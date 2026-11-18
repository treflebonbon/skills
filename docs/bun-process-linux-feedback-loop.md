# Linux namespace の再現ループ

状態: [run 44078199627 / attempt 1](evidence/linux-namespace-loop/44078199627-1/README.md) でx64 / arm64各3回、同じEPERMを再現した。前提検査は1回約0.22〜0.49秒で、Phase 1は確認済み。最新の[stdout比較](evidence/linux-namespace-stdout/44257860176-1/README.md)ではPython直接起動・空環境・cwd `/` のままstdoutだけを通常pipeに変えても同じEPERMを再現した。Phase 2の最小化と原因の確定は未完了。[run 44049468642 / attempt 1](evidence/linux-process-proof/44049468642-1/README.md) の失敗記録と [ADR 0003](adr/0003-os-specific-preparation-containment.md) の条件を引き継ぐ。

## 測る対象

実測した失敗は、非rootの `/usr/bin/unshare` が次のargvで `uid_map` 書込みの EPERM を返すもの。

```text
--user --map-current-user --pid --fork --kill-child=SIGKILL --mount-proc -- /usr/bin/true
```

2026-11-17 に手元の保護wrapper内で同じargvを3回実行すると、約3〜4ミリ秒で3回とも成功した。選択実体のSHA-256は前回x64 VMと同じだったが、手元はkernel `6.18.58.1-microsoft-standard-WSL2`、UID / EUID `1000`、外側の `uid_map` は `1000 0 1`、AppArmorは無効だった。この結果はCIのEPERMの再現ではない。

## 同じ準備のあとに繰り返す入口

`development/run-linux-process-proof.ts` の `probe-loop SOURCE OUTPUT` は、正式実証と同じ `preflight` を3回呼ぶ。各回のprobeのargv・非root条件・継承環境・出力上限・timeoutを維持し、同じVM内で測る。rootや別OSではprobeを実行せず停止する。

```bash
bun control/development/run-linux-process-proof.ts probe-loop "$GITHUB_WORKSPACE/subject" "$RUNNER_TEMP/linux-proof"
```

source / workflow / run / attemptの環境変数、固定版Nix、補助group fixtureなどの準備は、既存workflowのまま必要になる。準備後の反復時間は `elapsedMs` に記録し、実測してから速さを判断する。手元の成功や、toolを置き換えたCLI契約テストだけでPhase 1を完了にしない。

| 終了コード | 結果            | 意味                                                                           |
| ---------- | --------------- | ------------------------------------------------------------------------------ |
| `0`        | `passed`        | 3回とも同じ前提検査が成功                                                      |
| `1`        | `uid-map-eperm` | 3回とも前回と同じUID mappingのEPERMを検知                                      |
| `1`        | `inconsistent`  | 成功と対象のEPERMが混在し、安定したループとしては未達                          |
| `2`        | `unavailable`   | 別の失敗、他の前提不足、入力不正、source変更など。対象のバグの再現には数えない |

別の前提不足が見つかれば、その回で測定を止める。対象のEPERMと認めるには、probeのexit 1と該当stderrに加え、他の前提検査エラーがないことを要求する。

出力は `namespace-loop.json`。各回のPID・時刻・終了状態・stderr・既存の限定audit、callerと前提条件、source hashを保存する。標準出力は `[DEBUG-ns-loop]` の分類と時間に限定する。既存の同名結果ファイルは上書きしない。

## 手動workflowの診断モード

既存の `linux-process-proof.yml` に `mode=probe-loop` を指定すると、x64 / arm64で前回と同じ準備を行い、上のコマンドを実行する。省略時の既定値は `proof` で、正式な44ケース×3反復の経路を維持する。

診断モードは集約jobを実行せず、artifact名を `namespace-loop-<run>-<attempt>-<arch>`、run名を `Linux namespace 再現ループ: <source SHA>` とする。正式実証のartifact・履歴は既存の正式名だけを受理するため、診断モードの成功を正式実証へ加えない。テストでこの区別も確認する。

GitHubは手動workflowのdefault branchへの登録を要求するため、既に登録済みのworkflowを使う。branchの版は `--ref` で選択できる。[GitHubの手動実行仕様](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)を参照。

実際のdispatchと、このrunのartifact取得は、具体的なsource SHAとコマンドを示して事前確認する。以前の1回実行の承認を、新しい実行へ流用しない。

## まだ確認していないこと

fork後の子PIDとの対応付け、子側の拒否イベントと実際のpolicyは未確認。現在のaudit取得範囲は起動した親PIDのままで、子の情報を観測したとは扱わない。

実際の症状で赤になる短いループは確認できた。次に再現条件を一つずつ減らし、最小化が済んでから原因仮説や修正の検証へ進む。診断モードで3回成功しても、44ケースの互換性や全子孫5秒保証の成功には数えない。#33は未完了、#82は#33待ち、macOS 15の方式は保留を維持する。

## Phase 2: namespaceオプションの削減入口

`probe-minimize SOURCE OUTPUT` とworkflowの `mode=probe-minimize` は、承認済み [run 44091500711 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44091500711)で実行した。公開Actionsログでは両構成とも元の3回＋削減11組×3回、計36回を確認した。最終3回はすべて `uid-map-eperm`、直前の対照3回はすべて `passed`。固定版コードとログから残るargvを `--map-current-user -- /usr/bin/true` と推定できるが、取得済みartifactのJSON読取は自動承認レビューに拒否され、argv・stderr・PID・auditの直接照合は未完了。最初に従来の `preflight` を3回測り、他の前提エラーがなく3回とも対象EPERMになる場合だけ削減へ進む。

元の6オプションから一つだけ外し、同じ選択実体・継承環境・非root callerで各候補を3回実行する。3回とも同じstderr全文・exit 1の場合だけ削減を採用して先頭から試し直す。成功した候補は採用せず、別エラーも成功には数えない。候補の3反復が混在する、timeoutなどで完了しない場合は停止する。最後に残った条件でEPERMを3回再確認する。

