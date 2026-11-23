import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir, release } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import corpus from "../fixtures/bun-exec-python.json";
import manifest from "../../development/linux-process-proof-cases.json";
import { groupsInNamespace, selectContainment } from "../../development/linux-process-proof.ts";

const linux = process.platform === "linux" && process.env.PROCESS_PROOF_PID_NAMESPACE === "1";
// 正式実証ではホストで実際に選ばれる方式を読込み時に確かめ、「共通＋その方式専用」だけを登録する。
const containment = linux ? selectContainment() : undefined;
if (containment === "refused")
  throw new Error("namespace も委譲 scope も使えないため正式実証を開始しません（未実証）");
type Group = "common" | "namespace" | "cgroup";
// 無効時は manifest との照合のため全区分を skip として登録する。
function proof(
  group: Group,
  name: string,
  body: () => void | Promise<unknown>,
  timeout?: number,
  skip = false,
) {
  if (
    !(manifest.cases[group] as string[]).includes(name) &&
    !(manifest.observations[group as "cgroup"] ?? []).includes(name)
  )
    throw new Error(`manifest にないケースです: ${name}`);
  if (linux && group !== "common" && group !== containment) return;
  test.skipIf(!linux || skip)(name, body, timeout);
}
const root = fs.mkdtempSync(join(tmpdir(), "bun-process-namespace-"));
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const entry = fixture("bun-exec-entry.sh");
const prepare = fixture("bun-exec-prepare.ts");
const runner = fileURLToPath(new URL("../../lib/bun/run", import.meta.url));
const observer = join(root, "observer");
const launcher = join(root, "launcher");
const baseline = join(root, "baseline");
const withoutProc = join(root, "without-proc");
const watcher = join(root, "pidfds");
const delay = join(root, "delay.so");
const systemdRun = Bun.which("systemd-run");
const records: object[] = [];
let buildRecord: object;
const nixStdenv = process.env.PROCESS_PROOF_NIX_STDENV;
const nixBash = process.env.PROCESS_PROOF_NIX_BASH;
const groupFile = process.env.PROCESS_PROOF_GROUP_FILE;
const groupGid = process.env.PROCESS_PROOF_GROUP_GID;

