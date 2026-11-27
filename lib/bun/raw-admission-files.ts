import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
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

export function openPublicInputParent(root: string, name: string, create = false): Parent<Buffer> {
  const parts = name.split("/");
  if (
    name.includes("\0") ||
    parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  )
    throw new Error("input must be a relative file outside Git metadata");
  const components = parts.map(pathBytes);
  let directory = openParent(join(root, ".public-root")).fd;
  try {
    for (const part of components.slice(0, -1)) {
      if (create) {
        try {
          native.mkdirat(directory, part, 0o755);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const next = native.openat(directory, part, directoryFlags);
      closeSync(directory);
      directory = next;
    }
    return { fd: directory, leaf: components.at(-1)! };
  } catch (error) {
    closeSync(directory);
    throw error;
  }
}

export function readPublicInputAt(
  { fd, leaf }: Parent<string | Buffer>,
  validate?: (stat: BigIntStats) => void,
) {
  const descriptor = native.openat(
    fd,
    leaf,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n)
      throw new Error("input must be a regular file with one link");
    validate?.(before);
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
    return { bytes, fingerprint, identity: { dev: before.dev, ino: before.ino } };
  } finally {
    closeSync(descriptor);
  }
}

export function readPublicInput(root: string, name: string) {
  const parent = openPublicInputParent(root, name);
  try {
    return readPublicInputAt(parent);
  } finally {
    closeSync(parent.fd);
  }
}

export function openInputPolicy(path: string, { create = true } = {}): Parent {
  let parent: Parent;
  try {
    parent = openParent(path, "/", create);
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

export function publishInputPolicy(parent: Parent, text: string, beforePublish?: () => void): void {
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
      beforePublish?.();
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
