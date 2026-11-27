import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Repository } from "../../lib/bun/git-context.ts";
import { returnRawResult } from "../../lib/bun/raw-return.ts";

const legacy = resolve(import.meta.dir, "../../share/codex-isolation/secret-isolation-worktree.py");
const realGit = Bun.which("git")!;
const gitEnv = {
  PATH: process.env.PATH,
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-11-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-11-01T00:00:00Z",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync(realGit, args, { cwd, env: gitEnv, encoding: "utf8" }).trimEnd();
}

function fixture(base: string, executablePath: string, original: string) {
  const host = join(base, "host");
  const work = join(base, "work");
  const isolated = join(base, "isolated");
  const policy = join(base, "approval.json");
  const session = join(base, "session");
  const result = join(session, "result");
  const snapshot = join(session, "root", work);
  const python = (operation: string, ...args: string[]) =>
    spawnSync("python3", ["-B", legacy, operation, "--root", work, ...args], {
      env: { ...gitEnv, PATH: operation === "return" ? executablePath : gitEnv.PATH },
      encoding: "utf8",
    });
  function prepare(operation: string, ...args: string[]) {
    const completed = python(operation, ...args);
    expect(completed.stderr).toBe("");
    expect(completed.status).toBe(0);
  }

  git(base, "init", "-q", "--initial-branch=main", host);
  writeFileSync(join(host, "source.txt"), original);
  writeFileSync(join(host, "remove.txt"), "remove this\n");
  symlinkSync("source.txt", join(host, "existing-link"));
  git(host, "add", ".");
  git(host, "commit", "-qm", "original");
  git(
    host,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${git(host, "rev-parse", "HEAD")},existing-gitlink`,
  );
  git(host, "commit", "-qm", "existing gitlink");
  git(host, "worktree", "add", "-qb", "task", work);
  const before = git(work, "rev-parse", "HEAD");
  const beforeIndex = git(work, "write-tree");
  prepare("approve", "--policy", policy, "--git-head", before, "source.txt", "remove.txt");
  prepare("prepare", "--policy", policy, "--output", session);

  // The snapshot has absolute Git pointers for the namespace, so generate its export separately.
  git(base, "clone", "-q", "--no-local", host, isolated);
  writeFileSync(join(isolated, "source.txt"), "committed\n");
  git(isolated, "add", "source.txt");
  git(isolated, "commit", "-qm", "isolated commit");
  unlinkSync(join(isolated, "remove.txt"));
  mkdirSync(join(isolated, "tools"));
  writeFileSync(join(isolated, "tools/run"), "staged\n");
  chmodSync(join(isolated, "tools/run"), 0o755);
  git(isolated, "add", "-A");
  writeFileSync(join(isolated, "source.txt"), "unstaged\n");
  writeFileSync(join(isolated, "untracked.txt"), "untracked\n");
  writeFileSync(join(snapshot, "source.txt"), "unstaged\n");
  unlinkSync(join(snapshot, "remove.txt"));
  writeFileSync(join(snapshot, "untracked.txt"), "untracked\n");
  mkdirSync(join(snapshot, "tools"));
  writeFileSync(join(snapshot, "tools/run"), "staged\n");
  chmodSync(join(snapshot, "tools/run"), 0o755);
  mkdirSync(result);

  function exportResult() {
    const head = git(isolated, "rev-parse", "HEAD");
    const index = git(isolated, "write-tree");
    writeFileSync(join(result, "head"), head + "\n");
    writeFileSync(join(result, "index-tree"), index + "\n");
    writeFileSync(
      join(result, "files"),
      git(isolated, "ls-files", "-z", "--cached", "--others", "--exclude-standard"),
    );
    const commit = git(isolated, "commit-tree", index, "-p", head, "-m", "preserve index");
    git(isolated, "update-ref", "refs/isolation/index", commit);
    git(
      isolated,
      "bundle",
      "create",
      join(result, "commits.bundle"),
      "HEAD",
      "refs/isolation/index",
    );
    return { head, index };
  }

  const exported = exportResult();
  const repo = Repository.discover(work, { linkedOnly: true });
  return {
    base,
    work,
    repo,
    policy,
    session,
    snapshot,
    result,
    isolated,
    before,
    beforeIndex,
    exported,
    exportResult,
    python,
  };
}

type Fixture = ReturnType<typeof fixture>;
type Implementation = "python" | "bun";

async function compare(
  run: (input: Fixture, implementation: Implementation) => Promise<void>,
  original = "original\n",
) {
  const base = mkdtempSync("/tmp/codex/raw-return-test.");
  const path = process.env.PATH!;
  const umask = process.umask(0o022);
  try {
    for (const implementation of ["python", "bun"] as const) {
      const directory = join(base, implementation);
      mkdirSync(directory, { mode: 0o700 });
      const bin = join(directory, "bin");
      mkdirSync(bin);
      const executablePath = `${bin}:${path}`;
      const input = fixture(directory, executablePath, original);
      process.env.PATH = executablePath;
      await run(input, implementation);
    }
  } finally {
    process.umask(umask);
    process.env.PATH = path;
    rmSync(base, { recursive: true, force: true });
  }
}

async function runReturn(input: Fixture, implementation: Implementation) {
  if (implementation === "python") return input.python("return", "--session", input.session);
  try {
    const head = await returnRawResult(input.repo, input.session);
    return {
      status: 0,
      stdout: `returned HEAD ${head}, index and ordinary worktree changes\n`,
      stderr: "",
    };
  } catch (error) {
    return { status: 1, stdout: "", stderr: (error as Error).message };
  }
}

async function rejectReturn(
  input: Fixture,
  implementation: Implementation,
  reason: RegExp,
  snapshotAfter = input.snapshot,
) {
  const retained = [
    input.policy,
    join(input.session, "session.json"),
    join(input.result, "commits.bundle"),
    join(input.result, "files"),
    join(input.result, "head"),
    join(input.result, "index-tree"),
  ];
  const before = retained.map((path) => readFileSync(path));
  const source = readFileSync(join(input.snapshot, "source.txt"));
  const returned = await runReturn(input, implementation);
  expect(returned.stderr).toMatch(reason);
  expect(returned.status).toBe(1);
  expect(returned.stdout).toBe("");
  expect(retained.map((path) => readFileSync(path))).toEqual(before);
  expect(readFileSync(join(snapshotAfter, "source.txt"))).toEqual(source);
  if (implementation === "bun")
    expect(readdirSync(input.session).filter((path) => path.startsWith("return-"))).toEqual([]);
}

// Run a fixture operation at a plumbing call observed by both implementations.
function runBeforeGit(input: Fixture, command: string, change: string[]) {
  const literal = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    join(input.base, "bin/git"),
    `#!/bin/sh
set -eu
case " $* " in
  *' ${command} '*)
    ${change.map(literal).join(" ")}
    printf '%s\\n' ran > ${literal(join(input.base, "writer-ran"))}
    ;;
esac
exec ${literal(realGit)} "$@"
`,
    { mode: 0o700 },
  );
}

describe.skipIf(process.platform !== "linux" || process.env.RAW_RETURN_TEST !== "1")(
  "raw result return matches the legacy Python host",
  () => {
    test("returns the commit, staged tree, ordinary files and next approval", async () => {
      await compare(async (input, implementation) => {
        const { policy, work, exported } = input;
        mkdirSync(join(input.session, "return-existing"));
        const linkedEntries = git(
          work,
          "ls-files",
          "--stage",
          "--",
          "existing-link",
          "existing-gitlink",
        );
        const returned = await runReturn(input, implementation);
        expect(returned.stderr).toBe("");
        expect(returned.status).toBe(0);
        expect(returned.stdout).toBe(
          `returned HEAD ${exported.head}, index and ordinary worktree changes\n`,
        );
        expect(git(work, "rev-parse", "HEAD")).toBe(exported.head);
        expect(git(work, "show", "HEAD:source.txt")).toBe("committed");
        expect(git(work, "write-tree")).toBe(exported.index);
        expect(git(work, "status", "--porcelain")).toBe(
          "D  remove.txt\n M source.txt\nA  tools/run\n?? untracked.txt",
        );
        expect(readFileSync(join(work, "source.txt"), "utf8")).toBe("unstaged\n");
        expect(readFileSync(join(work, "tools/run"), "utf8")).toBe("staged\n");
        expect(statSync(join(work, "tools/run")).mode & 0o777).toBe(0o755);
        expect(readFileSync(join(work, "untracked.txt"), "utf8")).toBe("untracked\n");
        expect(readlinkSync(join(work, "existing-link"))).toBe("source.txt");
        expect(git(work, "ls-files", "--stage", "--", "existing-link", "existing-gitlink")).toBe(
          linkedEntries,
        );
        const approval = JSON.parse(readFileSync(policy, "utf8"));
        expect(approval.index_tree).toBe(exported.index);
        expect(approval.git_head).toBe(exported.head);
        expect(Object.keys(approval.files).sort()).toEqual([
          "source.txt",
          "tools/run",
          "untracked.txt",
        ]);
        expect(approval.files["tools/run"]).toEqual({
          sha256: "9ac007af3de930baf647288da0c843b26a5f046a3fe1351f1bb039b242d22cdf",
          executable: true,
        });
        expect(statSync(policy).mode & 0o777).toBe(0o600);
        if (implementation === "bun")
          expect(readdirSync(input.session).filter((path) => path.startsWith("return-"))).toEqual([
            "return-existing",
          ]);
      });
    });

    test("legacy prepare writes private session metadata under a shared umask", async () => {
      await compare(async (input, implementation) => {
        if (implementation !== "python") return;
        const output = join(input.base, "shared-umask-session");
        const umask = process.umask(0o002);
        try {
          const prepared = input.python("prepare", "--policy", input.policy, "--output", output);
          expect(prepared.stderr).toBe("");
          expect(prepared.status).toBe(0);
          expect(statSync(join(output, "session.json")).mode & 0o777).toBe(0o600);
        } finally {
          process.umask(umask);
        }
      });
    });

    test("preserves legacy policy fields and raw filename bytes and omits empty deny mount targets", async () => {
      await compare(async (input, implementation) => {
        const { policy, session, work, result, snapshot } = input;
        const name = Buffer.from([0x66, 0xff]);
        const filename = (directory: string) => Buffer.concat([Buffer.from(directory + "/"), name]);
        writeFileSync(filename(snapshot), "raw name\n");
        writeFileSync(join(snapshot, ".env"), "");
        writeFileSync(join(work, ".env"), "host fixture\n");
        const files = join(result, "files");
        writeFileSync(files, Buffer.concat([readFileSync(files), name, Buffer.from("\0.env\0")]));
        const requirements =
          '[permissions.dotfiles-secure.filesystem.":workspace_roots"]\n".env" = "deny"\n';
        for (const path of [policy, join(session, "session.json")]) {
          const record = JSON.parse(readFileSync(path, "utf8"));
          record.runtime = { requirements, number: "fixture integer" };
          writeFileSync(
            path,
            JSON.stringify(record).replace('"fixture integer"', "9223372036854775813"),
          );
        }
        const returned = await runReturn(input, implementation);
        expect(returned.stderr).toBe("");
        expect(returned.status).toBe(0);
        expect(readFileSync(filename(work), "utf8")).toBe("raw name\n");
        expect(readFileSync(join(work, ".env"), "utf8")).toBe("host fixture\n");
        const saved = readFileSync(policy, "utf8");
        expect(saved).toContain('"number": 9223372036854775813');
        const approved = JSON.parse(saved);
        expect(approved.runtime.requirements).toBe(requirements);
        expect(Object.hasOwn(approved.files, "f\udcff")).toBe(true);
        expect(Object.hasOwn(approved.files, ".env")).toBe(false);
      });
    });

    test.each([
      "modified",
      "executable",
      "unregistered",
      "host symlink",
      "snapshot symlink",
      "tree symlink",
      "tree gitlink",
      "approval",
      "session identity",
      "index lock",
    ] as const)("rejects %s and preserves recoverable output", async (kind) => {
      await compare(async (input, implementation) => {
        const { before, beforeIndex, policy, repo, work, snapshot, isolated, session } = input;
        const hostFile = join(work, "source.txt");
        const original = readFileSync(hostFile, "utf8");
        const lock = join(repo.gitDir, "index.lock");
        let reason: RegExp;
        switch (kind) {
          case "modified":
            writeFileSync(hostFile, "host change\n");
            reason = /host input changed/;
            break;
          case "executable":
            chmodSync(hostFile, 0o755);
            reason = /host input changed/;
            break;
          case "unregistered":
            writeFileSync(join(work, "untracked.txt"), "host only\n");
            reason = /unapproved host file/;
            break;
          case "host symlink":
            mkdirSync(join(input.base, "other"));
            symlinkSync(join(input.base, "other"), join(work, "tools"));
            reason = implementation === "python" ? /crosses a host link/ : /ENOTDIR/;
            break;
          case "snapshot symlink":
            unlinkSync(join(snapshot, "untracked.txt"));
            symlinkSync(hostFile, join(snapshot, "untracked.txt"));
            reason = implementation === "python" ? /Too many levels of symbolic links/ : /ELOOP/;
            break;
          case "tree symlink":
            symlinkSync("source.txt", join(isolated, "linked"));
            git(isolated, "add", "linked");
            input.exportResult();
            reason = /new or changed linked or unsupported file/;
            break;
          case "tree gitlink":
            git(isolated, "update-index", "--add", "--cacheinfo", `160000,${before},vendor`);
            input.exportResult();
            reason = /new or changed linked or unsupported file/;
            break;
          case "approval": {
            const record = JSON.parse(readFileSync(policy, "utf8"));
            record.files["source.txt"].executable = true;
            writeFileSync(policy, JSON.stringify(record));
            reason = /input approval changed/;
            break;
          }
          case "session identity": {
            const file = join(session, "session.json");
            const record = JSON.parse(readFileSync(file, "utf8"));
            record.repository.inode = 0;
            writeFileSync(file, JSON.stringify(record));
            reason = /session belongs to another worktree or repository/;
            break;
          }
          case "index lock":
            writeFileSync(lock, "another writer\n");
            reason = implementation === "python" ? /Git write-tree failed/ : /EEXIST: openat/;
            break;
        }
        await rejectReturn(input, implementation, reason);
        if (kind === "index lock") {
          expect(readFileSync(lock, "utf8")).toBe("another writer\n");
          unlinkSync(lock);
        }
        expect(existsSync(lock)).toBe(false);
        expect(git(work, "rev-parse", "HEAD")).toBe(before);
        expect(git(work, "write-tree")).toBe(beforeIndex);
        expect(readFileSync(hostFile, "utf8")).toBe(
          kind === "modified" ? "host change\n" : original,
        );
        expect(statSync(hostFile).mode & 0o777).toBe(kind === "executable" ? 0o755 : 0o644);
        expect(readFileSync(join(work, "remove.txt"), "utf8")).toBe("remove this\n");
        expect(existsSync(join(work, "tools/run"))).toBe(false);
        if (kind === "unregistered")
          expect(readFileSync(join(work, "untracked.txt"), "utf8")).toBe("host only\n");
        if (kind === "host symlink") expect(existsSync(join(input.base, "other/run"))).toBe(false);
      });
    });

    test("rejects a ref that changed just before transaction prepare", async () => {
      await compare(async (input, implementation) => {
        const { before, beforeIndex, work } = input;
        const racedHead = git(
          work,
          "commit-tree",
          beforeIndex,
          "-p",
          before,
          "-m",
          "parallel commit",
        );
        runBeforeGit(input, "update-ref --stdin", [
          realGit,
          "-C",
          work,
          "update-ref",
          "refs/heads/task",
          racedHead,
          before,
        ]);
        await rejectReturn(input, implementation, /host ref changed/);
        expect(readFileSync(join(input.base, "writer-ran"), "utf8")).toBe("ran\n");
        expect(git(work, "rev-parse", "HEAD")).toBe(racedHead);
        expect(git(work, "write-tree")).toBe(beforeIndex);
        expect(readFileSync(join(work, "source.txt"), "utf8")).toBe("original\n");
        expect(existsSync(join(input.repo.gitDir, "index.lock"))).toBe(false);
      });
    });

    test("rejects an index updated just before locking", async () => {
      await compare(async (input, implementation) => {
        const { before, work } = input;
        writeFileSync(join(work, "race.txt"), "parallel staging\n");
        runBeforeGit(input, "read-tree", [realGit, "-C", work, "add", "race.txt"]);
        await rejectReturn(input, implementation, /host index changed/);
        expect(readFileSync(join(input.base, "writer-ran"), "utf8")).toBe("ran\n");
        expect(git(work, "rev-parse", "HEAD")).toBe(before);
        expect(git(work, "show", ":race.txt")).toBe("parallel staging");
        expect(readFileSync(join(work, "source.txt"), "utf8")).toBe("original\n");
        expect(existsSync(join(input.repo.gitDir, "index.lock"))).toBe(false);
      });
    });

    test.skipIf(process.getuid?.() === 0)(
      "keeps the snapshot and bundle when file installation stops partway through",
      async () => {
        await compare(async (input, implementation) => {
          const { before, beforeIndex, work } = input;
          const directory = join(work, "tools");
          mkdirSync(directory, { mode: 0o500 });
          try {
            await rejectReturn(
              input,
              implementation,
              implementation === "python" ? /Permission denied/ : /EACCES: openat/,
            );
            expect(git(work, "rev-parse", "HEAD")).toBe(before);
            expect(git(work, "write-tree")).toBe(beforeIndex);
            expect(readFileSync(join(work, "source.txt"), "utf8")).toBe("unstaged\n");
            expect(existsSync(join(work, "remove.txt"))).toBe(false);
            expect(existsSync(join(work, "tools/run"))).toBe(false);
            expect(existsSync(join(input.repo.gitDir, "index.lock"))).toBe(false);
          } finally {
            chmodSync(directory, 0o700);
          }
        });
      },
    );

    test.each(["public approval", "group-writable file"] as const)(
      "rejects a %s under the TypeScript owner and mode checks",
      async (kind) => {
        await compare(async (input, implementation) => {
          const { work, policy, before, beforeIndex } = input;
          const hostFile = join(work, "source.txt");
          const isPolicy = kind === "public approval";
          const file = isPolicy ? policy : hostFile;
          const mode = isPolicy ? 0o644 : 0o664;
          chmodSync(file, mode);
          if (implementation === "python") {
            const returned = await runReturn(input, implementation);
            expect(returned.stderr).toBe("");
            expect(returned.status).toBe(0);
            expect(statSync(file).mode & 0o777).toBe(isPolicy ? 0o600 : 0o644);
          } else {
            await rejectReturn(
              input,
              implementation,
              isPolicy ? /input approval must be private/ : /protected from other writers/,
            );
            expect(git(work, "rev-parse", "HEAD")).toBe(before);
            expect(git(work, "write-tree")).toBe(beforeIndex);
            expect(readFileSync(hostFile, "utf8")).toBe("original\n");
            expect(statSync(file).mode & 0o777).toBe(mode);
          }
        });
      },
    );

    test.skipIf(process.getuid?.() === 0)(
      "rejects an unchanged approved file when it has a different owner",
      async () => {
        const foreign = "/proc/sys/kernel/ostype";
        const original = readFileSync(foreign, "utf8");
        await compare(async (input, implementation) => {
          const { work, snapshot, base, session, policy, before, beforeIndex } = input;
          const hostFile = join(work, "source.txt");
          writeFileSync(join(snapshot, "source.txt"), original);
          const saved = readFileSync(policy);
          const entry = join(base, "return.ts");
          writeFileSync(
            entry,
            `
import { Repository } from ${JSON.stringify(resolve(import.meta.dir, "../../lib/bun/git-context.ts"))};
import { returnRawResult } from ${JSON.stringify(resolve(import.meta.dir, "../../lib/bun/raw-return.ts"))};
try {
  await returnRawResult(Repository.discover(process.argv[2], { linkedOnly: true }), process.argv[3]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
`,
          );
          const command =
            implementation === "python"
              ? ["python3", "-B", legacy, "return", "--root", work, "--session", session]
              : [resolve(import.meta.dir, "../../lib/bun/run"), "run", entry, work, session];
          // Bind a public regular file of the same content only within this fixture's namespace.
          const returned = spawnSync(
            "bwrap",
            [
              "--unshare-user",
              "--die-with-parent",
              "--ro-bind",
              "/",
              "/",
              "--dev",
              "/dev",
              "--proc",
              "/proc",
              "--bind",
              base,
              base,
              "--ro-bind",
              foreign,
              hostFile,
              "--",
              "bash",
              "-ec",
              'test "$(stat -c %u "$1")" != "$(id -u)"; shift; exec "$@"',
              "_",
              hostFile,
              ...command,
            ],
            { encoding: "utf8", timeout: 10_000 },
          );
          if (implementation === "python") {
            expect(returned.stderr).toBe("");
            expect(returned.status).toBe(0);
            expect(git(work, "rev-parse", "HEAD")).toBe(input.exported.head);
          } else {
            expect(returned.stderr).toMatch(/must be owned by the current user/);
            expect(returned.status).toBe(1);
            expect(git(work, "rev-parse", "HEAD")).toBe(before);
            expect(git(work, "write-tree")).toBe(beforeIndex);
            expect(readFileSync(policy)).toEqual(saved);
          }
          expect(readFileSync(hostFile, "utf8")).toBe(original);
        }, original);
      },
    );

    test("the TypeScript return treats an absent snapshot as a failed export", async () => {
      await compare(async (input, implementation) => {
        const retained = input.snapshot + "-retained";
        renameSync(input.snapshot, retained);
        if (implementation === "python") {
          expect((await runReturn(input, implementation)).status).toBe(0);
          expect(existsSync(join(input.work, "source.txt"))).toBe(false);
        } else {
          await rejectReturn(
            { ...input, snapshot: retained },
            implementation,
            /result worktree snapshot is missing/,
          );
          expect(git(input.work, "rev-parse", "HEAD")).toBe(input.before);
          expect(git(input.work, "write-tree")).toBe(input.beforeIndex);
          expect(readFileSync(join(input.work, "source.txt"), "utf8")).toBe("original\n");
        }
      });
    });

    test.each(["move", "replace"])("rejects a snapshot %s before publication", async (kind) => {
      await compare(async (input, implementation) => {
        const { base, snapshot, work, before, beforeIndex } = input;
        const retained = snapshot + "-retained";
        const change =
          kind === "move"
            ? ["mv", "--", snapshot, retained]
            : ["sh", "-ec", 'mv -- "$1" "$2" && mkdir -- "$1"', "_", snapshot, retained];
        runBeforeGit(input, kind === "replace" ? "merge-base" : "read-tree", change);
        if (implementation === "python") {
          expect((await runReturn(input, implementation)).status).toBe(0);
          expect(git(work, "rev-parse", "HEAD")).toBe(input.exported.head);
          if (kind === "replace") expect(existsSync(join(work, "source.txt"))).toBe(false);
        } else {
          await rejectReturn(
            input,
            implementation,
            /result worktree snapshot (?:is missing|changed)/,
            retained,
          );
          expect(git(work, "rev-parse", "HEAD")).toBe(before);
          expect(git(work, "write-tree")).toBe(beforeIndex);
          expect(readFileSync(join(work, "source.txt"), "utf8")).toBe("original\n");
        }
        expect(readFileSync(join(base, "writer-ran"), "utf8")).toBe("ran\n");
      });
    });
  },
);
