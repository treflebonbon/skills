#!/usr/bin/env bash
# PythonとPerlを同じBashの子として順に起動し、baselineだけで追加測定を許可する。
set -euo pipefail

if [[ $# != 2 ]]; then
  printf '%s\n' 'SOURCE OUTPUTが必要です' >&2
  exit 2
fi

controller_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(cd -- "$1" && pwd -P)"
output="$2"
cd -- "$source_root"

baseline_status=0
python3 -I "$controller_dir/probe-linux-namespace-parent.py" baseline "$source_root" "$output" || baseline_status=$?
perl_status=-1
if [[ $baseline_status == 1 ]]; then
  perl_status=0
  /usr/bin/perl "$controller_dir/probe-linux-namespace-parent.pl" /usr/bin/unshare "$output" || perl_status=$?
fi
final_status=0
python3 -I "$controller_dir/probe-linux-namespace-parent.py" finalize "$source_root" "$output" "$baseline_status" "$perl_status" || final_status=$?
exit "$final_status"
