import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strip } from "./coordination-json.ts";
import { decodeSurrogateEscape, executable, trustFile } from "./devshell-environment.ts";
import { hash } from "./file-safety.ts";
import { gitEnvironment, type Repository } from "./git-context.ts";
import {
  openInputPolicy,
  publishInputPolicy,
  readPublicInput,
  type InputFingerprint,
} from "./raw-admission-files.ts";
import {
  asciiJSON,
  isTable,
  readManagedConfig,
  tomlDocument,
  within,
  type Table,
} from "./raw-admission-config.ts";
import { type GitHubPolicy, validateGitHubPolicy } from "./raw-github-policy.ts";
import { parseStrictJSON } from "./strict-json.ts";
import { orderedTable } from "./vendor/smol-toml/table.js";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const bin = fileURLToPath(new URL("../../bin/", import.meta.url));
const physical = realpathSync.native;

const mcpContracts = {
  context7: {
    command: "bunx",
    args: ["-y", "@upstash/context7-mcp"],
    tools: ["bunx", "node"],
  },
  serena: {
    command: "uvx",
    args: [
      "--from",
      "git+https://github.com/oraios/serena",
      "serena",
      "start-mcp-server",
      "--enable-web-dashboard",
      "false",
    ],
    tools: ["uvx"],
  },
} as const;

type AdmissionOptions = {
  githubPolicyFile?: string;
  mcp?: readonly (keyof typeof mcpContracts)[];
};

function git(repo: Repository, ...args: string[]): Buffer {
  const result = spawnSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", repo.root, ...args],
    {
      env: {
        PATH: process.env.PATH,
        HOME: "/nonexistent",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
    },
  );
  if (result.status !== 0) throw new Error(`Git ${args[0]} failed; no input was published`);
  return result.stdout;
}

function readText(root: string, name: string): string {
  return decoder.decode(readPublicInput(root, name).bytes);
}

function isOutsideProject(file: string, repo: Repository): boolean {
  return !within(file, repo.root) && !within(file, repo.commonDir);
}

function managedMcp(config: Table, selected: NonNullable<AdmissionOptions["mcp"]>) {
  const servers: Table = Object.create(null);
  const tools: Record<string, string> = Object.create(null);
  for (const name of selected) {
    if (!Object.hasOwn(mcpContracts, name)) throw new Error("invalid managed MCP selection");
    const contract = mcpContracts[name];
    const server = isTable(config.mcp_servers) ? config.mcp_servers[name] : undefined;
    if (
      !isTable(server) ||
      Object.keys(server).length !== 2 ||
      server.command !== contract.command ||
      !Array.isArray(server.args) ||
      server.args.length !== contract.args.length ||
      !server.args.every((value, index) => value === contract.args[index])
    ) {
      throw new Error(`managed MCP configuration differs: ${name}; review it on the host`);
    }
    for (const tool of contract.tools) {
      const candidate = executable(tool);
      if (!candidate || !within(candidate, "/nix/store"))
        throw new Error(`managed MCP requires a Nix store tool: ${tool}`);
      const alias = join(dirname(candidate), tool);
      if (physical(alias) !== candidate)
        throw new Error(`managed MCP requires the Nix store alias: ${tool}`);
      tools[tool] = alias;
    }
    servers[name] = {
      command: tools[contract.command],
      args: contract.args,
      enabled: true,
      required: true,
      startup_timeout_sec: 180n,
      env_vars: ["HTTPS_PROXY", "HTTP_PROXY", "SSL_CERT_FILE"],
    };
  }
  return { servers, tools };
}

function policyJSON(bytes: Buffer): unknown {
  // json.loads(bytes) recognizes BOMs and the UTF-16/32 encodings without BOMs.
  const first = bytes[0],
    second = bytes[1],
    third = bytes[2],
    fourth = bytes[3];
  const utf32le =
    (first === 0xff && second === 0xfe && third === 0 && fourth === 0) ||
    (first !== 0 && second === 0 && third === 0 && fourth === 0);
  const utf32be = first === 0 && second === 0 && fourth !== undefined;
  let text: string;
  if (utf32le || utf32be) {
    if (bytes.length % 4) throw new Error("invalid GitHub policy JSON encoding");
    const characters: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 4) {
      const code = utf32le ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
      if (offset === 0 && code === 0xfeff) continue;
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        throw new Error("invalid GitHub policy JSON encoding");
      characters.push(String.fromCodePoint(code));
    }
    text = characters.join("");
  } else {
    let encoding = "utf-8";
    if ((first === 0xff && second === 0xfe) || second === 0) encoding = "utf-16le";
    if ((first === 0xfe && second === 0xff) || first === 0) encoding = "utf-16be";
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  }
  try {
    return parseStrictJSON(Buffer.from(text));
  } catch {
    throw new Error("invalid GitHub policy JSON");
  }
}

function bindGitHubPolicy(repo: Repository, head: string, file: string): GitHubPolicy {
  const path = resolve(file);
  if (!isOutsideProject(physical(path), repo))
    throw new Error("GitHub policy must be owned outside the project");
  const policy = validateGitHubPolicy(
    policyJSON(readPublicInput(dirname(path), basename(path)).bytes),
  );
  if (strip(decoder.decode(git(repo, "branch", "--show-current"))) !== policy.branch)
    throw new Error("GitHub policy belongs to another topic branch");
  const origin = strip(decoder.decode(git(repo, "remote", "get-url", "origin")));
  const expected = "https://github.com/" + policy.repository;
  if (origin !== expected && origin !== expected + ".git")
    throw new Error("GitHub policy does not match the HTTPS origin");
  git(repo, "merge-base", "--is-ancestor", policy.reviewed_commit, head);
  return policy;
}

