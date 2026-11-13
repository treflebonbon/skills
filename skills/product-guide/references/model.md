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
      "flow": [<claim>（任意で "group": ["外側の区分", "内側の区分"] を追加できる）],
      "conditions": [<claim>],
      "exceptions": [<claim>],
      "constraints": [<claim>],
      "actions": [<claim>]
    }
  ]
}
```

- 根拠の版の一致検査は、`commit` を書いた根拠だけが対象。`code-verified` は `commit` が必須なので常に検査されるが、他の区分は `commit` が任意で、書かなければ版の一致は検査されない。
- `summary` は現行の概要で、`proposed` の機能を現行として書かない（自由記述は検査できない）。`changes[].feature` が `proposed` の機能を指すとき、`removed` 以外（`added` / `changed` / `unchanged`）は拒否される。
- `evidence.kind` は `code-verified` / `approved-decision` / `inferred` / `unverified`。`code-verified` には `commit` と `path` が必須で、`commit` は対象版と一致する。
- `conflicts` のコード側は `code-verified`、業務判断側は `approved-decision` の根拠を含む。
- `flow` の各手順には、任意の `group`（業務区分の入れ子。外側から内側の順の文字列配列で、1 段以上、4 段まで）を付けられる。`group` を持つ手順が 1 件でもある `flow` は、ELK.js が区分の枠で囲んで配置した SVG 図になり、手順リストにも区分が文字で出る。`group` を持たない `flow`（既存のモデル）は従来どおり Dagre の単純な図になる。`group` は出力に渡る自由記述なので、`public` では他の自由記述と同じ検査を受け、実装詳細を書かない。入れ子が 4 段を超える等で配置できなければ、Dagre と同じく「図の配置に失敗」で失敗する。
- `flow` は番号付き手順リストと、同じ手順から Dagre で配置した SVG 図（文章説明付き）として表示する。1 件以上必要。手順が 30 件を超える等で配置できなければ、`generate` は「図の配置に失敗」で終了コード 1 になり、成果物を作らない（図を省いて生成しない）。
- `evidence.version` は `target`（既定）か `baseline`。`target` の根拠の `commit` は対象版、`baseline` は比較元と一致する。機能・矛盾の主張は対象版の根拠だけを参照できる。
- `baseline` と `changes` は両方あるか両方ないかのどちらか。`added` は対象版の根拠のみ、`removed` は比較元の根拠のみ、`changed` は両方、`unchanged` はどちらでもよい。
- `who`・`summary`・`action` は、人・エージェントが影響を調べて書く。コード差分やコミットメッセージだけで影響を断定しない。出力先は `<対象版>-vs-<比較元>-<audience>` になる。
- `operations` は利用者が画面と照合する公開操作名で、`evidence.symbol` は根拠としての内部コードシンボル。別の項目であり、`public` では `evidence` 全体が出力に渡らない。公開操作名にコードのシンボル名を書かない。
- `public` の自由記述（題名・要約・操作名・用語集・未確認事項・主張・矛盾）に、パス・シンボル・コミット ID・ADR／issue 番号・ブランチ名などの実装詳細を書かない。出力に渡る項目の走査は、登録済みの値（シンボルは識別子の境界で照合）と典型的な形（7〜40 桁の 16 進 ID、`ADR` の後の数字、`issue` の後の数字と `#数字`、`origin/`・`refs/heads/` のブランチ名、`.ts`・`.js`・`.mjs`・`.py`・`.md`・`.json`・`.tsx`・`.rs`・`.go`）による最後の安全網で、完全な保証ではない。`PR#75`・全角の `＃75`・`.jsx` などは検出できず、拡張子形式を含む通常の文章は誤検知される。詳細は `SKILL.md` の「保証の範囲」。
