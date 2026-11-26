import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executable } from "../../lib/bun/devshell-environment.ts";
import { hash, source } from "../../lib/bun/file-safety.ts";

const root = resolve(import.meta.dir, "../..");
const runner = resolve(root, "lib/bun/run");
const moduleDir = resolve(root, "lib/bun");
const requiresNative = process.platform === "linux" && Boolean(process.env.RAW_ADMISSION_TEST_CA);

async function prepare(directory: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([runner, "run", join(directory, "prepare-file-safety.ts")], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(status, stderr).toBe(0);
  return stdout.trim();
}

test.if(requiresNative)(
  "中断した旧 cache を保持し、並行ビルドは単一の完全な世代を公開する",
  async () => {
    const base = mkdtempSync(join(realpathSync(tmpdir()), "raw-native-cache-"));
    try {
      const directory = join(
        base,
        hash(readFileSync(source)) + "-" + process.platform + "-" + process.arch,
      );
      const env = { ...process.env, TREFLEBONBON_FILE_SAFETY_DIR: base };
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(join(directory, "build.json"), "interrupted fixture", { mode: 0o600 });
      const artifact = join(directory, "artifact");
      const results = await Promise.allSettled([prepare(moduleDir, env), prepare(moduleDir, env)]);
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        expect(result.value).toBe(artifact);
      }
      expect(readdirSync(directory).sort()).toEqual(["artifact", "build.json"]);
      expect(readFileSync(join(directory, "build.json"), "utf8")).toBe("interrupted fixture");
      const files = ["build.json", "file-safety.node"].map((name) => join(artifact, name));
      function identity() {
        return files.map((path) => {
          const { ino, nlink } = statSync(path);
          expect(nlink).toBe(1);
          return ino;
        });
      }
      const published = identity();
      expect(await prepare(moduleDir, env)).toBe(artifact);
      expect(identity()).toEqual(published);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
  45_000,
);

test.if(requiresNative)(
  "ビルド中に元ソースが変わっても、非公開コピーと同じ bytes を記録する",
  async () => {
    const base = mkdtempSync(join(realpathSync(tmpdir()), "raw-native-source-"));
    try {
      // The preparer's payload boundary is two directories above its module.
      const dir = join(base, "worktree/lib/bun");
      const commands = join(base, "commands");
      mkdirSync(dir, { recursive: true });
      mkdirSync(commands);
      for (const name of ["prepare-file-safety.ts", "file-safety.ts", "file-safety-native.c"])
        copyFileSync(join(moduleDir, name), join(dir, name));
      const original = join(dir, "file-safety-native.c");
      const backup = join(base, "original.c");
      const observed = join(base, "compiler-source.c");
      copyFileSync(original, backup);
      writeFileSync(
        join(commands, "cc"),
        [
          "#!/bin/bash -p",
          'if [[ "$1" == --version ]]; then exec "$RAW_TEST_CC" "$@"; fi',
          'trap \'cp -- "$RAW_TEST_SOURCE_BACKUP" "$RAW_TEST_SOURCE"\' EXIT',
          'printf "\\n/* changed during compile */\\n" >> "$RAW_TEST_SOURCE"',
          'for argument in "$@"; do',
          '  if [[ "$argument" == *.c ]]; then cp -- "$argument" "$RAW_TEST_OBSERVED" || exit; fi',
          "done",
          '"$RAW_TEST_CC" "$@"',
        ].join("\n") + "\n",
        { mode: 0o700 },
      );
      const artifact = await prepare(dir, {
        ...process.env,
        PATH: commands + ":" + process.env.PATH,
        TREFLEBONBON_FILE_SAFETY_DIR: join(base, "cache"),
        RAW_TEST_CC: executable("cc")!,
        RAW_TEST_SOURCE: original,
        RAW_TEST_SOURCE_BACKUP: backup,
        RAW_TEST_OBSERVED: observed,
      });
      const digest = hash(readFileSync(backup));
      expect(hash(readFileSync(observed))).toBe(digest);
      expect(JSON.parse(readFileSync(join(artifact, "build.json"), "utf8")).sourceHash).toBe(
        digest,
      );
      expect(hash(readFileSync(original))).toBe(digest);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
  45_000,
);
