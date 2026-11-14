import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { resolve } from "node:path";
import corpus from "../fixtures/gh-review-thread-python.json";

const root = resolve(import.meta.dir, "../..");
const script = resolve(root, "bin/gh-review-thread");
function withDirectory(action: (directory: string) => void) {
  try {
    fs.mkdirSync("/tmp/codex", { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const shared = fs.lstatSync("/tmp/codex");
  if (!shared.isDirectory() || shared.uid !== process.getuid!())
    throw new Error("比較 fixture は実 owner の共有 directory が必要です");
  const directory = fs.mkdtempSync("/tmp/codex/gh-review-thread-42-");
  try {
    action(directory);
  } finally {
    for (const name of fs.readdirSync(directory, { recursive: true, encoding: "utf8" })) {
      const path = resolve(directory, name);
      if (fs.lstatSync(path).isDirectory()) fs.chmodSync(path, 0o700);
    }
    fs.rmSync(directory, { recursive: true });
  }
}

function snapshot(directory: string) {
  return ["", ...fs.readdirSync(directory, { recursive: true, encoding: "utf8" })]
    .sort()
    .map((name) => {
      const path = resolve(directory, name),
        info = fs.lstatSync(path);
      return [
        name,
        info.mode,
        info.isFile() ? createHash("sha256").update(fs.readFileSync(path)).digest("hex") : null,
      ];
    });
}

function replay(item: (typeof corpus.cases)[number], isolated = false) {
  withDirectory((directory) => {
    const commands = resolve(directory, "bin"),
      queue = resolve(directory, "queue.json"),
      count = resolve(directory, "count"),
      mismatch = resolve(directory, "mismatch");
    fs.mkdirSync(commands);
    fs.writeFileSync(queue, JSON.stringify(item.calls));
    if (!isolated)
      fs.writeFileSync(
        resolve(commands, "python3"),
        '#!/bin/sh\necho "Python 起動を検出" >&2\nexit 87\n',
        { mode: 0o700 },
      );
    const fake = resolve(directory, "gh-fixture.cjs");
    const fakeSource = `
const fs=require('node:fs'), assert=require('node:assert/strict');
const calls=JSON.parse(fs.readFileSync(process.env.REVIEW_QUEUE,'utf8'));
const index=fs.existsSync(process.env.REVIEW_COUNT)?Number(fs.readFileSync(process.env.REVIEW_COUNT,'utf8')):0;
fs.writeFileSync(process.env.REVIEW_COUNT,String(index+1));
try { assert.deepEqual(process.argv.slice(2),calls[index]?.args); }
catch(error) { fs.writeFileSync(process.env.REVIEW_MISMATCH,error.message); process.stderr.write('fake gh の argv 不一致\\n'); process.exit(91); }
process.stdout.write(Buffer.from(calls[index].stdout,'base64'));
process.stderr.write(Buffer.from(calls[index].stderr,'base64'));
process.exit(calls[index].status);
`;
    fs.writeFileSync(fake, "#!/usr/bin/env node\n" + fakeSource, { mode: 0o700 });
    fs.symlinkSync(fake, resolve(commands, "gh"));
    let entrypoint = script;
    const payload = resolve(directory, "payload with spaces"),
      marker = resolve(directory, "preload-ran"),
      cache = resolve(directory, "native-cache"),
      preload = resolve(directory, "preload.cjs"),
      home = resolve(directory, "home");
    if (isolated) {
      fs.mkdirSync(resolve(payload, "lib"), { recursive: true });
      fs.cpSync(resolve(root, "lib/bun"), resolve(payload, "lib/bun"), { recursive: true });
      fs.mkdirSync(resolve(payload, "bin"));
      fs.copyFileSync(script, resolve(payload, "bin/gh-review-thread"));
      entrypoint = resolve(commands, "review-thread");
      fs.symlinkSync(resolve(payload, "bin/gh-review-thread"), entrypoint);
      for (const name of ["bash", "dirname", "readlink"])
        fs.symlinkSync(Bun.which(name)!, resolve(commands, name));
      fs.symlinkSync(process.execPath, resolve(commands, "bun"));
      fs.mkdirSync(home);
      fs.writeFileSync(
        preload,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');\n`,
      );
      const config = `preload = [${JSON.stringify(preload)}]\n`;
      fs.writeFileSync(resolve(directory, "bunfig.toml"), config);
      fs.writeFileSync(resolve(home, ".bunfig.toml"), config);
      fs.writeFileSync(resolve(directory, ".env"), `BUN_OPTIONS=--preload=${preload}\n`);
      // fake gh も同じ安全な runner から起動し、Node を PATH に加えない。
      fs.writeFileSync(
        fake,
        `#!/bin/bash -p\nexec '${resolve(payload, "lib/bun/run")}' run '${resolve(directory, "gh-fixture-source.cjs")}' "$@"\n`,
      );
      fs.writeFileSync(resolve(directory, "gh-fixture-source.cjs"), fakeSource);
      for (const name of ["", ...fs.readdirSync(payload, { recursive: true, encoding: "utf8" })]) {
        const path = resolve(payload, name),
          info = fs.statSync(path);
        fs.chmodSync(path, info.isDirectory() || info.mode & 0o111 ? 0o555 : 0o444);
      }
    }
    const before = isolated ? snapshot(payload) : null;
    const body = resolve(directory, "reply.md");
    if (item.body)
      fs.writeFileSync(body, Buffer.from(item.body.base64, "base64"), { mode: item.body.mode });
    const start = Date.now();
    const result = spawnSync(
      entrypoint,
      item.args.map((arg) => (arg === "@BODY@" ? body : arg)),
      {
        cwd: directory,
        env: {
          ...process.env,
          PATH: isolated ? commands : commands + ":" + process.env.PATH,
          ...(isolated
            ? {
                HOME: home,
                BUN_OPTIONS: `--preload=${preload}`,
                NODE_OPTIONS: `--require=${preload}`,
                BASH_ENV: preload,
                TREFLEBONBON_FILE_SAFETY_DIR: cache,
              }
            : {}),
          REVIEW_QUEUE: queue,
          REVIEW_COUNT: count,
          REVIEW_MISMATCH: mismatch,
        },
        maxBuffer: Infinity,
      },
    );
    expect(result.status, item.name + ": " + result.stderr.toString()).toBe(item.status);
    const expected = Buffer.from(item.stdout, "base64");
    expect(createHash("sha256").update(expected).digest("hex")).toBe(item.stdoutHash);
    let output = result.stdout.toString();
    if (item.args.includes("--checks") && result.status === 0) {
      const original = JSON.parse(expected.toString()).checks.observed_at,
        observed = JSON.parse(output).checks.observed_at;
      expect(observed).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
      expect(Date.parse(observed)).toBeGreaterThanOrEqual(start - 1000);
      expect(Date.parse(observed)).toBeLessThanOrEqual(Date.now() + 1000);
      output = output.replace(JSON.stringify(observed), JSON.stringify(original));
    }
    expect(output, item.name).toBe(expected.toString());
    const diagnostic = (item as typeof item & { diagnostic?: string }).diagnostic;
    if (diagnostic) expect(result.stderr.toString()).toContain(diagnostic);
    else expect(result.stderr).toEqual(Buffer.from(item.stderr, "base64"));
    expect(fs.existsSync(mismatch) ? fs.readFileSync(mismatch, "utf8") : "", item.name).toBe("");
    expect(fs.existsSync(count) ? Number(fs.readFileSync(count, "utf8")) : 0, item.name).toBe(
      item.calls.length,
    );
    if (item.body) {
      expect(fs.readFileSync(body)).toEqual(Buffer.from(item.body.base64, "base64"));
      expect(fs.statSync(body).mode & 0o777).toBe(item.body.mode);
    }
    if (isolated) {
      expect(snapshot(payload)).toEqual(before!);
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.existsSync(cache)).toBe(false);
      expect(fs.readdirSync(home)).toEqual([".bunfig.toml"]);
    }
  });
}

test("inspect は Python なしで旧 corpus の出力・全ページ・plain・check 集約と gh argv を維持する", () => {
  for (const item of corpus.cases.filter(
    (item) => item.args[0] === "inspect" && item.scenario !== "追加の旧 CLI 実測",
  ))
    replay(item);
}, 60_000);

test("reply-resolve は旧 corpus の対象・commit・本文検査、重複回避と返信後の resolve を維持する", () => {
  for (const item of corpus.cases.filter(
    (item) => item.args[0] === "reply-resolve" && item.scenario !== "追加の旧 CLI 実測",
  ))
    replay(item);
}, 60_000);

for (const item of corpus.cases.filter((item) => item.scenario === "追加の旧 CLI 実測")) {
  test(`旧 CLI の境界: ${item.name}`, () => replay(item), 10_000);
}

test("公開入口は読み取り専用 payload から Python・Node・compiler・native cache なしで安全に起動する", () => {
  for (const args of [
    ["inspect", "--checks"],
    ["inspect", "--plain"],
    ["reply-resolve", "--commit"],
  ]) {
    const item = corpus.cases.find(
      (item) => args.every((arg) => item.args.includes(arg)) && item.status === 0,
    )!;
    replay(item, true);
  }
}, 30_000);
