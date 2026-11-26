import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { findCLI } from "./cli-path.ts";
import { strip } from "./coordination-json.ts";
import { equalStrictJSON } from "./strict-json.ts";

export class InvalidContext extends Error {}

export function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const physicalPath = realpathSync.native;

function gitPath(directory: string, option: string): string {
  const git = findCLI("git");
  if (!git) throw new InvalidContext("Git is required to resolve worktree metadata");
  let executable: string;
  try {
    executable = physicalPath(git);
  } catch (error) {
    throw new InvalidContext("Git executable is unavailable", { cause: error });
  }
  const result = spawnSync(
    executable,
    ["-C", directory, "rev-parse", "--path-format=absolute", option],
    {
      env: { ...gitEnvironment(), GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if (result.status !== 0) throw result.error ?? new Error("git rev-parse failed");
  return physicalPath(utf8.decode(result.stdout).replace(/\r\n?/g, "\n").replace(/\n+$/, ""));
}

function metadataTarget(path: string, prefix = ""): string {
  if (lstatSync(path).isSymbolicLink()) throw new InvalidContext("symlinked Git metadata pointer");
  const lines = utf8
    .decode(readFileSync(path))
    .replace(/\r\n/g, "\n")
    .split(/[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1 || !lines[0].startsWith(prefix))
    throw new InvalidContext("invalid Git metadata pointer");
  const target = strip(lines[0].slice(prefix.length));
  if (!target) throw new InvalidContext("empty Git metadata pointer");
  // Python の Path と同じく、余分な区切りと「.」を除去し「..」は物理解決に委ねる。
  const components = target.split("/").filter((part) => part && part !== ".");
  const base = isAbsolute(target) ? "" : dirname(path);
  return physicalPath(`${base}/${components.join("/")}`);
}

export type GitIdentity = {
  readonly common_dir: string;
  readonly device: number | bigint;
  readonly inode: number | bigint;
};

function exactInteger(value: bigint): number | bigint {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

export class Repository {
  private constructor(
    readonly root: string,
    readonly gitDir: string,
    readonly commonDir: string,
    private readonly linkedOnly: boolean,
    private readonly allowGitfile: boolean,
  ) {
    Object.freeze(this);
  }

  static discover(
    directory: string,
    { linkedOnly = false, allowGitfile = false } = {},
  ): Repository {
    try {
      const root = gitPath(directory, "--show-toplevel");
      const gitDir = gitPath(root, "--git-dir");
      const commonDir = gitPath(root, "--git-common-dir");
      const pointer = join(root, ".git");
      const pointerType = lstatSync(pointer);
      if (pointerType.isSymbolicLink()) throw new InvalidContext("symlinked worktree metadata");
      if (gitDir === commonDir) {
        if (
          linkedOnly ||
          !(
            (pointerType.isDirectory() && physicalPath(pointer) === commonDir) ||
            (allowGitfile && pointerType.isFile() && metadataTarget(pointer, "gitdir:") === gitDir)
          )
        )
          throw new InvalidContext("current directory is not a linked Git worktree");
      } else if (
        metadataTarget(pointer, "gitdir:") !== gitDir ||
        metadataTarget(join(gitDir, "commondir")) !== commonDir ||
        dirname(gitDir) !== join(commonDir, "worktrees") ||
        metadataTarget(join(gitDir, "gitdir")) !== pointer
      ) {
        throw new InvalidContext("linked worktree metadata ownership does not match");
      }
      return new Repository(root, gitDir, commonDir, linkedOnly, allowGitfile);
    } catch (error) {
      if (error instanceof InvalidContext) throw error;
      throw new InvalidContext("cannot resolve Git worktree metadata", { cause: error });
    }
  }

  identity(): GitIdentity {
    const { dev, ino } = statSync(this.commonDir, { bigint: true });
    return { common_dir: this.commonDir, device: exactInteger(dev), inode: exactInteger(ino) };
  }

  checkUnchanged(identity: unknown): void {
    const current = Repository.discover(this.root, {
      linkedOnly: this.linkedOnly,
      allowGitfile: this.allowGitfile,
    });
    if (
      current.root !== this.root ||
      current.gitDir !== this.gitDir ||
      current.commonDir !== this.commonDir ||
      !equalStrictJSON(this.identity(), identity)
    ) {
      throw new InvalidContext("worktree metadata changed during preparation");
    }
  }
}
