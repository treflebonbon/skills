export const KINDS = [
  "COMMAND",
  "EVENT",
  "POLICY",
  "READ_MODEL",
  "AGGREGATE",
  "ACTOR",
  "PROCESS",
];
export const ARCHITECTURE_KINDS = ["MODULE", "EXTERNAL"];
export const FLOW_KINDS = [
  "STAGE",
  "FAILURE_HANDLER",
  "RECOVERY",
  "BYPASS",
  "TERMINATION",
  "OUTSIDE_TYPED_ERROR",
];
const ALL_KINDS = new Set([...KINDS, ...ARCHITECTURE_KINDS, ...FLOW_KINDS]);
// drillInto: architecture node -> a node in its function-flow graph; flow node -> its business-flow node.
const DRILL_TARGETS = {
  ...Object.fromEntries(ARCHITECTURE_KINDS.map((k) => [k, FLOW_KINDS])),
  ...Object.fromEntries(FLOW_KINDS.map((k) => [k, KINDS])),
};
export const ORIGINS = {
  agreement: "業務上の合意",
  code: "コードで確認",
  inference: "AIの推測",
  proposal: "未検証の改善案",
};
export const RULE_KINDS = {
  INVARIANT: "不変条件",
  RULE: "業務ルール（一般）",
  TRANSITION: "状態遷移",
};
export const BOUNDARIES = {
  ADAPTER_INTEGRATION: "アダプター結合",
  DOMAIN: "ドメイン",
  FUNCTION: "関数",
  PORT_CONTRACT: "ポート契約",
  SLICE: "スライス",
};
export const RESULTS = {
  FAILED: "実行・失敗",
  MODEL_COUNTEREXAMPLE: "形式モデルで反例あり",
  MODEL_NO_COUNTEREXAMPLE: "形式モデルで反例なし",
  NOT_RUN: "未実行",
  PASSED: "実行・合格",
  READ: "読んだのみ",
  SKIPPED: "スキップ",
};
export const DECISIONS = {
  ADD: "追加",
  DELETE: "削除",
  HOLD: "保留",
  KEEP: "維持",
  MERGE: "統合",
};
const views = ["current", "proposed"];
const VIEW_LABELS = { current: "現状", proposed: "改善案" };
const VERIFICATION_KEYS = ["rules", "existingTests", "verificationCandidates"];
// Retired verification records use these entity names under view "verification".
const VERIFICATION_ENTITIES = {
  existingTests: "existingTest",
  rules: "rule",
  verificationCandidates: "verificationCandidate",
};
// schemaVersion 2 documents carry no verification records; read them as empty.
export const verificationOf = (doc) =>
  Object.fromEntries(VERIFICATION_KEYS.map((key) => [key, doc[key] ?? []]));
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string";
const nonempty = (v) => text(v) && v.trim().length > 0;
const commitId = (v) => text(v) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(v);
const id = (v) => text(v) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(v);
const need = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};
const evidence = (items) => {
  need(Array.isArray(items), "根拠は配列で指定してください");
  for (const ref of items) {
    need(
      object(ref) &&
        nonempty(ref.path) &&
        nonempty(ref.symbol) &&
        commitId(ref.revision),
      "根拠にpath・symbol・完全なコミットIDのrevisionが必要です"
    );
    need(
      !ref.path.startsWith("/") && !ref.path.split("/").includes(".."),
      "根拠はリポジトリ相対パスで指定してください"
    );
    need(
      ref.line === undefined || (Number.isInteger(ref.line) && ref.line > 0),
      "根拠の行番号が不正です"
    );
  }
};
const provenance = (data) => {
  need(object(data) && Object.hasOwn(ORIGINS, data.origin), "確度が不正です");
  evidence(data.evidence);
  need(
    data.origin !== "code" || data.evidence.length > 0,
    "コードで確認した要素には根拠が必要です"
  );
};
const validateNode = (node) => {
  need(
    nonempty(node.data.label) && ALL_KINDS.has(node.data.kind),
    "要素の名称・種別が不正です"
  );
  need(
    object(node.position) &&
      Number.isFinite(node.position.x) &&
      Number.isFinite(node.position.y),
    "要素の配置が不正です"
  );
  need(
    Number.isFinite(node.width) &&
      node.width >= 100 &&
      Number.isFinite(node.height) &&
      node.height >= 60,
    "要素のサイズが不正です"
  );
};
const validateDrillInto = (node, nodeKinds) => {
  const target = node.data.drillInto;
  if (target === undefined) {
    return;
  }
  const allowed = DRILL_TARGETS[node.data.kind];
  need(
    allowed && id(target) && allowed.includes(nodeKinds.get(target)),
    "ドリルダウン参照先が見つかりません"
  );
};
const validateGraph = (graph, view) => {
  need(
    object(graph) && Array.isArray(graph.nodes) && Array.isArray(graph.edges),
    `${view}にnodes・edgesが必要です`
  );
  const ids = new Set();
  for (const item of [...graph.nodes, ...graph.edges]) {
    need(
      object(item) && id(item.id) && !ids.has(item.id),
      "要素・関係のIDが不正または重複しています"
    );
    ids.add(item.id);
    provenance(item.data);
  }
  for (const node of graph.nodes) {
    validateNode(node);
  }
  const nodeKinds = new Map(graph.nodes.map((n) => [n.id, n.data.kind]));
  for (const node of graph.nodes) {
    validateDrillInto(node, nodeKinds);
  }
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  for (const edge of graph.edges) {
    need(
      nodeIds.has(edge.source) && nodeIds.has(edge.target),
      "接続先が見つかりません"
    );
    need(text(edge.label), "関係の条件ラベルが必要です");
  }
};

