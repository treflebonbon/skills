# Linux 追加実証: run 43869813149 / attempt 1

2026-11-16 に承認された範囲で1回実行した。結果は**成功条件未達・前提検査で停止・未実証**。両 architecture とも試験本体へ進んでおらず、候補の互換性や全子孫5秒保証について今回の結果から合否を判定できない。

| 項目                  | 記録                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| workflow              | `linux-process-proof.yml`（ID `420112417`）、`main` で手動起動                     |
| source / workflow SHA | `752923f9e9992739bfd0195ec1f4a992686b8c1f`                                         |
| run / attempt         | [43869813149 / 1](https://github.com/treflebonbon/skills/actions/runs/43869813149) |
| 開始                  | `2026-11-16T12:47:50Z`（UTC）                                                      |
| 対象                  | Ubuntu 24.04 native x64 / arm64、同じ run / attempt                                |
| 計画 / 実績           | 各44件×3反復 / 両構成とも0反復、試験本体0件                                        |
| Actions の結論        | 両 architecture の job と集約 job が `failure`                                     |
| 収集                  | raw artifact 2件と判定 artifact 1件を取得済み                                      |

## 確認した停止理由

| architecture | ImageOS / ImageVersion              | 前提検査の結果                                       |
| ------------ | ----------------------------------- | ---------------------------------------------------- |
| x64          | `ubuntu24` / `20261111.370.1`       | namespace probe が exit 1                            |
| arm64        | `ubuntu24-arm64` / `20261111.182.1` | namespace probe が exit 1、Ubuntu image 判定も不一致 |

両構成で kernel は `7.0.0-1017-azure`、caller の UID / EUID / primary GID は `1001`、Bun は `1.4.4`。固定版 Nix `2.34.6` の導入と architecture 別 Bash / stdenv closure の準備後に停止した。Nix daemon の接続検査は exit 0、実効 `sandbox` は `true`、`build-users-group` は `nixbld`。この準備成功は実 Nix caller の試験成功を意味しない。

共通の probe は、選択した `unshare` に `--user --map-current-user --pid --fork --kill-child=SIGKILL --mount-proc -- /usr/bin/true` を渡したもの。両構成とも stderr は次のとおりだった。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

namespace 権限の前提が成立しなかったことは確認できるが、拒否の根本原因は未確定。両構成で AppArmor は有効、`apparmor_restrict_unprivileged_userns = 1`、`unprivileged_userns_clone = 1`、caller の `/proc/self/attr/current` は `unconfined` だった。これらの値と EPERM だけでは、AppArmor など特定の原因へ断定しない。audit log による拒否原因の裏付けは今回の証跡にない。

arm64 の追加エラーについては、収集側の `preflight` と集約側の `readProofJob` がともに `ImageOS === "ubuntu24"` のみを受理することを[対象版のコード](https://github.com/treflebonbon/skills/blob/752923f9e9992739bfd0195ec1f4a992686b8c1f/development/run-linux-process-proof.ts)で確認した。実際の `ubuntu24-arm64` を拒否する harness の問題がある。ただし、この判定だけを修正しても、今回の共通の namespace probe 拒否は解消したことにならない。

## 証跡と判定の読み方

- [run.json](run.json): `gh run view` で取得した run、各 job、step の終了状態。
- [preflight.json](preflight.json): 各 raw `job.json` から source / workflow / run / attempt、controller hash、空の `trials`、前提検査、エラーを抽出。元の `job.json` の artifact 名、サイズ、SHA-256 も併記した。元ファイルの完全な source hash 一覧は raw artifact に残る。
- [cohort.json](cohort.json)、[verdict.json](verdict.json)、[workflow-summary.md](workflow-summary.md): 集約 artifact のファイルを内容を変えず保存した。

両 raw artifact に `job.json` は存在する。集約では `preflight.verified: false` の記録を有効な試験 job として受理しないため、`cohort.jobs` は空になり、「job が1件必要」「反復1・2・3が必要」と報告された。「source・前提検査・controller の証跡が不正」という包括的なエラーだけをもって、source の不一致や artifact の消失が起きたとは解釈しない。

| raw artifact                                                                                   | artifact ID   | GitHub が記録した bundle digest（SHA-256）                         | 実際の expiresAt（UTC） |
| ---------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------ | ----------------------- |
| [x64](https://github.com/treflebonbon/skills/actions/runs/43869813149/artifacts/14227460882)   | `14227460882` | `9e163f1c38d2a09fce06d422e604f4921f52da9200cabc48908727dde6c150d4` | `2027-02-14T12:47:51Z`  |
| [arm64](https://github.com/treflebonbon/skills/actions/runs/43869813149/artifacts/14226588953) | `14226588953` | `5f8cc88aafe7ea91abf320fa988c2979a1535795aa15226d51f90b3823f3ba69` | `2027-02-14T12:47:51Z`  |

これらの ID / digest / 保存期限は集約時に取得した metadata による。展開済みファイルのハッシュと bundle digest は別物であり、ZIP の byte 列をローカルで再計算したとは扱わない。判定 artifact は `linux-proof-verdict-43869813149-1` として取得済みだが、その metadata は `cohort.json` に含まれないため、ここでは実保存期限を断定しない。

## 次の判断へ引き継ぐこと

今回の失敗履歴は残す。namespace probe 拒否の原因調査と arm64 の image 検査修正が必要であり、修正後の実証には新しい対象 SHA と両構成の新しい一組を使う。環境原因が解決済みであると認定する履歴解決記録は追加していない。

自動再試行、kernel / sysctl / LSM の制限緩和、比較条件の変更は行っていない。#33 は OPEN、#82 は #33 待ち、macOS の Bun 移行は保留を維持する。[承認済み実行計画](../../../bun-process-linux-proof-plan.md)と ADR 0003 の条件は変更しない。
