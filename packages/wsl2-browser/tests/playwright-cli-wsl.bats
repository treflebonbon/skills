#!/usr/bin/env bats

setup() {
  PACKAGE_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  WRAPPER="$PACKAGE_ROOT/libexec/playwright-cli-wrapper.sh"
  WINDOWS_SCRIPT="$PACKAGE_ROOT/libexec/playwright-cli-windows.ps1"
  CDP_CLOSE_SCRIPT="$PACKAGE_ROOT/libexec/playwright-cli-cdp-close.js"
  CDP_CLOSE_HARNESS="$PACKAGE_ROOT/tests/fixtures/playwright-cli-cdp-close-harness.mjs"
  export MANAGED_CHROME_OWNER="$PACKAGE_ROOT/bin/managed-chrome-owner"
  export PWCLI_RUNTIME_COMMAND="$PACKAGE_ROOT/bin/playwright-runtime"
  FAKE_BIN="$BATS_TEST_TMPDIR/bin"
  UPSTREAM_LOG="$BATS_TEST_TMPDIR/upstream.log"
  POWERSHELL_LOG="$BATS_TEST_TMPDIR/powershell.log"
  POWERSHELL_STATE="$BATS_TEST_TMPDIR/powershell.state"
  RUNTIME_DIR="$BATS_TEST_TMPDIR/runtime"
  BROWSER_OWNERSHIP_DIR="$BATS_TEST_TMPDIR/browser-ownership"
  PROC_ROOT="$BATS_TEST_TMPDIR/proc"
  DASHBOARD_CALL_LOG="$BATS_TEST_TMPDIR/dashboard-call.log"
  DASHBOARD_READY="$BATS_TEST_TMPDIR/dashboard-ready"
  mkdir -p "$FAKE_BIN" "$PROC_ROOT/net"
  : >"$PROC_ROOT/net/tcp"

  cat >"$FAKE_BIN/fake-proc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
action="$1"
pid="$2"
case "$action" in
process | listener)
  session_id="$3"
  start_time="$4"
  mkdir -p "$PWCLI_PROC_ROOT/$pid/fd"
  printf '%s (fake-dashboard) S 1 %s %s 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 %s\n' \
    "$pid" "$session_id" "$session_id" "$start_time" >"$PWCLI_PROC_ROOT/$pid/stat"
  if [[ "$action" == "listener" ]]; then
    inode="$5"
    ln -sfn "socket:[$inode]" "$PWCLI_PROC_ROOT/$pid/fd/3"
    printf '0: 0100007F:%04X 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 %s\n' \
      "$DASHBOARD_PORT" "$inode" >"$PWCLI_PROC_ROOT/net/tcp"
  fi
  ;;
  remove)
    rm -f "$PWCLI_PROC_ROOT/$pid/fd/3" "$PWCLI_PROC_ROOT/$pid/stat"
    rmdir "$PWCLI_PROC_ROOT/$pid/fd" "$PWCLI_PROC_ROOT/$pid" 2>/dev/null || true
    : >"$PWCLI_PROC_ROOT/net/tcp"
    ;;
  unlisten)
    rm -f "$PWCLI_PROC_ROOT/$pid/fd/3"
    : >"$PWCLI_PROC_ROOT/net/tcp"
    ;;
esac
EOF
  chmod +x "$FAKE_BIN/fake-proc"

  cat >"$FAKE_BIN/playwright-cli-upstream" <<'EOF'
#!/usr/bin/env bash
if [[ "${PWCLI_FAKE_OCCUPY_DASHBOARD_ON_CLOSE_ALL:-0}" == "1" && "$*" == *"close-all"* ]]; then
  touch "$DASHBOARD_READY"
fi
if [[ "$*" == *"show"* && "$*" == *"--host=127.0.0.1"* ]]; then
  printf '%s\n' "$@" >>"$DASHBOARD_CALL_LOG"
  if [[ "${PWCLI_FAKE_DASHBOARD_FAIL:-0}" == "1" ]]; then
    exit 44
  fi
  "$FAKE_PROC_HELPER" listener "$$" "$$" 123456 424242
  touch "$DASHBOARD_READY"
  cleanup_dashboard() {
    "$FAKE_PROC_HELPER" remove "$$"
    rm -f "$DASHBOARD_READY"
  }
  trap cleanup_dashboard EXIT
  while :; do
    sleep 0.1
  done
fi
if [[ "$*" == *"show"* && "$*" == *"--kill"* ]]; then
  dashboard_pid_file="$STATE_DIR/dashboard.pid"
  if [[ "${PWCLI_FAKE_DASHBOARD_STOP_STUCK:-0}" != "1" && -f "$dashboard_pid_file" ]]; then
    kill "$(cat "$dashboard_pid_file")" 2>/dev/null || true
  fi
fi
if [[ "$*" == *"show"* && "$*" == *"--annotate"* && ! -f "$DASHBOARD_READY" ]]; then
  exit 42
fi
printf '%s\n' "$PWTEST_DAEMON_SESSION_DIR" "$PWTEST_SERVER_REGISTRY" "$PWTEST_SOCKETS_DIR" >"$UPSTREAM_LOG.registry"
printf '%s\n' "$@" >"$UPSTREAM_LOG"
printf '%s\n' "$*" >>"$UPSTREAM_LOG.calls"
if [[ "${PWCLI_FAKE_ANNOTATION_WAIT:-0}" == "1" && "$*" == *"--annotate"* ]]; then
  touch "$UPSTREAM_LOG.waiting"
  exec sleep 60
fi
if [[ "${PWCLI_FAKE_ANNOTATION_FAIL:-0}" == "1" && "$*" == *"--annotate"* ]]; then
  exit 47
fi
if [[ "${PWCLI_FAKE_ASSERT_LOCK_RELEASED:-0}" == "1" ]] &&
  ! "$PWCLI_FLOCK" --exclusive --nonblock \
    "$STATE_DIR/runtime.lock" true; then
  printf '%s\n' 'managed runtime lock is still held' >&2
  exit 46
fi
if [[ "${PWCLI_FAKE_UPSTREAM_FAIL:-0}" == "1" && "$*" == *"open"* ]]; then
  exit 23
fi
EOF
  chmod +x "$FAKE_BIN/playwright-cli-upstream"

  cat >"$FAKE_BIN/wslinfo" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${PWCLI_FAKE_NETWORK_MODE:-mirrored}"
EOF
  chmod +x "$FAKE_BIN/wslinfo"

  cat >"$FAKE_BIN/powershell.exe" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$POWERSHELL_LOG"
action=
mode=
previous=
for argument in "$@"; do
  if [[ "$previous" == "-Action" ]]; then
    action="$argument"
  elif [[ "$previous" == "-Mode" ]]; then
    mode="$argument"
  fi
  previous="$argument"
done
case "$action" in
  Resolve)
    printf '%s\n' 'C:\Temp\dogfood-race'
    ;;
  Inspect)
    if [[ "${PWCLI_FAKE_INSPECT_FAIL:-0}" == "1" ]]; then
      exit 45
    fi
    if [[ -f "$POWERSHELL_STATE.close-inspect-fail" ]]; then
      rm -f "$POWERSHELL_STATE.close-inspect-fail"
      exit 45
    fi
    if [[ -f "$POWERSHELL_STATE.close-inspections" ]]; then
      close_inspections="$(cat "$POWERSHELL_STATE.close-inspections")"
      if ((close_inspections > 0)); then
        printf '%s\n' "$((close_inspections - 1))" >"$POWERSHELL_STATE.close-inspections"
        cat "$POWERSHELL_STATE"
        exit 0
      fi
      rm -f "$POWERSHELL_STATE.close-inspections"
      printf '%s\n' absent >"$POWERSHELL_STATE"
    fi
    if [[ -f "$POWERSHELL_STATE.inspect-fail-once" ]]; then
      rm -f "$POWERSHELL_STATE.inspect-fail-once"
      exit 45
    fi
    if [[ -f "$POWERSHELL_STATE" ]]; then
      cat "$POWERSHELL_STATE"
    else
      printf '%s\n' absent
    fi
    ;;
  Start)
    if [[ "${PWCLI_FAKE_ASSERT_OWNER_ON_START:-0}" == "1" ]] &&
      [[ ! -f "$OWNER_RECORD" ]]; then
      printf '%s\n' 'browser ownership was not reserved before Start' >&2
      exit 47
    fi
    printf 'managed:%s:4242\n' "${mode:-headless}" >"$POWERSHELL_STATE"
    if [[ "${PWCLI_FAKE_INSPECT_FAIL_AFTER_START:-0}" == "1" ]]; then
      touch "$POWERSHELL_STATE.inspect-fail-once"
    fi
    printf '%s\n' started
    ;;
