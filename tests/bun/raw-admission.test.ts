import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Repository } from "../../lib/bun/git-context.ts";
import { admitRawInputs } from "../../lib/bun/raw-admission.ts";
import { executable } from "../../lib/bun/devshell-environment.ts";
import { validateGitHubPolicy } from "../../lib/bun/raw-github-policy.ts";
import corpus from "../fixtures/raw-admission-python.json";

describe("raw の GitHub policy validator", () => {
  const policy = {
    ...corpus.inputs.github,
    automation: "no-project-secrets" as const,
    reviewed_commit: "a".repeat(40),
  };

  test("旧 admit が受理した policy を同一 process で検証する", () => {
    expect(corpus.cases.githubHttps.expected.status).toBe(0);
    expect(validateGitHubPolicy(policy)).toEqual(policy);
  });

  const rejected = [
    corpus.cases.githubField,
    corpus.cases.githubEmpty,
    corpus.cases.githubRepository,
    corpus.cases.githubHash,
    corpus.cases.githubMain,
    corpus.cases.githubUnsupportedBranch,
    corpus.cases.githubAutomation,
  ];
  test.each(rejected)("旧 admit が拒否した policy を同じ理由で拒否する (%j)", (example) => {
    expect(() => validateGitHubPolicy({ ...policy, ...example.input.github })).toThrow(
      example.expected.stderr.trimEnd().replace(/^devshell-env: /, ""),
    );
  });
});

type Input = {
  replace?: readonly string[];
  append?: string;
  ancestorRoot?: boolean;
  head?: string;
  origin?: string;
  staged?: boolean;
  inputKind?: string;
  names?: string[];
  github?: Record<string, string>;
  insidePolicy?: boolean;
  symlinkPolicy?: boolean;
  inputsMode?: number;
  inputsSymlink?: boolean;
  externalCa?: boolean;
  policyEncoding?: "utf-8-sig" | "utf-32-be-bom";
  mcp?: ("context7" | "serena")[];
};
type Capture = {
  input: Input;
  expected: { status: number; stdout: string; stderr: string; bytes?: string; mode?: number };
};
const ca = process.env.RAW_ADMISSION_TEST_CA;

