# 直接UID-map書込みと成功対照のarm64監査

[run 44657370169 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44657370169) は、sourceとworkflowを `94f75da0e5dbce27abd354ab444b1cad81d61a94` に固定し、`mode=probe-uid-write`、`uid_write_audit=true` で承認されたarm64の1回を実行した。実行前の[通常CI](https://github.com/treflebonbon/skills/actions/runs/44655970701)は全6ジョブ成功、CodeRabbitは `SKIPPED` だった。

直接mapは3回ともnamespace作成と `/proc/self/uid_map` のopenに成功し、writeで `errno=1 / EPERM` になった。namespace作成だけの対照は3回とも成功した。比較stepは `direct-write-reproduced` と予定どおりのexit 1、監査stepは成功した。監査の6検索は全て `no-matching-events` で、遷移・能力拒否の記録はいずれも取得できなかった。AppArmor仮説の判定は保留する。

## 同じVM内の比較

Perlの最小argvは3/3 EPERM、通常対照は3/3成功。Bashの現行argvと現在EUIDのUID-onlyは各3/3 EPERM、namespace-only対照は3/3成功した。この15 probeの基準を通過してから、固定した直接経路の6 probeを実行した。基準と直接比較の21 PIDは重複せず、直接比較の所有Bash PIDは2580。全6件でwait statusと終了コードが一致し、観測子はexit 0、signal・stderr・ログ省略はなかった。

| 直接比較 | 対象PID | 測定区間（2026-11-20 UTC） | 結果 | kernel journal |
| --- | --- | --- | --- | --- |
| direct-map | 2740 | 01:58:04.587〜01:58:04.615 | write EPERM | 0件 |
| direct-map | 2744 | 01:58:04.727〜01:58:04.754 | write EPERM | 0件 |
| direct-map | 2748 | 01:58:04.866〜01:58:04.894 | write EPERM | 0件 |
| direct-control | 2752 | 01:58:05.006〜01:58:05.034 | namespace作成成功 | 0件 |
| direct-control | 2756 | 01:58:05.146〜01:58:05.174 | namespace作成成功 | 0件 |
| direct-control | 2760 | 01:58:05.286〜01:58:05.314 | namespace作成成功 | 0件 |

collectorと測定callerはUID/EUID 1001、同じPID namespaceと補助group。6件すべてでPID・測定時刻・役割が一致し、各検索の窓はその開始・終了の前後1秒を含んだ。readerは `/usr/bin/journalctl` の `systemd 255 (255.4-1ubuntu8.18)`。全件の `readStatus` と `status` は `no-matching-events`、`recordCount=0`。固定readerでは、この分類は検索がexit 1で標準出力・標準エラーとも空だったことを示す。監査stepの `collected` は6検索の完了を表す。

## 出所と判断範囲

今回のarm64 VMはimage `20261111.182.1`、kernel `7.0.0-1017-azure`。以前の[直接write再現](../../linux-namespace-uid-write/44633267572-1/README.md)と[Bashの監査](../../linux-namespace-bash-audit/44438396275-1/README.md)は、同じkernel表示でimage `20261116.188.1` だった。実行時のAppArmorは有効、`apparmor_restrict_unprivileged_userns=1`、測定前後のcallerは `unconfined` と `Seccomp: 0`。実VMのloaded policyと直接子のnamespace作成後のlabelは未確認。

直接子は `/usr/bin/python3.12`、SHA-256は `c86f21d0da9290ece2d7d49a3f7ed52aed59cb029abdf0ea25c79634f6cbe960`。全6件の実行体hash前後と、前回のarm64の記録が一致した。測定器7ファイルは前回の直接比較からバイト単位で同一。今回の測定器7ファイルとcollector・共有readerの計9ファイルは、公開記録のSHA-256と対象commitのGit blobが全て一致した。

旧runではarm64のBash最小argvで2/3 PIDにAppArmorの遷移と `sys_admin` 拒否が対応した。今回の検索では同じVM内で監査の可視性を確認する陽性対照がなく、監査の生成・抑制・可視性に加え、writeの拒否を返した具体的な検査は未確定である。[固定公開kernel sourceと過去のBash監査](../../../linux-namespace-capability-mapping.md)に基づくAppArmor能力検査の仮説は引き続き有力だが、今回固有の因果を確認できるイベントは得られなかった。

[run.json](run.json) は公開run metadataの14項目と比較・集約ジョブのstep結果を保存した。[observations.json](observations.json) は[arm64 job](https://github.com/treflebonbon/skills/actions/runs/44657370169/job/136026821824)から選んだ `[DEBUG-ns-uid]` 22行、`[DEBUG-ns-uid-write]` 10行、`[DEBUG-ns-uid-write-audit]` 7行の値と掲載順、比較stepの終了コードを保存した。artifactはCIで保存された。今回の照合は公開ログと公開metadataで完了した。
