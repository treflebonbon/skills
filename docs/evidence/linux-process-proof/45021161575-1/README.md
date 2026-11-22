# Linux 正式実証（cgroup 経路）: run 45021161575 / attempt 1

2026-11-22 に承認された範囲で1回実行し、別途承認を得て判定 artifact だけを取得した（#121）。結果は**成功条件未達**。両 architecture の試験本体は3回とも全件成功した。job token による metadata の取得と、同じ SHA の履歴の照合（過去2件の環境起因の解決記録を含む）も通った。未達の理由は、集約側の検証ロジックの欠陥だけだった。

| 項目           | 記録                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| workflow / ref | `linux-process-proof.yml` / `feat/121-host-adaptive-proof`                                 |
| workflow SHA   | `aa756d7fd76949b715d279057e9fd08f47933105`（集約 job に `actions: read` の job token を追加） |
| source SHA     | `c6947cda6fc5dada4e021cfc87034133393da8cb`                                                 |
| run / attempt  | [45021161575 / 1](https://github.com/treflebonbon/skills/actions/runs/45021161575)         |
| 対象           | Ubuntu 24.04 x64（image `20261116.133.1`）／ arm64（image `20261116.188.1`）、同じ run / attempt |
| 選ばれた方式   | 両 architecture とも `cgroup`                                                              |
| 計画 / 実績    | 各45件×3反復 / 両構成とも 45 pass・0 fail・0 skip・exit 0 を3回                            |
| Actions の結論 | 実証 job は両 architecture とも `success`、集約 job が `failure`                           |
| 収集           | 判定 artifact 1件を取得。raw artifact 2件は取得していない                                  |

## 未達の理由

[verdict.json](verdict.json) の理由は、`x64` と `arm64` の「artifact の同一性・保存期間を確認できません」の2件だけである。

集約は保存期間を「artifact の作成時刻から保存期限まで」が90日（許容60秒）以上かで検査していた。GitHub は保存期限を run の開始時刻から数える。この run は `2026-11-22T12:13:25Z` に始まり、試験の後の `12:15:19Z` に artifact が作られ、保存期限は `2027-02-20T12:13:27Z`（開始から90日と2秒）だった。作成時刻からは 89.9987 日で、許容を 52 秒超えて不足した。それまでの run は前提検査ですぐに止まり、artifact の作成が開始から60秒以内だったので、この欠陥は表に出なかった。

保存期間は run の開始時刻（metadata の `run_started_at`）から数えるよう、検証ロジックを修正した。この失敗は環境起因ではないため解決記録を付けない。Q10 に従い、修正後の新しい source SHA で両構成を再測定する。

## 確認したこと

[cohort.json](cohort.json) から次を確認した。

- 両 architecture とも前提検査で `cgroup` が選ばれ、3回とも実行したケースの集合が「共通30件＋cgroup 専用14件＋観測1件」と一致し、全件が `pass` だった。試験が使った方式も `cgroup` だった。
- 拒否のケースは終了コード 69 で準備を始めず、環境を戻した対照は 37 だった。
- 抜け出しの観測は `leftScope: true`・`survivedLauncherKill: false` で、過去2回の run と同じだった（合否には数えない）。
- `historyComplete` は `true` で、同じ SHA の過去の失敗2件（44976819303/1、45012162020/1）には、どちらも環境起因の解決記録が結び付いていた。

## 記録の範囲

`cohort.json` は判定 artifact の cohort から、観測 JSON の `records` を実 caller・拒否・抜け出しの観測に絞ったものである。省いた件数は `trials[].observation.recordsOmitted` にある。

## 示さないこと

- この run は成功ではない。
- macOS。[#33](https://github.com/treflebonbon/skills/issues/33) は未完了のままである。
