#!/usr/bin/env bats

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  OWNER_CLI="${TEST_MANAGED_CHROME_OWNER:-$PROJECT_ROOT/bin/managed-chrome-owner}"
  OWNER_MODULE="$PROJECT_ROOT/libexec/managed-chrome-owner.mjs"
  export BROWSER_OWNERSHIP_DIR="$BATS_TEST_TMPDIR/ownership"
  export PWCLI_RUNTIME_DIR="$BATS_TEST_TMPDIR/runtime"
  export OWNER_PROBE_STATE="$BATS_TEST_TMPDIR/browser-state"
  export PWCLI_WINDOWS_SCRIPT="$BATS_TEST_TMPDIR/Windows script.ps1"
  export PWCLI_POWERSHELL="$BATS_TEST_TMPDIR/powershell.exe"
  export PWCLI_WSLPATH="$BATS_TEST_TMPDIR/wslpath"
  export OWNER_PROBE_ARGS="$BATS_TEST_TMPDIR/probe-args"
  touch "$PWCLI_WINDOWS_SCRIPT"
  printf '%s\n' absent >"$OWNER_PROBE_STATE"
  cat >"$PWCLI_POWERSHELL" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$OWNER_PROBE_ARGS"
while (($#)); do
  if [[ "$1" == -File ]]; then
    script="$2"
    break
  fi
  shift
done
if [[ ! -f "${script#Z:}" ]]; then
  printf '%s\n' fixture-script-missing
  exit 0
fi
cat "$OWNER_PROBE_STATE"
MOCK
  cat >"$PWCLI_WSLPATH" <<'MOCK'
#!/usr/bin/env bash
case "$1" in
  -w) printf 'Z:%s\n' "$2" ;;
  -u) printf '%s\n' "${2#Z:}" ;;
  *) exit 1 ;;
esac
MOCK
  chmod +x "$PWCLI_POWERSHELL" "$PWCLI_WSLPATH"
}

@test "既定の Windows 資産で各 role の直接 activate と recover が使える" {
  unset PWCLI_WINDOWS_SCRIPT DOGFOOD_WINDOWS_SCRIPT
  export DOGFOOD_POWERSHELL="$PWCLI_POWERSHELL" DOGFOOD_WSLPATH="$PWCLI_WSLPATH"
  local role token script
  for role in attachment playwright dogfood; do
    script="$PROJECT_ROOT/libexec/playwright-cli-windows.ps1"
    [[ "$role" == dogfood ]] && script="$PROJECT_ROOT/libexec/dogfood-chrome-windows.ps1"
    token="$(owner --identity "$role" reserve --role "$role" --id "$role" --pid "$$" \
      --mode headless --profile "$BATS_TEST_TMPDIR/profile" --endpoint http://127.0.0.1:9222)"
    owner --identity "$role" run "$token" -- true
    printf '%s\n' managed:headless:4242 >"$OWNER_PROBE_STATE"

    run owner --identity "$role" activate "$token"
    [ "$status" -eq 0 ]
    grep -Fxq -- "Z:$script" "$OWNER_PROBE_ARGS"
    run owner --identity "$role" status
    [[ "$output" == *'"phase":"active"'* ]]

    run owner --identity "$role" recover
    [ "$status" -ne 0 ]
    [[ "$output" == *"Chrome is still running"* ]]
    printf '%s\n' absent >"$OWNER_PROBE_STATE"
    run owner --identity "$role" recover
    [ "$status" -eq 0 ]
    grep -Fxq -- "Z:$script" "$OWNER_PROBE_ARGS"
    run owner --identity "$role" status
    [ "$output" = null ]
  done
}

@test "Managed Chrome ownership is released only after the browser stops" {
  local token
  token="$(reserve playwright lifecycle)"
  owner run "$token" -- sh -c 'printf "%s\n" managed:headless:4242 >"$OWNER_PROBE_STATE"'
  run owner activate "$token"
  [ "$status" -eq 0 ]

  run owner release "$token"
  [ "$status" -ne 0 ]
  [[ "$output" == *"still running"* ]]

  printf '%s\n' absent >"$OWNER_PROBE_STATE"
  run owner release "$token"
  [ "$status" -eq 0 ]
  run owner status
  [ "$output" = null ]
}

