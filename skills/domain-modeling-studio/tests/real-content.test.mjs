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
  assert.doesNotMatch(recovered, /判断: 追加/u);

  const confirmed = ruleBlock("注文は請求が成功したときだけ確定済みになる");
  assert.doesNotMatch(confirmed, /### 既存テスト/u);
  assert.match(confirmed, /判断: 追加/u);
  assert.match(confirmed, /理由: この状態遷移を観測する既存テストがない/u);
});
