#!/bin/bash -p
set -euo pipefail

runner=$1
prepare=$2
launcher=$3
shift 3
# 準備子を作る前に launcher へ置換し、入口段階の親消失も同じ監視に含める。
exec "$launcher" "$runner" "$prepare" "$@"
