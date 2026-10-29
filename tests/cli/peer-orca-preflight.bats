#!/usr/bin/env bats

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$PROJECT_ROOT/skills/orca-peer-refactor/scripts/orca-preflight.py"
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

readiness_git() {
  python3 - "$@" <<'PY'
import os, subprocess, sys
env = {key: os.environ[key] for key in os.environ if not key.startswith("GIT_")}
subprocess.run(["git", *sys.argv[1:]], env=env, check=True)
PY
}

readiness_git_value() {
  python3 - "$@" <<'PY'
import os, subprocess, sys
env = {key: os.environ[key] for key in os.environ if not key.startswith("GIT_")}
result = subprocess.run(["git", *sys.argv[1:]], env=env, check=True, capture_output=True, text=True)
sys.stdout.write(result.stdout[:-1] if result.stdout.endswith("\n") else result.stdout)
PY
}

readiness_git_identity() {
  python3 - "$1" <<'PY'
import os, subprocess, sys
env = {key: os.environ[key] for key in os.environ if not key.startswith("GIT_")}
root = sys.argv[1]
branch = subprocess.run(["git", "-C", root, "branch", "--show-current"], env=env, check=True, capture_output=True, text=True).stdout.rstrip("\n")
head = subprocess.run(["git", "-C", root, "rev-parse", "--verify", "HEAD"], env=env, check=True, capture_output=True, text=True).stdout.rstrip("\n")
print(f"{branch}\t{head}")
PY
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
  python3 "$SCRIPT" worker-readiness verify "$1" --worktree "$2" --branch "$3" --head "$4" --task "$5" --dispatch "$6" --assignee "$7"
}

@test "coordinator receipt must match the expected Run and handle without changing it" {
  write_coordinator_receipt
  cp "$RECEIPT" "$BATS_TEST_TMPDIR/original.json"
  run python3 "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-1
  [ "$status" -eq 0 ]
  run python3 "$SCRIPT" coordinator "$RECEIPT" --run run-other --handle term-1
  [ "$status" -ne 0 ]
  run python3 "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-other
  [ "$status" -ne 0 ]
  run python3 "$SCRIPT" coordinator "$RECEIPT" --run '' --handle term-1
  [ "$status" -ne 0 ]
  cmp "$BATS_TEST_TMPDIR/original.json" "$RECEIPT"
  python3 - "$RECEIPT" <<'PY'
import json, sys
path = sys.argv[1]
doc = json.load(open(path, encoding="utf-8"))
doc["result"]["run"]["id"] = ""
json.dump(doc, open(path, "w", encoding="utf-8"))
PY
  cp "$RECEIPT" "$BATS_TEST_TMPDIR/empty.json"
  run python3 "$SCRIPT" coordinator "$RECEIPT" --run '' --handle term-1
  [ "$status" -ne 0 ]
  cmp "$BATS_TEST_TMPDIR/empty.json" "$RECEIPT"
}

@test "worker readiness must match the assigned checkout, including another worktree of the same repo" {
  local observation="$BATS_TEST_TMPDIR/worker-readiness.json" primary_observation="$BATS_TEST_TMPDIR/primary-readiness.json" branch head other_branch other_head primary_branch primary_head
  setup_readiness_fixture
  IFS=$'\t' read -r branch head <<<"$(readiness_git_identity "$WORKER_WORKTREE")"
  IFS=$'\t' read -r other_branch other_head <<<"$(readiness_git_identity "$OTHER_WORKTREE")"
  IFS=$'\t' read -r primary_branch primary_head <<<"$(readiness_git_identity "$PRIMARY_WORKTREE")"

  cd "$WORKER_WORKTREE"
  run python3 "$SCRIPT" worker-readiness record "$observation" --task task-1 --dispatch dispatch-1 --assignee term-1
  [ "$status" -eq 0 ]
  [[ "$output" == *"observation saved"* ]]
  cp "$observation" "$BATS_TEST_TMPDIR/worker-readiness.original.json"

  run worker_readiness_verify "$observation" "$WORKER_WORKTREE" "$branch" "$head" task-1 dispatch-1 term-1
  [ "$status" -eq 0 ]
  cmp "$BATS_TEST_TMPDIR/worker-readiness.original.json" "$observation"

  run worker_readiness_verify "$observation" "$OTHER_WORKTREE" "$other_branch" "$other_head" task-1 dispatch-1 term-1
  [ "$status" -ne 0 ]
  cmp "$BATS_TEST_TMPDIR/worker-readiness.original.json" "$observation"

  cd "$PRIMARY_WORKTREE"
  run python3 "$SCRIPT" worker-readiness record "$primary_observation" --task task-1 --dispatch dispatch-1 --assignee term-1
  [ "$status" -eq 0 ]
  run worker_readiness_verify "$primary_observation" "$PRIMARY_WORKTREE" "$primary_branch" "$primary_head" task-1 dispatch-1 term-1
  [ "$status" -ne 0 ]
}

