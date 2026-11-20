# Linux namespace の再現ループ

状態: [run 44078199627 / attempt 1](evidence/linux-namespace-loop/44078199627-1/README.md) でx64 / arm64各3回、同じEPERMを再現した。前提検査は1回約0.22〜0.49秒で、Phase 1は確認済み。stdin比較に続く[Bash直接起動比較](evidence/linux-namespace-bash/44418918065-1/README.md)では、共通Bashと上位祖先・閉鎖stdin・空環境・cwd `/`・両streamの通常pipeを保ち、Perlを含む起動層を外しても同じEPERMを再現した。最新の[Bash監査取得](evidence/linux-namespace-bash-audit/44438396275-1/README.md)では、両構成それぞれ2 PIDに対応する時間窓でAppArmorの `sys_admin` 能力拒否を通常権限で取得した。[namespace作成だけを残す比較](evidence/linux-namespace-userns/44458506354-1/README.md)では両構成とも最小argvが各3回EPERM、namespace作成だけの対照が各3回成功し、mapping関連操作が今回の再現に必要だった。[数値名検査を加えたUID mapping単独の比較](evidence/linux-namespace-uid/44542479679-1/README.md)では、両構成で数値名が正常な未登録と分類された後、UID-onlyも各3回同じEPERMとなり、namespace-only対照は各3回成功した。[直接UID-map書込み比較](evidence/linux-namespace-uid-write/44633267572-1/README.md)では、両構成でnamespace作成・openは各3回成功し、writeだけが各3回EPERM、直接namespace-only対照は各3回成功した。Phase 2の最小化と原因の確定は未完了。[run 44049468642 / attempt 1](evidence/linux-process-proof/44049468642-1/README.md) の失敗記録と [ADR 0003](adr/0003-os-specific-preparation-containment.md) の条件を引き継ぐ。

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

正式実証と `probe-loop` では、起動したunshareのPID・測定時刻に一致するAppArmorの `AUDIT` 遷移を保存した。通常の `probe-bash` は監査を取得しないが、承認済みの `probe-bash-audit` では失敗したBash最小argvの6 PIDを通常権限で検索し、4 PIDに対応する `unprivileged_userns` への遷移と `sys_admin` の `DENIED` を得た。残り2 PIDは一致なしで理由未確定。UID-map書込みまでの具体的な検査・syscallの因果関係とloaded policyの該当規則は未確認である。

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

| architecture | stderrの指定方式 | 最小argv  | 成功対照 |
| ------------ | ---------------- | --------- | -------- |
| x64          | 匿名Unix socket  | 3/3 EPERM | 3/3 成功 |
| x64          | 通常pipe         | 3/3 EPERM | 3/3 成功 |
| arm64        | 匿名Unix socket  | 3/3 EPERM | 3/3 成功 |
| arm64        | 通常pipe         | 3/3 EPERM | 3/3 成功 |

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

| 結果                        | 条件                                                     | 終了コード |
| --------------------------- | -------------------------------------------------------- | ---------- |
| `python-layer-not-required` | Python/Perlとも最小argvが各3回同じEPERM、対照が各3回成功 | 1          |
| `python-layer-dependent`    | Pythonだけ最小argvが3回同じEPERM、Perlと両対照は3回成功  | 1          |
| `not-reproduced`            | Python baselineの最小argvと対照が各3回成功、Perl側は省略 | 0          |
| `unavailable`               | 別エラー・混在・条件不一致・観測不足・起動段階の失敗     | 2          |

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

| 結果                         | 条件                                                          | 最終終了コード |
| ---------------------------- | ------------------------------------------------------------- | -------------- |
| `stdin-devnull-not-required` | 両stdin条件とも最小argvが各3回同じEPERM、対照が各3回成功      | 1              |
| `stdin-devnull-dependent`    | baselineの最小argvだけ3回同じEPERM、閉鎖側と両対照は各3回成功 | 1              |
| `not-reproduced`             | baselineの最小argvと対照が各3回成功、閉鎖側は省略             | 0              |
| `unavailable`                | 別エラー・混在・条件不一致・観測不足・段階の失敗              | 2              |

同じPerl親・祖先列・caller条件・unshareの実体hashと版、各条件6件のraw結果をPython後処理で再検証する。baselineが別エラーや混在なら閉鎖側を起動しない。Bashが未使用OUTPUTを排他的に確保し、`namespace-stdin-checkpoint.json` / `namespace-stdin-perl.json` / `namespace-stdin.json` をwx0600で保存する。閉鎖側やJSON読取りの失敗でも、取得済みbaselineと準備時のidentity・hashを保持する。閉鎖側はbaselineのpath/hashを受け取り、測定開始時にも一致を要求する。Pythonの祖先再検査は、完了した6件をcheckpointへ格納してから行う。

callerの非ASCII cwdと、比較対象の `PATH` / `HOME` / `LANG` / `LC_ALL` / `TMPDIR` はUTF-8文字列として照合する。選択環境値に不正なUTF-8がある場合は、値そのものを出力せず、変数名と拒否理由を有効なJSONへ保存して終了2にする。比較対象外の環境変数まで拒否しない。

`[DEBUG-ns-stdin]` のJSONでsource / workflow / run / attempt・測定器hash・各probeのargv/PID/時刻/終了状態を限定記録する。`stdinType` の `devnull` / `closed` は指定方式であり、実出力 `stdout` / `stderr` と分ける。各streamは1024文字まで、省略時は `logTruncated` を示す。環境全体や認証値を出力しない。

実子fixtureはexec後のfd 0をfcntl/readlinkで観測し、親PID・cwd・他stdioの種類とflags・環境の公開sentinelの除去を比較する。この環境のPerlを観測子にするとstdinを再オープンするため、観測には既存Pythonを使い、Pythonが空環境に追加する `LC_CTYPE=C.UTF-8` だけをfixture内で区別する。fd 0の閉鎖を省くmutationはテストで失敗する。これは測定器の設定とfixtureの検証であり、実unshareのfd・環境全件・拒否時LSMを直接dumpした証跡ではない。

既存Bun setupを保持し、新規依存install・Cビルド・root化・sysctl/profile変更・特権journal参照は行わない。専用Nix/group準備・正式44ケース・集約はスキップする。run名は `Linux namespace stdin比較: <source SHA>`、artifact名は `namespace-stdin-<run>-<attempt>-<arch>` とし、準備・レビュー・公開・通常CIを終えた新しいSHAを提示して1runを承認してから実行する。artifactの取得・読取は行わない。

