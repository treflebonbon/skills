# `run` assigns these names in Bats before each assertion.
# shellcheck disable=SC2154
assert_success() {
  if [ "$status" -ne 0 ]; then
    printf 'expected success, got status %s\n%s\n' "$status" "$output" >&2
    return 1
  fi
}

assert_failure() {
  if [ "$status" -eq 0 ]; then
    printf 'expected failure, got success\n%s\n' "$output" >&2
    return 1
  fi
}

assert_output() {
  local mode=exact expected
  if [ "${1:-}" = --partial ]; then
    mode=partial
    shift
  fi
  expected="${1:-}"
  if [ "$mode" = partial ]; then
    [[ "$output" == *"$expected"* ]] && return 0
  else
    [ "$output" = "$expected" ] && return 0
  fi
  printf 'expected %s output %q, got:\n%s\n' "$mode" "$expected" "$output" >&2
  return 1
}

refute_output() {
  local mode=exact expected
  if [ "${1:-}" = --partial ]; then
    mode=partial
    shift
  fi
  expected="${1:-}"
  if [ "$mode" = partial ]; then
    [[ "$output" != *"$expected"* ]] && return 0
  else
    [ "$output" != "$expected" ] && return 0
  fi
  printf 'did not expect %s output %q\n' "$mode" "$expected" >&2
  return 1
}

assert_line() {
  local index=-1 expected
  if [ "${1:-}" = --index ]; then
    index="$2"
    shift 2
  fi
  expected="${1:-}"
  if [ "$index" -ge 0 ]; then
    local actual
    actual="$(printf '%s\n' "$output" | sed -n "$((index + 1))p")"
    [ "$actual" = "$expected" ] && return 0
  else
    grep -F -x -q -- "$expected" <<<"$output" && return 0
  fi
  printf 'expected output line %q, got:\n%s\n' "$expected" "$output" >&2
  return 1
}

refute_line() {
  local expected="${1:-}"
  if ! grep -F -x -q -- "$expected" <<<"$output"; then
    return 0
  fi
  printf 'did not expect output line %q\n' "$expected" >&2
  return 1
}

setup_test_env() {
  export TEST_BIN_DIR="$BATS_TEST_TMPDIR/bin"
  export TEST_LOG="$BATS_TEST_TMPDIR/calls.log"
  mkdir -p "$TEST_BIN_DIR"
  : >"$TEST_LOG"
  export SHELL=/bin/bash
}

stub_cmd() {
  local name="$1" exit_code="${2:-0}"
  # shellcheck disable=SC2016
  printf '#!/usr/bin/env bash\necho "$0 $*" >> "$TEST_LOG"\nexit %s\n' "$exit_code" >"$TEST_BIN_DIR/$name"
  chmod +x "$TEST_BIN_DIR/$name"
}

system_cmd_path() {
  command -v "$1"
}

stub_real_cmd() {
  local name="$1" path
  path=$(system_cmd_path "$name")
  # shellcheck disable=SC2016
  printf '#!/usr/bin/env bash\necho "$0 $*" >> "$TEST_LOG"\nexec %q "$@"\n' "$path" >"$TEST_BIN_DIR/$name"
  chmod +x "$TEST_BIN_DIR/$name"
}

extract_function() {
  local file="$1" name="$2"
  awk -v name="$name" '$0 ~ "^" name "\\(\\) \\{" { found=1 } found { print } found && /^}/ { exit }' "$file"
}
