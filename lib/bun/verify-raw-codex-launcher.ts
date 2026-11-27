import * as fs from "node:fs";
import { join } from "node:path";
import { hash } from "./file-safety.ts";

function stamp(info: fs.BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.ctimeNs}`;
}

function directories(path: string): string[] {
  const identities = [];
  let current = "";
  for (const component of path.slice(1).split("/")) {
    current += "/" + component;
    const info = fs.lstatSync(current, { bigint: true });
    // The original user namespace checks owner. Inside unshare, host UID 0 may be unmapped.
    if (
      !info.isDirectory() ||
      ((info.mode & 0o22n) !== 0n && !(current === "/tmp" && (info.mode & 0o1000n) !== 0n))
    )
      throw new Error(`cache の祖先 directory が保護されていません: ${current}`);
    if (
      current === path &&
      (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o7777n) !== 0o700n)
    )
      throw new Error("launcher cache は本人所有の mode 0700 が必要です");
    identities.push(`${info.dev}:${info.ino}`);
  }
  return identities;
}

function verifiedFile(path: string, mode: bigint, limit: bigint) {
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const info = fs.fstatSync(fd, { bigint: true });
    if (
      !info.isFile() ||
      info.uid !== BigInt(process.getuid!()) ||
      (info.mode & 0o7777n) !== mode ||
      info.nlink !== 1n ||
      info.size < 1n ||
      info.size > limit
    )
      throw new Error(`cache file の種類・所有者・mode・サイズが不正です: ${path}`);
    const bytes = Buffer.alloc(Number(info.size));
    if (
      fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length ||
      stamp(fs.lstatSync(path, { bigint: true })) !== stamp(info)
    )
      throw new Error(`検査中に cache file が変わりました: ${path}`);
    return { bytes, identity: stamp(info) };
  } finally {
    fs.closeSync(fd);
  }
}

try {
  const [directory, snapshot] = process.argv.slice(2);
  if (!directory || !snapshot || !/^\/proc\/self\/fd\/[0-9]+$/.test(snapshot))
    throw new Error("launcher の検査引数が不正です");
  const ancestors = directories(directory);
  const source = ["bun-exec-pid-namespace.c", "bun-exec-launcher.c"]
    .map((name) => hash(fs.readFileSync(join(import.meta.dir, "../../tests/fixtures", name))))
    .join("");
  const launcher = verifiedFile(join(directory, "launcher"), 0o500n, 8n * 1024n * 1024n);
  const record = verifiedFile(join(directory, "build.json"), 0o600n, 4096n);
  const metadata = JSON.parse(record.bytes.toString("utf8"));
  const digest = hash(launcher.bytes);
  if (
    metadata?.version !== 1 ||
    metadata.platform !== process.platform ||
    metadata.arch !== process.arch ||
    metadata.sourceHash !== hash(Buffer.from(source)) ||
    metadata.binaryHash !== digest ||
    hash(fs.readFileSync(snapshot)) !== digest
  )
    throw new Error("launcher の source、実行体、記録または環境が一致しません");
  process.stdout.write(
    ["raw-launcher-verified-v1", ...ancestors, launcher.identity, record.identity, ""].join("\n"),
  );
} catch (error) {
  console.error(
    `raw-codex-launcher: ${(error as Error).message}。prepare-raw-codex-launcher を確認してください。`,
  );
  process.exitCode = 1;
}
