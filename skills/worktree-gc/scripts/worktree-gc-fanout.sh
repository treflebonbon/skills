#!/usr/bin/env bash
# ---
# topics: [worktree, gc, engine, cli, fan-out]
# source: human
# ---
# worktree-gc-fanout.sh
# Home-wide fan-out wrapper around worktree-gc.sh (ADR-0056). Explicit
# opt-in only: worktree-gc.sh's own single-repo default behavior and
# triggers are unchanged.
#
# Enumerates repos under --ghq-root and re-invokes the unmodified
# worktree-gc.sh engine once per repo, with two "trusted external roots"
# appended to --roots: --herdr-root/<repo-basename> and
# --orca-root/<repo-basename>. These are genuine git worktrees registered
# against the ghq repo, so the engine's own out-of-root/in-root
# classification already treats them as real removal candidates once they
# are named in --roots — no engine change needed.
#
# Also sweeps --herdr-root/** and --orca-root/** directly for *dangling*
# worktrees: a worktree whose parent repo (and thus its git worktree admin
# dir) has vanished entirely. worktree-gc.sh cannot see these on its own —
# it requires a live --repo to run against.
#
# Adds two safety features worktree-gc.sh itself intentionally does not
# have, both implemented here only (the engine stays untouched):
#   - a live-process guard: skip a candidate (or, for a repo call, the whole
#     repo) if some process still has it as cwd.
#   - a GLOBAL --max-removals cap across the whole run. worktree-gc.sh's own
#     --max-removals is per invocation (i.e. per repo); a single approval
#     covering many repos plus the dangling scan needs a run-wide cap too.
#
# Dry-run by default (mirrors worktree-gc.sh). --diagnose prints an
# aggregate, structured candidate report across every repo + the dangling
# scan. --apply requires readable Linux /proc cwd inspection; unsupported
# platforms retain dry-run and diagnose support.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="${WORKTREE_GC_ENGINE:-$SCRIPT_DIR/worktree-gc.sh}"

APPLY=false
DIAGNOSE=false
GHQ_ROOT="$HOME/ghq"
HERDR_ROOT="$HOME/.herdr/worktrees"
ORCA_ROOT="$HOME/orca/workspaces"
REPO_ROOTS=".claude/worktrees,.worktrees,tmp/implement-issue/worktrees"
AGE_DAYS=3
LOCKED_AGE_DAYS=""
MAX_REMOVALS=50 # global cap across the whole run, not per repo
MAX_REPORT=50
SELF_SESSION=""

while [ $# -gt 0 ]; do
  case "$1" in
  --apply) APPLY=true ;;
  --dry-run) APPLY=false ;;
  --diagnose) DIAGNOSE=true ;;
  --ghq-root)
    GHQ_ROOT="$2"
    shift
    ;;
  --herdr-root)
    HERDR_ROOT="$2"
    shift
    ;;
  --orca-root)
    ORCA_ROOT="$2"
    shift
    ;;
  --repo-roots)
    REPO_ROOTS="$2"
    shift
    ;;
  --age-days)
    AGE_DAYS="$2"
    shift
    ;;
  --locked-age-days)
    LOCKED_AGE_DAYS="$2"
    shift
    ;;
  --max-removals)
    MAX_REMOVALS="$2"
    shift
    ;;
  --max-report)
    MAX_REPORT="$2"
    shift
    ;;
  --self-session)
    SELF_SESSION="$2"
    shift
    ;;
  *)
    echo "unknown arg: $1" >&2
    exit 2
    ;;
  esac
  shift
done
[ -n "$LOCKED_AGE_DAYS" ] || LOCKED_AGE_DAYS="$AGE_DAYS"
[ -f "$ENGINE" ] || {
  echo "engine not found: $ENGINE" >&2
  exit 2
}