beforeAll(() => {
  if (!linux) return;
  const unshare = Bun.which("unshare");
  if (!unshare) throw new Error("正式実証には導入済み unshare が必要です（未実証）");
  const hash = (path: string) => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
  const builds: object[] = [];
  for (const [source, binary] of [
    ["bun-process-namespace-observer.c", observer],
    ["bun-process-pidfds.c", watcher],
    ["bun-exec-launcher.c", baseline],
    ["bun-exec-pid-namespace.c", launcher],
    ["bun-exec-pid-namespace.c", withoutProc],
    ["bun-exec-namespace-delay.c", delay],
  ]) {
    const result = spawnSync(
      "cc",
      [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        `-DPROCESS_PROOF_UNSHARE=${JSON.stringify(fs.realpathSync(unshare))}`,
        `-DPROCESS_PROOF_SYSTEMD_RUN=${JSON.stringify(systemdRun ? fs.realpathSync(systemdRun) : "/nonexistent/systemd-run")}`,
        `-DPROCESS_PROOF_LAUNCHER=${JSON.stringify(launcher)}`,
        ...(binary === delay ? ["-shared", "-fPIC"] : []),
        ...(binary === withoutProc ? ["-DPROCESS_PROOF_NO_PROC"] : []),
        fixture(source!),
        "-o",
        binary!,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (result.error || result.status !== 0)
      throw new Error(`fixture の build に失敗: ${source}\n${result.stderr}`);
    builds.push({
      source,
      variant: binary!.slice(root.length + 1),
      sourceHash: hash(fixture(source!)),
      binaryHash: hash(binary!),
    });
  }
  const version = spawnSync(unshare, ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (version.error || version.status !== 0) throw new Error("unshare の版を記録できません");
  const compiler = spawnSync("cc", ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (compiler.error || compiler.status !== 0) throw new Error("C compiler の版を記録できません");
  buildRecord = {
    unshare: fs.realpathSync(unshare),
    unshareHash: hash(unshare),
    version: version.stdout.trim(),
    compiler: compiler.stdout.split("\n")[0],
    launcherSourceHash: hash(fixture("bun-exec-launcher.c")),
    observerSourceHash: hash(fixture("bun-process-observer.c")),
    entrySourceHash: hash(entry),
    preparationSourceHash: hash(prepare),
    runnerSourceHash: hash(runner),
    systemdRun: systemdRun && fs.realpathSync(systemdRun),
    corpusRevision: corpus.sourceRevision,
    builds,
  };
  const observed = launch().containment;
  if (observed !== containment)
    throw new Error(`launcher の方式 ${observed} が読込み時の選択 ${containment} と一致しません`);
}, 190_000);

afterAll(() => {
  console.log(
    JSON.stringify({
      boundary: "process-namespace",
      platform: process.platform,
      kernel: release(),
      arch: process.arch,
      bun: Bun.version,
      build: buildRecord,
      containment,
      records,
      verification: linux ? "see-test-results" : "not-run",
      realCallerRequested: Boolean(nixStdenv && nixBash),
      adoption: "not-decided",
      macos: "held",
      issue33: "open",
      issue82: "blocked-by-33",
    }),
  );
  if (process.env.PROCESS_PROOF_RETAIN_TEMP !== "1")
    fs.rmSync(root, { recursive: true, force: true });
});

async function until(condition: () => boolean | Promise<boolean>, milliseconds = 3_000) {
  const start = performance.now();
  while (!(await condition())) {
    if (performance.now() - start > milliseconds)
      throw new Error("process の観測が期限内に終わりません");
    await Bun.sleep(10);
  }
}

async function within<T>(pending: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("process の終了待ちが期限を超えました")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function descendants(pid: number): number[] {
  const children = new Set<number>();
  // Bun は main thread 以外からも fork するため、全 task の children を読む。
  for (const task of fs.readdirSync(`/proc/${pid}/task`)) {
    try {
      for (const value of fs
        .readFileSync(`/proc/${pid}/task/${task}/children`, "utf8")
        .trim()
        .split(/\s+/)) {
        if (value) children.add(Number(value));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...children].flatMap((child) => [child, ...descendants(child)]);
}

async function pin(pids: number[]) {
  const child = spawn(watcher, pids.map(String), { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  const ended = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const next = async () => {
    const result = await within(iterator.next());
    if (result.done) throw new Error("pidfd observer が応答前に終了しました");
    return result.value;
  };
  try {
    expect(await next()).toBe("ready");
  } catch (error) {
    child.stdin.end("K");
    await within(ended, 7_000);
    lines.close();
    throw error;
  }
  return {
    async kill(pid: number) {
      child.stdin.write(`!${pids.indexOf(pid)}\n`);
      expect(await next()).toBe("sent");
    },
    async terminated(): Promise<number[]> {
      child.stdin.write("?");
      return JSON.parse(await next());
    },
    async close() {
      child.stdin.end("K");
      try {
        const [status, signal] = await within(ended, 7_000);
        expect(status).toBe(0);
        expect(signal).toBeNull();
      } finally {
        lines.close();
      }
    },
  };
}

let observationCount = 0;
/** launcher が PROCESS_PROOF_OBSERVE へ書いた観測。後の行が前の値を上書きする。 */
type Observation = { containment?: string; cgroup?: string; watchdog?: string };
function observation(path: string): Observation {
  const values: Record<string, string> = {};
  if (!fs.existsSync(path)) return values;
  for (const field of fs.readFileSync(path, "utf8").split(/\s+/)) {
    const separator = field.indexOf("=");
    if (separator > 0) values[field.slice(0, separator)] = field.slice(separator + 1);
  }
  return values;
}
const observationPath = () => join(root, `observe-${++observationCount}`);

function launch(mode = "reviewer", env: NodeJS.ProcessEnv = {}) {
  const path = observationPath();
  const result = execute(launcher, mode, observer, [], { ...env, PROCESS_PROOF_OBSERVE: path });
  return { result, ...observation(path) };
}

function killCgroup(path: string | undefined) {
  try {
    if (path) fs.writeFileSync(`/sys/fs/cgroup${path}/cgroup.kill`, "1");
  } catch (error) {
    if (!["ENOENT", "ENODEV"].includes((error as NodeJS.ErrnoException).code!)) throw error;
  }
}

type Interruption = {
  stage?: string;
  closeFrame?: boolean;
  hiddenParentDeath?: boolean;
  hiddenLauncherDeath?: boolean;
  /** launcher だけ・launcher の process group 全体・監視役だけ、のどれへ signal を送るか。 */
  target?: "launcher" | "group" | "helper";
};

async function interruption(
  mode: string,
  signal: "SIGTERM" | "SIGKILL",
  {
    stage,
    closeFrame = false,
    hiddenParentDeath = false,
    hiddenLauncherDeath = false,
    target = "launcher",
  }: Interruption = {},
) {
  const observed = observationPath();
  const child = spawn(entry, [runner, prepare, launcher, mode, observer], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    // process group 全体へ送るときだけ、試験 runner と別の group にする。
    detached: target === "group",
    env: {
      ...process.env,
      LD_PRELOAD: delay,
      PROCESS_PROOF_DETACH_INIT: "1",
      PROCESS_PROOF_OBSERVE: observed,
      ...(stage ? { PROCESS_PROOF_GATE: stage } : {}),
      ...(closeFrame ? { PROCESS_PROOF_CLOSE_FRAME: "1" } : {}),
      ...(hiddenParentDeath ? { PROCESS_PROOF_HIDE_PARENT_DEATH: "1" } : {}),
      ...(hiddenLauncherDeath ? { PROCESS_PROOF_HIDE_LAUNCHER_DEATH: "1" } : {}),
    },
  });
  const ended = once(child, "exit");
  const drained = once(child, "close");
  const gate = child.stdio[3] as import("node:stream").Writable;
  gate.on("error", () => {});
  let stderr = "",
    stdout = "";
  child.stderr!.on("data", (data) => {
    stderr += data;
  });
  child.stdout!.on("data", (data) => {
    stdout += data;
  });
  const unrelated = spawn("sleep", ["30"]);
  const unrelatedEnded = once(unrelated, "exit");
  let owned: Awaited<ReturnType<typeof pin>> | undefined;
  let controlParentsTerminatedBeforeRelease: number[] | undefined;
  try {
    try {
      await until(() =>
        stage
          ? stderr.includes(`namespace-gate:${stage}:`)
          : mode === "prep-hang"
            ? stderr.includes("prep-ready:")
            : (stderr.match(/prep-(?:detached|owned):\d+:/g) ?? []).length === 2,
      );
    } catch (error) {
      throw new Error(`${error}\n${stderr}`);
    }
    const pids = descendants(child.pid!);
    expect(pids.length).toBeGreaterThanOrEqual(stage ? 2 : mode === "prep-hang" ? 3 : 5);
    owned = await pin(pids);
    const identities = pids.map((pid) => ({
      pid,
      executable: fs.readlinkSync(`/proc/${pid}/exe`),
      status: fs
        .readFileSync(`/proc/${pid}/status`, "utf8")
        .split("\n")
        .filter((line) => /^(NSpid|NSpgid|NSsid|Uid|Gid|Groups):/.test(line)),
      cgroup: fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").trim(),
    }));
    const selected = observation(observed);
    expect(selected.containment).toBe(containment!);
    let helper: number | undefined;
    if (target === "helper") {
      // cgroup では scope 外の watchdog、namespace では準備 group の監視役を対照として止める。
      helper =
        containment === "cgroup"
          ? Number(selected.watchdog)
          : pids.find(
              (pid) =>
                fs.readlinkSync(`/proc/${pid}/exe`) === launcher &&
                Number(
                  fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[2],
                ) === pid,
            );
      expect(pids).toContain(helper!);
    }
    if (closeFrame) {
      const frame = stderr.match(/^prep-frame-closed:(pipe:\[\d+\])$/m)?.[1];
      expect(frame).toBeDefined();
      const directory = `/proc/${child.pid}/fd`;
      // launcher が EOF を処理して frame の読み取り側を閉じた後に watchdog を止める。
      await until(() =>
        fs.readdirSync(directory).every((fd) => {
          try {
            return fs.readlinkSync(join(directory, fd)) !== frame;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return true;
          }
        }),
      );
    }
    const detachedPids = hiddenLauncherDeath
      ? [...stderr.matchAll(/^prep-detached:(\d+):/gm)].map((match) => Number(match[1]))
      : [];
    if (hiddenLauncherDeath) {
      expect(detachedPids).toHaveLength(2);
      for (const pid of detachedPids) expect(pids).toContain(pid);
    }
    const started = performance.now();
    if (target === "group") process.kill(-child.pid!, "SIGKILL");
    else if (helper) await owned.kill(helper);
    else child.kill(signal);
    let launcherOutcome: unknown;
    if (helper && containment === "namespace") {
      // namespace では監視役の死亡を検知しない。launcher は準備を続け、中断で準備子孫を終了する。
      // launcher と監視役の両方が kill される場合は保証の外（ADR 0005 の追記）なので SIGKILL は送らない。
      await Bun.sleep(200);
      expect(child.exitCode).toBeNull();
      child.kill("SIGTERM");
    }
    const [status, exitSignal] = await within(ended);
    if (helper && containment === "namespace")
      expect([status, exitSignal]).toEqual([null, "SIGTERM"]);
    if (helper && containment === "cgroup") {
      expect([status, exitSignal]).toEqual([1, null]);
      launcherOutcome = { status, signal: exitSignal };
    }
    if (hiddenParentDeath) {
      const namespaceInit = identities.filter((identity) =>
        identity.status.some((line) => /^NSpid:\s+(?:\d+\s+)*1$/.test(line)),
      );
      expect(namespaceInit).toHaveLength(1);
      const initPid = namespaceInit[0]!.pid;
      const parents = pids.filter((pid) => pid !== initPid);
      // launcher の exit だけでは unshare の親死亡通知と競合するため、検査を隠す窓を固定する。
      await until(async () => {
        const terminated = await owned!.terminated();
        return parents.every((pid) => terminated.includes(pid));
      });
      const terminated = await owned.terminated();
      expect(terminated).not.toContain(initPid);
      controlParentsTerminatedBeforeRelease = terminated;
    }
    gate.end("R");
    if (hiddenParentDeath) {
      try {
        await until(
          () => stderr.includes("namespace-hidden-parent-death") && stderr.includes("prep-ready:"),
        );
      } catch (error) {
        throw new Error(`${error}\n${stderr}`);
      }
      // 対照の後始末が本判定へ入り込まないよう、launcher 終了後にも5秒待つ。
      await Bun.sleep(5_100);
      expect((await owned.terminated()).length).toBeLessThan(pids.length);
    } else if (hiddenLauncherDeath) {
      await Bun.sleep(5_100);
      const terminated = await owned.terminated();
      // watchdog が cgroup.kill を書かなければ、離脱した子孫と watchdog 自身が残る。
      expect(terminated).not.toContain(Number(selected.watchdog));
      expect(detachedPids.some((pid) => !terminated.includes(pid))).toBe(true);
      controlParentsTerminatedBeforeRelease = terminated;
    } else {
      await until(async () => (await owned!.terminated()).length === pids.length, 4_500);
      expect(performance.now() - started).toBeLessThan(5_000);
    }
    const durationMs = performance.now() - started;
    if (!hiddenParentDeath && !hiddenLauncherDeath) {
      await within(drained);
      if (stage) expect(stderr).not.toContain("prep-ready:");
    }
    if (helper && containment === "cgroup")
      expect(stderr).toContain("launcher: preparation failed");
    expect(stdout).toBe("");
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
    records.push({
      containment,
      mode,
      signal,
      stage,
      closeFrame,
      target,
      hiddenParentDeath,
      hiddenLauncherDeath,
      controlParentsTerminatedBeforeRelease,
      launcherOutcome,
      observation: selected,
      identities,
      durationMs,
      targetStarted: false,
      terminated: await owned.terminated(),
    });
  } finally {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await within(ended);
      gate.end("R");
      killCgroup(observation(observed).cgroup);
    } finally {
      unrelated.kill("SIGKILL");
      await Promise.all([owned?.close(), within(unrelatedEnded), within(drained)]);
    }
  }
}

for (const mode of [
  "prep-detached-group",
  "prep-detached-session",
  "prep-stubborn-blocked",
  "prep-stubborn-ignored",
  "prep-before-ready-blocked",
  "prep-complete-hang-blocked",
]) {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    proof(
      "common",
      `選ばれた方式は ${mode} の ${signal} 後に全所有子孫を5秒以内に終了する`,
      () => interruption(mode, signal),
      15_000,
    );
  }
}

proof(
  "common",
  "launcher の process group 全体への SIGKILL でも全所有子孫を5秒以内に終了する",
  () => interruption("prep-detached-session", "SIGKILL", { target: "group" }),
  15_000,
);

proof(
  "namespace",
  "namespace 経路で監視役が終了した後、launcher への SIGTERM で準備子孫を残さない",
  () => interruption("prep-detached-session", "SIGKILL", { target: "helper" }),
  15_000,
);

proof(
  "cgroup",
  "準備中に監視役だけが終了しても、準備子孫を残さず target を起動しない",
  async () => {
    await interruption("prep-detached-session", "SIGKILL", { target: "helper" });
    await interruption("prep-detached-session", "SIGKILL", { target: "helper", closeFrame: true });
  },
  15_000,
);

for (const stage of [
  "namespace-before",
  "pidfd-before",
  "pidfd-after",
  "fork-before",
  "fork-child",
  "parent-check",
  "exec-before",
]) {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    proof(
      "namespace",
      `unshare の ${stage} で ${signal} を受けても準備子を残さない`,
      () => interruption("prep-hang", signal, { stage }),
      15_000,
    );
  }
}

proof(
  "namespace",
  "親死亡の pidfd 検査を無効にした対照では登録前 race の残存を検出する",
  () => interruption("prep-hang", "SIGKILL", { stage: "fork-child", hiddenParentDeath: true }),
  15_000,
);

for (const stage of [
  "systemd-run-before",
  "scope-before",
  "scope-after",
  "watchdog-before",
  "watchdog-after",
  "prepare-exec-before",
]) {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    proof(
      "cgroup",
      `cgroup 経路の ${stage} で ${signal} を受けても準備子を残さない`,
      () => interruption("prep-hang", signal, { stage }),
      15_000,
    );
  }
}

proof(
  "cgroup",
  "watchdog を無効にした対照では launcher の SIGKILL 後に離脱子孫の残存を検出する",
  () => interruption("prep-detached-session", "SIGKILL", { hiddenLauncherDeath: true }),
  15_000,
);

proof(
  "cgroup",
  "子孫が cgroup の移動で準備用 cgroup から抜け出せるかを観測する",
  async () => {
    // shellHook から呼ばれたツールが自分で scope を作る場合を再現する。合否には数えず観測だけを残す。
    const escapePrepare = join(root, "escape.ts");
    fs.writeFileSync(
      escapePrepare,
      `
      import { readFileSync } from "node:fs";
      const own = readFileSync("/proc/self/cgroup", "utf8").trim();
      const child = Bun.spawn([${JSON.stringify(systemdRun)}, "--user", "--scope", "--quiet", "--collect", "--", "sleep", "30"], { stdout: "ignore", stderr: "inherit" });
      const start = performance.now();
      let moved = "";
      while (performance.now() - start < 3000) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        try { moved = readFileSync("/proc/" + child.pid + "/cgroup", "utf8").trim(); } catch {}
        if (moved && moved !== own) break;
        await Bun.sleep(10);
      }
      console.error("escape:" + JSON.stringify({ pid: child.pid, own, moved }));
      console.error("prep-ready:" + process.pid);
      setInterval(() => {}, 1000);
    `,
    );
    const observed = observationPath();
    const child = spawn(entry, [runner, escapePrepare, launcher, "reviewer", observer], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PROCESS_PROOF_OBSERVE: observed },
    });
    const ended = once(child, "exit");
    let stderr = "";
    child.stderr!.on("data", (data) => {
      stderr += data;
    });
    let owned: Awaited<ReturnType<typeof pin>> | undefined;
    let observationStage = "準備の起動";
    try {
      await until(() => stderr.includes("prep-ready:"), 8_000).catch((error) => {
        throw new Error(`${error}\n${stderr}`);
      });
      const reported: { pid: number; own: string; moved: string } = JSON.parse(
        /^escape:(.*)$/m.exec(stderr)![1]!,
      );
      observationStage = "離脱用プロセスの捕捉";
      const scope = observation(observed).cgroup!;
      const pids = descendants(child.pid!);
      if (!pids.includes(reported.pid) || !reported.moved)
        throw new Error(`離脱用プロセスの PID または cgroup を確認できません。\n${stderr}`);
      owned = await pin(pids);
      const remaining = pids.filter((pid) => pid !== reported.pid);
      observationStage = "launcher 終了後の生存確認";
      child.kill("SIGKILL");
      await within(ended);
      await until(async () => {
        const terminated = await owned!.terminated();
        return remaining.every((pid) => terminated.includes(pid));
      }, 4_500);
      await Bun.sleep(5_100);
      const survived = !(await owned.terminated()).includes(reported.pid);
      records.push({
        cgroupEscape: {
          status: "observed",
          scope,
          escapee: reported,
          leftScope: reported.moved !== reported.own,
          survivedLauncherKill: survived,
          countedInVerdict: false,
        },
      });
    } catch (error) {
      records.push({
        cgroupEscape: {
          status: "unobserved",
          stage: observationStage,
          reason: error instanceof Error ? error.message : String(error),
          countedInVerdict: false,
        },
      });
      throw error;
    } finally {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await within(ended);
        killCgroup(observation(observed).cgroup);
      } finally {
        await owned?.close();
      }
    }
  },
  30_000,
);

function execute(
  binary: string,
  mode = "reviewer",
  target = observer,
  arguments_: string[] = [],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(entry, [runner, prepare, binary, mode, target, ...arguments_], {
    encoding: "utf8",
    timeout: 10_000,
    cwd: root,
    env: { ...process.env, ...env },
  });
}

function contexts(stderr: string) {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("namespace-context:"))
    .map((line) => JSON.parse(line.slice("namespace-context:".length)));
}

