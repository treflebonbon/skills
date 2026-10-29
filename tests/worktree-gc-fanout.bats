#!/usr/bin/env bats
# skills/worktree-gc/scripts/worktree-gc-fanout.sh の
# home 幅広い fan-out ラッパー (ADR-0056) を検証する。

load 'worktree_gc_test_helper'

readonly SRC="$BATS_TEST_DIRNAME/../skills/worktree-gc/scripts/worktree-gc-fanout.sh"

setup() {
  setup_test_env
  # ホストの他ユーザーの権限に依存せず、列挙できる全PIDのcwdが読める状態を作る。
  export WORKTREE_GC_PROC_ROOT="$BATS_TEST_TMPDIR/proc"
  mkdir -p "$WORKTREE_GC_PROC_ROOT/self" "$WORKTREE_GC_PROC_ROOT/1"
  : >"$WORKTREE_GC_PROC_ROOT/self/stat"
  ln -s / "$WORKTREE_GC_PROC_ROOT/self/cwd"
  ln -s / "$WORKTREE_GC_PROC_ROOT/1/cwd"
  printf '1 0 0:1 / /proc rw - proc proc rw\n' >"$WORKTREE_GC_PROC_ROOT/self/mountinfo"
}

extract_functions() {
  local file="$1"
  shift
  local name
  for name in "$@"; do
    extract_function "$file" "$name"
    echo
  done
}

# 純粋関数を隔離環境で呼び出す。is_dangling_worktree のような依存関係のある
# 関数は、呼び出し先の関数定義も一緒に extract する。
run_pure_function() {
  local fn="$1"
  shift
  local deps=("$fn")
  case "$fn" in
  is_dangling_worktree) deps+=(gitdir_target) ;;
  dangling_snapshot) deps+=(gitdir_target is_older_than_days) ;;
  is_busy_dir) deps+=(process_inspection_available) ;;
  remove_dangling_dir) deps+=(dangling_snapshot gitdir_target is_older_than_days) ;;
  dangling_candidates) deps+=(find_worktree_dirs is_dangling_worktree gitdir_target is_older_than_days) ;;
  esac
  local quoted_args=() a
  for a in "$@"; do
    quoted_args+=("$(printf '%q' "$a")")
  done
  run /usr/bin/env -i \
    PATH="/usr/bin:/bin" \
    HOME="$BATS_TEST_TMPDIR/home" \
    WORKTREE_GC_PROC_ROOT="$WORKTREE_GC_PROC_ROOT" \
    AGE_DAYS=0 \
    /bin/bash -c "
      $(extract_functions "$SRC" "${deps[@]}")
      $fn ${quoted_args[*]}
    "
}

# stdin を読む純粋関数（skip_summary_and_header）用。呼び出し側が heredoc で
# stdin を渡す。
run_pure_function_stdin() {
  local fn="$1"
  run /usr/bin/env -i \
    PATH="/usr/bin:/bin" \
    HOME="$BATS_TEST_TMPDIR/home" \
    /bin/bash -c "
      $(extract_functions "$SRC" "$fn")
      $fn
    "
}

make_ghq_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.email test@example.com
  git -C "$repo" config user.name test
  git -C "$repo" commit -q --allow-empty -m init
}

age_dir() {
  touch -d '2001-09-09' "$1"
}

# --- repo_roots_for -----------------------------------------------------

@test "repo_roots_for: 既定rootsに herdr/orca の basename パスを追加する" {
  run_pure_function repo_roots_for \
    "/home/u/ghq/github.com/o/myrepo" "/home/u/.herdr/worktrees" \
    "/home/u/orca/workspaces" ".claude/worktrees,.worktrees"
  assert_success
  assert_output ".claude/worktrees,.worktrees,/home/u/.herdr/worktrees/myrepo,/home/u/orca/workspaces/myrepo"
}

# --- remaining_budget -----------------------------------------------------

@test "remaining_budget: cap未満なら差分を返す" {
  run_pure_function remaining_budget 50 10
  assert_success
  assert_output "40"
}

@test "remaining_budget: usedがcapを超えても0未満にはしない" {
  run_pure_function remaining_budget 50 999
  assert_success
  assert_output "0"
}

# --- gitdir_target / is_dangling_worktree ----------------------------------

@test "gitdir_target: worktree pointer file から絶対パスをそのまま返す" {
  mkdir -p "$BATS_TEST_TMPDIR/wt"
  echo "gitdir: /somewhere/.git/worktrees/wt" >"$BATS_TEST_TMPDIR/wt/.git"
  run_pure_function gitdir_target "$BATS_TEST_TMPDIR/wt"
  assert_success
  assert_output "/somewhere/.git/worktrees/wt"
}

@test "gitdir_target: 相対パスは worktree dir 基準で解決する" {
  mkdir -p "$BATS_TEST_TMPDIR/wt"
  echo "gitdir: ../elsewhere" >"$BATS_TEST_TMPDIR/wt/.git"
  run_pure_function gitdir_target "$BATS_TEST_TMPDIR/wt"
  assert_success
  assert_output "$BATS_TEST_TMPDIR/wt/../elsewhere"
}

