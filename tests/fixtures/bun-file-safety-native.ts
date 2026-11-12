import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getSystemErrorName } from "node:util";
import { fileURLToPath } from "node:url";

const node = spawnSync(
  "node",
  ["-p", "JSON.stringify({executable:process.execPath,version:process.version})"],
  { encoding: "utf8" },
);
if (node.status !== 0) throw new Error("Node-API header の検出には導入済みの Node.js が必要です");
const installation: { executable: string; version: string } = JSON.parse(node.stdout);
const headerDirectory = join(dirname(fs.realpathSync(installation.executable)), "../include/node");
if (!fs.existsSync(join(headerDirectory, "node_api.h")))
  throw new Error(`導入済み Node.js の Node-API header が必要です: ${headerDirectory}`);
const source = new URL("./bun-file-safety-native.c", import.meta.url);
const directory = fs.mkdtempSync(join(tmpdir(), "bun-file-safety-native-"));
const output = join(directory, "file-safety.node");
const compileArguments = [
  "-std=c11",
  "-D_POSIX_C_SOURCE=200809L",
  "-DNAPI_VERSION=6",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  ...(process.platform === "darwin"
    ? ["-bundle", "-undefined", "dynamic_lookup"]
    : ["-shared", "-fPIC"]),
  "-I",
  headerDirectory,
  fileURLToPath(source),
  "-o",
  output,
];
const hash = (path: string | URL) =>
  createHash("sha256").update(fs.readFileSync(path)).digest("hex");
type FileIdentity = { dev: bigint; ino: bigint };
type Addon = {
  openat(fd: number, name: Buffer, flags: number, mode: number): number;
  mkdirat(fd: number, name: Buffer, mode: number): number;
  renameat(fd: number, name: Buffer, otherFd: number, otherName: Buffer): number;
  linkat(fd: number, name: Buffer, otherFd: number, otherName: Buffer): number;
  unlinkat(fd: number, name: Buffer): number;
  fstatat(fd: number, name: Buffer): FileIdentity | number;
};
let addon: Addon;
export let nativeBuild: {
  node: string;
  compiler: string;
  headerDirectory: string;
  arguments: string[];
  output: string;
  sourceHash: string;
  binaryHash: string;
};
try {
  const build = spawnSync("cc", compileArguments, { encoding: "utf8", timeout: 30_000 });
  if (build.error || build.status !== 0)
    throw new Error(
      `Node-API fixture のビルドに失敗しました: ${build.error?.message ?? build.stderr}`,
    );
  const compiler = spawnSync("cc", ["--version"], { encoding: "utf8" });
  if (compiler.status !== 0) throw new Error("C compiler の版を記録できません");
  nativeBuild = {
    node: installation.version,
    compiler: compiler.stdout.split("\n")[0]!,
    headerDirectory,
    arguments: compileArguments,
    output,
    sourceHash: hash(source),
    binaryHash: hash(output),
  };
  addon = require(output) as Addon;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

function syscallError(result: number, syscall: string): never {
  const code = getSystemErrorName(result);
  throw Object.assign(new Error(`${code}: ${syscall}`), { code, errno: result, syscall });
}
function checked(result: number, syscall: string): number {
  if (result < 0) syscallError(result, syscall);
  return result;
}
type Component = string | Buffer;
function componentBytes(name: Component): Buffer {
  if (typeof name !== "string") return name;
  if (!name.isWellFormed()) throw new Error("有効な Unicode または Buffer が必要です");
  return Buffer.from(name);
}
export const native = {
  openat: (fd: number, name: Component, flags: number, mode = 0o600): number =>
    checked(addon.openat(fd, componentBytes(name), flags, mode), "openat"),
  mkdirat: (fd: number, name: Component, mode: number): void => {
    checked(addon.mkdirat(fd, componentBytes(name), mode), "mkdirat");
  },
  renameat: (fd: number, name: Component, otherFd: number, otherName: Component): void => {
    checked(
      addon.renameat(fd, componentBytes(name), otherFd, componentBytes(otherName)),
      "renameat",
    );
  },
  linkat: (fd: number, name: Component, otherFd: number, otherName: Component): void => {
    checked(addon.linkat(fd, componentBytes(name), otherFd, componentBytes(otherName)), "linkat");
  },
  unlinkat: (fd: number, name: Component): void => {
    checked(addon.unlinkat(fd, componentBytes(name)), "unlinkat");
  },
  fstatat: (fd: number, name: Component): FileIdentity => {
    const result = addon.fstatat(fd, componentBytes(name));
    if (typeof result === "number") syscallError(result, "fstatat");
    return result;
  },
};
