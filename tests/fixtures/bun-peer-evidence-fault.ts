// CLI の filesystem 境界だけに合成の失敗を挿入する。native syscall は実物を使う。
import { mock } from "bun:test";
import * as actual from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

const fs = { ...actual };
const [fault, first, second] = JSON.parse(process.env.PEER_FAULT!) as string[];
let writing: number | undefined;
let created = 0;
let reading = false;
let injected = false;
const pause = (path: string) => {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(path)) {
    if (Date.now() > deadline) throw new Error("fixture の同期が期限切れです");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
mock.module("node:fs", () => ({
  ...fs,
  lstatSync(path: any, ...args: any[]) {
    const result = (fs.lstatSync as any)(path, ...args);
    if (fault === "ancestor-read" && path === first) reading = true;
    return result;
  },
  openSync(path: any, ...args: any[]) {
    if (reading && path === "/tmp/codex") {
      reading = false;
      fs.renameSync(second!, second! + ".moved");
      fs.symlinkSync(second! + ".outside", second!);
    }
    return (fs.openSync as any)(path, ...args);
  },
  readFileSync(path: any, ...args: any[]) {
    const raw = (fs.readFileSync as any)(path, ...args);
    if (fault === "record-read" && path === first) {
      fs.writeFileSync(first!, raw.toString().replace("既存 bytes を維持", "changed intent"));
      fs.writeFileSync(
        second!,
        fs.readFileSync(second!, "utf8").replace("既存 bytes を維持", "changed intent"),
      );
    }
    return raw;
  },
  fchmodSync(fd: number, mode: number) {
    writing = fd;
    created++;
    if (fault === "restore-b" && created === 1) {
      fs.writeFileSync(first! + ".b-partial", "ready");
      pause(first! + ".b-release");
    }
    if (fault === "move-extra" && !injected && fs.existsSync(first!)) {
      const current = fs.fstatSync(fd),
        target = fs.statSync(first!);
      if (current.ino === target.ino && current.dev === target.dev) {
        injected = true;
        fs.renameSync(dirname(first!), dirname(first!) + ".moved");
        fs.mkdirSync(dirname(first!));
        fs.writeFileSync(first! + ".injected", "moved");
      }
    }
    if (fault === "chmod") throw new Error("injected chmod failure");
    if (
      created === 1 &&
      ["concurrent", "replaced", "symlink", "directory", "unreadable"].includes(fault!)
    ) {
      if (fault === "concurrent") fs.writeFileSync(second!, "newer evidence", { flag: "wx" });
      else if (fault === "replaced") {
        fs.writeFileSync(first! + ".other", "newer evidence");
        fs.renameSync(first! + ".other", first!);
      } else if (fault === "symlink") {
        fs.renameSync(first!, first! + ".original");
        fs.symlinkSync(first! + ".original", first!);
      } else if (fault === "directory") {
        fs.renameSync(first!, first! + ".original");
        fs.mkdirSync(first!);
      } else fs.fchmodSync(fd, 0);
    }
    if (
      created === 2 &&
      ["second", "replaced", "symlink", "directory", "unreadable"].includes(fault!)
    )
      throw new Error("injected second-file failure");
    if (fault !== "unreadable") fs.fchmodSync(fd, mode);
  },
  writeFileSync(fd: number | string, content: Uint8Array, ...args: any[]) {
    if (fault === "pin-write" && typeof fd === "number") {
      fs.writeSync(fd, content.subarray(0, 3));
      fs.writeFileSync(
        first! + ".injected",
        JSON.stringify({ finalVisible: fs.existsSync(first!) }),
      );
      throw new Error("injected pin write failure");
    }
    if (fd === writing && fault === "write") {
      fs.writeSync(fd as number, content.subarray(0, 3));
      throw new Error("injected write failure");
    }
    const result = (fs.writeFileSync as any)(fd, content, ...args);
    if (fd === writing && fault === "restore-a" && created === 1) {
      fs.writeFileSync(first! + ".a-ready", "ready");
      pause(first! + ".a-release");
    }
    return result;
  },
  linkSync(source: any, target: any) {
    if (
      ["build-publish", "build-replaced"].includes(fault!) &&
      String(target).endsWith("/file-safety.node")
    ) {
      if (fault === "build-replaced") {
        const metadata = dirname(target) + "/build.json";
        fs.writeFileSync(metadata + ".other", "another writer");
        fs.renameSync(metadata + ".other", metadata);
      }
      fs.writeFileSync(first! + ".injected", "binary publication");
      throw Object.assign(new Error("injected binary publication ENOSPC"), { code: "ENOSPC" });
    }
    return fs.linkSync(source, target);
  },
  closeSync(fd: number) {
    fs.closeSync(fd);
    if (fault === "final-source" && !injected && fd === writing && created === Number(second)) {
      injected = true;
      const changed = spawnSync("git", ["update-ref", "HEAD", first!], { encoding: "utf8" });
      if (changed.status !== 0) throw new Error("fixture の HEAD 更新に失敗しました");
      fs.writeFileSync(first! + ".injected", "source changed");
    }
    if (fd === writing && fault === "close") {
      writing = undefined;
      throw new Error("injected close failure");
    }
  },
}));
