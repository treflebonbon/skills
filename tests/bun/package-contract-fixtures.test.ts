import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { resolve, basename } from "node:path";
import corpus from "../fixtures/quality-python.json";

const root = resolve(import.meta.dir, "../..");
test("package 契約は旧 corpus の12拒否と正常な配布物を区別し、Python を起動しない", () => {
  fs.mkdirSync("/tmp/codex", { recursive: true, mode: 0o700 });
  const info = fs.lstatSync("/tmp/codex");
  if (!info.isDirectory() || info.uid !== process.getuid!())
    throw Error("/tmp/codex は実行ユーザー所有の通常 directory が必要です");
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/codex/quality-contract-50-"));
  try {
    const payload = resolve(directory, "payload"),
      bin = resolve(directory, "bin");
    fs.cpSync(root, payload, {
      recursive: true,
      filter: (path) =>
        ![".git", "node_modules", ".env"].includes(basename(path)) &&
        !basename(path).startsWith(".env."),
    });
    fs.mkdirSync(bin);
    for (const name of ["python", "python3"])
      fs.writeFileSync(resolve(bin, name), '#!/bin/sh\necho "Python 起動を検出" >&2\nexit 87\n', {
        mode: 0o700,
      });
    for (const args of [
      ["init", "-q"],
      ["add", "--force", "--all"],
    ]) {
      const git = spawnSync("git", args, { cwd: payload, encoding: "utf8" });
      expect(git.status, git.stderr).toBe(0);
    }
    const run = (name?: string) =>
      spawnSync(
        resolve(payload, "lib/bun/run"),
        [
          "test",
          resolve(payload, "tests/bun/package-contract.test.ts"),
          ...(name ? ["--test-name-pattern", "^" + name + "$"] : []),
        ],
        {
          cwd: directory,
          env: { ...process.env, PATH: bin + ":" + process.env.PATH },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
    const valid = run();
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stderr).toContain("17 pass");
    const reasons: Record<string, string> = {
      "manifest-version": ".claude-plugin/plugin.json version",
      "marketplace-policy": "Codex policy",
      "release-manifest": "release manifest",
      "release-jsonpath": "JSON path",
      "formatter-lock": "formatter lock",
      registry: "registry",
      integrity: "integrity",
      license: "package license",
      "markdown-link": "markdown link",
      "skill-name": "marp name",
      "explicit-invocation": "pr-screenshots explicit invocation",
      "quality-node": "quality entry",
    };
    for (const item of corpus.mutations.cases) {
      const path = resolve(payload, item.path),
        before = fs.readFileSync(path);
      try {
        fs.writeFileSync(path, item.utf8);
        const rejected = run(item.test);
        expect(rejected.status, item.name + "\n" + rejected.stderr).toBe(1);
        expect(rejected.stderr, item.name).toContain(reasons[item.name]!);
        expect(rejected.stderr).not.toContain("Python 起動を検出");
      } finally {
        fs.writeFileSync(path, before);
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
