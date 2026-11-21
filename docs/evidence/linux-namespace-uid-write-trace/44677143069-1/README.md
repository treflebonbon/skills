# UID-map カーネルトレースの初回実行

[run 44677143069 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44677143069) は、source と workflow を `9ed9ce0646985e00405ef0317a9202505e74eea9` に固定し、承認された arm64 の1ジョブを実行した。入力は `mode=probe-uid-write`、`uid_write_trace=true`、ラベル観測と監査は無効。[対象SHAの通常CI](https://github.com/treflebonbon/skills/actions/runs/44676499380) は全6ジョブ成功、CodeRabbit は `SKIPPED` だった。

**観測の前提確認は通過した。最初の直接 map の観測設定が `EINVAL` で止まり、対象子の exec は実行されなかった。** 直接比較は `unavailable`、比較ステップは exit 2。解除ステップは成功し、観測担当は `cleaned` を記録した。

| 段階 | 結果 |
| --- | --- |
| 前提確認 | `ready`。arm64、kernel `7.0.0-1017-azure`、AppArmor の設定、既設 tracefs と必要な関数の確認に成功 |
| 非rootの基準15回 | mapping側9/9で同じUID-map EPERM、対照6/6成功。直接比較の gate は `ready` |
| map 1回目の観測設定 | 所有 Bash PID 2551、待機中の子 PID 2711。観測担当は `arm / unavailable / EINVAL` |
| 比較の停止 | 対象子の Bash wait status は97。操作のstdout・stderrは空。直接子の exec 前に中止したため、通常のcaptureには対象PIDが登録されず `pid=0` |
| 後片付け | `cleanup / cleaned`、解除・生証跡保存ステップ成功。集約・監査はスキップ |

比較時の image は `20261111.182.1`。今回の記録は設定段階までで、直接writeや能力検査の戻り値は未観測。前回までの直接writeに関する AppArmor 仮説は、引き続きカーネルの個別の戻り値を待つ。観測担当のログは `EINVAL` までで、失敗したファイル操作名は含まれていない。

## 観測設定側で見つかった問題

公開されている同じ Ubuntu カーネルの `kprobe_events` は `seq_lseek` を使う。公開ソースの `seq_lseek` は `SEEK_END` を `EINVAL` で拒否し、CPython の追記ストリームは open 時に `SEEK_END` を行う。手元では別の `seq_file` である自プロセスの `/proc/self/status` を読取専用で開き、通常の FileIO 初期化は通過、追記モードの初期化は `EINVAL` になることを確認した。これは今回の `EINVAL` を説明できる有力な経路で、実VMでその操作が最初に失敗した時点は未観測。[Ubuntu の Kprobe 実装](https://git.launchpad.net/~canonical-kernel/ubuntu/+source/linux-azure/+git/noble/tree/kernel/trace/trace_kprobe.c?id=90f5e10e3a3dc1273846689f4cee162f97b4b3df) · [Linux の seq_lseek](https://github.com/torvalds/linux/blob/v7.0/fs/seq_file.c#L309) · [CPython の FileIO](https://github.com/python/cpython/blob/v3.12.3/Modules/_io/fileio.c#L484)

[run.json](run.json) は公開run metadata14項目と2ジョブのstep結果を保存した。[observations.json](observations.json) は[arm64 job](https://github.com/treflebonbon/skills/actions/runs/44677143069/job/136091563393)の基準22行、直接比較5行、トレース担当3行と終了コードを、公開ログの順に保存した。