今回の切り分けはstdinの指定方式の要否に限定する。原因確定とPhase 2全体の完了は未認定。共通Bashと上位祖先、Perlの起動経路、OS / LSMなどの条件は残り、#33未完了・#82待ち、macOS 15と全子孫5秒保証を維持する。

確認済み（confirmed）: 承認済みの [run 44366608889 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44366608889) をsource / workflow `73e36ee75839ee9d4bba6329466256e303cade73` で1回実行し、x64・arm64とも `stdin-devnull-not-required` だった。両stdin条件で最小argvは各3回同じUID-map EPERM、対照は各3回成功し、全24回にsignal・spawn error・ログ省略はなかった。予定exit 1によるfailureであり、正式実証の成功には数えない。

同じPerl親のPID・start time ticks・共通Bashと上位祖先列、caller条件と測定前後、unshareとruntimeのhashが各VM内で一致した。両jobの測定器4ファイルのhashは対象commitのGit blobと一致する。各job17行・計34行の選択した公開JSONと実行metadataを [実行記録](evidence/linux-namespace-stdin/44366608889-1/README.md) に保存した。stdinの指定方式の要否に結論を限定し、実unshareの拒否時fd・環境全件・LSMの直接観測とは扱わない。

評価済み `9cda5dc` との差分は文書とテストのみで、測定コードとworkflowは同一。最新 `73e36ee` のCodeRabbit評価が回数制限で未完了という制約と、symlink環境を模す追加fixture再現の未確認を了承した承認後の1runである。独立した仕様・規約レビューは各指摘0件、通常CI全6ジョブの成功を確認した。artifactの取得・読取は行っていない。

## 起動経路の最小化: 共通BashからPerlを経由せず直接起動する

stdin比較の結果を受け、`mode=probe-bash` はstdinをexec直前のfd 0閉鎖に固定し、Perlを含む起動層の要否を比較する。承認済みの [run 44418918065 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44418918065) をsource / workflow `d358f8cab04c70cf3986f122b9df320bc4bcd60d` に固定して1回実行した。`bash control/development/probe-linux-namespace-bash.sh SOURCE OUTPUT` で制御する。

共通Bashの別の子としてPython準備子、閉鎖stdinのPerl baseline、Pythonの段階検査、Bashの直接子であるunshare、Python後処理を順に待機する。baselineの最小argv `--map-current-user -- /usr/bin/true` と成功対照 `-- /usr/bin/true` を各3回測り、正確なUID-map EPERMと対照成功、caller・祖先・実行体の一致を確認した場合だけBash直接側を各3回測る。baseline全成功、別エラー、混在、条件不一致では直接側を起動しない。namespace probeは最大12回/architecture、x64・arm64で計24回。別に準備時のunshare版確認が1回/architectureある。

Bash直接側は、Bashがforkした子で `exec -c` を使う。PerlとPythonを、その子と共通Bashの間には挟まない。空環境 `{}`、cwd `/`、閉鎖stdin、stdout/stderrの別々の匿名通常pipeとflagsを維持する。起動API・process世代・Bash固有の子起動時の状態をまとめて比較し、個々の効果は分離しない。

