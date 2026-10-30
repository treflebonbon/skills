import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const entry = (name) => path.join(packageRoot, "bin", name);
const testTmpRoot = process.env.WSL2_BROWSER_TEST_TMPDIR || "/tmp/codex";

const temporaryDirectory = async (prefix) => {
  await mkdir(testTmpRoot, { mode: 0o700, recursive: true });
  return mkdtemp(path.join(testTmpRoot, prefix));
};

const copyPluginPackage = async (temporary) => {
  const sourcePluginRoot = path.resolve(packageRoot, "../..");
  const pluginRoot = path.join(temporary, "plugin");
  const packageCopy = path.join(pluginRoot, "packages/wsl2-browser");
  await mkdir(path.dirname(packageCopy), { recursive: true });
  await cp(packageRoot, packageCopy, { recursive: true });
  await cp(path.join(sourcePluginRoot, "plugin.json"), path.join(pluginRoot, "plugin.json"));
  return { pluginRoot, packageRoot: packageCopy };
};

const writeFakeNpm = async (temporary) => {
  const npmBin = path.join(temporary, "bin");
  const npm = path.join(npmBin, "npm");
  const npmCalls = path.join(temporary, "npm-calls.json");
  await mkdir(npmBin, { mode: 0o700 });
  const npmSource = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs/promises');",
    "const path = require('node:path');",
    "(async () => {",
    "  const args = process.argv.slice(2);",
    "  const prefix = args[args.indexOf('--prefix') + 1];",
    "  const cli = path.join(prefix, 'node_modules/@playwright/cli');",
    "  const core = path.join(prefix, 'node_modules/playwright-core/lib');",
    "  const program = path.join(core, 'tools/cli-client');",
    "  await fs.mkdir(cli, { recursive: true });",
    "  await fs.mkdir(core, { recursive: true });",
    "  await fs.mkdir(program, { recursive: true });",
    "  await fs.writeFile(path.join(cli, 'package.json'), JSON.stringify({version:'0.1.22'}));",
    "  await fs.writeFile(path.join(cli, 'playwright-cli.js'), \"process.stdout.write('pinned-cli:' + process.argv.slice(2).join(' '));\\n\");",
    "  await fs.writeFile(path.join(core, '../package.json'), JSON.stringify({version:'1.64.0-alpha-1790635538000'}));",
    "  await fs.writeFile(path.join(core, 'coreBundle.js'), 'throw new Error(`Socket directory path is too long (${Buffer.byteLength(dir)} bytes); set PWTEST_SOCKETS_DIR to a shorter location.`);\\n');",
    "  await fs.writeFile(path.join(program, 'program.js'), 'const toolText = await runInSessionOrStop(newEntry, clientInfo, { _: [\\\"goto\\\", ...params.length ? params : [\\\"about:blank\\\"]] }, output);\\n');",
    "  await fs.writeFile(process.env.NPM_CALLS, JSON.stringify({args, skip:process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, prefix}));",
    "})().catch(error => { console.error(error); process.exitCode = 1; });",
  ].join("\n");
  await writeFile(npm, npmSource, { mode: 0o700 });
  return { npmBin, npmCalls };
};

const snapshot = async (directory) => {
  const files = new Map();
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(filename);
      } else {
        files.set(path.relative(directory, filename), await readFile(filename));
      }
    }
  };
  await visit(directory);
  return files;
};

