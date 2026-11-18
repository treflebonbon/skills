import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  coordinationJSON,
  DuplicateKey,
  object,
  strip,
} from "../../../lib/bun/coordination-json.ts";

function match(actual: unknown, expected: unknown, label: string): void {
  if (
    typeof actual !== "string" ||
    !strip(actual) ||
    typeof expected !== "string" ||
    !strip(expected) ||
    actual !== expected
  )
    throw new Error(`${label} が期待値と一致しません`);
}
function receipt(path: string): Record<string, any> {
  let value;
  try {
    value = coordinationJSON(readFileSync(path));
  } catch (error) {
    throw new Error(
      "receipt を読み取れません" + (error instanceof DuplicateKey ? `: ${error.message}` : ""),
    );
  }
  if (!object(value) || value.ok !== true) throw new Error("receipt が成功応答ではありません");
  if (value.error != null) throw new Error("receipt に error があります");
  if (!object(value.result)) throw new Error("receipt に result がありません");
  return value.result;
}

function main(): number {
  const [kind, ...args] = process.argv.slice(2);
  if (kind === "--help") {
    console.log("使い方: orca-preflight coordinator | worker-show");
    return 0;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    let required: string[];
    if (kind === "coordinator") required = ["run", "handle"];
    else if (kind === "worker-show") required = ["dispatch", "task", "assignee"];
    else throw new Error("検査対象が必要です");
    const options: Record<string, { type: "string" | "boolean" }> = { help: { type: "boolean" } };
    for (const name of required) options[name] = { type: "string" };
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options,
    });
    if (parsed.values.help) {
      console.log(
        `使い方: orca-preflight ${kind} <file> ${required.map((name) => `--${name} <value>`).join(" ")}`,
      );
      return 0;
    }
    if (
      parsed.positionals.length !== 1 ||
      required.some((name) => parsed.values[name] === undefined)
    )
      throw new Error("必須の引数を指定してください");
  } catch (error) {
    console.error(`使用法エラー: ${(error as Error).message}`);
    return 2;
  }
  try {
    const result = receipt(parsed.positionals[0]!);
    const values = parsed.values;
    if (kind === "coordinator") {
      if (!object(result.run)) throw new Error("result.run がありません");
      match(result.run.id, values.run, "Run ID");
      match(result.run.coordinator_handle, values.handle, "coordinator handle");
    } else {
      if (!object(result.dispatch)) throw new Error("result.dispatch がありません");
      match(result.dispatch.id, values.dispatch, "Dispatch ID");
      match(result.dispatch.taskId, values.task, "Task ID");
      match(result.dispatch.assigneeHandle, values.assignee, "assignee handle");
      match(result.dispatch.status, "dispatched", "Dispatch status");
    }
  } catch (error) {
    console.error(`preflight 拒否: ${(error as Error).message}`);
    return 1;
  }
  console.log("preflight OK: receipt identity matches");
  return 0;
}
process.exitCode = main();
