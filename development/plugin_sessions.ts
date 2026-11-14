import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  openSync,
  fchmodSync,
  closeSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import { equalPeerJSON, parsePeerJSON, peerJSON } from "../lib/bun/peer-json.ts";
import { object, strip } from "../lib/bun/coordination-json.ts";
import { findCLI } from "../lib/bun/cli-path.ts";
import digitZeros from "../lib/bun/vendor/peer-decimal.json";

const ROOT = resolve(import.meta.dir, "..");
const SKILLS = readdirSync(resolve(ROOT, "skills"))
  .filter((name) => existsSync(resolve(ROOT, "skills", name, "SKILL.md")))
  .sort();
const RUNTIMES = ["claude", "codex", "agy"];
const HELP: Record<string, string> = {
  root: "usage: plugin-sessions [-h] {check,run} ...\n\nOpt-in native skill sessions and offline checks of their tool evidence.\n\npositional arguments:\n  {check,run}\n    run        実モデルを呼ぶ opt-in 検証\n\noptions:\n  -h, --help   show this help message and exit\n",
  check:
    "usage: plugin-sessions check [-h] case\n\npositional arguments:\n  case\n\noptions:\n  -h, --help  show this help message and exit\n",
  run: "usage: plugin-sessions run [-h] --output-dir OUTPUT_DIR\n                              [--runtime {claude,codex,agy}]\n                              [--skill {dogfood,domain-modeling-studio,herdr-peer-refactor,marp,md-agents-review,md-claude-review,orca-peer-refactor,pr-screenshots,product-guide,rop,ui-grill-with-docs,worktree-gc}]\n                              [--installed-root RUNTIME=PATH]\n                              [--timeout TIMEOUT]\n\noptions:\n  -h, --help            show this help message and exit\n  --output-dir OUTPUT_DIR\n  --runtime {claude,codex,agy}\n  --skill {dogfood,domain-modeling-studio,herdr-peer-refactor,marp,md-agents-review,md-claude-review,orca-peer-refactor,pr-screenshots,product-guide,rop,ui-grill-with-docs,worktree-gc}\n  --installed-root RUNTIME=PATH\n                        導入確認で得た plugin の絶対パス（runtime ごとに1件）\n  --timeout TIMEOUT\n",
};
type Data = Record<string, any>;
const field = (value: unknown, key: string, fallback: any = null): any => {
  if (!object(value)) throw new Error("invalid_evidence");
  return Object.hasOwn(value, key) ? value[key] : fallback;
};
const truthy = (value: any): boolean =>
  value != null &&
  value !== false &&
  value !== 0 &&
  value !== 0n &&
  value !== "" &&
  (!Array.isArray(value) || value.length > 0) &&
  (typeof value !== "object" || Object.keys(value).length > 0);
const splitLines = (text: string): string[] =>
  text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);

// Python の int 判定では JSON の 0 と 0.0 を区別する。
function document(raw: Uint8Array): { value: any; integerExit: boolean } {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  let depth = 0,
    key = "",
    previous = "",
    integerExit = false;
  for (const match of text.matchAll(
    /"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|NaN|-?Infinity|[{}\[\]:,]/g,
  )) {
    const token = match[0];
    if (/^-?\d+$/.test(token) && token.replace(/^-/, "").length > 4300)
      throw new Error("invalid_evidence");
    if (depth === 1 && previous === ":" && key === "exit_code") integerExit = /^-?\d+$/.test(token);
    if (depth === 1 && token === ":") key = JSON.parse(previous);
    if (token === "{" || token === "[") depth++;
    if (token === "}" || token === "]") depth--;
    previous = token;
  }
  return { value: parsePeerJSON(raw), integerExit };
}

