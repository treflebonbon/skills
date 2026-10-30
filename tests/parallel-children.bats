#!/usr/bin/env bats

# Parallel children. Mock herdr only: no real herdr, pane or agent is touched.

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  SCRIPTS="$PROJECT_ROOT/skills/herdr-peer-refactor/scripts"
  MOCK_DIR="$BATS_TEST_TMPDIR/mock"
  RUN_DIR="$BATS_TEST_TMPDIR/run"
  WT="$BATS_TEST_TMPDIR/wt-c1"
  mkdir -p "$MOCK_DIR/bin" "$RUN_DIR" "$WT"
  export MOCK_DIR
  REAL_PYTHON="$(command -v python3)"
  RECEIPT="$BATS_TEST_TMPDIR/preflight.json"
  SETTINGS="$BATS_TEST_TMPDIR/claude-peer/auto-peer-settings.json"
  CLAUDE="$MOCK_DIR/bin/claude"
  : >"$RECEIPT"
  mkdir -p "$(dirname "$SETTINGS")"
  : >"$SETTINGS"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$CLAUDE"
  chmod +x "$CLAUDE"
  export REAL_PYTHON RECEIPT SETTINGS CLAUDE
  export AUTO_PEER_TEST_PREFLIGHT_PASS=1
  export AUTO_PEER_TEST_VERIFIED_CLAUDE="$CLAUDE"

  # The real preflight and refusal paths are covered by test_issue_536_auto_peer.py.
  # This mock lets the suite exercise the launcher's process and parallel-limit checks.
  cat >"$MOCK_DIR/bin/python3" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *auto-peer-preflight.py*)
    [ "$AUTO_PEER_TEST_PREFLIGHT_PASS" = 1 ] || exit 1
    case " $* " in *--print-executable*) printf '%s\n' "$AUTO_PEER_TEST_VERIFIED_CLAUDE" ;; esac
    ;;
  *) exec "$REAL_PYTHON" "$@" ;;
esac
EOF
  chmod +x "$MOCK_DIR/bin/python3"

  # Per-subcommand behaviour from files in MOCK_DIR, as in tests/peer-request.bats:
  #   <cmd>.out / <cmd>.rc   stdout and exit code (default: empty, 0)
  cat >"$MOCK_DIR/bin/herdr" <<'EOF'
#!/usr/bin/env bash
cmd=$2
printf '%s\n' "$*" >>"$MOCK_DIR/calls.log"
cat "$MOCK_DIR/$cmd.out" 2>/dev/null || true
exit "$(cat "$MOCK_DIR/$cmd.rc" 2>/dev/null || echo 0)"
EOF
  chmod +x "$MOCK_DIR/bin/herdr"
  PATH="$MOCK_DIR/bin:$PATH"
  export PARALLEL_LAUNCH_TIMEOUT_S=1
  printf '%s\n' '{"result":{"root_pane":{"pane_id":"wA:p9"},"workspace":{"workspace_id":"wA"}}}' >"$MOCK_DIR/create.out"
  proc_out "$SETTINGS" "$WT"
}

# process-info as herdr prints it: foreground processes with argv and cwd.
proc_out() {
  python3 - "$1" "$2" >"$MOCK_DIR/process-info.out" <<'PY'
import json, sys
frag, cwd = sys.argv[1], sys.argv[2]
print(json.dumps({"result": {"process_info": {"foreground_processes": [
    {"argv": ["claude", "--permission-mode", "auto", "--settings", frag], "cwd": cwd, "pid": 4242}]}}}))
PY
}
calls() { cat "$MOCK_DIR/calls.log" 2>/dev/null || true; }
launch() { run bash "$SCRIPTS/launch-child.sh" "$RUN_DIR" wA:p1 "$WT" C1 "${LIMIT:-6}" "$RECEIPT" "$SETTINGS"; }

# ---- plan-parallel.sh ----

records() { printf '%s\t%s\t%s\n' "$@"; }

