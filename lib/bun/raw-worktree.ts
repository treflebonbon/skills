import {
  closeSync,
  constants,
  fchmodSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { coordinationJSON, object, strip } from "./coordination-json.ts";
import { native } from "./file-safety.ts";
import type { Repository } from "./git-context.ts";
import {
  openPublicInputParent,
  readPublicInput,
  type InputFingerprint,
} from "./raw-admission-files.ts";
import { equalStrictJSON, strictJSON } from "./strict-json.ts";

export function rawGit(
  root: string,
  args: string[],
  { gitDir, input }: { gitDir?: string; input?: Uint8Array } = {},
): Buffer {
  const result = Bun.spawnSync(
    ["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...args],
    {
      env: {
        PATH: process.env.PATH,
        HOME: "/nonexistent",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        ...(gitDir && { GIT_DIR: gitDir, GIT_WORK_TREE: root }),
      },
      stdin: input ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : "ignore",
      stderr: "ignore",
    },
  );
  if (!result.success) throw new Error(`Git ${args[0]} failed; no input was published`);
  return result.stdout;
}

export function rawGitText(root: string, ...args: string[]) {
  return strip(new TextDecoder("utf-8", { fatal: true }).decode(rawGit(root, args)));
}

export function readApproval(policy: string) {
  const record: unknown = coordinationJSON(
    readPublicInput(dirname(policy), basename(policy), (state) => {
      if (state.uid !== BigInt(process.getuid!()) || (state.mode & 0o077n) !== 0n)
        throw new Error("input policy must be private to the current user");
    }).bytes,
  );
  if (!object(record)) throw new Error("invalid input approval");
  return record;
}

const exclusive = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

function writePrivate(path: string, value: string) {
  const fd = openSync(path, exclusive, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, value);
  } finally {
    closeSync(fd);
  }
}

export function prepareRawWorktree(
  repo: Repository,
  policy: string,
  output: string,
  record = readApproval(policy),
  expectedTopic?: string,
) {
  if (
    record.version !== 1 ||
    record.root !== repo.root ||
    !equalStrictJSON(record.repository, repo.identity())
  )
    throw new Error("input approval belongs to another worktree or repository");
  const head = rawGitText(repo.root, "rev-parse", "HEAD");
  if (record.git_head !== head) throw new Error("Git HEAD changed since input approval");
  if (rawGitText(repo.root, "write-tree") !== record.index_tree)
    throw new Error("host index changed since input approval");
  if (!object(record.files)) throw new Error("invalid public input list");
  const admitted = new Map<string, { bytes: Buffer; fingerprint: InputFingerprint }>();
  for (const [name, expected] of Object.entries(record.files)) {
    const file = readPublicInput(repo.root, name);
    if (!equalStrictJSON(file.fingerprint, expected))
      throw new Error("public input changed since approval");
    admitted.set(name, file);
  }
  const branch = rawGitText(repo.root, "symbolic-ref", "HEAD");
  rawGit(repo.root, ["check-ref-format", branch]);
  if (expectedTopic !== undefined && branch !== "refs/heads/" + expectedTopic)
    throw new Error("prepared branch differs from the admitted GitHub topic");
  mkdirSync(output, { mode: 0o700 });
  const snapshotRoot = join(output, "root");
  const snapshotWorktree = join(snapshotRoot, repo.root);
  const snapshotCommon = join(snapshotRoot, repo.commonDir);
  const snapshotMetadata = join(snapshotRoot, repo.gitDir);
  mkdirSync(snapshotWorktree, { recursive: true });
  mkdirSync(snapshotCommon, { recursive: true });

  const pack = rawGit(repo.root, ["pack-objects", "--stdout", "--revs"], {
    input: Buffer.from(`${head}\n${record.index_tree}\n`),
  });
  const format = head.length === 64 ? "sha256" : "sha1";
  rawGit(snapshotCommon, ["init", "--bare", "--quiet", `--object-format=${format}`]);
  rawGit(snapshotWorktree, ["index-pack", "--stdin"], { gitDir: snapshotCommon, input: pack });
  rawGit(snapshotWorktree, ["fsck", "--full", "--no-reflogs"], { gitDir: snapshotCommon });
  rawGit(snapshotWorktree, ["config", "core.bare", "false"], { gitDir: snapshotCommon });
  rawGit(snapshotWorktree, ["update-ref", branch, head], { gitDir: snapshotCommon });
  mkdirSync(snapshotMetadata, { recursive: true });
  writeFileSync(join(snapshotMetadata, "HEAD"), `ref: ${branch}\n`);
  writeFileSync(join(snapshotMetadata, "commondir"), repo.commonDir + "\n");
  writeFileSync(join(snapshotMetadata, "gitdir"), join(repo.root, ".git") + "\n");
  writeFileSync(join(snapshotWorktree, ".git"), `gitdir: ${repo.gitDir}\n`);
  // The absolute pointers refer to the host until the snapshot is mounted.
  rawGit(snapshotWorktree, ["read-tree", record.index_tree], { gitDir: snapshotCommon });
  renameSync(join(snapshotCommon, "index"), join(snapshotMetadata, "index"));
  for (const [name, { bytes, fingerprint }] of admitted) {
    const parent = openPublicInputParent(snapshotWorktree, name, true);
    try {
      const fd = native.openat(parent.fd, parent.leaf, exclusive);
      try {
        fchmodSync(fd, fingerprint.executable ? 0o755 : 0o644);
        writeFileSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
    } finally {
      closeSync(parent.fd);
    }
  }
  repo.checkUnchanged(record.repository);
  if (rawGitText(repo.root, "rev-parse", "HEAD") !== head)
    throw new Error("Git HEAD changed while preparing input");
  const session = {
    ...record,
    git_head: head,
    branch,
    git_dir: repo.gitDir,
    common_dir: repo.commonDir,
    policy,
  };
  writePrivate(join(output, "session.json"), strictJSON(session, 2, { ascii: true }));
  console.log("public worktree snapshot prepared; host files are not mounted");
  return session;
}