@test "gitdir_target: .git が実ディレクトリ(通常clone)なら失敗する" {
  mkdir -p "$BATS_TEST_TMPDIR/repo/.git"
  run_pure_function gitdir_target "$BATS_TEST_TMPDIR/repo"
  assert_failure
}

@test "gitdir_target: .git が存在しなければ失敗する" {
  mkdir -p "$BATS_TEST_TMPDIR/plain"
  run_pure_function gitdir_target "$BATS_TEST_TMPDIR/plain"
  assert_failure
}

@test "is_dangling_worktree: gitdir参照先が存在すれば dangling ではない" {
  mkdir -p "$BATS_TEST_TMPDIR/parent/.git/worktrees/wt" "$BATS_TEST_TMPDIR/wt"
  echo "gitdir: $BATS_TEST_TMPDIR/parent/.git/worktrees/wt" >"$BATS_TEST_TMPDIR/wt/.git"
  run_pure_function is_dangling_worktree "$BATS_TEST_TMPDIR/wt"
  assert_failure
}

@test "is_dangling_worktree: gitdir参照先が消えていれば dangling と判定する" {
  mkdir -p "$BATS_TEST_TMPDIR/wt"
  echo "gitdir: $BATS_TEST_TMPDIR/parent-gone/.git/worktrees/wt" >"$BATS_TEST_TMPDIR/wt/.git"
  run_pure_function is_dangling_worktree "$BATS_TEST_TMPDIR/wt"
  assert_success
}

@test "is_dangling_worktree: 通常clone(.gitが実ディレクトリ)は dangling 扱いしない" {
  mkdir -p "$BATS_TEST_TMPDIR/repo/.git"
  run_pure_function is_dangling_worktree "$BATS_TEST_TMPDIR/repo"
  assert_failure
}

# --- skip_summary_and_header ------------------------------------------------

@test "skip_summary_and_header: summary行とヘッダ行を取り除きデータ行だけ残す" {
  run_pure_function_stdin skip_summary_and_header <<'EOF'
summary total=2 in_root=1 out_of_root=1 candidates=1 keep_main=0 keep_self_session=0 keep_young=0 keep_dirty=0 keep_detached=0 keep_unique=0 keep_open_pr=0 keep_other=0 keep_dirty_stale=0
decision	reason	scope	branch	path
remove-candidate	clean-safe	in-root	feature-x	/repo/.worktrees/feature-x
keep	out-of-root	out-of-root	-	/other/place
EOF
  assert_success
  [ "${#lines[@]}" -eq 2 ]
  assert_line --index 0 "remove-candidate	clean-safe	in-root	feature-x	/repo/.worktrees/feature-x"
  assert_line --index 1 "keep	out-of-root	out-of-root	-	/other/place"
}

# --- is_busy_dir -----------------------------------------------------------

@test "is_busy_dir: cwdが対象ディレクトリ配下のプロセスがあれば検出する" {
  local dir="$BATS_TEST_TMPDIR/busy"
  mkdir -p "$dir"
  (
    cd "$dir" || exit 1
    exec sleep 30
  ) &
  local pid=$!
  for _ in $(seq 1 50); do
    if [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "$(readlink -f "$dir")" ]; then
      break
    fi
    sleep 0.05
  done
  ln -s "/proc/$pid" "$WORKTREE_GC_PROC_ROOT/$pid"
  run_pure_function is_busy_dir "$dir"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  assert_success
}

@test "is_busy_dir: cwdが対象外なら検出しない" {
  local dir="$BATS_TEST_TMPDIR/idle"
  mkdir -p "$dir"
  run_pure_function is_busy_dir "$dir"
  assert_failure
}

# --- find_ghq_repos / find_worktree_dirs ------------------------------------

@test "find_ghq_repos: 実clone(.gitが実ディレクトリ)だけを列挙する" {
  local root="$BATS_TEST_TMPDIR/ghq"
  mkdir -p "$root/host/org/real-repo/.git"
  mkdir -p "$root/host/org/a-worktree"
  echo "gitdir: /elsewhere" >"$root/host/org/a-worktree/.git"
  run_pure_function find_ghq_repos "$root"
  assert_success
  assert_line "$root/host/org/real-repo"
  refute_line "$root/host/org/a-worktree"
}

@test "find_ghq_repos: rootが存在しなければ何も出力しない" {
  run_pure_function find_ghq_repos "$BATS_TEST_TMPDIR/does-not-exist"
  assert_success
  assert_output ""
}

@test "find_worktree_dirs: <repo>/<name> の2階層リーフを列挙する" {
  local root="$BATS_TEST_TMPDIR/herdr"
  mkdir -p "$root/dotfiles/worktree-a" "$root/dotfiles/worktree-b" "$root/other-repo/wt"
  run_pure_function find_worktree_dirs "$root"
  assert_success
  assert_line "$root/dotfiles/worktree-a"
  assert_line "$root/dotfiles/worktree-b"
  assert_line "$root/other-repo/wt"
}

