import { parseArgs } from "node:util";
import { trustCommand } from "./devshell-environment.ts";
import { Repository } from "./git-context.ts";
import { admitRawInputs } from "./raw-admission.ts";
import { validateCodexArguments } from "./raw-codex-arguments.ts";
import { rawArguments } from "./raw-exec-frame.ts";

const usage = "usage: devshell-env {trust|untrust|status|admit|codex|with-env}";
const admissionUsage =
  "usage: devshell-env admit --git-head FULL_SHA [--mcp {context7,serena}] [--github-policy PATH] -- FILES";
const [command, ...args] = process.platform === "linux" ? rawArguments() : process.argv.slice(2);

class UsageError extends Error {}

function admission() {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        "git-head": { type: "string" },
        mcp: { type: "string", multiple: true },
        "github-policy": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError(`${admissionUsage}\n${(error as Error).message}`);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(admissionUsage);
    return;
  }
  const head = values["git-head"];
  if (!head || !positionals.length) throw new UsageError(admissionUsage);
  const mcp = values.mcp?.filter((name) => name === "context7" || name === "serena");
  if (mcp?.length !== values.mcp?.length)
    throw new UsageError(`${admissionUsage}\ninvalid choice for --mcp`);
  const repo = Repository.discover(process.cwd(), { linkedOnly: true });
  admitRawInputs(repo, head, positionals, {
    mcp,
    githubPolicyFile: values["github-policy"],
  });
  console.log("public files, reachable Git history and managed runtime policy admitted");
}

try {
  switch (command) {
    case "codex": {
      validateCodexArguments(args);
      const { launch } = await import("./raw-host.ts");
      process.exitCode = await launch(args);
      break;
    }
    case "admit":
      admission();
      break;
    case "with-env":
      throw new Error(
        args[0] !== "--prepared"
          ? "with-env requires --prepared inside an isolated session"
          : "usage: devshell-env with-env --prepared -- command [args...]",
      );
    case "-h":
    case "--help":
      console.log(usage);
      break;
    case "trust":
    case "untrust":
    case "status": {
      const separator = args.indexOf("--");
      const beforeSeparator = separator === -1 ? args : args.slice(0, separator);
      const positionals = args[0] === "--" ? args.slice(1) : args;
      if (beforeSeparator.includes("-h") || beforeSeparator.includes("--help")) console.log(usage);
      else if (positionals.length > 1 || (positionals[0]?.startsWith("-") && args[0] !== "--"))
        throw new UsageError(usage);
      else console.log(trustCommand(command, Repository.discover(positionals[0] ?? ".")));
      break;
    }
    case undefined:
      throw new Error(usage);
    default:
      throw new UsageError(usage);
  }
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    console.error(
      `${command === "codex" ? "codex-worktree" : "devshell-env"}: ${(error as Error).message}`,
    );
    process.exitCode = 1;
  }
}
