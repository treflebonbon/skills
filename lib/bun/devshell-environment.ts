import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants, homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { findCLI } from "./cli-path.ts";
import { strip } from "./coordination-json.ts";
import { InvalidContext, Repository, gitEnvironment } from "./git-context.ts";
import { equalStrictJSON, parseStrictJSON, strictJSON } from "./strict-json.ts";

export class PreparationError extends Error {}

export function executable(name: string): string | null {
  const path = findCLI(name);
  return path ? realpathSync.native(path) : null;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

// trust state は未作成でも、既存の symlink をたどってから所属を検査する。
function physicalStatePath(path: string): string {
  let directory = isAbsolute(path) ? sep : process.cwd();
  let parts = path.split(sep);
  let links = 0;
  while (parts.length > 0) {
    const part = parts.shift();
    if (!part || part === ".") continue;
    if (part === "..") {
      directory = dirname(directory);
      continue;
    }
    const candidate = join(directory, part);
    try {
      const target = readlinkSync(candidate);
      if (++links > 40) throw new InvalidContext("cannot resolve trust state");
      if (isAbsolute(target)) directory = sep;
      parts = [...target.split(sep), ...parts];
    } catch (error) {
      if (!["EINVAL", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      directory = candidate;
    }
  }
  return directory;
}

// prepared context は旧版と文字列で照合するため、Python JSON の空白と ASCII escape を保つ。
function recordJSON(value: unknown): string {
  return strictJSON(value)
    .replace(/,\n +/g, ", ")
    .replace(/\n */g, "")
    .replace(
      /[\x7f-\uffff]/g,
      (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
    );
}

export function trustFile(repo: Repository): string {
  const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state");
  const directory = physicalStatePath(`${state ? state + sep : ""}devshell-env/trust`);
  let ancestor = directory;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);

  const git = executable("git");
  if (!git) throw new InvalidContext("Git is required to resolve worktree metadata");
  const result = spawnSync(git, ["-C", ancestor, "rev-parse", "--git-dir"], {
    env: gitEnvironment(),
    stdio: "ignore",
  });
  if (result.error) throw result.error;
  const fromCommon = relative(repo.commonDir, directory);
  if (result.status === 0 || (fromCommon !== ".." && !fromCommon.startsWith(".." + sep)))
    throw new InvalidContext("trust state must be outside repositories and Git metadata");
  return join(directory, sha256(repo.commonDir) + ".json");
}

export function trusted(repo: Repository): boolean {
  const path = trustFile(repo);
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new InvalidContext("symlinked trust record");
  try {
    return equalStrictJSON(parseStrictJSON(readFileSync(path)), repo.identity());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function trustCommand(command: "trust" | "untrust" | "status", repo: Repository): string {
  const path = trustFile(repo);
  if (command === "trust") {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = mkdtempSync(join(directory, ".trust-"));
    try {
      const record = join(temporary, "record");
      writeFileSync(record, recordJSON(repo.identity()), { mode: 0o600, flag: "wx" });
      renameSync(record, path);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  } else if (command === "untrust") {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const state = trusted(repo) ? "trusted" : "untrusted";
  const flake = isFile(join(repo.root, "flake.nix")) ? "flake present" : "no flake";
  return `devshell-env: ${state}; ${flake}; ${repo.root}`;
}

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

export function selectedOutput(repo: Repository): string {
  const explicit = process.env.DEVSHELL_ENV_OUTPUT;
  if (explicit) {
    if (!explicit.split(".").every((part) => part && !/[^\p{L}\p{N}_-]/u.test(part)))
      throw new PreparationError("DEVSHELL_ENV_OUTPUT must name an output in the current flake");
    return explicit;
  }
  const release = "/proc/sys/kernel/osrelease";
  const wsl =
    process.env.WSL_DISTRO_NAME ||
    (isFile(release) && /microsoft|wsl/i.test(readFileSync(release, "utf8")));
  return wsl && isFile(join(repo.root, ".wsl-browser-free")) ? "wsl" : "default";
}

function preparedContext(repo: Repository, output = selectedOutput(repo)): string {
  const files = Object.fromEntries(
    ["flake.lock", "flake.nix"].map((name) => {
      const path = join(repo.root, name);
      return [name, existsSync(path) ? sha256(readFileSync(path)) : null];
    }),
  );
  return recordJSON({ files, output, repository: repo.identity(), root: repo.root });
}

const bootstrapKeys = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "XDG_CACHE_HOME",
  "NIX_REMOTE",
  "NIX_SSL_CERT_FILE",
  "SSL_CERT_FILE",
];
const isolatedKeys = [
  "NIX_CONFIG",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
];
const excludedKeys = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "SHLVL",
  "_",
  "SHELL",
  "BASH_ENV",
  "ENV",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
]);

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeEnvironment(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    // OS の環境に UTF-8 でない byte があれば Python の surrogateescape と同じ値を返す。
    let decoded = "";
    for (let offset = 0; offset < bytes.length;) {
      const byte = bytes[offset];
      const width = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
      try {
        decoded += utf8.decode(bytes.subarray(offset, offset + width));
        offset += width;
      } catch {
        decoded += String.fromCharCode(0xdc00 + byte);
        offset++;
      }
    }
    return decoded;
  }
}

function shellEnvironment(bytes: Uint8Array): Record<string, string> {
  const records = decodeEnvironment(bytes).split("\0");
  if (records.pop() !== "" || records.length === 0)
    throw new PreparationError("invalid devShell environment output");
  return Object.fromEntries(
    records.map((record) => {
      const equal = record.indexOf("=");
      if (equal < 1) throw new PreparationError("invalid devShell environment output");
      return [record.slice(0, equal), record.slice(equal + 1)];
    }),
  );
}

function runPreparation(
  stage: "Nix" | "shellHook",
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number | undefined,
  stdin?: Uint8Array,
): Uint8Array {
  const result = Bun.spawnSync(command, {
    cwd,
    env,
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout) throw new PreparationError(`${stage} preparation timed out`);
  if (!result.success) {
    const signal = result.signalCode;
    const status = signal
      ? -(typeof signal === "number" ? signal : constants.signals[signal])
      : result.exitCode;
    throw new PreparationError(
      `${stage} preparation failed (${status}): ${strip(utf8.decode(result.stderr).replace(/\r\n?/g, "\n"))}`,
    );
  }
  return result.stdout;
}

// 旧 Python の locale 補正を保ち、利用可能な UTF-8 locale を Bash 自身で選ぶ。
const prepareScript = `
set -e
eval "$(cat)" >&2
if [[ -z \${LC_ALL:-} && ( \${LC_CTYPE:-\${LANG:-C}} == C || \${LC_CTYPE:-\${LANG:-C}} == POSIX ) ]]; then
  set -- "$1" "$(
    devshell_utf8_probe='☃'
    for devshell_locale in C.UTF-8 C.utf8 UTF-8; do
      if (export LC_CTYPE="$devshell_locale"; [[ \${#devshell_utf8_probe} -eq 1 ]]) 2>/dev/null; then
        printf '%s' "$devshell_locale"
        break
      fi
    done
  )"
  if [[ -n "$2" ]]; then exec "$1" -0 LC_CTYPE="$2"; fi
fi
exec "$1" -0
`;

export function prepareEnvironment(
  repo: Repository,
  inherited: NodeJS.ProcessEnv,
  {
    requireTrust = true,
    timeoutMs,
    isolated = false,
  }: {
    requireTrust?: boolean;
    timeoutMs?: number;
    isolated?: boolean;
  } = {},
): NodeJS.ProcessEnv {
  const identity = repo.identity();
  repo.checkUnchanged(identity);
  if (requireTrust && !trusted(repo))
    throw new PreparationError("untrusted repository; run devshell-env trust");
  if (!isFile(join(repo.root, "flake.nix")))
    throw new PreparationError("no flake.nix at the worktree root");

  const output = selectedOutput(repo);
  const context = preparedContext(repo, output);
  const nix = executable("nix");
  const bash = executable("bash");
  if (!nix || !bash) throw new PreparationError("nix and bash are required");
  const env = findCLI("env");
  if (!env) throw new PreparationError("env is required to read the devShell environment");
  // Nix の coreutils は argv[0] の名前で env を選ぶので symlink を保つ。
  const envPath = isAbsolute(env) ? env : process.cwd() + sep + env;

  const keys = isolated ? [...bootstrapKeys, ...isolatedKeys] : bootstrapKeys;
  const bootstrap = Object.fromEntries(
    keys.filter((key) => Object.hasOwn(inherited, key)).map((key) => [key, inherited[key]]),
  );
  bootstrap.TMPDIR = "/tmp";
  const quotedRoot = repo.root
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join("/");
  const nixOutput = runPreparation(
    "Nix",
    [
      nix,
      "--extra-experimental-features",
      "nix-command flakes",
      "print-dev-env",
      "--no-write-lock-file",
      `git+file://${quotedRoot}#${output}`,
    ],
    repo.root,
    bootstrap,
    timeoutMs,
  );
  const prepared = shellEnvironment(
    runPreparation(
      "shellHook",
      [bash, "--noprofile", "--norc", "-c", prepareScript, "devshell-env", envPath],
      repo.root,
      bootstrap,
      timeoutMs,
      Buffer.from(utf8.decode(nixOutput).replace(/\r\n?/g, "\n")),
    ),
  );
  const environment = Object.fromEntries([
    ...Object.entries(inherited),
    ...Object.entries(prepared).filter(
      ([key]) =>
        !Object.hasOwn(inherited, key) &&
        !excludedKeys.has(key) &&
        !/^(GIT_|CODEX_|DEVSHELL_ENV_)/.test(key),
    ),
  ]);
  const paths = `${prepared.PATH ?? ""}:${inherited.PATH ?? ""}`.split(":").filter(Boolean);
  environment.PATH = [...new Set(paths)].join(":");

  repo.checkUnchanged(identity);
  if (preparedContext(repo) !== context)
    throw new PreparationError("flake changed during preparation; restart the session");
  environment.DEVSHELL_ENV_CONTEXT = context;
  console.error(`devshell-env: ready; ${repo.root}#${output}`);
  return environment;
}

export function reuseEnvironment<Environment extends NodeJS.ProcessEnv>(
  repo: Repository,
  inherited: Environment,
): Environment {
  const identity = repo.identity();
  repo.checkUnchanged(identity);
  const context = inherited.DEVSHELL_ENV_CONTEXT;
  if (!context) throw new PreparationError("no prepared devShell; restart through codex-worktree");
  if (context !== preparedContext(repo))
    throw new PreparationError(
      "prepared devShell belongs to another root or flake; restart the session",
    );
  repo.checkUnchanged(identity);
  return inherited;
}

export function parseReasoningEffort(assignment: string): string {
  const separator = assignment.indexOf("=");
  if (separator < 0 || strip(assignment.slice(0, separator)) !== "model_reasoning_effort")
    throw new InvalidContext("only model_reasoning_effort config is allowed");

  const value = assignment.slice(separator + 1).replace(/\r\n/g, "\n");
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse("effort=" + value) as Record<string, unknown>;
  } catch (error) {
    throw new InvalidContext("reasoning effort must be a TOML string", { cause: error });
  }

  const effort = parsed.effort;
  if (Object.keys(parsed).length !== 1 || typeof effort !== "string" || effort.length === 0)
    throw new InvalidContext("reasoning effort must be one nonempty TOML string");

  // Bun は TOML 1.1 を受理するが、旧入口の basic string は 1.0 の escape だけを許す。
  const basic = /^[ \t]*(?:"""((?:\\[\s\S]|[^"\\]|"{1,2}(?!"))*)"""|"((?:\\[\s\S]|[^"\\])*)")/.exec(
    value,
  );
  const body = basic?.[1] ?? basic?.[2] ?? "";
  if (!effort.isWellFormed() || /(?:^|[^\\])(?:\\\\)*\\[ex]/.test(body))
    throw new InvalidContext("reasoning effort must be a TOML string");
  return effort;
}
