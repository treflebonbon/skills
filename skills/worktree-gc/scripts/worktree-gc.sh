#!/usr/bin/env bash
# ---
# topics: [worktree, gc, engine, cli]
# source: human
# ---
# worktree-gc.sh
# repo-local + cache worktree GC engine and CLI.
# Dry-run by default. --apply performs real removal.
# Manual repo-local engine, also used by the opt-in fan-out wrapper.
set -euo pipefail

# 検査と削除の対象を、呼出元の Git 設定ではなく --repo に固定する。
for git_variable in "${!GIT_@}"; do
  unset "$git_variable"
done

APPLY=false
DIAGNOSE=false
REPO=""
ROOTS=""
AGE_DAYS=3
LOCKED_AGE_DAYS="" # empty -> falls back to AGE_DAYS
DIRTY_AGE_DAYS=""  # empty -> feature off, preserves current dirty-guard behavior
MAX_REMOVALS=50
MAX_REPORT=50
SELF_SESSION=""

while [ $# -gt 0 ]; do
  case "$1" in
  --apply) APPLY=true ;;
  --dry-run) APPLY=false ;;
  --diagnose) DIAGNOSE=true ;;
  --repo)
    REPO="$2"
    shift
    ;;
  --roots)
    ROOTS="$2"
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
  --dirty-age-days)
    DIRTY_AGE_DAYS="$2"
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
[ -n "$REPO" ] || {
  echo "--repo required" >&2
  exit 2
}

REMOVED=0
remove_worktree() {
  local wt="$1"
  if [ "$APPLY" != true ]; then
    echo "would remove: $wt"
    return 0
  fi
  if [ "$REMOVED" -ge "$MAX_REMOVALS" ]; then
    echo "max-removals reached ($MAX_REMOVALS), skipping: $wt"
    return 0
  fi
  echo "removing: $wt"
  # `git worktree remove --force` (single --force) refuses a locked worktree,
  # so unlock first on failure, then fall back to a raw rm as a last resort.
  if ! git -C "$REPO" worktree remove --force "$wt" 2>/dev/null; then
    git -C "$REPO" worktree unlock "$wt" 2>/dev/null || true
    git -C "$REPO" worktree remove --force "$wt" 2>/dev/null || rm -rf -- "$wt"
  fi
  REMOVED=$((REMOVED + 1))
}

# Remove an orphan dir (not a registered git worktree). Honors dry-run,
# MAX_REMOVALS, and a prefix safety guard against the current sweep root.
remove_orphan() {
  local dir="$1" parent="$2"
  # Prefix safety guard: never rm anything that is not strictly under $parent.
  [[ "$dir" == "$parent/"* && "$dir" != "$parent/" ]] || {
    echo "prefix guard rejected: $dir" >&2
    return 0
  }
  if [ "$APPLY" != true ]; then
    echo "would remove: $dir"
    return 0
  fi
  if [ "$REMOVED" -ge "$MAX_REMOVALS" ]; then
    echo "max-removals reached ($MAX_REMOVALS), skipping: $dir"
    return 0
  fi
  echo "removing: $dir"
  rm -rf -- "$dir"
  REMOVED=$((REMOVED + 1))
}

