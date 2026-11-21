# Linux namespace 独立測定: run 44185969872 / attempt 1

2026-11-18 に承認された範囲で1回実行した。両構成とも、専用のNix/group準備なしで元argvと最小候補が各3回同じUID mappingのEPERMとなり、オプションを外した対照は各3回成功した。**最小argvと準備step省略後の再現を直接確認した。原因確定とPhase 2全体の最小化は未完了**。

| 項目                  | 記録                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| workflow / ref / mode | `linux-process-proof.yml` / `integration/python-to-bun` / `probe-isolate`          |
| source / workflow SHA | `a7ca9ca3c82fa4576c888d527c02cdf41c5ba7fc`                                         |
| run / attempt         | [44185969872 / 1](https://github.com/treflebonbon/skills/actions/runs/44185969872) |
| controller SHA-256    | `aeea4e6232c6796dea41f25bba400ab1f5ac432d6470ebefd33962c6a5639b31`                 |
| 実績                  | x64 / arm64 各9回、合計18回                                                        |
| 実行状態              | 両診断stepは終了コード1。専用準備・正式44ケース・集約はスキップ                    |

## 実行したコマンドと結果

新しいVMで、Bun 1.4.4から次を実行した。

```bash
bun control/development/run-linux-process-proof.ts probe-isolate "$GITHUB_WORKSPACE/subject" "$RUNNER_TEMP/linux-proof"
```

| case     | argv                                                                                        | x64       | arm64     |
| -------- | ------------------------------------------------------------------------------------------- | --------- | --------- |
| original | `--user --map-current-user --pid --fork --kill-child=SIGKILL --mount-proc -- /usr/bin/true` | 3/3 EPERM | 3/3 EPERM |
| minimal  | `--map-current-user -- /usr/bin/true`                                                       | 3/3 EPERM | 3/3 EPERM |
| control  | `-- /usr/bin/true`                                                                          | 3/3 成功  | 3/3 成功  |

最小候補の各probeは約0.94〜1.16ミリ秒。失敗12回のstderrはすべて次の全文と一致し、signal・実行エラー・ログ省略はない。対照6回のstdout / stderrは空でexit 0だった。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

両jobの最終JSON行は `{"outcome":"minimal-argv-reproduced"}`。公開ログでargv・PID・時刻・終了状態・stderrを直接確認した。以前のrunのコードと分類ログからの推定を、今回の新しい測定で確認できた。

## 実行条件と出典

| architecture | image / kernel                                           | unshare SHA-256                                                    |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------------ |
| x64          | `ubuntu24` / `20261111.127.1` / `7.0.0-1014-aws`         | `a23c8863860669003dc4660039fe642f5795c8c2195898ebc5d01afa1ac3d11c` |
| arm64        | `ubuntu24-arm64` / `20261111.182.1` / `7.0.0-1017-azure` | `e0c145c3d4c06686544b1362ed64da819539166a5e1e6fd96093aea4d2539b6a` |

両構成とも `/usr/bin/unshare`（util-linux 2.39.3）、UID / EUID / primary GID 1001、初期のUID / GID map。caller labelは `unconfined`、AppArmorは有効、user namespaceの制限sysctlは1、作成許可sysctlも1だった。callerの観測であり、失敗時点の子のprofile / capabilityの観測ではない。特権journalは取得していない。

- [observations.json](observations.json): 新しい `[DEBUG-ns-isolate]` JSON行から得たmetadata・全18probe・最終分類。
- [run.json](run.json): `gh run view` で得たrun / job / stepの状態。

データは許可済みのActionsログから取得した。source / workflow / run / attempt、controller hashを照合し、元と最小候補のstderr全文、成功対照、3反復と省略なしを再検証した。artifactの取得・読取は行っておらず、以前拒否されたartifactにもアクセスしていない。

## 判定の範囲

今回の2台では、既存の「CI専用依存と補助groupを準備」step全体がなくても同じ失敗を再現した。この失敗の再現に、その専用準備stepは必須ではなかった。省いたstep内部のNixとgroup準備の個別効果は分離していない。

Bun caller・継承環境・Ubuntu / LSMなどの残る条件の必要性は、まだすべて確認していない。原因仮説の検証、正式44ケース、全子孫5秒保証、macOS 15の方式成立は未認定。[ADR 0003](../../../adr/0003-os-specific-preparation-containment.md)に従い、#33未完了・#82待ちを維持する。