残る各オプションを外すと3回とも成功し、残した条件は3回ともEPERMなら、`minimization.outcome = minimal-options`。別エラーのまま残ったオプションがあれば `incomplete`、観測不足や混在なら `unavailable` として終了コード2にする。対象EPERMが続く `minimal-options` は終了コード1であり、原因修正の成功ではない。元の前提検査が3回とも成功なら削減せず終了コード0。

候補は最大21組、最後の確認1組、最初の前提検査3回を合わせ最大69回のprobeに限る。結果は `namespace-minimize.json`、artifactは `namespace-minimize-<run>-<attempt>-<arch>`、run名は `Linux namespace オプション削減: <source SHA>`。各argv・PID・時刻・終了状態・限定auditを記録する。正式実証の集約はスキップする。

これは6オプションに限った1個ずつの削減確認であり、再現条件全体の最小化完了ではない。実行体、LSM、非root条件、継承環境、workflow準備、終了用の `-- /usr/bin/true` は固定する。任意コマンドやshellの実行へ広げず、sysctl / profileを変更しない。次の実測結果で、準備・caller・環境をさらに削減できるか判断する。原因仮説へ進む前に、残った固定条件の根拠も確認する。

```bash
bun control/development/run-linux-process-proof.ts probe-minimize "$GITHUB_WORKSPACE/subject" "$RUNNER_TEMP/linux-proof"
```

追加dispatchと生成runのartifact取得は、新しいsource SHAを示して事前に確認する。

## 次の独立測定: 専用準備stepを省く

`probe-isolate SOURCE OUTPUT` とworkflowの `mode=probe-isolate` を追加した。これは新しい測定であり、以前拒否されたartifactを読み取らない。[run 44185969872 / attempt 1](evidence/linux-namespace-isolate/44185969872-1/README.md) でx64 / arm64とも9回を測定し、元argvと最小候補は各3回EPERM、対照は各3回成功した。新しい公開ログでargv・stderrを直接確認済み。原因確定とPhase 2全体の完了は未認定。

既存workflowの「CI専用依存と補助groupを準備」という1つのstepを省略する。Bun 1.4.4・Ubuntu 24.04・非rootは維持し、同じ選択実体で次を各3回、計9回測る。

| case       | argv                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------- |
| `original` | `--user --map-current-user --pid --fork --kill-child=SIGKILL --mount-proc -- /usr/bin/true` |
| `minimal`  | `--map-current-user -- /usr/bin/true`                                                       |
| `control`  | `-- /usr/bin/true`                                                                          |

新しいVMで先行ログの最小候補を直接確認する実験。省略した準備stepの内部にあるNixとgroup準備の個別効果を分離する測定ではない。準備step全体が再現に必須かを確認し、原因確定やPhase 2全体の完了とは扱わない。sysctl / profile / LSMを変更せず、特権journalも参照しない。

`/nix`・`/etc/nix/nix.conf`と専用準備が設定する5環境変数がある場合は開始しない。run / source / workflow、controller hash、選択実行体のpath・hash・版、caller・image・kernel・限定したnamespace / LSM contextを確認する。

| 終了コード | 結果                      | 意味                                                                            |
| ---------- | ------------------------- | ------------------------------------------------------------------------------- |
| `1`        | `minimal-argv-reproduced` | 元argvと最小候補が各3回同じUID mappingのEPERMで、対照は3回成功                  |
| `0`        | `not-reproduced`          | 3caseすべて3回成功し、この独立条件では対象の失敗を再現しなかった                |
| `2`        | `unavailable`             | 別エラー、混在、前提不足、source / 実行体の変化などで上記の条件を満たさなかった |

新しい各測定のargv・PID・時刻・経過時間・終了状態・stdout / stderr・分類は `[DEBUG-ns-isolate]` のJSON行で公開Actionsログへ記録する。stdout / stderrのログ表示は各1024文字までで、省略時は `logTruncated` を記録し、完全なprobe記録は `namespace-isolate.json` に残す。環境変数全体や認証値は出力しない。既存の同名結果は上書きしない。

run名は `Linux namespace 独立測定: <source SHA>`、artifact名は `namespace-isolate-<run>-<attempt>-<arch>`。正式44ケース・集約・正式履歴への採用は行わない。次の実行承認は新しいsource SHAと各構成9回の範囲に固定する。結果の一次確認は許可済みのActionsログで行う。以前のartifactの読取拒否や、今回のartifact読取可否を解消したとは扱わない。

## 次の最小化: Bun callerを外す

[run 44199074826 / attempt 1](evidence/linux-namespace-caller/44199074826-1/README.md) で、両構成ともBunとNodeの最小argvが各3回同じEPERM、対照が各3回成功した。この条件でBunは再現に必須ではない。継承環境全体とOS / LSMなどの最小化・原因確定は未完了。

`mode=probe-caller` はNode.jsを比較の親として、同じ `development/probe-linux-namespace-caller.mjs` をBun 1.4.4とrunner導入済みNode.js（22以上）で順番に起動する。Node.js側にはBunを祖先として残さない。新しい依存のinstallは行わない。専用Nix/group準備は省略し、両runtimeへ同じ親の継承環境を渡す。環境変数全体や認証値は保存しない。

各runtimeは同じ `spawnSync` API・cwd・stdio・timeout・出力上限で、最小argv `--map-current-user -- /usr/bin/true` と対照 `-- /usr/bin/true` を各3回実行する。最大12回/architecture。前の独立測定とは起動APIも異なるため、Bun側で同じEPERMを再確認することを比較の前提とする。

UID・EUID・GID・group、capability / NoNewPrivs / Seccomp、user / pid / mount namespaceの識別子、uid/gid map、callerのLSM context、選択した5環境変数を測定前後と両runtime間で照合する。これは継承環境全体の最小化や全変数の同一性の実測を意味しない。controllerと実行体のpath・hash・版、source/workflow/run/attempt、image/kernelも保存する。sysctl・profileは変更しない。

