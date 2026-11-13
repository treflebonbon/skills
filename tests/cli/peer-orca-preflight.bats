#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$PROJECT_ROOT/skills/orca-peer-refactor/scripts/orca-preflight"
  ORCA_DOC="$PROJECT_ROOT/skills/orca-peer-refactor/references/orca.md"
  ORCA_SEND="$PROJECT_ROOT/bin/orca-send"
  RECEIPT="$BATS_TEST_TMPDIR/receipt.json"
}

write_coordinator_receipt() {
  cat >"$RECEIPT" <<'JSON'
{"ok":true,"result":{"run":{"id":"run-1","coordinator_handle":"term-1"}}}
JSON
}

write_worker_receipt() {
  cat >"$RECEIPT" <<'JSON'
{"ok":true,"result":{"dispatch":{"id":"dispatch-1","taskId":"task-1","assigneeHandle":"term-1","status":"dispatched"}}}
JSON
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
  "$SCRIPT" worker-readiness verify "$1" --worktree "$2" --branch "$3" --head "$4" --task "$5" --dispatch "$6" --assignee "$7"
}

@test "coordinator receipt must match the expected Run and handle without changing it" {
  write_coordinator_receipt
  cp "$RECEIPT" "$BATS_TEST_TMPDIR/original.json"
  run "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-1
  [ "$status" -eq 0 ]
  run "$SCRIPT" coordinator "$RECEIPT" --run run-other --handle term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"Run ID が期待値と一致しません"* ]]
  run "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-other
  [ "$status" -ne 0 ]
  [[ "$output" == *"coordinator handle が期待値と一致しません"* ]]
  run "$SCRIPT" coordinator "$RECEIPT" --run '' --handle term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"Run ID が期待値と一致しません"* ]]
  cmp "$BATS_TEST_TMPDIR/original.json" "$RECEIPT"
  node - "$RECEIPT" <<'JS'
const fs=require('node:fs');const path=process.argv[2];const doc=JSON.parse(fs.readFileSync(path,'utf8'));
doc.result.run.id='';fs.writeFileSync(path,JSON.stringify(doc));
JS
  cp "$RECEIPT" "$BATS_TEST_TMPDIR/empty.json"
  run "$SCRIPT" coordinator "$RECEIPT" --run '' --handle term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"Run ID が期待値と一致しません"* ]]
  cmp "$BATS_TEST_TMPDIR/empty.json" "$RECEIPT"
}

@test "worker readiness must match the assigned checkout, including another worktree of the same repo" {
  local observation="$BATS_TEST_TMPDIR/worker-readiness.json" primary_observation="$BATS_TEST_TMPDIR/primary-readiness.json" branch head other_branch other_head primary_branch primary_head
  setup_readiness_fixture
  IFS=$'\t' read -r branch head <<<"$(readiness_git_identity "$WORKER_WORKTREE")"
  IFS=$'\t' read -r other_branch other_head <<<"$(readiness_git_identity "$OTHER_WORKTREE")"
  IFS=$'\t' read -r primary_branch primary_head <<<"$(readiness_git_identity "$PRIMARY_WORKTREE")"

  cd "$WORKER_WORKTREE"
  run "$SCRIPT" worker-readiness record "$observation" --task task-1 --dispatch dispatch-1 --assignee term-1
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
  run "$SCRIPT" worker-readiness record "$primary_observation" --task task-1 --dispatch dispatch-1 --assignee term-1
  [ "$status" -eq 0 ]
  run worker_readiness_verify "$primary_observation" "$PRIMARY_WORKTREE" "$primary_branch" "$primary_head" task-1 dispatch-1 term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"割当先が linked worktree ではありません"* ]]
}

@test "worker readiness rejects every changed checkout and native assignment field" {
  local observation="$BATS_TEST_TMPDIR/worker-readiness.json" variant="$BATS_TEST_TMPDIR/variant.json" field branch head wrong_head
  setup_readiness_fixture
  cd "$WORKER_WORKTREE"
  run "$SCRIPT" worker-readiness record "$observation" --task task-1 --dispatch dispatch-1 --assignee term-1
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
  run "$SCRIPT" worker-readiness record "$observation" --task task-1 --dispatch dispatch-1 --assignee term-1
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
  run "$SCRIPT" worker-readiness record "$BATS_TEST_TMPDIR/empty.json" --task task-1 --dispatch dispatch-1 --assignee ''
  [ "$status" -ne 0 ]
  [[ "$output" == *"assignee が空または不正です"* ]]
}