function localGitConfig(repo: Repository, ...args: string[]) {
  return spawnSync("git", ["-C", repo.root, ...args], {
    env: gitEnvironment(),
    encoding: "utf8",
  });
}

function gitRuntime(repo: Repository) {
  const hooks: Record<string, string> = orderedTable();
  const result = localGitConfig(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks");
  if (result.status !== 0) throw new Error("Git rev-parse failed; no input was published");
  const directory = strip(result.stdout);
  if (statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    for (const bytes of readdirSync(directory, { encoding: "buffer" })) {
      const name = decodeSurrogateEscape(bytes);
      if (name.endsWith(".sample")) continue;
      try {
        accessSync(Buffer.concat([Buffer.from(directory + "/"), bytes]), constants.X_OK);
      } catch {
        continue;
      }
      hooks[name] = readText(directory, name);
    }
  }
  const git_identity: Record<string, string> = Object.create(null);
  for (const name of ["user.name", "user.email"]) {
    const result = localGitConfig(repo, "config", "--get", name);
    if (result.status === 0)
      git_identity[name] = result.stdout.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  }
  return { hooks, git_identity };
}

function publicRuntime(
  repo: Repository,
  head: string,
  { githubPolicyFile, mcp = [] }: AdmissionOptions,
) {
  const codex_home = physical(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  if (!isOutsideProject(codex_home, repo))
    throw new Error("Codex configuration must be outside the project");
  const { config, profile, domains, denied } = readManagedConfig(
    readText(codex_home, "config.toml"),
    repo,
  );
  const { servers, tools: mcp_tools } = managedMcp(config, mcp);
  config.mcp_servers = servers;
  const plugins = Object.hasOwn(config, "plugins") ? config.plugins : {};
  if (!isTable(plugins)) throw new Error("managed plugins configuration must be a table");
  const disabledPlugins = orderedTable<{ enabled: false }>();
  for (const name of Object.keys(plugins)) disabledPlugins[name] = { enabled: false };
  config.plugins = disabledPlugins;

  const github =
    githubPolicyFile === undefined ? null : bindGitHubPolicy(repo, head, githubPolicyFile);
  const push_helper = github ? readText(physical(bin), "git-push-topic") : null;
  const config_files: Record<string, string> = { "config.toml": tomlDocument(config) };
  for (const name of ["AGENTS.md", "rules/default.rules"])
    if (existsSync(join(codex_home, name))) config_files[name] = readText(codex_home, name);

  const local = gitRuntime(repo);
  const requirements = tomlDocument({
    default_permissions: "dotfiles-secure",
    allowed_permission_profiles: { "dotfiles-secure": true },
    permissions: { "dotfiles-secure": profile },
  });
  const ca =
    process.env.CODEX_ISOLATION_CA_BUNDLE ||
    process.env.NIX_SSL_CERT_FILE ||
    process.env.SSL_CERT_FILE;
  const ca_bundle = ca ? physical(ca) : "";
  if (!ca_bundle || !within(ca_bundle, "/nix/store") || ca_bundle === "/nix/store")
    throw new Error("select the public Nix CA bundle with CODEX_ISOLATION_CA_BUNDLE");

  return {
    codex_home,
    config_files,
    requirements,
    domains,
    denied_domains: denied,
    ...local,
    ca_bundle,
    mcp_tools,
    private_tmp_codex: true,
    github,
    push_helper,
  };
}

export function admitRawInputs(
  repo: Repository,
  head: string,
  names: readonly string[],
  options: AdmissionOptions = {},
): string {
  if (repo.gitDir === repo.commonDir)
    throw new Error("current directory is not a linked Git worktree");
  const repository = repo.identity();
  const path = join(
    dirname(dirname(trustFile(repo))),
    "inputs",
    hash(Buffer.from(repo.root)) + ".json",
  );
  const parent = openInputPolicy(path);
  try {
    const runtime = publicRuntime(repo, head, options);
    if (strip(decoder.decode(git(repo, "rev-parse", "HEAD"))) !== head)
      throw new Error("approval must name the current full Git HEAD");
    const files: Record<string, InputFingerprint> = orderedTable();
    for (const name of names) files[name] = readPublicInput(repo.root, name).fingerprint;
    if (git(repo, "diff", "--cached", "--name-only").length)
      throw new Error("initial approval requires an index matching HEAD");
    if (!Object.keys(files).length) throw new Error("name the public input files explicitly");
    const index_tree = strip(decoder.decode(git(repo, "write-tree")));
    const headTree = strip(decoder.decode(git(repo, "rev-parse", head + "^{tree}")));
    if (index_tree !== headTree)
      throw new Error("initial approval requires an index matching HEAD");
    repo.checkUnchanged(repository);
    const record = {
      version: 1,
      root: repo.root,
      repository,
      git_head: head,
      index_tree,
      files,
      runtime,
    };
    const jsonify = JSON as typeof JSON & { rawJSON(text: string): unknown };
    const text = JSON.stringify(
      record,
      (_key, value) => (typeof value === "bigint" ? jsonify.rawJSON(value.toString()) : value),
      2,
    );
    publishInputPolicy(parent, asciiJSON(text) + "\n");
    return path;
  } finally {
    closeSync(parent.fd);
  }
}
