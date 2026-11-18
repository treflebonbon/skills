import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { peerJSON } from "./peer-json.ts";
import { coordinationJSON, DuplicateKey, object, strip } from "./coordination-json.ts";

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

const checkoutFields = ["cwd", "physical_root", "branch", "head", "git_dir", "common_dir"] as const;
const schema = "orca-worker-readiness-observation/v1";
const observationFields = new Set([
  "schema",
  "task_id",
  "dispatch_id",
  "assignee_handle",
  ...checkoutFields,
]);
function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !strip(value)) throw new Error(`${label} が空または不正です`);
  return value;
}
function validateCheckout(identity: Record<string, any>): void {
  for (const field of checkoutFields) {
    const value = nonempty(identity[field], field);
    if (["cwd", "physical_root", "git_dir", "common_dir"].includes(field) && !isAbsolute(value))
      throw new Error(`${field} が絶対パスではありません`);
  }
  if (![40, 64].includes(identity.head.length) || !/^[0-9a-f]+$/.test(identity.head))
    throw new Error("HEAD が不正です");
}
function gitValue(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const result = spawnSync("git", ["-C", cwd, ...args], {
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) throw new Error("Git metadata を取得できません");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stdout);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
function checkoutIdentity(path: string) {
  let cwd: string;
  try {
    cwd = realpathSync(path);
  } catch {
    throw new Error("Git metadata を取得できません");
  }
  const identity = {
    cwd,
    physical_root: realpathSync(gitValue(cwd, "rev-parse", "--show-toplevel")),
    branch: gitValue(cwd, "branch", "--show-current"),
    head: gitValue(cwd, "rev-parse", "--verify", "HEAD"),
    git_dir: realpathSync(gitValue(cwd, "rev-parse", "--absolute-git-dir")),
    common_dir: realpathSync(
      gitValue(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    ),
  };
  validateCheckout(identity);
  return identity;
}
function observation(path: string): Record<string, any> {
  let value;
  try {
    value = coordinationJSON(readFileSync(path));
  } catch (error) {
    throw new Error(
      "worker readiness JSON を読み取れません" +
        (error instanceof DuplicateKey ? `: ${error.message}` : ""),
    );
  }
  if (
    !object(value) ||
    Object.keys(value).length !== observationFields.size ||
    Object.keys(value).some((key) => !observationFields.has(key)) ||
    value.schema !== schema
  )
    throw new Error("worker readiness の schema が不正です");
  for (const field of ["task_id", "dispatch_id", "assignee_handle"]) nonempty(value[field], field);
  validateCheckout(value);
  return value;
}
function readiness(action: string, path: string, args: Record<string, string>): void {
  for (const field of ["task", "dispatch", "assignee"]) nonempty(args[field], field);
  nonempty(path, "observation");
  if (action === "record") {
    if (!isAbsolute(path)) throw new Error("observation は絶対パスで指定してください");
    const value = {
      schema,
      task_id: args.task,
      dispatch_id: args.dispatch,
      assignee_handle: args.assignee,
      ...checkoutIdentity(process.cwd()),
    };
    writeFileSync(path, peerJSON(value), { flag: "wx" });
    return;
  }
  nonempty(args.worktree, "worktree");
  if (!isAbsolute(args.worktree!)) throw new Error("worktree は絶対パスで指定してください");
  if (!isAbsolute(path)) throw new Error("observation は絶対パスで指定してください");
  const value = observation(path);
  match(value.task_id, args.task, "Task ID");
  match(value.dispatch_id, args.dispatch, "Dispatch ID");
  match(value.assignee_handle, args.assignee, "assignee handle");
  const expected = checkoutIdentity(args.worktree!);
  if (expected.cwd !== expected.physical_root)
    throw new Error("指定された worktree が physical root ではありません");
  if (expected.git_dir === expected.common_dir)
    throw new Error("割当先が linked worktree ではありません");
  match(expected.branch, args.branch, "割当 branch");
  match(expected.head, args.head, "割当 HEAD");
  for (const field of checkoutFields)
    match(
      value[field],
      field === "branch" ? args.branch : field === "head" ? args.head : expected[field],
      field,
    );
}

function main(): number {
  const [action, ...args] = process.argv.slice(2);
  if (action === "--help") {
    console.log("使い方: orca-worker-readiness record | verify");
    return 0;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    if (action !== "record" && action !== "verify")
      throw new Error("record または verify を指定してください");
    const required = [
      "dispatch",
      "task",
      "assignee",
      ...(action === "verify" ? ["worktree", "branch", "head"] : []),
    ];
    const options: Record<string, { type: "string" | "boolean" }> = { help: { type: "boolean" } };
    for (const name of required) options[name] = { type: "string" };
    parsed = parseArgs({ args, allowPositionals: true, options });
    if (parsed.values.help) {
      console.log(
        `使い方: orca-worker-readiness ${action} <file> ${required.map((name) => `--${name} <value>`).join(" ")}`,
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
    readiness(action, parsed.positionals[0]!, parsed.values as Record<string, string>);
  } catch (error) {
    console.error(`preflight 拒否: ${(error as Error).message}`);
    return 1;
  }
  console.log(
    action === "record"
      ? "preflight OK: worker checkout observation saved"
      : "preflight OK: worker checkout matches assigned worktree",
  );
  return 0;
}
process.exitCode = main();
