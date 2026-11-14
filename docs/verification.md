# 検証記録の入口

この文書は検証境界と記録方法の入口です。[受入](../GLOSSARY.md)した release PR の head の source SHA、payload hash、実 CLI の version、session 証跡は dotfiles の [Issue #540](https://github.com/treflebonbon/dotfiles/issues/540) に紐づく共有 QA report に記録します。受入の結果をこの repository へ追記する運用はしません（追記すると source SHA が変わるためです）。

## 受入で確認すること

受入では、以下を別々に確認します。版ごとの受入の結果は、その版の受入を行った時点の source SHA に対するものです。前の版の導入・session 証跡は、次の版の結果へ転用しません。

| 境界                 | 確認内容                                                                                                                        | 成功扱いに必要な証拠                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| package static       | 12件の exact set、frontmatter、manifest version、license、依存表、resource links、npm lock URLs/integrity                       | `npm test`、`npm run format:check`、`npm run lint` の実行結果                    |
| fixture / quality    | source と導入済み payload の hash、runtime の source/version/content 不一致、nested Node/Bats の回帰                            | fixture の具体的な検出・拒否結果と suite の終了状態                              |
| official CLI install | Claude Code、Codex、Antigravity CLI それぞれが同一 full-SHA checkout から 12件を導入し、version/source/content を一致させたこと | CLI version、実行コマンド、導入元 path、導入済み path、skill set と content hash |
| new session          | 各 runtime が公式名で12件を検出・呼出し、実際に読んだ SKILL.md と資源/補助 CLI の path を確認したこと                           | tool/command の実 path と成功・拒否状態。自己申告だけでは成功にしない            |
| App / IDE            | Antigravity App/IDE の公式配置案内                                                                                              | 実機で試していない場合は未確認と記録                                             |

validator は manifest の受理、mock/fixture は指定分岐の挙動、公式 CLI install は runtime 配布境界、新規 session は実際の skill 呼出しを示します。それぞれ別の証拠として扱います。必須 CLI が無い場合の skip は未確認です。

最終 report には host OS/architecture、CLI の版、source revision、公式導入元、導入済み version、skill 名、実際に読まれた skill/resource path、実行した test suite、結果、拒否・未確認範囲を残します。資格情報、認証値、実ユーザー内容は出力・保存しません。

受入作業の host は WSL2 x86_64 です。dogfood fixture が `DOGFOOD_TEST_WSL=0` を使う場合、それは Linux browser route を選ぶ test override であり、Windows Chrome や WSL2 interop の実機検証とは数えません。WSL2 browser 経路は Windows-side 準備と実際の WSL2 host で別に確認します。

## 再実行する品質入口

開発依存として Node.js 20.19+、npm、Python 3、Bun 1.4.4+、Bats Core 1.x、`jq` を用意します。TypeScript evidence の Bats は `npm test` と pre-push で実行され、Bun 1.4.4 以上を必要とします。旧版の拒否も確認する場合は、`TYPESCRIPT_EVIDENCE_OLD_BUN` に Bun 1.2.14 の実行ファイルの絶対パスを指定します。`npm run lint:sh` には `shfmt` と `shellcheck` も要ります。

`main` 向け PR では、`CI` workflow が `opened`・`synchronize`・`reopened` でコードを検査します。`PR タイトル` workflow は、この3イベントと `edited` で `conventional-commits` を実行します。タイトル・本文の編集ではコード CI を再実行せず、workflow ごとに concurrency group を分けるため、実行中のコード CI も取り消しません。

PR の base branch だけを変えた場合も `edited` になるため、変更後のコード CI は push または reopen で起動します。

CI の `bun-cli` は Bun 1.4.4 で型検査と `npm run test:bun` を実行します。次の標準 GitHub-hosted runner を使い、OS・host architecture・Bun の platform / architecture・版が期待値と一致しなければ fixture を始めず失敗します。runner の対応表は [GitHub の公式資料](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories)を参照します。

| 検証対象      | runner             | host architecture | Bun platform / architecture |
| ------------- | ------------------ | ----------------- | --------------------------- |
| Linux x86_64  | `ubuntu-latest`    | `x86_64`          | `linux / x64`               |
| Linux aarch64 | `ubuntu-24.04-arm` | `aarch64`         | `linux / arm64`             |
| macOS aarch64 | `macos-15`         | `arm64`           | `darwin / arm64`            |

各 job の summary に、実際の checkout SHA と PR head SHA、runner、実測した OS / kernel・architecture・Bun 版、導入・環境照合・型検査・fixture の結果と fixture log の末尾20行を記録します。導入失敗や未実行も `always()` の記録 step に残します。PR の checkout は通常 merge commit なので、PR head と実際に検査した checkout を区別します。

後続の portable なファイル操作・process / lock の実証は、`tests/bun/` にテストを追加し、同じ `npm run test:bun` を3つの環境で実行します。この matrix は合成 fixture と型検査だけを対象にし、実モデル・実 browser・認証・Nix / raw isolation を呼びません。summary と通常の job log を証拠とし、artifact の upload や cache の拡張は行いません。

実測結果は対象 HEAD の各 job summary と fixture log で確認します。runner が定義されていても、未実行・環境不一致・導入失敗・required test の skip は未確認です。Linux x86_64 の結果を macOS / Linux aarch64 の証拠として転用せず、必要な環境の成功が揃うまで実証完了や後続 ticket の解禁を判断しません。fixture の成功も、実 CLI session や OS ごとの受入とは別の証拠です。

`typescript-evidence` の旧版 job では共用起動の拒否も検査します。

安全なファイル操作の候補と採用条件は [Bun ファイル操作の実証](bun-file-safety-proof.md)に記録します。`tests/bun/file-safety.test.ts` の機能判定と、必要な契約テストの成功・失敗・skip を併せて確認します。不適合の判定や skip を、移植完了の証拠にはしません。

process 置換・TTY・signal・FD と lock の比較は [Bun process / lock の実証](bun-process-lock-proof.md)に記録します。旧契約との不適合を検出するテストの成功は、方式の採用や後続 ticket の解禁を意味しません。

namespace・UID/GID mapping・capability・loopback の比較は [Bun namespace の実証](bun-namespace-proof.md)に記録します。実 namespace のテストは Linux / WSL2 で `NAMESPACE_PROOF_REAL=1` を明示して実行します。通常 CI の skip と実測の成功を区別し、必要な OS と配布環境の確認が揃うまで採用と後続の依存解除を判断しません。

Nix store の Bun・closure・生成 wrapper と書込み先の実証は [Bun Nix runtime の実証](bun-nix-runtime-proof.md)に記録します。実隔離の検査は Linux / WSL2 で `NIX_BUN_PROOF_REAL=1` を明示し、Nix store の tool と bubblewrap を使って実行します。通常 CI の skip を採用や本番 runtime の受入の証拠にはしません。

CI の `typescript-evidence` は Bun 1.4.4 と `ast-grep 0.42.1` で抽出テストを実行し、別の Bun 1.2.14 ジョブで `unavailable` による拒否を確認します。対応版では実物の `ast-grep` の版を先に確認するため、ツール不足で native テストがスキップされた結果を成功扱いしません。旧版の拒否テストは専用ジョブで必ず実行します。

```sh
npm ci --prefix development
npm run format:check
npm test
npm run lint
npm run lint:sh
```

`lint:sh` が検査するのは、`shfmt` が `bin/` のシェルスクリプトと `lib/bun/run`、`development/plugin-sessions`、両 peer の `scripts/check-architecture-report`・`scripts/candidate-record`・`scripts/run-evidence`・`scripts/check-owned.sh`、Herdr の `scripts/peer-request.sh`、Orca の `scripts/orca-preflight`、`tests/cli/git-push-topic.bats`、`shellcheck` が `bin/` のシェルスクリプトと `lib/bun/run`、`development/plugin-sessions`、両 peer の `scripts/check-architecture-report`・`scripts/candidate-record`・`scripts/run-evidence`・`scripts/check-owned.sh`、Herdr の `scripts/peer-request.sh`、Orca の `scripts/orca-preflight` です（`-S warning` 以上。info と style は見ません）。対象のファイルを commit するときは、pre-commit hook が実行します。CI では走りません。

HTML report の静的 checker と text 抽出の比較 corpus、同梱 parser、入口の更新は [移行記録](html-report-parser-proof.md) を参照してください。

report と質問シートの loopback 配信、旧 HTTP corpus、専用 root と process の開始終了は [配信の移行記録](bun-loopback-proof.md)と `tests/bun/serve-local.test.ts` で確認します。

coordination helper の旧 corpus、readiness の独立検証、terminal 応答と所有範囲の比較は [移行記録](bun-peer-coordination-proof.md)と `tests/bun/peer-coordination.test.ts`、対応する公開 Bats で確認します。

`gh-review-thread` の旧 CLI 出力・段階別失敗・返信と resolve の順序は [移行記録](bun-review-thread-proof.md)、`tests/bun/gh-review-thread.test.ts` と `tests/cli/gh-review-thread.bats` で確認します。実 GitHub への返信・resolve は行わず、fake `gh` の argv と応答を比較します。

導入 smoke と session の `run/check`、旧証跡・native argv・process group の比較は [移行記録](bun-plugin-sessions-proof.md)と `tests/bun/plugin-{smoke,sessions,session-process}.test.ts` で確認します。通常 suite は fake CLI だけを使い、実公式導入・実モデルの opt-in と分けます。

他のシェルファイルは対象外です。そのうち次の Bats 7 ファイルは、`.editorconfig` の `indent_size = 2` で `shfmt -l` に差分が出ることを確認しました。対象へ足すときは、先に整形を揃えます。`peer-peer-request`、`peer-run-evidence`、`peer-skills-contracts`、`devshell-env`、`isolated-github`、`raw-codex-integration`、`secret-isolation-worktree`。他の対象外のファイルは、差分の有無を確認していません。

`npm test` は Bun CLI の型検査・`tests/bun/` の Bun suite、Python の unittest discovery、dogfood / domain-modeling-studio / WSL2 browser package の Node suite、dogfood / WSL2 browser package / raw Codex fixture、および公開 `tests/*.bats` と `tests/cli/*.bats` を実行します。通常 suite は実 browser suite を起動しません。`npm run test:plugin-cli` は3 CLI すべてを要求する install smoke test で、モデルを呼ぶ実 session の証拠にはなりません。

`tests/raw-codex/raw-managed-profile.bats` の「managed host grants and ancestor path rules stay scoped in raw namespace」は、Claude Code の worktree 隔離 session（Bats の一時 directory が `/tmp/nix-shell.*/` 配下）で失敗し、単独実行でも再現することを確認しました。sandbox 内の task が `mkdir: cannot create directory …/raw/home: Read-only file system` で終了します（confirmed）。原因の特定と、この環境の外で成功するかは未確認です。`npm test` の失敗にこのテスト 1 件だけが現れる場合は、環境依存の可能性が高い（推定）ので、通常の端末で単独実行して切り分けます。

同じ失敗が Nix shell 配下の一時 directory で起きた場合は、`TMPDIR` だけを Nix shell 外の書込み可能な directory に変えて、この1件を再実行します。WSL2 の通常セッションではこの変更で成功したことを確認しました（confirmed）。fixture の保管先を変える切り分けであり、権限と host 非公開の検査は同じものを実行します。単独実行が通ったら、その `TMPDIR` と同じ HEAD で全 `npm test` を実行します。

candidate と公開証跡の移行・native module の明示的な準備・旧 corpus の復旧は [移行記録](bun-peer-evidence-proof.md)と `tests/bun/peer-evidence.test.ts` で確認します。`npm run test:bun` は先に `npm run prepare:file-safety` を実行します。準備には導入済み Node.js と対応する Node-API header、`cc` が必要で、通常の helper 実行では build しません。

## product-guide のブラウザ受入（人手）

`tests/bun/product-guide.test.ts` は CLI の終了コードと出力ファイルだけを検証します。表示は自動化しておらず、リリースの受入で人が次を確認し、結果と未確認の項目を記録します。

1. 架空のモデルから `internal` と `public` を生成し、`index.html` だけをブラウザで開く。
2. ネットワークを遮断した状態で開き、外部読込みの失敗や欠けた表示がないこと。
3. 機能目次・見出しリンクで移動でき、`internal` の「根拠を表示」をキーボード（Tab・Enter・Space）だけで開閉できること。
4. 印刷プレビューで本文が読め、折りたたみの内容が表示されること。
5. 提案の機能が現行の節・目次にないこと。状態と区分が色以外の文字でも分かること。
6. `public` の `index.html` に、コミット ID・パス・シンボルがないこと（ページのソースを検索する）。
7. 流れの図が表示され、ブラウザのズーム（200% 以上）とスクロール領域のキーボード操作で読めること。枠線の種類と文字で根拠区分が分かり、図の下の文章説明が手順リストと一致していること。印刷プレビューでも図が欠けないこと。

実ブラウザの自動化は CI の対象外です。実行できなかった項目は未確認と記録します。

### 記録の方法

実施ごとに、日付・対象のコミット・ブラウザと実施手段・手順 1〜7 の結果（確認済み / 未確認と理由）を次の形式で追記します。

### 実施記録: 2026-11-13（#69、`playwright-cli` の Chromium、1400 幅と 360 幅）

- 対象コミット: `7068b4b`（初回の実施）。script を外した `dff433f` では、目次移動と現在位置だけを再確認した（手順 3 の注記のとおり）。それ以降のコミットでは再実施していない。
- 手段: `playwright-cli` で実 Chromium を操作。`file:` は拒否されたため、127.0.0.1 の一時 HTTP サーバー（`internal` と `public` を生成した親ディレクトリ）から配信。架空モデルは「請求書申請ガイド」。
- 手順 2（外部通信）: 確認済み。読込み中のリクエストは `index.html` の 1 件のみ（外部 0 件）で、HTML に script・外部参照・フォント指定はない（`document.fonts` は 0 件）。読込み後にコンテキストを offline にして操作した。offline での再読込みは loopback も遮断されるため行っていない。
- 手順 3（キーボード）: 確認済み。Tab の最初の停止はスキップリンク、次が目次。目次で Enter すると `#feature-1` へ移動し、その目次項目に「▶」と太字が付く（CSS の `:target` と `:has()` による。スクロール追従はしない）。`summary` は Enter と Space で開閉でき、フォーカスは 3px の枠線で見える（初回実施時の確認。script を外した再実施では目次移動と現在位置のみ再確認し、`summary` の開閉は再確認していない）。
- 手順 4（印刷）: 一部確認済み。`print` メディアの emulate で、閉じた折りたたみの内容が全て表示され（画面では閉じたまま）、全面スクリーンショットで本文が読めることを目視した。実際の印刷ダイアログと用紙への出力は未確認。
- 手順 5: 確認済み（目視）。提案は「提案（現行の機能ではありません）」の別枠にあり、目次にない。状態と区分は文字のバッジ、食い違いは「注意」の文字と記号で示される。
- 手順 6（`public` のソース検索）は自動テストで確認済み。ブラウザでの `public` 表示は未確認。
- 追加: 360 幅で横スクロールなし。本文 16px・行間 約 1.85。80rem 以上の幅では目次が左に固定される（#74 で 88rem 以上へ変更）。ダークモード表示・200% ズーム・スクリーンリーダーは未確認（#74 の実施記録で一部を確認）。

### 実施記録: 2026-11-13（#74、`playwright-cli` の Chromium）

- 対象コミット: `eb3da50` の上で、のちに `0349240` として commit した変更を加えた作業ツリー。commit 後のブラウザでの再確認はしていない。その後の `18e71b5`（型と定義表の整理）は、fixture から生成した `internal` と `public` の出力が変更の前後で同一であることだけを確認した。`7fc5da0` 以降（`public` の検査の変更）はブラウザでは未確認。
- 手段: 架空の実文 fixture（`tests/fixtures/product-guide-model.json`、機能 6 件・長い見出し 1 件・提案 1 件・未調査・矛盾・入れ子フロー 2 件）から `internal` と `public` を生成し、127.0.0.1 の一時 HTTP サーバーから配信して `playwright-cli` で操作。環境は Linux（WSL2）上の Chromium 1 種類のみ。
- 確認済み:
  - 狭い画面: 360 幅と 320 幅で、図のスクロール領域を除き横スクロールなし。長い見出しは折り返され、目次・本文とも崩れない。
  - ズーム: ブラウザのズームそのものは操作できないため、200% 相当の 640 幅と、1280 幅（2560 幅の 200%）で代替した（代替であり、実際のズーム操作は未確認）。
  - ダークモード（`set-color-scheme dark`）: 背景・本文・図の線と文字・リンクが読める。目視。コントラスト比の計測は未実施。
  - 印刷（`set-media print`、794 幅）: 閉じた折りたたみ 45 件がすべて表示され、図が欠けず、横はみ出しなし。実際の印刷ダイアログは未確認。
  - 図（Dagre・ELK.js）の実表示: 表示される。SVG の文字の右端が枠の右端より内側に収まることを、通常のフォントと、フォールバック想定の `DejaVu Sans` へ強制した場合の両方で実測した（余白 12px 以上）。
  - `summary` の開閉: script のない出力で、フォーカスした `summary` が Enter と Space で開閉する。フォーカス枠は 3px。
  - 外部通信: 読込みは `index.html` のみ。console の唯一のエラーは一時サーバーの `favicon.ico` 404。
  - フォールバック: この環境の日本語フォントは Noto CJK 系のみ。日本語フォントが全くない環境、Hiragino・Yu Gothic・Meiryo での表示は未確認。
- 見つけて直した問題:
  1. 1280〜1407 幅で、固定の目次と本文の間隔が 8px ほどしかなく窮屈だった。目次を固定する下限を 80rem から 88rem へ上げた（それ未満は本文の前に置く）。
  2. 本文の行長が 48rem（全角約 48 字）で、日本語には長かった。42rem へ縮めた。あわせて `word-break:auto-phrase`（対応ブラウザで文節単位の折返し）と、見出しの `text-wrap:balance`、本文の `text-wrap:pretty` を足した。非対応のブラウザでは従来の折返しになる。
  3. 入れ子の図で、同じ区分（社員 → 上長 → 社員）を往復する流れが 1 つの枠へ集められ、矢印が枠の外を大きく迂回して上から下の順に読めなかった。連続する手順ごとに別の枠にした。
- 残る未確認: Safari・Firefox・スマートフォン実機、実際のブラウザのズーム操作と印刷ダイアログ、日本語フォントがない環境、スクリーンリーダー、コントラスト比の計測、`word-break:auto-phrase` の非対応ブラウザでの折返し幅。
- **非エンジニアによるレビューは未実施**。この記録の確認項目は、レビューではなく表示の確認である。

## 非エンジニアのレビュー（人が実施・未完了）

#74 の受入条件「非エンジニアのレビューで把握できると確認され、記録されている」は、人にしか確認できない。次の手順で用意し、結果は実施者が下の形式で追記する。AI が非エンジニアの立場で代わりに記入しない。

### 再現手順

```sh
plugin_root="<このリポジトリの絶対パス>"
dir="$(mktemp -d)"
for a in internal public; do
  "$plugin_root/lib/bun/run" run "$plugin_root/skills/product-guide/scripts/product-guide.ts" \
    generate "$plugin_root/tests/fixtures/product-guide-model.json" --audience "$a" --out "$dir"
done
```

標準出力に 2 つの `index.html` のパスが出る。レビュー担当者には、まず `public`（外部へ共有する版）だけを渡す。`internal`（根拠を辿れる版）は、根拠の見え方を確かめたい人にだけ渡す。題材は架空の備品貸出で、実在の企業・個人・機密は含まない。

### チェックリスト（レビュー担当者が記入する）

レビュー担当者は、ガイドを開いて 15 分ほど読んだあと、ガイドを見ずに次に答える。答えられなかった項目、迷った箇所は、その場所（見出し）とともに記録する。

1. 自分への影響: 「社員」として、このガイドで何が自分に関係すると分かったか。
2. 必要な対応: 備品を借りる前、返却の前に、自分がしておくことは何か。
3. 通常の流れ: 備品を借りてから返すまでの順序を言えるか。
4. 例外: 返却予定日を過ぎたとき、備品が「要確認」になったとき、付属品が足りないときはどうなるか。
5. 未確認範囲: このガイドが調べていない機能と、確認できていない事項は何か。「分かっていること」と「分かっていないこと」を取り違えていないか。
6. 提供状況: 今使える機能と、まだ使えない・開発中・提案中の機能を区別できたか。
7. 食い違い: コードと業務判断が食い違っている箇所があることに気づいたか。どう扱うべきと感じたか。
8. 目次と見出し: 目的の節へ迷わず移動できたか。今どこを読んでいるか分かったか。
9. 図: 図と文章のどちらで流れを理解したか。図が読めない・役に立たない箇所はあったか。
10. 読みやすさ: 狭い画面・拡大・印刷のうち使ったもので、読みにくい箇所はなかったか。

### 記録の形式

実施日・レビュー担当者の立場（職種のみ。個人名は書かない）・使った版（`public` / `internal`）・端末とブラウザ・項目 1〜10 の回答の要点と迷った箇所・見つかった指摘と、反映したか未反映の理由。

## 変更した Python 関数の docstring 診断

`npm run report:docstrings` は、比較元の commit とステージ済みの内容（index）を比べ、構文が変わった Python 関数の docstring 有無を JSON で表示します。JSON だけを取得するときは `--silent` を使います。

```sh
npm run --silent report:docstrings
npm run --silent report:docstrings -- --base origin/main
```

既定の比較元は `HEAD` です。`--base REF` は指定した commit 自体と index を比較し、merge-base を自動計算しません。作業ツリーの未ステージ変更は含めず、ソースを実行したりファイルや index を変更したりしません。Git hook の `GIT_INDEX_FILE` は、現在の worktree の Git dir 内にある通常ファイルだけを受け付けます。これにより部分 commit 用の index も診断できます。

対象は `.py` と、一般的な Python / PyPy の shebang を持つ拡張子なしのファイルです。関数名はクラス・入れ子の所属を含め、`path`・`name`・`line`・`has_docstring` を列挙します。`head` と `base` は完全な SHA、`source` は `index`、`missing_docstrings` は docstring が空または存在しない関数の件数です。コメント・整形だけの変更や完全削除した関数は列挙しません。入れ子関数の変更は、それを含む関数の構文変更としても表示されます。

shebang の認識は Python / PyPy の直接指定（例: `#!/usr/bin/python3`）、`env python3`、`env -S python3 ...` の形に限ります。`env -S -u PYTHONPATH python3` のように Python の前に別のオプションが入る拡張子なしファイルは対象外です。`.py` は shebang に関係なく対象になります。

docstring の不足は診断だけなので終了コード0です。比較元不明・Git の管理情報不正・対象 Python の構文不正など、診断できない場合は非0で終了します。この診断は説明の要否や品質を判断せず、CodeRabbit の複雑度・coverage の計算も再現しません。結果を見て、説明が必要な関数を人または実装者が判断します。

## 実セッションの opt-in 検査

Bash・Bun 1.4.4+ と Linux、macOS、WSL2 の通常認証済み CLI で、導入済み plugin の新規セッションを検査します。先に各 CLI の管理画面・一覧と導入確認の記録で、受入対象の source SHA・version・payload hash と導入内容の一致、および実際に読み込まれる plugin root の絶対パスを確認してください。この入口は plugin の導入や更新、認証値の取得・複製を行いません。実行前後の配布物不変性と品質 suite は、上の独立した境界で確認します。

```sh
npm run test:plugin-sessions -- run --output-dir /absolute/path/outside-plugin/session-report \
  --installed-root claude=/verified/claude/plugin \
  --installed-root codex=/verified/codex/plugin \
  --installed-root agy=/verified/agy/plugin
```

`run` は実モデルを呼びます。出力先は plugin 外の未作成 directory を指定します。省略時は3 CLI × 全12 skill を実行し、欠けた CLI や inventory 取得失敗をスキップ扱いしません。`--runtime agy --skill pr-screenshots` のように範囲を絞れます（両 flag は複数指定可能）。モデルは各 CLI の通常設定を使い、各 session の上限は既定240秒、`--timeout` で変更できます。既存 session の resume、権限回避 flag、共有設定の変更は行いません。

`--installed-root RUNTIME=PATH` は runtime ごとに1件指定し、例のパスを独立した導入確認で得た値に置き換えます。`skills/` を含む plugin root を指定し、読込 event から逆算した値や cache の配置の推測は使いません。導入先の symlink と実体に別名がある場合は、導入確認で対応を確認した実読込側のパスを使います。この入力は呼出し側の確認結果であり、この CLI が source・version・hash の一致を保証するものではありません。未指定なら、他の条件が揃っても `installed_root_unconfirmed` で未確認にします。

各 case と同じ cwd で native inventory を取得し、その case の `inventory.json` に cwd と確認済み root を保存します。Codex は `plugin list --marketplace treflebonbon --json` で対象 marketplace の導入状態を取得します。Claude の対象 skill の一覧は session の init を使います。実行した case の `process.json` に正式な呼出し command と終了コード、`events.jsonl` に native event、`stderr.log` に分離した診断を保存します。CLI や inventory が不足して起動しない case は `result.json` に未確認を記録します。directory は0700、保存ファイルは0600です。`summary.json` に CLI の版と実体、session ID、実読込 path、成功・失敗・未確認を集約します。原本には tool の出力が含まれるため、共有前に資格情報や利用者内容が混ざっていないことを確認します。

```sh
npm run test:plugin-sessions -- check /absolute/path/outside-plugin/session-report/agy/pr-screenshots
```

`check` は保存済み case 内の `inventory.json` と event・process の記録を読み、モデルや native CLI を呼ばずに JSON を返します。再判定する端末の cwd・設定・導入先には依存しません。旧形式の親 directory の inventory だけを持つ証跡は未確認となり、case ごとの inventory と導入先を確認して再収集します。終了コードの手入力は不要です。`status: passed` のときだけ終了コード0を返し、失敗・未確認は1です。判定には以下をすべて要求します。

- native inventory に対象 skill があること。Claude は session の init、Codex は enabled な plugin inventory と skill の実読込、Antigravity は `/skills` の一覧で確認します。
- 記録された command が名前空間付きの正式名を明示し、resume を使っていないこと。
- CLI の終了コード0、native completion の成功、1件の session ID が揃うこと。`run` はさらに全 case の ID の重複を検査します。1件だけを再判定する `check` は、他 case の ID を照合しません。
- 確認済み root の `skills/<skill>/SKILL.md` と、その同じ directory 配下の同梱 reference・依存文書・helper source の成功読込があること。別コピーや旧 cache の同じ suffix では成功にしません。

Claude の Read は対応する tool result、Antigravity の read_file は完了時の読込結果、Codex は単独の `cat -- <絶対 path>`（または単独の `cat <絶対 path>`）の正常終了を判定します。Codex の shell 連結・変数・pipe・`sed`・出力の自己申告は読込証拠にしません。未知・途中切れの event は成功にせず、元ログを残します。

この成功は skill と同梱資源の読込に限ります。`dependencies_status` と `auxiliary_status` は `unconfirmed` として残し、第三者依存 skill の導入・補助 CLI の実行・本来の業務 workflow・App/IDE・browser の動作を成功扱いしません。prompt は検出・読込だけに限定し、Git 操作・外部書込・削除・子 agent 起動を要求しません。CLI の既存 permission profile と hooks は引き続き適用されます。

## リリース

リリースは release-please が自動で release PR を作り、人が[受入](../GLOSSARY.md)して merge する流れです。判断の経緯は [ADR-0001](adr/0001-automate-releases-with-release-please.md) にあります。

1. `main` に版へ影響する変更（`feat`、`fix`、破壊的変更）が merge（squash）されると、release-please が release PR（`chore(main): release <版>`）を作ります。版の更新と `CHANGELOG.md` の更新（初回は新規作成）が含まれます。`chore` や `docs` だけでは、release PR は作られません。
2. release PR の head で、上の「受入で確認すること」を行い、結果を [Issue #540](https://github.com/treflebonbon/dotfiles/issues/540) に記録します。
3. 受入が済んだら release PR を merge します（これがリリースです）。tag `v<版>` と GitHub release が自動で作られます。

版は、1.0 になる前は `feat` と `fix` で patch、破壊的変更で minor が上がります。PR タイトルは Conventional Commits にします（`PR タイトル` workflow の `conventional-commits` が検査します）。版の場所 4 つ（`plugin.json`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`package.json`）は release-please が更新するので、手で版を上げません。`tests/test_plugin.py` が、4 つが一致し、`release-please-config.json` が 4 つすべてを更新対象にしていることを検査します。

release PR を作るには、リポジトリ設定「Allow GitHub Actions to create and approve pull requests」（Settings → Actions → General → Workflow permissions）が有効である必要があります。

## git hook

hook は `lefthook.yml` が定義し、`lefthook install` で入ります。hook は共有の Git dir に入るため、同じ repo の全 worktree に効きます。`shfmt`、`shellcheck`、`gitleaks`、`cog`、Bats は devShell が提供します。

| hook       | job                    | 内容                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pre-commit | `format`               | `npm run format:check`。oxfmt が無ければ `npm ci --prefix development` を促して失敗します。新しい clone や worktree では先に導入します。                                                                                                                                                                                                                                                    |
| pre-commit | `shell`                | `npm run lint:sh`。`bin/**`、`lib/bun/run`、上記の peer helper、`tests/cli/git-push-topic.bats`、`.editorconfig`、`package.json` を変更したときだけ動きます。                                                                                                                                                                                                                               |
| pre-commit | `docstrings`           | `npm run --silent report:docstrings`。変更した Python 関数の docstring 有無を JSON で表示します。説明不足だけでは止めず、比較元不明・構文不正など診断不能の場合は失敗します。                                                                                                                                                                                                               |
| pre-commit | `workflows`            | `.github/workflows/*.{yaml,yml}` を変更したときだけ、`pinact`（action の SHA 固定）、`actionlint`、`ghalint` を順に実行します。                                                                                                                                                                                                                                                             |
| pre-commit | `gitleaks`             | staged の変更に秘密情報がないことを確認します。                                                                                                                                                                                                                                                                                                                                             |
| pre-push   | `tests`                | `npm run typecheck`・`npm run test:bun`・`npm run test:python` と公開 Bats（`tests/*.bats` と `tests/cli/*.bats`）。実測で約 2 分半です。raw Codex・browser・Node の suite は含みません（前節の sandbox 依存の失敗を避けるためです）。全 suite は `npm test` で別に実行します。hook が設定する `GIT_DIR` と `GIT_PREFIX` は、テストの fixture の Git が実 repo を向くため外して実行します。 |
| commit-msg | `conventional-commits` | `cog verify` で Conventional Commits を確認します。merge commit は対象外です。                                                                                                                                                                                                                                                                                                              |

## 以前の version 0.1.0 の記録

次の結果は rop だけを収録した `0.1.0` の記録です。それ以降の版の導入・呼出し・資源解決の受入証拠へ転用しません。旧 CLI session は当時の実行確認としてのみ保持します。

| 境界                                           | 旧結果                                                    |
| ---------------------------------------------- | --------------------------------------------------------- |
| Antigravity CLI 1.4.8 strict validation        | portable manifest と rop 1件を検出                        |
| Claude Code 2.1.312 official local marketplace | 一時 HOME/XDG で導入し rop inventory を確認               |
| Codex 0.165.0 official local marketplace       | 導入済み Rust reference と配布元の一致を確認              |
| Antigravity CLI 1.4.8 local install            | plugin list に rop を確認                                 |
| Claude Code / Codex / Antigravity new session  | 旧 rop 版で名前付き呼出しと Rust reference の読取りを確認 |
| Antigravity App/IDE                            | 未確認                                                    |

旧 session は既存の通常認証を runtime から利用し、資格情報を直接取得・複製・出力しませんでした。旧 report と一時実行記録は、現行の受入の source SHA ではありません。
