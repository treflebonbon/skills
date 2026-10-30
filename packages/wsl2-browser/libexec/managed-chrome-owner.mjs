#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { withBrowserLock } from "./browser-lock.mjs";
import { withStoppedPlaywrightRuntime } from "./playwright-runtime.mjs";

const exec = promisify(execFile);

const root = path.resolve(
  process.env.BROWSER_OWNERSHIP_DIR ||
    path.join(
      process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || "/tmp",
      "browser-ownership"
    )
);
let ownerFile = path.join(root, "owner");
let identity;
const digest = (value) => createHash("sha256").update(value).digest("hex");

const validEndpoint = (value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      Number(url.port) > 0 &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
};

const validUUID = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);

const validOwner = (owner) =>
  owner?.version === 1 &&
  validUUID(owner.token) &&
  ["playwright", "dogfood", "attachment"].includes(owner.role) &&
  ["reserved", "starting", "settled", "active"].includes(owner.phase) &&
  ["headless", "headed"].includes(owner.mode) &&
  [owner.id, owner.profile, owner.workspace].every(
    (value) => typeof value === "string" && value.length > 0
  ) &&
  validEndpoint(owner.endpoint) &&
  Number.isInteger(owner.caller?.pid) &&
  owner.caller.pid > 0 &&
  typeof owner.caller.start === "string" &&
  /^[0-9]+$/u.test(owner.caller.start) &&
  validUUID(owner.caller.boot) &&
  (owner.phase === "active"
    ? Number.isInteger(owner.browserPid) && owner.browserPid > 0
    : owner.browserPid === null);

const readOwner = async (filename = ownerFile) => {
  try {
    const owner = JSON.parse(await fs.readFile(filename, "utf-8"));
    if (!validOwner(owner)) {
      throw new Error("invalid owner");
    }
    return owner;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw new Error(
      `Legacy or invalid ownership at ${ownerFile}. Close the old managed sessions and Dashboard before switching; the record was preserved.`,
      { cause: error }
    );
  }
};

