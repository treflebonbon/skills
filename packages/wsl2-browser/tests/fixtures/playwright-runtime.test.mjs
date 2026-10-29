import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const runtimeModule = process.env.TEST_PLAYWRIGHT_RUNTIME_MODULE
  ? pathToFileURL(process.env.TEST_PLAYWRIGHT_RUNTIME_MODULE)
  : new URL(
      "../../libexec/playwright-runtime.mjs",
      import.meta.url
    );
const { withStoppedPlaywrightRuntime } = await import(runtimeModule.href);

const identity = `playwright-${"a".repeat(64)}`;
test("runtime callback holds a shared FD after flock exits, and releases after failure", async () => {
  const base = await fs.mkdtemp(
    path.join(process.env.BATS_TEST_TMPDIR, "runtime-")
  );
  process.env.PWCLI_RUNTIME_DIR = base;
  const directory = path.join(base, "playwright-cli", identity);
  const lock = path.join(directory, "runtime.lock");
  await assert.rejects(
    withStoppedPlaywrightRuntime(identity, async (...args) => {
      assert.deepEqual(args, []);
      assert.equal(spawnSync("flock", ["-n", lock, "true"]).status, 1);
      await assert.rejects(
        withStoppedPlaywrightRuntime(identity, () =>
          assert.fail("busy callback")
        ),
        /lock unavailable/u
      );
      throw new Error("update failed");
    }),
    /update failed/u
  );
  assert.equal(spawnSync("flock", ["-n", lock, "true"]).status, 0);
});

for (const record of [
  "dashboard.pid",
  "dashboard.starttime",
  "dashboard.launcher",
  "dashboard.session",
  "dashboard.stdin",
]) {
  for (const kind of ["file", "symlink", "fifo"]) {
    test(`${record} ${kind} refuses without mutation`, async () => {
      const base = await fs.mkdtemp(
        path.join(process.env.BATS_TEST_TMPDIR, "records-")
      );
      process.env.PWCLI_RUNTIME_DIR = base;
      const directory = path.join(base, "playwright-cli", identity);
      await fs.mkdir(directory, { recursive: true });
      const filename = path.join(directory, record);
      if (kind === "file") {
        await fs.writeFile(filename, "retained");
      }
      if (kind === "symlink") {
        await fs.symlink("missing", filename);
      }
      if (kind === "fifo") {
        execFileSync("mkfifo", [filename]);
      }
      const before = await fs.lstat(filename);
      await assert.rejects(
        withStoppedPlaywrightRuntime(identity, () =>
          assert.fail("record callback")
        ),
        /Close the worktree Dashboard/u
      );
      const after = await fs.lstat(filename);
      assert.equal(after.ino, before.ino);
      await fs.unlink(filename);
      assert.equal(
        await withStoppedPlaywrightRuntime(identity, () => "updated"),
        "updated"
      );
    });
  }
}

test("non-ENOENT runtime lookup failures never invoke update", async () => {
  const base = await fs.mkdtemp(
    path.join(process.env.BATS_TEST_TMPDIR, "invalid-")
  );
  const file = path.join(base, "file");
  await fs.writeFile(file, "retained");
  process.env.PWCLI_RUNTIME_DIR = file;
  await assert.rejects(
    withStoppedPlaywrightRuntime(identity, () =>
      assert.fail("invalid callback")
    ),
    /ENOTDIR/u
  );
});

test("runtime resolution follows the shared environment precedence", async () => {
  const base = await fs.mkdtemp(
    path.join(process.env.BATS_TEST_TMPDIR, "layout-")
  );
  const script = runtimeModule;
  for (const [pwcli, xdg, expected] of [
    [base, `${base}/xdg`, `${base}/playwright-cli`],
    ["", `${base}/xdg`, `${base}/xdg/playwright-cli`],
    ["", "", `${base}/playwright-cli-${process.getuid()}`],
  ]) {
    const result = execFileSync(process.execPath, [script.pathname, identity], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PWCLI_RUNTIME_DIR: pwcli,
        PWCLI_TMPDIR: base,
        XDG_RUNTIME_DIR: xdg,
      },
    });
    const fields = result.trim().split("\t");
    assert.equal(fields.length, 10);
    assert.equal(fields[0], path.join(expected, identity));
    assert.equal(fields[1], path.join(fields[0], "runtime.lock"));
  }
});

test("Dashboard lookup errors preserve state and release the runtime lock", async (context) => {
  const base = await fs.mkdtemp(
    path.join(process.env.BATS_TEST_TMPDIR, "lookup-")
  );
  process.env.PWCLI_RUNTIME_DIR = base;
  const originalLstat = fs.lstat.bind(fs);
  context.mock.method(fs, "lstat", async (filename) => {
    if (filename.endsWith("dashboard.pid")) {
      throw Object.assign(new Error("Dashboard lookup denied"), {
        code: "EACCES",
      });
    }
    return await originalLstat(filename);
  });
  await assert.rejects(
    withStoppedPlaywrightRuntime(identity, () =>
      assert.fail("lookup callback")
    ),
    /Dashboard lookup denied/u
  );
  const lock = path.join(base, "playwright-cli", identity, "runtime.lock");
  assert.equal(spawnSync("flock", ["-n", lock, "true"]).status, 0);
});
