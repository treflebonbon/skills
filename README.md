# treflebonbon-skills

Claude Code、Codex、Antigravity CLI で使う Agent Skills plugin です。現在の採用候補は `0.2.3` で、対象11件を1つの plugin にまとめています。plugin の利用と汎用 skill に dotfiles や Nix は必要ありません。

## 収録 skill

| Skill                    | 用途                                                     |
| ------------------------ | -------------------------------------------------------- |
| `dogfood`                | Web アプリや Chrome MV3 拡張を検査し、ローカル証跡を報告 |
| `domain-modeling-studio` | 既存コードを調べ、人が編集できる offline model を作成    |
| `herdr-peer-refactor`    | Herdr と read-only peer を使った候補改善                 |
| `marp`                   | Marp CLI でスライド・PDF を作成                          |
| `md-agents-review`       | `AGENTS.md` と Codex 向け指示をレビュー                  |
| `md-claude-review`       | `CLAUDE.md` と Claude Code 向け指示をレビュー            |
| `orca-peer-refactor`     | Orca orchestration と read-only peer を使った候補改善    |
| `pr-screenshots`         | 既存 PR に画像を添付する手順                             |
| `rop`                    | Elixir・Gleam・Rust・Effect-TS の ROP を適用             |
| `ui-grill-with-docs`     | UI/UX の設計質問と回答欄を含む offline HTML を作成       |
| `worktree-gc`            | repo-local worktree の保護付き診断・回収                 |

## 公式配布元から導入する

公開 repository の `treflebonbon/skills` を各 CLI の公式 installer に指定できます。以下は各 CLI の公開 GitHub source 形式です。候補 SHA への固定導入とは別の入口であり、この package の統合検証ではまだ実行していません。

### Claude Code

```sh
claude plugin marketplace add treflebonbon/skills
claude plugin install treflebonbon-skills@treflebonbon
```

### Codex

```sh
codex plugin marketplace add treflebonbon/skills
codex plugin add treflebonbon-skills@treflebonbon
```

### Antigravity CLI

```sh
agy plugin install https://github.com/treflebonbon/skills
agy plugin list --json
```

公開 source は更新に追従する入口です。候補版を固定して導入するときは、別の checkout を full commit SHA へ固定します。SHA と最終 payload hash は採用記録に残し、plugin 自身のファイルへ自己参照として書きません。

```sh
git clone https://github.com/treflebonbon/skills.git
cd skills
git checkout <確認済みの完全なcommit-SHA>
```

同じ checkout を各 runtime の公式 installer に渡します。

### Claude Code

```sh
claude plugin marketplace add /absolute/path/to/skills
claude plugin install treflebonbon-skills@treflebonbon
```

### Codex

```sh
codex plugin marketplace add /absolute/path/to/skills
codex plugin add treflebonbon-skills@treflebonbon
```

### Antigravity CLI

```sh
agy plugin install /absolute/path/to/skills
agy plugin list --json
```

各 CLI の `plugin` 管理画面・一覧で導入元と version を確認してから新規 session を始めます。呼び出し名は次のとおりです。

| Runtime         | 呼び出し                            |
| --------------- | ----------------------------------- |
| Claude Code     | `/treflebonbon-skills:<skill-name>` |
| Codex           | `$treflebonbon-skills:<skill-name>` |
| Antigravity CLI | `/<skill-name>`                     |

Claude Code の plugin manifest と Codex の plugin package は公式仕様に従います。Agent Skills の core frontmatter を使い、`ui-grill-with-docs` と `pr-screenshots` の明示起動条件は維持しています。Claude Code では `disable-model-invocation: true`、Codex では各 `agents/openai.yaml` の `policy.allow_implicit_invocation: false` を使います。これらの runtime 固有 metadata を core upload validator の成功と混同しません。Antigravity CLI の strict validator による manifest 検証と、manual-only の実効制御は別の確認項目です。