is_older_than_days() {
  local path="$1" days="$2" now mtime
  now=$(date +%s)
  # GNU stat (Linux) は `-c %Y`、BSD/macOS stat は `-f %m`。
  mtime=$(stat -c %Y "$path" 2>/dev/null) || mtime=$(stat -f %m "$path" 2>/dev/null) || return 1
  (((now - mtime) / 86400 >= days))
}
is_clean_worktree() {
  local wt="$1" status
  # Porcelain-based: clean iff there is NO output (no modified, staged, OR
  # untracked entries). Safe-by-default: if git fails, treat as dirty/protected.
  status=$(git -C "$wt" status --porcelain 2>/dev/null) || return 1
  [ -z "$status" ]
}
has_unique_commit() {
  local branch="$1" exclusions="" refs ref head
  refs=$(git -C "$REPO" for-each-ref --format='%(refname)' \
    refs/heads/ refs/tags/ refs/remotes/ 2>/dev/null) || {
    printf 'worktree-gc: 参照一覧を検査できないため停止します: %s\n' "$branch" >&2
    exit 1
  }
  while IFS= read -r ref; do
    [ "$ref" = "$branch" ] || exclusions+="$ref"$'\n'
  done <<<"$refs"
  # shellcheck disable=SC2086
  head=$(git -C "$REPO" rev-list --max-count=1 "$branch" --not $exclusions 2>/dev/null) || {
    printf 'worktree-gc: コミットを検査できないため停止します: %s\n' "$branch" >&2
    exit 1
  }
  [ -n "$head" ]
}

# Real merged-PR check via gh, used to override the unique-commit guard for
# squash-merged branches (whose original commits never land on main, so they
# look "unique" forever). Safe-by-default: any uncertainty -> return 1 (treat
# as not-merged -> keep the unique-commit protection).
#
# `gh pr list --head <branch>` matches by branch NAME only, so a merged PR is
# reported even if the branch was later reused or advanced with new, unmerged
# commits. To avoid deleting such still-live work, we require the branch tip to
# equal one of the merged PRs' head SHAs (headRefOid): only a tip that sits
# exactly at a merged state is safe to reclaim.
is_merged_via_gh() {
  local branch="${1#refs/heads/}" runner=() tip merged_shas
  # kill-switch: default 1. Set 0 to skip the merged check (legacy behavior).
  [ "${WORKTREE_GC_PRUNE_MERGED:-1}" = "1" ] || return 1
  command -v gh >/dev/null 2>&1 || return 1
  tip=$(git -C "$REPO" rev-parse --verify "refs/heads/$branch" 2>/dev/null) || return 1
  command -v timeout >/dev/null 2>&1 && runner=(timeout 5)
  merged_shas=$(cd "$REPO" && ${runner[@]+"${runner[@]}"} gh pr list --head "$branch" \
    --state merged --json headRefOid --jq '.[].headRefOid' 2>/dev/null) || return 1
  [ -n "$merged_shas" ] || return 1
  # Reclaim only when the current branch tip matches a merged PR head SHA.
  printf '%s\n' "$merged_shas" | grep -qx "$tip"
}

# Squash-to-epic override: /implement-issue never opens a GitHub PR for a
# task/<N>-<slug> branch — it squash-merges locally into an epic/plan branch,
# so is_merged_via_gh (which looks for a merged PR headed at this exact
# branch) never matches and the unique-commit guard protects it forever, even
# after the epic reaches main. Instead, treat the branch's issue as the
# source of truth: CLOSED + labeled merged-to-epic means the squash already
# landed. Shares the is_merged_via_gh kill-switch (same feature family).
# Safe-by-default: any uncertainty -> return 1 (protect).
is_task_merged_to_epic() {
  local branch="${1#refs/heads/}" runner=() issue_num result
  [ "${WORKTREE_GC_PRUNE_MERGED:-1}" = "1" ] || return 1
  [[ "$branch" =~ ^task/([0-9]+)- ]] || return 1
  issue_num="${BASH_REMATCH[1]}"
  command -v gh >/dev/null 2>&1 || return 1
  command -v timeout >/dev/null 2>&1 && runner=(timeout 5)
  result=$(cd "$REPO" && ${runner[@]+"${runner[@]}"} gh issue view "$issue_num" \
    --json state,labels \
    --jq 'if .state == "CLOSED" and (.labels | map(.name) | index("merged-to-epic")) then "1" else "" end' \
    2>/dev/null) || return 1
  [ -n "$result" ]
}