function shellWords(script: unknown): string[] {
  if (typeof script !== "string" || /[\r\n]/.test(script)) return [];
  const words: string[] = [];
  let word = "",
    active = false,
    quote = "",
    punctuation = false;
  const flush = () => {
    if (active) words.push(word);
    word = "";
    active = punctuation = false;
  };
  for (let index = 0; index < script.length; index++) {
    const char = script[index]!;
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"') {
        const next = script[++index];
        if (next === undefined) throw new Error("invalid_evidence");
        word += next === '"' || next === "\\" ? next : "\\" + next;
      } else word += char;
    } else if (char === "'" || char === '"') {
      if (punctuation) flush();
      active = true;
      quote = char;
    } else if (char === "\\") {
      if (punctuation) flush();
      const next = script[++index];
      if (next === undefined) throw new Error("invalid_evidence");
      active = true;
      word += next;
    } else if (" \t\r\n".includes(char)) flush();
    else if ("();<>|&".includes(char)) {
      if (active && !punctuation) flush();
      active = punctuation = true;
      word += char;
    } else {
      if (punctuation) flush();
      active = true;
      word += char;
    }
  }
  if (quote) throw new Error("invalid_evidence");
  flush();
  return words;
}
function codexRead(command: unknown): string | null {
  let argv = shellWords(command);
  if (
    argv.length === 3 &&
    ["bash", "sh", "zsh"].includes(basename(argv[0]!)) &&
    ["-lc", "-c"].includes(argv[1]!)
  )
    argv = shellWords(argv[2]);
  let path: string;
  if (argv.length === 3 && argv[0] === "cat" && argv[1] === "--") path = argv[2]!;
  else if (argv.length === 2 && argv[0] === "cat") path = argv[1]!;
  else return null;
  return /[$`*?\[\]{}]/.test(path) ? null : path;
}
function officialInvocation(command: unknown, runtime: string, skill: string): boolean {
  if (
    !Array.isArray(command) ||
    !command.length ||
    !command.every((arg) => typeof arg === "string")
  )
    return false;
  const continuation = [
    "resume",
    "--resume",
    "--continue",
    "--conversation",
    ...(runtime !== "codex" ? ["-c"] : []),
    ...(runtime === "claude" ? ["-r"] : []),
  ];
  if (basename(command[0]) !== runtime || command.some((arg) => continuation.includes(arg)))
    return false;
  const prefix = (runtime === "codex" ? "$" : "/") + `treflebonbon-skills:${skill} `;
  if (runtime === "codex")
    return (
      command.length > 2 &&
      command[1] === "exec" &&
      command.includes("--ephemeral") &&
      command.at(-1)!.startsWith(prefix)
    );
  const flags = command.flatMap((arg, index) => (["-p", "--print"].includes(arg) ? [index] : []));
  return (
    flags.length === 1 &&
    flags[0]! + 1 < command.length &&
    command[flags[0]! + 1].startsWith(prefix)
  );
}
function absolutePath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  const parts = value.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return null;
  return (value.startsWith("//") && !value.startsWith("///") ? "//" : "/") + parts.join("/");
}
const decimalClass =
  "[" +
  digitZeros.map((zero) => `\\u{${zero.toString(16)}}-\\u{${(zero + 9).toString(16)}}`).join("") +
  "]";
const agyReadOutput = new RegExp(`^${decimalClass}+ lines, ${decimalClass}+ bytes$`, "u");
const toolKey = (key: unknown) => {
  if (typeof key === "object" && key !== null) throw new Error("invalid_evidence");
  return typeof key === "boolean"
    ? `number:${Number(key)}`
    : typeof key === "bigint" || (typeof key === "number" && Number.isInteger(key))
      ? `number:${BigInt(key)}`
      : `${typeof key}:${key}`;
};

function checkCase(
  runtime: string,
  skill: string,
  events: any[],
  inventory: Data,
  process: Data,
): Data {
  const reads: unknown[] = [],
    tools = new Map<string, Data>(),
    sessionIds = new Set<string>();
  let complete = false,
    detected = false,
    sessionId: unknown = null;
  if (runtime === "agy")
    detected =
      field(inventory, "status") === "SUCCESS" &&
      splitLines(field(inventory, "response", ""))
        .map((line) => line.split("\t", 1)[0])
        .includes(`treflebonbon-skills:${skill}`);
  else if (runtime === "codex")
    detected = field(inventory, "installed", []).some(
      (plugin: Data) =>
        field(plugin, "name") === "treflebonbon-skills" &&
        field(plugin, "installed") === true &&
        field(plugin, "enabled") === true,
    );
  for (const event of events) {
    if (runtime === "claude") {
      if (field(event, "type") === "system" && field(event, "subtype") === "init") {
        detected = field(event, "skills", []).includes(`treflebonbon-skills:${skill}`);
        sessionId = field(event, "session_id");
      }
      for (const content of field(field(event, "message", {}), "content", [])) {
        if (field(content, "type") === "tool_use") {
          if (!Object.hasOwn(content, "id")) throw new Error("invalid_evidence");
          tools.set(toolKey(content.id), content);
        }
        if (field(content, "type") === "tool_result" && !truthy(field(content, "is_error"))) {
          const tool = tools.get(toolKey(field(content, "tool_use_id"))) ?? {};
          if (field(tool, "name") === "Read")
            reads.push(field(field(tool, "input", {}), "file_path", ""));
        }
      }
      if (field(event, "type") === "result")
        complete = field(event, "subtype") === "success" && field(event, "is_error") === false;
    } else if (runtime === "codex") {
      if (field(event, "type") === "thread.started") sessionId = field(event, "thread_id");
      const item = field(event, "item", {});
      if (
        field(event, "type") === "item.completed" &&
        field(item, "type") === "command_execution" &&
        equalPeerJSON(field(item, "exit_code"), 0) &&
        truthy(field(item, "aggregated_output"))
      )
        reads.push(codexRead(field(item, "command", "")));
      if (field(event, "type") === "turn.completed") complete = true;
      else if (["turn.failed", "error"].includes(field(event, "type"))) complete = false;
    } else {
      if (field(event, "event") === "init") sessionId = field(event, "conversation_id");
      const step = field(event, "step_update", {}),
        tool = field(step, "tool_info", {});
      if (field(step, "state") === "DONE" && field(tool, "name") === "read_file") {
        const output = field(tool, "output", "");
        if (typeof output !== "string") throw new Error("invalid_evidence");
        if (agyReadOutput.test(output))
          reads.push(field(field(tool, "parameters", {}), "Path", ""));
      }
      if (field(event, "event") === "result")
        complete = field(field(event, "result", {}), "status") === "SUCCESS";
    }
    if (typeof sessionId === "string" && sessionId) sessionIds.add(sessionId);
  }
  const paths = [...new Set(reads.map(absolutePath).filter((path): path is string => !!path))];
  const installedRoot = absolutePath(field(inventory, "installed_root"));
  const expectedSkill = installedRoot
    ? installedRoot.replace(/\/?$/, "/") + `skills/${skill}/SKILL.md`
    : null;
  const skillPath = expectedSkill && paths.includes(expectedSkill) ? expectedSkill : null;
  const resources = paths.filter(
    (path) =>
      skillPath && path !== skillPath && path.startsWith(skillPath.slice(0, -"SKILL.md".length)),
  );
  const reasons: string[] = [];
  if (!officialInvocation(field(process, "command"), runtime, skill))
    reasons.push("official_invocation_missing");
  if (sessionIds.size !== 1) reasons.push("session_id_missing_or_ambiguous");
  if (!detected) reasons.push("skill_not_detected");
  if (!equalPeerJSON(field(process, "exit_code"), 0)) reasons.push("process_failed");
  if (!complete) reasons.push("incomplete_session");
  if (installedRoot && !skillPath) reasons.push("skill_not_read");
  if (installedRoot && !resources.length) reasons.push("resource_not_read");
  const status = reasons.length ? "failed" : installedRoot ? "passed" : "unconfirmed";
  if (!installedRoot) reasons.push("installed_root_unconfirmed");
  return {
    runtime,
    skill,
    session_id: sessionId,
    status,
    reasons,
    installed_root: installedRoot,
    observed_read_paths: paths,
    skill_path: skillPath,
    resource_paths: resources,
    dependencies_status: "unconfirmed",
    auxiliary_status: "unconfirmed",
  };
}
function readCase(directory: string): Data {
  try {
    // 証跡 directory の symlink/.. は open に任せ、先に字句正規化しない。
    const file = (name: string) =>
      directory ? directory + (directory.endsWith("/") ? "" : "/") + name : name;
    const process = document(readFileSync(file("process.json")));
    const runtime = field(process.value, "runtime"),
      skill = field(process.value, "skill");
    if (!RUNTIMES.includes(runtime) || !SKILLS.includes(skill) || !process.integerExit)
      throw new Error("invalid_evidence");
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      readFileSync(file("events.jsonl")),
    );
    const events = splitLines(raw)
      .filter((line) => strip(line))
      .map((line) => document(Buffer.from(line)).value);
    const inventory = document(readFileSync(file("inventory.json"))).value;
    return checkCase(runtime, skill, events, inventory, process.value);
  } catch {
    return { status: "unconfirmed", reasons: ["invalid_evidence"] };
  }
}

function physicalPath(input: string): string {
  let current = input.startsWith("/") ? "/" : process.cwd();
  const activeLinks = new Set<string>();
  const parts: (string | { end: string })[] = input.split("/");
  while (parts.length) {
    const part = parts.shift()!;
    if (typeof part !== "string") {
      activeLinks.delete(part.end);
      continue;
    }
    if (!part || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, part);
    let link = false;
    try {
      link = lstatSync(candidate).isSymbolicLink();
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code!)) throw error;
    }
    if (link) {
      if (activeLinks.has(candidate)) throw new Error("execution_unconfirmed");
      activeLinks.add(candidate);
      const target = readlinkSync(candidate);
      if (target.startsWith("/")) current = "/";
      parts.unshift(...target.split("/"), { end: candidate });
    } else current = candidate;
  }
  return current;
}
function writeJSON(path: string, value: unknown): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, peerJSON(value));
  } finally {
    closeSync(fd);
  }
}
const decode = (raw: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw).replace(/\r\n?/g, "\n");
function nativeOutput(command: string[], cwd?: string): string {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd,
    maxBuffer: Infinity,
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0) throw new Error("cli_or_inventory_unavailable");
  return decode(result.stdout);
}
function inventoryFor(runtime: string, executable: string, directory: string): Data {
  if (runtime === "claude") return {};
  const command =
    runtime === "codex"
      ? [executable, "plugin", "list", "--marketplace", "treflebonbon", "--json"]
      : [executable, "--print", "/skills", "--output-format", "json"];
  const inventory = document(Buffer.from(nativeOutput(command, directory))).value;
  if (runtime === "codex")
    return {
      installed: field(inventory, "installed", []).filter(
        (plugin: Data) => field(plugin, "name") === "treflebonbon-skills",
      ),
    };
  return {
    status: field(inventory, "status"),
    response: splitLines(field(inventory, "response", ""))
      .filter((line) => line.startsWith("treflebonbon-skills:"))
      .map((line) => line.split("\t", 1)[0])
      .join("\n"),
  };
}
function sessionCommand(
  runtime: string,
  executable: string,
  skill: string,
  timeout: bigint,
): string[] {
  const invocation = (runtime === "codex" ? "$" : "/") + "treflebonbon-skills:" + skill;
  const prompt =
    invocation +
    " " +
    "新規セッションの受入確認です。今回は正式名で指定した skill の検出・読込と同梱資源の解決だけを確認します。" +
    "この明示的な範囲指定を skill の一般的な業務ワークフローより優先してください。" +
    "native metadata で検出したインストール済み SKILL.md を、起動時に本文が展開済みでも、実ファイルとして Read/file tool で改めて読んでください。" +
    "その directory を起点に同梱 reference を1件、別の tool call で読んで終了してください。" +
    "rop は references/rust.md、それ以外は reference が無ければ DEPENDENCIES.md または helper source を選んでください。" +
    "Codex は各ファイルを別々の tool call で、単独の cat -- <絶対パス> により読んでください。" +
    "未検出なら配布元や別コピーへの迂回をせず、そのまま報告してください。" +
    "補助 CLI・第三者依存 skill は存在確認できた範囲だけ報告し、未確認を成功扱いしないでください。" +
    "ファイル変更、削除、Git操作、他エージェント起動、browser起動、外部書込、credential読取は行わないでください。";
  if (runtime === "claude")
    return [
      executable,
      "-p",
      prompt,
      "--tools",
      "Read",
      "--allowedTools",
      "Read",
      "--permission-prompts",
      "none",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
    ];
  if (runtime === "codex")
    return [
      executable,
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      prompt,
    ];
  return [
    executable,
    "--print",
    prompt,
    "--mode",
    "plan",
    "--output-format",
    "stream-json",
    "--print-timeout",
    `${timeout}s`,
  ];
}
class Interrupted extends Error {}
async function captureSession(
  command: string[],
  directory: string,
  timeout: bigint,
): Promise<number> {
  const output = openSync(join(directory, "events.jsonl"), "wx", 0o600);
  let error: number | undefined;
  try {
    fchmodSync(output, 0o600);
    error = openSync(join(directory, "stderr.log"), "wx", 0o600);
    fchmodSync(error, 0o600);
    const child = spawn(command[0]!, command.slice(1), {
      cwd: directory,
      detached: true,
      stdio: ["ignore", output, error],
    });
    const done = new Promise<number>((resolve) => {
      child.once("error", () => resolve(127));
      child.once("exit", (code, signal) => resolve(code ?? -(constants.signals[signal!] ?? 1)));
    });
    let interrupt!: () => void;
    const interrupted = new Promise<"interrupt">((resolve) => {
      interrupt = () => resolve("interrupt");
    });
    process.on("SIGINT", interrupt);
    let timer: ReturnType<typeof setTimeout> | undefined,
      grace: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      const deadline = performance.now() + Number(timeout) * 1000;
      const tick = () => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) resolve("timeout");
        else timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
      };
      tick();
    });
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    try {
      const result = await Promise.race([done, expired, interrupted]);
      if (typeof result === "number") return result;
      killGroup("SIGTERM");
      try {
        await Promise.race([
          done,
          new Promise<void>((resolve) => {
            grace = setTimeout(resolve, 5000);
          }),
        ]);
      } finally {
        killGroup("SIGKILL");
        await done;
      }
      if (result === "interrupt") throw new Interrupted();
      return 124;
    } finally {
      clearTimeout(timer);
      clearTimeout(grace);
      process.removeListener("SIGINT", interrupt);
    }
  } finally {
    closeSync(output);
    if (error !== undefined) closeSync(error);
  }
}
type RunArguments = {
  output: string;
  runtimes: string[];
  skills: string[];
  roots: string[];
  timeout: bigint;
};
async function runSessions(args: RunArguments): Promise<Data> {
  const roots = new Map<string, string>();
  for (const specification of args.roots) {
    const at = specification.indexOf("="),
      runtime = specification.slice(0, at),
      root = absolutePath(specification.slice(at + 1));
    if (at < 0 || !RUNTIMES.includes(runtime) || !root || roots.has(runtime))
      throw new Error("invalid_installed_root");
    roots.set(runtime, root);
  }
  const output = physicalPath(args.output);
  if (output === ROOT || output.startsWith(ROOT + "/")) throw new Error("output_inside_payload");
  if (existsSync(output)) throw new Error("output_exists");
  mkdirSync(output, { mode: 0o700 });
  const records: Data[] = [],
    versions: Data = {},
    sessionIds = new Set<string>();
  for (const runtime of new Set(args.runtimes.length ? args.runtimes : RUNTIMES)) {
    const directory = join(output, runtime);
    mkdirSync(directory, { mode: 0o700 });
    const executable = findCLI(runtime);
    let failure: string | null = null;
    try {
      if (!executable) throw new Error("cli_unavailable");
      versions[runtime] = {
        path: executable,
        version: Array.from(strip(nativeOutput([executable, "--version"])))
          .slice(0, 256)
          .join(""),
      };
    } catch {
      failure = "cli_or_inventory_unavailable";
    }
    for (const skill of new Set(args.skills.length ? args.skills : SKILLS)) {
      const directoryCase = join(directory, skill);
      mkdirSync(directoryCase, { mode: 0o700 });
      const inventory: Data = { cwd: directoryCase, installed_root: roots.get(runtime) ?? null };
      let caseFailure = failure;
      if (!caseFailure) {
        try {
          Object.assign(inventory, inventoryFor(runtime, executable!, directoryCase));
        } catch {
          caseFailure = "cli_or_inventory_unavailable";
        }
      }
      writeJSON(join(directoryCase, "inventory.json"), inventory);
      let record: Data;
      if (caseFailure) record = { runtime, skill, status: "unconfirmed", reasons: [caseFailure] };
      else {
        const command = sessionCommand(runtime, executable!, skill, args.timeout);
        const code = await captureSession(command, directoryCase, args.timeout);
        writeJSON(join(directoryCase, "process.json"), {
          runtime,
          skill,
          command,
          exit_code: code,
        });
        record = readCase(directoryCase);
        const sessionId = record.session_id;
        if (truthy(sessionId)) {
          const key = toolKey(sessionId);
          if (sessionIds.has(key)) {
            record.status = "failed";
            record.reasons.push("session_reused");
          }
          sessionIds.add(key);
        }
      }
      writeJSON(join(directoryCase, "result.json"), record);
      records.push(record);
      process.stderr.write(`${runtime}/${skill}: ${record.status}\n`);
    }
  }
  const report: Data = {
    passed: records.filter((record) => record.status === "passed").length,
    expected: records.length,
    versions,
    cases: records,
  };
  report.status = report.passed === report.expected ? "passed" : "failed";
  writeJSON(join(output, "summary.json"), report);
  return report;
}
function argumentError(message: string): never {
  process.stderr.write(`plugin-sessions: error: ${message}\n`);
  process.exit(2);
}
const helpFlag = (argument: string) =>
  argument === "-h" || (argument.length > 2 && "--help".startsWith(argument));
function help(mode: string): never {
  process.stdout.write(HELP[mode]!);
  process.exit(0);
}
function argumentsForCLI(): { command: string; case?: string; run?: RunArguments } {
  const [command, ...argv] = process.argv.slice(2);
  if (command && helpFlag(command)) help("root");
  if (command === "check") {
    if (argv[0] !== "--" && argv.some(helpFlag)) help("check");
    const positional = argv[0] === "--" ? argv.slice(1) : argv;
    if (
      positional.length !== 1 ||
      (argv[0] !== "--" && positional[0]!.startsWith("-") && positional[0] !== "-")
    )
      argumentError("check requires a case directory");
    return { command, case: positional[0] };
  }
  if (command !== "run") argumentError("expected check or run");
  const result: RunArguments = { output: "", runtimes: [], skills: [], roots: [], timeout: 240n };
  let outputProvided = false;
  const options = ["--output-dir", "--runtime", "--skill", "--installed-root", "--timeout"];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (helpFlag(argument)) help("run");
    if (argument === "--" && index === argv.length - 1) break;
    const [key, ...tail] = argument.split("="),
      matches = options.filter((option) => option.startsWith(key!));
    if (matches.length !== 1) argumentError(`unrecognized arguments: ${argument}`);
    const option = matches[0]!,
      value = tail.length ? tail.join("=") : argv[++index];
    if (
      value === undefined ||
      (!tail.length &&
        value.startsWith("-") &&
        !new RegExp(`^-(?:${decimalClass}+|${decimalClass}*\\.${decimalClass}+)$`, "u").test(value))
    )
      argumentError(`argument ${option}: expected one argument`);
    if (option === "--output-dir") {
      result.output = value;
      outputProvided = true;
    } else if (option === "--runtime") {
      if (!RUNTIMES.includes(value)) argumentError("invalid runtime");
      result.runtimes.push(value);
    } else if (option === "--skill") {
      if (!SKILLS.includes(value)) argumentError("invalid skill");
      result.skills.push(value);
    } else if (option === "--installed-root") result.roots.push(value);
    else {
      const raw = strip(value),
        digits = raw.replace(/^[+-]/, "");
      if (
        !new RegExp(`^${decimalClass}+(?:_${decimalClass}+)*$`, "u").test(digits) ||
        Array.from(digits.replaceAll("_", "")).length > 4300
      )
        argumentError("invalid timeout");
      const ascii = Array.from(digits.replaceAll("_", ""), (char) => {
        const point = char.codePointAt(0)!,
          zero = digitZeros.find((zero) => zero <= point && point < zero + 10)!;
        return String(point - zero);
      }).join("");
      result.timeout = BigInt(ascii) * (raw.startsWith("-") ? -1n : 1n);
    }
  }
  if (!outputProvided) argumentError("--output-dir is required");
  return { command, run: result };
}
const args = argumentsForCLI();
let result: Data;
try {
  if (args.command === "check") result = readCase(args.case!);
  else {
    if (args.run!.timeout <= 0n) throw new Error("invalid_timeout");
    result = await runSessions(args.run!);
  }
} catch (error) {
  if (error instanceof Interrupted) {
    process.stderr.write("KeyboardInterrupt\n");
    process.kill(process.pid, "SIGINT");
    process.exit(130);
  }
  const reason = (error as Error).message;
  result = {
    status: "unconfirmed",
    reasons: [
      [
        "output_exists",
        "output_inside_payload",
        "invalid_timeout",
        "invalid_installed_root",
      ].includes(reason)
        ? reason
        : "execution_unconfirmed",
    ],
  };
}
process.stdout.write(peerJSON(result));
process.exitCode = result.status === "passed" ? 0 : 1;