Bashは[process substitutionとcoprocess](https://www.gnu.org/software/bash/manual/bash.html)で作ったpipeをbuiltinで複製する。`/proc/.../fd` のwriterを開き直す案では `O_LARGEFILE` が増える失敗を実子テストで検出したため、namespace probeのwriterには使わない。stderr pipeを引き継ぐPython補助はprobe開始前に終了し、出力を収集するPython観測子も共通Bashの別の子である。観測子はunshareの祖先には入らない。

観測子はexec前のgateでBashの所有子であること、PID・親PID・実体・process group・session・start time ticksを検査し、[pidfd](https://docs.python.org/3/library/os.html#os.pidfd_open)へ固定する。各probeの5秒・stdout/stderr合計32MiBを維持し、超過時は[保持したpidfdだけへSIGKILL](https://docs.python.org/3/library/signal.html#signal.pidfd_send_signal)を送る。終了した数値PIDを再利用してsignalを送らない。Bashがprobeと両補助をwaitする。Bash 5以上とPython/Linuxのpidfdが必要で、準備時に利用可否を確認し、未達ならnamespace probeを開始しない。新しい依存installやCビルドは行わない。

Bashの `wait` が返す128以上の値は、通常終了とsignalを推測で区別しない。元の `waitStatus` を保持し、`EWAITSTATUS` として `unavailable` にする。時間切れ・出力超過の `ETIMEDOUT` / `ENOBUFS` は別に保持する。正常な0/1と正確なstderrを確認できた測定だけを比較結果に使う。

| 結果                      | 条件                                                    | 最終終了コード |
| ------------------------- | ------------------------------------------------------- | -------------- |
| `perl-layer-not-required` | Perl/Bashとも最小argvが各3回同じEPERM、対照が各3回成功  | 1              |
| `perl-layer-dependent`    | Perlだけ最小argvが3回同じEPERM、Bashと両対照は各3回成功 | 1              |
| `not-reproduced`          | Perl baselineの最小argvと対照が各3回成功、Bash側は省略  | 0              |
| `unavailable`             | 別エラー・混在・条件不一致・観測不足・段階の失敗        | 2              |

共通BashのPID世代と上位祖先、Bash/Perl/Pythonとunshareの実体hash、source/workflow/run/attempt、非root資格情報・namespace・限定したcaller観測を照合する。Bash自身の限定proc情報と、観測子へ継承された `PATH` / `HOME` / `LANG` / `LC_ALL` / `TMPDIR` の5値を使い、環境全体やcommand lineは読まない。`childBefore` はexec前のBash子の観測であり、失敗したunshare自身の拒否時LSMとは扱わない。

Bashが未使用OUTPUTを排他的に確保する。準備の専用コード46でだけPerlを起動し、baselineの47でだけ直接側へ進む。後処理の43/44だけを最終1/0へ変換し、他は2にする。checkpoint、Perl raw、gate、Bash開始点、各probeのstream記録とwait結果、`namespace-bash.json` を0600で保存する。後続JSONや所有PIDの検査が失敗しても、準備時の出所と取得済みPerl baselineを保持する。stream記録が空・不正でもBashと観測子のwait結果を保存し、終了時snapshot失敗でも取得済みBash probeを最終JSONと公開ログに保持する。個別captureの読取・解析に失敗した場合も、case・反復番号・例外種別を `captureErrors` へ記録して後続の正常captureを取り込み、判定は `unavailable` にする。

`[DEBUG-ns-bash]` は方式、caller、exec前の所有PID情報、各probeのargv/PID/時刻/終了状態を限定出力する。stdout/stderrは各1024文字までで、省略時は `logTruncated` を示す。実子fixtureでfd 0の閉鎖、直接のBash親、他stdioの種類・flags、環境の公開sentinel除去を確認する。これは設定の検証であり、実unshareのfd・環境全件・拒否時LSMの直接dumpではない。

既存Bun setupを保持し、専用Nix/group準備・正式44ケース・集約をスキップする。root化・sysctl/profile変更・特権journal参照は行わない。run名は `Linux namespace Bash直接起動比較: <source SHA>`、artifact名は `namespace-bash-<run>-<attempt>-<arch>` とする。実行は検証・レビュー・公開・通常CIを終えた新しいSHAへsource/workflowをそろえ、範囲を明示した1runの承認後に行う。artifactの取得・読取は行わない。

結論は今回のPerlを含む起動層の要否に限定する。共通Bashと上位祖先、OS / LSMなどの条件は残り、原因確定とPhase 2全体の完了は未認定。#33未完了・#82待ち、macOS 15と全子孫5秒保証を維持する。

実測はx64・arm64とも `perl-layer-not-required`。Perl経由とBash直接起動の両方で、最小argvは各3/3同じUID-map EPERM、対照は各3/3成功した。全24回にsignal・spawn error・ログ省略はなく、Bash側のwait statusはexit statusと一致し、観測子は全てexit 0だった。両jobは予定exit 1で完了した。共通BashのPID世代と上位祖先、caller条件と測定前後、runtimeとunshareのhashが各VM内で一致し、測定器6ファイルのhashが対象commitのGit blobと一致した。

[実行記録と選択した公開JSON](evidence/linux-namespace-bash/44418918065-1/README.md) に各job18行・計36行を保存した。直前 `0f7bffc` のCodeRabbit評価は4項目成功し、その3指摘は `d358f8c` で修正・返信・解決した。修正差分の追加評価が回数制限で未完了という制約を了承した承認後の1runであり、最終差分の独立した仕様・規約レビューと通常CI全6ジョブは成功している。artifactの取得・読取は行っていない。

このペアではPerlを含む起動層を再現条件から省けた。共通Bashと上位祖先、unshareの起動path、OS / LSMなどの残る条件を次に検討する。起動API・process世代・Bash固有の初期状態の個別効果や、拒否原因を確定したものではない。Phase 2全体・#33は未完了、#82は#33待ちを維持する。

## 次の観測: Bash直接起動後のPIDと時刻に対応するkernel監査

保存済みの [正式run](evidence/linux-process-proof/44049468642-1/README.md) と [反復run](evidence/linux-namespace-loop/44078199627-1/README.md) では、実unshareのPIDと測定時刻に一致する `apparmor="AUDIT"`・`operation="userns_create"`・`target="unprivileged_userns"` のイベントを確認した。これはprofile遷移の記録であり、UID-map書込みの拒否イベントと同一とは認定していない。

[Ubuntu 24.04の公式仕様](https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions)は、unconfinedな非特権processのuser namespace作成を許容し、その後のnamespace内capability利用を制限する既定profileを説明している。保存イベントはこの説明と整合する。Bash監査取得では4 PIDの時間窓でprofile遷移と能力拒否を追加確認したが、UID-map書込みまでの因果関係とloaded policyの該当規則は未確認である。sysctlやprofileを変更して原因と認定する検証は行わない。

`mode=probe-bash-audit` は既存のBash比較を先にそのまま実行し、比較後に [専用collector](../development/probe-linux-namespace-bash-audit.ts) を別stepで実行する。namespace probeはPerl/Bash各6回・最大12回/architectureで、x64・arm64合計最大24回、unshare版確認は別に各1回。空環境・cwd `/`・閉鎖stdin・通常pipe・非root・5秒/合算32MiBを維持する。

collectorは正式実証で使う `probeAudit` を共有し、sudoを渡さない経路で `/usr/bin/journalctl` の実体を実行する。通常の `proof` / `probe-loop` / `probe-minimize` の既存sudo経路は維持する。新しい読取は呼出しユーザーの権限だけを使い、権限拒否や不完全な結果では後続の検索を省略する。sudoへの自動fallback、追加install、root化、profile/sysctl変更は行わない。

入力は所有する非公開OUTPUT内の `namespace-bash.json` だけとし、`O_NOFOLLOW | O_NONBLOCK` で開き、FIFOで待機せず通常ファイル・非公開mode・256KiB上限を検査する。同じdescriptorから最大256KiB + 1 byteだけ読み、サイズ検査後の追記も上限超過として拒否してからJSONを解析する。source/workflow/run/attemptと両checkoutを照合し、既存6測定器・collector・共有readerの計8ファイルをsource commitのGit blobと両checkoutの内容へ固定する。Bash側の測定前後・非root資格情報・argv・3反復・終了状態・所有PID情報・重複PIDを検査し、全6probeが120秒以内、各probeが5秒以内であることを確認する。検査が全て済むまでjournalを起動しない。

正確な `perl-layer-not-required` でBash最小argv3回が同じUID-map EPERM、対照3回が成功した場合だけ、最小argv側の3 PIDを検索する。対照・Perl・祖先のPIDへ検索を広げない。各検索は既存readerと同じくprobe開始/終了の前後1秒、最大7秒の範囲で、MESSAGE内の一意な非引用 `pid=` tokenとaudit表記を照合する。journalの `_PID` を対象PIDの代わりに使わず、quotedな偽PID・別PID・範囲外時刻を除外する。これはPIDと時刻の対応であり、kernel監査によるPID世代の証明とは扱わない。

[systemd 255の仕様](https://www.freedesktop.org/software/systemd/man/255/journalctl.html)では `--dmesg` がkernel transportと現在bootに限定し、`--grep` がMESSAGEを検索する。読める範囲はcallerの権限に依存する。各検索は5秒・256KiB・101行で上限超過を検知し、最大20イベント・各MESSAGE 4096文字を保持する。2構成合計でkernel journal検索は最大6回、journalctl版確認も最大6回。検索結果が空でも、全kernelログが可視であることや拒否・遷移が無かったことの証明には数えない。retry・`--sync`・ログ全体の取得は行わない。

| collectorの状態 | 意味                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `collected`     | 予定した3 PIDでreaderが `matched` / `no-matching-events` / `empty` を返した。拒否原因の認定ではない |
| `not-requested` | 比較がBash最小条件の正確なEPERMを示さず、検索しなかった                                             |
| `unavailable`   | 出所・入力・PID・時刻の不一致、読取拒否、版確認不可、切り詰めなど。取得済み部分記録は保持する       |

`namespace-bash-audit.json` をwx0600で保存する。`[DEBUG-ns-bash-audit]` はsummary・probe・eventを別JSON行にし、両code hash、collectorのUID/EUID・GID/EGID・補助group・PID namespace、reader実体/hash/版、検索argv・時刻・対象PID・結果を残す。`matched` を `DENIED` と同義にせず、`AUDIT` のprofile遷移も元の内容を保持する。Bash比較がfailureでもcollector stepを実行し、collector自体の未確認・取得不能を比較結果から区別する。

fixtureでは実journalをmockし、正常出力・正確な読取argvと対象3 PID、権限拒否時の停止、出所不一致・不正PID/時刻・root条件・symlink・入力上限と上書き拒否を検証する。実VMの通常権限で一部の該当イベントを読めることは、以下の承認済みrunで確認した。全kernelログの可視性や未一致の原因は未確認である。run/artifact名は `Linux namespace Bash監査` / `namespace-bash-audit-<run>-<attempt>-<arch>` とし、既存の専用準備・正式44件・集約をスキップする。新しい実行は検証・独立レビュー・公開・通常CI後のSHAに固定した1runについて、検索範囲まで明示して承認を得てから行う。artifactの取得・読取は行わない。Phase 2全体・#33は未完了、#82待ちとmacOS 15・全子孫5秒保証を維持する。

確認済み（confirmed）: [run 44438396275 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44438396275) をsource / workflow `dc16ae17848c68f9ea28e960d226aad4b3e16bec`、mode `probe-bash-audit` で承認どおり1回実行した。両構成とも `perl-layer-not-required` で、Perl/Bashの最小argvは各3/3同じEPERM、対照は各3/3成功した。比較stepは予定exit 1でfailure、監査stepは両構成で成功・`collected`。全24 probeにsignal・spawn error・ログ省略はなかった。

| architecture | Bash最小argvのPID | PID・時間窓に対応する監査                                               |
| ------------ | ----------------- | ----------------------------------------------------------------------- |
| x64          | 2524 / 2528       | 各PIDで `AUDIT userns_create` 遷移と `DENIED capable sys_admin` を各1件 |
| x64          | 2532              | `no-matching-events`                                                    |
| arm64        | 2632 / 2636       | 各PIDで `AUDIT userns_create` 遷移と `DENIED capable sys_admin` を各1件 |
| arm64        | 2640              | `no-matching-events`                                                    |

4件の拒否は `profile="unprivileged_userns" operation="capable" capability=21 capname="sys_admin"` で、遷移イベントの `target="unprivileged_userns"`、対象PIDと `comm="unshare"` に対応した。従来のcaller観測から進み、実unshareのPIDに対応するAppArmorの能力拒否を直接取得できた。これをUID-map書込みの特定syscallとの因果関係や、全6 PIDの拒否イベントを得た証明とは扱わない。

collectorのUID/EUID/GID/EGIDは両構成とも1001で、sudoを経由していない。検索は最小argvの3 PID/architectureのみ、合計6回と版確認6回で、再検索・窓拡大は行わなかった。各窓は開始/終了±1秒の約2秒、readerは両構成ともsystemd 255。未一致2 PIDについて、拒否・遷移の不存在や監査抑制・遅延の有無は未確認である。

[実行記録と選択した公開JSON](evidence/linux-namespace-bash-audit/44438396275-1/README.md) に、比較JSON36行・監査JSON16行の計52行と、公開run metadata14項目・3jobのstep結果を保存した。sourceの8ファイルをGit blobと照合し、全て一致した。CodeRabbitは `127b7b0` の4項目成功、その3指摘を直した `dc16ae1` の追加評価は回数制限で未完了という制約を了承した承認後の1runである。修正差分の独立した仕様・規約レビューは各指摘0件、通常CI全6ジョブは成功している。

専用Nix/group準備・正式44ケース・集約はスキップし、既存Bun setupを保持した。新規install・Cビルド・root化・profile/sysctl変更・artifactの取得/読取は行っていない。原因確定とPhase 2全体の完了は未認定。UID-map書込みと能力拒否の対応、loaded policyの根拠、残る固定条件を次の判断対象とし、#33未完了・#82待ち、macOS 15と全子孫5秒保証を維持する。

## mapping関連操作の最小化: namespace作成だけを残す

公開sourceの [対応調査](linux-namespace-capability-mapping.md) で、`--map-current-user` がnamespace作成とUID/GID mapping関連操作をまとめて指定することを確認した。版を固定したUbuntu kernelではUID-map書込みの先行する `CAP_SYS_ADMIN` 検査からAppArmorの能力検査へ進む経路があり、取得済みの拒否と整合する。実VMの完全なpackage版・loaded policy・当該syscallの直接traceは未確認で、原因確定とは扱わない。

`mode=probe-userns` は既存の共通Bash比較を再利用する。Perl baselineは従来の最小argv `--map-current-user -- /usr/bin/true` と普通の対照 `-- /usr/bin/true` を各3回測る。正確なUID-map EPERMと対照成功を確認した場合だけ、同じBashから最小argvと新しい対照 `--user -- /usr/bin/true` を各3回測る。両Bash条件でuser namespace作成を保ち、mapping関連操作の有無を比べる。UID書込みだけを分離する実験ではない。

共通Bashと上位祖先、非root、空環境、cwd `/`、閉鎖stdin、両streamの通常pipeとflags、所有PID・pidfdの扱い、各probeの5秒・合算32MiB、sourceと実行体hashの検査を引き継ぐ。checkpointへ比較方式を固定し、段階間の変更を拒否する。namespace probeは最大12回/architecture、x64・arm64で最大24回、unshare版確認は別に各1回。baselineが全成功ならBash側を省略し、別エラー・混在・条件不一致でも進まない。

| 結果                  | 条件                                                                                      | 最終終了コード |
| --------------------- | ----------------------------------------------------------------------------------------- | -------------- |
| `id-mapping-required` | Perl baselineが再現し、Bash最小argvは3回同じEPERM、Bashのnamespace作成だけの対照は3回成功 | 1              |
| `bash-not-reproduced` | Perl baselineが再現し、Bash最小argvとnamespace作成だけの対照が各3回成功                   | 1              |
| `not-reproduced`      | Perl baselineの最小argvと普通の対照が各3回成功。Bash側を省略                              | 0              |
| `unavailable`         | 別エラー、混在、対照失敗、観測不足、方式・出所・callerなどの不一致                        | 2              |

`id-mapping-required` は今回の指定条件でmapping関連操作が再現に必要という限定した結果である。`bash-not-reproduced` はBash側の未再現だけを述べ、対照が異なるPerl/Bashの起動層依存とは命名しない。どちらも元の症状の修正成功ではない。

最終結果は `linux-namespace-userns-comparison/v1` の `namespace-userns.json`、公開ログは `[DEBUG-ns-userns]`。共有する途中ファイル名 `namespace-bash-*` は専用OUTPUT内に保持する。run名は `Linux namespace mapping比較: <source SHA>`、artifact名は `namespace-userns-<run>-<attempt>-<arch>`。専用Nix/group準備・正式44件・集約をスキップし、既存Bun setupを維持する。root化・設定変更・追加install・kernel journal検索・artifact取得/読取は行わない。

実子fixtureで新しい対照argv、直接Bash親、fd・環境条件、3反復、対照の別エラー、元の対照への差替え拒否、方式変更拒否、baseline成功時の省略を検証する。実VMの比較は、検証・独立レビュー・公開・通常CIとCodeRabbit評価を終えた `e25a535` に固定し、1runの承認後に実行した。Phase 2全体・#33は未完了、#82待ち、macOS 15と全子孫5秒保証の未解決を維持する。

確認済み（confirmed）: [run 44458506354 / attempt 1](evidence/linux-namespace-userns/44458506354-1/README.md) をsource / workflow `e25a535074c26f2520d1e09b4f9ac6cf26ff354c`、mode `probe-userns` で承認どおり1回実行し、両構成とも `id-mapping-required` だった。

| architecture | Perl最小argv / 普通の対照 | Bash最小argv / namespace作成だけの対照 |
| ------------ | ------------------------- | -------------------------------------- |
| x64          | 3/3同じEPERM / 3/3成功    | 3/3同じEPERM / 3/3成功                 |
| arm64        | 3/3同じEPERM / 3/3成功    | 3/3同じEPERM / 3/3成功                 |

Bashの比較ではnamespace作成を保った対照が成功し、mapping関連操作付きの最小argvで同じEPERMが続いた。今回の指定条件ではmapping関連操作が再現に必要だった。UID/GID mappingとsetgroups指定をまとめて省いており、UID書込みだけの分離や原因確定とは扱わない。

全24回にsignal・spawn error・ログ省略はなく、Bashのwait statusはexit statusと一致し、全観測子はexit 0だった。各VM内の共通Bashと上位祖先、caller、測定前後、runtime / unshareのhashを照合し、測定器6ファイルのhashが対象commitのGit blobと一致した。比較stepは両構成とも予定exit 1でfailure、専用準備・正式44件・監査・集約はスキップした。

[実行記録](evidence/linux-namespace-userns/44458506354-1/README.md) に公開JSON各18行・計36行の全値と掲載順、公開run metadata14項目・3jobのstep結果、exit 1の終了行を保存した。実行対象の独立レビューは各指摘0件、通常CI全6ジョブとCodeRabbitの同じheadに対する4評価項目は成功している。追加dispatch・kernel journal検索・設定変更・新規install・artifactの取得/読取は行っていない。

今回のrunで拒否時LSMを観測したものではなく、前回runの監査PIDを今回のPIDへ対応させない。実VMの完全なpackage版、loaded policy、当該syscallの直接因果と、残る固定条件の要否は未確認。Phase 2全体・#33未完了、#82待ち、macOS 15と全子孫5秒保証の未解決を維持する。

## UID mapping単独の最小化

前回の [namespace作成だけを残す比較](evidence/linux-namespace-userns/44458506354-1/README.md) は、UID/GID mappingとsetgroups指定をまとめて省いたものだった。次の `mode=probe-uid` は、同じBash内に現行argvとUID-onlyの両方を置き、GID mappingとsetgroups指定を省いても同じUID-map EPERMになるかを測る入口である。

util-linux `v2.39.3` の [固定manual source](https://github.com/util-linux/util-linux/blob/2da5c904e18fdcffd2b252d641e6f76374c7b406/sys-utils/unshare.1.adoc#L93) は、`--map-user=<UID>` が現在の実効UIDを指定UIDへmappingし、`--user` を含むと説明する。`--map-group` と `--map-current-user` は `--setgroups=deny` も含む。manualのSHA-256は `723f7dbb45ca1d04a90a6cad1407d482083c0ee6cbf4e7c2619b33b3df745db8`。実VMの完全なpackage revisionやbinaryとの同一性は引き続き未確認である。

既存Perl基準測定の最小argvと普通の対照を各3回測り、正確なEPERMと対照成功を確認した場合だけ、同じ共通Bashから次の3caseを各3回実行する。

| case       | argv                                           | 役割                                              |
| ---------- | ---------------------------------------------- | ------------------------------------------------- |
| `minimal`  | `--map-current-user -- /usr/bin/true`          | 今回のBashでも元の最小条件が再現することを確認    |
| `uid-only` | `--map-user=<Bashの現在EUID> -- /usr/bin/true` | 同じUIDのmappingを残し、GID / setgroups指定を省く |
| `control`  | `--user -- /usr/bin/true`                      | namespace作成だけの成功対照                       |

EUIDは1001へ固定せず、Bashのreadonly `EUID` と、Bashとのcaller一致を検査するPython観測子の `os.geteuid()` から同じ数値を得る。UID-onlyの直前に、観測子が数値EUIDの文字列だけを、Ubuntu glibcの `getpwnam_r` で1回検索する。戻り値0・結果pointerなしだけを正常な未登録とし、結果pointerがある場合はUIDだけを参照する。戻り値が非0なら `EIO`・`ERANGE` などの限定したエラー名を残して停止する。bufferは64KiB固定で、拡張・再試行はしない。[CPython 3.12.3の実装](https://github.com/python/cpython/blob/v3.12.3/Modules/pwdmodule.c#L226) は検索障害も `KeyError` へ変換するため、この例外を未登録の根拠には使わない。bindingは対象Ubuntu x64 / arm64の [glibc 2.39のpasswd定義と関数宣言](https://github.com/bminor/glibc/blob/glibc-2.39/nss/pwd.h#L45) に固定し、[getpwnam_rの戻り値契約](https://man7.org/linux/man-pages/man3/getpwnam.3.html#RETURN_VALUE) に従う。同名アカウントがない場合は数値へのfallback、同じUIDの場合は同じmappingとして続行する。別UIDへ解決される場合や検索エラーでは、UID-onlyと後続対照を起動せず `unavailable` とし、Perl基準とBash現行argvの途中記録を残す。検索対象名と結果のUID・分類・限定したエラーを `namespace-uid-name-check.json` と最終結果・公開ログへ残し、passwdの他の値は参照・出力せず、一覧も取得しない。検索は各構成最大1回・計2回で、実unshare内の後続検索との間のNSS変化までは保証しない。namespace内のUID 0へのmappingは指定しない。Perl 6回とBash 9回の最大15 namespace probe/architecture、x64・arm64で最大30回。unshare版確認は別に各1回、計2回。Bashの3caseを同じ親で測ることで、起動層の変更とUID-onlyの効果を混同しない。

| 結果                         | 条件                                                                                                     | 最終終了コード |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | -------------- |
| `uid-mapping-reproduced`     | Perl基準が再現し、Bashの現行argvとUID-onlyが各3回同じEPERM、namespace-only対照が3回成功                  | 1              |
| `uid-mapping-not-reproduced` | Perl基準とBashの現行argvは同じEPERM、UID-onlyとnamespace-only対照が各3回成功                             | 1              |
| `not-reproduced`             | Perl基準の最小argvと普通の対照が各3回成功。Bash側は省略                                                  | 0              |
| `unavailable`                | 名前解決の不一致・失敗、Bash現行argvの未再現、対照失敗、別エラー、混在、観測不足、方式や出所などの不一致 | 2              |

Bashの現行argvと成功対照から再現を確認し、その同じ対照とUID-onlyを比べる。両比較は全raw結果から再計算する。`uid-mapping-not-reproduced` はUID-onlyのargvで未再現だったという結果で、GID mappingまたはsetgroupsのどちらかが原因と確定するものではない。どちらのexit 1も元の症状の修正成功ではない。再現と最小化の完了は、各runの実測に基づいて判断する。

空環境・cwd `/`・閉鎖stdin・両streamの通常pipeとflags、非root、共通Bashと上位祖先、PID世代・所有権・pidfd、各5秒/合算32MiB、sourceと実行体hash、checkpointの方式固定を維持する。全15 probeのPID重複も拒否する。UID-only途中のcaptureが壊れても、case / 反復番号 / 例外を保存し、他の正常captureとPerl基準測定を最終結果とログへ残す。

最終出力は `linux-namespace-uid-comparison/v1` の `namespace-uid.json`、公開ログは `[DEBUG-ns-uid]`。途中ファイルは既存の専用OUTPUT内に保存し、既存ファイルは上書きしない。run名は `Linux namespace UID mapping比較: <source SHA>`、artifact名は `namespace-uid-<run>-<attempt>-<arch>`。専用Nix/group準備・正式44件・集約を省略し、既存Bun setupを保持する。journal検索・設定変更・root化・新規install・artifact取得/読取は行わない。

実VM実行は、テスト・独立レビュー・公開・[通常CI全6ジョブの成功](https://github.com/treflebonbon/skills/actions/runs/44539023151)を確認した `915de5f` に固定した。CodeRabbitの同sourceへの追加評価は回数制限で未完了であり、この制約と最大30 namespace probe・版確認2回・数値名検索最大2回を示した1runをユーザーが承認した後に実行した。承認分は完了し、追加実行には対象と範囲を示した別の承認を得る。

確認済み（confirmed）: [run 44542479679 / attempt 1](evidence/linux-namespace-uid/44542479679-1/README.md) をsource / workflow `915de5f50fa2ff3154b1cb0dd71cdbc596ff87ad`、mode `probe-uid` で承認どおり1回実行し、両構成とも `uid-mapping-reproduced` だった。数値名検査は各1件、`requestedUid=1001`、`resolvedUid=null`、`resolution=numeric-fallback`、`outcome=ready` で、最終結果の検査記録と全値が一致した。固定sourceは `getpwnam_r` の戻り値0かつ結果pointerなしだけを正常な未登録と分類する。

同じBashの現行argvと `--map-user=1001 -- /usr/bin/true` は各3回同じUID-map EPERM、namespace-only対照は各3回成功した。GID mappingとsetgroups指定を省いたargvでも、このrun内の条件で症状が再現した。検査後の実unshare内のNSS検索までの変化は直接観測していない。

全30 probeにsignal・spawn error・ログ省略はなく、各VMの15 PIDは重複しなかった。全probeの時刻は各job内に収まり、Bash側のwait statusはexit statusと一致、全観測子はexit 0。共通Bashと祖先、caller、測定前後、runtime / unshareのhashを照合し、測定器6ファイルのhashが対象commitのGit blobと一致した。

[実行記録](evidence/linux-namespace-uid/44542479679-1/README.md) に公開JSON各22行・計44行の全値と掲載順、公開run metadata14項目・3jobの全step、exit 1の終了行を保存した。両jobは予定exit 1でfailure。専用準備・正式44件・監査・集約はスキップし、既存Bun setupを保持した。追加dispatch・journal検索・設定変更・既存Bun setup以外の追加install・artifact取得/読取は行っていない。

今回のx64は `7.0.0-1014-aws`、arm64は `7.0.0-1017-azure`。x64は [旧run](evidence/linux-namespace-uid/44486490046-1/README.md) とimage・kernel・祖先などが異なるため、run間で検索検査だけを変えた差分実験とは扱わず、今回の各VM内の比較として解釈する。旧runの数値名解決は未記録のままで、今回の検査によって遡って確認したことにはしない。旧runのJSONは変更していない。

これはUID mappingを指定したCLIの再現であり、実unshareのsyscall列やAppArmor拒否との直接因果を観測したものではない。前回runの監査PIDを今回のPIDへ対応させず、Azure kernelの公開sourceを新しいx64 kernelへそのまま対応させない。完全なpackage版・loaded policy・直接因果と、残る固定条件の要否は未確認。Phase 2全体・#33未完了、#82待ち、macOS 15のcontainment方式と全子孫5秒保証の未解決を維持する。

## 次の最小化: UID-mapを直接書き込む

`mode=probe-uid-write` は[run 44633267572](evidence/linux-namespace-uid-write/44633267572-1/README.md)で承認された1回を実行済みの診断である。同じVM・同じBashで既存の `probe-uid` 基準15回を実行し、Perlの最小argvとBashの最小argv・現在EUIDのUID-onlyが各3回同じEPERM、対照が各3回成功した場合だけ直接経路へ進む。数値名検査も既存の1回を再利用し、追加検索は行わない。

直接経路はPython 3.12以降の標準 [`os.unshare()`](https://docs.python.org/3.12/library/os.html#os.unshare) を使う。同じBashからPythonを空環境・cwd `/`・閉鎖stdin・stdout/stderrの通常pipeで起動する。Pythonのlocale coercionが追加し得る既知の `LC_CTYPE` だけを `os.unsetenv()` で消し、環境全体を読み出さない。新しいFFI、Cビルド、依存導入は不要である。

| 直接case  | 各3回の操作                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `map`     | `unshare(CLONE_NEWUSER)` → `open("/proc/self/uid_map", O_WRONLY\|O_CLOEXEC)` → 現在EUIDの1行 `UID UID 1\n` を1回write → close |
| `control` | `unshare(CLONE_NEWUSER)` の成功後、mapを開かず終了                                                                            |

作成・open・writeの結果とerrnoを別々に記録する。stdinが閉じているためmapをfd 0で開く場合も閉じる。短いwrite、close失敗、作成やopenのEPERM、別errno、成功と失敗の混在、対照の失敗は `unavailable` とする。直接writeのEPERM 3回と直接対照の成功3回が揃う場合だけ `direct-write-reproduced`。直接経路が全6回成功なら `direct-write-not-reproduced` とする。どちらも同じVMの元の失敗は残るため、最終終了コードは1である。Perl基準が全成功なら直接経路へ進まず `not-reproduced` / 終了コード0。それ以外は終了コード2。

実行上限は各構成21 probe、x64・arm64合計42 probe。版確認は合計2回、数値名検査は最大2回である。比較stepの上限4分、直接probeごとのtimeout 5秒・合算出力32MiB、所有PID・世代・pidfd・実行体hash、共通Bashと上位祖先・callerの検査を維持する。7ファイルのsourceとPython実行体をcommitへ固定し、基準と直接経路を別のVMの結果から組み合わせない。

結果は `namespace-uid-write.json`、artifact名は `namespace-uid-write-<run>-<attempt>-<arch>`。既存の `[DEBUG-ns-uid]` に続き、直接経路を `[DEBUG-ns-uid-write]` のJSON行で記録する。正常に読めた途中captureも基準全体とともに保存し、後続のcontext・source検査が失敗しても失わない。各streamの公開ログは1024文字までで、省略を明示する。

専用Nix/group準備、root化、sysctl/profile変更、journal検索、正式44ケース・集約は行わない。Pythonの起動と直接操作を含む比較なので、直接経路が成功してもutil-linux固有の原因とは確定しない。新しいVMのkernel/imageが以前と異なる可能性もあるため、そのVM内の再現を比較の前提とする。Phase 2全体・原因確定・ADR 0003の条件は未完了のまま維持する。追加dispatchは公開済みSHAと上限を示し、1回ごとに確認する。

### 直接書込み比較の結果

[run 44633267572 / attempt 1](evidence/linux-namespace-uid-write/44633267572-1/README.md) では、両構成で新しいVM内のPerl/Bash/UID-only基準を再現した後、直接mapのnamespace作成・openが各3回成功し、writeだけが各3回 `errno=1 / EPERM` になった。直接のnamespace-only対照は各3回成功した。両構成とも `direct-write-reproduced` / 予定exit 1である。各21・計42 probeと公開JSON64行を照合した。

この条件ではutil-linuxを起動せずUID-mapのwrite失敗を再現できた。拒否段階を作成・openから分離できたが、どのkernel/LSM規則が返したEPERMかや、以前のCLIの拒否と同じ規則かは未確認。Pythonの初期化・共通Bashと上位祖先・OS/LSM条件も残る。Phase 2全体・原因確定・#33未完了、#82待ち、macOS 15と全子孫5秒保証の未解決を維持する。

### Phase 4の監査観測

`mode=probe-uid-write` に `uid_write_audit=true` を指定すると、arm64の1ジョブで同じ測定を行う。既存基準15回の後、直接writeが3回ともEPERMで、namespace作成だけの対照が3回とも成功した場合、比較の終了後に6 PIDを各1回、通常権限のkernel journalで検索する。各検索の時間窓は測定の前後1秒を含めて最大7秒。検索と版確認は各最大6回で、読取不能や出力上限超過で打ち切る。

監査の結果は `namespace-uid-write-audit.json` と `[DEBUG-ns-uid-write-audit]` に記録する。公開するのは対象PID・測定時刻と、対応するAppArmorの遷移・`sys_admin` 拒否の定型項目、検索状態である。一致した拒否が失敗側で得られればAppArmor仮説を支持する。遷移だけ、イベントの不一致、読取不能は判定保留とする。検索の一致だけでwrite syscallの個別の戻り箇所は特定できない。

[run 44657370169 / attempt 1](evidence/linux-namespace-uid-write-audit/44657370169-1/README.md) で承認されたarm64の1回を実行した。直接mapのnamespace作成とopenは3/3成功、writeは3/3 `EPERM`、namespace-only対照は3/3成功した。通常権限で6 PIDの検索は完了し、全件 `no-matching-events`。監査の可視性を確認する同一VM内の陽性対照がなく、AppArmor仮説は判定保留とする。測定器7ファイルは前回から同一で、今回のimage `20261111.182.1` は前回と異なった。

### 同一VMでのBash基準との監査比較

追試では直接測定と既存のarm64・非root条件を固定し、同じVMで先に実行済みのBash最小argvの失敗3 PIDを監査の陽性対照に加える。直接mapとnamespace-onlyの6 PIDに続けて、Bash基準の3 PIDを同じreaderで各1回検索する。BashのUID-only・成功対照は基準の結果と所有PIDの検査に使う。Bash基準の出所、共通Bashとcaller、期待するEPERM、PID重複と測定順序を検索前に照合する。各検索の窓と1回あたりの上限を引き継ぎ、検索と版確認は各最大9回とする。

監査記録のschemaは `linux-namespace-uid-write-audit/v2`、Bash基準のroleは `bash-baseline`。Bash基準にも同じ定型項目を使い、対象実行体 `unshare` の `sys_admin` 拒否が取得できれば、そのVMでの監査の可視性を確認できる。直接map側でも対応する拒否が取れればAppArmor仮説を支持する。Bash側だけで取れれば監査上の経路差を確認できる。両方で対応する拒否を取得できなければ可視性と原因は判定保留とする。

[run 44665415403 / attempt 1](evidence/linux-namespace-uid-write-audit/44665415403-1/README.md) では、直接writeが3/3 EPERM、namespace-only対照が3/3成功。Bash基準の2/3 PIDでAppArmorの遷移と `sys_admin` 拒否を取得し、同じVMのreaderで読めることを確認した。直接比較の6 PIDとBash基準の残り1 PIDは0件だった。直接子のlabelとwriteを拒否した検査は未確定で、直接writeへのAppArmor仮説は判定保留とする。

### 直接子のAppArmorラベル観測

`mode=probe-uid-write` に `uid_write_label=true` を指定すると、同じarm64 VMで既存の基準15回と直接比較6回を実行する。直接子のmap側はwriteと既存のfd cleanupの後、成功対照はnamespace作成後に、AppArmorの現在ラベルを `/proc/self/attr/apparmor/current` から読み取る。読み取るのは1子につき1回、最大256バイトで、公開記録には既知のラベルまたは読取状態とerrnoだけを載せる。観測値は直接子の従来の操作・errno記録に追加し、ラベル読取の結果で操作結果や終了コードを変えない。観測指定はjournal監査と排他的で、比較の起動条件と基準判定を引き継ぐ。

直接mapが同じEPERMで `unprivileged_userns` を確認できれば、直接経路にも当該プロファイルが適用されるという予測を支持する。 `unconfined` を確認できれば、同プロファイルによる拒否の優先度を下げる。いずれもwriteを拒否した個別の検査の確定には至らず、未知のラベル・読取不能・再現の変化は判定保留とする。[LinuxカーネルのLSMインターフェース](https://www.kernel.org/doc/html/latest/userspace-api/lsm.html)

[run 44670151286 / attempt 1](evidence/linux-namespace-uid-write-label/44670151286-1/README.md) では、直接mapのwriteが3/3 EPERM、namespace-only対照が3/3成功。操作後に全6子から `unprivileged_userns (enforce)` を取得した。プロファイル適用の予測は支持され、直接writeを拒否した個別の検査は未確定である。

### UID-mapのカーネル戻り値トレース

`mode=probe-uid-write` と `uid_write_trace=true` の組合せは、既知の `7.0.0-1017-azure` を使う `ubuntu-24.04-arm` の1ジョブに限定する。チェックアウトとworkflowを同じSHAに固定し、AppArmorの状態、既設のtracefs、必要な関数、使用名の衝突がないことを事前に読み取る。前提が揃った場合に既存の基準15回と直接比較6回を行い、直接map最初の1回とnamespace-only最初の1回の計2子だけを観測する。BashがPIDを得た後、子の元のexec開始を許可する前に、所有PID・非root UIDを照合して観測を有効にする。登録できなければ対象子のexecを止め、比較を未確認として保存する。繰り返しの残りと、既存の監査・ラベル観測の各modeは従来の経路で動く。

管理権限を使うのは観測担当のcheck・arm・finish・cleanup。測定対象は既存の非root条件とargv・空環境・cwd・標準fdを保つ。専用のtracefsインスタンスと今回のrun・attempt・roleで名前を分けたイベントを使い、カーネルのイベントフィルタを対象PIDに設定する。公開ログ `[DEBUG-ns-uid-write-trace]` には対象PID・役割・状態と、UID-map writeおよびその中の能力検査の時刻・能力番号・戻り値だけを載せる。読取は対象ごとに最大256KiB、バッファ欠落や開始／終了の不一致は未確認とする。動的イベント登録と解除には追記を使い、終了時に今回のイベントだけを解除する。カーネル、AppArmor、sysctlは既存設定を使う。[LinuxカーネルのKprobeイベント](https://www.kernel.org/doc/html/latest/trace/kprobetrace.html)

同じwrite内で `file_ns_capable` の `CAP_SYS_ADMIN` 検査に入ったこと、AppArmor hookが `-EPERM` を返したこと、能力検査がfalse、writeが `-EPERM` を返したことを対応付けられれば、直接writeの拒否経路を支持する。先行する能力検査がtrueでwriteがEPERMなら、その後のUID mapping検査を候補とする。観測前提が満たせない場合、対象writeが再現しない場合、hookの列を対応付けられない場合は判定保留とする。

[初回のrun 44677143069](evidence/linux-namespace-uid-write-trace/44677143069-1/README.md) は前提確認と非root基準15回を通過し、最初の直接mapの観測設定が `EINVAL` で停止した。対象子のexecは中止し、解除は成功した。公開sourceを照合し、Python追記ストリームのseekを使わない `O_APPEND` の単一writeへ修正した。管理権限の観測範囲は同じで、失敗時は設定ファイルまたはイベント名を定型の理由に含める。修正後の実VMでの登録可否と直接writeの拒否経路は未確認である。
