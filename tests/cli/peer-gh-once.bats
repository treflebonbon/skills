#!/usr/bin/env bats

# Fake gh only: no GitHub write happens. The fake keeps issues and comments in
# FAKE_DIR/issues.json; FAKE_LOSE=1 makes a write succeed server-side and then
# fail on the client (the response is lost).

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../../skills/herdr-peer-refactor/scripts/gh-once.sh"
  FAKE_DIR="$BATS_TEST_TMPDIR/fake"
  mkdir -p "$FAKE_DIR/bin"
  export FAKE_DIR
  echo '[]' >"$FAKE_DIR/issues.json"
  printf 'body text\n' >"$BATS_TEST_TMPDIR/body.md"
  cp "$BATS_TEST_DIRNAME/fixtures/fake-gh" "$FAKE_DIR/bin/gh"
  chmod +x "$FAKE_DIR/bin/gh"
  PATH="$FAKE_DIR/bin:$PATH"
}

issues() { jq length "$FAKE_DIR/issues.json"; }
writes() { grep -cE '^issue (create|comment)' "$FAKE_DIR/calls.log" || true; }

@test "issue: creates once and prints the number" {
  run bash "$SCRIPT" issue run1 c1 "title" "$BATS_TEST_TMPDIR/body.md"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
  [ "$(issues)" -eq 1 ]
}

@test "issue: a second call for the same run and candidate looks up and does not create" {
  bash "$SCRIPT" issue run1 c1 "title" "$BATS_TEST_TMPDIR/body.md"
  run bash "$SCRIPT" issue run1 c1 "title" "$BATS_TEST_TMPDIR/body.md"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
  [ "$(issues)" -eq 1 ]
  [ "$(writes)" -eq 1 ]
}

@test "issue: another candidate or another run is a different artifact" {
  bash "$SCRIPT" issue run1 c1 "t" "$BATS_TEST_TMPDIR/body.md"
  bash "$SCRIPT" issue run1 c2 "t" "$BATS_TEST_TMPDIR/body.md"
  bash "$SCRIPT" issue run2 c1 "t" "$BATS_TEST_TMPDIR/body.md"
  [ "$(issues)" -eq 3 ]
}

@test "issue: a lost response after the server created it is recovered by the lookup, not a resend" {
  FAKE_LOSE=1 run bash "$SCRIPT" issue run1 c1 "t" "$BATS_TEST_TMPDIR/body.md"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
  [ "$(issues)" -eq 1 ]
  run bash "$SCRIPT" issue run1 c1 "t" "$BATS_TEST_TMPDIR/body.md"
  [ "$(issues)" -eq 1 ]
}

@test "report: a retry after a lost response sends no second comment" {
  bash "$SCRIPT" issue run1 c1 "t" "$BATS_TEST_TMPDIR/body.md"
  FAKE_LOSE=1 run bash "$SCRIPT" report run1 1 "$BATS_TEST_TMPDIR/body.md"
  [ "$status" -eq 0 ]
  run bash "$SCRIPT" report run1 1 "$BATS_TEST_TMPDIR/body.md"
  [ "$status" -eq 0 ]
  [ "$(jq '.[0].comments|length' "$FAKE_DIR/issues.json")" -eq 1 ]
}

@test "report: a different run's report on the same issue is not mistaken for this one" {
  bash "$SCRIPT" issue run1 c1 "t" "$BATS_TEST_TMPDIR/body.md"
  bash "$SCRIPT" report run1 1 "$BATS_TEST_TMPDIR/body.md"
  bash "$SCRIPT" report run2 1 "$BATS_TEST_TMPDIR/body.md"
  [ "$(jq '.[0].comments|length' "$FAKE_DIR/issues.json")" -eq 2 ]
}

@test "a write that fails and leaves nothing behind exits 1 so the caller can resend" {
  FAKE_FAIL=1 run bash "$SCRIPT" issue run1 c1 "t" "$BATS_TEST_TMPDIR/body.md"
  [ "$status" -eq 1 ]
  [ "$(issues)" -eq 0 ]
}

@test "a failed lookup exits 3 (unknown) and never writes, so the caller does not resend" {
  FAKE_READFAIL=1 run bash "$SCRIPT" issue run1 c1 "t" "$BATS_TEST_TMPDIR/body.md"
  [ "$status" -eq 3 ]
  [ "$(issues)" -eq 0 ]
  [ "$(writes)" -eq 0 ]
}

@test "a lookup that fails after the write exits 3, not 1, even though the write may have landed" {
  FAKE_LOSE=1 FAKE_READFAIL_AFTER=1 run bash "$SCRIPT" issue run1 c1 "t" "$BATS_TEST_TMPDIR/body.md"
  [ "$status" -eq 3 ]
  [ "$(issues)" -eq 1 ]
}

@test "report: a non-numeric issue number is a usage error" {
  run bash "$SCRIPT" report run1 '1)}; x' "$BATS_TEST_TMPDIR/body.md"
  [ "$status" -eq 2 ]
}

@test "usage error exits 2" {
  run bash "$SCRIPT" issue run1
  [ "$status" -eq 2 ]
}

@test "issue: the lock lives in a private per-user directory" {
  export GH_ONCE_TEST_LOCK_BASE="$BATS_TEST_TMPDIR/locks"
  mkdir "$GH_ONCE_TEST_LOCK_BASE"
  run bash "$SCRIPT" issue run1 c1 "title" "$BATS_TEST_TMPDIR/body.md"
  [ "$status" -eq 0 ]
  [ "$(stat -c %a "$GH_ONCE_TEST_LOCK_BASE/gh-once-$(id -u)")" = 700 ]
}

@test "issue: a lock directory that is a symlink is refused and nothing is written" {
  export GH_ONCE_TEST_LOCK_BASE="$BATS_TEST_TMPDIR/locks"
  mkdir "$GH_ONCE_TEST_LOCK_BASE" "$BATS_TEST_TMPDIR/elsewhere"
  ln -s "$BATS_TEST_TMPDIR/elsewhere" "$GH_ONCE_TEST_LOCK_BASE/gh-once-$(id -u)"
  run bash "$SCRIPT" issue run1 c1 "title" "$BATS_TEST_TMPDIR/body.md"
  [ "$status" -eq 3 ]
  [ ! -f "$FAKE_DIR/calls.log" ] # gh was never reached
  [ -z "$(ls -A "$BATS_TEST_TMPDIR/elsewhere")" ]
}

@test "issue: a full list page without the marker is unknown, not absent" {
  jq -n '[range(1000) | {number: ., body: "other", comments: []}]' >"$FAKE_DIR/issues.json"
  run bash "$SCRIPT" issue run1 c1 "title" "$BATS_TEST_TMPDIR/body.md"
  [ "$status" -eq 3 ]
  [ "$(writes)" -eq 0 ]
}