@test "find_worktree_dirs: 空の1階層ディレクトリ(.orca-preparing相当)は何も出さない" {
  local root="$BATS_TEST_TMPDIR/orca"
  mkdir -p "$root/.orca-preparing"
  run_pure_function find_worktree_dirs "$root"
  assert_success
  assert_output ""
}

# --- 統合テスト（実際の git repo / worktree を使う） -----------------------

@test "統合: --diagnose は他repoのstale worktreeとdangling worktreeを両方、正しいsourceで報告する" {
  local ghq_root="$BATS_TEST_TMPDIR/ghq"
  local herdr="$BATS_TEST_TMPDIR/herdr"
  local orca="$BATS_TEST_TMPDIR/orca"
  local repo="$ghq_root/host/org/myrepo"
  make_ghq_repo "$repo"
  git -C "$repo" worktree add -q -b feature-x "$herdr/myrepo/feature-x"
  age_dir "$herdr/myrepo/feature-x"

  mkdir -p "$orca/otherproj/gone-parent"
  echo "gitdir: $BATS_TEST_TMPDIR/vanished/.git/worktrees/gone-parent" >"$orca/otherproj/gone-parent/.git"
  age_dir "$orca/otherproj/gone-parent"

  run env WORKTREE_GC_PROTECT_OPEN_PR=0 bash "$SRC" --diagnose \
    --ghq-root "$ghq_root" --herdr-root "$herdr" --orca-root "$orca" --age-days 7
  assert_success

  local repo_row dangling_row
  repo_row=$(printf '%s\n' "$output" | awk -F'\t' -v p="$herdr/myrepo/feature-x" '$5==p')
  dangling_row=$(printf '%s\n' "$output" | awk -F'\t' -v p="$orca/otherproj/gone-parent" '$5==p')
  [ -n "$repo_row" ]
  [ -n "$dangling_row" ]
  [ "${repo_row%%$'\t'*}" = "repo" ]
  [ "${dangling_row%%$'\t'*}" = "dangling" ]
}

@test "package内のfan-out公開入口はcheckout外からengineを解決してpreviewできる" {
  local ghq_root="$BATS_TEST_TMPDIR/ghq"
  local herdr="$BATS_TEST_TMPDIR/herdr"
  local orca="$BATS_TEST_TMPDIR/orca"
  local repo="$ghq_root/host/org/myrepo"
  make_ghq_repo "$repo"
  git -C "$repo" worktree add -q -b feature-x "$herdr/myrepo/feature-x"
  age_dir "$herdr/myrepo/feature-x"
  cd "$BATS_TEST_TMPDIR"

  run env WORKTREE_GC_PROTECT_OPEN_PR=0 bash "$SRC" --diagnose \
    --ghq-root "$ghq_root" --herdr-root "$herdr" --orca-root "$orca" --age-days 7

  assert_success
  assert_output --partial "$herdr/myrepo/feature-x"
}

@test "fan-out の dangling preview は Nix を含まない system PATH で利用できる" {
  local herdr="$BATS_TEST_TMPDIR/herdr"
  local orca="$BATS_TEST_TMPDIR/orca"
  mkdir -p "$herdr/gone/old" "$BATS_TEST_TMPDIR/home"
  printf 'gitdir: /missing/parent/.git/worktrees/old\n' >"$herdr/gone/old/.git"
  age_dir "$herdr/gone/old"

  run /usr/bin/env -i HOME="$BATS_TEST_TMPDIR/home" PATH="/usr/bin:/bin" \
    WORKTREE_GC_PROC_ROOT="$WORKTREE_GC_PROC_ROOT" /bin/bash "$SRC" --diagnose \
    --ghq-root "$BATS_TEST_TMPDIR/empty-ghq" --herdr-root "$herdr" \
    --orca-root "$orca" --age-days 7

  assert_success
  assert_output --partial "$herdr/gone/old"
}

@test "統合: --herdr-root がsymlink経由でも登録済みworktreeを孤児と誤認識しない(symlink正規化回帰テスト, PR#281レビュー)" {
  local ghq_root="$BATS_TEST_TMPDIR/ghq"
  local herdr_real="$BATS_TEST_TMPDIR/herdr_real"
  local herdr_link="$BATS_TEST_TMPDIR/herdr_link"
  local orca="$BATS_TEST_TMPDIR/orca"
  local repo="$ghq_root/host/org/myrepo"
  make_ghq_repo "$repo"
  mkdir -p "$herdr_real"
  ln -s "$herdr_real" "$herdr_link"
  git -C "$repo" worktree add -q -b feature-x "$herdr_link/myrepo/feature-x"
  # dirty にしておく: 誤って「孤児」判定された場合、orphan削除はage判定のみで
  # dirtyガードが効かないため実際に削除されてしまい、正規化の有無で結果が
  # 分かれる。ディレクトリへのファイル追加はmtimeを更新するため、age_dir は
  # dirty化の後に呼ぶ(順序を誤ると常に「新しい」と判定され、この回帰テストが
  # 意図した分岐を検証できなくなる)。
  echo dirty >"$herdr_real/myrepo/feature-x/untracked.txt"
  age_dir "$herdr_real/myrepo/feature-x"

  run env WORKTREE_GC_PROTECT_OPEN_PR=0 bash "$SRC" --apply \
    --ghq-root "$ghq_root" --herdr-root "$herdr_link" --orca-root "$orca" --age-days 7

  assert_success
  [ -d "$herdr_real/myrepo/feature-x" ]
}