@test "worker readiness rejects every changed checkout and native assignment field" {
  local observation="$BATS_TEST_TMPDIR/worker-readiness.json" variant="$BATS_TEST_TMPDIR/variant.json" field branch head wrong_head
  setup_readiness_fixture
  cd "$WORKER_WORKTREE"
  run python3 "$SCRIPT" worker-readiness record "$observation" --task task-1 --dispatch dispatch-1 --assignee term-1
  [ "$status" -eq 0 ]
  cp "$observation" "$BATS_TEST_TMPDIR/worker-readiness.original.json"
  branch=worker
  head="$(readiness_git_value -C "$WORKER_WORKTREE" rev-parse --verify HEAD)"
  wrong_head=0000000000000000000000000000000000000000

  run worker_readiness_verify "$observation" "$WORKER_WORKTREE" "${branch}-different" "$head" task-1 dispatch-1 term-1
  [ "$status" -ne 0 ]
  run worker_readiness_verify "$observation" "$WORKER_WORKTREE" "$branch" "$wrong_head" task-1 dispatch-1 term-1
  [ "$status" -ne 0 ]

  for field in cwd physical_root branch head git_dir common_dir task_id dispatch_id assignee_handle; do
    python3 - "$observation" "$variant" "$field" <<'PY'
import json, sys
source, target, field = sys.argv[1:]
doc = json.load(open(source, encoding="utf-8"))
doc[field] = "f" * 40 if field == "head" else doc[field] + "-different"
json.dump(doc, open(target, "w", encoding="utf-8"))
PY
    cp "$variant" "$BATS_TEST_TMPDIR/variant.original.json"
    run worker_readiness_verify "$variant" "$WORKER_WORKTREE" "$branch" "$head" task-1 dispatch-1 term-1
    [ "$status" -ne 0 ]
    cmp "$BATS_TEST_TMPDIR/variant.original.json" "$variant"
  done
  cmp "$BATS_TEST_TMPDIR/worker-readiness.original.json" "$observation"
}

@test "worker readiness rejects malformed, missing, empty, and non-string observation values" {
  local observation="$BATS_TEST_TMPDIR/worker-readiness.json" invalid="$BATS_TEST_TMPDIR/invalid.json" branch head
  setup_readiness_fixture
  cd "$WORKER_WORKTREE"
  run python3 "$SCRIPT" worker-readiness record "$observation" --task task-1 --dispatch dispatch-1 --assignee term-1
  [ "$status" -eq 0 ]
  branch=worker
  head="$(readiness_git_value -C "$WORKER_WORKTREE" rev-parse --verify HEAD)"
  printf '{not-json\n' >"$invalid"
  cp "$invalid" "$BATS_TEST_TMPDIR/invalid.original.json"
  run worker_readiness_verify "$invalid" "$WORKER_WORKTREE" "$branch" "$head" task-1 dispatch-1 term-1
  [ "$status" -ne 0 ]
  cmp "$BATS_TEST_TMPDIR/invalid.original.json" "$invalid"

  for field in missing empty non-string duplicate; do
    python3 - "$observation" "$invalid" "$field" <<'PY'
import json, sys
source, target, mutation = sys.argv[1:]
doc = json.load(open(source, encoding="utf-8"))
if mutation == "missing":
    del doc["head"]
elif mutation == "empty":
    doc["head"] = ""
elif mutation == "non-string":
    doc["branch"] = 42
else:
    with open(target, "w", encoding="utf-8") as stream:
        stream.write(json.dumps(doc)[:-1] + ', "branch": "duplicate"}\n')
        raise SystemExit(0)
with open(target, "w", encoding="utf-8") as stream:
    json.dump(doc, stream)
PY
    cp "$invalid" "$BATS_TEST_TMPDIR/invalid.original.json"
    run worker_readiness_verify "$invalid" "$WORKER_WORKTREE" "$branch" "$head" task-1 dispatch-1 term-1
    [ "$status" -ne 0 ]
    cmp "$BATS_TEST_TMPDIR/invalid.original.json" "$invalid"
  done
  run python3 "$SCRIPT" worker-readiness record "$BATS_TEST_TMPDIR/empty.json" --task task-1 --dispatch dispatch-1 --assignee ''
  [ "$status" -ne 0 ]
}

