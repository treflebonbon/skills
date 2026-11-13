import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getSystemErrorName } from "node:util";

export const source = new URL("./file-safety-native.c", import.meta.url);
export const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export function cacheDirectory(): string {
  if (
    !(process.platform === "linux" && ["x64", "arm64"].includes(process.arch)) &&
    !(process.platform === "darwin" && process.arch === "arm64")
  )
    throw new Error("native module の採用対象は Linux x64 / arm64 と macOS arm64 です");
  const base =
    process.env.TREFLEBONBON_FILE_SAFETY_DIR ??
    join(
      process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
      "treflebonbon-skills/file-safety",
    );
  if (!isAbsolute(base) || base.split("/").includes(".."))
    throw new Error("native cache は正規の絶対 path が必要です");
  return join(base, `${hash(fs.readFileSync(source))}-${process.platform}-${process.arch}`);
}

// load 前の bootstrap。共有書込みを許す祖先は system の sticky /tmp のみ。
export function privateDirectory(path: string, create = false): void {
  const canonical = path.startsWith("/tmp/") ? fs.realpathSync("/tmp") + path.slice(4) : path;
  let current = "/";
  for (const part of canonical.split("/").filter(Boolean)) {
    current = join(current, part);
    if (create) {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const stat = fs.lstatSync(current);
    const systemTemporary =
      current === fs.realpathSync("/tmp") && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (
      !stat.isDirectory() ||
      (stat.uid !== 0 && stat.uid !== process.getuid!()) ||
      ((stat.mode & 0o022) !== 0 && !systemTemporary)
    )
      throw new Error("native cache の祖先は symlink と他 owner の書込みを許可できません");
  }
  const stat = fs.lstatSync(path);
  if (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)
    throw new Error("native cache は実 owner の private directory が必要です");
}

export type Identity = { dev: bigint; ino: bigint };
type Addon = {
  openat(fd: number, name: Buffer, flags: number, mode: number): number;
  mkdirat(fd: number, name: Buffer, mode: number): number;
  renameat(fd: number, name: Buffer, otherFd: number, otherName: Buffer): number;
  linkat(fd: number, name: Buffer, otherFd: number, otherName: Buffer): number;
  unlinkat(fd: number, name: Buffer): number;
  fstatat(fd: number, name: Buffer): Identity | number;
};
let addon: Addon | undefined;
function load(): Addon {
  if (addon) return addon;
  const directory = cacheDirectory();
  try {
    privateDirectory(directory);
    const path = join(directory, "file-safety.node");
    const fd = fs.openSync(
      path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid!() ||
        (stat.mode & 0o022) !== 0 ||
        stat.nlink !== 1
      )
        throw new Error("native module は実 owner の保護された通常ファイルが必要です");
      const record = fs.openSync(
        join(directory, "build.json"),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      let metadata;
      try {
        const info = fs.fstatSync(record);
        if (
          !info.isFile() ||
          info.uid !== process.getuid!() ||
          (info.mode & 0o022) !== 0 ||
          info.nlink !== 1
        )
          throw new Error("native build 記録は実 owner の保護された通常ファイルが必要です");
        metadata = JSON.parse(fs.readFileSync(record, "utf8"));
      } finally {
        fs.closeSync(record);
      }
      if (
        metadata.sourceHash !== hash(fs.readFileSync(source)) ||
        metadata.platform !== process.platform ||
        metadata.arch !== process.arch ||
        metadata.binaryHash !== hash(fs.readFileSync(fd))
      )
        throw new Error("native module の source / binary hash または環境が一致しません");
      const module = { exports: {} };
      // 検査した file FD 自体を load し、path の差し替えを再解決しない。
      process.dlopen(
        module,
        `${process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd"}/${fd}`,
      );
      addon = module.exports as Addon;
      return addon;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    throw new Error(
      `native module を読めません。bin/prepare-file-safety を明示実行してください: ${(error as Error).message}`,
    );
  }
}
function checked(result: number, syscall: string): number {
  if (result < 0) {
    const code = getSystemErrorName(result);
    throw Object.assign(new Error(`${code}: ${syscall}`), { code, errno: result, syscall });
  }
  return result;
}
function bytes(name: string | Buffer): Buffer {
  if (typeof name !== "string") return name;
  if (!name.isWellFormed()) throw new Error("有効な Unicode または Buffer が必要です");
  return Buffer.from(name);
}
export const native = {
  openat: (fd: number, name: string | Buffer, flags: number, mode = 0o600): number =>
    checked(load().openat(fd, bytes(name), flags, mode), "openat"),
  mkdirat: (fd: number, name: string, mode = 0o700): void => {
    checked(load().mkdirat(fd, bytes(name), mode), "mkdirat");
  },
  linkat: (fd: number, name: string, otherFd: number, otherName: string): void => {
    checked(load().linkat(fd, bytes(name), otherFd, bytes(otherName)), "linkat");
  },
  unlinkat: (fd: number, name: string): void => {
    checked(load().unlinkat(fd, bytes(name)), "unlinkat");
  },
  fstatat: (fd: number, name: string): Identity => {
    const result = load().fstatat(fd, bytes(name));
    if (typeof result === "number") {
      checked(result, "fstatat");
      throw new Error("stat metadata がありません");
    }
    return result;
  },
};
export type Parent = { fd: number; leaf: string };
export function exclusiveFile(parent: Parent): () => void {
  let made: Identity;
  try {
    const fd = native.openat(
      parent.fd,
      parent.leaf,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    );
    try {
      made = fs.fstatSync(fd, { bigint: true });
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    fs.closeSync(parent.fd);
    throw error;
  }
  return () => {
    try {
      removeCreated(parent, made);
    } finally {
      fs.closeSync(parent.fd);
    }
  };
}
export function openParent(path: string, anchor = "/", create = false): Parent {
  if (
    !isAbsolute(path) ||
    !path.isWellFormed() ||
    path.includes("\0") ||
    path.split("/").includes("..")
  )
    throw new Error("正規の絶対 path が必要です");
  path = resolve(path);
  if (!path.startsWith(anchor === "/" ? "/" : anchor + "/"))
    throw new Error("path が anchor の外です");
  const parts = path.slice(anchor.length).split("/").filter(Boolean);
  const createAnchor = create && anchor !== "/";
  if (createAnchor) parts.unshift(basename(anchor));
  // 共有先自身も保持した親 FD から作る。system の /tmp alias はここで解決する。
  let fd = fs.openSync(
    createAnchor ? fs.realpathSync(dirname(anchor)) : anchor,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    for (const part of parts.slice(0, -1)) {
      if (create) {
        try {
          native.mkdirat(fd, part);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const next = native.openat(
        fd,
        part,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      fs.closeSync(fd);
      fd = next;
    }
    if (!parts.length) throw new Error("file の path が必要です");
    return { fd, leaf: parts.at(-1)! };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
export function readRegular(parent: Parent): Buffer {
  const fd = native.openat(
    parent.fd,
    parent.leaf,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("証跡は通常ファイルで指定してください");
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function removeCreated(parent: Parent, made: Identity): void {
  const current = native.fstatat(parent.fd, parent.leaf);
  if (current.dev === made.dev && current.ino === made.ino) native.unlinkat(parent.fd, parent.leaf);
}