@test "統合: ghq外の生きた親を持つ同名basenameのworktreeがあれば外部rootを無効化し誤削除しない(PR#281レビュー)" {
  local ghq_root="$BATS_TEST_TMPDIR/ghq"
  local herdr="$BATS_TEST_TMPDIR/herdr"
  local orca="$BATS_TEST_TMPDIR/orca"
  local repo="$ghq_root/host/org/samename"
  local foreign_repo="$BATS_TEST_TMPDIR/foreign/samename"
  make_ghq_repo "$repo"
  make_ghq_repo "$foreign_repo"

  git -C "$repo" worktree add -q -b own-feature "$herdr/samename/own-feature"
  age_dir "$herdr/samename/own-feature"

  # basenameは同じ "samename" だが ghq 配下ではない別の生きたリポジトリが、
  # 同じ herdr ディレクトリ配下に自分の worktree を持っている(dirty)。
  # age_dir はディレクトリへのファイル追加(dirty化)の後に呼ぶ(順序を誤ると
  # mtimeが更新され「新しい」扱いになる)。
  git -C "$foreign_repo" worktree add -q -b foreign-feature "$herdr/samename/foreign-feature"
  echo dirty >"$herdr/samename/foreign-feature/untracked.txt"
  age_dir "$herdr/samename/foreign-feature"

  run env WORKTREE_GC_PROTECT_OPEN_PR=0 bash "$SRC" --apply \
    --ghq-root "$ghq_root" --herdr-root "$herdr" --orca-root "$orca" --age-days 7

  assert_success
  assert_output --partial "foreign worktree found under a same-named external root"
  # 外部root全体を無効化するため、ghq発見リポジトリ自身のstale worktreeも
  # このラウンドでは削除されない(安全側の道連れ保護)。
  [ -d "$herdr/samename/own-feature" ]
  [ -d "$herdr/samename/foreign-feature" ]
}

@test "統合: 稼働中プロセスが無ければ --apply は stale worktree と dangling worktree を削除する" {
  local ghq_root="$BATS_TEST_TMPDIR/ghq"
  local herdr="$BATS_TEST_TMPDIR/herdr"
  local orca="$BATS_TEST_TMPDIR/orca"
  local repo="$ghq_root/host/org/myrepo"
  make_ghq_repo "$repo"
  git -C "$repo" worktree add -q -b feature-x "$herdr/myrepo/feature-x"
  age_dir "$herdr/myrepo/feature-x"

  mkdir -p "$orca/otherproj/gone-parent"
  echo "gitdir: $BATS_TEST_TMPDIR/vanished/.git/worktrees/gone-parent" >"$orca/otherproj/gone-parent/.git"
  age_dir "$orca/otherproj/gone-parent"

  run env WORKTREE_GC_PROTECT_OPEN_PR=0 bash "$SRC" --apply \
    --ghq-root "$ghq_root" --herdr-root "$herdr" --orca-root "$orca" --age-days 7

  assert_success
  [ ! -d "$herdr/myrepo/feature-x" ]
  [ ! -d "$orca/otherproj/gone-parent" ]
  assert_output --partial "fanout done removed=2"
}

@test "統合: --max-removals 0 なら全体でも何も削除しない" {
  local ghq_root="$BATS_TEST_TMPDIR/ghq"
  local herdr="$BATS_TEST_TMPDIR/herdr"
  local orca="$BATS_TEST_TMPDIR/orca"
  local repo="$ghq_root/host/org/myrepo"
  make_ghq_repo "$repo"
  git -C "$repo" worktree add -q -b feature-x "$herdr/myrepo/feature-x"
  age_dir "$herdr/myrepo/feature-x"

  mkdir -p "$orca/otherproj/gone-parent"
  echo "gitdir: $BATS_TEST_TMPDIR/vanished/.git/worktrees/gone-parent" >"$orca/otherproj/gone-parent/.git"
  age_dir "$orca/otherproj/gone-parent"

  run env WORKTREE_GC_PROTECT_OPEN_PR=0 bash "$SRC" --apply --max-removals 0 \
    --ghq-root "$ghq_root" --herdr-root "$herdr" --orca-root "$orca" --age-days 7

  assert_success
  [ -d "$herdr/myrepo/feature-x" ]
  [ -d "$orca/otherproj/gone-parent" ]
  assert_output --partial "fanout done removed=0"
}

