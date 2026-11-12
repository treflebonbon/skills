import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import corpus from "../fixtures/bun-process-lock-python.json";
import launcherCorpus from "../fixtures/bun-exec-python.json";

const root = fs.mkdtempSync(join(tmpdir(), "bun-process-lock-"));
const observer = join(root, "observer");
const snapshot = join(root, "snapshot.node");
const launcher = join(root, "launcher");
const entry = fileURLToPath(new URL("../fixtures/bun-exec-entry.sh", import.meta.url));
const prepare = fileURLToPath(new URL("../fixtures/bun-exec-prepare.ts", import.meta.url));
const launcherSource = new URL("../fixtures/bun-exec-launcher.c", import.meta.url);
const fixture = fileURLToPath(new URL("../fixtures/bun-process-lock.ts", import.meta.url));
const runner = fileURLToPath(new URL("../../lib/bun/run", import.meta.url));
const observerSource = new URL("../fixtures/bun-process-observer.c", import.meta.url);
let buildRecord: object | undefined;
let execObservation: object | undefined;
let launcherObservation: object | undefined;
type Report = {
  event: string;
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  tty: number[];
  foreground: number;
  usr1Blocked: number;
  blocked: number[];
  ignored: { int: number; pipe: number; xfsz: number };
  gitMarker: string;
  fd63: number;
  fds: number[];
  fd9: { dev: string; ino: string; cloexec: number } | null;
  marker: string;
  argv: string[];
};