proof(
  "namespace",
  "probe 成功後に本番の unshare が拒否されたら cgroup へ移らず target を実行せず、同じ実行体の正常対照は動く",
  () => {
    const denied = launch("reviewer", { LD_PRELOAD: delay, PROCESS_PROOF_DENY_NAMESPACE: "1" });
    expect(denied.containment).toBe("namespace");
    expect(denied.cgroup).toBeUndefined();
    expect(denied.result.status).toBe(1);
    expect(denied.result.stdout).toBe("");
    expect(denied.result.stderr).toContain("namespace-denied");
    expect(denied.result.stderr).toContain("Operation not permitted");
    expect(denied.result.stderr).toContain("launcher: preparation failed");
    expect(execute(launcher).status).toBe(37);
  },
);

proof(
  "cgroup",
  "user manager に届かない環境では準備を始めずに拒否し、環境を戻した同じ実行体は動く",
  () => {
    const marker = join(root, "refusal-marker");
    const markerPrepare = join(root, "marker.ts");
    fs.writeFileSync(
      markerPrepare,
      `await Bun.write(${JSON.stringify(marker)}, "started"); await import(${JSON.stringify(prepare)});`,
    );
    const observed = observationPath();
    // テスト専用の上書きではなく、ログインセッションの無いホストと同じく user bus の場所を渡さない。
    const denied = spawnSync(entry, [runner, markerPrepare, launcher, "reviewer", observer], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: undefined,
        DBUS_SESSION_BUS_ADDRESS: undefined,
        PROCESS_PROOF_OBSERVE: observed,
      },
    });
    expect(denied.status).toBe(69);
    expect(denied.stdout).toBe("");
    expect(denied.stderr).toContain("launcher: containment unavailable");
    expect(fs.existsSync(marker)).toBe(false);
    expect(observation(observed).containment).toBe("refused");
    const allowed = spawnSync(entry, [runner, markerPrepare, launcher, "reviewer", observer], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(allowed.status).toBe(37);
    expect(fs.readFileSync(marker, "utf8")).toBe("started");
    records.push({
      refusal: { status: denied.status, stderr: denied.stderr, allowed: allowed.status },
    });
  },
);

