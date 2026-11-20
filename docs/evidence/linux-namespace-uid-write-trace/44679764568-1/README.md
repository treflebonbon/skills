# 同じ UID-map write で観測した AppArmor の能力拒否

[run 44679764568 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44679764568) は、source と workflow を `0bb4e2d50406bdc14b3aebb9c725db0dcb829018` に固定し、承認された arm64 の1ジョブを実行した。入力は `mode=probe-uid-write`、`uid_write_trace=true`、ラベル観測と監査は無効。[対象 SHA の通常CI](https://github.com/treflebonbon/skills/actions/runs/44679085226) は全6ジョブ成功、CodeRabbit は `SKIPPED` だった。

**観測した直接 map の PID 2744 では、AppArmor の `CAP_SYS_ADMIN` 拒否に続いて `file_ns_capable` が false を返し、同じ UID-map write が `-EPERM` を返した。** PID 2762 の成功対照は namespace 作成に成功し、UID-map write イベントは0件だった。

| PID 2744 のイベント（単調時計の秒） | 能力／戻り値 |
| --- | --- |
| `149.265497` `proc_uid_map_write` に入る | |
| `149.265504` `file_ns_capable` に入る | 21（`CAP_SYS_ADMIN`） |
| `149.265506` `apparmor_capable` に入る | 21（`CAP_SYS_ADMIN`） |
| `149.265517` `apparmor_capable` から戻る | `-1`（`-EPERM`） |
| `149.265518` `file_ns_capable` から戻る | `0`（false） |
| `149.265519` `proc_uid_map_write` から戻る | `-1`（`-EPERM`） |

固定した Ubuntu のカーネルソースでは、`proc_uid_map_write` は `map_write` を呼び、`map_write` はデータの解析前に対象 namespace の `CAP_SYS_ADMIN` を検査する。`file_ns_capable` はファイルを開いた資格情報で LSM の能力検査を呼ぶ。今回の入れ子になった引数と戻り値は、この拒否経路と対応する。[Ubuntu の UID-map 実装](https://git.launchpad.net/~canonical-kernel/ubuntu/+source/linux-azure/+git/noble/tree/kernel/user_namespace.c?id=90f5e10e3a3dc1273846689f4cee162f97b4b3df#n992) · [Ubuntu の能力検査](https://git.launchpad.net/~canonical-kernel/ubuntu/+source/linux-azure/+git/noble/tree/kernel/capability.c?id=90f5e10e3a3dc1273846689f4cee162f97b4b3df#n433)

## 対象と終了状態

基準15回は mapping 側の9/9で同じ EPERM、対照は6/6成功。続く直接 map 3回は `unshare` と `open` が成功し、全3回の `write` が EPERM。namespace-only 対照は3/3成功した。21 PID に重複はなく、観測の有効化と終了、直接比較の JSON にある PID と所有 Bash PID 2584 がそれぞれ一致した。測定 caller は非root（UID/EUID 1001）。観測したのは直接 map の1回目と対照の1回目だった。

観測担当は `check / ready`、map と対照の `arm / armed`、各 `finish` と `cleanup / cleaned` を記録した。比較は `direct-write-reproduced` の予定 exit 1。解除・生証跡保存ステップは成功した。陽性側のトレースは上の6イベント。対照は `no-uid-map-write`、イベント配列は空だった。

kernel は `7.0.0-1017-azure`、runner image は `20261116.188.1`。初回の失敗時は同じ kernel 表示で image `20261111.182.1` だった。測定器7ファイルの記録ハッシュと Python の実体情報は初回と一致した。追記時の seek を避けた観測担当で登録・採取・解除できたことを確認した。初回の `EINVAL` が返った操作自体は当時のログに含まれない。[初回の証跡](../44677143069-1/README.md)

原因を確認した範囲は、この arm64 VM の直接 map 1件である。ロードされた AppArmor の規則の行や、残るPID・他のOSの個別経路は未観測。#33 の採用可否には、対応範囲での終了保証と互換性の実証が必要である。[ADR 0003](../../../adr/0003-os-specific-preparation-containment.md)

[run.json](run.json) は公開run metadata14項目と2ジョブのstep結果を保存した。[observations.json](observations.json) は[arm64 job](https://github.com/treflebonbon/skills/actions/runs/44679764568/job/136100096954)の基準22行、直接比較10行、トレース担当6行と比較ステップの exit 1 を、公開ログの順に保存した。
