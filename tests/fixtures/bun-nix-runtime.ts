import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:os";
import { dirname, resolve } from "node:path";

const [action, location, selection] = process.argv.slice(2);
const report = (event: string, value: object) => console.log(JSON.stringify({ event, ...value }));
const storeRoot = (path: string) => {
  const root = path.match(/^\/nix\/store\/[a-z0-9]{32}-[a-zA-Z0-9+._?=-]+(?=\/|$)/)?.[0];
  if (!root) throw new Error("選択した tool / closure は Nix store 内である必要があります");
  return root;
};
const command = (executable: string, args: string[], env = process.env, timeout = 15_000) => {
  const result = spawnSync(executable, args, {
    env,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${executable}: status=${result.status}, signal=${result.signal}: ${result.stderr}`,
    );
  return result.stdout.trim();
};

export type RuntimeManifest = {
  tools: Record<"bun" | "bash" | "coreutils" | "nix" | "bwrap", string>;
  roots: string[];
  closure: string[];
  bunVersion: string;
  nixVersion: string;
  bwrapVersion: string;
  bunHash: string;
};

function prepare(directory: string, selected: string) {
  const bun = realpathSync(selected);
  if (!/^\/nix\/store\/[a-z0-9]{32}-[^/]+\/bin\/bun$/.test(bun))
    throw new Error("Nix store の Bun が必要です");
  if (process.platform !== "linux") throw new Error("隔離実証は Linux / WSL2 専用です");
  const tool = (name: string) => {
    const found = Bun.which(name);
    if (!found) throw new Error(`実証 tool がありません: ${name}`);
    const path = realpathSync(found);
    storeRoot(path);
    return path;
  };
  const tools = {
    bun,
    bash: tool("bash"),
    coreutils: tool("cat"),
    nix: tool("nix"),
    bwrap: tool("bwrap"),
  };
  const source = resolve(import.meta.dir, "../../lib/bun");
  const path = [bun, tools.bash, tools.coreutils].map((file) => `${storeRoot(file)}/bin`).join(":");
  const bunVersion = command(resolve(source, "run"), ["run", import.meta.filename, "version"], {
    ...process.env,
    PATH: path,
  });
  mkdirSync(directory, { mode: 0o700 });
  const bootstrap = resolve(directory, "bootstrap");
  mkdirSync(bootstrap, { mode: 0o700 });
  const env = {
    HOME: bootstrap,
    PATH: `${storeRoot(tools.nix)}/bin`,
    NIX_CONF_DIR: bootstrap,
    NIX_CONFIG: "experimental-features = nix-command flakes\nsubstituters =\n",
  };
  const roots = [...new Set([bun, tools.bash, tools.coreutils].map(storeRoot))].sort();
  const closure = command(
    resolve(dirname(tools.nix), "nix-store"),
    ["--query", "--requisites", ...roots],
    env,
  )
    .split("\n")
    .sort();
  for (const path of closure)
    if (storeRoot(path) !== path) throw new Error("不正な closure path です");
  command(
    tools.nix,
    ["copy", "--to", resolve(directory, "store"), "--no-check-sigs", ...roots],
    env,
    90_000,
  );
  const copied = command(
    resolve(dirname(tools.nix), "nix-store"),
    ["--store", resolve(directory, "store"), "--query", "--requisites", ...roots],
    env,
  )
    .split("\n")
    .sort();
  if (JSON.stringify(copied) !== JSON.stringify(closure))
    throw new Error("コピー先の closure が一致しません");
  const runtime = resolve(directory, "runtime");
  mkdirSync(resolve(runtime, "lib/bun"), { recursive: true });
  for (const file of ["run", "bunfig.toml", "tsconfig.json"])
    copyFileSync(resolve(source, file), resolve(runtime, "lib/bun", file));
  copyFileSync(import.meta.filename, resolve(runtime, "probe.ts"));
  writeFileSync(
    resolve(runtime, "package.json"),
    JSON.stringify({ dependencies: { "nix-bun-proof-not-installed": "0.0.0" } }),
  );
  writeFileSync(
    resolve(runtime, "entry"),
    `#!${tools.bash} -p\nset -euo pipefail\nexport PATH='${path}'\nexec /runtime/lib/bun/run run /runtime/probe.ts probe "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    resolve(runtime, "old-bun"),
    `#!${tools.bash} -p\nif [[ "$1" = --version ]]; then printf '1.2.14\\n'; exit 0; fi\nprintf 'unexpected invocation\\n' > /scratch/old-bun-started\nexit 97\n`,
    { mode: 0o755 },
  );
  for (const name of ["home", "scratch", "work"])
    mkdirSync(resolve(directory, name), { mode: 0o700 });
  writeFileSync(resolve(directory, "outside"), "host-only-fixture");
  const manifest: RuntimeManifest = {
    tools,
    roots,
    closure,
    bunVersion,
    nixVersion: command(tools.nix, ["--version"], env),
    bwrapVersion: command(tools.bwrap, ["--version"]),
    bunHash: createHash("sha256").update(readFileSync(bun)).digest("hex"),
  };
  writeFileSync(resolve(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  report("prepared", manifest);
}

function launch(directory: string, mode: string) {
  if (
    !["normal", "missing-bun", "roots-only", "unsupported-version", "missing-import"].includes(mode)
  )
    throw new Error("未知の実証対照です");
  const manifest: RuntimeManifest = JSON.parse(
    readFileSync(resolve(directory, "manifest.json"), "utf8"),
  );
  for (const path of Object.values(manifest.tools)) storeRoot(path);
  for (const path of manifest.closure)
    if (storeRoot(path) !== path) throw new Error("不正な closure path です");
  const mounted = manifest.closure.filter((path) =>
    mode === "roots-only"
      ? manifest.roots.includes(path)
      : mode !== "missing-bun" || path !== storeRoot(manifest.tools.bun),
  );
  const mounts = mounted.flatMap((path) => [
    "--ro-bind",
    resolve(directory, "store", path.slice(1)),
    path,
  ]);
  report("launch", { mode, mounted });
  const result = spawnSync(
    manifest.tools.bwrap,
    [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--clearenv",
      "--tmpfs",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      ...mounts,
      ...(mode === "unsupported-version"
        ? ["--ro-bind", resolve(directory, "runtime/old-bun"), manifest.tools.bun]
        : []),
      "--ro-bind",
      resolve(directory, "runtime"),
      "/runtime",
      "--bind",
      resolve(directory, "home"),
      "/home/agent",
      "--bind",
      resolve(directory, "scratch"),
      "/scratch",
      "--bind",
      resolve(directory, "work"),
      "/work",
      "--dir",
      "/tmp",
      "--symlink",
      manifest.tools.bash,
      "/bin/bash",
      "--symlink",
      `${storeRoot(manifest.tools.coreutils)}/bin/env`,
      "/usr/bin/env",
      "--setenv",
      "HOME",
      "/home/agent",
      "--setenv",
      "TMPDIR",
      "/scratch",
      "--setenv",
      "XDG_CACHE_HOME",
      "/home/agent/.cache",
      "--setenv",
      "PATH",
      "/unavailable-host-path",
      "--chdir",
      "/work",
      "--",
      "/runtime/entry",
      mode,
      resolve(directory, "outside"),
    ],
    { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
  );
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  report("exit", { status: result.status, signal: result.signal });
  process.exit(result.status ?? 128 + constants.signals[result.signal!]);
}

async function probe(mode: string, hostCanary: string) {
  report("probe-started", { mode });
  if (mode === "missing-import") {
    const missing = "nix-bun-proof-not-installed";
    await import(missing);
  }
  const denied = (path: string) => {
    try {
      writeFileSync(path, "unexpected-write");
      return "writable";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code;
    }
  };
  writeFileSync(resolve(process.env.HOME!, "written"), "home-fixture");
  writeFileSync(resolve(process.env.TMPDIR!, "written"), "scratch-fixture");
  report("target", {
    version: Bun.version,
    executable: realpathSync(process.execPath),
    home: process.env.HOME,
    scratch: process.env.TMPDIR,
    poison: process.env.NIX_BUN_PROOF_POISON ?? null,
    readonly: {
      runtime: denied("/runtime/forbidden"),
      bun: denied(resolve(dirname(process.execPath), "forbidden")),
    },
    homeWrite: readFileSync(resolve(process.env.HOME!, "written"), "utf8"),
    scratchWrite: readFileSync(resolve(process.env.TMPDIR!, "written"), "utf8"),
    hostVisible: existsSync(hostCanary),
    cache: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
  });
  process.exit(37);
}

try {
  if (action === "version") console.log(Bun.version);
  else if (action === "prepare" && location) prepare(location, selection ?? process.execPath);
  else if (action === "run" && location) launch(location, selection ?? "normal");
  else if (action === "probe" && location && selection) await probe(location, selection);
  else throw new Error("未知の実証 command です");
} catch (error) {
  console.error(JSON.stringify({ event: "failure", action, reason: String(error) }));
  process.exit(1);
}
