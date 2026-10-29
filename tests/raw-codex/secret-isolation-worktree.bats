#!/usr/bin/env bats

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  CLI="$PROJECT_ROOT/share/codex-isolation/secret-isolation-worktree.py"
  FIXTURE="$BATS_TEST_TMPDIR/fixture"
  mkdir -p "$FIXTURE"
  git init -q -b main "$FIXTURE/repo"
  printf 'public source\n' >"$FIXTURE/repo/source.txt"
  git -C "$FIXTURE/repo" add source.txt
  git -C "$FIXTURE/repo" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm 'test: public baseline'
  git -C "$FIXTURE/repo" worktree add -qb task "$FIXTURE/work"
  HEAD_SHA="$(git -C "$FIXTURE/work" rev-parse HEAD)"
  printf 'dummy-root-secret\n' >"$FIXTURE/work/.env"
  printf 'dummy-alias-secret\n' >"$FIXTURE/work/ordinary-looking-name"
}

teardown() {
  # Bats owns this temporary fixture, including its read-only copied store.
  python3 - "$FIXTURE" <<'PY'
import os
from pathlib import Path
import sys
for root, directories, _ in os.walk(sys.argv[1], followlinks=False):
    os.chmod(root, os.stat(root).st_mode | 0o700)
    directories[:] = [name for name in directories if not (Path(root) / name).is_symlink()]
PY
}

@test "explicit public inputs produce an independent snapshot of the existing linked worktree" {
  python3 "$CLI" approve --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --git-head "$HEAD_SHA" -- source.txt

  run python3 "$CLI" prepare --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" --output "$FIXTURE/session"

  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
  [ "$(cat "$FIXTURE/session/root$FIXTURE/work/source.txt")" = 'public source' ]
  [ ! -e "$FIXTURE/session/root$FIXTURE/work/.env" ]
  [ ! -e "$FIXTURE/session/root$FIXTURE/work/ordinary-looking-name" ]
  printf 'dummy-late-secret\n' >"$FIXTURE/work/source.txt"
  [ "$(cat "$FIXTURE/session/root$FIXTURE/work/source.txt")" = 'public source' ]
}

@test "changed bytes and linked inputs are rejected before a snapshot can be launched" {
  mkdir "$FIXTURE/work/src"
  printf 'public source\n' >"$FIXTURE/work/src/entry.txt"
  python3 "$CLI" approve --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --git-head "$HEAD_SHA" -- src/entry.txt
  local attack
  for attack in changed symlink hardlink ancestor; do
    mv "$FIXTURE/work/src/entry.txt" "$FIXTURE/saved-$attack"
    case "$attack" in
      changed) cp "$FIXTURE/work/.env" "$FIXTURE/work/src/entry.txt" ;;
      symlink) ln -s ../.env "$FIXTURE/work/src/entry.txt" ;;
      hardlink) ln "$FIXTURE/work/.env" "$FIXTURE/work/src/entry.txt" ;;
      ancestor)
        mv "$FIXTURE/work/src" "$FIXTURE/real-src"
        ln -s "$FIXTURE/real-src" "$FIXTURE/work/src"
        cp "$FIXTURE/saved-$attack" "$FIXTURE/real-src/entry.txt"
        ;;
    esac
    run python3 "$CLI" prepare --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" --output "$FIXTURE/session-$attack"
    [ "$status" -ne 0 ]
    [[ "$output" != *'dummy-root-secret'* ]]
    [ ! -e "$FIXTURE/session-$attack" ]
    if [ "$attack" != ancestor ]; then
      mv "$FIXTURE/work/src/entry.txt" "$FIXTURE/rejected-$attack"
      mv "$FIXTURE/saved-$attack" "$FIXTURE/work/src/entry.txt"
    fi
  done
}

