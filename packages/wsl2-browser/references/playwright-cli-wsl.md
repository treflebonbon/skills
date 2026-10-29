# WSL2 の Playwright CLI 運用

以下のコマンド例では、`BROWSER_BIN` をこの plugin に同梱された `packages/wsl2-browser/bin` の絶対 path に設定します。`playwright-cli` の本体と Agent Skill は公式の第三者配布元から別途導入してください。この package は上流 CLI を複製しません。

```sh
BROWSER_BIN=/absolute/path/to/treflebonbon-skills/packages/wsl2-browser/bin
```

## Browser と session の所有

WSL2 では通常の `"$BROWSER_BIN/playwright-cli" open <URL>` が物理 Git worktree ごとの Managed Playwright Chrome を headless で使います。同じ worktree の subdirectory は同じ browser identity を共有し、異なる worktree は分離されます。CLI session、Dashboard の探索・制御 socket も worktree ごとに分離されるため、別 worktree で同じ session 名を使えます。

証跡を repository 外へ保存するときは、open、show、annotation、close を含むすべての呼出しに `PWCLI_WORKSPACE=<absolute-task-worktree>` を指定してください。wrapper は指定先の Git worktree と物理 root を検証し、現在の directory は証跡の出力先として維持します。Git 外から起動する場合、未指定の identity は現在の物理 directory から決まります。

- WSL mirrored networking が必要です。WSL 内の browser へ fallback しません。
- 既定は headless です。`PLAYWRIGHT_MCP_HEADLESS=true|1` は headless、`"$BROWSER_BIN/playwright-cli" open --headed` または `PLAYWRIGHT_MCP_HEADLESS=false|0` は headed を指定します。バックグラウンド処理では headless を使い、OS 入力、foreground 化、自動 login、Dashboard 表示を行いません。可視 browser は人が明示的に起動します。
- 各 worktree browser は一つの CLI session が所有します。同じ identity で headed と headless を同時に使えません。所有競合があれば既存 consumer を保持します。別 worktree、共有添付、Dogfood は別 consumer です。
- `open` は新しい tab を作ります。別 consumer の tab を移動しません。
- `"$BROWSER_BIN/playwright-cli" show` と `"$BROWSER_BIN/playwright-cli" show --annotate` は headed mode とその worktree の Dashboard port を必要とし、annotation は lease を持つ session からだけ実行できます。`"$BROWSER_BIN/playwright-cli" show --kill` はその Dashboard を起動した session だけが使えます。background task のために browser mode を自動変更しません。

## 終了と復旧

所有者を特定してから `"$BROWSER_BIN/playwright-cli" -s=<owner> close` を実行します。`close-all` と `kill-all` は拒否され、managed session に対する `delete-data` も拒否されます。session と Dashboard を停止し owner を解放した後、worktree 専用 profile を明示的に初期化するときだけ `"$BROWSER_BIN/playwright-cli" reset-profile --confirm-identity <identity>` を使います。共有認証 profile は reset 対象ではありません。

```sh
BROWSER_BIN=/absolute/path/to/treflebonbon-skills/packages/wsl2-browser/bin
"$BROWSER_BIN/managed-chrome-owner" locate --role playwright --workspace /absolute/physical/worktree
"$BROWSER_BIN/managed-chrome-owner" status
"$BROWSER_BIN/managed-chrome-owner" --identity <identity> status
"$BROWSER_BIN/managed-chrome-owner" --identity <identity> recover
```

`locate` は identity、profile、CDP endpoint、Dashboard port を tab 区切りで返します。`recover` は停止を確認できた browser の owner だけを解放し、profile を変更しません。browser が動作中、または起動状態が不確かな場合は owner record を保持します。記録を手作業で削除しないでください。

