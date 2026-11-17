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

`probe-minimize SOURCE OUTPUT` とworkflowの `mode=probe-minimize` を用意した。実VMではまだ未実行。最初に従来の `preflight` を3回測り、他の前提エラーがなく3回とも対象EPERMになる場合だけ削減へ進む。

元の6オプションから一つだけ外し、同じ選択実体・継承環境・非root callerで各候補を3回実行する。3回とも同じstderr全文・exit 1の場合だけ削減を採用して先頭から試し直す。成功した候補は採用せず、別エラーも成功には数えない。候補の3反復が混在する、timeoutなどで完了しない場合は停止する。最後に残った条件でEPERMを3回再確認する。

残る各オプションを外すと3回とも成功し、残した条件は3回ともEPERMなら、`minimization.outcome = minimal-options`。別エラーのまま残ったオプションがあれば `incomplete`、観測不足や混在なら `unavailable` として終了コード2にする。対象EPERMが続く `minimal-options` は終了コード1であり、原因修正の成功ではない。元の前提検査が3回とも成功なら削減せず終了コード0。

候補は最大21組、最後の確認1組、最初の前提検査3回を合わせ最大69回のprobeに限る。結果は `namespace-minimize.json`、artifactは `namespace-minimize-<run>-<attempt>-<arch>`、run名は `Linux namespace オプション削減: <source SHA>`。各argv・PID・時刻・終了状態・限定auditを記録する。正式実証の集約はスキップする。

これは6オプションに限った1個ずつの削減確認であり、再現条件全体の最小化完了ではない。実行体、LSM、非root条件、継承環境、workflow準備、終了用の `-- /usr/bin/true` は固定する。任意コマンドやshellの実行へ広げず、sysctl / profileを変更しない。次の実測結果で、準備・caller・環境をさらに削減できるか判断する。原因仮説へ進む前に、残った固定条件の根拠も確認する。

```bash
bun control/development/run-linux-process-proof.ts probe-minimize "$GITHUB_WORKSPACE/subject" "$RUNNER_TEMP/linux-proof"
```

追加dispatchと生成runのartifact取得は、新しいsource SHAを示して事前に確認する。