const validateComment = (comment) => {
  need(
    object(comment) &&
      id(comment.id) &&
      text(comment.text) &&
      object(comment.target),
    "指摘の形式が不正です"
  );
  need(
    comment.target.view === "whole" ||
      ([...views, "verification"].includes(comment.target.view) &&
        id(comment.target.id)),
    "指摘対象が不正です"
  );
};

const validateRetired = (entry) => {
  if (entry?.view === "verification") {
    // Referential checks no longer apply to a removed record; keep it legible.
    need(
      Object.values(VERIFICATION_ENTITIES).includes(entry.entity) &&
        object(entry.item) &&
        id(entry.item.id) &&
        nonempty(entry.item.statement ?? entry.item.title),
      "削除記録が不正です"
    );
    evidence(entry.item.evidence);
    return;
  }
  need(
    object(entry) &&
      views.includes(entry.view) &&
      ["node", "edge"].includes(entry.entity) &&
      object(entry.item) &&
      id(entry.item.id),
    "削除記録が不正です"
  );
  provenance(entry.item.data);
  if (entry.entity === "node") {
    validateNode(entry.item);
  } else {
    need(
      id(entry.item.source) && id(entry.item.target),
      "削除した関係の端点が不正です"
    );
  }
  need(
    entry.entity === "node"
      ? nonempty(entry.item.data.label)
      : text(entry.item.label),
    "削除対象の名称が不正です"
  );
};

const validateTerm = (term) => {
  need(
    object(term) &&
      nonempty(term.term) &&
      text(term.definition) &&
      ["confirmed", "draft"].includes(term.status),
    "用語辞書の形式が不正です"
  );
  evidence(term.evidence);
};

const validateScenario = (scenario) => {
  need(
    object(scenario) &&
      id(scenario.id) &&
      nonempty(scenario.title) &&
      views.includes(scenario.model) &&
      ["confirmed", "draft"].includes(scenario.status),
    "シナリオの形式が不正です"
  );
  need(
    Array.isArray(scenario.given) &&
      scenario.given.length > 0 &&
      scenario.given.every(nonempty) &&
      nonempty(scenario.when) &&
      Array.isArray(scenario.then) &&
      scenario.then.length > 0 &&
      scenario.then.every(nonempty),
    "シナリオの前提・操作・結果が必要です"
  );
  evidence(scenario.evidence);
  need(
    scenario.status !== "confirmed" || scenario.evidence.length > 0,
    "確認済みシナリオには根拠が必要です"
  );
};

const validateChange = (change) => {
  need(
    object(change) &&
      id(change.id) &&
      nonempty(change.title) &&
      text(change.reason) &&
      ["proposed", "agreed"].includes(change.status),
    "実装変更候補の形式が不正です"
  );
  evidence(change.evidence);
};

// A rule may point at a removed element: deleting a proposed node must not
// invalidate the rule, and the retired record keeps the target attributable.
const elementIds = (doc, view) =>
  new Set([
    ...[...doc.models[view].nodes, ...doc.models[view].edges].map((i) => i.id),
    ...doc.retired.filter((r) => r.view === view).map((r) => r.item.id),
  ]);
