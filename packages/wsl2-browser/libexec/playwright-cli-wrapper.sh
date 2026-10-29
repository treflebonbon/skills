#!/usr/bin/env bash

set -euo pipefail

pwcli_libexec="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
pwcli_package_root="$(cd -- "$pwcli_libexec/.." && pwd -P)"
pwcli_upstream="${PWCLI_UPSTREAM:-$pwcli_package_root/bin/upstream-playwright-cli}"
pwcli_wslinfo="${PWCLI_WSLINFO:-wslinfo}"
pwcli_powershell="${PWCLI_POWERSHELL:-powershell.exe}"
pwcli_wslpath="${PWCLI_WSLPATH:-wslpath}"
pwcli_curl="${PWCLI_CURL:-curl}"
pwcli_cdp_close="${PWCLI_CDP_CLOSE:-$pwcli_libexec/playwright-cli-cdp-close.js}"
pwcli_windows_script="${PWCLI_WINDOWS_SCRIPT:-$pwcli_libexec/playwright-cli-windows.ps1}"
pwcli_proc_root="${PWCLI_PROC_ROOT:-/proc}"
pwcli_flock="${PWCLI_FLOCK:-flock}"
pwcli_owner_command="${MANAGED_CHROME_OWNER:-$pwcli_package_root/bin/managed-chrome-owner}"
pwcli_runtime_command="${PWCLI_RUNTIME_COMMAND:-$pwcli_package_root/bin/playwright-runtime}"

fail() {
  printf 'playwright-cli: %s\n' "$*" >&2
  exit 1
}

if [[ "${1:-}" == "__pwcli-dashboard-daemon" ]]; then
  pwcli_fifo="$2"
  pwcli_launcher_file="$3"
  pwcli_inherited_lock_fd="${4:-}"
  if [[ "$pwcli_inherited_lock_fd" =~ ^[0-9]+$ ]]; then
    exec {pwcli_inherited_lock_fd}>&-
  fi
  printf '%s\n' "$$" >"$pwcli_launcher_file"
  exec 3<>"$pwcli_fifo"
  exec "$pwcli_upstream" show --host=127.0.0.1 --port="$5" <&3
fi

is_wsl() {
  if [[ -n "${PWCLI_TEST_WSL:-}" ]]; then
    [[ "$PWCLI_TEST_WSL" == "1" ]]
    return
  fi
  [[ -r /proc/sys/kernel/osrelease ]] &&
    grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null
}

if ! is_wsl; then
  exec "$pwcli_upstream" "$@"
fi