proof("common", "旧 Python corpus の PID・FD・signal・argv・env 契約を候補でも満たす", () => {
  for (const item of corpus.cases) {
    const observed = observationPath();
    const result = spawnSync(
      observer,
      [
        "seed",
        join(root, "corpus-fd"),
        item.flags,
        item.mask,
        entry,
        runner,
        prepare,
        launcher,
        "reviewer",
        observer,
        "--",
        "report",
        "37",
        "literal ; $() 🙂",
        "",
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          PROCESS_PROOF_MARKER: "literal🙂",
          GIT_PROOF_MARKER: "remove",
          PROCESS_PROOF_OBSERVE: observed,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(item.expected.exitCode);
    expect(result.signal).toBe(item.expected.signal);
    const selected = observation(observed).containment;
    expect(selected).toBe(containment!);
    const [seed, target] = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const key of ["pid", "ppid", "pgid", "sid"] as const) expect(target[key]).toBe(seed[key]);
    expect(target.fds).toEqual(item.expected.fds);
    expect(target.usr1Blocked).toBe(item.expected.usr1Blocked);
    expect(target.ignored).toEqual(item.expected.ignored);
    expect(target.fd9 !== null).toBe(item.expected.fdInherited);
    expect(target.fd9?.cloexec ?? null).toBe(item.expected.fdCloexec);
    expect(target.gitMarker).toBe(item.expected.gitMarker);
    expect(target.marker).toBe(item.expected.marker);
    expect(target.argv).toEqual(["codex", ...item.expected.literalTail]);
    const [before, after] = contexts(result.stderr);
    expect(after.fds).toEqual(
      item.flags === "cloexec" ? [] : seed.fds.map((fd: number) => ({ fd, ...seed.fd9 })),
    );
    expect(after.groups).toEqual(before.groups);
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    records.push({
      corpus: item.flags + "/" + item.mask,
      containment: selected,
      seed,
      target,
      contexts: [before, after],
    });
  }
});

proof("common", "旧 corpus の exec 拒否を候補でも維持する", () => {
  for (const item of corpus.errors) {
    const path = join(root, `error-${item.name}`);
    if (item.name === "directory") fs.mkdirSync(path);
    else if (item.content !== null) fs.writeFileSync(path, item.content, { mode: item.mode! });
    const observed = observationPath();
    const result = execute(launcher, "reviewer", path, [], { PROCESS_PROOF_OBSERVE: observed });
    expect(result.status).toBe(item.expected.exitCode);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`exec-error:${item.expected.code}`);
    const selected = observation(observed).containment;
    expect(selected).toBe(containment!);
    records.push({ corpus: item.name, containment: selected });
  }
  expect(execute(launcher).status).toBe(37);
});

