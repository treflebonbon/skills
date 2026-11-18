# stdoutのsocketと通常pipeの比較記録

[run 44257860176 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44257860176) は、source / workflowを `811325e67d5be4b9d50ea3d3aa3f98d82efb7065` に固定し、承認された `mode=probe-stdout` を1回実行した。

両architectureとも結果は `stdout-socket-not-required`。今回の条件ではstdoutだけを通常pipeに変えても、同じUID mappingのEPERMが続いた。対象症状を検出した場合の予定どおりの終了コード1であり、正式実証や原因修正の成功ではない。

## 実測結果

同じPython 3.12.3親から、最初にstdoutが匿名Unix socketの条件で最小argvと成功対照を各3回測った。同じEPERM・対照の成功とcaller条件の一致を確認してから、stdoutだけを通常pipeに変えて各3回測った。

| architecture | stdoutの指定方式 | 最小argv  | 成功対照 |
| ------------ | ---------------- | --------- | -------- |
| x64          | 匿名Unix socket  | 3/3 EPERM | 3/3 成功 |
| x64          | 通常pipe         | 3/3 EPERM | 3/3 成功 |
| arm64        | 匿名Unix socket  | 3/3 EPERM | 3/3 成功 |
| arm64        | 通常pipe         | 3/3 EPERM | 3/3 成功 |

最小argvは `--map-current-user -- /usr/bin/true`、対照は `-- /usr/bin/true`。最小argvの12回はexit 1・空stdoutと次のstderr全文を返した。対照12回はexit 0・空stdout/stderrで、全24回ともsignal・spawn error・ログ省略はなかった。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

各VMでsocket側の全6回が終わってからpipe側が始まった。probeのPID・時刻・monotonicな経過時間・終了状態を公開ログと照合し、各測定jobの開始・完了時刻内にあることを確認した。

## 照合した条件

- 両条件の記録でPython親のPID・親PID・実行体・版・hashが一致した。x64はPython PID 2507 / 親PID 2506、arm64はPython PID 2578 / 親PID 2577。実体は `/usr/bin/python3.12`。Node測定器をunshareの祖先に置かず、同じPython親から直接起動する。
- 両条件とも対象のcwd指定は `/`。親Python自身のcwdは対象checkoutに保持する。namespace probeへ渡す環境は `{}`、stderrは匿名Unix socket、stdinは読み取り専用の `/dev/null` とする。
- 両条件と測定前後でUID / EUID / GIDは1001。group・user/PID/mount namespace識別子・uid/gid map・callerのLSM context・capability / NoNewPrivs / Seccomp・選択した5環境変数が一致した。namespace識別子の一致は各VM内の比較で、別VM間の同一性を示すものではない。
- x64はUbuntu 24.04 image `20261111.127.1` / kernel `7.0.0-1014-aws`、arm64はimage `20261111.182.1` / kernel `7.0.0-1017-azure`。
- Python実体のSHA-256はx64が `e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f`、arm64が `c86f21d0da9290ece2d7d49a3f7ed52aed59cb029abdf0ea25c79634f6cbe960`。各VMで開始時と両測定のログ値が一致し、測定器の終了時検査も完了した。
- `/usr/bin/unshare` は両構成ともutil-linux 2.39.3。両条件で同じ実体だった。SHA-256はx64が `a23c8863860669003dc4660039fe642f5795c8c2195898ebc5d01afa1ac3d11c`、arm64が `e0c145c3d4c06686544b1362ed64da819539166a5e1e6fd96093aea4d2539b6a`。
- 測定コードのSHA-256は `721b17e8f80b1a6ed7cbf022848b5c2a463bdcbef697cc93ce04483834d5cad8`。両構成のログ値が対象commitのblobと一致した。
- 専用Nix/group準備・正式44ケース・集約はスキップされた。既存Bun setupは保持し、追加の依存install・rootでのprobe・sysctl / profile変更・特権journal参照は行っていない。

## 設定と観測の区別

[対象コード](https://github.com/treflebonbon/skills/blob/811325e67d5be4b9d50ea3d3aa3f98d82efb7065/development/probe-linux-namespace-launch.py)は同じ `subprocess.Popen` を使い、pipe側だけstdoutを `subprocess.PIPE` に指定する。stdoutの種類とそれに伴うfd 1のアクセスモードが変わり、他stdioの種類とflagsは保持する。時間上限5秒、stdout/stderr合計32MiBとし、超過時は所有する子へSIGKILLを送る。実行体の `--version` 確認は両条件とも従来どおり継承環境・stdout socketで行う。

ログの `stdoutType` / `workingDirectory` は指定方式・cwdのタグである。空環境・cwd・stdoutのFIFO/socket判定・他stdioの種類とflagsの設定一致は対象コードと実子プロセスの契約fixtureに基づくもので、実unshareのfd・cwd・環境変数全件を直接dumpしたとは扱わない。`stdoutType` と実際の出力 `stdout` は別々に記録した。ログ内の選択した5環境変数・capability・LSMはcallerの観測であり、空にしたunshare環境の値や、失敗したunshare自身の拒否時の状態ではない。

## 根拠と限界

[選択した公開JSON](observations.json)は各jobの16行ずつを保存し、JSON値と順序を公開ログと照合した。[run metadata](run.json)にはsource SHA・attempt・stepの終了状態を保存した。取得元は[x64の公開ログ](https://github.com/treflebonbon/skills/actions/runs/44257860176/job/134643778022)と[arm64の公開ログ](https://github.com/treflebonbon/skills/actions/runs/44257860176/job/134643778389)。artifactの取得・読取は行っていない。

GitHub提供のスキップ済み集約jobでは、開始 `2026-11-18T07:18:52Z` に対して完了 `2026-11-18T07:18:51Z` が1秒早い。提供されたmetadataをそのまま保持し、このjobの時刻はprobeの時間計算に使わない。測定jobと各probeの時刻・monotonicな経過時間は別に照合した。

今回の条件ではstdoutの匿名Unix socketは対象EPERMの再現に必須ではなく、以後はstdoutを通常pipeにした再現条件へ縮められる。stderr・stdin・Pythonを含む全caller・OS / LSMの影響を否定する結果ではなく、拒否原因を確定したとは扱わない。

Phase 2全体は未完了。#33未完了・#82待ち、macOS 15の方式保留と全子孫5秒保証の条件を維持する。
