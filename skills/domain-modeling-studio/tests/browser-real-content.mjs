// Run with Node. Same environment requirements as tests/browser.mjs
// (STUDIO_PLAYWRIGHT_MODULE / STUDIO_CHROMIUM). Verifies the layer-selector
// UI's architecture -> function-flow -> business-flow drilldown against a
// model built by actually running #334's generateArchitecture and #335's
// evidence-grounded function-flow procedure (tests/fixtures/real-content.mjs),
// not the deliberately fictional tests/fixture.mjs used elsewhere.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildRealContentDocument } from "./fixtures/real-content.mjs";

const { join } = path;

const { chromium } = await import(
  process.env.STUDIO_PLAYWRIGHT_MODULE || "playwright"
);
const dir = await mkdtemp(join(tmpdir(), "domain-studio-real-content-"));
const { document: doc } = await buildRealContentDocument();
const tsModuleId = doc.models.proposed.nodes.find(
  (n) => n.data.kind === "MODULE" && n.data.label.endsWith(".ts.fixture")
).id;

const input = join(dir, "model.json");
const output = join(dir, "studio.html");
await writeFile(input, JSON.stringify(doc));
execFileSync(process.execPath, [
  fileURLToPath(new URL("../scripts/render.mjs", import.meta.url)),
  input,
  output,
]);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM
    ? { executablePath: process.env.STUDIO_CHROMIUM }
    : {}),
});
try {
  const context = await browser.newContext({
    offline: true,
    viewport: { height: 1000, width: 1440 },
  });
  const errors = [];
  const remote = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/^https?:/u.test(r.url())) {
      remote.push(r.url());
    }
  });
  await page.goto(pathToFileURL(output).href);

  await page
    .getByRole("button", { exact: true, name: "アーキテクチャ" })
    .click();
  // Real generateArchitecture output actually renders on the canvas, and the
  // business-flow layer's node is hidden while on the architecture layer.
  await page.locator(`.react-flow__node[data-id="${tsModuleId}"]`).waitFor();
  assert.equal(
    await page.locator('.react-flow__node[data-id="checkout-flow"]').count(),
    0
  );
  await page
    .getByLabel("レビュー対象", { exact: true })
    .selectOption(`node:${tsModuleId}`);
  await page
    .getByRole("button", { exact: true, name: "ドリルダウン: 確定応答を返す" })
    .click();
  assert.equal(
    await page
      .getByRole("button", { exact: true, name: "関数フロー" })
      .getAttribute("aria-pressed"),
    "true"
  );
  assert.equal(
    await page.getByLabel("レビュー対象", { exact: true }).inputValue(),
    "node:ts-success-end"
  );
  await page.locator('.react-flow__node[data-id="ts-success-end"]').waitFor();
  assert.equal(
    await page.locator(`.react-flow__node[data-id="${tsModuleId}"]`).count(),
    0
  );

  await page
    .getByRole("button", { exact: true, name: "ドリルダウン: 注文を確定する" })
    .click();
  assert.equal(
    await page
      .getByRole("button", { exact: true, name: "業務フロー" })
      .getAttribute("aria-pressed"),
    "true"
  );
  assert.equal(
    await page.getByLabel("レビュー対象", { exact: true }).inputValue(),
    "node:checkout-flow"
  );
  await page.locator('.react-flow__node[data-id="checkout-flow"]').waitFor();

  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  console.log(
    `PASS real-content drilldown (architecture -> function-flow -> business-flow); evidence: ${dir}`
  );
} finally {
  await browser.close();
}
