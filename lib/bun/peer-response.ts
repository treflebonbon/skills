import { readFileSync, writeFileSync } from "node:fs";
import { strip, stripEnd } from "./coordination-json.ts";

function main(): number {
  const [head, wantStart, wantEnd] = process.argv.slice(2);
  if (process.argv.length !== 5) return 2;
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(0));
  const lines = text.split("\n");
  const norm = (line: string) =>
    stripEnd(
      line.replace(
        /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000•]+/u,
        "",
      ),
    );
  const start = lines.findIndex((line) => norm(line) === wantStart);
  if (start < 0) return 3;
  let end = -1;
  for (let at = start + 1; at < lines.length; at++) if (norm(lines[at]!) === wantEnd) end = at;
  if (end < 0) return 3;
  const body = lines.slice(start + 1, end).map((line) => stripEnd(line.replace(/^ {1,2}/, "")));
  if (!body.some((line) => strip(line))) return 3;
  writeFileSync(1, head + "\n" + body.join("\n") + "\n");
  return 0;
}
try {
  process.exitCode = main();
} catch {
  console.error("terminal 応答を読み取り・保存できません");
  process.exitCode = 2;
}
