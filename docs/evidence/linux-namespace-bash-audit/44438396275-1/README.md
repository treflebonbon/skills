# Bash最小argvの失敗PIDに対応するkernel監査

[run 44438396275 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44438396275) は、source / workflowを `dc16ae17848c68f9ea28e960d226aad4b3e16bec` に固定し、承認された `mode=probe-bash-audit` を1回実行した。refは `integration/python-to-bun`。実行と通常権限での検索範囲に加え、修正差分へのCodeRabbit追加評価が[回数制限で未完了](https://github.com/treflebonbon/skills/pull/87#issuecomment-6996705245)という制約を了承した承認後の1runである。

評価済み `127b7b0` の4項目成功と、その3指摘を修正した `dc16ae1` の未評価を区別する。修正前はFIFO入力の停止・検査後の追記受理・破損capture時の正常分欠落を再現し、修正後は関連10テスト・820 assertions、独立した仕様・規約レビュー各指摘0件、[通常CI全6ジョブ](https://github.com/treflebonbon/skills/actions/runs/44435623939)が成功した。3スレッドに返信・解決済み。artifactの取得・読取は行っていない。

確認済み（confirmed）: 両構成で通常callerによるcollectorが `collected` となり、失敗したBash最小argvのPID3件を各1回検索した。x64・arm64それぞれ2 PID、計4 PIDの時間窓で、`unprivileged_userns` へのprofile遷移と、同profileによる `sys_admin` 能力の `DENIED` を取得した。各構成の3件目は一致なしで、理由は未確定である。

## 比較と監査の結果

既存のPerl/Bash比較を完了してから、別stepでBash最小argvのPIDだけを検索した。

| architecture | 起動層                 | 最小argv  | 成功対照 |
| ------------ | ---------------------- | --------- | -------- |
| x64          | Perlのfork/exec        | 3/3 EPERM | 3/3 成功 |
| x64          | 共通Bashの直接子でexec | 3/3 EPERM | 3/3 成功 |
| arm64        | Perlのfork/exec        | 3/3 EPERM | 3/3 成功 |
| arm64        | 共通Bashの直接子でexec | 3/3 EPERM | 3/3 成功 |

最小argvは `--map-current-user -- /usr/bin/true`、対照は `-- /usr/bin/true`。計12回の最小argvはexit 1・空stdoutと次のstderr全文、計12回の対照はexit 0・空stdout/stderrだった。全24回にsignal・spawn error・ログ省略はなく、Bash側はwait statusがexit statusと一致し、観測子は全てexit 0だった。両構成の比較結果は `perl-layer-not-required` である。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

各VMでPerlの6回が終わってからBash直接側が始まり、12 PIDは重複しなかった。空環境・cwd `/`・閉鎖stdin・通常pipe・非root・各probe 5秒/合算32MiBを維持するsourceで実行した。実測の最大elapsedMsはx64が約1.93ms、arm64が約3.26ms。別に準備時のunshare版確認が各1回ある構成である。

| architecture | 対象PID | readerの結果         | 保存したイベント                      |
| ------------ | ------- | -------------------- | ------------------------------------- |
| x64          | 2524    | `matched`            | `AUDIT` 遷移1件・`DENIED` 能力拒否1件 |
| x64          | 2528    | `matched`            | `AUDIT` 遷移1件・`DENIED` 能力拒否1件 |
| x64          | 2532    | `no-matching-events` | この時間窓で一致なし                  |
| arm64        | 2632    | `matched`            | `AUDIT` 遷移1件・`DENIED` 能力拒否1件 |
| arm64        | 2636    | `matched`            | `AUDIT` 遷移1件・`DENIED` 能力拒否1件 |
| arm64        | 2640    | `no-matching-events` | この時間窓で一致なし                  |

一致した各PIDでは、`apparmor="AUDIT" operation="userns_create" profile="unconfined" target="unprivileged_userns"` と、`apparmor="DENIED" operation="capable" profile="unprivileged_userns" capability=21 capname="sys_admin"` を各1件保存した。遷移イベントには `execpath="/usr/bin/unshare"`、両イベントには対象PIDと `comm="unshare"` がある。PID 2524の拒否イベントのMESSAGE全文は次のとおり。

```text
audit: type=1400 audit(1795052304.794:134): apparmor="DENIED" operation="capable" class="cap" profile="unprivileged_userns" pid=2524 comm="unshare" capability=21  capname="sys_admin"
```

イベントの照合はMESSAGE内の一意な非引用 `pid=` と、probe開始/終了の前後1秒に限定したjournal時刻で行う。journalの `_PID` を対象PIDの代わりに使わない。保存したJSONは公開順を保持しており、イベント行の掲載順をそのまま操作の実行順とは扱わない。これはPIDと時間窓による対応であり、kernel監査でPID世代を証明したものではない。

## 通常権限の読取と固定条件

collectorは両構成ともUID/EUID/GID/EGID 1001。補助groupはx64が `[4,100,118,999,1001]`、arm64が `[4,100,117,999,1001]`。各VM内で、collectorのPID namespaceとgroupがBash callerの記録と一致した。

| architecture | 共通Bash PID | Perl PID | image            | kernel             |
| ------------ | ------------ | -------- | ---------------- | ------------------ |
| x64          | 2469         | 2494     | `20261111.370.1` | `7.0.0-1017-azure` |
| arm64        | 2577         | 2602     | `20261116.188.1` | `7.0.0-1017-azure` |

Bashは `/usr/bin/bash` の `5.2.21(1)-release`、Perlは `/usr/bin/perl` の `5.38.2`。Perlの祖先列から自身を除いたものがBash側と一致し、callerの資格情報・namespace・限定LSM項目・5環境変数は両方式と測定前後で一致した。callerのLSM表記は `unconfined`、AppArmor有効、`apparmor_restrict_unprivileged_userns=1` だった。callerの状態と、今回得た実unshareのPIDに対応する拒否イベントを分けて扱う。

読取は `/usr/bin/journalctl`、版は `systemd 255 (255.4-1ubuntu8.18)`。reader hashはx64が `0b08431236d5c8249b42994c00b401b3c093dee837e0465a53658057820d05b7`、arm64が `5b26f3b172aa9fd840e7938a8910499953e0ac0c261dd0c6e872fad24d9d14d8`。各VMの3読取で同じ実体/hash/版を記録した。検索argvは `--dmesg`、対象時間窓、MESSAGEのPIDを指定する `--grep`、JSONの3出力項目、`--no-pager --lines=101` で、sudoを経由していない。

kernel journal検索は合計6回、journalctl版確認も6回。各検索5秒・256KiB・101行で超過を検知し、最大20イベント・各MESSAGE 4096文字というsourceの上限を維持した。保存イベント8件は省略されていない。実際の検索窓は各約2秒で、承認上限の7秒以内だった。

通常権限で今回のイベントを読めたことは確認済みだが、全kernelログの可視性を保証しない。PID 2532と2640の `no-matching-events` は承認された窓でのreaderの分類であり、拒否や遷移が無かった証明ではない。未一致の原因、監査の抑制・遅延などの有無は未確認で、再検索・窓拡大・追加dispatchは行っていない。

## 出所と保存範囲

測定器6ファイル・collector・共有readerの計8ファイルについて、両jobの記録と対象commitのGit blobから計算したSHA-256が一致した。

| source path                                       | SHA-256                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `development/probe-linux-namespace-parent.py`     | `650bf8323a4699064f2a7cea32fc1fb5eef344f54a66408cf4b4d27007857c4e` |
| `development/probe-linux-namespace-launch.py`     | `3867eb6b09a0b2ebd72ded1c8045e6ceb9b2e5409825333f6ff25995cd949973` |
| `development/probe-linux-namespace-parent.pl`     | `b7fce1f8cb2ece6e10d3a373c4a798ba619c0baf0d66259d46852938c97b8319` |
| `development/probe-linux-namespace-parent.sh`     | `495b7df6cb709088013e83e3d9df186ea72a76827585d9356c4bb86f6aecfe0f` |
| `development/probe-linux-namespace-bash.sh`       | `44275855206e14f2b3a3e6e72a62b8a0c82be694e21862d4c36353df0ede0de4` |
| `development/probe-linux-namespace-bash.py`       | `c836c9587a98e8ed794c21937d8a9d4e67604e44289f2fd76361bb868197c513` |
| `development/probe-linux-namespace-bash-audit.ts` | `d6aa1976a6265b59ac794eede4e7f6820687c3b9b4bda7db1980f50c199f3ede` |
| `development/run-linux-process-proof.ts`          | `788519dddc4c8ca42553ffc73e0e17fcf588255e6892a332a752b01303aee166` |

unshareは `/usr/bin/unshare`、`util-linux 2.39.3`。実体hashはx64が `a23c8863860669003dc4660039fe642f5795c8c2195898ebc5d01afa1ac3d11c`、arm64が `e0c145c3d4c06686544b1362ed64da819539166a5e1e6fd96093aea4d2539b6a`。runtime hashは準備時の固定値と測定器の記録を照合したもので、VMのbinaryを取得して独立に再計算したものではない。

- [run.json](run.json): 公開run metadata 14項目、両jobとスキップされた集約jobのstep結果。
- [observations.json](observations.json): [x64 job 135272913180](https://github.com/treflebonbon/skills/actions/runs/44438396275/job/135272913180) と [arm64 job 135272913557](https://github.com/treflebonbon/skills/actions/runs/44438396275/job/135272913557) の選択した公開JSON。各jobの `records` は `[DEBUG-ns-bash]` の18行、`auditRecords` は `[DEBUG-ns-bash-audit]` の8行で、計52行の値と順序を保持。
- 専用Nix/group準備・正式44ケース・集約はスキップした。既存Bun setupを保持し、新規依存install・Cビルド・root化・sudo fallback・sysctl/profile変更は行っていない。環境全体やcommand lineを取得せず、artifactの取得・読取も行っていない。

両jobのfailureは、比較stepが対象症状を検出した場合の予定exit 1による。監査stepは両構成で成功した。正式44ケースや原因修正の成功には数えない。

今回、少なくとも4 PIDに対応する時間窓でAppArmorの能力拒否を直接確認できた。UID-map書込みまでの具体的な検査・syscallの因果関係、loaded policyの該当規則、残り2 PIDの未一致理由は未確定である。共通Bashと上位祖先、起動path、OS / LSMなどの残る固定条件を維持し、Phase 2全体・#33は未完了、#82は#33待ち、macOS 15と全子孫5秒保証も保留のままとする。次の切り分け条件は[再現ループ](../../../bun-process-linux-feedback-loop.md)で管理する。
