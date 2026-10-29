import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const skillRoot = fileURLToPath(new URL("..", import.meta.url));
const sourcePluginRoot = path.resolve(skillRoot, "../..");
const testTmpRoot = process.env.DOGFOOD_TEST_TMPDIR || "/tmp/codex";

const temporaryDirectory = async (prefix) => {
  await mkdir(testTmpRoot, { mode: 0o700, recursive: true });
  return mkdtemp(path.join(testTmpRoot, prefix));
};

const copyPlugin = async (temporary) => {
  const pluginRoot = path.join(temporary, "plugin");
  await mkdir(pluginRoot, { recursive: true });
  await cp(
    path.join(sourcePluginRoot, "plugin.json"),
    path.join(pluginRoot, "plugin.json"),
  );
  await cp(skillRoot, path.join(pluginRoot, "skills/dogfood"), {
    recursive: true,
  });
  await cp(
    path.join(sourcePluginRoot, "packages/wsl2-browser"),
    path.join(pluginRoot, "packages/wsl2-browser"),
    { recursive: true },
  );
  return pluginRoot;
};

const writeFakeNpm = async (temporary) => {
  const npm = path.join(temporary, "npm");
  const npmLog = path.join(temporary, "npm.log");
  const browserInstaller = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const root = process.env.PLAYWRIGHT_BROWSERS_PATH;",
    "const executable = path.join(root, 'chromium-1217/chrome-linux64/chrome');",
    "fs.mkdirSync(path.dirname(executable), { recursive: true });",
    "fs.writeFileSync(executable, '#!/bin/sh\\nexit 0\\n', { mode: 0o700 });",
    "fs.appendFileSync(process.env.DOGFOOD_TEST_BROWSER_LOG, 'install\\n');",
  ].join("\n");
  const npmSource = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const prefix = args[args.indexOf('--prefix') + 1];",
    "const playwright = path.join(prefix, 'node_modules/playwright');",
    "fs.mkdirSync(playwright, { recursive: true });",
    "fs.copyFileSync(process.env.DOGFOOD_TEST_PLAYWRIGHT_FIXTURE, path.join(playwright, 'index.mjs'));",
    "fs.writeFileSync(path.join(playwright, 'package.json'), JSON.stringify({ type: 'module', version: '1.63.0' }));",
    "const bin = path.join(prefix, 'node_modules/.bin');",
    "fs.mkdirSync(bin, { recursive: true });",
    `fs.writeFileSync(path.join(bin, 'playwright'), ${JSON.stringify(browserInstaller)}, { mode: 0o700 });`,
    "fs.appendFileSync(process.env.DOGFOOD_TEST_NPM_LOG, JSON.stringify({ args, prefix, skip: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD }) + '\\n');",
  ].join("\n");
  await writeFile(npm, npmSource, { mode: 0o700 });
  return npmLog;
};

const snapshot = async (root) => {
  const entries = new Map();
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".env" || entry.name.startsWith(".env.")) continue;
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename);
      if (entry.isDirectory()) {
        entries.set(relative, `directory:${(await lstat(filename)).mode}`);
        await visit(filename);
      } else if (entry.isSymbolicLink()) {
        entries.set(relative, `symlink:${await readlink(filename)}`);
      } else {
        entries.set(relative, {
          content: await readFile(filename),
          mode: (await stat(filename)).mode,
        });
      }
    }
  };
  await visit(root);
  return entries;
};

const runRuntime = (fixture, args, extraEnv = {}) =>
  spawnSync(
    process.execPath,
    [
      path.join(
        fixture.pluginRoot,
        "skills/dogfood/scripts/dogfood-runtime.mjs",
      ),
      ...args,
    ],
    {
      cwd: fixture.temporary,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...fixture.env, ...extraEnv },
    },
  );

const createFixture = async (temporary) => {
  const pluginRoot = await copyPlugin(temporary);
  const npm = path.join(temporary, "npm");
  const npmLog = await writeFakeNpm(temporary);
  const browserLog = path.join(temporary, "browser.log");
  const cache = path.join(temporary, "external-cache");
  const output = path.join(temporary, "evidence");
  const playwrightFixture = path.join(skillRoot, "tests/fixtures/dogfood-playwright.mjs");
  const env = {
    ...process.env,
    DOGFOOD_TEST_WSL: "0",
    DOGFOOD_TEST_BROWSER_LOG: browserLog,
    DOGFOOD_TEST_NPM_LOG: npmLog,
    DOGFOOD_TEST_PLAYWRIGHT_FIXTURE: playwrightFixture,
    DOGFOOD_NPM: npm,
    XDG_CACHE_HOME: cache,
  };
  return { cache, env, npmLog, output, pluginRoot, temporary, browserLog };
};

