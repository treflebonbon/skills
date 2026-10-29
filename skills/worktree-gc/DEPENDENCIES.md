# worktree-gc の依存と適用条件

## 実行時依存

| 経路                                     | 必要なもの                                                                                                                        | 版と供給元                                                                                                                                                           | 不足時の扱い                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| repo 単位                                | Bash、Git 2.7 以降                                                                                                                | Bash は [GNU Bash](https://www.gnu.org/software/bash/)、Git は [git-scm.com](https://git-scm.com/downloads)。Git の最小版は `worktree list --porcelain` を基準にする | 対象処理を始めず、その CLI と Git 管理情報を確認する                                                        |
| fan-out preview (`--diagnose` / dry-run) | Bash 4.0 以降、GNU-compatible `readlink -f` と共通 command 群                                                                     | Bash 4.0 の associative arrays / `mapfile` が必要。時刻取得は GNU `stat -c` または BSD `stat -f`。macOS の stock Bash 3.2 では起動できない                           | preview の依存を満たすまで wrapper を起動しない。repo 単位の手順は利用できる                                |
| GitHub 保護判定                          | GitHub CLI `gh` と通常の認証設定                                                                                                  | [GitHub CLI 公式配布元](https://cli.github.com/)。版は pin せず、公式に保守される現行版を使用                                                                        | `gh` 不在・認証不能・照会失敗・timeout は open PR / merge 状態の未確認として候補を保持する                  |
| 共通コマンド                             | `find`, `stat`, `readlink`, `date`, `grep`, `sed`, `awk`, `head`, `basename`, `dirname`, `mkdir`, `rm`, `uname`。`timeout` は任意 | Linux の OS 提供 GNU utilities、macOS の OS 提供 BSD utilities。スクリプトは repo 単位の mtime 判定で GNU/BSD `stat` を扱う                                          | 必須コマンドの検査失敗時は対象を保持する。`timeout` がない場合も照会は行い、gh の応答待ち時間は制限されない |
| fan-out の `--apply`                     | Linux `/proc`、GNU `stat -c`、`readlink -f`、閲覧可能な PID cwd と `/proc/self/mountinfo`                                         | Linux kernel の procfs と OS 提供 utilities。WSL2 は Linux として認識される                                                                                          | いずれかを検査できない場合は `--apply` を拒否する。`--diagnose` と既定 dry-run は利用できる                 |
| Python                                   | 実行時依存なし                                                                                                                    | 使用しない                                                                                                                                                           | 該当なし                                                                                                    |
| Nix                                      | 依存なし                                                                                                                          | 使用しない                                                                                                                                                           | 該当なし                                                                                                    |

Bash 4.0 では associative arrays が追加されたため、fan-out の最小版は `declare -A` と `mapfile` から決めている（[Bash 4.0 announcement](https://lists.gnu.org/archive/html/bug-bash/2009-02/msg00164.html)、[Bash arrays](https://www.gnu.org/software/bash/manual/html_node/Arrays.html)）。Git の最小版は Git 2.7.6 の `worktree list --porcelain` 契約を基準にしている（[Git 2.7.6 worktree docs](https://git-scm.com/docs/git-worktree/2.7.6)）。

repo 単位の処理は Bash と Git、必要な OS 標準 command 群で動き、Linux 専用の process guard は要求しない。fan-out wrapper は Bash 4.0 以降を使い、path 正規化に GNU-compatible `readlink -f` を呼ぶ。macOS stock Bash 3.2 では fan-out preview も起動できず、preview には Bash 4.0+ と対応する `readlink -f` が必要。fan-out `--apply` は Linux/WSL2 のみで、`/proc` 配下の cwd、mount 情報、GNU `stat -c` が検査できない場合は拒否する。macOS では preview と repo 単位の処理を使う。

## 用語と保全契約

- **Dangling Worktree**: `.git` pointer が示す親 repo の worktree 管理情報が存在しない directory。age 条件を満たすものだけ fan-out が候補にする。
- **信頼できる外部ルート**: `~/.herdr/worktrees/<repo>` と `~/orca/workspaces/<repo>`。この2つ以外の repo 外 path は診断対象に限る。
- `~/ghq/` は repo の列挙元であり、削除対象ではない。basename 衝突または別 repo が所有する外部 worktree を検出した場合は、その basename の外部 root を無効にする。
- process 所有者、Git 所有権、procfs 可視性、候補 path の状態を検証できない場合は削除しない。dangling candidate は `--apply` 中に所有 pointer・directory inode・age を再検証し、検査中に path が変わった候補を保持する。
- dry-run が既定。人が aggregate preview を確認し、1回の明示承認を得てから同一条件の `--apply` を実行する。repo ごとの個別承認は不要。

## 検証依存

この package の Bats 回帰 suite は [Bats Core](https://github.com/bats-core/bats-core) 1.x を使用する。通常の利用時に Bats は不要。削除ケースは各テストが作る使い捨て Git / worktree fixture 内だけで行う。