@test "is_older_than_days: GNU stat で古いパスを古いと判定する" {
  stub_real_cmd stat
  stub_real_cmd date
  local old_path="$BATS_TEST_TMPDIR/old-dir"
  mkdir -p "$old_path"
  touch -d '2001-09-09' "$old_path"
  run /usr/bin/env -i \
    PATH="$TEST_BIN_DIR:/usr/bin:/bin" \
    TEST_LOG="$TEST_LOG" \
    /bin/bash -c "
      $(extract_function "$SRC" is_older_than_days)
      is_older_than_days '$old_path' 7
    "
  assert_success
}

@test "is_older_than_days: 作成直後のパスは古いと判定しない" {
  local fresh_path="$BATS_TEST_TMPDIR/fresh-dir"
  mkdir -p "$fresh_path"
  run_pure_function is_older_than_days "$fresh_path" 7
  assert_failure
}

@test "is_busy_dir: 候補パスがsymlink経由でも、実体のcwdを検出する(fail-open回帰テスト)" {
  mkdir -p "$BATS_TEST_TMPDIR/real/wt"
  ln -s "$BATS_TEST_TMPDIR/real" "$BATS_TEST_TMPDIR/link"
  (
    cd "$BATS_TEST_TMPDIR/real/wt" || exit 1
    exec sleep 30
  ) &
  local pid=$!
  for _ in $(seq 1 50); do
    if [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "$(readlink -f "$BATS_TEST_TMPDIR/real/wt")" ]; then
      break
    fi
    sleep 0.05
  done
  # symlink 経由の(未解決の)パスを渡しても検出できなければならない。
  ln -s "/proc/$pid" "$WORKTREE_GC_PROC_ROOT/$pid"
  run_pure_function is_busy_dir "$BATS_TEST_TMPDIR/link/wt"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  assert_success
}

@test "統合: basenameが衝突する2repoは herdr 外部rootの付与を無効化し警告する" {
  local ghq_root="$BATS_TEST_TMPDIR/ghq"
  local herdr="$BATS_TEST_TMPDIR/herdr"
  local orca="$BATS_TEST_TMPDIR/orca"
  local repo_a="$ghq_root/host/org-a/myrepo"
  local repo_b="$ghq_root/host/org-b/myrepo"
  make_ghq_repo "$repo_a"
  make_ghq_repo "$repo_b"
  git -C "$repo_a" worktree add -q -b feature-a "$herdr/myrepo/from-a"
  age_dir "$herdr/myrepo/from-a"

  run env WORKTREE_GC_PROTECT_OPEN_PR=0 bash "$SRC" --diagnose \
    --ghq-root "$ghq_root" --herdr-root "$herdr" --orca-root "$orca" --age-days 7
  assert_success
  assert_output --partial "basename collision, external roots disabled for 'myrepo'"
  refute_output --partial "$herdr/myrepo/from-a"
}

@test "統合: --max-report を絞ってもプロセス検出ガードは全候補を見て保護する" {
  local ghq_root="$BATS_TEST_TMPDIR/ghq"
  local herdr="$BATS_TEST_TMPDIR/herdr"
  local orca="$BATS_TEST_TMPDIR/orca"
  local repo="$ghq_root/host/org/myrepo"
  make_ghq_repo "$repo"
  git -C "$repo" worktree add -q -b feature-x "$herdr/myrepo/feature-x"
  git -C "$repo" worktree add -q -b feature-y "$herdr/myrepo/feature-y"
  age_dir "$herdr/myrepo/feature-x"
  age_dir "$herdr/myrepo/feature-y"

  # feature-y (2件目に作成) を稼働中にする。--max-report 1 で先頭1件しか
  # 見えない実装であれば、feature-y のビジー状態を見逃して削除してしまう。
  (
    cd "$herdr/myrepo/feature-y" || exit 1
    exec sleep 30
  ) &
  local pid=$!
  for _ in $(seq 1 50); do
    if [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "$(readlink -f "$herdr/myrepo/feature-y")" ]; then
      break
    fi
    sleep 0.05
  done

  ln -s "/proc/$pid" "$WORKTREE_GC_PROC_ROOT/$pid"
  run env WORKTREE_GC_PROTECT_OPEN_PR=0 bash "$SRC" --apply --max-report 1 \
    --ghq-root "$ghq_root" --herdr-root "$herdr" --orca-root "$orca" --age-days 7

  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true

  assert_success
  [ -d "$herdr/myrepo/feature-x" ]
  [ -d "$herdr/myrepo/feature-y" ]
}

@test "統合: --diagnose は --max-report で表示を絞っても total_candidates で真の件数を報告する" {
  local ghq_root="$BATS_TEST_TMPDIR/ghq"
  local herdr="$BATS_TEST_TMPDIR/herdr"
  local orca="$BATS_TEST_TMPDIR/orca"
  local repo="$ghq_root/host/org/myrepo"
  make_ghq_repo "$repo"
  git -C "$repo" worktree add -q -b feature-x "$herdr/myrepo/feature-x"
  git -C "$repo" worktree add -q -b feature-y "$herdr/myrepo/feature-y"
  age_dir "$herdr/myrepo/feature-x"
  age_dir "$herdr/myrepo/feature-y"

  run env WORKTREE_GC_PROTECT_OPEN_PR=0 bash "$SRC" --diagnose --max-report 1 \
    --ghq-root "$ghq_root" --herdr-root "$herdr" --orca-root "$orca" --age-days 7
  assert_success
  assert_output --partial "total_candidates=2 shown=1"
  # ヘッダ行 + 1データ行だけが標準出力に乗る。
  local data_lines
  data_lines=$(printf '%s\n' "$output" | grep -c '^repo	')
  [ "$data_lines" -eq 1 ]
}

