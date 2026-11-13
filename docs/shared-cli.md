# 共用 CLI と Git context

この package は、共用 CLI と Git metadata の読取りを所有する。実装は `bin/`、`lib/bun/` と `lib/python/treflebonbon_skills/` にあり、dotfiles や Nix の checkout は参照しない。

## package 内のパス

`bin/` が runtime の `PATH` に入ることを前提にしない。skill から呼び出す場合は、実際に読み込まれた `SKILL.md` の絶対パスを解決し、標準配置 `skills/<name>/SKILL.md` の package root を `Path(skill_path).resolve().parents[2]` で求めてから、`<package root>/bin/<command>` を絶対パスで実行する。カレントディレクトリ、旧 `~/.agents/skills/`、dotfiles checkout から root を推定しない。

Python の共用 module を使う package 内の実装は、読み込まれた実体の位置から `lib/python` を絶対パスで追加して import する。`codex-reviewer` はこの方法を使い、`python3 -I` で起動する。CLI の子プロセスには package 内の必要な実体を絶対パスで渡す。外部ツールは OS の公式配布方法で導入し、必要な CLI が `PATH` にない場合は対象の処理を開始しない。

## Git context の Interface

`treflebonbon_skills.git_context` は Nix 非依存の read-only module である。

```python
from treflebonbon_skills.git_context import InvalidContext, Repository, git_environment

repository = Repository.discover(path, linked_only=True)
root = repository.root
git_dir = repository.git_dir
common_dir = repository.common_dir
identity = repository.identity()
repository.check_unchanged(identity)
environment = git_environment()
```

- `Repository.discover(directory, linked_only=False, *, allow_gitfile=False)` は実際の repository root、worktree 固有 Git dir、common Git dir を絶対パスで返す。
- `linked_only=True` は primary checkout と unlinked gitfile を拒否する。linked worktree では `.git` pointer、gitdir の `commondir`、`common/worktrees` の所属、gitdir の back-pointer をすべて照合する。
- `identity()` は common Git dir の path・device・inode を返す。`check_unchanged(identity)` は ownership chain と同一性を再検証する。
- `git_environment()` は呼び出し元の `GIT_*` をすべて除去する。内部の `git rev-parse` は optional lock を無効にする。
- Git metadata を解決できない場合は `InvalidContext` を返す。呼び出し元は権限を広げず処理を止める。

## CLI の契約と依存

依存 CLI は package に同梱しない。必要な一般ツールは公式の配布元から別途用意する。バージョンは plugin で pin せず、各 CLI が現在サポートする版を使う。これらの実行時依存は独立しており、ある CLI の不足で別の skill を止めない。