# Canonicalize the three scan roots up front (fall back to the literal value
# if resolution fails, e.g. the dir doesn't exist yet). `git worktree list`
# always reports canonical paths; comparing them against an unresolved root
# would fail-open on any symlink component the same way the original
# is_busy_dir bug did (PR #281 review: symlinked --herdr-root/--orca-root
# would let a live, dirty worktree be misclassified as an orphan and removed
# without the dirty/unique-commit/open-PR guards).
canonicalize_root() {
  local var_name="$1" current resolved
  current="${!var_name}"
  if resolved=$(readlink -f "$current" 2>/dev/null); then
    printf -v "$var_name" '%s' "$resolved"
  fi
}
canonicalize_root GHQ_ROOT
canonicalize_root HERDR_ROOT
canonicalize_root ORCA_ROOT

ENGINE_EXTRA_ARGS=()
if [ -n "$SELF_SESSION" ]; then
  ENGINE_EXTRA_ARGS+=(--self-session "$SELF_SESSION")
fi

# Effectively unlimited. Used for every internal --diagnose call this wrapper
# makes for its own decisions (the busy-process guard, building the aggregate
# report before applying our own --max-report display cap). worktree-gc.sh's
# --max-report exists purely to bound what it *prints*; letting it also
# silently truncate what THIS script sees would hide real remove-candidates
# from the busy guard and from the aggregate report once a repo has more than
# --max-report worktrees under scan — exactly the fd/inotify-exhaustion
# scenario this tool exists for (found in code review).
readonly ENGINE_REPORT_LIMIT=1000000

GHQ_REPOS=()
declare -A BASENAME_COUNT=()

# ---------------------------------------------------------------------------
# Pure helpers (unit-tested via extract_function in tests/worktree-gc-fanout.bats)
# ---------------------------------------------------------------------------

# Duplicated from worktree-gc.sh on purpose (ADR-0056: that engine stays
# unmodified, and sourcing the whole file would re-run its top-level CLI
# parsing/dispatch against this script's own argv).
is_older_than_days() {
  local path="$1" days="$2" now mtime
  now=$(date +%s)
  mtime=$(stat -c %Y "$path" 2>/dev/null) || mtime=$(stat -f %m "$path" 2>/dev/null) || return 1
  (((now - mtime) / 86400 >= days))
}

# Builds the --roots CSV for one ghq repo: its existing repo-local roots plus
# the two trusted external roots named after the repo's basename.
repo_roots_for() {
  local repo="$1" herdr_root="$2" orca_root="$3" default_roots="$4" base
  base=$(basename "$repo")
  printf '%s,%s/%s,%s/%s\n' "$default_roots" "$herdr_root" "$base" "$orca_root" "$base"
}

# cap - used, floored at 0.
remaining_budget() {
  local cap="$1" used="$2" remaining
  remaining=$((cap - used))
  if [ "$remaining" -lt 0 ]; then
    remaining=0
  fi
  printf '%s\n' "$remaining"
}

