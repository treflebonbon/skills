import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createInterface } from "node:readline";

const [mode, executable, ...arguments_] = process.argv.slice(2);
if (!executable) throw new Error("観測用 executable が必要です");
if (mode === "execve") {
  process.execve!(executable, [executable, ...arguments_], process.env);
} else if (mode === "execve-caught") {
  try {
    process.execve!(executable, [executable, ...arguments_], process.env);
  } catch (error) {
    console.error(`exec-error:${(error as NodeJS.ErrnoException).code}`);
    process.exit(1);
  }
} else if (mode === "spawn") {
  const child = Bun.spawnSync([executable, ...arguments_], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(child.exitCode);
} else if (mode === "lock") {
  const [path, inheritance] = arguments_;
  if (!path) throw new Error("lock path が必要です");
  let descriptor: number | undefined = fs.openSync(
    path,
    fs.constants.O_RDWR | fs.constants.O_CREAT,
    0o600,
  );
  let child: ReturnType<typeof spawn> | undefined;
  try {
    // 既存 peer-request.sh と同じ open file description で flock を取得する。
    const acquired = spawnSync(
      "perl",
      [
        "-MFcntl=:flock",
        "-e",
        'open(my $fh, "+<&=", 3) or exit 2; flock($fh, LOCK_EX | LOCK_NB) or exit 1',
      ],
      { stdio: ["ignore", "ignore", "pipe", descriptor], encoding: "utf8", timeout: 5_000 },
    );
    if (acquired.error || acquired.status !== 0)
      throw new Error(
        `lock-error:${acquired.status === 1 ? "busy" : "acquisition"}:${acquired.error?.message ?? acquired.stderr}`,
      );
    console.log(JSON.stringify({ event: "locked", pid: process.pid }));
    const lines = createInterface({ input: process.stdin });
    try {
      for await (const command of lines) {
        if (command === "close") {
          if (descriptor === undefined) throw new Error("lock は既に閉じています");
          fs.closeSync(descriptor);
          descriptor = undefined;
          console.log(JSON.stringify({ event: "closed" }));
        } else if (command === "spawn") {
          if (child || descriptor === undefined) throw new Error("子 process の状態が不正です");
          child = spawn(executable, ["interactive"], {
            stdio: [
              "pipe",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              inheritance === "inherit" ? descriptor : "ignore",
            ],
          });
          await once(child, "spawn");
          console.log(JSON.stringify({ event: "spawned", child: child.pid }));
        } else if (command === "replace") {
          process.execve!(executable, [executable, "interactive"], process.env);
        } else if (command === "finish") {
          break;
        } else throw new Error(`未知の lock command: ${command}`);
      }
    } finally {
      lines.close();
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      await ended;
    }
  }
} else {
  throw new Error(`未知の実証 mode: ${mode}`);
}