if [[ -n "${PWCLI_WORKSPACE+x}" ]]; then
  [[ "$PWCLI_WORKSPACE" == /* ]] || fail "PWCLI_WORKSPACE must be an absolute path inside the task worktree."
  pwcli_workspace="$(git -C "$PWCLI_WORKSPACE" rev-parse --show-toplevel 2>/dev/null)" ||
    fail "PWCLI_WORKSPACE must identify an existing Git worktree."
else
  pwcli_workspace="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
fi
pwcli_workspace="$(cd "$pwcli_workspace" && pwd -P)"
# Upstream uses one global session registry when no .playwright marker exists.
# Scope both session lookup and Dashboard discovery, including passthrough commands.
pwcli_workspace_hash="$(printf '%s' "$pwcli_workspace" | sha256sum)"
pwcli_workspace_hash="${pwcli_workspace_hash%% *}"
pwcli_registry_root="${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright/worktrees/$pwcli_workspace_hash"
export PWTEST_DAEMON_SESSION_DIR="${PWTEST_DAEMON_SESSION_DIR:-$pwcli_registry_root/sessions}"
export PWTEST_SERVER_REGISTRY="${PWTEST_SERVER_REGISTRY:-$pwcli_registry_root/browsers}"
export PWTEST_SOCKETS_DIR="${PWTEST_SOCKETS_DIR:-/tmp/pwcli-$UID/worktree-${pwcli_workspace_hash:0:32}}"
umask 077

pwcli_command=
pwcli_confirm_identity=
pwcli_session=default
pwcli_option_value_next=
pwcli_explicit_show_endpoint=0
pwcli_passthrough_metadata=0
pwcli_show_annotate=0
pwcli_show_kill=0
pwcli_requested_mode=headless
pwcli_open_headed=0
pwcli_bypass_managed=0
for pwcli_argument in "$@"; do
  if [[ -n "$pwcli_option_value_next" ]]; then
    if [[ "$pwcli_option_value_next" == "session" ]]; then
      pwcli_session="$pwcli_argument"
    elif [[ "$pwcli_option_value_next" == "confirm-identity" ]]; then
      pwcli_confirm_identity="$pwcli_argument"
    fi
    pwcli_option_value_next=
    continue
  fi
  case "$pwcli_argument" in
  --confirm-identity)
    pwcli_option_value_next=confirm-identity
    ;;
  --confirm-identity=*)
    pwcli_confirm_identity="${pwcli_argument#*=}"
    ;;
  -s | --session)
    pwcli_option_value_next=session
    ;;
  -s=* | --session=*)
    pwcli_session="${pwcli_argument#*=}"
    ;;
  --config | --browser | --profile | --device)
    pwcli_bypass_managed=1
    pwcli_option_value_next=ignore
    ;;
  --config=* | --browser=* | --profile=* | --device=* | --persistent | --mobile)
    pwcli_bypass_managed=1
    ;;
  --host | --port)
    pwcli_explicit_show_endpoint=1
    pwcli_option_value_next=ignore
    ;;
  --host=* | --port=*)
    pwcli_explicit_show_endpoint=1
    ;;
  --kill)
    pwcli_show_kill=1
    ;;
  --annotate)
    pwcli_show_annotate=1
    ;;
  --headed)
    pwcli_open_headed=1
    ;;
  --help | -h | --version | -v)
    pwcli_passthrough_metadata=1
    ;;
  -*)
    ;;
  *)
    if [[ -z "$pwcli_command" ]]; then
      pwcli_command="$pwcli_argument"
    fi
    ;;
  esac
done

if [[ "$pwcli_command" != "show" ]]; then
  pwcli_show_kill=0
  pwcli_show_annotate=0
fi

if ((pwcli_passthrough_metadata)); then
  exec "$pwcli_upstream" "$@"
fi

if [[ "$pwcli_command" == "open" || "$pwcli_command" == "show" ]]; then
  pwcli_browser_env=(
    PLAYWRIGHT_MCP_CONFIG
    PLAYWRIGHT_MCP_BROWSER
    PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS
    PLAYWRIGHT_MCP_CDP_ENDPOINT
    PLAYWRIGHT_MCP_CDP_HEADERS
    PLAYWRIGHT_MCP_CDP_TIMEOUT
    PLAYWRIGHT_MCP_DEVICE
    PLAYWRIGHT_MCP_EXECUTABLE_PATH
    PLAYWRIGHT_MCP_EXTENSION
    PLAYWRIGHT_MCP_GRANT_PERMISSIONS
    PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS
    PLAYWRIGHT_MCP_INIT_PAGE
    PLAYWRIGHT_MCP_INIT_SCRIPT
    PLAYWRIGHT_MCP_ISOLATED
    PLAYWRIGHT_MCP_MOBILE
    PLAYWRIGHT_MCP_PROXY_BYPASS
    PLAYWRIGHT_MCP_PROXY_SERVER
    PLAYWRIGHT_MCP_SANDBOX
    PLAYWRIGHT_MCP_STORAGE_STATE
    PLAYWRIGHT_MCP_USER_AGENT
    PLAYWRIGHT_MCP_USER_DATA_DIR
    PLAYWRIGHT_MCP_VIEWPORT_SIZE
    PWTEST_CLI_GLOBAL_CONFIG
  )
  for pwcli_env_name in "${pwcli_browser_env[@]}"; do
    if [[ -n "${!pwcli_env_name:-}" ]]; then
      pwcli_bypass_managed=1
      break
    fi
  done

  if [[ -f .playwright/cli.config.json ]]; then
    pwcli_bypass_managed=1
  fi
  if ((pwcli_bypass_managed)); then
    fail "local browser overrides are unsupported in WSL2 browser-free mode. Use explicit 'playwright-cli attach --cdp=<remote-endpoint>' for a remote CDP browser."
  fi
fi

if [[ "$pwcli_command" == "open" ]]; then
  if [[ "${PLAYWRIGHT_MCP_HEADLESS:-}" == "false" || "${PLAYWRIGHT_MCP_HEADLESS:-}" == "0" ]]; then
    pwcli_requested_mode=headed
  fi
  if ((pwcli_open_headed)); then
    pwcli_requested_mode=headed
  fi

elif [[ "$pwcli_command" == "show" ]]; then
  pwcli_requested_mode=headed
  if ((pwcli_explicit_show_endpoint)); then
    exec "$pwcli_upstream" "$@"
  fi
elif [[ "$pwcli_command" != "close" && "$pwcli_command" != "delete-data" && "$pwcli_command" != "close-all" && "$pwcli_command" != "kill-all" && "$pwcli_command" != "reset-profile" ]]; then
  exec "$pwcli_upstream" "$@"
fi

pwcli_allocation="$("$pwcli_owner_command" locate --role playwright --workspace "$pwcli_workspace")"
IFS=$'\t' read -r pwcli_identity pwcli_profile pwcli_cdp_endpoint pwcli_dashboard_port <<<"$pwcli_allocation"
[[ -n "$pwcli_identity" && "$pwcli_dashboard_port" =~ ^[0-9]+$ ]] || fail "Invalid browser allocation"
if [[ "$pwcli_command" == "reset-profile" && "$pwcli_confirm_identity" != "$pwcli_identity" ]]; then
  fail "reset-profile requires the exact identity: --confirm-identity $pwcli_identity (profile: $pwcli_profile)"
fi
pwcli_runtime_layout="$("$pwcli_runtime_command" "$pwcli_identity")"
IFS=$'\t' read -r pwcli_state_dir pwcli_lock_file pwcli_dashboard_pid_file \
  pwcli_dashboard_start_time_file pwcli_dashboard_launcher_file pwcli_dashboard_session_file \
  pwcli_dashboard_fifo pwcli_lease pwcli_owner_token_file pwcli_dashboard_log <<<"$pwcli_runtime_layout"
[[ -n "$pwcli_dashboard_log" ]] || fail "Invalid Playwright runtime layout"
umask 077
mkdir -p "$pwcli_state_dir"
chmod 700 "$pwcli_state_dir"

exec {pwcli_lock_fd}>"$pwcli_lock_file"
if ! "$pwcli_flock" --exclusive --wait 5 "$pwcli_lock_fd"; then
  fail "timed out waiting for the Managed Playwright Chrome runtime lock at $pwcli_lock_file"
fi
release_lock() {
  exec {pwcli_lock_fd}>&-
}
trap release_lock EXIT

# relocate may have completed while this command waited for the runtime lock.
[[ "$("$pwcli_owner_command" locate --role playwright --workspace "$pwcli_workspace")" == "$pwcli_allocation" ]] ||
  fail "Browser allocation changed while waiting for the runtime lock. Retry the command."

pwcli_powershell_ready=0
pwcli_had_consumer=0
pwcli_managed_owner=0
pwcli_owner_session=
pwcli_owner_workspace=
pwcli_owner_reserved=0
if [[ -f "$pwcli_lease" ]]; then
  pwcli_owner_session="$(sed -n '1p' "$pwcli_lease")"
  pwcli_owner_workspace="$(sed -n '2p' "$pwcli_lease")"
  if [[ "$pwcli_owner_session" == "$pwcli_session" && "$pwcli_owner_workspace" == "$pwcli_workspace" ]]; then
    pwcli_managed_owner=1
  fi
  pwcli_had_consumer=1
fi

pwcli_owner_command="${MANAGED_CHROME_OWNER:-$pwcli_package_root/bin/managed-chrome-owner}"
pwcli_owner_token="$(cat "$pwcli_owner_token_file" 2>/dev/null || true)"

browser_owner() {
  "$pwcli_owner_command" --identity "$pwcli_identity" "$@"
}

check_browser_owner_conflict() {
  browser_owner check --role playwright --token "$pwcli_owner_token"
}

write_browser_owner() {
  browser_owner activate "$pwcli_owner_token"
  pwcli_owner_reserved=0
}

reserve_browser_owner() {
  local previous_token="$pwcli_owner_token"
  pwcli_owner_token="$(browser_owner reserve --role playwright \
    --id "$pwcli_session@$pwcli_workspace" --pid "$$" \
    --mode "$pwcli_requested_mode" --profile "$pwcli_profile" \
    --endpoint "$pwcli_cdp_endpoint" --token "$previous_token")"
  printf '%s\n' "$pwcli_owner_token" >"$pwcli_owner_token_file"
  if [[ "$previous_token" != "$pwcli_owner_token" ]]; then
    pwcli_owner_reserved=1
  fi
}

remove_browser_owner() {
  browser_owner release "$pwcli_owner_token"
  rm -f "$pwcli_owner_token_file"
  pwcli_owner_token=
}

check_browser_owner_conflict

if [[ "$pwcli_command" == "open" && -f "$pwcli_lease" ]] &&
  ((pwcli_managed_owner == 0)); then
  fail "Managed Playwright Chrome is owned by session '$pwcli_owner_session' in '$pwcli_owner_workspace'. Close that session before opening '$pwcli_session'."
fi

prepare_powershell() {
  if ((pwcli_powershell_ready)); then
    return
  fi
  if ! command -v "$pwcli_powershell" >/dev/null 2>&1; then
    fail "powershell.exe is unavailable. Enable Windows interoperability for this WSL distribution, restart WSL, and verify with: powershell.exe -NoProfile -Command '\$PSVersionTable.PSVersion'"
  fi
  if [[ "$pwcli_windows_script" != *\\* && "$pwcli_windows_script" != [A-Za-z]:* ]]; then
    pwcli_windows_script="$("$pwcli_wslpath" -w "$pwcli_windows_script")"
  fi
  pwcli_powershell_ready=1
}

powershell_action() {
  prepare_powershell
  local action="$1"
  local mode="${2:-}"
  local -a powershell_args=(
    -NoProfile
    -NonInteractive
    -WindowStyle Hidden
    -ExecutionPolicy Bypass
    -File "$pwcli_windows_script"
    -Action "$action"
  )
  if [[ -n "$mode" ]]; then
    powershell_args+=(-Mode "$mode")
  fi
  powershell_args+=(-ProfileDir "$pwcli_profile" -DebugPort "${pwcli_cdp_endpoint##*:}")
  if [[ "$action" == "Start" ]]; then
    browser_owner run "$pwcli_owner_token" -- "$pwcli_powershell" "${powershell_args[@]}"
  else
    "$pwcli_powershell" "${powershell_args[@]}" | tr -d '\r'
  fi
}

inspect_chrome() {
  powershell_action Inspect | tail -n 1
}

managed_status_mode() {
  local status="$1"
  [[ "$status" =~ ^managed:(headless|headed):[0-9]+$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

managed_status_pid() {
  local status="$1"
  [[ "$status" =~ ^managed:(headless|headed):([0-9]+)$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[2]}"
}

dashboard_port_ready() {
  "$pwcli_curl" \
    --fail \
    --silent \
    --max-time "${PWCLI_DASHBOARD_PROBE_TIMEOUT:-0.25}" \
    "http://127.0.0.1:$pwcli_dashboard_port/" >/dev/null
}

dashboard_listener_inodes() {
  local address
  printf -v address '0100007F:%04X' "$pwcli_dashboard_port"
  awk -v address="$address" '$2 == address && $4 == "0A" { print $10 }' "$pwcli_proc_root/net/tcp"
}

process_owns_socket_inode() {
  local pid="$1"
  local inode="$2"
  local fd target
  [[ "$pid" =~ ^[0-9]+$ && -d "$pwcli_proc_root/$pid/fd" ]] || return 1
  for fd in "$pwcli_proc_root/$pid/fd/"*; do
    [[ -L "$fd" ]] || continue
    target="$(readlink "$fd" 2>/dev/null || true)"
    if [[ "$target" == "socket:[$inode]" ]]; then
      return 0
    fi
  done
  return 1
}

find_dashboard_listener_pid() {
  local inode process_fd_dir pid
  while read -r inode; do
    [[ -n "$inode" ]] || continue
    for process_fd_dir in "$pwcli_proc_root"/[0-9]*/fd; do
      pid="${process_fd_dir#"$pwcli_proc_root"/}"
      pid="${pid%/fd}"
      if process_owns_socket_inode "$pid" "$inode"; then
        printf '%s\n' "$pid"
        return 0
      fi
    done
  done < <(dashboard_listener_inodes)
  return 1
}

process_session_id() {
  local pid="$1"
  local stat_data stat_tail session_id
  [[ -r "$pwcli_proc_root/$pid/stat" ]] || return 1
  stat_data="$(<"$pwcli_proc_root/$pid/stat")"
  stat_tail="${stat_data##*) }"
  read -r _ _ _ session_id _ <<<"$stat_tail"
  printf '%s\n' "$session_id"
}

process_start_time() {
  local pid="$1"
  local stat_data stat_tail
  local -a stat_fields
  [[ -r "$pwcli_proc_root/$pid/stat" ]] || return 1
  stat_data="$(<"$pwcli_proc_root/$pid/stat")"
  stat_tail="${stat_data##*) }"
  read -r -a stat_fields <<<"$stat_tail"
  [[ -n "${stat_fields[19]:-}" ]] || return 1
  printf '%s\n' "${stat_fields[19]}"
}

dashboard_pid_owns_port() {
  local pid="$1"
  local inode
  while read -r inode; do
    if process_owns_socket_inode "$pid" "$inode"; then
      return 0
    fi
  done < <(dashboard_listener_inodes)
  return 1
}

dashboard_listener_for_launcher() {
  local launcher_pid="$1"
  local listener_pid listener_session_id
  listener_pid="$(find_dashboard_listener_pid)" || return 1
  listener_session_id="$(process_session_id "$listener_pid")" || return 1
  [[ "$listener_session_id" == "$launcher_pid" ]] || return 1
  printf '%s\n' "$listener_pid"
}

terminate_dashboard_session() {
  local session_id="$1"
  local process_dir pid
  for process_dir in "$pwcli_proc_root"/[0-9]*; do
    pid="${process_dir#"$pwcli_proc_root"/}"
    if [[ "$(process_session_id "$pid" 2>/dev/null || true)" == "$session_id" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}

cdp_ready() {
  "$pwcli_curl" \
    --fail \
    --silent \
    --max-time "${PWCLI_CDP_PROBE_TIMEOUT:-0.5}" \
    "$pwcli_cdp_endpoint/json/version" >/dev/null
}

dashboard_status() {
  if [[ -f "$pwcli_dashboard_pid_file" ]]; then
    local pid recorded_start_time actual_start_time
    pid="$(cat "$pwcli_dashboard_pid_file")"
    recorded_start_time="$(cat "$pwcli_dashboard_start_time_file" 2>/dev/null || true)"
    actual_start_time="$(process_start_time "$pid" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] &&
      [[ -n "$recorded_start_time" && "$actual_start_time" == "$recorded_start_time" ]] &&
      kill -0 "$pid" 2>/dev/null; then
      if ! dashboard_port_ready; then
        return 3
      fi
      if dashboard_pid_owns_port "$pid"; then
        return 0
      fi
    fi
    rm -f \
      "$pwcli_dashboard_pid_file" \
      "$pwcli_dashboard_start_time_file" \
      "$pwcli_dashboard_session_file" \
      "$pwcli_dashboard_launcher_file" \
      "$pwcli_dashboard_fifo"
  elif [[ -f "$pwcli_dashboard_start_time_file" || -f "$pwcli_dashboard_launcher_file" ]]; then
    rm -f "$pwcli_dashboard_start_time_file" "$pwcli_dashboard_launcher_file"
  fi
  if dashboard_port_ready; then
    return 2
  fi
  return 1
}

pwcli_dashboard_running=0
if dashboard_status; then
  pwcli_dashboard_running=1
  pwcli_had_consumer=1
else
  pwcli_dashboard_result=$?
  if ((pwcli_dashboard_result == 2)); then
    fail "127.0.0.1:$pwcli_dashboard_port is already in use without matching Managed Playwright Dashboard state. Stop that process, then retry."
  fi
  if ((pwcli_dashboard_result == 3)); then
    fail "Managed Playwright Dashboard is still stopping. Wait for the recorded process to exit, then retry."
  fi
fi

close_chrome_if_unused() {
  if [[ -f "$pwcli_lease" ]]; then
    return
  fi
  local dashboard_result=0
  if dashboard_status; then
    return
  else
    dashboard_result=$?
  fi
  if ((dashboard_result == 2)); then
    fail "refusing to close Chrome while 127.0.0.1:$pwcli_dashboard_port is in use without matching Dashboard state."
  fi
  if ((dashboard_result == 3)); then
    return
  fi
  if [[ ! -f "$pwcli_state_dir/chrome.pid" ]]; then
    return
  fi
  local recorded_pid chrome_status actual_pid
  recorded_pid="$(cat "$pwcli_state_dir/chrome.pid")"
  chrome_status="$(inspect_chrome || true)"
  if [[ "$chrome_status" == "absent" ]]; then
    remove_browser_owner
    rm -f "$pwcli_state_dir/chrome.pid"
    return
  fi
  actual_pid="$(managed_status_pid "$chrome_status" || true)"
  if [[ ! "$recorded_pid" =~ ^[0-9]+$ || "$actual_pid" != "$recorded_pid" ]]; then
    fail "refusing to close Chrome because recorded Managed Playwright Chrome PID '$recorded_pid' does not match Windows ownership status '${chrome_status:-empty}'. Close the dedicated Chrome manually, then retry."
  fi
  if ! "$pwcli_cdp_close" "$pwcli_cdp_endpoint"; then
    fail "could not close Managed Playwright Chrome through CDP. Close the dedicated Chrome manually; the profile was preserved."
  fi
  local deadline=$((SECONDS + ${PWCLI_CDP_TIMEOUT:-10}))
  while ((SECONDS <= deadline)); do
    if ! chrome_status="$(inspect_chrome)"; then
      fail "could not inspect Managed Playwright Chrome after Browser.close. Close the dedicated Chrome manually; ownership state was preserved."
    fi
    if [[ "$chrome_status" == "absent" ]]; then
      remove_browser_owner
      rm -f "$pwcli_state_dir/chrome.pid"
      return
    fi
    actual_pid="$(managed_status_pid "$chrome_status" || true)"
    if [[ "$actual_pid" != "$recorded_pid" ]]; then
      fail "Managed Playwright Chrome ownership changed while closing (status: ${chrome_status:-empty}). Close the dedicated Chrome manually; ownership state was preserved."
    fi
    sleep 0.2
  done
  fail "Managed Playwright Chrome did not exit before the timeout (status: ${chrome_status:-empty}). Close the dedicated Chrome manually; ownership state was preserved."
}

if [[ "$pwcli_command" == "delete-data" ]]; then
  fail "will not delete Managed Playwright Chrome data automatically. First close the session and Dashboard, then reset only '$pwcli_profile' using: playwright-cli reset-profile --confirm-identity $pwcli_identity."
fi

if [[ "$pwcli_command" == "reset-profile" ]]; then
  [[ ! -f "$pwcli_lease" && "$pwcli_dashboard_running" -eq 0 && ! -f "$pwcli_owner_token_file" ]] ||
    fail "Close this worktree's session and Dashboard before reset-profile."
  [[ "$(browser_owner status)" == "null" ]] || fail "Browser ownership must be released before reset-profile."
  [[ "$(inspect_chrome)" == "absent" ]] || fail "The exact worktree profile must be stopped before reset-profile."
  powershell_action Reset
  exit 0
fi

if [[ "$pwcli_command" == "close" ]]; then
  "$pwcli_upstream" "$@"
  if ((pwcli_managed_owner)); then
    rm -f "$pwcli_lease"
    close_chrome_if_unused
  fi
  exit 0
fi

if [[ "$pwcli_command" == "close-all" || "$pwcli_command" == "kill-all" ]]; then
  fail "Use session-scoped close; bulk termination can affect other worktrees."
fi

if ((pwcli_show_kill)); then
  if ((pwcli_dashboard_running)) && [[ "$(cat "$pwcli_dashboard_session_file" 2>/dev/null || true)" != "$pwcli_session" ]]; then
    fail "Dashboard belongs to session '$(cat "$pwcli_dashboard_session_file" 2>/dev/null || printf unknown)'; use that session to stop it."
  fi
  pwcli_dashboard_pid=
  if [[ -f "$pwcli_dashboard_pid_file" ]]; then
    pwcli_dashboard_pid="$(cat "$pwcli_dashboard_pid_file")"
  fi
  "$pwcli_upstream" "$@" --port="$pwcli_dashboard_port"
  pwcli_kill_deadline=$((SECONDS + ${PWCLI_DASHBOARD_STOP_TIMEOUT:-5}))
  while [[ "$pwcli_dashboard_pid" =~ ^[0-9]+$ ]] &&
    kill -0 "$pwcli_dashboard_pid" 2>/dev/null &&
    ((SECONDS <= pwcli_kill_deadline)); do
    sleep 0.1
  done
  if [[ "$pwcli_dashboard_pid" =~ ^[0-9]+$ ]] &&
    kill -0 "$pwcli_dashboard_pid" 2>/dev/null; then
    fail "Managed Playwright Dashboard did not exit before the timeout. Its process identity and Chrome ownership state were preserved."
  fi
  rm -f \
    "$pwcli_dashboard_pid_file" \
    "$pwcli_dashboard_start_time_file" \
    "$pwcli_dashboard_session_file" \
    "$pwcli_dashboard_launcher_file" \
    "$pwcli_dashboard_fifo"
  close_chrome_if_unused
  exit 0
fi

if ((pwcli_show_annotate)) && ((pwcli_managed_owner == 0)); then
  if [[ -f "$pwcli_lease" ]]; then
    fail "annotation requires the lease-owning session '$pwcli_owner_session' in '$pwcli_owner_workspace'."
  fi
  if [[ "${PWCLI_EXTERNAL_CDP:-0}" != "1" ]]; then
    fail "annotation requires an open Managed Playwright Chrome session."
  fi
fi

if ((pwcli_show_annotate && pwcli_dashboard_running)) &&
  [[ "$(cat "$pwcli_dashboard_session_file" 2>/dev/null || true)" != "$pwcli_session" ]]; then
  fail "annotation requires the Dashboard-owning session."
fi

pwcli_network_mode="$("$pwcli_wslinfo" --networking-mode 2>/dev/null || true)"
if [[ "$pwcli_network_mode" != "mirrored" ]]; then
  fail "Managed Playwright Chrome requires WSL2 mirrored networking. Set [wsl2] networkingMode=mirrored in %UserProfile%\\.wslconfig, run wsl.exe --shutdown, restart WSL, and verify with: wslinfo --networking-mode"
fi

prepare_powershell

release_reserved_browser_owner() {
  if ((pwcli_owner_reserved == 0)); then
    return
  fi
  remove_browser_owner
  pwcli_owner_reserved=0
}

cleanup_failed_browser_start() {
  if ((pwcli_owner_reserved == 0)); then
    return
  fi
  # The common owner keeps any live or unconfirmed startup reserved.
  # A failed start must not call an unsupported Windows Cleanup action.
  release_reserved_browser_owner || true
}

trap 'cleanup_failed_browser_start; release_lock' EXIT

if [[ "$pwcli_command" == "open" ||
  ("$pwcli_command" == "show" && "$pwcli_show_kill" -eq 0) ]]; then
  reserve_browser_owner
fi

ensure_chrome() {
  local status actual_mode actual_pid remediation
  status="$(inspect_chrome || true)"
  case "$status" in
  managed:*)
    actual_mode="$(managed_status_mode "$status" || true)"
    if [[ -z "$actual_mode" ]]; then
      fail "could not inspect Windows Chrome ownership (status: ${status:-empty}). Verify PowerShell and retry."
    fi
    if ((pwcli_had_consumer == 0)); then
      fail "an exact Managed Playwright Chrome process is already running without matching state in this WSL runtime. Close that dedicated Chrome manually, then retry."
    fi
    if [[ "$actual_mode" != "$pwcli_requested_mode" ]]; then
      remediation=
      if [[ -f "$pwcli_lease" ]]; then
        remediation=" Run playwright-cli -s='$pwcli_owner_session' close from '$pwcli_owner_workspace'."
        if [[ "$pwcli_command" == "show" ]]; then
          remediation+=" Then run playwright-cli -s='$pwcli_owner_session' open --headed, followed by playwright-cli show."
        fi
      fi
      if ((pwcli_dashboard_running)); then
        remediation+=" Run playwright-cli show --kill."
      fi
      fail "Managed Playwright Chrome current mode '$actual_mode' does not match requested mode '$pwcli_requested_mode'.$remediation"
    fi
    ;;
  absent)
    powershell_action Start "$pwcli_requested_mode" >/dev/null
    ;;
  chrome-missing)
    fail "Windows Google Chrome was not found. Install the stable Windows Chrome release, then retry."
    ;;
  port-conflict:*)
    fail "$pwcli_cdp_endpoint is owned by a process that is not Managed Playwright Chrome. Stop that process or free the port; it will not be replaced automatically."
    ;;
  profile-conflict:*)
    fail "the Managed Playwright Chrome profile is open with different launch arguments. Close that dedicated Chrome manually, then retry."
    ;;
  *)
    fail "could not inspect Windows Chrome ownership (status: ${status:-empty}). Verify PowerShell and retry."
    ;;
  esac

  local deadline=$((SECONDS + ${PWCLI_CDP_TIMEOUT:-10}))
  while ((SECONDS <= deadline)); do
    status="$(inspect_chrome || true)"
    actual_mode="$(managed_status_mode "$status" || true)"
    actual_pid="$(managed_status_pid "$status" || true)"
    if [[ "$actual_mode" == "$pwcli_requested_mode" && -n "$actual_pid" ]] && cdp_ready; then
      printf '%s\n' "$actual_pid" >"$pwcli_state_dir/chrome.pid"
      write_browser_owner "$actual_pid"
      return
    fi
    sleep 0.2
  done
  fail "Managed Playwright Chrome did not expose CDP at $pwcli_cdp_endpoint before the timeout. Close the dedicated Chrome, verify port ${pwcli_cdp_endpoint##*:} is free, and retry."
}

