#!/usr/bin/env bats

# The contract table is the norm; peer-request.sh duplicates its limits as
# constants. Compare only the two (not wording elsewhere), failing closed when
# a row or constant is missing, duplicated, or not a plain integer.

@test "peer limits in the contract table match peer-request.sh constants" {
  run python3 -I - "$BATS_TEST_DIRNAME/../.." <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
contract = (root / "contracts/autonomous-peer-contract.md").read_text(encoding="utf-8")
script = (root / "skills/herdr-peer-refactor/scripts/peer-request.sh").read_text(encoding="utf-8")


def one(items, label):
    if len(items) != 1:
        raise SystemExit(f"{label}: found {len(items)}, expected exactly 1")
    return items[0]


def cells(line):
    return [c.strip() for c in line.strip().split("|")]


lines = contract.splitlines()
head = one([i for i, l in enumerate(lines) if cells(l) == ["", "上限", "値", ""]], "limits table")
rows = []
for line in lines[head + 2 :]:
    if not line.lstrip().startswith("|"):
        break
    row = cells(line)
    if len(row) != 4:
        raise SystemExit(f"limits table: bad row {line!r}")
    rows.append((re.sub(r"\s+", "", row[1]), row[2]))

for label, name, units in (
    ("peer1回の待機", "PEER_TIMEOUT_S", {"分": 60, "時間": 3600}),
    ("1候補の累積待機", "TOTAL_WAIT_S", {"分": 60, "時間": 3600}),
    ("ReviewRound", "MAX_ROUNDS", {"回": 1}),
):
    value = one([v for k, v in rows if k == label], label)
    m = re.fullmatch(r"(\d+)\s*(" + "|".join(units) + ")", value)
    if m is None:
        raise SystemExit(f"{label}: bad value {value!r}")
    # leading blanks allowed: an indented override inside a conditional also counts
    const = one(re.findall(rf"^[ \t]*{name}=(.*)$", script, re.M), name)
    # no leading zero: Bash arithmetic reads 01200 as octal, int() as decimal
    if re.fullmatch(r"[1-9]\d*", const) is None:
        raise SystemExit(f"{name}: not a plain decimal literal: {const!r}")
    if int(m[1]) * units[m[2]] != int(const):
        raise SystemExit(f"{label}: contract {value} != {name}={const}")
PY
  echo "$output"
  [ "$status" -eq 0 ]
}