| CLI | 実行時依存 | 契約 |
| --- | --- | --- |
| `git-push-topic` | Git、Bash、GitHub CLI `gh` と、その通常の認証設定（`origin` の PR を読める権限） | 引数なしで現在 branch と `origin` の default branch を確認する。detached HEAD・default branch・default branch 不明時は拒否し、topic branch だけ `git push -u origin HEAD` する。force option は受け付けない。push の前に default branch の tip を fetch し（祖先判定に必要な履歴を取得し、ローカルの Git metadata を更新する）、HEAD が tip と同一またはその祖先（default の先に commit がない）なら拒否する。同じ head branch の merge 済み PR を `origin` の repository に固定して全件取得し、HEAD が旧 head を含み merge 結果を含まない（merge 済み branch の続き）場合も拒否する。merge 結果を含む同名 branch と、旧 head を含まない同名 branch は通す。この clone に存在しない commit は HEAD の履歴に含まれ得ないため、祖先ではないものとして扱い通す。fetch・shallow repository・祖先判定の失敗（commit が無い場合を除く）・`gh`・PR 取得（上限 1000 件で打ち切りの可能性があるとき）のいずれかで判定できなければ拒否する。追加の検査は topic branch の経路だけで、`git-push-reviewed` は実行しない。 |
| `git-push-reviewed` | Git、Bash | 隣接する `git-push-topic` を絶対 path で読み込む実行可能 entrypoint で、別実装を持たない。起動 basename を保ち、現在 branch が `origin` の default branch と一致する場合に限り通常 push を行う。呼び出し前に必要な人間の承認は caller が確認する。 |
| `gh-review-thread` | Python 3.9+、GitHub CLI `gh` と、その通常の認証設定 | `inspect` は PR / review thread を読む。`--checks` を加えると対象 HEAD の GitHub 検査と CodeRabbit の pre-merge 判定を集計する。`reply-resolve` は対象 PR、thread、commit、返信内容を検証してから返信し、その後に resolve する。返信に失敗した場合は resolve しない。 |
| `serve-local` | Bash、Bun 1.4.4+ | `serve-local <document-root> <port>` で専用 root を `127.0.0.1` のみへ配信する。port `0` は OS が空きを選び、listen 後に `{root,url}` の JSON を1行出す。foreground の process を runtime の session handle で管理する。GET/HEAD、通常ファイルと `index.html`、directory の末尾 `/` redirect を扱い、root 外の参照と index のない directory は404。追加 install と payload 書込みは不要。 |
| `orca-send` | Bash、Bun 1.4.4+、選択済み Orca CLI | UTF-8 本文ファイルを最大 8 KiB まで読み、空本文・NUL・不正 UTF-8・重複 body 引数を拒否する。`--body` は shell を通さず literal のまま一度だけ渡す。本文は Orca CLI の argv に入るため、同一 host 上の process から見える可能性がある。 |
| `prepare-file-safety` | Bash、Bun 1.4.4+、導入済み Node.js と対応する Node-API header、`cc` | candidate/evidence の利用前に、採用済み6操作の native module を payload 外へ source build する明示的な準備入口。保存先・保護・既存 module の検査は[移行手順](bun-peer-evidence-proof.md#入口と準備)を参照する。通常の helper 実行は自動 build / install しない。 |
| `codex-reviewer` | Bash、Python 3.9+、Git、Codex CLI | linked worktree だけを受け入れ、`-C <root>` で起動する。worktree 固有 Git dir と common Git dir だけを、選択した既存 profile の read-only filesystem 許可として渡す。 |

`git-push-topic` と `git-push-reviewed` は実際の push を行う入口であり、検証では mock のみを使う。`gh-review-thread reply-resolve` と `orca-send` も外部への書込みを行うため、skill とその利用者が通常の承認契約を確認してから実行する。

## PR の検査結果を確認する

`gh-review-thread inspect --repo OWNER/REPO --pr NUMBER --checks --no-diff` は、従来の出力に `checks` を追加します。オプションなしの出力形式と返信・resolve の挙動は従来どおりです。

`checks.head` は確認対象の commit、`checks.status` は `passed`・`failed`・`pending`・`unknown` のいずれかです。GitHub の各検査は `checks.github`、CodeRabbit のサマリー URL・判定対象 HEAD・検査別の結果は `checks.coderabbit` に残ります。警告・失敗があれば `failed`、実行中の検査があれば `pending`、全てが成功したときに `passed` になります。検査がない、GitHub の検査がスキップされた、または CodeRabbit のサマリーが存在しない・古い・未対応形式である場合は `unknown` とします。集約では失敗、実行中、判定不能の順に優先します。

検査とサマリーは全ページを取得します。CodeRabbit は公式 bot の最新の更新済みコメントから既知の pre-merge テーブルを読みます。同じコメント内のレビュー範囲文、または HTML メタデータ `change_assessment_commit` の完全な SHA を対象 HEAD と照合し、記載が矛盾する場合は `unknown` とします。取得中に PR の HEAD が変わった場合も `unknown` とします。

`checks.observed_at` は GitHub と CodeRabbit の取得が完了した時刻を UTC で示します。複数回の取得を一つの時点のスナップショットとする保証はありません。GitHub の各項目は、正規化した `status` に加え、API が返した状態を `source` に保持します。`CheckRun` は `type`・`status`・`conclusion`、`StatusContext` は `type`・`state` です。例えば `NEUTRAL` は元の値を残し、集計では従来どおり `unknown` とします。

CodeRabbit の `head_evidence` は、サマリーで見つけた HEAD を `{source, head}` の配列で示します。`source` は `review_range` または `change_assessment_commit` です。根拠が一つの SHA で一致すると `reviewed_head` に入り、不明・矛盾時は `null` になります。これはサマリーの対象 HEAD です。対応する形式では個別の pre-merge 検査の評価 SHA が公開されていないため、`evaluated_head` は `null` とし、サマリーの SHA から推定しません。サマリーが存在しない場合なども、これらの項目を空配列または `null` で残します。

表の行頭・行末の `|` は省略できます。表内の区切り不足や名前のない行も判定対象に残し、`unknown` とします。件数表示がない場合も、読み取れた成功行だけで `passed` にはしません。

`inspect` の終了コード0は取得成功を示します。自動判断では `checks.status` を評価し、従来の `review_threads` にある未解決スレッドも確認します。

## `codex-reviewer` の read-only 起動

通常起動は `dotfiles-secure`、先頭の `--peer` は `dotfiles-peer` profile を選択する。引数で `-C`、worktree、sandbox、profile、remote、権限変更を指定することはできない。`-c` / `--config` は model 関連 key だけを許可し、`--` の後は Codex に positional arguments として渡す。

この launcher は linked worktree の正確な Git metadata に read-only access を加える。profile 欠損や実効性の preflight は行わず、Codex の起動失敗をそのまま返す。別 profile や通常起動へ切り替えない。profile の実効性は専用 auto の保護検証で別途確認する。Codex の秘密情報は隔離せず、`--peer` も秘密隔離を意味しない。

## Bun CLI の起動

`orca-send`、`serve-local`、`prepare-file-safety` と両 peer の candidate/evidence wrapper は Bash の privileged mode（`#!/bin/bash -p`）から `lib/bun/run` を使う。`BASH_ENV` と exported shell function を起動前に読み込ませず、symlink の実体から package root を解決する。呼び出し方と選択済み Orca CLI への native 引数は従来どおりである。

共用起動は `BUN_*`・`JSC_*`・`NODE_OPTIONS`・`NODE_PATH` を除去してから Bun を起動し、package の bunfig と tsconfig を絶対パスで指定する。dotenv、auto-install、macro、transpiler cache と crash report upload を無効にする。これらの runtime 設定は子 CLI にも引き継がれない。`PATH`、`HOME`、`XDG_CONFIG_HOME`、proxy や認証用の環境、cwd は保つ。Bun 自体と選択済み CLI、package payload は信頼済みの実体を使う。これはそれらの実体を隔離する sandbox ではない。

最低版の基準は Bun 1.4.4 とし、実物の版が古い・不明・見つからない場合は開始前に終了コード2で拒否する。移行全体の最低版は残る実証を集約して確定する。[起動実証と比較データ](bun-startup-proof.md)に、確認環境・未確認範囲・後続移行の保存規約を記載する。
