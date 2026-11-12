# 検証記録の入口

この文書は検証境界と記録方法の入口です。[受入](../GLOSSARY.md)した release PR の head の source SHA、payload hash、実 CLI の version、session 証跡は dotfiles の [Issue #540](https://github.com/treflebonbon/dotfiles/issues/540) に紐づく共有 QA report に記録します。受入の結果をこの repository へ追記する運用はしません（追記すると source SHA が変わるためです）。

## 受入で確認すること

受入では、以下を別々に確認します。版ごとの受入の結果は、その版の受入を行った時点の source SHA に対するものです。前の版の導入・session 証跡は、次の版の結果へ転用しません。

| 境界                 | 確認内容                                                                                                                        | 成功扱いに必要な証拠                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| package static       | 11件の exact set、frontmatter、manifest version、license、依存表、resource links、npm lock URLs/integrity                       | `npm test`、`npm run format:check`、`npm run lint` の実行結果                    |
| fixture / quality    | source と導入済み payload の hash、runtime の source/version/content 不一致、nested Node/Bats の回帰                            | fixture の具体的な検出・拒否結果と suite の終了状態                              |
| official CLI install | Claude Code、Codex、Antigravity CLI それぞれが同一 full-SHA checkout から 11件を導入し、version/source/content を一致させたこと | CLI version、実行コマンド、導入元 path、導入済み path、skill set と content hash |
| new session          | 各 runtime が公式名で11件を検出・呼出し、実際に読んだ SKILL.md と資源/補助 CLI の path を確認したこと                           | tool/command の実 path と成功・拒否状態。自己申告だけでは成功にしない            |
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

CI の `typescript-evidence` は Bun 1.4.4 と `ast-grep 0.42.1` で抽出テストを実行し、別の Bun 1.2.14 ジョブで `unavailable` による拒否を確認します。対応版では実物の `ast-grep` の版を先に確認するため、ツール不足で native テストがスキップされた結果を成功扱いしません。旧版の拒否テストは専用ジョブで必ず実行します。

```sh
npm ci --prefix development
npm run format:check
npm test
npm run lint
npm run lint:sh
```

`lint:sh` が検査するのは、`shfmt` が `bin/` のシェルスクリプトと `lib/bun/run`、`tests/cli/git-push-topic.bats`、`shellcheck` が `bin/` のシェルスクリプトと `lib/bun/run`です（`-S warning` 以上。info と style は見ません）。対象のファイルを commit するときは、pre-commit hook が実行します。CI では走りません。

他のシェルファイルは対象外です。そのうち次の Bats 7 ファイルは、`.editorconfig` の `indent_size = 2` で `shfmt -l` に差分が出ることを確認しました。対象へ足すときは、先に整形を揃えます。`peer-peer-request`、`peer-run-evidence`、`peer-skills-contracts`、`devshell-env`、`isolated-github`、`raw-codex-integration`、`secret-isolation-worktree`。他の対象外のファイルは、差分の有無を確認していません。

`npm test` は Bun CLI の型検査・`tests/bun/` の Bun suite、Python の unittest discovery、dogfood / domain-modeling-studio / WSL2 browser package の Node suite、dogfood / WSL2 browser package / raw Codex fixture、および公開 `tests/*.bats` と `tests/cli/*.bats` を実行します。通常 suite は実 browser suite を起動しません。`npm run test:plugin-cli` は3 CLI すべてを要求する install smoke test で、モデルを呼ぶ実 session の証拠にはなりません。

`tests/raw-codex/raw-managed-profile.bats` の「managed host grants and ancestor path rules stay scoped in raw namespace」は、Claude Code の worktree 隔離 session（Bats の一時 directory が `/tmp/nix-shell.*/` 配下）で失敗し、単独実行でも再現することを確認しました。sandbox 内の task が `mkdir: cannot create directory …/raw/home: Read-only file system` で終了します（confirmed）。原因の特定と、この環境の外で成功するかは未確認です。`npm test` の失敗にこのテスト 1 件だけが現れる場合は、環境依存の可能性が高い（推定）ので、通常の端末で単独実行して切り分けます。

同じ失敗が Nix shell 配下の一時 directory で起きた場合は、`TMPDIR` だけを Nix shell 外の書込み可能な directory に変えて、この1件を再実行します。WSL2 の通常セッションではこの変更で成功したことを確認しました（confirmed）。fixture の保管先を変える切り分けであり、権限と host 非公開の検査は同じものを実行します。単独実行が通ったら、その `TMPDIR` と同じ HEAD で全 `npm test` を実行します。

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

Python 3.9+ と Linux、macOS、WSL2 の通常認証済み CLI で、導入済み plugin の新規セッションを検査します。先に各 CLI の管理画面・一覧と導入確認の記録で、受入対象の source SHA・version・payload hash と導入内容の一致、および実際に読み込まれる plugin root の絶対パスを確認してください。この入口は plugin の導入や更新、認証値の取得・複製を行いません。実行前後の配布物不変性と品質 suite は、上の独立した境界で確認します。

```sh
npm run test:plugin-sessions -- run --output-dir /absolute/path/outside-plugin/session-report \
  --installed-root claude=/verified/claude/plugin \
  --installed-root codex=/verified/codex/plugin \
  --installed-root agy=/verified/agy/plugin
```

`run` は実モデルを呼びます。出力先は plugin 外の未作成 directory を指定します。省略時は3 CLI × 全11 skill を実行し、欠けた CLI や inventory 取得失敗をスキップ扱いしません。`--runtime agy --skill pr-screenshots` のように範囲を絞れます（両 flag は複数指定可能）。モデルは各 CLI の通常設定を使い、各 session の上限は既定240秒、`--timeout` で変更できます。既存 session の resume、権限回避 flag、共有設定の変更は行いません。

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
| pre-commit | `shell`                | `npm run lint:sh`。`bin/**`、`tests/cli/git-push-topic.bats`、`.editorconfig`、`package.json` を変更したときだけ動きます。                                                                                                                                                                                                                                                                  |
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
