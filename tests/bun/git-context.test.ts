import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  gitEnvironment,
  InvalidContext,
  Repository,
  type GitIdentity,
} from "../../lib/bun/git-context.ts";
import { parseStrictJSON, strictJSON } from "../../lib/bun/strict-json.ts";
import corpus from "../fixtures/git-context-python.json";

let base: string, primary: string, worktree: string, common: string, metadata: string;

function git(...args: string[]): void {
  execFileSync("git", args);
}

beforeEach(() => {
  base = mkdtempSync(join(realpathSync.native(tmpdir()), "skills-git-context."));
  primary = join(base, "repo");
  worktree = join(base, "review");
  common = join(primary, ".git");
  metadata = join(common, "worktrees/review");
  git("init", "-q", primary);
  git(
    "-C",
    primary,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "initial",
  );
  git("-C", primary, "worktree", "add", "-q", "-b", "review", worktree);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function paths(repo: Repository) {
  return {
    root: relative(base, repo.root),
    git_dir: relative(base, repo.gitDir),
    common_dir: relative(base, repo.commonDir),
  };
}

function linked(directory = worktree): Repository {
  return Repository.discover(directory, { linkedOnly: true });
}

function compare(name: keyof typeof corpus.cases, run: () => unknown): void {
  let result;
  try {
    result = run();
  } catch (error) {
    if (!(error instanceof InvalidContext)) throw error;
    result = { rejected: error.message };
  }
  expect(result).toEqual(corpus.cases[name]);
}

function backPointer(path: string): void {
  writeFileSync(join(metadata, "gitdir"), `${path}\n`);
}

test("linked worktree の物理 Git metadata を解決する", () => {
  compare("linked", () => paths(linked()));
});

test("worktree への symlink は物理パスに解決する", () => {
  const alias = join(base, "alias");
  symlinkSync(worktree, alias);
  compare("alias", () => paths(linked(alias)));
});

test("相対 pointer は各 metadata ファイルを基準に解決する", () => {
  writeFileSync(join(worktree, ".git"), "gitdir: ../repo/.git/worktrees/review\n");
  writeFileSync(join(metadata, "commondir"), "../..\n");
  backPointer("../../../../review/.git");
  compare("relativePointers", () => paths(linked()));
});

test("back-pointer は symlink をたどってから親を解決する", () => {
  const child = join(worktree, "child");
  mkdirSync(child);
  symlinkSync(child, join(base, "child-alias"));
  backPointer("../../../../child-alias/../.git");
  compare("physicalBackPointer", () => paths(linked()));
});

test("primary checkout は既定で許可し linked-only で拒否する", () => {
  compare("primary", () => paths(Repository.discover(primary)));
  compare("linkedOnly", () => linked(primary));
});

test("unlinked gitfile は明示許可した場合に限り解決する", () => {
  const checkout = join(base, "separate");
  git("init", "-q", "--separate-git-dir", join(base, "external"), checkout);
  compare("gitfile", () => Repository.discover(checkout));
  compare("allowedGitfile", () => paths(Repository.discover(checkout, { allowGitfile: true })));
  compare("linkedOnlyGitfile", () =>
    Repository.discover(checkout, { allowGitfile: true, linkedOnly: true }),
  );
});

test("存在しない back-pointer を拒否する", () => {
  backPointer(join(base, "elsewhere/.git"));
  compare("brokenBackPointer", linked);
});

test("存在しても worktree の .git と一致しない back-pointer を拒否する", () => {
  const foreign = join(worktree, "foreign");
  writeFileSync(foreign, "");
  backPointer(foreign);
  compare("foreignBackPointer", linked);
});

test("common Git dir の worktrees 直下に属さない Git dir を拒否する", () => {
  const moved = join(common, "outside-worktrees");
  renameSync(metadata, moved);
  writeFileSync(join(worktree, ".git"), `gitdir: ${moved}\n`);
  writeFileSync(join(moved, "commondir"), "..\n");
  compare("foreignMetadata", linked);
});

test("内容が同一でも symlink の .git と back-pointer を拒否する", () => {
  const pointer = join(worktree, ".git");
  const stored = join(worktree, "original");
  renameSync(pointer, stored);
  symlinkSync("original", pointer);
  compare("symlinkDotGit", linked);
  renameSync(stored, pointer);

  const metadataPointer = join(metadata, "gitdir");
  renameSync(metadataPointer, join(metadata, "original"));
  symlinkSync("original", metadataPointer);
  compare("symlinkBackPointer", linked);
});

test("Git repository を持たないディレクトリを拒否する", () => {
  compare("nonGit", () => linked(base));
});

test("Git が見つからない場合は診断付きで拒否する", () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    compare("unavailableGit", linked);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("継承した GIT_* 全体を除去し、他の環境変数を保持する", () => {
  const overrides = {
    GIT_DIR: common,
    GIT_WORK_TREE: primary,
    GIT_CONFIG_COUNT: "8",
    FIXTURE_MARKER: "retained",
  };
  const original = Object.keys(overrides).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, overrides);
  try {
    compare("environment", () => {
      const resolved = linked();
      const environment = gitEnvironment();
      return {
        root: relative(base, resolved.root),
        retained: environment.FIXTURE_MARKER,
        containsGitVariables: Object.keys(environment).some((key) => key.startsWith("GIT_")),
      };
    });
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("保存した device と inode で common Git dir を再照合できる", () => {
  const repo = linked();
  const saved = parseStrictJSON(Buffer.from(strictJSON(repo.identity()))) as GitIdentity;
  repo.checkUnchanged(saved);
  const { dev, ino } = statSync(common, { bigint: true });
  expect({
    common_dir: relative(base, saved.common_dir),
    deviceMatches: BigInt(saved.device) === dev,
    inodeMatches: BigInt(saved.inode) === ino,
  }).toEqual(corpus.cases.identity);
});

test("同じ物理パスに別 inode の common Git dir を置くと再照合で拒否する", () => {
  const repo = linked();
  const saved = repo.identity();
  const old = join(primary, "old-git");
  renameSync(common, old);
  cpSync(old, common, { recursive: true });
  expect(paths(linked())).toEqual(paths(repo));
  expect(repo.identity().inode).not.toBe(saved.inode);
  compare("replacedCommonDir", () => repo.checkUnchanged(saved));
});

test("metadata の所有関係が崩れた場合も再照合で拒否する", () => {
  const repo = linked();
  const saved = repo.identity();
  backPointer(join(base, "elsewhere/.git"));
  compare("changedOwnership", () => repo.checkUnchanged(saved));
});