describe.skipIf(process.platform !== "linux" || !ca)("raw 入力登録と旧 admit の比較", () => {
  test.each(Object.entries(corpus.cases as Record<string, Capture>))("%s", (caseName, captured) => {
    const { input, expected } = captured;
    const { inputs } = corpus;
    const base = mkdtempSync(join(realpathSync(tmpdir()), "raw-admission-"));
    const original = { ...process.env };
    try {
      const primary = join(base, "repo");
      const work = join(base, "work");
      const home = join(base, "home");
      const codex = join(home, ".codex");
      const state = join(base, "state");
      const output = join(state, "devshell-env/inputs");
      const caBundle = realpathSync(ca!);
      mkdirSync(join(codex, "rules"), { recursive: true });
      writeFileSync(join(base, "ca.pem"), "");
      Object.assign(process.env, {
        HOME: home,
        XDG_STATE_HOME: state,
        CODEX_HOME: codex,
        GH_CONFIG_DIR: input.ancestorRoot ? base : join(home, "gh"),
        CODEX_ISOLATION_CA_BUNDLE: input.externalCa ? join(base, "ca.pem") : caBundle,
      });

      function git(args: string[], cwd = primary): string {
        return execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: home,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
        }).trimEnd();
      }
      git(["init", "-q", "--initial-branch=main", primary], base);
      git(["config", "user.name", "Fixture"]);
      git(["config", "user.email", "fixture@example.invalid"]);
      git(["commit", "-qm", "fixture", "--allow-empty"]);
      git(["worktree", "add", "-qb", "task", work]);
      git(["remote", "add", "origin", input.origin ?? "https://github.com/fixture/demo"]);
      const head = git(["rev-parse", "HEAD"], work);
      const tree = git(["write-tree"], work);
      const repo = Repository.discover(work, { linkedOnly: true });
      writeFileSync(join(repo.commonDir, "hooks/pre-commit"), inputs.hook, { mode: 0o755 });

      for (const [name, value] of Object.entries(inputs.managed))
        writeFileSync(join(codex, name), value);
      const config = input.replace
        ? inputs.config.replaceAll(input.replace[0]!, input.replace[1]!)
        : inputs.config;
      writeFileSync(
        join(codex, "config.toml"),
        config + (input.append ?? "").replaceAll("{base}", base),
      );
      mkdirSync(join(work, "tools"));
      mkdirSync(join(work, "notes"));
      for (const [name, file] of Object.entries(inputs.public))
        writeFileSync(join(work, name), file.text, { mode: file.mode });
      if (input.staged) git(["add", "flake.nix"], work);
      if (input.inputKind === "symlink") {
        symlinkSync(join(work, "flake.nix"), join(work, "linked"));
        symlinkSync(join(work, "notes"), join(work, "alias"));
      }
      if (input.inputKind === "hardlink") linkSync(join(work, "flake.nix"), join(work, "linked"));
      if (input.inputKind === "fifo") execFileSync("mkfifo", [join(work, "linked")]);
      if (input.inputKind === "bytes")
        writeFileSync(
          Buffer.concat([Buffer.from(join(work, "notes/raw-")), Buffer.from([255])]),
          "surrogateescape fixture\n",
        );
      if (input.inputsMode !== undefined) {
        mkdirSync(output, { recursive: true });
        chmodSync(output, input.inputsMode);
      }
      if (input.inputsSymlink) {
        mkdirSync(join(state, "devshell-env"), { recursive: true });
        symlinkSync(home, output);
      }

      let githubPolicy: string | undefined;
      if (input.github) {
        githubPolicy = join(input.insidePolicy ? work : base, "github.json");
        const fields = Object.fromEntries(
          Object.entries({ ...inputs.github, ...input.github }).map(([key, value]) => [
            key,
            value.replaceAll("{head}", head),
          ]),
        );
        const file = input.symlinkPolicy ? join(base, "github-target.json") : githubPolicy;
        const payload = JSON.stringify(fields);
        if (input.policyEncoding === "utf-32-be-bom") {
          const data = Buffer.alloc((payload.length + 1) * 4);
          data.writeUInt32BE(0xfeff);
          for (let index = 0; index < payload.length; index++)
            data.writeUInt32BE(payload.charCodeAt(index), (index + 1) * 4);
          writeFileSync(file, data);
        } else {
          writeFileSync(file, (input.policyEncoding === "utf-8-sig" ? "\ufeff" : "") + payload);
        }
        if (input.symlinkPolicy) symlinkSync(file, githubPolicy);
      }

      const names = input.names ?? Object.keys(inputs.public);
      const admit = () =>
        admitRawInputs(repo, input.head ?? head, names, { githubPolicy, mcp: input.mcp });
      if (expected.status !== 0) {
        const legacy = expected.stderr.trimEnd().replace(/^devshell-env: /, "");
        const reason = legacy.startsWith("[Errno ")
          ? legacy.match(/^\[Errno (2|20|40)\]/)?.[1]
          : legacy;
        const errno = { "2": "ENOENT", "20": "ENOTDIR", "40": "ELOOP" } as Record<string, string>;
        expect(admit).toThrow(
          errno[reason ?? ""] ??
            (legacy.includes("(at line ") ? "invalid managed TOML configuration" : legacy),
        );
        if (existsSync(output) && !input.inputsSymlink) expect(readdirSync(output)).toEqual([]);
        return;
      }

      const path = admit();
      const { device, inode } = repo.identity();
      const before = readFileSync(path, "utf8");
      let normalized = before
        .replaceAll(base, "{base}")
        .replaceAll(caBundle, "{ca}")
        .replaceAll(head, "{head}")
        .replaceAll(tree, "{index_tree}")
        .replace(`"device": ${device}`, '"device": {device}')
        .replace(`"inode": ${inode}`, '"inode": {inode}');
      if (caseName === "managedMcp") {
        for (const name of ["bunx", "node", "uvx"]) {
          normalized = normalized.replaceAll(
            join(dirname(executable(name)!), name),
            "{" + name + "}",
          );
        }
      }
      expect(normalized).toBe(expected.bytes!);
      expect(statSync(path).mode & 0o777).toBe(expected.mode!);
      const expectedName = createHash("sha256").update(work).digest("hex") + ".json";
      expect(path).toBe(join(output, expectedName));
      expect(readdirSync(output)).toEqual([basename(path)]);
      if (caseName === "valid") {
        writeFileSync(join(work, "flake.nix"), "# revised public input\n");
        expect(() => admitRawInputs(repo, head, [...names, "missing"])).toThrow("ENOENT");
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(admit()).toBe(path);
        expect(readFileSync(path, "utf8")).not.toBe(before);
        expect(readdirSync(output)).toEqual([expectedName]);
        expect(statSync(path).mode & 0o777).toBe(expected.mode!);
      }
    } finally {
      for (const key of Object.keys(process.env))
        if (!Object.hasOwn(original, key)) delete process.env[key];
      Object.assign(process.env, original);
      rmSync(base, { recursive: true, force: true });
    }
  });
});