@test "統合: --max-removals は複数repoを跨いで累計され、上限で打ち切る" {
  local ghq_root="$BATS_TEST_TMPDIR/ghq"
  local herdr="$BATS_TEST_TMPDIR/herdr"
  local orca="$BATS_TEST_TMPDIR/orca"
  local repo1="$ghq_root/host/org/repo1"
  local repo2="$ghq_root/host/org/repo2"
  make_ghq_repo "$repo1"
  make_ghq_repo "$repo2"
  git -C "$repo1" worktree add -q -b feature-a "$herdr/repo1/feature-a"
  git -C "$repo2" worktree add -q -b feature-b "$herdr/repo2/feature-b"
  age_dir "$herdr/repo1/feature-a"
  age_dir "$herdr/repo2/feature-b"

  run env WORKTREE_GC_PROTECT_OPEN_PR=0 bash "$SRC" --apply --max-removals 1 \
    --ghq-root "$ghq_root" --herdr-root "$herdr" --orca-root "$orca" --age-days 7

  assert_success
  assert_output --partial "fanout done removed=1"
  local remaining=0
  [ -d "$herdr/repo1/feature-a" ] && remaining=$((remaining + 1))
  [ -d "$herdr/repo2/feature-b" ] && remaining=$((remaining + 1))
  [ "$remaining" -eq 1 ]
}

@test "統合: 稼働中プロセスがある候補を含むrepoは丸ごと保護し削除しない" {
  local ghq_root="$BATS_TEST_TMPDIR/ghq"
  local herdr="$BATS_TEST_TMPDIR/herdr"
  local orca="$BATS_TEST_TMPDIR/orca"
  local repo="$ghq_root/host/org/myrepo"
  make_ghq_repo "$repo"
  git -C "$repo" worktree add -q -b feature-x "$herdr/myrepo/feature-x"
  git -C "$repo" worktree add -q -b feature-y "$herdr/myrepo/feature-y"
  age_dir "$herdr/myrepo/feature-x"
  age_dir "$herdr/myrepo/feature-y"

  (
    cd "$herdr/myrepo/feature-y" || exit 1
    exec sleep 30
  ) &
  local pid=$!
  for _ in $(seq 1 50); do
    if [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "$(readlink -f "$herdr/myrepo/feature-y")" ]; then
      break
    fi
    sleep 0.05
  done

  ln -s "/proc/$pid" "$WORKTREE_GC_PROC_ROOT/$pid"
  run env WORKTREE_GC_PROTECT_OPEN_PR=0 bash "$SRC" --apply \
    --ghq-root "$ghq_root" --herdr-root "$herdr" --orca-root "$orca" --age-days 7

  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true

  assert_success
  [ -d "$herdr/myrepo/feature-x" ]
  [ -d "$herdr/myrepo/feature-y" ]
}

@test "apply refuses unsupported or inaccessible process inspection before invoking the engine" {
  local bin="$BATS_TEST_TMPDIR/bin" mode
  mkdir -p "$bin" "$BATS_TEST_TMPDIR/herdr/deleted/old"
  printf 'gitdir: /missing/parent/worktrees/old\n' >"$BATS_TEST_TMPDIR/herdr/deleted/old/.git"
  age_dir "$BATS_TEST_TMPDIR/herdr/deleted/old"
  make_ghq_repo "$BATS_TEST_TMPDIR/ghq/repo"
  printf '#!/bin/sh\necho invoked >>"$ENGINE_LOG"\necho "done removed=0"\n' >"$bin/engine"
  for mode in unsupported inaccessible; do
    if [ "$mode" = unsupported ]; then
      printf '#!/bin/sh\necho Darwin\n' >"$bin/uname"
      printf '#!/bin/sh\nexec /usr/bin/readlink "$@"\n' >"$bin/readlink"
    else
      printf '#!/bin/sh\necho Linux\n' >"$bin/uname"
      printf '#!/bin/sh\nexit 1\n' >"$bin/readlink"
    fi
    chmod +x "$bin/uname" "$bin/readlink"
    run env PATH="$bin:$PATH" WORKTREE_GC_ENGINE="$bin/engine" ENGINE_LOG="$BATS_TEST_TMPDIR/$mode.log" bash "$SRC" --apply \
      --ghq-root "$BATS_TEST_TMPDIR/ghq" \
      --herdr-root "$BATS_TEST_TMPDIR/herdr" --orca-root "$BATS_TEST_TMPDIR/orca"
    assert_failure
    assert_output --partial 'process inspection unavailable; refusing --apply'
    [ ! -e "$BATS_TEST_TMPDIR/$mode.log" ]
    [ -d "$BATS_TEST_TMPDIR/herdr/deleted/old" ]
    run env PATH="$bin:$PATH" bash "$SRC" --dry-run \
      --ghq-root "$BATS_TEST_TMPDIR/empty" \
      --herdr-root "$BATS_TEST_TMPDIR/herdr" --orca-root "$BATS_TEST_TMPDIR/orca"
    assert_success
  done
}

