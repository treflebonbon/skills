// Fault injection stays in the test process, outside the shipped CLI interface.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const assertLocksHeld = () => {
  for (const lock of [
    process.env.TEST_OWNER_LOCK,
    process.env.TEST_RUNTIME_LOCK,
  ]) {
    assert.equal(spawnSync("flock", ["--nonblock", lock, "true"]).status, 1);
  }
};
const originalLstat = fs.lstat.bind(fs);
fs.lstat = (filename) => {
  if (
    filename ===
    path.join(path.dirname(process.env.TEST_RUNTIME_LOCK), "dashboard.pid")
  ) {
    assertLocksHeld();
  }
  return originalLstat(filename);
};

const originalRename = fs.rename.bind(fs);
fs.rename = async (source, target) => {
  if (
    target !== path.join(process.env.BROWSER_OWNERSHIP_DIR, "allocations.json")
  ) {
    return originalRename(source, target);
  }
  assertLocksHeld();
  const barrier = process.env.TEST_RELOCATION_BARRIER;
  await fs.writeFile(`${barrier}.ready`, String(process.pid));
  // The barrier must poll sequentially so the parent can inspect the held locks.
  /* eslint-disable no-await-in-loop */
  while (!(await fs.stat(`${barrier}.continue`).catch(() => false))) {
    await delay(10);
  }
  /* eslint-enable no-await-in-loop */
  if (process.env.TEST_RELOCATION_FAULT === "before") {
    throw new Error("before rename fault");
  }
  await originalRename(source, target);
  if (process.env.TEST_RELOCATION_FAULT === "after") {
    throw new Error("after rename fault");
  }
};
