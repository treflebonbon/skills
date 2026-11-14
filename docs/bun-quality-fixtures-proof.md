# 品質検査と browser fixture の Bun 移行

[#50](https://github.com/treflebonbon/skills/issues/50) は plugin／一般 skill の静的契約、TypeScript evidence の検査、dogfood／WSL2 browser の Python 補助を Bun に移す。既存 Node・Bats・npm を維持し、peer・auto・raw 専用の fixture は各機能 ticket に残す。docstring 診断と最後の Python 品質配線の撤去は #51 が扱う。

## 旧実装の固定と比較

比較元は `d784ab17661bc84f8972ee0f4f3f5bd694be9183`。移植前の checkout から全403 tracked file の bytes／mode を固定し、[`quality-python.json`](../tests/fixtures/quality-python.json) に対象 source の SHA-256 と観測を保存した。ローカルは WSL2／Linux x64、Python 3.14.7、Bun 1.4.4、ast-grep 0.42.1。

- 旧 package／一般 skill テスト33件と、manifest・policy・release・JSON path・lock・registry・integrity・license・資源リンクなどを改変した12件の拒否を採取した。新しい package 検査は正常な配布物と同じ12入力の拒否理由を対照し、Python 起動を trap している。
- 旧 evidence ドライバー14件を実行し、33回の CLI の入力 bytes／mode、argv／cwd、stdout／stderr、終了状態と JSON bytes を採取した。新ドライバーは同じケースを実行し、一時 case root と旧 Bun の版表示だけを正規化して比較する。
- 移植前に旧 payload snapshot の8ケースを採取した。空 directory、権限、除外名、symlink／壊れたリンク／外部 directory へのリンク、FIFO、Unicode、複数 block のファイル、root alias を含む。移植中に同じ固定 source から DEL、不正 UTF-8 の名前と link target、読めない directory を追加測定し、最終 corpus は共通10ケースと Linux 用1ケースになった。旧 stdout bytes と hash を保持し、サイズの大きい入力だけ既知の10 bytesを反復する recipe で表す。
- 移植前の対象 Bats 126件が成功した。これは fake CLI と fixture の結果で、実 browser の受入ではない。

package 契約18件のうち1件は、#49 で消費者を失った Python snapshot 関数自身のテストだった。この関数と専用テストは撤去し、残り17件と一般 skill 15件を Bun へ移した。配布物の観測は、実際に使う snapshot CLI の旧11ケースと既存の導入 smoke／payload 不変性の検査で確認する。新実装から旧 corpus の期待値を生成していない。

## 入口と維持する契約

`npm run test:bun` が `tests/bun/package-contract.test.ts`、`public-skills.test.ts` と旧 corpus の対照を実行する。公開 skill の exact set、frontmatter、明示起動条件、manifest／release version、資源リンク、依存説明、license／notice と npm lock の registry／integrity を維持する。

TypeScript evidence の Bats と CI は `tests/helpers/rop-typescript-evidence.test.ts` を使う。抽出本体の公開引数・保存形式は変えない。対応 Bun と実 ast-grep の抽出、未対応 Bun の明示的拒否、失敗時の batch 破棄、source containment、Unicode range、30秒 deadline、対象 cwd の preload 拒否を保つ。fake ast-grep は argv を照合し、正常な空応答も通る。CI の旧版 job は Bun 1.2.14 でドライバーを直接起動し、共用 runner 自身の旧版拒否も別 step で検査する。ローカルの旧版確認には実在の Bun 1.3.13 を使った。

dogfood の実 browser suite が呼ぶ snapshot は `skills/dogfood/tests/helpers/payload-snapshot.ts` を共用 runner から実行する。通常ファイルの hash、directory／symlink／その他の種別と mode、link target、Unicode の順序、ASCII escape と JSON separator を旧 bytes に合わせる。`.git` と local environment 名を除き、`node_modules` などの生成物は観測に含める。link の先は辿らない。

不正 UTF-8 のファイル名は元の bytes で読み、旧 Python の surrogateescape と同じ JSON を出す。この入力は [APFS の作成条件](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html)では扱えないため、Linux 用の1検査として分けた。共通10ケースは各 OS の対象に残す。旧 os.walk の既定動作を保ち、走査できない directory は自身の mode を記録して内容を省略する。その中の bytes の不変性はこの snapshot では証明しない。

Bats 内の文書 block 抽出、report の証跡リンク確認、JSON fixture の改変と signal 検査も共用 runner から実行する。annotation の開始待ちと終了待ちの15秒上限、SIGINT／SIGTERM の process group 送信、異常時の所有 group の回収、既存 Dashboard の保持を維持する。fixture の共有基底は実行ユーザー所有の通常 directory `/tmp/codex`。payload や通常 HOME に cache を生成する前提にはしない。

旧 `tests/test_plugin.py`、`test_issue_530_skills.py`、`test_issue_531_skills.py`、`test_issue_539_pr_screenshots.py`、旧 evidence driver と snapshot helper は同じ変更で撤去した。旧 path の shim、新しい native helper／FFI、依存 package は追加していない。

## 外部の呼出し元と切替

調査した dotfiles の `docs/`・`scripts/`・`tests/` と `~/runtime/` では、対象旧 helper／test path の直接 caller は見つからなかった。調査外の caller は未確認。

通常の npm 品質入口は維持する。旧 unittest の直接 caller は `lib/bun/run test tests/bun/package-contract.test.ts tests/bun/public-skills.test.ts` へ切り替える。旧 evidence driver の直接 caller は `lib/bun/run test tests/helpers/rop-typescript-evidence.test.ts` へ、snapshot は同じ引数で `lib/bun/run run skills/dogfood/tests/helpers/payload-snapshot.ts ROOT` へ切り替える。旧 Python path と unittest の選択形式は残さない。テストを名前で選ぶ場合は Bun の `--test-name-pattern` を使う。Bun 1.4.4+ と既存の Node／Bash／Bats／Git／OS ツールを用意する。repo 外の caller・pin・共有設定は更新していない。

## 未確認の範囲

公式 CLI の実導入、実モデル／通常認証、実 browser、App／IDE、Nix／raw isolation の受入は実行していない。macOS arm64／Linux arm64 と CI の Bun 1.2.14 は当該 checkout の CI で別に確認する。skip、runner の定義、過去の版での成功を今回の受入の証拠に数えない。
