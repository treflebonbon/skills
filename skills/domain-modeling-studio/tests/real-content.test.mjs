import assert from "node:assert/strict";
import { test } from "node:test";

import { artifacts, validateDocument } from "../src/model.mjs";
import { example } from "./fixture.mjs";
import { buildRealContentDocument } from "./fixtures/real-content.mjs";

const shapeOf = (obj) => Object.keys(obj).toSorted();
const assertSameShape = (real, fixture) => {
  assert.deepEqual(shapeOf(real), shapeOf(fixture));
  assert.deepEqual(shapeOf(real.data), shapeOf(fixture.data));
  assert.deepEqual(shapeOf(real.position), shapeOf(fixture.position));
};

test("#334の生成器と#335の関数フロー層が出した実際のモデルを1つの文書として開ける", async () => {
  const { architecture, businessNode, document } =
    await buildRealContentDocument();

  // The architecture layer really came from scanning import statements, not
  // from typing MODULE/EXTERNAL nodes by hand.
  assert.deepEqual(architecture.nodes.map((n) => n.data.label).toSorted(), [
    "effect",
    "skills/domain-modeling-studio/tests/fixtures/effect-checkout.ts.fixture",
    "skills/domain-modeling-studio/tests/fixtures/rust-checkout.rs.fixture",
  ]);
  assert.ok(architecture.edges.length > 0);

  assert.doesNotThrow(() => validateDocument(document));

  // The full architecture -> function-flow -> business-flow chain resolves,
  // without needing a browser to walk drillInto by hand.
  const byId = new Map(document.models.proposed.nodes.map((n) => [n.id, n]));
  const tsModule = document.models.proposed.nodes.find(
    (n) =>
      n.data.kind === "MODULE" &&
      n.data.label.endsWith("effect-checkout.ts.fixture")
  );
  const flowTarget = byId.get(tsModule.data.drillInto);
  assert.equal(flowTarget.data.kind, "TERMINATION");
  const businessTarget = byId.get(flowTarget.data.drillInto);
  assert.equal(businessTarget.id, businessNode.id);
});

test("手作りフィクスチャと実生成物のあいだでノード・関係の形状(フィールド集合)が一致する", async () => {
  const { architecture, document } = await buildRealContentDocument();
  const fixtureGraph = example().models.current;

  // Architecture layer (generateArchitecture's raw output) vs the hand fixture's MODULE node.
  assertSameShape(
    architecture.nodes.find((n) => n.data.kind === "MODULE"),
    fixtureGraph.nodes.find((n) => n.data.kind === "MODULE")
  );

  // Function-flow layer (evidence-grounded, #335) vs the hand fixture's STAGE node.
  // Both compared nodes carry drillInto, so the field sets line up field-for-field.
  const realFlowNode = document.models.proposed.nodes.find(
    (n) => n.id === "ts-success-end"
  );
  assertSameShape(
    realFlowNode,
    fixtureGraph.nodes.find((n) => n.data.kind === "STAGE")
  );

  const [fixtureEdge] = fixtureGraph.edges;
  const [realEdge] = architecture.edges;
  assert.deepEqual(shapeOf(realEdge), shapeOf(fixtureEdge));
  assert.deepEqual(shapeOf(realEdge.data), shapeOf(fixtureEdge.data));
});

