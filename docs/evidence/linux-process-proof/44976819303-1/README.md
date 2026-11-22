# Linux 正式実証（cgroup 経路）: run 44976819303 / attempt 1

2026-11-22 に承認された範囲で1回実行し、別途承認を得て判定 artifact だけを取得した（#121）。結果は**成功条件未達**。両 architecture の試験本体は3回とも全件成功したが、集約 job が公開 metadata API から HTTP 403 を受け、artifact と同じ SHA の履歴を照合できなかった。証跡不足による未達であり、この run を成功には数えない。

| 項目                  | 記録                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------ |
| workflow / ref        | `linux-process-proof.yml` / `feat/121-host-adaptive-proof`                                 |
| workflow SHA          | `f28d4a6d3d880d2e239d72884aa425e0c5e07b2a`                                                 |
| source SHA            | `c6947cda6fc5dada4e021cfc87034133393da8cb`（[WSL2 の実証](../../wsl2-host-adaptive/2026-11-21-c6947cd/README.md)と同じ） |
| run / attempt         | [44976819303 / 1](https://github.com/treflebonbon/skills/actions/runs/44976819303)         |
| 対象                  | Ubuntu 24.04 x64（image `20261116.133.1`）／ arm64（image `20261116.188.1`）、同じ run / attempt |
| 選ばれた方式          | 両 architecture とも `cgroup`                                                              |
| 計画 / 実績           | 各45件×3反復 / 両構成とも 45 pass・0 fail・0 skip・exit 0 を3回                            |
| Actions の結論        | 実証 job は両 architecture とも `success`、集約 job が `failure`                           |
| 収集                  | 判定 artifact 1件を取得。raw artifact 2件は取得していない                                  |

## 未達の理由

[verdict.json](verdict.json) の理由は次の4件で、いずれも集約 job の metadata 取得に由来する。試験本体・ケース・方式に関する理由は無い。

```text
x64: artifact の同一性・保存期間を確認できません
arm64: artifact の同一性・保存期間を確認できません
同じ SHA の失敗履歴を確認できません
metadata: Error: public metadata API: HTTP 403
```

集約の照合 step は約 0.1 秒で終了した。controller は HTTP の状態コードだけを記録し、応答本文と rate limit の header は残していない。そのため 403 の原因（認証なし API の rate limit など）は確定していない。

## 確認したこと

[cohort.json](cohort.json) の各 job と反復から、次を確認した。

- 両 architecture とも前提検査で `cgroup` が選ばれた。namespace probe は `unshare: write failed /proc/self/uid_map: Operation not permitted` で失敗し、`systemd-run` の委譲 scope が使えた。user manager は `active`、linger は `yes`、user bus は存在した。
- 3回とも、実行したケースの集合が manifest v2 の「共通30件＋cgroup 専用14件＋観測1件」と一致し、全件が `pass` だった。試験が使った方式も3回とも `cgroup` だった。
- 拒否のケース（user bus の場所を渡さない）では、launcher が終了コード 69 で拒否し、準備を始めなかった。環境を戻した同じ実行体は終了コード 37 で target を実行した。
- 補助 group の2件と、実 Nix・shellHook の caller のケースも3回とも成功した。

## 抜け出しの観測（合否に数えない）

準備の子孫が自分で `systemd-run --user --scope` を実行すると、両 architecture・3回とも、準備用 scope とは別の scope へ移った（`leftScope: true`）。launcher を SIGKILL した 5.1 秒後には、その子孫は生き残っていなかった（`survivedLauncherKill: false`）。

この子孫は準備の process group に残ったまま cgroup だけを移ったため、準備 group の監視役による group kill で終了したと推測する（未確認）。cgroup の移動と process group の離脱を組み合わせた場合の生存は測っていない。cgroup の移動による抜け出しは、ADR 0005 の追記どおり保証の外に置く。

## 記録の範囲

- `cohort.json` は、判定 artifact の cohort から、各試験の観測 JSON の `records` を実 caller・拒否・抜け出しの観測だけに絞ったものである。省いた件数は `trials[].observation.recordsOmitted` にある。ケースの結果・集計・終了状態・前提検査は省いていない。
- `run.json` は公開 run metadata、`workflow-summary.md` は集約 job の要約である。

## 示さないこと

- この run は成功ではない。同じ SHA の認定には、この失敗の解決記録（Q10）と、新しい run での一組が要る。
- raw artifact の内容（試行ログ・build した実行体）は取得していない。
- macOS。[#33](https://github.com/treflebonbon/skills/issues/33) は未完了のままで、[#82](https://github.com/treflebonbon/skills/issues/82) は依存待ちのままである。
