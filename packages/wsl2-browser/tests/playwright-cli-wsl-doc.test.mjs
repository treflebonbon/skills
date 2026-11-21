import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("WSL Playwright guidance preserves browser ownership and authentication rules", async () => {
  const [usage, guidance] = await Promise.all([
    readFile(path.join(packageRoot, "USAGE.md"), "utf8"),
    readFile(path.join(packageRoot, "references/playwright-cli-wsl.md"), "utf8"),
  ]);

  assert.match(usage, /references\/playwright-cli-wsl\.md/u);
  assert.match(guidance, /BROWSER_BIN=\/absolute\/path\/to\/.*\/packages\/wsl2-browser\/bin/u);
  for (const contract of [
    "PLAYWRIGHT_MCP_HEADLESS",
    "PWCLI_WORKSPACE",
    "show --kill",
    "close-all",
    "delete-data",
    "reset-profile --confirm-identity",
    "managed-chrome-owner",
    "recover",
    "relocate",
    "headed",
    "headless",
    "credential import、通常の Chrome profile の再利用",
  ]) {
    assert.ok(guidance.includes(contract), `Missing WSL contract: ${contract}`);
  }

  assert.match(guidance, /"\$BROWSER_BIN\/playwright-cli"/u);
  assert.match(guidance, /"\$BROWSER_BIN\/managed-chrome-owner"/u);
  assert.match(guidance, /"\$BROWSER_BIN\/playwright-cli" attach --cdp/u);
  assert.doesNotMatch(guidance, /```(?:bash|sh)\n(?:playwright-cli|managed-chrome-owner)\b/mu);
  assert.doesNotMatch(guidance, /browser-attachments/u);
  assert.match(usage, /\.\.\/\.\.\/docs\/pr-attachments\.md/u);
});