esac
EOF
  chmod +x "$FAKE_BIN/powershell.exe"

  cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CURL_LOG"
case "$*" in
  */json/version*)
    if [[ "${PWCLI_FAKE_CDP_DOWN:-0}" == "1" ]]; then
      exit 1
    fi
    grep -q '^managed:' "$POWERSHELL_STATE"
    printf '%s\n' '{"Browser":"Chrome/150.0.0.0"}'
    ;;
  */json/new*)
    if [[ "${PWCLI_FAKE_DASHBOARD_TAB_FAIL:-0}" == "1" ]]; then
      exit 22
    fi
    printf '%s\n' '{"id":"dashboard"}'
    ;;
  *127.0.0.1:$DASHBOARD_PORT*)
    [[ -f "$DASHBOARD_READY" ]]
    ;;
  *)
    exit 1
    ;;
esac
EOF
  chmod +x "$FAKE_BIN/curl"

  cat >"$FAKE_BIN/cdp-close" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CDP_CLOSE_LOG"
if [[ "${PWCLI_FAKE_CLOSE_INSPECT_FAIL:-0}" == "1" ]]; then
  touch "$POWERSHELL_STATE.close-inspect-fail"
elif [[ -n "${PWCLI_FAKE_CLOSE_STATUS:-}" ]]; then
  printf '%s\n' "$PWCLI_FAKE_CLOSE_STATUS" >"$POWERSHELL_STATE"
elif [[ -n "${PWCLI_FAKE_CLOSE_INSPECTIONS:-}" ]]; then
  printf '%s\n' "$PWCLI_FAKE_CLOSE_INSPECTIONS" >"$POWERSHELL_STATE.close-inspections"
else
  printf '%s\n' absent >"$POWERSHELL_STATE"
fi
EOF
  chmod +x "$FAKE_BIN/cdp-close"

  export CDP_CLOSE_LOG="$BATS_TEST_TMPDIR/cdp-close.log"
  export CURL_LOG="$BATS_TEST_TMPDIR/curl.log"
  export DASHBOARD_CALL_LOG DASHBOARD_READY
  export FAKE_PROC_HELPER="$FAKE_BIN/fake-proc"
  export PWCLI_PROC_ROOT="$PROC_ROOT"
  export POWERSHELL_LOG POWERSHELL_STATE UPSTREAM_LOG
  export PWCLI_UPSTREAM="$FAKE_BIN/playwright-cli-upstream"
  export PWCLI_WSLINFO="$FAKE_BIN/wslinfo"
  export PWCLI_POWERSHELL="$FAKE_BIN/powershell.exe"
  export PWCLI_WINDOWS_SCRIPT="C:\\fake\\playwright-cli-windows.ps1"
  export PWCLI_CURL="$FAKE_BIN/curl"
  export PWCLI_CDP_CLOSE="$FAKE_BIN/cdp-close"
  export PWCLI_FLOCK
  PWCLI_FLOCK="$(command -v flock)"
  export PWCLI_RUNTIME_DIR="$RUNTIME_DIR"
  export BROWSER_OWNERSHIP_DIR
  export PWCLI_CDP_TIMEOUT=1
  local allocation
  allocation="$("$MANAGED_CHROME_OWNER" locate --role playwright --workspace "$(git rev-parse --show-toplevel)")"
  IFS=$'\t' read -r IDENTITY PROFILE ENDPOINT DASHBOARD_PORT <<<"$allocation"
  STATE_DIR="$RUNTIME_DIR/playwright-cli/$IDENTITY"
  export STATE_DIR IDENTITY ENDPOINT DASHBOARD_PORT
  export OWNER_RECORD="$BROWSER_OWNERSHIP_DIR/identity-$(printf '%s' "$IDENTITY" | sha256sum | cut -d ' ' -f 1).json"
}

@test "managed Playwright publishes its lifecycle through the common ownership CLI" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=shared-owner open
  [ "$status" -eq 0 ]
  run "$MANAGED_CHROME_OWNER" --identity "$IDENTITY" status
  [ "$status" -eq 0 ]
  [[ "$output" == *'"phase":"active"'* ]]
  [[ "$output" == *'"browserPid":4242'* ]]
  run bash "$WRAPPER" -s=shared-owner close
  [ "$status" -eq 0 ]
  run "$MANAGED_CHROME_OWNER" --identity "$IDENTITY" status
  [ "$output" = null ]
}

@test "Playwright and Dogfood callers racing use independent browser identities" {
  export PWCLI_TEST_WSL=1 DOGFOOD_TEST_WSL=1 DOGFOOD_TEST_ALLOW_CDP_ENDPOINT=1
  export DOGFOOD_CDP_ENDPOINT=http://127.0.0.1:19330
  export DOGFOOD_POWERSHELL="$FAKE_BIN/powershell.exe" DOGFOOD_WINDOWS_SCRIPT='C:\fake\dogfood.ps1'
  export CALLER_RACE_DIR="$BATS_TEST_TMPDIR/race"
  mkdir -p "$CALLER_RACE_DIR"
  (
    if bash "$WRAPPER" -s=race open >"$CALLER_RACE_DIR/playwright.log" 2>&1; then
      echo ok >"$CALLER_RACE_DIR/playwright.result"
      while [[ ! -f "$CALLER_RACE_DIR/finish" ]]; do sleep 0.02; done
      bash "$WRAPPER" -s=race close
    else
      echo blocked >"$CALLER_RACE_DIR/playwright.result"
    fi
  ) &
  local playwright_pid=$!
  node --input-type=module - "$MANAGED_CHROME_OWNER" <<'JS' &
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.env.CALLER_RACE_DIR;
const owner = process.argv[2];
let token;
try {
  token = execFileSync(owner, [
    '--identity', 'dogfood-race', 'reserve', '--role', 'dogfood',
    '--id', 'race', '--pid', String(process.pid), '--mode', 'headless',
    '--profile', 'C:\\dogfood-profile', '--endpoint', 'http://127.0.0.1:19330',
  ], { encoding: 'utf8' }).trim();
} catch {
  await fs.writeFile(`${root}/dogfood.result`, 'blocked\n');
}
if (token) {
  await fs.writeFile(`${root}/dogfood.result`, 'ok\n');
  while (!(await fs.stat(`${root}/finish`).catch(() => null))) await delay(20);
}
JS
  local dogfood_pid=$!
  for _ in {1..500}; do
    [[ -f "$CALLER_RACE_DIR/playwright.result" && -f "$CALLER_RACE_DIR/dogfood.result" ]] && break
    sleep 0.02
  done
  touch "$CALLER_RACE_DIR/finish"
  wait "$playwright_pid" "$dogfood_pid"
  [ "$(cat "$CALLER_RACE_DIR/"*.result | sort | tr '\n' ' ')" = 'ok ok ' ]
  run "$MANAGED_CHROME_OWNER" --identity "$IDENTITY" status
  [ "$output" = null ]
  run "$MANAGED_CHROME_OWNER" --identity dogfood-race status
  [[ "$output" == *'"role":"dogfood"'* ]]
}

teardown() {
  local dashboard_pid_file="$STATE_DIR/dashboard.pid"
  if [[ -f "$dashboard_pid_file" ]]; then
    kill "$(cat "$dashboard_pid_file")" 2>/dev/null || true
  fi
  if [[ -f "$BATS_TEST_TMPDIR/extra-pids" ]]; then
    while read -r pid; do
      kill "$pid" 2>/dev/null || true
    done <"$BATS_TEST_TMPDIR/extra-pids"
  fi
}

@test "non-WSL environments pass every argument through to upstream" {
  export PWCLI_TEST_WSL=0

  run bash "$WRAPPER" -s=alpha --json open "https://example.com/?a=1&b=2"

  [ "$status" -eq 0 ]
  mapfile -t actual <"$UPSTREAM_LOG"
  expected=(
    "-s=alpha"
    "--json"
    "open"
    "https://example.com/?a=1&b=2"
  )
  [ "${actual[*]}" = "${expected[*]}" ]
}

