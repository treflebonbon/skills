# 専用 auto session の追加保護

> この移管資料は追加保護の設計経緯を残す参考資料です。必要な専用起動ゲート、隔離設定、実効保護の検証を package として提供するものではありません。専用 auto を実行済み・有効と扱わず、完成条件は専用 ticket の実装と検証を参照してください。通常の明示 peer 協働にはこの資料の gate を適用しません。
>
> この下の `dotfiles-peer`、`dotfiles-secure`、`private_dot_config`、`~/.codex-peer` などは移管元 dotfiles 環境の設定名・path です。この package はそれらを配置も有効化もしません。利用対象 repo の現在の設定や専用 auto の保護として扱わないでください。

通常の明示依頼からの peer 協働には、この起動ゲートを適用しない。専用 auto session を選んだ場合だけ以下を確認する。設定の存在は適用の証拠ではない。専用起動前に配備済み `permissions.deny`／rules の内容を read-only で確認し、空・不正・必要な拒否規則がない場合は保留する。権限設定を変更して通過させない。

## auto session の識別と merge deny

merge の禁止は文書だけでなく permission の deny でも強制する。deny は Claude と Codex の標準の permission 機能だけで実現し、独自の検証層（確認結果の記録表、版と設定の識別の照合）は持たない（ADR-0075）。deny は auto session 限定で `gh pr merge` などの merge の形を拒否し、通常 session の承認済み merge は妨げない。

deny は、列挙した形に対するパターン照合で、merge の権限そのものの保証ではない。codex 経路で資格情報の側から止める方法は、codex peer の資格情報の節に書く。

| 項目 | 内容 |
| --- | --- |
| deny の実体（Claude） | `~/.claude/auto-peer-deny.json`（`permissions.deny` の断片）。auto session は `claude --permission-mode auto --settings ~/.claude/auto-peer-deny.json` で起動する |
| deny の実体（Codex） | 専用 `CODEX_HOME` の `rules/auto-peer.rules`（`forbidden`）と、`dotfiles-peer` の permission profile。専用 home には人が置く（認証も人） |
| auto session の識別 | 専用起動の指定は、自分の `claude` プロセスの引数に `--settings` と断片のパスが含まれることで観測する。これは runtime の実効 deny の確認ではない（`ps -o args= -p <pid>`。Linux と macOS で共通）。環境変数は使わない。断片が無ければ通常 session |
| 起動チェック | 次を確認し、成り立たなければ auto を開始せず人へ戻す。設定内容・起動経路と runtime の実効 deny を確認し、引数の観測だけを適用の証拠にしない。適用が確認できない場合は専用 auto の起動を保留する。通常の明示協働へ自動で切り替えない。断片があるのに Run Scope などのゲートが通らない session は、auto の失敗として人へ戻す。deny を適用できない runtime（Orca Yolo など）では開始しない |

### codex peer の資格情報

codex の peer は GitHub に書き込まないので、書込み権限のない資格情報で起動する。codex は、並行実行の前提ではなく、後から加える強化である（ADR-0075）。

- 資格情報: repo 限定の read-only の fine-grained token を、専用の gh 設定先 `~/.codex-peer/gh`（`GH_CONFIG_DIR`）に置く。人が発行して置く。
- 隔離: peer は `dotfiles-peer` profile（`private_dot_config/codex/config.toml.tmpl`）で起動する。`dotfiles-secure` から、書込み可能な資格情報がある `~/.config/gh` の読取りを外し、`~/.codex-peer/gh` だけを読む。
- 別の認証経路: 管理設定は GitHub App を `approve` で有効にしている（`[apps.github]`）。peer では `--disable apps` で App 全体を無効にし、`gh` の read-only の資格情報を唯一の GitHub 認証にする。
- 起動: 専用 auto 経路はこの package では実装・検証していません。人が用意する専用 home、認証、rules、profile と、その実効性の検証条件を完了するまで実行しないでください。通常の明示協働で Codex reviewer を使う場合は、[共用 CLI](../../../docs/shared-cli.md) の `bin/codex-reviewer` を読み、選択済み profile と実際の権限を確認します。
- 使う条件: 専用 home、`rules/auto-peer.rules`、read-only の資格情報を人が用意し、この参照の「有効化」の表の行を人が「有効」に更新したときだけ使う。それまでは未有効の規則で、実行せず、報告に未実行の項目と有効化の手順を書く。実測は任意で、済んでいなくても使えるが、rules が覆うのは列挙した形だけで、`sh -c` や `env` の前置きは実行できる。

## 起動と既存 helper

`launch-child.sh` と `plan-parallel.sh` は専用 auto 起動の追加保護として維持する。前者は子自身の `--settings` 引数と cwd、親停止、上限を検査する。引数の観測だけでは runtime が拒否規則を有効にした証明にならず、実効性が確認不能なら保留する。後者はファイル単位の保守的な選定であり、通常の明示協働で別 hunk を並行改善する手順には使わない。`agent start` の設定転送を適用証拠にせず、専用 auto は pane の shell から `claude --permission-mode auto --settings ~/.claude/auto-peer-deny.json` で起動する。Claude の background process しか観測できず適用が確認できない場合、その専用 auto 起動は保留する。

Codex 専用 auto peer は未有効のまま。専用資格情報・rules・profile の準備と有効化が済むまでは使わない。この制限は通常の明示依頼で native Codex を read-only reviewer として使うことを禁止しない。

### 専用 auto の並行 helper

親 1・子 N・peer N+1 の live-agent 上限は 2N+2。`plan-parallel.sh <limit> <records.tsv>` はファイル単位の保守的選定、`launch-child.sh <run-dir> <parent-pane> <worktree> <candidate-id> <limit>` は子ごとに専用 workspace（`herdr workspace create`）を作り、その root pane で起動して `herdr pane process-info` で子自身の `--settings` 引数と cwd を確認する。実行中の pane は `pane move` で移さない（pane ID が変わる）。`<parent-pane>` は互換のため受け取るが分割には使わない。mock 起動テストはこの観測の検査であり、実効 deny の検証ではない。確認できない子には依頼を送らない。親が止まったら `<run dir>/stopped` を記録し、新規子を起動しない。公開前は `check-owned.sh <child worktree> <base> <owned-files>` で実差分を照合する。base は開始時に確定した値を使い、main を取り込んだ後は新しい main の SHA に替えて範囲付きの宣言を読み替える(SKILL.md の「worktree と担当」)。

### 有効化

| 任意の追加保護                                  | 状態   |
| ----------------------------------------------- | ------ |
| Codex 専用 auto peer の起動・read-only 資格情報 | 未有効 |

設定の作成・有効化は人が行う。通常の native reviewer を専用 auto peer と報告しない。
