# 専用 auto peer の保護契約

この契約は、専用の auto peer 起動経路にだけ適用する。通常 session から明示依頼された read-only peer 協働は [autonomous peer 契約](autonomous-peer-contract.md) に従い、ここに記載した専用 home、資格情報、事前確認を要求しない。専用 auto の preflight が失敗したとき、通常 session や別 profile へ自動で切り替えない。

## 正本と配布物

- [`skills/herdr-peer-refactor/assets/auto-peer/auto-peer.rules`](../skills/herdr-peer-refactor/assets/auto-peer/auto-peer.rules) の `peer_deny` が deny ルールの正本である。
- `auto-peer-deny.json` は Claude の `permissions.deny` 断片、`claude-peer.settings.json` は隔離・deny を含む専用 Claude profile、`codex-peer.config.toml` は専用 Codex profile である。
- 同じ directory の `read-only-attestation.example.json` は人が記入するための例で、資格情報の値は含まない。人が置く認証設定・read-only 資格情報は package に含めない。
- 準備・起動入口は `scripts/auto-peer-preflight.py`、`scripts/launch-child.sh`、`scripts/codex-auto-peer.sh` である。第三者 skill は別途公式配布元から用意し、package にコピーしない。

## 人が準備するもの

既存設定を上書きせず、専用 home を人が作り、mode `0700` にする。

- Claude: `$HOME/.claude-peer/auto-peer-settings.json` に `claude-peer.settings.json` を配置し、`CLAUDE_CONFIG_DIR` を `$HOME/.claude-peer` に向けて、その home 専用の認証を用意する。
- Codex: `$HOME/.codex-peer/config.toml` と `$HOME/.codex-peer/rules/auto-peer.rules` に対応する配布資源を置く。`rules/` と `$HOME/.codex-peer/gh` は mode `0700`、設定と rule は人が所有し group/other から書けない状態にする。`GH_CONFIG_DIR` は `$HOME/.codex-peer/gh` に向け、そこに repo 限定 fine-grained token の `hosts.yml` を人が用意する。
- Codex: `auto-peer-read-only-attestation.json` は例を基に人が記入する。対象 repository、認証方式、`contents`, `issues`, `metadata`, `pull_requests` の read-only 権限、確認者・有効化者、実日付を記録する。preflight は GitHub CLI の active authentication と repository identity も確かめるが、GitHub token の権限内容を人の確認に代わって読み出さない。

設定の自動配置、認証、資格情報の取得・表示・複製、自動有効化は行わない。資格情報を準備できない場合や、人が read-only 範囲を確認していない場合は実行を保留する。

## 実効性を確かめて起動する

起動前に、mode `0700` の一時 directory を `/tmp/codex` 配下に作って receipt の保存先にする。Claude は Claude Code の専用 home 認証を、Codex は Codex と GitHub CLI の専用 home 認証および repository identity を確認した後、active runtime の canary を行う。各起動 wrapper は 24 時間以内の receipt、runtime binary、profile/rules の hash を再照合し、canary をもう一度実行してから session を開始する。

認証値を含む host の ambient environment は最終 peer へ渡さない。Codex guard は `verify_codex` が確認した `child_environment` と専用 `CODEX_HOME` / `GH_CONFIG_DIR` を使って bundled reviewer を exec する。Claude は起動直前の `verify` が hash 検証した physical CLI path を child script の引数で渡して実行し、子の `PATH` にある別の `claude` で置き換わらないようにする。Claude child は対象 pane の shell 内で allowlist を組み、`env -i` で非credential runtime/terminal variables、専用 `CLAUDE_CONFIG_DIR`、その子 pane 自身の Herdr context だけを継承する。親 pane の ID や socket をコピーせず、token/key/auth/secret/provider selector などの host 変数は除く。

```bash
run_dir="$(mktemp -d /tmp/codex/auto-peer.XXXXXX)"
skill_dir="/absolute/path/to/herdr-peer-refactor"

CLAUDE_CONFIG_DIR="$HOME/.claude-peer" \
  python3 -B "$skill_dir/scripts/auto-peer-preflight.py" claude \
    --settings "$HOME/.claude-peer/auto-peer-settings.json" \
    --receipt "$run_dir/claude-preflight.json"

CODEX_HOME="$HOME/.codex-peer" GH_CONFIG_DIR="$HOME/.codex-peer/gh" \
  python3 -B "$skill_dir/scripts/auto-peer-preflight.py" codex \
    --repository owner/name \
    --receipt "$run_dir/codex-preflight.json"
```

Herdr child は必ず `scripts/launch-child.sh <run-dir> <parent-pane> <worktree> <child-id> <limit> <receipt> <settings>` を使う。この入口は preflight の前に workspace / pane を作らず、Claude の専用 home と `--settings` を明示する。Codex auto peer は `scripts/codex-auto-peer.sh <owner/repo> <receipt> -- <prompt>` を使う。この入口は共用 `bin/codex-reviewer --peer` を通し、専用 home の preflight が失敗したら Codex session を起動しない。直接 CLI を起動して preflight を迂回しない。

## Canary が示すこと

Claude preflight は実 Claude CLI の `--settings` 付き session を使う。deny を除いた一時 control では無害な probe の許可と workspace 外の設定ファイルを読めないことを確認し、配布 profile では policy probe と raw `git push` の permission denial を確認する。sandbox を使えない場合は失敗する。CLI の auth status は専用 config directory と認証方式だけを確認し、その出力や秘密値を記録しない。

Codex preflight は、まず公式 `codex execpolicy check --rules` で配布 rule 内の deny command を評価する。実効 canary は、profile と rule の hash を検証した上で、実際の専用 home から資格情報のない一時 `HOME` / `CODEX_HOME` へ同じ config/rule だけを複写して実 Codex CLI を起動する。一時 home の GH 設定 directory は空にする。model provider は loopback のみの fixture とし、`Authorization` header があれば拒否する。Git read/write/raw-push の検査は `$HOME` 配下の使い捨て linked worktree で行う。実際の linked Git dir と common dir に対して `bin/codex-reviewer` と同じ read-only `-c permissions.dotfiles-peer.filesystem={...}` を加え、Git status が成功し、workspace write が拒否され、raw push が Codex runtime の policy で拒否され、fake Git marker に到達しないことを確かめる。実際の対象 repository に canary file、nonce、commit、push は作らない。

これらの canary は runtime が実際に拒否した証拠である。一方、mock CLI test は guard の分岐だけを検証し、実 runtime の証拠ではない。Codex canary によって資格情報の read-only scope や認証の有効性を証明したとは扱わない。Claude の実 auth/API と Codex/GitHub の実 auth は、利用者の専用 home を人が準備した後に preflight が確認する。

## 通常協働との境界

通常の明示 peer 協働は専用 auto preflight と無関係に利用できる。通常 Codex peer の `bin/codex-reviewer --peer` は通常の `dotfiles-peer` 起動 profile であり、専用 auto home や専用 credential があることを意味しない。専用 auto を選ぶ場合だけこの契約の preflight wrapper を通す。保護が確認できないときは専用 auto を保留し、人へ条件を報告する。

専用 auto として検証する起動入口は Claude Code と Codex である。Orca の Yolo / auto worker にはこの package の Claude deny や Codex profile を適用できる証拠がなく、専用 auto として起動しない。これは通常の明示 Orca read-only peer 協働を禁止するものではない。
