# モデル仕様

未知の項目は、どの階層でも拒否される。`<claim>` は `{ "text": "...", "evidence": ["E1"] }` で、根拠を 1 件以上参照する。

```json
{
  "title": "利用ガイドの題名",
  "summary": "誰が何のために使うか",
  "target": { "commit": "<40 桁の小文字 16 進>", "versionName": "v1.2（任意）", "confirmedOn": "YYYY-MM-DD" },
  "scope": { "investigated": ["調べた機能"], "notInvestigated": ["調べていない機能"] },
  "evidence": [
    { "id": "E1", "kind": "code-verified", "commit": "<対象版と同じ>", "path": "…", "symbol": "…（任意）", "note": "…（任意）" },
    { "id": "E2", "kind": "approved-decision", "note": "…" }
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
- `operations` は利用者が画面と照合する公開操作名で、`evidence.symbol` は根拠としての内部コードシンボル。別の項目であり、`public` では `evidence` 全体が出力に渡らない。公開操作名にコードのシンボル名を書かない。
- `public` の自由記述（題名・要約・操作名・用語集・未確認事項・主張・矛盾）に、パス・シンボル・コミット ID・ADR／issue 番号・ブランチ名などの実装詳細を書かない。出力に渡る項目の走査は正規表現と登録済みの値による最後の安全網で、完全な保証ではない。拡張子形式を含む通常の文章は誤検知される。
