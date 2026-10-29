# 共用 CLI と Git context

この package は、共用 CLI と Git metadata の読取りを所有する。実装は `bin/` と `lib/python/treflebonbon_skills/` にあり、dotfiles や Nix の checkout は参照しない。

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
| `git-push-topic` | Git、Bash | 引数なしで現在 branch と `origin` の default branch を確認する。detached HEAD・default branch・default branch 不明時は拒否し、topic branch だけ `git push -u origin HEAD` する。force option は受け付けない。 |
| `git-push-reviewed` | Git、Bash | `git-push-topic` への symlink で、別実装を持たない。現在 branch が `origin` の default branch と一致する場合に限り通常 push を行う。呼び出し前に必要な人間の承認は caller が確認する。 |
| `gh-review-thread` | Python 3.9+、GitHub CLI `gh` と、その通常の認証設定 | `inspect` は PR / review thread を読む。`reply-resolve` は対象 PR、thread、commit、返信内容を検証してから返信し、その後に resolve する。返信に失敗した場合は resolve しない。 |
| `orca-send` | Python 3.9+、選択済み Orca CLI | UTF-8 本文ファイルを最大 8 KiB まで読み、空本文・NUL・不正 UTF-8・重複 body 引数を拒否する。`--body` は shell を通さず literal のまま一度だけ渡す。本文は Orca CLI の argv に入るため、同一 host 上の process から見える可能性がある。 |
| `codex-reviewer` | Bash、Python 3.9+、Git、Codex CLI | linked worktree だけを受け入れ、`-C <root>` で起動する。worktree 固有 Git dir と common Git dir だけを、選択した既存 profile の read-only filesystem 許可として渡す。 |

`git-push-topic` と `git-push-reviewed` は実際の push を行う入口であり、検証では mock のみを使う。`gh-review-thread reply-resolve` と `orca-send` も外部への書込みを行うため、skill とその利用者が通常の承認契約を確認してから実行する。

## `codex-reviewer` の read-only 起動

通常起動は `dotfiles-secure`、先頭の `--peer` は `dotfiles-peer` profile を選択する。引数で `-C`、worktree、sandbox、profile、remote、権限変更を指定することはできない。`-c` / `--config` は model 関連 key だけを許可し、`--` の後は Codex に positional arguments として渡す。

この launcher は linked worktree の正確な Git metadata に read-only access を加える。profile 欠損や実効性の preflight は行わず、Codex の起動失敗をそのまま返す。別 profile や通常起動へ切り替えない。profile の実効性は専用 auto の保護検証で別途確認する。Codex の秘密情報は隔離せず、`--peer` も秘密隔離を意味しない。
