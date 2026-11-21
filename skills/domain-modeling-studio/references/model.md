# Model contract (schemaVersion 4)

The JSON document is the editable model, not raw React Flow props. The UI projects whitelisted fields into the graph: supplied HTML, styles and callbacks never execute. See `tests/fixture.mjs` for a minimal fictional example and `src/model.mjs` for the executable validator.

```json
{
  "schemaVersion": 4,
  "sessionId": "project-flow-unique-session",
  "revision": "r1",
  "basedOn": null,
  "title": "業務フローのレビュー",
  "repository": {
    "name": "owner/repo",
    "revision": "0000000000000000000000000000000000000000"
  },
  "scope": "検証対象の開始点と終了点",
  "needsReview": false,
  "models": {
    "current": { "nodes": [], "edges": [] },
    "proposed": { "nodes": [], "edges": [] }
  },
  "comments": [],
  "retired": [],
  "glossary": [],
  "scenarios": [],
  "changes": [],
  "unresolved": [],
  "rules": [],
  "existingTests": [],
  "verificationCandidates": []
}
```

A schemaVersion 2 document omits the three verification arrays and still opens; it reads as having no verification records. A schemaVersion 3 document opens as one without the schemaVersion 4 fields (scenario `rules`, candidate `method`/`property`/`plan`, existing test `method`, result `seed`/`counterexample`/`scope`); a schemaVersion 2 or 3 document carrying any of them is rejected as needing schemaVersion 4, and an older template rejects a schemaVersion 4 document, so no field round-trips undisplayed. IDs (`sessionId`, `revision`, nodes, edges, comments, scenarios, changes, rules, existing tests, verification candidates) start with an ASCII letter/digit, followed by up to 99 letters/digits/underscores/hyphens. Node and edge IDs share a namespace per model. Reuse IDs across current/proposed for the same concept. Names are Japanese business vocabulary; IDs are opaque identity.

Evidence: `{ "path": "src/orders.ts", "symbol": "confirmOrder", "revision": "0000000000000000000000000000000000000000", "line": 42 }`. Repository and evidence revisions must be complete 40- or 64-character hexadecimal Git commit IDs (case-insensitive), never branch names, `HEAD`, or abbreviations. The all-zero examples are fictional: replace them with inspected commit IDs. `line` is optional; use an exact line only after inspection. Paths are repository-relative. A reference establishes only what was inspected at that version, not a guarantee that a changed proposal is implemented.

Node:

```json
{
  "id": "request",
  "position": { "x": 40, "y": 80 },
  "width": 200,
  "height": 100,
  "data": {
    "label": "依頼を発行する",
    "kind": "COMMAND",
    "origin": "inference",
    "evidence": []
  }
}
```

`kind`: business flow — `COMMAND`, `EVENT`, `POLICY`, `READ_MODEL`, `AGGREGATE`, `ACTOR`, `PROCESS`; architecture layer — `MODULE`, `EXTERNAL`; function-flow layer — `STAGE`, `FAILURE_HANDLER`, `RECOVERY`, `BYPASS`, `TERMINATION`, `OUTSIDE_TYPED_ERROR` (ROP semantics: see [rop-semantics.md](rop-semantics.md)). All three layers share the same `nodes`/`edges` arrays per view; `kind` alone determines which layer a node belongs to. Do not infer kinds from keyword matching. Width ≥100, height ≥60; finite coordinates. Place a small flow left-to-right and separate exception paths vertically.

`drillInto` (optional, on nodes only): an architecture node's `drillInto` names a node ID inside its function-flow layer; a function-flow node's `drillInto` names the business-flow node ID it implements or affects. The target must exist in the same view and belong to the expected layer. Business-flow nodes do not carry `drillInto`. Not every node needs one.

`origin`: `code` (inspected implementation, requires evidence), `inference` (AI deduction), `agreement` (human business decision), `proposal` (unverified change). Editing business content sets `proposal` and `needsReview`; moving a node does not change its provenance. Preserve original references as context, not evidence for new semantics. This discipline, and the ID rules above, apply identically across all three layers.

