import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { arch, release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  namespaceProbe as probeArgs,
  parseTrial,
  selectContainment,
  verifyCohort,
  verifyLocal,
  validGroupCredentials,
} from "./linux-process-proof.ts";
import { collectMetadata } from "./linux-process-proof-metadata.ts";
import resolutions from "./linux-process-proof-resolutions.json";

const control = fileURLToPath(new URL("..", import.meta.url));
const proofTools = [
  "cc",
  "unshare",
  "systemd-run",
  "nix",
  "nix-build",
  "nix-store",
  "setpriv",
  "bun",
  "sudo",
  "python3",
  "git",
  "bash",
];
const hash = (path: string) => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
const json = (path: string) => JSON.parse(fs.readFileSync(path, "utf8"));
const write = (path: string, value: unknown) =>
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
function command(command: string, args: string[], cwd: string, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

const probeOutputLimit = 32 * 1024 * 1024;
function inspectProbeProcess(pid: number, expectedExecutable: string, expectedStartTicks?: string) {
  const proc = "/proc/" + pid;
  const identity = () => {
    const stat = fs.readFileSync(proc + "/stat", "utf8");
    const end = stat.lastIndexOf(")");
    if (end < 0) throw Object.assign(new Error("stat-parse"), { code: "EIO" });
    const fields = stat
      .slice(end + 1)
      .trim()
      .split(/\s+/);
    const startTicks = fields[19];
    if (!/^\d+$/.test(startTicks ?? ""))
      throw Object.assign(new Error("stat-parse"), { code: "EIO" });
    let executable: string;
    try {
      executable = fs.readlinkSync(proc + "/exe");
    } catch (error) {
      throw Object.assign(error as NodeJS.ErrnoException, { startTicks });
    }
    return { startTicks, executable };
  };
  const processChanged = (
    before: { startTicks: string; executable: string },
    after: { startTicks: string; executable: string },
  ) => ({
    status: "process-changed",
    pid,
    expectedStartTicks: expectedStartTicks ?? before.startTicks,
    observedStartTicks: after.startTicks,
  });
  const failure = (error: unknown, startTicks?: string) => {
    const code = (error as NodeJS.ErrnoException).code;
    const knownStartTicks =
      startTicks ??
      (error as NodeJS.ErrnoException & { startTicks?: string }).startTicks ??
      expectedStartTicks;
    const result =
      code === "ENOENT"
        ? { status: "process-exited-before-sample", pid }
        : {
            status: code === "EACCES" || code === "EPERM" ? "permission-denied" : "unavailable",
            pid,
            error: code,
          };
    return knownStartTicks ? { ...result, startTicks: knownStartTicks } : result;
  };
  let before: ReturnType<typeof identity>;
  try {
    before = identity();
  } catch (error) {
    return failure(error);
  }
  if (expectedStartTicks && before.startTicks !== expectedStartTicks)
    return {
      status: "process-changed",
      pid,
      expectedStartTicks,
      observedStartTicks: before.startTicks,
    };
  if (before.executable.endsWith(" (deleted)") || before.executable !== expectedExecutable) {
    try {
      const after = identity();
      if (after.startTicks !== before.startTicks || after.executable !== before.executable)
        return processChanged(before, after);
    } catch (error) {
      return failure(error, before.startTicks);
    }
    return {
      status: "exe-mismatch",
      pid,
      startTicks: before.startTicks,
      executable: before.executable,
    };
  }
  const lines: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(proc + "/status", "utf8").split("\n")) {
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      const name = line.slice(0, separator);
      if (
        [
          "Uid",
          "Gid",
          "Groups",
          "CapInh",
          "CapPrm",
          "CapEff",
          "CapBnd",
          "CapAmb",
          "NoNewPrivs",
          "Seccomp",
        ].includes(name)
      )
        lines[name] = line.slice(separator + 1).trim();
    }
  } catch (error) {
    return failure(error, before.startTicks);
  }
  const capabilityNames = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];
  const capabilities = Object.fromEntries(
    capabilityNames.filter((name) => lines[name] !== undefined).map((name) => [name, lines[name]]),
  );
  const profile = readContext(proc + "/attr/current");
  let after: ReturnType<typeof identity>;
  try {
    after = identity();
  } catch (error) {
    return failure(error, before.startTicks);
  }
  if (after.startTicks !== before.startTicks || after.executable !== before.executable)
    return processChanged(before, after);
  return {
    status: "observed",
    pid,
    startTicks: before.startTicks,
    executable: before.executable,
    sampledAt: new Date().toISOString(),
    identity: Object.fromEntries(
      ["Uid", "Gid", "Groups"]
        .filter((name) => lines[name] !== undefined)
        .map((name) => [name, lines[name]]),
    ),
    profile,
    capabilities: {
      status: capabilityNames.every((name) => lines[name] !== undefined) ? "observed" : "partial",
      values: capabilities,
      missing: capabilityNames.filter((name) => lines[name] === undefined),
    },
    restrictions: Object.fromEntries(
      ["NoNewPrivs", "Seccomp"]
        .filter((name) => lines[name] !== undefined)
        .map((name) => [name, lines[name]]),
    ),
  };
}
async function namespaceProbe(executable: string, cwd: string, argv = probeArgs) {
  const startedAt = new Date().toISOString();
  const child = spawn(executable, argv, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  const stdoutBuffers: Buffer[] = [];
  const stderrBuffers: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputTruncated = false;
  const collect = (buffers: Buffer[], size: number, chunk: Buffer) => {
    const remaining = Math.max(0, probeOutputLimit - size);
    if (chunk.length > remaining && !outputTruncated) {
      outputTruncated = true;
      child.kill("SIGTERM");
    }
    if (remaining) buffers.push(chunk.subarray(0, remaining));
    return size + Math.min(chunk.length, remaining);
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes = collect(stdoutBuffers, stdoutBytes, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes = collect(stderrBuffers, stderrBytes, chunk);
  });
  let observedStartTicks: string | undefined;
  const sampleProcess = () => {
    if (!pid) return { status: "probe-pid-unavailable" };
    const sample = inspectProbeProcess(pid, executable, observedStartTicks);
    if (
      !observedStartTicks &&
      sample.status !== "process-changed" &&
      "startTicks" in sample &&
      typeof sample.startTicks === "string"
    )
      observedStartTicks = sample.startTicks;
    return sample;
  };
  let processObservation = pid ? sampleProcess() : undefined;
  const sampleTimer = setInterval(() => {
    if (
      pid &&
      observedStartTicks &&
      ["unavailable", "permission-denied", "exe-mismatch"].includes(
        processObservation?.status ?? "",
      )
    )
      processObservation = sampleProcess();
  }, 5);
  let spawnError: NodeJS.ErrnoException | undefined;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 180_000);
  const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
    (resolveResult) => {
      child.once("error", (error) => {
        spawnError = error as NodeJS.ErrnoException;
      });
      child.once("close", (status, signal) => resolveResult({ status, signal }));
    },
  );
  clearTimeout(timeout);
  clearInterval(sampleTimer);
  const endedAt = new Date().toISOString();
  return {
    path: executable,
    argv,
    pid,
    startedAt,
    endedAt,
    status: timedOut || outputTruncated ? null : result.status,
    signal: result.signal,
    stdout: Buffer.concat(stdoutBuffers).toString("utf8"),
    stderr: Buffer.concat(stderrBuffers).toString("utf8"),
    outputTruncated,
    error: timedOut ? "ETIMEDOUT" : outputTruncated ? "ENOBUFS" : spawnError?.message,
    processObservation: processObservation ?? { status: "probe-pid-unavailable" },
  };
}
function auditMessagePid(message: string) {
  const pids: number[] = [];
  let token = "";
  let quoted = false;
  let escaped = false;
  const collect = () => {
    const match = /^pid=(\d+)$/.exec(token);
    if (match) pids.push(Number(match[1]));
    token = "";
  };
  for (const character of message) {
    if (quoted) {
      token += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
      token += character;
    } else if (/\s|,/.test(character)) {
      collect();
    } else {
      token += character;
    }
  }
  collect();
  return pids.length === 1 ? pids[0] : undefined;
}
/** probeのPIDと時刻に限定し、journalの取得不能と一致なしを区別する。 */
function probeAudit(
  probe: { pid?: number; startedAt: string; endedAt: string },
  sudoPath: string | undefined,
  cwd: string,
) {
  const unavailable = (status: string, reason?: string, extra: Record<string, unknown> = {}) => ({
    status,
    reason,
    events: [],
    ...extra,
  });
  if (typeof probe.pid !== "number" || !Number.isSafeInteger(probe.pid) || probe.pid <= 0)
    return unavailable("probe-pid-unavailable");
  const started = Date.parse(probe.startedAt);
  const ended = Date.parse(probe.endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started)
    return unavailable("window-unavailable");
  const since = new Date(started - 1_000).toISOString();
  const until = new Date(ended + 1_000).toISOString();
  const window = { since, until };
  const journalPath = "/usr/bin/journalctl";
  const journalArgs = [
    "--dmesg",
    "--since",
    since,
    "--until",
    until,
    "--grep=(^|[^[:alnum:]_])pid=" + probe.pid + "([^[:alnum:]_]|$)",
    "--output=json",
    "--output-fields=__REALTIME_TIMESTAMP,_PID,MESSAGE",
    "--no-pager",
    "--lines=101",
  ];
  let readerPath: string;
  let readerHash: string;
  try {
    readerPath = fs.realpathSync(journalPath);
    readerHash = hash(journalPath);
  } catch (error) {
    return unavailable(
      "unavailable",
      (error as NodeJS.ErrnoException).code ?? "journalctl-unavailable",
      {
        reader: {
          path: journalPath,
          version: { status: "unavailable", reason: "binary-unavailable" },
        },
        window,
      },
    );
  }
  const versionResult = spawnSync(readerPath, ["--version"], {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 8 * 1024,
  });
  const versionError = (versionResult.error as NodeJS.ErrnoException | undefined)?.code;
  const versionLine = (versionResult.stdout ?? "").split("\n").find(Boolean)?.trim().slice(0, 256);
  const version =
    !versionError && versionResult.status === 0 && versionLine
      ? { status: "recorded", argv: ["--version"], value: versionLine }
      : {
          status: "unavailable",
          argv: ["--version"],
          reason: versionError ?? "version-exit-" + versionResult.status,
        };
  const reader = { path: readerPath, hash: readerHash, version };
  const command = sudoPath
    ? { path: sudoPath, argv: ["-n", "--", readerPath, ...journalArgs] }
    : { path: readerPath, argv: journalArgs };
  const context = { reader, window, command };
  const result = spawnSync(command.path, command.argv, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 256 * 1024,
  });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const stderr = result.stderr ?? "";
  if (errorCode === "ENOBUFS") return unavailable("truncated", "size-limit", context);
  if (errorCode === "ETIMEDOUT") return unavailable("timeout", undefined, context);
  if (errorCode)
    return unavailable(
      errorCode === "EACCES" || errorCode === "EPERM" ? "permission-denied" : "unavailable",
      errorCode,
      context,
    );
  const noMatches =
    result.status === 1 && !result.signal && !(result.stdout ?? "").trim() && !stderr.trim();
  if (result.status !== 0 && !noMatches) {
    const denied = /permission denied|not allowed|a password is required|no password/i.test(stderr);
    return unavailable(
      denied ? "permission-denied" : "unavailable",
      "journal-exit-" + result.status,
      context,
    );
  }
  const rows = (result.stdout ?? "").split("\n").filter(Boolean);
  if (rows.length >= 101)
    return unavailable("truncated", "record-limit", { ...context, recordCount: rows.length });
  if (rows.length === 0) {
    const versionUnavailable = version.status !== "recorded";
    const readStatus = noMatches ? "no-matching-events" : "empty";
    return {
      ...context,
      status: versionUnavailable ? "unavailable" : readStatus,
      reason: versionUnavailable ? "journalctl-version-unavailable" : undefined,
      readStatus,
      recordCount: 0,
      events: [],
    };
  }
  const entries: Record<string, unknown>[] = [];
  for (const line of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return unavailable("invalid-json", undefined, { ...context, recordCount: rows.length });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return unavailable("unavailable", "record-not-object", {
        ...context,
        recordCount: rows.length,
      });
    const row = parsed as Record<string, unknown>;
    const message = typeof row.MESSAGE === "string" ? row.MESSAGE : "";
    const timestamp = Number(row.__REALTIME_TIMESTAMP);
    if (!message || !Number.isFinite(timestamp))
      return unavailable("unavailable", "message-or-timestamp-missing", {
        ...context,
        recordCount: rows.length,
      });
    const millis = timestamp / 1_000;
    if (millis < started - 1_000 || millis > ended + 1_000) continue;
    const pidMatches = auditMessagePid(message) === probe.pid;
    const relevant = /\baudit(?::|\(\d+(?:\.\d+)?:\d+\):)/.test(message);
    if (!pidMatches || !relevant) continue;
    const messageTruncated = message.length > 4_096;
    entries.push({
      timestamp: new Date(millis).toISOString(),
      journalPid: typeof row._PID === "string" ? row._PID : undefined,
      messagePid: probe.pid,
      message: message.slice(0, 4_096),
      messageTruncated,
    });
    if (entries.length > 20)
      return unavailable("truncated", "event-limit", {
        ...context,
        recordCount: rows.length,
        events: entries.slice(0, 20),
      });
    if (messageTruncated)
      return unavailable("truncated", "message-limit", {
        ...context,
        recordCount: rows.length,
        events: entries,
      });
  }
  const readStatus = entries.length ? "matched" : "no-matching-events";
  const versionUnavailable = version.status !== "recorded";
  return {
    ...context,
    status: versionUnavailable ? "unavailable" : readStatus,
    reason: versionUnavailable ? "journalctl-version-unavailable" : undefined,
    readStatus,
    recordCount: rows.length,
    events: entries,
  };
}
function checked(command_: string, args: string[], cwd: string) {
  const result = command(command_, args, cwd);
  if (result.status !== 0 || result.error)
    throw new Error(`${command_}: ${result.error ?? result.stderr}`);
  return result.stdout.trim();
}
function readContext(path: string) {
  try {
    return { value: fs.readFileSync(path, "utf8") };
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code };
  }
}
/** 両checkoutと実行環境のsource/workflow/run/attemptを検査する。 */
function identity(root: string) {
  const sourceSha = process.env.PROOF_SOURCE_SHA!,
    workflowSha = process.env.GITHUB_SHA!;
  const runId = process.env.GITHUB_RUN_ID!,
    attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (
    !/^[0-9a-f]{40}$/.test(sourceSha ?? "") ||
    !/^[0-9a-f]{40}$/.test(workflowSha ?? "") ||
    !/^[1-9][0-9]*$/.test(runId ?? "") ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    throw new Error("source/workflow/run/attempt の入力が不正です");
  if (
    checked("git", ["rev-parse", "HEAD"], root) !== sourceSha ||
    checked("git", ["rev-parse", "HEAD"], control) !== workflowSha
  )
    throw new Error("checkout の SHA が一致しません");
  return { sourceSha, workflowSha, runId, attempt };
}
function sources(root: string) {
  return Object.fromEntries(
    checked(
      "git",
      ["ls-files", "--", "lib", "tests", "development/linux-process-proof-cases.json"],
      root,
    )
      .split("\n")
      .filter(Boolean)
      .map((path) => [path, hash(join(root, path))]),
  );
}
function validRunnerImage(architecture: string, imageOS: unknown) {
  return (
    (architecture === "x64" && imageOS === "ubuntu24") ||
    (architecture === "arm64" && imageOS === "ubuntu24-arm64")
  );
}
/**
 * cgroup 経路は user manager に届く必要がある。runner の job 環境には user bus の場所が無いため、
 * linger で起動済みの user bus があれば、その場所を試行と前提検査へ明示的に渡す。
 */
function exportUserSession() {
  const uid = process.getuid!();
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  if (fs.existsSync(`${runtime}/bus`)) {
    process.env.XDG_RUNTIME_DIR = runtime;
    process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${runtime}/bus`;
  }
  const user = checked("id", ["-un"], control);
  return {
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    bus: fs.existsSync(`${runtime}/bus`),
    linger: command("loginctl", ["show-user", user, "--property=Linger", "--value"], control),
    userManager: command("systemctl", ["is-active", `user@${uid}.service`], control),
  };
}

async function preflight(
  root: string,
  onProgress?: (state: Record<string, unknown>) => void,
  local = false,
) {
  const session = exportUserSession();
  const tools = Object.fromEntries(
    proofTools.map((name) => {
      const selected = name === "bash" ? "/bin/bash" : Bun.which(name);
      if (!selected) throw new Error(`必須 tool がありません: ${name}`);
      const path = fs.realpathSync(selected);
      return [
        name,
        { path, hash: hash(path), version: checked(path, ["--version"], root).split("\n")[0] },
      ];
    }),
  );
  const contexts = Object.fromEntries(
    [
      "/proc/self/status",
      "/proc/self/uid_map",
      "/proc/self/gid_map",
      "/proc/self/attr/current",
      "/sys/kernel/security/lsm",
      "/sys/module/apparmor/parameters/enabled",
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
      "/proc/sys/kernel/unprivileged_userns_clone",
      "/proc/sys/user/max_user_namespaces",
    ].map((path) => [path, readContext(path)]),
  );
  const namespaces = Object.fromEntries(
    ["user", "pid", "mnt"].map((name) => [name, fs.readlinkSync(`/proc/self/ns/${name}`)]),
  );
  // 方式の選択は launcher と同じ順に実際に試す。下の namespace probe は選択の根拠として記録する。
  const containment = selectContainment();
  const probe = await namespaceProbe(tools.unshare!.path, root);
  const audit =
    probe.status === 0
      ? { status: "not-requested", events: [] }
      : probeAudit(probe, tools.sudo!.path, root);
  const observed = {
    platform: process.platform,
    arch: arch(),
    kernel: release(),
    imageOS: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    tools,
    contexts,
    namespaces,
    probe: { ...probe, audit },
    containment,
    session,
    environment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NIX_REMOTE: process.env.NIX_REMOTE,
      PROCESS_PROOF_NIX_BASH: process.env.PROCESS_PROOF_NIX_BASH,
      PROCESS_PROOF_NIX_STDENV: process.env.PROCESS_PROOF_NIX_STDENV,
      PROCESS_PROOF_GROUP_FILE: process.env.PROCESS_PROOF_GROUP_FILE,
      PROCESS_PROOF_GROUP_GID: process.env.PROCESS_PROOF_GROUP_GID,
    },
    uid: process.getuid!(),
    euid: process.geteuid!(),
    gid: process.getgid!(),
    groups: process.getgroups!(),
    bun: Bun.version,
  };
  onProgress?.(observed);
  const config = JSON.parse(
    checked(
      "nix",
      ["--extra-experimental-features", "nix-command", "config", "show", "--json"],
      root,
    ),
  );
  const nix = {
    mode: "multi-user",
    remote: process.env.NIX_REMOTE,
    sandbox: config.sandbox?.value,
    buildUsersGroup: config["build-users-group"]?.value,
    daemon: command(
      "nix",
      [
        "--extra-experimental-features",
        "nix-command",
        "store",
        "ping",
        "--store",
        "daemon",
        "--json",
      ],
      root,
    ),
    bash: process.env.PROCESS_PROOF_NIX_BASH,
    stdenv: process.env.PROCESS_PROOF_NIX_STDENV,
  };
  const groupPath = process.env.PROCESS_PROOF_GROUP_FILE!;
  const group = fs.statSync(groupPath);
  const errors: string[] = [];
  if (
    process.platform !== "linux" ||
    arch() !== process.env.PROOF_ARCH ||
    Bun.version !== "1.4.4" ||
    process.getuid!() === 0 ||
    process.geteuid!() === 0
  )
    errors.push("OS・architecture・Bun・非root 条件が不一致です");
  if (
    !local &&
    (!validRunnerImage(arch(), process.env.ImageOS) ||
      !process.env.ImageVersion ||
      !/^VERSION_ID="24\.04"$/m.test(fs.readFileSync("/etc/os-release", "utf8")))
  )
    errors.push("Ubuntu VM image が不一致です");
  if (local && !/microsoft-standard-WSL2/.test(release()))
    errors.push("手元実行は WSL2 kernel だけを対象にします");
  if (observed.containment === "refused")
    errors.push("namespace も委譲 scope も使えないため準備を始められません");
  // 手元の WSL2 は既存の Nix をそのまま使い、runner で導入した版と remote 設定は求めない。
  if (
    (!local && (tools.nix!.version !== "nix (Nix) 2.34.6" || nix.remote !== "daemon")) ||
    nix.sandbox !== true ||
    nix.buildUsersGroup !== "nixbld" ||
    nix.daemon.status !== 0 ||
    !nix.bash?.startsWith("/nix/store/") ||
    !nix.stdenv?.startsWith("/nix/store/")
  )
    errors.push("Nix daemon・設定・closure が不一致です");
  if (
    group.uid === process.getuid!() ||
    group.gid !== Number(process.env.PROCESS_PROOF_GROUP_GID) ||
    (group.mode & 0o777) !== 0o060 ||
    process.getgroups!().includes(group.gid) ||
    group.gid === process.getgid!()
  )
    errors.push("補助 group fixture の資格情報が不正です");
  return {
    verified: errors.length === 0,
    errors,
    ...observed,
    nix,
    group: {
      path: groupPath,
      ownerUid: group.uid,
      gid: group.gid,
      mode: group.mode & 0o777,
      dev: String(group.dev),
      ino: String(group.ino),
    },
  };
}

/** 手元の WSL2 では対象 SHA を checkout の HEAD に固定し、未 commit の変更があれば始めない。 */
function localIdentity(root: string, out: string) {
  if (checked("git", ["status", "--porcelain", "--untracked-files=no"], root))
    throw new Error("対象 checkout に未 commit の変更があるため SHA を固定できません");
  process.env.PROOF_ARCH = arch();
  const revision = fs.readFileSync(join(root, "tests/fixtures/raw-codex/nixpkgs-revision"), "utf8");
  for (const name of ["bash", "stdenv"]) {
    const key = `PROCESS_PROOF_NIX_${name.toUpperCase()}`;
    process.env[key] ??= checked(
      "nix-build",
      [
        join(control, "development/linux-process-proof.nix"),
        ...["--argstr", "system", `${arch() === "arm64" ? "aarch64" : "x86_64"}-linux`],
        ...["--argstr", "revision", revision.trim(), "-A", name],
        ...["--out-link", join(out, `nix-${name}`)],
      ],
      root,
    );
  }
  return { sourceSha: checked("git", ["rev-parse", "HEAD"], root) };
}

async function run(root: string, out: string, local = false) {
  fs.mkdirSync(out, { recursive: true });
  const job: Record<string, unknown> = {
    schema: local ? "linux-process-proof-local-job/v1" : "linux-process-proof-job/v1",
    arch: process.env.PROOF_ARCH,
    trials: [],
  };
  try {
    Object.assign(job, local ? localIdentity(root, out) : identity(root));
    job.arch = process.env.PROOF_ARCH;
    job.sources = sources(root);
    job.controllerHash = hash(fileURLToPath(import.meta.url));
    try {
      job.preflight = await preflight(
        root,
        (observed) => {
          job.preflight = observed;
        },
        local,
      );
    } catch (error) {
      if (job.preflight)
        job.preflight = {
          ...(job.preflight as Record<string, unknown>),
          verified: false,
          errors: [String(error)],
        };
      throw error;
    }
    const before = JSON.stringify(job.sources);
    if (!(job.preflight as { verified: boolean }).verified)
      throw new Error("前提検査未達のため実証を開始しません");
    const trials: unknown[] = [];
    job.trials = trials;
    for (const repetition of [1, 2, 3]) {
      const temporary = fs.mkdtempSync(join(out, `temporary-${repetition}-`));
      const logName = `trial-${repetition}.log`;
      const environment = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: temporary,
        NO_COLOR: "1",
        PROCESS_PROOF_PID_NAMESPACE: "1",
        PROCESS_PROOF_RETAIN_TEMP: "1",
        ...(process.env.XDG_RUNTIME_DIR
          ? {
              XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
              DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
            }
          : {}),
      };
      const result = command(
        process.execPath,
        ["test", join(root, "tests/bun/process-namespace.test.ts")],
        root,
        { ...process.env, ...environment },
      );
      fs.writeFileSync(join(out, logName), result.stdout + result.stderr);
      let trial: unknown;
      try {
        trial = parseTrial(result.stdout + result.stderr, result.status, repetition);
      } catch (error) {
        trial = { repetition, exitCode: result.status, error: String(error) };
      }
      trials.push({
        ...(trial as object),
        environment,
        temporary: temporary.slice(out.length + 1),
        log: logName,
        logHash: hash(join(out, logName)),
        signal: result.signal,
        error: result.error,
      });
    }
    job.sourcesAfter = sources(root);
    job.callerAfter = {
      status: readContext("/proc/self/status"),
      uidMap: readContext("/proc/self/uid_map"),
      gidMap: readContext("/proc/self/gid_map"),
      namespaces: Object.fromEntries(
        ["user", "pid", "mnt"].map((name) => [name, fs.readlinkSync(`/proc/self/ns/${name}`)]),
      ),
    };
    if (before !== JSON.stringify(job.sourcesAfter))
      throw new Error("実行中に source が変化しました");
  } catch (error) {
    job.error = String(error);
  }
  write(join(out, "job.json"), job);
  if (local) {
    // runner と同じ判定ロジックで、GitHub 固有の run・artifact・履歴だけを要求しない。
    const input = {
      schema: "linux-process-proof-local/v1",
      host: "wsl2",
      sourceSha: job.sourceSha,
      job,
    };
    const verdict = verifyLocal(
      input,
      json(join(root, "development/linux-process-proof-cases.json")),
    );
    if (job.error) verdict.reasons.push(String(job.error));
    verdict.verified = verdict.reasons.length === 0;
    write(join(out, "verdict.json"), verdict);
    fs.writeFileSync(
      join(out, "summary.md"),
      `# WSL2 の正式実証（namespace 経路）\n\n判定: ${verdict.verified ? "成功" : "成功条件未達"}\n\nsource: ${String(job.sourceSha)}\nkernel: ${release()}\n\n` +
        verdict.reasons.map((reason) => `- ${reason.replaceAll("\n", " ")}`).join("\n") +
        "\n\nrunner の結果とは別に記録し、互いに読み替えない。#33 は OPEN、#82 は #33 待ち。\n",
    );
    if (!verdict.verified) process.exitCode = 1;
  }
  if (job.error) throw new Error(String(job.error));
}