@test "plan: files that do not overlap run together up to the child limit" {
  records C1 a.sh "" C2 b.sh "" C3 c.sh "" >"$BATS_TEST_TMPDIR/r.tsv"
  # limit 6 = 1 parent + N children + (N+1) peers -> N = 2
  run bash "$SCRIPTS/plan-parallel.sh" 6 "$BATS_TEST_TMPDIR/r.tsv"
  [ "$status" -eq 0 ]
  [[ "$output" == *"RUN C1"* ]]
  [[ "$output" == *"RUN C2"* ]]
  [[ "$output" == *"DEFER C3 over-limit"* ]]
}

@test "plan: a candidate whose owned file overlaps an earlier one is deferred to the next run" {
  records C1 a.sh,b.sh "" C2 b.sh "" >"$BATS_TEST_TMPDIR/r.tsv"
  run bash "$SCRIPTS/plan-parallel.sh" 6 "$BATS_TEST_TMPDIR/r.tsv"
  [ "$status" -eq 0 ]
  [[ "$output" == *"RUN C1"* ]]
  [[ "$output" == *"DEFER C2 conflicts-with C1"* ]]
}

@test "plan: a dependency on another file counts as a conflict even when owned files differ" {
  # C2 owns c.sh but depends on a.sh, which C1 owns.
  records C1 a.sh "" C2 c.sh a.sh >"$BATS_TEST_TMPDIR/r.tsv"
  run bash "$SCRIPTS/plan-parallel.sh" 6 "$BATS_TEST_TMPDIR/r.tsv"
  [ "$status" -eq 0 ]
  [[ "$output" == *"DEFER C2 conflicts-with C1"* ]]
  # and the other direction: C1 depends on a file C2 owns
  records C1 a.sh c.sh C2 c.sh "" >"$BATS_TEST_TMPDIR/r.tsv"
  run bash "$SCRIPTS/plan-parallel.sh" 6 "$BATS_TEST_TMPDIR/r.tsv"
  [[ "$output" == *"DEFER C2 conflicts-with C1"* ]]
}

@test "plan: line ranges are ignored (the unit is the file)" {
  records C1 a.sh:10-20 "" C2 a.sh:90-99 "" >"$BATS_TEST_TMPDIR/r.tsv"
  run bash "$SCRIPTS/plan-parallel.sh" 6 "$BATS_TEST_TMPDIR/r.tsv"
  [[ "$output" == *"DEFER C2 conflicts-with C1"* ]]
}

@test "plan: ./a.sh and a.sh are the same file, and a blank record is skipped" {
  printf 'C1\t./a.sh\t\n\t\t\nC2\ta.sh\t\n' >"$BATS_TEST_TMPDIR/r.tsv"
  run bash "$SCRIPTS/plan-parallel.sh" 6 "$BATS_TEST_TMPDIR/r.tsv"
  [ "$status" -eq 0 ]
  [[ "$output" == *"DEFER C2 conflicts-with C1"* ]]
  [[ "$output" != *"RUN "$'\n'* ]]
}

@test "plan: a missing records file is a usage error" {
  run bash "$SCRIPTS/plan-parallel.sh" 6 "$BATS_TEST_TMPDIR/none.tsv"
  [ "$status" -eq 2 ]
}

@test "plan: a limit that leaves no room for one child is refused" {
  records C1 a.sh "" >"$BATS_TEST_TMPDIR/r.tsv"
  run bash "$SCRIPTS/plan-parallel.sh" 3 "$BATS_TEST_TMPDIR/r.tsv"
  [ "$status" -eq 2 ]
}

# ---- launch-child.sh ----

@test "launch: observes the worktree cwd and --settings path in mocked process arguments" {
  launch
  [ "$status" -eq 0 ]
  [ "$output" = "wA:p9" ]
  # a dedicated workspace per child; never a split of the parent's pane, never a pane move
  calls | grep -F 'workspace create' | grep -Fq -- '--no-focus'
  calls | grep -F 'workspace create' | grep -Fq -- "--cwd $WT"
  calls | grep -F 'workspace create' | grep -Fq -- '--label C1'
  run grep -E 'pane (split|move)' "$MOCK_DIR/calls.log"
  [ "$status" -eq 1 ]
  calls | grep -F 'pane run wA:p9' | grep -Fq -- '--settings "$settings"'
  calls | grep -F 'pane run wA:p9' | grep -Fq -- "$SETTINGS"
  calls | grep -F 'pane run wA:p9' | grep -Fq -- '--permission-mode auto'
  # The process-info check owns this launch; no marker or agent-start path substitutes for it.
  run grep -F 'AUTO_PEER_SESSION' "$MOCK_DIR/calls.log"
  [ "$status" -eq 1 ]
  run grep -F 'agent start' "$MOCK_DIR/calls.log"
  [ "$status" -eq 1 ]
  grep -Fq "C1	wA:p9" "$RUN_DIR/children.tsv"
}