# Open-PR guard: a branch whose PR is still open is under active review, so its
# worktree must never be reclaimed even when every other guard passes (a
# pushed, clean branch has no unique commits and would otherwise be removed
# after AGE_DAYS — issue #880). Fail-safe: gh absence / timeout / failure
# protects the worktree; removal proceeds only when gh succeeds AND reports no
# open PR. Kill-switch: WORKTREE_GC_PROTECT_OPEN_PR=0 restores legacy
# behavior (return 1 = no protection).
has_open_pr() {
  local branch="${1#refs/heads/}" runner=() open_prs
  [ "${WORKTREE_GC_PROTECT_OPEN_PR:-1}" = "1" ] || return 1
  command -v gh >/dev/null 2>&1 || return 0
  command -v timeout >/dev/null 2>&1 && runner=(timeout 5)
  open_prs=$(cd "$REPO" && ${runner[@]+"${runner[@]}"} gh pr list --head "$branch" \
    --state open --json number --jq '.[].number' 2>/dev/null) || return 0
  [ -n "$open_prs" ]
}

# Porcelain-driven sweep: apply age/dirty/unique-commit/self-session guards.
# Then sweep orphan dirs under the root that are not registered worktrees.
sweep_root() {
  local root="$1" parent
  case "$root" in
  /*) parent="$root" ;;
  *) parent="$REPO/$root" ;;
  esac
  [ -d "$parent" ] || return 0
  # A root that is (or resolves through) a symlink out of the repo must not be
  # swept: the textual prefix guard in remove_orphan would not notice.
  if [[ "$parent" == "$REPO/"* ]] &&
    [[ "$(cd "$parent" && pwd -P)/" != "$(cd "$REPO" && pwd -P)/"* ]]; then
    echo "root resolves outside repo, skipping: $parent" >&2
    return 0
  fi
  local line path="" branch="" is_locked=0 is_detached=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
    "worktree "*) path="${line#worktree }" ;;
    "branch "*) branch="${line#branch }" ;;
    "detached") is_detached=1 ;;
    "locked" | "locked "*) is_locked=1 ;;
    "")
      sweep_record "$parent" "$path" "$branch" "$is_locked" "$is_detached"
      path=""
      branch=""
      is_locked=0
      is_detached=0
      ;;
    esac
  done < <(git -C "$REPO" worktree list --porcelain 2>/dev/null)
  # Final record (porcelain output ends with a blank line, but be safe).
  if [ -n "$path" ]; then
    sweep_record "$parent" "$path" "$branch" "$is_locked" "$is_detached"
  fi
  sweep_orphans "$parent"
}

# Remove dirs directly under $parent that are NOT registered git worktrees and
# are older than AGE_DAYS. Registered worktrees are handled by sweep_record.
sweep_orphans() {
  local parent="$1" dir registered
  registered=$(git -C "$REPO" worktree list --porcelain 2>/dev/null |
    sed -n 's/^worktree //p')
  for dir in "$parent"/*/; do
    [ -d "$dir" ] || continue
    dir="${dir%/}"
    # Names with a newline cannot survive the line-based diagnostics the
    # fanout wrapper parses; keep them rather than risk a truncated path.
    [[ "$dir" != *$'\n'* ]] || continue
    # Skip registered worktrees (handled by porcelain sweep).
    if printf '%s\n' "$registered" | grep -q -F -x "$dir"; then
      continue
    fi
    # Age guard: keep young orphans.
    is_older_than_days "$dir" "$AGE_DAYS" || continue
    remove_orphan "$dir" "$parent"
  done
}

