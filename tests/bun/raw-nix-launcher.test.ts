import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { selectRawLauncher } from "../../lib/bun/raw-nix-launcher.ts";

const root = resolve(import.meta.dir, "../..");
const fixtures = join(root, "tests/fixtures");
const selected = process.env.RAW_LAUNCHER_PROOF;
const source = createHash("sha256")
  .update(
    ["bun-exec-pid-namespace.c", "bun-exec-launcher.c"]
      .map((name) =>
        createHash("sha256")
          .update(readFileSync(join(fixtures, name)))
          .digest("hex"),
      )
      .join(""),
  )
  .digest("hex");

test("raw launcher selection requires a canonical Nix store output", () => {
  for (const path of ["", "/usr/bin/true", "/nix/store/../bin/true"])
    expect(() => selectRawLauncher(path, source)).toThrow("Nix store");
});

test.skipIf(!selected)("raw launcher rejects different source and unselected closure", () => {
  const launcher = selectRawLauncher(selected!, source);
  expect(() => selectRawLauncher(selected!, "0".repeat(64))).toThrow("source or version");
  expect(() => launcher.verifyCopy("/nonexistent", [])).toThrow("selected closure");
});

test.skipIf(!selected)(
  "launcher-only SIGKILL ends preparation under real raw isolation",
  () => {
    const launcher = selectRawLauncher(selected!, source);
    const base = mkdtempSync(join(tmpdir(), "raw-launcher-proof-"));
    try {
      const ca = join(base, "unused-ca");
      writeFileSync(ca, "");
      const fixtureEnv = {
        ...process.env,
        PROJECT_ROOT: root,
        BATS_TEST_TMPDIR: base,
        CODEX_ISOLATION_CA_BUNDLE: ca,
      };
      execFileSync(
        "bash",
        ["-c", 'source "$PROJECT_ROOT/tests/helpers/raw-codex.bash"; raw_fixture'],
        {
          env: fixtureEnv,
          timeout: 30_000,
        },
      );
      const work = join(base, "raw/work");
      const files = {
        entry: join(fixtures, "bun-exec-entry.sh"),
        "prepare.ts": join(fixtures, "bun-raw-launcher-prepare.ts"),
        "supervise.py": join(fixtures, "raw-launcher-proof.py"),
        ...Object.fromEntries(
          ["run", "bunfig.toml", "tsconfig.json"].map((name) => [
            name,
            join(root, "lib/bun", name),
          ]),
        ),
      };
      for (const [name, file] of Object.entries(files)) {
        const target = join(work, name);
        cpSync(file, target);
        chmodSync(target, statSync(file).mode & 0o777);
      }
      const runner = join(root, "lib/bun/run");
      const driver = join(root, "tests/helpers/raw-worktree-fixture.ts");
      const policy = join(base, "policy.json");
      const head = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      execFileSync(runner, [
        "run",
        driver,
        "approve",
        "--root",
        work,
        "--policy",
        policy,
        "--git-head",
        head,
        "--",
        "flake.nix",
        ...Object.keys(files),
      ]);
      execFileSync(
        runner,
        [
          "run",
          driver,
          "run",
          "--root",
          work,
          "--policy",
          policy,
          "--output",
          join(base, "session"),
          "--launcher",
          launcher.package,
          "--launcher-source",
          source,
          "--",
          "python3",
          "-I",
          "-B",
          join(work, "supervise.py"),
          launcher.executable,
        ],
        { timeout: 360_000 },
      );

      const copied = join(base, "altered-store");
      const output = join(copied, basename(launcher.package));
      cpSync(launcher.package, output, { recursive: true });
      const executable = join(output, "bin/raw-codex-launcher");
      const closure = [launcher.package];
      launcher.verifyCopy(copied, closure);
      chmodSync(executable, 0o755);
      expect(() => launcher.verifyCopy(copied, closure)).toThrow("file owner or mode");
      writeFileSync(executable, "changed executable");
      chmodSync(executable, 0o555);
      expect(() => launcher.verifyCopy(copied, closure)).toThrow("digest");
    } finally {
      // Copied store directories are read-only until the fixture is finished.
      execFileSync("bash", ["-c", 'find "$1" -type d -exec chmod u+w {} +', "_", base]);
      rmSync(base, { recursive: true, force: true });
    }
  },
  370_000,
);
