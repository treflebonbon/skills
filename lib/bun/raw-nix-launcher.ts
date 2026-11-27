import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { coordinationJSON, object } from "./coordination-json.ts";

export const nixStore = "/nix/store";
const outputPath = /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[a-zA-Z0-9+._?=-]+$/;
const digestPattern = /^[0-9a-f]{64}$/;
const binary = "bin/raw-codex-launcher";
const manifestPath = "share/raw-codex-launcher/manifest.json";

function storeFile(root: string, relative: string, owner: number, mode: number) {
  if (realpathSync(root) !== root)
    throw new Error(`raw launcher must use its real Nix store path: ${root}`);
  let directory = root;
  for (const part of ["", ...relative.split("/").slice(0, -1)]) {
    directory = join(directory, part);
    const state = lstatSync(directory);
    if (!state.isDirectory() || state.uid !== owner || (state.mode & 0o7777) !== 0o555)
      throw new Error(`invalid Nix store directory owner or mode: ${directory}`);
  }
  const path = join(root, relative);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const state = fstatSync(fd);
    if (!state.isFile() || state.uid !== owner || (state.mode & 0o7777) !== mode)
      throw new Error(`invalid Nix store file owner or mode: ${path}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function verifyBinary(root: string, owner: number, expected: string) {
  const actual = createHash("sha256")
    .update(storeFile(root, binary, owner, 0o555))
    .digest("hex");
  if (actual !== expected)
    throw new Error("raw launcher executable digest does not match the selected package");
}

export function selectRawLauncher(packagePath: string, sourceSha256: string) {
  if (!outputPath.test(packagePath) || packagePath.includes("\n"))
    throw new Error("select a canonical Nix store output for the raw launcher");
  const owner = statSync(nixStore).uid;
  const manifest = coordinationJSON(storeFile(packagePath, manifestPath, owner, 0o444));
  if (
    !object(manifest) ||
    manifest.version !== "1" ||
    manifest.sourceSha256 !== sourceSha256 ||
    sourceSha256.length !== 64 ||
    !digestPattern.test(sourceSha256)
  )
    throw new Error("raw launcher source or version does not match trusted configuration");
  const digest = manifest.sha256;
  if (typeof digest !== "string" || digest.length !== 64 || !digestPattern.test(digest))
    throw new Error("invalid raw launcher executable digest");
  verifyBinary(packagePath, owner, digest);
  return {
    package: packagePath,
    executable: join(packagePath, binary),
    verifyCopy(store: string, closure: readonly string[]) {
      if (!closure.includes(packagePath))
        throw new Error("raw launcher package is missing from the selected closure");
      verifyBinary(join(store, basename(packagePath)), process.geteuid!(), digest);
    },
  };
}

export type RawNixLauncher = ReturnType<typeof selectRawLauncher>;