const validateRule = (rule, doc) => {
  need(
    object(rule) &&
      Object.hasOwn(RULE_KINDS, rule.kind) &&
      nonempty(rule.statement) &&
      views.includes(rule.model),
    "業務ルールの形式が不正です"
  );
  provenance(rule);
  const known = elementIds(doc, rule.model);
  need(
    Array.isArray(rule.targets) &&
      rule.targets.length > 0 &&
      rule.targets.every((target) => known.has(target)),
    "業務ルールの関連先が見つかりません"
  );
};
const validateBoundary = (boundary) => {
  need(
    object(boundary) && Object.hasOwn(BOUNDARIES, boundary.kind),
    "検証の境界が不正です"
  );
  provenance(boundary);
};
const validateResult = (result) => {
  need(
    object(result) && Object.hasOwn(RESULTS, result.status),
    "検証結果の区分が不正です"
  );
  // Only an actual run is a result; reading a test or not running it is not.
  need(
    ["READ", "NOT_RUN"].includes(result.status) ||
      (nonempty(result.command) &&
        commitId(result.revision) &&
        nonempty(result.source)),
    "実行結果には実行コマンド・対象revision・出所が必要です"
  );
};
const validateExistingTest = (item, rules) => {
  need(
    object(item) && nonempty(item.title) && Array.isArray(item.evidence),
    "既存テストの形式が不正です"
  );
  evidence(item.evidence);
  need(item.evidence.length > 0, "既存テストの形式が不正です（読んだ位置の根拠が必要です）");
  need(
    Array.isArray(item.rules) &&
      item.rules.length > 0 &&
      item.rules.every((ruleId) => rules.has(ruleId)),
    "既存テストが守る業務ルールが見つかりません"
  );
  need(
    item.rules.every((ruleId) => rules.get(ruleId).model === "current"),
    "改善案の業務ルールには既存テストを紐づけられません"
  );
  validateBoundary(item.boundary);
  validateResult(item.result);
};
const validateCandidate = (item, rules, tests) => {
  need(
    object(item) &&
      nonempty(item.title) &&
      Object.hasOwn(DECISIONS, item.decision) &&
      (item.tests === undefined || Array.isArray(item.tests)),
    "検証候補の形式が不正です"
  );
  evidence(item.evidence);
  need(
    item.decision === "HOLD" ||
      (nonempty(item.error) &&
        item.rule !== undefined &&
        item.boundary !== undefined &&
        nonempty(item.reason)),
    "保留以外の検証候補には検出したい誤り・守る業務ルール・検証の境界・理由が必要です"
  );
  need(
    item.decision === "HOLD" || item.evidence.length > 0,
    "保留以外の検証候補には理由の根拠が必要です"
  );
  need(
    item.rule === undefined || rules.has(item.rule),
    "検証候補の業務ルールが見つかりません"
  );
  if (item.boundary !== undefined) {
    validateBoundary(item.boundary);
  }
  const targets = item.tests ?? [];
  need(
    !["KEEP", "MERGE", "DELETE"].includes(item.decision) || targets.length > 0,
    "維持・統合・削除の候補には対象の既存テストが必要です"
  );
  need(
    targets.every((testId) => tests.has(testId)),
    "対象の既存テストが見つかりません"
  );
  need(
    item.rule === undefined ||
      targets.every((testId) => tests.get(testId).rules.includes(item.rule)),
    "対象の既存テストが守る業務ルールと一致しません"
  );
};
const validateVerification = (doc) => {
  if (doc.schemaVersion === 2) {
    need(
      VERIFICATION_KEYS.every((key) => doc[key] === undefined),
      "業務ルール・既存テスト・検証候補にはschemaVersion: 3が必要です"
    );
    return;
  }
  for (const key of VERIFICATION_KEYS) {
    need(Array.isArray(doc[key]), `${key}は配列で指定してください`);
  }
  const ids = VERIFICATION_KEYS.flatMap((key) => doc[key]).map((i) => i?.id);
  need(
    ids.every(id) && new Set(ids).size === ids.length,
    "業務ルール・既存テスト・検証候補のIDが不正または重複しています"
  );
  for (const rule of doc.rules) {
    validateRule(rule, doc);
  }
  const rules = new Map(doc.rules.map((rule) => [rule.id, rule]));
  for (const item of doc.existingTests) {
    validateExistingTest(item, rules);
  }
  const tests = new Map(doc.existingTests.map((item) => [item.id, item]));
  for (const item of doc.verificationCandidates) {
    validateCandidate(item, rules, tests);
  }
};

const validateResolutions = (items = []) => {
  need(Array.isArray(items), "解決記録は配列で指定してください");
  for (const item of items) {
    need(
      object(item) && nonempty(item.question) && nonempty(item.reason),
      "解決記録には元の質問と解決理由が必要です"
    );
    evidence(item.evidence);
  }
};

