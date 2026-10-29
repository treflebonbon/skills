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
plugin_root="$(cd -- "$skill_dir/../.." && pwd -P)"
python3 -B "$skill_dir/scripts/auto-peer-preflight.py" verify --runtime codex --repository "$repository" --receipt "$receipt" || {
  echo "dedicated Codex auto-peer preflight failed; no session was started" >&2
  exit 1
}

exec "$plugin_root/bin/codex-reviewer" --peer --disable apps -- "$@"