# Prints the gitdir target of $1/.git when it is a worktree pointer file.
# Fails (no output) if $1/.git is missing or is a real directory (a normal
# clone, not a worktree).
gitdir_target() {
  local dir="$1" line target
  local gitfile="$dir/.git"
  [ -f "$gitfile" ] || return 1
  line=$(head -n1 "$gitfile") || return 1
  case "$line" in
  "gitdir: "*) target="${line#gitdir: }" ;;
  *) return 1 ;;
  esac
  case "$target" in
  /*) ;;
  *) target="$dir/$target" ;;
  esac
  printf '%s\n' "$target"
}

# Success iff $1 is a git-worktree pointer whose gitdir target no longer
# exists (its parent repo, or the repo's own worktree admin dir, is gone).
is_dangling_worktree() {
  local dir="$1" target
  target=$(gitdir_target "$dir") || return 1
  if [ -e "$target" ]; then
    return 1
  fi
  return 0
}

# Strips the "summary ..." line and the TSV header line that worktree-gc.sh
# --diagnose prints ahead of its data rows, leaving just the data rows.
skip_summary_and_header() {
  local line
  while IFS= read -r line; do
    case "$line" in
    "summary "*) continue ;;
    $'decision\treason\tscope\tbranch\tpath') continue ;;
    esac
    printf '%s\n' "$line"
  done
}

# Refuse deletion when this runtime cannot inspect Linux process cwd links.
# A procfs that exposes /proc/self but hides other processes (hidepid, or no
# visible PID 1) is as blind as a missing one, so the current process alone is
# not proof. Limit: a procfs mounted inside a nested PID namespace still shows
# its own PID 1, so processes outside that namespace cannot be detected here.
# WORKTREE_GC_PROC_ROOT only exists so tests can supply a fixture.
process_inspection_available() {
  local root="${WORKTREE_GC_PROC_ROOT:-/proc}" mountinfo_status=0
  [ "$(uname -s)" = Linux ] &&
    [ -r "$root" ] && [ -x "$root" ] &&
    [ -r "$root/self/stat" ] &&
    readlink -f "$root/self/cwd" >/dev/null 2>&1 &&
    [ -d "$root/1" ] || return 1
  grep -Eq 'hidepid=(1|2|4|noaccess|invisible|ptraceable)' "$root/self/mountinfo" 2>/dev/null || mountinfo_status=$?
  [ "$mountinfo_status" -eq 1 ]
}

# Success iff $1 is busy or a surviving PID's cwd cannot be inspected.
is_busy_dir() {
  local dir pid_dir resolved
  process_inspection_available || return 0
  # Canonicalize $1 too: /proc/<pid>/cwd always resolves to a canonical path,
  # so comparing it against an unresolved $1 would fail-open (miss a busy
  # process) whenever $1's path has a symlink component. Fall back to the
  # literal argument if it can't be resolved (e.g. it no longer exists).
  dir=$(readlink -f "$1" 2>/dev/null) || dir="$1"
  for pid_dir in "${WORKTREE_GC_PROC_ROOT:-/proc}"/[0-9]*; do
    [ -d "$pid_dir" ] || continue
    if ! resolved=$(readlink "$pid_dir/cwd" 2>/dev/null); then
      [ ! -d "$pid_dir" ] || return 0
      continue
    fi
    case "$resolved" in
    "$dir" | "$dir"/*) return 0 ;;
    esac
  done
  return 1
}

# Prints one real (non-worktree) repo path per line under $1.
find_ghq_repos() {
  local root="$1" gitdir
  [ -d "$root" ] || return 0
  while IFS= read -r gitdir; do
    dirname "$gitdir"
  done < <(find "$root" -mindepth 1 -maxdepth 6 -type d -name .git 2>/dev/null)
}

# Prints leaf worktree dirs (two levels: <repo>/<name>) under $1.
find_worktree_dirs() {
  local root="$1"
  [ -d "$root" ] || return 0
  find "$root" -mindepth 2 -maxdepth 2 -type d ${2:+"$2"} 2>/dev/null
}

# Prints dangling worktree dirs (age-gated) under $1. Shared by cmd_diagnose
# and cmd_sweep so the two never drift apart on what counts as dangling.
dangling_candidates() {
  local root="$1" dir
  while IFS= read -r -d '' dir; do
    # Candidates travel newline-delimited; a newline in a name would split into
    # fragments (possibly relative paths) that rm -rf later resolves elsewhere.
    case "$dir" in
    *$'\n'*)
      echo "skipping name with newline: ${dir//$'\n'/?}" >&2
      continue
      ;;
    esac
    is_dangling_worktree "$dir" || continue
    is_older_than_days "$dir" "$AGE_DAYS" || continue
    printf '%s\n' "$dir"
  done < <(find_worktree_dirs "$root" -print0)
}

# Captures the missing owner reference and filesystem identity of one dangling
# candidate. Apply checks this again after process inspection so a replaced
# path or a worktree whose owner reappeared is preserved.
dangling_snapshot() {
  local dir="$1" target dir_state gitfile_state
  [ -d "$dir" ] && [ ! -L "$dir" ] || return 1
  target=$(gitdir_target "$dir") || return 1
  [ ! -e "$target" ] || return 1
  is_older_than_days "$dir" "$AGE_DAYS" || return 1
  dir_state=$(stat -c '%d:%i:%s:%Y:%Z' "$dir" 2>/dev/null) || return 1
  gitfile_state=$(stat -c '%d:%i:%s:%Y:%Z' "$dir/.git" 2>/dev/null) || return 1
  printf '%s\t%s\t%s\n' "$target" "$dir_state" "$gitfile_state"
}

# Removes $2 only if its parent physically sits under $1. cd -P pins the parent
# as the cwd, so a later symlink swap of an ancestor cannot redirect rm.
remove_dangling_dir() {
  local root="$1" dir="$2" expected_snapshot="${3:-}" real_root current_snapshot
  current_snapshot=$(dangling_snapshot "$dir") || return 1
  if [ -n "$expected_snapshot" ] && [ "$current_snapshot" != "$expected_snapshot" ]; then
    return 1
  fi
  real_root=$(cd -P -- "$root" 2>/dev/null && pwd -P) || return 1
  (
    cd -P -- "$(dirname -- "$dir")" 2>/dev/null || exit 1
    [[ "$PWD/" == "$real_root/"* ]] || exit 1
    current_snapshot=$(dangling_snapshot "$dir") || exit 1
    if [ -n "$expected_snapshot" ] && [ "$current_snapshot" != "$expected_snapshot" ]; then
      exit 1
    fi
    rm -rf -- "./$(basename -- "$dir")"
  )
}

# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

# Populates GHQ_REPOS and BASENAME_COUNT once. Must run after arg parsing
# (depends on $GHQ_ROOT) and before anything calls safe_roots_for.
load_ghq_repos() {
  local repo base
  mapfile -t GHQ_REPOS < <(find_ghq_repos "$GHQ_ROOT")
  BASENAME_COUNT=()
  for repo in "${GHQ_REPOS[@]}"; do
    base=$(basename "$repo")
    BASENAME_COUNT["$base"]=$((${BASENAME_COUNT["$base"]:-0} + 1))
  done
  warn_basename_collisions
}

warn_basename_collisions() {
  local base repo
  for base in "${!BASENAME_COUNT[@]}"; do
    if [ "${BASENAME_COUNT[$base]}" -gt 1 ]; then
      echo "basename collision, external roots disabled for '$base':" >&2
      for repo in "${GHQ_REPOS[@]}"; do
        if [ "$(basename "$repo")" = "$base" ]; then
          echo "  $repo" >&2
        fi
      done
    fi
  done
}

# True iff $1 is missing, or every entry directly under it is either
# registered to $2 (per `git worktree list`) or dangling (no live parent at
# all -- handled separately by dangling_candidates, safe to leave alone
# here). False means some OTHER, still-live repository owns an entry under
# $1: worktree-gc.sh's own orphan sweep (unmodified) would otherwise treat
# that foreign, live worktree as $2's orphan and remove it on age alone, no
# dirty/unique-commit/open-PR guard (PR #281 review: a Herdr/Orca worktree
# whose real parent repo lives outside --ghq-root, but happens to share a
# basename with a discovered ghq repo, was invisible to the basename-count
# check below since only *discovered* repos were ever counted).
external_root_owned_by_repo() {
  local dir="$1" repo="$2" registered entry
  [ -d "$dir" ] || return 0
  registered=$(git -C "$repo" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
  while IFS= read -r entry; do
    if printf '%s\n' "$registered" | grep -q -F -x "$entry"; then
      continue
    fi
    if is_dangling_worktree "$entry"; then
      continue
    fi
    return 1
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
  return 0
}

# --roots for one ghq repo. Falls back to repo-local roots only (no
# --herdr-root/--orca-root augmentation) when the repo's basename collides
# with another discovered repo, or when a herdr/orca directory named after
# this repo's basename actually contains a worktree owned by some OTHER,
# still-live repository: worktree-gc.sh's own orphan sweep (unmodified)
# treats anything under a root that isn't registered to the *current* --repo
# as an orphan and removes it on age alone (no dirty/unique-commit/open-PR
# guard). Two repos sharing a basename -- discovered under --ghq-root or
# not -- would otherwise let one repo's GC run delete the other's live
# worktrees (found in code review).
safe_roots_for() {
  local repo="$1" base herdr_dir orca_dir
  base=$(basename "$repo")
  if [ "${BASENAME_COUNT[$base]:-0}" -gt 1 ]; then
    printf '%s\n' "$REPO_ROOTS"
    return 0
  fi
  herdr_dir="$HERDR_ROOT/$base"
  orca_dir="$ORCA_ROOT/$base"
  if ! external_root_owned_by_repo "$herdr_dir" "$repo" ||
    ! external_root_owned_by_repo "$orca_dir" "$repo"; then
    echo "foreign worktree found under a same-named external root, disabling it for '$base' ($repo)" >&2
    printf '%s\n' "$REPO_ROOTS"
    return 0
  fi
  repo_roots_for "$repo" "$HERDR_ROOT" "$ORCA_ROOT" "$REPO_ROOTS"
}

engine_diagnose() {
  local repo="$1" roots="$2" report_limit="$3"
  bash "$ENGINE" --diagnose --repo "$repo" --roots "$roots" \
    --age-days "$AGE_DAYS" --locked-age-days "$LOCKED_AGE_DAYS" \
    --max-report "$report_limit" "${ENGINE_EXTRA_ARGS[@]}" |
    skip_summary_and_header
}

# Success iff any remove-candidate for $1/$2 currently has a live process
# sitting in it, OR the diagnose call itself failed (fail-closed: an engine
# we can't ask is treated as busy, matching worktree-gc.sh's own
# "uncertainty protects" convention for its other guards).
repo_has_busy_candidate() {
  local repo="$1" roots="$2" decision reason scope branch wt rows
  if ! rows=$(engine_diagnose "$repo" "$roots" "$ENGINE_REPORT_LIMIT"); then
    return 0
  fi
  while IFS=$'\t' read -r decision reason scope branch wt; do
    [ "$decision" = "remove-candidate" ] || continue
    if is_busy_dir "$wt"; then
      return 0
    fi
  done <<<"$rows"
  return 1
}

diagnose_ghq_fanout() {
  local repo roots rows decision reason scope branch wt
  for repo in "${GHQ_REPOS[@]}"; do
    roots=$(safe_roots_for "$repo")
    if ! rows=$(engine_diagnose "$repo" "$roots" "$ENGINE_REPORT_LIMIT"); then
      echo "engine diagnose failed, skipping from aggregate report: $repo" >&2
      continue
    fi
    while IFS=$'\t' read -r decision reason scope branch wt; do
      [ "$decision" = "remove-candidate" ] || continue
      printf 'repo\t%s\t%s\t%s\t%s\t%s\n' "$reason" "$scope" "$branch" "$wt" "$repo"
    done <<<"$rows"
  done
}

diagnose_dangling() {
  local root dir
  for root in "$HERDR_ROOT" "$ORCA_ROOT"; do
    while IFS= read -r dir; do
      printf 'dangling\tdangling-parent\tin-root\t-\t%s\t-\n' "$dir"
    done < <(dangling_candidates "$root")
  done
}

# Prints the full aggregate report (no truncation is possible upstream: every
# engine_diagnose call above already uses ENGINE_REPORT_LIMIT, not
# --max-report), then applies the user-facing --max-report cap to the
# assembled list. Always reports the true total on stderr so a capped report
# is never mistaken for the complete candidate set.
cmd_diagnose() {
  local rows=() row count=0
  while IFS= read -r row; do
    rows+=("$row")
  done < <(
    diagnose_ghq_fanout
    diagnose_dangling
  )
  printf 'source\treason\tscope\tbranch\tpath\trepo\n'
  for row in "${rows[@]}"; do
    if [ "$MAX_REPORT" -le 0 ] || [ "$count" -ge "$MAX_REPORT" ]; then
      break
    fi
    printf '%s\n' "$row"
    count=$((count + 1))
  done
  echo "total_candidates=${#rows[@]} shown=$count" >&2
}

# Shared by the default dry-run and --apply: only whether $APPLY is true (and
# thus whether the engine is told --apply, dangling dirs are actually rm'd,
# and the busy-process guard runs) differs between the two.
cmd_sweep() {
  local global_used=0 repo roots remaining out removed root dir snapshot current_snapshot
  local engine_flags=()
  if [ "$APPLY" = true ]; then
    if ! process_inspection_available; then
      echo "process inspection unavailable; refusing --apply" >&2
      return 1
    fi
    engine_flags=(--apply)
  fi

  for repo in "${GHQ_REPOS[@]}"; do
    remaining=$(remaining_budget "$MAX_REMOVALS" "$global_used")
    if [ "$remaining" -le 0 ]; then
      echo "global max-removals reached ($MAX_REMOVALS), skipping: $repo" >&2
      continue
    fi
    roots=$(safe_roots_for "$repo")
    if [ "$APPLY" = true ] && repo_has_busy_candidate "$repo" "$roots"; then
      echo "protected (busy or uninspectable process in a candidate): $repo" >&2
      continue
    fi
    if ! out=$(bash "$ENGINE" "${engine_flags[@]}" --repo "$repo" --roots "$roots" \
      --age-days "$AGE_DAYS" --locked-age-days "$LOCKED_AGE_DAYS" \
      --max-removals "$remaining" "${ENGINE_EXTRA_ARGS[@]}" 2>&1); then
      echo "engine failed for repo, skipping: $repo" >&2
      printf '%s\n' "$out" >&2
      continue
    fi
    printf '%s\n' "$out"
    removed=$(printf '%s\n' "$out" | sed -n 's/^done removed=\([0-9]*\)$/\1/p')
    global_used=$((global_used + ${removed:-0}))
  done

  for root in "$HERDR_ROOT" "$ORCA_ROOT"; do
    while IFS= read -r dir; do
      remaining=$(remaining_budget "$MAX_REMOVALS" "$global_used")
      if [ "$remaining" -le 0 ]; then
        echo "global max-removals reached ($MAX_REMOVALS), skipping: $dir" >&2
        continue
      fi
      if [ "$APPLY" != true ]; then
        echo "would remove dangling: $dir"
        continue
      fi
      snapshot=$(dangling_snapshot "$dir") || {
        echo "changed during apply; preserving: $dir" >&2
        continue
      }
      if is_busy_dir "$dir"; then
        echo "protected (busy or uninspectable process): $dir" >&2
        continue
      fi
      current_snapshot=$(dangling_snapshot "$dir") || {
        echo "changed during apply; preserving: $dir" >&2
        continue
      }
      if [ "$current_snapshot" != "$snapshot" ]; then
        echo "changed during apply; preserving: $dir" >&2
        continue
      fi
      echo "removing dangling: $dir"
      remove_dangling_dir "$root" "$dir" "$snapshot" || {
        echo "refused to remove (changed, outside root or unreachable): $dir" >&2
        continue
      }
      global_used=$((global_used + 1))
    done < <(dangling_candidates "$root")
  done

  echo "fanout done removed=$global_used"
}

load_ghq_repos

if [ "$DIAGNOSE" = true ]; then
  cmd_diagnose
  exit 0
fi

cmd_sweep
