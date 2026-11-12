import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { native, nativeBuild } from "../fixtures/bun-file-safety-native.ts";

test("Bun で開いた directory FD を Node-API に渡し、戻った FD を Bun で読んで閉じる", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "native-file-safety-"));
  fs.writeFileSync(join(root, "file"), "native🙂\n");
  const parent = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    const fd = native.openat(parent, "file", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, 0);
    try {
      expect(fs.readFileSync(fd, "utf8")).toBe("native🙂\n");
      expect(fs.fstatSync(fd).isFile()).toBe(true);
    } finally {
      fs.closeSync(fd);
    }
    expect(fs.fstatSync(parent).isDirectory()).toBe(true);
  } finally {
    fs.closeSync(parent);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fstatat は読取り権限のないファイルを開かず device / inode を BigInt で返す", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "native-file-safety-"));
  const path = join(root, "private");
  fs.writeFileSync(path, "private bytes", { mode: 0o000 });
  const parent = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    if (process.getuid!() !== 0)
      expect(() => fs.closeSync(fs.openSync(path, fs.constants.O_RDONLY))).toThrow("EACCES");
    const expected = fs.lstatSync(path, { bigint: true });
    const observed = native.fstatat(parent, "private");
    expect(observed).toEqual({ dev: expected.dev, ino: expected.ino });
    expect(typeof observed.dev).toBe("bigint");
    expect(typeof observed.ino).toBe("bigint");
    expect(() => native.fstatat(parent, "missing")).toThrow("ENOENT: fstatat");
  } finally {
    fs.closeSync(parent);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Node-API 境界で component と整数を検査し、閉じた FD は EBADF として返す", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "native-file-safety-"));
  const parent = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    const operations = [
      (name: string) => fs.closeSync(native.openat(parent, name, fs.constants.O_RDONLY)),
      (name: string) => native.mkdirat(parent, name, 0o700),
      (name: string) => native.renameat(parent, name, parent, "other"),
      (name: string) => native.linkat(parent, name, parent, "other"),
      (name: string) => native.unlinkat(parent, name),
      (name: string) => native.fstatat(parent, name),
    ];
    for (const operation of operations) {
      for (const name of [
        "",
        ".",
        "..",
        "../outside",
        "/outside",
        "file\0suffix",
        "a/b",
        "x".repeat(4096),
      ])
        expect(() => operation(name)).toThrow("正規の単一 component が必要です");
    }
    for (const fd of [-1, 0.5, NaN, Infinity, 2 ** 32])
      expect(() => native.openat(fd, "file", fs.constants.O_RDONLY)).toThrow(
        "非負の int が必要です",
      );
    expect(() => native.openat(parent, "file", NaN)).toThrow("非負の int が必要です");
    expect(() => native.mkdirat(parent, "file", 0o10000)).toThrow("mode は07777以下が必要です");
    native.mkdirat(parent, "有効🙂", 0o700);
    expect(fs.readdirSync(root)).toEqual(["有効🙂"]);
  } finally {
    fs.closeSync(parent);
    fs.rmSync(root, { recursive: true, force: true });
  }
  expect(() => native.mkdirat(parent, "closed", 0o700)).toThrow("EBADF: mkdirat");
  expect(() => native.fstatat(parent, "closed")).toThrow("EBADF: fstatat");
});

test("Node-API の mkdir・rename・link・unlink が保持 FD の元 directory に作用する", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "native-file-safety-"));
  fs.mkdirSync(join(root, "held"));
  fs.mkdirSync(join(root, "outside"));
  const parent = fs.openSync(join(root, "held"), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.renameSync(join(root, "held"), join(root, "moved"));
    fs.symlinkSync(join(root, "outside"), join(root, "held"));
    native.mkdirat(parent, "created", 0o700);
    const fd = native.openat(
      parent,
      "temporary",
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.closeSync(fd);
    native.renameat(parent, "temporary", parent, "renamed");
    native.linkat(parent, "renamed", parent, "snapshot");
    expect(() => native.linkat(parent, "renamed", parent, "snapshot")).toThrow("EEXIST");
    native.unlinkat(parent, "renamed");
    expect(fs.readdirSync(join(root, "moved")).sort()).toEqual(["created", "snapshot"]);
    expect(fs.statSync(join(root, "moved", "created")).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(join(root, "outside"))).toEqual([]);
    expect(fs.existsSync(nativeBuild.output)).toBe(false);
  } finally {
    fs.closeSync(parent);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("component の bytes を保持し、不正な Unicode を別名へ変換して開かない", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "native-file-safety-"));
  const parent = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  const name = process.platform === "linux" ? Buffer.from([0xff]) : Buffer.from("名前🙂");
  try {
    fs.writeFileSync(Buffer.concat([Buffer.from(`${root}/`), name]), "original bytes");
    fs.writeFileSync(join(root, "�"), "replacement path");
    const renamed = Buffer.concat([name, Buffer.from("-renamed")]);
    native.mkdirat(parent, Buffer.from("directory🙂"), 0o700);
    native.renameat(parent, name, parent, renamed);
    native.linkat(parent, renamed, parent, name);
    native.unlinkat(parent, renamed);
    const expected = fs.lstatSync(Buffer.concat([Buffer.from(`${root}/`), name]), { bigint: true });
    expect(native.fstatat(parent, name)).toEqual({ dev: expected.dev, ino: expected.ino });
    const fd = native.openat(parent, name, fs.constants.O_RDONLY);
    try {
      expect(fs.readFileSync(fd, "utf8")).toBe("original bytes");
    } finally {
      fs.closeSync(fd);
    }
    expect(() => native.openat(parent, "\udcff", fs.constants.O_RDONLY)).toThrow(
      "有効な Unicode または Buffer が必要です",
    );
    expect(() => native.openat(parent, Buffer.from("file\0suffix"), fs.constants.O_RDONLY)).toThrow(
      "正規の単一 component が必要です",
    );
    expect(() => native.unlinkat(parent, Buffer.from("../outside"))).toThrow(
      "正規の単一 component が必要です",
    );
    expect(fs.readFileSync(join(root, "�"), "utf8")).toBe("replacement path");
  } finally {
    fs.closeSync(parent);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
