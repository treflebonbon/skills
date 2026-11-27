# コメント抽出時の構文回復を評価する

リポジトリのルートで fixture を一時ディレクトリにコピーし、Git の追跡対象にする。

```sh
fixture=$(mktemp -d /tmp/codex/delete-comment-eval.XXXXXX) &&
  cp -R skills/delete-comment/evals/files/parser-recovery/src "$fixture/" &&
  (
    cd "$fixture" &&
    git init --quiet --initial-branch=fixture &&
    git add -- src &&
    git -c user.name='Eval Fixture' -c user.email='fixture@example.invalid' commit -qm 'test: seed comment audit fixture'
  )
```

準備が成功したら、`$fixture` を作業ディレクトリとして、実行役に [evals.json](evals.json) の `prompt` を渡す。採点時に `assertions` を使い、必須条件がすべて満たされれば合格とする。読み取り専用の条件は実行前後の `git rev-parse HEAD` と `git status --porcelain` で確認する。

| ファイル    | 対応する grammar | Tree-sitter の構文状態 | 検出済みコメント |
| ----------- | ---------------- | ---------------------- | ---------------: |
| `format.ts` | TypeScript       | 正常                   |              1件 |
| `limit.ts`  | TypeScript       | `ERROR` ノードあり     |              1件 |
| `status.ts` | TypeScript       | 欠落トークンのみ       |              1件 |
| `badge.tsx` | TSX              | 欠落トークンのみ       |              1件 |