Edge: `{ "id": "e1", "source": "request", "target": "accepted", "label": "期限内", "data": { "origin": "inference", "evidence": [] } }`. Both endpoints must exist. Record evidence on relationships as well as nodes.

Comment: `{ "id": "c1", "target": { "view": "proposed", "id": "request" }, "text": "再発行時は旧依頼が失効する" }`. `view` is `current`, `proposed`, `verification` (a rule, existing test or verification candidate ID), or `whole`; `whole` omits `id`. Preserve the view on comments even when both models share a node ID.

Retired record: `{ "view": "proposed", "entity": "node", "item": <complete removed node> }`; use `entity: "edge"` for edges, and `view: "verification"` with `entity` `rule`, `existingTest` or `verificationCandidate` for a removed verification record. Keep associated comments. Restoring through Undo restores the document snapshot.

Glossary entry: `{ "term": "依頼", "definition": "業務上の意味", "status": "draft", "evidence": [] }`. `confirmed` means the vocabulary has been agreed or comes from the existing authoritative glossary; it does not mean proposed behavior already exists in code.

Scenario: `{ "id": "expiry", "title": "満了した依頼を拒否する", "model": "current", "status": "draft", "given": ["依頼が満了した"], "when": "受諾する", "then": ["拒否される"], "evidence": [] }`. `model` is current/proposed, status is confirmed/draft; confirmed requires evidence. Confirmed describes source-grounded scenario content, not an executed passing test. Use concrete boundaries and known exceptions. Mark unknowns explicitly; never synthesize an imaginary failure event. Optional `rules` (schemaVersion 4) lists the rule IDs the scenario is a representative example of: a `current` scenario names current rules only, a `proposed` scenario current or proposed ones. `scenarios.feature` writes `# 業務ルール: <id>` above each such scenario, and `verification.md` and the **検証** tab list it under each rule.

Change candidate: `{ "id": "clarify-expiry", "title": "期限の案内を改善する", "reason": "合意した変更理由と検討事項", "status": "proposed", "evidence": [] }`. `status` is proposed/agreed. Evidence lists affected source locations. Changes are not implemented by the modeling skill.

## Verification (schemaVersion 4)

Rule, existing test and verification candidate IDs share one namespace. A record's `origin` says where a claim comes from; a verification result says what actually happened to a test or formal model. Keep the two separate.

Rule: `{ "id": "accept-once", "kind": "INVARIANT", "statement": "受諾済みの依頼は再受諾できない", "model": "current", "origin": "code", "evidence": [], "targets": ["accept"] }`. `kind` is `RULE`, `INVARIANT` or `TRANSITION`. `targets` lists at least one node or edge ID of the same view, live or retired.

Existing test: `{ "id": "accept-once-test", "title": "再受諾を拒否するテスト", "evidence": [<test location>], "rules": ["accept-once"], "boundary": { "kind": "DOMAIN", "origin": "code", "evidence": [] }, "result": { "status": "READ" } }`. `evidence` holds at least one test location. `rules` names current rules only; a proposed rule has candidates, never existing tests. Boundary `kind` is `DOMAIN`, `PORT_CONTRACT`, `ADAPTER_INTEGRATION`, `SLICE` or `FUNCTION`; anything but `origin: code` displays as an unconfirmed structure. Result `status` is `READ`, `NOT_RUN`, `PASSED`, `FAILED`, `SKIPPED`, `MODEL_NO_COUNTEREXAMPLE` or `MODEL_COUNTEREXAMPLE`; every status except `READ` and `NOT_RUN` requires `command`, a full commit `revision`, and `source` (who ran it, e.g. a user-approved session run or CI). An actual run may also record a nonempty `scope`: the range it actually explored, displayed as 実際に探索した範囲 apart from a plan's intended `scope`.