ensure_chrome

if [[ "$pwcli_command" == "open" ]]; then
  pwcli_created_lease=0
  if ((pwcli_managed_owner == 0)); then
    printf '%s\n%s\n' "$pwcli_session" "$pwcli_workspace" >"$pwcli_lease"
    pwcli_created_lease=1
  fi
  pwcli_config="$pwcli_state_dir/managed-cli-config.json"
  printf '%s\n' \
    '{' \
    '  "browser": {' \
    '    "browserName": "chromium",' \
    "    \"cdpEndpoint\": \"$pwcli_cdp_endpoint\"," \
    '    "cdpTimeout": 10000' \
    '  }' \
    '}' >"$pwcli_config"

  if PWTEST_CLI_MANAGED_CHROME=1 "$pwcli_upstream" "$@" "--config=$pwcli_config"; then
    exit 0
  else
    pwcli_upstream_status=$?
    if ((pwcli_created_lease)); then
      rm -f "$pwcli_lease"
      close_chrome_if_unused
    fi
    exit "$pwcli_upstream_status"
  fi
fi

pwcli_started_dashboard=0
if ((pwcli_dashboard_running == 0)); then
  if ! command -v setsid >/dev/null 2>&1; then
    fail "setsid is required to keep the Managed Playwright Dashboard in the background."
  fi
  rm -f "$pwcli_dashboard_fifo" "$pwcli_dashboard_launcher_file"
  mkfifo "$pwcli_dashboard_fifo"
  setsid "${BASH:-bash}" "$0" \
    __pwcli-dashboard-daemon \
    "$pwcli_dashboard_fifo" \
    "$pwcli_dashboard_launcher_file" \
    "$pwcli_lock_fd" "$pwcli_dashboard_port" \
    >>"$pwcli_dashboard_log" 2>&1 &
  pwcli_dashboard_bootstrap_pid=$!
  pwcli_dashboard_launcher_pid=
  pwcli_dashboard_pid=

  pwcli_dashboard_deadline=$((SECONDS + ${PWCLI_DASHBOARD_TIMEOUT:-10}))
  while ((SECONDS <= pwcli_dashboard_deadline)); do
    if [[ -z "$pwcli_dashboard_launcher_pid" && -f "$pwcli_dashboard_launcher_file" ]]; then
      pwcli_dashboard_launcher_pid="$(cat "$pwcli_dashboard_launcher_file")"
    fi
    if [[ "$pwcli_dashboard_launcher_pid" =~ ^[0-9]+$ ]] && dashboard_port_ready; then
      pwcli_dashboard_pid="$(
        dashboard_listener_for_launcher "$pwcli_dashboard_launcher_pid" || true
      )"
      if [[ -n "$pwcli_dashboard_pid" ]]; then
        pwcli_dashboard_start_time="$(process_start_time "$pwcli_dashboard_pid")"
        printf '%s\n' "$pwcli_dashboard_pid" >"$pwcli_dashboard_pid_file"
        printf '%s\n' "$pwcli_dashboard_start_time" >"$pwcli_dashboard_start_time_file"
        printf '%s\n' "$pwcli_session" >"$pwcli_dashboard_session_file"
        rm -f "$pwcli_dashboard_launcher_file"
        pwcli_dashboard_running=1
        pwcli_started_dashboard=1
        break
      fi
    fi
    sleep 0.2
  done
  if ((pwcli_dashboard_running == 0)); then
    if [[ "$pwcli_dashboard_launcher_pid" =~ ^[0-9]+$ ]]; then
      terminate_dashboard_session "$pwcli_dashboard_launcher_pid"
    else
      kill "$pwcli_dashboard_bootstrap_pid" 2>/dev/null || true
    fi
    rm -f \
      "$pwcli_dashboard_pid_file" \
      "$pwcli_dashboard_start_time_file" \
      "$pwcli_dashboard_session_file" \
      "$pwcli_dashboard_launcher_file" \
      "$pwcli_dashboard_fifo"
    close_chrome_if_unused
    fail "Managed Playwright Dashboard did not start on http://127.0.0.1:$pwcli_dashboard_port/. Inspect $pwcli_dashboard_log and verify port $pwcli_dashboard_port is free."
  fi