@test "欠落した明示 Windows 資産は記録と profile を保持して理由を示す" {
  local token before missing
  mkdir "$BATS_TEST_TMPDIR/profile"
  printf '%s\n' authentication >"$BATS_TEST_TMPDIR/profile/authentication"
  token="$(owner reserve --role playwright --id missing-script --pid "$$" --mode headless \
    --profile "$BATS_TEST_TMPDIR/profile" --endpoint http://127.0.0.1:9222)"
  owner run "$token" -- true
  printf '%s\n' managed:headless:4242 >"$OWNER_PROBE_STATE"
  owner activate "$token"
  before="$(owner status)"

  for missing in "$BATS_TEST_TMPDIR/missing script.ps1" "Z:$BATS_TEST_TMPDIR/missing script.ps1"; do
    export PWCLI_WINDOWS_SCRIPT="$missing"
    run owner recover
    [ "$status" -ne 0 ]
    [[ "$output" == *"Windows script unavailable"* ]]
    [[ "$output" == *"$missing"* ]]
    run owner activate "$token"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Windows script unavailable"* ]]
    run owner status
    [ "$status" -eq 0 ]
    [ "$output" = "$before" ]
    [ "$(cat "$BATS_TEST_TMPDIR/profile/authentication")" = authentication ]
  done

  export PWCLI_WINDOWS_SCRIPT="Z:$BATS_TEST_TMPDIR/Windows script.ps1"
  run owner activate "$token"
  [ "$status" -eq 0 ]
  grep -Fxq -- "$PWCLI_WINDOWS_SCRIPT" "$OWNER_PROBE_ARGS"
  printf '%s\n' absent >"$OWNER_PROBE_STATE"
  run owner recover
  [ "$status" -eq 0 ]
  [ "$(cat "$BATS_TEST_TMPDIR/profile/authentication")" = authentication ]
}

