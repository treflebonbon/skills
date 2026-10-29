#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = await fs.realpath(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const packageManifest = JSON.parse(
  await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
);
const lockText = await fs.readFile(path.join(packageRoot, "package-lock.json"), "utf8");
const lock = JSON.parse(lockText);
const lockDigest = createHash("sha256").update(lockText).digest("hex");
const patchVersion = 1;
const readPatch = async (filename) => {
  const lines = (await fs.readFile(filename, "utf8")).split("\n");
  const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---"));
  const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  if (removed.length !== 1 || added.length !== 1) {
    throw new Error("Each Playwright patch must replace exactly one upstream line.");
  }
  return [removed[0].slice(1).trim(), added[0].slice(1).trim()];
};
const [socketPatch, managedSocketPatch] = await readPatch(
  path.join(packageRoot, "libexec/playwright-cli-sockets.patch"),
);
const [programPatch, managedProgramPatch] = await readPatch(
  path.join(packageRoot, "libexec/playwright-cli-program.patch"),
);
const [runtimeSource, socketHelper] = await Promise.all([
  fs.readFile(fileURLToPath(import.meta.url)),
  fs.readFile(path.join(packageRoot, "libexec/playwright-cli-sockets.cjs")),
]);
const runtimeDigest = createHash("sha256")
  .update(`${packageManifest.version}\n${lockDigest}\n${patchVersion}\n`)
  .update(runtimeSource)
  .update(socketHelper)
  .digest("hex");

const configuredRuntime = process.env.WSL2_BROWSER_DEPS_DIR;
const cacheRoot =
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
const runtimeDir = path.resolve(
  configuredRuntime ||
    path.join(cacheRoot, "treflebonbon", "wsl2-browser", runtimeDigest),
);
const readyFile = path.join(runtimeDir, ".wsl2-browser-runtime.json");
const expectedCli = lock.packages["node_modules/@playwright/cli"]?.version;
const expectedCore = lock.packages["node_modules/playwright-core"]?.version;
const fail = (message) => {
  throw new Error(message);
};

if (!expectedCli || expectedCli !== packageManifest.dependencies["@playwright/cli"]) {
  fail("The package manifest and lock do not agree on the Playwright CLI version.");
}
if (!expectedCore) {
  fail("The fixed Playwright runtime lock is incomplete.");
}
if (configuredRuntime && !path.isAbsolute(configuredRuntime)) {
  fail("WSL2_BROWSER_DEPS_DIR must be an absolute external path.");
}
if (process.env.XDG_CACHE_HOME && !path.isAbsolute(process.env.XDG_CACHE_HOME)) {
  fail("XDG_CACHE_HOME must be absolute when setting the Playwright runtime location.");
}
if (
  runtimeDir === packageRoot ||
  runtimeDir.startsWith(`${packageRoot}${path.sep}`)
) {
  fail("WSL2_BROWSER_DEPS_DIR must stay outside the fixed package.");
}
if (/[\r\n\t]/u.test(runtimeDir)) {
  fail("The dependency runtime path cannot contain tabs or line breaks.");
}

