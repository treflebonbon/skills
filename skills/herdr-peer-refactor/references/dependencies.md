# Herdr route dependencies

この手順は package 内の helper を使いますが、Herdr runtime、agent CLI、関連 skill は含みません。必要な依存だけ別途導入し、外部 skill はこの package へコピーしないでください。

## 別途用意するもの

| 役割 | 依存・供給元 | 版の扱い |
| --- | --- | --- |
| Herdr の使い方 | [`herdr` skill](https://github.com/herdrdev/herdr/tree/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/skills/herdr) | 元 dotfiles の lock は commit `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01` を固定。実行時はロード済み skill の guide を確認する |
| Herdr runtime | [`herdrdev/herdr`](https://github.com/herdrdev/herdr) の公式配布と[公式 Quick start](https://herdr.dev/docs/quick-start/) | native CLI の `--help` と応答を正本とする。移管時に観測した CLI は `0.9.5` |
| 設計・実装・review・PR の skill | [`mattpocock/skills`](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336) の `codebase-design`, `tdd`, `code-review`, `pr`。複数 session にまたがる設計時だけ `to-spec`, `to-tickets` も使う | 元 dotfiles の lock は commit `49dd158d1076134a641b33efb035946536778336`、plugin version `1.3.1`。使う skill は個別に導入する |
| 人間との設計質問 | 同じ [`mattpocock/skills`](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336) の `grilling` | 人の回答を待つ既存契約を保つため、peer の回答を得る用途では呼び出さない |
| Agent runtime | 利用者が選んだ Claude Code または Codex CLI | この package は agent runtime や認証情報を配布しない。実効モデル・effort が確認できなければ未確認と報告する |
| Git 操作 helper | package root の `bin/` | [共用 CLI](../../../docs/shared-cli.md) を参照。必要なコマンドがない場合は開始しない |
| HTML report の実描画検査（任意） | package の [WSL2 browser package](../../../packages/wsl2-browser/USAGE.md) | WSL2、Node.js 20.19 以上などの条件が満たされる場合だけ利用する。Playwright CLI 本体は package の外へ cache される |

Herdr 手順の script helper には Bash、Git、Python 3.9 以上、`jq`、`perl` の `flock`、OpenSSL、標準の POSIX command が必要です。実際の native runtime や GitHub 操作を行う前に、現在の command が利用可能か確認してください。必要な `gh` 操作は GitHub CLI の利用者設定を使います。

移管時に観測した共通 toolchain は [Git](https://git-scm.com/) `2.55.0`、[Python](https://www.python.org/) `3.14.7`、[GitHub CLI](https://github.com/cli/cli) `2.102.0`、[jq](https://github.com/jqlang/jq) `1.8.2`、[Perl](https://www.perl.org/) `5.38.2`、[OpenSSL](https://github.com/openssl/openssl) `3.0.13` でした。Herdr `0.9.5` と [tmux](https://github.com/tmux/tmux) `3.7b` も同環境で観測しました。peer skill の helper は tmux を直接起動しません。tmux は Herdr runtime の選択済み配布手順が要求する場合だけ host 側に用意します。

HTML checker は Agent Skill を呼ばず、package wrapper を通して [npm の `@playwright/cli`](https://www.npmjs.com/package/@playwright/cli/v/0.1.22) `0.1.22` を使用します。lock は `playwright` / `playwright-core` `1.64.0-alpha-1790635538000` も固定します。移管時の Node.js `24.22.1` / npm `11.19.1` は観測値で、browser package が明示する Node.js 下限は `20.19` です。上記の観測値は互換性保証や推奨 pin ではなく、CLI API は選択した native CLI と同じ版の外部 guide を確認します。