@test "apply refuses hidden or uninspectable procfs and accepts a fully visible one" {
  local bin="$BATS_TEST_TMPDIR/bin" proc="$BATS_TEST_TMPDIR/proc" mode
  mkdir -p "$bin" "$BATS_TEST_TMPDIR/herdr" "$BATS_TEST_TMPDIR/orca"
  make_ghq_repo "$BATS_TEST_TMPDIR/ghq/repo"
  printf '#!/bin/sh\necho invoked >>"$ENGINE_LOG"\necho "done removed=0"\n' >"$bin/engine"
  chmod +x "$bin/engine"
  for mode in hidepid hidepid-4 hidepid-ptraceable no-init missing-mountinfo mountinfo-directory visible; do
    rm -rf "$proc"
    mkdir -p "$proc/self" "$proc/1"
    : >"$proc/self/stat"
    ln -s / "$proc/self/cwd"
    printf '1 0 0:1 / /proc rw - proc proc rw\n' >"$proc/self/mountinfo"
    [ "$mode" != hidepid ] || printf '1 0 0:1 / /proc rw - proc proc rw,hidepid=2\n' >"$proc/self/mountinfo"
    [ "$mode" != no-init ] || rmdir "$proc/1"
    [ "$mode" = no-init ] || ln -s / "$proc/1/cwd"
    case "$mode" in
    hidepid-4) printf '1 0 0:1 / /proc rw - proc proc rw,hidepid=4\n' >"$proc/self/mountinfo" ;;
    hidepid-ptraceable) printf '1 0 0:1 / /proc rw - proc proc rw,hidepid=ptraceable\n' >"$proc/self/mountinfo" ;;
    missing-mountinfo) rm "$proc/self/mountinfo" ;;
    mountinfo-directory)
      rm "$proc/self/mountinfo"
      mkdir "$proc/self/mountinfo"
      ;;
    esac
    run env WORKTREE_GC_PROC_ROOT="$proc" WORKTREE_GC_ENGINE="$bin/engine" ENGINE_LOG="$BATS_TEST_TMPDIR/$mode.log" \
      bash "$SRC" --apply --ghq-root "$BATS_TEST_TMPDIR/ghq" \
      --herdr-root "$BATS_TEST_TMPDIR/herdr" --orca-root "$BATS_TEST_TMPDIR/orca"
    if [ "$mode" = visible ]; then
      assert_success
      [ -e "$BATS_TEST_TMPDIR/$mode.log" ]
    else
      assert_failure
      assert_output --partial 'process inspection unavailable; refusing --apply'
      [ ! -e "$BATS_TEST_TMPDIR/$mode.log" ]
    fi
  done
}

@test "dangling worktree が処理中に入れ替わった場合は新しい内容を保持する" {
  local ghq_root="$BATS_TEST_TMPDIR/ghq"
  local herdr="$BATS_TEST_TMPDIR/herdr"
  local orca="$BATS_TEST_TMPDIR/orca"
  local candidate="$herdr/repo/disappearing"
  local displaced="$BATS_TEST_TMPDIR/displaced"
  local real_readlink
  mkdir -p "$candidate" "$BATS_TEST_TMPDIR/bin"
  printf 'gitdir: /missing/parent/.git/worktrees/disappearing\n' >"$candidate/.git"
  age_dir "$candidate"
  real_readlink=$(command -v readlink)
  cat >"$TEST_BIN_DIR/readlink" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = -f ] && [ "${2:-}" = "$GC_SWAP_CANDIDATE" ] && [ ! -e "$GC_SWAP_DONE" ]; then
  mv -- "$GC_SWAP_CANDIDATE" "$GC_DISPLACED"
  mkdir -p -- "$GC_SWAP_CANDIDATE"
  printf '%s\n' user-data >"$GC_SWAP_CANDIDATE/keep.txt"
  : >"$GC_SWAP_DONE"
fi
exec "$GC_REAL_READLINK" "$@"
SH
  chmod +x "$TEST_BIN_DIR/readlink"

  run env PATH="$TEST_BIN_DIR:$PATH" WORKTREE_GC_PROC_ROOT="$WORKTREE_GC_PROC_ROOT" \
    GC_SWAP_CANDIDATE="$candidate" GC_DISPLACED="$displaced" \
    GC_SWAP_DONE="$BATS_TEST_TMPDIR/swap-done" GC_REAL_READLINK="$real_readlink" \
    bash "$SRC" --apply --ghq-root "$ghq_root" --herdr-root "$herdr" \
    --orca-root "$orca" --age-days 7

  assert_success
  [ -f "$candidate/keep.txt" ]
  [ -f "$displaced/.git" ]
  assert_output --partial 'fanout done removed=0'
}

