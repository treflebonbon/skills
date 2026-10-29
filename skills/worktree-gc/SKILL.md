---
name: worktree-gc
description: 緊急時に repo-local worktree (.claude/worktrees / .worktrees / tmp/implement-issue/worktrees) を GC して fd/inotify 枯渇を解消する。"worktree cleanup" "fd 枯渇" "Too many open files" "worktree が溜まった" で起動。home 全体・ghq 全体の掃除を明示依頼された場合は home-wide fan-out を使う。
---

# worktree-gc

依存とOS条件、用語の補足は [DEPENDENCIES.md](DEPENDENCIES.md) を参照する。特に fan-out の `--apply` は Linux/WSL2 でプロセス検査を完了できる場合だけ使う。

## Steps

1. `git worktree list --porcelain` の先頭 `worktree` 行で main worktree の絶対パスを確認し、`GC_REPO` に設定する。`git -C "$GC_REPO" rev-parse --is-bare-repository` が `false` であることを確認する。bare repo・Git 管理情報を解決できない場合は適用せず、必要な確認事項を報告する。linked worktree 内の `--show-toplevel` は現在の checkout を返すため、repo-local roots の基準に使わない。
2. この `SKILL.md` と同じ directory を起点に `scripts/worktree-gc.sh` を解決し、`bash <script path> --diagnose --repo "$GC_REPO" --roots ".claude/worktrees,.worktrees,tmp/implement-issue/worktrees" --max-report 50` で実行して、まず `summary` を読む。skill の directory を解決できない場合は場所を推測せず、適用を保留する。
3. `candidates` と主要な keep 理由 (`out_of_root`, `keep_dirty`, `keep_detached`, `keep_unique`, `keep_open_pr`) をユーザーに示す。大量の明細は貼らず、必要な時だけ TSV を抜粋する。
4. AskUserQuestion で「適用するか / age 閾値を変えるか」を確認する。
5. 承認されたら `--diagnose` を外し、同じ `--repo` / `--roots` / age 設定に `--apply` を付けて実行する。緊急時は `--age-days 0 --locked-age-days 0` で即時回収も可 (ライブ agent を撃つ恐れを明示)。
6. 実行後 `git -C "$GC_REPO" worktree list --porcelain | grep -c '^worktree '` で残数を報告する。

## Notes

- 単一 repo の診断で現在の checkout が削除候補に含まれた場合は `--apply` を実行せず、稼働中の作業として報告する。単体スクリプトには fan-out のプロセス検出ガードがない。
- dry-run が既定。`--apply` を付けない限り削除しない。
- `--diagnose` は削除しない。`--apply` と併用しても診断のみ。
- summary は `out_of_root` を scope バケット、`keep_*` を in-root/main 側の保護理由として読む。
- `keep_open_pr` は open PR がある場合だけでなく、`gh` 未導入・timeout・失敗による確認不能も含む。open PR の存在を断定せず、確認不能なら照会環境を復旧して同設定で再診断する。保護ガードは無効化しない。
- 年齢の既定値は単体・fan-out とも3日。`--locked-age-days` 未指定時も同じ値を使う。
- locked は age ゲート。`--locked-age-days` 未満の locked はライブ agent とみなし保護される。
- `removed=0` でも `git worktree list` が多い場合、roots 外 worktree や dirty / detached / unique commit / open PR で保護されている可能性が高い。
- 外部 worktree (`~/workspace` 等) は診断表示のみで、自動削除対象外。
- shell snippet は bash 前提にする。zsh では `path` 変数名が `PATH` と連動するため使わない。
- fan-out の `--apply` は Linux/WSL2 で `/proc` の対象 process を検査できる場合だけ許可する。macOS、`hidepid`、一部 PID の cwd 読み取り失敗、必要な mount 情報の欠落では適用を止め、preview と repo 単位の手順を案内する。

## Home-wide fan-out (明示オプトイン, ADR-0056)