sweep_record() {
  local parent="$1" path="$2" branch="$3" is_locked="$4" is_detached="${5:-0}"
  # Only consider worktrees under this root.
  case "$path/" in
  "$parent"/*) ;;
  *) return 0 ;;
  esac
  # Self-session guard: never remove the current session's own worktree.
  # The isolate hook may name the branch session/<full> (Case B fallback) or
  # session/<short> (SESSION_ID:0:8, the common case), while the hook passes the
  # full session id here. Protect both forms so an old, clean current-session
  # worktree is never GC'd right after isolation told the user to use it.
  if [ -n "$SELF_SESSION" ] && {
    [ "$branch" = "refs/heads/session/$SELF_SESSION" ] ||
      [ "$branch" = "refs/heads/session/${SELF_SESSION:0:8}" ]
  }; then
    return 0
  fi
  # Dirty-age warning: checked independent of --age-days/--locked-age-days so
  # it fires even on a worktree that hasn't reached the normal sweep age yet
  # (age has no bearing on whether stale uncommitted work is worth flagging).
  # Side-effect only (never protects/removes by itself) — the unchanged dirty
  # guard below still governs that.
  if [ -n "$DIRTY_AGE_DAYS" ] && ! is_clean_worktree "$path" && is_older_than_days "$path" "$DIRTY_AGE_DAYS"; then
    echo "warning: dirty worktree exceeds --dirty-age-days ($DIRTY_AGE_DAYS): $path"
  fi
  # Age guard. Locked worktrees are gated on LOCKED_AGE_DAYS: a young locked
  # worktree is a live agent (keep); an old locked worktree is a stale lock.
  if [ "$is_locked" = "1" ]; then
    is_older_than_days "$path" "$LOCKED_AGE_DAYS" || return 0
  else
    is_older_than_days "$path" "$AGE_DAYS" || return 0
  fi
  # Dirty guard. Never auto-remove a dirty worktree (warning already surfaced
  # above, independent of this guard's position).
  is_clean_worktree "$path" || return 0
  # Detached HEAD guard: a detached worktree has no branch ref, so the
  # unique-commit guard below cannot evaluate it. Protect it unconditionally
  # to avoid dropping a detached worktree that carries unique commits.
  if [ "$is_detached" = "1" ]; then
    return 0
  fi
  # Unique-commit guard, with a squash-merge override: a branch that looks
  # "unique" but whose PR is actually merged (squash-merge), or whose
  # task/<N>-<slug> issue was already squashed into an epic, is reclaimed.
  if [ -n "$branch" ] && has_unique_commit "$branch"; then
    if ! is_merged_via_gh "$branch" && ! is_task_merged_to_epic "$branch"; then
      return 0
    fi
  fi
  # Open-PR guard (fail-safe): never reclaim a worktree whose branch has an
  # open PR; gh uncertainty also protects.
  if [ -n "$branch" ] && has_open_pr "$branch"; then
    return 0
  fi
  remove_worktree "$path"
}

IFS=',' read -r -a _roots <<<"$ROOTS"
root_parent() {
  local root="$1"
  case "$root" in
  /*) printf '%s\n' "$root" ;;
  *) printf '%s\n' "$REPO/$root" ;;
  esac
}

diagnose_scope() {
  local wt="$1" root parent
  for root in "${_roots[@]}"; do
    parent=$(root_parent "$root")
    case "$wt/" in
    "$parent"/*)
      printf 'in-root\n'
      return 0
      ;;
    esac
  done
  printf 'out-of-root\n'
}

DIAG_TOTAL=0
DIAG_IN_ROOT=0
DIAG_OUT_OF_ROOT=0
DIAG_CANDIDATES=0
DIAG_KEEP_MAIN=0
DIAG_KEEP_SELF_SESSION=0
DIAG_KEEP_YOUNG=0
DIAG_KEEP_DIRTY=0
DIAG_KEEP_DIRTY_STALE=0
DIAG_KEEP_DETACHED=0
DIAG_KEEP_UNIQUE=0
DIAG_KEEP_OPEN_PR=0
DIAG_KEEP_OTHER=0
DIAG_ROWS=()

diagnose_add_row() {
  local decision="$1" reason="$2" scope="$3" branch_name="$4" wt="$5"
  if [ "$MAX_REPORT" -gt 0 ] && [ "${#DIAG_ROWS[@]}" -lt "$MAX_REPORT" ]; then
    DIAG_ROWS+=("$decision"$'\t'"$reason"$'\t'"$scope"$'\t'"$branch_name"$'\t'"$wt")
  fi
}

diagnose_record() {
  local wt="$1" branch="$2" is_locked="$3" is_detached="${4:-0}" scope decision reason branch_name
  # Keep this guard order in sync with sweep_record: --diagnose is the approval
  # preview for --apply, so a new removal guard must be reflected here too.
  [ -n "$wt" ] || return 0
  DIAG_TOTAL=$((DIAG_TOTAL + 1))
  scope=$(diagnose_scope "$wt")
  if [ "$wt" = "$REPO" ]; then
    :
  elif [ "$scope" = "in-root" ]; then
    DIAG_IN_ROOT=$((DIAG_IN_ROOT + 1))
  else
    DIAG_OUT_OF_ROOT=$((DIAG_OUT_OF_ROOT + 1))
  fi

  decision="keep"
  reason="clean-safe"
  if [ "$wt" = "$REPO" ]; then
    reason="main"
    DIAG_KEEP_MAIN=$((DIAG_KEEP_MAIN + 1))
  elif [ "$scope" = "out-of-root" ]; then
    reason="out-of-root"
  elif [ -n "$SELF_SESSION" ] && {
    [ "$branch" = "refs/heads/session/$SELF_SESSION" ] ||
      [ "$branch" = "refs/heads/session/${SELF_SESSION:0:8}" ]
  }; then
    reason="self-session"
    DIAG_KEEP_SELF_SESSION=$((DIAG_KEEP_SELF_SESSION + 1))
  elif [ -n "$DIRTY_AGE_DAYS" ] && ! is_clean_worktree "$wt" && is_older_than_days "$wt" "$DIRTY_AGE_DAYS"; then
    # Checked ahead of the young guards below: a --dirty-age-days breach is
    # independent of --age-days/--locked-age-days, so it must not be masked
    # by "young" just because the worktree hasn't reached the normal sweep
    # age yet.
    reason="dirty-stale"
    DIAG_KEEP_DIRTY_STALE=$((DIAG_KEEP_DIRTY_STALE + 1))
  elif [ "$is_locked" = "1" ] && ! is_older_than_days "$wt" "$LOCKED_AGE_DAYS"; then
    reason="young"
    DIAG_KEEP_YOUNG=$((DIAG_KEEP_YOUNG + 1))
  elif [ "$is_locked" != "1" ] && ! is_older_than_days "$wt" "$AGE_DAYS"; then
    reason="young"
    DIAG_KEEP_YOUNG=$((DIAG_KEEP_YOUNG + 1))
  elif ! is_clean_worktree "$wt"; then
    reason="dirty"
    DIAG_KEEP_DIRTY=$((DIAG_KEEP_DIRTY + 1))
  elif [ "$is_detached" = "1" ]; then
    reason="detached"
    DIAG_KEEP_DETACHED=$((DIAG_KEEP_DETACHED + 1))
  elif [ -n "$branch" ] && has_unique_commit "$branch" && ! is_merged_via_gh "$branch" &&
    ! is_task_merged_to_epic "$branch"; then
    reason="unique-commit"
    DIAG_KEEP_UNIQUE=$((DIAG_KEEP_UNIQUE + 1))
  elif [ -n "$branch" ] && has_open_pr "$branch"; then
    reason="open-pr"
    DIAG_KEEP_OPEN_PR=$((DIAG_KEEP_OPEN_PR + 1))
  elif [ "$scope" = "in-root" ]; then
    decision="remove-candidate"
    reason="clean-safe"
    DIAG_CANDIDATES=$((DIAG_CANDIDATES + 1))
  else
    # Defensive bucket for future scope/classification changes. With today's
    # two scopes, out-of-root is handled above and this should stay zero.
    reason="other"
    DIAG_KEEP_OTHER=$((DIAG_KEEP_OTHER + 1))
  fi

  branch_name="${branch#refs/heads/}"
  [ -n "$branch_name" ] || branch_name="-"
  diagnose_add_row "$decision" "$reason" "$scope" "$branch_name" "$wt"
}

diagnose_orphan_record() {
  local dir="$1" decision="keep" reason="young"
  # Keep this in sync with sweep_orphans/remove_orphan.
  DIAG_TOTAL=$((DIAG_TOTAL + 1))
  DIAG_IN_ROOT=$((DIAG_IN_ROOT + 1))
  if is_older_than_days "$dir" "$AGE_DAYS"; then
    decision="remove-candidate"
    reason="orphan"
    DIAG_CANDIDATES=$((DIAG_CANDIDATES + 1))
  else
    DIAG_KEEP_YOUNG=$((DIAG_KEEP_YOUNG + 1))
  fi
  diagnose_add_row "$decision" "$reason" "in-root" "-" "$dir"
}

diagnose_orphans() {
  local parent="$1" dir registered
  registered=$(git -C "$REPO" worktree list --porcelain 2>/dev/null |
    sed -n 's/^worktree //p')
  for dir in "$parent"/*/; do
    [ -d "$dir" ] || continue
    dir="${dir%/}"
    [[ "$dir" != *$'\n'* ]] || continue # keep in sync with sweep_orphans
    if printf '%s\n' "$registered" | grep -q -F -x "$dir"; then
      continue
    fi
    diagnose_orphan_record "$dir"
  done
}

