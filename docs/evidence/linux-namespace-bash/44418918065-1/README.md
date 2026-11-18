# 共通BashからPerlを経由せず直接起動した比較記録

[run 44418918065 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44418918065) は、source / workflowを `d358f8cab04c70cf3986f122b9df320bc4bcd60d` に固定し、承認された `mode=probe-bash` を1回実行した。直前 `0f7bffc` のCodeRabbit評価は4項目成功したが、その3指摘を直した `d358f8c` の追加評価は[回数制限で未完了](https://github.com/treflebonbon/skills/pull/87#issuecomment-6991028983)という制約を了承した承認後に実行した。

3指摘はstream記録不正時のwait結果保持、終了時snapshot失敗時の取得済みBash測定保持、テスト用パスのシェル展開で、同じ修正commitで対応・返信・解決した。修正前の再現と修正後の関連7テスト成功（692 assertions）、独立した仕様・規約レビュー各指摘0件、[通常CI全6ジョブの成功](https://github.com/treflebonbon/skills/actions/runs/44393308231)を確認している。artifactの取得・読取は行っていない。

確認済み（confirmed）: x64・arm64とも `perl-layer-not-required`。共通Bashとその上位祖先を保ち、Perlを含む起動層を外しても同じUID mappingのEPERMが続いた。runのfailureは、対象症状を検出した場合の予定終了コード1による。正式実証や原因修正の成功には数えない。

## 実測結果

Perl baselineの最小argvと成功対照を各3回測り、正確なEPERMと対照成功を確認した後、同じ共通Bashの直接子からexecする側を各3回測った。

| architecture | 起動層                 | 最小argv  | 成功対照 |
| ------------ | ---------------------- | --------- | -------- |
| x64          | Perlのfork/exec        | 3/3 EPERM | 3/3 成功 |
| x64          | 共通Bashの直接子でexec | 3/3 EPERM | 3/3 成功 |
| arm64        | Perlのfork/exec        | 3/3 EPERM | 3/3 成功 |
| arm64        | 共通Bashの直接子でexec | 3/3 EPERM | 3/3 成功 |

最小argvは `--map-current-user -- /usr/bin/true`、対照は `-- /usr/bin/true`。最小argvの計12回はexit 1・空stdoutと次のstderr全文、対照の計12回はexit 0・空stdout/stderrを返した。全24回にsignal・spawn error・ログ省略はなかった。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

両方式のnamespace probe用fork数は各6で、各VM内の12 PIDは重複しない。別に準備時のunshare版確認が1回/architectureある構成である。Bash側12回の `waitStatus` は各probeのexit statusと一致し、観測子の `observerStatus` は全て0だった。

各VMではPerl側の全6回が終わってからBash直接側が始まった。probeのPID・開始/終了時刻・monotonicな経過時間を公開ログと照合し、全24回が各job内で完了し、各probeが5秒未満であることを確認した。probe自身の `elapsedMs` の最大はx64が約1.66ms、arm64が約2.87ms。公開JSONの値と掲載順は保存したままで、実行順の判断にはprobe自身の時刻を使った。

## 固定した条件

| architecture | 共通Bash PID | Perl PID | image            | kernel             |
| ------------ | ------------ | -------- | ---------------- | ------------------ |
| x64          | 2486         | 2511     | `20261111.127.1` | `7.0.0-1014-aws`   |
| arm64        | 2571         | 2596     | `20261111.182.1` | `7.0.0-1017-azure` |

Bashは `/usr/bin/bash` の `5.2.21(1)-release`、Perlは `/usr/bin/perl` の `5.38.2`。Perlの祖先列からPerl自身を除いたものが、Bash直接側の祖先列と一致した。共通BashのPID・親PID・start time ticks・process group・sessionと上位祖先は各VM内で同じで、PID 1のexeは両側とも `EACCES` だった。command lineや環境全体は読んでいない。

Bash側はexec前のgateで取得した `childBefore` のPID・親PID・Bash実体・process group・sessionを照合し、観測子が保持したpidfdで対象を固定する。共通Bashと観測子のPIDは対象PIDと異なる。これはexec前のBash子の観測であり、失敗したunshare自身の拒否時LSMを観測したものではない。

callerは両構成ともUID/EUID/GID 1001。補助groupはx64が `[4,100,117,999,1001]`、arm64が `[4,100,118,999,1001]`。各VM内では、namespace識別子・map・capability / NoNewPrivs / Seccomp・限定したLSM項目と5環境変数が、両方式と各測定前後で一致した。callerのLSM表記は `unconfined`、AppArmorは有効、`apparmor_restrict_unprivileged_userns` は `1`。これを実unshareの拒否時の状態や拒否原因とは扱わない。

namespace probeの設定は空環境 `{}`、cwd `/`、exec直前に閉鎖するstdin、別々の匿名通常pipeであるstdout/stderrに固定する。測定器のcwdは対象checkout。fdの種類・flags・空環境・cwd・実子の親PIDはfixtureで検証し、実VMでは対象sourceに固定した測定器の設定として確認した。実unshareのfd・環境全件・cwd・拒否時LSMを直接dumpした証跡ではない。各probeの5秒・合算32MiB制限を維持している。

unshareは `/usr/bin/unshare`、`util-linux 2.39.3`。実体hashはx64が `a23c8863860669003dc4660039fe642f5795c8c2195898ebc5d01afa1ac3d11c`、arm64が `e0c145c3d4c06686544b1362ed64da819539166a5e1e6fd96093aea4d2539b6a`。各VMの両方式でruntimeとunshareのhashが一致し、Bash側の各probeではunshareの測定前後のhashも一致した。runtime hashは準備時の固定値と測定器の記録を照合したもので、VMのbinaryを取得して独立に再計算したものではない。

測定器6ファイルのSHA-256は、対象commitのGit blobから計算した値と両jobの記録が一致した。

| 測定器              | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| parent Python判定器 | `650bf8323a4699064f2a7cea32fc1fb5eef344f54a66408cf4b4d27007857c4e` |
| 既存Python capture  | `3867eb6b09a0b2ebd72ded1c8045e6ceb9b2e5409825333f6ff25995cd949973` |
| Perl collector      | `b7fce1f8cb2ece6e10d3a373c4a798ba619c0baf0d66259d46852938c97b8319` |
| 既存Bash driver     | `495b7df6cb709088013e83e3d9df186ea72a76827585d9356c4bb86f6aecfe0f` |
| Bash直接driver      | `44275855206e14f2b3a3e6e72a62b8a0c82be694e21862d4c36353df0ede0de4` |
| Bash観測子・判定器  | `cc5f26e3bab791fff0a9df17a3cfda1d778c2cae3388fa5076dcc184a122a039` |

## 保存した証跡と結論の範囲

- [run.json](run.json): 公開run metadata 14項目、両jobとスキップされた集約jobのstep結果。
- [observations.json](observations.json): [x64 job 135206426664](https://github.com/treflebonbon/skills/actions/runs/44418918065/job/135206426664) と [arm64 job 135206427062](https://github.com/treflebonbon/skills/actions/runs/44418918065/job/135206427062) の `[DEBUG-ns-bash]` JSON行だけを選択。各job18行、計36行の値と順序を保持。
- 専用Nix/group準備・正式44ケース・集約はスキップ。既存Bun setupは保持し、新規依存install・Cビルド・root化・sysctl/profile変更・特権journal参照は行っていない。artifactの取得・読取は行っていない。

今回のペアでは、共通Bashより下のPerlを含む起動層は再現に不要だった。起動API・process世代・Bash固有の子起動時の状態の個別効果は分離していない。過去の比較とは別VMであり、今回のペア内で固定・照合した条件に結論を限定する。共通Bashと上位祖先、`/usr/bin/unshare` という起動path、OS / LSMなどの条件は残る。拒否原因の確定とPhase 2全体の完了は未認定。#33未完了、#82待ち、macOS 15と全子孫5秒保証を維持する。次の切り分け条件は[再現ループ](../../../bun-process-linux-feedback-loop.md)で管理する。
