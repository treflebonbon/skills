// Run with Node. Set STUDIO_PLAYWRIGHT_MODULE to an installed Playwright index.mjs
// and optionally STUDIO_CHROMIUM to an existing Chromium executable. No download.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { example } from "./fixture.mjs";

const { join } = path;

const { chromium } = await import(
  process.env.STUDIO_PLAYWRIGHT_MODULE || "playwright"
);
const dir = await mkdtemp(join(tmpdir(), "domain-studio-check-"));
const base = example();
base.models.current.nodes[0].data.label =
  "依頼 <script>window.pwned=1</script>";
base.models.proposed.nodes[0].data.label =
  base.models.current.nodes[0].data.label;
base.glossary = [
  { definition: "架空の説明用語", evidence: [], status: "draft", term: "依頼" },
];
base.scenarios = [
  {
    evidence: [],
    given: ["依頼がある"],
    id: "sample",
    model: "current",
    status: "draft",
    // oxlint-disable-next-line unicorn/no-thenable -- Gherkin data, not a Promise.
    then: ["結果を確認する"],
    title: "架空の受諾",
    when: "受諾する",
  },
];
base.changes = [
  {
    evidence: [],
    id: "change",
    reason: "検討用",
    status: "proposed",
    title: "案内を改善する",
  },
];
const input = join(dir, "model.json");
const output = join(dir, "studio.html");
await writeFile(input, JSON.stringify(base));
execFileSync(process.execPath, [
  fileURLToPath(new URL("../scripts/render.mjs", import.meta.url)),
  input,
  output,
  join(dir, "artifacts"),
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
  page.on("dialog", (d) => d.accept());
  await page.goto(pathToFileURL(output).href);
  const header = page.locator(".topbar p");
  assert.equal(await header.isVisible(), true);
  assert.match(
    await header.textContent(),
    /セッション: example-session · 版: r1/u
  );
  await page
    .getByLabel("レビュー対象", { exact: true })
    .selectOption("node:request");
  assert.equal(
    await page.getByLabel("名称", { exact: true }).getAttribute("readonly"),
    ""
  );
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  // Layer selection drills architecture -> function-flow -> business-flow,
  // switching the selected layer and node together (fixture: fixture.mjs).
  await page
    .getByRole("button", { exact: true, name: "アーキテクチャ" })
    .click();
  // The layer filter must change what's actually on the canvas, not just
  // which options the inspector lists.
  await page.locator('.react-flow__node[data-id="accept-module"]').waitFor();
  assert.equal(
    await page.locator('.react-flow__node[data-id="request"]').count(),
    0
  );
  await page
    .getByLabel("レビュー対象", { exact: true })
    .selectOption("node:accept-module");
  await page
    .getByRole("button", { exact: true, name: "ドリルダウン: 受諾ステージ" })
    .click();
  assert.equal(
    await page
      .getByRole("button", { exact: true, name: "関数フロー" })
      .getAttribute("aria-pressed"),
    "true"
  );
  assert.equal(
    await page.getByLabel("レビュー対象", { exact: true }).inputValue(),
    "node:accept-stage"
  );
  await page.locator('.react-flow__node[data-id="accept-stage"]').waitFor();
  await page
    .getByRole("button", { exact: true, name: "ドリルダウン: 受諾する" })
    .click();
  assert.equal(
    await page
      .getByRole("button", { exact: true, name: "業務フロー" })
      .getAttribute("aria-pressed"),
    "true"
  );
  assert.equal(
    await page.getByLabel("レビュー対象", { exact: true }).inputValue(),
    "node:accept"
  );
  await page.locator('.react-flow__node[data-id="accept"]').waitFor();
  await page.getByRole("button", { exact: true, name: "改善案" }).click();
  // Layer selection stays independent of the current/proposed tab switch.
  assert.equal(
    await page
      .getByRole("button", { exact: true, name: "業務フロー" })
      .getAttribute("aria-pressed"),
    "true"
  );
  // Comments, Undo/Redo, and deletion must work the same on the
  // architecture/function-flow layers as on the business layer (#338).
  await page.getByRole("button", { exact: true, name: "関数フロー" }).click();
  await page
    .getByLabel("レビュー対象", { exact: true })
    .selectOption("node:accept-stage");
  await page
    .getByLabel("指摘を入力", { exact: false })
    .fill("ステージの境界を確認");
  await page.getByRole("button", { exact: true, name: "指摘を追加" }).click();
  await page.getByText("ステージの境界を確認", { exact: true }).waitFor();
  await page
    .getByRole("button", { exact: true, name: "アーキテクチャ" })
    .click();
  await page
    .getByLabel("レビュー対象", { exact: true })
    .selectOption("node:accept-module");
  await page
    .getByLabel("指摘を入力", { exact: false })
    .fill("モジュールの範囲を確認");
  await page.getByRole("button", { exact: true, name: "指摘を追加" }).click();
  await page.getByText("モジュールの範囲を確認", { exact: true }).waitFor();
  // Undo/Redo act on the whole document, not just the layer on screen.
  await page.getByRole("button", { exact: true, name: "元に戻す" }).click();
  assert.equal(
    await page.getByText("モジュールの範囲を確認", { exact: true }).count(),
    0
  );
  await page.getByRole("button", { exact: true, name: "やり直す" }).click();
  await page.getByText("モジュールの範囲を確認", { exact: true }).waitFor();
  await page
    .getByRole("button", { exact: true, name: "ドリルダウン: 受諾ステージ" })
    .click();
  // The function-flow comment survived the Undo/Redo round trip and the
  // layer navigation away from it.
  await page.getByText("ステージの境界を確認", { exact: true }).waitFor();
  // accept-module.drillInto points at accept-stage: deleting the target
  // must retire it (with its comment) instead of failing validation.
  await page
    .getByRole("button", { exact: true, name: "選択対象を削除" })
    .click();
  await page
    .getByRole("button", { exact: true, name: "アーキテクチャ" })
    .click();
  await page
    .getByLabel("レビュー対象", { exact: true })
    .selectOption("node:accept-module");
  assert.equal(
    await page.getByRole("button", { name: /^ドリルダウン/u }).count(),
    0
  );
  await page.getByRole("button", { exact: true, name: "業務フロー" }).click();
  await page
    .getByLabel("レビュー対象", { exact: true })
    .selectOption("node:request");
  await page.getByLabel("名称", { exact: true }).fill("再発行する");
  await page.getByRole("button", { exact: true, name: "元に戻す" }).click();
  assert.equal(
    await page.getByLabel("名称", { exact: true }).inputValue(),
    base.models.proposed.nodes[0].data.label
  );
  await page.getByRole("button", { exact: true, name: "やり直す" }).click();
  assert.equal(
    await page.getByLabel("名称", { exact: true }).inputValue(),
    "再発行する"
  );
  await page.getByLabel("width", { exact: true }).fill("240");
  const positionBefore = await page
    .getByLabel("x", { exact: true })
    .inputValue();
  const canvasNode = page.locator('.react-flow__node[data-id="request"]');
  const bounds = await canvasNode.boundingBox();
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width / 2 + 60,
    bounds.y + bounds.height / 2 + 20,
    { steps: 5 }
  );
  await page.mouse.up();
  assert.notEqual(
    await page.getByLabel("x", { exact: true }).inputValue(),
    positionBefore
  );
  await page.getByRole("button", { exact: true, name: "元に戻す" }).click();
  assert.equal(
    await page.getByLabel("x", { exact: true }).inputValue(),
    positionBefore
  );

  await page
    .getByLabel("指摘を入力", { exact: false })
    .fill("旧依頼を失効する条件を確認");
  await page.getByRole("button", { exact: true, name: "指摘を追加" }).click();
  // Test a rejected clipboard API, not a simulated successful copy.
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error("denied")),
      },
    })
  );
  await page
    .getByRole("button", { exact: true, name: "指摘・モデルをコピー" })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "自動コピーできません" })
    .waitFor();
  const payload = async () => {
    const value = await page
      .getByLabel("AIへ渡すMarkdown", { exact: true })
      .inputValue();
    return JSON.parse(
      value.match(/\n```json\n(?<payload>[\s\S]*?)\n```/u).groups.payload
    );
  };
  let copied = await payload();
  assert.equal(copied.document.models.proposed.nodes[0].id, "request");
  assert.equal(copied.document.models.proposed.nodes[0].width, 240);
  await page
    .getByRole("button", { exact: true, name: "手動でコピーしたことを記録" })
    .click();
  await page.getByLabel("名称", { exact: true }).fill("コピー後に変更");
  await page.getByRole("alert").filter({ hasText: "コピー後に変更" }).waitFor();
  const incoming = {
    ...copied.document,
    basedOn: { exportId: copied.exportId, revision: "r1" },
    needsReview: false,
    revision: "r2",
  };
  const updateFile = join(dir, "update.json");
  await writeFile(updateFile, JSON.stringify(incoming));
  await page.locator("input[type=file]").setInputFiles(updateFile);
  await page.getByRole("region", { name: "更新の競合" }).waitFor();
  assert.equal(
    await page.getByLabel("名称", { exact: true }).inputValue(),
    "コピー後に変更"
  );
  await page
    .getByRole("button", { exact: true, name: "現在の編集を続ける" })
    .click();
  await page
    .getByRole("button", { exact: true, name: "指摘・モデルをコピー" })
    .click();
  copied = await payload();
  await page
    .getByRole("button", { exact: true, name: "手動でコピーしたことを記録" })
    .click();
  const expectProtectedImport = async (patch) => {
    await writeFile(
      updateFile,
      JSON.stringify({
        ...copied.document,
        basedOn: { exportId: copied.exportId, revision: "r1" },
        revision: "r2",
        ...patch,
      })
    );
    await page.locator("input[type=file]").setInputFiles(updateFile);
    await page.getByRole("region", { name: "更新の競合" }).waitFor();
    assert.equal(
      await page.getByLabel("名称", { exact: true }).inputValue(),
      "コピー後に変更"
    );
    await page.getByText("業務ルールを確認する", { exact: true }).waitFor();
    await page
      .getByRole("button", { exact: true, name: "現在の編集を続ける" })
      .click();
  };
  await expectProtectedImport({ unresolved: [] });
  await expectProtectedImport({
    repository: {
      ...copied.document.repository,
      revision: "b".repeat(40),
    },
  });
  const reverted = structuredClone(copied.document.models);
  reverted.proposed.nodes[0].data.label =
    base.models.proposed.nodes[0].data.label;
  await expectProtectedImport({ models: reverted });
  await writeFile(
    updateFile,
    JSON.stringify({
      ...copied.document,
      basedOn: { exportId: copied.exportId, revision: "r1" },
      needsReview: false,
      revision: "r2",
    })
  );
  await page.locator("input[type=file]").setInputFiles(updateFile);
  await page
    .getByRole("status")
    .filter({ hasText: "AI更新版を取り込みました" })
    .waitFor();
  await page
    .getByLabel("レビュー対象", { exact: true })
    .selectOption("node:request");
  await page
    .getByRole("button", { exact: true, name: "選択対象を削除" })
    .click();
  await page.getByText("削除した対象と指摘（3）", { exact: true }).click();
  await page.getByText("旧依頼を失効する条件を確認", { exact: true }).waitFor();
  await page.getByRole("button", { exact: true, name: "元に戻す" }).click();
  await page
    .getByLabel("レビュー対象", { exact: true })
    .selectOption("edge:request-accept");
  await page.getByLabel("条件ラベル", { exact: true }).fill("新しい条件");
  await page.getByLabel("接続元", { exact: true }).selectOption("accept");
  await page.getByRole("button", { exact: true, name: "関係を追加" }).click();
  await page.getByRole("button", { exact: true, name: "要素を追加" }).click();
  await page.getByLabel("名称", { exact: true }).fill("追加した要素");
  await page
    .getByLabel("指摘を入力", { exact: false })
    .fill("追加ボタン前の指摘も退避する");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { exact: true, name: "JSONを保存" }).click();
  const backup = await downloaded;
  const backupPath = join(dir, "backup.json");
  await backup.saveAs(backupPath);
  const backupData = JSON.parse(await readFile(backupPath, "utf-8"));
  assert.ok(
    backupData.document.comments.some(
      (c) => c.text === "追加ボタン前の指摘も退避する"
    )
  );
  await page
    .getByRole("button", { exact: true, name: "指摘・モデルをコピー" })
    .click();
  copied = await payload();
  await page
    .getByRole("button", { exact: true, name: "手動でコピーしたことを記録" })
    .click();
  await writeFile(
    updateFile,
    JSON.stringify({
      ...copied.document,
      basedOn: { exportId: copied.exportId, revision: "r2" },
      revision: "r3",
      revisionHistory: [],
    })
  );
  await page.locator("input[type=file]").setInputFiles(updateFile);
  await page
    .getByRole("status")
    .filter({ hasText: "AI更新版を取り込みました" })
    .waitFor();
  await page
    .getByLabel("レビュー対象", { exact: true })
    .selectOption(
      `node:${backupData.document.models.proposed.nodes.find((n) => n.data.label === "追加した要素").id}`
    );
  await page.getByLabel("名称", { exact: true }).fill("復元前の変更");
  await page.locator("input[type=file]").setInputFiles(backupPath);
  await page
    .getByRole("button", { exact: true, name: "退避して保存版を復元" })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "保存JSONを復元しました" })
    .waitFor();
  await page
    .getByRole("button", { exact: true, name: "指摘・モデルをコピー" })
    .click();
  copied = await payload();
  assert.ok(
    copied.document.models.proposed.nodes.some(
      (n) => n.data.label === "追加した要素"
    )
  );
  assert.ok(
    !copied.document.models.proposed.nodes.some(
      (n) => n.data.label === "復元前の変更"
    )
  );
  // Reload uses the current saved draft, including an imported newer revision.
  await page.reload();
  await page.getByRole("button", { exact: true, name: "改善案" }).click();
  await page
    .getByRole("button", { exact: true, name: "指摘・モデルをコピー" })
    .click();
  copied = await payload();
  assert.equal(copied.document.revision, "r2");
  assert.deepEqual(copied.document.revisionHistory.toSorted(), ["r1", "r3"]);
  await page
    .getByRole("button", { exact: true, name: "手動でコピーしたことを記録" })
    .click();
  await writeFile(
    updateFile,
    JSON.stringify({
      ...copied.document,
      basedOn: { exportId: copied.exportId, revision: "r2" },
      revision: "r1",
    })
  );
  await page.locator("input[type=file]").setInputFiles(updateFile);
  await page.getByRole("region", { name: "更新の競合" }).waitFor();
  await page
    .getByRole("button", { exact: true, name: "現在の編集を続ける" })
    .click();
  assert.ok(
    copied.document.models.proposed.nodes.some(
      (n) => n.data.label === "追加した要素"
    )
  );
  await page.screenshot({ fullPage: true, path: join(dir, "desktop.png") });
  await page.setViewportSize({ height: 844, width: 390 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  );
  await page.screenshot({ fullPage: true, path: join(dir, "mobile.png") });
  const renderedFiles = await Promise.all(
    ["model.md", "glossary.md", "scenarios.feature", "changes.md"].map((name) =>
      readFile(join(dir, "artifacts", name), "utf-8")
    )
  );
  assert.ok(renderedFiles.every((content) => content.length > 10));
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  // Storage failure must remain usable and visible.
  const other = await browser.newContext({ offline: true });
  await other.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
  });
  const failed = await other.newPage();
  await failed.goto(pathToFileURL(output).href);
  await failed
    .getByRole("alert")
    .filter({ hasText: "ブラウザに保存できません" })
    .waitFor();
  await failed
    .getByRole("button", { exact: true, name: "指摘・モデルをコピー" })
    .click();
  await failed.getByLabel("AIへ渡すMarkdown", { exact: true }).waitFor();
  console.log(
    `PASS offline browser workflow, zero remote requests; evidence: ${dir}`
  );
} finally {
  await browser.close();
}