proof(
  "common",
  "正常な準備には5秒上限を設けず、5.2秒後に同じ launcher PID で target を実行する",
  () => {
    const slow = join(root, "slow.ts");
    fs.writeFileSync(slow, `await Bun.sleep(5200); await import(${JSON.stringify(prepare)});`);
    const started = performance.now();
    const result = spawnSync(
      observer,
      [
        "seed",
        join(root, "slow-fd"),
        "cloexec",
        "clear",
        entry,
        runner,
        slow,
        launcher,
        "reviewer",
        observer,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status).toBe(37);
    expect(performance.now() - started).toBeGreaterThan(5_000);
    const [seed, target] = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(target.pid).toBe(seed.pid);
  },
  12_000,
);

proof("common", "準備失敗・不正 frame・完了 frame 後の非ゼロ終了では target を実行しない", () => {
  for (const mode of ["prep-fail", "prep-partial", "prep-trailing", "prep-complete-fail"]) {
    const result = execute(launcher, mode);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("launcher: preparation failed");
  }
  expect(execute(launcher).status).toBe(37);
});

proof(
  "common",
  "wrapper 入力の ARG_MAX で旧方式の受理範囲を独立対照と比較する",
  () => {
    for (const environmentEntries of containment === "cgroup" ? [0, 16] : [0]) {
      const padding = "e".repeat(64 * 1024);
      const env = { ...process.env };
      for (let index = 0; index < environmentEntries; index++)
        env[`PROOF_ARG_MAX_${index}`] = padding;
      const run = (binary: string, count: number, tail = 0) => {
        const result = spawnSync(
          observer,
          ["exec-input", entry, runner, prepare, binary, observer, String(count), String(tail)],
          { encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024, env },
        );
        expect(result.error).toBeUndefined();
        if (result.status !== 37) {
          expect(result.status).toBe(1);
          expect(result.stderr).toMatch(/Argument list too long|exec-error:E2BIG/);
        }
        return result;
      };
      let low = 0,
        high = 8192;
      expect(run(baseline, low).status).toBe(37);
      expect(run(baseline, high).status).toBe(1);
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (run(baseline, middle).status === 37) low = middle;
        else high = middle;
      }
      let tail = 0,
        // 引数1個分の文字列と pointer より広げ、拒否を実測してから探索する。
        rejectedTail = 2048;
      expect(run(baseline, low, rejectedTail).status).toBe(1);
      while (tail + 1 < rejectedTail) {
        const middle = Math.floor((tail + rejectedTail) / 2);
        if (run(baseline, low, middle).status === 37) tail = middle;
        else rejectedTail = middle;
      }
      const accepted = run(launcher, low, tail),
        rejected = run(launcher, low, rejectedTail);
      expect(accepted.status).toBe(37);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toMatch(/Argument list too long|exec-error:E2BIG/);
      records.push({
        argumentLimit: {
          environmentEntries,
          bytesPerArgument: 1024,
          baselineMaxCount: low,
          candidateMaxAccepted: low,
          acceptedTailBytes: tail,
          rejectedTailBytes: rejectedTail,
          candidateDiagnostic: rejected.stderr,
        },
      });
    }
  },
  60_000,
);

