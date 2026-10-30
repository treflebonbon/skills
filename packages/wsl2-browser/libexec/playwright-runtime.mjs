#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { withBrowserLock } from "./browser-lock.mjs";

const entry = async (filename) => {
  try {
    return await fs.lstat(filename);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return null;
  }
};

const layout = (identity) => {
  if (!/^playwright-[a-f0-9]{64}$/u.test(identity || "")) {
    throw new Error("Expected the exact existing worktree identity.");
  }
  const base = process.env.PWCLI_RUNTIME_DIR || process.env.XDG_RUNTIME_DIR;
  const root = base
    ? path.join(base, "playwright-cli")
    : path.join(
        process.env.PWCLI_TMPDIR || "/tmp",
        `playwright-cli-${process.getuid()}`
      );
  const directory = path.join(root, identity);
  return {
    directory,
    launcher: path.join(directory, "dashboard.launcher"),
    lease: path.join(directory, "lease"),
    lock: path.join(directory, "runtime.lock"),
    log: path.join(directory, "dashboard.log"),
    pid: path.join(directory, "dashboard.pid"),
    root,
    session: path.join(directory, "dashboard.session"),
    start: path.join(directory, "dashboard.starttime"),
    stdin: path.join(directory, "dashboard.stdin"),
    token: path.join(directory, "owner.token"),
  };
};

export const withStoppedPlaywrightRuntime = async (identity, update) => {
  const runtime = layout(identity);
  await fs.mkdir(runtime.directory, { mode: 0o700, recursive: true });
  // Ownership is already held. Never wait for a wrapper holding runtime while
  // it acquires ownership in the opposite order.
  return withBrowserLock(runtime.lock, true, async () => {
    const records = await Promise.all(
      [
        runtime.pid,
        runtime.start,
        runtime.launcher,
        runtime.session,
        runtime.stdin,
      ].map(entry)
    );
    if (records.some(Boolean)) {
      throw new Error(
        "Close the worktree Dashboard with its owning session before relocating; allocation and runtime state were preserved."
      );
    }
    return update();
  });
};

const printLayout = async (identity) => {
  const runtime = layout(identity);
  const legacy = await Promise.all(
    ["lease", "dashboard.pid", "owner.token"].map((record) =>
      entry(path.join(runtime.root, record))
    )
  );
  if (legacy.some(Boolean)) {
    throw new Error(
      "Legacy Playwright consumers exist. Close them with the old package before migration."
    );
  }
  const fields = [
    runtime.directory,
    runtime.lock,
    runtime.pid,
    runtime.start,
    runtime.launcher,
    runtime.session,
    runtime.stdin,
    runtime.lease,
    runtime.token,
    runtime.log,
  ];
  if (fields.some((field) => /[\r\n\t]/u.test(field))) {
    throw new Error("Runtime paths cannot contain line breaks or tabs.");
  }
  process.stdout.write(`${fields.join("\t")}\n`);
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 3) {
      throw new Error("Expected a worktree identity.");
    }
    await printLayout(process.argv[2]);
  } catch (error) {
    process.stderr.write(`playwright-runtime: ${error.message}\n`);
    process.exitCode = 1;
  }
}