const semanticFields = {
  edges: ["label", "source", "target"],
  nodes: ["label", "kind"],
};
const validateEditResolutions = (items = []) => {
  need(Array.isArray(items), "編集解決記録は配列で指定してください");
  for (const item of items) {
    need(
      object(item) &&
        id(item.id) &&
        ["node", "edge"].includes(item.entity) &&
        semanticFields[item.entity === "node" ? "nodes" : "edges"].includes(
          item.field
        ) &&
        text(item.before) &&
        text(item.after) &&
        nonempty(item.reason),
      "編集解決記録には対象・変更前後の値・理由が必要です"
    );
    evidence(item.evidence);
  }
};
const validateHistory = (history = []) => {
  need(
    Array.isArray(history) &&
      history.every(id) &&
      new Set(history).size === history.length,
    "版履歴は重複のないrevisionの配列で指定してください"
  );
};

export const validateDocument = (doc) => {
  need(
    object(doc) && [2, 3].includes(doc.schemaVersion),
    "未対応のモデル形式です（schemaVersion: 2または3が必要）"
  );
  need(id(doc.sessionId) && id(doc.revision), "sessionId・revisionが不正です");
  need(nonempty(doc.title) && text(doc.scope), "タイトル・対象範囲が必要です");
  need(
    object(doc.repository) &&
      nonempty(doc.repository.name) &&
      commitId(doc.repository.revision),
    "リポジトリと完全なコミットIDの参照版が必要です"
  );
  need(
    doc.basedOn === null ||
      (object(doc.basedOn) &&
        id(doc.basedOn.revision) &&
        id(doc.basedOn.exportId)),
    "basedOnが不正です"
  );
  need(object(doc.models), "現状・改善案が必要です");
  need(
    doc.needsReview === undefined || typeof doc.needsReview === "boolean",
    "needsReviewは真偽値で指定してください"
  );
  for (const view of views) {
    validateGraph(doc.models[view], view);
  }
  for (const key of [
    "comments",
    "retired",
    "glossary",
    "scenarios",
    "changes",
    "unresolved",
  ]) {
    need(Array.isArray(doc[key]), `${key}は配列で指定してください`);
  }
  for (const item of doc.comments) {
    validateComment(item);
  }
  need(
    new Set(doc.comments.map((c) => c.id)).size === doc.comments.length,
    "指摘IDが重複しています"
  );
  for (const item of doc.retired) {
    validateRetired(item);
  }
  for (const item of doc.glossary) {
    validateTerm(item);
  }
  for (const item of doc.scenarios) {
    validateScenario(item);
  }
  for (const item of doc.changes) {
    validateChange(item);
  }
  need(doc.unresolved.every(nonempty), "未解決事項は文字列で指定してください");
  validateVerification(doc);
  validateResolutions(doc.resolutions);
  validateEditResolutions(doc.editResolutions);
  validateHistory(doc.revisionHistory);
  // Imported JSON never supplies executable React Flow props, styles, or HTML.
  return structuredClone(doc);
};

export const signature = (doc) => JSON.stringify(doc);
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    object(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b))
        )
      : item
  );
const preservesEvidence = (before, after) =>
  before.every((ref) =>
    after.some((candidate) => canonical(ref) === canonical(candidate))
  );
const fieldValue = (item, key, field) =>
  key === "nodes" ? item.data[field] : item[field];
const preservesSemantics = (incoming, item, next, original, key) =>
  semanticFields[key].every((field) => {
    const before = fieldValue(item, key, field);
    const after = fieldValue(next, key, field);
    return (
      before === after ||
      (original && fieldValue(original, key, field) === before) ||
      incoming.editResolutions?.some(
        (record) =>
          record.id === item.id &&
          record.entity === (key === "nodes" ? "node" : "edge") &&
          record.field === field &&
          record.before === before &&
          record.after === after
      )
    );
  });
const preservesItems = (incoming, previous, view, key, seed) =>
  previous.models[view][key].every((item) => {
    const next = incoming.models[view][key].find(
      (candidate) => candidate.id === item.id
    );
    const removed = incoming.retired.find(
      (entry) =>
        entry.view === view &&
        entry.item.id === item.id &&
        entry.entity === (key === "nodes" ? "node" : "edge")
    );
    if (!next) {
      return Boolean(removed && canonical(removed.item) === canonical(item));
    }
    if (!preservesEvidence(item.data.evidence, next.data.evidence)) {
      return false;
    }
    const original = seed.models[view][key].find(
      (candidate) => candidate.id === item.id
    );
    if (
      view === "proposed" &&
      !preservesSemantics(incoming, item, next, original, key)
    ) {
      return false;
    }
    if (key !== "nodes") {
      return true;
    }
    // Preserve human layout and drillInto changes; AI may adjust either one
    // on nodes the human hasn't touched (drillInto is generation output,
    // not something a reviewer proposes, so it follows the layout rule).
    return [
      (n) => n.position,
      (n) => n.width,
      (n) => n.height,
      (n) => n.data.drillInto,
    ].every(
      (get) =>
        (original && canonical(get(original)) === canonical(get(item))) ||
        canonical(get(item)) === canonical(get(next))
    );
  });