@test "non-WSL environments pass through without diagnostics when the osrelease probe fails" {
  unset PWCLI_TEST_WSL
  local missing_proc_bin="$BATS_TEST_TMPDIR/missing-proc-bin"
  mkdir -p "$missing_proc_bin"
  cat >"$missing_proc_bin/grep" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'grep: /proc/sys/kernel/osrelease: No such file or directory' >&2
exit 2
EOF
  chmod +x "$missing_proc_bin/grep"

  run env PATH="$missing_proc_bin:$PATH" \
    bash "$WRAPPER" open https://example.com

  [ "$status" -eq 0 ]
  [ -z "$output" ]
  grep -Fxq -- "open" "$UPSTREAM_LOG"
  grep -Fxq -- "https://example.com" "$UPSTREAM_LOG"
}

@test "help and version flags retain upstream behavior on WSL2" {
  export PWCLI_TEST_WSL=1

  run bash "$WRAPPER" --help show
  [ "$status" -eq 0 ]
  [ ! -e "$POWERSHELL_LOG" ]
  grep -Fxq -- "--help" "$UPSTREAM_LOG"
  grep -Fxq -- "show" "$UPSTREAM_LOG"

  run bash "$WRAPPER" --version
  [ "$status" -eq 0 ]
  [ ! -e "$POWERSHELL_LOG" ]
  grep -Fxq -- "--version" "$UPSTREAM_LOG"
}

@test "mirrored WSL2 starts managed Chrome and opens through the CDP config" {
  export PWCLI_TEST_WSL=1

  run bash "$WRAPPER" -s=alpha --raw open "https://example.com/?a=1&b=2"

  [ "$status" -eq 0 ]
  grep -Fq -- "-Action Inspect" "$POWERSHELL_LOG"
  grep -Fq -- "-Action Start" "$POWERSHELL_LOG"
  grep -Fq -- "-s=alpha" "$UPSTREAM_LOG"
  grep -Fq -- "--raw" "$UPSTREAM_LOG"
  grep -Fq -- "https://example.com/?a=1&b=2" "$UPSTREAM_LOG"
  grep -Eq -- "--config=.*/managed-cli-config.json" "$UPSTREAM_LOG"
  grep -Fq "\"cdpEndpoint\": \"$ENDPOINT\"" \
    "$STATE_DIR/managed-cli-config.json"
  [ "$(sed -n '1p' "$STATE_DIR/lease")" = "alpha" ]
  [ "$(sed -n '2p' "$STATE_DIR/lease")" = "$PWD" ]
}

@test "managed Playwright refuses a Managed Dogfood Chrome owner" {
  export PWCLI_TEST_WSL=1
  "$MANAGED_CHROME_OWNER" reserve --role dogfood --id dogfood-run-1 --pid "$$" \
    --mode headed --profile 'C:\Temp\aiakos-dogfood-dogfood-run-1' --endpoint http://127.0.0.1:49152

  run bash "$WRAPPER" -s=alpha open https://example.com

  [ "$status" -ne 0 ]
  [[ "$output" == *"Legacy ownership exists"* ]]
  [ ! -f "$POWERSHELL_LOG" ]
}

@test "managed open requests headless Windows Chrome by default" {
  export PWCLI_TEST_WSL=1

  run bash "$WRAPPER" open https://example.com

  [ "$status" -eq 0 ]
  grep -Fq -- "-Action Start -Mode headless" "$POWERSHELL_LOG"
  [ "$(cat "$STATE_DIR/chrome.pid")" = "4242" ]
}

@test "managed open reserves browser ownership before launching Chrome" {
  export PWCLI_TEST_WSL=1
  export PWCLI_FAKE_ASSERT_OWNER_ON_START=1

  run bash "$WRAPPER" open https://example.com

  [ "$status" -eq 0 ]
  run "$MANAGED_CHROME_OWNER" --identity "$IDENTITY" status
  [[ "$output" == *'"role":"playwright"'* ]]
  [[ "$output" == *'"browserPid":4242'* ]]
}

@test "runtime state falls back to a user-only tmp directory" {
  export PWCLI_TEST_WSL=1
  unset PWCLI_RUNTIME_DIR XDG_RUNTIME_DIR
  export PWCLI_TMPDIR="$BATS_TEST_TMPDIR/tmp"
  mkdir -p "$PWCLI_TMPDIR"

  run bash "$WRAPPER" -s=alpha open https://example.com

  [ "$status" -eq 0 ]
  local fallback="$PWCLI_TMPDIR/playwright-cli-$UID/$IDENTITY"
  [ -f "$fallback/lease" ]
  [ "$(stat -c '%a' "$fallback")" = "700" ]
}

@test "a stale legacy lock left by a terminated wrapper does not block managed commands" {
  export PWCLI_TEST_WSL=1
  mkdir -p "$STATE_DIR/lock"

  run bash "$WRAPPER" -s=alpha open https://example.com

  [ "$status" -eq 0 ]
  [ "$(sed -n '1p' "$STATE_DIR/lease")" = "alpha" ]
}

@test "the same managed session reuses Chrome while another session is refused" {
  export PWCLI_TEST_WSL=1

  run bash "$WRAPPER" -s=alpha open https://example.com/first
  [ "$status" -eq 0 ]
  run bash "$WRAPPER" -s=alpha open https://example.com/second
  [ "$status" -eq 0 ]
  [ "$(grep -Fc -- "-Action Start" "$POWERSHELL_LOG")" -eq 1 ]

  run bash "$WRAPPER" -s=beta open https://example.com/beta
  [ "$status" -ne 0 ]
  [[ "$output" == *"owned by session 'alpha'"* ]]
  [[ "$output" == *"Close that session"* ]]
}

@test "a managed mode mismatch fails closed without changing the owning session or Chrome" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open https://example.com/headless
  [ "$status" -eq 0 ]

  run bash "$WRAPPER" -s=alpha open --headed https://example.com/headed

  [ "$status" -ne 0 ]
  [[ "$output" == *"current mode 'headless'"* ]]
  [[ "$output" == *"requested mode 'headed'"* ]]
  [[ "$output" == *"close"* ]]
  [ "$(sed -n '1p' "$STATE_DIR/lease")" = "alpha" ]
  [ "$(cat "$POWERSHELL_STATE")" = "managed:headless:4242" ]
  [ ! -e "$CDP_CLOSE_LOG" ]
  grep -Fxq -- "https://example.com/headless" "$UPSTREAM_LOG"
}

@test "explicit local browser options are rejected in browser-free WSL2" {
  export PWCLI_TEST_WSL=1
  local option
  for option in \
    "--config=custom.json" \
    "--browser=firefox" \
    "--profile=/tmp/profile" \
    "--persistent" \
    "--device=iPhone 15" \
    "--mobile"; do
    rm -f "$POWERSHELL_LOG"
    run bash "$WRAPPER" open "$option" https://example.com
    [ "$status" -ne 0 ]
    [[ "$output" == *"local browser overrides are unsupported"* ]]
    [ ! -e "$POWERSHELL_LOG" ]
  done
}

@test "local browser options are rejected for managed Dashboard startup" {
  export PWCLI_TEST_WSL=1

  run bash "$WRAPPER" show --config=custom.json

  [ "$status" -ne 0 ]
  [[ "$output" == *"local browser overrides are unsupported"* ]]
  [ ! -e "$POWERSHELL_LOG" ]
  [ ! -e "$STATE_DIR" ]
}

@test "an explicit local browser option cannot replace its own managed session" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open https://example.com/managed
  [ "$status" -eq 0 ]

  run bash "$WRAPPER" -s=alpha open --browser=firefox https://example.com/override

  [ "$status" -ne 0 ]
  [[ "$output" == *"local browser overrides are unsupported"* ]]
  [ "$(sed -n '1p' "$STATE_DIR/lease")" = "alpha" ]
  [ "$(cat "$POWERSHELL_STATE")" = "managed:headless:4242" ]
  grep -Fxq -- "https://example.com/managed" "$UPSTREAM_LOG"
}

@test "a split-value local config override cannot replace its own managed session" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open https://example.com/managed
  [ "$status" -eq 0 ]

  local before="$BATS_TEST_TMPDIR/split-value-config-before"
  mkdir "$before"
  touch "$CDP_CLOSE_LOG"
  cp "$POWERSHELL_LOG" "$before/powershell.log"
  cp "$CDP_CLOSE_LOG" "$before/cdp-close.log"
  cp "$UPSTREAM_LOG" "$before/upstream.log"
  cp "$POWERSHELL_STATE" "$before/powershell.state"
  cp "$STATE_DIR/chrome.pid" "$before/chrome.pid"
  cp "$STATE_DIR/lease" "$before/lease"

  run bash "$WRAPPER" -s=alpha --config custom.json open

  [ "$status" -ne 0 ]
  [[ "$output" == *"local browser overrides are unsupported"* ]]
  cmp "$before/powershell.log" "$POWERSHELL_LOG"
  cmp "$before/cdp-close.log" "$CDP_CLOSE_LOG"
  cmp "$before/upstream.log" "$UPSTREAM_LOG"
  cmp "$before/powershell.state" "$POWERSHELL_STATE"
  cmp "$before/chrome.pid" "$STATE_DIR/chrome.pid"
  cmp "$before/lease" "$STATE_DIR/lease"
}

