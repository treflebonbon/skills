import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { findCLI } from "./cli-path.ts";
import { validateGitHubPolicy, type GitHubPolicy } from "./raw-github-policy.ts";
import { equalStrictJSON, parseStrictJSON } from "./strict-json.ts";

export class GitHubOperationDenied extends Error {}

export type GitHubSeed = { pack: Uint8Array; pushHelper: string };

function executable(name: string) {
  const path = findCLI(name);
  if (!path) throw new Error(`host tool is unavailable: ${name}`);
  return realpathSync(path);
}

function toolPath(names: string[]) {
  return [...new Set(names.map((name) => dirname(executable(name))))].join(delimiter);
}

async function command(
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  timeout: number,
  signal: AbortSignal,
  input?: Uint8Array,
) {
  signal.throwIfAborted();
  const child = Bun.spawn(argv, {
    env,
    cwd,
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    stdin: input ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [output, status] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    child.exited,
  ]);
  return { output: Buffer.from(output), status };
}

export function githubProbe(signal: AbortSignal) {
  const gh = executable("gh");
  const env = {
    HOME: homedir(),
    PATH: toolPath(["gh", "git"]),
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
  };
  return async () =>
    command(
      [gh, "api", "repos/octocat/Hello-World", "--method", "GET", "--jq", "{full_name:.full_name}"],
      env,
      "/",
      30_000,
      signal,
    );
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function project(value: unknown, fields: readonly string[]) {
  if (!record(value)) throw new Error("GitHub returned an invalid response");
  return Object.fromEntries(
    fields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]),
  );
}

function prResult(value: unknown) {
  return project(value, ["number", "html_url", "title", "body", "state", "draft", "head", "base"]);
}

function textFields(payload: unknown, fields: readonly string[]) {
  return (
    record(payload) &&
    Object.keys(payload).length > 0 &&
    Object.entries(payload).every(
      ([key, value]) =>
        fields.includes(key) &&
        typeof value === "string" &&
        [...value].length <= 65536 &&
        (key !== "title" || /^[a-z]+(?:\([^)]+\))?!?: [^\n]+/.test(value)),
    )
  );
}

function decodeBundle(value: string) {
  const padding = value.indexOf("=");
  const length = padding === -1 ? value.length : padding;
  const required = (4 - (length % 4)) % 4;
  if (
    required === 3 ||
    value.length - length !== required ||
    /[^A-Za-z0-9+/]/.test(value.slice(0, length)) ||
    /[^=]/.test(value.slice(length))
  )
    throw new GitHubOperationDenied("invalid publication bundle");
  return Buffer.from(value, "base64");
}

class Publication {
  private head: string;
  private queue = Promise.resolve();
  private readonly env: Record<string, string>;
  private readonly helper: string;

  constructor(
    private readonly directory: string,
    private readonly policy: GitHubPolicy,
    private readonly signal: AbortSignal,
    environment: Record<string, string>,
  ) {
    this.head = policy.reviewed_commit;
    this.helper = join(directory, "git-push-topic");
    this.env = {
      ...environment,
      PATH: toolPath(["git", "gh", "bash", "cat", "awk"]),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_COUNT: "6",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "!gh auth git-credential",
      GIT_CONFIG_KEY_2: "core.hooksPath",
      GIT_CONFIG_VALUE_2: "/dev/null",
      GIT_CONFIG_KEY_3: "protocol.file.allow",
      GIT_CONFIG_VALUE_3: "always",
      GIT_CONFIG_KEY_4: "fetch.fsckObjects",
      GIT_CONFIG_VALUE_4: "true",
      GIT_CONFIG_KEY_5: "transfer.fsckObjects",
      GIT_CONFIG_VALUE_5: "true",
    };
  }

  private async git(args: string[], data?: Uint8Array) {
    const result = await command(
      ["git", "-C", this.directory, ...args],
      this.env,
      this.directory,
      120_000,
      this.signal,
      data,
    );
    if (result.status)
      throw new GitHubOperationDenied("invalid publication history or non-fast-forward update");
    return result.output;
  }