@test "launch: a child whose process does not carry the settings path is not recorded as started" {
  python3 - "$WT" >"$MOCK_DIR/process-info.out" <<'PY'
import json, sys
print(json.dumps({"result": {"process_info": {"foreground_processes": [
    {"argv": ["claude", "--permission-mode", "auto"], "cwd": sys.argv[1], "pid": 4242}]}}}))
PY
  launch
  [ "$status" -eq 20 ]
  [ ! -e "$RUN_DIR/children.tsv" ]
}

@test "launch: a child that failed the check still counts toward the live-agent limit" {
  python3 - "$WT" >"$MOCK_DIR/process-info.out" <<'PY'
import json, sys
print(json.dumps({"result": {"process_info": {"foreground_processes": [
    {"argv": ["claude"], "cwd": sys.argv[1], "pid": 4242}]}}}))
PY
  LIMIT=4 launch
  [ "$status" -eq 20 ]
  # its pane is kept and may still run, so a limit of 4 (one child) has no room left
  proc_out "$SETTINGS" "$WT"
  LIMIT=4 launch
  [ "$status" -eq 13 ]
}

@test "launch: --settings=<path> in one argument is accepted" {
  python3 - "$SETTINGS" "$WT" >"$MOCK_DIR/process-info.out" <<'PY'
import json, sys
print(json.dumps({"result": {"process_info": {"foreground_processes": [
    {"argv": ["claude", "--settings=" + sys.argv[1]], "cwd": sys.argv[2], "pid": 4242}]}}}))
PY
  launch
  [ "$status" -eq 0 ]
}

@test "launch: a non-numeric limit is a usage error" {
  LIMIT=six launch
  [ "$status" -eq 2 ]
}

@test "launch: a child running in another directory is not started" {
  proc_out "$SETTINGS" "/somewhere/else"
  launch
  [ "$status" -eq 21 ]
  [ ! -e "$RUN_DIR/children.tsv" ]
}

@test "launch: the combined parent, child and peer count never exceeds the limit" {
  # limit 6 allows 2 children; a third is refused before any pane is created.
  printf 'C0\twA:p7\nCx\twA:p8\n' >"$RUN_DIR/children.tsv"
  launch
  [ "$status" -eq 13 ]
  [ ! -e "$MOCK_DIR/calls.log" ]
}

@test "launch: no new child starts after the parent has stopped" {
  : >"$RUN_DIR/stopped"
  launch
  [ "$status" -eq 14 ]
  [ ! -e "$MOCK_DIR/calls.log" ]
}

# ---- check-owned.sh ----

mkrepo() {
  REPO="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$REPO"
  git -C "$REPO" init -q -b main
  git -C "$REPO" config user.email t@example.com
  git -C "$REPO" config user.name t
  printf 'x\n' >"$REPO/a.sh"
  printf 'x\n' >"$REPO/b.sh"
  git -C "$REPO" add -A
  git -C "$REPO" commit -q -m init
  BASE="$(git -C "$REPO" rev-parse HEAD)"
}

@test "owned: a diff inside the declared files passes" {
  mkrepo
  printf 'y\n' >"$REPO/a.sh"
  git -C "$REPO" commit -qam change
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" a.sh:1-5
  [ "$status" -eq 0 ]
}

@test "owned: a file outside the declared range is reported and the candidate stops" {
  mkrepo
  printf 'y\n' >"$REPO/a.sh"
  printf 'y\n' >"$REPO/b.sh"
  git -C "$REPO" commit -qam change
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" a.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"b.sh"* ]]
}

