import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { resolve } from "node:path";
import corpus from "../fixtures/plugin-sessions-python.json";

const root = resolve(import.meta.dir, "../..");
const npm = fs.realpathSync(Bun.which("npm")!);
const node = Bun.which("node")!;

test("相対 PATH の CLI 表記と case cwd での inventory 失敗を旧実装どおり保持する", () =>
  withDirectory((directory) => {
    const clients = resolve(directory, "clients"),
      commands = resolve(directory, "bin"),
      output = resolve(directory, "output"),
      calls = resolve(directory, "calls.json");
    fs.mkdirSync(clients);
    fs.mkdirSync(commands);
    for (const name of ["bash", "dirname", "readlink"])
      fs.symlinkSync(Bun.which(name)!, resolve(commands, name));
    fs.symlinkSync(process.execPath, resolve(commands, "bun"));
    const baseline = corpus.cases
      .find((item) => item.args[0] === "run" && item.status === 0)!
      .native!.filter((call) => call.runtime === "agy");
    fs.writeFileSync(
      resolve(clients, "agy"),
      `#!${node}\nconst fs=require('node:fs'),assert=require('node:assert/strict'),calls=${JSON.stringify(baseline)},args=process.argv.slice(2);const previous=fs.existsSync(${JSON.stringify(calls)})?JSON.parse(fs.readFileSync(${JSON.stringify(calls)},'utf8')):[];const call=calls[previous.length];assert.deepEqual(args,call.args);previous.push(args);fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(previous));process.stdout.write(Buffer.from(call.stdout,'base64'));\n`,
      { mode: 0o700 },
    );
    const result = spawnSync(
      resolve(root, "development/plugin-sessions"),
      [
        "run",
        "--runtime",
        "agy",
        "--skill",
        "rop",
        "--installed-root",
        "agy=/installed/plugin",
        "--output-dir",
        output,
      ],
      { cwd: directory, env: { ...process.env, PATH: "clients:bin" }, maxBuffer: Infinity },
    );
    expect(result.status, result.stderr.toString()).toBe(1);
    const report = JSON.parse(result.stdout.toString());
    expect(report.versions.agy.path).toBe("clients/agy");
    expect(report.cases[0].reasons).toEqual(["cli_or_inventory_unavailable"]);
    expect(JSON.parse(fs.readFileSync(calls, "utf8"))).toEqual([["--version"]]);
  }));

test("check は symlink の後ろの .. を kernel と同じ対象へ解決する", () =>
  withDirectory((directory) => {
    const passed = corpus.cases.find((item) => item.args[0] === "check" && item.status === 0)!;
    const failed = corpus.cases.find((item) => item.args[0] === "check" && item.status === 1)!;
    const wanted = resolve(directory, "real/case"),
      decoy = resolve(directory, "case");
    fs.mkdirSync(resolve(directory, "real/subdir"), { recursive: true });
    restore(wanted, passed.before);
    restore(decoy, failed.before);
    const alias = resolve(directory, "alias");
    fs.symlinkSync(resolve(directory, "real/subdir"), alias);
    for (const [path, item] of [
      [wanted, passed],
      [decoy, failed],
      [alias + "/../case", passed],
    ] as const) {
      const result = spawnSync(resolve(root, "development/plugin-sessions"), ["check", path], {
        cwd: directory,
        maxBuffer: Infinity,
      });
      expect(result.status, result.stderr.toString()).toBe(item.status);
      expect(result.stdout).toEqual(Buffer.from(item.stdout, "base64"));
    }
  }));

test("CLI help と省略形を維持し、空の出力先は cwd の payload として拒否する", () => {
  for (const [mode, encoded] of Object.entries(corpus.help))
    for (const flag of ["--help", "--hel"]) {
      const args = mode === "root" ? [flag] : [mode, flag];
      const result = spawnSync(resolve(root, "development/plugin-sessions"), args, {
        cwd: root,
        maxBuffer: Infinity,
      });
      expect(result.status, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString()).toBe(
        Buffer.from(encoded, "base64")
          .toString()
          .replaceAll("plugin_sessions.py", "plugin-sessions"),
      );
    }
  const empty = spawnSync(
    resolve(root, "development/plugin-sessions"),
    ["run", "--output-dir", ""],
    { cwd: root, maxBuffer: Infinity },
  );
  expect(empty.status).toBe(1);
  expect(JSON.parse(empty.stdout.toString()).reasons).toEqual(["output_inside_payload"]);
});

