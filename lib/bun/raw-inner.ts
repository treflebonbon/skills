import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { executable, prepareEnvironment } from "./devshell-environment.ts";
import { InvalidContext, Repository } from "./git-context.ts";
import { validateCodexArguments } from "./raw-codex-arguments.ts";
import { rawArguments, writeExecFrame } from "./raw-exec-frame.ts";

try {
  const launch = JSON.parse(readFileSync("/nix/codex-isolation/launch.json", "utf8"));
  const args = rawArguments();
  validateCodexArguments(args);
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
  writeExecFrame(
    [codex, "-C", repo.root, ...overrides.flatMap((value) => ["-c", value]), ...args],
    env,
  );
  closeSync(openSync("/result/codex-started", "a"));
} catch (error) {
  console.error(`codex-worktree: ${(error as Error).message}; initialization incomplete`);
  process.exitCode = 1;
}
