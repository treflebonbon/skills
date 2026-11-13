// CLI の filesystem 境界だけに合成の失敗を挿入する。native syscall は実物を使う。
import { mock } from "bun:test";
import * as actual from "node:fs";

const fs = { ...actual };
const [fault, first, second] = JSON.parse(process.env.PEER_FAULT!) as string[];
let writing: number | undefined;
let created = 0;
let reading = false;
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
    if (fd === writing && fault === "write") {
      fs.writeSync(fd as number, content.subarray(0, 3));
      throw new Error("injected write failure");
    }
    return (fs.writeFileSync as any)(fd, content, ...args);
  },
  closeSync(fd: number) {
    fs.closeSync(fd);
    if (fd === writing && fault === "close") {
      writing = undefined;
      throw new Error("injected close failure");
    }
  },
}));
