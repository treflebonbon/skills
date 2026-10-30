#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 || $3 != -- ]]; then
  echo "usage: $0 <owner/repo> <receipt> -- <prompt>" >&2
  exit 2
fi
repository=$1
receipt=$2
shift 3
export CODEX_HOME="$HOME/.codex-peer"
export GH_CONFIG_DIR="$CODEX_HOME/gh"

skill_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec python3 -B "$skill_dir/scripts/auto-peer-preflight.py" launch-codex \
  --repository "$repository" --receipt "$receipt" -- "$@"
