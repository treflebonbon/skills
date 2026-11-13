import { existsSync, readFileSync, writeFileSync, linkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { coordinationJSON, object, strip } from "../../../lib/bun/coordination-json.ts";

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !strip(value)) throw new Error(`${label} が空または不正です`);
  return value;
}
function call(command: string, args: string[], capture = false): Buffer {
  const result = spawnSync(command, args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: Infinity,
  });
  if (result.error || result.status !== 0)
    throw new Error("receipt の取得または検査に失敗しました");
  return result.stdout ?? Buffer.alloc(0);
}
function main(): void {
  const [runDirectory, receiptDirectory] = process.argv.slice(2);
  if (process.argv.length !== 4)
    throw new Error("run directory と receipt directory を指定してください");
  const orca = id(process.env.ORCA_CLI, "ORCA_CLI");
  const handle = id(process.env.ORCA_TERMINAL_HANDLE, "ORCA_TERMINAL_HANDLE");
  const checker = join(import.meta.dir, "orca-preflight");
  const createdPath = join(runDirectory!, "run-create.json");
  const created = coordinationJSON(readFileSync(createdPath));
  if (!object(created) || !object(created.result) || created.result.run === undefined)
    throw new Error("Run receipt に result.run がありません");
  const bound = coordinationJSON(
    call(orca, ["orchestration", "check", "--terminal", handle, "--peek", "--json"], true),
  );
  const runId = id(bound?.result?.runId, "bound Run ID");
  call(checker, ["coordinator", createdPath, "--run", runId, "--handle", handle]);
  call(orca, [
    "orchestration",
    "check",
    "--terminal",
    handle,
    "--run",
    runId,
    "--wait",
    "--timeout-ms",
    "45000",
    "--json",
  ]);
  const started = coordinationJSON(
    readFileSync(join(receiptDirectory!, "worker-start.json")),
  )?.result;
  if (!object(started) || !Array.isArray(started.effects))
    throw new Error("worker-start receipt の形式が不正です");
  const effect = started.effects.find(
    (item) => object(item) && item.kind === "terminal" && item.role === "agent",
  );
  const assignee = id(effect?.id, "assignee handle");
  const dispatch = id(started.dispatchId, "Dispatch ID"),
    task = id(started.taskId, "Task ID");
  const shownPath = join(receiptDirectory!, "worker-show.json");
  let candidatePath = shownPath;
  if (!existsSync(shownPath)) {
    candidatePath = shownPath + ".part";
    if (existsSync(candidatePath))
      throw new Error("未確定の receipt があります。native の状態と実行記録を照合してください");
    const raw = call(
      orca,
      ["orchestration", "worker-show", "--dispatch", dispatch, "--json"],
      true,
    );
    // 旧 subprocess の text mode と同じ改行を保存する。
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(raw)
      .replace(/\r\n?/g, "\n");
    writeFileSync(candidatePath, text, { flag: "wx" });
  }
  call(checker, [
    "worker-show",
    candidatePath,
    "--dispatch",
    dispatch,
    "--task",
    task,
    "--assignee",
    assignee,
  ]);
  if (candidatePath !== shownPath) linkSync(candidatePath, shownPath);
}
try {
  main();
} catch (error) {
  console.error(`receipt 拒否: ${(error as Error).message}`);
  process.exitCode = 1;
}