const writeOwner = async (owner) => {
  const temporary = `${ownerFile}.${randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(owner)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await fs.rename(temporary, ownerFile);
};

const processIdentity = async (pid) => {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf-8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const boot = await fs.readFile("/proc/sys/kernel/random/boot_id", "utf-8");
    return { boot: boot.trim(), pid, start: fields[19] };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") {
      return null;
    }
    throw error;
  }
};

const callerAlive = async (owner) => {
  const current = await processIdentity(owner.caller.pid);
  return (
    current?.start === owner.caller.start && current?.boot === owner.caller.boot
  );
};

const locked = async (action) => {
  const dogfoodRoot = process.env.DOGFOOD_BROWSER_OWNERSHIP_DIR;
  const dogfoodTmp = process.env.DOGFOOD_TMPDIR;
  if (
    (dogfoodRoot && path.resolve(dogfoodRoot) !== root) ||
    (dogfoodTmp && path.resolve(dogfoodTmp, "browser-ownership") !== root)
  ) {
    throw new Error(
      "Use the shared BROWSER_OWNERSHIP_DIR; role-specific ownership directories cannot differ."
    );
  }
  await fs.mkdir(root, { mode: 0o700, recursive: true });
  await fs.chmod(root, 0o700);
  if (
    await fs.lstat(path.join(root, "acquire.lock")).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return null;
    })
  ) {
    throw new Error(
      `Legacy acquisition lock at ${root}/acquire.lock. Finish the old managed consumers before cutover; the lock was preserved.`
    );
  }
  return withBrowserLock(path.join(root, "ownership.lock"), false, async () => {
    const legacy = path.join(root, "owner");
    if (
      identity &&
      (await fs.lstat(legacy).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
        return null;
      }))
    ) {
      throw new Error(
        "Legacy ownership exists. Close the old consumers and recover using the old package before migration; state was preserved."
      );
    }
    return await action();
  });
};

const conflict = (owner) =>
  new Error(
    `Managed ${owner.role} Chrome is already owned by '${owner.id}' in '${owner.workspace}'. Close that consumer, then run managed-chrome-owner recover if ownership remains.`
  );

const matching = (owner, token) => {
  if (!owner || owner.token !== token) {
    throw new Error("Ownership changed; refusing an outdated request.");
  }
  return owner;
};

const probe = async (owner) => {
  const prefix = owner.role === "dogfood" ? "DOGFOOD" : "PWCLI";
  const filename =
    owner.role === "dogfood" ? "dogfood-chrome-windows.ps1" : "windows.ps1";
  let script =
    process.env[`${prefix}_WINDOWS_SCRIPT`] ||
    fileURLToPath(new URL(filename, import.meta.url));
  if (!/^[A-Za-z]:/u.test(script)) {
    const converted = await exec(
      process.env[`${prefix}_WSLPATH`] || "wslpath",
      ["-w", script]
    );
    script = converted.stdout.trim();
  }
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Action",
    "Inspect",
  ];
  if (identity || owner.role === "dogfood") {
    args.push(
      "-ProfileDir",
      owner.profile,
      "-DebugPort",
      new URL(owner.endpoint).port
    );
  }
  if (owner.role === "dogfood") {
    args.push("-RunId", owner.id);
  }
  const result = await exec(
    process.env[`${prefix}_POWERSHELL`] || "powershell.exe",
    args,
    { timeout: 15_000 }
  );
  const status = result.stdout.trim();
  if (
    status === "absent" ||
    /^managed:(?:headless|headed):[1-9][0-9]*$/u.test(status)
  ) {
    return status;
  }
  throw new Error(
    `Chrome state is unconfirmed (${status || "empty response"}); ownership was preserved.`
  );
};

const runStartup = async (token, [program, ...args]) => {
  if (!program) {
    throw new Error("run requires a startup command after --");
  }
  await locked(async () => {
    const owner = matching(await readOwner(), token);
    if (owner.phase !== "reserved") {
      throw new Error("Only a new reservation can start Chrome.");
    }
    await writeOwner({ ...owner, phase: "starting" });
  });
  let result;
  let failure;
  try {
    result = await exec(program, args, { maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    failure = error;
  }
  // A killed supervisor must leave an uncertain launch reserved. A completed
  // command (including a nonzero exit) can no longer initiate another launch.
  if (!failure || Number.isInteger(failure.code)) {
    await locked(async () => {
      const owner = matching(await readOwner(), token);
      await writeOwner({ ...owner, phase: "settled" });
    });
  }
  if (failure) {
    throw failure instanceof Error ? failure : new Error(String(failure));
  }
  return result.stdout.trim();
};

const activate = async (owner, token) => {
  matching(owner, token);
  if (!["settled", "active"].includes(owner.phase)) {
    throw new Error("Startup has not completed.");
  }
  const status = await probe(owner);
  const [, mode, pid] = status.split(":");
  if (
    status === "absent" ||
    mode !== owner.mode ||
    (owner.browserPid && owner.browserPid !== Number(pid))
  ) {
    throw new Error(
      "The requested Chrome is not running; ownership was preserved."
    );
  }
  await writeOwner({ ...owner, browserPid: Number(pid), phase: "active" });
};

const release = async (owner, token, command) => {
  if (!owner && command === "recover") {
    if (!identity) {
      const entries = await fs.readdir(root).catch((error) => {
        if (error.code === "ENOENT") {
          return [];
        }
        throw error;
      });
      const identities = entries.filter(
        (name) => name.startsWith("identity-") && name.endsWith(".json")
      );
      if (identities.length) {
        throw new Error(
          "Bare recover found no legacy owner, but identity-scoped owner records exist; pass --identity to select one (see managed-chrome-owner status)."
        );
      }
    }
    return;
  }
  if (command === "release") {
    matching(owner, token);
    if (owner.phase === "reserved") {
      // Cancellation shares run's lock; removing the token prevents a later start.
      return fs.unlink(ownerFile);
    }
  }
  if (owner.phase === "starting") {
    throw new Error(
      "Startup is still in progress or unconfirmed; ownership was preserved."
    );
  }
  if (
    command === "recover" &&
    ["reserved", "settled"].includes(owner.phase) &&
    (await callerAlive(owner))
  ) {
    throw new Error(
      "A live startup reservation exists; ownership was preserved."
    );
  }
  const status = await probe(owner);
  if (status !== "absent") {
    throw new Error(
      "Chrome is still running; ownership was preserved. Close it, then run managed-chrome-owner recover."
    );
  }
  await fs.unlink(ownerFile);
};

const allocateDogfoodEndpoint = (others, id) => {
  const occupied = new Set(others.map((other) => other.endpoint));
  const offset = Number.parseInt(digest(id).slice(0, 8), 16) % 64;
  const endpoint = Array.from(
    { length: 64 },
    (_, index) => `http://127.0.0.1:${19_330 + ((offset + index) % 64)}`
  ).find((candidate) => !occupied.has(candidate));
  if (!endpoint) {
    throw new Error(
      "No unreserved Dogfood CDP port remains; existing owners were preserved."
    );
  }
  return endpoint;
};

