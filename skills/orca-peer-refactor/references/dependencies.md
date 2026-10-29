# Orca route dependencies

この手順は package 内の helper を使いますが、Orca application、native CLI、Orca agent skill は含みません。必要な依存だけ別途導入し、外部 skill はこの package へコピーしないでください。

## 別途用意するもの

| 役割 | 依存・供給元 | 版の扱い |
| --- | --- | --- |
| Orca CLI の起動規則 | [`orca-cli` skill](https://github.com/stablyai/orca/tree/aedb9305cd1b3de859b5eafc1ee0d77fa0df8963/skills/orca-cli) | 元 dotfiles の lock は commit `aedb9305cd1b3de859b5eafc1ee0d77fa0df8963` を固定。使用前にロード済み skill の選択規則を読む |
| Native orchestration | [`orchestration` skill](https://github.com/stablyai/orca/tree/de93f326eaff6157bc5be4cceafb0bec19810d65/skills/orchestration) | 元 dotfiles の lock は commit `de93f326eaff6157bc5be4cceafb0bec19810d65` を固定。使用中 CLI と同じ版の guide を確認する |
| Orca runtime | Orca application が提供する `orca` / `orca-ide` / `orca-dev` | 起動規則で選んだ一つを使い続ける。移管時に観測した `orca-ide` は `1.4.243` |
| 設計・実装・review・PR の skill | [`mattpocock/skills`](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336) の `codebase-design`, `tdd`, `code-review`, `pr`。複数 session にまたがる設計時だけ `to-spec`, `to-tickets` も使う | 元 dotfiles の lock は commit `49dd158d1076134a641b33efb035946536778336`、plugin version `1.3.1`。使う skill は個別に導入する |
| 人間との設計質問 | 同じ [`mattpocock/skills`](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336) の `grilling` | 人の回答を待つ既存契約を保つため、peer の回答を得る用途では呼び出さない |
| Orca send helper と共用 GitHub CLI | package root の `bin/` | [共用 CLI](../../../docs/shared-cli.md) を参照。`orca-send` の `--cli` にはこの session で選択済みの Orca command を渡す |
| HTML report の実描画検査（任意） | package の [WSL2 browser package](../../../packages/wsl2-browser/USAGE.md) | WSL2、Node.js 20.19 以上などの条件が満たされる場合だけ利用する。Playwright CLI 本体は package の外へ cache される |

Orca preflight helper には Python 3.9 以上と Git が必要です。証跡 helper と GitHub comment helper には Bash、`jq`、`perl` の `flock` が必要です。native orchestration の操作は選択した Orca CLI 自身が行います。GitHub 用の操作では GitHub CLI `gh` と利用者の認証設定を使います。package は Orca/agent runtime、認証情報、外部 skill を配布しません。Orca route は tmux と OpenSSL を直接呼び出さず、その runtime の起動条件を優先します。

移管時に観測した共通 toolchain は [Git](https://git-scm.com/) `2.55.0`、[Python](https://www.python.org/) `3.14.7`、[GitHub CLI](https://github.com/cli/cli) `2.102.0`、[jq](https://github.com/jqlang/jq) `1.8.2`、[Perl](https://www.perl.org/) `5.38.2`、[OpenSSL](https://github.com/openssl/openssl) `3.0.13` でした。`orca-ide` `1.4.243` も同環境で観測しました。

HTML checker は Agent Skill を呼ばず、package wrapper を通して [npm の `@playwright/cli`](https://www.npmjs.com/package/@playwright/cli/v/0.1.22) `0.1.22` を使用します。lock は `playwright` / `playwright-core` `1.64.0-alpha-1790635538000` も固定します。移管時の Node.js `24.22.1` / npm `11.19.1` は観測値で、browser package が明示する Node.js 下限は `20.19` です。上記の観測値は互換性保証や推奨 pin ではなく、API の仕様は選択した native CLI と同じ版の外部 guide を確認します。