@test "worker readiness ignores ambient Git overrides and never executes shell-looking JSON" {
  local observation="$BATS_TEST_TMPDIR/worker-readiness.json" marker="$BATS_TEST_TMPDIR/should-not-exist" variant="$BATS_TEST_TMPDIR/variant.json" branch head
  setup_readiness_fixture
  branch=worker
  head="$(readiness_git_value -C "$WORKER_WORKTREE" rev-parse --verify HEAD)"
  cd "$WORKER_WORKTREE"
  run env GIT_DIR="$BATS_TEST_TMPDIR/not-a-git-dir" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0="$BATS_TEST_TMPDIR/not-a-worktree" "$SCRIPT" worker-readiness record "$observation" --task task-1 --dispatch dispatch-1 --assignee term-1
  [ "$status" -eq 0 ]
  [[ "$output" != *"not-a-worktree"* ]]
  run grep -Fq "not-a-worktree" "$observation"
  [ "$status" -eq 1 ]
  run env GIT_DIR="$BATS_TEST_TMPDIR/not-a-git-dir" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0="$BATS_TEST_TMPDIR/not-a-worktree" "$SCRIPT" worker-readiness verify "$observation" --worktree "$WORKER_WORKTREE" --branch "$branch" --head "$head" --task task-1 --dispatch dispatch-1 --assignee term-1
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

@test "coordinator rejects errors, malformed envelopes, and missing Run identity" {
  write_coordinator_receipt
  run "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-1
  [ "$status" -eq 0 ]
  printf '{"ok":false,"error":{"code":"failed"}}\n' >"$RECEIPT"
  run "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"receipt が成功応答ではありません"* ]]
  write_coordinator_receipt
  run "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-1
  [ "$status" -eq 0 ]
  printf '{not-json\n' >"$RECEIPT"
  run "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"receipt を読み取れません"* ]]
  write_coordinator_receipt
  run "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-1
  [ "$status" -eq 0 ]
  printf '{"ok":true,"result":{}}\n' >"$RECEIPT"
  run "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"result.run がありません"* ]]
  write_coordinator_receipt
  run "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-1
  [ "$status" -eq 0 ]
  printf '{"ok":true,"error":{"code":"failed"},"result":{"run":{"id":"run-1","coordinator_handle":"term-1"}}}\n' >"$RECEIPT"
  run "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"receipt に error があります"* ]]
}

@test "worker-show receipt must match the dispatched Task, Dispatch, and assignee" {
  write_worker_receipt
  cp "$RECEIPT" "$BATS_TEST_TMPDIR/original.json"
  run "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-1
  [ "$status" -eq 0 ]
  run "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-other --task task-1 --assignee term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"Dispatch ID が期待値と一致しません"* ]]
  run "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-other --assignee term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"Task ID が期待値と一致しません"* ]]
  run "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-other
  [ "$status" -ne 0 ]
  [[ "$output" == *"assignee handle が期待値と一致しません"* ]]
  cmp "$BATS_TEST_TMPDIR/original.json" "$RECEIPT"
}

@test "worker-show rejects settled or errored Dispatches" {
  write_worker_receipt
  run "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-1
  [ "$status" -eq 0 ]
  node - "$RECEIPT" <<'JS'
const fs=require('node:fs');const path=process.argv[2];const doc=JSON.parse(fs.readFileSync(path,'utf8'));
doc.result.dispatch.status='completed';fs.writeFileSync(path,JSON.stringify(doc));
JS
  run "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"Dispatch status が期待値と一致しません"* ]]
  write_worker_receipt
  run "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-1
  [ "$status" -eq 0 ]
  printf '{"ok":false,"error":{"code":"failed"},"result":{"dispatch":{"id":"dispatch-1","taskId":"task-1","assigneeHandle":"term-1","status":"dispatched"}}}\n' >"$RECEIPT"
  run "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"receipt が成功応答ではありません"* ]]
}

@test "worker-show rejects missing and malformed dispatch identities" {
  write_worker_receipt
  run "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-1
  [ "$status" -eq 0 ]
  printf '{"ok":true,"result":{}}\n' >"$RECEIPT"
  run "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"result.dispatch がありません"* ]]
  write_worker_receipt
  run "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-1
  [ "$status" -eq 0 ]
  printf '{"ok":true,"result":{"dispatch":{"id":"dispatch-1","taskId":"task-1","status":"dispatched"}}}\n' >"$RECEIPT"
  run "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-1
  [ "$status" -ne 0 ]
  [[ "$output" == *"assignee handle が期待値と一致しません"* ]]
}

@test "the documented Bash sender calls orca-send and preserves shell-looking body text" {
  local example="$BATS_TEST_TMPDIR/example.sh" bin="$BATS_TEST_TMPDIR/bin" body_file="$BATS_TEST_TMPDIR/task body.md"
  mkdir -p "$bin"
  cat >"$body_file" <<'BODY'
レビューの要点:
literal $HOME、$(printf test)、`バッククォート`、"二重引用符"、'一重引用符' を含む。
BODY
  awk '
    $0 == "<!-- literal-safe-example:start -->" { example = 1; next }
    example && $0 == "```bash" { code = 1; next }
    code && $0 == "```" { exit }
    code { print }
  ' "$ORCA_DOC" >"$example"
  [ -s "$example" ]
  cat >"$bin/orca-ide" <<'SH'
#!/bin/sh
printf '%s\0' "$@" > "$ARGV_CAPTURE"
SH
  chmod +x "$bin/orca-ide"
  run env SKILL_DIR="$PROJECT_ROOT/skills/orca-peer-refactor" ORCA_CLI=orca-ide ORCA_BODY_FILE="$body_file" ARGV_CAPTURE="$BATS_TEST_TMPDIR/argv" PATH="$bin:$PATH" bash "$example"
  [ "$status" -eq 0 ]
  node - "$BATS_TEST_TMPDIR/argv" "$body_file" <<'JS'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const argv = fs.readFileSync(process.argv[2], 'utf8').split('\0').slice(0, -1);
const body = fs.readFileSync(process.argv[3], 'utf8');
assert.deepEqual(argv, [
  'orchestration', 'send', '--body', body,
  '--to', 'run:<run-id>', '--run', '<run-id>', '--from', '<sender-handle>',
  '--subject', 'レビュー依頼', '--type', 'status', '--json',
]);
JS
  run --separate-stderr env SKILL_DIR="$PROJECT_ROOT/skills/orca-peer-refactor" ORCA_CLI=orca-ide ORCA_BODY_FILE="$body_file" ARGV_CAPTURE="$BATS_TEST_TMPDIR/interactive-argv" PATH="$bin:$PATH" bash --noprofile --norc -i <"$example"
  [ "$status" -eq 0 ]
  cmp "$BATS_TEST_TMPDIR/argv" "$BATS_TEST_TMPDIR/interactive-argv"
}

@test "the documented Bash sender refuses invalid SKILL_DIR before selecting a package" {
  local example="$BATS_TEST_TMPDIR/example.sh" outside="$BATS_TEST_TMPDIR/outside" marker="$BATS_TEST_TMPDIR/outside-called"
  mkdir -p "$outside/skills/orca-peer-refactor" "$outside/bin"
  awk '
    $0 == "<!-- literal-safe-example:start -->" { example = 1; next }
    example && $0 == "```bash" { code = 1; next }
    code && $0 == "```" { exit }
    code { print }
  ' "$ORCA_DOC" >"$example"
  [ -s "$example" ]
  cat >"$outside/bin/orca-send" <<'SH'
#!/bin/sh
printf 'wrong package\n' > "$OUTSIDE_MARKER"
SH
  chmod +x "$outside/bin/orca-send"
  cd "$outside/skills/orca-peer-refactor"
  run env -u SKILL_DIR ORCA_CLI=unused ORCA_BODY_FILE=unused OUTSIDE_MARKER="$marker" bash "$example"
  [ "$status" -ne 0 ]
  [[ "$output" == *"SKILL_DIR"* ]]
  [ ! -e "$marker" ]
  run env SKILL_DIR= ORCA_CLI=unused ORCA_BODY_FILE=unused OUTSIDE_MARKER="$marker" bash "$example"
  [ "$status" -ne 0 ]
  [[ "$output" == *"SKILL_DIR"* ]]
  [ ! -e "$marker" ]
  run env SKILL_DIR="$BATS_TEST_TMPDIR/missing-skill" ORCA_CLI=unused ORCA_BODY_FILE=unused OUTSIDE_MARKER="$marker" bash "$example"
  [ "$status" -ne 0 ]
  [[ "$output" == *"package root"* ]]
  [ ! -e "$marker" ]
  local interactive="$BATS_TEST_TMPDIR/interactive.sh"
  cat "$example" >"$interactive"
  cat >>"$interactive" <<'SH'
example_status=$?
printf 'EXAMPLE_STATUS=%s\n' "$example_status"
printf 'INTERACTIVE_ALIVE\n'
SH
  run --separate-stderr env -u SKILL_DIR ORCA_CLI=unused ORCA_BODY_FILE=unused OUTSIDE_MARKER="$marker" bash --noprofile --norc -i <"$interactive"
  [ "$status" -eq 0 ]
  [[ "$output" == *$'EXAMPLE_STATUS=1\nINTERACTIVE_ALIVE'* ]]
  [[ "$stderr" == *"SKILL_DIR"* ]]
  [ ! -e "$marker" ]
  run --separate-stderr env SKILL_DIR= ORCA_CLI=unused ORCA_BODY_FILE=unused OUTSIDE_MARKER="$marker" bash --noprofile --norc -i <"$interactive"
  [ "$status" -eq 0 ]
  [[ "$output" == *$'EXAMPLE_STATUS=1\nINTERACTIVE_ALIVE'* ]]
  [[ "$stderr" == *"SKILL_DIR"* ]]
  [ ! -e "$marker" ]
  run --separate-stderr env SKILL_DIR="$BATS_TEST_TMPDIR/missing-skill" ORCA_CLI=unused ORCA_BODY_FILE=unused OUTSIDE_MARKER="$marker" bash --noprofile --norc -i <"$interactive"
  [ "$status" -eq 0 ]
  [[ "$output" == *$'EXAMPLE_STATUS=1\nINTERACTIVE_ALIVE'* ]]
  [[ "$stderr" == *"package root"* ]]
  [ ! -e "$marker" ]
}

@test "documented shell sends preserve file body text without shell expansion" {
  local example="$BATS_TEST_TMPDIR/send.sh" fake_cli="$BATS_TEST_TMPDIR/ORCA" body_file="$BATS_TEST_TMPDIR/task body.md"
  cat >"$body_file" <<'BODY'
本文:
literal $READINESS_LITERAL、$(touch "$READINESS_SHELL_MARKER")、`touch "$READINESS_BACKTICK_MARKER"`、"二重引用符"、'一重引用符'
BODY
  node - "$ORCA_DOC" "$example" "$body_file" <<'JS'
const fs=require('node:fs');const [doc,target,bodyFile]=process.argv.slice(2);
let script=fs.readFileSync(doc,'utf8').split('\n').filter(line=>line.startsWith('task_body=')||line.startsWith('ORCA orchestration send --to ')).join('\n');
for(const [placeholder,value] of [['<dispatch-id>','dispatch-1'],['<child-dispatch-id>','dispatch-child'],['<nested-dispatch-id>','dispatch-nested'],['<coordinator-handle>','term-parent']])script=script.replaceAll(placeholder,value);
for(const placeholder of ['<確定済みの実タスク本文>','<確定済みのchild task本文>','<literal body>'])script=script.replaceAll(placeholder,fs.readFileSync(bodyFile,'utf8').replace(/\n+$/,''));
fs.writeFileSync(target,script+'\n');
JS
  cat >"$fake_cli" <<'JS'
#!/usr/bin/env node
const fs=require('node:fs');fs.appendFileSync(process.env.ARGV_CAPTURE,JSON.stringify(process.argv.slice(2))+'\n');
JS
  chmod +x "$fake_cli"
  run env ARGV_CAPTURE="$BATS_TEST_TMPDIR/argv.jsonl" PATH="$BATS_TEST_TMPDIR:$PATH" task_body_file="$body_file" READINESS_LITERAL=expanded READINESS_SHELL_MARKER="$BATS_TEST_TMPDIR/shell-marker" READINESS_BACKTICK_MARKER="$BATS_TEST_TMPDIR/backtick-marker" bash "$example"
  [ "$status" -eq 0 ]
  [ ! -e "$BATS_TEST_TMPDIR/shell-marker" ]
  [ ! -e "$BATS_TEST_TMPDIR/backtick-marker" ]
  node - "$BATS_TEST_TMPDIR/argv.jsonl" "$body_file" <<'JS'
const fs=require('node:fs'),assert=require('node:assert/strict');const [source,bodyFile]=process.argv.slice(2);
const calls=fs.readFileSync(source,'utf8').trim().split('\n').map(JSON.parse),body=fs.readFileSync(bodyFile,'utf8').replace(/\n+$/,'');
const expected=[];
for(const [target,sender,subject,kind] of [['dispatch-1',[],'実タスク開始','dispatch'],['dispatch-child',[],'実タスク開始','dispatch'],['dispatch-nested',['--from','term-parent'],'follow-up','status']])expected.push(['orchestration','send','--to','dispatch:'+target,...sender,'--subject',subject,'--body',body,'--type',kind,'--json']);
assert.deepEqual(calls,expected);
JS
}

@test "Orca guidance separates worker, coordinator, nested inbox, and report evidence" {
  section() {
    awk -v heading="$1" '
      BEGIN { match(heading, /^#+/); level = RLENGTH }
      $0 == heading { found = 1; in_section = 1; next }
      in_section && /^#+[[:space:]]/ {
        match($0, /^#+/)
        if (RLENGTH <= level) exit
      }
      in_section { print }
      END { if (!found) exit 1 }
    ' "$ORCA_DOC"
  }

  ordinary_worker="$(section '### 普通の dispatched worker')"
  nested_coordinator="$(section '### nested coordinator')"
  coordinator="$(section '### coordinator')"
  inbox_settlement="$(section '## inbox / settlement')"
  verification_record="$(section '## 検証記録')"
  worktree_readiness="$(section '## Worktree readiness')"

  [[ "$ordinary_worker" == *'通常の dispatched worker は `--run` を付けず'* ]]
  [[ "$nested_coordinator" == *'上位 coordinator から自分の Dispatch 宛てに届く follow-up'* ]]
  [[ "$nested_coordinator" == *'Task の初回 spec は準備確認だけにし'* ]]
  [[ "$nested_coordinator" == *'task-create --spec "準備確認のみ: native Task / Dispatch / handle と現在の checkout を記録して報告し、親の照合まで待つ"'* ]]
  [[ "$nested_coordinator" == *'--to "dispatch:<child-dispatch-id>"'* ]]
  [[ "$nested_coordinator" == *'--type dispatch --json'* ]]
  [[ "$inbox_settlement" == *'`consumer_fenced` を受けたら停止し'* ]]
  [[ "$verification_record" == *'全採点と native receipt が確定し、一つにまとまった evidence packet'* ]]
  [[ "$verification_record" == *'usage が取得できない場合は `null`'* ]]
  [[ "$worktree_readiness" == *'ローカル変更につながる診断・実装を Git task worktree で監督するとき'* ]]
  [[ "$worktree_readiness" == *'remote placement では親の local path から worker 側を推測せず'* ]]
  [[ "$worktree_readiness" == *'照合成功後だけ親は `dispatch:<dispatch-id>` 宛てに実タスク本文を送る'* ]]
  [[ "$coordinator" == *'準備確認のみ: native Task / Dispatch / handle と現在の checkout を記録して報告し、親の照合まで待つ'* ]]
  [[ "$worktree_readiness" == *'--type dispatch --json'* ]]
  [[ "$worktree_readiness" == *'--branch <assigned-branch> --head <assigned-start-head>'* ]]
}