@test "an explicit local browser option is rejected even for another session" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open https://example.com/managed
  [ "$status" -eq 0 ]

  run bash "$WRAPPER" -s=beta open --browser=firefox --headed https://example.com/override

  [ "$status" -ne 0 ]
  [[ "$output" == *"local browser overrides are unsupported"* ]]
  [ "$(sed -n '1p' "$STATE_DIR/lease")" = "alpha" ]
  [ "$(cat "$POWERSHELL_STATE")" = "managed:headless:4242" ]
}

@test "a rejected local browser override leaves the managed runtime lock untouched" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open https://example.com/managed
  [ "$status" -eq 0 ]
  run bash "$WRAPPER" -s=beta open --browser=firefox https://example.com/override

  [ "$status" -ne 0 ]
  [[ "$output" == *"local browser overrides are unsupported"* ]]
  [ "$(sed -n '1p' "$STATE_DIR/lease")" = "alpha" ]
  [ "$(cat "$POWERSHELL_STATE")" = "managed:headless:4242" ]
}

@test "open headed uses managed headed Windows Chrome through CDP" {
  export PWCLI_TEST_WSL=1

  run bash "$WRAPPER" open --headed https://example.com

  [ "$status" -eq 0 ]
  grep -Fq -- "-Action Start -Mode headed" "$POWERSHELL_LOG"
  grep -Fq -- "--headed" "$UPSTREAM_LOG"
  grep -Eq -- "--config=.*/managed-cli-config.json" "$UPSTREAM_LOG"
}

@test "PLAYWRIGHT_MCP_HEADLESS false selects managed headed Windows Chrome" {
  export PWCLI_TEST_WSL=1
  export PLAYWRIGHT_MCP_HEADLESS=false

  run bash "$WRAPPER" open https://example.com

  [ "$status" -eq 0 ]
  grep -Fq -- "-Action Start -Mode headed" "$POWERSHELL_LOG"
  grep -Eq -- "--config=.*/managed-cli-config.json" "$UPSTREAM_LOG"
}

@test "PLAYWRIGHT_MCP_HEADLESS zero selects managed headed Windows Chrome" {
  export PWCLI_TEST_WSL=1
  export PLAYWRIGHT_MCP_HEADLESS=0

  run bash "$WRAPPER" open https://example.com

  [ "$status" -eq 0 ]
  grep -Fq -- "-Action Start -Mode headed" "$POWERSHELL_LOG"
}

@test "PLAYWRIGHT_MCP_HEADLESS true selects managed headless Windows Chrome" {
  export PWCLI_TEST_WSL=1
  export PLAYWRIGHT_MCP_HEADLESS=true

  run bash "$WRAPPER" open https://example.com

  [ "$status" -eq 0 ]
  grep -Fq -- "-Action Start -Mode headless" "$POWERSHELL_LOG"
  grep -Eq -- "--config=.*/managed-cli-config.json" "$UPSTREAM_LOG"
}

@test "PLAYWRIGHT_MCP_HEADLESS one selects managed headless Windows Chrome" {
  export PWCLI_TEST_WSL=1
  export PLAYWRIGHT_MCP_HEADLESS=1

  run bash "$WRAPPER" open https://example.com

  [ "$status" -eq 0 ]
  grep -Fq -- "-Action Start -Mode headless" "$POWERSHELL_LOG"
}

@test "an invalid PLAYWRIGHT_MCP_HEADLESS value uses the managed headless default" {
  export PWCLI_TEST_WSL=1
  export PLAYWRIGHT_MCP_HEADLESS=unexpected

  run bash "$WRAPPER" open https://example.com

  [ "$status" -eq 0 ]
  grep -Fq -- "-Action Start -Mode headless" "$POWERSHELL_LOG"
}

@test "open headed takes precedence over PLAYWRIGHT_MCP_HEADLESS true" {
  export PWCLI_TEST_WSL=1
  export PLAYWRIGHT_MCP_HEADLESS=true

  run bash "$WRAPPER" open --headed https://example.com

  [ "$status" -eq 0 ]
  grep -Fq -- "-Action Start -Mode headed" "$POWERSHELL_LOG"
}

@test "show-only flags do not enter Dashboard control paths on open" {
  export PWCLI_TEST_WSL=1

  run bash "$WRAPPER" -s=alpha open --kill https://example.com/kill
  [ "$status" -eq 0 ]
  grep -Fq -- "-Action Start" "$POWERSHELL_LOG"
  grep -Fxq -- "--kill" "$UPSTREAM_LOG"

  run bash "$WRAPPER" -s=alpha open --annotate https://example.com/annotate
  [ "$status" -eq 0 ]
  grep -Fxq -- "--annotate" "$UPSTREAM_LOG"
}

@test "project config and browser-shaping environment are rejected in browser-free WSL2" {
  export PWCLI_TEST_WSL=1
  local project="$BATS_TEST_TMPDIR/project"
  mkdir -p "$project/.playwright"
  printf '%s\n' '{}' >"$project/.playwright/cli.config.json"

  cd "$project"
  run bash "$WRAPPER" open https://example.com
  [ "$status" -ne 0 ]
  [[ "$output" == *"local browser overrides are unsupported"* ]]
  [ ! -e "$POWERSHELL_LOG" ]

  rm -f "$project/.playwright/cli.config.json" "$POWERSHELL_LOG"
  export PLAYWRIGHT_MCP_DEVICE="Pixel 10"
  run bash "$WRAPPER" open https://example.com
  [ "$status" -ne 0 ]
  [[ "$output" == *"local browser overrides are unsupported"* ]]
  [ ! -e "$POWERSHELL_LOG" ]
  unset PLAYWRIGHT_MCP_DEVICE

  rm -f "$POWERSHELL_LOG"
  export PWTEST_CLI_GLOBAL_CONFIG="$project/global-config"
  run bash "$WRAPPER" open https://example.com
  [ "$status" -ne 0 ]
  [[ "$output" == *"local browser overrides are unsupported"* ]]
  [ ! -e "$POWERSHELL_LOG" ]
  unset PWTEST_CLI_GLOBAL_CONFIG
}

@test "managed open fails with mirrored networking remediation" {
  export PWCLI_TEST_WSL=1
  export PWCLI_FAKE_NETWORK_MODE=nat

  run bash "$WRAPPER" open https://example.com

  [ "$status" -ne 0 ]
  [[ "$output" == *"requires WSL2 mirrored networking"* ]]
  [[ "$output" == *"networkingMode=mirrored"* ]]
  [[ "$output" == *"wsl.exe --shutdown"* ]]
  [[ "$output" == *"wslinfo --networking-mode"* ]]
  [ ! -e "$POWERSHELL_LOG" ]
}

@test "managed open fails with PowerShell remediation" {
  export PWCLI_TEST_WSL=1
  export PWCLI_POWERSHELL="$FAKE_BIN/missing-powershell.exe"

  run bash "$WRAPPER" open https://example.com

  [ "$status" -ne 0 ]
  [[ "$output" == *"powershell.exe is unavailable"* ]]
  [[ "$output" == *"Windows interoperability"* ]]
}

@test "managed open reports remediation when Chrome ownership inspection fails" {
  export PWCLI_TEST_WSL=1
  export PWCLI_FAKE_INSPECT_FAIL=1

  run bash "$WRAPPER" open https://example.com

  [ "$status" -ne 0 ]
  [[ "$output" == *"could not inspect Windows Chrome ownership"* ]]
  [[ "$output" == *"Verify PowerShell and retry"* ]]
}

@test "managed open retries a transient inspection failure while waiting for CDP" {
  export PWCLI_TEST_WSL=1
  export PWCLI_FAKE_INSPECT_FAIL_AFTER_START=1

  run bash "$WRAPPER" open https://example.com

  [ "$status" -eq 0 ]
  [ "$(cat "$STATE_DIR/chrome.pid")" = "4242" ]
}

@test "managed open fails when Windows Chrome is missing" {
  export PWCLI_TEST_WSL=1
  printf '%s\n' chrome-missing >"$POWERSHELL_STATE"

  run bash "$WRAPPER" open https://example.com

  [ "$status" -ne 0 ]
  [[ "$output" == *"Windows Google Chrome was not found"* ]]
  [[ "$output" == *"Install the stable Windows Chrome release"* ]]
}

