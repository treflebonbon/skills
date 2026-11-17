# pr-screenshots の依存と対応環境

## 実行時

| 機能                      | 必要なもの                                                                                                                                                                                                               | 条件を満たさない場合                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| PR とコメントの確認・投稿 | GitHub CLI `gh`（`pr comment --attach` 対応版）、通常の認証、対象 repository への push 権限                                                                                                                                                        | `gh auth status` と権限を案内し、画像・原稿を保持する。token を表示する `gh auth token` は使わない          |
| コメント添付 CLI          | Node.js 20.19 以降、`flock`、この plugin の `packages/wsl2-browser/bin/browser-attachments`                                                                                                                              | package の [入口](../../packages/wsl2-browser/USAGE.md#入口)を確認する。Nix と添付用 browser runtime は不要 |
| 既存画像の添付            | 通常の Markdown 画像参照と `gh pr comment --attach`                                                                                                                                                                      | 原稿と画像を保持し、不足条件を案内する。browser 経路へ自動で切り替えない                                    |
| 新しい画像の撮影          | 第三者配布元の `playwright-cli` skill、package 内 `bin/playwright-cli`。WSL2 では mirrored networking、Windows interoperability、`wslinfo`、`powershell.exe`、`wslpath`、Windows Stable Chrome と固定 Playwright runtime | 撮影が必要な場合だけ package の準備を案内する。既存画像を使える場合は撮影を追加しない                       |

既存画像をコメントへ添付するには Nix は不要です。撮影時に必要な browser 認証は利用者が手動で設定します。GitHub CLI の認証と browser の手動認証は別の仕組みです。コメント添付は GitHub CLI の認証だけを使い、専用 browser profile の認証を読みません。撮影には browser runtime が必要になる場合がありますが、既存画像の添付には必要ありません。通常利用の Chrome profile や token をコピーしません。

## 準備

この skill の読み込まれた `SKILL.md` directory を `SKILL_ROOT` として、同梱 helper から package の絶対 path を取得します。

```bash
SKILL_ROOT=/absolute/path/to/skills/pr-screenshots
BROWSER_ATTACHMENTS="$("$SKILL_ROOT/scripts/browser-tool-path" browser-attachments)"
```

既存画像をコメントへ添付する場合、これで CLI を使えます。runtime 確認や依存導入は不要です。

撮影するときだけ、同じ helper から固定 runtime の確認コマンドを得ます。

```bash
BROWSER_PREPARE="$("$SKILL_ROOT/scripts/browser-tool-path" wsl2-browser-prepare)"
"$BROWSER_PREPARE" --check
```

`--check` は準備済み runtime の整合性を確認します。未準備や不一致では失敗し、依存を導入・変更しません。引数なしの `wsl2-browser-prepare` は Node.js と npm で固定 runtime を plugin root の外へ準備します。初回準備は [package の手順](../../packages/wsl2-browser/USAGE.md)に従います。

## テスト

回帰 suite は Bats Core 1.x、Node.js 20.19 以降、`jq` を使います。これらは skill の通常利用には不要です。fixture は使い捨て directory の中だけで動作し、実 PR への書き込みや実 browser 認証は行いません。
