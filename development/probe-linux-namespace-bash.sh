#!/usr/bin/env bash
# pipeを複製し、観測用Pythonをunshareの祖先に入れない。
set -euo pipefail

capture_open_error_pipe() {
  local pipe_fd=${1##*/}
  exec {capture_err}>&"$pipe_fd"
}

capture_probe() {
  local executable=$1 prefix=$2 timeout=$3 limit=$4 expected=$5
  shift 5
  if [[ -e "$prefix.json" || -e "$prefix-streams.json" ]]; then
    return 2
  fi
  local capture_err capture_donor capture_observer capture_cr capture_cw
  local capture_out capture_gate capture_ready capture_reply
  local capture_probe_pid=0 capture_wait=255 capture_status=2 capture_setup=0
  capture_open_error_pipe >(exec python3 -I "$capture_helper" donor)
  capture_donor=$!
  coproc CAPTURE {
    exec {capture_err}>&-
    exec python3 -I "$capture_helper" observe "$$" "$capture_donor" "$capture_err" \
      "$prefix-streams.json" "$timeout" "$limit" "$executable" "$expected" "$@"
  }
  capture_observer=$!
  capture_cr=${CAPTURE[0]:-}
  capture_cw=${CAPTURE[1]:-}
  if [[ -n "$capture_cr" && -n "$capture_cw" ]] && IFS= read -r -t 5 capture_ready <&"$capture_cr" && [[ "$capture_ready" == READY ]]; then
    printf 'RELEASE\n' >&"$capture_err" || capture_setup=2
    wait "$capture_donor" || capture_setup=2
    if [[ $capture_setup == 0 ]]; then
      exec {capture_out}>&"$capture_cw"
      exec {capture_gate}<&"$capture_cr"
      (
        IFS= read -r -t 5 capture_reply <&"$capture_gate" || exit 97
        [[ "$capture_reply" == GO ]] || exit 97
        printf 'ACK\n' >&"$capture_out" || exit 97
        exec 1>&"$capture_out" 2>&"$capture_err"
        exec {capture_out}>&- {capture_err}>&- {capture_gate}<&-
        cd / || exit 97
        exec -c -- "$executable" "$@" <&-
      ) &
      capture_probe_pid=$!
      printf 'START %s\n' "$capture_probe_pid" >&"$capture_out" || capture_setup=2
      exec {capture_out}>&- {capture_gate}<&-
    fi
  fi
  exec {capture_err}>&-
  [[ -z "$capture_cr" ]] || exec {capture_cr}<&-
  [[ -z "$capture_cw" ]] || exec {capture_cw}>&-
  if [[ $capture_probe_pid != 0 ]]; then
    capture_wait=0
    wait "$capture_probe_pid" 2>/dev/null || capture_wait=$?
  else
    wait "$capture_donor" 2>/dev/null || true
  fi
  capture_status=0
  wait "$capture_observer" 2>/dev/null || capture_status=$?
  python3 -I "$capture_helper" merge "$prefix" "$capture_wait" "$capture_status" "$$" \
    "$executable" "$expected" "$@"
}

compare_bash() {
  if [[ $# != 2 ]]; then
    printf '%s\n' 'SOURCE OUTPUTが必要です' >&2
    return 2
  fi
  local source_root output prepare_status=0 perl_status=-1 gate_status=-1 bash_status=-1 final_status=0
  local executable_hash case_name repetition prefix capture_status
  local -a case_argv case_names=(minimal control)
  if [[ ${PROOF_MODE:-} == probe-uid ]]; then
    case_names=(minimal uid-only control)
  fi
  source_root="$(CDPATH='' cd -- "$1" && pwd -P)" || return 2
  case "$2" in
  /*) output=$2 ;;
  *) output="$PWD/$2" ;;
  esac
  cd -- "$source_root" || return 2
  mkdir -m 700 -- "$output" || return 2
  python3 -I "$capture_helper" prepare "$source_root" "$output" "$BASH_VERSION" || prepare_status=$?
  if [[ $prepare_status == 46 ]]; then
    perl_status=0
    /usr/bin/perl "$capture_dir/probe-linux-namespace-parent.pl" bash /usr/bin/unshare "$output" || perl_status=$?
    gate_status=0
    python3 -I "$capture_helper" baseline-check "$source_root" "$output" "$BASH_VERSION" "$perl_status" || gate_status=$?
    if [[ $gate_status == 47 ]]; then
      bash_status=0
      python3 -I "$capture_helper" start "$source_root" "$output" "$BASH_VERSION" || bash_status=$?
      if [[ $bash_status == 0 ]]; then
        executable_hash="$(python3 -I "$capture_helper" settings "$source_root" "$output" "$BASH_VERSION")" || bash_status=$?
        if [[ $bash_status == 0 ]]; then
          for case_name in "${case_names[@]}"; do
            case_argv=(-- /usr/bin/true)
            if [[ $case_name == minimal ]]; then
              case_argv=(--map-current-user -- /usr/bin/true)
            elif [[ $case_name == uid-only ]]; then
              case_argv=("--map-user=$EUID" -- /usr/bin/true)
            elif [[ ${PROOF_MODE:-} == probe-userns || ${PROOF_MODE:-} == probe-uid ]]; then
              case_argv=(--user -- /usr/bin/true)
            fi
            for repetition in 1 2 3; do
              prefix="$output/bash-$case_name-$repetition"
              capture_status=0
              capture_probe /usr/bin/unshare "$prefix" 5 33554432 "$executable_hash" "${case_argv[@]}" || capture_status=$?
              if [[ $capture_status != 0 ]]; then
                bash_status=$capture_status
                break 2
              fi
            done
          done
        fi
      fi
    fi
  fi
  python3 -I "$capture_helper" finalize "$source_root" "$output" "$BASH_VERSION" \
    "$prepare_status" "$perl_status" "$gate_status" "$bash_status" || final_status=$?
  case "$final_status" in
  44) return 0 ;;
  43) return 1 ;;
  *) return 2 ;;
  esac
}

capture_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || exit 2
capture_helper="$capture_dir/probe-linux-namespace-bash.py"
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi
if [[ "${1:-}" == capture && $# -ge 6 ]]; then
  shift
  capture_probe "$@"
else
  compare_bash "$@"
fi
