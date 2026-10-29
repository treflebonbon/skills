# Raw Codex の隔離起動

`bin/codex-worktree` は、対象 repository の linked worktree から raw Codex を起動します。実装は `bin/devshell-env`、`lib/python/treflebonbon_skills/devshell_environment.py`、`share/codex-isolation/` にあり、Git metadata の所有権確認には共用の [`git_context`](../lib/python/treflebonbon_skills/git_context.py) を使います。dotfiles checkout は実行時の依存ではありません。

## 必要な環境

- Linux または WSL2 と、rootless user/network namespace を使える kernel
- Nix flakes と、対象 worktree root の `flake.nix`
- PATH で選択できる Nix store 内の `nix`、`bash`、`cat`、Python 3.13 以上、Git、Codex CLI 0.153.4 以上、GitHub CLI `gh`、bubblewrap `bwrap`
- managed Codex 設定にある `dotfiles-secure` permission profile と、その profile が参照する network allowlist
- Nix store 内の公開 CA bundle。`CODEX_ISOLATION_CA_BUNDLE`、`NIX_SSL_CERT_FILE`、`SSL_CERT_FILE` の順に選び、指定なし・Nix store 外は拒否します。

macOS と Windows native は対象外です。Nix または flake がない、必要な tool が Nix store 外から選ばれた、linked worktree の Git ownership を検証できない、repo の trust や入力登録がない場合は隔離起動前に理由を表示して停止します。

GitHub policy を登録する場合だけ Nix store の `awk` と `jq` も必要です。Context7／Serena を登録する場合は Nix store の `bunx`、`node`、`uvx` と managed Codex 設定が必要です。これらは任意の host command や環境変数を隔離へ引き継がず、固定した tool・引数・scope だけを利用します。

## Trust と公開入力

trust は repository の Git common directory の physical path と inode に結び付き、同じ repository に所属する linked worktree で共有されます。公開入力登録は worktree ごとに行います。

```bash
devshell-env trust
devshell-env status
devshell-env admit --git-head FULL_COMMIT_SHA -- flake.nix flake.lock src/main.py
codex-worktree
```

`FULL_COMMIT_SHA` は確認済みの現在の full `HEAD` です。`admit` はその `HEAD` から到達可能な Git 履歴全体と、引数で列挙したファイルの内容・実行属性を公開入力として記録します。初回登録時の index は `HEAD` と一致している必要があり、入力の symlink・hardlink・特殊ファイル、登録後に変わった入力、別 repository の trust を拒否します。ファイル名による秘密判定は行わないため、公開すると決めたファイルだけを人が列挙します。`.env`、鍵、認証ファイルや、それらを含む履歴は登録しないでください。

入力登録時に managed `CODEX_HOME/config.toml` の `dotfiles-secure` profile と network domain allowlist を確認します。この package は profile の配布・導入や実効 policy の preflight を行いません。profile は起動前の導入条件で、存在しない・形式が合わない場合は `admit` が拒否します。起動 argv から permission profile、filesystem root、追加 workspace、sandbox、approval、remote を差し替える指定も拒否します。`model_reasoning_effort` の単一指定は引き続き受け付けます。

## 隔離と復旧

raw 起動はホストの HOME、Nix daemon、任意の継承環境変数、未登録ファイルを渡しません。専用 user・filesystem・PID・network namespace と使い捨ての Nix store を作り、登録済み snapshot と選択済み Nix tool closure だけを使用します。host Codex login は host 側の model gateway が利用し、token や認証ファイルは隔離内へコピーしません。モデル gateway は Responses API に限定され、依存取得は登録済み domain allowlist と公開 IP の gateway を通ります。GitHub は別途人が用意した topic policy がある場合だけ公開 metadata gateway を使います。

実行 state は `${XDG_STATE_HOME:-$HOME/.local/state}/devshell-env/inputs/` と `sessions/` に保存され、package checkout は書き換えません。各起動は session directory を表示します。隔離内では同じ host worktree を並行編集しないでください。終了後は commit、index、通常ファイルの結果を元へ返し、次の公開入力登録を更新します。HEAD・index・入力の競合、未登録ファイルとの衝突、失敗した初期化や gateway cleanup は返却を止め、session を復旧用に保持します。返却中の I/O 障害に対する全体 atomic rollback は保証しないため、保存された snapshot と bundle を確認してから人が復旧します。成功後の session も自動削除しません。

隔離内の `with-env` は `devshell-env with-env --prepared -- COMMAND [ARGS...]` のみです。準備済み環境を再利用し、root `.env` を読みません。package に含む入口は generic な host `.env` loader ではありません。

## テスト

`tests/raw-codex/` へ、raw entry、devShell preparation、公開入力 snapshot、Git result transfer、gateway cleanup と protocol、MCP/GitHub opt-in、app-server handoff の既存 Bats suite を移しています。既定の Python suite には、dotfiles を使わない Git context と argv 拒否の確認があります。実モデル・既存認証を使うケースは元の opt-in 条件を維持し、通常の fixture 検証は一時 repository とダミー値だけを使用します。
