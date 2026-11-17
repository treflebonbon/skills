# Linux namespace 再現ループ: run 44078199627 / attempt 1

2026-11-17 に実行と専用artifact 2件の取得を承認された診断run。Ubuntu 24.04 x64 / arm64の同じ準備・非root条件で、元のUID mappingのEPERMを各3回、計6回再現した。**Phase 1の再現ループは確認済み、Phase 2の最小化は未実施、原因は未確定**。

| 項目                  | 記録                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| workflow / ref / mode | `linux-process-proof.yml` / `integration/python-to-bun` / `probe-loop`             |
| source / workflow SHA | `cd4707793e32ffd25c26ed5552d6cac8c0a8d06c`                                         |
| run / attempt         | [44078199627 / 1](https://github.com/treflebonbon/skills/actions/runs/44078199627) |
| 診断結果              | 両jobとも `uid-map-eperm`、終了コード `1`                                          |
| 正式実証              | 44ケースのstepと集約jobは `skipped`                                                |

## 実行したコマンドと観測

同じworkflowの準備後、両VMで次を実行した。

```bash
bun control/development/run-linux-process-proof.ts probe-loop "$GITHUB_WORKSPACE/subject" "$RUNNER_TEMP/linux-proof"
```

x64の出力（時間は前提検査全体）:

```text
[DEBUG-ns-loop] 反復=1 結果=uid-map-eperm 時間ms=486.515
[DEBUG-ns-loop] 反復=2 結果=uid-map-eperm 時間ms=236.740
[DEBUG-ns-loop] 反復=3 結果=uid-map-eperm 時間ms=276.241
Process completed with exit code 1.
```

arm64の出力:

```text
[DEBUG-ns-loop] 反復=1 結果=uid-map-eperm 時間ms=338.901
[DEBUG-ns-loop] 反復=2 結果=uid-map-eperm 時間ms=225.880
[DEBUG-ns-loop] 反復=3 結果=uid-map-eperm 時間ms=224.390
Process completed with exit code 1.
```

6回ともprobeはexit 1、signalと実行エラーなし、stdoutは空、stderrは次の1行。前提エラーはnamespace probeの失敗だけで、別の前提不足はない。各3反復の前提検査は合計約1.00秒 / 0.79秒で終わった。workflowのVM起動・依存準備の時間は含めない。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

| architecture | kernel             | UID / EUID      | probe PID（反復順）    | probe開始〜終了（UTC）                                 |
| ------------ | ------------------ | --------------- | ---------------------- | ------------------------------------------------------ |
| x64          | `7.0.0-1014-aws`   | `1001` / `1001` | `4205`, `4250`, `4295` | `11:55:10.141`〜`.144`、`.381`〜`.382`、`.646`〜`.647` |
| arm64        | `7.0.0-1017-azure` | `1001` / `1001` | `4279`, `4324`, `4369` | `11:55:00.329`〜`.334`、`.560`〜`.562`、`.784`〜`.786` |

Bunは両VMとも `1.4.4`、選択実体は `/usr/bin/unshare`、util-linux `2.39.3`。argvは次のまま。別binary・root・LSMの緩和は使用していない。

```text
--user --map-current-user --pid --fork --kill-child=SIGKILL --mount-proc -- /usr/bin/true
```

## auditと直接観測の限界

全6回で親probeのPID・実行時間に一致する `AUDIT / userns_create` が1件ずつあり、`unconfined` → `unprivileged_userns` の遷移を記録した。`DENIED` は取得していない。親PIDだけの検索なので、fork後の子の拒否eventの有無は分からない。

各VMの反復1は短命で直接観測に間に合わなかった。反復2・3では同じ開始識別値と選択実体を持つprocessを観測したが、profileは `unconfined`、`CapEff`は0だった。audit遷移より前のsampleであり、UID mapping失敗時のprofile / capabilityの証拠にはしない。実policy本文・版も未取得。

## 保存した証跡

- [run.json](run.json): 取得したrun・job・stepの終了状態。
- [loop.json](loop.json): 両artifactの `namespace-loop.json` から、run / source / workflowの識別値、controller hash、3回分の前提検査とprobe / auditを選択した記録。環境fieldは既存の7キーだけ。source hash一覧は元artifactに残る。

| 元artifact                           | 元JSONのbyte数 | 展開した元JSONのSHA-256                                            |
| ------------------------------------ | -------------- | ------------------------------------------------------------------ |
| `namespace-loop-44078199627-1-x64`   | `62820`        | `082f978b18791750c0cf92ed408e30782ecf9d376ed98d1324f2e58ddfcdce3e` |
| `namespace-loop-44078199627-1-arm64` | `61798`        | `962f2f361947d773945fc6c88c99a17a2570bf24b2c93fc60d561ae5e94d661d` |

ここでのhashは展開したJSONのbyte列で、GitHubのartifact bundle digestではない。artifact ID / bundle digest / 実際の保存期限は今回の取得では照会していない。

## 維持する判定

これは診断ループの再現結果で、正式実証の成功や原因修正ではない。[前回の正式runの未達](../../linux-process-proof/44049468642-1/README.md)と[ADR 0003](../../../adr/0003-os-specific-preparation-containment.md)を維持する。#33は未完了、#82は#33待ち、macOS 15の方式は保留。次はオプションを一つずつ減らす。再現条件全体の最小化が済むまで原因仮説の検証へ進まない。