Antigravity App/IDE は[公式 plugin 手順](https://antigravity.google/docs/plugins)に従って配置してください。App/IDE の実機動作は未確認です。

## 依存と対応条件

依存は使う機能の直前にだけ必要です。第三者 skill は公式配布元から runtime の公式手段で別途導入し、この repository へコピーしません。

| Skill                                                                                | 依存・供給元・版                                                                                                                     | 必要になる経路と制約                                                                                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| [`dogfood`](skills/dogfood/references/dependencies.md)                               | Node.js 20+、npm、npm lock 内の Playwright/Core `1.63.0`。OS の Xvfb と `xauth` は headed retry 用のみ（版・導入法は依存詳細を参照） | browser 実行時のみ。WSL2 は Windows Managed Chrome。annotation は別途 Microsoft skill と `@playwright/cli` `0.1.22`               |
| [`domain-modeling-studio`](skills/domain-modeling-studio/references/dependencies.md) | Node.js 20+、Matt Pocock `domain-modeling` plugin `1.3.1`、公式 npm の `@ast-grep/cli`（確認環境で `0.42.1`）                        | model 作成時。Python 3 と `ast-grep` は TypeScript evidence のみ。browser review は任意                                           |
| [`herdr-peer-refactor`](skills/herdr-peer-refactor/references/dependencies.md)       | Herdr CLI（移管時に観測 `0.9.5`）、Git、Python 3.9+、Bash、`jq`、Perl `flock`、OpenSSL、`gh`（外部 skill の pin は依存詳細を参照）   | 専用 auto は Python 3.11+ (`tomllib`)。raw Codex isolation は別途 Nix と対象 flake が必要。通常 peer は専用 auto 前提を要求しない |
| [`marp`](skills/marp/SKILL.md)                                                       | Node.js 18+、公式 npm package [`@marp-team/marp-cli@4.5.1`](https://github.com/marp-team/marp-cli/releases/tag/v4.5.1)               | Marp 変換時。PDF・PowerPoint・画像出力は browser が必要。HTML 出力には不要                                                        |
| [`md-agents-review`](skills/md-agents-review/SKILL.md)                               | 追加 runtime 依存なし                                                                                                                | Codex 向け Markdown のレビュー。Git や network 操作は不要                                                                         |
| [`md-claude-review`](skills/md-claude-review/SKILL.md)                               | Claude Code。Anthropic [`claude-api`](https://github.com/anthropics/skills/tree/main/skills/claude-api) skill は任意で別途導入       | `prompt-audit` 用。revision は固定せず、未導入時は同梱の公式文書を fallback とする                                                |
| [`orca-peer-refactor`](skills/orca-peer-refactor/references/dependencies.md)         | Orca runtime（移管時に観測 `1.4.243`）、Git、Python 3.9+、Bash、`jq`、Perl `flock`、`gh`（外部 skill の pin は依存詳細を参照）       | Orca peer route。GitHub 操作では利用者の `gh` 認証を使う                                                                          |
| [`pr-screenshots`](skills/pr-screenshots/DEPENDENCIES.md)                            | `gh` と通常認証、Node.js 20.19+、package lock 固定 `@playwright/cli` `0.1.22`                                                        | 既存画像の添付には WSL2、mirrored networking、Windows interop、Windows Stable Chrome が必要                                       |
| [`rop`](skills/rop/SKILL.md)                                                         | reference を読むだけなら追加依存なし                                                                                                 | 対象コードの編集・検証では対象 project の指定 runtime を使う                                                                      |
| [`ui-grill-with-docs`](skills/ui-grill-with-docs/references/dependencies.md)         | Matt Pocock の `grilling` と `domain-modeling` skills（外部配布）                                                                    | interview と domain model 作成時。`codebase-design` は設計境界の検討時のみ必要                                                    |
| [`worktree-gc`](skills/worktree-gc/DEPENDENCIES.md)                                  | repo-local は Bash + Git 2.7+。fan-out は Bash 4.0+ と GNU-compatible `readlink -f`                                                  | fan-out `--apply` は Linux/WSL2、読める `/proc`、GNU `stat -c` が必要。macOS は repo-local / preview 用                           |

Node.js は[公式配布元](https://nodejs.org/en/download)から導入します。dogfood、peer-refactor、PR 添付で使う `packages/wsl2-browser` の Node.js 最小版は 20.19 です。固定 npm package は `https://registry.npmjs.org/` を source とし、lock file に tarball URL と integrity を記録します。第三者 license 表示は [domain-modeling-studio の notice](skills/domain-modeling-studio/dist/THIRD-PARTY-LICENSES.txt) と [WSL2 browser notice](packages/wsl2-browser/THIRD_PARTY_NOTICES.md) にあります。各依存の詳細には外部 skill/runtime の公式 source、固定 revision、導入経路を記載しています。

| Host                         | 汎用 skill | 専用経路                                                                                                                                                        |
| ---------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux x86_64 / Linux aarch64 | 対象環境   | raw Codex isolation は Linux + Nix + 対象 repository の flake が必要。worktree-gc fan-out の `--apply` は `/proc` 検査ができる場合だけ                          |
| macOS aarch64                | 対象環境   | worktree-gc repo-local 処理と fan-out preview は可能。fan-out `--apply` は不可。fan-out は Bash 4.0+ を要し、標準 `/bin/bash` 3.2 では動かない                  |
| WSL2                         | 対象環境   | browser 添付では Windows 側の Stable Chrome、mirrored networking、Windows interoperability が必要。raw Codex isolation は Nix と対象 repository の flake も必要 |
| Windows native               | 対象外     | Windows-side Chrome は WSL2 browser route のみで使う                                                                                                            |

raw Codex isolation の準備条件は [raw Codex 隔離手順](docs/raw-codex-isolation.md)、専用 auto の詳細は [auto 保護契約](contracts/auto-peer-protection.md) と [起動手順](skills/herdr-peer-refactor/references/auto-session.md)を参照してください。この表は product support target と専用機能の必要条件を示します。実機確認済みの host と未確認範囲は [verification entrypoint](docs/verification.md) と最終採用記録で分けて示します。実 host の WSL2 確認と Linux 用テスト override は別の証拠で、override を Windows/WSL2 実機試験として扱いません。

## 資源、更新、復旧

各 skill の同梱 reference は、runtime が実際に読み込んだ `SKILL.md` の directory を起点に解決します。old home path、dotfiles checkout、current working directory から resource root を推測しません。補助 CLI は package root 内の実体を絶対 path で呼び出します。browser runtime、依存 cache、作業成果物は plugin checkout の外に置きます。

更新時は旧 checkout を保持したまま、別 directory に新しい full-SHA checkout を用意します。三つの manifest と `package.json` の version が一致することを確認し、対象 runtime の公式 plugin 操作から新 checkout を指定します。導入済み cache の version・source path・skill/resource content hash をその checkout と照合し、同じ version の別 payload、旧 cache、異なる導入元は受入れません。確認が終わるまでは旧 checkout を保持し、不一致や失敗があれば公式 plugin 操作で旧 checkout を再指定します。runtime の cache を手で編集しません。

この plugin の license は [MIT](LICENSE) です。第三者 skill の本文は同梱しません。

## 検証入口

開発には Node.js 20.19+、npm、Python 3、Bats Core 1.x、`jq` が必要です。`npm run lint` には Antigravity CLI `agy` と Claude Code CLI `claude` も必要です。`npm run format:check` の対象は配布 metadata、README、verification entrypoint、worktree-gc の変更文書です。移管済み全 skill source の一括 reformat 結果を示すものではありません。

```sh
npm ci --prefix development
npm run format:check
npm test
npm run lint
```

`npm test` は Python suite、dogfood・domain-modeling-studio・WSL2 browser package の nested Node suite、dogfood・WSL2 browser package・raw-Codex の Bats fixture を実行します。実 browser を使う dogfood / WSL2 browser suite は通常テストに含めません。`npm run test:plugin-cli` は Claude Code、Codex、Antigravity CLI がすべて必要な隔離 HOME での公式導入 smoke test です。CLI が不足する必須実行では skip を成功と扱わず、[検証記録](docs/verification.md)へ未確認として残します。公式実 session の11 skill × 3 runtime の証跡と最終 version/source SHA/hash は plugin 外の採用記録に保管し、この README に自己参照として埋め込みません。

## 公式仕様と配布元

- [Agent Skills specification](https://agentskills.io/specification)
- [Codex plugin packages and marketplace source forms](https://developers.openai.com/plugins/build/plugins) / [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [Claude Code plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) / [plugin manifests](https://code.claude.com/docs/en/plugins/manifest-reference) / [skills](https://code.claude.com/docs/en/skills)
- [Antigravity CLI plugin install source forms](https://antigravity.google/docs/plugins?tab=cli)
- [Matt Pocock skills](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336)
- [Microsoft Playwright CLI skill](https://github.com/microsoft/playwright-cli)
