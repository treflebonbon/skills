# unshareの継承環境と空の環境の比較記録

[run 44218183339 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44218183339) は、source / workflowを `cf770549b4bc0052e95eb5066e8faac3382c7f3b` に固定し、承認された `mode=probe-environment` を1回実行した。

両architectureとも結果は `environment-not-required`。対象EPERMが続く場合の予定どおりの終了コード1で、Actions上のfailureは原因修正や正式実証の成功を意味しない。

## 実測結果

各VMでNode.js 22.23.4を固定し、unshareへ渡す `env` 引数だけを継承環境 / 空の環境 `{}` に変更した。同じ `spawnSync` API・cwd・stdio・timeout・出力上限で、最小argvと成功対照を各3回実行した。

| architecture | unshareの環境引数 | 最小argv  | 成功対照 |
| ------------ | ----------------- | --------- | -------- |
| x64          | 継承              | 3/3 EPERM | 3/3 成功 |
| x64          | 空                | 3/3 EPERM | 3/3 成功 |
| arm64        | 継承              | 3/3 EPERM | 3/3 成功 |
| arm64        | 空                | 3/3 EPERM | 3/3 成功 |

最小argvは `--map-current-user -- /usr/bin/true`、対照は `-- /usr/bin/true`。失敗12回はすべてexit 1・空stdoutと次のstderr全文を返し、対照12回はexit 0・空stdout/stderrだった。全24回でsignal・spawn error・ログ省略はなかった。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

空の環境という方式は、対象commitの `env: {}` と測定タグ `probeEnvironment: empty` に基づく。実unshareの環境変数全体は出力していない。契約fixtureでは子側の変数数と既知の非機密sentinelで、この入力が空になることを検証している。Nodeと測定器のCI継承環境は両条件で保持した。

## 照合した条件

- x64はUbuntu 24.04 image `20261111.127.1` / kernel `7.0.0-1014-aws`、arm64はimage `20261111.182.1` / kernel `7.0.0-1017-azure`。
- 各VM内でNodeの実行体path・SHA-256・版・親PIDは両条件で一致した。Node親PIDはx64が2476、arm64が2576。Node実体のSHA-256は[観測JSON](observations.json)に保存した。
- UID / EUID / GIDは1001。group・user/PID/mount namespace識別子・uid/gid map・callerのLSM context・capability / NoNewPrivs / Seccomp・選択した5環境変数は、各VM内の両条件間と測定前後で一致した。選択した環境変数はcaller側の観測で、空にしたunshare環境の値ではない。namespace識別子を別VMとの同一性の証明には使わない。
- `/usr/bin/unshare` は両構成ともutil-linux 2.39.3。各VM内の両条件で同じ実体だった。SHA-256はx64が `a23c8863860669003dc4660039fe642f5795c8c2195898ebc5d01afa1ac3d11c`、arm64が `e0c145c3d4c06686544b1362ed64da819539166a5e1e6fd96093aea4d2539b6a`。
- controller hashは両構成とも `dadacae60656e9988b700ea8cd52605a7ed17eb8528041bd3ad0b376cecf7544` で、対象commitのblobと一致した。
- 専用Nix/group準備・正式44ケース・集約はスキップされた。既存のBun setupは維持したが、今回のprobeはNodeから起動した。probeは非rootのままで、sysctl / profileを変更せず、特権journalも参照していない。

## 根拠と限界

[選択した公開JSON行](observations.json)には各jobの18行ずつを保存した。argv・PID・時刻・終了状態・stdout/stderrとcaller条件を照合した。[run metadata](run.json)には対象SHA・attempt・stepの終了状態を保存した。取得元は新しい[x64の公開ログ](https://github.com/treflebonbon/skills/actions/runs/44218183339/job/134513190110)と[arm64の公開ログ](https://github.com/treflebonbon/skills/actions/runs/44218183339/job/134513190477)。artifactの取得・読取は行っていない。

集約jobはskippedで、GitHub返却の開始時刻が終了時刻より1秒後になっている。`run.json`ではこの返却値をそのまま保存し、測定の時間計算には使っていない。

この条件では、unshareへの継承環境はUID mappingのEPERM再現に必須ではない。以後は空の環境を減らした再現条件として使える。個別の環境変数の効果や、Nodeの起動経路を含む全caller・OS / LSMの影響まで確定した結果ではない。観測したcapabilityとLSMはcallerの状態であり、失敗したunshare自身の拒否時の状態を観測したとは扱わない。

Phase 2全体と原因確定は未完了。#33は未完了、#82は#33待ち、macOS 15の方式と全子孫5秒保証の条件を維持する。
