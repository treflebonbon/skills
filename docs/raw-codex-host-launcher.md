# Linux／WSL2 の raw ホスト向け launcher

[#146](https://github.com/treflebonbon/skills/issues/146) は plugin 同梱の `bin/prepare-raw-codex-launcher` と `bin/raw-codex-launcher` を提供します。設計の範囲は [#131 の追補](https://github.com/treflebonbon/skills/issues/131)、方式の選択と終了保証は [ADR 0005](adr/0005-linux-host-adaptive-preparation-containment.md) に従います。

## 準備と起動

```sh
plugin=/absolute/path/to/plugin
"$plugin/bin/prepare-raw-codex-launcher"
exec "$plugin/bin/raw-codex-launcher" /absolute/path/to/prepare.ts
```

明示準備には導入済みの `cc`、Linux の C header／library、システムの `/usr/bin/perl` と標準モジュール（`syscall.ph` を含む）が必要です。Ubuntu 24.04 では `gcc`、`libc6-dev`、`perl` を利用できます。明示準備は C source からビルドし、成果物が公開された directory を stdout に返します。成果物は `$XDG_CACHE_HOME/treflebonbon-skills/raw-codex-launcher/`、未指定時は実行ユーザーのホームの `.cache` 以下に保存します。格納先は plugin payload 外の、祖先 directory が保護された Linux filesystem に置きます。公開には `renameat2(RENAME_NOREPLACE)` が必要です。並行実行では先に公開された成果物を再検査して利用します。不完全な成果物が同じ場所にある場合は、当該成果物を利用者が退避するか、新しい private cache を選んで明示準備を実行してください。

通常起動には `/usr/bin/perl`、Bash、導入済みの Bun 1.4.4 以上と Linux の `/proc`、実行を許可した sealed memfd、pidfd が必要です。`/usr/bin/unshare` と `/usr/bin/true` で PID namespace を試し、成立しなければ `/usr/bin/systemd-run` と user manager が提供する cgroup v2 の委譲を試します。launcher は選択と理由を stderr に記録します。どちらも成立しない場合は Bun を起動する前に終了コード `69` を返します。キャッシュが欠落または不一致の場合は、明示準備を案内して終了コード `1` を返します。コンパイルとキャッシュの書き込みは明示準備に限ります。

起動入口は C 実行体と記録を検査し、ハッシュを照合した実行体を sealed memfd に固定します。その実行体が独立した Bun 検査子を監督します。Bun は source と実行体のハッシュ、環境とファイルの属性を検査し、検査した inode を監督側に返します。監督側は cache の path とその inode の対応を再照合し、同じ sealed memfd を同じ PID で `exec` します。cache は利用者が信頼する入力です。コンパイルに使用する `cc` と検査・準備に使用する `bun` は呼び出し元の信頼済み `PATH` から解決します。

`prepare.ts` は `lib/bun/run run` で受け取る引数を使い、成功時に `exec-proof-v1` frame を stdout に返して終了します。raw 用 TypeScript caller では `lib/bun/raw-exec-frame.ts` の `rawArguments` と `writeExecFrame` がこの契約を実装します。launcher は準備子孫を終了・回収してから、frame の argv と環境差分で target を `exec` します。呼び出し元は `exec` で入口へ制御を渡し、継承させる FD と lock の保持期間を指定します。

## #48 への引き継ぎ

利用側 flake では、plugin と外部 caller が同じ repository revision の payload を参照するように pin を更新してください。ホスト側は新しい payload の `bin/prepare-raw-codex-launcher` をセットアップ工程に置き、起動時は `bin/raw-codex-launcher` へ `exec` します。`cc` と C header／library は準備時の環境に置き、`perl`、Bash、Bun と選択方式の依存をホストの実行環境に揃えます。隔離内の成果物は、同じ pin の `nix/raw-codex-launcher.nix` からビルドし、[#45 の Nix 配布契約](raw-codex-launcher-proof.md#利用側-flake-と-45-への引継ぎ) で選択します。`codex-worktree`／`devshell-env` の公開入口の接続と Git・ファイル返却の検証は [#48](https://github.com/treflebonbon/skills/issues/48) が担当します。

## 製品の検証

次のテストを準備と通常起動が実行されるホストで、非 root ユーザーとして実行します。`TMPDIR` は本人が書き込める、Unix domain socket を作成できる絶対 path にしてください。

```sh
RAW_HOST_LAUNCHER_CONTAINMENT=namespace python3 -B -m unittest discover -s tests -p test_raw_host_launcher.py -v
RAW_HOST_LAUNCHER_CONTAINMENT=cgroup python3 -B -m unittest discover -s tests -p test_raw_host_launcher.py -v
```

ホストに合った1行を選びます。拒否を期待する環境では `RAW_HOST_LAUNCHER_CONTAINMENT=refused` を指定します。テストは準備コマンドから実際の起動入口を通って合成 target に至ります。旧 corpus の PID、TTY、FD、signal、argv／env、終了状態と、target の `ARG_MAX` および frame 上限を照合します。Bun 検査中と準備中の中断は、入口だけにシグナルを送り、離脱した子孫の pidfd による終了通知を単調時計で測ります。終了までの時間はシグナル送信直前から計るため、SIGTERM の受理からの時間も上限に含まれます。 [#121 の方式実証](linux-host-adaptive-proof-plan.md#結果)
