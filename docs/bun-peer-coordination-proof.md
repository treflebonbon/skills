# peer coordination helper の Bun 移行

[#39](https://github.com/treflebonbon/skills/issues/39) は、Orca の native receipt・worker readiness、両 peer の変更所有範囲、Herdr peer-request の JSON 検査と terminal 応答抽出、Orca 手順内の JSON / ID 処理を Bun へ移す。Herdr child launcher と専用 auto peer の Python は #41 の対象として残す。

## 入口と実行条件

Orca の `scripts/orca-preflight.py` は撤去し、同じ引数を受ける拡張子なしの `scripts/orca-preflight` を直接実行する。両 peer の `scripts/check-owned.sh` と Herdr の `scripts/peer-request.sh` は入口を保つ。Orca の receipt 手順は同梱の `scripts/verify-orca-receipts.ts` を共用 runner から呼ぶ。

これらの helper は Bash、Bun 1.4.4 以上、Git と、各 shell 手順が元から必要とする POSIX command を使う。peer-request の排他は引き続き system Perl の `flock` で行う。Python、Node.js、compiler、native cache、npm install は coordination helper の実行条件に加えない。candidate / evidence helper の native module 準備は [#38 の記録](bun-peer-evidence-proof.md)に従う。

すべての Bun 起動は既存の `lib/bun/run` を通る。payload 外の cwd・HOME の設定、`.env`、preload 環境変数を起動前に遮断し、自動 install と transpiler cache を無効にする。readiness の保存は既存の `open(..., "x")` に対応する `flag: "wx"` で排他的に新規作成する。新しい directory FD 操作・native helper は追加しない。

## 旧 corpus と比較境界

移植前の source `be6a6aaa0c2d5841ea90e594119058832e8f04a6` を保存し、Python 3.14.7 の実行から比較値を採取した。新実装から期待値を生成していない。

| corpus                                                                      | 旧 source の SHA-256                                               | 比較する内容                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [Orca receipt / readiness](../tests/fixtures/peer-coordination-python.json) | `82be9f809a280bf955e19bf97b014fea6e5eff2ed21064b5f40ddaf470bc0ac4` | native receipt 27入力の終了状態・stdout / stderr と readiness の保存 bytes |
| [変更所有範囲](../tests/fixtures/peer-owned-python.json)                    | `7dacfb45b8574afd81b184a22aa680e10f65fc450168cf583a0eb1cee062bba0` | 実 Git 差分14入力の宣言・行範囲・Unicode・出力順序                         |
| [terminal 応答](../tests/fixtures/peer-response-python.json)                | `c87c819874de37bac46e3518ff28a67702f77c828569b6dc6d79154dcefe006b` | 旧 peer-request 内の extractor 15入力と応答 bytes                          |

readiness の元 bytes の SHA-256 は `8984a2f5780ecfc82dd509031906c375a5677008f8630c304a32c5bf6f5ec6ae`。テストでは同じ空 Git commit を再現し、一時 fixture の物理 path だけを対応させる。元 bytes の hash も別に照合し、path を変えた値を旧 hash として扱わない。これは Linux で採取した corpus で、macOS の実採取結果ではない。

native receipt の重複 JSON key は受入条件に合わせて拒否へ強化する。旧 Python が最後の値を採ったケースは corpus の `tightened` で区別する。readiness と手順の JSON 検査も、escape 後に同じになる key と入れ子の key を含めて重複を拒否する。整数トークンの4300桁上限は codec の BigInt 変換より前に検査し、文字列内の数字と float はこの制限に数えない。数値と非有限値の読込みには既存の peer JSON codec を使う。

変更所有範囲の数字は Python の Unicode 16.0.0 の Nd 760文字を固定した [table](../lib/bun/vendor/peer-decimal.json) と [Unicode license](../lib/bun/vendor/peer-decimal.LICENSE) を同梱する。Bun の Unicode 分類が追加で認識する U+11DE0–U+11DE9 は旧版と同じく行番号にしない。整数は BigInt で比較し、旧 Python の4300桁上限も維持する。通常の数字・上限の直前と、不適合の数字・上限超過を対にして検査する。

## 検証する契約

native receipt は期待する Run / handle、Task / Dispatch / assignee と照合する。worker の readiness は worker 自身の観測として保存し、親が割当時に固定した branch / HEAD と、独立して読み取った linked worktree の物理 root / Git dir / common dir と照合する。別 checkout、primary checkout、不正 ID、未知 schema、余分な field、欠落・空・非文字列、重複 key を拒否する。Git 観測は ambient な `GIT_*` を外し、JSON 内の shell 記号を literal な値として扱う。

Orca 手順は bound inbox の Run ID と runtime の handle を独立した期待値として使い、worker-start が object・`ok: true`・`error` が null または未設定であることを検証してから Task / Dispatch / assignee を取り出す。失敗 receipt は worker-show の取得と保存より前に拒否する。worker-show の取得が成功し、preflight を通った `.part` だけを非上書きの link で公開する。未確定の `.part` は保持して停止し、検査済みの最終 receipt は再利用する。保存済みの ID を shell command に展開しない。

peer-request の shell / Perl による lock・signal・待機台帳・nonce・Review Round と再質問の上限を維持する。Bun の子にも lock FD 9 を継承させない。terminal 応答は最初の一致する DONE から最後の一致する END までを取り、旧版と同じ空白集合・字下げ・改行で保存する。quoted marker、旧 nonce、別 ID / SHA、空本文、bare CR を完了の根拠にしない。

[Bun CLI テスト](../tests/bun/peer-coordination.test.ts) は旧 corpus、独立した一時 Git repository、fake native CLI、Python を隠した経路を検査する。read-only payload のテストでは Python・Node.js・compiler を PATH から外し、native cache 不在、設定混入、payload の bytes / mode 不変を確認する。対応する既存 Bats は timeout・signal・並行 helper・孤児 process・待機予算と、文書にある Bash 手順そのものを検査する。移行した専用 Bats の Python fixture は Node.js / Bash に置き換え、共有品質テストと対象外の child launcher fixture は残す。

ローカル検証は Linux x64、Bun 1.4.4。型検査、全体 suite、整形・shell lint・plugin validator、独立した Standards / Spec review の結果は実装の報告に残す。macOS arm64 / Linux arm64 の今回の実行、実 Orca / Herdr peer と実モデルの session、導入済み plugin の受入は未確認で、既存の CI matrix と release 受入で別途確認する。

## repo 外で必要な更新

外部 repo、固定 pin、導入済み cache、runtime 設定は変更していない。今回確認した参照と更新手順は次のとおり。

- `treflebonbon/dotfiles/docs/adr/0075-adopt-peer-refactor-skills.md` の Orca helper の記述を `orca-preflight.py` から `orca-preflight` へ揃える。
- `~/runtime/skill-harness.md` の Orca worktree readiness と監督手順は、`~/runtime/autonomous-peer-contract.md` を介して固定 plugin の `skills/orca-peer-refactor/references/orca.md#worktree-readiness` を参照する。通常の release 受入で新 source を採用し、source / version / hash と同梱 helper を照合する。
- 保存済みの外部 worker brief に `python3 "$SKILL_DIR/scripts/orca-preflight.py" worker-readiness record ...` がある場合は、同じ引数で `"$SKILL_DIR/scripts/orca-preflight" worker-readiness record ...` を直接呼ぶ。親の `verify` と coordinator / worker-show も同じ置換をする。旧 readiness を新しい割当の成功証拠として転用しない。
- 外部に保存した旧 inline Python の receipt 手順は、導入済み source の `verify-orca-receipts.ts` を `lib/bun/run` から呼ぶ新手順に更新する。Bun 不足・helper 読取り不可の場合は実行を保留し、read grant、raw 境界、共有設定を拡張しない。
