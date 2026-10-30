# Browser opening empirical evaluation — 2026-09-16

配備前の `feat/ui-grill-auto-open` で実行。対象 baseline は `023d0e4`。新しい `gpt-5.6-terra / high` executor を各ケースに割り当て、親の会話を渡さず実行した（計7実行）。シナリオと採点項目は実行前に固定し、途中で変更していない。 [固定シナリオ・初期データ](scenarios-browser-open.json) を参照。

## Iteration 0

description は質問シート生成と回答コピー、本文は同じ用途に表示手順を加えている。範囲の矛盾はなく、変更なし。既存 `results-v2.json` の ledger を確認した。今回のサーバー寿命の問題に該当する既存パターンはなかった。

## 採点と計測

○=1、partial=0.5、×=0。Accuracy は固定項目の平均。Success は全 `[critical]` が○の場合のみ○。 `steps` / `duration` は collaboration API が `tool_uses` / `duration_ms` を返さないため未取得。自己申告や時計計測で置き換えていない。Retries は executor 自己申告。

## Iteration 1

Changes: baseline、変更なし。

| Scenario | Success | Accuracy | steps | duration | retries | Weak phase |
| --- | --- | --- | --- | --- | --- | --- |
| A 初回表示 | ○ | 100% | 未取得 | 未取得 | 4 | Execution |
| B 既存タブ更新 | ○ | 91.7% | 未取得 | 未取得 | 0 | Formatting |

### Structured reflection

- A / Execution:
  - Issue: 短命な shell のバックグラウンド起動と nohup 起動でサーバーが終了し、ブラウザが接続拒否になった。
  - Cause: 「プロセスを維持する」は要求していたが、実行環境で維持可能なセッションを指定していなかった。
  - General Fix Rule: 人間の入力待ちに必要な依存プロセスは runtime 管理の長時間実行セッションで保持し、利用前に応答を確認する。
- A: file URL 拒否は既存 HTTP fallback で解決。DOM `eval` へ文ではなく式を渡す必要がある点は操作上のミスであり、対象 skill への追記は行わなかった。
- B / Formatting: 非critical項目5を親判定で partial。HTMLリンクは返したが、応答内の入力→コピー→チャット貼付け案内を欠いた。executor も後から不足を認めた。
  - Issue: 評価依頼の `user-response.md` が「提出済みユーザー回答」と解釈された。
  - Cause: 評価ハーネスが、入力記録と人間への案内文の区別を明記しなかった。
  - General Fix Rule: 評価成果物の送信者と受信者を明記する。

Discretionary fill-ins: A のsessionIdとroundId、未選択の推奨「申請する」「常時表示」。B は既存定義を維持。Critical item drops: なし。

### 次の修正と ledger

A-4「回答できる状態に残す」とA-6「実行結果を正確に報告する」に対応し、サーバーを runtime-managed long-running terminal/session で起動し、handleを保持してHTTP応答を確認する手順へ最小修正した。評価依頼側は `human-facing-message.md` を「人間へ送る案内文」と明記した。これは skill 修正とは分けて扱った。

## Iteration 2

Changes: サーバー寿命・readiness の1テーマのみ。Pattern: Viewing server tied to a short-lived shell。

| Scenario | Success | Accuracy | steps | duration | retries | Weak phase |
| --- | --- | --- | --- | --- | --- | --- |
| A 初回表示 | ○ | 100% | 未取得 | 未取得 | 1 | — |
| B 既存タブ更新 | ○ | 100% | 未取得 | 未取得 | 0 | — |

Structured reflection: 新しい不明点なし。Aはfile URL拒否後にHTTPへ移行し、長時間実行セッションからHTTP 200を確認して表示。サーバー起動のやり直しなし。Bは既存タブ更新を1回で完了。Discretionary fill-ins: A の識別子と未選択の推奨のみ。Bはなし。Ledger: 新規・再発なし。次の修正なし。同じ本文を新しいexecutorで再評価する。Convergence: 定性的clear 1回。定量基準は未判定。

## Iteration 3

Changes: なし。

| Scenario | Success | Accuracy | steps | duration | retries | Weak phase |
| --- | --- | --- | --- | --- | --- | --- |
| A 初回表示 | ○ | 100% | 未取得 | 未取得 | 1 | — |
| B 既存タブ更新 | ○ | 100% | 未取得 | 未取得 | 0 | — |
| Holdout バックグラウンド | ○ | 100% | 未取得 | 未取得 | 1 | — |

Structured reflection: 新しい指示上の不明点なし。AはHTTP fallbackを1回使用、Bは既存タブ更新、holdoutはブラウザとサーバーを起動せず手動リンクと回答手順を返した。Holdoutのretryは静的検査が `input.checked` の処理を初期選択と誤検出したための検査修正であり、skill本文の曖昧さではない。Discretionary fill-ins: Aとholdoutの識別子・推奨のみ。Bはなし。Ledger: 新規・再発なし。次の修正なし。Holdoutの低下は0ポイント。Convergence: 定性的clear 2回。定量基準は未判定。

## 親による独立確認

- 6つの対話シートをブラウザから読み取り、sessionId/roundId、質問数、未選択、自由記述が空欄であることを照合した。
- Bの3成果物すべてで未回答の質問定義が初期データと一致し、別セッションのsentinelファイルが不変だった。
- 7成果物すべての回答処理scriptが配布テンプレートとbyte単位で一致。回答機能の新規改変はない。
- 既存の2つの空タブが保持され、Bの各URLに対応するシートタブは1個ずつだった。
- Holdoutのシートはブラウザに存在せず、案内文も未表示と明記していた。

