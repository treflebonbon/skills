#!/usr/bin/env bats

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$PROJECT_ROOT/bin/git-push-topic"
  MOCK_BIN="$BATS_TEST_TMPDIR/bin"
  MOCK_LOG="$BATS_TEST_TMPDIR/git.log"
  mkdir -p "$MOCK_BIN"
  REVIEWED_SCRIPT="$PROJECT_ROOT/bin/git-push-reviewed"

  cat >"$MOCK_BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "$*" in
"branch --show-current")
  printf '%s\n' "$MOCK_BRANCH"
  ;;
"ls-remote --symref origin HEAD")
  [ -n "${MOCK_DEFAULT:-}" ] || exit 1
  printf 'ref: refs/heads/%s\tHEAD\n' "$MOCK_DEFAULT"
  [ "${MOCK_NO_TIP:-}" = 1 ] || printf 'remotesha\tHEAD\n'
  ;;
"rev-parse --is-shallow-repository")
  printf '%s\n' "${MOCK_SHALLOW:-false}"
  ;;
"fetch -q origin refs/heads/$MOCK_DEFAULT")
  [ "${MOCK_FETCH_FAILS:-}" != 1 ]
  ;;
"merge-base --is-ancestor HEAD remotesha")
  case "${MOCK_ANCESTOR:-no}" in
  yes) exit 0 ;;
  no) exit 1 ;;
  *) exit 128 ;;
  esac
  ;;
"remote get-url origin")
  printf 'https://github.com/example/repo.git\n'
  ;;
"cat-file -e mergedsha^{commit}" | "cat-file -e mergecommit^{commit}")
  [ "${MOCK_OBJECTS_MISSING:-}" != 1 ]
  ;;
"merge-base --is-ancestor mergedsha HEAD")
  case "${MOCK_MERGED_ANCESTOR:-no}" in
  yes) exit 0 ;;
  no) exit 1 ;;
  *) exit 128 ;;
  esac
  ;;
"merge-base --is-ancestor mergecommit HEAD")
  case "${MOCK_MERGE_COMMIT_ANCESTOR:-no}" in
  yes) exit 0 ;;
  no) exit 1 ;;
  *) exit 128 ;;
  esac
  ;;
"push -u origin HEAD")
  printf '%s\n' "$*" >>"$MOCK_LOG"
  ;;
*)
  printf 'unexpected git invocation: %s\n' "$*" >&2
  exit 2
  ;;
esac
EOF
  chmod +x "$MOCK_BIN/git"

  cat >"$MOCK_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[ "${MOCK_GH_FAILS:-}" != 1 ] || exit 1
[ "$*" = 'pr list --repo https://github.com/example/repo.git --head '"$MOCK_BRANCH"' --state merged --limit 1000 --json headRefOid,mergeCommit --jq .[] | "\(.headRefOid) \(.mergeCommit.oid // "")"' ] || {
  printf 'unexpected gh invocation: %s\n' "$*" >&2
  exit 2
}
if [ "${MOCK_GH_TRUNCATED:-}" = 1 ]; then
  yes 'othersha othermerge' | head -n 1000
elif [ -n "${MOCK_MERGED_PRS:-}" ]; then
  printf '%s\n' "$MOCK_MERGED_PRS"
fi
EOF
  chmod +x "$MOCK_BIN/gh"
}

@test "git-push-topic publishes only the current non-default branch" {
  run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="feat/example" MOCK_DEFAULT="main" \
    MOCK_LOG="$MOCK_LOG" "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(cat "$MOCK_LOG")" = "push -u origin HEAD" ]
}

@test "git-push-topic rejects default branches" {
  run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="main" MOCK_DEFAULT="main" \
    MOCK_LOG="$MOCK_LOG" "$SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$MOCK_LOG" ]

  run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="trunk" MOCK_DEFAULT="trunk" \
    MOCK_LOG="$MOCK_LOG" "$SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$MOCK_LOG" ]
}

@test "git-push-topic fails closed when the remote default branch is unknown" {
  run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="feat/example" MOCK_DEFAULT="" \
    MOCK_LOG="$MOCK_LOG" bash "$SCRIPT"

  [ "$status" -ne 0 ]
  [ ! -e "$MOCK_LOG" ]
}

@test "git-push-reviewed permits a confirmed non-force default-branch push" {
  run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="main" MOCK_DEFAULT="main" \
    MOCK_LOG="$MOCK_LOG" "$REVIEWED_SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(cat "$MOCK_LOG")" = "push -u origin HEAD" ]
}

@test "git-push-reviewed rejects a non-default branch" {
  run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="release/example" MOCK_DEFAULT="main" \
    MOCK_LOG="$MOCK_LOG" "$REVIEWED_SCRIPT"

  [ "$status" -ne 0 ]
  [ ! -e "$MOCK_LOG" ]
}

@test "git-push-reviewed resolves the shared body from outside the package directory" {
  run env PATH="$MOCK_BIN:/usr/bin:/bin" MOCK_BRANCH="main" MOCK_DEFAULT="main" \
    MOCK_LOG="$MOCK_LOG" bash -c 'cd "$1" && exec "$2"' _ \
    "$BATS_TEST_TMPDIR" "$REVIEWED_SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(cat "$MOCK_LOG")" = "push -u origin HEAD" ]
}

@test "git-push-reviewed preserves arguments for the shared body to reject" {
  run env PATH="$MOCK_BIN:/usr/bin:/bin" MOCK_BRANCH="main" MOCK_DEFAULT="main" \
    MOCK_LOG="$MOCK_LOG" "$REVIEWED_SCRIPT" --force

  [ "$status" -eq 2 ]
  [ ! -e "$MOCK_LOG" ]
}