const reserve = async (owner, values) => {
  if (owner) {
    if (
      owner.role === "playwright" &&
      values.role === owner.role &&
      values.token === owner.token &&
      owner.phase === "active"
    ) {
      return owner.token;
    }
    throw conflict(owner);
  }
  const automaticEndpoint =
    identity && values.role === "dogfood" && values.endpoint === "auto";
  if (
    !["playwright", "dogfood", "attachment"].includes(values.role) ||
    !values.id ||
    !values.profile ||
    (!validEndpoint(values.endpoint) && !automaticEndpoint) ||
    !["headless", "headed"].includes(values.mode)
  ) {
    throw new Error("reserve requires role, id, mode, profile and endpoint");
  }
  const entries = await fs.readdir(root);
  const files = entries.filter(
    (name) => name.startsWith("identity-") && name.endsWith(".json")
  );
  const others = await Promise.all(
    files
      .map((name) => path.join(root, name))
      .filter((filename) => filename !== ownerFile)
      .map((filename) => readOwner(filename))
  );
  if (automaticEndpoint) {
    values.endpoint = allocateDogfoodEndpoint(others, values.id);
  }
  for (const other of others) {
    if (
      !identity ||
      other.endpoint === values.endpoint ||
      other.profile.toLowerCase().replaceAll("/", "\\") ===
        values.profile.toLowerCase().replaceAll("/", "\\")
    ) {
      throw new Error(
        "Browser resource conflict with an existing identity; consumer was preserved."
      );
    }
  }
  const caller = await processIdentity(Number(values.pid));
  if (!caller) {
    throw new Error("reserve requires the live caller's --pid");
  }
  const reservation = {
    browserPid: null,
    caller,
    endpoint: values.endpoint,
    id: values.id,
    mode: values.mode,
    phase: "reserved",
    profile: values.profile,
    role: values.role,
    token: randomUUID(),
    version: 1,
    workspace: process.cwd(),
  };
  await writeOwner(reservation);
  return reservation.token;
};

const ephemeralRange = async () => {
  const filename =
    process.env.BROWSER_EPHEMERAL_RANGE_FILE ||
    "/proc/sys/net/ipv4/ip_local_port_range";
  const text = await fs.readFile(filename, "utf-8");
  const parts = text.trim().split(/\s+/u).map(Number);
  if (
    parts.length !== 2 ||
    parts.some(
      (port) => !Number.isInteger(port) || port < 1 || port > 65_535
    ) ||
    parts[0] > parts[1]
  ) {
    throw new Error(
      "Invalid Linux ephemeral port range; allocation was preserved."
    );
  }
  return parts;
};

const checkRelocation = async (values, key, previous) => {
  if (values.role !== "playwright" || identity !== key || !previous) {
    throw new Error("relocate requires the exact existing worktree identity.");
  }
  if (await readOwner()) {
    throw new Error(
      "Release the worktree owner before relocating; state was preserved."
    );
  }
  if (
    (await probe({
      endpoint: `http://127.0.0.1:${previous.port}`,
      profile: previous.profile,
      role: "playwright",
    })) !== "absent"
  ) {
    throw new Error(
      "Close the worktree Chrome before relocating; state was preserved."
    );
  }
};