@test "統合: 生存するPIDのcwdを検査できなければrepoとdangling候補を保護する" {
  local bin="$BATS_TEST_TMPDIR/bin" proc="$BATS_TEST_TMPDIR/proc" mode
  mkdir -p "$bin" "$proc/2"
  for mode in missing-cwd unreadable-cwd; do
    local root="$BATS_TEST_TMPDIR/$mode" repo="$BATS_TEST_TMPDIR/$mode/ghq/repo"
    make_ghq_repo "$repo"
    git -C "$repo" worktree add -q -b feature "$root/herdr/repo/feature"
    mkdir -p "$root/orca/gone/old"
    printf 'gitdir: /missing/parent/worktrees/old\n' >"$root/orca/gone/old/.git"
    age_dir "$root/herdr/repo/feature"
    age_dir "$root/orca/gone/old"
    if [ "$mode" = unreadable-cwd ]; then
      ln -s "$root/herdr/repo/feature" "$proc/2/cwd"
      cat >"$bin/readlink" <<'EOF'
#!/bin/sh
for arg do
  [ "$arg" != "$WORKTREE_GC_PROC_ROOT/2/cwd" ] || exit 1
done
exec /usr/bin/readlink "$@"
EOF
      chmod +x "$bin/readlink"
    fi
    run env PATH="$bin:$PATH" WORKTREE_GC_PROC_ROOT="$proc" WORKTREE_GC_PROTECT_OPEN_PR=0 \
      bash "$SRC" --apply --ghq-root "$root/ghq" --herdr-root "$root/herdr" --orca-root "$root/orca"
    assert_success
    [ -d "$root/herdr/repo/feature" ]
    [ -d "$root/orca/gone/old" ]
    assert_output --partial 'fanout done removed=0'
  done
}

@test "統合: 単体とfan-outの既定は3日で、danglingにも適用する" {
  local ghq_root="$BATS_TEST_TMPDIR/ghq"
  local repo="$ghq_root/host/org/myrepo"
  local herdr="$BATS_TEST_TMPDIR/herdr"
  local orca="$BATS_TEST_TMPDIR/orca"
  make_ghq_repo "$repo"
  local days
  for days in 2 3; do
    mkdir -p "$repo/.worktrees/day-$days" "$orca/gone/day-$days"
    echo "gitdir: $BATS_TEST_TMPDIR/missing/.git/worktrees/day-$days" >"$orca/gone/day-$days/.git"
    touch -d "$days days ago" "$repo/.worktrees/day-$days" "$orca/gone/day-$days"
  done

  run bash "${SRC%/*}/worktree-gc.sh" --diagnose --repo "$repo" --roots .worktrees
  assert_success
  assert_output --partial $'remove-candidate\torphan\tin-root\t-\t'"$repo/.worktrees/day-3"
  assert_output --partial $'keep\tyoung\tin-root\t-\t'"$repo/.worktrees/day-2"

  run bash "$SRC" --diagnose --ghq-root "$ghq_root" --herdr-root "$herdr" --orca-root "$orca"
  assert_success
  assert_output --partial "$repo/.worktrees/day-3"
  assert_output --partial "$orca/gone/day-3"
  refute_output --partial "$repo/.worktrees/day-2"
  refute_output --partial "$orca/gone/day-2"
}

@test "dangling_candidates: 改行を含むディレクトリ名は候補にせず、相対パス断片も出さない" {
  local root="$BATS_TEST_TMPDIR/root" cwd="$BATS_TEST_TMPDIR/cwd"
  mkdir -p "$root/repo/$(printf 'a\nvictim')" "$root/repo/ok" "$cwd/victim"
  echo "gitdir: /nonexistent/x" >"$cwd/victim/.git"
  echo "gitdir: /nonexistent/x" >"$root/repo/ok/.git"
  cd "$cwd"
  run_pure_function dangling_candidates "$root"
  assert_success
  assert_line "$root/repo/ok"
  refute_line "victim"
}

@test "remove_dangling_dir: 祖先が root 外への symlink に差し替わっていたら外部を削除しない" {
  local root="$BATS_TEST_TMPDIR/root" outside="$BATS_TEST_TMPDIR/outside"
  mkdir -p "$root" "$outside/victim"
  printf 'gitdir: /missing/parent/worktrees/victim\n' >"$outside/victim/.git"
  age_dir "$outside/victim"
  ln -s "$outside" "$root/repo"
  run_pure_function remove_dangling_dir "$root" "$root/repo/victim"
  assert_failure
  [ -d "$outside/victim" ]
}

@test "remove_dangling_dir: root 配下の通常のディレクトリは削除する" {
  local root="$BATS_TEST_TMPDIR/root"
  mkdir -p "$root/repo/wt"
  printf 'gitdir: /missing/parent/worktrees/wt\n' >"$root/repo/wt/.git"
  age_dir "$root/repo/wt"
  run_pure_function remove_dangling_dir "$root" "$root/repo/wt"
  assert_success
  [ ! -e "$root/repo/wt" ]
}
