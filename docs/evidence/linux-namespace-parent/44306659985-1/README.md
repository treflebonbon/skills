# Python測定器を含む起動層を外した比較記録

[run 44306659985 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44306659985) は、source / workflowを `a5fc890c9cd94d1df5a43cf143625c18ad2e9d1e` に固定し、承認された `mode=probe-parent` を1回実行した。測定追加 `dec76e9` へのCodeRabbitの11件の指摘は `a5fc890` で修正・返信・解決済み。修正差分の独立した仕様・規約レビューと通常CI全6ジョブの成功を確認した上で、[最新差分のCodeRabbit評価が回数制限で未完了](https://github.com/treflebonbon/skills/pull/87#issuecomment-6977086733)という制約を了承した承認後に実行した。artifactの取得・読取は行っていない。

両architectureとも結果は `python-layer-not-required`。共通Bashの下でPython測定器を含む起動層を外し、Perlのfork/execに変えても同じUID mappingのEPERMが続いた。症状を検出した場合の予定どおりの終了コード1であり、正式実証や原因修正の成功ではない。

## 実測結果

Python baselineの最小argvと成功対照を各3回測り、同じEPERMと対照の成功を確認した後、Pythonを子の祖先に挟まないPerl siblingから各3回測った。共通Bashが各測定器の終了を待って、順に実行した。Python祖先とPython固有の起動API・process世代を一つの起動層として比較しており、それぞれの効果を分離した実験ではない。

| architecture | 起動層        | 最小argv  | 成功対照 |
| ------------ | ------------- | --------- | -------- |
| x64          | Python 3.12.3 | 3/3 EPERM | 3/3 成功 |
| x64          | Perl 5.38.2   | 3/3 EPERM | 3/3 成功 |
| arm64        | Python 3.12.3 | 3/3 EPERM | 3/3 成功 |
| arm64        | Perl 5.38.2   | 3/3 EPERM | 3/3 成功 |

最小argvは `--map-current-user -- /usr/bin/true`、対照は `-- /usr/bin/true`。最小argvの12回はexit 1・空stdoutと次のstderr全文を返した。対照12回はexit 0・空stdout/stderrで、全24回ともsignal・spawn error・ログ省略はなかった。各architectureのPerl側のnamespace probe用fork数は6で、追加の版確認起動は行わず、baselineの版表記を同一のunshare実体hashと照合して引き継いだ。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

各VMでPython側の全6回が終わってからPerl側が始まった。probeのPID・時刻・monotonicな経過時間・終了状態を公開ログと照合し、全24回が各jobの開始・完了時刻内にあることを確認した。step metadataは秒精度、probeの時刻はミリ秒精度なので、stepについてはmetadataが示す秒の区間と照合した。

## 共通親と固定した条件

| architecture | 共通Bash PID | Python PID | Perl PID | image            | kernel             |
| ------------ | ------------ | ---------- | -------- | ---------------- | ------------------ |
| x64          | 2647         | 2652       | 2674     | `20261111.370.1` | `7.0.0-1017-azure` |
| arm64        | 2571         | 2576       | 2598     | `20261111.182.1` | `7.0.0-1017-azure` |

両測定器の親PIDは各VMの共通Bashに一致し、BashのPID・start time ticks・process group・sessionと、その上位の祖先列も一致した。測定器自身のPIDとstart time ticksは異なる。PID 1のexeは両条件とも `EACCES` であり、その観測を保持した。command lineや環境全体は読んでいない。

両測定器のcallerはUID/EUID/GID 1001、補助group `[4,100,118,999,1001]`。namespace識別子・map・capability / NoNewPrivs / Seccomp・限定したLSM項目と5環境変数は、Python/Perl間とそれぞれの測定前後で一致した。callerのLSM表記は `unconfined`、AppArmorは有効、`apparmor_restrict_unprivileged_userns` は `1`。これはcallerの観測であり、失敗したunshare自身の拒否時の状態とは扱わない。

namespace probeの設定は空環境 `{}`、cwd `/`、読み取り専用 `/dev/null` stdin、stdout/stderrは別々の匿名の通常pipe。測定器のcwdは対象checkout。種類・flags・空環境・実子の親PIDはfixtureで観測し、実VMでは同じsourceに固定した測定器の設定として確認した。実unshareのfd・環境全件・cwd・拒否時LSMを直接dumpした証跡ではない。各probeの5秒・合算32MiB制限を維持している。

unshareは両構成とも `/usr/bin/unshare`、`util-linux 2.39.3`。Python/Perl間で同じ実体hashを確認した。

| architecture | unshare SHA-256                                                    |
| ------------ | ------------------------------------------------------------------ |
| x64          | `a23c8863860669003dc4660039fe642f5795c8c2195898ebc5d01afa1ac3d11c` |
| arm64        | `e0c145c3d4c06686544b1362ed64da819539166a5e1e6fd96093aea4d2539b6a` |

測定器4ファイルのSHA-256を対象commitのGit blobから計算し、両jobの記録と一致することを確認した。

| 測定器              | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| parent Python判定器 | `013562b76677b9bcb4906bde966b650a1197c34af8d94da947a7ccf4443c8c91` |
| 既存Python capture  | `5c241261172a32a8d35c0c1af0ce05f265b19afc7191d9f35a86264e27eaf11a` |
| Perl collector      | `8f7b4972cceb62eec8fb690e08c5c7fbad8946e1390b65d705737eb79602efc6` |
| Bash driver         | `bfe611fcc0276948b023bc46daa37dc63e6d74c61c132e1d25ac64c04bdf2bee` |

runtimeの実体path・版・hashは [observations.json](observations.json) に保存した。実VMのbinaryを取得して独立に再計算したものではなく、各測定器の記録と、後処理が固定したruntime hashを照合した。

## 保存した証跡と結論の範囲

- [run.json](run.json): 新しいrunの公開metadata、両jobと集約jobのstep結果。
- [observations.json](observations.json): [x64 job 134809886080](https://github.com/treflebonbon/skills/actions/runs/44306659985/job/134809886080) と [arm64 job 134809886508](https://github.com/treflebonbon/skills/actions/runs/44306659985/job/134809886508) の公開ログから `[DEBUG-ns-parent]` のJSON行だけを選択。各job17行、合計34行。
- 専用Nix/group準備・正式44ケース・集約はスキップ。既存Bun setupは保持し、新たな依存install・Cビルド・root化・sysctl/profile変更・特権journal参照は行っていない。artifactの取得・読取と、過去に拒否された一時ログへのアクセスは行っていない。

今回のペアでは、共通Bashより下のPython測定器を含む起動層は再現に不要だった。過去のstderr比較とは別VM/imageの測定であり、各ペア内で固定・照合した条件に結論を限定する。stdin、共通Bashと上位祖先、Perlの起動経路、OS / LSMなどの条件は残る。拒否原因の確定とPhase 2全体の完了は未認定。#33未完了、#82待ち、macOS 15と全子孫5秒保証を維持する。
