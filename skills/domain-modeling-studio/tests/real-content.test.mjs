import assert from "node:assert/strict";
import { test } from "node:test";

import { validateDocument } from "../src/model.mjs";
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
