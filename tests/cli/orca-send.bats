#!/usr/bin/env bats

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  ORCA_SEND="$PROJECT_ROOT/bin/orca-send"
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
