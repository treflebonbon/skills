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
