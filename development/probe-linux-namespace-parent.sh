#!/usr/bin/env bash
# 共通Bashの子として準備・測定・後処理を待機し、専用コードだけで次段階を許可する。
set -euo pipefail

if [[ $# != 2 && $# != 3 ]]; then
  printf '%s\n' 'SOURCE OUTPUT [parent|stdin]が必要です' >&2
  exit 2
fi

baseline_stage=baseline
final_stage=finalize
allowed_status=42
perl_mode=()
case "${3:-parent}" in
parent) ;;
stdin)
  baseline_stage=stdin-prepare
  final_stage=stdin-finalize
  allowed_status=45
  perl_mode=(stdin)
  ;;
*)
  printf '%s\n' '比較方式が不正です' >&2
  exit 2
  ;;
esac

controller_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || exit 2
source_root="$(CDPATH='' cd -- "$1" && pwd -P)" || exit 2
case "$2" in
/*) output="$2" ;;
*) output="$PWD/$2" ;;
esac
cd -- "$source_root" || exit 2
# 未使用の出力先を確保した実行だけに、checkpointと最終記録の作成を許可する。
mkdir -m 700 -- "$output" || exit 2

baseline_status=0
python3 -I "$controller_dir/probe-linux-namespace-parent.py" "$baseline_stage" "$source_root" "$output" || baseline_status=$?
perl_status=-1
if [[ $baseline_status == "$allowed_status" ]]; then
  perl_status=0
  /usr/bin/perl "$controller_dir/probe-linux-namespace-parent.pl" "${perl_mode[@]}" /usr/bin/unshare "$output" || perl_status=$?
fi
final_status=0
python3 -I "$controller_dir/probe-linux-namespace-parent.py" "$final_stage" "$source_root" "$output" "$baseline_status" "$perl_status" || final_status=$?
case "$final_status" in
44) exit 0 ;;
43) exit 1 ;;
*) exit 2 ;;
esac
