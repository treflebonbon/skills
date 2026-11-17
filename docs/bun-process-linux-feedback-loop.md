# Linux namespace の再現ループ

状態: [run 44078199627 / attempt 1](evidence/linux-namespace-loop/44078199627-1/README.md) でx64 / arm64各3回、同じEPERMを再現した。前提検査は1回約0.22〜0.49秒で、Phase 1は確認済み。Phase 2の最小化と原因の確定は未完了。[run 44049468642 / attempt 1](evidence/linux-process-proof/44049468642-1/README.md) の失敗記録と [ADR 0003](adr/0003-os-specific-preparation-containment.md) の条件を引き継ぐ。

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
