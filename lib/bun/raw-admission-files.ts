import { closeSync, constants, fchmodSync, fstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hash, native, openParent, removeCreated, type Parent } from "./file-safety.ts";

export type InputFingerprint = { sha256: string; executable: boolean };

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function pathBytes(component: string): Buffer {
  if (component.isWellFormed()) return Buffer.from(component);
  // Git and Python represent non-UTF-8 path bytes with surrogateescape.
  const parts: Buffer[] = [];
  let offset = 0;
  for (const match of component.matchAll(/[\udc80-\udcff]/gu)) {
    const text = component.slice(offset, match.index);
    if (!text.isWellFormed()) throw new Error("invalid public input path bytes");
    parts.push(Buffer.from(text), Buffer.from([match[0].charCodeAt(0) - 0xdc00]));
    offset = match.index + 1;
  }
  const tail = component.slice(offset);
  if (!tail.isWellFormed()) throw new Error("invalid public input path bytes");
  parts.push(Buffer.from(tail));
  return Buffer.concat(parts);
}

export function readPublicInput(root: string, name: string) {
  const parts = name.split("/");
  if (
    name.includes("\0") ||
    parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  )
    throw new Error("input must be a relative file outside Git metadata");
  let directory = openParent(join(root, ".admission-root")).fd;
  let descriptor: number;
  try {
    for (const part of parts.slice(0, -1)) {
      const next = native.openat(directory, pathBytes(part), directoryFlags);
      closeSync(directory);
      directory = next;
    }
    descriptor = native.openat(
      directory,
      pathBytes(parts.at(-1)!),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } finally {
    closeSync(directory);
  }

  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n)
      throw new Error("input must be a regular file with one link");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("input changed while being read");
    const fingerprint: InputFingerprint = {
      sha256: hash(bytes),
      executable: (before.mode & 0o111n) !== 0n,
    };
    return { bytes, fingerprint };
  } finally {
    closeSync(descriptor);
  }
}

export function openInputPolicy(path: string): Parent {
  let parent: Parent;
  try {
    parent = openParent(path, "/", true);
  } catch (error) {
    if (["ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw new Error("input state must be private to the current user");
    throw error;
  }
  try {
    const directory = fstatSync(parent.fd);
    if (directory.uid !== process.getuid!() || (directory.mode & 0o077) !== 0)
      throw new Error("input state must be private to the current user");
    return parent;
  } catch (error) {
    closeSync(parent.fd);
    throw error;
  }
}

export function publishInputPolicy(parent: Parent, text: string): void {
  const leaf = parent.leaf + "." + randomUUID();
  const descriptor = native.openat(
    parent.fd,
    leaf,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
  );
  try {
    const identity = fstatSync(descriptor, { bigint: true });
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, text);
      native.renameat(parent.fd, leaf, parent.fd, parent.leaf);
    } catch (error) {
      try {
        removeCreated({ fd: parent.fd, leaf }, identity);
      } catch {
        // Preserve the original publication error.
      }
      throw error;
    }
  } finally {
    closeSync(descriptor);
  }
}
