# pr-screenshots の依存と対応環境

## 実行時

| 機能 | 必要なもの | 条件を満たさない場合 |
| --- | --- | --- |
| PR とコメントの確認 | GitHub CLI `gh` と通常の認証設定 | `gh auth status` が成功しなければ添付を始めず、認証準備を案内する。token を表示する `gh auth token` は使わない |
| 添付 CLI | Node.js 20.19 以降と、この plugin の `packages/wsl2-browser/bin/browser-attachments` | package の [準備手順](../../packages/wsl2-browser/USAGE.md) を案内して止める。Nix は不要 |
| 画像添付用 browser | WSL2、mirrored networking、Windows interoperability、`wslinfo`、`powershell.exe`、`wslpath`、Windows Stable Chrome | `browser-attachments` を呼ばない。保存済み画像・原稿を保持し、手動添付の引き継ぎを案内する |
| browser runtime | package の `wsl2-browser-prepare` で準備した固定 Playwright runtime。既定 cache は plugin 外 | 不足していれば package の準備手順を案内し、browser を起動しない |
| 新しい画像の撮影 | 公式配布元から別途導入した第三者 `playwright-cli` skill。撮影には package 内 `bin/playwright-cli` を使う | 撮影が不可欠なら処理を止めて導入方法を案内する。既存画像を使える場合はその依頼で撮影を追加しない |

`gh` の CLI 認証と共有添付 browser の GitHub 認証は別々に必要です。browser 認証は専用 profile で人間が手動設定します。認証情報の複製や自動 login、通常利用の Chrome profile の再利用はしません。

## 準備

この skill の読み込まれた `SKILL.md` directory を `SKILL_ROOT` として、同梱 helper から package の絶対 path を取得します。

```bash
SKILL_ROOT=/absolute/path/to/skills/pr-screenshots
"$SKILL_ROOT/scripts/browser-tool-path" wsl2-browser-prepare
```

`wsl2-browser-prepare` は Node.js と npm を使って固定 runtime を plugin root の外に準備します。runtime は配布物へ書き込みません。初回準備が必要な場合は、人間が [package の手順](../../packages/wsl2-browser/USAGE.md) に沿って行います。

添付時は、同じ helper で `browser-attachments` の実体を得て使います。

```bash
BROWSER_ATTACHMENTS="$("$SKILL_ROOT/scripts/browser-tool-path" browser-attachments)"
"$BROWSER_ATTACHMENTS" close
```

WSL2 の mirrored networking は `/etc/wsl.conf` ではなく Windows user profile の `.wslconfig` に設定し、`wsl.exe --shutdown` 後に再起動して確認します。詳しい依存、browser 所有権、手動認証、復旧条件は [package の使用手順](../../packages/wsl2-browser/USAGE.md) と [WSL2 運用規約](../../packages/wsl2-browser/references/playwright-cli-wsl.md) を参照してください。

## テスト

回帰 suite は Bats Core 1.x、Node.js 20.19 以降、`jq` を使います。これらは skill の通常利用には不要です。fixture は使い捨て directory の中でだけ動作し、実 PR への書き込みや実 browser 認証は行いません。
