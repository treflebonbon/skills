# Linux namespace の再現ループ

状態: Phase 1 の入口を準備中。実 VM でこのループが今回の EPERM を再現することは、まだ確認していない。[run 44049468642 / attempt 1](evidence/linux-process-proof/44049468642-1/README.md) の失敗記録と [ADR 0003](adr/0003-os-specific-preparation-containment.md) の条件を引き継ぐ。

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

実VMでの再現率と反復時間、fork後の子PIDとの対応付け、子側の拒否イベントと実際のpolicyは未確認。現在のaudit取得範囲は起動した親PIDのままで、子の情報を観測したとは扱わない。

まず実際の症状で赤になる短いループを確認し、その後に再現条件を一つずつ減らす。原因仮説や修正の検証へは、この確認後に進む。診断モードで3回成功しても、44ケースの互換性や全子孫5秒保証の成功には数えない。#33は未完了、#82は#33待ち、macOS 15の方式は保留を維持する。
