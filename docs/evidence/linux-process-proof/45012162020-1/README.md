# Linux 正式実証（cgroup 経路）: run 45012162020 / attempt 1

2026-11-22 に承認された範囲で1回実行し、別途承認を得て判定 artifact だけを取得した（#121）。結果は**成功条件未達**。[run 44976819303](../44976819303-1/README.md) と同じく、両 architecture の試験本体は3回とも全件成功した。集約 job は、公開 metadata API の認証なし rate limit に当たり、artifact と同じ SHA の履歴を照合できなかった。証跡不足による未達であり、この run を成功には数えない。

| 項目           | 記録                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| workflow / ref | `linux-process-proof.yml` / `feat/121-host-adaptive-proof`                                 |
| workflow SHA   | `86b52f3b755771d190728f5e38659c2f022bf0b7`（run 44976819303 の解決記録と、API 失敗時の詳細記録を追加） |
| source SHA     | `c6947cda6fc5dada4e021cfc87034133393da8cb`                                                 |
| run / attempt  | [45012162020 / 1](https://github.com/treflebonbon/skills/actions/runs/45012162020)         |
| 対象           | Ubuntu 24.04 x64（image `20261116.376.1`）／ arm64（image `20261116.188.1`）、同じ run / attempt |
| 選ばれた方式   | 両 architecture とも `cgroup`                                                              |
| 計画 / 実績    | 各45件×3反復 / 両構成とも 45 pass・0 fail・0 skip・exit 0 を3回                            |
| Actions の結論 | 実証 job は両 architecture とも `success`、集約 job が `failure`                           |
| 収集           | 判定 artifact 1件を取得。raw artifact 2件は取得していない                                  |

## 未達の理由

[verdict.json](verdict.json) の理由は4件で、すべて metadata 取得の失敗に由来する。今回は controller が応答の header と本文を記録したため、原因を確定できた。

```text
public metadata API: HTTP 403 /actions/runs/45012162020 x-ratelimit-limit=60 x-ratelimit-remaining=0
{"message":"API rate limit exceeded for 3.42.157.50. (But here's the good news: Authenticated requests get a higher rate limit. ...)"}
```

集約 job の最初の API 呼出しの時点で、runner の IP に割り当てられた認証なしの上限（1時間60回）が残り0だった。この IP は GitHub-hosted runner で共有されるため、上限の消費はこの workflow だけに由来しない。run 44976819303 の 403 も同じ原因だった可能性が高いが、その run では header を記録していないので確定しない。

## 確認したこと

[cohort.json](cohort.json) から、run 44976819303 と同じ内容を確認した。

- 両 architecture とも前提検査で `cgroup` が選ばれた。
- 3回とも、実行したケースの集合が「共通30件＋cgroup 専用14件＋観測1件」と一致し、全件が `pass` だった。試験が使った方式も3回とも `cgroup` だった。
- 拒否のケースは終了コード 69 で準備を始めず、環境を戻した対照は 37 だった。
- 抜け出しの観測は `leftScope: true`・`survivedLauncherKill: false` で、run 44976819303 と同じだった（合否には数えない）。

## 記録の範囲

`cohort.json` では固定 Nix store path のハッシュを含む接頭部を architecture ごとのプレースホルダーで表す。

`cohort.json` は判定 artifact の cohort から、観測 JSON の `records` を実 caller・拒否・抜け出しの観測に絞ったものである。省いた件数は `trials[].observation.recordsOmitted` にある。

## 示さないこと

- この run は成功ではない。
- 対策として、集約 job だけに `actions: read` の job token を与え、同じ read API を認証付きで読むよう変更する。その変更後の run は別に記録する。
- macOS。[#33](https://github.com/treflebonbon/skills/issues/33) は未完了のままである。
