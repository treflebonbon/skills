#!/bin/bash -p
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

# stdin は diff に使い、宣言と repository は literal な argv で渡す。
source_path="${BASH_SOURCE[0]}"
while [[ -L "$source_path" ]]; do
  source_dir="$(cd -- "$(dirname -- "$source_path")" && pwd -P)"
  source_path="$(readlink -- "$source_path")"
  [[ "$source_path" = /* ]] || source_path="$source_dir/$source_path"
done
source_dir="$(cd -- "$(dirname -- "$source_path")" && pwd -P)"
package_root="$(cd -- "$source_dir/../../.." && pwd -P)"
UNTRACKED="$untracked" exec "$package_root/lib/bun/run" run "$source_dir/check-owned.ts" "$owned" "$repo" <<<"$diff_out"