test("package entrypoints work from an external working directory", async () => {
  const temporary = await temporaryDirectory("wsl2-browser-entry.");
  const upstream = path.join(temporary, "upstream");
  const calls = path.join(temporary, "calls");
  const ownerState = path.join(temporary, "owner-state");

  try {
    await writeFile(
      upstream,
      "#!/usr/bin/env bash\nprintf 'upstream:%s\\n' \"$*\" >\"$CALLS\"\n",
      { mode: 0o700 },
    );

    const cli = spawnSync(entry("playwright-cli"), ["--version"], {
      cwd: temporary,
      encoding: "utf8",
      env: {
        ...process.env,
        CALLS: calls,
        PWCLI_TEST_WSL: "0",
        PWCLI_UPSTREAM: upstream,
      },
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(await readFile(calls, "utf8"), "upstream:--version\n");

    const owner = spawnSync(entry("managed-chrome-owner"), ["status"], {
      cwd: temporary,
      encoding: "utf8",
      env: {
        ...process.env,
        BROWSER_OWNERSHIP_DIR: ownerState,
      },
    });
    assert.equal(owner.status, 0, owner.stderr);
    assert.equal(owner.stdout, "null\n");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("WSL metadata commands reach the pinned CLI before Windows setup", async () => {
  const temporary = await temporaryDirectory("wsl2-browser-help.");
  const upstream = path.join(temporary, "upstream");
  const calls = path.join(temporary, "calls");

  try {
    await writeFile(
      upstream,
      "#!/usr/bin/env bash\nprintf 'upstream:%s\\n' \"$*\" >\"$CALLS\"\n",
      { mode: 0o700 },
    );

    const cli = spawnSync(entry("playwright-cli"), ["--help"], {
      cwd: temporary,
      encoding: "utf8",
      env: {
        ...process.env,
        CALLS: calls,
        PWCLI_TEST_WSL: "1",
        PWCLI_UPSTREAM: upstream,
      },
    });
    assert.equal(cli.status, 0, cli.stderr ?? cli.error?.message);
    assert.equal(await readFile(calls, "utf8"), "upstream:--help\n");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("runtime preparation keeps its fixed dependency cache outside the package", async () => {
  const temporary = await temporaryDirectory("wsl2-browser-prepare.");
  const { npmBin, npmCalls } = await writeFakeNpm(temporary);
  const deps = path.join(temporary, "cache", "runtime");
  const before = await snapshot(packageRoot);

  try {

    const prepared = spawnSync(entry("wsl2-browser-prepare"), [], {
      cwd: temporary,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${npmBin}:${process.env.PATH}`,
        NPM_CALLS: npmCalls,
        WSL2_BROWSER_DEPS_DIR: deps,
      },
    });
    assert.equal(prepared.status, 0, prepared.stderr ?? prepared.error?.message);
    const call = JSON.parse(await readFile(npmCalls, "utf8"));
    assert.ok(call.args.includes("ci"));
    assert.ok(call.args.includes("--ignore-scripts"));
    assert.equal(call.skip, "1");
    assert.equal(path.dirname(path.resolve(call.prefix)), path.dirname(deps));
    assert.match(path.basename(call.prefix), /^wsl2-browser-runtime\./u);
    assert.deepEqual(
      await readFile(path.join(deps, "package-lock.json")),
      await readFile(path.join(packageRoot, "package-lock.json")),
    );
    const cli = spawnSync(entry("playwright-cli"), ["--version"], {
      cwd: temporary,
      encoding: "utf8",
      env: {
        ...process.env,
        PWCLI_TEST_WSL: "0",
        WSL2_BROWSER_DEPS_DIR: deps,
      },
    });
    assert.equal(cli.status, 0, cli.stderr ?? cli.error?.message);
    assert.equal(cli.stdout, "pinned-cli:--version");
    assert.equal(
      await stat(path.join(packageRoot, "node_modules")).then(() => true, () => false),
      false,
    );
    const after = await snapshot(packageRoot);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [name, contents] of before) {
      assert.deepEqual(after.get(name), contents, `${name} changed during prepare`);
    }
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("prepare and require reject dependency paths inside the plugin root", async () => {
  const temporary = await temporaryDirectory("wsl2-browser-plugin-root.");
  const fixture = await copyPluginPackage(temporary);
  const dependencies = path.join(fixture.pluginRoot, "runtime-cache");
  const npmCalls = path.join(temporary, "npm-called");
  const npm = path.join(temporary, "npm");

  try {
    await writeFile(
      npm,
      ["#!/usr/bin/env bash", "printf called >\"$NPM_CALLS\"", "exit 13", ""].join("\n"),
      { mode: 0o700 },
    );
    const prepared = spawnSync(
      path.join(fixture.packageRoot, "bin/wsl2-browser-prepare"),
      [],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NPM_CALLS: npmCalls,
          WSL2_BROWSER_DEPS_DIR: dependencies,
          WSL2_BROWSER_NPM: npm,
        },
      },
    );
    assert.notEqual(prepared.status, 0);
    assert.match(prepared.stderr, /outside the plugin/u);
    assert.equal(await stat(npmCalls).then(() => true, () => false), false);
    assert.equal(await stat(dependencies).then(() => true, () => false), false);

    const required = spawnSync(
      path.join(fixture.packageRoot, "bin/playwright-cli"),
      ["--version"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PWCLI_TEST_WSL: "0",
          WSL2_BROWSER_DEPS_DIR: dependencies,
        },
      },
    );
    assert.notEqual(required.status, 0);
    assert.match(required.stderr, /outside the plugin/u);
    assert.equal(await stat(dependencies).then(() => true, () => false), false);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("patch changes prepare a distinct default cache and keep the old cache", async () => {
  const temporary = await temporaryDirectory("wsl2-browser-patch-cache.");
  const fixture = await copyPluginPackage(temporary);
  const { npmBin, npmCalls } = await writeFakeNpm(temporary);
  const cacheHome = path.join(temporary, "external-cache");
  const runtimePath = path.join(fixture.packageRoot, "libexec/runtime-path.mjs");
  const patchPath = path.join(fixture.packageRoot, "libexec/playwright-cli-sockets.patch");
  const environment = {
    ...process.env,
    PATH: [npmBin, process.env.PATH || ""].join(path.delimiter),
    NPM_CALLS: npmCalls,
    XDG_CACHE_HOME: cacheHome,
  };

  try {
    const firstPrepare = spawnSync(
      path.join(fixture.packageRoot, "bin/wsl2-browser-prepare"),
      [],
      { encoding: "utf8", env: environment },
    );
    assert.equal(firstPrepare.status, 0, firstPrepare.stderr);
    const firstPath = spawnSync(process.execPath, [runtimePath, "require"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(firstPath.status, 0, firstPath.stderr);
    const oldCache = firstPath.stdout.trim();
    const oldMarker = await readFile(
      path.join(oldCache, ".wsl2-browser-runtime.json"),
      "utf8",
    );

    const originalPatch = await readFile(patchPath, "utf8");
    const modifiedPatch = originalPatch.replace(
      "shortSocketPath(dir, name);",
      "shortSocketPath(dir,name);",
    );
    assert.notEqual(modifiedPatch, originalPatch);
    await writeFile(patchPath, modifiedPatch);

    const secondPrepare = spawnSync(
      path.join(fixture.packageRoot, "bin/wsl2-browser-prepare"),
      [],
      { encoding: "utf8", env: environment },
    );
    assert.equal(secondPrepare.status, 0, secondPrepare.stderr);
    const secondPath = spawnSync(process.execPath, [runtimePath, "require"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(secondPath.status, 0, secondPath.stderr);
    const newCache = secondPath.stdout.trim();
    assert.notEqual(newCache, oldCache);
    assert.deepEqual(
      await readFile(path.join(oldCache, ".wsl2-browser-runtime.json"), "utf8"),
      oldMarker,
    );
    assert.equal(await stat(oldCache).then(() => true, () => false), true);
    assert.ok(newCache.startsWith(cacheHome));
    assert.notEqual(
      JSON.parse(oldMarker).runtimeDigest,
      JSON.parse(
        await readFile(path.join(newCache, ".wsl2-browser-runtime.json"), "utf8"),
      ).runtimeDigest,
    );
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
