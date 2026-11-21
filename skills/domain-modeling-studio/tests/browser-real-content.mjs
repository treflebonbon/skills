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

  // Verification: a function-flow node leads to its business rule, whose
  // existing test and candidates are readable without a single extra click.
  await page.getByRole("button", { exact: true, name: "関数フロー" }).click();
  await page
    .getByLabel("レビュー対象", { exact: true })
    .selectOption("node:ts-recovery");
  await page
    .getByRole("button", {
      exact: true,
      name: "検証を見る: 在庫切れの注文は代替入荷で確定する",
    })
    .click();
  assert.equal(
    await page
      .getByRole("button", { exact: true, name: "検証" })
      .getAttribute("aria-pressed"),
    "true"
  );
  const recovered = page.locator('[data-rule="rule-backorder"]');
  assert.equal(await recovered.getAttribute("open"), "");
  const recoveredText = await recovered.innerText();
  for (const expected of [
    "在庫切れを代替入荷で確定するテスト",
    "検証の境界: 関数（コードで確認）",
    "検証結果: 読んだのみ",
    "判断: 維持",
  ]) {
    assert.ok(recoveredText.includes(expected), expected);
  }
  const declined = page.locator('[data-rule="rule-declined"]');
  await declined.locator("summary").click();
  const declinedText = await declined.innerText();
  assert.ok(
    declinedText.includes("検証の境界: ポート契約（AIの推測・構造は未確認）")
  );
  assert.ok(declinedText.includes("検証結果: 実行・合格"));
  assert.ok(declinedText.includes("npm test -- checkout"));
  // #105: representative examples, properties and the shrunk counterexample.
  for (const expected of [
    "代表例（1）",
    "支払いを拒否された注文は確定しない（現状 · 確認済み）",
    "検証手法: プロパティベーステスト",
    "合意済みの性質（業務上の合意）: 支払いが拒否された注文は、明細や金額によらず確定しない",
    "事前条件: 在庫を予約できる、支払いが拒否される",
    "生成範囲: 明細: 1〜20件、各明細の数量: 1〜99、単価: 0〜100,000円",
    "観測する結果: 注文が確定済みになったかどうか",
    "未合意の性質（AIの推測）: 支払いの拒否理由が何であっても",
    "seed: 1729",
    "反例: 明細: [{ 数量: 1, 単価: 0 }], 支払い: 拒否",
  ]) {
    assert.ok(declinedText.includes(expected), expected);
  }
  assert.ok(
    recoveredText.includes(
      "在庫切れの注文を代替入荷で確定する（現状 · 確認済み）"
    )
  );
  assert.ok(
    recoveredText.includes("未合意の性質（コードで確認）: 在庫切れの注文の確定応答は")
  );
  const verificationText = await page
    .getByLabel("業務ルールと検証", { exact: true })
    .innerText();
  assert.equal(verificationText.split("合意済みの性質").length - 1, 1);

  // The comment typed here must target the rule, not the node still selected
  // on the model tab.
  const confirmed = page.locator('[data-rule="rule-confirmed"]');
  await confirmed.locator("summary").click();
  await confirmed
    .getByRole("button", { exact: true, name: "この業務ルールに指摘" })
    .click();
  await page.getByLabel("指摘を入力").fill("確定済みへ移る条件に取消を含める");
  await page.getByRole("button", { exact: true, name: "指摘を追加" }).click();
  assert.ok(
    (await page.getByLabel("検証への指摘").innerText()).includes(
      "確定済みへ移る条件に取消を含める"
    )
  );
  await page
    .getByRole("button", { exact: true, name: "指摘・モデルをコピー" })
    .click();
  const exported = await page.getByLabel("AIへ渡すMarkdown").inputValue();
  const payload = JSON.parse(exported.slice(exported.indexOf("{"), exported.lastIndexOf("}") + 1));
  assert.deepEqual(payload.document.comments.at(-1).target, {
    id: "rule-confirmed",
    view: "verification",
  });
  await page
    .getByRole("button", { exact: true, name: "verification.mdを保存" })
    .waitFor();

  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  console.log(
    `PASS real-content drilldown (architecture -> function-flow -> business-flow); evidence: ${dir}`
  );
} finally {
  await browser.close();
}