上記の既定フローは現在の repo 1つだけが対象。`~/ghq/` 配下の全リポジトリ + `~/.herdr/worktrees/` + `~/orca/workspaces/` を横断して GC したい場合だけ、ユーザーが明示的に要求したとき（例:「home 全体を掃除して」「ghq 全部まとめて worktree-gc して」）に限り、この `SKILL.md` と同じ directory 内の `scripts/worktree-gc-fanout.sh` を使う。skill の directory を解決できない場合は場所を推測せず、適用を保留する。デフォルトの単一repo緊急GCの動作・トリガーフレーズはこの節と無関係で変更されない。

1. `bash <script path>/worktree-gc-fanout.sh --diagnose --age-days 3` を実行する（`--ghq-root` / `--herdr-root` / `--orca-root` は既定でそれぞれ `~/ghq`・`~/.herdr/worktrees`・`~/orca/workspaces`。別パスなら明示指定）。出力は `source(repo|dangling)\treason\tscope\tbranch\tpath\trepo` の TSV で、全repo分 + dangling worktree 分を1つに集約した一覧。
2. 集約された候補一覧を示す。対象 root の全件確認を求められた場合は、別途 `<repo>/<worktree>` の各ディレクトリを列挙し、Git の所有元・age と照合する。生存する親 repo が ghq 外にある worktree は fan-out 対象外で、age 未達の dangling も候補 TSV に出ない。ディレクトリ総数・候補数・対象外を分けて報告する。診断だけの依頼ならここで完了し、適用も依頼された場合は AskUserQuestion で「まとめて適用するか」を1回だけ確認する（repoごとに個別承認しない）。
3. 承認されたら同じオプションに `--apply` を付けて実行する。
4. 実行後、`--herdr-root` / `--orca-root` 配下の残数や `fanout done removed=N` の行で結果を報告する。

- `worktree-gc.sh` の既存の保護判定を使う。`~/.herdr/worktrees/<repo>` と `~/orca/workspaces/<repo>` を、各 ghq リポジトリ呼び出しの `--roots` に追加するだけで実削除対象にしている（信頼できる外部ルートの許可リスト、[GLOSSARY.md](../../GLOSSARY.md)）。
- dangling worktree（親リポジトリ自体が消滅した worktree、[GLOSSARY.md](../../GLOSSARY.md)）も `--age-days` 閾値ゲート付きで検出・削除する。
- 実削除前に稼働中プロセス（`/proc/*/cwd`）を検出し、該当する repo 呼び出し・dangling候補を丸ごと保護する（repo単位の粒度。同じ呼び出しに含まれる他の候補も道連れで保護される）。
- `--max-removals`（既定50）は **実行全体** の上限。repo単位の上限ではない点が `worktree-gc.sh` 単体と異なる。
- `~/ghq/` は削除対象ではなく列挙起点。実際に削除され得るのは各リポジトリの repo-local roots・`~/.herdr/worktrees/<repo>`・`~/orca/workspaces/<repo>`・dangling worktree のみ。
- `--max-report`（既定50）は表示行数の上限に過ぎない。プロセス検出ガードや実削除対象の判定には常に全候補を使うため、`--max-report` を絞っても見落としは起きない。標準エラーの `total_candidates=N shown=M` 行で、表示件数とは別に真の候補総数を確認できる。
- 2つの異なる ghq リポジトリが同じ basename を共有する場合、事故防止のため両方とも herdr/orca 外部rootの付与を無効化し（repo-local roots のみで継続）、標準エラーに `basename collision, external roots disabled for '<name>'` と警告する。
- ghq 配下では発見されない、別の生きたリポジトリが同じ basename の herdr/orca ディレクトリに worktree を持っている場合も同様に検出し（`git worktree list` との照合による所有権検証）、標準エラーに `foreign worktree found under a same-named external root, disabling it for '<name>' (...)` と警告して外部rootの付与を無効化する。
- `--ghq-root`/`--herdr-root`/`--orca-root` は取得直後に正規化(`readlink -f`)する。symlink を含むパスを渡しても `git worktree list` の正規化済みパスと一致するため、登録済みworktreeを孤児と誤認識しない。