  async initialize({ pack, pushHelper }: GitHubSeed) {
    mkdirSync(this.directory, { mode: 0o700 });
    await this.git(["init", "-q"]);
    await this.git(["index-pack", "--strict", "--stdin"], pack);
    const branch = `refs/heads/${this.policy.branch}`;
    await this.git(["check-ref-format", branch]);
    await this.git(["symbolic-ref", "HEAD", branch]);
    await this.git(["update-ref", "HEAD", this.head]);
    await this.git(["remote", "add", "origin", `https://github.com/${this.policy.repository}.git`]);
    writeFileSync(this.helper, pushHelper, { mode: 0o600 });
  }

  push(head: string, encodedBundle: string, checkAutomation: () => Promise<void>) {
    const result = this.queue.then(async () => {
      this.signal.throwIfAborted();
      const bundle = decodeBundle(encodedBundle);
      if (bundle.length) {
        const path = join(this.directory, "incoming.bundle");
        writeFileSync(path, bundle, { mode: 0o600 });
        const advertised = (await this.git(["bundle", "list-heads", path])).toString().trim();
        if (advertised !== `${head} HEAD`)
          throw new GitHubOperationDenied("publication bundle must contain only the selected HEAD");
        await this.git([
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--no-write-fetch-head",
          path,
          "HEAD",
        ]);
      }
      await this.git(["merge-base", "--is-ancestor", this.head, head]);
      const base = this.policy.reviewed_commit;
      const automation = await this.git(["ls-tree", base, "--", ".github"]);
      const commits = (await this.git(["rev-list", `${base}..${head}`])).toString().trim();
      for (const commit of commits ? commits.split("\n") : []) {
        if (!(await this.git(["ls-tree", commit, "--", ".github"])).equals(automation))
          throw new GitHubOperationDenied("unreviewed automation changes cannot be published");
      }
      await checkAutomation();
      await this.git(["update-ref", "HEAD", head]);
      const result = await command(
        ["bash", this.helper],
        this.env,
        this.directory,
        180_000,
        this.signal,
      );
      if (result.status)
        throw new Error("topic push failed; inspect host authorization or remote divergence");
      this.head = head;
      return { head, branch: this.policy.branch, repository: this.policy.repository };
    });
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

export class GitHubService {
  private readonly prefix: string;
  private readonly environment: Record<string, string>;
  private readonly gh: string;
  private publication?: Publication;

  private constructor(
    private readonly policy: GitHubPolicy,
    private readonly signal: AbortSignal,
  ) {
    const home = homedir();
    this.prefix = `/repos/${policy.repository}`;
    this.gh = executable("gh");
    this.environment = {
      HOME: home,
      PATH: toolPath(["gh", "git"]),
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      GH_CONFIG_DIR: resolve(
        process.env.GH_CONFIG_DIR ||
          join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "gh"),
      ),
    };
  }

  static async open(
    policy: unknown,
    signal: AbortSignal,
    seed?: { directory: string; input: GitHubSeed },
  ) {
    const service = new GitHubService({ ...validateGitHubPolicy(policy) }, signal);
    await service.metadata();
    if (seed) {
      const publication = new Publication(
        seed.directory,
        service.policy,
        signal,
        service.environment,
      );
      await publication.initialize(seed.input);
      service.publication = publication;
    }
    return service;
  }

  private async api(method: string, path: string, payload?: unknown) {
    const argv = [this.gh, "api", path.slice(1), "--method", method];
    if (payload !== undefined) argv.push("--input", "-");
    const result = await command(
      argv,
      this.environment,
      "/",
      60_000,
      this.signal,
      payload === undefined ? undefined : Buffer.from(JSON.stringify(payload)),
    );
    if (result.status)
      throw new Error(
        "GitHub request failed; check host login, granted repository access and network",
      );
    return parseStrictJSON(result.output);
  }

  private async metadata() {
    const value = await this.api("GET", this.prefix);
    if (
      value?.full_name !== this.policy.repository ||
      value.private !== false ||
      value.default_branch !== this.policy.default_branch
    )
      throw new Error(
        "GitHub repository visibility or default branch differs from the reviewed public scope",
      );
    return project(value, ["full_name", "private", "default_branch"]);
  }

  private async automationTree(revision: string) {
    const value = await this.api("GET", `${this.prefix}/git/trees/${encodeURIComponent(revision)}`);
    if (
      !record(value) ||
      value.truncated ||
      !Array.isArray(value.tree) ||
      value.tree.some((entry) => !record(entry) || typeof entry.path !== "string")
    )
      throw new Error("cannot verify the reviewed automation tree");
    return value.tree.find((entry) => entry.path === ".github") ?? null;
  }

  private async checkAutomation(topic = false) {
    await this.metadata();
    const reviewed = await this.automationTree(this.policy.reviewed_commit);
    if (!equalStrictJSON(reviewed, await this.automationTree(this.policy.default_branch)))
      throw new Error("remote automation changed; review it on the host before publishing");
    if (topic && !equalStrictJSON(reviewed, await this.automationTree(this.policy.branch)))
      throw new GitHubOperationDenied("topic automation differs from the reviewed commit");
  }

  private async selectedPR(number: string) {
    const value = await this.api("GET", `${this.prefix}/pulls/${number}`);
    if (
      value?.head?.ref !== this.policy.branch ||
      value.head.repo?.full_name !== this.policy.repository ||
      value.base?.ref !== this.policy.default_branch
    )
      throw new GitHubOperationDenied("PR is outside the selected topic");
    return value;
  }

  async dispatch(method: string, path: string, payload: unknown) {
    if (method === "POST" && path === "/topic-push") {
      if (
        !this.publication ||
        !record(payload) ||
        Object.keys(payload).length !== 2 ||
        typeof payload.head !== "string" ||
        !/^[0-9a-f]{40}(?![\s\S])/.test(payload.head) ||
        typeof payload.bundle !== "string"
      )
        throw new GitHubOperationDenied("topic publication is not admitted");
      return this.publication.push(payload.head, payload.bundle, () => this.checkAutomation());
    }
    if (method === "GET" && path === this.prefix) return this.metadata();
    const pulls = `${this.prefix}/pulls`;
    if (method === "GET" && path === pulls) {
      const owner = this.policy.repository.split("/")[0];
      const values = await this.api(
        "GET",
        `${pulls}?head=${encodeURIComponent(`${owner}:${this.policy.branch}`)}`,
      );
      if (!Array.isArray(values)) throw new Error("GitHub returned an invalid response");
      return values.map(prResult);
    }
    if (method === "POST" && path === pulls) {
      if (
        !record(payload) ||
        !Object.keys(payload).every((field) =>
          ["title", "body", "head", "base", "draft"].includes(field),
        ) ||
        payload.head !== this.policy.branch ||
        payload.base !== this.policy.default_branch ||
        typeof payload.title !== "string" ||
        (Object.hasOwn(payload, "draft") && typeof payload.draft !== "boolean") ||
        !textFields(project(payload, ["title", "body"]), ["title", "body"])
      )
        throw new GitHubOperationDenied("PR creation is outside the selected topic");
      await this.checkAutomation(true);
      return prResult(await this.api("POST", pulls, payload));
    }
    const relative = path.startsWith(`${this.prefix}/`) ? path.slice(this.prefix.length) : "";
    const pull = /^\/pulls\/([1-9][0-9]*)(?![\s\S])/.exec(relative);
    if (pull && (method === "GET" || method === "PATCH")) {
      if (method === "PATCH" && !textFields(payload, ["title", "body"]))
        throw new GitHubOperationDenied("only PR title and body edits are permitted");
      const value = await this.selectedPR(pull[1]);
      if (method === "GET") return prResult(value);
      await this.checkAutomation(true);
      return prResult(await this.api("PATCH", path, payload));
    }
    const comment = /^\/issues\/([1-9][0-9]*)\/comments(?![\s\S])/.exec(relative);
    if (comment && method === "POST" && textFields(payload, ["body"])) {
      await this.selectedPR(comment[1]);
      await this.checkAutomation(true);
      const result = project(await this.api("POST", path, payload), ["id", "html_url", "body"]);
      if (Object.keys(result).length !== 3) throw new Error("GitHub returned an invalid response");
      return result;
    }
    throw new GitHubOperationDenied("GitHub operation is outside the admitted scope");
  }
}
