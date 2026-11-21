# 直接UID-map書込みと同一VMのBash監査対照

[run 44665415403 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44665415403) は、sourceとworkflowを `5984207bdf1122ae3db7946dff757bfec831751c` に固定し、`mode=probe-uid-write`、`uid_write_audit=true` で承認されたarm64の1回を実行した。[実行前の通常CI](https://github.com/treflebonbon/skills/actions/runs/44664075770)は全6ジョブが成功し、CodeRabbitは `SKIPPED`。独立した仕様・規約レビューは各指摘0件だった。

**直接writeのEPERMは3/3再現した。同じVMのBash基準では2/3 PIDからAppArmorの遷移と `sys_admin` 拒否を取得し、直接比較の6 PIDでは一致がなかった。** そのVMで監査イベントを読める条件を確認できた。直接writeを拒否した検査は未確定である。

## 同一VMの比較結果

先にPerlの最小argvと通常対照を各3回、同じBashから現行argv・現在EUIDのUID-only・namespace-only対照を各3回測った。失敗側は全て同じUID-mapのEPERM、対照は全て成功した。続くPythonの直接mapはnamespace作成と `/proc/self/uid_map` のopenが各3回成功し、writeで各3回 `errno=1 / EPERM`。直接のnamespace-only対照は3回とも成功した。全21 PIDに重複はなく、基準が終わってから直接側を測定した。

| 対象 | PID | 測定時刻（2026-11-20 UTC） | 測定結果 | kernel journal |
| --- | --- | --- | --- | --- |
| bash-baseline | 2630 | 03:06:32.850〜03:06:32.851 | UID-map EPERM | 遷移1件・`sys_admin` 拒否1件 |
| bash-baseline | 2634 | 03:06:32.942〜03:06:32.943 | UID-map EPERM | 遷移1件・`sys_admin` 拒否1件 |
| bash-baseline | 2638 | 03:06:33.035〜03:06:33.036 | UID-map EPERM | 0件 |
| map | 2736 | 03:06:34.073〜03:06:34.101 | write EPERM | 0件 |
| map | 2740 | 03:06:34.216〜03:06:34.243 | write EPERM | 0件 |
| map | 2744 | 03:06:34.357〜03:06:34.384 | write EPERM | 0件 |
| control | 2748 | 03:06:34.497〜03:06:34.525 | namespace作成成功 | 0件 |
| control | 2752 | 03:06:34.638〜03:06:34.666 | namespace作成成功 | 0件 |
| control | 2756 | 03:06:34.779〜03:06:34.807 | namespace作成成功 | 0件 |

対象9件のPID・時刻・役割を測定記録と照合した。全件で同じBashの所有子であること、wait statusと終了コードの一致、観測子のexit 0、signalとログ省略のないことを確認した。検索窓は測定の開始・終了の前後各1秒。PID 2630と2634のjournal時刻はそれぞれ測定終了の `03:06:32.851Z` と `03:06:32.943Z`。audit本体の時刻は開始に対してそれぞれ1ms前と同時で、どちらも検索窓内にある。serialは2630が遷移132・拒否133、2634が遷移134・拒否135だった。

collectorと測定callerはUID/EUID 1001、同じPID namespaceと補助group。9件を同じ `/usr/bin/journalctl`（`systemd 255 (255.4-1ubuntu8.18)`）で各1回検索し、版確認も9回完了した。比較stepは `direct-write-reproduced` の予定exit 1、監査stepは成功・`collected`。生証跡はCIで保存され、今回の照合は公開ログで行った。

## 出所と判断の範囲

image `20261111.182.1`、kernel `7.0.0-1017-azure`、直接子 `/usr/bin/python3.12` のSHA-256は[前回の直接監査](../44657370169-1/README.md)と一致した。実行時はAppArmor有効、`apparmor_restrict_unprivileged_userns=1`。共通Bashの測定前後は `unconfined`、`Seccomp: 0`。測定器7ファイルと共有readerは前回と同じGit blobで、collectorを含む計9ファイルのSHA-256は今回の公開ログと対象commitが一致した。

同じjournal readerでBash経路の遷移と能力拒否を取得できた。直接経路ではnamespace作成・writeの両方に対応する監査が0件で、同じBash経路の3件目も0件だった。監査の出力順、欠落理由、直接子がnamespace作成後に持つlabel、loaded policy、writeを拒否したkernel内の検査は未確定。経路間の違いは記録上の差で、直接writeに対するAppArmor仮説は判定保留とする。

[run.json](run.json) は公開run metadataの14項目、比較・集約ジョブの結果を保存した。[observations.json](observations.json) は[arm64 job](https://github.com/treflebonbon/skills/actions/runs/44665415403/job/136053378313)の `[DEBUG-ns-uid]` 22行、`[DEBUG-ns-uid-write]` 10行、`[DEBUG-ns-uid-write-audit]` 14行の値と掲載順、比較stepの終了コードを保存した。