const locate = async (values, relocate = false) => {
  if (!["playwright", "attachment"].includes(values.role)) {
    throw new Error("locate requires playwright or attachment role");
  }
  const workspace =
    values.role === "attachment"
      ? "shared"
      : await fs.realpath(values.workspace || process.cwd());
  const key = `${values.role}-${digest(workspace)}`;
  const filename = path.join(root, "allocations.json");
  const allocations = await fs
    .readFile(filename, "utf-8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return {};
    });
  if (relocate) {
    await checkRelocation(values, key, allocations[key]);
  }
  if (!allocations[key] || relocate) {
    const used = new Set(
      Object.values(allocations).flatMap((item) => [item.port, item.dashboard])
    );
    let port =
      values.role === "attachment"
        ? 9222
        : 20_000 +
          (Number.parseInt(digest(workspace).slice(0, 6), 16) % 18_000) * 2;
    const [firstEphemeral, lastEphemeral] = await ephemeralRange();
    while (
      used.has(port) ||
      used.has(port + 1) ||
      (port <= lastEphemeral && port + 1 >= firstEphemeral)
    ) {
      port += 2;
    }
    if (port > 65_000) {
      throw new Error("No browser ports available");
    }
    allocations[key] = {
      dashboard: port + 1,
      port,
      profile:
        allocations[key]?.profile ??
        (values.role === "attachment"
          ? "%LOCALAPPDATA%\\aiakos\\playwright-cli\\chrome-profile"
          : `%LOCALAPPDATA%\\aiakos\\playwright-cli\\worktrees\\${digest(workspace)}`),
    };
    const temporary = `${filename}.${randomUUID()}`;
    await fs.writeFile(temporary, JSON.stringify(allocations), {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, filename);
  }
  const item = allocations[key];
  return [
    key,
    item.profile,
    `http://127.0.0.1:${item.port}`,
    item.dashboard,
  ].join("\t");
};

const main = () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      [
        "workspace",
        "identity",
        "role",
        "id",
        "pid",
        "mode",
        "profile",
        "endpoint",
        "token",
      ].map((key) => [key, { type: "string" }])
    ),
  });
  ({ identity } = values);
  if (identity) {
    ownerFile = path.join(root, `identity-${digest(identity)}.json`);
  }
  const [command, token, ...startup] = positionals;
  if (command === "run") {
    return runStartup(token, startup);
  }
  return locked(async () => {
    if (command === "relocate") {
      // Never wait for runtime while holding ownership: wrappers lock in the reverse order.
      return withStoppedPlaywrightRuntime(identity, () => locate(values, true));
    }
    if (command === "locate") {
      return locate(values);
    }
    const owner = await readOwner();
    if (command === "status") {
      if (!identity && !owner) {
        const files = await fs.readdir(root);
        const owners = await Promise.all(
          files
            .filter(
              (name) => name.startsWith("identity-") && name.endsWith(".json")
            )
            .map((name) => readOwner(path.join(root, name)))
        );
        return JSON.stringify(owners.length ? owners : null);
      }
      return JSON.stringify(owner);
    }
    if (command === "check") {
      if (
        owner &&
        (owner.role !== values.role || owner.token !== values.token)
      ) {
        throw conflict(owner);
      }
      return;
    }
    if (command === "activate") {
      return activate(owner, token);
    }
    if (command === "release" || command === "recover") {
      return release(owner, token, command);
    }
    if (command === "reserve") {
      return reserve(owner, values);
    }
    throw new Error(
      "Use locate, relocate, status, reserve, run, activate, release, check or recover."
    );
  });
};

try {
  const result = await main();
  if (result !== undefined) {
    process.stdout.write(`${result}\n`);
  }
} catch (error) {
  process.stderr.write(`managed-chrome-owner: ${error.message}\n`);
  process.exitCode = 1;
}