const physicalRuntimeDir = async () => {
  let ancestor = path.dirname(runtimeDir);
  const remaining = [path.basename(runtimeDir)];
  while (true) {
    try {
      const physicalAncestor = await fs.realpath(ancestor);
      const existingTarget = await fs.realpath(runtimeDir).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const candidate =
        existingTarget || path.resolve(physicalAncestor, ...remaining);
      if (
        candidate === packageRoot ||
        candidate.startsWith(`${packageRoot}${path.sep}`)
      ) {
        fail("WSL2_BROWSER_DEPS_DIR resolves inside the fixed package.");
      }
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      remaining.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
};
await physicalRuntimeDir();

const readRuntime = async () => {
  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(readyFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    fail("The cached Playwright runtime marker is invalid; its contents were preserved.");
  }
  if (
    metadata?.format !== 1 ||
    metadata?.runtimeDigest !== runtimeDigest ||
    metadata?.lockDigest !== lockDigest ||
    metadata?.cliVersion !== expectedCli ||
    metadata?.coreVersion !== expectedCore
  ) {
    fail("The cached Playwright runtime does not match this package lock; its contents were preserved.");
  }
  const cliManifest = JSON.parse(
    await fs.readFile(
      path.join(runtimeDir, "node_modules/@playwright/cli/package.json"),
      "utf8",
    ),
  );
  const coreManifest = JSON.parse(
    await fs.readFile(
      path.join(runtimeDir, "node_modules/playwright-core/package.json"),
      "utf8",
    ),
  );
  if (cliManifest.version !== expectedCli || coreManifest.version !== expectedCore) {
    fail("The cached Playwright runtime packages do not match the package lock.");
  }
  const coreDirectory = path.join(runtimeDir, "node_modules/playwright-core/lib");
  const [coreBundle, program, helper, expectedHelper] = await Promise.all([
    fs.readFile(path.join(coreDirectory, "coreBundle.js"), "utf8"),
    fs.readFile(path.join(coreDirectory, "tools/cli-client/program.js"), "utf8"),
    fs.readFile(path.join(coreDirectory, "playwright-cli-sockets.cjs")),
    fs.readFile(path.join(packageRoot, "libexec/playwright-cli-sockets.cjs")),
  ]);
  if (
    !coreBundle.includes(managedSocketPatch) ||
    !program.includes(managedProgramPatch) ||
    !helper.equals(expectedHelper)
  ) {
    fail("The cached Playwright runtime patches do not match this package.");
  }
  return runtimeDir;
};

const replaceOnce = async (filename, before, after, name) => {
  const source = await fs.readFile(filename, "utf8");
  const matches = source.split(before).length - 1;
  if (matches === 0 && source.includes(after)) return;
  if (matches !== 1) {
    fail(`Pinned Playwright ${name} patch expected one upstream match; found ${matches}.`);
  }
  await fs.writeFile(filename, source.replace(before, after));
};

const prepare = async () => {
  if (await readRuntime()) {
    process.stdout.write(`Playwright CLI ${expectedCli} is ready.\n`);
    return;
  }
  if (await fs.lstat(runtimeDir).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  })) {
    fail("The dependency path exists without a valid package marker; its contents were preserved. Choose a new WSL2_BROWSER_DEPS_DIR after inspection.");
  }

  const parent = path.dirname(runtimeDir);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const lockPath = `${runtimeDir}.prepare.lock`;
  let lockHandle;
  try {
    lockHandle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      fail("Another Playwright runtime preparation is in progress. Wait for it to finish, then retry.");
    }
    throw error;
  }

  let staging;
  try {
    staging = await fs.mkdtemp(path.join(parent, "wsl2-browser-runtime."));
    await fs.chmod(staging, 0o700);
    await Promise.all(
      ["package.json", "package-lock.json"].map((name) =>
        fs.copyFile(path.join(packageRoot, name), path.join(staging, name)),
      ),
    );
    const result = spawnSync(
      process.env.WSL2_BROWSER_NPM || "npm",
      ["ci", "--prefix", staging, "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: staging,
        env: {
          ...process.env,
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
          npm_config_cache: path.join(parent, "npm-cache"),
          npm_config_audit: "false",
          npm_config_fund: "false",
          npm_config_loglevel: "error",
          npm_config_update_notifier: "false",
        },
        stdio: "ignore",
      },
    );
    if (result.error || result.status !== 0) {
      fail(`npm ci failed${result.status === null ? " to start" : ` with exit ${result.status}`}; partial files remain at ${staging}.`);
    }

    const cliManifest = JSON.parse(
      await fs.readFile(
        path.join(staging, "node_modules/@playwright/cli/package.json"),
        "utf8",
      ),
    );
    const coreManifest = JSON.parse(
      await fs.readFile(
        path.join(staging, "node_modules/playwright-core/package.json"),
        "utf8",
      ),
    );
    if (cliManifest.version !== expectedCli || coreManifest.version !== expectedCore) {
      fail("npm ci produced versions that do not match the package lock.");
    }

    const coreDirectory = path.join(staging, "node_modules/playwright-core/lib");
    await replaceOnce(
      path.join(coreDirectory, "coreBundle.js"),
      socketPatch,
      managedSocketPatch,
      "socket",
    );
    const helper = path.join(coreDirectory, "playwright-cli-sockets.cjs");
    const helperSource = await fs.readFile(
      path.join(packageRoot, "libexec/playwright-cli-sockets.cjs"),
    );
    const existingHelper = await fs.readFile(helper).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existingHelper && !existingHelper.equals(helperSource)) {
      fail("The pinned Playwright socket helper path already contains different content.");
    }
    if (!existingHelper) await fs.writeFile(helper, helperSource, { flag: "wx" });

    await replaceOnce(
      path.join(
        coreDirectory,
        "tools/cli-client/program.js",
      ),
      programPatch,
      managedProgramPatch,
      "managed tab",
    );
    await fs.writeFile(
      path.join(staging, ".wsl2-browser-runtime.json"),
      `${JSON.stringify({
        cliVersion: expectedCli,
        coreVersion: expectedCore,
        format: 1,
        lockDigest,
        runtimeDigest,
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await fs.rename(staging, runtimeDir);
    process.stdout.write(`Prepared Playwright CLI ${expectedCli}.\n`);
  } finally {
    await lockHandle.close();
    await fs.unlink(lockPath);
  }
};

const command = process.argv[2] || "require";
try {
  if (command === "prepare") {
    await prepare();
  } else if (command === "require") {
    if (!(await readRuntime())) {
      fail(`Playwright CLI ${expectedCli} is not prepared. Run ${path.join(packageRoot, "bin/wsl2-browser-prepare")}.`);
    }
    process.stdout.write(`${runtimeDir}\n`);
  } else {
    fail("Expected 'prepare' or 'require'.");
  }
} catch (error) {
  process.stderr.write(`wsl2-browser-runtime: ${error.message}\n`);
  process.exitCode = 1;
}
