import { chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Repository } from "../../lib/bun/git-context.ts";
import { readPublicInput } from "../../lib/bun/raw-admission-files.ts";
import { rawArguments } from "../../lib/bun/raw-exec-frame.ts";
import { runIsolated } from "../../lib/bun/raw-isolation.ts";
import { selectRawLauncher } from "../../lib/bun/raw-nix-launcher.ts";
import { returnRawResult } from "../../lib/bun/raw-return.ts";
import { prepareRawWorktree, rawGit, rawGitText } from "../../lib/bun/raw-worktree.ts";
import { strictJSON } from "../../lib/bun/strict-json.ts";

const [command, ...args] = rawArguments();
const separator = args.indexOf("--");
const argumentsBefore = separator === -1 ? args : args.slice(0, separator);
const remainder = separator === -1 ? [] : args.slice(separator + 1);
const { values, positionals } = parseArgs({
  args: argumentsBefore,
  allowPositionals: true,
  options: {
    root: { type: "string" },
    policy: { type: "string" },
    output: { type: "string" },
    "git-head": { type: "string" },
    session: { type: "string" },
    service: { type: "string", multiple: true },
    "ca-bundle": { type: "string" },
    launcher: { type: "string" },
    "launcher-source": { type: "string" },
  },
});

try {
  const repo = Repository.discover(values.root!, { linkedOnly: true });
  const policy = values.policy && resolve(values.policy);
  if (command === "return") {
    const head = await returnRawResult(repo, resolve(values.session!));
    console.log(`returned HEAD ${head}, index and ordinary worktree changes`);
  } else if (!policy) throw new Error("missing fixture policy");
  else if (command === "approve") {
    for (const root of [repo.root, repo.commonDir]) {
      const suffix = relative(root, policy);
      if (!suffix || (!suffix.startsWith("../") && suffix !== ".."))
        throw new Error("input policy must be outside the worktree and Git metadata");
    }
    const head = rawGitText(repo.root, "rev-parse", "HEAD");
    if (head !== values["git-head"])
      throw new Error("approval must name the current full Git HEAD");
    if (rawGit(repo.root, ["diff", "--cached", "--name-only"]).length)
      throw new Error("initial approval requires an index matching HEAD");
    const names = [...positionals, ...remainder];
    if (!names.length) throw new Error("name the public input files explicitly");
    const files = Object.fromEntries(
      names.map((name) => [name, readPublicInput(repo.root, name).fingerprint]),
    );
    const record = {
      version: 1,
      root: repo.root,
      repository: repo.identity(),
      git_head: head,
      index_tree: rawGitText(repo.root, "write-tree"),
      files,
    };
    writeFileSync(policy, strictJSON(record, 2, { ascii: true }), { flag: "wx", mode: 0o600 });
    chmodSync(policy, 0o600);
  } else if (command === "prepare") {
    prepareRawWorktree(repo, policy, resolve(values.output!));
  } else if (command === "run") {
    const services = (values.service ?? []).map((name) => {
      if (name !== "github" && name !== "model" && name !== "dependencies")
        throw new Error("invalid fixture service");
      return name;
    });
    const launcher = values.launcher
      ? selectRawLauncher(values.launcher, values["launcher-source"]!)
      : undefined;
    process.exitCode = await runIsolated(
      repo,
      policy,
      resolve(values.output!),
      remainder,
      services,
      {
        caBundle: values["ca-bundle"],
        launcher,
        runtime: launcher
          ? {
              codex_home: process.env.CODEX_HOME ?? homedir(),
              requirements: "",
              config_files: {},
              domains: [],
              denied_domains: [],
              hooks: {},
              git_identity: {},
              mcp_tools: {},
              private_tmp_codex: true,
              ca_bundle: "",
              github: null,
              push_helper: null,
              output: "default",
            }
          : undefined,
      },
    );
  } else throw new Error("unknown raw worktree fixture command");
} catch (error) {
  console.error("secret-isolation-worktree: " + (error as Error).message);
  process.exitCode = 1;
}
