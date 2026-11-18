# pr-screenshots の依存と対応環境

## 実行時

| 機能 | 必要なもの |
| --- | --- |
| 既存画像のコメント添付 | GitHub CLI `gh`（`pr comment --attach` 対応版）、通常の認証、対象 repository への push 権限、Node.js 20.19 以降、`flock`（Linux / WSL2 では util-linux） |
| 新しい画像の撮影 | 第三者配布元の `playwright-cli` skill と同梱の撮影 CLI。WSL2 では mirrored networking、Windows interoperability、`wslinfo`、`powershell.exe`、`wslpath`、Windows Stable Chrome と固定 Playwright runtime |

既存画像のコメント添付には、同梱の `scripts/pr-screenshots-comment.mjs` を使います。Nix は不要です。撮影先のサイトで認証が必要な場合は、[撮影用 profile の手動認証手順](../../packages/wsl2-browser/references/playwright-cli-wsl.md#対応範囲と認証)を参照してください。

GitHub CLI は [2.102.0](https://github.com/cli/cli/releases/tag/v2.102.0) で対応を確認しています。`gh pr comment --help` に `--attach` があることを確認し、表示されなければ対応版へ更新します。添付 CLI も投稿前にこの機能を検査するため、未対応版で停止した依頼は更新後に同じ request ID で再試行できます。`--attach` の仕様は [GitHub 公式ドキュメント](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli)を参照します。

## 撮影の準備

実際に読み込まれた `SKILL.md` の directory を `SKILL_ROOT` とし、撮影 CLI の絶対 path と固定 runtime の状態を確認します。

```bash
PLAYWRIGHT_CLI="$("$SKILL_ROOT/scripts/browser-tool-path" playwright-cli)"
BROWSER_PREPARE="$("$SKILL_ROOT/scripts/browser-tool-path" wsl2-browser-prepare)"
"$BROWSER_PREPARE" --check
```

`--check` は準備済み runtime の整合性を確認します。未準備や不一致では失敗し、依存を導入・変更しません。引数なしの `wsl2-browser-prepare` は Node.js と npm で固定 runtime を plugin root の外へ準備します。初回準備は [package の手順](../../packages/wsl2-browser/USAGE.md)に従います。

## テスト

回帰 suite は Bats Core 1.x、Node.js 20.19 以降、`jq` を使います。Bats と `jq` は回帰検証だけに必要です。`bats skills/pr-screenshots/tests/comment.bats` は使い捨て directory の中だけで動作し、実 PR への書き込みや実 browser 認証は行いません。
