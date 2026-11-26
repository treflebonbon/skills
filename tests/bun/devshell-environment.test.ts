import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseReasoningEffort,
  prepareEnvironment,
  reuseEnvironment,
  selectedOutput,
  trustCommand,
  trusted,
} from "../../lib/bun/devshell-environment.ts";
import { gitEnvironment, Repository } from "../../lib/bun/git-context.ts";
import corpus from "../fixtures/devshell-environment-python.json";

const { inputs, cases } = corpus;
describe("devShell 準備", () => {
  let base: string, primary: string, worktree: string, state: string;
  let original: NodeJS.ProcessEnv;

  function git(...args: string[]): void {
    execFileSync("git", args, { env: gitEnvironment() });
  }

  beforeEach(() => {
    base = mkdtempSync(join(realpathSync.native(tmpdir()), "skills-devshell."));
    primary = join(base, inputs.common);
    worktree = join(base, inputs.worktree);
    state = join(base, "state");
    original = { ...process.env };
    process.env.XDG_STATE_HOME = state;
    process.env.DEVSHELL_ENV_OUTPUT = inputs.output;
    git("init", "-q", primary);
    git(
      "-C",
      primary,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "fixture",
    );
    git("-C", primary, "worktree", "add", "-qb", "task", worktree);
    writeFileSync(join(worktree, "flake.nix"), inputs.flake);
    writeFileSync(join(worktree, "flake.lock"), inputs.lock);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(original, key)) delete process.env[key];
    }
    Object.assign(process.env, original);
    rmSync(base, { recursive: true, force: true });
  });

  function normalized(value: string): string {
    return value.replaceAll(base, "{base}");
  }

  function recordTemplate(value: string, repo: Repository): string {
    const { device, inode } = repo.identity();
    return normalized(value)
      .replace(`"device": ${device}`, '"device": {device}')
      .replace(`"inode": ${inode}`, '"inode": {inode}');
  }

  test("trust と untrust は旧 CLI と同じ状態を linked worktree で共有する", () => {
    const main = Repository.discover(primary);
    const linked = Repository.discover(worktree, { linkedOnly: true });
    expect(normalized(trustCommand("status", linked) + "\n")).toBe(cases.untrusted.stdout);
    expect(normalized(trustCommand("trust", main) + "\n")).toBe(cases.trust.stdout);
    expect(normalized(trustCommand("status", linked) + "\n")).toBe(cases.trusted.stdout);

    const directory = join(state, "devshell-env/trust");
    const [filename, ...extra] = readdirSync(directory);
    expect(extra).toEqual([]);
    const record = join(directory, filename);
    expect(recordTemplate(readFileSync(record, "utf8"), linked)).toBe(cases.record.bytes);
    expect(statSync(record).mode & 0o777).toBe(cases.record.mode);
    expect(trusted(linked)).toBe(true);

    expect(normalized(trustCommand("untrust", linked) + "\n")).toBe(cases.untrust.stdout);
    expect(normalized(trustCommand("status", main) + "\n")).toBe(cases.revoked.stdout);
    expect(readdirSync(directory)).toEqual([]);
  });

  test("trust record の symlink と repo 内の trust state を旧 CLI と同じ理由で拒否する", () => {
    const linked = Repository.discover(worktree);
    trustCommand("trust", linked);
    const directory = join(state, "devshell-env/trust");
    const record = join(directory, readdirSync(directory)[0]);
    const saved = join(base, "saved-record");
    renameSync(record, saved);
    symlinkSync(saved, record);
    expect(() => trustCommand("status", linked)).toThrow(
      cases.symlinkRecord.stderr.trim().slice("devshell-env: ".length),
    );

    const alias = join(base, "alias");
    symlinkSync(worktree, alias);
    process.env.XDG_STATE_HOME = alias + "/not-created";
    expect(() => trustCommand("trust", linked)).toThrow(
      cases.insideRepository.stderr.trim().slice("devshell-env: ".length),
    );
  });

  function fakeNix(script: string): void {
    const bin = join(base, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(base, "nix-env"), script);
    writeFileSync(
      join(bin, "nix"),
      "#!/bin/bash\nprintf '%s\\n' \"$@\" > " +
        "'" +
        join(base, "nix-argv") +
        "'\nexec cat '" +
        join(base, "nix-env") +
        "'\n",
      { mode: 0o700 },
    );
    process.env.PATH = bin + ":" + original.PATH;
  }

  test("fake Nix と shellHook の環境を通常・隔離用 bootstrap それぞれで旧版と比較する", () => {
    const repo = Repository.discover(worktree, { linkedOnly: true });
    trustCommand("trust", repo);
    fakeNix(inputs.shell);

    for (const isolated of [false, true]) {
      const expected = isolated ? corpus.prepared.isolated : corpus.prepared.normal;
      const { DEVSHELL_ENV_CONTEXT: context, ...environment } = prepareEnvironment(
        repo,
        inputs.inherited,
        { isolated },
      );
      expect(environment).toEqual(expected.environment);
      expect(Object.hasOwn(environment, "__proto__")).toBe(true);
      expect(recordTemplate(context!, repo)).toBe(expected.context);
      expect(
        normalized(readFileSync(join(base, "nix-argv"), "utf8"))
          .trimEnd()
          .split("\n"),
      ).toEqual(cases.nixArgv);
    }
  });

  test.skipIf(process.platform !== "linux")(
    "旧環境取得時の C locale 補正を Linux で再現する",
    () => {
      const repo = Repository.discover(worktree);
      fakeNix("export PROJECT=from-flake");
      expect(prepareEnvironment(repo, inputs.inherited, { requireTrust: false }).LC_CTYPE).toBe(
        cases.legacyLocale,
      );
    },
  );

  test("旧 with-env の context を再利用でき、未準備・別 root・flake 変更を拒否する", () => {
    const repo = Repository.discover(worktree);
    const { device, inode } = repo.identity();
    const oldContext = corpus.prepared.normal.context
      .replace("{base}", base)
      .replace("{base}", base)
      .replace("{device}", String(device))
      .replace("{inode}", String(inode));
    const inherited = { DEVSHELL_ENV_CONTEXT: oldContext, FIXTURE_VALUE: "a=b\n空" };
    expect(reuseEnvironment(repo, inherited)).toBe(inherited);
    expect(reuseEnvironment(repo, inherited).FIXTURE_VALUE).toBe(cases.reused.stdout);
    expect(() => reuseEnvironment(repo, {})).toThrow(
      cases.missingContext.stderr.trim().slice("devshell-env: ".length),
    );
    expect(() => reuseEnvironment(Repository.discover(primary), inherited)).toThrow(
      cases.foreignContext.stderr.trim().slice("devshell-env: ".length),
    );
    writeFileSync(join(worktree, "flake.lock"), "changed");
    expect(() => reuseEnvironment(repo, inherited)).toThrow(
      cases.changedContext.stderr.trim().slice("devshell-env: ".length),
    );
  });

  test("未承認の repository は Nix 起動前に拒否し、隔離側は承認済み入力を準備できる", () => {
    const repo = Repository.discover(worktree);
    fakeNix(inputs.shell);
    expect(() => prepareEnvironment(repo, inputs.inherited)).toThrow(
      cases.untrustedPreparation.error,
    );
    expect(() => readFileSync(join(base, "nix-argv"))).toThrow();
    expect(
      prepareEnvironment(repo, inputs.inherited, { requireTrust: false, isolated: true }).HOOK,
    ).toBe(corpus.prepared.isolated.environment.HOOK);
  });

  test("shellHook の非ゼロ終了と、準備中の flake 変更で環境を返さない", () => {
    const repo = Repository.discover(worktree);
    trustCommand("trust", repo);
    fakeNix("printf 'hook failed\\n'; exit 41");
    expect(() => prepareEnvironment(repo, inputs.inherited)).toThrow(
      "shellHook preparation failed (41): hook failed",
    );
    fakeNix("exit 0");
    expect(() => prepareEnvironment(repo, inputs.inherited)).toThrow(
      "invalid devShell environment output",
    );
    fakeNix("printf changed > flake.lock");
    expect(() => prepareEnvironment(repo, inputs.inherited)).toThrow(
      "flake changed during preparation; restart the session",
    );
  });

  test("Nix 自体のエラーと timeout は shellHook 実行前に診断する", () => {
    const repo = Repository.discover(worktree);
    trustCommand("trust", repo);
    fakeNix("");
    const nix = join(base, "bin", "nix");
    writeFileSync(nix, "#!/bin/bash\nprintf '%s\\n' 'Nix failed' >&2\nexit 42\n");
    expect(() => prepareEnvironment(repo, inputs.inherited)).toThrow(
      "Nix preparation failed (42): Nix failed",
    );
    writeFileSync(nix, "#!/bin/bash\ntrap '' TERM\nwhile :; do :; done\n");
    expect(() => prepareEnvironment(repo, inputs.inherited, { timeoutMs: 100 })).toThrow(
      "Nix preparation timed out",
    );
  });

  test("WSL は marker がある場合に wsl を選び、不正な明示指定を拒否する", () => {
    const repo = Repository.discover(worktree);
    expect(selectedOutput(repo)).toBe(inputs.output);
    delete process.env.DEVSHELL_ENV_OUTPUT;
    process.env.WSL_DISTRO_NAME = "Fixture";
    expect(selectedOutput(repo)).toBe("default");
    writeFileSync(join(worktree, ".wsl-browser-free"), "");
    expect(selectedOutput(repo)).toBe("wsl");
    for (const invalid of ["output..nested", "output\n"]) {
      process.env.DEVSHELL_ENV_OUTPUT = invalid;
      expect(() => selectedOutput(repo)).toThrow(
        "DEVSHELL_ENV_OUTPUT must name an output in the current flake",
      );
    }
  });
});

test.each(Object.entries(corpus.toml))(
  "reasoning effort の TOML を旧版と比較する (%s)",
  (_name, testcase) => {
    if ("error" in testcase) {
      expect(() => parseReasoningEffort(testcase.assignment)).toThrow(testcase.error);
    } else {
      expect(parseReasoningEffort(testcase.assignment)).toBe(testcase.value);
    }
  },
);