test("dogfood prepare and repeated runs keep dependencies, browser and evidence outside the plugin", async () => {
  const temporary = await temporaryDirectory("dogfood-runtime-payload.");
  const fixture = await createFixture(temporary);

  try {
    const before = await snapshot(fixture.pluginRoot);
    const prepared = runRuntime(fixture, ["prepare"]);
    assert.equal(prepared.status, 0, prepared.stderr ?? prepared.error?.message);
    assert.match(prepared.stdout, /ready outside the plugin/u);
    assert.deepEqual(await snapshot(fixture.pluginRoot), before);

    const first = runRuntime(fixture, [
      "run",
      "--target",
      "about:blank",
      "--output",
      fixture.output,
    ]);
    assert.equal(first.status, 0, first.stderr ?? first.error?.message);
    assert.match(
      await readFile(path.join(fixture.output, "report.md"), "utf8"),
      /Run status: completed/u,
    );
    const firstAttempt = (await readFile(path.join(fixture.output, "report.md"), "utf8"))
      .match(/^Attempt directory: (.+)$/mu)?.[1];
    assert.ok(firstAttempt);
    assert.ok(
      await stat(path.join(fixture.output, firstAttempt, "screenshots/initial.png"))
        .then(() => true, () => false),
    );

    const second = runRuntime(fixture, [
      "run",
      "--target",
      "about:blank",
      "--output",
      fixture.output,
    ]);
    assert.equal(second.status, 0, second.stderr ?? second.error?.message);
    assert.equal((await readFile(fixture.npmLog, "utf8")).trim().split("\n").length, 1);
    assert.equal((await readFile(fixture.browserLog, "utf8")).trim().split("\n").length, 1);
    assert.deepEqual(await snapshot(fixture.pluginRoot), before);
    assert.equal(
      await stat(path.join(fixture.pluginRoot, "node_modules")).then(() => true, () => false),
      false,
    );
    assert.ok((await readdir(fixture.cache)).length > 0);
    assert.ok(!path.resolve(fixture.cache).startsWith(`${fixture.pluginRoot}${path.sep}`));
    assert.ok(!path.resolve(fixture.output).startsWith(`${fixture.pluginRoot}${path.sep}`));
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("dogfood refuses cache and evidence paths inside the full plugin root before preparation", async () => {
  const temporary = await temporaryDirectory("dogfood-plugin-write-refusal.");
  const fixture = await createFixture(temporary);
  const npmLog = path.join(temporary, "npm.log");
  const internalCache = path.join(fixture.pluginRoot, "runtime-cache");
  const internalOutput = path.join(fixture.pluginRoot, "dogfood-output");
  const link = path.join(temporary, "plugin-alias");

  try {
    const before = await snapshot(fixture.pluginRoot);
    const cacheRefusal = runRuntime(fixture, ["prepare"], {
      DOGFOOD_DEPS_DIR: internalCache,
    });
    assert.notEqual(cacheRefusal.status, 0);
    assert.match(cacheRefusal.stderr, /outside the plugin/u);
    assert.equal(await stat(npmLog).then(() => true, () => false), false);
    assert.equal(await stat(internalCache).then(() => true, () => false), false);

    const outputRefusal = runRuntime(
      {
        ...fixture,
        env: {
          ...fixture.env,
          DOGFOOD_DEPS_DIR: path.join(temporary, "external-cache"),
        },
      },
      ["run", "--target", "about:blank", "--output", internalOutput],
    );
    assert.notEqual(outputRefusal.status, 0);
    assert.match(outputRefusal.stderr, /outside the plugin/u);
    assert.equal(await stat(internalOutput).then(() => true, () => false), false);
    assert.equal(await stat(npmLog).then(() => true, () => false), false);

    await symlink(fixture.pluginRoot, link, "dir");
    const symlinkRefusal = runRuntime(fixture, ["prepare"], {
      DOGFOOD_DEPS_DIR: path.join(link, "runtime-cache"),
    });
    assert.notEqual(symlinkRefusal.status, 0);
    assert.match(symlinkRefusal.stderr, /inside the plugin/u);
    assert.equal(await stat(npmLog).then(() => true, () => false), false);
    assert.deepEqual(await snapshot(fixture.pluginRoot), before);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
