import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import corpus from "../fixtures/bun-process-lock-python.json";

const root = fs.mkdtempSync(join(tmpdir(), "bun-process-lock-"));
const observer = join(root, "observer");
const fixture = fileURLToPath(new URL("../fixtures/bun-process-lock.ts", import.meta.url));
const runner = fileURLToPath(new URL("../../lib/bun/run", import.meta.url));
const observerSource = new URL("../fixtures/bun-process-observer.c", import.meta.url);
let buildRecord: object | undefined;
let execObservation: object | undefined;
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
  fd9: { dev: string; ino: string; cloexec: number } | null;
  marker: string;
  argv: string[];
};

beforeAll(() => {
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
      `process の観測用 fixture をビルドできません: ${build.error?.message ?? build.stderr}`,
    );
  const compiler = spawnSync("cc", ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (compiler.error || compiler.status !== 0) throw new Error("C compiler の版を記録できません");
  const hash = (path: string | URL) =>
    createHash("sha256").update(fs.readFileSync(path)).digest("hex");
  buildRecord = {
    compiler: compiler.stdout.split("\n")[0],
    sourceHash: hash(observerSource),
    binaryHash: hash(observer),
  };
});
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
      : [runner, "run", fixture, mode, target, "report", "37", "literal ; $() 🙂", ""];
  const result = spawnSync(observer, ["seed", join(root, "seed-fd"), flags, mask, ...command], {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, PROCESS_PROOF_MARKER: "literal🙂" },
  });
  return {
    ...result,
    reports: result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Report),
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

test("process.execve は継承可能 FD と block 済み signal を失い、旧契約には不適合と判定する", () => {
  const { reports } = run("execve", "inherit", "blocked");
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
  };
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

async function pty(
  mode: "execve" | "posix-control",
  action: "input" | "interrupt" | "terminate" | "timeout",
) {
  let output = "";
  const decoder = new TextDecoder();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const target = [observer, "interactive"];
  const command = mode === "posix-control" ? target : [runner, "run", fixture, mode, ...target];
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

test("POSIX 対照と process.execve は controlling TTY・foreground group と対話入力を維持する", async () => {
  for (const mode of ["posix-control", "execve"] as const) {
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
  test(`process.execve は ${action} を target の signal と終了状態として観測できる`, async () => {
    const result = await pty("execve", action);
    expect(result.signal).toBe(signal);
    expect(result.status).toBe(status);
    expect(result.reports.map((report) => report.event)).toEqual(["seed", "ready"]);
  });
}

const lockPath = join(root, "admission.lock");
function contender() {
  const result = spawnSync(observer, ["try-lock", lockPath], { encoding: "utf8", timeout: 5_000 });
  if (result.error) throw result.error;
  return { status: result.status, message: result.stdout.trim() };
}

function startLock(inherit = false) {
  const child = spawn(
    runner,
    ["run", fixture, "lock", observer, lockPath, inherit ? "inherit" : "cloexec"],
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
