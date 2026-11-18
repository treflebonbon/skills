# PR への画像添付

既存画像の添付には GitHub CLI の通常の認証と対象 repository への push 権限が必要です。`gh auth status` で認証を、`gh pr edit --help` と `gh pr comment --help` で `--attach` の対応を確認します。[GitHub CLI の公式手順](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli)

## コメントへの添付

既存 PR に画像と短い説明を一つのコメントとして投稿する場合は、[`pr-screenshots`](../skills/pr-screenshots/SKILL.md) を明示的に呼び出します。同じ依頼の照会では、同じ画像・原稿・request ID と receipt の保存先を使います。以前に `BROWSER_OWNERSHIP_DIR` を設定した場合は同じ値を引き継ぎます。

## 本文への添付

末尾へ追加するときは、既存の PR を指定して `--attach` を渡します。複数画像には `--attach` を繰り返します。

```sh
gh pr edit NUMBER --repo OWNER/REPO --attach './after.png#変更後の画面'
```

掲載位置を指定するときは、最新の本文から原稿を作ります。`pr-body.md` は新規の作業ファイルにします。

```sh
gh pr view NUMBER --repo OWNER/REPO --json body --jq .body >pr-body.md
```

`pr-body.md` の掲載箇所に通常の Markdown 画像参照 `![変更後の画面](./after.png)` を置きます。送信直前に `gh pr view NUMBER --repo OWNER/REPO --json body --jq .body` で最新の本文を再確認します。並行編集があれば取り込んだうえで、原稿に書いた画像と同じパスを `--attach` へ渡します。

```sh
gh pr edit NUMBER --repo OWNER/REPO --body-file pr-body.md --attach ./after.png
```

GitHub CLI が参照先をGitHub 上の添付 URL に置き換えます。一部の画像だけで本文が更新される場合があるため、実行後は本文を読み直して掲載を確認します。本文の編集は直接実行する操作です。結果が不明なときは、本文の状態を確認してから追加編集を判断します。コメント用 CLI の request ID による重複防止はコメント依頼に適用されます。

## 旧版からの移行

1. 旧版の処理が終わってから、起動中の添付専用ブラウザを、起動元と同じ旧版・同じ所有権ディレクトリの `browser-attachments close` で閉じます。競合や停止未確認で失敗した場合は、旧版のエラーが示す identity の `status` を確認し、Chrome の停止を確認してから旧版の `recover` を使います。
2. 旧 profile・所有権データ・画像・原稿・receipt は保存します。未完了や結果不明の旧本文添付は、対象 PR の現在の本文と保存済み receipt を照合します。アップロード済み URL を確認できた場合は掲載の有無を確認し、必要ならその URL を原稿へ手動で反映します。結果を確認できない場合は証跡を保持して判断を待ちます。
3. これ以降の本文編集には上の `gh pr edit` を使います。旧 placeholder を含む原稿は、最新の本文を基に通常の Markdown 画像参照へ直します。旧添付依頼を移行の一部として自動再送する処理はありません。

WSL2 で撮影に切り替える場合は、[撮影用 runtime の確認手順](../packages/wsl2-browser/USAGE.md#準備)を参照してください。package の lock 更新で固定 runtime の cache path が変わるため、旧 cache を保持したまま現行版の runtime を準備します。