proof(
  "common",
  "元 launcher の frame 上限の直前は通り、上限では候補も同じ診断で拒否する",
  () => {
    const driver = join(root, "frame-limit.ts");
    fs.writeFileSync(
      driver,
      `
    const fields = ["exec-proof-v1", "reviewer", ${JSON.stringify(observer)}, "1", "codex", "1", "", "0"];
    const size = Number(process.argv[2]);
    fields[6] = "x".repeat(size - Buffer.byteLength(fields.join("\\0") + "\\0"));
    process.stdout.write(fields.join("\\0") + "\\0");
  `,
    );
    for (const binary of [baseline, launcher]) {
      for (const size of [16 * 1024 * 1024 - 1, 16 * 1024 * 1024]) {
        const result = spawnSync(entry, [runner, driver, binary, String(size), observer], {
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        if (size === 16 * 1024 * 1024 - 1) {
          expect(result.status).toBe(37);
          expect(JSON.parse(result.stdout).event).toBe("target");
        } else {
          expect(result.status).toBe(1);
          expect(result.stdout).toBe("");
          expect(result.stderr).toBe("launcher: preparation failed\n");
        }
      }
    }
    records.push({
      frameLimit: { acceptedBytes: 16 * 1024 * 1024 - 1, rejectedBytes: 16 * 1024 * 1024 },
    });
  },
  45_000,
);

function contextPrepare() {
  const path = join(root, "context.ts");
  const ownedFile = join(root, "owner-only");
  fs.writeFileSync(ownedFile, "proof-access", { mode: 0o600 });
  fs.writeFileSync(
    path,
    `
    const child = Bun.spawnSync([process.argv[3]!, "context"]);
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    process.stderr.write(child.stderr);
    if (await Bun.file(${JSON.stringify(ownedFile)}).text() !== "proof-access") throw new Error("owner file を読めません");
    await import(${JSON.stringify(prepare)});
  `,
  );
  return (binary: string) => {
    const result = spawnSync(entry, [runner, path, binary, "reviewer", observer], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.status).toBe(37);
    return contexts(result.stderr)[0];
  };
}

proof("common", "準備子の UID/GID/groups と proc PID は対照に一致する", () => {
  const context = contextPrepare();
  const [before, after] = [baseline, launcher].map(context);
  for (const key of ["uid", "euid", "gid", "egid"]) expect(after[key]).toEqual(before[key]);
  if (containment === "namespace") {
    expect(after.uid_map).toEqual([[before.uid, before.uid, 1]]);
    expect(after.gid_map).toEqual([[before.gid, before.gid, 1]]);
    const overflowGid = Number(fs.readFileSync("/proc/sys/kernel/overflowgid", "utf8").trim());
    // 写像外の補助 group は namespace 内で overflow GID に見える。
    expect([...after.groups].sort((a: number, b: number) => a - b)).toEqual(
      groupsInNamespace(before.groups, after.gid_map, overflowGid).sort((a, b) => a - b),
    );
  } else {
    // cgroup 経路は user namespace を作らないため、写像も groups も対照と同じになる。
    expect(after.uid_map).toEqual(before.uid_map);
    expect(after.gid_map).toEqual(before.gid_map);
    expect(after.groups).toEqual(before.groups);
  }
  expect(before.procSelf).toBe(String(before.pid));
  expect(after.procSelf).toBe(String(after.pid));
  records.push({ preparationContext: { containment, before, after, procPidCompatible: true } });
});

proof("namespace", "mount-proc なしの launcher では準備子の proc PID の不整合を検出する", () => {
  const mismatched = contextPrepare()(withoutProc);
  expect(mismatched.procSelf).not.toBe(String(mismatched.pid));
  records.push({ preparationContext: { withoutProc: mismatched } });
});

for (const member of [true, false]) {
  proof(
    "common",
    member
      ? "補助 group だけで許可される読み書きを候補でも維持する"
      : "補助 group 非所属時の読み書き拒否を候補でも維持する",
    () => {
      const uid = process.getuid!(),
        gid = process.getgid!();
      expect(uid).toBeGreaterThan(0);
      const selectedGid = Number(groupGid);
      expect(Number.isSafeInteger(selectedGid)).toBe(true);
      expect(selectedGid).toBeGreaterThan(0);
      expect(selectedGid).not.toBe(gid);
      const originalGroups = fs
        .readFileSync("/proc/self/status", "utf8")
        .match(/^Groups:\s*(.*)$/m)![1]!
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
      expect(originalGroups).not.toContain(selectedGid);
      const groups = member ? [...originalGroups, selectedGid] : originalGroups;
      const overflowGid = Number(fs.readFileSync("/proc/sys/kernel/overflowgid", "utf8").trim());
      const fileState = fs.statSync(groupFile!);
      expect(fileState.uid).not.toBe(uid);
      expect(fileState.gid).toBe(selectedGid);
      expect(fileState.mode & 0o777).toBe(0o060);
      const groupPrepare = join(root, `group-${member}.ts`);
      fs.writeFileSync(
        groupPrepare,
        `
        import { readFileSync } from "node:fs";
        console.error("namespace-group-caps:" + readFileSync("/proc/self/status", "utf8").match(/^CapEff:\\s*(\\S+)$/m)![1]);
        console.error("namespace-group-environment:" + JSON.stringify({ PATH: process.env.PATH, HOME: process.env.HOME }));
        const result = Bun.spawnSync([${JSON.stringify(observer)}, "group-access", ${JSON.stringify(groupFile)}]);
        process.stderr.write(result.stderr);
        if (result.exitCode !== 0) process.exit(result.exitCode);
        await import(${JSON.stringify(prepare)});
      `,
      );
      const observations = [baseline, launcher].map((binary) => {
        const result = spawnSync(
          "sudo",
          [
            "-n",
            "--",
            fs.realpathSync(Bun.which("setpriv")!),
            "--reuid",
            String(uid),
            "--regid",
            String(gid),
            ...(groups.length ? ["--groups", groups.join(",")] : ["--clear-groups"]),
            "--inh-caps=-all",
            "--ambient-caps=-all",
            "--",
            "env",
            "-i",
            `PATH=${process.env.PATH}`,
            `HOME=${process.env.HOME}`,
            // 資格情報を切り替えた準備子からも user manager に届くよう、user bus の場所だけを渡す。
            ...["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap((name) =>
              process.env[name] ? [`${name}=${process.env[name]}`] : [],
            ),
            entry,
            runner,
            groupPrepare,
            binary,
            "reviewer",
            observer,
          ],
          { encoding: "utf8", timeout: 10_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(37);
        expect(result.stderr).toContain("namespace-group-caps:0000000000000000");
        const environmentLine = result.stderr
          .split("\n")
          .find((line) => line.startsWith("namespace-group-environment:"));
        expect(environmentLine).toBeDefined();
        const environment = JSON.parse(
          environmentLine!.slice("namespace-group-environment:".length),
        );
        expect(environment).toEqual({ PATH: process.env.PATH, HOME: process.env.HOME });
        const line = result.stderr
          .split("\n")
          .find((line) => line.startsWith("namespace-group-access:"));
        expect(line).toBeDefined();
        const report = JSON.parse(line!.slice("namespace-group-access:".length));
        expect(report.uid).toBe(uid);
        expect(report.euid).toBe(uid);
        expect(report.gid).toBe(gid);
        expect(report.egid).toBe(gid);
        expect(report.ownerUid).not.toBe(uid);
        expect(report.fileGid).not.toBe(gid);
        expect(report.mode).toBe(0o060);
        expect(report.dev).toBe(String(fileState.dev));
        expect(report.ino).toBe(String(fileState.ino));
        expect(report.readErrno).toBe(member ? 0 : 13);
        expect(report.writeErrno).toBe(member ? 0 : 13);
        expect(report.readMarker).toBe(member);
        expect(report.written).toBe(member ? 12 : -1);
        const context = contexts(result.stderr)[0];
        expect(context).toBeDefined();
        const expectedGroups =
          binary === baseline || containment === "cgroup"
            ? groups
            : groupsInNamespace(groups, context.gid_map, overflowGid);
        expect([...context.groups].sort((a: number, b: number) => a - b)).toEqual(
          [...expectedGroups].sort((a, b) => a - b),
        );
        return {
          binary: binary === baseline ? "baseline" : "candidate",
          report,
          environment,
          context,
        };
      });
      records.push({
        supplementaryGroup: {
          member,
          uid,
          gid,
          originalGroups,
          selectedGid,
          overflowGid,
          observations,
        },
      });
    },
    30_000,
    !groupFile || !groupGid,
  );
}

for (const [action, signal, status] of [
  ["input", null, 37],
  ["interrupt", "SIGINT", 130],
  ["terminate", "SIGTERM", 143],
  ["timeout", "SIGTERM", 143],
] as const) {
  proof(
    "common",
    `実 PTY の ${action} で target の PID・TTY・foreground group と終了状態を維持する`,
    async () => {
      let output = "";
      const decoder = new TextDecoder();
      const drained = Promise.withResolvers<void>();
      const ready = Promise.withResolvers<void>();
      const child = Bun.spawn(
        [
          observer,
          "seed",
          join(root, "tty-fd"),
          "cloexec",
          "clear",
          entry,
          runner,
          prepare,
          launcher,
          "search",
          observer,
          "interactive",
        ],
        {
          timeout: action === "timeout" ? 1_000 : 5_000,
          killSignal: "SIGTERM",
          terminal: {
            cols: 80,
            rows: 24,
            data(_terminal, bytes) {
              output += decoder.decode(bytes, { stream: true });
              if (output.includes('"event":"ready"')) ready.resolve();
            },
            exit() {
              drained.resolve();
            },
          },
        },
      );
      try {
        await within(
          Promise.race([
            ready.promise,
            child.exited.then(() => {
              throw new Error(`PTY が ready 前に終了: ${output}`);
            }),
          ]),
        );
        if (action === "input") child.terminal!.write("hello🙂\n");
        if (action === "interrupt") child.terminal!.write("\x03");
        if (action === "terminate") child.kill("SIGTERM");
        const observedStatus = await within(child.exited);
        expect(observedStatus).toBe(status);
        await within(drained.promise);
        expect(child.signalCode).toBe(signal);
        const reports = output
          .split(/\r?\n/)
          .filter((line) => line.startsWith('{"event":'))
          .map((line) => JSON.parse(line));
        const [seed, target, input] = reports;
        for (const key of ["pid", "ppid", "pgid", "sid"] as const)
          expect(target[key]).toBe(seed[key]);
        expect(target.tty).toEqual([1, 1, 1]);
        expect(target.foreground).toBe(target.pgid);
        if (action === "input") expect(input.value).toBe("hello🙂\n");
        records.push({ pty: action, status: observedStatus, signal: child.signalCode, reports });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await within(child.exited);
        }
        child.terminal!.close();
      }
    },
    12_000,
  );
}

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  proof(
    "common",
    `実 PTY の準備中の ${signal} でも離脱子孫を終了し target を起動しない`,
    async () => {
      let output = "";
      const decoder = new TextDecoder();
      const drained = Promise.withResolvers<void>();
      const child = Bun.spawn(
        [entry, runner, prepare, launcher, "prep-detached-session", observer],
        {
          env: { ...process.env, LD_PRELOAD: delay, PROCESS_PROOF_DETACH_INIT: "1" },
          terminal: {
            data(_terminal, bytes) {
              output += decoder.decode(bytes, { stream: true });
            },
            exit() {
              drained.resolve();
            },
          },
        },
      );
      let owned: Awaited<ReturnType<typeof pin>> | undefined;
      try {
        await until(() => (output.match(/prep-detached:\d+:/g) ?? []).length === 2);
        const pids = descendants(child.pid);
        expect(pids.length).toBe(5);
        owned = await pin(pids);
        const started = performance.now();
        child.kill(signal);
        await within(child.exited);
        await until(async () => (await owned!.terminated()).length === pids.length, 4_500);
        const durationMs = performance.now() - started;
        expect(durationMs).toBeLessThan(5_000);
        await within(drained.promise);
        expect(output).not.toContain('"event":"target"');
        records.push({ preparationPty: signal, pids, durationMs, targetStarted: false });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await within(child.exited);
        }
        await owned?.close();
        child.terminal!.close();
      }
    },
    12_000,
  );
}

proof(
  "common",
  "実 Nix・shellHook を現行 prepare_environment caller から実行し候補と比較する",
  () => {
    const project = join(root, "nix-project");
    fs.mkdirSync(project);
    for (const path of [nixStdenv!, nixBash!]) {
      expect(fs.realpathSync(path)).toMatch(/^\/nix\/store\/[a-z0-9]{32}-[a-zA-Z0-9+._?=-]+$/);
    }
    // 導入済み closure のみを参照する。Nixpkgs の fetch や host の設定変更は行わない。
    fs.writeFileSync(
      join(project, "flake.nix"),
      `{
    outputs = { self }: { devShells.${process.arch === "arm64" ? "aarch64" : "x86_64"}-linux.default = builtins.derivation {
      name = "process-namespace-proof"; system = "${process.arch === "arm64" ? "aarch64" : "x86_64"}-linux";
      builder = builtins.appendContext "${nixBash}/bin/bash" { "${nixBash}" = { path = true; }; };
      stdenv = builtins.appendContext "${nixStdenv}" { "${nixStdenv}" = { path = true; }; }; args = [ "-c" "exit 1" ];
      shellHook = "export PROCESS_NAMESPACE_NIX_PROBE=hook-ok";
    }; };
  }`,
    );
    for (const args of [
      ["init", "-q"],
      ["add", "flake.nix"],
    ]) {
      const result = spawnSync("git", ["-C", project, ...args], {
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(result.status).toBe(0);
    }
    const python = Bun.which("python3");
    if (!python) throw new Error("実 caller の対照には導入済み Python が必要です");
    const caller = join(root, "real-caller.py");
    const library = fileURLToPath(new URL("../../lib/python", import.meta.url));
    fs.writeFileSync(
      caller,
      `import os,sys,json\nsys.path.insert(0,${JSON.stringify(library)})\nfrom treflebonbon_skills.git_context import Repository\nfrom treflebonbon_skills.devshell_environment import prepare_environment\nrepo=Repository.discover(sys.argv[1])\nenv=prepare_environment(repo,dict(os.environ),require_trust=False,timeout=30,isolated=True)\nprint(json.dumps({"hook":env.get("PROCESS_NAMESPACE_NIX_PROBE")}))\n`,
    );
    const realPrepare = join(root, "real-prepare.ts");
    fs.writeFileSync(
      realPrepare,
      `const result = Bun.spawnSync([${JSON.stringify(python)}, "-I", "-B", ${JSON.stringify(caller)}, ${JSON.stringify(project)}], {env: {...process.env, NIX_CONFIG: "experimental-features = nix-command flakes\\npure-eval = false\\nsubstituters = \\n"}});
    process.stderr.write(result.stderr); if (result.exitCode !== 0) process.exit(17);
    console.error("real-caller:" + result.stdout.toString().trim());
    await import(${JSON.stringify(prepare)});`,
    );
    const observations = [baseline, launcher].map((binary) => {
      const result = spawnSync(entry, [runner, realPrepare, binary, "reviewer", observer], {
        encoding: "utf8",
        timeout: 70_000,
      });
      return {
        binary: binary === baseline ? "baseline" : "candidate",
        status: result.status,
        stderr: result.stderr,
      };
    });
    const nix = spawnSync("nix", ["--version"], { encoding: "utf8", timeout: 5_000 });
    expect(nix.status).toBe(0);
    const hash = (path: string) => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
    records.push({
      realCaller: {
        nixStdenv,
        nixBash,
        nixVersion: nix.stdout.trim(),
        callerSourceHash: hash(join(library, "treflebonbon_skills/devshell_environment.py")),
        flakeHash: hash(join(project, "flake.nix")),
        bashHash: hash(join(nixBash!, "bin/bash")),
        observations,
      },
    });
    for (const result of observations) {
      expect(result.status).toBe(37);
      expect(result.stderr).toContain('real-caller:{"hook": "hook-ok"}');
    }
  },
  150_000,
  !nixStdenv || !nixBash,
);
