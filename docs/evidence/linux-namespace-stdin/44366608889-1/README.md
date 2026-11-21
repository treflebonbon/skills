# 同じPerl親でstdinだけを閉じた比較記録

[run 44366608889 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44366608889) は、source / workflowを `73e36ee75839ee9d4bba6329466256e303cade73` に固定し、承認された `mode=probe-stdin` を1回実行した。最新差分のCodeRabbit評価が[回数制限で未完了](https://github.com/treflebonbon/skills/pull/87#issuecomment-6987153450)という制約と、symlink環境を模す追加fixtureの再現が未確認である点を了承した承認後に実行した。評価済み `9cda5dc` との差分は文書とテストの2ファイルのみで、測定コードとworkflowは同一。修正差分の独立した仕様・規約レビューは各指摘0件、通常CI全6ジョブの成功を確認している。artifactの取得・読取は行っていない。

確認済み（confirmed）: x64・arm64とも結果は `stdin-devnull-not-required`。同じPIDのPerl親でstdinだけを読み取り専用 `/dev/null` からexec直前のfd 0閉鎖へ変えても、同じUID mappingのEPERMが続いた。runのfailureは、対象症状を検出した場合の予定終了コード1による。正式実証や原因修正の成功には数えない。

## 実測結果

両構成とも `/dev/null` baselineの最小argvと成功対照を各3回測り、正確なEPERMと対照成功を確認してから、同じPerl親の下でfd 0をexec直前に閉じる指定へ変えて各3回測った。

| architecture | stdinの指定              | 最小argv  | 成功対照 |
| ------------ | ------------------------ | --------- | -------- |
| x64          | 読み取り専用 `/dev/null` | 3/3 EPERM | 3/3 成功 |
| x64          | exec直前にfd 0を閉鎖     | 3/3 EPERM | 3/3 成功 |
| arm64        | 読み取り専用 `/dev/null` | 3/3 EPERM | 3/3 成功 |
| arm64        | exec直前にfd 0を閉鎖     | 3/3 EPERM | 3/3 成功 |

最小argvは `--map-current-user -- /usr/bin/true`、対照は `-- /usr/bin/true`。最小argvの12回はexit 1・空stdoutと次のstderr全文、対照12回はexit 0・空stdout/stderrを返した。全24回ともsignal・spawn error・ログ省略はなかった。各stdin条件のnamespace probe用fork数は6で、別に準備時のunshare版確認を1回/architecture行う構成である。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

各VMでbaselineの全6回が終わってから閉鎖側が始まった。probeのPID・開始/終了時刻・monotonicな経過時間を公開ログと照合し、全24回が各job内で完了し、各probeが5秒未満であることを確認した。公開JSONは後処理の出力順を保持しており、閉鎖側の6件がbaselineの6件より先に掲載されている。実行順の判断にはprobe自身の時刻を使った。

## 固定した条件

| architecture | 共通Bash PID | Perl PID | Perl版 | image            | kernel             |
| ------------ | ------------ | -------- | ------ | ---------------- | ------------------ |
| x64          | 2566         | 2587     | 5.38.2 | `20261111.127.1` | `7.0.0-1014-aws`   |
| arm64        | 2570         | 2591     | 5.38.2 | `20261111.182.1` | `7.0.0-1017-azure` |

各VMの両条件でPerlのPID・start time ticks・親PID、共通Bashと上位祖先列、runtimeのpath/版/hash、unshareの実体hashと版が一致した。PID 1のexeは両条件とも `EACCES` で、その観測を保持した。command lineや環境全体は読んでいない。

callerは両構成ともUID/EUID/GID 1001。補助groupはx64が `[4,100,117,999,1001]`、arm64が `[4,100,118,999,1001]`。各VM内では、namespace識別子・map・capability / NoNewPrivs / Seccomp・限定したLSM項目と5環境変数が、両条件と各測定前後で一致した。callerのLSM表記は `unconfined`、AppArmorは有効、`apparmor_restrict_unprivileged_userns` は `1`。これはcallerの観測であり、失敗したunshare自身の拒否時の状態とは扱わない。

namespace probeの設定は空環境 `{}`、cwd `/`、stdout/stderrは別々の匿名通常pipeで固定する。測定器のcwdは対象checkout。`stdinType` の `devnull` / `closed` はexec直前の指定方式で、実出力 `stdout` / `stderr` と区別する。fdの種類・flags・空環境・cwd・実子の親PIDはfixtureで検証し、実VMでは対象sourceに固定した測定器の設定として確認した。実unshareのfd・環境全件・cwd・拒否時LSMを直接dumpした証跡ではない。各probeの5秒・合算32MiB制限を維持している。

unshareは `/usr/bin/unshare`、`util-linux 2.39.3`。実体hashはx64が `a23c8863860669003dc4660039fe642f5795c8c2195898ebc5d01afa1ac3d11c`、arm64が `e0c145c3d4c06686544b1362ed64da819539166a5e1e6fd96093aea4d2539b6a`。runtime hashは測定器の記録と準備時の固定値を照合しており、VMのbinaryを取得して独立に再計算したものではない。

測定器4ファイルのSHA-256は、対象commitのGit blobから計算した値と両jobの記録が一致した。

| 測定器              | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| parent Python判定器 | `55a25c889d51ee055ab23afaa9f89555508163b321eb01569c06baf9df75963e` |
| 既存Python capture  | `3867eb6b09a0b2ebd72ded1c8045e6ceb9b2e5409825333f6ff25995cd949973` |
| Perl collector      | `c7068a8a69c9e5ffb96ffab2f766abc75bdeae4850d85ee89ea641ff746fba91` |
| Bash driver         | `495b7df6cb709088013e83e3d9df186ea72a76827585d9356c4bb86f6aecfe0f` |

## 保存した証跡と結論の範囲

- [run.json](run.json): 今回の公開metadata、両jobとスキップされた集約jobのstep結果。
- [observations.json](observations.json): [x64 job 135021924891](https://github.com/treflebonbon/skills/actions/runs/44366608889/job/135021924891) と [arm64 job 135021924080](https://github.com/treflebonbon/skills/actions/runs/44366608889/job/135021924080) の `[DEBUG-ns-stdin]` JSON行だけを選択。各job17行、計34行の値と順序を保持。
- 専用Nix/group準備・正式44ケース・集約はスキップ。既存Bun setupは保持し、新たな依存install・Cビルド・root化・sysctl/profile変更・特権journal参照は行っていない。artifactの取得・読取は行っていない。

今回のペアでは、stdinの読み取り専用 `/dev/null` 指定は再現に不要だった。過去の起動層比較とは別VM/imageであり、各ペア内で固定・照合した条件に結論を限定する。共通Bashと上位祖先、Perlの起動経路、OS / LSMなどの条件は残る。拒否原因の確定とPhase 2全体の完了は未認定。#33未完了、#82待ち、macOS 15と全子孫5秒保証を維持する。