fi

pwcli_display_status=0
"$pwcli_curl" \
  --fail \
  --silent \
  --show-error \
  --max-time 5 \
  --request PUT \
  "$pwcli_cdp_endpoint/json/new?http%3A%2F%2Flocalhost%3A${pwcli_dashboard_port}%2F" >/dev/null || pwcli_display_status=$?

release_lock
trap - EXIT
if ((pwcli_show_annotate)); then
  # shellcheck disable=SC2329 # Invoked by the EXIT trap.
  finish_annotation() {
    local annotation_status=$? cleanup_status=0
    trap - EXIT
    if [[ "${PWCLI_EXTERNAL_CDP:-0}" == "1" ]] && ((pwcli_started_dashboard)); then
      "${BASH:-bash}" "$0" -s="$pwcli_session" show --kill || cleanup_status=$?
      if ((annotation_status == 0)); then
        annotation_status=$cleanup_status
      fi
    fi
    exit "$annotation_status"
  }
  trap finish_annotation EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  pwcli_annotation_status=$pwcli_display_status
  if ((pwcli_annotation_status == 0)); then
    "$pwcli_upstream" "$@" --port="$pwcli_dashboard_port" || pwcli_annotation_status=$?
  fi
  exit "$pwcli_annotation_status"
else
  ((pwcli_display_status == 0)) || exit "$pwcli_display_status"
  printf 'Dashboard: http://127.0.0.1:%s/\n' "$pwcli_dashboard_port"
fi
