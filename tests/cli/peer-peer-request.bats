#!/usr/bin/env bats

# Mock herdr only: no real herdr, pane, or peer is touched.

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$PROJECT_ROOT/skills/herdr-peer-refactor/scripts/peer-request.sh"
  MOCK_DIR="$BATS_TEST_TMPDIR/mock"
  WORK="$BATS_TEST_TMPDIR/work"
  mkdir -p "$MOCK_DIR/bin" "$WORK"
  export MOCK_DIR
  printf 'review please\n' >"$BATS_TEST_TMPDIR/req.txt"
  SHA=abc1234

  # Behaviour per subcommand comes from files in MOCK_DIR:
  #   <cmd>.out / <cmd>.rc   stdout and exit code (default: empty, 0)
  #   <cmd>.hook             sourced first (e.g. to write the response file)
  cat >"$MOCK_DIR/bin/herdr" <<'EOF'
#!/usr/bin/env bash
cmd=$2
printf '%s\n' "$*" >>"$MOCK_DIR/calls.log"
n=$(($(cat "$MOCK_DIR/$cmd.n" 2>/dev/null || echo 0) + 1))
echo "$n" >"$MOCK_DIR/$cmd.n"
[ -f "$MOCK_DIR/$cmd.$n.hook" ] && . "$MOCK_DIR/$cmd.$n.hook"
if [ -f "$MOCK_DIR/$cmd.$n.out" ]; then cat "$MOCK_DIR/$cmd.$n.out"; else cat "$MOCK_DIR/$cmd.out" 2>/dev/null || true; fi
if [ -f "$MOCK_DIR/$cmd.$n.rc" ]; then exit "$(cat "$MOCK_DIR/$cmd.$n.rc")"; fi
exit "$(cat "$MOCK_DIR/$cmd.rc" 2>/dev/null || echo 0)"
EOF
  chmod +x "$MOCK_DIR/bin/herdr"
  PATH="$MOCK_DIR/bin:$PATH"
  export WORK
  export PEER_SETTLE_S=0
}

run_helper() { run bash "$SCRIPT" peer REQ-1 "$SHA" "$WORK" "$BATS_TEST_TMPDIR/req.txt" "$@"; }
write_resp() { printf '%s\nbody\n' "$1" >"$WORK/REQ-1.md"; }
export -f write_resp
calls() { cat "$MOCK_DIR/calls.log" 2>/dev/null || true; }

@test "done: valid response file after prompt returns" {
  echo 'write_resp "DONE REQ-1 abc1234"' >"$MOCK_DIR/prompt.1.hook"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  run_helper
  [ "$status" -eq 0 ]
  [ "$output" = "$WORK/REQ-1.md" ]
  # the prompt carries the ID, SHA and the response path
  calls | grep -F 'Request ID: REQ-1' | head -1 >/dev/null
  calls | grep -Fq "$WORK/REQ-1.md"
}

@test "idle without response file is not done (missing)" {
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/get.out"
  run_helper
  [ "$status" -eq 12 ]
  [[ "$output" == *missing* ]]
}

@test "same failure twice holds the candidate" {
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/get.out"
  run_helper
  [ "$status" -eq 12 ]
  run_helper
  [ "$status" -eq 13 ]
}

@test "response with a wrong SHA or ID is not done" {
  echo 'write_resp "DONE REQ-1 deadbee"' >"$MOCK_DIR/prompt.1.hook"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/get.out"
  run_helper
  [ "$status" -eq 12 ]
}

@test "a wrong-SHA reply twice for one request holds (same kind as a missing reply)" {
  echo 'write_resp "DONE REQ-1 deadbee"' >"$MOCK_DIR/prompt.1.hook"
  echo 'write_resp "DONE REQ-1 deadbee"' >"$MOCK_DIR/prompt.2.hook"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/get.out"
  run_helper
  [ "$status" -eq 12 ]
  run_helper
  [ "$status" -eq 13 ]
}

