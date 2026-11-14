import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { resolve } from "node:path";
import legacy from "../fixtures/plugin-smoke-python.json";

const root = resolve(import.meta.dir, "../.."),
  node = Bun.which("node")!,
  npm = fs.realpathSync(Bun.which("npm")!);

function fixture(action: (directory: string) => void) {
  try {
    fs.mkdirSync("/tmp/codex", { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const shared = fs.lstatSync("/tmp/codex");
  if (!shared.isDirectory() || shared.uid !== process.getuid!())
    throw Error("実 owner の共有 directory が必要です");
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/codex/plugin-smoke-49-"));
  try {
    action(directory);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
}
function run(directory: string, source = root, mode = "success") {
  const commands = resolve(directory, "bin"),
    tape = resolve(directory, "legacy.json"),
    calls = resolve(directory, "calls.jsonl");
  fs.mkdirSync(commands);
  fs.writeFileSync(tape, JSON.stringify(legacy.calls));
  for (const name of ["node", "bash", "sh", "dirname", "readlink"])
    fs.symlinkSync(Bun.which(name)!, resolve(commands, name));
  fs.symlinkSync(process.execPath, resolve(commands, "bun"));
  fs.writeFileSync(
    resolve(commands, "python3"),
    '#!/bin/sh\necho "Python 起動を検出" >&2\nexit 87\n',
    { mode: 0o700 },
  );
  const program = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const source=${JSON.stringify(source)},mode=${JSON.stringify(mode)},callsFile=${JSON.stringify(calls)},tape=JSON.parse(fs.readFileSync(${JSON.stringify(tape)},'utf8'));
const observed=fs.existsSync(callsFile)?fs.readFileSync(callsFile,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[], expected=tape[observed.length];
const name=path.basename(process.argv[1]),args=process.argv.slice(2),privateRoot=path.dirname(process.env.HOME),oldSource=tape.find(call=>call.name==='agy'&&call.args[1]==='validate').args[2],oldPrivate=path.dirname(expected.home);
const normalize=(value,from,home)=>value.split(from).join('@SOURCE@').split(home).join('@PRIVATE@');
assert.equal(name,expected.name);assert.deepEqual(args.map(a=>normalize(a,source,privateRoot)),expected.args.map(a=>normalize(a,oldSource,oldPrivate)));assert.equal(normalize(process.cwd(),source,privateRoot),normalize(expected.cwd,oldSource,oldPrivate));
assert.equal(process.env.TREFLEBONBON_SMOKE_PARENT,undefined);
let output=expected.output.split(oldSource).join(source).split(oldPrivate).join(privateRoot);
if(name==='codex'&&args[0]==='plugin'&&args[1]==='add'){
 const installed=JSON.parse(output).installedPath;fs.cpSync(source,installed,{recursive:true,filter:p=>!['.git','node_modules'].includes(path.basename(p))});
}
if(name==='bats'){assert(args.length>0);for(const file of args)assert(fs.statSync(file).isFile());}
fs.appendFileSync(callsFile,JSON.stringify({name,args,home:process.env.HOME,codexHome:process.env.CODEX_HOME,cwd:process.cwd()})+'\\n');
if(mode==='tamper'&&name==='agy'&&args[1]==='validate')fs.writeFileSync(path.join(source,'tampered.txt'),'fixture');
process.stdout.write(output);
`;
  for (const name of ["claude", "codex", "agy", "bats"])
    if (!(mode === "missing" && name === "codex"))
      fs.writeFileSync(resolve(commands, name), program, { mode: 0o700 });
  const result = spawnSync(node, [npm, "run", "--silent", "test:plugin-cli"], {
    cwd: source,
    env: { ...process.env, PATH: commands, TREFLEBONBON_SMOKE_PARENT: "parent-fixture" },
    maxBuffer: Infinity,
    timeout: 60_000,
  });
  return {
    result,
    calls: fs.existsSync(calls)
      ? fs
          .readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [],
  };
}

test("導入 smoke は Python なしで旧4検査・公式 CLI argv・隔離 HOME・導入物の検査を維持する", () => {
  fixture((directory) => {
    const checked = run(directory);
    expect(
      checked.result.status,
      checked.result.stdout.toString() + checked.result.stderr.toString(),
    ).toBe(0);
    expect(checked.calls.length).toBe(legacy.calls.length);
    expect(new Set(checked.calls.map((call) => call.home)).size).toBe(4);
    expect(checked.result.stderr.toString()).toContain("4 pass");
  });
}, 60_000);

test(
  "導入 smoke は必須 CLI の不足を skip にせず、native 操作前に拒否する",
  () =>
    fixture((directory) => {
      const checked = run(directory, root, "missing");
      expect(checked.result.status).toBe(1);
      expect(checked.result.stderr.toString()).toContain(
        "必要な公式 plugin CLI がありません: codex",
      );
      expect(checked.calls).toEqual([]);
    }),
  60_000,
);

test(
  "導入 smoke は配布元の改変を検出し、成功扱いしない",
  () =>
    fixture((directory) => {
      const source = resolve(directory, "payload");
      fs.cpSync(root, source, {
        recursive: true,
        filter: (path) => ![".git", "node_modules"].includes(path.split("/").at(-1)!),
      });
      const checked = run(directory, source, "tamper");
      expect(checked.result.status).toBe(1);
      expect(checked.result.stderr.toString()).toContain("公式 CLI が配布元を書き換えました");
      expect(fs.readFileSync(resolve(source, "tampered.txt"), "utf8")).toBe("fixture");
    }),
  60_000,
);