@test "worker readiness ignores ambient Git overrides and never executes shell-looking JSON" {
  local observation="$BATS_TEST_TMPDIR/worker-readiness.json" marker="$BATS_TEST_TMPDIR/should-not-exist" variant="$BATS_TEST_TMPDIR/variant.json" branch head
  setup_readiness_fixture
  branch=worker
  head="$(readiness_git_value -C "$WORKER_WORKTREE" rev-parse --verify HEAD)"
  cd "$WORKER_WORKTREE"
  run env GIT_DIR="$BATS_TEST_TMPDIR/not-a-git-dir" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0="$BATS_TEST_TMPDIR/not-a-worktree" python3 "$SCRIPT" worker-readiness record "$observation" --task task-1 --dispatch dispatch-1 --assignee term-1
  [ "$status" -eq 0 ]
  [[ "$output" != *"not-a-worktree"* ]]
  run grep -Fq "not-a-worktree" "$observation"
  [ "$status" -eq 1 ]
  run env GIT_DIR="$BATS_TEST_TMPDIR/not-a-git-dir" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0="$BATS_TEST_TMPDIR/not-a-worktree" python3 "$SCRIPT" worker-readiness verify "$observation" --worktree "$WORKER_WORKTREE" --branch "$branch" --head "$head" --task task-1 --dispatch dispatch-1 --assignee term-1
  [ "$status" -eq 0 ]
  [[ "$output" != *"not-a-worktree"* ]]

  python3 - "$observation" "$variant" "$marker" <<'PY'
import json, sys
source, target, marker = sys.argv[1:]
doc = json.load(open(source, encoding="utf-8"))
doc["branch"] = f"$(touch {marker})"
with open(target, "w", encoding="utf-8") as stream:
    json.dump(doc, stream)
PY
  cp "$variant" "$BATS_TEST_TMPDIR/variant.original.json"
  run worker_readiness_verify "$variant" "$WORKER_WORKTREE" "$branch" "$head" task-1 dispatch-1 term-1
  [ "$status" -ne 0 ]
  [ ! -e "$marker" ]
  cmp "$BATS_TEST_TMPDIR/variant.original.json" "$variant"
}

@test "coordinator rejects errors, malformed envelopes, and missing Run identity" {
  printf '{"ok":false,"error":{"code":"failed"}}\n' >"$RECEIPT"
  run python3 "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-1
  [ "$status" -ne 0 ]
  printf '{not-json\n' >"$RECEIPT"
  run python3 "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-1
  [ "$status" -ne 0 ]
  printf '{"ok":true,"result":{}}\n' >"$RECEIPT"
  run python3 "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-1
  [ "$status" -ne 0 ]
  printf '{"ok":true,"error":{"code":"failed"},"result":{"run":{"id":"run-1","coordinator_handle":"term-1"}}}\n' >"$RECEIPT"
  run python3 "$SCRIPT" coordinator "$RECEIPT" --run run-1 --handle term-1
  [ "$status" -ne 0 ]
}

@test "worker-show receipt must match the dispatched Task, Dispatch, and assignee" {
  write_worker_receipt
  cp "$RECEIPT" "$BATS_TEST_TMPDIR/original.json"
  run python3 "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-1
  [ "$status" -eq 0 ]
  run python3 "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-other --task task-1 --assignee term-1
  [ "$status" -ne 0 ]
  run python3 "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-other --assignee term-1
  [ "$status" -ne 0 ]
  run python3 "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-other
  [ "$status" -ne 0 ]
  cmp "$BATS_TEST_TMPDIR/original.json" "$RECEIPT"
}