@test "the real isolated Git worktree returns the same commit and refuses concurrent host edits" {
  [ "${SECRET_ISOLATION_REAL_RUNTIME:-0}" = 1 ] || skip "opt in with SECRET_ISOLATION_REAL_RUNTIME=1; requires Nix store tools and bubblewrap"
  cat >"$FIXTURE/work/task.sh" <<'SH'
set -eu
test ! -e .env
test ! -e ordinary-looking-name
test -z "${WORKTREE_DUMMY_SECRET+x}"
test ! -e /nix/var/nix/daemon-socket/socket
printf 'edited public source\n' > source.txt
git add source.txt
git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm 'test: isolated edit'
git rev-parse HEAD
SH
  python3 "$CLI" approve --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --git-head "$HEAD_SHA" -- source.txt task.sh

  run env WORKTREE_DUMMY_SECRET=dummy-parent-secret python3 "$CLI" run \
    --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" --output "$FIXTURE/session" -- bash task.sh

  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
  local result_head
  result_head="$(cat "$FIXTURE/session/result/head")"
  [[ "$output" == *"$result_head"* ]]
  [ "$(git -C "$FIXTURE/work" rev-parse HEAD)" = "$HEAD_SHA" ]
  printf 'concurrent host edit\n' >"$FIXTURE/work/source.txt"
  run python3 "$CLI" return --root "$FIXTURE/work" --session "$FIXTURE/session"
  [ "$status" -ne 0 ]
  [ "$(cat "$FIXTURE/work/source.txt")" = 'concurrent host edit' ]
  [ "$(git -C "$FIXTURE/work" rev-parse HEAD)" = "$HEAD_SHA" ]
  printf 'public source\n' >"$FIXTURE/work/source.txt"
  run python3 "$CLI" return --root "$FIXTURE/work" --session "$FIXTURE/session"
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
  [ "$(git -C "$FIXTURE/work" rev-parse HEAD)" = "$result_head" ]
  [ "$(cat "$FIXTURE/work/source.txt")" = 'edited public source' ]
  [ "$(cat "$FIXTURE/work/.env")" = 'dummy-root-secret' ]
  [ -z "$(git -C "$FIXTURE/work" diff --name-only HEAD)" ]
}

@test "isolated GitHub uses only the fixed authenticated public metadata route" {
  [ "${SECRET_ISOLATION_REAL_SERVICES:-0}" = 1 ] || skip "opt in with SECRET_ISOLATION_REAL_SERVICES=1; uses the host GitHub login for one public GET"
  cat >"$FIXTURE/work/github.sh" <<'SH'
set -eu
export GH_CONFIG_DIR=/home/agent/gh
gh config set http_unix_socket /gateway/github/service.sock
export GH_TOKEN=isolated-placeholder
test "$(gh api repos/octocat/Hello-World --jq .full_name)" = octocat/Hello-World
if gh api user >/dev/null 2>&1; then exit 1; fi
if gh api repos/octocat/Hello-World --method POST >/dev/null 2>&1; then exit 1; fi
test ! -e /home/ubuntu/.config/gh/hosts.yml
test ! -e .env
printf 'GITHUB_BOUNDARY_OK\n'
SH
  python3 "$CLI" approve --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --git-head "$HEAD_SHA" -- source.txt github.sh
  run python3 "$CLI" run --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --output "$FIXTURE/session" --service github -- bash github.sh
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
  [[ "$output" == *GITHUB_BOUNDARY_OK* ]]
}

