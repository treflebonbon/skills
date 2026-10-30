# worktree-gc 用語

## Dangling worktree

`.git` pointer file が示す Git worktree 管理先が存在しない worktree directory。親 repository が削除された後に残ったものを指す。年齢、path、Git 所有権を確認できる場合だけ fan-out の候補になる。

## Trusted external root

`~/.herdr/worktrees/<repo>` と `~/orca/workspaces/<repo>` は、対応する live repository が Git worktree として登録している場合に限り、fan-out が repo 外で候補を探す場所として信頼する。これ以外の repo 外 path は診断のみで、削除対象にしない。