@test "worker-show rejects settled or errored Dispatches" {
  write_worker_receipt
  python3 - "$RECEIPT" <<'PY'
import json, sys
path = sys.argv[1]
doc = json.load(open(path, encoding="utf-8"))
doc["result"]["dispatch"]["status"] = "completed"
json.dump(doc, open(path, "w", encoding="utf-8"))
PY
  run python3 "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-1
  [ "$status" -ne 0 ]
  printf '{"ok":false,"error":{"code":"failed"},"result":{"dispatch":{"id":"dispatch-1","taskId":"task-1","assigneeHandle":"term-1","status":"dispatched"}}}\n' >"$RECEIPT"
  run python3 "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-1
  [ "$status" -ne 0 ]
}

@test "worker-show rejects missing and malformed dispatch identities" {
  printf '{"ok":true,"result":{}}\n' >"$RECEIPT"
  run python3 "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-1
  [ "$status" -ne 0 ]
  printf '{"ok":true,"result":{"dispatch":{"id":"dispatch-1","taskId":"task-1","status":"dispatched"}}}\n' >"$RECEIPT"
  run python3 "$SCRIPT" worker-show "$RECEIPT" --dispatch dispatch-1 --task task-1 --assignee term-1
  [ "$status" -ne 0 ]
}

@test "orca-send preserves the UTF-8 body, selects the requested CLI, and returns its exit code" {
  local selected="$BATS_TEST_TMPDIR/selected-orca" other="$BATS_TEST_TMPDIR/bin/orca-ide" body_file="$BATS_TEST_TMPDIR/message body.md" marker="$BATS_TEST_TMPDIR/shell marker" backtick_marker="$BATS_TEST_TMPDIR/backtick marker"
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  cat >"$selected" <<'PY'
#!/usr/bin/env python3
import json, os, sys
with open(os.environ["ARGV_CAPTURE"], "wb") as stream:
    stream.write(json.dumps(sys.argv[1:], ensure_ascii=False).encode("utf-8"))
sys.exit(int(os.environ.get("ORCA_EXIT", "0")))
PY
  cat >"$other" <<'SH'
#!/usr/bin/env sh
touch "$OTHER_CLI_MARKER"
SH
  chmod +x "$selected" "$other"
  python3 - "$body_file" "$marker" "$backtick_marker" <<'PY'
from pathlib import Path
import sys
body_file, marker, backtick_marker = sys.argv[1:]
Path(body_file).write_bytes((f'本文🙂\r\nliteral $HOME、$(touch "{marker}")、`touch "{backtick_marker}"`、"二重引用符"、\'一重引用符\'\n').encode("utf-8"))
PY
  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" ARGV_CAPTURE="$BATS_TEST_TMPDIR/argv.json" OTHER_CLI_MARKER="$BATS_TEST_TMPDIR/other-called" "$ORCA_SEND" --cli "$selected" --body-file "$body_file" -- --to dispatch:dispatch-1 --subject status --type status --json
  [ "$status" -eq 0 ]
  [ ! -e "$BATS_TEST_TMPDIR/other-called" ]
  [ ! -e "$marker" ]
  [ ! -e "$backtick_marker" ]
  python3 - "$BATS_TEST_TMPDIR/argv.json" "$body_file" <<'PY'
import json, sys
from pathlib import Path
argv = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
body = Path(sys.argv[2]).read_bytes().decode("utf-8")
assert argv == ["orchestration", "send", "--body", body, "--to", "dispatch:dispatch-1", "--subject", "status", "--type", "status", "--json"], argv
PY
  run env ARGV_CAPTURE="$BATS_TEST_TMPDIR/exit-argv.json" ORCA_EXIT=37 "$ORCA_SEND" --cli "$selected" --body-file "$body_file" -- --to dispatch:dispatch-1
  [ "$status" -eq 37 ]
}

