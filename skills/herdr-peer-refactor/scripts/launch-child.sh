#!/usr/bin/env bash
# launch-child.sh: verify the active Claude auto-peer policy, then start one child
# in a dedicated herdr workspace and confirm its settings path and cwd.
#
# usage: launch-child.sh <run-dir> <parent-pane> <worktree> <child-id> <limit> <receipt> <settings>
#
# The active runtime must pass auto-peer-preflight before any child workspace is
# created. The child runs `claude --permission-mode auto --settings <settings>`
# with the dedicated Claude home. A failed or missing preflight never falls back
# to a normal session.
#
# The launch is checked from `herdr pane process-info`: a foreground `claude`
# process whose argv has `--settings <settings>` and whose cwd is <worktree>.
# This process check supplements the preflight's actual permission-denial
# canaries; argv alone is not proof that the runtime loaded its policy.
# A child that fails the check is NOT started: no request is sent to it, it is
# not recorded, and its pane is left for the report (no pane is closed here).
#
# State in <run-dir>:
#   children.tsv   <child-id> TAB <pane>, one line per confirmed child
#   failed.tsv     same, for a child that failed the check: its pane is kept and
#                  may still run, so it counts toward the limit
#   stopped        when this file exists the parent has stopped: no new child
#
# <limit> is the Run Scope total of live agents: 1 parent + N children + (N+1)
# peers (the same formula as plan-parallel.sh: N = (limit-2)/2). A new child
# must keep that total within <limit>.
#
# The parent starts children one at a time from a single session, so the two
# state files are read and appended without a lock.
#
# exit: 0 started (pane id printed) | 13 over the limit (no pane created) |
# 14 the parent stopped (no pane created) | 20 settings path not on the child's
# process | 21 child runs outside its worktree | 2 usage | 1 preflight/herdr/parse
# failure. 2 also covers an unwritable <run-dir>. These codes are this script's own; peer-request.sh uses 13 and 14
# for other meanings.
set -euo pipefail

{ [ $# -eq 7 ]; } || {
  echo "usage: $0 <run-dir> <parent-pane> <worktree> <child-id> <limit> <receipt> <settings>" >&2
  exit 2
}
run_dir=$1 wt=$3 id=$4 limit=$5 # $2 (parent pane) is kept for callers; each child gets its own workspace
receipt=$6 settings=$7
timeout_s=${PARALLEL_LAUNCH_TIMEOUT_S:-60}
case $limit$timeout_s in '' | *[!0-9]*)
  echo "limit and PARALLEL_LAUNCH_TIMEOUT_S must be numbers" >&2
  exit 2
  ;;
esac

skill_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
preflight="$skill_dir/scripts/auto-peer-preflight.py"
claude_home="$(dirname -- "$settings")"
CLAUDE_CONFIG_DIR=$claude_home python3 -B "$preflight" verify --runtime claude --settings "$settings" --receipt "$receipt" || {
  echo "dedicated Claude auto-peer preflight failed; no child was started" >&2
  exit 1
}

# Both state files are appended after the child exists: an unwritable run-dir
# would leave a live child unrecorded and uncounted, so check before any side effect.
{ mkdir -p "$run_dir" && [ -w "$run_dir" ]; } || {
  echo "run-dir is not writable: $run_dir" >&2
  exit 2
}
for f in children.tsv failed.tsv; do
  [ ! -e "$run_dir/$f" ] || [ -w "$run_dir/$f" ] || {
    echo "state file is not writable: $run_dir/$f" >&2
    exit 2
  }
done

[ ! -e "$run_dir/stopped" ] || {
  echo "the parent has stopped: no new child" >&2
  exit 14
}

# Every child that was started counts, including one that failed the check.
count=0
for f in children.tsv failed.tsv; do
  [ ! -f "$run_dir/$f" ] || count=$((count + $(wc -l <"$run_dir/$f")))
done
# After this child: children = count+1, peers = children+1.
need=$((1 + (count + 1) + (count + 2)))
[ "$need" -le "$limit" ] || {
  echo "starting child $id needs $need live agents, the Run Scope limit is $limit" >&2
  exit 13
}

# A dedicated workspace per child keeps its pane wide; the pane is its root pane.
# Never `pane move` a running pane: its ID changes.
create_out=$(herdr workspace create --cwd "$wt" --label "$id" --no-focus)
pane=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])' <<<"$create_out")

printf -v settings_arg '%q' "$settings"
printf -v home_arg '%q' "$claude_home"
herdr pane run "$pane" "CLAUDE_CONFIG_DIR=$home_arg claude --permission-mode auto --settings $settings_arg" >/dev/null

# The checker is passed with -c so that stdin stays free for the JSON snapshot.
check_py=$(
  cat <<'PY'
import json, os, sys

settings, wt = sys.argv[1], sys.argv[2]
try:
    procs = json.load(sys.stdin)["result"]["process_info"]["foreground_processes"]
except Exception:
    print("nofrag")
    sys.exit(0)
state = "nofrag"
for p in procs:
    argv = p.get("argv") or []
    if not argv or os.path.basename(argv[0]) != "claude":
        continue
    carries = any(argv[i] == "--settings" and argv[i + 1] == settings for i in range(len(argv) - 1))
    if carries or "--settings=" + settings in argv:
        state = "ok" if os.path.realpath(p.get("cwd", "")) == os.path.realpath(wt) else "nocwd"
print(state)
PY
)
# prints ok | nofrag | nocwd for one process-info snapshot
check() { python3 -c "$check_py" "$settings" "$wt"; }

deadline=$((SECONDS + timeout_s))
while :; do
  state=$(check < <(herdr pane process-info --pane "$pane" || true))
  case $state in
  ok)
    printf '%s\t%s\n' "$id" "$pane" >>"$run_dir/children.tsv"
    echo "$pane"
    exit 0
    ;;
  nocwd)
    printf '%s\t%s\n' "$id" "$pane" >>"$run_dir/failed.tsv"
    echo "child $id (pane $pane) runs outside $wt: not started, pane left for the report" >&2
    exit 21
    ;;
  esac
  [ "$SECONDS" -lt "$deadline" ] || break
  sleep 1
done
printf '%s\t%s\n' "$id" "$pane" >>"$run_dir/failed.tsv"
echo "child $id (pane $pane): the dedicated settings path is not on its process: not started, send no request, pane left for the report" >&2
exit 20