export function readProofJob(root: string, directory: string, architecture: string) {
  const job = json(join(directory, "job.json"));
  const expectedSources = sources(root);
  if (
    job.schema !== "linux-process-proof-job/v1" ||
    job.arch !== architecture ||
    job.error ||
    job.preflight?.verified !== true ||
    !Number.isSafeInteger(job.preflight?.uid) ||
    job.preflight.uid <= 0 ||
    job.controllerHash !== hash(fileURLToPath(import.meta.url)) ||
    JSON.stringify(job.sources) !== JSON.stringify(expectedSources) ||
    JSON.stringify(job.sourcesAfter) !== JSON.stringify(expectedSources)
  )
    throw new Error("source・前提検査・controller の証跡が不正です");
  const environment = job.preflight;
  if (!validGroupCredentials(environment))
    throw new Error("資格情報・補助 group fixture の必須観測が不正です");
  if (
    environment.euid !== environment.uid ||
    environment.platform !== "linux" ||
    environment.arch !== architecture ||
    environment.bun !== "1.4.4" ||
    !["PATH", "HOME"].every(
      (name) =>
        typeof environment.environment?.[name] === "string" && environment.environment[name],
    ) ||
    !validRunnerImage(architecture, environment.imageOS) ||
    typeof environment.imageVersion !== "string" ||
    !environment.imageVersion ||
    typeof environment.kernel !== "string" ||
    !environment.kernel ||
    typeof environment.containment !== "string" ||
    environment.nix?.mode !== "multi-user" ||
    environment.nix.remote !== "daemon" ||
    environment.nix.sandbox !== true ||
    environment.nix.buildUsersGroup !== "nixbld" ||
    environment.nix.daemon?.status !== 0 ||
    !proofTools.every((name) => {
      const tool = environment.tools?.[name];
      return (
        typeof tool?.path === "string" &&
        tool.path.startsWith("/") &&
        typeof tool.version === "string" &&
        tool.version &&
        /^[a-f0-9]{64}$/.test(tool.hash)
      );
    }) ||
    !["/proc/self/status", "/proc/self/uid_map", "/proc/self/gid_map"].every(
      (path) => typeof environment.contexts?.[path]?.value === "string",
    ) ||
    !["user", "pid", "mnt"].every(
      (name) =>
        typeof environment.namespaces?.[name] === "string" &&
        job.callerAfter?.namespaces?.[name] === environment.namespaces[name],
    ) ||
    !["status", "uidMap", "gidMap"].every(
      (name) => typeof job.callerAfter?.[name]?.value === "string",
    )
  )
    throw new Error("実行環境・資格情報・namespace の必須観測が不足しています");
  const installerHash = fs.readFileSync(join(directory, "nix-installer.sha256"), "utf8").trim();
  if (
    installerHash !==
    (architecture === "x64"
      ? "311b9f406f0239ef640a1e3fbea1df1bac9d3a7c316c4def30df3206dd964960"
      : "09edae3ed146b1a47de84eda6135ef12ee74783d409e7a207c912cb94e14aa35")
  )
    throw new Error("Nix installer の hash が不一致です");
  for (const name of ["bash", "stdenv"]) {
    const storeRoot = fs.readFileSync(join(directory, `nix-${name}-root.txt`), "utf8").trim();
    const closure = fs
      .readFileSync(join(directory, `nix-${name}-closure.txt`), "utf8")
      .trim()
      .split("\n");
    if (
      job.preflight.nix[name] !== storeRoot ||
      !closure.includes(storeRoot) ||
      !closure.every((path: string) => /^\/nix\/store\/[a-z0-9]{32}-[^/]+$/.test(path))
    )
      throw new Error("Nix closure の証跡が不正です");
  }
  if (
    !Array.isArray(job.trials) ||
    JSON.stringify(job.trials.map((trial: { repetition: number }) => trial.repetition).sort()) !==
      "[1,2,3]"
  )
    throw new Error("反復1・2・3が一意に必要です");
  const rebuilt = [1, 2, 3].map((repetition) => {
    const trial = job.trials.find(
      (trial: { repetition: number }) => trial.repetition === repetition,
    );
    const path = join(directory, `trial-${repetition}.log`);
    if (
      trial?.log !== `trial-${repetition}.log` ||
      hash(path) !== trial.logHash ||
      trial.signal ||
      trial.error ||
      trial.environment?.PATH !== environment.environment.PATH ||
      trial.environment?.HOME !== environment.environment.HOME ||
      trial.environment?.PROCESS_PROOF_PID_NAMESPACE !== "1" ||
      trial.environment?.PROCESS_PROOF_RETAIN_TEMP !== "1" ||
      typeof trial.environment?.TMPDIR !== "string" ||
      !trial.environment.TMPDIR.endsWith(`/${trial.temporary}`)
    )
      throw new Error(`反復 ${repetition} の log 同一性・終了状態を確認できません`);
    const parsed = parseTrial(fs.readFileSync(path, "utf8"), trial.exitCode, repetition);
    if (JSON.stringify(parsed.observation) !== JSON.stringify(trial.observation))
      throw new Error("観測と raw log が一致しません");
    const build = (parsed.observation as { build?: { builds?: Record<string, string>[] } }).build;
    if (
      !build?.builds ||
      build.builds.length !== 6 ||
      !build.builds.every(
        (item) =>
          /^[a-f0-9]{64}$/.test(item.sourceHash!) && /^[a-f0-9]{64}$/.test(item.binaryHash!),
      )
    )
      throw new Error("source/binary hash が不足しています");
    if (
      JSON.stringify(build.builds.map((item) => `${item.source}/${item.variant}`).sort()) !==
      JSON.stringify(
        [
          "bun-process-namespace-observer.c/observer",
          "bun-process-pidfds.c/pidfds",
          "bun-exec-launcher.c/baseline",
          "bun-exec-pid-namespace.c/launcher",
          "bun-exec-pid-namespace.c/without-proc",
          "bun-exec-namespace-delay.c/delay.so",
        ].sort(),
      )
    )
      throw new Error("build fixture が一意に揃っていません");
    if (!new RegExp(`^temporary-${repetition}-[a-zA-Z0-9]+$`).test(trial.temporary))
      throw new Error("一時領域の対応が不正です");
    const temporary = join(directory, trial.temporary);
    const roots = fs
      .readdirSync(temporary)
      .filter((name) => name.startsWith("bun-process-namespace-"));
    if (roots.length !== 1) throw new Error("build 一時領域が1件必要です");
    for (const item of build.builds) {
      if (
        !/^[a-z.-]+$/.test(item.variant!) ||
        !/^[a-z.-]+$/.test(item.source!) ||
        expectedSources[`tests/fixtures/${item.source}`] !== item.sourceHash ||
        hash(join(temporary, roots[0]!, item.variant!)) !== item.binaryHash
      )
        throw new Error("保存された source/binary と hash が一致しません");
    }
    return parsed;
  });
  return { ...job, trials: rebuilt };
}

