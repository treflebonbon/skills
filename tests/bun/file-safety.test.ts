import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  closeParent,
  descriptorPath,
  openParent,
  openRelative,
  readRegular,
  removeCreated,
  requirePrivateDirectory,
} from "../fixtures/bun-file-safety.ts";
import reference from "../fixtures/bun-file-safety-python.json";
import { native, nativeBuild } from "../fixtures/bun-file-safety-native.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "file-safety-"));
  directories.push(root);
  fs.mkdirSync(join(root, "nested"), { mode: 0o700 });
  fs.writeFileSync(join(root, "nested", "file"), "inside🙂\n", { mode: 0o600 });
  return root;
}

function swapAncestor(root: string, outside: string): void {
  const attacker = spawnSync("/bin/sh", [
    "-c",
    'mv "$1/nested" "$1/moved" && ln -s "$2" "$1/nested"',
    "swap",
    root,
    outside,
  ]);
  expect(attacker.status).toBe(0);
}

function descriptorCapability(): {
  status: "available" | "incompatible";
  reason?: string;
  lookupErrno?: string;
  fdAliasIdentity: boolean;
  fdAliasError?: string;
} {
  const root = fixture();
  const parentPath = join(root, "nested", "file");
  if (fs.readFileSync(parentPath, "utf8") !== "inside🙂\n")
    throw new Error("対照 fixture が不正です");
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const rootFd = fs.openSync(root, flags);
  const identity = fs.fstatSync(rootFd, { bigint: true });
  const childPath = descriptorPath({ fd: rootFd, leaf: "nested" });
  const alias = childPath.slice(0, -"/nested".length);
  let fdAliasIdentity = false;
  let fdAliasError: string | undefined;
  try {
    const duplicate = fs.openSync(alias, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      const observed = fs.fstatSync(duplicate, { bigint: true });
      fdAliasIdentity = observed.dev === identity.dev && observed.ino === identity.ino;
    } finally {
      fs.closeSync(duplicate);
    }
  } catch (error) {
    fdAliasError = error instanceof Error ? error.message : String(error);
  }
  try {
    try {
      const child = fs.openSync(childPath, flags);
      try {
        if (fs.readFileSync(descriptorPath({ fd: child, leaf: "file" }), "utf8") !== "inside🙂\n")
          throw new Error("FD path が元の bytes を返しません");
      } finally {
        fs.closeSync(child);
      }
      return { status: "available", fdAliasIdentity, fdAliasError };
    } catch (error) {
      if (
        process.platform !== "darwin" ||
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "ENOTDIR" && error.code !== "ENOENT")
      )
        throw error;
      // fixture の消失や FD の close と、FD namespace の lookup 不適合を区別する。
      const held = fs.fstatSync(rootFd, { bigint: true });
      const direct = fs.statSync(root, { bigint: true });
      const prefix = alias.slice(0, alias.lastIndexOf("/"));
      if (
        !held.isDirectory() ||
        held.dev !== identity.dev ||
        held.ino !== identity.ino ||
        direct.dev !== identity.dev ||
        direct.ino !== identity.ino ||
        !fs.statSync(prefix).isDirectory() ||
        fs.readFileSync(parentPath, "utf8") !== "inside🙂\n"
      )
        throw error;
      return {
        status: "incompatible",
        reason: error.message,
        lookupErrno: error.code,
        fdAliasIdentity,
        fdAliasError,
      };
    }
  } finally {
    fs.closeSync(rootFd);
  }
}

const capability = descriptorCapability();
test(`FD path 候補の機能判定を記録する: ${capability.status}`, () => {
  if (capability.status === "incompatible") {
    expect(capability.reason).toMatch(/ENOTDIR|ENOENT/);
    expect(capability.lookupErrno).toMatch(/^(ENOTDIR|ENOENT)$/);
  } else expect(capability.status).toBe("available");
});

