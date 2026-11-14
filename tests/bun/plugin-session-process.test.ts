import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { resolve } from "node:path";
import corpus from "../fixtures/plugin-sessions-python.json";

const root = resolve(import.meta.dir, "../.."),
  runner = resolve(root, "lib/bun/run"),
  ps = Bun.which("ps")!;
const baseline = corpus.cases.find((item) => item.args[0] === "run" && item.status === 0)!;
const inventory = baseline.native!.find(
  (call) => call.runtime === "agy" && call.args.includes("/skills"),
)!;
const session = baseline.native!.find(
  (call) =>
    call.runtime === "agy" && call.args.some((arg) => arg.startsWith("/treflebonbon-skills:")),
)!;

function running(pid: number): boolean {
  const result = spawnSync(ps, ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect([0, 1]).toContain(result.status!);
  return !!result.stdout.trim() && !result.stdout.trim().startsWith("Z");
}
async function until<T>(read: () => T | false): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== false) return value;
    await Bun.sleep(10);
  }
  throw new Error("fixture の開始・終了を観測できませんでした");
}
const stopped = (pid: number) => until(() => !running(pid));

test("timeout と中断は所有 process group を回収し、SIGTERM を無視する孫 process も残さない", async () => {
  try {
    fs.mkdirSync("/tmp/codex", { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const shared = fs.lstatSync("/tmp/codex");
  if (!shared.isDirectory()) throw Error("/tmp/codex は symlink ではない通常 directory が必要です");
  const uid = process.getuid!();
  if (shared.uid !== uid)
    throw Error(`/tmp/codex の所有者が一致しません（期待 UID: ${uid}、実際 UID: ${shared.uid}）`);
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/codex/plugin-session-process-49-")),
    commands = resolve(directory, "bin"),
    ready = resolve(directory, "worker.json"),
    group = resolve(directory, "group.json");
  fs.mkdirSync(commands);
  for (const name of ["bash", "dirname", "readlink"])
    fs.symlinkSync(Bun.which(name)!, resolve(commands, name));
  fs.symlinkSync(process.execPath, resolve(commands, "bun"));
  const worker = resolve(directory, "worker.cjs"),
    fixture = resolve(directory, "agy.cjs"),
    client = resolve(commands, "agy");
  fs.writeFileSync(
    worker,
    `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,parent:Number(process.env.FIXTURE_PARENT_PID)}));setInterval(()=>{},1000);\n`,
  );
  fs.writeFileSync(
    fixture,
    `const fs=require('node:fs'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const args=process.argv.slice(2),inventory=${JSON.stringify(inventory)},session=${JSON.stringify(session)};
if(args[0]==='--version'){assert.deepEqual(args,['--version']);console.log('fixture-cli 1.0');}
else if(args.includes('/skills')){assert.deepEqual(args,inventory.args);process.stdout.write(Buffer.from(inventory.stdout,'base64'));}
else {
 const expected=[...session.args.slice(0,-1),process.env.FIXTURE_SECONDS+'s'];assert.deepEqual(args,expected);assert.equal(process.cwd(),process.env.FIXTURE_CASE);
 const shell=spawn('bash',['-p','-c','"$1" run "$2" & wait','worker',${JSON.stringify(runner)},${JSON.stringify(worker)}],{env:{...process.env,FIXTURE_PARENT_PID:String(process.pid)},stdio:'ignore'});
 fs.writeFileSync(${JSON.stringify(group)},JSON.stringify({parent:process.pid,shell:shell.pid}));
 (async()=>{for(let index=0;index<500;index++){if(fs.existsSync(${JSON.stringify(ready)})&&JSON.parse(fs.readFileSync(${JSON.stringify(ready)},'utf8')).parent===process.pid){process.stdout.write(Buffer.from(session.stdout,'base64'));setInterval(()=>{},1000);return;}await Bun.sleep(10);}throw Error('worker が開始しませんでした');})();
}
`,
  );
  fs.writeFileSync(client, `#!/bin/bash -p\nexec '${runner}' run '${fixture}' "$@"\n`, {
    mode: 0o700,
  });
  const groups = new Set<number>();
  const info = () => (fs.existsSync(group) ? JSON.parse(fs.readFileSync(group, "utf8")) : null);
  const started = async (parent?: number) =>
    until(() => {
      if (!fs.existsSync(ready)) return false;
      const worker = JSON.parse(fs.readFileSync(ready, "utf8"));
      const actual = parent ?? info()?.parent;
      return actual && worker.parent === actual && running(worker.pid) ? worker : false;
    });
  const cleanup = () => {
    for (const pid of groups)
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    const worker = fs.existsSync(ready) ? JSON.parse(fs.readFileSync(ready, "utf8")) : null;
    for (const pid of [worker?.pid, info()?.shell, info()?.parent])
      if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid)
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
  };
  try {
    // 同じ fixture は親だけの終了では孫を残すことを、回収の対照として確認する。
    const controlDir = resolve(directory, "control");
    fs.mkdirSync(controlDir);
    const control = spawn(client, [...session.args.slice(0, -1), "1s"], {
      cwd: controlDir,
      env: { ...process.env, PATH: commands, FIXTURE_CASE: controlDir, FIXTURE_SECONDS: "1" },
      detached: true,
      stdio: "ignore",
    });
    groups.add(control.pid!);
    const controlWorker = await started(control.pid!);
    control.kill("SIGTERM");
    await stopped(control.pid!);
    expect(running(controlWorker.pid)).toBe(true);
    process.kill(-control.pid!, "SIGKILL");
    groups.delete(control.pid!);
    await stopped(controlWorker.pid);

    const output = resolve(directory, "timeout"),
      casePath = resolve(output, "agy/rop");
    const timed = spawnSync(
      resolve(root, "development/plugin-sessions"),
      [
        "run",
        "--runtime",
        "agy",
        "--skill",
        "rop",
        "--timeout",
        "1",
        "--installed-root",
        "agy=/installed/plugin",
        "--output-dir",
        output,
      ],
      {
        cwd: root,
        env: { ...process.env, PATH: commands, FIXTURE_CASE: casePath, FIXTURE_SECONDS: "1" },
        maxBuffer: Infinity,
        timeout: 12_000,
        killSignal: "SIGKILL",
      },
    );
    expect(timed.status, timed.stderr.toString()).toBe(1);
    expect(JSON.parse(timed.stdout.toString()).cases[0].reasons).toContain("process_failed");
    expect(JSON.parse(fs.readFileSync(resolve(casePath, "process.json"), "utf8")).exit_code).toBe(
      124,
    );
    expect(fs.readFileSync(resolve(casePath, "events.jsonl"))).toEqual(
      Buffer.from(session.stdout, "base64"),
    );
    const timeoutWorker = JSON.parse(fs.readFileSync(ready, "utf8"));
    expect(timeoutWorker.parent).not.toBe(control.pid!);
    await stopped(timeoutWorker.pid);
    for (const name of ["events.jsonl", "stderr.log", "process.json"])
      expect(fs.statSync(resolve(casePath, name)).mode & 0o777).toBe(0o600);

    const interrupted = resolve(directory, "interrupt"),
      interruptCase = resolve(interrupted, "agy/rop");
    const child = spawn(
      resolve(root, "development/plugin-sessions"),
      ["run", "--runtime", "agy", "--skill", "rop", "--timeout", "60", "--output-dir", interrupted],
      {
        cwd: root,
        env: { ...process.env, PATH: commands, FIXTURE_CASE: interruptCase, FIXTURE_SECONDS: "60" },
        detached: true,
        stdio: "ignore",
      },
    );
    groups.add(child.pid!);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    await until(() => info()?.parent !== timeoutWorker.parent && info()?.parent);
    const cancelledWorker = await started();
    child.kill("SIGINT");
    const result = await exited;
    groups.delete(child.pid!);
    expect(result).toEqual({ code: null, signal: "SIGINT" });
    await stopped(cancelledWorker.pid);
    expect(fs.existsSync(resolve(interruptCase, "events.jsonl"))).toBe(true);
    expect(fs.existsSync(resolve(interruptCase, "stderr.log"))).toBe(true);
    expect(fs.existsSync(resolve(interruptCase, "process.json"))).toBe(false);
  } finally {
    cleanup();
    fs.rmSync(directory, { recursive: true });
  }
}, 30_000);
