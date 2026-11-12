import { closeSync, constants, fstatSync, openSync, readFileSync, type BigIntStats } from "node:fs";
import { native } from "./bun-file-safety-native.ts";

export type Parent = { fd: number; leaf: string };

export function openParent(root: string, relative: string, rawInput = false): Parent {
  const parts = relative.split("/");
  if (
    !root.startsWith("/") ||
    parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))
  ) {
    throw new Error("正規の相対 path が必要です");
  }
  if (rawInput && parts.includes(".git")) {
    throw new Error("raw 入力は Git metadata 外の相対 path が必要です");
  }
  let fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of parts.slice(0, -1)) {
      const child = native.openat(
        fd,
        part,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      closeSync(fd);
      fd = child;
    }
    return { fd, leaf: parts.at(-1)! };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
export function openRelative(
  parent: Parent,
  flags: number,
  mode = 0o600,
  name = parent.leaf,
): number {
  if (parent.fd < 0) throw new Error("directory FD は閉じています");
  return native.openat(parent.fd, name, flags, mode);
}
export function descriptorPath(parent: Parent, name = parent.leaf): string {
  if (parent.fd < 0) throw new Error("directory FD は閉じています");
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error("正規の単一 component が必要です");
  }
  return `${process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd"}/${parent.fd}/${name}`;
}

export function requirePrivateDirectory(fd: number, owner: number): void {
  const stat = fstatSync(fd);
  if (!stat.isDirectory() || stat.uid !== owner || (stat.mode & 0o077) !== 0) {
    throw new Error("state directory は指定 owner の private directory が必要です");
  }
}

export function removeCreated(parent: Parent, made: Pick<BigIntStats, "dev" | "ino">): boolean {
  if (parent.fd < 0) throw new Error("directory FD は閉じています");
  const current = native.fstatat(parent.fd, parent.leaf);
  if (current.dev !== made.dev || current.ino !== made.ino) return false;
  native.unlinkat(parent.fd, parent.leaf);
  return true;
}
export function closeParent(parent: Parent): void {
  closeSync(parent.fd);
  parent.fd = -1;
}

export function readRegular(parent: Parent, singleLink = false, pause = () => {}): Buffer {
  const fd = openRelative(parent, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("通常ファイルが必要です");
    if (singleLink && before.nlink !== 1n)
      throw new Error("raw 入力は link 数1の通常ファイルが必要です");
    // 合成の競合を決定的に挿入する実証用 barrier。OS 操作は mock しない。
    pause();
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (
      singleLink &&
      (before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs)
    ) {
      throw new Error("raw 入力が読込中に変更されました");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