@test "managed open fails when the CDP endpoint times out" {
  export PWCLI_TEST_WSL=1
  export PWCLI_FAKE_CDP_DOWN=1

  run bash "$WRAPPER" open https://example.com

  [ "$status" -ne 0 ]
  [[ "$output" == *"did not expose CDP at $ENDPOINT"* ]]
  [[ "$output" == *"verify port ${ENDPOINT##*:} is free"* ]]
}

@test "a failed upstream open releases the lease and closes unused Chrome" {
  export PWCLI_TEST_WSL=1
  export PWCLI_FAKE_UPSTREAM_FAIL=1

  run bash "$WRAPPER" -s=alpha open https://example.com

  [ "$status" -eq 23 ]
  [ ! -e "$STATE_DIR/lease" ]
  [ -s "$CDP_CLOSE_LOG" ]
}

@test "a repeated open failure preserves the existing session lease and Chrome" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open https://example.com/first
  [ "$status" -eq 0 ]
  export PWCLI_FAKE_UPSTREAM_FAIL=1

  run bash "$WRAPPER" -s=alpha open https://example.com/bad

  [ "$status" -eq 23 ]
  [ "$(sed -n '1p' "$STATE_DIR/lease")" = "alpha" ]
  [ ! -e "$CDP_CLOSE_LOG" ]
}

@test "show starts one loopback dashboard and reopens it in managed Chrome" {
  export PWCLI_TEST_WSL=1

  run bash "$WRAPPER" show
  [ "$status" -eq 0 ]
  [ -s "$STATE_DIR/dashboard.pid" ]
  [ -s "$STATE_DIR/dashboard.starttime" ]
  [ -f "$STATE_DIR/dashboard.log" ]
  grep -Fq -- "-Action Start -Mode headed" "$POWERSHELL_LOG"
  local first_pid
  first_pid="$(cat "$STATE_DIR/dashboard.pid")"
  kill -0 "$first_pid"
  grep -Fq -- "--host=127.0.0.1" "$DASHBOARD_CALL_LOG"
  grep -Fq -- "--port=$DASHBOARD_PORT" "$DASHBOARD_CALL_LOG"
  grep -Fq "${ENDPOINT#http://}/json/new?http%3A%2F%2Flocalhost%3A${DASHBOARD_PORT}%2F" \
    "$CURL_LOG"

  run bash "$WRAPPER" show
  [ "$status" -eq 0 ]
  [ "$(cat "$STATE_DIR/dashboard.pid")" = "$first_pid" ]
  [ "$(grep -Fc -- "--port=$DASHBOARD_PORT" "$DASHBOARD_CALL_LOG")" -eq 1 ]
}

@test "show annotate waits for the dashboard and only accepts the lease owner" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open --headed https://example.com
  [ "$status" -eq 0 ]

  run bash "$WRAPPER" -s=alpha show --annotate
  [ "$status" -eq 0 ]
  grep -Fxq -- "--annotate" "$UPSTREAM_LOG"
  [ -f "$DASHBOARD_READY" ]

  run bash "$WRAPPER" -s=beta show --annotate
  [ "$status" -ne 0 ]
  [[ "$output" == *"annotation requires the lease-owning session 'alpha'"* ]]
}

@test "show and annotation refuse a headless managed session before starting the Dashboard" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open https://example.com
  [ "$status" -eq 0 ]

  run bash "$WRAPPER" -s=alpha show
  [ "$status" -ne 0 ]
  [[ "$output" == *"current mode 'headless'"* ]]
  [[ "$output" == *"requested mode 'headed'"* ]]
  [[ "$output" == *"open --headed"* ]]
  [ ! -e "$STATE_DIR/dashboard.pid" ]
  [ ! -e "$DASHBOARD_READY" ]

  run bash "$WRAPPER" -s=alpha show --annotate
  [ "$status" -ne 0 ]
  [[ "$output" == *"current mode 'headless'"* ]]
  [ ! -e "$STATE_DIR/dashboard.pid" ]
  [ "$(sed -n '1p' "$STATE_DIR/lease")" = "alpha" ]
  [ ! -e "$CDP_CLOSE_LOG" ]
}

@test "default open refuses a headed Dashboard without stopping it" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" show
  [ "$status" -eq 0 ]
  local dashboard_pid
  dashboard_pid="$(cat "$STATE_DIR/dashboard.pid")"

  run bash "$WRAPPER" open https://example.com

  [ "$status" -ne 0 ]
  [[ "$output" == *"current mode 'headed'"* ]]
  [[ "$output" == *"requested mode 'headless'"* ]]
  [[ "$output" == *"show --kill"* ]]
  [ "$(cat "$STATE_DIR/dashboard.pid")" = "$dashboard_pid" ]
  kill -0 "$dashboard_pid"
  [ ! -e "$STATE_DIR/lease" ]
  [ ! -e "$CDP_CLOSE_LOG" ]
}

@test "stale dashboard PID is replaced before show returns" {
  export PWCLI_TEST_WSL=1
  mkdir -p "$STATE_DIR"
  printf '%s\n' 999999 >"$STATE_DIR/dashboard.pid"

  run bash "$WRAPPER" show

  [ "$status" -eq 0 ]
  [ "$(cat "$STATE_DIR/dashboard.pid")" != "999999" ]
  kill -0 "$(cat "$STATE_DIR/dashboard.pid")"
}

@test "Dashboard state must couple the recorded PID to the loopback listener" {
  export PWCLI_TEST_WSL=1
  mkdir -p "$STATE_DIR"

  sleep 60 &
  local unrelated_pid=$!
  printf '%s\n' "$unrelated_pid" >"$STATE_DIR/dashboard.pid"
  printf '%s\n' 100 >"$STATE_DIR/dashboard.starttime"
  printf '%s\n' "$unrelated_pid" >>"$BATS_TEST_TMPDIR/extra-pids"
  "$FAKE_PROC_HELPER" process "$unrelated_pid" "$unrelated_pid" 100
  "$FAKE_PROC_HELPER" listener 999999 999999 200 424242
  touch "$DASHBOARD_READY"

  run bash "$WRAPPER" show

  [ "$status" -ne 0 ]
  [[ "$output" == *"without matching Managed Playwright Dashboard state"* ]]
}

@test "Dashboard state rejects a reused listener PID with a different start time" {
  export PWCLI_TEST_WSL=1
  mkdir -p "$STATE_DIR"

  sleep 60 &
  local reused_pid=$!
  printf '%s\n' "$reused_pid" >"$STATE_DIR/dashboard.pid"
  printf '%s\n' 1 >"$STATE_DIR/dashboard.starttime"
  printf '%s\n' "$reused_pid" >>"$BATS_TEST_TMPDIR/extra-pids"
  "$FAKE_PROC_HELPER" listener "$reused_pid" "$reused_pid" 2 424242
  touch "$DASHBOARD_READY"

  run bash "$WRAPPER" show

  [ "$status" -ne 0 ]
  [[ "$output" == *"without matching Managed Playwright Dashboard state"* ]]
}

@test "Dashboard startup records the listener from the launcher session" {
  grep -Fq 'dashboard_listener_for_launcher "$pwcli_dashboard_launcher_pid"' "$WRAPPER"
  grep -Fq 'process_session_id "$listener_pid"' "$WRAPPER"
  grep -Fq 'printf '\''%s\n'\'' "$pwcli_dashboard_pid" >"$pwcli_dashboard_pid_file"' "$WRAPPER"
}

@test "Windows Chrome inspection couples the CDP listener to an exact managed process" {
  grep -Fq '$ListenerProcess = $ManagedProcesses | Where-Object {' "$WINDOWS_SCRIPT"
  grep -Fq 'return Format-ManagedState -Process $ListenerProcess' "$WINDOWS_SCRIPT"
  grep -Fq -- '--headless(?:=\S+)?' "$WINDOWS_SCRIPT"
  grep -Fq 'return "managed:${ProcessMode}:$($Process.ProcessId)"' "$WINDOWS_SCRIPT"
}

@test "CDP close exits promptly after Chrome acknowledges Browser.close" {
  run timeout 30 node "$CDP_CLOSE_HARNESS" "$CDP_CLOSE_SCRIPT"

  [ "$status" -eq 0 ]
}

@test "CDP close ignores unrelated events before the matching response" {
  run timeout 30 node "$CDP_CLOSE_HARNESS" "$CDP_CLOSE_SCRIPT" event-then-success

  [ "$status" -eq 0 ]
}