@test "real Nix, hosted Codex, children, GitHub and MCP run through the worktree boundary" {
  [ "${SECRET_ISOLATION_REAL_MODEL:-0}/${SECRET_ISOLATION_REAL_SERVICES:-0}" = 1/1 ] || skip "requires SECRET_ISOLATION_REAL_MODEL=1 and SECRET_ISOLATION_REAL_SERVICES=1; uses hosted model and authenticated public GitHub GET"
  mkdir -p "$FIXTURE/work/nested"
  printf 'dummy nested secret\n' >"$FIXTURE/work/nested/renamed"
  printf 'dummy dotenv\n' >"$FIXTURE/work/nested/.env"
  printf 'dummy other worktree secret\n' >"$FIXTURE/repo/.env"
  cp "$PROJECT_ROOT/tests/fixtures/secret-isolation/worktree-task.py" "$FIXTURE/work/worktree-task.py"
  python3 - "$FIXTURE/work/flake.nix" <<'PY'
from pathlib import Path
import shutil, sys
bash = Path(shutil.which('bash')).resolve().parents[1]
python = Path(shutil.which('python3')).resolve().parents[1]
utils = Path(shutil.which('cat')).resolve().parents[1]
Path(sys.argv[1]).write_text("""{
 outputs = { self }: { devShells.x86_64-linux.default = builtins.derivation {
  name = "isolated-worktree-shell"; system = "x86_64-linux";
  builder = "%s/bin/bash"; args = [ "-c" "exit 0" ];
  outputs = [ "out" ]; PATH = "%s/bin:%s/bin";
  shellHook = "%s/bin/python3 worktree-task.py boundary; export PROBE_HOOK=ready";
 }; };
}""" % (bash, bash, utils, python))
PY
  cat >"$FIXTURE/work/model.sh" <<'SH'
set -eu
export CODEX_HOME=/home/agent/codex
mkdir -p "$CODEX_HOME"
gh config set http_unix_socket /gateway/github/service.sock
nix print-dev-env --no-write-lock-file "git+file://$PWD" > /tmp/environment.sh
source /tmp/environment.sh
python3 worktree-task.py boundary
cat >"$CODEX_HOME/config.toml" <<'TOML'
model = "gpt-6-astra"
model_reasoning_effort = "low"
model_provider = "isolated"
approval_policy = "never"
default_permissions = "dotfiles-secure"
web_search = "disabled"
[features]
shell_snapshot = false
[permissions.dotfiles-secure]
extends = ":workspace"
[permissions.dotfiles-secure.network]
enabled = true
[model_providers.isolated]
name = "Fixed model gateway"
base_url = "http://127.0.0.1:8123/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
TOML
python3 - "$CODEX_HOME/config.toml" <<'PY'
import json, os, subprocess, sys
from pathlib import Path
metadata = subprocess.check_output(['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], text=True).splitlines()
with Path(sys.argv[1]).open('a') as file:
    file.write('\n[permissions.dotfiles-secure.filesystem]\n')
    for path in metadata:
        file.write(json.dumps(path) + '="write"\n')
    file.write('"/nix"="read"\n')
    file.write('\n[mcp_servers.boundary]\ncommand="python3"\nargs=["worktree-task.py","mcp"]\ncwd=' + json.dumps(os.getcwd()) + '\n')
    file.write('\n[mcp_servers.boundary.tools.boundary]\napproval_mode="approve"\n')
PY
test ! -e "$CODEX_HOME/auth.json"
test ! -e /home/ubuntu/.codex/auth.json
test ! -e .env
codex exec --strict-config --ephemeral --json 'Execute python3 worktree-task.py task in this working directory, then call the boundary MCP tool. Both must succeed. Do not change the fixture or recover by weakening a permission. Reply exactly ISOLATED_MODEL_OK only after both succeed.'
SH
  git -C "$FIXTURE/work" add flake.nix worktree-task.py model.sh
  git -C "$FIXTURE/work" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm 'test: public hosted fixture'
  HEAD_SHA="$(git -C "$FIXTURE/work" rev-parse HEAD)"
  python3 "$CLI" approve --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --git-head "$HEAD_SHA" -- source.txt model.sh flake.nix worktree-task.py
  run python3 "$CLI" run --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --output "$FIXTURE/session" --service model --service github -- bash model.sh
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
  [[ "$output" == *ISOLATED_MODEL_OK* ]]
  [ -f "$FIXTURE/session/root$FIXTURE/work/mcp-ok" ]
  run python3 "$CLI" return --root "$FIXTURE/work" --session "$FIXTURE/session"
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
  [ -f "$FIXTURE/work/calculator.py" ]
  [ "$(git -C "$FIXTURE/work" log -1 --format=%s)" = 'test: hosted isolated calculation' ]
  [ "$(cat "$FIXTURE/work/.env")" = 'dummy-root-secret' ]
}

@test "isolated Nix fetches the public cache through an allowlisted gateway and refuses other destinations" {
  [ "${SECRET_ISOLATION_REAL_DEPENDENCIES:-0}" = 1 ] || skip "opt in with SECRET_ISOLATION_REAL_DEPENDENCIES=1 and SECRET_ISOLATION_CA_BUNDLE; uses one public Nix cache GET"
  [ -f "$SECRET_ISOLATION_CA_BUNDLE" ]
  cat >"$FIXTURE/work/fetch.sh" <<'SH'
set -eu
nix store prefetch-file --json https://cache.nixos.org/nix-cache-info > fetch.json
python3 - <<'PY'
import json, socket
from pathlib import Path
result = json.loads(Path('fetch.json').read_text())
assert 'StoreDir: /nix/store' in Path(result['storePath']).read_text()
for target in ('example.com:443', '127.0.0.1:443', 'cache.nixos.org:80', 'cache.nixos.org.evil.example:443'):
    with socket.create_connection(('127.0.0.1', 8124)) as sock:
        sock.sendall(f'CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n'.encode())
        assert b'403' in sock.recv(4096).split(b'\r\n')[0]
print('DEPENDENCY_BOUNDARY_OK')
PY
SH
  python3 "$CLI" approve --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --git-head "$HEAD_SHA" -- source.txt fetch.sh
  run python3 "$CLI" run --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --output "$FIXTURE/session" --service dependencies --ca-bundle "$SECRET_ISOLATION_CA_BUNDLE" -- bash fetch.sh
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
  [[ "$output" == *DEPENDENCY_BOUNDARY_OK* ]]
}

@test "stage and unstaged edits survive result transfer and the next isolated start" {
  [ "${SECRET_ISOLATION_REAL_RUNTIME:-0}" = 1 ] || skip "opt in with SECRET_ISOLATION_REAL_RUNTIME=1; requires Nix store tools and bubblewrap"
  mkdir "$FIXTURE/work/src"
  git -C "$FIXTURE/work" mv source.txt src/source.txt
  git -C "$FIXTURE/work" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm 'test: nested public baseline'
  HEAD_SHA="$(git -C "$FIXTURE/work" rev-parse HEAD)"
  cat >"$FIXTURE/work/task.sh" <<'SH'
set -eu
printf 'staged source\n' > src/source.txt
git add src/source.txt
printf 'unstaged source\n' > src/source.txt
mkdir docs
printf 'new public file\n' > docs/new.txt
exit 7
SH
  python3 "$CLI" approve --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --git-head "$HEAD_SHA" -- src/source.txt task.sh
  run python3 "$CLI" run --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --output "$FIXTURE/session" -- bash task.sh
  [ "$status" -eq 7 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 7 ]
  run python3 "$CLI" return --root "$FIXTURE/work" --session "$FIXTURE/session"
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
  [ "$(git -C "$FIXTURE/work" show :src/source.txt)" = 'staged source' ]
  [ "$(cat "$FIXTURE/work/src/source.txt")" = 'unstaged source' ]
  [ "$(cat "$FIXTURE/work/docs/new.txt")" = 'new public file' ]
  [ "$(git -C "$FIXTURE/work" rev-parse HEAD)" = "$HEAD_SHA" ]
  run python3 "$CLI" run --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --output "$FIXTURE/restart" -- bash -c 'test "$(git show :src/source.txt)" = "staged source" && test "$(cat src/source.txt)" = "unstaged source" && test -f docs/new.txt && test ! -e .env'
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "project initialization cannot replace the selected runtime tools or their store parent" {
  [ "${SECRET_ISOLATION_REAL_RUNTIME:-0}" = 1 ] || skip "opt in with SECRET_ISOLATION_REAL_RUNTIME=1; requires Nix store tools and bubblewrap"
  cat >"$FIXTURE/work/check-runtime.py" <<'PY'
import os, shutil
from pathlib import Path
tool = Path(shutil.which('gh')).resolve()
try:
    tool.chmod(0o755)
    with tool.open('ab') as file:
        file.write(b'public-fixture-tamper')
except OSError:
    pass
else:
    raise AssertionError('project code can replace the chosen runtime tool')
try:
    os.rename('/nix/store', '/nix/moved-store')
except OSError:
    pass
else:
    os.rename('/nix/moved-store', '/nix/store')
    raise AssertionError('project code can replace the store parent')
PY
  python3 "$CLI" approve --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --git-head "$HEAD_SHA" -- source.txt check-runtime.py
  run python3 "$CLI" run --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --output "$FIXTURE/session" -- python3 check-runtime.py
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "result transfer preserves a host stage completed before acquiring the index lock" {
  [ "${SECRET_ISOLATION_REAL_RUNTIME:-0}" = 1 ] || skip "opt in with SECRET_ISOLATION_REAL_RUNTIME=1; requires Nix store tools and bubblewrap"
  python3 "$CLI" approve --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --git-head "$HEAD_SHA" -- source.txt
  run python3 "$CLI" run --root "$FIXTURE/work" --policy "$FIXTURE/policy.json" \
    --output "$FIXTURE/session" -- bash -c 'printf "agent edit\n" > source.txt; git add source.txt'
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
  printf 'concurrent host stage\n' > "$FIXTURE/work/host-stage.txt"
  mkdir "$FIXTURE/bin"
  # Complete a real host git add after the early check, at the bundle boundary.
  python3 - "$FIXTURE" <<'PY'
from pathlib import Path
import shlex, shutil, sys
fixture = Path(sys.argv[1])
real_git = shlex.quote(shutil.which('git'))
bash = shutil.which('bash')
work = shlex.quote(str(fixture / 'work'))
wrapper = fixture / 'bin/git'
wrapper.write_text(f'''#!{bash}
{real_git} "$@"
result=$?
case " $* " in
  *" -C "{work}" bundle unbundle "*)
    [ "$result" -eq 0 ] || exit "$result"
    {real_git} -C {work} add host-stage.txt
    exit "$?"
    ;;
esac
exit "$result"
''')
wrapper.chmod(0o755)
PY
  run env PATH="$FIXTURE/bin:$PATH" python3 "$CLI" return \
    --root "$FIXTURE/work" --session "$FIXTURE/session"
  [ "$status" -ne 0 ]
  [ "$(git -C "$FIXTURE/work" show :host-stage.txt)" = 'concurrent host stage' ]
  [ "$(git -C "$FIXTURE/work" show :source.txt)" = 'public source' ]
  [ "$(cat "$FIXTURE/work/source.txt")" = 'public source' ]
  [ "$(git -C "$FIXTURE/work" rev-parse HEAD)" = "$HEAD_SHA" ]
}
