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