@test "owned: a hunk outside the declared line range is reported, a hunk inside it passes" {
  mkrepo
  printf '1\n2\n3\n4\n5\n' >"$REPO/a.sh"
  git -C "$REPO" commit -qam five
  five="$(git -C "$REPO" rev-parse HEAD)"
  printf '1\n2\nX\n4\n5\n' >"$REPO/a.sh"
  git -C "$REPO" commit -qam line3
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$five" a.sh:1-2
  [ "$status" -eq 1 ]
  [[ "$output" == *"a.sh:3-3"* ]]
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$five" a.sh:2-4
  [ "$status" -eq 0 ]
}

@test "owned: a deletion is judged by the OLD line it removes, not by the new-side position after it" {
  mkrepo
  printf '1\n2\n3\n4\n5\n' >"$REPO/a.sh"
  git -C "$REPO" commit -qam five
  five="$(git -C "$REPO" rev-parse HEAD)"
  printf '1\n2\n4\n5\n' >"$REPO/a.sh"
  git -C "$REPO" commit -qam delete3
  # old line 3 was deleted: only a range containing 3 owns it
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$five" a.sh:3-3
  [ "$status" -eq 0 ]
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$five" a.sh:2-2
  [ "$status" -eq 1 ]
}

@test "owned: an insertion needs a neighbouring old line inside a declared range" {
  mkrepo
  printf '1\n2\n3\n' >"$REPO/a.sh"
  git -C "$REPO" commit -qam three
  three="$(git -C "$REPO" rev-parse HEAD)"
  printf '1\n2\nnew\n3\n' >"$REPO/a.sh"
  git -C "$REPO" commit -qam insert
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$three" a.sh:2-2
  [ "$status" -eq 0 ]
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$three" a.sh:1-1
  [ "$status" -eq 1 ]
}

@test "owned: a new file declared with a range must fit all its lines in that range" {
  mkrepo
  printf '1\n2\n3\n4\n5\n' >"$REPO/new.sh"
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" new.sh:1-2
  [ "$status" -eq 1 ]
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" new.sh:1-5
  [ "$status" -eq 0 ]
  # the same holds once the file is staged and committed
  git -C "$REPO" add new.sh
  git -C "$REPO" commit -qm add
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" new.sh:1-2
  [ "$status" -eq 1 ]
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" new.sh
  [ "$status" -eq 0 ]
}

@test "owned: a base supplied by the caller is used as given" {
  local skill="$PROJECT_ROOT/skills/herdr-peer-refactor/SKILL.md"
  grep -Fq 'check-owned.sh" <worktree> <base> <owned-files>' "$skill"
  run bash -c "grep -F 'check-owned.sh' '$skill' | grep -F 'origin/main <owned'"
  [ "$status" -eq 1 ]
}

@test "owned: a rename counts as a delete plus an add, so both paths must be declared" {
  mkrepo
  git -C "$REPO" mv a.sh c.sh
  git -C "$REPO" commit -qm rename
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" c.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"a.sh"* ]]
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" a.sh,c.sh
  [ "$status" -eq 0 ]
}

@test "owned: a change that landed on the base after the branch point is not blamed on the candidate" {
  mkrepo
  git -C "$REPO" switch -q -c feat
  printf 'y\n' >"$REPO/a.sh"
  git -C "$REPO" commit -qam feat
  git -C "$REPO" switch -q main
  printf 'z\n' >"$REPO/b.sh"
  git -C "$REPO" commit -qam later-on-main
  git -C "$REPO" switch -q feat
  run bash "$SCRIPTS/check-owned.sh" "$REPO" main a.sh
  [ "$status" -eq 0 ]
}

@test "owned: an untracked new file must be declared" {
  mkrepo
  printf 'n\n' >"$REPO/new.sh"
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" a.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"new.sh"* ]]
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" new.sh
  [ "$status" -eq 0 ]
}

@test "owned: an uncommitted change is part of the actual diff" {
  mkrepo
  printf 'y\n' >"$REPO/b.sh"
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" a.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *"b.sh"* ]]
}

# ---- documents ----