@test "git-push-topic rejects a branch with no commits beyond the default branch" {
  run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="feat/example" MOCK_DEFAULT="main" \
    MOCK_ANCESTOR=yes MOCK_LOG="$MOCK_LOG" "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"no commits"* ]]
  [ ! -e "$MOCK_LOG" ]
}

@test "git-push-topic fails closed when HEAD cannot be compared with the default branch tip" {
  for variable in MOCK_FETCH_FAILS=1 MOCK_NO_TIP=1 MOCK_ANCESTOR=error MOCK_SHALLOW=true; do
    run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="feat/example" MOCK_DEFAULT="main" \
      "$variable" MOCK_LOG="$MOCK_LOG" "$SCRIPT"

    [ "$status" -ne 0 ]
    [ ! -e "$MOCK_LOG" ]
  done
}

@test "git-push-topic rejects new commits on a branch whose PR is already merged" {
  run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="feat/example" MOCK_DEFAULT="main" \
    MOCK_MERGED_PRS="mergedsha mergecommit" MOCK_MERGED_ANCESTOR=yes MOCK_LOG="$MOCK_LOG" "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"already merged"* ]]
  [ ! -e "$MOCK_LOG" ]
}

@test "git-push-topic allows a reused branch name that does not contain the merged PR head" {
  run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="feat/example" MOCK_DEFAULT="main" \
    MOCK_MERGED_PRS="mergedsha mergecommit" MOCK_MERGED_ANCESTOR=no MOCK_LOG="$MOCK_LOG" "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(cat "$MOCK_LOG")" = "push -u origin HEAD" ]
}

@test "git-push-topic allows a branch cut from the default branch after the merge" {
  # A merge-commit merge keeps the old head in the default branch's history, so the merge commit marks a new branch.
  run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="feat/example" MOCK_DEFAULT="main" \
    MOCK_MERGED_PRS="mergedsha mergecommit" MOCK_MERGED_ANCESTOR=yes MOCK_MERGE_COMMIT_ANCESTOR=yes \
    MOCK_LOG="$MOCK_LOG" "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(cat "$MOCK_LOG")" = "push -u origin HEAD" ]
}

@test "git-push-topic allows a merged PR whose objects are not in this clone" {
  # An object this clone never had cannot be in HEAD's history.
  run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="feat/example" MOCK_DEFAULT="main" \
    MOCK_MERGED_PRS="mergedsha mergecommit" MOCK_OBJECTS_MISSING=1 MOCK_LOG="$MOCK_LOG" "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(cat "$MOCK_LOG")" = "push -u origin HEAD" ]
}

@test "git-push-topic fails closed when merged PRs cannot be checked" {
  for variable in MOCK_GH_FAILS=1 MOCK_GH_TRUNCATED=1 MOCK_MERGED_ANCESTOR=error MOCK_MERGE_COMMIT_ANCESTOR=error; do
    run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="feat/example" MOCK_DEFAULT="main" \
      MOCK_MERGED_PRS="mergedsha mergecommit" "$variable" MOCK_LOG="$MOCK_LOG" "$SCRIPT"

    [ "$status" -ne 0 ]
    [ ! -e "$MOCK_LOG" ]
  done
}

@test "git-push-topic fails closed without the GitHub CLI" {
  mkdir "$BATS_TEST_TMPDIR/no-gh"
  for command_name in bash basename; do
    ln -s "$(type -P "$command_name")" "$BATS_TEST_TMPDIR/no-gh/$command_name"
  done
  ln -s "$MOCK_BIN/git" "$BATS_TEST_TMPDIR/no-gh/git"

  run env PATH="$BATS_TEST_TMPDIR/no-gh" MOCK_BRANCH="feat/example" MOCK_DEFAULT="main" \
    MOCK_LOG="$MOCK_LOG" "$SCRIPT"

  [ "$status" -ne 0 ]
  [ ! -e "$MOCK_LOG" ]
}

@test "git-push-topic queries origin's repository regardless of GH_REPO" {
  run env PATH="$MOCK_BIN:$PATH" GH_REPO="other/repo" MOCK_BRANCH="feat/example" MOCK_DEFAULT="main" \
    MOCK_LOG="$MOCK_LOG" "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(cat "$MOCK_LOG")" = "push -u origin HEAD" ]
}

@test "git-push-reviewed does not run the topic-branch guards on the default branch" {
  run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="main" MOCK_DEFAULT="main" \
    MOCK_ANCESTOR=yes MOCK_MERGED_PRS="mergedsha mergecommit" MOCK_MERGED_ANCESTOR=yes MOCK_GH_FAILS=1 \
    MOCK_LOG="$MOCK_LOG" "$REVIEWED_SCRIPT"

  [ "$status" -eq 0 ]
  [ "$(cat "$MOCK_LOG")" = "push -u origin HEAD" ]
}

@test "git-push-topic rejects arguments and detached HEAD" {
  run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="feat/example" MOCK_DEFAULT="main" \
    MOCK_LOG="$MOCK_LOG" "$SCRIPT" --force
  [ "$status" -eq 2 ]
  [ ! -e "$MOCK_LOG" ]

  run env PATH="$MOCK_BIN:$PATH" MOCK_BRANCH="" MOCK_DEFAULT="main" \
    MOCK_LOG="$MOCK_LOG" "$SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$MOCK_LOG" ]
}
