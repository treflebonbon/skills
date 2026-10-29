#!/usr/bin/env bats
# skills/worktree-gc/scripts/worktree-gc.sh の is_older_than_days が
# GNU/BSD 両方の stat で正しく mtime を取得できるかを検証する（issue #42）。

load 'worktree_gc_test_helper'

readonly SRC="$BATS_TEST_DIRNAME/../skills/worktree-gc/scripts/worktree-gc.sh"

setup() {
  setup_test_env
}

gc_git() {
  env -i HOME="$BATS_TEST_TMPDIR/home" PATH="$PATH" git "$@"
}

setup_gc_repository() {
  GC_REPO="$BATS_TEST_TMPDIR/repo"
  GC_WORKTREE="$GC_REPO/.worktrees/topic"
  mkdir -p "$BATS_TEST_TMPDIR/home" "$GC_REPO"
  gc_git -C "$GC_REPO" init -q -b main
  gc_git -C "$GC_REPO" -c user.name=Test -c user.email=test@example.invalid \
    commit -q --allow-empty -m initial
  gc_git -C "$GC_REPO" worktree add -q -b topic "$GC_WORKTREE"
  stub_cmd gh
}

run_gc() {
  run env -i HOME="$BATS_TEST_TMPDIR/home" PATH="$TEST_BIN_DIR:$PATH" TEST_LOG="$TEST_LOG" \
    bash "$SRC" --repo "$GC_REPO" --roots .worktrees --age-days 0 "$@"
}

@test "GC の dry-run は一時的に参照できない worktree の管理情報を保持する" {
  setup_gc_repository
  mv "$GC_WORKTREE" "$BATS_TEST_TMPDIR/temporarily-unavailable"

  run_gc --dry-run

  assert_success
  mv "$BATS_TEST_TMPDIR/temporarily-unavailable" "$GC_WORKTREE"
  run gc_git -C "$GC_WORKTREE" rev-parse --show-toplevel
  assert_success
  assert_output "$GC_WORKTREE"
}

@test "コミットを検査できない GC は診断と apply の両方で停止して worktree を保持する" {
  setup_gc_repository
  gc_git -C "$GC_WORKTREE" -c user.name=Test -c user.email=test@example.invalid \
    commit -q --allow-empty -m unique
  run_gc --diagnose
  assert_success
  assert_output --partial 'unique-commit'
  printf '%s\n' ffffffffffffffffffffffffffffffffffffffff >"$GC_REPO/.git/refs/heads/broken"

  local mode
  for mode in --diagnose --apply; do
    run_gc "$mode"

    assert_failure
    [ -d "$GC_WORKTREE" ]
    refute_output --partial 'remove-candidate'
  done
}

@test "参照一覧の取得失敗を merge 済みという照会結果で上書きしない" {
  setup_gc_repository
  local real_git
  real_git=$(command -v git)
  cat >"$TEST_BIN_DIR/git" <<'SH'
#!/usr/bin/env bash
for argument in "$@"; do
  if [ "$argument" = for-each-ref ]; then
    exit 128
  fi
done
exec "$GC_REAL_GIT" "$@"
SH
  chmod +x "$TEST_BIN_DIR/git"
  gc_git -C "$GC_REPO" rev-parse topic >"$BATS_TEST_TMPDIR/merged-head"
  cat >"$TEST_BIN_DIR/gh" <<'SH'
#!/usr/bin/env bash
case "$*" in
*'--state merged'*) cat "$GC_MERGED_HEAD" ;;
esac
SH
  chmod +x "$TEST_BIN_DIR/gh"

  local mode
  for mode in --diagnose --apply; do
    run env -i HOME="$BATS_TEST_TMPDIR/home" PATH="$TEST_BIN_DIR:$PATH" \
      GC_REAL_GIT="$real_git" GC_MERGED_HEAD="$BATS_TEST_TMPDIR/merged-head" \
      bash "$SRC" --repo "$GC_REPO" --roots .worktrees --age-days 0 "$mode"

    assert_failure
    [ -d "$GC_WORKTREE" ]
  done
}

@test "検査が成功した clean な worktree は診断と apply で回収できる" {
  setup_gc_repository

  run_gc --diagnose
  assert_success
  assert_output --partial 'remove-candidate'
  run_gc --apply
  assert_success
  [ ! -d "$GC_WORKTREE" ]
  run gc_git -C "$GC_REPO" worktree list --porcelain
  assert_success
  refute_output --partial "$GC_WORKTREE"
}

@test "preview 後に未追跡ファイルが加わった worktree は apply で保持する" {
  setup_gc_repository

  run_gc --diagnose
  assert_success
  assert_output --partial 'remove-candidate'

  printf '%s\n' changed >"$GC_WORKTREE/after-preview.txt"
  run_gc --apply

  assert_success
  [ -f "$GC_WORKTREE/after-preview.txt" ]
  refute_output --partial 'removing:'
}

