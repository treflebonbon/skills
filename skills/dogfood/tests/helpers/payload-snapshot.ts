import { createHash } from "node:crypto";
import * as fs from "node:fs";

const root = fs.realpathSync(process.argv[2]!);
const ignored = (name: string) => name === ".git" || name === ".env" || name.startsWith(".env.");
type Entry = { kind: string; mode: number; path: string; sha256?: string; target?: string };
const entries: Entry[] = [{ kind: "directory", mode: fs.lstatSync(root).mode & 0o7777, path: "." }];
// Python の filesystem surrogateescape を保ち、不正 UTF-8 の名前も元の bytes で読む。
function filename(bytes: Buffer): string {
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let value = "";
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index]!;
    if (byte < 0x80) {
      value += String.fromCharCode(byte);
      index++;
      continue;
    }
    const width =
      byte >= 0xc2 && byte <= 0xdf
        ? 2
        : byte >= 0xe0 && byte <= 0xef
          ? 3
          : byte >= 0xf0 && byte <= 0xf4
            ? 4
            : 0;
    try {
      if (!width || index + width > bytes.length) throw Error();
      value += utf8.decode(bytes.subarray(index, index + width));
      index += width;
    } catch {
      value += String.fromCharCode(0xdc00 + byte);
      index++;
    }
  }
  return value;
}
function walk(directory: Buffer, prefix: string) {
  let names: Buffer[];
  try {
    names = fs.readdirSync(directory, { encoding: "buffer" });
  } catch (error) {
    // 旧 os.walk の既定動作と同じく、読めない directory の内容は走査しない。
    if (/^E[A-Z]+$/.test((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  for (const bytes of names) {
    const name = filename(bytes);
    if (ignored(name)) continue;
    const path = Buffer.concat([directory, Buffer.from("/"), bytes]),
      relative = prefix + name,
      info = fs.lstatSync(path),
      mode = info.mode & 0o7777;
    if (info.isSymbolicLink())
      entries.push({
        kind: "symlink",
        mode,
        path: relative,
        target: filename(fs.readlinkSync(path, { encoding: "buffer" })),
      });
    else if (info.isDirectory()) {
      entries.push({ kind: "directory", mode, path: relative });
      walk(path, relative + "/");
    } else if (info.isFile()) {
      const digest = createHash("sha256"),
        fd = fs.openSync(path, "r"),
        block = Buffer.alloc(1024 * 1024);
      try {
        for (let size; (size = fs.readSync(fd, block, 0, block.length, null));)
          digest.update(block.subarray(0, size));
      } finally {
        fs.closeSync(fd);
      }
      entries.push({ kind: "file", mode, path: relative, sha256: digest.digest("hex") });
    } else entries.push({ kind: "other", mode, path: relative });
  }
}
walk(Buffer.from(root), "");
entries.sort((a, b) => {
  const left = Array.from(a.path, (character) => character.codePointAt(0)!);
  const right = Array.from(b.path, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(left.length, right.length); index++)
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  return left.length - right.length;
});
// 旧 json.dumps(sort_keys=True) の ASCII escape と separator を保つ。
console.log(
  JSON.stringify(entries).replace(/"(?:[^"\\]|\\.)*"|[:,]/g, (token) =>
    token === ":"
      ? ": "
      : token === ","
        ? ", "
        : token.replace(
            /[^\x00-\x7e]/g,
            (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
          ),
  ),
);
