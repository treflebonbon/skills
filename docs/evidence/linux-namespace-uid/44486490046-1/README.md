# UID mapping単独でも同じEPERMが残った比較記録

[run 44486490046 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44486490046) は、source / workflowを `f2d0e838ffc05f2009b4dc22580c45057c13ce93` に固定し、承認された `mode=probe-uid` を1回実行した。実行前に対象commitの独立した仕様指摘0件・規約違反0件、[通常CI全6ジョブの成功](https://github.com/treflebonbon/skills/actions/runs/44484191643)、CodeRabbitの同じheadに対する4評価項目の成功と、当時取得したスレッド一覧の未解決0件を確認した。その後の再取得では、このsourceへの追加指摘4件を確認した。数値表記のユーザー名の解決先を確認していない指摘を受け、以下では実際のargvと出力の観測、および同じUIDへmappingしたかという未確認の前提を区別する。規約軸の既存workflow定義重複に関する参考指摘1件は、今回の接続テストを維持し、共通化を別の整理対象とした。

確認済み（confirmed）: x64・arm64とも `uid-mapping-reproduced`。同じBashで現行の `--map-current-user` と `--map-user=1001` が各3回同じUID-map EPERM、namespace作成だけの対照は各3回成功した。GID mappingとsetgroupsの指定を省いても今回の症状は再現した。runのfailureは予定exit 1によるもので、正式実証や修正の成功には数えない。

## 実測結果

最初にPerl基準測定の最小argvと普通の対照を各3回測り、正確なEPERMと対照成功を確認した。その後、同じ共通Bashで3caseを各3回測った。

| architecture | Perl最小 / 普通の対照  | Bash現行argv | Bash UID-only | Bash namespace-only |
| ------------ | ---------------------- | ------------ | ------------- | ------------------- |
| x64          | 3/3同じEPERM / 3/3成功 | 3/3同じEPERM | 3/3同じEPERM  | 3/3成功             |
| arm64        | 3/3同じEPERM / 3/3成功 | 3/3同じEPERM | 3/3同じEPERM  | 3/3成功             |

Perl最小とBash現行argvは `--map-current-user -- /usr/bin/true`。Perl対照は `-- /usr/bin/true`、Bash UID-onlyは `--map-user=1001 -- /usr/bin/true`、Bash対照は `--user -- /usr/bin/true`。1001は測定時の現在EUIDで、sourceに固定した値ではない。ただし `--map-user` はUIDとユーザー名の両方を受け付ける。数値表記のユーザー名 `1001` の解決先をこのVMでは記録していないため、UID-onlyが同じUIDを指定したかは未確認である。後から追加した名前解決検査はこのrunには含まれず、まだ実VMで実行していない。元の `run.json` と `observations.json` は観測時の内容を保持する。

mappingを指定した計18回はexit 1・空stdoutと次のstderr全文、対照の計12回はexit 0・空stdout/stderrだった。全30回にsignal・spawn error・ログ省略はなかった。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

| architecture | 共通Bash PID | Perl PID | Bash現行argv PID   | UID-only PID       | namespace-only PID |
| ------------ | ------------ | -------- | ------------------ | ------------------ | ------------------ |
| x64          | 3172         | 3197     | 3227 / 3231 / 3235 | 3239 / 3243 / 3247 | 3251 / 3255 / 3259 |
| arm64        | 3238         | 3263     | 3293 / 3297 / 3301 | 3305 / 3309 / 3313 | 3317 / 3321 / 3325 |

各VMの15 probe PIDは重複しない。全Perl probeの終了後にBash側を開始し、全probeの時刻は各job内、各probeは5秒未満だった。probeの最大経過時間はx64が約2.14ms、arm64が約2.97ms。Bash側9回/architectureの `waitStatus` はexit statusと一致し、全観測子の `observerStatus` は0だった。exec前の子PID・所有するBashの親PID・Bash実体・process group・sessionを照合し、観測子は対象と祖先のどちらでもなかった。namespace probeは計30回、別に準備時のunshare版確認が各1回ある構成である。

## 固定した条件と出所

| architecture | image            | kernel             | caller UID/EUID/GID | 補助group              |
| ------------ | ---------------- | ------------------ | ------------------- | ---------------------- |
| x64          | `20261111.370.1` | `7.0.0-1017-azure` | 1001                | `[4,100,118,999,1001]` |
| arm64        | `20261116.188.1` | `7.0.0-1017-azure` | 1001                | `[4,100,117,999,1001]` |

Bashは `/usr/bin/bash` の `5.2.21(1)-release`、Perlは `/usr/bin/perl` の `5.38.2`。Perl自身を除いた祖先列がBash側と一致した。共通BashのPID・親PID・start time ticks・process group・sessionと上位祖先は各VM内で同じで、PID 1のexeは `EACCES`。callerの資格情報、namespace識別子、map、capability / NoNewPrivs / Seccomp、限定LSM項目と5環境変数は両方式・各測定前後で一致した。環境全体とcommand lineは読んでいない。

callerは `unconfined`、AppArmorは有効、`apparmor_restrict_unprivileged_userns` は `1`。今回はjournalを検索せず、実unshareの拒否時LSM・loaded policy全内容・当該syscallの直接traceは得ていない。別runの監査PIDを今回のPIDへ対応させない。

probeの設定は空環境、cwd `/`、exec直前のfd 0閉鎖、別々の匿名通常pipeとflags、5秒・合算32MiB制限を維持した。fd・環境・cwdは固定sourceと実子fixtureで検証した設定であり、実unshareの拒否時状態を直接dumpしたものではない。`childBefore` はexec前のBash子の観測である。

unshareは `/usr/bin/unshare`、`util-linux 2.39.3`。実体hashはx64が `a23c8863860669003dc4660039fe642f5795c8c2195898ebc5d01afa1ac3d11c`、arm64が `e0c145c3d4c06686544b1362ed64da819539166a5e1e6fd96093aea4d2539b6a`。各VM内で両方式の記録が一致し、Bash側の測定前後も一致した。Bash / Perlのruntime hashは準備時の固定値と一致した。VMのbinaryを取得して独立にhashを計算したものではない。

測定器6ファイルのSHA-256は、対象commitのGit blobから計算した値と両jobの記録が一致した。

| 測定器              | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| parent Python判定器 | `650bf8323a4699064f2a7cea32fc1fb5eef344f54a66408cf4b4d27007857c4e` |
| 既存Python capture  | `23733c4730bf653dbb6f03ea829d9b0b184e3c00d176dc72070164b18c5497f4` |
| Perl collector      | `b7fce1f8cb2ece6e10d3a373c4a798ba619c0baf0d66259d46852938c97b8319` |
| 既存Bash driver     | `495b7df6cb709088013e83e3d9df186ea72a76827585d9356c4bb86f6aecfe0f` |
| Bash直接driver      | `737d1f51bff4d2274b68ad302cd665320295aa79bcd8cb6b7b6200d34fd3554c` |
| Bash観測子・判定器  | `17814dbaec10da634a4abe3d46b76178a334dbe42c2bd75083803453bcac8a07` |

## 保存した証跡と結論の範囲

- [run.json](run.json): 公開run metadata14項目と、両比較job・スキップされた集約jobの全step結果。
- [observations.json](observations.json): [x64 job 135431143691](https://github.com/treflebonbon/skills/actions/runs/44486490046/job/135431143691) と [arm64 job 135431143165](https://github.com/treflebonbon/skills/actions/runs/44486490046/job/135431143165) の `[DEBUG-ns-uid]` JSON各21行・計42行の全値と掲載順、およびexit 1の終了行を保存した。
- 専用Nix/group準備・正式44件・監査・集約はスキップし、既存Bun setupを保持した。追加dispatch・新規install・Cビルド・root化・profile/sysctl変更・kernel journal検索・artifact取得/読取は行っていない。

UID mappingだけを指定したargvでも、今回の条件で同じEPERMが再現した。GID mappingとsetgroups指定を省いたargvでの観測だが、指定した数値が同じUIDに解決されたかは未確認である。これは指定したCLI操作の比較であり、実際のsyscall列やAppArmor拒否との直接因果を観測したものではない。[公開sourceの能力検査経路](../../../linux-namespace-capability-mapping.md) は整合する説明だが、完全なpackage版・loaded policyと直接因果は未確認である。

共通Bashと上位祖先、起動path、OS / LSMなどの条件は残る。Phase 2全体・原因確定・#33は未完了、#82待ち、macOS 15と全子孫5秒保証の未解決を維持する。条件は [再現ループ](../../../bun-process-linux-feedback-loop.md) で管理する。
