import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { coordinationJSON, strip } from "./coordination-json.ts";
import { decodeSurrogateEscape } from "./devshell-environment.ts";
import { native, openParent, removeCreated, type Parent } from "./file-safety.ts";
import type { Repository } from "./git-context.ts";
import { isTable, within } from "./raw-admission-config.ts";
import {
  openInputPolicy,
  openPublicInputParent,
  publishInputPolicy,
  readPublicInputAt,
  type InputFingerprint,
} from "./raw-admission-files.ts";
import { equalStrictJSON, strictJSON } from "./strict-json.ts";
import { parse } from "./vendor/smol-toml/parse.js";

const createFile = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const hostFileChanged = "host input changed; result is retained for recovery";
const hostIndexChanged = "host index changed; result is retained for recovery";
const hostBranchChanged = "host branch changed; result is retained for recovery";
const policyChanged = "input approval changed; result is retained for recovery";
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function gitArgs(root: string, ...args: string[]): string[] {
  return [
    "git",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    root,
    ...args,
  ];
}

function gitEnv() {
  return {
    PATH: process.env.PATH,
    HOME: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

function git(root: string, ...args: string[]): Buffer {
  const result = Bun.spawnSync(gitArgs(root, ...args), { env: gitEnv(), stderr: "ignore" });
  if (result.exitCode !== 0)
    throw new Error(`Git ${args[0]} failed; result is retained for recovery`);
  return result.stdout;
}

function gitText(root: string, ...args: string[]): string {
  return strip(utf8.decode(git(root, ...args)));
}

async function publishRef(
  root: string,
  branch: string,
  before: string,
  head: string,
  publish: () => void,
): Promise<void> {
  const child = Bun.spawn(gitArgs(root, "update-ref", "--stdin"), {
    env: gitEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = createInterface({ input: Readable.from(child.stdout) });
  const lines = output[Symbol.asyncIterator]();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    child.stdin.write(`start\nupdate ${branch} ${head} ${before}\nprepare\n`);
    await child.stdin.flush();
    if ((await lines.next()).value !== "start: ok" || (await lines.next()).value !== "prepare: ok")
      throw new Error("host ref changed; result is retained for recovery");
    publish();
    timeout.refresh();
    child.stdin.write("commit\n");
    await child.stdin.flush();
    if ((await lines.next()).value !== "commit: ok")
      throw new Error("ref update failed; staged result is retained for recovery");
  } finally {
    output.close();
    try {
      timeout.refresh();
      try {
        child.stdin.end();
      } finally {
        await child.exited;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  if (child.exitCode !== 0)
    throw new Error("ref update failed; staged result is retained for recovery");
}

function checkFileOwnerAndMode(stat: BigIntStats): void {
  if (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o7022n) !== 0n)
    throw new Error(
      "result and host files must be owned by the current user and protected from other writers",
    );
}

function privatePolicy(stat: BigIntStats): void {
  checkFileOwnerAndMode(stat);
  if ((stat.mode & 0o177n) !== 0n)
    throw new Error("input approval must be private to the current user");
}

function readResultFile(root: string, name: string) {
  const parent = openPublicInputParent(root, name);
  try {
    return readPublicInputAt(parent, checkFileOwnerAndMode);
  } finally {
    closeSync(parent.fd);
  }
}

function namedIdentity(parent: Parent<string | Buffer>) {
  try {
    return native.fstatat(parent.fd, parent.leaf);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

function checkHostAt(parent: Parent<Buffer>, expected: InputFingerprint | undefined) {
  if (!expected) {
    if (namedIdentity(parent)) throw new Error("result would replace an unapproved host file");
    return undefined;
  }
  const input = readPublicInputAt(parent, checkFileOwnerAndMode);
  if (!equalStrictJSON(input.fingerprint, expected)) throw new Error(hostFileChanged);
  return input.identity;
}

function checkHostFile(root: string, name: string, expected: InputFingerprint | undefined): void {
  try {
    const parent = openPublicInputParent(root, name);
    try {
      const identity = checkHostAt(parent, expected);
      if (identity && !equalStrictJSON(identity, namedIdentity(parent)))
        throw new Error(hostFileChanged);
    } finally {
      closeSync(parent.fd);
    }
  } catch (error) {
    if (!missing(error)) throw error;
    if (expected) throw new Error(hostFileChanged);
  }
}

function installResultFile(
  root: string,
  name: string,
  contents: ReturnType<typeof readResultFile> | undefined,
  expected: InputFingerprint | undefined,
): void {
  const parent = openPublicInputParent(root, name, !expected);
  const { fd, leaf } = parent;
  function recheck() {
    const identity = checkHostAt(parent, expected);
    const current = openPublicInputParent(root, name);
    try {
      const opened = fstatSync(fd, { bigint: true });
      const named = fstatSync(current.fd, { bigint: true });
      if (
        opened.dev !== named.dev ||
        opened.ino !== named.ino ||
        !equalStrictJSON(identity, namedIdentity(current))
      )
        throw new Error(hostFileChanged);
    } finally {
      closeSync(current.fd);
    }
  }
  try {
    if (!contents) {
      recheck();
      native.unlinkat(fd, leaf);
      return;
    }
    const temporary = { fd, leaf: ".isolation-" + randomUUID() };
    const descriptor = native.openat(fd, temporary.leaf, createFile);
    try {
      const created = fstatSync(descriptor, { bigint: true });
      try {
        writeFileSync(descriptor, contents.bytes);
        fchmodSync(descriptor, contents.fingerprint.executable ? 0o755 : 0o644);
        recheck();
        if (!equalStrictJSON({ dev: created.dev, ino: created.ino }, namedIdentity(temporary)))
          throw new Error("temporary result file changed");
        if (expected) native.renameat(fd, temporary.leaf, fd, leaf);
        else native.linkat(fd, temporary.leaf, fd, leaf);
      } finally {
        removeCreated(temporary, created);
      }
    } finally {
      closeSync(descriptor);
    }
  } finally {
    closeSync(fd);
  }
}

function treeFiles(directory: string, revision: string): Map<string, string> {
  const entries = decodeSurrogateEscape(git(directory, "ls-tree", "-rz", revision)).split("\0");
  return new Map(
    entries.filter(Boolean).map((entry) => {
      const tab = entry.indexOf("\t");
      return [entry.slice(tab + 1), entry.slice(0, tab)];
    }),
  );
}

function fingerprintEntries(value: unknown): Map<string, InputFingerprint> {
  if (!isTable(value)) throw new Error("invalid input approval files");
  const files = new Map<string, InputFingerprint>();
  for (const [name, entry] of Object.entries(value)) {
    if (
      !isTable(entry) ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      typeof entry.executable !== "boolean" ||
      Object.keys(entry).length !== 2
    )
      throw new Error("invalid input approval fingerprint");
    files.set(name, { sha256: entry.sha256, executable: entry.executable });
  }
  return files;
}

function deniedFiles(runtime: unknown) {
  if (runtime === undefined) return {};
  if (!isTable(runtime) || typeof runtime.requirements !== "string")
    throw new Error("invalid saved permission requirements");
  const parsed = parse(runtime.requirements, { integersAsBigInt: true, useLegacyDate: false });
  const profile = isTable(parsed.permissions) ? parsed.permissions["dotfiles-secure"] : undefined;
  if (!isTable(profile) || !isTable(profile.filesystem))
    throw new Error("invalid saved permission requirements");
  const workspace = profile.filesystem[":workspace_roots"];
  if (workspace !== undefined && !isTable(workspace))
    throw new Error("invalid saved workspace permissions");
  return workspace ?? {};
}

export async function returnRawResult(repo: Repository, session: string): Promise<string> {
  if (!isAbsolute(session) || normalize(session) !== session)
    throw new Error("session requires an absolute normalized path");
  const sessionFile = openParent(join(session, "session.json"));
  let record: unknown;
  try {
    const directory = fstatSync(sessionFile.fd);
    if (directory.uid !== process.getuid!() || (directory.mode & 0o077) !== 0)
      throw new Error("session must be private to the current user");
    record = coordinationJSON(readPublicInputAt(sessionFile, checkFileOwnerAndMode).bytes);
  } finally {
    closeSync(sessionFile.fd);
  }
  if (
    !isTable(record) ||
    record.version !== 1 ||
    repo.gitDir === repo.commonDir ||
    record.root !== repo.root ||
    record.git_dir !== repo.gitDir ||
    record.common_dir !== repo.commonDir ||
    !equalStrictJSON(record.repository, repo.identity())
  )
    throw new Error("session belongs to another worktree or repository");
  repo.checkUnchanged(record.repository);
  const { branch, git_head: before, policy, index_tree: beforeIndex } = record;
  if (
    typeof branch !== "string" ||
    typeof before !== "string" ||
    gitText(repo.root, "rev-parse", "HEAD") !== before ||
    gitText(repo.root, "symbolic-ref", "HEAD") !== branch
  )
    throw new Error(hostBranchChanged);
  git(repo.root, "check-ref-format", branch);
  if (
    typeof policy !== "string" ||
    !isAbsolute(policy) ||
    normalize(policy) !== policy ||
    within(policy, repo.root) ||
    within(policy, repo.commonDir)
  )
    throw new Error("input policy must be outside the worktree and Git metadata");

  const policyFile = openInputPolicy(policy, { create: false });
  try {
    const saved = readPublicInputAt(policyFile, privatePolicy);
    const approval: unknown = coordinationJSON(saved.bytes);
    const required = ["version", "root", "repository", "git_head", "index_tree", "files"];
    if (
      !isTable(approval) ||
      required.some((key) => !Object.hasOwn(approval, key)) ||
      Object.entries(approval).some(
        ([key, value]) => !Object.hasOwn(record, key) || !equalStrictJSON(record[key], value),
      )
    )
      throw new Error(policyChanged);
    const checkPolicy = () => {
      const current = openInputPolicy(policy, { create: false });
      try {
        const file = readPublicInputAt(current, privatePolicy);
        if (
          !file.bytes.equals(saved.bytes) ||
          !equalStrictJSON(namedIdentity(current), saved.identity) ||
          !equalStrictJSON(namedIdentity(policyFile), saved.identity)
        )
          throw new Error(policyChanged);
      } finally {
        closeSync(current.fd);
      }
    };
    const fingerprints = fingerprintEntries(approval.files);
    const denied = deniedFiles(approval.runtime);
    const readExport = (name: string) => readResultFile(session, "result/" + name).bytes;
    const head = strip(utf8.decode(readExport("head")));
    const index = strip(utf8.decode(readExport("index-tree")));
    const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
    if (![head, index].every((item) => oid.test(item) && item.length === before.length))
      throw new Error("invalid result object");

    const quarantine = mkdtempSync(join(session, "return-"));
    git(
      quarantine,
      "init",
      "--bare",
      "--quiet",
      `--object-format=sha${head.length === 40 ? 1 : 256}`,
    );
    const bundle = join(quarantine, "result.bundle");
    writeFileSync(bundle, readExport("commits.bundle"), { flag: "wx", mode: 0o600 });
    git(quarantine, "bundle", "unbundle", bundle);
    git(quarantine, "fsck", "--full", "--no-reflogs");
    if (
      gitText(quarantine, "cat-file", "-t", head) !== "commit" ||
      gitText(quarantine, "cat-file", "-t", index) !== "tree"
    )
      throw new Error("invalid result object");
    git(quarantine, "merge-base", "--is-ancestor", before, head);
    const oldTree = treeFiles(quarantine, before);
    const newTree = treeFiles(quarantine, head);
    const stagedTree = treeFiles(quarantine, index);
    for (const tree of [newTree, stagedTree]) {
      for (const [name, entry] of tree) {
        if (!/^100(?:644|755) blob /.test(entry) && entry !== oldTree.get(name))
          throw new Error("result tree contains a new or changed linked or unsupported file");
      }
    }

    const names = new Set(decodeSurrogateEscape(readExport("files")).split("\0").filter(Boolean));
    for (const name of fingerprints.keys()) names.add(name);
    const files = new Map<string, ReturnType<typeof readResultFile>>();
    const snapshot = join(session, "root", repo.root);
    // A missing snapshot is a failed export, not a deletion of every admitted file.
    try {
      closeSync(openParent(join(snapshot, ".public-root")).fd);
    } catch (error) {
      if (!missing(error)) throw error;
      throw new Error("result worktree snapshot is missing; result is retained for recovery");
    }
    for (const name of names) {
      try {
        const file = readResultFile(snapshot, name);
        // Codex creates empty mount targets for concrete deny rules.
        if (
          denied[name] === "deny" &&
          !file.bytes.length &&
          !fingerprints.has(name) &&
          !newTree.has(name) &&
          !stagedTree.has(name)
        )
          continue;
        files.set(name, file);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    const affected = new Set([...fingerprints.keys(), ...files.keys()]);
    for (const name of new Set([...oldTree.keys(), ...newTree.keys(), ...stagedTree.keys()])) {
      if (oldTree.get(name) !== newTree.get(name) || newTree.get(name) !== stagedTree.get(name))
        affected.add(name);
    }
    for (const name of affected) checkHostFile(repo.root, name, fingerprints.get(name));

    git(quarantine, "read-tree", index);
    const indexBytes = readFileSync(join(quarantine, "index"));
    const lock = openParent(join(repo.gitDir, "index.lock"));
    try {
      const descriptor = native.openat(lock.fd, lock.leaf, createFile, 0o644);
      try {
        const stat = fstatSync(descriptor, { bigint: true });
        const identity = { dev: stat.dev, ino: stat.ino };
        try {
          const previous = readPublicInputAt({ fd: lock.fd, leaf: "index" }, checkFileOwnerAndMode);
          writeFileSync(join(quarantine, "index"), previous.bytes);
          let currentIndex: string;
          try {
            currentIndex = gitText(quarantine, "write-tree");
          } catch {
            throw new Error(hostIndexChanged);
          }
          if (currentIndex !== beforeIndex) throw new Error(hostIndexChanged);
          writeFileSync(descriptor, indexBytes);
          git(repo.root, "bundle", "unbundle", bundle);
          await publishRef(repo.root, branch, before, head, () => {
            repo.checkUnchanged(record.repository);
            if (gitText(repo.root, "symbolic-ref", "HEAD") !== branch)
              throw new Error(hostBranchChanged);
            checkPolicy();
            for (const name of affected) checkHostFile(repo.root, name, fingerprints.get(name));
            for (const name of [...affected].sort()) {
              const contents = files.get(name);
              const expected = fingerprints.get(name);
              if (equalStrictJSON(contents?.fingerprint, expected)) continue;
              installResultFile(repo.root, name, contents, expected);
            }
            if (
              !equalStrictJSON(namedIdentity(lock), identity) ||
              !equalStrictJSON(namedIdentity({ fd: lock.fd, leaf: "index" }), previous.identity)
            )
              throw new Error(hostIndexChanged);
            native.renameat(lock.fd, lock.leaf, lock.fd, "index");
          });
        } finally {
          removeCreated(lock, identity);
        }
      } finally {
        closeSync(descriptor);
      }
    } finally {
      closeSync(lock.fd);
    }

    const next = {
      ...approval,
      git_head: head,
      index_tree: index,
      files: Object.fromEntries([...files].map(([name, file]) => [name, file.fingerprint])),
    };
    publishInputPolicy(policyFile, strictJSON(next, 2, { ascii: true }), checkPolicy);
    return head;
  } finally {
    closeSync(policyFile.fd);
  }
}
