#!/usr/bin/env bash
# check-owned.sh: before publishing, compare the actual diff with the owned
# files and line ranges a candidate declared.
#
# usage: check-owned.sh <repo> <base> <owned, comma separated>
#
# <owned> is a list of `path` (the whole file) or `path:start-end` (only those
# lines). Ranges are declared up front, against the file as it is at <base>, so
# a changed hunk is compared by its OLD lines (a deletion of old line 3 needs
# 3 in a range; an insertion between old lines 3 and 4 needs 3 or 4 in a
# range). A file that does not exist at <base> has no old lines: all of its
# lines 1..N count, so it needs a whole-file declaration or a range covering
# 1..N. The actual diff is taken against the merge-base of <base> and HEAD (so
# work that landed on <base> later is not blamed on this candidate) and covers
# committed, staged and unstaged changes, plus untracked files. Renames are
# read as a delete plus an add, so both paths must be declared. A changed file
# with no declaration is outside the ownership.
#
# exit: 0 every change is inside the declaration | 1 changes outside it (listed
# on stdout; stop and select again, do not publish) | 2 usage or no merge-base
set -euo pipefail

[ $# -eq 3 ] || {
  echo "usage: $0 <repo> <base> <owned, comma separated>" >&2
  exit 2
}
repo=$1 base=$2 owned=$3

# Unrelated history has no merge-base: diffing against <base> itself would flag
# the whole base as changed, so stop instead of guessing.
point=$(git -C "$repo" merge-base "$base" HEAD 2>/dev/null) || {
  echo "no merge-base between $base and HEAD" >&2
  exit 2
}
diff_out=$(git -C "$repo" -c core.quotepath=off diff -U0 --no-renames --no-color "$point")
untracked=$(git -C "$repo" -c core.quotepath=off ls-files --others --exclude-standard)

# The checker is passed with -c so that stdin stays free for the diff text.
check_py=$(
  cat <<'PY'
import os, re, sys

declared = {}  # path -> None (the whole file) or a list of (start, end)
for item in sys.argv[1].split(","):
    item = item.strip()
    if not item:
        continue
    m = re.match(r"^(.*?)(?::(\d+)-(\d+))?$", item)
    path = m.group(1)
    while path.startswith("./"):
        path = path[2:]
    if m.group(2) is None:
        declared[path] = None
    elif declared.get(path, []) is not None:
        declared.setdefault(path, []).append((int(m.group(2)), int(m.group(3))))

def covers(ranges, lo, hi):
    return any(a <= lo and hi <= b for a, b in ranges)


def check(path, lo, hi, label, outside):
    ranges = declared.get(path, "missing")
    if ranges == "missing":
        outside.add(path)
    elif ranges is not None and not covers(ranges, lo, hi):
        outside.add("%s:%s (outside the declared lines)" % (path, label))


outside = set()
cur = None
is_new = False
hunks = {}  # path -> whether a hunk was seen (a binary or mode-only change has none)
for line in sys.stdin.read().split("\n"):
    if line.startswith("diff --git "):
        cur = line.rsplit(" b/", 1)[-1]
        is_new = False
        hunks[cur] = False
    elif line.startswith("new file mode") and cur is not None:
        is_new = True
    elif line.startswith("@@ ") and cur is not None:
        m = re.match(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
        old_start = int(m.group(1))
        old_count = 1 if m.group(2) is None else int(m.group(2))
        new_start = int(m.group(3))
        new_count = 1 if m.group(4) is None else int(m.group(4))
        hunks[cur] = True
        if is_new:
            check(cur, new_start, new_start + new_count - 1, "%d-%d" % (new_start, new_start + new_count - 1), outside)
        elif old_count > 0:
            check(cur, old_start, old_start + old_count - 1, "%d-%d" % (old_start, old_start + old_count - 1), outside)
        else:
            # a pure insertion after old line old_start: either neighbour inside a range is enough
            ranges = declared.get(cur, "missing")
            if ranges == "missing":
                outside.add(cur)
            elif ranges is not None and not any(a <= old_start + 1 and old_start <= b for a, b in ranges):
                outside.add("%s:insert-after-%d (outside the declared lines)" % (cur, old_start))
for path, seen in hunks.items():
    if not seen and path not in declared:
        outside.add(path)
for path in os.environ.get("UNTRACKED", "").split("\n"):
    if not path:
        continue
    try:
        n, last = 0, b"\n"
        with open(os.path.join(sys.argv[2], path), "rb") as f:
            # counted in chunks: a large untracked file is not held in memory
            while chunk := f.read(1 << 20):
                n += chunk.count(b"\n")
                last = chunk[-1:]
        # an unterminated last line is still a line
        n += 1 if last != b"\n" else 0
    except OSError:
        n = 1
    check(path, 1, max(n, 1), "1-%d" % max(n, 1), outside)

for entry in sorted(outside):
    print(entry)
sys.exit(1 if outside else 0)
PY
)

UNTRACKED="$untracked" python3 -c "$check_py" "$owned" "$repo" <<<"$diff_out"
