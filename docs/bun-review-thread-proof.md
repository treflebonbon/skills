# gh-review-thread の Bun 移行

[#42](https://github.com/treflebonbon/skills/issues/42) は、公開入口 `bin/gh-review-thread` の `inspect` / `reply-resolve` を Bun へ移す。コマンド名と引数を保ち、同じ入口から `lib/bun/run` 経由で `lib/bun/gh-review-thread.ts` を実行する。

## 依存と実行条件

通常利用には Bash、Bun 1.4.4 以上、GitHub CLI `gh` と既存の認証設定が必要。Python、Node.js、compiler、native module の準備はこの CLI の実行条件に含めない。本文は引き続き UTF-8 ファイルで渡す。CLI から npm install や payload 内の cache 生成は行わない。

入口は Bash の privileged mode から実体の package root を解決する。[共用 runner の起動契約](bun-startup-proof.md)で、ambient bunfig・dotenv・preload と環境変数からの起動設定の混入を防ぐ。cwd と `gh` の通常の認証環境は保つ。

## 固定した旧出力

旧実装は `bff3d67a9a0e56f450cf55a9459edea840b49279:bin/gh-review-thread`。ファイルの SHA-256 は `133db1bad6c2a5a92c49ee4184c269cbf37b31845f7e7d0b492ce04f0b50fc46`。Linux x86_64 / Python 3.14.7 で、移行前に元の Bats 43 テストを fake `gh` と実行し、46 回の CLI 呼出しを採取した。旧 source を退避した後、同じ不変の旧実装で境界値と追加の部分失敗を31回採取した。追加分も新実装の出力からは作っていない。

[`tests/fixtures/gh-review-thread-python.json`](../tests/fixtures/gh-review-thread-python.json) に77ケースの argv、本文のバイト列と mode、終了コード、stdout / stderr、stdout の SHA-256、全 fake `gh` 呼出しの argv と応答・終了コードを保存した。合成 PR・本文のみで、実ユーザー内容や資格情報を含まない。

比較時は `--body-file` の一時パスを `@BODY@` へ置換する。`inspect --checks` の `observed_at` だけは、実行前後の UTC 時刻であることを別に検査し、旧値に正規化して出力の全バイトを比較する。旧出力の原本と hash は変更しない。

不正な comment / author 型の2ケースは旧 Python が traceback で停止した。言語・source path 固有の traceback は一致対象から外し、新 CLI の具体的な不正型診断、同じ終了コード1、同じ呼出し位置での停止と mutation 未実行を検査する。その他のケースは stderr も全バイトで比較する。

## 比較する境界

- `inspect` の diff 有無、thread / comment / check / CodeRabbit comment の全ページ、`--plain` の既知 markup 除去とコード保持、JSON のキー順・空白・Unicode。
- GitHub と CodeRabbit の状態集約、欠落・未知状態・不完全な表・件数不一致・古い HEAD・取得中の HEAD 変更。未知状態を成功へ変換しない。
- repo / PR / thread の所属、完全 SHA と PR の全 commit ページ、未公開 commit、日本語本文の prefix・要約・検証結果、説明専用の回答と根拠。
- 自分の同一返信だけを再送対象から外し、後続の他者 feedback がある場合は再送する。削除済み author と resolve 済み thread も旧契約どおり扱う。
- 認証失敗、返信失敗と resolve 失敗、配列・object の GraphQL errors。返信が失敗したら resolve せず、resolve だけが失敗した場合は再試行時の重複回避を保つ。
- CLI help、PR の Unicode decimal・underscore・負数・桁数制限、末尾改行を含む repo / commit の拒否。
- Unicode の単語境界・大文字小文字と CR / Unicode 改行を含む本文。HEAD 根拠の行頭は LF だけで認識し、別の区切り文字で不明な根拠を成功扱いしない。

`tests/bun/gh-review-thread.test.ts` は Python 起動を拒否する fake と、argv ごとの応答を再生する fake `gh` を使う。未登録の呼出しと順序違反は失敗する。読み取り専用 payload の検査では、Python / Node.js / compiler を PATH へ入れず、`inspect --checks`、`inspect --plain`、commit 付き返信の成功ケースを symlink の公開入口から実行する。ambient 設定を注入し、payload の mode / hash / directory 構成、本文と native cache の未変更を確認する。

既存の `tests/cli/gh-review-thread.bats` 43テストも公開入口で続ける。commit ページ生成と時刻検証の埋込み Python を Node.js に移した。旧 Python 本体は同じ変更で置き換え、比較用 Python 実装や旧パス用 shim を配布しない。既存の共通 JSON codec・Unicode 表だけを再利用し、新規 native helper は追加しない。

## repo 外の呼出し元と更新手順

この環境では dotfiles の `private_dot_local/bin/executable_gh-review-thread.tmpl` と、その生成先 `~/.local/bin/gh-review-thread` が `sync-skills-plugin --run-cli gh-review-thread` に委譲する。公開名と引数は同じなので launcher の呼出し形式は維持できる。

配布側では、この変更を含む固定 plugin source / version / hash を通常の受入・リリース手順で更新し、Bun 1.4.4 以上を用意する。`gh-review-thread` は実行可能入口を直接呼び、`python3 <payload>/bin/gh-review-thread` のような明示的な Python 起動が別環境にあれば直接実行へ切り替える。この変更では外部 template・導入済み payload・pin・共有設定は更新しない。

## 確認範囲

ローカルの比較は Linux x86_64 / Bun 1.4.4 で行う。fake `gh` の副作用記録であり、実 GitHub の返信・resolve、認証、モデル session、公式 CLI 導入、Nix / raw isolation の受入を示さない。macOS aarch64 / Linux aarch64 は既存 CI matrix の当該 checkout の結果を別に確認する。定義済みの job を実測の成功として数えない。