| 結果               | 条件                                                     | 終了コード |
| ------------------ | -------------------------------------------------------- | ---------- |
| `bun-not-required` | 両runtimeで最小argvが3/3同じEPERM、対照が3/3成功         | 1          |
| `caller-dependent` | Bunの最小argvだけが3/3同じEPERM、Node側と両対照が3/3成功 | 1          |
| `not-reproduced`   | 全12回が成功                                             | 0          |
| `unavailable`      | 条件の不一致、別エラー、混在、観測不足                   | 2          |

`bun-not-required` はこの比較にBunが必須ではないという結果であり、原因確定やPhase 2全体の完了ではない。`caller-dependent` でもruntime内部のどの差が必要かは未確定とする。

新規の `namespace-caller.json` と `caller-bun.json` / `caller-node.json` を上書きせず0600で保存する。各probeのargv・PID・時刻・終了状態・stderrは `[DEBUG-ns-caller]` のJSON行で記録し、stdout/stderrは各1024文字まで、省略時は `logTruncated` を示す。run名・artifact名を正式実証と分け、44ケースと集約は実行しない。新しいsource SHAと最大12回/architectureの1runを対象に事前承認し、結果は新しいActionsログで確認する。以前のartifactの読取拒否は引き継ぐ。

## 環境引数の最小化: unshareへ渡す環境を空にする

[run 44218183339 / attempt 1](evidence/linux-namespace-environment/44218183339-1/README.md) で、x64 / arm64とも継承環境と空の環境の最小argvが各3回同じEPERM、成功対照が各3回成功した。Node.js 22.23.4と各VM内のcaller条件・実行体hashは一致し、両構成とも `environment-not-required`。全24回を公開ログで直接照合した。この条件ではunshareへの継承環境は再現に必須ではなく、以後は空の環境を再現条件に使える。原因確定とPhase 2全体の完了は未認定。

`mode=probe-environment` はcaller比較と同じ測定器を使い、Node.jsを固定して `unshare` の `env` 引数だけを変える。継承環境と空の環境 `{}` の各条件で、最小argvと成功対照を各3回、最大12回/architecture測る。Node自体と測定器はCIの継承環境で動作し、CI識別・hash照合・観測条件を維持する。Bun用setup stepも前回と同じまま保持し、probeはNodeだけから起動する。

`development/probe-linux-namespace-caller.mjs environment SOURCE OUTPUT` を既存workflowから実行する。新しい実行体・依存を導入せず、専用Nix/group準備・正式44ケース・集約はスキップする。source/workflow/run/attempt、Nodeの実行体・版・親PID、unshare実体、caller資格情報・namespace識別子・LSM等の一致を要求する。

`probeEnvironment` は `inherited` / `empty` の方式だけを示す。記録する5環境変数はcallerの観測であり、空にしたunshare環境の値ではない。環境変数全体・認証値・変数一覧を記録しない。Node 20.19以上というrepoのengine契約は維持し、契約fixtureでは選択Nodeの実版を確認して20系の拒否と22以上の比較を分ける。専用CIは最小版20.19.0でこのfixtureだけを実行し、実測modeのNode 22以上という条件は変えない。fixtureでは既知の非機密sentinelと子側の変数数で、空の環境が実際に渡ることを確認する。

| 結果                       | 条件                                                        | 終了コード |
| -------------------------- | ----------------------------------------------------------- | ---------- |
| `environment-not-required` | 両環境で最小argvが各3回同じEPERM、対照が各3回成功           | 1          |
| `environment-dependent`    | 継承環境だけ最小argvが3回同じEPERM、空環境と両対照は3回成功 | 1          |
| `not-reproduced`           | 全12回が成功                                                | 0          |
| `unavailable`              | 別エラー・混在・条件不一致・観測不足                        | 2          |

今回の比較では `env` 引数全体を空にしても再現したため、空の環境を減らした再現条件として採用する。個別変数の効果やOS / LSMの原因を確定したとは扱わない。後続の[起動経路比較](evidence/linux-namespace-launch/44232172294-1/README.md)ではNode測定器を外した直接起動でも再現した。後続の[cwd比較](evidence/linux-namespace-cwd/44247496245-1/README.md)でも再現したため、対象checkoutのcwdは省けた。後続の[stdout比較](evidence/linux-namespace-stdout/44257860176-1/README.md)ではstdoutの匿名Unix socketも省けた。stdin/stderr・Python・OS / LSMなどの条件は残っており、失敗したunshare自身の拒否時の状態は未観測。記録したcallerのLSM contextだけで拒否原因を断定しない。

結果は `namespace-environment.json` と `environment-inherited.json` / `environment-empty.json` にwx0600で保存する。新しい `[DEBUG-ns-env]` JSON行には各probeの方式・argv・PID・時刻・終了状態と上限付き出力を記録し、各streamの1024文字を超える場合は `logTruncated` を示す。run名は `Linux namespace 環境比較: <source SHA>`、artifact名は `namespace-environment-<run>-<attempt>-<arch>`。新しいSHAに固定した1runを事前承認してから測定し、結果は新しいActionsログで確認する。過去に拒否されたartifactや一時ログへはアクセスしない。

## 起動経路の最小化: Node測定器を起動経路から外す

[run 44232172294 / attempt 1](evidence/linux-namespace-launch/44232172294-1/README.md) で、x64 / arm64ともNode経由とPython直接起動の最小argvが各3回同じEPERM、成功対照が各3回成功した。全24回の公開ログを直接照合し、両構成とも `node-not-required`。この条件でNode測定器を含む起動層は再現に必須ではない。

`mode=probe-launch` は導入済みPython 3を共通親として、空環境のNode経由とPythonからの直接起動を比較する。