@test "peer guidance names parallel helpers, the 2N+2 limit and parent-stop behavior" {
  local auto="$PROJECT_ROOT/skills/herdr-peer-refactor/references/auto-session.md"
  local skill="$PROJECT_ROOT/skills/herdr-peer-refactor/SKILL.md"
  [ -f "$auto" ]
  for helper in plan-parallel.sh launch-child.sh; do
    [ -x "$SCRIPTS/$helper" ]
    grep -Fq "$helper" "$auto"
  done
  [ -x "$SCRIPTS/check-owned.sh" ]
  grep -Fq 'check-owned.sh' "$skill"
  grep -Fq '2N+2' "$auto"
  grep -Fq '親が停止を記録したら新しい child を開始しない' "$auto"
  # The launch is checked from the child's process, never from an environment variable.
  grep -Fq 'herdr pane process-info' "$auto"
  run grep -Fq 'AUTO_PEER_SESSION' "$auto"
  [ "$status" -eq 1 ]
}

@test "instructions never tell an agent to run git -C (the standard deny refuses it)" {
  # Scripts may use it internally; public agent guidance uses the worktree cwd.
  local doc
  for doc in skills/herdr-peer-refactor/SKILL.md contracts/autonomous-peer-contract.md skills/herdr-peer-refactor/references/herdr.md; do
    run bash -c "grep -n -F 'git -C' '$PROJECT_ROOT/$doc' | grep -v -E 'Never|deny|拒否|使わない|指示しない'"
    [ "$status" -eq 1 ]
  done
  grep -Fq 'Git は worktree の cwd で使う' "$PROJECT_ROOT/skills/herdr-peer-refactor/references/herdr.md"
}

@test "native peer workflow is available directly while dedicated auto keeps process-level permission checks" {
  local skill="$PROJECT_ROOT/skills/herdr-peer-refactor/SKILL.md"
  local auto="$PROJECT_ROOT/skills/herdr-peer-refactor/references/auto-session.md"
  grep -Fq '通常 session の明示 peer 協働は専用 auto の資格情報や preflight を要求しない' "$skill"
  grep -Fq '設定ファイルの存在、起動 argv、rule evaluator の結果だけでは、runtime が実際に権限を適用した証拠にならない' "$auto"
  grep -Fq 'herdr pane process-info' "$auto"
  grep -Fq 'preflight' "$auto"
  grep -Fq 'references/auto-session.md' "$skill"
}

@test "native workflow keeps one upstream exploration and does not re-explore after candidate rejection" {
  local skill="$PROJECT_ROOT/skills/herdr-peer-refactor/SKILL.md"
  local contract="$PROJECT_ROOT/contracts/autonomous-peer-contract.md"
  grep -Fq '候補探索はやり直さず' "$skill"
  grep -Fq '候補の棄却を理由に探索し直さない' "$contract"
}

@test "launch: an unwritable run-dir stops before any herdr side effect" {
  RUN_DIR="$BATS_TEST_TMPDIR/not-a-dir"
  : >"$RUN_DIR"
  launch
  [ "$status" -eq 2 ]
  [ ! -f "$MOCK_DIR/calls.log" ]
}

@test "launch: an unwritable state file stops before any herdr side effect" {
  [ "$(id -u)" -ne 0 ] || skip "root can write any file"
  : >"$RUN_DIR/children.tsv"
  chmod 444 "$RUN_DIR/children.tsv"
  launch
  [ "$status" -eq 2 ]
  [ ! -f "$MOCK_DIR/calls.log" ]
}

@test "owned: an untracked file without a trailing newline counts its last line" {
  mkrepo
  printf '1\n2' >"$REPO/new.sh"
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" new.sh:1-1
  [ "$status" -eq 1 ]
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" new.sh:1-2
  [ "$status" -eq 0 ]
}

@test "owned: a file larger than one read chunk is counted exactly" {
  mkrepo
  yes line | head -n 400000 >"$REPO/big.txt" # about 2 MB, more than one 1 MiB chunk
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" big.txt:1-400000
  [ "$status" -eq 0 ]
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" big.txt:1-399999
  [ "$status" -eq 1 ]
  printf 'x' >>"$REPO/big.txt" # an unterminated last line past the chunk boundary
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$BASE" big.txt:1-400000
  [ "$status" -eq 1 ]
}

@test "owned: a base with no merge-base stops instead of diffing against the base" {
  mkrepo
  unrelated=$(git -C "$REPO" commit-tree "$(git -C "$REPO" hash-object -t tree /dev/null)" -m unrelated)
  run bash "$SCRIPTS/check-owned.sh" "$REPO" "$unrelated" a.sh
  [ "$status" -eq 2 ]
}
