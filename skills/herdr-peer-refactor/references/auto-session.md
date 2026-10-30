# 専用 auto session の準備と起動

専用 auto の保護は [保護契約](../../../contracts/auto-peer-protection.md) が正本である。通常 session から明示依頼された peer 協働はこの起動 gate の対象外で、専用 auto が未準備でも通常経路を拒否しない。逆に、専用 auto が保護確認に失敗したとき通常 profile へ切り替えて続行しない。

この package は、元候補の固定、read-only peer、独立 review、merge を行わない条件を [通常 peer 契約](../../../contracts/autonomous-peer-contract.md) から引き継ぐ。専用 auto はそれらの契約を変えず、専用 home・実効 permission・credential の追加条件を満たした場合だけ起動する。

実効保護を検証する専用起動入口は Claude Code と Codex である。Orca Yolo / auto worker にはこの package の Claude deny と Codex permission profile を結び付ける入口がなく、専用 auto として起動しない。通常 session の明示 Orca read-only peer は引き続き [Orca 手順](../../orca-peer-refactor/references/orca.md) を使う。

## 正本と人による準備

[`assets/auto-peer/auto-peer.rules`](../assets/auto-peer/auto-peer.rules) の `peer_deny` が拒否規則の正本である。同じ directory の `auto-peer-deny.json` は Claude の deny 投影、`claude-peer.settings.json` は Claude 専用 profile、`codex-peer.config.toml` は Codex 専用 profile である。資格情報の値や live runtime 設定は配布しない。

人が既存設定を上書きせず専用 home を用意する。

- Claude は `$HOME/.claude-peer` を mode `0700` にし、`claude-peer.settings.json` を `auto-peer-settings.json` として配置する。Claude の認証は `CLAUDE_CONFIG_DIR=$HOME/.claude-peer` を指定して、その専用 home に人が準備する。
- Codex は `$HOME/.codex-peer` と `rules/` を mode `0700` にし、`codex-peer.config.toml` と `auto-peer.rules` を配置する。`$HOME/.codex-peer/gh` も mode `0700` にして `GH_CONFIG_DIR` に指定し、そこへ repository 限定 fine-grained token を人が用意する。
- Codex の `auto-peer-read-only-attestation.json` は `read-only-attestation.example.json` を基に人が記入する。対象 repo と read-only 権限、確認者・有効化者、実日付を記録する。CLI status と repo identity は別途照合されるが、権限内容を確認したという attestation の代わりにはならない。

設定ファイルの存在、起動 argv、rule evaluator の結果だけでは、runtime が実際に権限を適用した証拠にならない。認証がない、専用 home が違う、profile/rules が一致しない、canary が失敗する場合は専用 auto を保留する。保護を弱めて通過させない。

## Preflight と起動

receipt 用に `/tmp/codex` 配下で private run directory を作る。`skill_dir` はロードされた `SKILL.md` の絶対 path の親にする。

```bash
: "${skill_dir:?現在の skill directory を指定してください}"
run_dir="$(mktemp -d /tmp/codex/auto-peer.XXXXXX)"

CLAUDE_CONFIG_DIR="$HOME/.claude-peer" \
  python3 -B "$skill_dir/scripts/auto-peer-preflight.py" claude \
    --settings "$HOME/.claude-peer/auto-peer-settings.json" \
    --receipt "$run_dir/claude-preflight.json"

CODEX_HOME="$HOME/.codex-peer" GH_CONFIG_DIR="$HOME/.codex-peer/gh" \
  python3 -B "$skill_dir/scripts/auto-peer-preflight.py" codex \
    --repository owner/name \
    --receipt "$run_dir/codex-preflight.json"
```

Claude の Herdr child は次の入口だけで開始する。

```bash
bash "$skill_dir/scripts/launch-child.sh" \
  "$run_dir" "$parent_pane" "$worktree" "$child_id" "$limit" \
  "$run_dir/claude-preflight.json" "$HOME/.claude-peer/auto-peer-settings.json"
```

この入口は起動直前にも receipt、専用 home 認証、CLI identity、settings hash、実効 canary を再確認する。確認が通る前に pane / workspace を作らず、child にも専用 `CLAUDE_CONFIG_DIR` と `--settings` を渡す。`herdr agent start` の設定転送を active policy の証拠には使わない。

Codex の専用 auto peer は次の入口を使う。

```bash
bash "$skill_dir/scripts/codex-auto-peer.sh" owner/name \
  "$run_dir/codex-preflight.json" -- "<review prompt>"
```

この入口は receipt、専用 `CODEX_HOME` と `GH_CONFIG_DIR`、GitHub auth status、repository identity、config/rules/attestation hash、公式 `execpolicy check`、実 session canary を起動直前に再検証してから、共有 `bin/codex-reviewer --peer --disable apps` へ渡す。失敗時は Codex session を開始しない。通常の read-only reviewer は従来どおり `bin/codex-reviewer --peer` から使え、専用 auto receipt を要求しない。

## Canary の範囲と限界

Claude は専用 settings を使った実 CLI session で no-deny control と configured deny を比較する。no-deny control の無害な probe が実行され、workspace 外にある settings を読めないことを確認する。専用 settings では policy probe と raw push の実 permission denial が返ることを確認する。sandbox unavailable や拒否不足は fail closed となる。Claude の preflight と起動直前の verify はそれぞれ2回の authenticated API canary を行い、各 invocation は `--max-budget-usd 0.02` を指定する。この上限の実動での妥当性・十分性は未検証であり、budget で完了しない場合は保留する。実際の Claude auth/API canary はこの package の統合検証では実行していない。

Codex は実 CLI sessionへ loopback-only model fixture を使う。canary 用の `HOME` / `CODEX_HOME` は、実際の専用 home から検証済み config と rules だけを複写した一時 home で、資格情報は含めず、GH directory は空にする。loopback server は request body の tool output だけを使い、header/body/prompt を出力せず、`Authorization` header があれば失敗する。workspace write と raw push は使い捨て linked Git worktree と fake Git で確認する。CLI が実際に付ける linked worktree の Git dir/common dir override を適用して `git status --short` の成功も見る。実対象 repo に nonce、file、commit、push は作らない。

Canary が確認するのは Codex filesystem と deny rule の active CLI enforcement であり、GitHub credential の scope ではない。Codex auth status、GitHub CLI の active auth/repository identity、read-only attestation は別々に検査する。mock テストは拒否時の分岐検証であり、実 runtime の証拠とは区別する。実 credential が未準備なら preflight は通らない。

## 子の上限と担当

`plan-parallel.sh <limit> <records.tsv>` は、共有するファイル所有を見て保守的に並行候補を選ぶ。`launch-child.sh` は子ごとに `herdr workspace create --cwd <worktree>` で workspace を作り、親 1・子 N・peer N+1 の live-agent 上限 `2N+2` を守る。子起動後は `herdr pane process-info` の foreground argv と cwd を確認する。process-info は preflight 後の起動経路の観測であり、permission enforcement は canary が別途確認する。

親が停止を記録したら新しい child を開始しない。peer は read-only とし、候補固定と公開証跡を保持する。確認不能・設定不一致・依存不足・累積待機超過では pane、worktree、成果物を保持して保留する。
