# 直接UID-map比較の子が確認したAppArmorラベル

[run 44670151286 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44670151286) は、sourceとworkflowを `5181d087a882d0e647b2ea59e1a2b02991cb9ece` に固定し、`mode=probe-uid-write`、`uid_write_label=true`、`uid_write_audit=false` で承認されたarm64の1回を実行した。[実行前の通常CI](https://github.com/treflebonbon/skills/actions/runs/44669402513)は全6ジョブ成功、CodeRabbitは `SKIPPED` だった。

**直接の失敗側・成功対照とも3/3で、対象操作の後に子自身が `unprivileged_userns (enforce)` を取得した。** map側ではnamespace作成・openが3/3成功し、writeは3/3 `EPERM`。namespace-only対照は3/3成功した。直接経路にも当該プロファイルが適用されるという予測を支持する。

| 直接比較 | PID | 測定区間（2026-11-20 UTC） | 操作結果 | 観測ラベル |
| --- | --- | --- | --- | --- |
| direct-map | 2763 | 03:48:21.410〜03:48:21.438 | write EPERM | `unprivileged_userns (enforce)` |
| direct-map | 2767 | 03:48:21.550〜03:48:21.578 | write EPERM | `unprivileged_userns (enforce)` |
| direct-map | 2771 | 03:48:21.694〜03:48:21.722 | write EPERM | `unprivileged_userns (enforce)` |
| direct-control | 2775 | 03:48:21.834〜03:48:21.862 | namespace作成成功 | `unprivileged_userns (enforce)` |
| direct-control | 2779 | 03:48:21.976〜03:48:22.004 | namespace作成成功 | `unprivileged_userns (enforce)` |
| direct-control | 2783 | 03:48:22.119〜03:48:22.147 | namespace作成成功 | `unprivileged_userns (enforce)` |

既存のPerl・Bash基準15回では、UID mapping側がすべて同じEPERM、対照側がすべて成功した。基準と直接比較の21 PIDに重複はなく、基準の終了後に直接比較を実行した。直接6 PIDは同じBashの所有子で、wait statusは終了コードと一致し、観測子はexit 0。signal・stderr・ログ省略はなかった。

workflowは監査ステップと集約をスキップし、CIで生証跡を保存した。比較結果は `direct-write-reproduced`。ジョブの `failure` は再現を示す予定exit 1による。今回の照合は公開ログで行った。

## 観測時点と出所

子自身の `/proc/self/attr/apparmor/current` を、map側はwriteの結果とfd cleanupの後、成功対照はnamespace作成の後に読んだ。ソース上、読取は各子1回、最大256バイト。観測したラベルを除く子のJSONと、観測用オプションを除くargv、終了コードは[前回の直接比較](../../linux-namespace-uid-write-audit/44665415403-1/README.md)の対応する6件と一致した。同じVM内のBash測定の前後では `unconfined`、`Seccomp: 0` を記録した。Bashのcallerラベルと子が実行後に観測したラベルはそれぞれのプロセスの値である。[LinuxのLSMインターフェース](https://www.kernel.org/doc/html/latest/userspace-api/lsm.html)

arm64のimage `20261111.182.1`、kernel `7.0.0-1017-azure` と `/usr/bin/python3.12` の実行体SHA-256は前回と一致。測定callerは非root（UID/EUID 1001）で、AppArmor有効かつ `apparmor_restrict_unprivileged_userns=1`。測定器7ファイルは今回と前回それぞれの固定commitのGit blobに一致した。差分があるのはラベル指定を渡すBash launcherと、測定後に読む直接子の2ファイルだった。

この観測により直接子のプロファイルは確認できた。writeを拒否したkernel内の検査、write時点の独立したhook結果、読み込まれた個別のポリシー規則は未確定である。前回のBash経路で保存した能力拒否は、その経路のPIDと時刻に対応する。[固定kernel sourceとこれまでの証跡](../../../linux-namespace-capability-mapping.md)

[run.json](run.json) は公開run metadata14項目と2ジョブのstep結果、[observations.json](observations.json) は[arm64 job](https://github.com/treflebonbon/skills/actions/runs/44670151286/job/136068909170)の `[DEBUG-ns-uid]` 22行、`[DEBUG-ns-uid-write]` 10行、比較stepの終了コードを保存した。
