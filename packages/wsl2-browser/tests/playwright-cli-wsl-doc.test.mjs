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
    "認証情報をコピーせず",
  ]) {
    assert.ok(guidance.includes(contract), `Missing WSL contract: ${contract}`);
  }

  const closeBeforeAuth = guidance.indexOf('"$BROWSER_BIN/browser-attachments" close');
  const auth = guidance.indexOf('"$BROWSER_BIN/browser-attachments" auth');
  const manualLogin = guidance.indexOf("手動ログイン", auth);
  const closeAfterAuth = guidance.indexOf(
    '"$BROWSER_BIN/browser-attachments" close',
    closeBeforeAuth + 1,
  );
  assert.ok(closeBeforeAuth >= 0 && auth > closeBeforeAuth);
  assert.ok(manualLogin > auth && closeAfterAuth > manualLogin);
  const usageClose = usage.indexOf('"$BROWSER_BIN/browser-attachments" close');
  const usageAuth = usage.indexOf('"$BROWSER_BIN/browser-attachments" auth');
  const usageCloseAfterAuth = usage.indexOf(
    '"$BROWSER_BIN/browser-attachments" close',
    usageClose + 1,
  );
  assert.ok(usageClose >= 0 && usageAuth > usageClose);
  assert.ok(usageCloseAfterAuth > usageAuth);
  assert.match(guidance, /"\$BROWSER_BIN\/playwright-cli"/u);
  assert.match(guidance, /"\$BROWSER_BIN\/managed-chrome-owner"/u);
  assert.match(guidance, /"\$BROWSER_BIN\/browser-attachments"/u);
  assert.match(guidance, /"\$BROWSER_BIN\/playwright-cli" attach --cdp/u);
  assert.doesNotMatch(guidance, /```(?:bash|sh)\n(?:playwright-cli|managed-chrome-owner|browser-attachments)\b/mu);
});
