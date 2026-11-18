# Node経由とPython直接起動の比較記録

[run 44232172294 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44232172294) は、source / workflowを `e0ec91b8eca9f4e2faf440ed3d83fb66966b793e` に固定し、承認された `mode=probe-launch` を1回実行した。

両architectureとも結果は `node-not-required`。Node測定器を含む起動層を外した直接起動でも、同じUID mappingのEPERMが続いた。対象症状を検出した場合の予定どおりの終了コード1であり、正式実証や原因修正の成功ではない。

## 実測結果

共通Python親から、最初にNode.js 22.23.4の既存測定器で最小argvと成功対照を各3回測った。対象EPERMと対照の成功、caller条件の一致を確認してから、Python 3.12.3の `subprocess.Popen` による直接起動を各3回測った。

| architecture | 起動経路   | 最小argv  | 成功対照 |
| ------------ | ---------- | --------- | -------- |
| x64          | Node経由   | 3/3 EPERM | 3/3 成功 |
| x64          | Python直接 | 3/3 EPERM | 3/3 成功 |
| arm64        | Node経由   | 3/3 EPERM | 3/3 成功 |
| arm64        | Python直接 | 3/3 EPERM | 3/3 成功 |

最小argvは `--map-current-user -- /usr/bin/true`、対照は `-- /usr/bin/true`。最小argvの12回はexit 1・空stdoutと次のstderr全文を返した。対照12回はexit 0・空stdout/stderrで、全24回ともsignal・spawn error・ログ省略はなかった。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

Nodeの全6回が終わった後に直接起動が始まっており、probeのPID・時刻・monotonicな経過時間・終了状態を公開ログで照合した。

## 照合した条件

- 各VM内でNode測定器の親PIDと共通Python親PIDが一致した。x64はNode PID 2504 / Python親PID 2498、arm64はNode PID 2704 / Python親PID 2699。直接起動は同じPython親から行い、Node測定器をunshareの祖先に残さない。
- 両経路と測定前後でUID / EUID / GIDは1001。group・user/PID/mount namespace識別子・uid/gid map・callerのLSM context・capability / NoNewPrivs / Seccomp・選択した5環境変数が一致した。namespace識別子の一致は各VM内の比較で、別VM間の同一性を示すものではない。
- x64はUbuntu 24.04 image `20261111.127.1` / kernel `7.0.0-1014-aws`、arm64はimage `20261111.182.1` / kernel `7.0.0-1017-azure`。
- Node実体は `/usr/local/bin/node`、Python実体は `/usr/bin/python3.12`。各実体のSHA-256を[観測JSON](observations.json)に保存した。開始時と各測定のログ値の一致、測定器による終了時の同一性検査の完了を確認した。
- `/usr/bin/unshare` は両構成ともutil-linux 2.39.3。両経路で同じ実体だった。SHA-256はx64が `a23c8863860669003dc4660039fe642f5795c8c2195898ebc5d01afa1ac3d11c`、arm64が `e0c145c3d4c06686544b1362ed64da819539166a5e1e6fd96093aea4d2539b6a`。
- Python測定コードのSHA-256は `82fc566fb330b074aa0d447bc89c23a880487c10c8d63656479d2d8bc134db13`、Node測定コードは `dadacae60656e9988b700ea8cd52605a7ed17eb8528041bd3ad0b376cecf7544`。両構成のログ値が対象commitのblobと一致した。
- 専用Nix/group準備・正式44ケース・集約はスキップされた。既存Bun setupは保持し、追加の依存install・rootでのprobe・sysctl / profile変更・特権journal参照は行っていない。

## 設定と観測の区別

両経路は対象コードでunshareの `env` を `{}`、cwdを対象checkout、stdinを読み取り専用の `/dev/null`、stdout/stderrを匿名Unix socket対に設定する。時間上限5秒、stdout/stderr合計32MiBとし、超過時は所有する子へSIGKILLを送る。設定の一致は対象コードと契約fixtureで検証しており、実unshareの環境変数全件やfdの状態を直接ダンプしたとは扱わない。

ログ内の選択した5環境変数・capability・LSMはcallerの観測であり、空にしたunshare環境の値や、失敗したunshare自身の拒否時の状態ではない。

## 根拠と限界

[選択した公開JSON](observations.json)は各jobの16行ずつを保存し、JSON値と順序を公開ログと照合した。[run metadata](run.json)にはsource SHA・attempt・stepの終了状態を保存した。取得元は[x64の公開ログ](https://github.com/treflebonbon/skills/actions/runs/44232172294/job/134559609650)と[arm64の公開ログ](https://github.com/treflebonbon/skills/actions/runs/44232172294/job/134559609416)。artifactの取得・読取は行っていない。

この条件では、Node測定器を含む起動層は対象EPERMの再現に必須ではない。起動APIと追加process世代の個別効果は分離していない。Pythonを含む全caller・cwd・OS / LSMの影響を否定する結果ではなく、拒否原因を確定したとは扱わない。

Phase 2全体は未完了。#33未完了・#82待ち、macOS 15の方式保留と全子孫5秒保証の条件を維持する。