Verification candidate: `{ "id": "accept-race", "title": "同時受諾の二重成功を検出する", "decision": "ADD", "rule": "accept-once", "tests": [], "error": "検出したい誤り", "boundary": { "kind": "ADAPTER_INTEGRATION", "origin": "inference", "evidence": [] }, "reason": "既存テストでは足りない理由", "evidence": [] }`. `decision` is `ADD`, `KEEP`, `MERGE`, `DELETE`, `HOLD` or `DECLINE`. Every decision but `HOLD` and `DECLINE` requires `error`, `rule`, `boundary`, `reason`, and at least one `evidence` reference supporting the reason; a `HOLD` may omit them. A `DECLINE` (不採用) records a method considered and found unnecessary: it requires `method`, an existing `rule` and `reason`, while `evidence` stays an array that may be empty; it needs no `error`, `boundary`, `plan` or `property`. Only methods actually considered are declined; a method with no record has not been considered. `KEEP`, `MERGE` and `DELETE` list the affected existing tests, and each of those tests must keep the candidate's rule.

Verification method (schemaVersion 4): a candidate or existing test may carry `method`: `PROPERTY` (property-based testing), `MBT` (model-based testing), `QUINT`, `ALLOY` or `MUTATION` (mutation testing); any other value is rejected, including TIA, which is not a method (see below). A candidate without `method` is a proposal whose method is undecided. A `PROPERTY` candidate requires `property`, even under `HOLD` (not under `DECLINE`); only a `PROPERTY` candidate carries `property`. `property`: `{ "statement": "入力が変わっても成り立つ性質", "preconditions": ["事前条件"], "inputs": ["入力ごとの生成範囲"], "observation": "観測する結果", "origin": "inference", "evidence": [] }`, natural business language rather than generator code. `preconditions` and `inputs` hold at least one nonempty string; `origin`/`evidence` follow the usual provenance rule. Only `origin: agreement` displays as 合意済みの性質; `code`, `inference` and `proposal` display as 未合意の性質 and also appear under 未確認事項. An existing test keeps only `method`; the property itself lives on candidates. A result may record nonempty `seed` and `counterexample` (the shrunk counterexample) for an actual run only, never with `READ` or `NOT_RUN`; a `PROPERTY` test whose result is `FAILED` requires `counterexample`.

