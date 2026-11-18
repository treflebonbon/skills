# WSL2 browser 補助

この package は WSL2 の Playwright CLI wrapper、Managed Chrome 所有権管理を提供します。Playwright の CLI 本体と Agent Skill は第三者配布元から別途導入してください。この package は上流の CLI や Skill を複製せず、固定 lock から取得した CLI の一部へ WSL2 用 patch を適用します。

## 準備

WSL2 での撮影には runtime 準備用の npm、Bash、`git`、`curl`、`sha256sum`、`wslinfo`、`powershell.exe`、`wslpath`、Windows 側の Stable Chrome が必要です。WSL2 の networking mode は `mirrored` にします。設定後に `wsl.exe --shutdown` を実行して WSL を再起動し、`wslinfo --networking-mode` で確認してください。

まず準備済み runtime を、依存を導入・変更せず確認できます。成功時は検証した runtime の絶対 path を表示し、未準備や不一致では非0で終了します。

```sh
/absolute/path/to/skills/packages/wsl2-browser/bin/wsl2-browser-prepare --check
```

初回の準備が必要なら、固定依存を package 外の cache に準備します。

```sh
/absolute/path/to/skills/packages/wsl2-browser/bin/wsl2-browser-prepare
```

既定では `${XDG_CACHE_HOME:-~/.cache}/treflebonbon/wsl2-browser/` の配下を使います。`WSL2_BROWSER_DEPS_DIR` に plugin root の外にある絶対 path を指定すると、その場所へ準備します。準備は package 固有の `package-lock.json` に対して `npm ci --ignore-scripts` を使い、`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` を設定します。上流ファイルへの WSL2 patch を検査した後にだけ完成した cache を公開します。`node_modules`、一時 install、patch 済み上流ファイルは plugin source に置きません。

## 入口

| コマンド | 用途 |
| --- | --- |
| `bin/playwright-cli` | Playwright CLI。WSL2 の `open` は headless 既定の Managed Playwright Chrome を使います。非 WSL2 では固定版の上流 CLI に委譲します。 |
| `bin/managed-chrome-owner` | browser identity ごとの所有状態を照会・復旧する入口です。 |
| `bin/wsl2-browser-prepare` | 引数なしで固定 runtime を外部 cache へ準備します。`--check` は既存 runtime の検証、`--help` は使い方の表示だけを行います。 |

CLI と補助資産はすべてこの package から解決します。どの作業 directory から起動しても同じ entrypoint と資産を使えます。

## Browser identity と状態

Managed Playwright Chrome と Managed Dogfood Chrome は別 identity と profile を使います。Playwright の identity は物理 worktree root から決まり、同じ worktree の subdirectory は同じ browser を使います。worktree ごとの Playwright と Dogfood は状態を分離します。WSL 側に browser を起動したり、通常の Windows Chrome profile へ fallback したりしません。

証跡を repository 外の directory から保存する場合は、すべての `playwright-cli` 呼出しに同じ Git worktree を指定します。

```sh
PWCLI_WORKSPACE=/absolute/path/to/task-worktree \
  /absolute/path/to/skills/packages/wsl2-browser/bin/playwright-cli open https://example.com
```

`PWCLI_WORKSPACE` は既存 Git worktree の絶対 path にします。指定した path の物理 root が browser identity になり、証跡を置く現在の directory は変わりません。

| 環境変数 | 用途 |
| --- | --- |
| `WSL2_BROWSER_DEPS_DIR` | 固定 Playwright runtime を置く plugin root の外にある絶対 path。省略時は lock と patch の指紋を含む XDG cache path を使います。 |
| `PWCLI_WORKSPACE` | 作業 directory が worktree 外にある場合の Managed Playwright Chrome identity。 |
| `PWCLI_RUNTIME_DIR` | Playwright session、Dashboard、lease の一時状態 root。省略時は `XDG_RUNTIME_DIR` を使い、未設定なら `PWCLI_TMPDIR` または mode 0700 の `/tmp` 配下を使います。 |
| `BROWSER_OWNERSHIP_DIR` | Playwright と Dogfood が共有する ownership state root。各 consumer で同じ値を使います。 |
| `PWCLI_WSLINFO` / `PWCLI_POWERSHELL` / `PWCLI_WSLPATH` | WSL と Windows interoperability の command path を上書きします。 |
| `PWCLI_CURL` / `PWCLI_FLOCK` | CDP probe と wrapper lock に使う command path を上書きします。 |
| `PWCLI_CDP_CLOSE` | CDP を閉じる package 内 helper を別 path から呼ぶ場合に上書きします。 |
| `PWCLI_WINDOWS_SCRIPT` / `DOGFOOD_WINDOWS_SCRIPT` | package 内 Windows asset の既定 path を別の checkout から呼ぶ場合に上書きします。 |
| `MANAGED_CHROME_OWNER` | ownership CLI を package 既定 path 以外から呼ぶ場合に上書きします。 |

`PWCLI_UPSTREAM`、`PWCLI_RUNTIME_COMMAND`、timeout 系の `PWCLI_*` は wrapper/test 用 override です。通常利用では設定せず、package の公開 entrypoint に任せてください。

所有権が不明、起動・停止が未確認、または別 consumer が同じ resource を使っている場合、処理は state を保持して失敗します。owner 記録や profile を手で削除せず、owner が示す終了・復旧手順を使ってください。通常の `close` は profile を保持します。Managed Playwright Chrome の `reset-profile` は該当 identity が停止し所有権を解放した後にだけ使えます。

WSL2 の headed/headless 切替、Dashboard と session の所有、port relocation、手動認証の条件は [Playwright CLI の WSL2 運用規約](references/playwright-cli-wsl.md)を参照してください。

## 画像添付

既存画像のコメント・本文への添付と旧版からの移行は、[PR への画像添付](../../docs/pr-attachments.md)を参照してください。

## 検証

package 固有の Node テストは `npm --prefix packages/wsl2-browser test` で実行します。既存の wrapper、ownership、socket mock suite は Bats を用意し、次のコマンドで実行します。

```sh
bats packages/wsl2-browser/tests/*.bats
```

実ブラウザ確認には、手動認証済みの WSL2 mirrored networking と Windows Chrome が必要です。fixture/mock の成功は実 Windows browser の確認として扱いません。