test("run は厳しい umask でも未確認の証跡ファイルを0600で保存する", () => {
  withDirectory((directory) => {
    const commands = resolve(directory, "bin"),
      output = resolve(directory, "output");
    fs.mkdirSync(commands);
    for (const name of ["bash", "dirname", "readlink"])
      fs.symlinkSync(Bun.which(name)!, resolve(commands, name));
    fs.symlinkSync(process.execPath, resolve(commands, "bun"));
    try {
      const result = spawnSync(
        Bun.which("bash")!,
        [
          "-p",
          "-c",
          'umask 0400; exec "$@"',
          "fixture",
          resolve(root, "development/plugin-sessions"),
          "run",
          "--runtime",
          "agy",
          "--skill",
          "rop",
          "--output-dir",
          output,
        ],
        { env: { ...process.env, PATH: commands }, maxBuffer: Infinity },
      );
      expect(result.status, result.stderr.toString()).toBe(1);
      expect(JSON.parse(result.stdout.toString()).cases[0].reasons).toEqual([
        "cli_or_inventory_unavailable",
      ]);
      for (const file of ["summary.json", "agy/rop/inventory.json", "agy/rop/result.json"])
        expect(fs.statSync(resolve(output, file)).mode & 0o777, file).toBe(0o600);
    } finally {
      for (const path of [output, resolve(output, "agy"), resolve(output, "agy/rop")])
        if (fs.existsSync(path)) fs.chmodSync(path, 0o700);
    }
  });
});