@test "欠落した既定 Windows 資産を直接呼出しで特定できる" {
  local copy="$BATS_TEST_TMPDIR/package copy" token before
  mkdir -p "$copy/bin" "$copy/libexec"
  cp "$OWNER_CLI" "$copy/bin/managed-chrome-owner"
  cp "$PROJECT_ROOT"/libexec/*.mjs "$copy/libexec/"
  token="$(reserve attachment missing-default)"
  owner run "$token" -- true
  printf '%s\n' managed:headless:4242 >"$OWNER_PROBE_STATE"
  owner activate "$token"
  before="$(owner status)"
  unset PWCLI_WINDOWS_SCRIPT

  run "$copy/bin/managed-chrome-owner" recover
  [ "$status" -ne 0 ]
  [[ "$output" == *"Windows script unavailable"* ]]
  [[ "$output" == *"$copy/libexec/playwright-cli-windows.ps1"* ]]
  run "$copy/bin/managed-chrome-owner" status
  [ "$status" -eq 0 ]
  [ "$output" = "$before" ]

  printf '%s\n' absent >"$OWNER_PROBE_STATE"
  run owner recover
  [ "$status" -eq 0 ]
}

@test "Dogfood の Windows 形式の明示上書きを既定資産より優先する" {
  export DOGFOOD_WINDOWS_SCRIPT="Z:$PWCLI_WINDOWS_SCRIPT"
  export DOGFOOD_POWERSHELL="$PWCLI_POWERSHELL" DOGFOOD_WSLPATH="$PWCLI_WSLPATH"
  local token
  token="$(reserve dogfood override-script)"
  owner run "$token" -- true
  printf '%s\n' managed:headless:4242 >"$OWNER_PROBE_STATE"
  run owner activate "$token"
  [ "$status" -eq 0 ]
  grep -Fxq -- "$DOGFOOD_WINDOWS_SCRIPT" "$OWNER_PROBE_ARGS"
  printf '%s\n' absent >"$OWNER_PROBE_STATE"
  run owner recover
  [ "$status" -eq 0 ]
}

@test "Windows 照会の失敗・競合・不明応答で復旧が記録を解放しない" {
  local token before state
  token="$(reserve playwright unsafe-probe)"
  owner run "$token" -- true
  printf '%s\n' managed:headless:4242 >"$OWNER_PROBE_STATE"
  owner activate "$token"
  before="$(owner status)"
  for state in port-conflict:5150 profile-conflict:4242 unknown ''; do
    printf '%s\n' "$state" >"$OWNER_PROBE_STATE"
    run owner recover
    [ "$status" -ne 0 ]
    [[ "$output" == *"Chrome state is unconfirmed"* ]]
    run owner status
    [ "$output" = "$before" ]
  done
  cp "$PWCLI_POWERSHELL" "$BATS_TEST_TMPDIR/working-probe"
  cat >"$PWCLI_POWERSHELL" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' fixture-inspection-failed >&2
exit 42
MOCK
  run owner recover
  [ "$status" -ne 0 ]
  [[ "$output" == *fixture-inspection-failed* ]]
  run owner status
  [ "$output" = "$before" ]
  cp "$BATS_TEST_TMPDIR/working-probe" "$PWCLI_POWERSHELL"
  printf '%s\n' absent >"$OWNER_PROBE_STATE"
  run owner recover
  [ "$status" -eq 0 ]
}

owner() {
  "$OWNER_CLI" "$@"
}

reserve() {
  owner reserve --role "$1" --id "$2" --pid "$$" --mode headless \
    --profile 'C:\\managed-profile' --endpoint http://127.0.0.1:9222
}

@test "Managed Chrome ownership permits only one competing reservation" {
  run reserve playwright first
  [ "$status" -eq 0 ]
  local token="$output"

  run reserve dogfood second
  [ "$status" -ne 0 ]
  [[ "$output" == *"already owned by 'first'"* ]]

  run owner status
  [ "$status" -eq 0 ]
  [[ "$output" == *"$token"* ]]
  [[ "$output" == *'"phase":"reserved"'* ]]
}

@test "explicit recovery keeps a live reservation and reclaims an abandoned one" {
  local token
  token="$(reserve playwright live-reservation)"
  run owner recover
  [ "$status" -ne 0 ]
  [[ "$output" == *"startup"* ]]
  owner release "$token"

  token="$(bash -c 'node "$1" reserve --role playwright --id abandoned --pid "$$" --mode headless --profile profile --endpoint http://127.0.0.1:9222' _ "$OWNER_MODULE")"
  run owner recover
  [ "$status" -eq 0 ]
  run owner status
  [ "$output" = null ]
}

@test "bare recovery refuses to no-op past an abandoned identity-scoped owner" {
  bash -c 'node "$1" --identity abandoned-identity reserve --role playwright --id abandoned-identity --pid "$$" --mode headless --profile profile --endpoint http://127.0.0.1:9222' \
    _ "$OWNER_MODULE"

  run owner recover
  [ "$status" -ne 0 ]
  [[ "$output" == *"--identity"* ]]

  run owner status --identity abandoned-identity
  [[ "$output" == *'"id":"abandoned-identity"'* ]]

  run owner --identity abandoned-identity recover
  [ "$status" -eq 0 ]
  run owner status --identity abandoned-identity
  [ "$output" = null ]
}

@test "recovery cannot steal a reservation while the startup command is running" {
  local token startup_pid
  token="$(reserve playwright starting)"
  owner run "$token" -- sh -c 'touch "$1"; while [ ! -e "$2" ]; do sleep 0.02; done' _ \
    "$BATS_TEST_TMPDIR/started" "$BATS_TEST_TMPDIR/finish" &
  startup_pid=$!
  for _ in {1..100}; do
    [[ -e "$BATS_TEST_TMPDIR/started" ]] && break
    sleep 0.02
  done
  run owner recover
  local recovery_status="$status"
  touch "$BATS_TEST_TMPDIR/finish"
  wait "$startup_pid"
  [ "$recovery_status" -ne 0 ]
  [[ "$output" == *"in progress"* ]]
  run owner recover
  [ "$status" -ne 0 ]
  [[ "$output" == *"live startup reservation"* ]]
  owner release "$token"
}

@test "recovery keeps a live caller's reservation after the launcher returns" {
  local token
  token="$(reserve playwright waiting-for-cdp)"
  owner run "$token" -- true

  run owner recover
  [ "$status" -ne 0 ]
  [[ "$output" == *"live startup reservation"* ]]
  run reserve dogfood competing
  [ "$status" -ne 0 ]
  [[ "$output" == *"already owned by 'waiting-for-cdp'"* ]]

  owner release "$token"
  run owner status
  [ "$output" = null ]
}

@test "a caller can cancel an unused reservation despite a preflight conflict" {
  local token state
  for state in chrome-missing port-conflict:5150 profile-conflict:4242; do
    token="$(reserve playwright cancelled)"
    printf '%s\n' "$state" >"$OWNER_PROBE_STATE"

    run owner release "$token"
    [ "$status" -eq 0 ]
    run owner status
    [ "$output" = null ]

    run owner run "$token" -- touch "$BATS_TEST_TMPDIR/unexpected-start"
    [ "$status" -ne 0 ]
    [[ "$output" == *"outdated request"* ]]
    [ ! -e "$BATS_TEST_TMPDIR/unexpected-start" ]
  done
}

@test "recovery reclaims a completed startup after its caller exits" {
  bash -c '
    token="$(node "$1" reserve --role playwright --id abandoned-startup --pid "$$" --mode headless --profile profile --endpoint http://127.0.0.1:9222)"
    node "$1" run "$token" -- true
  ' _ "$OWNER_MODULE"

  run owner recover
  [ "$status" -eq 0 ]
  run owner status
  [ "$output" = null ]
}

@test "old acquisition locks require an explicit cutover instead of automatic removal" {
  mkdir -p "$BROWSER_OWNERSHIP_DIR/acquire.lock"
  printf '99999999\n' >"$BROWSER_OWNERSHIP_DIR/acquire.lock/pid"
  run reserve playwright migration
  [ "$status" -ne 0 ]
  [[ "$output" == *"Legacy"* ]]
  [ -f "$BROWSER_OWNERSHIP_DIR/acquire.lock/pid" ]
}

@test "incomplete and old ownership records are preserved instead of treated as free" {
  mkdir -p "$BROWSER_OWNERSHIP_DIR"
  printf '%s\n' '{"version":1,"token":"test","role":"playwright"}' >"$BROWSER_OWNERSHIP_DIR/owner"
  run owner status
  [ "$status" -ne 0 ]
  [[ "$output" == *"invalid ownership"* ]]
  run owner recover
  [ "$status" -ne 0 ]
  printf '%s\n' playwright old 4242 headless profile http://127.0.0.1:9222 workspace >"$BROWSER_OWNERSHIP_DIR/owner"
  run reserve dogfood new
  [ "$status" -ne 0 ]
  [[ "$output" == *"Legacy"* ]]
  [ "$(head -n 1 "$BROWSER_OWNERSHIP_DIR/owner")" = playwright ]
}

@test "recovery preserves records with malformed caller identities" {
  reserve playwright malformed-caller >/dev/null
  cp "$BROWSER_OWNERSHIP_DIR/owner" "$BATS_TEST_TMPDIR/valid-owner"
  local field value
  for field in start boot; do
    for value in '' unknown; do
      python3 - "$BATS_TEST_TMPDIR/valid-owner" "$BROWSER_OWNERSHIP_DIR/owner" "$field" "$value" <<'PY'
import json, pathlib, sys
record = json.loads(pathlib.Path(sys.argv[1]).read_text())
record['caller'][sys.argv[3]] = sys.argv[4]
pathlib.Path(sys.argv[2]).write_text(json.dumps(record))
PY
      cp "$BROWSER_OWNERSHIP_DIR/owner" "$BATS_TEST_TMPDIR/invalid-owner"
      run owner recover
      [ "$status" -ne 0 ]
      [[ "$output" == *"invalid ownership"* ]]
      cmp "$BROWSER_OWNERSHIP_DIR/owner" "$BATS_TEST_TMPDIR/invalid-owner"
    done
  done
}

@test "recovery preserves records whose phase contradicts the browser identity" {
  reserve playwright malformed-phase >/dev/null
  cp "$BROWSER_OWNERSHIP_DIR/owner" "$BATS_TEST_TMPDIR/valid-owner"
  local phase
  for phase in reserved starting settled active; do
    python3 - "$BATS_TEST_TMPDIR/valid-owner" "$BROWSER_OWNERSHIP_DIR/owner" "$phase" <<'PY'
import json, pathlib, sys
record = json.loads(pathlib.Path(sys.argv[1]).read_text())
record['phase'] = sys.argv[3]
record['browserPid'] = None if record['phase'] == 'active' else 4242
pathlib.Path(sys.argv[2]).write_text(json.dumps(record))
PY
    cp "$BROWSER_OWNERSHIP_DIR/owner" "$BATS_TEST_TMPDIR/invalid-owner"
    run owner recover
    [ "$status" -ne 0 ]
    [[ "$output" == *"invalid ownership"* ]]
    cmp "$BROWSER_OWNERSHIP_DIR/owner" "$BATS_TEST_TMPDIR/invalid-owner"
  done
}

@test "Windows inspection distinguishes query failure from an absent browser" {
  command -v powershell.exe >/dev/null || skip "Windows PowerShell is unavailable"
  local harness script role query
  harness="$(wslpath -w "$PROJECT_ROOT/tests/fixtures/managed-chrome-inspection.ps1")"
  for role in playwright dogfood; do
    script="$PROJECT_ROOT/libexec/playwright-cli-windows.ps1"
    [[ "$role" == dogfood ]] && script="$PROJECT_ROOT/libexec/dogfood-chrome-windows.ps1"
    script="$(wslpath -w "$script")"
    for query in process port; do
      run powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$harness" \
        -ScriptPath "$script" -Scenario "$query" -Role "$role"
      [ "$status" -ne 0 ]
      [[ "$output" == *"query unavailable"* ]]
    done
  done
}

@test "Windows inspection filters the selected listener and preserves its owner" {
  command -v powershell.exe >/dev/null || skip "Windows PowerShell is unavailable"
  local harness script role scenario expected
  harness="$(wslpath -w "$PROJECT_ROOT/tests/fixtures/managed-chrome-inspection.ps1")"
  for role in playwright dogfood; do
    script="$PROJECT_ROOT/libexec/playwright-cli-windows.ps1"
    [[ "$role" == dogfood ]] && script="$PROJECT_ROOT/libexec/dogfood-chrome-windows.ps1"
    script="$(wslpath -w "$script")"
    for scenario in absent conflict conflict-bare conflict-quoted conflict-lookup-fails conflict-gone managed; do
      case "$scenario" in
        absent) expected=absent ;;
        conflict) expected=port-conflict:4242 ;;
        conflict-*) expected=port-conflict:4242 ;;
        managed) expected=managed:headless:4242 ;;
      esac
      # Dogfood also names the owner (its --user-data-dir, else the executable name).
      if [[ "$role" == dogfood ]]; then
        case "$scenario" in
          conflict) expected='port-conflict:4242:C:\other profile\aiakos-dogfood-x' ;;
          conflict-quoted) expected='port-conflict:4242:C:\other profile\aiakos-dogfood-x' ;;
          conflict-bare) expected='port-conflict:4242:node.exe' ;;
          conflict-lookup-fails | conflict-gone) expected='port-conflict:4242:unknown' ;;
        esac
      fi
      run powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$harness" \
        -ScriptPath "$script" -Scenario "$scenario" -Role "$role"
      [ "$status" -eq 0 ]
      [ "${output%$'\r'}" = "$expected" ]
    done
  done
}

dogfood_cleanup() {
  run powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
    -File "$(wslpath -w "$PROJECT_ROOT/tests/fixtures/managed-chrome-cleanup.ps1")" \
    -ScriptPath "$(wslpath -w "$PROJECT_ROOT/libexec/dogfood-chrome-windows.ps1")" \
    -Scenario "$1"
  [ "$status" -eq 0 ]
  output="${output//$'\r'/}"
}

@test "Dogfood cleanup stops profile processes that appear after the first stop" {
  command -v powershell.exe >/dev/null || skip "Windows PowerShell is unavailable"
  dogfood_cleanup respawn
  [ "$output" = "result:ok removed:True" ]
}

@test "Dogfood cleanup waits for processes that exit slowly under load" {
  command -v powershell.exe >/dev/null || skip "Windows PowerShell is unavailable"
  dogfood_cleanup slow
  [ "$output" = "result:ok removed:True" ]
}

@test "Dogfood cleanup keeps the profile when processes never exit" {
  command -v powershell.exe >/dev/null || skip "Windows PowerShell is unavailable"
  dogfood_cleanup stuck
  [ "$output" = "result:failed removed:False Managed Chrome did not exit for profile 'C:\\test-profile'." ]
}
