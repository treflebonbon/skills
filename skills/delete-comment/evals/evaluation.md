# コメント抽出時の構文回復を評価する

リポジトリのルートで `eval_case` に `parser-recovery` または `zero-comments` を指定し、対象の fixture を一時ディレクトリにコピーして Git の追跡対象にする。

```sh
eval_case=parser-recovery
mkdir -p -m 700 /tmp/codex &&
  fixture=$(mktemp -d /tmp/codex/delete-comment-eval.XXXXXX) &&
  cp -R "skills/delete-comment/evals/files/$eval_case/src" "$fixture/" &&
  (
    cd "$fixture" &&
    git init --quiet --initial-branch=fixture &&
    git add -- src &&
    git -c user.name='Eval Fixture' -c user.email='fixture@example.invalid' commit -qm 'test: seed comment audit fixture'
  )
```

準備が成功したら、`$fixture` を作業ディレクトリとして、実行役に [evals.json](evals.json) から `name` が一致するケースの `prompt` を渡す。採点時に `assertions` を使い、必須条件がすべて満たされれば合格とする。読み取り専用の条件は実行前後の `git rev-parse HEAD` と `git status --porcelain` で確認する。

### `parser-recovery`

| ファイル    | 対応する grammar | Tree-sitter の構文状態 | 検出済みコメント |
| ----------- | ---------------- | ---------------------- | ---------------: |
| `format.ts` | TypeScript       | 正常                   |              1件 |
| `limit.ts`  | TypeScript       | `ERROR` ノードあり     |              1件 |
| `status.ts` | TypeScript       | 欠落トークンのみ       |              1件 |
| `badge.tsx` | TSX              | 欠落トークンのみ       |              1件 |

### `zero-comments`

| ファイル    | 対応する grammar | Tree-sitter の構文状態 | 件数の判定          |
| ----------- | ---------------- | ---------------------- | ------------------- |
| `label.tsx` | TSX              | 正常                   | 確定0件             |
| `status.js` | JavaScript       | 欠落トークンのみ       | 検出0件・総数未確定 |