const preservesReview = (incoming, saved) => {
  const previous = saved.document;
  let seed;
  try {
    seed = validateDocument(JSON.parse(saved.seed));
  } catch {
    return false;
  }
  return (
    incoming.repository.name === previous.repository.name &&
    incoming.repository.revision === previous.repository.revision &&
    previous.unresolved.every(
      (question) =>
        incoming.unresolved.includes(question) ||
        incoming.resolutions?.some((item) => item.question === question)
    ) &&
    ["resolutions", "editResolutions"].every((key) =>
      (previous[key] ?? []).every((item) =>
        incoming[key]?.some(
          (candidate) => canonical(item) === canonical(candidate)
        )
      )
    ) &&
    previous.comments.every((comment) =>
      incoming.comments.some(
        (candidate) => canonical(comment) === canonical(candidate)
      )
    ) &&
    previous.retired.every((entry) =>
      incoming.retired.some(
        (candidate) => canonical(entry) === canonical(candidate)
      )
    ) &&
    views.every((view) =>
      ["nodes", "edges"].every((key) =>
        preservesItems(incoming, previous, view, key, seed)
      )
    ) &&
    VERIFICATION_KEYS.every((key) =>
      verificationOf(previous)[key].every(
        (item) =>
          verificationOf(incoming)[key].some((next) => next.id === item.id) ||
          incoming.retired.some(
            (entry) =>
              entry.view === "verification" &&
              entry.entity === VERIFICATION_ENTITIES[key] &&
              canonical(entry.item) === canonical(item)
          )
      )
    )
  );
};
// History travels with copies/backups; a restore must not forget later revisions.
export const withRevisionHistory = (doc, ...previous) => ({
  ...doc,
  revisionHistory: [
    ...new Set(
      [doc, ...previous].flatMap((item) => [
        ...(item.revisionHistory ?? []),
        item.revision,
        item.basedOn?.revision,
      ])
    ),
  ].filter((revision) => revision && revision !== doc.revision),
});
export const reconcile = (incoming, saved) => {
  validateDocument(incoming);
  if (!saved) {
    return {
      conflict: false,
      document: withRevisionHistory(incoming),
      lastExport: null,
    };
  }
  validateDocument(saved.document);
  if (saved.document.sessionId !== incoming.sessionId) {
    throw new Error("別セッションの下書きです");
  }
  const sameSeed = saved.seed === signature(incoming);
  const acknowledged =
    incoming.basedOn &&
    incoming.revision !== saved.document.revision &&
    !withRevisionHistory(saved.document).revisionHistory.includes(
      incoming.revision
    ) &&
    incoming.basedOn.revision === saved.document.revision &&
    incoming.basedOn.exportId === saved.lastExport?.id &&
    saved.lastExport.signature === signature(saved.document);
  if (sameSeed) {
    return {
      conflict: false,
      document: saved.document,
      lastExport: saved.lastExport ?? null,
    };
  }
  if (acknowledged && preservesReview(incoming, saved)) {
    return {
      conflict: false,
      document: withRevisionHistory(incoming, saved.document),
      lastExport: null,
    };
  }
  return {
    conflict: true,
    document: saved.document,
    lastExport: saved.lastExport ?? null,
  };
};

export const editItem = (doc, view, entity, itemId, patch) => {
  need(
    views.includes(view) && ["node", "edge"].includes(entity),
    "編集対象が不正です"
  );
  const next = structuredClone(doc);
  const item = next.models[view][entity === "node" ? "nodes" : "edges"].find(
    (n) => n.id === itemId
  );
  need(item, "編集対象が見つかりません");
  const layoutKeys = new Set(["position", "width", "height"]);
  need(!Object.hasOwn(patch, "id"), "IDは変更できません");
  const semantic = Object.keys(patch).some((key) => !layoutKeys.has(key));
  need(
    view === "proposed" || !semantic,
    "現状の業務内容は指摘から再確認してください"
  );
  Object.assign(item, patch);
  if (semantic) {
    item.data = { ...item.data, origin: "proposal" };
    next.needsReview = true;
  }
  return validateDocument(next);
};

