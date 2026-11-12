import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import corpus from "../fixtures/bun-process-lock-python.json";

const root = fs.mkdtempSync(join(tmpdir(), "bun-process-lock-"));
const observer = join(root, "observer");
const fixture = fileURLToPath(new URL("../fixtures/bun-process-lock.ts", import.meta.url));
const runner = fileURLToPath(new URL("../../lib/bun/run", import.meta.url));
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
      fileURLToPath(new URL("../fixtures/bun-process-observer.c", import.meta.url)),
      "-o",
      observer,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (build.error || build.status !== 0)
    throw new Error(
      `process の観測用 fixture をビルドできません: ${build.error?.message ?? build.stderr}`,
    );
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

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