test("架空のcheckoutで、業務ルールから関連要素・既存テスト・検証候補を辿り、守れているルールには追加でなく維持を示す", async () => {
  const { document } = await buildRealContentDocument();
  const doc = validateDocument(document);
  assert.deepEqual(doc.rules.map((r) => r.kind).toSorted(), [
    "INVARIANT",
    "RULE",
    "RULE",
    "TRANSITION",
  ]);
  const file = artifacts(doc)["verification.md"];
  const ruleBlock = (statement) => {
    const start = file.indexOf(`## 業務ルール: ${statement}`);
    assert.notEqual(start, -1, statement);
    const next = file.indexOf("\n## ", start + 1);
    return file.slice(start, next === -1 ? undefined : next);
  };

  const recovered = ruleBlock("在庫切れの注文は代替入荷で確定する");
  assert.match(recovered, /関連要素: 在庫切れを代替入荷へ回復する/u);
  assert.match(recovered, /### 既存テスト: 在庫切れを代替入荷で確定するテスト/u);
  assert.match(recovered, /判断: 維持/u);
  assert.match(
    recovered,
    /理由: OutOfStockだけを回復する条件を関数の境界で直接観測する唯一のテストのため、同じ役割のテストは追加しない/u
  );
  assert.doesNotMatch(recovered, /判断: 追加/u);

  const confirmed = ruleBlock("注文は請求が成功したときだけ確定済みになる");
  assert.doesNotMatch(confirmed, /### 既存テスト/u);
  assert.match(confirmed, /判断: 追加/u);
  assert.match(confirmed, /理由: この状態遷移を観測する既存テストがない/u);
});

test("架空のcheckoutで、業務ルールから代表例・性質・反例を辿れ、未合意の性質は未確認事項にも並ぶ", async () => {
  const { document } = await buildRealContentDocument();
  const doc = validateDocument(document);
  const out = artifacts(doc);
  const file = out["verification.md"];
  const ruleBlock = (statement) => {
    const start = file.indexOf(`## 業務ルール: ${statement}`);
    assert.notEqual(start, -1, statement);
    const next = file.indexOf("\n## ", start + 1);
    return file.slice(start, next === -1 ? undefined : next);
  };

  const recovered = ruleBlock("在庫切れの注文は代替入荷で確定する");
  assert.match(recovered, /代表例: 在庫切れの注文を代替入荷で確定する（現状 \/ 確認済み）/u);
  assert.match(recovered, /判断: 保留/u);
  assert.match(recovered, /未合意の性質（コードで確認）: 在庫切れの注文の確定応答は/u);
  assert.match(recovered, /理由: 実装の式をそのまま期待値に写しており/u);

  const declined = ruleBlock("支払いが拒否された注文は確定しない");
  assert.match(declined, /代表例: 支払いを拒否された注文は確定しない（現状 \/ 確認済み）/u);
  assert.match(declined, /合意済みの性質（業務上の合意）: 支払いが拒否された注文は、明細や金額によらず確定しない/u);
  assert.match(declined, /未合意の性質（AIの推測）: 支払いの拒否理由が何であっても/u);
  assert.match(declined, /検証結果: 実行・失敗/u);
  assert.match(declined, /seed: ` 1729 `/u);
  assert.match(declined, /反例: ` 明細: \[\{ 数量: 1, 単価: 0 \}\], 支払い: 拒否 `/u);
  assert.equal(file.match(/合意済みの性質/gu).length, 1);

  const unknowns = file.slice(file.indexOf("## 未確認事項"));
  assert.match(unknowns, /未合意の性質: 実装の式を写した代替入荷の性質を保留する（コードで確認）/u);
  assert.match(unknowns, /未合意の性質: 拒否理由によらずCheckoutFailedを返すことを確かめる（AIの推測）/u);

  const feature = out["scenarios.feature"];
  for (const id of ["rule-backorder", "rule-declined", "rule-confirmed"]) {
    assert.match(feature, new RegExp(`# 業務ルール: ${id}\\n {2}Scenario:`, "u"));
  }
});

test("架空のcheckoutで、業務ルールから手法ごとの計画・不採用・保留・形式モデルの探索範囲を辿れる", async () => {
  const { document } = await buildRealContentDocument();
  const doc = validateDocument(document);
  const file = artifacts(doc)["verification.md"];
  const ruleBlock = (statement) => {
    const start = file.indexOf(`## 業務ルール: ${statement}`);
    assert.notEqual(start, -1, statement);
    const next = file.indexOf("\n## ", start + 1);
    return file.slice(start, next === -1 ? undefined : next);
  };
  const methods = doc.verificationCandidates
    .filter((c) => c.decision !== "DECLINE")
    .map((c) => c.method);
  for (const method of ["MBT", "QUINT", "ALLOY", "MUTATION"]) {
    assert.ok(methods.includes(method), method);
  }

  const confirmed = ruleBlock("注文は請求が成功したときだけ確定済みになる");
  assert.match(confirmed, /### 検証手法: モデルベーステスト/u);
  assert.match(confirmed, /モデルと実装の対応: /u);
  assert.match(confirmed, /被覆目標: /u);
  assert.match(confirmed, /### 検証手法: Quint/u);
  assert.match(confirmed, /\*\*保証しないこと\*\*: 実装の正しさの証明ではない/u);

  const declined = ruleBlock("支払いが拒否された注文は確定しない");
  assert.match(declined, /### 既存テスト: 支払い拒否の注文が確定に至らないAlloyモデル/u);
  assert.match(declined, /検証結果: 形式モデルで反例なし/u);
  assert.match(declined, /実際に探索した範囲: 注文3件・明細4件・支払い3件まで/u);
  assert.match(declined, /### 検証手法: Alloy/u);
  assert.match(declined, /計画時の探索範囲: 注文5件・明細6件・支払い5件まで/u);
  assert.match(declined, /### 検証手法: ミューテーションテスト/u);
  assert.match(declined, /対象の既存テスト: 支払い拒否を確定しないテスト（test\\-declined）/u);

  const recovered = ruleBlock("在庫切れの注文は代替入荷で確定する");
  const rejected = recovered.slice(recovered.indexOf("### 不採用の検証手法"));
  assert.match(rejected, /判断: 不採用/u);
  assert.match(rejected, /検証手法: Quint/u);
  assert.match(rejected, /理由: 1回の予約失敗を回復する分岐で/u);

  const notice = ruleBlock("代替入荷で確定した注文には入荷予定日を知らせる");
  assert.match(notice, /改善案/u);
  assert.match(notice, /### 検証手法: ミューテーションテスト/u);
  assert.match(notice, /判断: 保留/u);
  assert.match(notice, /理由: 改善案の業務ルールで、検出を確かめる既存テストがまだない/u);
  assert.doesNotMatch(notice, /### 既存テスト/u);

  // The current fixture proposes no merge or delete, so no TIA note.
  assert.doesNotMatch(file, /TIA/u);
});