export const removeItem = (doc, entity, itemId) => {
  const next = structuredClone(doc);
  const graph = next.models.proposed;
  const nodes =
    entity === "node" ? graph.nodes.filter((n) => n.id === itemId) : [];
  const edges = graph.edges.filter(
    (e) =>
      e.id === itemId ||
      nodes.some((n) => n.id === e.source || n.id === e.target)
  );
  next.retired.push(
    ...nodes.map((item) => ({ entity: "node", item, view: "proposed" })),
    ...edges.map((item) => ({ entity: "edge", item, view: "proposed" }))
  );
  graph.nodes = graph.nodes.filter((n) => !nodes.includes(n));
  graph.edges = graph.edges.filter((e) => !edges.includes(e));
  // A survivor's drillInto may point into what was just removed (e.g. an
  // architecture node drilling into a deleted function-flow node).
  const removedIds = new Set(nodes.map((n) => n.id));
  for (const node of graph.nodes) {
    if (removedIds.has(node.data.drillInto)) {
      delete node.data.drillInto;
    }
  }
  next.needsReview = true;
  return validateDocument(next);
};

const md = (s) =>
  String(s)
    .replaceAll(/[\\`*_{}[\]()#+.!|>~<-]/gu, "\\$&")
    .replaceAll("\n", " ");
const mermaidText = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", " ");
export const toMermaid = (graph) => {
  // Use generated diagram IDs: user-provided IDs like "end" have Mermaid meaning.
  const ids = new Map(graph.nodes.map((n, i) => [n.id, `N${i}`]));
  return [
    "flowchart LR",
    ...graph.nodes.map(
      (n) => `  ${ids.get(n.id)}["${mermaidText(n.data.label)}"]`
    ),
    ...graph.edges.map(
      (e) =>
        `  ${ids.get(e.source)} -->|"${mermaidText(e.label).replaceAll("|", "&#124;")}"| ${ids.get(e.target)}`
    ),
  ].join("\n");
};
const refs = (items) =>
  items
    .map(
      (r) =>
        `- ${md(r.path)}${r.line ? `:${r.line}` : ""} / ${md(r.symbol)} @ ${md(r.revision)}`
    )
    .join("\n");
