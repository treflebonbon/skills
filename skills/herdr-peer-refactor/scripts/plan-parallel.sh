#!/usr/bin/env bash
# plan-parallel.sh: choose which candidates run in parallel in this run.
#
# usage: plan-parallel.sh <limit> <records.tsv>
#
# records.tsv: one candidate per line, in the order the peer chose them:
#   <id> TAB <owned files, comma separated> TAB <related files, comma separated>
# A file may carry a line range (a.sh:10-20); the unit here is the file, so the
# range is ignored.
#
# <limit> is the Run Scope total of live agents: 1 parent + N children + (N+1)
# peers (contracts/autonomous-peer-contract.md), so N = (limit-2)/2.
#
# A candidate conflicts with an already chosen one when a file it owns is owned
# or depended on (related) by that one, or the other way round. A conflict is
# deferred to the next run; stacked PRs are not made.
#
# output, one line per candidate:
#   RUN <id> | DEFER <id> conflicts-with <id> | DEFER <id> over-limit
# exit: 0 | 2 usage, or a limit with no room for one child (needs at least 4)
set -euo pipefail

[ $# -eq 2 ] || {
  echo "usage: $0 <limit> <records.tsv>" >&2
  exit 2
}
limit=$1 records=$2
case $limit in '' | *[!0-9]*)
  echo "limit must be a number: $limit" >&2
  exit 2
  ;;
esac
[ -r "$records" ] || {
  echo "cannot read $records" >&2
  exit 2
}
# The same formula as launch-child.sh: 1 parent + N children + (N+1) peers = 2N+2.
n=$(((limit - 2) / 2))
[ "$n" -ge 1 ] || {
  echo "limit $limit leaves no room for one child (1 parent + 1 child + 2 peers = 4)" >&2
  exit 2
}

awk -F'\t' -v n="$n" '
function load(id, field, kind,    parts, i, f, c) {
  c = split(field, parts, ",")
  for (i = 1; i <= c; i++) {
    f = parts[i]
    sub(/:.*/, "", f)
    while (sub(/^\.\//, "", f)) {}
    if (f == "") continue
    set[kind, id, f] = 1
    list[kind, id] = list[kind, id] " " f
  }
}
function overlaps(a, b,    parts, i, c, f) {
  # a owns a file that b owns or depends on
  c = split(list["own", a], parts, " ")
  for (i = 1; i <= c; i++) {
    f = parts[i]
    if (f != "" && ((("own", b, f) in set) || (("rel", b, f) in set))) return 1
  }
  return 0
}
$1 == "" { next }
{
  id = $1
  load(id, $2, "own")
  load(id, $3, "rel")
  hit = ""
  for (i = 1; i <= taken; i++) {
    if (overlaps(id, chosen[i]) || overlaps(chosen[i], id)) { hit = chosen[i]; break }
  }
  if (hit != "") print "DEFER " id " conflicts-with " hit
  else if (taken >= n) print "DEFER " id " over-limit"
  else { chosen[++taken] = id; print "RUN " id }
}
' "$records"
