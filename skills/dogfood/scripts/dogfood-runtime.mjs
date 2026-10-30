import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fail = (message) => {
  throw new Error(message);
};

const isInside = (candidate, root) =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

const physicalPath = async (candidate) => {
  let cursor = path.resolve(candidate);
  const suffix = [];
  while (true) {
    try {
      return path.resolve(await fs.realpath(cursor), ...suffix.reverse());
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
};

const assertOutsidePlugin = async (candidate, root, label) => {
  const resolved = path.resolve(candidate);
  if (isInside(resolved, root)) {
    fail(`${label} must stay outside the plugin: ${resolved}`);
  }
  const physical = await physicalPath(resolved);
  if (isInside(physical, root)) {
    fail(`${label} resolves inside the plugin: ${physical}`);
  }
  return resolved;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

const digest = (value) => createHash("sha256").update(value).digest("hex");

const runtimeLayout = async () => {
  const scriptDirectory = await fs.realpath(
    path.dirname(fileURLToPath(import.meta.url)),
  );
  const skillRoot = path.resolve(scriptDirectory, "..");
  const pluginRoot = await fs.realpath(path.resolve(skillRoot, "../.."));
  const manifest = JSON.parse(
    await fs.readFile(path.join(pluginRoot, "plugin.json"), "utf8"),
  );
  if (manifest.name !== "treflebonbon-skills") {
    fail("Dogfood must run from the treflebonbon-skills plugin layout.");
  }
  const packageRoot = path.join(pluginRoot, "packages/wsl2-browser");
  const requiredAssets = [
    path.join(packageRoot, "bin/playwright-cli"),
    path.join(packageRoot, "bin/managed-chrome-owner"),
    path.join(packageRoot, "libexec/dogfood-chrome-windows.ps1"),
  ];
  for (const asset of requiredAssets) {
    if (!(await fs.stat(asset).then(() => true, () => false))) {
      fail(`Required WSL2 browser asset is missing: ${asset}`);
    }
  }

  const references = path.join(skillRoot, "references");
  const manifestText = await fs.readFile(path.join(references, "package.json"), "utf8");
  const lockText = await fs.readFile(path.join(references, "package-lock.json"), "utf8");
  const packageManifest = JSON.parse(manifestText);
  const lock = JSON.parse(lockText);
  const playwrightPackage = lock.packages?.["node_modules/playwright"];
  const corePackage = lock.packages?.["node_modules/playwright-core"];
  if (
    !playwrightPackage?.integrity ||
    !corePackage?.integrity ||
    playwrightPackage.version !== packageManifest.dependencies?.playwright ||
    corePackage.version !== playwrightPackage.version ||
    !playwrightPackage.resolved?.startsWith("https://registry.npmjs.org/") ||
    !corePackage.resolved?.startsWith("https://registry.npmjs.org/")
  ) {
    fail("The fixed Playwright lock or its public registry metadata is incomplete.");
  }
  const runtimeDigest = digest(`${manifestText}\n${lockText}`);
  const configuredCache = process.env.DOGFOOD_DEPS_DIR;
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  if (configuredCache && !path.isAbsolute(configuredCache)) {
    fail("DOGFOOD_DEPS_DIR must be an absolute external path.");
  }
  if (process.env.XDG_CACHE_HOME && !path.isAbsolute(cacheHome)) {
    fail("XDG_CACHE_HOME must be absolute when setting the dogfood cache location.");
  }
  const runtimeDirectory = await assertOutsidePlugin(
    configuredCache || path.join(cacheHome, "treflebonbon", "dogfood", runtimeDigest),
    pluginRoot,
    "DOGFOOD_DEPS_DIR",
  );
  const outputDirectory = process.argv[2] === "run"
    ? await outputArgument(process.argv.slice(3), pluginRoot)
    : null;
  return {
    browserDirectory: path.join(runtimeDirectory, "ms-playwright"),
    lockDigest: digest(lockText),
    lockText,
    manifestText,
    packageRoot,
    packageManifest,
    pluginRoot,
    references,
    runtimeDigest,
    runtimeDirectory,
    outputDirectory,
    runner: path.join(references, "playwright-dogfood-runner.mjs"),
    skillRoot,
  };
};

const outputArgument = async (args, pluginRoot) => {
  const index = args.indexOf("--output");
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) {
    fail("A new dogfood run requires --output <absolute evidence directory>.");
  }
  return assertOutsidePlugin(path.resolve(args[index + 1]), pluginRoot, "Dogfood output");
};

const readMarker = async (filename, expected, message) => {
  try {
    const marker = JSON.parse(await fs.readFile(filename, "utf8"));
    if (marker?.format === 1 && marker.runtimeDigest === expected) return marker;
    fail(`${message}; its contents were preserved.`);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

const installDependencies = async (layout) => {
  const markerPath = path.join(layout.runtimeDirectory, ".dogfood-runtime.json");
  const marker = await readMarker(
    markerPath,
    layout.runtimeDigest,
    "The cached Playwright runtime does not match the fixed package lock",
  );
  if (marker) {
    const installed = JSON.parse(
      await fs.readFile(
        path.join(layout.runtimeDirectory, "node_modules/playwright/package.json"),
        "utf8",
      ),
    );
    if (installed.version !== layout.packageManifest.dependencies.playwright) {
      fail("The cached Playwright package does not match the fixed lock.");
    }
    return;
  }
  if (await fs.lstat(layout.runtimeDirectory).then(() => true, () => false)) {
    fail("The dependency path exists without a valid marker; its contents were preserved. Choose a new DOGFOOD_DEPS_DIR after inspection.");
  }

  const parent = path.dirname(layout.runtimeDirectory);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const lockPath = `${layout.runtimeDirectory}.prepare.lock`;
  let lockHandle;
  try {
    lockHandle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      fail("Another dogfood dependency preparation is active, or its lock remains. Inspect it before retrying.");
    }
    throw error;
  }

  let staging;
  try {
    staging = await fs.mkdtemp(path.join(parent, "dogfood-runtime."));
    await fs.chmod(staging, 0o700);
    await Promise.all(
      ["package.json", "package-lock.json"].map((name) =>
        fs.copyFile(path.join(layout.references, name), path.join(staging, name)),
      ),
    );
    const status = run(
      process.env.DOGFOOD_NPM || "npm",
      ["ci", "--prefix", staging, "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: staging,
        env: {
          ...process.env,
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
          npm_config_audit: "false",
          npm_config_cache: path.join(parent, "npm-cache"),
          npm_config_fund: "false",
          npm_config_loglevel: "error",
          npm_config_update_notifier: "false",
        },
      },
    );
    if (status !== 0) {
      fail(`npm ci failed with exit ${status}; partial files remain at ${staging}.`);
    }
    const installed = JSON.parse(
      await fs.readFile(path.join(staging, "node_modules/playwright/package.json"), "utf8"),
    );
    if (installed.version !== layout.packageManifest.dependencies.playwright) {
      fail("npm ci produced a Playwright version that does not match the fixed lock.");
    }
    await fs.writeFile(
      path.join(staging, ".dogfood-runtime.json"),
      `${JSON.stringify({ format: 1, runtimeDigest: layout.runtimeDigest, lockDigest: layout.lockDigest, playwrightVersion: installed.version })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await fs.rename(staging, layout.runtimeDirectory);
  } finally {
    await lockHandle.close();
    await fs.unlink(lockPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};

const isWsl = () => {
  if (process.env.DOGFOOD_TEST_WSL !== undefined) {
    return process.env.DOGFOOD_TEST_WSL === "1";
  }
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft|wsl/iu.test(
      fsSync.readFileSync("/proc/sys/kernel/osrelease", "utf8"),
    );
  } catch {
    return false;
  }
};

const chromiumExecutable = async (browserDirectory) => {
  const layouts = [
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ];
  const entries = await fs.readdir(browserDirectory);
  const bundles = entries.filter((entry) => /^chromium-\d+$/u.test(entry));
  const candidates = bundles.flatMap((bundle) =>
    layouts.map((layout) => path.join(browserDirectory, bundle, layout)),
  );
  const found = [];
  for (const candidate of candidates) {
    try {
      const info = await fs.stat(candidate);
      if (!info.isFile()) continue;
      await fs.access(candidate, fs.constants.X_OK);
      found.push(candidate);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  if (found.length !== 1) {
    fail(`Expected one Chromium executable in ${browserDirectory}; found ${found.length}.`);
  }
  return found[0];
};

const installBrowser = async (layout) => {
  if (isWsl()) return;
  const markerPath = path.join(layout.runtimeDirectory, ".dogfood-browser.json");
  const preparingPath = path.join(layout.runtimeDirectory, ".dogfood-browser-preparing.json");
  const marker = await readMarker(
    markerPath,
    layout.runtimeDigest,
    "The cached Chromium browser does not match this Playwright runtime",
  );
  if (marker) {
    await chromiumExecutable(layout.browserDirectory);
    return;
  }

  const preparing = await readMarker(
    preparingPath,
    layout.runtimeDigest,
    "A different Chromium preparation is recorded",
  );
  if (!preparing && await fs.lstat(layout.browserDirectory).then(() => true, () => false)) {
    fail("The browser cache exists without a preparation marker; its contents were preserved. Choose a new DOGFOOD_DEPS_DIR after inspection.");
  }
  await fs.writeFile(
    preparingPath,
    `${JSON.stringify({ format: 1, runtimeDigest: layout.runtimeDigest })}\n`,
    { mode: 0o600, flag: preparing ? "w" : "wx" },
  );
  const browserCli = path.join(
    layout.runtimeDirectory,
    "node_modules/.bin/playwright",
  );
  const browserEnvironment = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: layout.browserDirectory,
  };
  delete browserEnvironment.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
  const status = run(browserCli, ["install", "chromium"], {
    cwd: layout.runtimeDirectory,
    env: browserEnvironment,
  });
  if (status !== 0) {
    fail(`Playwright Chromium preparation failed with exit ${status}; files remain in ${layout.browserDirectory}.`);
  }
  const executable = await chromiumExecutable(layout.browserDirectory);
  await fs.writeFile(
    markerPath,
    `${JSON.stringify({ format: 1, runtimeDigest: layout.runtimeDigest, executable: path.relative(layout.browserDirectory, executable) })}\n`,
    { mode: 0o600, flag: "wx" },
  );
  await fs.unlink(preparingPath);
};

const runDogfood = async (layout, runnerArgs) => {
  if (runnerArgs.includes("--resume")) {
    fail("--resume is a skill option; read the saved report without starting the runner.");
  }
  const environment = {
    ...process.env,
    DOGFOOD_PLUGIN_ROOT: layout.pluginRoot,
    DOGFOOD_PLAYWRIGHT_CLI: path.join(layout.packageRoot, "bin/playwright-cli"),
    DOGFOOD_PLAYWRIGHT_MODULE: path.join(
      layout.runtimeDirectory,
      "node_modules/playwright/index.mjs",
    ),
    DOGFOOD_WINDOWS_SCRIPT: path.join(
      layout.packageRoot,
      "libexec/dogfood-chrome-windows.ps1",
    ),
    MANAGED_CHROME_OWNER: path.join(layout.packageRoot, "bin/managed-chrome-owner"),
  };
  if (!isWsl()) {
    environment.PLAYWRIGHT_BROWSERS_PATH = layout.browserDirectory;
  }
  return run(process.execPath, [layout.runner, ...runnerArgs], {
    cwd: process.cwd(),
    env: environment,
  });
};

const prepareAnnotationCli = (layout, runnerArgs) => {
  if (!runnerArgs.includes("--annotate")) return;
  const status = run(
    path.join(layout.packageRoot, "bin/wsl2-browser-prepare"),
    [],
    { cwd: process.cwd(), env: process.env },
  );
  if (status !== 0) {
    fail(`The fixed Playwright CLI runtime could not be prepared (exit ${status}); annotation did not start.`);
  }
};

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "prepare" && command !== "run") {
    fail("usage: dogfood-runtime.mjs <prepare|run> [runner arguments]");
  }
  const layout = await runtimeLayout();
  if (command === "run" && args.includes("--resume")) {
    fail("--resume is a skill option; read the saved report without preparing a browser.");
  }
  if (command === "run" && !layout.outputDirectory) {
    fail("A new dogfood run requires --output <evidence directory>.");
  }
  await installDependencies(layout);
  await installBrowser(layout);
  if (command === "prepare") {
    process.stdout.write(`Dogfood runtime is ready outside the plugin: ${layout.runtimeDirectory}\n`);
    return;
  }
  prepareAnnotationCli(layout, args);
  const status = await runDogfood(layout, args);
  process.exitCode = status;
};

try {
  await main();
} catch (error) {
  process.stderr.write(`DOGFOOD_RUNTIME_FAIL: ${error.message || String(error)}\n`);
  process.exitCode = 1;
}
