import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { resolve } from "node:path";
import corpus from "../fixtures/peer-coordination-python.json";
import ownedCorpus from "../fixtures/peer-owned-python.json";
import responseCorpus from "../fixtures/peer-response-python.json";

const root = resolve(import.meta.dir, "../..");
const preflight = resolve(root, "skills/orca-peer-refactor/scripts/orca-preflight");
function withDirectory(action: (directory: string) => void) {
  try {
    fs.mkdirSync("/tmp/codex", { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const shared = fs.lstatSync("/tmp/codex");
  if (!shared.isDirectory() || shared.uid !== process.getuid!())
    throw new Error("テスト共有先は実 owner の directory が必要です");
  const directory = fs.mkdtempSync("/tmp/codex/peer-coordination-39-");
  try {
    action(directory);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
}

test("Orca の native receipt を旧 corpus と同じ ID・状態で検査し、重複キーを拒否する", () => {
  withDirectory((directory) => {
    const path = resolve(directory, "receipt.json");
    for (const item of corpus.receipts) {
      const bytes = Buffer.from(item.base64, "base64");
      fs.writeFileSync(path, bytes);
      const result = spawnSync(preflight, [item.args[0]!, path, ...item.args.slice(1)], {
        cwd: directory,
        encoding: "utf8",
      });
      expect(result.status, item.name + ": " + result.stderr).toBe(
        item.tightened ? 1 : item.status,
      );
      if (item.tightened) expect(result.stderr).toContain("重複キー");
      else {
        expect(result.stdout, item.name).toBe(item.stdout);
        expect(result.stderr, item.name).toBe(item.stderr);
      }
      expect(fs.readFileSync(path)).toEqual(bytes);
    }
  });
}, 15_000);

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
    const record = spawnSync(preflight, ["worker-readiness", "record", observation, ...context], {
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
    const duplicate = spawnSync(
      preflight,
      ["worker-readiness", "record", observation, ...context],
      { cwd: worker, encoding: "utf8" },
    );
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("EEXIST");
    expect(fs.readFileSync(observation, "utf8")).toBe(expected);
    const verify = (path: string, branch: string, task = "task-1") =>
      spawnSync(
        preflight,
        [
          "worker-readiness",
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

test("両 peer の変更所有範囲は Python なしで旧 corpus の行範囲・Unicode・順序を維持する", () => {
  withDirectory((directory) => {
    const { repo, git } = readinessFixture(directory);
    fs.writeFileSync(resolve(repo, "a.txt"), "1\n2\n3\n4\n5\n");
    git(["-C", repo, "add", "a.txt"]);
    git([
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "owned base",
    ]);
    fs.writeFileSync(resolve(repo, "a.txt"), "1\n2\nX\n4\n5\n");
    fs.writeFileSync(resolve(repo, "new.txt"), "1\n2");
    const commands = resolve(directory, "bin");
    fs.mkdirSync(commands);
    fs.writeFileSync(
      resolve(commands, "python3"),
      '#!/bin/sh\necho "Python 実行を検出" >&2\nexit 87\n',
      { mode: 0o700 },
    );
    for (const item of ownedCorpus.cases) {
      if (item.extras)
        for (const name of ["𐀀.txt", "\ue000.txt"])
          fs.writeFileSync(resolve(repo, name), "extra\n");
      for (const peer of ["herdr-peer-refactor", "orca-peer-refactor"]) {
        const result = spawnSync(
          resolve(root, `skills/${peer}/scripts/check-owned.sh`),
          [repo, "HEAD", item.owned],
          { encoding: "utf8", env: { ...process.env, PATH: commands + ":" + process.env.PATH } },
        );
        expect(result.status, peer + ": " + item.owned + ": " + result.stderr).toBe(item.status);
        expect(result.stdout).toBe(item.stdout);
        expect(result.stderr).toBe(item.stderr);
      }
    }
  });
}, 20_000);

test("変更所有範囲の整数は旧 Python の4300桁上限を超えた宣言を拒否する", () => {
  withDirectory((directory) => {
    const { repo } = readinessFixture(directory);
    fs.writeFileSync(resolve(repo, "a.txt"), "line\n");
    for (const peer of ["herdr-peer-refactor", "orca-peer-refactor"]) {
      const script = resolve(root, `skills/${peer}/scripts/check-owned.sh`);
      const control = spawnSync(script, [repo, "HEAD", "a.txt:1-" + "9".repeat(4300)], {
        encoding: "utf8",
      });
      expect(control.status, control.stderr).toBe(0);
      const rejected = spawnSync(script, [repo, "HEAD", "a.txt:1-" + "9".repeat(4301)], {
        encoding: "utf8",
      });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("4300");
    }
  });
});

test("peer-request は Python なしで旧 terminal 応答の nonce・本文・最後の END を検査する", () => {
  withDirectory((directory) => {
    const commands = resolve(directory, "bin");
    fs.mkdirSync(commands);
    fs.writeFileSync(resolve(commands, "python3"), "#!/bin/sh\nexit 87\n", { mode: 0o700 });
    fs.writeFileSync(
      resolve(commands, "herdr"),
      '#!/bin/sh\ncase "$2" in\nprompt|get) printf \'%s\\n\' \'{"agent_status":"idle"}\' ;;\nread) cat "$PEER_TRANSCRIPT" ;;\n*) exit 89 ;;\nesac\n',
      { mode: 0o700 },
    );
    const request = resolve(directory, "request.md");
    fs.writeFileSync(request, "review\n");
    for (const item of responseCorpus.cases) {
      const transcript = resolve(directory, item.name + ".txt");
      fs.writeFileSync(transcript, item.text);
      const work = resolve(directory, item.name);
      fs.mkdirSync(work);
      const result = spawnSync(
        resolve(root, "skills/herdr-peer-refactor/scripts/peer-request.sh"),
        ["peer", "REQ-1", "abc1234", work, request],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: commands + ":" + process.env.PATH,
            PEER_TRANSCRIPT: transcript,
            PEER_SETTLE_S: "0",
            PEER_REQUEST_TEST_NONCE: "fixture-nonce",
          },
        },
      );
      expect(result.status, item.name + ": " + result.stderr).toBe(item.status === 0 ? 0 : 12);
      const response = resolve(work, "REQ-1.md");
      if (item.status === 0) {
        expect(result.stdout.trim()).toBe(response);
        expect(fs.readFileSync(response)).toEqual(Buffer.from(item.base64, "base64"));
      } else {
        expect(result.stderr).toContain("missing");
        expect(fs.existsSync(response)).toBe(false);
      }
      expect(fs.readdirSync(work).some((name) => name.includes(".term."))).toBe(false);
    }
  });
}, 20_000);

test("Orca 手順は独立した Run と照合し、検査済み worker receipt だけを公開・再利用する", () => {
  withDirectory((directory) => {
    const commands = resolve(directory, "bin");
    fs.mkdirSync(commands);
    const calls = resolve(directory, "calls.jsonl");
    fs.writeFileSync(
      resolve(commands, "orca-fixture"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ORCA_CALLS, JSON.stringify(args) + '\\n');
if (args[1] === 'worker-show') process.stdout.write(process.env.WORKER_OUTPUT);
else process.stdout.write(JSON.stringify({result:{runId:'run-1'}}));
process.exit(0);
`,
      { mode: 0o700 },
    );
    const run = resolve(directory, "run");
    fs.mkdirSync(run);
    fs.writeFileSync(
      resolve(run, "run-create.json"),
      JSON.stringify({
        ok: true,
        result: { run: { id: "run-1", coordinator_handle: "parent-1" } },
      }),
    );
    const started = {
      ok: true,
      result: {
        dispatchId: "dispatch-1",
        taskId: "task-1",
        effects: [{ kind: "terminal", role: "agent", id: "worker-1" }],
      },
    };
    const valid = JSON.stringify({
      ok: true,
      result: {
        dispatch: {
          id: "dispatch-1",
          taskId: "task-1",
          assigneeHandle: "worker-1",
          status: "dispatched",
        },
      },
    });
    const queries = () =>
      fs.existsSync(calls)
        ? fs
            .readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter((args) => args[1] === "worker-show").length
        : 0;
    for (const [name, output, startReceipt] of [
      ["valid", valid, started],
      ["valid-null-error", valid, { ...started, error: null }],
      ["malformed", '{"ok":', started],
      ["rejected", '{"ok":false,"result":{}}', started],
      ["mismatch", valid.replace("dispatch-1", "dispatch-other"), started],
      ["failed-start", valid, { ...started, ok: false }],
      ["errored-start", valid, { ...started, error: { code: "failed" } }],
      ["missing-ok-start", valid, { result: started.result }],
      ["non-boolean-ok-start", valid, { ...started, ok: "true" }],
      ["null-start", valid, null],
      ["array-start", valid, []],
    ] as const) {
      const receipt = resolve(directory, name);
      fs.mkdirSync(receipt);
      const startedPath = resolve(receipt, "worker-start.json"),
        startBytes = JSON.stringify(startReceipt);
      fs.writeFileSync(startedPath, startBytes);
      const invoke = () =>
        spawnSync(
          resolve(root, "lib/bun/run"),
          [
            "run",
            resolve(root, "skills/orca-peer-refactor/scripts/verify-orca-receipts.ts"),
            run,
            receipt,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: commands + ":" + process.env.PATH,
              ORCA_CLI: "orca-fixture",
              ORCA_TERMINAL_HANDLE: "parent-1",
              ORCA_CALLS: calls,
              WORKER_OUTPUT: output,
            },
          },
        );
      const before = queries(),
        result = invoke();
      const final = resolve(receipt, "worker-show.json"),
        part = final + ".part";
      if (name.endsWith("-start")) {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("worker-start receipt が成功応答ではありません");
        expect(fs.existsSync(final)).toBe(false);
        expect(fs.existsSync(part)).toBe(false);
        expect(fs.readFileSync(startedPath, "utf8")).toBe(startBytes);
        expect(queries()).toBe(before);
        continue;
      }
      if (name.startsWith("valid")) {
        expect(result.status, result.stderr).toBe(0);
        expect(fs.readFileSync(final, "utf8")).toBe(output);
        const repeated = invoke();
        expect(repeated.status, repeated.stderr).toBe(0);
      } else {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("preflight 拒否");
        expect(fs.existsSync(final)).toBe(false);
        expect(fs.readFileSync(part, "utf8")).toBe(output);
        const repeated = invoke();
        expect(repeated.status).toBe(1);
        expect(repeated.stderr).toContain("未確定の receipt");
        expect(fs.readFileSync(part, "utf8")).toBe(output);
      }
      expect(queries()).toBe(before + 1);
    }
  });
}, 15_000);

test("手順の JSON 検査は入れ子・escape 後の重複と旧 Python の整数桁数超過を拒否する", () => {
  withDirectory((directory) => {
    const invoke = (input: string) =>
      spawnSync(
        resolve(root, "lib/bun/run"),
        ["run", resolve(root, "lib/bun/coordination-json.ts"), "-"],
        { cwd: directory, input, encoding: "utf8" },
      );
    for (const [input, diagnostic] of [
      ['{"a":[{"x":1},{"x":2}],"text":"\\\"x\\\":3"}', ""],
      ['{"outer":[{"x":1,"\\u0078":2}]}', "重複キー"],
      ['{"ok":true,"ok":true}', "重複キー"],
      ['{"number":' + "1".repeat(4300) + "}", ""],
      ['{"number":' + "1".repeat(4301) + "}", "4300"],
      ['{"text":"\\\"' + "1".repeat(100_000) + '\\u0031"}', ""],
      ['{"number":-' + "1".repeat(100_000) + "}", "4300"],
      ['{"number":' + "1".repeat(100_000) + ".0}", ""],
      ['{"number":' + "1".repeat(100_000) + "e1}", ""],
      ['{"number":' + "1".repeat(100_000) + ',"truncated":', "4300"],
    ]) {
      const result = invoke(input!);
      expect(result.status, result.stderr).toBe(diagnostic ? 1 : 0);
      if (diagnostic) expect(result.stderr).toContain(diagnostic);
      expect(result.stdout).toBe("");
    }
  });
});

test("coordination helper は Python・compiler・native cache がない読み取り専用 payload から安全に起動する", () => {
  withDirectory((directory) => {
    const { worker } = readinessFixture(directory);
    const payload = resolve(directory, "payload"),
      commands = resolve(directory, "bin"),
      poison = resolve(directory, "poison");
    fs.mkdirSync(resolve(payload, "lib"), { recursive: true });
    fs.cpSync(resolve(root, "lib/bun"), resolve(payload, "lib/bun"), { recursive: true });
    for (const peer of ["herdr-peer-refactor", "orca-peer-refactor"]) {
      const scripts = resolve(payload, `skills/${peer}/scripts`);
      fs.mkdirSync(scripts, { recursive: true });
      const names = [
        "check-owned.sh",
        "check-owned.ts",
        ...(peer.startsWith("orca")
          ? ["orca-preflight", "orca-preflight.ts", "verify-orca-receipts.ts"]
          : ["peer-request.sh"]),
      ];
      for (const name of names)
        fs.copyFileSync(resolve(root, `skills/${peer}/scripts/${name}`), resolve(scripts, name));
    }
    fs.mkdirSync(commands);
    fs.mkdirSync(poison);
    for (const name of [
      "bun",
      "bash",
      "git",
      "dirname",
      "readlink",
      "cat",
      "head",
      "awk",
      "od",
      "tr",
      "mkdir",
      "perl",
      "date",
      "grep",
      "mv",
      "rm",
      "sleep",
    ]) {
      fs.symlinkSync(
        fs.realpathSync(name === "bun" ? process.execPath : Bun.which(name)!),
        resolve(commands, name),
      );
    }
    const marker = resolve(poison, "preload-ran"),
      preload = resolve(poison, "preload.ts");
    fs.writeFileSync(
      preload,
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unexpected");`,
    );
    fs.writeFileSync(
      resolve(worker, "bunfig.toml"),
      `preload=[${JSON.stringify(preload)}]\n[install]\nauto="force"\n`,
    );
    fs.writeFileSync(resolve(worker, ".env"), "ORCA_TERMINAL_HANDLE=poison\n");
    fs.writeFileSync(
      resolve(commands, "herdr"),
      "#!/bin/sh\ncase \"$2\" in\nprompt|get) printf '%s\\n' '{\"agent_status\":\"idle\"}' ;;\nread) printf '%s\\n' 'DONE REQ-1 abc1234 fixture-nonce' '  literal body' 'END REQ-1 fixture-nonce' ;;\n*) exit 89 ;;\nesac\n",
      { mode: 0o700 },
    );
    fs.writeFileSync(
      resolve(commands, "orca-fixture"),
      '#!/bin/sh\ncase "$2" in\ncheck) printf \'%s\\n\' \'{"result":{"runId":"run-1"}}\' ;;\nworker-show) printf \'%s\\n\' \'{"ok":true,"result":{"dispatch":{"id":"dispatch-1","taskId":"task-1","assigneeHandle":"worker-1","status":"dispatched"}}}\' ;;\n*) exit 89 ;;\nesac\n',
      { mode: 0o700 },
    );
    const paths = [
      payload,
      ...fs
        .readdirSync(payload, { recursive: true, encoding: "utf8" })
        .map((name) => resolve(payload, name)),
    ];
    for (const path of paths) {
      const info = fs.statSync(path);
      fs.chmodSync(path, info.isDirectory() || info.mode & 0o111 ? 0o555 : 0o444);
    }
    const state = () =>
      JSON.stringify(
        paths.map((path) => {
          const info = fs.statSync(path);
          return [
            path,
            info.mode,
            info.isFile()
              ? createHash("sha256").update(fs.readFileSync(path)).digest("hex")
              : fs.readdirSync(path).sort(),
          ];
        }),
      );
    const before = state();
    const env = {
      ...process.env,
      PATH: commands,
      HOME: poison,
      BUN_OPTIONS: `--preload=${preload}`,
      NODE_OPTIONS: `--require=${preload}`,
      BASH_ENV: preload,
      TREFLEBONBON_FILE_SAFETY_DIR: resolve(directory, "absent-native-cache"),
      ORCA_CLI: "orca-fixture",
      ORCA_TERMINAL_HANDLE: "parent-1",
      PEER_SETTLE_S: "0",
      PEER_REQUEST_TEST_NONCE: "fixture-nonce",
    };
    const invoke = (command: string, args: string[], input?: string) => {
      const result = spawnSync(command, args, { cwd: worker, env, input, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result;
    };
    try {
      const checker = resolve(payload, "skills/orca-peer-refactor/scripts/orca-preflight"),
        observation = resolve(directory, "observation.json");
      const context = ["--task", "task-1", "--dispatch", "dispatch-1", "--assignee", "worker-1"];
      invoke(checker, ["worker-readiness", "record", observation, ...context]);
      invoke(checker, [
        "worker-readiness",
        "verify",
        observation,
        ...context,
        "--worktree",
        worker,
        "--branch",
        "worker",
        "--head",
        corpus.readiness.head,
      ]);
      for (const peer of ["herdr-peer-refactor", "orca-peer-refactor"])
        invoke(resolve(payload, `skills/${peer}/scripts/check-owned.sh`), [
          worker,
          "HEAD",
          "bunfig.toml,.env",
        ]);
      const runner = resolve(payload, "lib/bun/run");
      invoke(
        runner,
        ["run", resolve(payload, "lib/bun/coordination-json.ts"), "-"],
        '{"ok":true}\n',
      );
      const response = invoke(
        runner,
        ["run", resolve(payload, "lib/bun/peer-response.ts"), "DONE", "START", "END"],
        "START\n  body\nEND\n",
      );
      expect(response.stdout).toBe("DONE\nbody\n");
      const request = resolve(directory, "request.md"),
        work = resolve(directory, "work");
      fs.writeFileSync(request, "review\n");
      invoke(resolve(payload, "skills/herdr-peer-refactor/scripts/peer-request.sh"), [
        "peer",
        "REQ-1",
        "abc1234",
        work,
        request,
      ]);
      expect(fs.readFileSync(resolve(work, "REQ-1.md"), "utf8")).toBe(
        "DONE REQ-1 abc1234\nliteral body\n",
      );
      const run = resolve(directory, "run"),
        receipt = resolve(directory, "receipt");
      fs.mkdirSync(run);
      fs.mkdirSync(receipt);
      fs.writeFileSync(
        resolve(run, "run-create.json"),
        '{"ok":true,"result":{"run":{"id":"run-1","coordinator_handle":"parent-1"}}}',
      );
      fs.writeFileSync(
        resolve(receipt, "worker-start.json"),
        '{"ok":true,"result":{"dispatchId":"dispatch-1","taskId":"task-1","effects":[{"kind":"terminal","role":"agent","id":"worker-1"}]}}',
      );
      invoke(runner, [
        "run",
        resolve(payload, "skills/orca-peer-refactor/scripts/verify-orca-receipts.ts"),
        run,
        receipt,
      ]);
      expect(fs.existsSync(resolve(receipt, "worker-show.json"))).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.existsSync(env.TREFLEBONBON_FILE_SAFETY_DIR)).toBe(false);
      expect(state()).toBe(before);
    } finally {
      for (const path of paths) if (fs.statSync(path).isDirectory()) fs.chmodSync(path, 0o700);
    }
  });
}, 15_000);