beforeAll(() => {
  const buildStarted = performance.now();
  const build = spawnSync(
    "cc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      fileURLToPath(observerSource),
      "-o",
      observer,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (build.error || build.status !== 0)
    throw new Error(
      `process の観測用 fixture をビルドできません (status=${build.status}, signal=${build.signal}, error=${build.error?.message ?? "なし"})\nstdout: ${build.stdout ?? ""}\nstderr: ${build.stderr ?? ""}`,
    );
  const compiler = spawnSync("cc", ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (compiler.error || compiler.status !== 0) throw new Error("C compiler の版を記録できません");
  const node = spawnSync(
    "node",
    ["-p", "JSON.stringify({executable:process.execPath,version:process.version})"],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (node.error || node.status !== 0)
    throw new Error("Node-API header の検出には Node.js が必要です");
  const installation: { executable: string; version: string } = JSON.parse(node.stdout);
  const headerDirectory = join(
    dirname(fs.realpathSync(installation.executable)),
    "../include/node",
  );
  const snapshotBuild = spawnSync(
    "cc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-DNAPI_VERSION=6",
      "-DPROCESS_SNAPSHOT_ADDON",
      ...(process.platform === "darwin"
        ? ["-bundle", "-undefined", "dynamic_lookup"]
        : ["-shared", "-fPIC"]),
      "-I",
      headerDirectory,
      fileURLToPath(observerSource),
      "-o",
      snapshot,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (snapshotBuild.error || snapshotBuild.status !== 0)
    throw new Error(
      `観測用 Node-API snapshot をビルドできません (status=${snapshotBuild.status}, signal=${snapshotBuild.signal}, error=${snapshotBuild.error?.message ?? "なし"})\nstdout: ${snapshotBuild.stdout ?? ""}\nstderr: ${snapshotBuild.stderr ?? ""}`,
    );
  const launcherBuild = spawnSync(
    "cc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      fileURLToPath(launcherSource),
      "-o",
      launcher,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (launcherBuild.error || launcherBuild.status !== 0)
    throw new Error(
      `実証用 launcher をビルドできません (status=${launcherBuild.status}, signal=${launcherBuild.signal}, error=${launcherBuild.error?.message ?? "なし"})\nstdout: ${launcherBuild.stdout ?? ""}\nstderr: ${launcherBuild.stderr ?? ""}`,
    );
  const hash = (path: string | URL) =>
    createHash("sha256").update(fs.readFileSync(path)).digest("hex");
  buildRecord = {
    compiler: compiler.stdout.split("\n")[0],
    sourceHash: hash(observerSource),
    binaryHash: hash(observer),
    snapshotHash: hash(snapshot),
    launcherSourceHash: hash(launcherSource),
    launcherHash: hash(launcher),
    node: installation.version,
    headerDirectory,
    durationMs: Math.round(performance.now() - buildStarted),
  };
  // 3回の compile 各30秒と版検出2回各5秒の上限を外側でも確保する。
}, 105_000);
afterAll(() => {
  console.log(
    JSON.stringify({
      boundary: "process-lock",
      bun: Bun.version,
      os: process.platform,
      kernel: release(),
      architecture: process.arch,
      build: buildRecord,
      pythonCorpus: corpus.sourceRevision,
      processExecve: execObservation,
      nativeLauncher: {
        pythonCorpus: launcherCorpus.sourceRevision,
        observation: launcherObservation,
        results: "see-test-results",
        adoption: "not-decided",
      },
      lock: {
        mechanism: "Perl flock on a shared open file description",
        results: "see-test-results",
      },
      fullCompatibility: false,
      adoption: "not-decided",
    }),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

function run(mode: string, flags = "inherit", mask = "clear", target = observer) {
  const command =
    mode === "posix-control"
      ? [target, "report", "37", "literal ; $() 🙂", ""]
      : mode === "launcher"
        ? [
            entry,
            runner,
            prepare,
            launcher,
            "reviewer",
            target,
            "--",
            "report",
            "37",
            "literal ; $() 🙂",
            "",
          ]
        : [runner, "run", fixture, mode, target, "report", "37", "literal ; $() 🙂", ""];
  const result = spawnSync(observer, ["seed", join(root, "seed-fd"), flags, mask, ...command], {
    encoding: "utf8",
    timeout: 5_000,
    env: {
      ...process.env,
      PROCESS_PROOF_MARKER: "literal🙂",
      GIT_PROOF_MARKER: "remove",
      PROCESS_PROOF_OBSERVER: snapshot,
    },
  });
  const records = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Report);
  return {
    ...result,
    beforeExec: records.find((report) => report.event === "before-exec"),
    reports: records.filter((report) => report.event !== "before-exec"),
  };
}

test("process.execve は spawn と異なり、PID・親・process group・終了状態と literal argv を維持する", () => {
  const result = run("execve");
  expect(result.status).toBe(37);
  expect(result.signal).toBeNull();
  const [before, after] = result.reports;
  expect(after!.pid).toBe(before!.pid);
  expect(after!.ppid).toBe(before!.ppid);
  expect(after!.pgid).toBe(before!.pgid);
  expect(after!.sid).toBe(before!.sid);
  expect(after!.marker).toBe("literal🙂");
  expect(after!.argv.slice(1)).toEqual(["report", "37", "literal ; $() 🙂", ""]);
});

test("spawn の対照は終了コードを返しても別 PID と親子関係になる", () => {
  const result = run("spawn");
  expect(result.status).toBe(37);
  const [before, after] = result.reports;
  expect(after!.pid).not.toBe(before!.pid);
  expect(after!.ppid).toBe(before!.pid);
});

test("POSIX 対照は旧 reviewer corpus と同じ FD 継承と signal mask を持つ", () => {
  for (const item of corpus.cases) {
    const blocked = item.expected.usr1Blocked === 1;
    const result = run(
      "posix-control",
      blocked ? "inherit" : "cloexec",
      blocked ? "blocked" : "clear",
    );
    expect(result.status).toBe(item.expected.exitCode);
    const [before, after] = result.reports;
    expect(after!.pid === before!.pid).toBe(item.expected.samePid);
    expect(after!.usr1Blocked).toBe(item.expected.usr1Blocked);
    expect(after!.blocked).toEqual(before!.blocked);
    expect(after!.fd9 !== null).toBe(item.expected.fdInherited);
    if (item.expected.fdInherited) expect(after!.fd9).toEqual(before!.fd9);
    expect(after!.fd9?.cloexec ?? null).toBe(item.expected.fdCloexec);
  }
});

test("Bun 経路は継承可能 FD と block 済み signal を失い、旧契約には不適合と判定する", () => {
  const { reports, beforeExec } = run("execve", "inherit", "blocked");
  const [before, after] = reports;
  expect(before!.fd9).not.toBeNull();
  expect(before!.usr1Blocked).toBe(1);
  expect(after!.fd9).toBeNull();
  expect(after!.usr1Blocked).toBe(0);
  expect(after!.fd9 !== null).not.toBe(corpus.cases[0]!.expected.fdInherited);
  expect(after!.usr1Blocked).not.toBe(corpus.cases[0]!.expected.usr1Blocked);
  execObservation = {
    inheritedFdPreserved: after!.fd9 !== null,
    blockedSignalPreserved: after!.usr1Blocked === before!.usr1Blocked,
    pidPreserved: after!.pid === before!.pid,
    beforeCall: beforeExec,
    target: after,
  };
});

test("execve 呼出し直前の同一 process で FD の identity / flags と mask を観測する", () => {
  const result = run("execve", "inherit", "blocked");
  const [seed] = result.reports;
  expect(result.beforeExec).toBeDefined();
  expect(result.beforeExec!.pid).toBe(seed!.pid);
  expect(result.beforeExec!.fd9?.dev).toBe(seed!.fd9!.dev);
  expect(result.beforeExec!.fd9?.ino).toBe(seed!.fd9!.ino);
  expect(result.beforeExec!.usr1Blocked).toBe(seed!.usr1Blocked);
});

test("process.execve でも CLOEXEC の FD は target に渡らない", () => {
  const { reports } = run("execve", "cloexec");
  const [before, after] = reports;
  expect(before!.fd9!.cloexec).toBe(1);
  expect(after!.fd9).toBeNull();
});

test("存在しない executable は例外として捕捉でき、異常 signal で終了しない", () => {
  const result = run("execve-caught", "inherit", "clear", join(root, "missing"));
  expect(result.status).toBe(1);
  expect(result.signal).toBeNull();
  expect(result.stderr).toContain("exec-error:ENOENT");
  expect(result.reports.map((report) => report.event)).toEqual(["seed"]);
});

test("実行権限のない file と不正な executable も失敗を捕捉できる", () => {
  for (const [name, mode, code] of [
    ["no-permission", 0o600, "EACCES"],
    ["invalid-image", 0o700, "ENOEXEC"],
  ] as const) {
    const path = join(root, name);
    fs.writeFileSync(path, "invalid executable\n", { mode });
    const result = run("execve-caught", "inherit", "clear", path);
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain(`exec-error:${code}`);
    expect(result.reports.map((report) => report.event)).toEqual(["seed"]);
  }
});

test("専用 launcher は旧 reviewer corpus の PID・FD・mask・argv・env と Python の SIG_IGN を維持する", () => {
  for (const item of launcherCorpus.cases) {
    const result = run("launcher", item.flags, item.mask);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(item.expected.exitCode);
    expect(result.stderr).toBe("");
    const [before, after] = result.reports;
    expect(after!.pid).toBe(before!.pid);
    expect(after!.ppid).toBe(before!.ppid);
    expect(after!.pgid).toBe(before!.pgid);
    expect(after!.sid).toBe(before!.sid);
    expect(after!.blocked).toEqual(before!.blocked);
    expect(after!.usr1Blocked).toBe(item.expected.usr1Blocked);
    expect(after!.fd9).toEqual(item.expected.fdInherited ? before!.fd9 : null);
    expect(after!.fds).toEqual(item.expected.fds);
    expect(after!.ignored).toEqual(item.expected.ignored);
    expect(after!.argv[0]).toBe("codex");
    expect(after!.argv.slice(1)).toEqual(item.expected.literalTail);
    expect(after!.marker).toBe(item.expected.marker);
    expect(before!.gitMarker).toBe("remove");
    expect(after!.gitMarker).toBe(item.expected.gitMarker);
    if (item.mask === "blocked-ignored") launcherObservation = { seed: before, target: after };
  }
});

test("呼出し元の FD 3・9・63 を保持し、準備 pipe の FD を target に漏らさない", () => {
  const { status, reports } = run("launcher", "inherit-high", "blocked");
  const [before, after] = reports;
  expect(status).toBe(37);
  expect(before!.fds).toEqual([3, 9, 63]);
  expect(after!.fds).toEqual(before!.fds);
});

for (const item of launcherCorpus.errors) {
  test(`専用 launcher は Python corpus と同じ ${item.expected.code} で ${item.name} を拒否する`, () => {
    const target = item.name === "directory" ? root : join(root, `launcher-${item.name}`);
    if (item.content !== null) fs.writeFileSync(target, item.content, { mode: item.mode! });
    const result = run("launcher", "inherit", "clear", target);
    expect(result.status).toBe(item.expected.exitCode);
    expect(result.signal).toBeNull();
    expect(result.stderr).toMatch(
      new RegExp(
        `^codex-reviewer: exec-error:${item.expected.code} errno=${item.expected.errno}\\n$`,
      ),
    );
    expect(result.reports.map((item) => item.event)).toEqual(["seed"]);
  });
}

test("Bash 単独の対照は execfail を使っても ENOEXEC の text を実行してしまう", () => {
  const target = join(root, "bash-fallback");
  fs.writeFileSync(target, 'printf "FALLBACK\\n"\nexit 37\n', { mode: 0o700 });
  const result = spawnSync(
    "/bin/bash",
    ["-p", "-c", 'shopt -s execfail; exec "$1"; exit 1', "control", target],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.status).toBe(37);
  expect(result.stdout).toBe("FALLBACK\n");
});

function prepared(mode: string, executable: string, arguments_: string[] = [], path?: string) {
  return spawnSync(entry, [runner, prepare, launcher, mode, executable, ...arguments_], {
    encoding: "utf8",
    timeout: 5_000,
    cwd: root,
    env: { ...process.env, ...(path === undefined ? {} : { EXEC_PROOF_TARGET_PATH: path }) },
  });
}

test("PATH 探索は execvp の shell fallback を使わず、後続の実行可能 file を試す", () => {
  const denied = join(root, "path-denied"),
    valid = join(root, "path-valid");
  fs.mkdirSync(denied);
  fs.mkdirSync(valid);
  fs.writeFileSync(join(denied, "probe"), "invalid\n", { mode: 0o700 });
  fs.symlinkSync(observer, join(valid, "probe"));
  const result = prepared("search", "probe", ["report", "37", ""], `${denied}:${valid}`);
  expect(result.status).toBe(37);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).argv).toEqual(["probe", "report", "37", ""]);
  const refused = prepared("search", "probe", [], denied);
  expect(refused.status).toBe(1);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("devshell-env: exec-error:ENOEXEC");
});

test("PATH 探索は最初の非 ENOENT/ENOTDIR エラーを報告する", () => {
  const paths = ["path-access", "path-format", "path-absent"].map((name) => join(root, name));
  for (const path of paths) fs.mkdirSync(path);
  fs.writeFileSync(join(paths[0]!, "probe"), "denied\n", { mode: 0o600 });
  fs.writeFileSync(join(paths[1]!, "probe"), "invalid\n", { mode: 0o700 });
  for (const [order, error] of [
    [paths, "EACCES"],
    [[paths[1], paths[0], paths[2]], "ENOEXEC"],
  ] as const) {
    const result = prepared("search", "probe", [], order.join(":"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`exec-error:${error}`);
  }
});

test("PATH の空要素は cwd、未指定は Python と同じ既定 path とし、slash のある名前は直接実行する", () => {
  fs.symlinkSync(observer, join(root, "relative-probe"));
  for (const [executable, path] of [
    ["relative-probe", ""],
    ["./relative-probe", "/missing"],
  ]) {
    const result = prepared("search", executable!, ["report", "37"], path);
    expect(result.status).toBe(37);
    expect(JSON.parse(result.stdout).argv[0]).toBe(executable);
  }
  const result = prepared("search-no-path", "true");
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
});

test("shebang のある script は kernel の実行判定に従う", () => {
  const target = join(root, "script");
  fs.writeFileSync(target, "#!/bin/sh\nexit 37\n", { mode: 0o700 });
  expect(prepared("reviewer", target).status).toBe(37);
});

test("準備・置換の実行前後で runner と fixture payload の bytes・mode・file inventory は不変", () => {
  function digest() {
    const hash = createHash("sha256");
    function walk(directory: string) {
      for (const name of fs.readdirSync(directory).sort()) {
        const path = join(directory, name);
        const state = fs.lstatSync(path);
        hash.update(`${path}:${state.mode}\0`);
        if (state.isSymbolicLink()) hash.update(fs.readlinkSync(path));
        else if (state.isDirectory()) walk(path);
        else hash.update(fs.readFileSync(path));
      }
    }
    walk(dirname(runner));
    walk(dirname(fixture));
    return hash.digest("hex");
  }
  const before = digest();
  expect(prepared("reviewer", observer).status).toBe(37);
  expect(digest()).toBe(before);
});

test("pipe buffer より大きい準備結果も途中で切れず、空引数と Unicode を維持する", () => {
  const marker = `${"x".repeat(64 * 1024)}🙂`;
  const result = spawnSync(
    entry,
    [runner, prepare, launcher, "search", observer, "report", "37", ""],
    {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, PROCESS_PROOF_MARKER: marker },
    },
  );
  expect(result.status).toBe(37);
  expect(result.stderr).toBe("");
  const target = JSON.parse(result.stdout);
  expect(createHash("sha256").update(target.marker).digest("hex")).toBe(
    createHash("sha256").update(marker).digest("hex"),
  );
  expect(target.argv.at(-1)).toBe("");
});

for (const mode of ["prep-fail", "prep-partial", "prep-trailing", "prep-complete-fail"]) {
  test(`${mode} では完全な frame の出力後であっても target を起動しない`, () => {
    const result = prepared(mode, observer, ["report", "37"]);
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("launcher: preparation failed\n");
  });
}

test("準備中に親を SIGTERM 終了すると準備子も終了し、親が回収する", async () => {
  const child = spawn(entry, [runner, prepare, launcher, "prep-hang", observer], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const ended = once(child, "exit");
  const lines = createInterface({ input: child.stderr });
  let preparationPid: number | undefined;
  const deadline = setTimeout(() => child.kill("SIGKILL"), 4_000);
  try {
    for await (const line of lines) {
      if (line.startsWith("prep-ready:")) {
        preparationPid = Number(line.slice("prep-ready:".length));
        child.kill("SIGTERM");
        break;
      }
    }
    expect(await ended).toEqual([null, "SIGTERM"]);
    expect(preparationPid).toBeGreaterThan(1);
    expect(() => process.kill(preparationPid!, 0)).toThrow();
  } finally {
    clearTimeout(deadline);
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await ended;
    }
    if (preparationPid) {
      try {
        process.kill(preparationPid, "SIGKILL");
      } catch {}
    }
  }
});

async function pty(
  mode: "execve" | "posix-control" | "launcher",
  action: "input" | "interrupt" | "terminate" | "timeout",
) {
  let output = "";
  const decoder = new TextDecoder();
  const terminalEnded = Promise.withResolvers<void>();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const target = [observer, "interactive"];
  const command =
    mode === "posix-control"
      ? target
      : mode === "launcher"
        ? [entry, runner, prepare, launcher, "search", ...target]
        : [runner, "run", fixture, mode, ...target];
  const child = Bun.spawn(
    [observer, "seed", join(root, "tty-fd"), "cloexec", "clear", ...command],
    {
      timeout: action === "timeout" ? 1_000 : 5_000,
      killSignal: "SIGTERM",
      terminal: {
        cols: 80,
        rows: 24,
        data(_terminal, bytes) {
          output += decoder.decode(bytes, { stream: true });
          if (output.includes('"event":"ready"')) ready();
        },
        exit() {
          terminalEnded.resolve();
        },
      },
    },
  );
  try {
    await Promise.race([
      started,
      child.exited.then(() => {
        throw new Error(`PTY が ready 前に終了しました: ${output}`);
      }),
    ]);
    if (action === "input") child.terminal!.write("hello🙂\n");
    if (action === "interrupt") child.terminal!.write("\x03");
    if (action === "terminate") child.kill("SIGTERM");
    const status = await child.exited;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        terminalEnded.promise,
        new Promise<never>((_resolve, reject) => {
          drainTimer = setTimeout(() => reject(new Error("PTY の出力終端を確認できません")), 3_000);
        }),
      ]);
    } finally {
      clearTimeout(drainTimer);
    }
    const reports = output
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{"event":'))
      .map((line) => JSON.parse(line));
    return { status, signal: child.signalCode, reports };
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    child.terminal!.close();
  }
}

test("POSIX 対照・Bun・専用 launcher は controlling TTY・foreground group と対話入力を維持する", async () => {
  for (const mode of ["posix-control", "execve", "launcher"] as const) {
    const result = await pty(mode, "input");
    const [before, after, input] = result.reports;
    expect(result.status).toBe(37);
    expect(result.signal).toBeNull();
    expect(after.tty).toEqual([1, 1, 1]);
    expect(after.pid).toBe(before.pid);
    expect(after.sid).toBe(before.sid);
    expect(after.pgid).toBe(before.pgid);
    expect(after.foreground).toBe(after.pgid);
    expect(input.value).toBe("hello🙂\n");
  }
});

for (const [action, signal, status] of [
  ["interrupt", "SIGINT", 130],
  ["terminate", "SIGTERM", 143],
  ["timeout", "SIGTERM", 143],
] as const) {
  test(`POSIX 対照・Bun・専用 launcher は ${action} を target の signal と終了状態として観測できる`, async () => {
    for (const mode of ["posix-control", "execve", "launcher"] as const) {
      const result = await pty(mode, action);
      expect(result.signal).toBe(signal);
      expect(result.status).toBe(status);
      expect(result.reports.map((report) => report.event)).toEqual(["seed", "ready"]);
    }
  });
}

const lockPath = join(root, "admission.lock");
function contender(path = lockPath) {
  const result = spawnSync(observer, ["try-lock", path], { encoding: "utf8", timeout: 5_000 });
  if (result.error) throw result.error;
  return { status: result.status, message: result.stdout.trim() };
}

function startLock(inherit = false, writeOnly = false, path = lockPath) {
  const child = spawn(
    runner,
    [
      "run",
      fixture,
      writeOnly ? "lock-write" : "lock",
      observer,
      path,
      inherit ? "inherit" : "cloexec",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const ended = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  child.stdin.on("error", (error) => {
    stderr += `stdin:${error.message}`;
  });
  return {
    child,
    ended,
    async next(): Promise<{ event: string; pid?: number; child?: number }> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const line = await Promise.race([
          iterator.next(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`lock fixture が応答しません: ${stderr}`)),
              5_000,
            );
          }),
        ]);
        if (line.done) throw new Error(`lock fixture が早期終了しました: ${stderr}`);
        return JSON.parse(line.value);
      } finally {
        clearTimeout(timer);
      }
    },
    async stop() {
      lines.close();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 1_000);
      try {
        if (child.exitCode === null && child.signalCode === null) child.stdin.end("finish\n");
        await ended;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

test("acquisition 子の終了後も親の FD が admission lock を保持し、close で解放する", async () => {
  expect(contender()).toEqual({ status: 0, message: "acquired" });
  const holder = startLock();
  try {
    expect((await holder.next()).event).toBe("locked");
    expect(contender()).toEqual({ status: 73, message: "busy" });
    holder.child.stdin.write("close\n");
    expect((await holder.next()).event).toBe("closed");
    expect(contender()).toEqual({ status: 0, message: "acquired" });
    holder.child.stdin.write("finish\n");
    expect(await holder.ended).toEqual([0, null]);
  } finally {
    await holder.stop();
  }
});

test("Python と同じ append/write-only と umask で lock を作り、書込み専用の既存 file でも競合を拒否する", async () => {
  const path = join(root, "write-admission.lock");
  let holder = startLock(false, true, path);
  try {
    expect((await holder.next()).event).toBe("locked");
    expect(fs.statSync(path).mode & 0o777).toBe(0o666 & ~process.umask());
    expect(contender(path).status).toBe(73);
  } finally {
    await holder.stop();
  }
  fs.chmodSync(path, 0o200);
  holder = startLock(false, true, path);
  try {
    expect((await holder.next()).event).toBe("locked");
    expect(contender(path).status).toBe(73);
    holder.child.stdin.write("close\n");
    expect((await holder.next()).event).toBe("closed");
    expect(contender(path).status).toBe(0);
  } finally {
    await holder.stop();
  }
});

test("lock を明示継承した子だけが親の close 後も保持する対照を置く", async () => {
  for (const inherit of [false, true]) {
    const holder = startLock(inherit);
    try {
      expect((await holder.next()).event).toBe("locked");
      holder.child.stdin.write("spawn\n");
      const spawned = await holder.next();
      expect(spawned.event).toBe("spawned");
      expect(spawned.child).toBeGreaterThan(0);
      holder.child.stdin.write("close\n");
      expect((await holder.next()).event).toBe("closed");
      process.kill(spawned.child!, 0);
      expect(contender()).toEqual(
        inherit ? { status: 73, message: "busy" } : { status: 0, message: "acquired" },
      );
      process.kill(spawned.child!, 0);
      holder.child.stdin.write("finish\n");
      expect(await holder.ended).toEqual([0, null]);
      expect(contender()).toEqual({ status: 0, message: "acquired" });
    } finally {
      await holder.stop();
    }
  }
});

test("CLOEXEC の lock FD を持つ親を置換すると、生存中の target へ lock は渡らない", async () => {
  const holder = startLock();
  try {
    expect((await holder.next()).event).toBe("locked");
    expect(contender()).toEqual({ status: 73, message: "busy" });
    holder.child.stdin.write("replace\n");
    const target = await holder.next();
    expect(target.event).toBe("ready");
    expect(target.pid).toBe(holder.child.pid);
    expect(contender()).toEqual({ status: 0, message: "acquired" });
    holder.child.stdin.write("hello\n");
    expect((await holder.next()).event).toBe("input");
    expect(await holder.ended).toEqual([37, null]);
  } finally {
    await holder.stop();
  }
});

test("競合する別 process は明示的に拒否され、元の holder の lock を変えない", async () => {
  const first = startLock();
  let second: ReturnType<typeof startLock> | undefined;
  try {
    expect((await first.next()).event).toBe("locked");
    second = startLock();
    await expect(second.next()).rejects.toThrow("lock-error:busy");
    expect(await second.ended).toEqual([1, null]);
    expect(contender()).toEqual({ status: 73, message: "busy" });
    first.child.stdin.write("finish\n");
    expect(await first.ended).toEqual([0, null]);
    expect(contender()).toEqual({ status: 0, message: "acquired" });
  } finally {
    if (second) await second.stop();
    await first.stop();
  }
});

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(`holder の ${signal} 終了後は kernel が admission lock を解放する`, async () => {
    const holder = startLock();
    try {
      expect((await holder.next()).event).toBe("locked");
      expect(contender()).toEqual({ status: 73, message: "busy" });
      holder.child.kill(signal);
      expect(await holder.ended).toEqual([null, signal]);
      expect(contender()).toEqual({ status: 0, message: "acquired" });
    } finally {
      await holder.stop();
    }
  });
}
