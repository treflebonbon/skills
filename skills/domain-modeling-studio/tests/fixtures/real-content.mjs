// A model built from the actual generators/procedures (#334's
// generateArchitecture, #335's evidence-grounded function-flow layer), not a
// hand-typed placeholder like fixture.mjs. Used by real-content.test.mjs
// (schema/shape checks) and browser-real-content.mjs (drilldown UI check),
// so #337 can verify the layer-selector UI against real generated content
// instead of only the deliberately fictional fixture.
import { fileURLToPath } from "node:url";

import { generateArchitecture } from "../../scripts/generate-architecture.mjs";
import {
  checkoutFunctionFlow,
  FIXTURE_REVISION,
  TS_PATH,
  RS_PATH,
} from "./checkout-flow.mjs";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

export const buildRealContentDocument = async () => {
  const architecture = await generateArchitecture({
    repoRoot,
    revision: FIXTURE_REVISION,
    seeds: [TS_PATH, RS_PATH],
  });
  const moduleByLabel = (label) =>
    architecture.nodes.find((n) => n.data.label === label);
  // The module that defines each fixture's checkout function drills into
  // that function's own success termination in the function-flow layer.
  moduleByLabel(TS_PATH).data.drillInto = "ts-success-end";
  moduleByLabel(RS_PATH).data.drillInto = "rs-success-end";

  const { businessNode, edges, nodes } = checkoutFunctionFlow();
  const graph = {
    edges: [...architecture.edges, ...edges],
    nodes: [...architecture.nodes, ...nodes],
  };
  return {
    architecture,
    businessNode,
    document: {
      basedOn: null,
      changes: [],
      comments: [],
      glossary: [],
      models: {
        current: structuredClone(graph),
        proposed: structuredClone(graph),
      },
      repository: {
        name: "example/checkout-fixtures",
        revision: FIXTURE_REVISION,
      },
      retired: [],
      revision: "r1",
      scenarios: [],
      schemaVersion: 2,
      scope:
        "実際の生成器・手順が出した3層(アーキテクチャ/関数フロー/業務フロー)モデル",
      sessionId: "real-content-session",
      title: "実生成コンテンツでのレイヤー統合ドリルダウン検証",
      unresolved: [],
    },
  };
};
