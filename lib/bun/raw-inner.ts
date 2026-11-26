import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { executable, parseReasoningEffort, prepareEnvironment } from "./devshell-environment.ts";
import { InvalidContext, Repository } from "./git-context.ts";
import { rawArguments, writeExecFrame } from "./raw-exec-frame.ts";

const prohibited = new Set([
  "--cd",
  "--worktree",
  "--enable",
  "--disable",
  "--sandbox",
  "--add-dir",
  "--profile",
  "--approve-for-me",
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "--ignore-user-config",
  "--ignore-rules",
  "--dangerously-bypass-hook-trust",
  "--remote",
  "--remote-auth-token-env",
  "--sandbox-state-json",
  "--sandbox-state-readable-root",
]);
const profiles = new Set(["-P", "--permission-profile", "--permissions-profile"]);

function validate(args: string[]) {
  let effortSeen = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return;
    if (arg === "-c" || arg === "--config" || arg.startsWith("-c") || arg.startsWith("--config=")) {
      if (effortSeen) throw new InvalidContext("reasoning effort must be specified only once");
      const value =
        arg === "-c" || arg === "--config"
          ? (args[++index] ?? "")
          : arg.startsWith("-c")
            ? arg.slice(2)
            : arg.slice("--config=".length);
      parseReasoningEffort(value);
      effortSeen = true;
    } else if (
      profiles.has(arg) ||
      arg.startsWith("-P") ||
      [...profiles].some((flag) => arg.startsWith(flag + "="))
    ) {
      const profile = profiles.has(arg)
        ? args[++index]
        : arg.startsWith("-P")
          ? arg.slice(2)
          : arg.slice(arg.indexOf("=") + 1);
      if (profile === undefined) throw new InvalidContext("missing permission profile value");
      if (profile !== "dotfiles-secure")
        throw new InvalidContext("permission profile must remain dotfiles-secure");
    } else if (arg === "features" || prohibited.has(arg.split("=", 1)[0]) || /^-[Csp]/.test(arg)) {
      throw new InvalidContext(`argument can replace the worktree runtime boundary: ${arg}`);
    }
  }
}

try {
  const launch = JSON.parse(readFileSync("/nix/codex-isolation/launch.json", "utf8"));
  const args = rawArguments();
  validate(args);
  const repo = Repository.discover(launch.root, { linkedOnly: true });
  if (
    repo.gitDir !== launch.git_dir ||
    repo.commonDir !== launch.common_dir ||
    process.cwd() !== repo.root
  )
    throw new InvalidContext("isolated Git ownership does not match the selected worktree");
  const codex = executable("codex");
  if (!codex) throw new Error("the selected Codex is unavailable");
  const env = prepareEnvironment(repo, process.env, { requireTrust: false, isolated: true });
  env.CODEX_HOME = "/home/agent/.codex";
  env.TMPDIR = mkdtempSync("/tmp/codex/codex-worktree-");
  for (const key of Object.keys(env)) {
    if (key.startsWith("LD_")) delete env[key];
  }
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "NIX_CONFIG",
    "NIX_REMOTE",
    "NIX_SSL_CERT_FILE",
    "SSL_CERT_FILE",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const overrides = [
    'default_permissions="dotfiles-secure"',
    'model_provider="isolated"',
    'model_providers.isolated={name="Isolated model",base_url="http://127.0.0.1:8123/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}',
    'web_search="disabled"',
    "features.shell_snapshot=false",
    "features.network_proxy=true",
  ];
  closeSync(openSync("/result/codex-started", "a"));
  writeExecFrame(
    [codex, "-C", repo.root, ...overrides.flatMap((value) => ["-c", value]), ...args],
    env,
  );
} catch (error) {
  console.error(`codex-worktree: ${(error as Error).message}; initialization incomplete`);
  process.exitCode = 1;
}