新しい worktree の port 割当は Linux の現在の `/proc/sys/net/ipv4/ip_local_port_range` を避けます。WSL mirrored networking ではその範囲の全 port が Windows listener から使えないことがあります。既存割当は維持されます。既存 CDP port が使えなくなった場合は、まず owner session から Dashboard を `show --kill` し、Chrome を閉じて owner を復旧します。その後、正確な identity を指定して relocation します。

```sh
BROWSER_BIN=/absolute/path/to/treflebonbon-skills/packages/wsl2-browser/bin
"$BROWSER_BIN/managed-chrome-owner" relocate --role playwright --workspace /absolute/physical/worktree --identity <exact-identity>
```

relocation は profile を保持したまま CDP と Dashboard port だけを変更します。残っている owner、Dashboard runtime record、使用中の wrapper runtime、起動中または不明な browser があると拒否します。runtime lock は ownership lock を保持したまま待機せず取得します。現在の wrapper 処理が終わってから再試行してください。CDP が使える間は通常の close を使います。CDP も終了可能な window もない場合、対象 process の終了には明示的な承認を得てください。browser を自動終了しません。

旧 package の consumer をすべて閉じてから package と Dogfood skill を一緒に更新してください。旧 global owner record と runtime lease は移行を止めます。

## 共有添付と手動認証

PR 添付用の共有 browser は専用 profile を使い、認証は利用者が手動で設定します。認証を準備するとき、最初に残った headless browser を閉じ、専用 window を起動して手動 login/MFA を完了し、もう一度閉じてください。添付時は同じ profile を headless で再起動します。認証情報をコピーせず、通常の閲覧用 Chrome profile を使いません。

```sh
"$BROWSER_BIN/browser-attachments" close
"$BROWSER_BIN/browser-attachments" auth
# 専用 Chrome で手動ログイン/MFA を完了
"$BROWSER_BIN/browser-attachments" close
```

画像 upload は明示依頼の後で `"$BROWSER_BIN/browser-attachments" upload` を使います。複数画像を一つの PR comment にまとめるときは `"$BROWSER_BIN/browser-attachments" comment` を使い、各画像用の `<!-- screenshot-N -->` placeholder を本文へ一度ずつ置いてください。同じ処理を再試行するときは同じ request ID を使います。comment は PR 本文を変更しません。

```sh
BROWSER_BIN=/absolute/path/to/treflebonbon-skills/packages/wsl2-browser/bin
"$BROWSER_BIN/browser-attachments" upload --repo OWNER/REPO --pr NUMBER --image PATH --placeholder '<placeholder>' --request-id REQUEST_ID
"$BROWSER_BIN/browser-attachments" comment --repo OWNER/REPO --pr NUMBER --image BEFORE.png --image AFTER.png --body-file COMMENT.md --request-id REQUEST_ID
```

`upload` と `comment` は GitHub の最新 PR 情報と同じ request ID の receipt を確認してから投稿します。同じ request ID を別の本文や画像に再利用すると拒否されます。結果を確認できない場合は receipt を保持し再送を止めます。GitHub 上で前回の request を確認できるまで、新しい ID で同じ作業を作り直さないでください。

## 対応範囲と認証

WSL2 browser-free mode は `--config`、`--browser`、`--profile`、`--persistent`、`--device`、`--mobile`、`PLAYWRIGHT_MCP_HEADLESS` 以外の browser-shaping `PLAYWRIGHT_MCP_*`、`PWTEST_CLI_GLOBAL_CONFIG`、project 内 `.playwright/cli.config.json` を拒否します。明示的な remote CDP browser には `"$BROWSER_BIN/playwright-cli" attach --cdp=<remote-endpoint>` を使えます。非 WSL2 では上流 CLI の挙動を維持します。

専用 profile は利用者が手動で設定した認証を再利用できます。認証済みでも payment、production data の変更、その他の取り消せない操作を許可したことにはなりません。自動 login、credential import、通常の Chrome profile の再利用をしません。headless 中に認証が期限切れになった場合は閉じ、手動 login が必要な場合は headed で起動し、操作後に閉じ、通常の headless mode で再起動します。