@test "CDP close rejects a matching error response" {
  run timeout 30 node "$CDP_CLOSE_HARNESS" "$CDP_CLOSE_SCRIPT" error

  [ "$status" -ne 0 ]
  [[ "$output" == *"close refused"* ]]
}

@test "Chrome close refuses a CDP listener that no longer matches recorded ownership" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open
  [ "$status" -eq 0 ]
  printf '%s\n' 4242 >"$STATE_DIR/chrome.pid"
  printf '%s\n' 'port-conflict:5150' >"$POWERSHELL_STATE"

  run bash "$WRAPPER" -s=alpha close

  [ "$status" -ne 0 ]
  [[ "$output" == *"refusing to close Chrome"* ]]
  [ ! -e "$CDP_CLOSE_LOG" ]
}

@test "Chrome close waits for the managed process to exit before removing ownership state" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open https://example.com
  [ "$status" -eq 0 ]
  export PWCLI_FAKE_CLOSE_INSPECTIONS=2
  # 並列実行の負荷で2回の状態確認が setup の1秒を超えないよう、既定の待ち時間に戻す。
  export PWCLI_CDP_TIMEOUT=10
  : >"$POWERSHELL_LOG"

  run bash "$WRAPPER" -s=alpha close

  [ "$status" -eq 0 ]
  [ "$(cat "$POWERSHELL_STATE")" = "absent" ]
  [ ! -e "$POWERSHELL_STATE.close-inspections" ]
  [ ! -e "$STATE_DIR/chrome.pid" ]
  [ "$(grep -Fc -- "-Action Inspect" "$POWERSHELL_LOG")" -ge 4 ]
}

@test "Chrome close timeout preserves ownership state" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open https://example.com
  [ "$status" -eq 0 ]
  export PWCLI_FAKE_CLOSE_INSPECTIONS=100
  export PWCLI_CDP_TIMEOUT=0

  run bash "$WRAPPER" -s=alpha close

  [ "$status" -ne 0 ]
  [[ "$output" == *"did not exit before the timeout"* ]]
  [[ "$output" == *"ownership state was preserved"* ]]
  [ "$(cat "$STATE_DIR/chrome.pid")" = "4242" ]
  [ "$(cat "$POWERSHELL_STATE")" = "managed:headless:4242" ]
}

@test "Chrome close fails closed when post-ack ownership inspection fails" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open https://example.com
  [ "$status" -eq 0 ]
  export PWCLI_FAKE_CLOSE_INSPECT_FAIL=1
  export PWCLI_CDP_TIMEOUT=0

  run bash "$WRAPPER" -s=alpha close

  [ "$status" -ne 0 ]
  [[ "$output" == *"could not inspect Managed Playwright Chrome after Browser.close"* ]]
  [[ "$output" == *"ownership state was preserved"* ]]
  [ "$(cat "$STATE_DIR/chrome.pid")" = "4242" ]
}

@test "Chrome close fails closed when post-ack ownership changes" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open https://example.com
  [ "$status" -eq 0 ]
  export PWCLI_FAKE_CLOSE_STATUS=managed:headless:5150
  export PWCLI_CDP_TIMEOUT=0

  run bash "$WRAPPER" -s=alpha close

  [ "$status" -ne 0 ]
  [[ "$output" == *"ownership changed while closing"* ]]
  [[ "$output" == *"managed:headless:5150"* ]]
  [[ "$output" == *"ownership state was preserved"* ]]
  [ "$(cat "$STATE_DIR/chrome.pid")" = "4242" ]
}

@test "a failed Dashboard start removes stale state and closes unused Chrome" {
  export PWCLI_TEST_WSL=1
  export PWCLI_FAKE_DASHBOARD_FAIL=1
  export PWCLI_DASHBOARD_TIMEOUT=1

  run bash "$WRAPPER" show

  [ "$status" -ne 0 ]
  [[ "$output" == *"did not start on http://127.0.0.1:$DASHBOARD_PORT/"* ]]
  [ ! -e "$STATE_DIR/dashboard.pid" ]
  [ -s "$CDP_CLOSE_LOG" ]
}

@test "Chrome closes only after the last managed CLI or dashboard consumer exits" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open --headed https://example.com
  [ "$status" -eq 0 ]
  run bash "$WRAPPER" show
  [ "$status" -eq 0 ]

  run bash "$WRAPPER" -s=alpha close
  [ "$status" -eq 0 ]
  [ ! -e "$STATE_DIR/lease" ]
  [ ! -e "$CDP_CLOSE_LOG" ]

  local dashboard_pid
  dashboard_pid="$(cat "$STATE_DIR/dashboard.pid")"
  run bash "$WRAPPER" show --kill
  [ "$status" -eq 0 ]
  run kill -0 "$dashboard_pid"
  [ "$status" -ne 0 ]
  [ -s "$CDP_CLOSE_LOG" ]
  [ ! -e "$STATE_DIR/dashboard.pid" ]
  [ ! -e "$STATE_DIR/dashboard.starttime" ]
}

@test "Dashboard stop timeout preserves process identity across wrapper calls" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open --headed https://example.com
  [ "$status" -eq 0 ]
  run bash "$WRAPPER" show
  [ "$status" -eq 0 ]
  local dashboard_pid
  dashboard_pid="$(cat "$STATE_DIR/dashboard.pid")"
  printf '%s\n' "$dashboard_pid" >>"$BATS_TEST_TMPDIR/extra-pids"
  export PWCLI_FAKE_DASHBOARD_STOP_STUCK=1
  export PWCLI_DASHBOARD_STOP_TIMEOUT=0

  run bash "$WRAPPER" show --kill

  [ "$status" -ne 0 ]
  [[ "$output" == *"did not exit before the timeout"* ]]
  [ "$(cat "$STATE_DIR/dashboard.pid")" = "$dashboard_pid" ]
  [ -s "$STATE_DIR/dashboard.starttime" ]
  [ -e "$STATE_DIR/dashboard.stdin" ]
  kill -0 "$dashboard_pid"
  [ -s "$STATE_DIR/chrome.pid" ]
  [ ! -e "$CDP_CLOSE_LOG" ]

  "$FAKE_PROC_HELPER" unlisten "$dashboard_pid"
  rm -f "$DASHBOARD_READY"

  run bash "$WRAPPER" show

  [ "$status" -ne 0 ]
  [[ "$output" == *"is still stopping"* ]]
  [ "$(cat "$STATE_DIR/dashboard.pid")" = "$dashboard_pid" ]
  [ -s "$STATE_DIR/dashboard.starttime" ]
  [ -e "$STATE_DIR/dashboard.stdin" ]
  [ "$(grep -Fc -- "--port=$DASHBOARD_PORT" "$DASHBOARD_CALL_LOG")" -eq 1 ]
  [ -s "$STATE_DIR/chrome.pid" ]
}

@test "managed delete-data refuses to remove the dedicated profile" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open https://example.com
  [ "$status" -eq 0 ]

  run bash "$WRAPPER" -s=alpha delete-data

  [ "$status" -ne 0 ]
  [[ "$output" == *"will not delete Managed Playwright Chrome data"* ]]
  [[ "$output" == *"$PROFILE"* ]]
  [[ "$output" != *"playwright-cli\\chrome-profile"* ]]
  [[ "$output" == *"close the session and Dashboard"* ]]
}

@test "attach and explicit Dashboard endpoints retain upstream behavior on WSL2" {
  export PWCLI_TEST_WSL=1

  run bash "$WRAPPER" -s=external attach --cdp=http://localhost:9333
  [ "$status" -eq 0 ]
  [ ! -e "$POWERSHELL_LOG" ]
  grep -Fxq -- "attach" "$UPSTREAM_LOG"

  run bash "$WRAPPER" show --host=0.0.0.0 --port=7777
  [ "$status" -eq 0 ]
  [ ! -e "$POWERSHELL_LOG" ]
  grep -Fxq -- "--host=0.0.0.0" "$UPSTREAM_LOG"
  grep -Fxq -- "--port=7777" "$UPSTREAM_LOG"
}

@test "external CDP annotation starts a managed Dashboard before annotation and cleans it up" {
  export PWCLI_TEST_WSL=1

  run env PWCLI_EXTERNAL_CDP=1 bash "$WRAPPER" -s=dogfood-annotate show --annotate --json

  [ "$status" -eq 0 ]
  grep -Fq -- '--host=127.0.0.1' "$DASHBOARD_CALL_LOG"
  grep -Fq -- 'show --annotate --json' "$UPSTREAM_LOG.calls"
  grep -Fq -- 'show --kill' "$UPSTREAM_LOG.calls"
  grep -Fq -- '-Action Start -Mode headed' "$POWERSHELL_LOG"
  [ ! -e "$STATE_DIR/dashboard.pid" ]
  [ ! -e "$STATE_DIR/chrome.pid" ]
}