@test "a reply whose first line lacks the SHA is the same failure kind as a wrong SHA" {
  echo 'write_resp "DONE REQ-1"' >"$MOCK_DIR/prompt.1.hook"
  echo 'write_resp "DONE REQ-1 deadbee"' >"$MOCK_DIR/prompt.2.hook"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/get.out"
  run_helper
  [ "$status" -eq 12 ]
  run_helper
  [ "$status" -eq 13 ]
}

@test "a re-ask keeps the request ID and SHA and accepts the corrected reply" {
  echo 'write_resp "DONE REQ-1 deadbee"' >"$MOCK_DIR/prompt.1.hook"
  echo 'write_resp "DONE REQ-1 abc1234"' >"$MOCK_DIR/prompt.2.hook"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/get.out"
  run_helper
  [ "$status" -eq 12 ]
  run_helper
  [ "$status" -eq 0 ]
  [ "$(calls | grep -c 'Target SHA: abc1234')" -eq 2 ]
}

@test "early return from an old turn: keeps waiting until the file appears" {
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"working"}' >"$MOCK_DIR/get.out"
  echo 'write_resp "DONE REQ-1 abc1234"' >"$MOCK_DIR/wait.1.hook"
  run_helper
  [ "$status" -eq 0 ]
  calls | grep -q '^agent wait peer'
}

@test "blocked from prompt is held without retry" {
  echo '{"agent_status":"blocked"}' >"$MOCK_DIR/prompt.out"
  run_helper
  [ "$status" -eq 11 ]
  [ "$(calls | grep -c '^agent prompt')" -eq 1 ]
}

@test "agent_blocked rejection at send is held" {
  echo '{"error":{"code":"agent_blocked","message":"agent peer is blocked and requires interactive input"}}' >"$MOCK_DIR/prompt.out"
  echo 1 >"$MOCK_DIR/prompt.rc"
  run_helper
  [ "$status" -eq 11 ]
}

@test "blocked right after idle (approval dialog) is held, not done" {
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"blocked"}' >"$MOCK_DIR/get.out"
  run_helper
  [ "$status" -eq 11 ]
  [ "$(calls | grep -c '^agent prompt')" -eq 1 ]
}

@test "timeout returns the per-peer timeout code and accounts the wait" {
  echo '{"error":{"code":"timeout","message":"timed out waiting for agent"}}' >"$MOCK_DIR/prompt.out"
  echo 1 >"$MOCK_DIR/prompt.rc"
  run_helper
  [ "$status" -eq 10 ]
  [ -f "$WORK/waited-s" ]
}

@test "timeout passed to herdr is the 20 minute per-peer limit" {
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo 'write_resp "DONE REQ-1 abc1234"' >"$MOCK_DIR/prompt.1.hook"
  run_helper
  [ "$status" -eq 0 ]
  calls | grep -Eq -- '--timeout (119[0-9]{4}|1200000)$'
}

@test "total wait budget (2 h) inherited by a successor holds the candidate" {
  echo 7200 >"$WORK/waited-s"
  run_helper
  [ "$status" -eq 14 ]
  [ ! -f "$MOCK_DIR/calls.log" ]
}

@test "remaining total budget caps the per-peer timeout" {
  echo 7000 >"$WORK/waited-s"
  echo 'write_resp "DONE REQ-1 abc1234"' >"$MOCK_DIR/prompt.1.hook"
  run_helper
  [ "$status" -eq 0 ]
  calls | grep -Eq -- '--timeout (19[0-9]{4}|200000)$'
}

@test "fourth Review Round is held" {
  run_helper 4
  [ "$status" -eq 14 ]
}

@test "resume: an existing valid response is accepted without sending again" {
  write_resp "DONE REQ-1 abc1234"
  run_helper
  [ "$status" -eq 0 ]
  [ ! -f "$MOCK_DIR/calls.log" ]
}