Plan: an `MBT`, `QUINT`, `ALLOY` or `MUTATION` candidate requires `plan`, even under `HOLD` (not under `DECLINE`); only those methods carry one. `{ "target": "対象の状態・操作・関係・実装箇所", "expectedEvidence": "何が観測できれば確かめたことになるか", "limits": "保証しないこと", "origin": "inference", "evidence": [] }`, all natural business language. `MBT` adds `mapping` (how model operations and observations map to the implementation's) and `coverage` (a coverage goal chosen from risk and the transitions in scope, never every path). `ALLOY` adds `scope` (search bounds and constraints), displayed as 計画時の探索範囲. `QUINT` adds nothing, but its `limits` states that the result is no proof of the implementation. A `MUTATION` candidate other than `HOLD`/`DECLINE` lists at least one existing test in `tests` (keeping its rule, as above); with no such test yet, as for a proposed rule, it is a `HOLD` explaining why. Its `expectedEvidence` states how surviving mutants split into missing tests, equivalent mutants and out of scope, and on what grounds. `limits` always displays as 保証しないこと.

Formal-model results: only an existing test with explicit `method` `QUINT` or `ALLOY` requires `counterexample` for `MODEL_COUNTEREXAMPLE`, and only `ALLOY` requires `result.scope` for `MODEL_NO_COUNTEREXAMPLE`. A test without `method` keeps accepting a bare `MODEL_*` result, and `MODEL_*` is not limited to formal-model methods. Record a repository `.qnt`/`.als` model as such an existing test only once it maps to a current rule.

### Test impact analysis (TIA)

TIA selects which tests run first on a change; it is neither a method nor a record in the model, and it reaches the target project only as a proposal. `verification.md` notes that exclusion from TIA is no reason to merge or delete whenever a `MERGE` or `DELETE` candidate exists. Fixed examples:

- Adopt: the target project's CI runs a long suite on every change, and its build tool already exposes static module dependencies. Propose running the tests depending on the changed modules first, stating that static dependencies miss runtime-loaded resources, and run the full suite for changes to configuration, the lockfile or shared infrastructure, or whenever the impact is unknown.
- Unnecessary: the whole suite already finishes in under a minute on every change. Selection would save little while risking missed tests, so propose nothing beyond running everything.
- Not run: no selection has ever been executed in this session. Report no TIA result, and never treat a test as covered, redundant or removable because a selection would or would not pick it.

An AI update keeps every prior rule, existing test and candidate ID, or moves the record into `retired`; a silently missing record is held as a conflict. Record content may be regenerated under the same ID.

## Open questions and resolutions

`unresolved` is an array of plain, nonempty question strings, not objects; the structured `{question, reason, evidence}` shape below belongs to `resolutions` only, once a question is answered. Keep contradicting code/business explanations visible until resolved. An update must retain each prior question verbatim or provide an explicit entry in optional `resolutions`: `{ "question": "元の質問と完全一致", "reason": "確認した回答・解決理由。人間の合意と実装の証拠を区別する", "evidence": [] }`. Both question and reason must be nonempty. Preserve earlier resolution entries in subsequent rounds; these records also appear in `model.md`. A renamed question must retain the original question in its resolution record, rather than silently replacing history.

# Revision protocol

The copied Markdown contains `{ "format": "domain-studio-feedback-v1", "exportId": "unique-id", "document": <edited document> }`. A new agent-produced document increments `revision` and sets `basedOn` to the received document's revision and exportId. These identify the exact submitted content, not just the session. A new revision must never reuse a revision previously used in the session. Preserve optional `revisionHistory` (an array of unique revision IDs) from the submitted document and add the submitted current revision before publishing the update. The browser accumulates this history across imports and backup restores, even if an incoming update omits it. Both `repository.name` and the pinned `repository.revision` must match the submitted document. A source rebase is not an ordinary AI update: retain the existing session and its backups, explicitly agree on the new source baseline with the human, then start a separate session and re-investigate its evidence. Do not bypass the conflict by changing export IDs. Imports that omit comments, retired records, prior evidence, or existing IDs without complete retirement records are held as conflicts. Preserve human-changed proposed node labels/kinds and edge labels/endpoints. The browser compares submitted content with the original seed, including human-created elements. To intentionally supersede such an edit, include an explicit `editResolutions` entry: `{ "id": "request", "entity": "node", "field": "label", "before": "人間の名称", "after": "再調査後の名称", "reason": "訂正理由と人間の合意・実装の根拠の区別", "evidence": [] }`. `entity` is node/edge; allowed fields are label/kind for nodes and label/source/target for edges. The target and before/after values must match the actual change. Preserve earlier entries; `model.md` includes these records. Preserve human-changed geometry; the agent can arrange newly added or untouched nodes. Keep conflicting historical citations with an explanation in the unresolved record rather than silently erasing them.

The browser stores the seed document, editable draft, and last copied document signature. It adopts an AI update automatically only when the submitted export matches the current draft and revision. Otherwise it protects the draft and exposes the pending update separately for recovery. A fresh export is necessary after additional edits. If local storage is unavailable, retain JSON backups and use the existing open page's import action for the guarded update; opening a new file alone cannot discover an unavailable browser draft.

The generator writes new files only. Five outputs are `model.md` (a per-layer Mermaid diagram for each layer present, a further "層をまたぐ関係" diagram for any edge whose endpoints fall in different layers so it stays visible rather than silently dropped, plus each node's kind and `drillInto`, every node's/edge's origin and evidence, and each rule's mapped elements), `glossary.md`, `scenarios.feature`, `changes.md`, `verification.md` (each rule with its representative examples, existing tests with their method, explored scope and counterexample, candidates grouped by method with properties and their agreement or plans and what they do not guarantee, the declined methods with reasons, boundaries, results with seeds, and remaining unknowns). All five deliverables draw from every layer present in the model, not only the business flow. The artifacts must be regenerated after AI review of semantic changes; `needsReview` flags pre-review derived content. Mermaid is an output view, not a lossless editing format.
