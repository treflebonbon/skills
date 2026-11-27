import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { inputPolicy, type RawRuntime } from "./raw-admission.ts";
import { openInputPolicy } from "./raw-admission-files.ts";
import { executable, selectedOutput, trusted } from "./devshell-environment.ts";
import { native } from "./file-safety.ts";
import { Repository } from "./git-context.ts";
import { GatewayCleanupError, type Service } from "./raw-gateway.ts";
import {
  isolationTools,
  launcherArgv,
  namespaceTools,
  nixExecutable,
  runIsolated,
} from "./raw-isolation.ts";
import { nixStore, selectRawLauncher } from "./raw-nix-launcher.ts";
import { returnRawResult } from "./raw-return.ts";
import { rawGitText, readApproval } from "./raw-worktree.ts";

const hostEnvironment = [
  "HOME",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "CODEX_HOME",
  "CODEX_ISOLATION_CA_BUNDLE",
  "NIX_SSL_CERT_FILE",
  "SSL_CERT_FILE",
  "DEVSHELL_ENV_OUTPUT",
  "WSL_DISTRO_NAME",
  "TREFLEBONBON_FILE_SAFETY_DIR",
  "XDG_CACHE_HOME",
];
const offline = ["sandbox", "mcp", "--version", "--help"];

// Perl acquires flock on the same open description that the Bun parent keeps.
function lockPolicy(policy: string) {
  const parent = openInputPolicy(policy, { create: false });
  const leaf = parent.leaf.replace(/\.json$/, ".lock");
  let fd: number;
  try {
    fd = native.openat(
      parent.fd,
      leaf,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } finally {
    closeSync(parent.fd);
  }
  try {
    const state = fstatSync(fd);
    if (!state.isFile() || state.nlink !== 1 || state.uid !== process.getuid!())
      throw new Error("invalid public-input lock");
    const lock = spawnSync(
      "/usr/bin/perl",
      ["-MFcntl=:flock", "-e", "exit(flock(STDIN, LOCK_EX | LOCK_NB) ? 0 : 1)"],
      { env: {}, stdio: [fd, "ignore", "ignore"] },
    );
    if (lock.error) throw lock.error;
    if (lock.status !== 0) throw new Error("public inputs are locked by another raw session");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export async function launch(args: string[]) {
  if (process.platform !== "linux") throw new Error("raw isolated Codex requires Linux or WSL2");
  const launcherPackage = process.env.CODEX_RAW_LAUNCHER ?? "";
  const launcherSource = process.env.CODEX_RAW_LAUNCHER_SOURCE_SHA256 ?? "";
  const originalPath = process.env.PATH;
  const git = dirname(nixExecutable("git"));
  for (const key of Object.keys(process.env))
    if (!hostEnvironment.includes(key)) delete process.env[key];
  process.env.PATH = git;
  const repo = Repository.discover(process.cwd(), { linkedOnly: true });
  if (!trusted(repo)) throw new Error("untrusted repository; run devshell-env trust");
  if (!statSync(join(repo.root, "flake.nix"), { throwIfNoEntry: false })?.isFile())
    throw new Error("no flake.nix at the worktree root");
  if (originalPath !== undefined) process.env.PATH = originalPath;
  const paths = [...isolationTools, ...namespaceTools].map((tool) => dirname(nixExecutable(tool)));
  const python = executable("python3");
  if (python?.startsWith(nixStore + "/")) paths.push(dirname(python));
  process.env.PATH = [...new Set(paths)].join(delimiter);
  const policy = inputPolicy(repo);
  if (!lstatSync(policy, { throwIfNoEntry: false }))
    throw new Error(
      "public inputs are not admitted; run devshell-env admit --git-head FULL_SHA -- FILES",
    );
  const lock = lockPolicy(policy);
  const controller = new AbortController();
  let interrupted = 0;
  const handlers = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ].map(([signal, code]) => {
    const handler = () => {
      interrupted ||= code as number;
      controller.abort(
        new Error("isolated execution interrupted; the session is retained for recovery"),
      );
    };
    process.on(signal as NodeJS.Signals, handler);
    return [signal as NodeJS.Signals, handler] as const;
  });
  try {
    const record = readApproval(policy);
    const runtime: RawRuntime = { ...record.runtime, output: selectedOutput(repo) };
    if (runtime.github) {
      const selectedPath = process.env.PATH;
      if (originalPath !== undefined) process.env.PATH = originalPath;
      process.env.PATH =
        selectedPath +
        delimiter +
        ["awk", "jq"].map((tool) => dirname(nixExecutable(tool))).join(delimiter);
    }
    if (!Object.hasOwn(record.files ?? {}, "flake.nix"))
      throw new Error("flake.nix must be an admitted public input");
    const launcher = selectRawLauncher(launcherPackage, launcherSource);
    const sessions = join(dirname(dirname(policy)), "sessions");
    mkdirSync(sessions, { mode: 0o700, recursive: true });
    const session = join(sessions, randomUUID().replaceAll("-", ""));
    console.error(`codex-worktree: isolated session ${session}`);
    const services: Service[] = ["dependencies"];
    if (
      runtime.github &&
      rawGitText(repo.root, "branch", "--show-current") !== runtime.github.branch
    )
      throw new Error("current branch differs from the admitted GitHub topic");
    if (!offline.includes(args[0])) services.push("model");
    const status = await runIsolated(
      repo,
      policy,
      session,
      [...launcherArgv(launcher, "raw-inner.ts"), ...args],
      services,
      {
        caBundle: runtime.ca_bundle,
        runtime,
        launcher,
        approval: record,
        signal: controller.signal,
      },
    );
    controller.signal.throwIfAborted();
    if (!lstatSync(join(session, "result/codex-started"), { throwIfNoEntry: false })?.isFile())
      throw new Error(
        "initialization incomplete; session retained, review public inputs and restart",
      );
    const head = await returnRawResult(repo, session);
    console.log(`returned HEAD ${head}, index and ordinary worktree changes`);
    return interrupted || status;
  } catch (error) {
    if (interrupted) {
      console.error(`codex-worktree: ${controller.signal.reason.message}`);
      return interrupted;
    }
    if (error instanceof GatewayCleanupError) {
      console.error(`codex-worktree: ${error.message}`);
      return error.status;
    }
    throw error;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    closeSync(lock);
  }
}