@test "resume: a stale response for an older SHA is discarded and re-requested" {
  write_resp "DONE REQ-1 oldsha0"
  echo 'write_resp "DONE REQ-1 abc1234"' >"$MOCK_DIR/prompt.1.hook"
  run_helper
  [ "$status" -eq 0 ]
  [ "$(calls | grep -c '^agent prompt')" -eq 1 ]
}

@test "prompt_stalled (work never started) is not done" {
  echo '{"error":{"code":"agent_prompt_stalled","message":"no agent activity observed after submission"}}' >"$MOCK_DIR/prompt.out"
  echo 1 >"$MOCK_DIR/prompt.rc"
  run_helper
  [ "$status" -eq 12 ]
  [[ "$output" == *stalled* ]]
}

@test "the word working in a non-status field does not make an idle peer working" {
  echo '{"agent_status":"idle","terminal_title":"working on the migration"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"idle","terminal_title":"working on the migration"}' >"$MOCK_DIR/get.out"
  run timeout 20 bash "$SCRIPT" peer REQ-1 "$SHA" "$WORK" "$BATS_TEST_TMPDIR/req.txt"
  [ "$status" -eq 12 ]
  [[ "$output" == *missing* ]]
}

@test "the word blocked in a non-status field is not a block" {
  echo '{"agent_status":"idle","terminal_title":"unblock the blocked deps"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"idle","terminal_title":"unblock the blocked deps"}' >"$MOCK_DIR/get.out"
  run timeout 20 bash "$SCRIPT" peer REQ-1 "$SHA" "$WORK" "$BATS_TEST_TMPDIR/req.txt"
  [ "$status" -eq 12 ]
  [[ "$output" == *missing* ]]
}

