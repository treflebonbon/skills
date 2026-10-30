#!/usr/bin/env bash
# gh-once.sh: create an issue or post the run report at most once per run.
#
# usage: gh-once.sh issue  <run-id> <candidate-id> <title> <body-file>
#        gh-once.sh report <run-id> <issue-number> <body-file>
#
# Every write carries a marker "<!-- auto-run:<run-id> <key> -->" (key = cand:<id>
# or report). The marker is looked up BEFORE the write and again after a failed
# write, so a response lost after the server succeeded finds the artifact instead
# of creating a duplicate. List reads are used, not search: search is eventually
# consistent and could miss a just-created issue.
#
# stdout: issue number (issue) | the report comment's issue number (report)
# exit: 0 done (created or already there) | 1 write failed and a lookup confirmed
# no artifact exists (the caller may resend) | 2 usage | 3 a lookup (or the marker
# lock) failed or hit the list limit, so whether the artifact exists is unknown
# (never resend; report it unconfirmed)
set -euo pipefail

kind=${1:-}
case $kind in
issue) [ $# -eq 5 ] || kind= ;;
report) [ $# -eq 4 ] || kind= ;;
*) kind= ;;
esac
[ -n "$kind" ] || {
  echo "usage: $0 issue <run-id> <cand-id> <title> <body-file> | report <run-id> <issue-number> <body-file>" >&2
  exit 2
}

run=$2
limit=1000
if [ "$kind" = issue ]; then
  marker="<!-- auto-run:$run cand:$3 -->"
  title=$4 body=$5
  lookup() {
    # Only the newest $limit issues are listed: a full page with no match cannot
    # prove the artifact is absent, so it fails the lookup (exit 3, unknown).
    gh issue list --state all --limit "$limit" --json number,body |
      jq -r --arg m "$marker" --argjson n "$limit" '
        ([.[] | select(.body | contains($m)) | .number] | first) as $f
        | if $f != null then $f elif length >= $n then error("issue list reached the limit") else empty end'
  }
  write() { gh issue create --label ready-for-agent --title "$title" --body-file "$tmp" >/dev/null; }
else
  marker="<!-- auto-run:$run report -->"
  target=$3 body=$4
  [[ $target =~ ^[0-9]+$ ]] || {
    echo "issue-number must be numeric: $target" >&2
    exit 2
  }
  lookup() {
    gh issue view "$target" --json comments |
      jq -r --arg m "$marker" --arg t "$target" 'if any(.comments[]; .body | contains($m)) then $t else empty end'
  }
  write() { gh issue comment "$target" --body-file "$tmp" >/dev/null; }
fi

# One writer per marker: a concurrent run waits here, then its lookup sees the
# first run's artifact. The lock is system Perl's flock(2) (macOS has no flock
# command, ADR-0050); a lock that cannot be taken leaves existence unknown.
# The path is fixed (not TMPDIR): callers with different TMPDIR must share it.
# The lock lives in a private per-user directory: in a shared /tmp another user
# could plant a symlink at a predictable path and have it truncated.
lock_dir="${GH_ONCE_TEST_LOCK_BASE:-/tmp}/gh-once-$(id -u)" # the base is overridden by tests only
mkdir -m 700 "$lock_dir" 2>/dev/null || [ -d "$lock_dir" ] || exit 3
{ [ -d "$lock_dir" ] && [ ! -L "$lock_dir" ] && [ -O "$lock_dir" ]; } || exit 3
lock="$lock_dir/$(printf '%s' "$marker" | cksum | cut -d' ' -f1).lock"
exec 9>>"$lock" || exit 3
perl -MFcntl=:flock -e 'open(my $fh, "+<&=", 9) or exit 2; flock($fh, LOCK_EX) or exit 2' || exit 3

found=$(lookup) || exit 3
[ -z "$found" ] || {
  echo "$found"
  exit 0
}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
{
  cat "$body"
  printf '\n%s\n' "$marker"
} >"$tmp"

write || true
found=$(lookup) || exit 3
[ -n "$found" ] || exit 1
echo "$found"