@test "repo-local 公開入口は checkout 外の作業ディレクトリから利用できる" {
  setup_gc_repository
  cd "$BATS_TEST_TMPDIR"

  run_gc --diagnose

  assert_success
  assert_output --partial "$GC_WORKTREE"
}

@test "repo-local CLI は Nix を含まない system PATH で preview できる" {
  setup_gc_repository

  run /usr/bin/env -i HOME="$BATS_TEST_TMPDIR/home" \
    PATH="$TEST_BIN_DIR:/usr/bin:/bin" TEST_LOG="$TEST_LOG" \
    /bin/bash "$SRC" --diagnose --repo "$GC_REPO" --roots .worktrees --age-days 0

  assert_success
  assert_output --partial "$GC_WORKTREE"
}

@test "継承した Git 環境が別 repo を指しても対象 worktree の独自コミットを保護する" {
  setup_gc_repository
  gc_git -C "$GC_WORKTREE" -c user.name=Test -c user.email=test@example.invalid \
    commit -q --allow-empty -m unique
  local foreign="$BATS_TEST_TMPDIR/foreign" mode
  mkdir -p "$foreign"
  gc_git -C "$foreign" init -q -b main
  gc_git -C "$foreign" -c user.name=Test -c user.email=test@example.invalid \
    commit -q --allow-empty -m foreign

  for mode in --diagnose --apply; do
    run env -i HOME="$BATS_TEST_TMPDIR/home" PATH="$TEST_BIN_DIR:$PATH" TEST_LOG="$TEST_LOG" \
      GIT_DIR="$foreign/.git" GIT_WORK_TREE="$foreign" GIT_COMMON_DIR="$foreign/.git" \
      GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0="$foreign" \
      bash "$SRC" --repo "$GC_REPO" --roots .worktrees --age-days 0 "$mode"

    assert_success
    refute_output --partial 'remove-candidate'
    [ -d "$GC_WORKTREE" ]
  done
}

# BSD/macOS の stat（`-f FORMAT`）のみ受け付け、GNU の `-c` は拒否するスタブ。
# mtime は 2001-09-09 (epoch 1000000000) 固定 — どんな --age-days 閾値より
# 確実に「古い」ことを保証する。
stub_bsd_stat() {
  cat >"$TEST_BIN_DIR/stat" <<'STUB_EOF'
#!/bin/bash
echo "$0 $*" >> "$TEST_LOG"
if [ "$1" = "-c" ]; then
  echo "stat: illegal option -- c" >&2
  exit 1
fi
if [ "$1" = "-f" ]; then
  echo "1000000000"
  exit 0
fi
exit 1
STUB_EOF
  chmod +x "$TEST_BIN_DIR/stat"
}

run_is_older_than_days() {
  local path="$1" days="$2"
  run /usr/bin/env -i \
    PATH="$TEST_BIN_DIR:/usr/bin:/bin" \
    TEST_LOG="$TEST_LOG" \
    /bin/bash -c "
      $(extract_function "$SRC" is_older_than_days)
      is_older_than_days '$path' '$days'
    "
}

@test "BSD stat (-f) でも古いパスを古いと判定する" {
  stub_bsd_stat
  run_is_older_than_days "/tmp/whatever" 7
  assert_success
}

@test "GNU stat (-c) では従来通り古いパスを古いと判定する（回帰なし）" {
  stub_real_cmd stat
  stub_real_cmd date
  local old_path="$BATS_TEST_TMPDIR/old-dir"
  mkdir -p "$old_path"
  touch -d '2001-09-09' "$old_path"
  run_is_older_than_days "$old_path" 7
  assert_success
}

@test "GC は repo 内 root が外部への symlink でも外部の子を削除しない" {
  setup_gc_repository
  mkdir -p "$BATS_TEST_TMPDIR/outside/victim"
  gc_git -C "$GC_REPO" worktree remove --force "$GC_WORKTREE"
  rm -rf "$GC_REPO/.worktrees"
  ln -s "$BATS_TEST_TMPDIR/outside" "$GC_REPO/.worktrees"

  run_gc --apply

  [ -d "$BATS_TEST_TMPDIR/outside/victim" ]
}

@test "GC は末尾 / 付きの安全な root でも孤立 directory を掃除する" {
  setup_gc_repository
  mkdir -p "$GC_REPO/.worktrees/orphan"

  run env -i HOME="$BATS_TEST_TMPDIR/home" PATH="$TEST_BIN_DIR:$PATH" TEST_LOG="$TEST_LOG" \
    bash "$SRC" --repo "$GC_REPO" --roots .worktrees/ --age-days 0 --apply

  assert_success
  [ ! -d "$GC_REPO/.worktrees/orphan" ]
}

@test "GC は改行を含む孤立 directory を sweep でも診断でも対象にしない" {
  setup_gc_repository
  mkdir -p "$GC_REPO/.worktrees/$(printf 'a\nb')"

  run_gc --diagnose
  assert_success
  refute_output --partial "remove-candidate	orphan"

  run_gc --apply
  assert_success
  [ -d "$GC_REPO/.worktrees/$(printf 'a\nb')" ]
}
