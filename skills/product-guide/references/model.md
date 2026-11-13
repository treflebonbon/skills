# モデル仕様

未知の項目は、どの階層でも拒否される。`<claim>` は `{ "text": "...", "evidence": ["E1"] }` で、根拠を 1 件以上参照する。

```json
{
  "title": "利用ガイドの題名",
  "summary": "誰が何のために使うか",
  "target": { "commit": "<40 桁の小文字 16 進>", "versionName": "v1.2（任意）", "confirmedOn": "YYYY-MM-DD" },
  "baseline": { "commit": "<40 桁>", "versionName": "v1.1（任意）", "confirmedOn": "YYYY-MM-DD" },  // 任意。比較するときだけ
  "changes": [{ "feature": "…", "status": "added | changed | removed | unchanged", "who": "誰に", "summary": "何が変わるか", "action": "必要な対応", "evidence": ["E1", "B1"] }],
  "scope": { "investigated": ["調べた機能"], "notInvestigated": ["調べていない機能"] },
  "evidence": [
    { "id": "E1", "kind": "code-verified", "commit": "<対象版と同じ>", "path": "…", "symbol": "…（任意）", "note": "…（任意）" },
    { "id": "E2", "kind": "approved-decision", "note": "…" },
    { "id": "B1", "kind": "code-verified", "version": "baseline", "commit": "<比較元と同じ>", "path": "…" }
  ],
  "glossary": [{ "term": "…", "meaning": "…" }],
  "unconfirmed": ["確認できていない事項"],
  "conflicts": [{ "summary": "…", "code": <claim>, "decision": <claim> }],
  "features": [
    {
      "name": "…",
      "availability": "available | in-development | proposed | unknown（既定 unknown）",
      "purpose": "…",
      "operations": ["画面表示のままの操作名・選択肢・制限値"],
      "flow": [<claim>],
      "conditions": [<claim>],
      "exceptions": [<claim>],
      "constraints": [<claim>],
      "actions": [<claim>]
    }
  ]
}
```

- `evidence.kind` は `code-verified` / `approved-decision` / `inferred` / `unverified`。`code-verified` には `commit` と `path` が必須で、`commit` は対象版と一致する。
- `conflicts` のコード側は `code-verified`、業務判断側は `approved-decision` の根拠を含む。
- `flow` は初版では番号付き手順リストとして表示する。1 件以上必要。
- `evidence.version` は `target`（既定）か `baseline`。`target` の根拠の `commit` は対象版、`baseline` は比較元と一致する。機能・矛盾の主張は対象版の根拠だけを参照できる。
- `baseline` と `changes` は両方あるか両方ないかのどちらか。`added` は対象版の根拠のみ、`removed` は比較元の根拠のみ、`changed` は両方、`unchanged` はどちらでもよい。
- `who`・`summary`・`action` は、人・エージェントが影響を調べて書く。コード差分やコミットメッセージだけで影響を断定しない。出力先は `<対象版>-vs-<比較元>-<audience>` になる。
