import { X509Certificate } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";
import type { RawRuntime } from "./raw-admission.ts";
import { readPublicInput } from "./raw-admission-files.ts";
import { executable } from "./devshell-environment.ts";
import type { Repository } from "./git-context.ts";
import { encodeSurrogateEscape } from "./raw-exec-frame.ts";
import {
  GatewayCleanupError,
  withGatewayScope,
  type GatewayOptions,
  type Service,
} from "./raw-gateway.ts";
import { nixStore, type RawNixLauncher } from "./raw-nix-launcher.ts";
import { prepareRawWorktree, rawGit } from "./raw-worktree.ts";

const hostBun = import.meta.dir;
const innerRoot = "/nix/codex-isolation";
const innerBun = innerRoot + "/lib/bun";
export const isolationTools = ["nix", "bash", "cat", "git", "codex", "gh", "bwrap", "bun"] as const;
export const namespaceTools = ["unshare", "ip", "setpriv"] as const;

export function nixExecutable(name: string) {
  const path = executable(name);
  if (!path?.startsWith(nixStore + sep))
    throw new Error(`isolation tool must come from the Nix store: ${name}`);
  return path;
}

function toolOutput(path: string) {
  return path.split(sep).slice(0, 4).join(sep);
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const shell = (argv: string[]) => argv.map(quote).join(" ");

export function launcherArgv(launcher: RawNixLauncher, entry: string) {
  // Bun consumes the separators, and the launcher accepts even an empty caller argv.
  return [launcher.executable, innerBun + "/run", "--", innerBun + "/" + entry, "--"];
}

function execWrapper(path: string, bash: string, argv: string[]) {
  writeFileSync(path, `#!${bash} -p\nexec ${shell(argv)} "$@"\n`);
  chmodSync(path, 0o755);
}

export function bridgeStartup(service: string, port: number) {
  return `bridge_read_status=0
IFS= read -r -t 30 bridge_ready < <(
    ${innerBun}/run run ${innerBun}/raw-gateway-bridge.ts /gateway/${service}/service.sock ${port} </dev/null
) || bridge_read_status=$?
if [ "$bridge_read_status" -gt 128 ]; then
    printf '%s\\n' 'gateway bridge did not start: no readiness within 30s' >&2
    exit 1
elif [ "$bridge_read_status" -ne 0 ]; then
    kill "$!" 2>/dev/null || :
    bridge_status=0
    wait "$!" || bridge_status=$?
    printf 'gateway bridge did not start: bridge exited with status %s\\n' "$bridge_status" >&2
    exit 1
elif [ "$bridge_ready" != ready ]; then
    printf '%s\\n' 'gateway bridge did not start: unexpected readiness line' >&2
    exit 1
fi
`;
}

function publicCA(path: string) {
  const text = readFileSync(path, "utf8");
  const certificates = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!certificates?.length) throw new Error("invalid public Nix CA bundle");
  return [...new Set(certificates.map((pem) => new X509Certificate(pem).toString()))].join("");
}

const resultExport = `
set +e
"$@"
command_status=$?
set -e
git rev-parse HEAD > /result/head
git write-tree > /result/index-tree
git ls-files --cached --others --exclude-standard -z > /result/files
index_commit=$(GIT_AUTHOR_NAME=Isolation GIT_AUTHOR_EMAIL=isolation@example.invalid GIT_COMMITTER_NAME=Isolation GIT_COMMITTER_EMAIL=isolation@example.invalid git commit-tree "$(cat /result/index-tree)" -p HEAD -m 'test: preserve isolated index')
git update-ref refs/isolation/index "$index_commit"
git bundle create /result/commits.bundle HEAD refs/isolation/index
printf '%s\\n' "$command_status" > /result/exit-code
`;

function copyRuntime(output: string, services: readonly Service[], runtime?: RawRuntime) {
  const dir = join(output, "runtime/lib/bun");
  mkdirSync(dir, { recursive: true });
  const files = ["run", "bunfig.toml", "tsconfig.json"];
  if (services.length) files.push("raw-gateway-bridge.ts");
  if (runtime)
    files.push(
      "raw-inner.ts",
      "raw-with-env.ts",
      "raw-exec-frame.ts",
      "raw-codex-arguments.ts",
      "devshell-environment.ts",
      "cli-path.ts",
      "coordination-json.ts",
      "git-context.ts",
      "strict-json.ts",
    );
  if (runtime?.github) files.push("raw-github-client.ts");
  for (const file of files) {
    const target = join(dir, file);
    copyFileSync(join(hostBun, file), target);
  }
}