diagnose_worktrees() {
  local line wt="" branch="" is_locked=0 is_detached=0 root parent
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
    "worktree "*) wt="${line#worktree }" ;;
    "branch "*) branch="${line#branch }" ;;
    "detached") is_detached=1 ;;
    "locked" | "locked "*) is_locked=1 ;;
    "")
      diagnose_record "$wt" "$branch" "$is_locked" "$is_detached"
      wt=""
      branch=""
      is_locked=0
      is_detached=0
      ;;
    esac
  done < <(git -C "$REPO" worktree list --porcelain 2>/dev/null)
  if [ -n "$wt" ]; then
    diagnose_record "$wt" "$branch" "$is_locked" "$is_detached"
  fi
  for root in "${_roots[@]}"; do
    parent=$(root_parent "$root")
    [ -d "$parent" ] || continue
    diagnose_orphans "$parent"
  done

  printf 'summary total=%d in_root=%d out_of_root=%d candidates=%d keep_main=%d keep_self_session=%d keep_young=%d keep_dirty=%d keep_detached=%d keep_unique=%d keep_open_pr=%d keep_other=%d keep_dirty_stale=%d\n' \
    "$DIAG_TOTAL" "$DIAG_IN_ROOT" "$DIAG_OUT_OF_ROOT" "$DIAG_CANDIDATES" \
    "$DIAG_KEEP_MAIN" "$DIAG_KEEP_SELF_SESSION" "$DIAG_KEEP_YOUNG" \
    "$DIAG_KEEP_DIRTY" "$DIAG_KEEP_DETACHED" "$DIAG_KEEP_UNIQUE" \
    "$DIAG_KEEP_OPEN_PR" "$DIAG_KEEP_OTHER" "$DIAG_KEEP_DIRTY_STALE"
  if [ "$MAX_REPORT" -gt 0 ]; then
    printf 'decision\treason\tscope\tbranch\tpath\n'
    if [ "${#DIAG_ROWS[@]}" -gt 0 ]; then
      printf '%s\n' "${DIAG_ROWS[@]}"
    fi
  fi
}

if [ "$DIAGNOSE" = true ]; then
  diagnose_worktrees
  exit 0
fi

for r in "${_roots[@]}"; do sweep_root "$r"; done
# Prune dangling worktree admin entries left by removals.
if [ "$APPLY" = true ]; then
  git -C "$REPO" worktree prune --expire now 2>/dev/null || true
fi
echo "done removed=$REMOVED"