`python3 -I control/development/probe-linux-namespace-launch.py SOURCE OUTPUT NODE` で起動する。Node側は既存MJSの `measure-environment ... empty` を再利用する。最初にNode経由で最小argvが3/3同じEPERM、対照が3/3成功することと共通親の条件を確認し、その場合だけ直接起動を各3回測る。最大12回/architecture。Node側で全6回が成功した場合は直接起動を省略して `not-reproduced` とし、別エラー・混在・条件不一致は `unavailable` で停止する。

直接起動は共通Python親の `subprocess.Popen` から `/usr/bin/unshare` を実行するため、Node測定器はunshareの祖先に残らない。両経路ともunshareの `env` は `{}`、cwdは対象checkout、stdinは読み取り専用の `/dev/null`、時間上限5秒、stdout/stderr合計32MiB、超過時は所有する子へSIGKILLとする。Nodeの `stdio: pipe` は通常のUnix pipeではないため、Python側も匿名Unix socket対を使う。fixtureで両経路のfd種別とflagsを確認する。[Nodeのstdio仕様](https://nodejs.org/api/child_process.html#optionsstdio)を参照。出力上限は[Node 22の実装](https://github.com/nodejs/node/blob/v22.x/src/spawn_sync.cc)と同じくstdout/stderr合算とし、実Nodeの `spawnSync` を使って境界ちょうどの成功と合計1 byte超過の拒否を対照する。

UID / EUID / GID・group、namespace識別子、callerのcapability / NoNewPrivs / Seccomp / LSM、選択した5環境変数を両経路と測定前後で照合する。Node測定器の親PIDが共通Python親PIDと一致することを要求し、両測定コード・Node/Python/unshare実体のhash、source/workflow/run/attempt、image/kernelを記録する。値の全件記録や認証値の取得は行わない。

| 結果                    | 条件                                                               | 終了コード |
| ----------------------- | ------------------------------------------------------------------ | ---------- |
| `node-not-required`     | Node経由と直接起動で最小argvが各3回同じEPERM、対照が各3回成功      | 1          |
| `node-launch-dependent` | Node経由だけ最小argvが3回同じEPERM、直接起動と両対照は3回成功      | 1          |
| `not-reproduced`        | Node経由の最小argvと対照が各3回成功。直接起動は省略                | 0          |
| `unavailable`           | 別エラー・混在・条件不一致・観測不足。直接起動前ならその時点で停止 | 2          |

これはNode測定器を含む起動経路を外せるかの比較であり、起動APIと追加されたprocess世代の個別効果は分離しない。Pythonを含む全callerやOS / LSMの影響を否定せず、callerのLSM観測を失敗したunshare自身の拒否時の状態とは扱わない。Phase 2全体と原因確定は未完了。#33未完了・#82待ち、macOS 15と全子孫5秒保証の条件を維持する。

結果は `namespace-launch.json`、Node側の記録は `launch-node.json` にwx0600で保存する。新しい `[DEBUG-ns-launch]` JSON行にはcaller条件・各argv・PID・時刻・終了状態を記録し、stdout/stderrは各1024文字まで、省略時は `logTruncated` を示す。環境変数全体や認証値は出力しない。

既存Bun setupは維持し、新しい依存のinstallは行わない。専用Nix/group準備、正式44ケース、集約はスキップする。run名は `Linux namespace 起動経路比較: <source SHA>`、artifact名は `namespace-launch-<run>-<attempt>-<arch>`。新しいSHAに固定した1runを事前承認し、結果は新しい公開Actionsログで確認する。今回の実行は承認どおり1回で、artifactの取得・読取は行っていない。

## cwdの最小化: 対象checkoutのcwdを外す

[run 44247496245 / attempt 1](evidence/linux-namespace-cwd/44247496245-1/README.md) で、x64 / arm64とも対象checkoutと `/` の最小argvが各3回同じEPERM、成功対照が各3回成功した。全24回の公開ログを直接照合し、両構成とも `cwd-not-required`。今回の条件で対象checkoutのcwdは再現に必須ではなく、以後は `/` を使う再現条件に縮められる。

起動経路比較の `node-not-required` を受け、`mode=probe-cwd` は既存Python 3からの直接起動と空環境を固定し、unshareのcwdだけを対象checkoutから `/` に変える。

`python3 -I control/development/probe-linux-namespace-launch.py compare-cwd SOURCE OUTPUT` で起動する。親Python自身のcwdは対象checkoutに固定し、各子への `cwd` 引数だけを変える。まず対象checkoutで最小argv `--map-current-user -- /usr/bin/true` が3/3同じUID-map EPERM、対照 `-- /usr/bin/true` が3/3成功することを確認し、その場合だけ `/` 側を各3回測る。最大12回/architecture。baselineの全6回が成功なら `/` 側を省略し、別エラー・混在・条件不一致でも比較へ進まない。

両条件で同じPython親・実行体・版、unshare実体・版・hash、非root資格情報、namespace識別子、callerのcapability / NoNewPrivs / Seccomp / LSM、選択した5環境変数を照合する。namespace probeへ渡す環境は `{}` とし、実行体の版確認は両cwdとも従来どおり継承環境で行う。stdinは読み取り専用の `/dev/null`、stdout/stderrは匿名Unix socket、上限は5秒・両stream合計32MiBとし、超過時は所有する子へSIGKILLする。各条件で最小argvと成功対照を各3回測る。空環境・cwd・親PID・stdio条件の一致は実子プロセスのfixtureで検証するが、実unshareの環境全件やfdのダンプとは扱わない。

| 結果               | 条件                                                       | 終了コード |
| ------------------ | ---------------------------------------------------------- | ---------- |
| `cwd-not-required` | checkoutと `/` で最小argvが各3回同じEPERM、対照が各3回成功 | 1          |
| `cwd-dependent`    | checkoutだけ最小argvが3回同じEPERM、`/` と両対照は3回成功  | 1          |
| `not-reproduced`   | checkout側の最小argvと対照が各3回成功。`/` 側は省略        | 0          |
| `unavailable`      | 別エラー・混在・条件不一致・観測不足                       | 2          |

`cwd-not-required` は今回の条件で対象checkoutのcwdを外せるという分類であり、全cwd・Python・OS / LSMの影響を否定しない。失敗したunshare自身の拒否時の状態は未観測で、原因確定とPhase 2全体は未完了。#33未完了・#82待ち、macOS 15と全子孫5秒保証を維持する。

結果は `namespace-cwd.json` にwx0600で保存する。`[DEBUG-ns-cwd]` のJSON行でsource/workflow/run/attempt・image/kernel・実行体hash・各条件のcwd・caller条件・各probeのargv/PID/時刻/終了状態を記録する。stdout/stderrは各1024文字までとし、省略時は `logTruncated` を示す。環境変数全体や認証値は出力しない。

既存Bun setupは保持し、新たな依存install・root化・sysctl/profile変更・特権journal取得を行わない。専用Nix/group準備・正式44ケース・集約はスキップする。run名は `Linux namespace cwd比較: <source SHA>`、artifact名は `namespace-cwd-<run>-<attempt>-<arch>` として正式実証から区別する。準備・レビュー・通常CIを終えた新しいSHAに固定した1runを事前承認してから実行し、新しい公開Actionsログで確認する。今回の承認済み1runはsource / workflowを `6bbf24e1f6d33bb90a7534c4426044ca0c71e9da` に固定して実行した。artifactの取得・読取と、過去に拒否された一時ログへのアクセスは行っていない。

## stdoutの最小化: stdoutだけを匿名Unix socketから通常pipeへ変える

[run 44257860176 / attempt 1](evidence/linux-namespace-stdout/44257860176-1/README.md) で、x64 / arm64ともstdoutがsocketとpipeの最小argvは各3回同じEPERM、成功対照は各3回成功した。全24回の公開ログを直接照合し、両構成とも `stdout-socket-not-required`。今回の条件でstdoutの匿名Unix socketは再現に必須ではなく、以後はstdoutを通常pipeにした再現条件へ縮められる。

cwd比較の `cwd-not-required` を受け、`mode=probe-stdout` は同じPython親からの直接起動・空環境・対象のcwd `/` を固定し、stdoutだけを匿名Unix socketから通常pipeへ変える。

`python3 -I control/development/probe-linux-namespace-launch.py compare-stdout SOURCE OUTPUT` で起動する。親Pythonのcwdは従来どおり対象checkoutのまま保持する。まずstdoutがsocketの条件で最小argv `--map-current-user -- /usr/bin/true` が3/3同じUID-map EPERM、対照 `-- /usr/bin/true` が3/3成功することを確認し、その場合だけstdoutを `subprocess.PIPE` に変えて各3回測る。最大12回/architecture。baselineの全6回が成功ならpipe側を省略し、別エラー・混在・条件不一致でも比較へ進まない。

stderrは両条件とも同じ匿名Unix socket、stdinは読み取り専用の `/dev/null` とする。stdoutのpipe化に伴いfd 1の種類とアクセスモードは変わるが、stdin/stderrの種類とflags、同じPython親・実行体・版・unshare実体・非root資格情報・namespace識別子・callerのcapability / NoNewPrivs / Seccomp / LSM・選択した5環境変数を固定する。namespace probeの環境は `{}`、実行体の `--version` 確認は従来どおり継承環境で行い、版確認のstdoutは両条件ともsocketのまま。時間上限5秒・stdout/stderr合計32MiBと超過時の所有する子へのSIGKILLも維持する。

| 結果                         | 条件                                                    | 終了コード |
| ---------------------------- | ------------------------------------------------------- | ---------- |
| `stdout-socket-not-required` | socketとpipeで最小argvが各3回同じEPERM、対照が各3回成功 | 1          |
| `stdout-type-dependent`      | socketだけ最小argvが3回同じEPERM、pipeと両対照は3回成功 | 1          |
| `not-reproduced`             | socket側の最小argvと対照が各3回成功。pipe側は省略       | 0          |
| `unavailable`                | 別エラー・混在・条件不一致・観測不足                    | 2          |

結果は `namespace-stdout.json` にwx0600で保存し、途中のpipe側エラーでも取得済みbaselineを保持する。`[DEBUG-ns-stdout]` のJSON行でsource/workflow/run/attempt・image/kernel・実行体hash・caller条件・各probeのargv/PID/時刻/終了状態を記録する。条件名は `stdoutType` に保存し、実際の出力を表す `stdout` と区別する。各streamは1024文字まで、省略時は `logTruncated` を示す。環境変数全体や認証値は出力しない。

空環境・cwd・親PID・stdoutのFIFO / socket判定・他stdioの種類とflagsは実子プロセスのfixtureで検証し、両stdout方式でtimeoutと合算出力の境界対照も確認する。これは設定の検証であり、実unshareの環境・fd・拒否時のLSM状態を直接dumpしたとは扱わない。結果はstdoutのsocketが今回の再現に必要かの比較に限定し、stderr・Python・OS / LSMの影響や原因を確定しない。Phase 2全体・#33は未完了、#82待ち、macOS 15と全子孫5秒保証を維持する。

既存Bun setupは保持し、新たな依存install・root化・sysctl/profile変更・特権journal取得は行わない。専用Nix/group準備・正式44ケース・集約はスキップする。run名は `Linux namespace stdout比較: <source SHA>`、artifact名は `namespace-stdout-<run>-<attempt>-<arch>` として正式実証から区別する。準備・レビュー・通常CIを終えた新しいSHAに固定した1runを事前承認してから実行し、新しい公開Actionsログで結果を照合する。今回の承認済み1runはsource / workflowを `811325e67d5be4b9d50ea3d3aa3f98d82efb7065` に固定して実行した。artifactの取得・読取と過去に拒否された一時ログへのアクセスは行っていない。

## 次の最小化: stdoutをpipeに固定してstderrだけ通常pipeへ変える

stdout比較の `stdout-socket-not-required` を受け、`mode=probe-stderr` は同じPython親からの直接起動・空環境・対象cwd `/` とstdoutの通常pipeを固定し、stderrだけを匿名Unix socketから通常pipeへ変える。[run 44271416358 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44271416358) をsource / workflow `6937f37083b47b393a60363a8e4d3dc03c85864d` で1回実行し、両構成とも `stderr-socket-not-required` を確認した。

| architecture | stderrの指定方式 | 最小argv | 成功対照 |
| --- | --- | --- | --- |
| x64 | 匿名Unix socket | 3/3 EPERM | 3/3 成功 |
| x64 | 通常pipe | 3/3 EPERM | 3/3 成功 |
| arm64 | 匿名Unix socket | 3/3 EPERM | 3/3 成功 |
| arm64 | 通常pipe | 3/3 EPERM | 3/3 成功 |

全24回のargv・PID・時刻・終了状態・stderr全文を新しい公開ログと照合し、signal・spawn error・ログ省略がないことを確認した。測定前後と条件間でPython親・実行体・caller条件が各VM内で一致し、測定コードhashも対象blobと一致した。[実行記録と選択した公開JSON](evidence/linux-namespace-stderr/44271416358-1/README.md)に保存した。今回の条件ではstderrのsocketも再現に必須ではなく、stdout/stderrを通常pipeにした状態でも最小argvのEPERMが続く。runのfailureは対象症状を検出した予定exit 1による。

`python3 -I control/development/probe-linux-namespace-launch.py compare-stderr SOURCE OUTPUT` で起動する。親Pythonのcwdは従来どおり対象checkoutに保持する。まずstderrがsocketの条件で最小argv `--map-current-user -- /usr/bin/true` が3/3同じUID-map EPERM、対照 `-- /usr/bin/true` が3/3成功することを確認し、その場合だけstderrを `subprocess.PIPE` に変えて各3回測る。最大12回/architecture。baselineの全6回が成功ならpipe側を省略し、別エラー・混在・条件不一致でも比較へ進まない。

stdoutは両条件とも通常pipe、stdinは読み取り専用の `/dev/null` とする。stderrのpipe化に伴うfd 2の種類とアクセスモードを比較対象とし、stdin/stdoutの種類とflags、Python親・実行体・版・unshare実体・非root資格情報・namespace識別子・callerのcapability / NoNewPrivs / Seccomp / LSM・選択した5環境変数を固定する。namespace probeの環境は `{}`。実行体の `--version` 確認は両条件とも従来どおり継承環境とstdout/stderrのsocketを使う。5秒・stdout/stderr合計32MiBと超過時の所有する子へのSIGKILLも維持する。

| 結果                         | 条件                                                    | 終了コード |
| ---------------------------- | ------------------------------------------------------- | ---------- |
| `stderr-socket-not-required` | socketとpipeで最小argvが各3回同じEPERM、対照が各3回成功 | 1          |
| `stderr-type-dependent`      | socketだけ最小argvが3回同じEPERM、pipeと両対照は3回成功 | 1          |
| `not-reproduced`             | socket側の最小argvと対照が各3回成功。pipe側は省略       | 0          |
| `unavailable`                | 別エラー・混在・条件不一致・観測不足                    | 2          |

結果は `namespace-stderr.json` にwx0600で保存し、途中のpipe側エラーでも取得済みbaselineを保持する。`[DEBUG-ns-stderr]` のJSON行でsource/workflow/run/attempt・image/kernel・実行体hash・caller条件・各probeのargv/PID/時刻/終了状態を記録する。`stdoutType` / `stderrType` は指定方式、`stdout` / `stderr` は実出力として分け、各streamは1024文字まで、省略時は `logTruncated` を示す。環境変数全体や認証値は出力しない。

実子fixtureでstdoutのpipe固定、stderrのFIFO/socket判定、他stdioの種類とflags、空環境・cwd・親PIDを検証する。両streamがpipeの場合もtimeout・合算出力上限・境界ちょうどと1 byte超過の対照を確認する。これらは設定の検証であり、実unshareのfd・環境・拒否時LSM状態を直接dumpしたとは扱わない。結果は今回の再現にstderrのsocketが必要かの比較に限定し、stdin・Python・OS / LSMの影響や原因を確定しない。Phase 2全体・#33は未完了、#82待ち、macOS 15と全子孫5秒保証を維持する。

既存Bun setupは保持し、新たな依存install・root化・sysctl/profile変更・特権journal取得は行わない。専用Nix/group準備・正式44ケース・集約はスキップする。run名は `Linux namespace stderr比較: <source SHA>`、artifact名は `namespace-stderr-<run>-<attempt>-<arch>` として正式実証から区別する。今回の承認済み1runはsource / workflowを `6937f37083b47b393a60363a8e4d3dc03c85864d` に固定して実行した。CodeRabbitは測定コード `8860a6a` を評価済みだが、テスト修正 `6937f37` は回数制限で未評価だった。修正差分の独立した仕様・規約レビューと通常CI全6ジョブの成功を確認し、その制約を了承した承認後に実行した。artifactの取得・読取と過去に拒否された一時ログへのアクセスは行っていない。

## 次の最小化: 共通Bash親の下でPython測定器を外す

`mode=probe-parent` は同じBash親の子としてPython baselineを先に終了させ、正確な再現を確認した場合だけPerl測定器を起動する。PerlをPythonの子にはせず、共通Bashより下のPython測定器を含む起動層を除く比較とする。承認済みの [run 44306659985 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44306659985) をsource / workflow `a5fc890c9cd94d1df5a43cf143625c18ad2e9d1e` で1回実行した。

`bash control/development/probe-linux-namespace-parent.sh SOURCE OUTPUT` が制御する。Pythonは既存captureで最小argv `--map-current-user -- /usr/bin/true` と成功対照 `-- /usr/bin/true` を各3回測る。最小argvが3/3同じUID-map EPERM、対照が3/3成功した場合だけ段階間専用の終了コード42を返し、Perl側も各3回、最大12回/architectureを測る。baseline全6回成功ならPerl側を省略し、別エラー・混在・不足でも追加起動しない。Perlの失敗も含めてPythonの後処理へ渡し、取得済みbaselineを保持して判定する。

両測定のnamespace probeは空環境 `{}`、cwd `/`、読み取り専用の `/dev/null` stdinと、別々の匿名の通常pipeであるstdout/stderrを使う。Pythonは既存 `subprocess.Popen`、Perlはpipe・fork・execを使う。各probeは5秒・stdout/stderr合計32MiBを維持し、時間切れ・出力超過では未回収の所有する対象子だけへSIGKILLを送る。Perlのunshare版表記はbaselineの観測を同一実体hashと照合して引き継ぎ、Perl側に追加の `--version` 起動を置かない。

共通BashのPID・start time ticks・祖先列、測定器のPID/親PID・実行体/版/hash、callerの非root資格情報・namespace識別子・map・capability / NoNewPrivs / Seccomp / LSM・選択した5環境変数を照合する。共通Bashより上の祖先は両条件で保持し、command lineや環境全体は読まない。祖先のexeが読めない場合はそのerrorを記録する。stdin/stdout/stderrの種類・flags・空環境・cwd・実子の親PIDはfixtureで観測するが、実unshareの拒否時のfd・環境全件・LSMを直接dumpしたとは扱わない。

Pythonの祖先が消えることと、Python固有の起動API・process世代がPerlのfork/execへ変わることを一つの起動層として比較する。結果が依存を示しても、祖先と起動APIの個別効果は分離しない。

| 結果 | 条件 | 終了コード |
| --- | --- | --- |
| `python-layer-not-required` | Python/Perlとも最小argvが各3回同じEPERM、対照が各3回成功 | 1 |
| `python-layer-dependent` | Pythonだけ最小argvが3回同じEPERM、Perlと両対照は3回成功 | 1 |
| `not-reproduced` | Python baselineの最小argvと対照が各3回成功、Perl側は省略 | 0 |
| `unavailable` | 別エラー・混在・条件不一致・観測不足・起動段階の失敗 | 2 |

Bashが未使用の `OUTPUT` directoryを `mkdir` で排他的に確保し、取得した実行だけが測定と後処理へ進む。Python baselineは全成功で41、正確な再現で42、後処理は全成功で44、比較成立で43を返す。Bashが後処理の44を最終0、43を最終1へ変換し、それ以外の終了コードは2にする。通常のinterpreter起動失敗は追加測定や再現成功を許可しない。`namespace-parent-python.json`、`namespace-parent-perl.json`、`namespace-parent.json` をwx0600で保存する。途中記録や不正な形の記録も保存を先に行い、ログ生成の失敗でbaselineを失わない。`[DEBUG-ns-parent]` はsource/workflow/run/attemptと測定器hash、各probeのargv/PID/時刻/終了状態を限定記録し、`parent` / `stdoutType` / `stderrType` と実出力を分ける。出力は各stream1024文字まで、省略時は `logTruncated` を示す。

実子fixtureではPython/Perlの共通Bash親、通常pipeのflags一致、空環境・cwd・親PIDとfork数6を観測し、追加測定が必要な2ケースだけで記録を要求する。合算上限ちょうどの成功と1 byte超過、時間切れ・exec失敗・子の回収、条件やPID世代の改変、部分記録と上書き拒否も検証する。これは測定器の契約検証であり、実VMのnamespace成功や正式44ケースの成功には数えない。

既存Bun setupを保持し、新規依存install・Cビルド・root化・sysctl/profile変更・特権journal参照は行わない。専用Nix/group準備・正式44ケース・集約をスキップし、run名 `Linux namespace Python起動層比較: <source SHA>`、artifact名 `namespace-parent-<run>-<attempt>-<arch>` で区別する。準備・レビュー・通常CIを終えた新しいSHAに固定した1runを事前承認してから実行し、新しい公開Actionsログで照合する。artifactの取得・読取や、過去に拒否された一時ログへのアクセスは行わない。

原因確定とPhase 2全体の完了は未認定。stdin・共通親より上の祖先・OS / LSMなどの条件は残り、#33未完了・#82待ち、macOS 15と全子孫5秒保証を維持する。

実測はx64・arm64とも `python-layer-not-required`。Python 3.12.3とPerl 5.38.2の両方で、最小argvは各3回同じUID-map EPERM、対照は各3回成功した。全24回にsignal・spawn error・ログ省略はなく、予定exit 1で完了した。共通BashのPID・start time ticks・祖先列、caller条件と測定前後、unshareの実体hashが各VM内で一致した。Python測定器を含む起動層を今回の再現条件から省けたが、Python祖先と起動APIの個別効果や拒否原因を確定したものではない。

[実行記録と選択した公開JSON](evidence/linux-namespace-parent/44306659985-1/README.md) に各job17行・計34行を保存した。両jobの測定器4ファイルのhashは対象commitのGit blobと一致する。修正前 `dec76e9` へのCodeRabbitの11件の指摘は `a5fc890` で修正・返信・解決し、独立した仕様・規約レビューと通常CI全6ジョブの成功を確認した。最新差分へのCodeRabbit評価は回数制限で未完了という制約を了承した承認後の1runであり、artifactの取得・読取は行っていない。

## 次の最小化: 同じPerl親でstdinだけを閉じる

`probe-parent` の結果を受け、`mode=probe-stdin` はPythonをnamespace probeの祖先に挟まず、同じPerl processの下で子のstdinだけを変える。承認済みのrunは後掲の実測結果に記録する。`bash control/development/probe-linux-namespace-parent.sh SOURCE OUTPUT stdin` で制御する。

Python準備子はUbuntu 24.04・非root・source / workflow / run / attempt・専用Nix/group準備の省略・測定器4ファイルのGit blob一致とruntime hashを検査し、unshareの版を1回確認して終了する。専用の段階終了コード45だけでPerlを起動し、Python後処理も共通Bashの別の子として実行する。通常のinterpreter失敗を起動許可や再現成功に数えない。

Perl baselineは読み取り専用 `/dev/null` stdinで最小argv `--map-current-user -- /usr/bin/true` と対照 `-- /usr/bin/true` を各3回測る。最小argvが3/3同じUID-map EPERM、対照が3/3成功し、caller・祖先・実行体が変化していない場合だけ、同じPerl親から子のfd 0をexec直前に閉じて各3回測る。namespace probeは最大12回/architecture、x64・arm64で計24回。これとは別に準備時の版確認が1回/architectureある。

空環境 `{}`、cwd `/`、stdout/stderrの別々の匿名通常pipeとflags、PerlのPID・start time ticks・共通Bashと上位祖先、非root資格情報と限定したcaller観測をそろえる。各probeの5秒・合算32MiB・未回収の所有子だけへのSIGKILLを維持する。

| 結果 | 条件 | 最終終了コード |
| --- | --- | --- |
| `stdin-devnull-not-required` | 両stdin条件とも最小argvが各3回同じEPERM、対照が各3回成功 | 1 |
| `stdin-devnull-dependent` | baselineの最小argvだけ3回同じEPERM、閉鎖側と両対照は各3回成功 | 1 |
| `not-reproduced` | baselineの最小argvと対照が各3回成功、閉鎖側は省略 | 0 |
| `unavailable` | 別エラー・混在・条件不一致・観測不足・段階の失敗 | 2 |

同じPerl親・祖先列・caller条件・unshareの実体hashと版、各条件6件のraw結果をPython後処理で再検証する。baselineが別エラーや混在なら閉鎖側を起動しない。Bashが未使用OUTPUTを排他的に確保し、`namespace-stdin-checkpoint.json` / `namespace-stdin-perl.json` / `namespace-stdin.json` をwx0600で保存する。閉鎖側やJSON読取りの失敗でも、取得済みbaselineと準備時のidentity・hashを保持する。閉鎖側はbaselineのpath/hashを受け取り、測定開始時にも一致を要求する。Pythonの祖先再検査は、完了した6件をcheckpointへ格納してから行う。

callerの非ASCII cwdと、比較対象の `PATH` / `HOME` / `LANG` / `LC_ALL` / `TMPDIR` はUTF-8文字列として照合する。選択環境値に不正なUTF-8がある場合は、値そのものを出力せず、変数名と拒否理由を有効なJSONへ保存して終了2にする。比較対象外の環境変数まで拒否しない。

`[DEBUG-ns-stdin]` のJSONでsource / workflow / run / attempt・測定器hash・各probeのargv/PID/時刻/終了状態を限定記録する。`stdinType` の `devnull` / `closed` は指定方式であり、実出力 `stdout` / `stderr` と分ける。各streamは1024文字まで、省略時は `logTruncated` を示す。環境全体や認証値を出力しない。

実子fixtureはexec後のfd 0をfcntl/readlinkで観測し、親PID・cwd・他stdioの種類とflags・環境の公開sentinelの除去を比較する。この環境のPerlを観測子にするとstdinを再オープンするため、観測には既存Pythonを使い、Pythonが空環境に追加する `LC_CTYPE=C.UTF-8` だけをfixture内で区別する。fd 0の閉鎖を省くmutationはテストで失敗する。これは測定器の設定とfixtureの検証であり、実unshareのfd・環境全件・拒否時LSMを直接dumpした証跡ではない。

既存Bun setupを保持し、新規依存install・Cビルド・root化・sysctl/profile変更・特権journal参照は行わない。専用Nix/group準備・正式44ケース・集約はスキップする。run名は `Linux namespace stdin比較: <source SHA>`、artifact名は `namespace-stdin-<run>-<attempt>-<arch>` とし、準備・レビュー・公開・通常CIを終えた新しいSHAを提示して1runを承認してから実行する。artifactの取得・読取は行わない。

今回の切り分けはstdinの指定方式の要否に限定する。原因確定とPhase 2全体の完了は未認定。共通Bashと上位祖先、Perlの起動経路、OS / LSMなどの条件は残り、#33未完了・#82待ち、macOS 15と全子孫5秒保証を維持する。

確認済み（confirmed）: 承認済みの [run 44366608889 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44366608889) をsource / workflow `73e36ee75839ee9d4bba6329466256e303cade73` で1回実行し、x64・arm64とも `stdin-devnull-not-required` だった。両stdin条件で最小argvは各3回同じUID-map EPERM、対照は各3回成功し、全24回にsignal・spawn error・ログ省略はなかった。予定exit 1によるfailureであり、正式実証の成功には数えない。

同じPerl親のPID・start time ticks・共通Bashと上位祖先列、caller条件と測定前後、unshareとruntimeのhashが各VM内で一致した。両jobの測定器4ファイルのhashは対象commitのGit blobと一致する。各job17行・計34行の選択した公開JSONと実行metadataを [実行記録](evidence/linux-namespace-stdin/44366608889-1/README.md) に保存した。stdinの指定方式の要否に結論を限定し、実unshareの拒否時fd・環境全件・LSMの直接観測とは扱わない。

評価済み `9cda5dc` との差分は文書とテストのみで、測定コードとworkflowは同一。最新 `73e36ee` のCodeRabbit評価が回数制限で未完了という制約と、symlink環境を模す追加fixture再現の未確認を了承した承認後の1runである。独立した仕様・規約レビューは各指摘0件、通常CI全6ジョブの成功を確認した。artifactの取得・読取は行っていない。
