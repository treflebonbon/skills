import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const attachments = path.join(packageRoot, "libexec/browser-attachments.mjs");
const owner = path.join(packageRoot, "bin/managed-chrome-owner");
const temporaryRoot = process.env.WSL2_BROWSER_TEST_TMPDIR || "/tmp/codex";

const fixture = async (t) => {
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(temporaryRoot, "attachment-recovery."));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const ownership = path.join(temporary, "owner's state");
  const profile = path.join(temporary, "profile");
  const state = path.join(temporary, "browser-state");
  const powershell = path.join(temporary, "PowerShell's fixture");
  const wslpath = path.join(temporary, "wslpath's fixture");
  const windowsScript = path.join(temporary, "Windows script's fixture.ps1");
  const playwright = path.join(temporary, "playwright.mjs");
  const ownerCommand = path.join(temporary, "owner's cli");
  const ownerCalls = path.join(temporary, "owner-calls");
  const github = path.join(temporary, "github");
  const image = path.join(temporary, "image.png");
  const body = path.join(temporary, "comment.md");
  await mkdir(profile);
  await writeFile(path.join(profile, "authentication"), "fixture-authentication\n");
  await writeFile(state, "managed:headless:4242\n");
  await writeFile(ownerCalls, "");
  await writeFile(image, "fixture-image");
  await writeFile(body, "fixture-comment\n<!-- screenshot-1 -->\n");
  await writeFile(windowsScript, "# fixture script\n");
  await writeFile(
    powershell,
    `#!/usr/bin/env node
const fs=require("node:fs"), args=process.argv.slice(2), state=process.env.FIXTURE_STATE;
if(args[args.indexOf("-Action")+1]==="Start"){
  fs.writeFileSync(state,"managed:"+args[args.indexOf("-Mode")+1]+":4242\\n");
  console.log("started");
}else if(fs.readFileSync(state,"utf8").trim()==="query-failed"){
  console.error("fixture-inspection-failed");process.exitCode=42;
}else{process.stdout.write(fs.readFileSync(state));}
`,
    { mode: 0o700 },
  );
  await writeFile(wslpath, `#!/usr/bin/env node
if(process.argv[2]!=="-w"||process.argv[3]!==process.env.PWCLI_WINDOWS_SCRIPT)throw new Error("Unexpected Windows script path");
console.log(process.argv[3]);\n`, { mode: 0o700 });
  await writeFile(playwright, `import fs from "node:fs";
export const chromium={connectOverCDP:async()=>{
  if(!fs.readFileSync(process.env.FIXTURE_STATE,"utf8").startsWith("managed:"))throw new Error("Unexpected CDP connection");
  return {close:async()=>{},contexts:()=>[{newPage:async()=>({goto:async()=>{},url:()=>"https://github.com/login",close:async()=>{}})}],
    newBrowserCDPSession:async()=>({send:async(method)=>{
      if(method!=="Browser.close")throw new Error("Unexpected CDP command");
      fs.writeFileSync(process.env.FIXTURE_STATE,"absent\\n");
    }})};
}};\n`);
  await writeFile(github, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args.includes("--method"))throw new Error("Unexpected GitHub mutation");
if(args.includes("user"))process.stdout.write("fixture-user");
else if(args.includes("--paginate"))process.stdout.write("");
else process.stdout.write(JSON.stringify({number:42,base:{repo:{full_name:"owner/repo"}}}));
`, { mode: 0o700 });
  await writeFile(
    ownerCommand,
    `#!/usr/bin/env node
