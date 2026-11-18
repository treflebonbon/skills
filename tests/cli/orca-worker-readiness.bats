#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$PROJECT_ROOT/bin/orca-worker-readiness"
}

readiness_git() (
  unset "${!GIT_@}"
  git "$@"
)

readiness_git_value() { readiness_git "$@"; }

readiness_git_identity() {
  local branch head
  branch="$(readiness_git -C "$1" branch --show-current)"
  head="$(readiness_git -C "$1" rev-parse --verify HEAD)"
  printf '%s\t%s\n' "$branch" "$head"
}

setup_readiness_fixture() {
  local repo="$BATS_TEST_TMPDIR/readiness-repo"
  WORKER_WORKTREE="$BATS_TEST_TMPDIR/readiness-worker"
  OTHER_WORKTREE="$BATS_TEST_TMPDIR/readiness-other"
  mkdir -p "$repo"
  readiness_git init -q -b main "$repo"
  readiness_git -C "$repo" config user.name readiness-test
  readiness_git -C "$repo" config user.email readiness-test@example.invalid
  printf 'readiness fixture\n' >"$repo/README.md"
  readiness_git -C "$repo" add README.md
  readiness_git -C "$repo" commit -q -m fixture
  readiness_git -C "$repo" worktree add -q -b worker "$WORKER_WORKTREE" HEAD
  readiness_git -C "$repo" worktree add -q -b other "$OTHER_WORKTREE" HEAD
  PRIMARY_WORKTREE="$repo"
}

worker_readiness_verify() {
  "$SCRIPT" verify "$1" --worktree "$2" --branch "$3" --head "$4" --task "$5" --dispatch "$6" --assignee "$7"
}
@test "worker readiness must match the assigned checkout, including another worktree of the same repo" {
  local observation="$BATS_TEST_TMPDIR/worker-readiness.json" primary_observation="$BATS_TEST_TMPDIR/primary-readiness.json" branch head other_branch other_head primary_branch primary_head
  setup_readiness_fixture
  IFS=$'\t' read -r branch head <<<"$(readiness_git_identity "$WORKER_WORKTREE")"
  IFS=$'\t' read -r other_branch other_head <<<"$(readiness_git_identity "$OTHER_WORKTREE")"
  IFS=$'\t' read -r primary_branch primary_head <<<"$(readiness_git_identity "$PRIMARY_WORKTREE")"

  cd "$WORKER_WORKTREE"
  run "$SCRIPT" record "$observation" --task task-1 --dispatch dispatch-1 --assignee term-1
  [ "$status" -eq 0 ]
  [[ "$output" == *"observation saved"* ]]
  cp "$observation" "$BATS_TEST_TMPDIR/worker-readiness.original.json"

  run worker_readiness_verify "$observation" "$WORKER_WORKTREE" "$branch" "$head" task-1 dispatch-1 term-1
  [ "$status" -eq 0 ]
  cmp "$BATS_TEST_TMPDIR/worker-readiness.original.json" "$observation"

  run worker_readiness_verify "$observation" "$OTHER_WORKTREE" "$other_branch" "$other_head" task-1 dispatch-1 term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"cwd が期待値と一致しません"* ]]
  cmp "$BATS_TEST_TMPDIR/worker-readiness.original.json" "$observation"

  cd "$PRIMARY_WORKTREE"
  run "$SCRIPT" record "$primary_observation" --task task-1 --dispatch dispatch-1 --assignee term-1
  [ "$status" -eq 0 ]
  run worker_readiness_verify "$primary_observation" "$PRIMARY_WORKTREE" "$primary_branch" "$primary_head" task-1 dispatch-1 term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"割当先が linked worktree ではありません"* ]]
}

@test "worker readiness rejects every changed checkout and native assignment field" {
  local observation="$BATS_TEST_TMPDIR/worker-readiness.json" variant="$BATS_TEST_TMPDIR/variant.json" field branch head wrong_head
  setup_readiness_fixture
  cd "$WORKER_WORKTREE"
  run "$SCRIPT" record "$observation" --task task-1 --dispatch dispatch-1 --assignee term-1
  [ "$status" -eq 0 ]
  cp "$observation" "$BATS_TEST_TMPDIR/worker-readiness.original.json"
  branch=worker
  head="$(readiness_git_value -C "$WORKER_WORKTREE" rev-parse --verify HEAD)"
  wrong_head=0000000000000000000000000000000000000000

  run worker_readiness_verify "$observation" "$WORKER_WORKTREE" "${branch}-different" "$head" task-1 dispatch-1 term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"割当 branch が期待値と一致しません"* ]]
  run worker_readiness_verify "$observation" "$WORKER_WORKTREE" "$branch" "$wrong_head" task-1 dispatch-1 term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"割当 HEAD が期待値と一致しません"* ]]

  for field in cwd physical_root branch head git_dir common_dir task_id dispatch_id assignee_handle; do
    node - "$observation" "$variant" "$field" <<'JS'
