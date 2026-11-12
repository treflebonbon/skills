import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { constants } from "node:os";

const usage = "usage: orca-send [-h] --cli CLI --body-file BODY_FILE ...\n";
function error(message: string): never {
  process.stderr.write(`orca-send: ${message}\n`);
  process.exit(2);
}
function argumentError(message: string): never {
  process.stderr.write(usage);
  return error(`error: ${message}`);
}

const args = process.argv.slice(2);
let cli: string | undefined;
let bodyFile: string | undefined;
let index = 0;
for (; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--" || !arg.startsWith("-")) break;
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      `${usage}\nUTF-8本文ファイルを選択済みOrca CLIから文字どおり送信します。\n\npositional arguments:\n  native_args           -- の後に渡す native send 引数\n\noptions:\n  -h, --help            show this help message and exit\n  --cli CLI             このsessionで選択したOrca実行ファイル\n  --body-file BODY_FILE\n                        送信本文のUTF-8ファイル\n\n本文は8 KiB以内の公開情報に限ります。本文をargvに渡すため、同一ホストのプロセスから見える可能性があります。\n`,
    );
    process.exit(0);
  }
  const [key, ...valueParts] = arg.split("=");
  if (key !== "--cli" && key !== "--body-file") argumentError(`unrecognized arguments: ${arg}`);
  let value: string;
  if (valueParts.length) value = valueParts.join("=");
  else {
    value = args[++index];
    if (value === undefined || value.startsWith("-"))
      argumentError(`argument ${key}: expected one argument`);
  }
  if (key === "--cli") cli = value;
  else bodyFile = value;
}
const missing = [
  cli === undefined ? "--cli" : null,
  bodyFile === undefined ? "--body-file" : null,
].filter(Boolean);
if (missing.length) argumentError(`the following arguments are required: ${missing.join(", ")}`);
if (!args.includes("--")) argumentError("native send 引数の前に -- が必要です");
const nativeArgs = args.slice(index);
if (nativeArgs[0] === "--") nativeArgs.shift();
if (!nativeArgs.length) argumentError("-- の後に native send 引数が必要です");
if (
  nativeArgs.some(
    (arg) =>
      ["--body", "-b", "--body-file"].includes(arg) ||
      ["--body=", "--body-file=", "-b="].some((prefix) => arg.startsWith(prefix)),
  )
) {
  argumentError("本文は --body-file で一度だけ指定してください");
}

let body: string;
try {
  const fd = openSync(bodyFile!, "r");
  const bytes = Buffer.alloc(8193);
  let length = 0;
  try {
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
  } finally {
    closeSync(fd);
  }
  if (length > 8192) error("本文は8 KiB以内にしてください");
  // Python の UTF-8 decode と同じく BOM を本文として保持する。
  body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes.subarray(0, length),
  );
} catch {
  error("本文ファイルをUTF-8として読み取れません");
}
// Python str.strip の集合（JS trim は BOM を除去し、U+001C..U+001F を残す）。
if (
  /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u.test(
    body!,
  )
)
  error("本文が空です");
if (body!.includes("\0")) error("本文にNUL文字は使えません");

try {
  const executable = cli!.includes("/") ? cli! : Bun.which(cli!);
  if (!executable) error("選択したOrca CLIを起動できません");
  const result = spawnSync(
    realpathSync(executable),
    ["orchestration", "send", "--body", body!, ...nativeArgs],
    { stdio: "inherit" },
  );
  if (result.error) error("選択したOrca CLIを起動できません");
  // Python の負の signal returncode を sys.exit へ渡したときの終了状態。
  process.exit(result.signal ? 256 - constants.signals[result.signal] : result.status!);
} catch {
  error("選択したOrca CLIを起動できません");
}
