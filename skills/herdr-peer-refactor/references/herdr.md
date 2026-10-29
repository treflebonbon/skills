# Herdr の native 協働

別途導入した [`herdr` skill と runtime](dependencies.md) を読み、`HERDR_ENV=1` と現在の pane を確認する。実行中 CLI の help と作成応答から ID を取得し、予測した ID や bare `herdr` は使わない。

package root はロード済み skill の位置から解決する。共用 helper は package root 内の絶対 path を使い、`PATH` や cwd から別 install を推測しない。

```bash
herdr --help
herdr worktree create --cwd <repo> --branch <topic> --base <base> --label <candidate-id> --no-focus
herdr pane split <returned-pane-id> --direction right --cwd <worktree> --no-focus   # peer 用
herdr workspace create --cwd <worktree> --label <candidate-id> --no-focus   # 並列子 session 用。起動応答の `.result.root_pane.pane_id` を使う
plugin_root="$(cd "$skill_dir/../.." && pwd)"
reviewer_command="$(printf '%q' "$plugin_root/bin/codex-reviewer") --peer"
herdr pane run <new-pane-id> "$reviewer_command"   # Codex peer。shell prompt の pane で起動する
herdr agent rename <new-pane-id> <unique-name>   # 検出後
herdr agent get <unique-name>
```

writer と reviewer の cwd・役割・モデルを起動応答と実 process で確認する。`agent_pane_busy` が出たら `pane read <pane-id>` と `pane process-info --pane <pane-id>` で foreground を調べる。agent や別 command がいない対話 shell prompt と確認できた場合だけ、`herdr pane run <pane-id> '<native-agent-command>'` で起動して検出を待つ。稼働中 process を置換しない。

起動前に `herdr pane current --current` で、継承された `HERDR_PANE_ID` が自分の pane（cwd と agent）かを確認する。別 workspace や別 cwd の pane を指す場合（dashboard から起動された background session など）は、`--current` で分割せず、他者の pane を読まず操作せず、peer 起動前に保留する。Claude の writer・親は pane の shell から `claude '<prompt>'` のように prompt を引数で渡して対話 session として起動する。引数なしの `claude` は利用者の設定や現在の CLI により dashboard を開くことがある。dashboard が開いた場合、`agent prompt` は同じ session の background job であり、別 writer を起動せず、session ID を確認して attach する。起動後は `pane current --current` と `pane process-info` で実際の pane・cwd を確認する。

`pane run` で起動した agent は名前を持たない。検出後に `herdr agent rename <pane-id> <name>` するか、pane ID を宛先にする。起動した model と effort は、要求した引数と実 process までを確認し、実効値を取得できなければ「未確認」と記録する。Codex peer は `herdr agent start --kind codex` で起動しない。worktree を cwd にした pane の shell から `"$plugin_root/bin/codex-reviewer" --peer` で起動し、対象 worktree の Git 管理情報を read で使えるようにする（詳しくは [共用 CLI](../../../docs/shared-cli.md) を読む）。それでも peer から Git が読めない（`not a git repository`）場合は、起動経路と `codex-reviewer` のエラーを確認する。peer の権限は広げず、native checkout の状態は親が確認して、peer 側の未確認として報告に残す。

peer-dir と request-file は親と peer の両方から読書きできる Git 管理外の共有ディレクトリの絶対パスで渡す。`/tmp/codex` 配下の run directory に要件・候補と返信先を置く。証跡は [保存と復旧](evidence.md) に従って checkpoint を作る。原本の record は保持し、コピー元と内容を照合する。各依頼に `REQ-<n>` と対象 SHA を付け、共有ディレクトリの `REQ-<n>.md` の一行目を `DONE REQ-<n> <sha>` にする。`<sha>` は依頼の対象 SHA で、writer では依頼時の base SHA とし、最終 commit の SHA は本文の先頭行に書かせる(最終 SHA は依頼時に未確定で、`peer-request.sh` は一行目の SHA だけを照合する)。peer は本文に反例または自分の検証コマンド・結果を書く。peer の sandbox が共有ディレクトリに書けないときは端末に `DONE REQ-<n> <sha> <nonce>` 行・本文・`END REQ-<n> <nonce>` 行で答えさせる（nonce は依頼文に `peer-request.sh` が試行ごとに入れる）。`peer-request.sh` がこの完全な block だけを検査して `REQ-<n>.md` に保存する。peer の権限は広げず、端末を読めない、または保存できない場合は保留する。依頼本文はファイルに保存し、run ID は最初に `date -u +%Y%m%dT%H%M%SZ` と `openssl rand -hex 4` から一度生成する。

並行する peer(reviewer など)は、依頼ごとに別の peer-dir を使う。`peer-request.sh` は peer-dir ごとに 1 本だけ動き、同じ dir の 2 本目は exit 15 で保留される。

## 公開入力の readiness

設計依頼の前に、起動後の同じ peer へ短い read-only の readiness 依頼を送る。親は依頼 ID・対象 SHA・cwd・record fingerprint を固定し、`openssl rand -hex 16` で試行ごとの公開 nonce を作る。新しい receipt の絶対パスを `/tmp/codex` の今回の run directory 内に指定し、[公開入力の probe](evidence.md#公開入力の-probe) のコマンドを具体的な値で渡す。peer は権限を変更せず、自分の通常の shell tool で実行する。

親は応答と receipt を読み、次の全条件を満たしてから設計依頼へ進む。

- 今回の依頼 ID と対象 SHA の応答があり、probe の実行と終了を確認できる。
- receipt は完全な JSON で、version は1、nonce・fingerprint・実 HEAD・cwd が依頼値と一致する。
- 実行コマンドは指定した skill の `candidate-record.py check` と元の record・候補・fingerprint を指し、終了コードは0である。

receipt がない、不完全、不一致、または非0なら readiness 未完了とし、設計へ進まない。tool 実行前の peer の判断は「未実行」と記録し、実際の tool 拒否とは区別する。実行済みの失敗は receipt と観測したエラーの要約を残す。親側の sandbox 成功だけを peer の成功にせず、既存の再照会・保留規則と待機台帳を引き継ぐ。採用した receipt は checkpoint と独立レビューへの入力に含める。

## 依頼と応答

```bash
bash <skill-dir>/scripts/peer-request.sh <peer> REQ-<n> <sha> <peer-dir> <request-file> [<round>]
```

同じ peer dir の run-id、累積待機、round、失敗履歴を後継にも引き継ぐ。helper が返す応答ファイルを読み、terminal の依頼 echo を結果として採用しない。exit 10 は個別 timeout、11 は blocked、12 は一回だけ再照会可能な失敗、13 は同種失敗 2 回、14 は予算、15 は状態不明。12 でも再送前に pane と成果物を確認する。10 の後は元 writer が working でないことと未 commit 差分が安定したことを確認できた場合だけ後継を起動する。11・13・14・15 は保留。

Claude が background dashboard に戻った場合、session ID と process を確認して同じ session に attach する。別 session の重複 writer を作らない。応答の ID／SHA と検証がない限り完了にはしない。検証できない状態は保存して報告する。

Git は worktree の cwd で使う。直接の `git -C` は deny で拒否される起動経路があるため指示しない。reviewer から `.git` の参照先が読めなければ primary repo の read-only pane に同じ対象 SHA を渡す。