@test "external annotation failure preserves its exit status and cleans up the Dashboard" {
  export PWCLI_TEST_WSL=1 PWCLI_FAKE_ANNOTATION_FAIL=1

  run env PWCLI_EXTERNAL_CDP=1 bash "$WRAPPER" -s=dogfood-annotate show --annotate --json

  [ "$status" -eq 47 ]
  [ ! -e "$STATE_DIR/dashboard.pid" ]
  [ ! -e "$STATE_DIR/chrome.pid" ]
}

@test "external annotation preserves a pre-existing same-session Dashboard" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=dogfood-annotate show
  [ "$status" -eq 0 ]
  local dashboard_pid="$(cat "$STATE_DIR/dashboard.pid")"

  run env PWCLI_EXTERNAL_CDP=1 bash "$WRAPPER" -s=dogfood-annotate show --annotate --json

  [ "$status" -eq 0 ]
  [ "$(cat "$STATE_DIR/dashboard.pid")" = "$dashboard_pid" ]
  [ -e "$STATE_DIR/chrome.pid" ]
}

@test "external annotation preserves its failure when Dashboard cleanup also fails" {
  export PWCLI_TEST_WSL=1 PWCLI_FAKE_ANNOTATION_FAIL=1
  export PWCLI_FAKE_DASHBOARD_STOP_STUCK=1 PWCLI_DASHBOARD_STOP_TIMEOUT=0

  run env PWCLI_EXTERNAL_CDP=1 bash "$WRAPPER" -s=dogfood-annotate show --annotate --json

  [ "$status" -eq 47 ]
  [[ "$output" == *"Dashboard did not exit"* ]]
  [ -e "$STATE_DIR/dashboard.pid" ]
}

@test "external annotation cannot take over another session's Dashboard" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha show
  [ "$status" -eq 0 ]

  run env PWCLI_EXTERNAL_CDP=1 bash "$WRAPPER" -s=dogfood-annotate show --annotate --json

  [ "$status" -ne 0 ]
  [[ "$output" == *"Dashboard-owning session"* ]]
  [ "$(cat "$STATE_DIR/dashboard.session")" = alpha ]
}

@test "managed open refuses orphan Chrome and a conflicting CDP port" {
  export PWCLI_TEST_WSL=1
  printf '%s\n' 'managed:headless:4242' >"$POWERSHELL_STATE"

  run bash "$WRAPPER" open https://example.com
  [ "$status" -ne 0 ]
  [[ "$output" == *"already running without matching state"* ]]
  [[ "$output" == *"Close that dedicated Chrome manually"* ]]

  run "$MANAGED_CHROME_OWNER" --identity "$IDENTITY" status
  [ "$output" = null ]
  printf '%s\n' 'port-conflict:5150' >"$POWERSHELL_STATE"
  run bash "$WRAPPER" open https://example.com
  [ "$status" -ne 0 ]
  [[ "$output" == *"$ENDPOINT is owned by a process that is not"* ]]
  [[ "$output" == *"will not be replaced automatically"* ]]
}

@test "managed open can retry a preflight failure without manual ownership recovery" {
  export PWCLI_TEST_WSL=1
  local state
  for state in chrome-missing port-conflict:5150 profile-conflict:4242; do
    printf '%s\n' "$state" >"$POWERSHELL_STATE"
    : >"$POWERSHELL_LOG"
    run bash "$WRAPPER" -s=preflight-retry open https://example.com
    [ "$status" -ne 0 ]
    ! grep -Fq -- '-Action Start' "$POWERSHELL_LOG"
    run "$MANAGED_CHROME_OWNER" --identity "$IDENTITY" status
    [ "$output" = null ]

    printf '%s\n' absent >"$POWERSHELL_STATE"
    run bash "$WRAPPER" -s=preflight-retry open https://example.com
    [ "$status" -eq 0 ]
    run bash "$WRAPPER" -s=preflight-retry close
    [ "$status" -eq 0 ]
  done
}

@test "bulk termination is rejected without closing a worktree browser" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha open
  [ "$status" -eq 0 ]
  for command in close-all kill-all; do
    run bash "$WRAPPER" "$command"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Use session-scoped close"* ]]
    [ "$(sed -n '1p' "$STATE_DIR/lease")" = alpha ]
    [ "$(cat "$POWERSHELL_STATE")" = managed:headless:4242 ]
  done
  [ ! -e "$CDP_CLOSE_LOG" ]
}

@test "two worktrees open independent browsers and closing A leaves B usable" {
  export PWCLI_TEST_WSL=1
  mkdir -p "$BATS_TEST_TMPDIR/a" "$BATS_TEST_TMPDIR/b"
  cd "$BATS_TEST_TMPDIR/a"
  run bash "$WRAPPER" -s=alpha open http://localhost:3001
  [ "$status" -eq 0 ]
  local first_profile
  first_profile="$(cat "$POWERSHELL_LOG")"
  cd "$BATS_TEST_TMPDIR/b"
  export POWERSHELL_STATE="$BATS_TEST_TMPDIR/b.state"
  run bash "$WRAPPER" -s=beta open http://localhost:3002
  [ "$status" -eq 0 ]
  run bash "$WRAPPER" -s=beta close
  [ "$status" -eq 0 ]
  cd "$BATS_TEST_TMPDIR/a"
  export POWERSHELL_STATE="$BATS_TEST_TMPDIR/powershell.state"
  run bash "$WRAPPER" -s=alpha open http://localhost:3001
  [ "$status" -eq 0 ]
  [[ "$first_profile" == *'-ProfileDir'* ]]
}

@test "another session cannot stop the Dashboard owner" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=alpha show
  [ "$status" -eq 0 ]
  local dashboard_pid
  dashboard_pid="$(cat "$STATE_DIR/dashboard.pid")"
  run bash "$WRAPPER" -s=beta show --kill
  [ "$status" -ne 0 ]
  [[ "$output" == *'Dashboard belongs to session'* ]]
  kill -0 "$dashboard_pid"
  [ "$(cat "$STATE_DIR/dashboard.pid")" = "$dashboard_pid" ]
}

@test "profile reset requires the exact stopped worktree identity" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" reset-profile --confirm-identity wrong-worktree
  [ "$status" -ne 0 ]
  [[ "$output" == *'exact identity'* ]]
  [ ! -e "$POWERSHELL_LOG" ]
  run bash "$WRAPPER" -s=alpha open
  [ "$status" -eq 0 ]
  run bash "$WRAPPER" reset-profile --confirm-identity "$IDENTITY"
  [ "$status" -ne 0 ]
  ! grep -Fq -- '-Action Reset' "$POWERSHELL_LOG"
  run bash "$WRAPPER" -s=alpha close
  [ "$status" -eq 0 ]
  run bash "$WRAPPER" reset-profile --confirm-identity "$IDENTITY"
  [ "$status" -eq 0 ]
  grep -Fq -- "-Action Reset -ProfileDir $PROFILE" "$POWERSHELL_LOG"
}

@test "same session name uses independent registries across worktrees and stable registry in subdirectories" {
  export PWCLI_TEST_WSL=1
  mkdir -p "$BATS_TEST_TMPDIR/first/sub" "$BATS_TEST_TMPDIR/second"
  git -C "$BATS_TEST_TMPDIR/first" init -q
  git -C "$BATS_TEST_TMPDIR/second" init -q
  cd "$BATS_TEST_TMPDIR/first"
  run bash "$WRAPPER" -s=shared snapshot
  [ "$status" -eq 0 ]
  local first
  first="$(cat "$UPSTREAM_LOG.registry")"
  [ -n "$(sed -n '1p' "$UPSTREAM_LOG.registry")" ]
  [ -n "$(sed -n '2p' "$UPSTREAM_LOG.registry")" ]
  [ -n "$(sed -n '3p' "$UPSTREAM_LOG.registry")" ]
  cd sub
  run bash "$WRAPPER" -s=shared snapshot
  [ "$status" -eq 0 ]
  [ "$(cat "$UPSTREAM_LOG.registry")" = "$first" ]
  cd "$BATS_TEST_TMPDIR/second"
  run bash "$WRAPPER" -s=shared snapshot
  [ "$status" -eq 0 ]
  [ "$(cat "$UPSTREAM_LOG.registry")" != "$first" ]
}