const fs=require('node:fs');const [source,target,field]=process.argv.slice(2);const doc=JSON.parse(fs.readFileSync(source,'utf8'));
doc[field]=field==='head'?'f'.repeat(40):doc[field]+'-different';fs.writeFileSync(target,JSON.stringify(doc));
JS
    cp "$variant" "$BATS_TEST_TMPDIR/variant.original.json"
    run worker_readiness_verify "$variant" "$WORKER_WORKTREE" "$branch" "$head" task-1 dispatch-1 term-1
    [ "$status" -ne 0 ]
    case "$field" in task_id) label="Task ID" ;; dispatch_id) label="Dispatch ID" ;; assignee_handle) label="assignee handle" ;; *) label="$field" ;; esac
    [[ "$output" == *"$label が期待値と一致しません"* ]]
    cmp "$BATS_TEST_TMPDIR/variant.original.json" "$variant"
  done
  cmp "$BATS_TEST_TMPDIR/worker-readiness.original.json" "$observation"
}

@test "worker readiness rejects malformed, missing, empty, and non-string observation values" {
  local observation="$BATS_TEST_TMPDIR/worker-readiness.json" invalid="$BATS_TEST_TMPDIR/invalid.json" branch head
  setup_readiness_fixture
  cd "$WORKER_WORKTREE"
  run "$SCRIPT" record "$observation" --task task-1 --dispatch dispatch-1 --assignee term-1
  [ "$status" -eq 0 ]
  branch=worker
  head="$(readiness_git_value -C "$WORKER_WORKTREE" rev-parse --verify HEAD)"
  run worker_readiness_verify "$observation" "$WORKER_WORKTREE" "$branch" "$head" task-1 dispatch-1 term-1
  [ "$status" -eq 0 ]
  printf '{not-json\n' >"$invalid"
  cp "$invalid" "$BATS_TEST_TMPDIR/invalid.original.json"
  run worker_readiness_verify "$invalid" "$WORKER_WORKTREE" "$branch" "$head" task-1 dispatch-1 term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"worker readiness JSON を読み取れません"* ]]
  cmp "$BATS_TEST_TMPDIR/invalid.original.json" "$invalid"

  for field in missing empty non-string duplicate; do
    node - "$observation" "$invalid" "$field" <<'JS'
const fs=require('node:fs');const [source,target,mutation]=process.argv.slice(2);const doc=JSON.parse(fs.readFileSync(source,'utf8'));
if(mutation==='missing')delete doc.head;
else if(mutation==='empty')doc.head='';
else if(mutation==='non-string')doc.branch=42;
fs.writeFileSync(target,mutation==='duplicate'?JSON.stringify(doc).slice(0,-1)+', "branch": "duplicate"}\n':JSON.stringify(doc));
JS
    cp "$invalid" "$BATS_TEST_TMPDIR/invalid.original.json"
    run worker_readiness_verify "$invalid" "$WORKER_WORKTREE" "$branch" "$head" task-1 dispatch-1 term-1
    [ "$status" -ne 0 ]
    case "$field" in missing) diagnostic="schema が不正" ;; empty) diagnostic="head が空または不正" ;; non-string) diagnostic="branch が空または不正" ;; duplicate) diagnostic="重複キー" ;; esac
    [[ "$output" == *"$diagnostic"* ]]
    cmp "$BATS_TEST_TMPDIR/invalid.original.json" "$invalid"
  done
  run "$SCRIPT" record "$BATS_TEST_TMPDIR/empty.json" --task task-1 --dispatch dispatch-1 --assignee ''
  [ "$status" -ne 0 ]
  [[ "$output" == *"assignee が空または不正です"* ]]
}

@test "worker readiness ignores ambient Git overrides and never executes shell-looking JSON" {
  local observation="$BATS_TEST_TMPDIR/worker-readiness.json" marker="$BATS_TEST_TMPDIR/should-not-exist" variant="$BATS_TEST_TMPDIR/variant.json" branch head
  setup_readiness_fixture
  branch=worker
  head="$(readiness_git_value -C "$WORKER_WORKTREE" rev-parse --verify HEAD)"
  cd "$WORKER_WORKTREE"
  run env GIT_DIR="$BATS_TEST_TMPDIR/not-a-git-dir" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0="$BATS_TEST_TMPDIR/not-a-worktree" "$SCRIPT" record "$observation" --task task-1 --dispatch dispatch-1 --assignee term-1
  [ "$status" -eq 0 ]
  [[ "$output" != *"not-a-worktree"* ]]
  run grep -Fq "not-a-worktree" "$observation"
  [ "$status" -eq 1 ]
  run env GIT_DIR="$BATS_TEST_TMPDIR/not-a-git-dir" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0="$BATS_TEST_TMPDIR/not-a-worktree" "$SCRIPT" verify "$observation" --worktree "$WORKER_WORKTREE" --branch "$branch" --head "$head" --task task-1 --dispatch dispatch-1 --assignee term-1
  [ "$status" -eq 0 ]
  [[ "$output" != *"not-a-worktree"* ]]

  node - "$observation" "$variant" "$marker" <<'JS'
const fs=require('node:fs');const [source,target,marker]=process.argv.slice(2);const doc=JSON.parse(fs.readFileSync(source,'utf8'));
doc.branch='$(touch '+marker+')';fs.writeFileSync(target,JSON.stringify(doc));
JS
  cp "$variant" "$BATS_TEST_TMPDIR/variant.original.json"
  run worker_readiness_verify "$variant" "$WORKER_WORKTREE" "$branch" "$head" task-1 dispatch-1 term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"branch が期待値と一致しません"* ]]
  [ ! -e "$marker" ]
  cmp "$BATS_TEST_TMPDIR/variant.original.json" "$variant"
}