### 実行環境による限界

Aの各実行時にはHTTP 200と実際の表示を確認した。後続評価を終えた時点では、終了済みexecutor A1/A2のサーバープロセスが消失し、A2 URLへの再接続はtimeoutになった。A3と親の配信は引き続きHTTP 200だった。終了済みagentの実行セッションの回収に伴う可能性があるが、停止原因は未確定。

このため「回答待ちへ移った実行時点で利用可能」と「executor終了・回収後もHTTP配信が存続する」は分ける。後者は保証しない。通常の対話セッションをまたぐ配信寿命も今回の評価では未検証。評価完了後は残った評価用サーバーと専用ブラウザを親が停止し、HTMLは保持する。

## Failure pattern ledger

- **Viewing server tied to a short-lived shell** — iter-1 A。プロセス寿命を保持できる実行セッションに依存を置く。旧文は結果だけを要求していたため防げなかった。iter-2/3で再発なし。
- **Ambiguous evaluation output filename** — iter-1 B、評価ハーネス側。入力記録と人間向け出力を区別する。iter-2/3で再発なし。
- file URL拒否は既存fallbackが機能したため追加の修正対象ではない。DOM検証式とholdoutの静的検査の誤りは実行手法の記録に留める。

## 終了判定

`resource cutoff — qualitative plateau; quantitative convergence unverified`。修正後の2反復でAccuracy 100%、新しい指示上の不明点0、holdoutも100%。ネイティブusageが欠けるため strict convergence とは呼ばない。これ以上の同条件反復では欠けた計測値やagent回収後の寿命を検証できず、今回の変更規模に対する追加評価の費用が釣り合わないため終了。配備は行っていない。

## ローカル証跡

生のHTML・自己報告・ブラウザ状態は `tmp/empirical-ui-open/` に保持（Git対象外）。以下は自己報告のhashであり、内容の正しさを単独で証明するものではない。

| Run | Self-report SHA-256 |
| --- | --- |
| iter-1/a | `d65df9cd4ce291a92bfd9d7a97abaaff6debf9865fcaf4118b221204fb5ac016` |
| iter-1/b | `e9e9030ba697e43726adff8aeab96910e9c6769bd7eb7300f43e828c48db1134` |
| iter-2/a | `3fb47d727917b14a4ff956137dbfb9e9fc64940823a692d4acd6c701b42f338f` |
| iter-2/b | `1b01abb8e27e092f4b45fd02768fb3f935d58dc1aa0abf5a2a8ac5d5ad6fbfcb` |
| iter-3/a | `b4ef837b5e04fa8125b99af2e2d78771db53be5334a2a97513081fc77cad68d1` |
| iter-3/b | `a1da7073990433ef96c225c944b5af66cc29acc2d810387f394b5eb2448cdf51` |
| iter-3/holdout | `2ccaee5ff3acd36a8ce565f447b731a462dfed072eab856a4a91cdf193b19861` |

対象の修正後 SKILL.md SHA-256: `70b5dd4c9e371f864378a371415529a8037d43265cb1efc115a8017ad10403f9`。

## PR #328 review follow-up — 2026-09-16

この節は上記7実行後の指摘対応。過去のスコア・対象hashは変更せず、以下をその後の検証として記録する。empirical loopの再実行ではない。

- 配信先を `mktemp -d` の専用document rootとし、所有シートだけを `index.html` にコピーする。ログは外側へ置き、次ラウンドでコピーを更新する。確認済みの削除範囲に、このコピーと空の専用ディレクトリを含める。
- loopback利用を同一ホストまたは既存localhost転送経路に限定する。別ホストには所有シートだけを扱う既存の許可済み到達可能な配信方法を使い、なければ表示不可としてリンクを案内する。executor側のHTTP応答とブラウザ側の表示確認を区別する。
- 自分で起動したbrowserは所有CLI sessionをcloseし、外部browserへの接続はdetachする。

検証結果:

| 対象 | 操作と結果 |
| --- | --- |
| 配信範囲・更新 | Python標準HTTP serverを専用rootで起動。所有HTMLは200、別セッションのファイル・`../`・URLエンコードした親ディレクトリ参照は404。コピー更新後、同じURLがr2を返す。別ファイルは不変。実行可能なローカルcheckは `tmp/ui-grill-review/check-serving.py` に保持。 |
| browser所有権 | `ui-grill-review-owner open --headed` → `ui-grill-review-attached attach --cdp=...` → `detach` → ownerのDOM読み取り成功 → ownerを`close` → `ui-grill-review-next open --headed`成功。後続sessionもcloseして終了。 |
| 別ホスト分岐 | SKILL本文を確認し、許可済み配信経路なしの場合の表示不可・ファイルリンク案内、bind拡張とpublic tunnelを行わないことを明記。別ホストの実機は使用していない。 |
| 既存契約 | `bats tests/workflow-contract.bats` 14件、`bats tests/nix-devshell.bats --filter 'ui grill skill'` 1件が通過。 |

通常の対話をまたぐHTTP配信寿命とネイティブusage不足は、上記評価の未確認事項として引き続き残る。