@test "evidence bundles preserve the explicit worktree browser and registry identity" {
  export PWCLI_TEST_WSL=1
  mkdir -p "$BATS_TEST_TMPDIR/bundle-a" "$BATS_TEST_TMPDIR/bundle-b" "$BATS_TEST_TMPDIR/task/sub"
  git -C "$BATS_TEST_TMPDIR/task" init -q
  ln -s "$BATS_TEST_TMPDIR/task" "$BATS_TEST_TMPDIR/task-link"
  export PWCLI_WORKSPACE="$BATS_TEST_TMPDIR/task"
  cd "$BATS_TEST_TMPDIR/bundle-a"
  run bash "$WRAPPER" -s=shared open
  [ "$status" -eq 0 ]
  local first allocations
  first="$(cat "$UPSTREAM_LOG.registry")"
  allocations="$(cat "$BROWSER_OWNERSHIP_DIR/allocations.json")"
  cd "$BATS_TEST_TMPDIR/bundle-b"
  export PWCLI_WORKSPACE="$BATS_TEST_TMPDIR/task-link/sub"
  run bash "$WRAPPER" -s=shared snapshot
  [ "$status" -eq 0 ]
  [ "$(cat "$UPSTREAM_LOG.registry")" = "$first" ]
  [ "$(cat "$BROWSER_OWNERSHIP_DIR/allocations.json")" = "$allocations" ]
  run bash "$WRAPPER" -s=other open
  [ "$status" -ne 0 ]
  [[ "$output" == *"owned by session 'shared'"* ]]
  run bash "$WRAPPER" -s=shared close
  [ "$status" -eq 0 ]
  [ "$(cat "$UPSTREAM_LOG.registry")" = "$first" ]
}

@test "invalid explicit worktree paths fail before browser or upstream operations" {
  export PWCLI_TEST_WSL=1
  local candidate
  for candidate in '' relative "$BATS_TEST_TMPDIR/missing" "$BATS_TEST_TMPDIR"; do
    run env PWCLI_WORKSPACE="$candidate" bash "$WRAPPER" -s=shared open
    [ "$status" -ne 0 ]
    [[ "$output" == *'PWCLI_WORKSPACE must'* ]]
    [ ! -e "$POWERSHELL_LOG" ]
    [ ! -e "$UPSTREAM_LOG" ]
  done
}

@test "relocation refuses a surviving Dashboard and preserves show kill cleanup" {
  export PWCLI_TEST_WSL=1
  run bash "$WRAPPER" -s=surviving-dashboard open --headed
  [ "$status" -eq 0 ]
  run bash "$WRAPPER" -s=surviving-dashboard show
  [ "$status" -eq 0 ]
  local original dashboard_pid
  original="$(cat "$BROWSER_OWNERSHIP_DIR/allocations.json")"
  dashboard_pid="$(cat "$STATE_DIR/dashboard.pid")"
  printf 'absent\n' >"$POWERSHELL_STATE"
  run "$MANAGED_CHROME_OWNER" recover --identity "$IDENTITY"
  [ "$status" -eq 0 ]
  run "$MANAGED_CHROME_OWNER" relocate --identity "$IDENTITY" --role playwright --workspace "$PROJECT_ROOT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'Close the worktree Dashboard'* ]]
  [ "$(cat "$BROWSER_OWNERSHIP_DIR/allocations.json")" = "$original" ]
  kill -0 "$dashboard_pid"
  run bash "$WRAPPER" -s=surviving-dashboard show --kill
  [ "$status" -eq 0 ]
  [ ! -f "$STATE_DIR/dashboard.pid" ]
  run "$MANAGED_CHROME_OWNER" relocate --identity "$IDENTITY" --role playwright --workspace "$PROJECT_ROOT"
  [ "$status" -eq 0 ]
}

@test "wrapper rejects an allocation relocated before runtime lock acquisition" {
  export PWCLI_TEST_WSL=1 PROJECT_ROOT
  cat >"$FAKE_BIN/relocate-before-flock" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
"$MANAGED_CHROME_OWNER" relocate --identity "$IDENTITY" --role playwright --workspace "$PROJECT_ROOT" >"$UPSTREAM_LOG.relocated"
exec flock "$@"
SH
  chmod +x "$FAKE_BIN/relocate-before-flock"
  export PWCLI_FLOCK="$FAKE_BIN/relocate-before-flock"
  run bash "$WRAPPER" -s=stale-allocation open
  [ "$status" -ne 0 ]
  [[ "$output" == *'Browser allocation changed'* ]]
  [ -s "$UPSTREAM_LOG.relocated" ]
  ! grep -Fq -- '-Action Start' "$POWERSHELL_LOG"
  [ ! -e "$UPSTREAM_LOG" ]
}

@test "wrapper startup waits while direct relocation holds both locks before rename" {
  export PWCLI_TEST_WSL=1
  local barrier="$BATS_TEST_TMPDIR/rename" updater wrapper_pid
  export TEST_OWNER_LOCK="$BROWSER_OWNERSHIP_DIR/ownership.lock"
  export TEST_RUNTIME_LOCK="$STATE_DIR/runtime.lock"
  env NODE_OPTIONS="--import=$PACKAGE_ROOT/tests/fixtures/playwright-relocation-hooks.mjs" \
    TEST_RELOCATION_BARRIER="$barrier" \
    "$MANAGED_CHROME_OWNER" relocate --identity "$IDENTITY" --role playwright --workspace "$PROJECT_ROOT" >"$barrier.log" 2>&1 &
  updater=$!
  for _ in {1..200}; do
    [[ -f "$barrier.ready" ]] && break
    sleep 0.01
  done
  if [[ ! -f "$barrier.ready" ]]; then
    cat "$barrier.log"
    kill "$updater" 2>/dev/null || true
    wait "$updater" || true
    return 1
  fi
  bash "$WRAPPER" -s=after-relocation open >"$barrier.wrapper" 2>&1 &
  wrapper_pid=$!
  sleep 0.2
  local prematurely_started=0
  [[ ! -e "$UPSTREAM_LOG" ]] || prematurely_started=1
  touch "$barrier.continue"
  wait "$updater"
  wait "$wrapper_pid"
  [ "$prematurely_started" -eq 0 ]
  [ -s "$UPSTREAM_LOG" ]
  run bash "$WRAPPER" -s=after-relocation close
  [ "$status" -eq 0 ]
}

@test "external annotation cleans its Dashboard when opening the display tab fails" {
  export PWCLI_TEST_WSL=1 PWCLI_FAKE_DASHBOARD_TAB_FAIL=1

  run env PWCLI_EXTERNAL_CDP=1 bash "$WRAPPER" -s=dogfood-annotate show --annotate --json

  [ "$status" -eq 22 ]
  [ ! -e "$STATE_DIR/dashboard.pid" ]
  [ ! -e "$STATE_DIR/chrome.pid" ]
  ! grep -Fq -- '--annotate' "$UPSTREAM_LOG.calls"
}

@test "interrupted external annotation cleans only its newly started Dashboard" {
  export PWCLI_TEST_WSL=1 PWCLI_FAKE_ANNOTATION_WAIT=1
  for existing in 0 1; do
    if ((existing)); then
      run bash "$WRAPPER" -s=dogfood-annotate show
      [ "$status" -eq 0 ]
    fi
    for signal_name in SIGINT SIGTERM; do
      run python3 - "$WRAPPER" "$signal_name" <<'PYTEST'
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

marker = Path(os.environ["UPSTREAM_LOG"] + ".waiting")
marker.unlink(missing_ok=True)
proc = subprocess.Popen(
    ["bash", sys.argv[1], "-s=dogfood-annotate", "show", "--annotate", "--json"],
    env={**os.environ, "PWCLI_EXTERNAL_CDP": "1"},
    start_new_session=True,
)
try:
    deadline = time.monotonic() + 15
    while not marker.exists():
        assert proc.poll() is None, "wrapper exited before annotation wait"
        assert time.monotonic() < deadline, "annotation wait timed out"
        time.sleep(.05)
    sig = getattr(signal, sys.argv[2])
    os.killpg(proc.pid, sig)
    assert proc.wait(timeout=15) == 128 + sig
finally:
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
PYTEST
      [ "$status" -eq 0 ]
      if ((existing)); then
        [ -e "$STATE_DIR/dashboard.pid" ]
        [ -e "$STATE_DIR/chrome.pid" ]
      else
        [ ! -e "$STATE_DIR/dashboard.pid" ]
        [ ! -e "$STATE_DIR/chrome.pid" ]
      fi
    done
  done
}