function withDirectory(action: (directory: string) => void) {
  try {
    fs.mkdirSync("/tmp/codex", { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const shared = fs.lstatSync("/tmp/codex");
  if (!shared.isDirectory() || shared.uid !== process.getuid!())
    throw new Error("実 owner の共有 directory が必要です");
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/codex/plugin-sessions-49-"));
  try {
    action(directory);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
}

function restore(
  directory: string,
  entries: Record<string, { mode: number; kind: string; base64?: string } | undefined> | null,
) {
  if (!entries) return;
  for (const [name, entry] of Object.entries(entries)) {
    if (!entry) continue;
    const path = resolve(directory, name);
    if (entry.kind === "directory") fs.mkdirSync(path, { recursive: true, mode: entry.mode });
    else fs.writeFileSync(path, Buffer.from(entry.base64!, "base64"), { mode: entry.mode });
  }
}

function snapshot(directory: string) {
  if (!fs.existsSync(directory)) return null;
  return Object.fromEntries(
    [".", ...fs.readdirSync(directory, { recursive: true, encoding: "utf8" })]
      .sort()
      .map((name) => {
        const path = resolve(directory, name),
          info = fs.statSync(path);
        return [
          name,
          info.isDirectory()
            ? { mode: info.mode & 0o777, kind: "directory" }
            : {
                mode: info.mode & 0o777,
                kind: "file",
                base64: fs.readFileSync(path).toString("base64"),
              },
        ];
      }),
  );
}

test("run は旧 corpus の native argv・保存 bytes/mode・失敗と未確認を維持する", () => {
  const successful = corpus.cases.find((item) => item.args[0] === "run" && item.status === 0)!;
  for (const item of corpus.cases
    .filter((item) => item.args[0] === "run")
    .sort((a, b) => a.status - b.status))
    withDirectory((directory) => {
      const output = resolve(directory, "output"),
        clients = resolve(directory, "clients"),
        commands = resolve(directory, "bin"),
        count = resolve(directory, "count"),
        mismatch = resolve(directory, "mismatch");
      fs.mkdirSync(clients);
      fs.mkdirSync(commands);
      for (const name of ["bash", "sh", "dirname", "readlink", "node"])
        fs.symlinkSync(Bun.which(name)!, resolve(commands, name));
      fs.symlinkSync(process.execPath, resolve(commands, "bun"));
      fs.writeFileSync(
        resolve(commands, "python3"),
        '#!/bin/sh\necho "Python 起動を検出" >&2\nexit 87\n',
        { mode: 0o700 },
      );
      const translate = (text: string) =>
        text
          .split(item.output!)
          .join(output)
          .split(item.base!)
          .join(directory)
          .split(corpus.sourceRoot)
          .join(root);
      let native: Array<{
        runtime: string;
        args: string[];
        cwd: string;
        stdout: string;
        stderr: string;
        status: number;
        hang?: boolean;
      }> = item.native ?? [];
      if (item.args.includes("--timeout")) {
        const process = JSON.parse(
          Buffer.from(item.after!["agy/rop/process.json"]!.base64!, "base64").toString(),
        );
        native = [
          {
            runtime: "agy",
            args: ["--version"],
            cwd: root,
            stdout: Buffer.from("fixture 1.0\n").toString("base64"),
            stderr: "",
            status: 0,
          },
          {
            ...successful.native!.find(
              (call) => call.runtime === "agy" && call.args.includes("/skills"),
            )!,
            cwd: item.output! + "/agy/rop",
          },
          {
            runtime: "agy",
            args: process.command.slice(1),
            cwd: item.output! + "/agy/rop",
            stdout: item.after!["agy/rop/events.jsonl"]!.base64!,
            stderr: item.after!["agy/rop/stderr.log"]!.base64!,
            status: 0,
            hang: true,
          },
        ];
      }
      native = native.map((call) => ({
        ...call,
        args: call.args.map(translate),
        cwd: translate(call.cwd),
      }));
      const tape = resolve(directory, "native.json");
      fs.writeFileSync(tape, JSON.stringify(native));
      for (const runtime of new Set(native.map((call) => call.runtime))) {
        const fixture = resolve(directory, runtime + ".cjs");
        fs.writeFileSync(
          fixture,
          `const fs=require('node:fs'),assert=require('node:assert/strict');
const calls=JSON.parse(fs.readFileSync(${JSON.stringify(tape)},'utf8')),counter=${JSON.stringify(count)},mismatch=${JSON.stringify(mismatch)};
const index=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0,call=calls[index];
try{assert.equal(call?.runtime,${JSON.stringify(runtime)});assert.deepEqual(process.argv.slice(2),call.args);assert.equal(process.cwd(),call.cwd);}catch(error){fs.writeFileSync(mismatch,error.message);process.stderr.write('native argv/cwd の不一致\\n');process.exit(91);}
fs.writeFileSync(counter,String(index+1));if(call.removeSelf)fs.unlinkSync(${JSON.stringify(resolve(clients, runtime))});process.stdout.write(Buffer.from(call.stdout,'base64'));process.stderr.write(Buffer.from(call.stderr,'base64'));
if(call.hang)setInterval(()=>{},1000);else if(call.status<0)process.kill(process.pid,-call.status);else process.exit(call.status);
`,
        );
        fs.writeFileSync(
          resolve(clients, runtime),
          `#!/bin/bash -p\nexec '${resolve(root, "lib/bun/run")}' run '${fixture}' "$@"\n`,
          { mode: 0o700 },
        );
      }
      restore(output, item.before);
      const result = spawnSync(
        node,
        [
          npm,
          "run",
          "--silent",
          "test:plugin-sessions",
          "--",
          ...item.args.slice(1).map(translate).toSpliced(0, 0, "run"),
        ],
        {
          cwd: root,
          env: { ...process.env, PATH: clients + ":" + commands },
          maxBuffer: Infinity,
          timeout: 15_000,
        },
      );
      expect(result.status, item.name + ": " + result.stderr.toString()).toBe(item.status);
      expect(result.stdout.toString(), item.name).toBe(
        translate(Buffer.from(item.stdout, "base64").toString()),
      );
      expect(result.stderr.toString(), item.name).toBe(
        translate(Buffer.from(item.stderr, "base64").toString()),
      );
      const expected = Object.fromEntries(
        Object.entries(item.after ?? {}).map(([name, entry]) => [
          name,
          entry!.kind === "file"
            ? {
                ...entry,
                base64: Buffer.from(
                  translate(Buffer.from(entry!.base64!, "base64").toString()),
                ).toString("base64"),
              }
            : entry,
        ]),
      );
      expect(snapshot(output), item.name).toEqual(item.after === null ? null : expected);
      expect(fs.existsSync(mismatch) ? fs.readFileSync(mismatch, "utf8") : "").toBe("");
      expect(fs.existsSync(count) ? Number(fs.readFileSync(count, "utf8")) : 0).toBe(native.length);
    });
}, 60_000);

test("check は Python・native CLI なしで旧 corpus の証跡と診断を維持する", () => {
  withDirectory((directory) => {
    const commands = resolve(directory, "bin"),
      marker = resolve(directory, "unexpected-native");
    fs.mkdirSync(commands);
    for (const command of ["python3", "claude", "codex", "agy"]) {
      fs.writeFileSync(
        resolve(commands, command),
        `#!/bin/sh\necho '${command} 起動を検出' >&2\necho '${command}' >> '${marker}'\nexit 87\n`,
        { mode: 0o700 },
      );
    }
    for (const [index, item] of corpus.cases.entries()) {
      if (item.args[0] !== "check") continue;
      const casePath = resolve(directory, "case-" + index);
      restore(casePath, item.before);
      const result = spawnSync(
        node,
        [npm, "run", "--silent", "test:plugin-sessions", "--", "check", casePath],
        {
          cwd: root,
          env: { ...process.env, PATH: commands + ":" + process.env.PATH },
          maxBuffer: Infinity,
        },
      );
      expect(result.status, item.name + ": " + result.stderr.toString()).toBe(item.status);
      const expected = Buffer.from(item.stdout, "base64");
      expect(createHash("sha256").update(expected).digest("hex")).toBe(item.stdoutHash);
      expect(result.stdout, item.name).toEqual(expected);
      expect(result.stderr, item.name).toEqual(Buffer.from(item.stderr, "base64"));
      for (const [name, entry] of Object.entries(item.before!)) {
        const path = resolve(casePath, name);
        expect(fs.statSync(path).mode & 0o777).toBe(entry.mode);
        if (entry.kind === "file")
          expect(fs.readFileSync(path)).toEqual(Buffer.from(entry.base64!, "base64"));
      }
    }
    expect(fs.existsSync(marker)).toBe(false);
  });
}, 90_000);

test(
  "公開入口は読み取り専用 payload と Python・Node なしの PATH で、ambient 設定を無視して動く",
  () =>
    withDirectory((directory) => {
      const payload = resolve(directory, "payload with spaces"),
        commands = resolve(directory, "bin"),
        cwd = resolve(directory, "cwd"),
        home = resolve(directory, "home"),
        marker = resolve(directory, "preload-ran"),
        preload = resolve(directory, "preload.cjs");
      fs.mkdirSync(resolve(payload, "development"), { recursive: true });
      fs.mkdirSync(resolve(payload, "lib"));
      fs.cpSync(resolve(root, "lib/bun"), resolve(payload, "lib/bun"), { recursive: true });
      for (const name of ["plugin-sessions", "plugin_sessions.ts"])
        fs.copyFileSync(resolve(root, "development", name), resolve(payload, "development", name));
      for (const name of fs.readdirSync(resolve(root, "skills"))) {
        const source = resolve(root, "skills", name, "SKILL.md");
        if (fs.existsSync(source)) {
          fs.mkdirSync(resolve(payload, "skills", name), { recursive: true });
          fs.copyFileSync(source, resolve(payload, "skills", name, "SKILL.md"));
        }
      }
      fs.mkdirSync(resolve(payload, "subdir"));
      fs.mkdirSync(commands);
      fs.mkdirSync(cwd);
      fs.mkdirSync(home);
      for (const name of ["bash", "dirname", "readlink"])
        fs.symlinkSync(Bun.which(name)!, resolve(commands, name));
      fs.symlinkSync(process.execPath, resolve(commands, "bun"));
      const entry = resolve(commands, "plugin-sessions");
      fs.symlinkSync(resolve(payload, "development/plugin-sessions"), entry);
      fs.writeFileSync(
        preload,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'loaded');\n`,
      );
      for (const file of [resolve(cwd, "bunfig.toml"), resolve(home, ".bunfig.toml")])
        fs.writeFileSync(file, `preload = [${JSON.stringify(preload)}]\n`);
      fs.writeFileSync(resolve(cwd, ".env"), `BUN_OPTIONS=--preload=${preload}\n`);
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
      const fingerprint = () =>
          createHash("sha256")
            .update(JSON.stringify(snapshot(payload)))
            .digest("hex"),
        before = fingerprint();
      const environment = {
        ...process.env,
        PATH: commands,
        HOME: home,
        BUN_OPTIONS: `--preload=${preload}`,
        NODE_OPTIONS: `--require=${preload}`,
        BASH_ENV: preload,
        TREFLEBONBON_FILE_SAFETY_DIR: resolve(directory, "native-cache"),
      };
      const invoke = (args: string[]) =>
        spawnSync(entry, args, { cwd, env: environment, maxBuffer: Infinity, timeout: 5000 });
      try {
        for (const runtime of ["claude", "codex", "agy"]) {
          const item = corpus.cases.find(
            (item) =>
              item.args[0] === "check" &&
              item.status === 0 &&
              JSON.parse(Buffer.from(item.stdout, "base64").toString()).runtime === runtime,
          )!;
          const casePath = resolve(directory, runtime);
          restore(casePath, item.before);
          const result = invoke(["check", casePath]);
          expect(result.status, result.stderr.toString()).toBe(0);
          expect(result.stdout).toEqual(Buffer.from(item.stdout, "base64"));
        }
        const output = resolve(directory, "output"),
          result = invoke(["run", "--output-dir", output]);
        expect(result.status, result.stderr.toString()).toBe(1);
        const missing = corpus.cases.find(
          (item) =>
            item.args[0] === "run" &&
            JSON.parse(Buffer.from(item.stdout, "base64").toString()).expected === 36,
        )!;
        expect(result.stdout).toEqual(Buffer.from(missing.stdout, "base64"));
        expect(fs.statSync(resolve(output, "summary.json")).mode & 0o777).toBe(0o600);
        const alias = resolve(directory, "inside");
        fs.symlinkSync(resolve(payload, "subdir"), alias);
        for (const destination of [alias + "/evidence", alias + "/../evidence"]) {
          const refused = invoke(["run", "--output-dir", destination]);
          expect(refused.status).toBe(1);
          expect(JSON.parse(refused.stdout.toString()).reasons).toEqual(["output_inside_payload"]);
        }
        for (let index = 0; index < 45; index++)
          fs.symlinkSync(
            index === 44 ? payload : resolve(directory, "chain-" + (index + 1)),
            resolve(directory, "chain-" + index),
          );
        const deep = invoke(["run", "--output-dir", resolve(directory, "chain-0") + "/evidence"]);
        expect(deep.status).toBe(1);
        expect(JSON.parse(deep.stdout.toString()).reasons).toEqual(["output_inside_payload"]);
        fs.mkdirSync(resolve(directory, "child"));
        fs.symlinkSync(resolve(directory, "child"), resolve(directory, "again"));
        const repeated = invoke([
          "run",
          "--output-dir",
          resolve(directory, "again") + "/../again/output",
        ]);
        expect(repeated.status).toBe(1);
        expect(JSON.parse(repeated.stdout.toString()).expected).toBe(36);
        fs.symlinkSync(resolve(directory, "cycle-b"), resolve(directory, "cycle-a"));
        fs.symlinkSync(resolve(directory, "cycle-a"), resolve(directory, "cycle-b"));
        const cycle = invoke(["run", "--output-dir", resolve(directory, "cycle-a") + "/evidence"]);
        expect(cycle.status).toBe(1);
        expect(JSON.parse(cycle.stdout.toString()).reasons).toEqual(["execution_unconfirmed"]);
        expect(fingerprint()).toBe(before);
        expect(fs.existsSync(marker)).toBe(false);
        expect(fs.existsSync(environment.TREFLEBONBON_FILE_SAFETY_DIR)).toBe(false);
      } finally {
        for (const path of paths) if (fs.statSync(path).isDirectory()) fs.chmodSync(path, 0o700);
      }
    }),
  15_000,
);