async function aggregate(root: string, raw: string, out: string) {
  fs.mkdirSync(out, { recursive: true });
  const current = identity(root);
  const cohort: Record<string, unknown> = {
    schema: "linux-process-proof-cohort/v1",
    ...current,
    jobs: [],
    historyComplete: false,
  };
  const errors: string[] = [];
  const jobs: unknown[] = [];
  cohort.jobs = jobs;
  for (const architecture of ["x64", "arm64"]) {
    try {
      const directory = join(
        raw,
        `linux-proof-${current.runId}-${current.attempt}-${architecture}`,
      );
      jobs.push(readProofJob(root, directory, architecture));
    } catch (error) {
      errors.push(`${architecture}: ${error}`);
    }
  }
  try {
    const metadata = await collectMetadata(
      async (path) => {
        const response = await fetch(`https://api.github.com/repos/treflebonbon/skills${path}`, {
          headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`public metadata API: HTTP ${response.status}`);
        return (await response.json()) as Record<string, unknown>;
      },
      current,
      resolutions.resolutions,
    );
    Object.assign(cohort, metadata);
  } catch (error) {
    errors.push(`metadata: ${error}`);
  }
  const verdict = verifyCohort(
    cohort,
    json(join(root, "development/linux-process-proof-cases.json")),
  );
  verdict.reasons.push(...errors);
  verdict.verified = verdict.reasons.length === 0;
  write(join(out, "cohort.json"), cohort);
  write(join(out, "verdict.json"), verdict);
  const summary =
    `# Linux 追加実証\n\n判定: ${verdict.verified ? "今回の追加実証は成功" : "成功条件未達"}\n\nsource: ${current.sourceSha}\nworkflow: ${current.workflowSha}\nrun/attempt: ${current.runId}/${current.attempt}\n\n` +
    verdict.reasons.map((reason) => `- ${reason.replaceAll("\n", " ")}`).join("\n") +
    "\n\n#33 は OPEN、#82 は #33 待ち、macOS 移行は保留。JSON と要約は人が確認したうえで Git 管理へ移す。\n";
  fs.writeFileSync(join(out, "summary.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (!verdict.verified) process.exitCode = 1;
}

if (import.meta.main) {
  const [mode, source, directory, output] = process.argv.slice(2);
  try {
    if (!source || !directory)
      throw new Error("run|local SOURCE OUTPUT / aggregate SOURCE RAW OUTPUT が必要です");
    if (mode === "run") await run(resolve(source), resolve(directory));
    else if (mode === "local") await run(resolve(source), resolve(directory), true);
    else if (mode === "aggregate" && output)
      await aggregate(resolve(source), resolve(directory), resolve(output));
    else throw new Error("不明な実行方式です");
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
