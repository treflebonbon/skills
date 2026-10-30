#!/usr/bin/env bats

bats_require_minimum_version 1.5.0
load ../helpers/raw-codex

setup() { PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"; }
teardown() { raw_cleanup; }

@test "raw admission selects managed local MCP without importing additional servers or their credentials" {
  raw_fixture
  mkdir -p "$RAW_BASE/profile/bin"
  local tool
  for tool in bunx node uvx; do
    ln -s "$(command -v "$tool")" "$RAW_BASE/profile/bin/$tool"
  done
  cat >>"$RAW_BASE/home/.codex/config.toml" <<'TOML'

[mcp_servers.unreviewed]
command = "secret-fetcher"
env = { PROJECT_SECRET = "dummy-unreviewed-credential" }
TOML
  raw_admit flake.nix task.sh
  PATH="$RAW_BASE/profile/bin:$PATH" run raw_cli admit --git-head "$(git -C "$RAW_BASE/work" rev-parse HEAD)" --mcp context7 --mcp serena -- flake.nix task.sh
  raw_assert_status 0
  run --separate-stderr raw_run mcp list --json
  raw_assert_status 0
  [[ "$output" == *'"name": "context7"'* ]]
  [[ "$output" == *'"name": "serena"'* ]]
  [[ "$output" == *'"command": "/nix/store/'* ]]
  [[ "$output" != *unreviewed* ]]
  [[ "$output" != *dummy-unreviewed-credential* ]]
  local commands=()
  mapfile -t commands < <(python3 -c '
import json, sys
text = sys.argv[1]
servers = json.JSONDecoder().raw_decode(text[text.index("["):])[0]
for server in sorted(servers, key=lambda entry: entry["name"]):
    print(server["transport"]["command"])
' "$output")
  run raw_run sandbox -- python3 -c '
import subprocess, sys
assert len(sys.argv) == 3
for command, usage in zip(sys.argv[1:], ("Usage: bunx", "Usage: uvx")):
    result = subprocess.run([command, "--help"], capture_output=True, text=True)
    assert result.returncode == 0, result
    assert usage in result.stdout + result.stderr, result
subprocess.run(["node", "--version"], check=True)
print("MCP_PROFILE_TOOLS_CHECKED")
' "${commands[@]}"
  raw_assert_status 0
  [[ "$output" == *MCP_PROFILE_TOOLS_CHECKED* ]]
}

@test "raw entry uses host gh through the scoped proxy and edited code cannot request secret or control APIs" {
  [ "${CODEX_ISOLATION_REAL_GITHUB:-0}" = 1 ] || skip "opt in with CODEX_ISOLATION_REAL_GITHUB=1; authenticated public GET only"
  local host_gh_config="${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}"
  raw_fixture
  mkdir -p "$RAW_BASE/host-config"
  ln -s "$host_gh_config" "$RAW_BASE/host-config/gh"
  git -C "$RAW_BASE/work" remote add origin https://github.com/treflebonbon/dotfiles.git
  cat >"$RAW_BASE/work/task.sh" <<'TASK'
set -eu
test -z "${GH_CONFIG_DIR+x}"
test -z "${GH_TOKEN+x}"
test -z "${GITHUB_TOKEN+x}"
case "${XDG_CONFIG_HOME:-}" in *host-config*) exit 23;; esac
gh api repos/treflebonbon/dotfiles --jq .full_name
test "$(gh pr list --json number,url --jq type)" = array
if gh auth token; then exit 19; fi
for route in actions/secrets actions/runs/1/logs contents/.env; do
  if gh api "repos/treflebonbon/dotfiles/$route"; then exit 20; fi
done
if gh api graphql -f query='query { viewer { login } }'; then exit 21; fi
if gh api repos/treflebonbon/dotfiles/actions/workflows/example/dispatches -X POST -f ref=main; then exit 22; fi
test -z "$(cat .env 2>/dev/null || true)"
test ! -e ordinary-looking-name
printf 'SCOPED_GITHUB_CHECKED\n'
TASK
  raw_admit flake.nix task.sh
  python3 - "$RAW_BASE/github.json" "$(git -C "$RAW_BASE/work" rev-parse HEAD)" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({'repository':'treflebonbon/dotfiles','branch':'task','default_branch':'main',
    'reviewed_commit':sys.argv[2],'automation':'no-project-secrets','review':'public GET probe only; no publication'}))
PY
  raw_cli admit --git-head "$(git -C "$RAW_BASE/work" rev-parse HEAD)" --github-policy "$RAW_BASE/github.json" -- flake.nix task.sh
  local mode
  for mode in gh xdg; do
    if [ "$mode" = gh ]; then
      export GH_CONFIG_DIR="$RAW_BASE/host-config/gh" XDG_CONFIG_HOME="$RAW_BASE/unused-config"
    else
      unset GH_CONFIG_DIR
      export XDG_CONFIG_HOME="$RAW_BASE/host-config"
    fi
    GH_TOKEN=dummy-host-token GITHUB_TOKEN=dummy-host-token run raw_run sandbox -- bash task.sh
    raw_assert_status 0
    [[ "$output" == *SCOPED_GITHUB_CHECKED* ]]
    [[ "$output" != *dummy-root-secret* ]]
  done
}

@test "raw Codex uses real managed Context7 and Serena inside the boundary" {
  [ "${CODEX_ISOLATION_REAL_MCP:-0}" = 1 ] || skip "opt in with CODEX_ISOLATION_REAL_MCP=1; downloads managed MCP and uses the existing model login"
  local host_codex_home="${CODEX_HOME:-$HOME/.codex}"
  raw_fixture
  ln -s "$host_codex_home/auth.json" "$RAW_BASE/home/.codex/auth.json"
  # Keep package/startup failures observable without changing MCP permissions.
  python3 - "$RAW_BASE/work/flake.nix" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text(path.read_text().replace('PUBLIC_VAR = "normal";', 'PUBLIC_VAR = "normal"; RUST_LOG = "codex_rmcp_client=info";'))
PY
  printf 'def greeting():\n    return "before"\n' >"$RAW_BASE/work/greeting.py"
  raw_admit flake.nix task.sh greeting.py
  raw_cli admit --git-head "$(git -C "$RAW_BASE/work" rev-parse HEAD)" --mcp context7 --mcp serena -- flake.nix task.sh greeting.py
  run raw_run exec --json 'Use the context7 MCP tools to resolve the Python documentation library and query pathlib read_text documentation. Use the serena MCP tools to activate the current Python project, read greeting.py, and change the return value of greeting() from before to after. You must actually call both MCP servers, not use shell replacements. Verify that .env and ordinary-looking-name cannot be read, without asking for broader permissions. End with MCP_SERVICES_CHECKED only if both MCP operations succeeded.'
  raw_assert_status 0
  [[ "$output" == *MCP_SERVICES_CHECKED* ]]
  [[ "$output" == *'mcp__context7'* || "$output" == *'mcp.context7'* || "$output" == *'"server":"context7"'* ]]
  [[ "$output" == *'mcp__serena'* || "$output" == *'mcp.serena'* || "$output" == *'"server":"serena"'* ]]
  [[ "$output" != *dummy-root-secret* ]]
  [[ "$output" != *dummy-renamed-secret* ]]
  [ "$(cat "$RAW_BASE/work/greeting.py")" = $'def greeting():\n    return "after"' ]
}
