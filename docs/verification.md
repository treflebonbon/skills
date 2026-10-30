# 検証記録の入口

この文書は検証境界と記録方法の入口です。最終 candidate の source SHA、payload hash、実 CLI の version、session 証跡は dotfiles の [Issue #540](https://github.com/treflebonbon/dotfiles/issues/540) に紐づく共有 QA report と PR 記録へ置きます。受入時の結果をこの repository へ追記して source SHA を変える運用はしません。

## Candidate 0.2.3 の再受入境界

候補版 `0.2.3` では、dotfiles から未移管だった機能契約 test を公開側へ揃えます。既存の root / CLI Bats は従来 Python bridge 経由で `npm test` に含まれており、その成功を保ったまま、新しい suite と合わせて `test:bats` から全 Bats を直接実行する入口へ統一します。重複する bridge を整理し、新しい source SHA で全受入境界を再確認します。結果は Issue #540 と PR の共有 QA report に記録します。

## Candidate 0.2.2 の受入境界

候補版 `0.2.2` では、以下を別々に確認します。

公開済み `0.2.1` は変更せず、Claude Code 2.1.312 の official local marketplace install で確認した開発依存の自動展開を修正します。Claude Code は plugin root の `package.json` と `package-lock.json` にある Node.js 依存を導入時に install します（[公式仕様](https://code.claude.com/docs/en/plugins/loading#node-js-package-dependencies)）。そのため formatter の package と lockfile を `development/` へ移し、runtime plugin root に開発依存と lockfile を置かない構成にします。0.2.1 の導入・session 証跡は 0.2.2 の結果へ転用しません。

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

開発依存として Node.js 20.19+、npm、Python 3、Bats Core 1.x、`jq` を用意します。

```sh
npm ci --prefix development
npm run format:check
npm test
npm run lint
```

`npm test` は Python の unittest discovery、dogfood / domain-modeling-studio / WSL2 browser package の Node suite、dogfood / WSL2 browser package / raw Codex fixture、および公開 `tests/*.bats` と `tests/cli/*.bats` を実行します。通常 suite は実 browser suite を起動しません。`npm run test:plugin-cli` は3 CLI すべてを要求する install smoke test で、モデルを呼ぶ実 session の証拠にはなりません。

## 以前の version 0.1.0 の記録

次の結果は rop だけを収録した `0.1.0` の記録です。`0.2.2` の11件の導入・呼出し・資源解決の受入証拠へ転用しません。旧 CLI session は当時の実行確認としてのみ保持します。

| 境界                                           | 旧結果                                                    |
| ---------------------------------------------- | --------------------------------------------------------- |
| Antigravity CLI 1.4.8 strict validation        | portable manifest と rop 1件を検出                        |
| Claude Code 2.1.312 official local marketplace | 一時 HOME/XDG で導入し rop inventory を確認               |
| Codex 0.165.0 official local marketplace       | 導入済み Rust reference と配布元の一致を確認              |
| Antigravity CLI 1.4.8 local install            | plugin list に rop を確認                                 |
| Claude Code / Codex / Antigravity new session  | 旧 rop 版で名前付き呼出しと Rust reference の読取りを確認 |
| Antigravity App/IDE                            | 未確認                                                    |

旧 session は既存の通常認証を runtime から利用し、資格情報を直接取得・複製・出力しませんでした。旧 report と一時実行記録は現行 candidate の最終 source SHA ではありません。