@test "orca-send rejects duplicate, empty, unreadable, and invalid UTF-8 bodies before invoking Orca" {
  local fake_cli="$BATS_TEST_TMPDIR/orca-ide" body_file="$BATS_TEST_TMPDIR/body.md" invalid_file="$BATS_TEST_TMPDIR/invalid.md"
  cat >"$fake_cli" <<'PY'
#!/usr/bin/env python3
import os
open(os.environ["ORCA_CALLED"], "w").close()
PY
  chmod +x "$fake_cli"
  printf '本文\n' >"$body_file"
  : >"$invalid_file"
  printf '\377' >"$invalid_file"
  for duplicate in --body --body=duplicate -b -b=duplicate --body-file=other; do
    run env ORCA_CALLED="$BATS_TEST_TMPDIR/orca-called" "$ORCA_SEND" --cli "$fake_cli" --body-file "$body_file" -- "$duplicate"
    [ "$status" -eq 2 ]
    [ ! -e "$BATS_TEST_TMPDIR/orca-called" ]
  done
  run env ORCA_CALLED="$BATS_TEST_TMPDIR/orca-called" "$ORCA_SEND" --cli "$fake_cli" --body-file "$BATS_TEST_TMPDIR/missing.md" -- --to dispatch:dispatch-1
  [ "$status" -eq 2 ]
  [ ! -e "$BATS_TEST_TMPDIR/orca-called" ]
  run env ORCA_CALLED="$BATS_TEST_TMPDIR/orca-called" "$ORCA_SEND" --cli "$fake_cli" --body-file "$invalid_file" -- --to dispatch:dispatch-1
  [ "$status" -eq 2 ]
  [ ! -e "$BATS_TEST_TMPDIR/orca-called" ]
  : >"$body_file"
  run env ORCA_CALLED="$BATS_TEST_TMPDIR/orca-called" "$ORCA_SEND" --cli "$fake_cli" --body-file "$body_file" -- --to dispatch:dispatch-1
  [ "$status" -eq 2 ]
  [ ! -e "$BATS_TEST_TMPDIR/orca-called" ]
  printf '\000' >"$body_file"
  run env ORCA_CALLED="$BATS_TEST_TMPDIR/orca-called" "$ORCA_SEND" --cli "$fake_cli" --body-file "$body_file" -- --to dispatch:dispatch-1
  [ "$status" -eq 2 ]
  [ ! -e "$BATS_TEST_TMPDIR/orca-called" ]
  run "$ORCA_SEND" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"UTF-8本文ファイル"* ]]
}

@test "orca-send limits the UTF-8 body to 8 KiB before invoking Orca" {
  local fake_cli="$BATS_TEST_TMPDIR/orca-ide" body_file="$BATS_TEST_TMPDIR/body.md"
  cat >"$fake_cli" <<'PY'
#!/usr/bin/env python3
import os
from pathlib import Path
Path(os.environ["ORCA_CALLED"]).touch()
PY
  chmod +x "$fake_cli"
  python3 - "$body_file" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_bytes(("あ" * 2730 + "ab").encode("utf-8"))
PY
  run env ORCA_CALLED="$BATS_TEST_TMPDIR/limit-called" "$ORCA_SEND" --cli "$fake_cli" --body-file "$body_file" -- --to dispatch:dispatch-1
  [ "$status" -eq 0 ]
  [ -e "$BATS_TEST_TMPDIR/limit-called" ]
  printf 'c' >>"$body_file"
  run env ORCA_CALLED="$BATS_TEST_TMPDIR/oversize-called" "$ORCA_SEND" --cli "$fake_cli" --body-file "$body_file" -- --to dispatch:dispatch-1
  [ "$status" -eq 2 ]
  [[ "$output" == *"本文は8 KiB以内"* ]]
  [ ! -e "$BATS_TEST_TMPDIR/oversize-called" ]
  run "$ORCA_SEND" --help
  [[ "$output" == *"argv"* ]]
}

