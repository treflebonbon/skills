import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { findCLI } from "../lib/bun/cli-path.ts";

const ROOT = fs.realpathSync(resolve(import.meta.dir, ".."));
const SKILLS = fs
  .readdirSync(join(ROOT, "skills"))
  .filter((name) => fs.existsSync(join(ROOT, "skills", name, "SKILL.md")))
  .sort();
const enabled = process.env.TREFLEBONBON_PLUGIN_CLI_E2E === "1";
// subprocess ごとの旧上限を使い、テスト全体に別の上限を重ねない。
const smoke = enabled ? test : test.skip;
beforeAll(() => {
  if (!enabled) return;
  const missing = ["agy", "claude", "codex"].filter((name) => !findCLI(name));
  if (missing.length) throw new Error("必要な公式 plugin CLI がありません: " + missing.join(", "));
});

const localEnvironment = (name: string) => name === ".env" || name.startsWith(".env.");
function assertSafeInstall(root: string): void {
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (localEnvironment(item.name))
      throw new Error("plugin source contains a local environment file");
    if (item.isDirectory()) assertSafeInstall(join(root, item.name));
  }
}
function snapshot(root: string): Record<string, { hash: string; mode: number }> {
  const result: Record<string, { hash: string; mode: number }> = {};
  function walk(directory: string, prefix: string) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, item.name),
        name = prefix + item.name;
      if (fs.statSync(file).isDirectory()) {
        if (
          !item.isSymbolicLink() &&
          ![".git", "node_modules"].includes(item.name) &&
          !localEnvironment(item.name)
        )
          walk(file, name + "/");
      } else if (!localEnvironment(item.name))
        result[name] = {
          hash: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
          mode: fs.statSync(file).mode,
        };
    }
  }
  walk(root, "");
  return result;
}
function withHome(
  action: (
    command: (...argv: string[]) => string,
    directory: string,
    env: NodeJS.ProcessEnv,
  ) => void,
) {
  assertSafeInstall(ROOT);
  const before = snapshot(ROOT),
    directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "skills-plugin.")));
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP"])
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  for (const [name, part] of Object.entries({
    HOME: "home",
    XDG_CONFIG_HOME: "config",
    XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache",
    XDG_STATE_HOME: "state",
    CODEX_HOME: "codex",
    CLAUDE_CONFIG_DIR: "claude",
  })) {
    environment[name] = join(directory, part);
    fs.mkdirSync(environment[name]!);
  }
  const command = (...argv: string[]) => {
    const result = spawnSync(argv[0]!, argv.slice(1), {
      cwd: directory,
      env: environment,
      encoding: "utf8",
      maxBuffer: Infinity,
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    if (result.error) throw result.error;
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  try {
    action(command, directory, environment);
  } finally {
    fs.rmSync(directory, { recursive: true });
    assertSafeInstall(ROOT);
    expect(snapshot(ROOT), "公式 CLI が配布元を書き換えました").toEqual(before);
  }
}

smoke(
  "Antigravity が全 skill の配布物を受理する",
  () =>
    withHome((command) => {
      const result = JSON.parse(command("agy", "plugin", "validate", ROOT, "--strict", "--json"));
      expect(result.name).toBe("treflebonbon-skills");
      expect(result.components.skills).toBe(SKILLS.length);
      expect(
        result.findings.filter((finding: { severity: string }) => finding.severity !== "note"),
      ).toEqual([]);
    }),
  0,
);

smoke(
  "Antigravity が portable plugin を導入する",
  () =>
    withHome((command) => {
      command("agy", "plugin", "install", ROOT);
      expect(command("agy", "plugin", "list", "--json")).toContain("treflebonbon-skills");
    }),
  0,
);

smoke(
  "Claude Code が local marketplace から全 skill を導入する",
  () =>
    withHome((command) => {
      command("claude", "plugin", "marketplace", "add", ROOT, "--json");
      command("claude", "plugin", "install", "treflebonbon-skills@treflebonbon", "--json");
      const inventory = command("claude", "plugin", "details", "treflebonbon-skills@treflebonbon");
      for (const skill of SKILLS) expect(inventory).toContain(skill);
    }),
  0,
);

smoke(
  "Codex の公式導入物の全 skill と共用 CLI を検査する",
  () =>
    withHome((command, directory, environment) => {
      command("codex", "plugin", "marketplace", "add", ROOT, "--json");
      const installed = JSON.parse(
        command("codex", "plugin", "add", "treflebonbon-skills@treflebonbon", "--json"),
      ).installedPath;
      expect(JSON.parse(fs.readFileSync(join(installed, "plugin.json"), "utf8")).version).toBe(
        JSON.parse(fs.readFileSync(join(ROOT, "plugin.json"), "utf8")).version,
      );
      expect(
        fs
          .readdirSync(join(installed, "skills"))
          .filter((name) => fs.existsSync(join(installed, "skills", name, "SKILL.md")))
          .sort(),
      ).toEqual(SKILLS);
      for (const name of [
        "git-push-topic",
        "git-push-reviewed",
        "gh-review-thread",
        "orca-send",
        "codex-reviewer",
      ]) {
        const path = join(installed, "bin", name),
          info = fs.lstatSync(path);
        expect(info.isFile(), name).toBe(true);
        expect(info.isSymbolicLink(), name).toBe(false);
        fs.accessSync(path, fs.constants.X_OK);
      }
      const bats = findCLI("bats");
      if (bats) {
        const cliRoot = join(directory, "codex-installed-cli-tests");
        fs.mkdirSync(cliRoot);
        for (const name of ["bin", "contracts", "lib", "packages", "share", "skills"])
          fs.symlinkSync(join(installed, name), join(cliRoot, name), "dir");
        fs.cpSync(join(ROOT, "tests/cli"), join(cliRoot, "tests/cli"), { recursive: true });
        fs.cpSync(join(ROOT, "tests/fixtures"), join(cliRoot, "tests/fixtures"), {
          recursive: true,
        });
        const suites = fs
          .readdirSync(join(cliRoot, "tests/cli"))
          .filter((name) => name.endsWith(".bats"))
          .sort()
          .map((name) => join(cliRoot, "tests/cli", name));
        const result = spawnSync(bats, suites, {
          cwd: cliRoot,
          env: environment,
          encoding: "utf8",
          maxBuffer: Infinity,
          timeout: 240_000,
          killSignal: "SIGKILL",
        });
        if (result.error) throw result.error;
        expect(result.status, result.stdout + result.stderr).toBe(0);
      }
      for (const skill of SKILLS)
        expect(snapshot(join(installed, "skills", skill)), skill).toEqual(
          snapshot(join(ROOT, "skills", skill)),
        );
    }),
  0,
);
