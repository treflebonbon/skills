import * as fs from "node:fs";
import { resolve } from "node:path";
import { strip } from "../../../lib/bun/coordination-json.ts";
import digitZeros from "../../../lib/bun/vendor/peer-decimal.json";

type Range = [bigint, bigint];
// Python 3.14 の Unicode 16 と同じ数字だけを行番号として受け入れる。
const digits =
  "[" +
  digitZeros
    .map((start) => `\\u{${start.toString(16)}}-\\u{${(start + 9).toString(16)}}`)
    .join("") +
  "]";
const declaration = new RegExp(`^(.*?)(?::(${digits}+)-(${digits}+))?$`, "u");
function decimal(text: string): bigint {
  const characters = Array.from(text);
  if (characters.length > 4300)
    throw new Error("行番号は旧 Python と同じ4300桁以内で指定してください");
  let value = 0n;
  for (const digit of characters) {
    const point = digit.codePointAt(0)!;
    const start = digitZeros.find((start) => start <= point && point < start + 10)!;
    value = value * 10n + BigInt(point - start);
  }
  return value;
}
function main(): number {
  const [owned, repo] = process.argv.slice(2);
  if (owned === undefined || repo === undefined || process.argv.length !== 4) return 2;
  const declared = new Map<string, Range[] | null>();
  for (const raw of owned.split(",")) {
    const item = strip(raw);
    if (!item) continue;
    const match = declaration.exec(item);
    if (!match) throw new Error("変更所有範囲の形式が不正です");
    let path = match[1]!;
    while (path.startsWith("./")) path = path.slice(2);
    if (match[2] === undefined) declared.set(path, null);
    else if (declared.get(path) !== null) {
      const ranges = declared.get(path) ?? [];
      ranges.push([decimal(match[2]), decimal(match[3]!)]);
      declared.set(path, ranges);
    }
  }
  const outside = new Set<string>();
  const covers = (ranges: Range[], lo: bigint, hi: bigint) =>
    ranges.some(([a, b]) => a <= lo && hi <= b);
  const check = (path: string, lo: bigint, hi: bigint, label: string) => {
    const ranges = declared.get(path);
    if (ranges === undefined) outside.add(path);
    else if (ranges !== null && !covers(ranges, lo, hi))
      outside.add(`${path}:${label} (outside the declared lines)`);
  };
  let current: string | undefined,
    isNew = false;
  const hunks = new Map<string, boolean>();
  const diff = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    fs.readFileSync(0),
  );
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const at = line.lastIndexOf(" b/");
      current = at < 0 ? line : line.slice(at + 3);
      isNew = false;
      hunks.set(current, false);
    } else if (line.startsWith("new file mode") && current !== undefined) isNew = true;
    else if (line.startsWith("@@ ") && current !== undefined) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) throw new Error("diff の行範囲を読み取れません");
      const oldStart = BigInt(match[1]!),
        oldCount = BigInt(match[2] ?? "1");
      const newStart = BigInt(match[3]!),
        newCount = BigInt(match[4] ?? "1");
      hunks.set(current, true);
      if (isNew)
        check(
          current,
          newStart,
          newStart + newCount - 1n,
          `${newStart}-${newStart + newCount - 1n}`,
        );
      else if (oldCount > 0n)
        check(
          current,
          oldStart,
          oldStart + oldCount - 1n,
          `${oldStart}-${oldStart + oldCount - 1n}`,
        );
      else {
        const ranges = declared.get(current);
        if (ranges === undefined) outside.add(current);
        else if (ranges !== null && !ranges.some(([a, b]) => a <= oldStart + 1n && oldStart <= b))
          outside.add(`${current}:insert-after-${oldStart} (outside the declared lines)`);
      }
    }
  }
  for (const [path, seen] of hunks) if (!seen && !declared.has(path)) outside.add(path);
  for (const path of (process.env.UNTRACKED ?? "").split("\n")) {
    if (!path) continue;
    let lines = 0n,
      last = 10;
    let fd: number | undefined;
    try {
      fd = fs.openSync(resolve(repo, path), "r");
      const buffer = Buffer.alloc(1 << 20);
      let count: number;
      while ((count = fs.readSync(fd, buffer)) > 0) {
        for (let at = 0; at < count; at++) if (buffer[at] === 10) lines++;
        last = buffer[count - 1]!;
      }
      if (last !== 10) lines++;
    } catch {
      lines = 1n;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    if (lines < 1n) lines = 1n;
    check(path, 1n, lines, `1-${lines}`);
  }
  // 有効な UTF-8 の byte 順は Python と同じ code point 順になる。
  for (const entry of [...outside].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))))
    console.log(entry);
  return outside.size ? 1 : 0;
}
try {
  process.exitCode = main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