@test "the documented Python sender calls orca-send and preserves shell-looking body text" {
  local example="$BATS_TEST_TMPDIR/example.py" bin="$BATS_TEST_TMPDIR/bin" body_file="$BATS_TEST_TMPDIR/task body.md"
  mkdir -p "$bin"
  ln -s "$ORCA_SEND" "$bin/orca-send"
  cat >"$body_file" <<'BODY'
レビューの要点:
literal $HOME、$(printf test)、`バッククォート`、"二重引用符"、'一重引用符' を含む。
BODY
  awk '
    $0 == "<!-- literal-safe-example:start -->" { example = 1; next }
    example && $0 == "```python" { code = 1; next }
    code && $0 == "```" { exit }
    code { print }
  ' "$ORCA_DOC" >"$example"
  [ -s "$example" ]
  cat >"$bin/orca-ide" <<'PY'
#!/usr/bin/env python3
import json, os, sys
with open(os.environ["ARGV_CAPTURE"], "w", encoding="utf-8") as stream:
    json.dump(sys.argv[1:], stream, ensure_ascii=False)
PY
  chmod +x "$bin/orca-ide"
  run env SKILL_DIR="$PROJECT_ROOT/skills/orca-peer-refactor" ORCA_CLI=orca-ide ORCA_BODY_FILE="$body_file" ARGV_CAPTURE="$BATS_TEST_TMPDIR/argv.json" PATH="$bin:$PATH" python3 "$example"
  [ "$status" -eq 0 ]
  python3 - "$BATS_TEST_TMPDIR/argv.json" "$body_file" <<'PY'
import json, sys
from pathlib import Path
argv = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
body = Path(sys.argv[2]).read_text(encoding="utf-8")
assert argv == [
    "orchestration", "send", "--body", body,
    "--to", "run:<run-id>", "--run", "<run-id>", "--from", "<sender-handle>",
    "--subject", "レビュー依頼", "--type", "status", "--json",
], argv
PY
}

@test "documented shell sends preserve file body text without shell expansion" {
  local example="$BATS_TEST_TMPDIR/send.sh" fake_cli="$BATS_TEST_TMPDIR/ORCA" body_file="$BATS_TEST_TMPDIR/task body.md"
  cat >"$body_file" <<'BODY'
本文:
literal $READINESS_LITERAL、$(touch "$READINESS_SHELL_MARKER")、`touch "$READINESS_BACKTICK_MARKER"`、"二重引用符"、'一重引用符'
BODY
  python3 - "$ORCA_DOC" "$example" "$body_file" <<'PY'
from pathlib import Path
import sys
doc, target, body_file = map(Path, sys.argv[1:])
lines = [line for line in doc.read_text().splitlines() if line.startswith(("task_body=", "ORCA orchestration send --to "))]
script = "\n".join(lines)
for placeholder, value in (
    ("<dispatch-id>", "dispatch-1"),
    ("<child-dispatch-id>", "dispatch-child"),
    ("<nested-dispatch-id>", "dispatch-nested"),
    ("<coordinator-handle>", "term-parent"),
):
    script = script.replace(placeholder, value)
for placeholder in ("<確定済みの実タスク本文>", "<確定済みのchild task本文>", "<literal body>"):
    script = script.replace(placeholder, body_file.read_text().rstrip("\n"))
target.write_text(script + "\n")
PY
  cat >"$fake_cli" <<'PY'
#!/usr/bin/env python3
import json, os, sys
with open(os.environ["ARGV_CAPTURE"], "a", encoding="utf-8") as stream:
    stream.write(json.dumps(sys.argv[1:], ensure_ascii=False) + "\n")
PY
  chmod +x "$fake_cli"
  run env ARGV_CAPTURE="$BATS_TEST_TMPDIR/argv.jsonl" PATH="$BATS_TEST_TMPDIR:$PATH" task_body_file="$body_file" READINESS_LITERAL=expanded READINESS_SHELL_MARKER="$BATS_TEST_TMPDIR/shell-marker" READINESS_BACKTICK_MARKER="$BATS_TEST_TMPDIR/backtick-marker" bash "$example"
  [ "$status" -eq 0 ]
  [ ! -e "$BATS_TEST_TMPDIR/shell-marker" ]
  [ ! -e "$BATS_TEST_TMPDIR/backtick-marker" ]
  python3 - "$BATS_TEST_TMPDIR/argv.jsonl" "$body_file" <<'PY'
import json, sys
from pathlib import Path
calls = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
body = Path(sys.argv[2]).read_text().rstrip("\n")
expected = []
for target, sender, subject, kind in (
    ("dispatch-1", [], "実タスク開始", "dispatch"),
    ("dispatch-child", [], "実タスク開始", "dispatch"),
    ("dispatch-nested", ["--from", "term-parent"], "follow-up", "status"),
):
    expected.append(["orchestration", "send", "--to", f"dispatch:{target}", *sender, "--subject", subject, "--body", body, "--type", kind, "--json"])
assert calls == expected, calls
PY
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