const args=process.argv.slice(2);
const action=args[0]==="--identity"?args[2]:args[0];
require("node:fs").appendFileSync(process.env.FIXTURE_OWNER_CALLS,action+"\\n");
if(process.env.FIXTURE_OWNER_FAILURE===action){console.error("fixture-owner-"+action+"-failed");process.exit(42);}
const result=require("node:child_process").spawnSync(${JSON.stringify(owner)},args,{stdio:"inherit"});process.exit(result.status??1);\n`,
    { mode: 0o700 },
  );
  const environment = {
    ...process.env,
    BROWSER_OWNERSHIP_DIR: ownership,
    MANAGED_CHROME_OWNER: ownerCommand,
    PWCLI_POWERSHELL: powershell,
    PWCLI_WSLPATH: wslpath,
    PWCLI_WINDOWS_SCRIPT: windowsScript,
    BROWSER_ATTACHMENTS_PLAYWRIGHT: playwright,
    BROWSER_ATTACHMENTS_GH: github,
    FIXTURE_STATE: state,
    FIXTURE_OWNER_CALLS: ownerCalls,
  };
  const execute = (program, args, overrides = {}) => spawnSync(program, args, {
    encoding: "utf8",
    env: { ...environment, ...overrides },
    timeout: 15_000,
  });
  const successfulOwner = (...args) => {
    const result = execute(owner, args);
    assert.equal(result.status, 0, "所有権 fixture の準備に成功する");
    return result.stdout.trim();
  };
  const [identity, , endpoint] = successfulOwner("locate", "--role", "attachment").split("\t");
  const allocationsFile = path.join(ownership, "allocations.json");
  const allocations = JSON.parse(await readFile(allocationsFile, "utf8"));
  allocations[identity].profile = profile;
  await writeFile(allocationsFile, JSON.stringify(allocations));
  const token = successfulOwner("--identity", identity, "reserve", "--role", "attachment",
    "--id", "shared-attachments", "--pid", String(process.pid), "--mode", "headless",
    "--profile", profile, "--endpoint", endpoint);
  successfulOwner("--identity", identity, "run", token, "--", "true");
  successfulOwner("--identity", identity, "activate", token);
  successfulOwner("--identity", "fixture-other", "reserve", "--role", "playwright", "--id", "other",
    "--pid", String(process.pid), "--mode", "headless", "--profile", path.join(temporary, "other-profile"),
    "--endpoint", "http://127.0.0.1:29998");
  const receipt = path.join(ownership, "attachments/existing.json");
  await mkdir(path.dirname(receipt));
  await writeFile(receipt, '{"phase":"uploaded","asset":"fixture-existing"}\n');
  await writeFile(state, "absent\n");
  return {
    identity,
    profile,
    state,
    ownerCommand,
    ownership,
    temporary,
    image,
    body,
    receipt,
    ownerCalls,
    environment,
    execute,
    owner: successfulOwner,
    otherStatus: () => successfulOwner("--identity", "fixture-other", "status"),
    ownerStatus: () => successfulOwner("--identity", identity, "status"),
    attachment: (...args) => execute(process.execPath, [attachments, ...args]),
  };
};

test("終了済み Chrome の close は同じ identity の実行可能な復旧コマンドを示す", async (t) => {
  const scenario = await fixture(t);
  const before = scenario.ownerStatus();
  const result = scenario.attachment("close");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("The requested Chrome is not running; ownership was preserved."));
  const commands = result.stderr.split("\n").filter((line) => line.startsWith("BROWSER_OWNERSHIP_DIR="));
  assert.equal(commands.length, 2, "status と recover の案内を表示する");
  assert.ok(commands.every((command) => command.includes("--identity") && command.includes(scenario.identity)));
  const cleanEnvironment = { BROWSER_OWNERSHIP_DIR: path.join(scenario.ownership, "wrong") };
  for (const key of ["PWCLI_POWERSHELL", "PWCLI_WINDOWS_SCRIPT", "PWCLI_WSLPATH"]) {
    assert.ok(commands.every((command) => command.includes(`${key}=`)), "Windows 照会の上書き設定を案内に含める");
    cleanEnvironment[key] = undefined;
  }
  assert.ok(scenario.ownerStatus() === before, "案内だけでは所有者記録を変更しない");
  const status = scenario.execute("sh", ["-c", commands[0]], cleanEnvironment);
  assert.equal(status.status, 0);
  assert.ok(status.stdout.trim() === before, "引用符を含むパスで同じ記録を照会する");
  const recover = scenario.execute("sh", ["-c", commands[1]], cleanEnvironment);
  assert.equal(recover.status, 0);
  assert.equal(scenario.ownerStatus(), "null");
  assert.equal(scenario.attachment("close").status, 0);
  assert.equal(await readFile(path.join(scenario.profile, "authentication"), "utf8"), "fixture-authentication\n");
});

test("4つの添付操作が復旧案内だけでは記録と既存データを変更しない", async (t) => {
  const scenario = await fixture(t);
  const before = scenario.ownerStatus();
  const other = scenario.otherStatus();
  const inputs = new Map(await Promise.all([scenario.image, scenario.body, scenario.receipt, path.join(scenario.profile, "authentication")]
    .map(async (filename) => [filename, await readFile(filename, "utf8")])));
  const requests = [
    ["close"],
    ["auth"],
    ["upload", "--repo", "owner/repo", "--pr", "42", "--image", scenario.image, "--placeholder", "PLACE", "--request-id", "upload-original"],
    ["comment", "--repo", "owner/repo", "--pr", "42", "--image", scenario.image, "--body-file", scenario.body, "--request-id", "comment-original"],
  ];
  for (const request of requests) {
    const result = scenario.attachment(...request);
    assert.equal(result.status, 1, `${request[0]} は失敗を報告する`);
    const reason = request[0] === "close"
      ? "The requested Chrome is not running; ownership was preserved."
      : request[0] === "auth"
        ? "different mode or incomplete startup"
        : "attachment browser identity changed";
    assert.ok(result.stderr.includes(reason), "意図した所有権の不一致で拒否する");
    assert.equal(result.stderr.split("\n").filter((line) => line.startsWith("BROWSER_OWNERSHIP_DIR=")).length, 2);
    assert.ok(scenario.ownerStatus() === before, "対象の所有者記録を保持する");
    assert.ok(scenario.otherStatus() === other, "別 identity を保持する");
  }
  assert.ok(!(await readFile(scenario.ownerCalls, "utf8")).split("\n").some((action) => ["recover", "release", "reserve", "run"].includes(action)), "案内は復旧を自動実行しない");
  for (const [filename, content] of inputs) assert.ok(await readFile(filename, "utf8") === content, "既存データを保持する");
  const commands = scenario.attachment("auth").stderr.split("\n").filter((line) => line.startsWith("BROWSER_OWNERSHIP_DIR="));
  assert.equal(scenario.execute("sh", ["-c", commands[1]]).status, 0);
  assert.equal(scenario.attachment("close").status, 0);
  assert.equal(scenario.attachment("auth").status, 0, "明示的復旧後は通常の認証手順へ進める");
  assert.ok(JSON.parse(scenario.ownerStatus()).mode === "headed");
  assert.equal(scenario.attachment("close").status, 0);
  assert.equal(scenario.ownerStatus(), "null");
  assert.ok(scenario.otherStatus() === other);
  for (const [filename, content] of inputs) assert.ok(await readFile(filename, "utf8") === content, "復旧後も元の依頼と認証 profile を保持する");
});

test("案内された recover は稼働中・競合・不明状態・照会失敗で記録を保持する", async (t) => {
  const scenario = await fixture(t);
  const before = scenario.ownerStatus();
  const other = scenario.otherStatus();
  const command = scenario.attachment("auth").stderr.split("\n").find((line) => line.startsWith("BROWSER_OWNERSHIP_DIR=") && line.endsWith(" recover"));
  assert.ok(command);
  for (const [state, reason] of [
    ["managed:headless:4242", "Chrome is still running"],
    ["managed:headless:5150", "Chrome is still running"],
    ["port-conflict:5150", "Chrome state is unconfirmed"],
    ["profile-conflict:4242", "Chrome state is unconfirmed"],
    ["unknown", "Chrome state is unconfirmed"],
    ["query-failed", "fixture-inspection-failed"],
  ]) {
    await writeFile(scenario.state, state + "\n");
    const result = scenario.execute("sh", ["-c", command]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(reason));
    assert.ok(scenario.ownerStatus() === before && scenario.otherStatus() === other, "解放拒否では両 identity を保持する");
  }
  const failedInspection = scenario.attachment("upload", "--repo", "owner/repo", "--pr", "42", "--image", scenario.image, "--placeholder", "PLACE", "--request-id", "query-failed");
  assert.equal(failedInspection.status, 1);
  assert.equal(failedInspection.stderr.split("\n").filter((line) => line.startsWith("BROWSER_OWNERSHIP_DIR=")).length, 2);
  await writeFile(scenario.state, "absent\n");
  assert.equal(scenario.execute("sh", ["-c", command]).status, 0);
  assert.equal(scenario.ownerStatus(), "null");
  assert.ok(scenario.otherStatus() === other);
});

test("既定の復旧案内は PATH 上の別コピーを使わず同梱 CLI に到達する", async (t) => {
  const scenario = await fixture(t);
  delete scenario.environment.MANAGED_CHROME_OWNER;
  const bin = path.join(scenario.temporary, "bin");
  const marker = path.join(scenario.temporary, "foreign-cli-called");
  await mkdir(bin);
  await writeFile(path.join(bin, "managed-chrome-owner"), `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)},"unexpected");process.exit(91);\n`, { mode: 0o700 });
  scenario.environment.PATH = bin + path.delimiter + process.env.PATH;
  const result = scenario.attachment("close");
  const commands = result.stderr.split("\n").filter((line) => line.startsWith("BROWSER_OWNERSHIP_DIR="));
  assert.equal(commands.length, 2);
  assert.equal(scenario.execute("sh", ["-c", commands[0]]).status, 0);
  assert.equal(await stat(marker).then(() => true, () => false), false);
});

test("起動未完了の close も案内を示し、生存中の予約は明示的 recover でも保持する", async (t) => {
  const scenario = await fixture(t);
  scenario.owner("--identity", scenario.identity, "recover");
  scenario.owner("--identity", scenario.identity, "reserve", "--role", "attachment", "--id", "starting", "--pid", String(process.pid), "--mode", "headed", "--profile", scenario.profile, "--endpoint", "http://127.0.0.1:9222");
  const before = scenario.ownerStatus();
  const result = scenario.attachment("close");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("incomplete startup"));
  const command = result.stderr.split("\n").find((line) => line.startsWith("BROWSER_OWNERSHIP_DIR=") && line.endsWith(" recover"));
  assert.ok(command);
  const recovery = scenario.execute("sh", ["-c", command]);
  assert.equal(recovery.status, 1);
  assert.ok(recovery.stderr.includes("live startup reservation"));
  assert.ok(scenario.ownerStatus() === before);
});

for (const [stage, reason] of [
  ["status", "fixture-owner-status-failed"],
  ["inspect", "fixture-inspection-failed"],
]) {
  test(`コメントの ${stage} 事前確認が失敗しても同じ request-id で再試行できる`, async (t) => {
    const scenario = await fixture(t);
    const before = scenario.ownerStatus();
    const request = ["comment", "--repo", "owner/repo", "--pr", "42", "--image", scenario.image,
      "--body-file", scenario.body, "--request-id", "preflight-original"];
    if (stage === "status") scenario.environment.FIXTURE_OWNER_FAILURE = "status";
    else await writeFile(scenario.state, "query-failed\n");
    const failed = scenario.attachment(...request);
    assert.equal(failed.status, 1);
    assert.ok(failed.stderr.includes(reason), "意図した事前確認の失敗を報告する");
    const directory = path.join(scenario.ownership, "attachments");
    const receipts = (await readdir(directory)).filter((name) => name.startsWith("comment-") && name.endsWith(".json"));
    assert.equal(receipts.length, 1);
    const receipt = path.join(directory, receipts[0]);
    assert.equal(JSON.parse(await readFile(receipt, "utf8")).phase, "ready", "送信前の失敗は再試行可能な状態へ戻す");
    assert.match(failed.stderr, /^browser-attachments: ownership-conflict:/m);
    assert.ok(scenario.ownerStatus() === before);
    delete scenario.environment.FIXTURE_OWNER_FAILURE;
    await writeFile(scenario.state, "absent\n");
    const recover = failed.stderr.split("\n").find((line) => line.startsWith("BROWSER_OWNERSHIP_DIR=") && line.endsWith(" recover"));
    assert.ok(recover);
    assert.equal(scenario.execute("sh", ["-c", recover]).status, 0);
    assert.equal(scenario.attachment("close").status, 0);
    const retried = scenario.attachment(...request);
    assert.equal(retried.status, 1);
    assert.ok(retried.stderr.includes("authentication-required:"), "同じ依頼で事前確認を通過して認証確認まで進む");
    assert.ok(!retried.stderr.includes("upload-unconfirmed:"));
    const saved = JSON.parse(await readFile(receipt, "utf8"));
    assert.equal(saved.phase, "ready");
    assert.deepEqual(saved.assets, []);
    assert.equal(scenario.attachment("close").status, 0);
  });
}

test("所有者記録がない競合や照会失敗は復旧コマンドを案内せず原因解消後に再試行できる", async (t) => {
  const scenario = await fixture(t);
  scenario.owner("--identity", scenario.identity, "recover");
  const other = scenario.otherStatus();
  for (const state of ["port-conflict:5150", "profile-conflict:4242", "unknown", "query-failed"]) {
    await writeFile(scenario.state, state + "\n");
    const failed = scenario.attachment("auth");
    assert.equal(failed.status, 1);
    assert.ok(failed.stderr.includes(state === "query-failed" ? "fixture-inspection-failed" : "no matching attachment owner"));
    assert.equal(failed.stderr.split("\n").filter((line) => line.startsWith("BROWSER_OWNERSHIP_DIR=")).length, 0, "解放対象の記録がない場合は recover を案内しない");
    assert.equal(scenario.ownerStatus(), "null", "一時予約だけを通常の release で取り消す");
    assert.ok(scenario.otherStatus() === other);
    assert.equal(await readFile(scenario.state, "utf8"), state + "\n");
  }
  assert.ok(!(await readFile(scenario.ownerCalls, "utf8")).split("\n").some((action) => ["run", "recover"].includes(action)));
  await writeFile(scenario.state, "absent\n");
  assert.equal(scenario.attachment("auth").status, 0);
  assert.equal(scenario.attachment("close").status, 0);
});