afterAll(() => {
  const source = spawnSync("git", ["-c", "core.fsmonitor=false", "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  console.log(
    JSON.stringify({
      boundary: "file-safety",
      os: process.platform,
      kernel: release(),
      architecture: process.arch,
      bun: Bun.version,
      sourceRevision: source.status === 0 ? source.stdout.trim() : null,
      fdPathLookup: capability.status,
      reason: capability.reason,
      lookupErrno: capability.lookupErrno,
      fdAliasIdentity: capability.fdAliasIdentity,
      fdAliasError: capability.fdAliasError,
      method: "node-api",
      nativeBuild,
      fullContract: "see-test-results",
      adoption: "not-decided",
    }),
  );
});

describe("Node-API 候補の契約", () => {
  test("directory FD を基準に相対 path の元 bytes を読み、cwd を変更しない", () => {
    const root = fixture();
    const cwd = process.cwd();
    const parent = openParent(root, "nested/file");
    try {
      const leaf = openRelative(
        parent,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        expect(fs.readFileSync(leaf)).toEqual(Buffer.from("inside🙂\n"));
        expect(fs.fstatSync(leaf).isFile()).toBe(true);
      } finally {
        fs.closeSync(leaf);
      }
      expect(process.cwd()).toBe(cwd);
    } finally {
      closeParent(parent);
    }
  });

  test("相対 path の .. を directory FD で辿る前に拒否する", () => {
    const root = fixture();
    expect(() => closeParent(openParent(root, "nested/../nested/file"))).toThrow(
      "正規の相対 path が必要です",
    );
  });

  test("公開証跡で読める .git 内の合成ファイルを raw 入力では拒否する", () => {
    const root = fixture();
    fs.mkdirSync(join(root, ".git"));
    fs.writeFileSync(join(root, ".git", "config"), "metadata-fixture");
    const parent = openParent(root, ".git/config");
    try {
      expect(readRegular(parent).toString("utf8")).toBe("metadata-fixture");
      expect(() => closeParent(openParent(root, ".git/config", true))).toThrow(
        "raw 入力は Git metadata 外の相対 path が必要です",
      );
    } finally {
      closeParent(parent);
    }
  });

  for (const relative of [
    "",
    "/nested/file",
    "nested//file",
    "./nested/file",
    "nested/",
    "nested/\0file",
  ]) {
    test(`非正規の相対 path を拒否する: ${JSON.stringify(relative)}`, () => {
      expect(() => closeParent(openParent(fixture(), relative))).toThrow(
        "正規の相対 path が必要です",
      );
    });
  }

  test("検査後に祖先を symlink に差し替えた子 process を誤受理しない", () => {
    const root = fixture();
    const outside = fixture();
    fs.writeFileSync(join(outside, "file"), "outside");
    expect(fs.lstatSync(join(root, "nested")).isDirectory()).toBe(true);
    swapAncestor(root, outside);
    // 最終 component だけの O_NOFOLLOW は祖先の symlink を辿ってしまう。
    const unsafe = fs.openSync(
      join(root, "nested", "file"),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      expect(fs.readFileSync(unsafe, "utf8")).toBe("outside");
    } finally {
      fs.closeSync(unsafe);
    }
    expect(() => closeParent(openParent(root, "nested/file"))).toThrow(/ENOTDIR|ELOOP/);
  });

  test("開いた parent の名前を別 process が symlink に置換しても元 directory から読む", () => {
    const root = fixture();
    const outside = fixture();
    fs.writeFileSync(join(outside, "file"), "outside");
    const parent = openParent(root, "nested/file");
    try {
      swapAncestor(root, outside);
      const leaf = openRelative(
        parent,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        expect(fs.readFileSync(leaf, "utf8")).toBe("inside🙂\n");
      } finally {
        fs.closeSync(leaf);
      }
      expect(fs.readFileSync(join(outside, "file"), "utf8")).toBe("outside");
    } finally {
      closeParent(parent);
    }
  });

  test("trusted anchor より上の system alias を許容する", () => {
    const outer = fixture();
    fs.symlinkSync(join(outer, "nested"), join(outer, "alias"));
    fs.mkdirSync(join(outer, "nested", "anchor"), { mode: 0o700 });
    fs.writeFileSync(join(outer, "nested", "anchor", "file"), "inside");
    const parent = openParent(join(outer, "alias", "anchor"), "file");
    try {
      expect(readRegular(parent).toString("utf8")).toBe("inside");
    } finally {
      closeParent(parent);
    }
  });

  test("FIFO を空の通常ファイルとして誤受理せず拒否する", () => {
    const root = fixture();
    expect(spawnSync("mkfifo", [join(root, "pipe")]).status).toBe(0);
    const parent = openParent(root, "pipe");
    try {
      expect(() => readRegular(parent)).toThrow("通常ファイルが必要です");
    } finally {
      closeParent(parent);
    }
  });

  test("公開証跡の hard link は読めるが raw 入力の複数 link は拒否する", () => {
    const root = fixture();
    fs.linkSync(join(root, "nested", "file"), join(root, "alias"));
    const parent = openParent(root, "alias");
    try {
      expect(readRegular(parent).toString("utf8")).toBe("inside🙂\n");
      expect(() => readRegular(parent, true)).toThrow(
        "raw 入力は link 数1の通常ファイルが必要です",
      );
    } finally {
      closeParent(parent);
    }
  });

  test("raw 入力が metadata 検査後に別 process から変更されたら bytes を返さない", () => {
    const root = fixture();
    const parent = openParent(root, "nested/file");
    try {
      expect(readRegular(parent, true).toString("utf8")).toBe("inside🙂\n");
      expect(() =>
        readRegular(parent, true, () => {
          const attacker = spawnSync("/bin/sh", [
            "-c",
            'printf changed-content > "$1/nested/file"',
            "change",
            root,
          ]);
          expect(attacker.status).toBe(0);
        }),
      ).toThrow("raw 入力が読込中に変更されました");
    } finally {
      closeParent(parent);
    }
  });

  test("state directory の実 owner と mode を FD から検査し不一致を拒否する", () => {
    const root = fixture();
    const parent = openParent(root, "unused");
    try {
      const owner = process.getuid!();
      expect(() => requirePrivateDirectory(parent.fd, owner)).not.toThrow();
      expect(() => requirePrivateDirectory(parent.fd, owner + 1)).toThrow(
        "指定 owner の private directory が必要です",
      );
      fs.fchmodSync(parent.fd, 0o755);
      expect(() => requirePrivateDirectory(parent.fd, owner)).toThrow(
        "指定 owner の private directory が必要です",
      );
    } finally {
      closeParent(parent);
    }
  });

  for (const mode of [0o600, 0o644, 0o755]) {
    test(`parent の symlink 差し替え後も作成・write・fchmod・fsync を保持 FD 内で行う: ${mode.toString(8)}`, () => {
      const root = fixture();
      const outside = fixture();
      const parent = openParent(root, "nested/created");
      try {
        swapAncestor(root, outside);
        const fd = openRelative(
          parent,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          fs.writeFileSync(fd, "complete bytes");
          fs.fchmodSync(fd, mode);
          fs.fsyncSync(fd);
          expect(fs.fstatSync(fd).uid).toBe(process.getuid!());
          expect(fs.fstatSync(fd).mode & 0o777).toBe(mode);
        } finally {
          fs.closeSync(fd);
        }
        expect(fs.readFileSync(join(root, "moved", "created"), "utf8")).toBe("complete bytes");
        expect(fs.existsSync(join(outside, "created"))).toBe(false);
      } finally {
        closeParent(parent);
      }
    });
  }

  test("通常ファイル・dangling symlink・FIFO の既存宛先を排他的作成で上書きしない", () => {
    const root = fixture();
    fs.symlinkSync(join(root, "missing"), join(root, "link"));
    expect(spawnSync("mkfifo", [join(root, "pipe")]).status).toBe(0);
    for (const relative of ["nested/file", "link", "pipe"]) {
      const parent = openParent(root, relative);
      try {
        expect(() =>
          fs.closeSync(
            openRelative(
              parent,
              fs.constants.O_WRONLY |
                fs.constants.O_CREAT |
                fs.constants.O_EXCL |
                fs.constants.O_NOFOLLOW,
              0o600,
            ),
          ),
        ).toThrow("EEXIST");
      } finally {
        closeParent(parent);
      }
    }
    expect(fs.readFileSync(join(root, "nested", "file"), "utf8")).toBe("inside🙂\n");
    expect(fs.existsSync(join(root, "missing"))).toBe(false);
  });

  test("作成後に宛先 inode が他 writer に置換されたら rollback で削除しない", () => {
    const root = fixture();
    const parent = openParent(root, "nested/file");
    const path = descriptorPath(parent);
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const made = fs.fstatSync(fd, { bigint: true });
    try {
      fs.renameSync(join(root, "nested", "file"), join(root, "original"));
      fs.writeFileSync(join(root, "nested", "file"), "new writer");
      expect(removeCreated(parent, made)).toBe(false);
      expect(fs.readFileSync(path, "utf8")).toBe("new writer");
      const replacement = fs.lstatSync(path, { bigint: true });
      expect(removeCreated(parent, replacement)).toBe(true);
      expect(fs.existsSync(path)).toBe(false);
    } finally {
      fs.closeSync(fd);
      closeParent(parent);
    }
  });

  test("閉じた parent を再利用して無関係な FD を参照しない", () => {
    const root = fixture();
    const parent = openParent(root, "nested/file");
    closeParent(parent);
    const reused = fs.openSync(join(root, "nested", "file"), fs.constants.O_RDONLY);
    try {
      expect(() => openRelative(parent, fs.constants.O_RDONLY)).toThrow(
        "directory FD は閉じています",
      );
    } finally {
      fs.closeSync(reused);
    }
  });

  test("保持した parent 内に directory を作成し、再度 O_NOFOLLOW で開ける", () => {
    const root = fixture();
    const outside = fixture();
    const parent = openParent(root, "nested/created");
    try {
      swapAncestor(root, outside);
      native.mkdirat(parent.fd, parent.leaf, 0o700);
      const child = openRelative(
        parent,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      try {
        expect(fs.fstatSync(child).isDirectory()).toBe(true);
        expect(fs.fstatSync(child).mode & 0o777).toBe(0o700);
      } finally {
        fs.closeSync(child);
      }
      expect(fs.existsSync(join(root, "moved", "created"))).toBe(true);
      expect(fs.existsSync(join(outside, "created"))).toBe(false);
    } finally {
      closeParent(parent);
    }
  });

  test("保持した parent 内の一時ファイルを rename し削除しても外部に影響しない", () => {
    const root = fixture();
    const outside = fixture();
    fs.writeFileSync(join(outside, "file"), "outside");
    const parent = openParent(root, "nested/file");
    try {
      swapAncestor(root, outside);
      const fd = openRelative(
        parent,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
        "temporary",
      );
      try {
        fs.writeFileSync(fd, "new complete bytes");
        fs.fchmodSync(fd, 0o755);
      } finally {
        fs.closeSync(fd);
      }
      native.renameat(parent.fd, "temporary", parent.fd, parent.leaf);
      expect(fs.readFileSync(join(root, "moved", "file"), "utf8")).toBe("new complete bytes");
      expect(fs.statSync(join(root, "moved", "file")).mode & 0o777).toBe(0o755);
      native.unlinkat(parent.fd, parent.leaf);
      expect(fs.existsSync(join(root, "moved", "file"))).toBe(false);
      expect(fs.readFileSync(join(outside, "file"), "utf8")).toBe("outside");
    } finally {
      closeParent(parent);
    }
  });

  test("完成した checkpoint を hard link で排他的に公開し競合先を保持する", () => {
    const root = fixture();
    const parent = openParent(root, "snapshot");
    try {
      const fd = openRelative(
        parent,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
        "temporary",
      );
      try {
        fs.writeFileSync(fd, "complete snapshot");
        fs.fsyncSync(fd);
        native.linkat(parent.fd, "temporary", parent.fd, parent.leaf);
        expect(fs.lstatSync(join(root, "snapshot"), { bigint: true }).ino).toBe(
          fs.fstatSync(fd, { bigint: true }).ino,
        );
        expect(() => native.linkat(parent.fd, "temporary", parent.fd, parent.leaf)).toThrow(
          "EEXIST",
        );
      } finally {
        fs.closeSync(fd);
        native.unlinkat(parent.fd, "temporary");
      }
      expect(readRegular(parent).toString("utf8")).toBe("complete snapshot");
      expect(fs.statSync(join(root, "snapshot")).nlink).toBe(1);
    } finally {
      closeParent(parent);
    }
  });

  for (const scenario of reference.cases) {
    test(`旧 Python 版との受理・拒否比較: ${scenario.profile}/${scenario.kind}`, () => {
      const root = fixture();
      if (scenario.kind === "git-metadata") {
        fs.mkdirSync(join(root, ".git"));
        fs.writeFileSync(join(root, ".git", "config"), "metadata-fixture");
      }
      if (scenario.kind === "hardlink")
        fs.linkSync(join(root, "nested", "file"), join(root, "alias"));
      if (scenario.kind === "leaf-symlink") fs.symlinkSync("nested/file", join(root, "alias"));
      if (scenario.kind === "ancestor-symlink") fs.symlinkSync("nested", join(root, "alias"));
      if (scenario.kind === "fifo")
        expect(spawnSync("mkfifo", [join(root, "pipe")]).status).toBe(0);
      if (scenario.kind === "ancestor-after-validation") {
        const outside = fixture();
        fs.writeFileSync(join(outside, "file"), "outside");
        expect(fs.lstatSync(join(root, "nested")).isDirectory()).toBe(true);
        swapAncestor(root, outside);
      }
      let parent: ReturnType<typeof openParent> | undefined;
      let bytes: Buffer | undefined;
      let failure: Error | undefined;
      try {
        parent = openParent(root, scenario.relative, scenario.profile === "raw");
        bytes = readRegular(parent, scenario.profile === "raw", () => {
          if (scenario.kind === "change-after-stat") {
            expect(
              spawnSync("/bin/sh", [
                "-c",
                'printf changed-content > "$1/nested/file"',
                "change",
                root,
              ]).status,
            ).toBe(0);
          }
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failure = error;
      } finally {
        if (parent) closeParent(parent);
      }
      expect(!failure).toBe(scenario.expected.accepted);
      if (scenario.expected.accepted) {
        const expected = scenario.expected.bodyBase64;
        if (typeof expected !== "string")
          throw new Error("旧版 corpus の受理ケースに bytes がありません");
        expect(bytes!.toString("base64")).toBe(expected);
      } else {
        const messages: Record<string, RegExp> = {
          hardlink: /raw 入力は link 数1の通常ファイル/,
          "leaf-symlink": /ELOOP/,
          "ancestor-symlink": /ENOTDIR|ELOOP/,
          "ancestor-after-validation": /ENOTDIR|ELOOP/,
          fifo: /通常ファイルが必要/,
          directory: /通常ファイルが必要/,
          "parent-component": /正規の相対 path/,
          "git-metadata": /raw 入力は Git metadata 外の相対 path/,
          "change-after-stat": /raw 入力が読込中に変更/,
        };
        expect(failure!.message).toMatch(messages[scenario.kind]!);
      }
    });
  }
});
