// Runs the browser workflows (tests/browser.mjs, tests/browser-real-content.mjs).
// With STUDIO_PLAYWRIGHT_MODULE set, uses that Playwright as is (offline).
// Otherwise installs the Playwright pinned in package-lock.json into a temporary
// directory, like build.mjs, and installs its Chromium (network required).
import { execFileSync } from "node:child_process";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { join } = path;
const root = fileURLToPath(new URL("../", import.meta.url));
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

let playwright = process.env.STUDIO_PLAYWRIGHT_MODULE;
if (!playwright) {
  // Keep npm's installation outside the skill tree: chezmoi deploys every skill file.
  const dir = await mkdtemp(join(tmpdir(), "domain-studio-browser-"));
  await Promise.all(
    ["package.json", "package-lock.json"].map((file) =>
      cp(join(root, file), join(dir, file))
    )
  );
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: dir,
  });
  // CI runners also need Chromium's system libraries.
  run(
    join(dir, "node_modules/.bin/playwright"),
    ["install", ...(process.env.CI ? ["--with-deps"] : []), "chromium"],
    { cwd: dir }
  );
  playwright = join(dir, "node_modules/playwright/index.mjs");
}
for (const test of ["tests/browser.mjs", "tests/browser-real-content.mjs"]) {
  run(process.execPath, [join(root, test)], {
    env: { ...process.env, STUDIO_PLAYWRIGHT_MODULE: playwright },
  });
}
