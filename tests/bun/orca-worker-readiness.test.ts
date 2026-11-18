import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { resolve } from "node:path";
import corpus from "../fixtures/orca-worker-readiness-python.json";

const root = resolve(import.meta.dir, "../..");
const readiness = resolve(root, "bin/orca-worker-readiness");
function withDirectory(action: (directory: string) => void) {
  try {
    fs.mkdirSync("/tmp/codex", { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const shared = fs.lstatSync("/tmp/codex");
  if (!shared.isDirectory() || shared.uid !== process.getuid!())
    throw new Error("テスト共有先は実 owner の directory が必要です");
  const directory = fs.mkdtempSync("/tmp/codex/orca-worker-readiness-");
  try {
    action(directory);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
}

function readinessFixture(directory: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (args: string[], input?: string) => {
    const result = spawnSync("git", args, { env, input, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.replace(/\n$/, "");
  };
  const repo = resolve(directory, "repo"),
    worker = resolve(directory, "worker"),
    other = resolve(directory, "other");
  git(["init", "-q", "-b", "main", repo]);
  git(["-C", repo, "hash-object", "-t", "tree", "-w", "--stdin"], "");
  expect(
    git(["-C", repo, "hash-object", "-t", "commit", "-w", "--stdin"], corpus.readiness.commit),
  ).toBe(corpus.readiness.head);
  git(["-C", repo, "update-ref", "HEAD", corpus.readiness.head]);
  git(["-C", repo, "worktree", "add", "-q", "-b", "worker", worker, corpus.readiness.head]);
  git(["-C", repo, "worktree", "add", "-q", "-b", "other", other, corpus.readiness.head]);
  return { repo, worker, other, git };
}

test("worker の観測を旧 readiness bytes で保存し、親が同じ linked checkout だけを受け入れる", () => {
  withDirectory((directory) => {
    const { repo, worker, other } = readinessFixture(directory);
    const observation = resolve(directory, "observation.json");
    const context = ["--task", "task-1", "--dispatch", "dispatch-1", "--assignee", "term-1"];
    const env = {
      ...process.env,
      GIT_DIR: resolve(directory, "poison"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree",
      GIT_CONFIG_VALUE_0: resolve(directory, "wrong-worktree"),
    };
    const record = spawnSync(readiness, ["record", observation, ...context], {
      cwd: worker,
      env,
      encoding: "utf8",
    });
    expect(record.status, record.stderr).toBe(0);
    expect(record.stdout).toBe(corpus.readiness.stdout);
    const raw = Buffer.from(corpus.readiness.base64, "base64");
    expect(createHash("sha256").update(raw).digest("hex")).toBe(corpus.readiness.sha256);
    // Git の実体 path だけを現在の fixture に対応させ、旧 serialization を期待値にする。
    const expected = raw.toString().replaceAll(corpus.readiness.base, fs.realpathSync(directory));
    expect(fs.readFileSync(observation, "utf8")).toBe(expected);
    const duplicate = spawnSync(readiness, ["record", observation, ...context], {
      cwd: worker,
      encoding: "utf8",
    });
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("EEXIST");
    expect(fs.readFileSync(observation, "utf8")).toBe(expected);
    const verify = (path: string, branch: string, task = "task-1") =>
      spawnSync(
        readiness,
        [
          "verify",
          observation,
          "--worktree",
          path,
          "--branch",
          branch,
          "--head",
          corpus.readiness.head,
          "--task",
          task,
          "--dispatch",
          "dispatch-1",
          "--assignee",
          "term-1",
        ],
        { cwd: directory, env, encoding: "utf8" },
      );
    const accepted = verify(worker, "worker");
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toBe("preflight OK: worker checkout matches assigned worktree\n");
    const mismatched = verify(other, "other");
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain("cwd が期待値と一致しません");
    const primary = verify(repo, "main");
    expect(primary.status).toBe(1);
    expect(primary.stderr).toContain("割当先が linked worktree ではありません");
    const wrongTask = verify(worker, "worker", "other-task");
    expect(wrongTask.status).toBe(1);
    expect(wrongTask.stderr).toContain("Task ID が期待値と一致しません");
    expect(fs.readFileSync(observation, "utf8")).toBe(expected);
    const invalid: [string, string][] = [
      [
        expected.replace(
          '"schema": "orca-worker-readiness-observation/v1"',
          '"schema": "unknown/v2"',
        ),
        "schema が不正",
      ],
      [expected.replace('"schema":', '"extra": true, "schema":'), "schema が不正"],
      [
        expected.replace('"branch": "worker"', '"branch": "worker", "br\\u0061nch": "worker"'),
        "重複キー",
      ],
      [
        expected.replace('"head": "' + corpus.readiness.head + '"', '"head": ""'),
        "head が空または不正",
      ],
      [expected.replace('"branch": "worker"', '"branch": 42'), "branch が空または不正"],
      [expected.replace('"task_id": "task-1"', '"task_id": ""'), "task_id が空または不正"],
    ];
    for (const [bytes, diagnostic] of invalid) {
      fs.writeFileSync(observation, bytes);
      const rejected = verify(worker, "worker");
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain(diagnostic);
      expect(fs.readFileSync(observation, "utf8")).toBe(bytes);
    }
  });
}, 15_000);