const clean = (s) => String(s).replaceAll(/[\r\n]/gu, " ");
const codeSpan = (s) => {
  const value = clean(s);
  const fence = "`".repeat(
    Math.max(0, ...[...value.matchAll(/`+/gu)].map((m) => m[0].length)) + 1
  );
  return `${fence} ${value} ${fence}`;
};
export const retiredLabel = (item) =>
  item.data?.label ?? item.label ?? item.statement ?? item.title ?? item.id;
// Rule targets may name retired elements (see elementIds).
export const elementName = (doc, view, elementId) =>
  retiredLabel(
    [...doc.models[view].nodes, ...doc.models[view].edges].find(
      (i) => i.id === elementId
    ) ??
      doc.retired.find((r) => r.view === view && r.item.id === elementId).item
  );
const elementLabel = (doc, view, elementId) =>
  `${md(elementName(doc, view, elementId))}（${md(elementId)}）`;
export const boundaryText = (boundary) =>
  `${BOUNDARIES[boundary.kind]}（${ORIGINS[boundary.origin]}${boundary.origin === "code" ? "" : "・構造は未確認"}）`;
const resultText = (result) =>
  [
    `検証結果: ${RESULTS[result.status]}`,
    ...(result.command
      ? [
          `実行コマンド: ${codeSpan(result.command)}`,
          `対象版: ${md(result.revision)}`,
          `出所: ${md(result.source)}`,
        ]
      : []),
  ].join("\n");
const verificationMarkdown = (doc) => {
  const { existingTests, rules, verificationCandidates } = verificationOf(doc);
  const testById = new Map(existingTests.map((t) => [t.id, t]));
  const testSection = (t) =>
    [
      `\n### 既存テスト: ${md(t.title)}`,
      `ID: ${md(t.id)}`,
      `検証の境界: ${boundaryText(t.boundary)}`,
      resultText(t.result),
      refs(t.evidence),
    ].join("\n");
  const candidateSection = (c) =>
    [
      `\n### 検証候補: ${md(c.title)}`,
      `ID: ${md(c.id)} / 判断: ${DECISIONS[c.decision]}`,
      ...(c.error ? [`検出したい誤り: ${md(c.error)}`] : []),
      ...(c.boundary ? [`検証の境界: ${boundaryText(c.boundary)}`] : []),
      ...(c.reason ? [`理由: ${md(c.reason)}`] : []),
      ...(c.tests ?? []).map(
        (testId) =>
          `対象の既存テスト: ${md(testById.get(testId).title)}（${md(testId)}）`
      ),
      refs(c.evidence),
    ].join("\n");
  const unassigned = verificationCandidates.filter((c) => !c.rule);
  return [
    "# 検証方針",
    "根拠と検証結果は別の区分です。根拠はコードで確認・業務上の合意・AIの推測・未検証の改善案を、検証結果はテストや形式モデルを実際にどう扱ったかを示します。テストを読んだことは、実行や合格を意味しません。",
    ...(rules.length ? [] : ["\n業務ルールは未登録です。"]),
    ...rules.flatMap((r) => [
      `\n## 業務ルール: ${md(r.statement)}`,
      `ID: ${md(r.id)} / ${RULE_KINDS[r.kind]} / ${VIEW_LABELS[r.model]} / ${ORIGINS[r.origin]}`,
      `関連要素: ${r.targets.map((t) => elementLabel(doc, r.model, t)).join("、")}`,
      refs(r.evidence),
      ...existingTests.filter((t) => t.rules.includes(r.id)).map(testSection),
      ...verificationCandidates
        .filter((c) => c.rule === r.id)
        .map(candidateSection),
    ]),
    ...(unassigned.length
      ? ["\n## 業務ルールが未定の検証候補", ...unassigned.map(candidateSection)]
      : []),
    "\n## 未確認事項",
    ...verificationCandidates
      .filter((c) => c.decision === "HOLD")
      .map((c) => `- 保留: ${md(c.title)}`),
    ...existingTests
      .filter((t) => ["READ", "NOT_RUN"].includes(t.result.status))
      .map(
        (t) => `- 実行結果なし: ${md(t.title)}（${RESULTS[t.result.status]}）`
      ),
    ...[...existingTests, ...verificationCandidates]
      .filter((item) => item.boundary && item.boundary.origin !== "code")
      .map(
        (item) =>
          `- 境界の構造が未確認: ${md(item.title)}（${BOUNDARIES[item.boundary.kind]}）`
      ),
  ].join("\n");
};
// A node's kind alone names its layer (see model.md).
const LAYER_ORDER = ["business", "architecture", "function-flow"];
const LAYER_LABELS = {
  architecture: "アーキテクチャ層",
  business: "業務フロー層",
  "function-flow": "関数フロー層",
};
const layerOf = (kind) => {
  if (ARCHITECTURE_KINDS.includes(kind)) {
    return "architecture";
  }
  if (FLOW_KINDS.includes(kind)) {
    return "function-flow";
  }
  return "business";
};
const byLayer = (graph) => {
  const layers = new Map(LAYER_ORDER.map((l) => [l, { edges: [], nodes: [] }]));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodeLayer = new Map();
  for (const node of graph.nodes) {
    const layer = layerOf(node.data.kind);
    nodeLayer.set(node.id, layer);
    layers.get(layer).nodes.push(node);
  }
  // Nothing forbids a schema-valid edge from spanning two layers; keep it
  // visible under its own heading rather than silently dropping it.
  const crossNodeIds = new Set();
  const crossEdges = [];
  for (const edge of graph.edges) {
    const layer = nodeLayer.get(edge.source);
    if (layer && layer === nodeLayer.get(edge.target)) {
      layers.get(layer).edges.push(edge);
    } else {
      crossEdges.push(edge);
      crossNodeIds.add(edge.source);
      crossNodeIds.add(edge.target);
    }
  }
  const cross = {
    edges: crossEdges,
    nodes: [...crossNodeIds]
      .map((nodeId) => nodeById.get(nodeId))
      .filter(Boolean),
  };
  return { cross, layers };
};
export const artifacts = (doc) => {
  const model = [
    `# ${md(doc.title)}`,
    `${md(doc.repository.name)} @ ${md(doc.repository.revision)}`,
    md(doc.scope),
  ];
  for (const view of views) {
    model.push(`\n## ${VIEW_LABELS[view]}`);
    const { cross, layers } = byLayer(doc.models[view]);
    for (const layer of LAYER_ORDER) {
      const graph = layers.get(layer);
      if (graph.nodes.length === 0) {
        continue;
      }
      model.push(
        `\n### ${LAYER_LABELS[layer]}`,
        "```mermaid",
        toMermaid(graph),
        "```"
      );
    }
    if (cross.edges.length > 0) {
      model.push("\n### 層をまたぐ関係", "```mermaid", toMermaid(cross), "```");
    }
    for (const item of [...doc.models[view].nodes, ...doc.models[view].edges]) {
      model.push(
        `\n### ${md(item.id)}: ${md(item.data.label ?? item.label)}`,
        ...(item.data.kind
          ? [
              `種別: ${item.data.kind}${item.data.drillInto ? ` / drillInto: ${item.data.drillInto}` : ""}`,
            ]
          : []),
        ORIGINS[item.data.origin],
        refs(item.data.evidence)
      );
    }
  }
  const { rules } = verificationOf(doc);
  model.push(
    "\n## 業務ルールと図の要素",
    ...rules.map(
      (r) =>
        `- ${md(r.id)}（${VIEW_LABELS[r.model]} / ${RULE_KINDS[r.kind]}）: ${md(r.statement)} → ${r.targets.map((t) => elementLabel(doc, r.model, t)).join("、")}`
    ),
    "\n## 指摘",
    ...doc.comments.map(
      (c) =>
        `- ${md(c.target.view)} / ${md(c.target.id ?? "全体")}: ${md(c.text)}`
    ),
    "\n## 削除記録",
    ...doc.retired.map(
      (r) =>
        `- ${md(r.view)} / ${md(r.item.id)}: ${md(retiredLabel(r.item))}`
    ),
    "\n## 未解決",
    ...doc.unresolved.map((s) => `- ${md(s)}`),
    "\n## 編集の解決記録",
    ...(doc.editResolutions ?? []).map(
      (item) =>
        `- proposed / ${md(item.entity)} / ${md(item.id)} / ${md(item.field)}: ${md(item.before)} → ${md(item.after)}\n${md(item.reason)}\n${refs(item.evidence)}`
    ),
    "\n## 解決記録",
    ...(doc.resolutions ?? []).map(
      (item) =>
        `\n### ${md(item.question)}\n${md(item.reason)}\n${refs(item.evidence)}`
    )
  );
  const glossary = [
    "# 用語辞書",
    ...doc.glossary.map(
      (t) =>
        `\n## ${md(t.term)}\n${t.status === "confirmed" ? "合意済み" : "草案"}\n\n${md(t.definition)}\n${refs(t.evidence)}`
    ),
  ].join("\n");
  const bdd = [
    `# レビュー用草案：テスト実行結果ではありません`,
    ...(doc.needsReview ? ["# モデル変更後の再確認待ち"] : []),
    `Feature: ${clean(doc.title)}`,
    ...doc.scenarios.map(
      (s) =>
        `\n  # ${s.model} / ${s.status}\n${s.evidence.map((r) => `  # ${clean(r.path)}:${r.line ?? ""} @ ${clean(r.revision)}`).join("\n")}\n  Scenario: ${clean(s.title)}\n${s.given.map((g, i) => `    ${i ? "And" : "Given"} ${clean(g)}`).join("\n")}\n    When ${clean(s.when)}\n${s.then.map((t, i) => `    ${i ? "And" : "Then"} ${clean(t)}`).join("\n")}`
    ),
  ].join("\n");
  const changes = [
    "# 実装変更候補",
    ...doc.changes.map(
      (c) =>
        `\n## ${md(c.title)}\n${c.status === "agreed" ? "合意済み・実装は別工程" : "提案・未実装"}\n\n${md(c.reason)}\n${refs(c.evidence)}`
    ),
  ].join("\n");
  const warning = doc.needsReview
    ? "> モデル変更後のためAIによる再確認が必要です。\n\n"
    : "";
  return {
    "changes.md": warning + changes,
    "glossary.md": warning + glossary,
    "model.md": model.join("\n"),
    "scenarios.feature": bdd,
    "verification.md": warning + verificationMarkdown(doc),
  };
};

export const feedback = (doc, exportId) => {
  const payload = {
    document: doc,
    exportId,
    format: "domain-studio-feedback-v1",
  };
  const json = JSON.stringify(payload, null, 2);
  const fence = "`".repeat(
    Math.max(3, ...[...json.matchAll(/`+/gu)].map((m) => m[0].length + 1))
  );
  return `# ドメインモデルのレビュー\nセッション: ${md(doc.sessionId)} / 版: ${md(doc.revision)}\n回答ID: ${exportId}\n\n指摘と改善案を再調査してください。現状はコードから再確認し、用語・BDD・変更候補・検証方針も整合させてください。更新版のbasedOnには、この版と回答IDを設定し、未解決事項と削除対象への指摘を保持してください。\n\n${doc.comments.map((c) => `- ${md(c.target.view)}/${md(c.target.id ?? "全体")}: ${md(c.text)}`).join("\n")}\n\n${fence}json\n${json}\n${fence}\n`;
};
