# WSL2 browser 補助

この package は WSL2 の Playwright CLI wrapper、Managed Chrome 所有権管理、共有添付ブラウザを提供します。Playwright の CLI 本体と Agent Skill は第三者配布元から別途導入してください。この package は上流の CLI や Skill を複製せず、固定 lock から取得した CLI の一部へ WSL2 用 patch を適用します。

## 準備

必要なものは Node.js 20.19 以上、runtime 準備用の npm、Bash、`git`、`curl`、`flock`、`sha256sum`、`wslinfo`、`powershell.exe`、`wslpath`、Windows 側の Stable Chrome です。GitHub の添付 upload/comment には `gh` も使います。WSL2 の networking mode は `mirrored` にします。設定後に `wsl.exe --shutdown` を実行して WSL を再起動し、`wslinfo --networking-mode` で確認してください。Windows interoperability と PowerShell が使えない場合、managed browser は起動しません。

固定依存を package 外の cache に準備します。

```sh
/absolute/path/to/skills/packages/wsl2-browser/bin/wsl2-browser-prepare
```

既定では `${XDG_CACHE_HOME:-~/.cache}/treflebonbon/wsl2-browser/` の配下を使います。`WSL2_BROWSER_DEPS_DIR` に plugin root の外にある絶対 path を指定すると、その場所へ準備します。準備は package 固有の `package-lock.json` に対して `npm ci --ignore-scripts` を使い、`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` を設定します。上流ファイルへの WSL2 patch を検査した後にだけ完成した cache を公開します。`node_modules`、一時 install、patch 済み上流ファイルは plugin source に置きません。

## 入口

| コマンド | 用途 |
| --- | --- |
| `bin/playwright-cli` | Playwright CLI。WSL2 の `open` は headless 既定の Managed Playwright Chrome を使います。非 WSL2 では固定版の上流 CLI に委譲します。 |
| `bin/browser-attachments` | 共有添付ブラウザの手動認証、終了、画像 upload、コメント投稿です。WSL2 mirrored networking と Windows interop が必要です。 |
| `bin/managed-chrome-owner` | browser identity ごとの所有状態を照会・復旧する入口です。 |
| `bin/wsl2-browser-prepare` | 固定 lock の Playwright CLI runtime を外部 cache へ準備します。 |

CLI と補助資産はすべてこの package から解決します。どの作業 directory から起動しても同じ entrypoint と資産を使えます。

## Browser identity と状態

Managed Playwright Chrome、共有添付ブラウザ、Managed Dogfood Chrome は別 identity と profile を使います。Playwright の identity は物理 worktree root から決まり、同じ worktree の subdirectory は同じ browser を使います。別 worktree、共有添付、Dogfood は状態を共有しません。WSL 側に browser を起動したり、通常の Windows Chrome profile へ fallback したりしません。

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
| `BROWSER_OWNERSHIP_DIR` | Playwright、添付、Dogfood が共有する ownership state root。各 consumer で同じ値を使います。 |
| `PWCLI_WSLINFO` / `PWCLI_POWERSHELL` / `PWCLI_WSLPATH` | WSL と Windows interoperability の command path を上書きします。 |
| `PWCLI_CURL` / `PWCLI_FLOCK` | CDP probe と wrapper lock に使う command path を上書きします。 |
| `PWCLI_CDP_CLOSE` | CDP を閉じる package 内 helper を別 path から呼ぶ場合に上書きします。 |
| `PWCLI_WINDOWS_SCRIPT` / `DOGFOOD_WINDOWS_SCRIPT` | package 内 Windows asset の既定 path を別の checkout から呼ぶ場合に上書きします。 |
| `MANAGED_CHROME_OWNER` | ownership CLI を package 既定 path 以外から呼ぶ場合に上書きします。 |
| `BROWSER_ATTACHMENTS_GH` | 添付 upload/comment で使う GitHub CLI command を上書きします。 |

`BROWSER_ATTACHMENTS_PLAYWRIGHT` は添付 entrypoint が固定 runtime から設定します。直接 `libexec/browser-attachments.mjs` を呼ばず、`bin/browser-attachments` を使ってください。`PWCLI_UPSTREAM`、`PWCLI_RUNTIME_COMMAND`、timeout 系の `PWCLI_*` は wrapper/test 用 override です。通常利用では設定せず、package の公開 entrypoint に任せてください。

所有権が不明、起動・停止が未確認、または別 consumer が同じ resource を使っている場合、処理は state を保持して失敗します。owner 記録や profile を手で削除せず、owner が示す終了・復旧手順を使ってください。通常の `close` は profile を保持します。Managed Playwright Chrome の `reset-profile` は該当 identity が停止し所有権を解放した後にだけ使えます。共有添付ブラウザの認証 profile は reset 対象にしません。

## 共有添付ブラウザ

GitHub の認証は利用者が専用の共有添付ブラウザで手動確立します。認証情報をコピーせず、通常利用の Chrome profile を使いません。

```sh
bin/browser-attachments auth
# 専用 Chrome でログイン/MFA を手動完了
bin/browser-attachments close
```

添付は同じ専用 profile を headless で再利用します。未認証なら明示的な認証手順へ戻り、通常 profile に切り替えません。

`upload` は指定した画像を GitHub の PR 本文に置いた placeholder へ反映します。明示依頼を受けてから実行してください。

```sh
bin/browser-attachments upload \
  --repo OWNER/REPO --pr NUMBER --image PATH \
  --placeholder '<placeholder>' --request-id REQUEST_ID
```

複数画像を一つのコメントにする場合は `comment` を使います。本文には各画像に対応する `<!-- screenshot-1 -->` から始まる placeholder を一度ずつ置き、同じ操作を再試行するときは同じ request ID を使います。

```sh
bin/browser-attachments comment \
  --repo OWNER/REPO --pr NUMBER \
  --image BEFORE.png --image AFTER.png \
  --body-file COMMENT.md --request-id REQUEST_ID
```

コメントは最新の PR 情報と同じ request ID の投稿済み marker を確認してから投稿します。同一 request ID を異なる本文・画像へ再利用すると拒否します。画像 upload やコメント投稿の結果を確認できない場合、receipt を保持して再送を止めます。前回の request を GitHub 上で確認し、確認できるまで新しい ID で同じ作業を作り直さないでください。コメント投稿は PR 本文を更新しません。

## 検証

package 固有の Node テストは `npm --prefix packages/wsl2-browser test` で実行します。既存の wrapper、ownership、添付、socket mock suite は Bats を用意し、次のコマンドで実行します。

```sh
bats packages/wsl2-browser/tests/*.bats
```

実ブラウザ確認には、手動認証済みの WSL2 mirrored networking と Windows Chrome が必要です。fixture/mock の成功は実 Windows browser の確認として扱いません。