@test "real herdr error bodies map to the same exit codes" {
  echo '{"error":{"code":"agent_blocked","message":"agent peer is blocked and requires interactive input"}}' >"$MOCK_DIR/prompt.out"
  echo 1 >"$MOCK_DIR/prompt.rc"
  run_helper
  [ "$status" -eq 11 ]

  rm -rf "$WORK" "$MOCK_DIR/calls.log" "$MOCK_DIR"/*.n
  mkdir -p "$WORK"
  echo '{"error":{"code":"timeout","message":"timed out waiting for agent"}}' >"$MOCK_DIR/prompt.out"
  run_helper
  [ "$status" -eq 10 ]
}

@test "the wait is added to the saved total, not just recorded" {
  echo 100 >"$WORK/waited-s"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo 'sleep 3; write_resp "DONE REQ-1 abc1234"' >"$MOCK_DIR/prompt.1.hook"
  run_helper
  [ "$status" -eq 0 ]
  # the clock has 1 s granularity and can step under load: allow 1 s of slack
  [ "$(cat "$WORK/waited-s")" -ge 102 ]
}

@test "an interrupted helper still saves the time it waited" {
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo 'sleep 8' >"$MOCK_DIR/prompt.1.hook"
  bash "$SCRIPT" peer REQ-1 "$SHA" "$WORK" "$BATS_TEST_TMPDIR/req.txt" >/dev/null 2>&1 &
  local pid=$!
  sleep 3
  kill -TERM "$pid"
  wait "$pid" || true
  # about 3 s elapsed; allow 1 s of slack for the clock granularity
  [ "$(cat "$WORK/waited-s")" -ge 2 ]
}

@test "a second helper on the same workdir is refused instead of overwriting the ledger" {
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo 'sleep 6' >"$MOCK_DIR/prompt.1.hook"
  bash "$SCRIPT" peer REQ-1 "$SHA" "$WORK" "$BATS_TEST_TMPDIR/req.txt" >/dev/null 2>&1 &
  local pid=$!
  sleep 2
  run bash "$SCRIPT" peer REQ-1 "$SHA" "$WORK" "$BATS_TEST_TMPDIR/req.txt"
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  [ "$status" -eq 15 ]
}

@test "reaching the total wait during a timed-out wait holds instead of allowing a successor" {
  echo 7199 >"$WORK/waited-s"
  echo 'sleep 3' >"$MOCK_DIR/prompt.1.hook"
  echo '{"error":{"code":"timeout","message":"timed out waiting for agent"}}' >"$MOCK_DIR/prompt.out"
  echo 1 >"$MOCK_DIR/prompt.rc"
  run_helper
  [ "$status" -eq 14 ]
}

@test "an unreadable peer state is held, not re-sent" {
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo 'Operation not permitted' >"$MOCK_DIR/get.out"
  echo 1 >"$MOCK_DIR/get.rc"
  run_helper
  [ "$status" -eq 15 ]
  [ "$(calls | grep -c '^agent prompt')" -eq 1 ]
}

@test "an orphan child of herdr does not keep the workdir locked after the helper exits" {
  echo 'sleep 20 >/dev/null 2>&1 & echo $! >"$MOCK_DIR/child.pid"' >"$MOCK_DIR/prompt.1.hook"
  echo '{"error":{"code":"timeout","message":"timed out waiting for agent"}}' >"$MOCK_DIR/prompt.out"
  echo 1 >"$MOCK_DIR/prompt.rc"
  run_helper
  [ "$status" -eq 10 ]
  run_helper
  local second=$status
  kill "$(cat "$MOCK_DIR/child.pid")" 2>/dev/null || true
  [ "$second" -ne 15 ]
}

@test "reaching the total wait on the settle path holds instead of allowing a re-ask" {
  echo 7199 >"$WORK/waited-s"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo 'sleep 2' >"$MOCK_DIR/prompt.1.hook"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/get.out"
  run_helper
  [ "$status" -eq 14 ]
}

@test "an unknown peer state is held, not treated as a missing reply" {
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"unknown"}' >"$MOCK_DIR/get.out"
  run_helper
  [ "$status" -eq 15 ]
  [ "$(calls | grep -c '^agent prompt')" -eq 1 ]
}

@test "the lock does not depend on a flock command (macOS has none)" {
  printf '#!/usr/bin/env bash\nexit 99\n' >"$MOCK_DIR/bin/flock"
  chmod +x "$MOCK_DIR/bin/flock"
  echo 'write_resp "DONE REQ-1 abc1234"' >"$MOCK_DIR/prompt.1.hook"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  run_helper
  [ "$status" -eq 0 ]
}

@test "the same failure kind twice holds even with another failure in between" {
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/get.out"
  run_helper
  [ "$status" -eq 12 ]   # missing
  echo '{"error":{"code":"agent_prompt_stalled","message":"no activity"}}' >"$MOCK_DIR/prompt.out"
  echo 1 >"$MOCK_DIR/prompt.rc"
  run_helper
  [ "$status" -eq 12 ]   # stalled
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  rm -f "$MOCK_DIR/prompt.rc"
  run_helper
  [ "$status" -eq 13 ]   # missing again
}

@test "generic errors with different messages count as the same failure" {
  echo '{"error":{"code":"internal","message":"first"}}' >"$MOCK_DIR/prompt.out"
  echo 1 >"$MOCK_DIR/prompt.rc"
  run_helper
  [ "$status" -eq 12 ]
  echo '{"error":{"code":"internal","message":"second, different text"}}' >"$MOCK_DIR/prompt.out"
  run_helper
  [ "$status" -eq 13 ]
}

@test "a peer state that is not valid JSON is held even if it contains an idle status" {
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  printf '{"agent_status":"idle"' >"$MOCK_DIR/get.out"
  run_helper
  [ "$status" -eq 15 ]
  [ "$(calls | grep -c '^agent prompt')" -eq 1 ]
}

@test "an approval dialog that appears just after idle is caught by the settle re-check" {
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/get.1.out"
  echo '{"agent_status":"blocked"}' >"$MOCK_DIR/get.2.out"
  run_helper
  [ "$status" -eq 11 ]
}

@test "the same timeout twice for one request holds the candidate" {
  echo '{"error":{"code":"timeout","message":"timed out waiting for agent"}}' >"$MOCK_DIR/prompt.out"
  echo 1 >"$MOCK_DIR/prompt.rc"
  run_helper
  [ "$status" -eq 10 ]
  run_helper
  [ "$status" -eq 13 ]
}

@test "the Review Round never goes back down on a resumed run" {
  echo 'write_resp "DONE REQ-1 abc1234"' >"$MOCK_DIR/prompt.1.hook"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  run_helper 2
  [ "$status" -eq 0 ]
  [ "$(cat "$WORK/round")" -eq 2 ]
  rm -f "$WORK/REQ-1.md" "$MOCK_DIR/prompt.n"
  run_helper 1
  [ "$status" -eq 0 ]
  [ "$(cat "$WORK/round")" -eq 2 ]
}

@test "an omitted Review Round continues from the saved one and the cap still holds" {
  echo 3 >"$WORK/round"
  echo 'write_resp "DONE REQ-1 abc1234"' >"$MOCK_DIR/prompt.1.hook"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  run_helper
  [ "$status" -eq 0 ]
  [ "$(cat "$WORK/round")" -eq 3 ]
  run_helper 4
  [ "$status" -eq 0 ]  # a valid response is accepted before the round check (resume)
  rm -f "$WORK/REQ-1.md"
  run_helper 4
  [ "$status" -eq 14 ]
}

@test "the request tells the peer not to write the reply anywhere else" {
  echo 'write_resp "DONE REQ-1 abc1234"' >"$MOCK_DIR/prompt.1.hook"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  run_helper
  [ "$status" -eq 0 ]
  calls | grep -Fq 'Do not write the reply anywhere else'
}

@test "a valid response written at the timeout boundary is still accepted" {
  echo 'write_resp "DONE REQ-1 abc1234"' >"$MOCK_DIR/prompt.1.hook"
  echo '{"error":{"code":"timeout","message":"timed out waiting for agent"}}' >"$MOCK_DIR/prompt.out"
  echo 1 >"$MOCK_DIR/prompt.rc"
  run_helper
  [ "$status" -eq 0 ]
}

@test "a request ID that is a path is refused" {
  run bash "$SCRIPT" peer ../../x "$SHA" "$WORK" "$BATS_TEST_TMPDIR/req.txt"
  [ "$status" -eq 2 ]
  [ ! -f "$MOCK_DIR/calls.log" ]
}

@test "a long finished response is accepted on resume (no SIGPIPE under pipefail)" {
  { printf 'DONE REQ-1 abc1234\n'; head -c 200000 /dev/zero | tr '\0' x; } >"$WORK/REQ-1.md"
  run_helper
  [ "$status" -eq 0 ]
  [ ! -f "$MOCK_DIR/calls.log" ]
}

@test "a response with only the header line is not complete" {
  echo 'printf "DONE REQ-1 abc1234\n" >"$WORK/REQ-1.md"' >"$MOCK_DIR/prompt.1.hook"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/get.out"
  run_helper
  [ "$status" -eq 12 ]
  [[ "$output" == *missing* ]]
}

terminal_answer() {
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/prompt.out"
  echo '{"agent_status":"idle"}' >"$MOCK_DIR/get.out"
  printf '%s\n' "$@" >"$MOCK_DIR/read.out"
  export PEER_REQUEST_TEST_NONCE=n0nce1
}

@test "a terminal answer from a peer that cannot write the file is saved by the helper" {
  terminal_answer '› review please' \
    '  If you cannot write that path, answer with a line holding only DONE REQ-1 abc1234 n0nce1, then END REQ-1 n0nce1' \
    '• DONE REQ-1 abc1234 n0nce1' '  finding one' '  finding two' '  END REQ-1 n0nce1'
  run_helper
  [ "$status" -eq 0 ]
  [ "$output" = "$WORK/REQ-1.md" ]
  [ "$(head -n1 "$WORK/REQ-1.md")" = "DONE REQ-1 abc1234" ]
  grep -Fxq 'finding two' "$WORK/REQ-1.md"
  ! grep -q '^END' "$WORK/REQ-1.md"
}

@test "a complete terminal answer is saved even when the wait timed out or stalled" {
  local code
  for code in timeout agent_prompt_stalled; do
    rm -f "$WORK/REQ-1.md" "$WORK/REQ-1.failures"
    terminal_answer '• DONE REQ-1 abc1234 n0nce1' '  finding one' '  END REQ-1 n0nce1'
    echo "{\"error\":{\"code\":\"$code\",\"message\":\"x\"}}" >"$MOCK_DIR/prompt.out"
    echo 1 >"$MOCK_DIR/prompt.rc"
    run_helper
    [ "$status" -eq 0 ]
    [ "$output" = "$WORK/REQ-1.md" ]
    grep -Fxq 'finding one' "$WORK/REQ-1.md"
  done
}

@test "an incomplete terminal answer does not hide a timeout" {
  terminal_answer '• DONE REQ-1 abc1234 n0nce1' '  finding one'
  echo '{"error":{"code":"timeout","message":"x"}}' >"$MOCK_DIR/prompt.out"
  echo 1 >"$MOCK_DIR/prompt.rc"
  run_helper
  [ "$status" -eq 10 ]
  [ ! -e "$WORK/REQ-1.md" ]
}

@test "a timeout leaves the response file a peer may still be writing alone" {
  terminal_answer ''
  echo 'printf "DONE REQ-1 abc1234\npartial\n" >"$WORK/REQ-1.md.part"' >"$MOCK_DIR/prompt.1.hook"
  echo '{"error":{"code":"timeout","message":"x"}}' >"$MOCK_DIR/prompt.out"
  echo 1 >"$MOCK_DIR/prompt.rc"
  run_helper
  [ "$status" -eq 10 ]
  grep -Fxq 'partial' "$WORK/REQ-1.md.part"
}

@test "an unreadable terminal after a timeout or stall holds instead of allowing a re-ask" {
  local code
  for code in timeout agent_prompt_stalled; do
    rm -f "$WORK/REQ-1.failures"
    terminal_answer ''
    echo "{\"error\":{\"code\":\"$code\",\"message\":\"x\"}}" >"$MOCK_DIR/prompt.out"
    echo 1 >"$MOCK_DIR/prompt.rc"
    echo 1 >"$MOCK_DIR/read.rc"
    run_helper
    [ "$status" -eq 15 ]
    [ ! -e "$WORK/REQ-1.failures" ]
  done
}

@test "a response file that lands while the terminal is read is taken after a timeout" {
  terminal_answer ''
  echo 'write_resp "DONE REQ-1 abc1234"' >"$MOCK_DIR/read.1.hook"
  echo '{"error":{"code":"timeout","message":"x"}}' >"$MOCK_DIR/prompt.out"
  echo 1 >"$MOCK_DIR/prompt.rc"
  run_helper
  [ "$status" -eq 0 ]
  [ "$output" = "$WORK/REQ-1.md" ]
}

@test "the request carries the attempt nonce inside a sentence, never as a marker line" {
  terminal_answer ''
  run_helper
  calls | grep -F 'holding only DONE REQ-1 abc1234 n0nce1' | grep -vq '^DONE'
  ! calls | grep -q '^DONE REQ-1'
}

@test "a terminal answer cut off before END is not complete" {
  terminal_answer '• DONE REQ-1 abc1234 n0nce1' '  finding one'
  run_helper
  [ "$status" -eq 12 ]
  [ ! -f "$WORK/REQ-1.md" ]
}

@test "an echo of the request's instruction line is not an answer" {
  terminal_answer '  answer with a line holding only DONE REQ-1 abc1234 n0nce1, then the body, then a line holding only END REQ-1 n0nce1'
  run_helper
  [ "$status" -eq 12 ]
  [ ! -f "$WORK/REQ-1.md" ]
}

@test "a complete block from an earlier attempt (other nonce) is not accepted, even before a cut-off new one" {
  terminal_answer '• DONE REQ-1 abc1234 old0001' '  stale finding' '  END REQ-1 old0001' \
    '• DONE REQ-1 abc1234 n0nce1' '  fresh finding'
  run_helper
  [ "$status" -eq 12 ]
  [ ! -f "$WORK/REQ-1.md" ]
}

@test "marker-shaped lines in the reply body without the nonce do not cut the answer" {
  terminal_answer '• DONE REQ-1 abc1234 n0nce1' '  sample:' '  DONE REQ-1 abc1234' '  END REQ-1' '  last line' '  END REQ-1 n0nce1'
  run_helper
  [ "$status" -eq 0 ]
  grep -Fxq 'last line' "$WORK/REQ-1.md"
}

@test "a reply body that quotes a block carrying the same nonce is saved whole" {
  terminal_answer '• DONE REQ-1 abc1234 n0nce1' '  the protocol is:' '  DONE REQ-1 abc1234 n0nce1' '  sample body' '  END REQ-1 n0nce1' '  closing line' '  END REQ-1 n0nce1'
  run_helper
  [ "$status" -eq 0 ]
  grep -Fxq 'sample body' "$WORK/REQ-1.md"
  grep -Fxq 'closing line' "$WORK/REQ-1.md"
}

@test "a rename that fails holds instead of reporting a missing reply" {
  terminal_answer '• DONE REQ-1 abc1234 n0nce1' '  finding' '  END REQ-1 n0nce1'
  printf '#!/usr/bin/env bash\nexit 1\n' >"$MOCK_DIR/bin/mv"
  chmod +x "$MOCK_DIR/bin/mv"
  run_helper
  [ "$status" -eq 15 ]
  [ ! -f "$WORK/REQ-1.md" ]
}

@test "a terminal answer for another request or SHA is not accepted" {
  terminal_answer '• DONE REQ-1 deadbee n0nce1' '  finding' '  END REQ-1 n0nce1'
  run_helper
  [ "$status" -eq 12 ]
  terminal_answer '• DONE REQ-2 abc1234 n0nce1' '  finding' '  END REQ-2 n0nce1'
  run_helper
  [ "$status" -eq 13 ] # missing twice holds
}

@test "a terminal answer with an empty body is not complete" {
  terminal_answer '• DONE REQ-1 abc1234 n0nce1' '' '  END REQ-1 n0nce1'
  run_helper
  [ "$status" -eq 12 ]
}

@test "a terminal that cannot be read holds instead of reporting a missing reply" {
  terminal_answer ''
  echo 1 >"$MOCK_DIR/read.rc"
  run_helper
  [ "$status" -eq 15 ]
}

@test "a planted .term symlink in the response directory is not followed" {
  printf 'protected\n' >"$BATS_TEST_TMPDIR/victim"
  echo 'ln -s "$BATS_TEST_TMPDIR/victim" "$WORK/REQ-1.md.term"' >"$MOCK_DIR/prompt.1.hook"
  export BATS_TEST_TMPDIR
  terminal_answer '• DONE REQ-1 abc1234 n0nce1' '  finding one' '  END REQ-1 n0nce1'
  run_helper
  [ "$status" -eq 0 ]
  [ "$(cat "$BATS_TEST_TMPDIR/victim")" = protected ]
  grep -Fxq 'finding one' "$WORK/REQ-1.md"
}
