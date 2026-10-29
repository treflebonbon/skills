# Model contract (schemaVersion 2)

The JSON document is the editable model, not raw React Flow props. The UI projects whitelisted fields into the graph: supplied HTML, styles and callbacks never execute. See `tests/fixture.mjs` for a minimal fictional example and `src/model.mjs` for the executable validator.

```json
{
  "schemaVersion": 2,
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
  "unresolved": []
}
```

IDs (`sessionId`, `revision`, nodes, edges, comments, scenarios, changes) start with an ASCII letter/digit, followed by up to 99 letters/digits/underscores/hyphens. Node and edge IDs share a namespace per model. Reuse IDs across current/proposed for the same concept. Names are Japanese business vocabulary; IDs are opaque identity.

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

Comment: `{ "id": "c1", "target": { "view": "proposed", "id": "request" }, "text": "再発行時は旧依頼が失効する" }`. `view` is `current`, `proposed`, or `whole`; `whole` omits `id`. Preserve the view on comments even when both models share a node ID.

Retired record: `{ "view": "proposed", "entity": "node", "item": <complete removed node> }`; use `entity: "edge"` for edges. Keep associated comments. Restoring through Undo restores the document snapshot.

Glossary entry: `{ "term": "依頼", "definition": "業務上の意味", "status": "draft", "evidence": [] }`. `confirmed` means the vocabulary has been agreed or comes from the existing authoritative glossary; it does not mean proposed behavior already exists in code.

Scenario: `{ "id": "expiry", "title": "満了した依頼を拒否する", "model": "current", "status": "draft", "given": ["依頼が満了した"], "when": "受諾する", "then": ["拒否される"], "evidence": [] }`. `model` is current/proposed, status is confirmed/draft; confirmed requires evidence. Confirmed describes source-grounded scenario content, not an executed passing test. Use concrete boundaries and known exceptions. Mark unknowns explicitly; never synthesize an imaginary failure event.

Change candidate: `{ "id": "clarify-expiry", "title": "期限の案内を改善する", "reason": "合意した変更理由と検討事項", "status": "proposed", "evidence": [] }`. `status` is proposed/agreed. Evidence lists affected source locations. Changes are not implemented by the modeling skill.

`unresolved` is an array of plain, nonempty question strings, not objects; the structured `{question, reason, evidence}` shape below belongs to `resolutions` only, once a question is answered. Keep contradicting code/business explanations visible until resolved. An update must retain each prior question verbatim or provide an explicit entry in optional `resolutions`: `{ "question": "元の質問と完全一致", "reason": "確認した回答・解決理由。人間の合意と実装の証拠を区別する", "evidence": [] }`. Both question and reason must be nonempty. Preserve earlier resolution entries in subsequent rounds; these records also appear in `model.md`. A renamed question must retain the original question in its resolution record, rather than silently replacing history.

# Revision protocol

The copied Markdown contains `{ "format": "domain-studio-feedback-v1", "exportId": "unique-id", "document": <edited document> }`. A new agent-produced document increments `revision` and sets `basedOn` to the received document's revision and exportId. These identify the exact submitted content, not just the session. A new revision must never reuse a revision previously used in the session. Preserve optional `revisionHistory` (an array of unique revision IDs) from the submitted document and add the submitted current revision before publishing the update. The browser accumulates this history across imports and backup restores, even if an incoming update omits it. Both `repository.name` and the pinned `repository.revision` must match the submitted document. A source rebase is not an ordinary AI update: retain the existing session and its backups, explicitly agree on the new source baseline with the human, then start a separate session and re-investigate its evidence. Do not bypass the conflict by changing export IDs. Imports that omit comments, retired records, prior evidence, or existing IDs without complete retirement records are held as conflicts. Preserve human-changed proposed node labels/kinds and edge labels/endpoints. The browser compares submitted content with the original seed, including human-created elements. To intentionally supersede such an edit, include an explicit `editResolutions` entry: `{ "id": "request", "entity": "node", "field": "label", "before": "人間の名称", "after": "再調査後の名称", "reason": "訂正理由と人間の合意・実装の根拠の区別", "evidence": [] }`. `entity` is node/edge; allowed fields are label/kind for nodes and label/source/target for edges. The target and before/after values must match the actual change. Preserve earlier entries; `model.md` includes these records. Preserve human-changed geometry; the agent can arrange newly added or untouched nodes. Keep conflicting historical citations with an explanation in the unresolved record rather than silently erasing them.

The browser stores the seed document, editable draft, and last copied document signature. It adopts an AI update automatically only when the submitted export matches the current draft and revision. Otherwise it protects the draft and exposes the pending update separately for recovery. A fresh export is necessary after additional edits. If local storage is unavailable, retain JSON backups and use the existing open page's import action for the guarded update; opening a new file alone cannot discover an unavailable browser draft.

The generator writes new files only. Four outputs are `model.md` (a per-layer Mermaid diagram for each layer present, a further "層をまたぐ関係" diagram for any edge whose endpoints fall in different layers so it stays visible rather than silently dropped, plus each node's kind and `drillInto`, and every node's/edge's origin and evidence), `glossary.md`, `scenarios.feature`, `changes.md`. All four deliverables draw from every layer present in the model, not only the business flow. The artifacts must be regenerated after AI review of semantic changes; `needsReview` flags pre-review derived content. Mermaid is an output view, not a lossless editing format.
