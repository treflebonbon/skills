# Linux 追加実証: run 44049468642 / attempt 1

2026-11-17 に承認された範囲で1回実行し、別途承認された artifact 取得を行った。結果は**成功条件未達・前提検査で停止・未実証**。両 architecture とも試験本体は0件で、候補の互換性や全子孫5秒保証の合否は判定できない。[前回の失敗記録](../43869813149-1/README.md)も保持する。

| 項目                  | 記録                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| workflow / ref        | `linux-process-proof.yml` / `integration/python-to-bun`                            |
| source / workflow SHA | `d7087d4b5eebebc3157791b09ca1395e76c0a7f7`                                         |
| run / attempt         | [44049468642 / 1](https://github.com/treflebonbon/skills/actions/runs/44049468642) |
| 開始                  | `2026-11-17T08:45:32Z`（UTC）                                                      |
| 対象                  | Ubuntu 24.04 native x64 / arm64、同じ run / attempt                                |
| 計画 / 実績           | 各44件×3反復 / 両構成とも0反復、試験本体0件                                        |
| Actions の結論        | 両 architecture の job と集約 job が `failure`                                     |
| 収集                  | raw artifact 2件と判定 artifact 1件を取得済み                                      |

## 確認した停止理由

両構成とも非root caller の UID / EUID / primary GID は `1001`、Bun は `1.4.4`、選択実体は `/usr/bin/unshare`（util-linux `2.39.3`）。既存の argv、継承環境、非root条件のまま probe が exit 1 となった。今回の前提検査エラーは namespace probe 拒否だけで、arm64 の image 不一致エラーはない。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

| architecture | ImageOS / ImageVersion              | kernel             | probe PID | probe 開始〜終了（UTC）        |
| ------------ | ----------------------------------- | ------------------ | --------- | ------------------------------ |
| x64          | `ubuntu24` / `20261111.127.1`       | `7.0.0-1014-aws`   | `4183`    | `08:46:09.407`〜`08:46:09.412` |
| arm64        | `ubuntu24-arm64` / `20261111.182.1` | `7.0.0-1017-azure` | `4712`    | `08:46:16.278`〜`08:46:16.283` |

## 追加診断で分かったこと

両 probe は約5ミリ秒で終了した。`processObservation` は `process-exited-before-sample` で、開始時刻の識別値は残ったが、実行体・profile・capabilityを揃えた直接観測は得られなかった。caller の状態で代用しない。

固定実体の `journalctl`（systemd `255.4-1ubuntu8.18`）の読取りは両構成とも成功した。probe PID と開始／終了時刻の各1秒前後に限定した検索で、それぞれ1件の一致があり、切詰めはなかった。event の時刻は probe の実際の開始〜終了の範囲内にある。

| architecture | audit 時刻（UTC） | message PID | apparmor / operation      | profile → target                     |
| ------------ | ----------------- | ----------- | ------------------------- | ------------------------------------ |
| x64          | `08:46:09.411`    | `4183`      | `AUDIT` / `userns_create` | `unconfined` → `unprivileged_userns` |
| arm64        | `08:46:16.280`    | `4712`      | `AUDIT` / `userns_create` | `unconfined` → `unprivileged_userns` |

両 event の `comm` は `unshare`、`execpath` は `/usr/bin/unshare`。これは profile 遷移の実測であり、`DENIED` event ではない。収集範囲には `uid_map` 書込みを直接拒否した event がなく、今回の EPERM の拒否元・capability を一意に確定しない。

[Ubuntu Security Team の説明](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007)では、AppArmor が user namespace と内部の capability を選択的に制限する。この説明は今回の遷移と整合するが、一般仕様を今回の拒否原因の確定に置き換えない。実 VM の `unprivileged_userns` policy 本文・版は今回収集していない。

## PID 対応付けの限界

実測した版と同じ [上流 util-linux v2.39.3 の `unshare.c`](https://raw.githubusercontent.com/util-linux/util-linux/v2.39.3/sys-utils/unshare.c)では、`unshare()` の後に `--fork` の子を作り、親は `waitpid()` で終了を待つ。`--map-current-user` の `map_id()` は子側の経路にある。

今回の検索対象は Bun が起動した親の probe PID だけで、fork 後の子 PID とその開始時刻・親子関係を取得していない。このため子側の拒否 event は取りこぼす可能性があり、`DENIED` が取得できなかったことを「拒否 event が発生しなかった」と解釈しない。上流実装の読取りだけで、今回の VM で子の拒否 event が実際に発生したとも断定しない。

次の調査には、同じ argv・非root条件のまま、fork 後の子を親 probe に対応付ける方法と、その範囲に限定した拒否証跡の取得設計が必要になる。今回の記録から AppArmor の無効化や profile 変更、root での probe 実行へ進まない。

## 保存した証跡

- [run.json](run.json): `gh run view` で確認した run、job、step の終了状態。
- [preflight.json](preflight.json): 各 raw `job.json` から source / workflow / run / attempt、controller hash、空の `trials`、前提検査、エラーを抽出。固定 Nix store path のハッシュを含む接頭部は architecture ごとのプレースホルダーで表す。元ファイルの artifact 名、サイズ、SHA-256を併記した。元のパスと完全な source hash 一覧は raw artifact に残る。
- [cohort.json](cohort.json)、[verdict.json](verdict.json)、[workflow-summary.md](workflow-summary.md): 集約 artifact の内容を保存した。

`preflight.verified: false` のため集約は試験 job として受理せず、`cohort.jobs` は空になった。job 不足・反復不足や包括的な証跡エラーを、artifact 消失や source 不一致の証拠とは扱わない。

| raw artifact                                                                                   | artifact ID   | GitHub が記録した bundle digest（SHA-256）                         | 実際の expiresAt（UTC） |
| ---------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------ | ----------------------- |
| [x64](https://github.com/treflebonbon/skills/actions/runs/44049468642/artifacts/14312454152)   | `14312454152` | `d3906b94b94cbb070a13fc465579017214779474afe7cff8e9e905168f22c4a2` | `2027-02-15T08:45:33Z`  |
| [arm64](https://github.com/treflebonbon/skills/actions/runs/44049468642/artifacts/14313550278) | `14313550278` | `d622ee3e72fae531e70867e26c5f23afda7f2e5fa44052432203d4e73b32c7c2` | `2027-02-15T08:45:33Z`  |

ID / digest / 保存期限は `cohort.json` の取得済み metadata による。展開した元 `job.json` の SHA-256 と bundle digest は別物で、ZIP の byte 列を再計算したとは扱わない。判定 artifact の実保存期限はこの metadata に含まれず、ここでは断定しない。

## 維持する判定

追加実証の成功、環境起因の確定、履歴解決記録の追加は行わない。自動再試行や kernel / sysctl / LSM の制限緩和も行っていない。#33 は未完了、#82 は #33 待ち、macOS 15 の封じ込め方式は保留のまま。[承認済み計画](../../../bun-process-linux-proof-plan.md)と ADR 0003 の条件を維持する。