function configureRuntime(
  output: string,
  repo: Repository,
  runtime: RawRuntime,
  launcher: RawNixLauncher,
  bash: string,
  mounts: string[],
) {
  const copied = join(output, "runtime");
  const wrappers = join(copied, "bin");
  mkdirSync(wrappers);
  if (runtime.github) {
    const client = [innerBun + "/run", "run", innerBun + "/raw-github-client.ts"];
    execWrapper(join(wrappers, "git-push-topic"), bash, client);
    execWrapper(join(wrappers, "gh"), bash, [...client, "gh"]);
  }
  execWrapper(join(wrappers, "with-env"), bash, launcherArgv(launcher, "raw-with-env.ts"));
  const config = join(output, "config");
  mkdirSync(config);
  // Codex saves TUI trust by atomically replacing config.toml.
  mounts.push("--bind", config, "/home/agent/.codex");
  for (const [name, content] of Object.entries(runtime.config_files)) {
    const path = join(config, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (name !== "config.toml") mounts.push("--ro-bind", path, "/home/agent/.codex/" + name);
  }
  writeFileSync(
    join(copied, "launch.json"),
    JSON.stringify({
      root: repo.root,
      output: runtime.output,
      git_dir: repo.gitDir,
      common_dir: repo.commonDir,
      github: runtime.github ?? null,
    }),
  );
  const requirements = join(output, "requirements.toml");
  writeFileSync(requirements, runtime.requirements);
  mounts.push("--ro-bind", requirements, "/etc/codex/requirements.toml");
  const common = join(output, "root", repo.commonDir);
  mkdirSync(join(common, "hooks"), { recursive: true });
  for (const [name, content] of Object.entries(runtime.hooks)) {
    const path = join(common, "hooks", name);
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }
  for (const [name, value] of Object.entries(runtime.git_identity))
    rawGit(common, ["config", name, value]);
  rawGit(common, ["config", "commit.gpgsign", "false"]);
  return (
    "export CODEX_HOME=/home/agent/.codex\nexport PATH=/nix/codex-isolation/bin:$PATH\n" +
    "export DEVSHELL_ENV_OUTPUT=" +
    quote(runtime.output) +
    "\n"
  );
}

async function childStatus(
  argv: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  stdio: ["inherit" | "ignore", "inherit" | number, "inherit" | number, ...number[]],
) {
  signal.throwIfAborted();
  const child = Bun.spawn(argv, {
    env,
    signal,
    killSignal: "SIGKILL",
    stdio,
  });
  const status = await child.exited;
  signal.throwIfAborted();
  return status;
}

async function isolatedStatus(
  argv: string[],
  command: string[],
  output: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  const path = join(output, "command-argv");
  const fd = openSync(path, "wx+", 0o600);
  try {
    // Unlink before writing argv. Positional writes leave the read offset at zero.
    unlinkSync(path);
    const bytes = encodeSurrogateEscape(command.map((arg) => arg + "\0").join(""));
    for (let offset = 0; offset < bytes.length;)
      offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    return await childStatus(argv, environment, signal, ["inherit", "inherit", "inherit", fd]);
  } finally {
    closeSync(fd);
  }
}

type IsolationOptions = {
  caBundle?: string;
  runtime?: RawRuntime;
  launcher?: RawNixLauncher;
  approval?: Record<string, unknown>;
  signal?: AbortSignal;
};

export async function runIsolated(
  repo: Repository,
  policy: string,
  output: string,
  command: string[],
  services: readonly Service[],
  options: IsolationOptions = {},
) {
  const { caBundle, launcher, runtime } = options;
  const signal = options.signal ?? new AbortController().signal;
  if (services.includes("dependencies") && !caBundle)
    throw new Error("dependency access requires an explicitly selected public CA bundle");
  if (runtime && !launcher) throw new Error("raw runtime requires an explicitly selected launcher");
  const record = prepareRawWorktree(repo, policy, output, options.approval);
  const paths = Object.fromEntries(
    isolationTools.map((name) => [name, toolOutput(nixExecutable(name))]),
  );
  const python = executable("python3");
  if (python?.startsWith(nixStore + sep)) paths.python3 = toolOutput(python);
  for (const [name, selected] of Object.entries(runtime?.mcp_tools ?? {})) {
    const physical = realpathSync(selected);
    if (!physical.startsWith(nixStore + sep))
      throw new Error("admitted MCP tool is no longer in the Nix store");
    paths[name] = toolOutput(physical);
  }
  if (runtime?.github) paths.jq = toolOutput(nixExecutable("jq"));
  const store = join(output, "store");
  const bootstrap = join(output, "bootstrap");
  mkdirSync(bootstrap);
  const environment = {
    HOME: bootstrap,
    PATH: Object.values(paths)
      .map((path) => join(path, "bin"))
      .join(delimiter),
    NIX_CONF_DIR: bootstrap,
    NIX_CONFIG: "experimental-features = nix-command flakes\n",
  };
  const roots = Object.values(paths);
  if (launcher) roots.push(launcher.package);
  const log = openSync(join(output, "store-copy.log"), "w");
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
    if (
      await childStatus(
        [join(paths.nix, "bin/nix"), "copy", "--to", store, "--no-check-sigs", ...roots],
        environment,
        deadline,
        ["ignore", log, log],
      )
    )
      throw new Error("Nix runtime copy failed; the session is retained for recovery");
  } finally {
    closeSync(log);
  }
  const query = Bun.spawnSync(
    [join(paths.nix, "bin/nix-store"), "--query", "--requisites", ...roots],
    { env: environment },
  );
  if (!query.success) throw new Error("Nix runtime closure query failed");
  const closure = query.stdout.toString().trimEnd().split("\n");
  const copiedStore = join(store, "nix/store");
  launcher?.verifyCopy(copiedStore, closure);
  const result = join(output, "result");
  mkdirSync(result);
  const mounts: string[] = [];
  for (const path of closure) {
    if (dirname(path) !== nixStore) throw new Error("invalid runtime closure path");
    mounts.push("--ro-bind", join(store, path), path);
  }
  let status = 0;
  try {
    return await withGatewayScope(async (startGateway) => {
      try {
        for (const service of services) {
          signal.throwIfAborted();
          const settings: GatewayOptions = runtime
            ? {
                domains: runtime.domains,
                deniedDomains: runtime.denied_domains,
                codexHome: runtime.codex_home,
              }
            : {};
          if (service === "dependencies" && runtime?.github) {
            const common = join(output, "root", repo.commonDir);
            settings.githubPolicy = runtime.github;
            settings.githubSeed = {
              pack: rawGit(common, ["pack-objects", "--stdout", "--revs"], {
                gitDir: common,
                input: Buffer.from(record.git_head + "\n"),
              }),
              pushHelper: runtime.push_helper!,
            };
          }
          const directory = await startGateway(service, settings);
          mounts.push("--ro-bind", directory, "/gateway/" + service);
        }
      } catch (error) {
        throw new Error(
          `service setup failed: ${(error as Error).message}; no isolated command was started`,
        );
      }
      const bash = join(paths.bash, "bin/bash");
      if (runtime || services.length) {
        copyRuntime(output, services, runtime);
        mounts.push("--ro-bind", join(output, "runtime"), innerRoot);
      }
      let startup = "";
      for (const [service, port] of [
        ["model", 8123],
        ["dependencies", 8124],
      ] as const)
        if (services.includes(service)) startup += bridgeStartup(service, port);
      if (services.includes("dependencies")) {
        const path = join(output, "ca-bundle.crt");
        const resolved = realpathSync(caBundle!);
        if (!resolved.startsWith(nixStore + sep))
          throw new Error("select the public CA bundle from a trusted Nix tool closure");
        writeFileSync(path, publicCA(resolved));
        const certificate = runtime ? "/nix/codex-ca-bundle.crt" : "/ca-bundle.crt";
        mounts.push("--ro-bind", path, certificate);
        startup += `export HTTPS_PROXY=http://127.0.0.1:8124 HTTP_PROXY=http://127.0.0.1:8124
export https_proxy=$HTTPS_PROXY http_proxy=$HTTP_PROXY
export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
export NIX_SSL_CERT_FILE=${certificate} SSL_CERT_FILE=${certificate}
`;
        if (runtime) {
          const resolver = join(output, "resolv.conf");
          writeFileSync(resolver, "nameserver 127.0.0.1\noptions timeout:2 attempts:2\n");
          mounts.push("--ro-bind", resolver, "/etc/resolv.conf");
          startup += `${innerBun}/run run ${innerBun}/raw-gateway-bridge.ts --dns /gateway/dependencies/service.sock </dev/null &\n`;
        }
      }
      if (runtime && launcher)
        startup += configureRuntime(output, repo, runtime, launcher, bash, mounts);
      const script = join(output, "inside.sh");
      // Bun.spawn encodes strings as UTF-8. Pass the command in a byte stream on fd 3.
      writeFileSync(
        script,
        'set -eu\nmapfile -d "" -t command <&3\nexec 3<&-\nset -- "${command[@]}"\n' +
          startup +
          resultExport,
      );
      const fs = join(output, "root");
      let argv = [
        join(paths.bwrap, "bin/bwrap"),
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--clearenv",
        ...(runtime ? ["--share-net"] : []),
        "--tmpfs",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--dir",
        "/tmp",
        ...(runtime?.private_tmp_codex ? ["--dir", "/tmp/codex"] : []),
        "--dir",
        "/home/agent",
        "--bind",
        join(store, "nix"),
        "/nix",
        "--bind",
        copiedStore,
        nixStore,
        "--bind",
        join(fs, repo.root),
        repo.root,
        "--bind",
        join(fs, repo.commonDir),
        repo.commonDir,
        "--bind",
        result,
        "/result",
        "--ro-bind",
        script,
        "/inside.sh",
        ...mounts,
        "--symlink",
        bash,
        "/bin/sh",
        "--symlink",
        bash,
        "/bin/bash",
        "--symlink",
        join(paths.cat, "bin/env"),
        "/usr/bin/env",
        "--setenv",
        "HOME",
        "/home/agent",
        "--setenv",
        "PATH",
        environment.PATH,
        "--setenv",
        "LANG",
        "C.UTF-8",
        "--setenv",
        "TERM",
        "xterm-256color",
        "--setenv",
        "NIX_REMOTE",
        "local",
        "--setenv",
        "NIX_CONFIG",
        "experimental-features = nix-command flakes\nbuild-users-group =\nsandbox = false\nsubstituters =" +
          (runtime ? " https://cache.nixos.org" : "") +
          "\n",
        "--chdir",
        repo.root,
        bash,
        "/inside.sh",
      ];
      if (runtime) {
        const prepare = shell([
          bash,
          "-p",
          join(hostBun, "run"),
          "run",
          join(hostBun, "raw-namespace.ts"),
          String(statSync("/proc/self/ns/user", { bigint: true }).ino),
          String(statSync("/proc/self/ns/net", { bigint: true }).ino),
          nixExecutable("ip"),
        ]);
        const drop = shell([nixExecutable("setpriv"), "--inh-caps=-all", "--ambient-caps=-all"]);
        argv = [
          nixExecutable("unshare"),
          "--user",
          "--map-current-user",
          "--net",
          "--keep-caps",
          bash,
          "-p",
          "-c",
          `${prepare} && exec ${drop} "$@"`,
          "codex-namespace",
          ...argv,
        ];
      }
      const deadline = runtime ? signal : AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
      if (await isolatedStatus(argv, command, output, environment, deadline))
        throw new Error(
          "isolated execution or export failed; the session is retained for recovery",
        );
      const exitCode = readPublicInput(result, "exit-code").bytes.toString().trim();
      if (!/^\d{1,3}$/.test(exitCode) || Number(exitCode) > 255)
        throw new Error("invalid isolated exit status; the session is retained for recovery");
      status = Number(exitCode);
      return status;
    }, signal);
  } catch (error) {
    if (!(error instanceof GatewayCleanupError)) throw error;
    throw new GatewayCleanupError(
      "gateway cleanup failed; the session is retained for recovery",
      status || 1,
      { cause: error },
    );
  }
}
