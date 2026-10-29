#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() { PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"; }

@test "raw Codex handoff keeps early turn events for only the requested thread and turn" {
  local base="$BATS_TEST_TMPDIR/handoff"
  mkdir -p "$base/bin" "$base/home" "$base/state"
  git init -q "$base/work"
  git -C "$base/work" config user.name Fixture
  git -C "$base/work" config user.email fixture@example.invalid
  git -C "$base/work" commit --allow-empty -qm 'test: handoff fixture'
  export RAW_HANDOFF_FAKE_SERVER="$PROJECT_ROOT/tests/helpers/fake-raw-codex-app-server.py"
  cat >"$base/bin/codex-worktree" <<'SH'
#!/usr/bin/env bash
exec python3 "$RAW_HANDOFF_FAKE_SERVER" "$@"
SH
  chmod +x "$base/bin/codex-worktree"

  local helper="$PROJECT_ROOT/tests/helpers/raw-codex-handoff.py"
  run python3 -c 'import runpy,sys; helper=sys.argv.pop(1); print("RAW_HANDOFF_FINAL_ANSWER=" + runpy.run_path(helper)["answer"])' "$helper" "$base"

  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [[ "$output" == *'HOSTED_RAW_TASK_OK HOSTED_RAW_OK'* ]]
  [[ "$output" == *'RAW_HANDOFF_FINAL_ANSWER=HOSTED_RAW_OK'* ]]
  [[ "$output" != *'OTHER_THREAD_MESSAGE'* ]]
  [[ "$output" != *'OLD_TURN_MESSAGE'* ]]
}
