# namespace作成を保ってmapping関連操作を省いた比較記録

[run 44458506354 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44458506354) は、source / workflowを `e25a535074c26f2520d1e09b4f9ac6cf26ff354c` に固定し、承認された `mode=probe-userns` を1回実行した。対象commitの独立した仕様・規約レビューは各指摘0件、[通常CI全6ジョブの成功](https://github.com/treflebonbon/skills/actions/runs/44451549835)、CodeRabbitの同じheadに対する4評価項目の成功と未解決0件を確認してから実行した。

確認済み（confirmed）: x64・arm64とも `id-mapping-required`。同じ共通Bashで `--map-current-user` は各3回同じUID-map EPERM、`--user` だけの対照は各3回成功した。今回の指定条件ではmapping関連操作が再現に必要だった。runのfailureは予定exit 1によるもので、正式実証や原因修正の成功には数えない。

## 実測結果

Perl baselineの最小argvと普通の対照を各3回測り、正確なEPERMと対照成功を確認した後、同じ共通Bashの直接子から最小argvとnamespace作成だけの対照を各3回測った。

| architecture | 起動層        | 最小argv  | 対照                             |
| ------------ | ------------- | --------- | -------------------------------- |
| x64          | Perl baseline | 3/3 EPERM | 普通の対照が3/3成功              |
| x64          | Bash直接      | 3/3 EPERM | namespace作成だけの対照が3/3成功 |
| arm64        | Perl baseline | 3/3 EPERM | 普通の対照が3/3成功              |
| arm64        | Bash直接      | 3/3 EPERM | namespace作成だけの対照が3/3成功 |

最小argvは両方式とも `--map-current-user -- /usr/bin/true`。Perlの対照は `-- /usr/bin/true`、Bashの対照は `--user -- /usr/bin/true`。最小argvの計12回はexit 1・空stdoutと次のstderr全文、対照の計12回はexit 0・空stdout/stderrを返した。全24回にsignal・spawn error・ログ省略はなかった。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

| architecture | 共通Bash PID | Perl PID | Bash最小argvのPID  | Bash対照のPID      | probe elapsedMsの範囲 |
| ------------ | ------------ | -------- | ------------------ | ------------------ | --------------------- |
| x64          | 2447         | 2472     | 2502 / 2506 / 2510 | 2515 / 2519 / 2523 | 約0.875〜1.868ms      |
| arm64        | 2577         | 2602     | 2632 / 2636 / 2640 | 2644 / 2648 / 2652 | 約0.920〜2.971ms      |

各VMの12 probe PIDは重複せず、全Perl probeが終了してからBash側を開始した。probeの時刻は各job内で、各probeは5秒未満だった。Bash側の `waitStatus` はexit statusと一致し、観測子の `observerStatus` は全て0。exec前の子PID・親PID・Bash実体・process group・sessionと、対象とは別の観測子PIDを照合した。namespace probeは12回/architecture・計24回で、別に準備時のunshare版確認が各1回ある構成である。

## 固定した条件と出所

| architecture | image            | kernel             | caller UID/EUID/GID | 補助group              |
| ------------ | ---------------- | ------------------ | ------------------- | ---------------------- |
| x64          | `20261111.370.1` | `7.0.0-1017-azure` | 1001                | `[4,100,118,999,1001]` |
| arm64        | `20261111.182.1` | `7.0.0-1017-azure` | 1001                | `[4,100,118,999,1001]` |

Bashは `/usr/bin/bash` の `5.2.21(1)-release`、Perlは `/usr/bin/perl` の `5.38.2`。Perl自身を除いた祖先列がBash側と一致し、共通BashのPID・親PID・start time ticks・process group・sessionと上位祖先は各VM内で同じだった。PID 1のexeは両側とも `EACCES`。各VM内では、測定前後と両方式のcaller資格情報、namespace識別子、map、capability / NoNewPrivs / Seccomp、限定LSM項目、5環境変数も一致した。環境全体とcommand lineは読んでいない。

callerのLSM表記は `unconfined`、AppArmorは有効、`apparmor_restrict_unprivileged_userns` は `1`。これらはcallerの観測であり、実unshareの拒否時LSMやloaded policy全内容の証明ではない。今回はjournalを検索しておらず、前回runの監査イベントと今回のPIDを対応させない。

namespace probeの設定は空環境、cwd `/`、exec直前のfd 0閉鎖、stdout/stderrの別々の匿名通常pipeとflags、5秒・合算32MiB制限を維持した。fd・環境・cwdの設定は固定sourceと実子fixtureで検証しており、実unshareのfd・環境全件・拒否時状態を直接dumpしたものではない。`childBefore` はexec前のBash子の観測である。

unshareは `/usr/bin/unshare`、`util-linux 2.39.3`。実体hashはx64が `a23c8863860669003dc4660039fe642f5795c8c2195898ebc5d01afa1ac3d11c`、arm64が `e0c145c3d4c06686544b1362ed64da819539166a5e1e6fd96093aea4d2539b6a`。各VM内で両方式のunshare記録が一致し、Bash側の測定前後のhashも一致した。Bash/Perlのruntime hashは準備時の固定値と一致する。VMのbinaryを取得して独立にhashを計算したものではない。

測定器6ファイルのSHA-256は、対象commitのGit blobから計算した値と両jobの記録が一致した。

| 測定器              | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| parent Python判定器 | `650bf8323a4699064f2a7cea32fc1fb5eef344f54a66408cf4b4d27007857c4e` |
| 既存Python capture  | `23733c4730bf653dbb6f03ea829d9b0b184e3c00d176dc72070164b18c5497f4` |
| Perl collector      | `b7fce1f8cb2ece6e10d3a373c4a798ba619c0baf0d66259d46852938c97b8319` |
| 既存Bash driver     | `495b7df6cb709088013e83e3d9df186ea72a76827585d9356c4bb86f6aecfe0f` |
| Bash直接driver      | `505ea2682249afb7b59b11560a19a2cc5008ca36f49e08aa6db4346f385f6339` |
| Bash観測子・判定器  | `7dfee8780a4b2cc4b9bdd7680391cebf31fe5fe72eedef4e9af6180e1163333b` |

## 保存した証跡と結論の範囲

- [run.json](run.json): 公開run metadata 14項目と、両job・スキップされた集約jobのstep結果。
- [observations.json](observations.json): [x64 job 135339321024](https://github.com/treflebonbon/skills/actions/runs/44458506354/job/135339321024) と [arm64 job 135339321297](https://github.com/treflebonbon/skills/actions/runs/44458506354/job/135339321297) の `[DEBUG-ns-userns]` JSON各18行・計36行を選び、全値と掲載順を保持した。各jobのexit 1を示す公開終了行も保存した。
- 専用Nix/group準備・正式44ケース・集約・Bash監査stepはスキップした。既存Bun setupを保持し、新規install・Cビルド・root化・profile/sysctl変更・kernel journal検索・artifactの取得/読取は行っていない。追加dispatchも行っていない。

namespace作成だけの対照は今回の両構成で成功した。比較から省いたのはUID/GID mappingとsetgroupsの指定をまとめた操作であり、UID書込みだけを単独で除く実験ではない。公開sourceとの [能力検査経路の対応](../../../linux-namespace-capability-mapping.md) は観測と整合するが、実VMの完全なpackage版・loaded policy・当該write syscallとの直接因果は未確認である。

共通Bashと上位祖先、起動path、OS / LSMなどの条件は残る。原因確定とPhase 2全体の完了は未認定。#33未完了、#82待ち、macOS 15と全子孫5秒保証の未解決を維持する。次の切り分け条件は [再現ループ](../../../bun-process-linux-feedback-loop.md) で管理する。
