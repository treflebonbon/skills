import { parseReasoningEffort } from "./devshell-environment.ts";
import { InvalidContext } from "./git-context.ts";

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

export function validateCodexArguments(args: string[]) {
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
