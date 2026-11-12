#!/bin/bash -p
set -euo pipefail

runner=$1
prepare=$2
launcher=$3
shift 3
# fd path と子 PID だけを argv に載せ、準備結果・環境は専用 pipe で渡す。
exec "$launcher" <(exec "$runner" run "$prepare" "$@") "$!"
