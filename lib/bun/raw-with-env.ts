import { PreparationError, reuseEnvironment } from "./devshell-environment.ts";
import { Repository } from "./git-context.ts";
import { rawArguments, writeExecFrame } from "./raw-exec-frame.ts";

try {
  const [mode, ...args] = rawArguments();
  if (mode !== "--prepared")
    throw new PreparationError("with-env requires --prepared inside an isolated session");
  const argv = args[0] === "--" ? args.slice(1) : args;
  if (!argv.length)
    throw new PreparationError("usage: devshell-env with-env --prepared -- command [args...]");
  const repo = Repository.discover(process.cwd(), { allowGitfile: true });
  writeExecFrame(argv, reuseEnvironment(repo, process.env));
} catch (error) {
  console.error("devshell-env: " + (error as Error).message);
  process.exitCode = 1;
}
