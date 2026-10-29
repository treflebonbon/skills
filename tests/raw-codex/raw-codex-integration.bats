#!/usr/bin/env bats

bats_require_minimum_version 1.5.0
load ../helpers/raw-codex

setup() { PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"; }
teardown() {
  raw_cleanup
  if [ -n "${RAW_HOST_TMP:-}" ]; then rm -rf -- "$RAW_HOST_TMP"; fi
}

@test "raw Codex keeps host /tmp private while its isolated TMPDIR remains writable" {
  raw_fixture
  # 並列実行の別ファイルが先に作った場合も、次行で種類と所有者を確かめる。
  mkdir -m 700 /tmp/codex 2>/dev/null || :
  [ -d /tmp/codex ] && [ ! -L /tmp/codex ] && [ -O /tmp/codex ]
  RAW_HOST_TMP="$(mktemp -d /tmp/codex/raw-host.XXXXXX)"
  printf 'host-only\n' >"$RAW_HOST_TMP/public.txt"
  cat >"$RAW_BASE/work/task.sh" <<'TASK'
set -eu
test ! -e "$1/public.txt"
case "$TMPDIR" in /tmp/codex-worktree-*) ;; *) exit 1 ;; esac
file="$(mktemp "$TMPDIR/public.XXXXXX")"
printf 'created\n' >"$file"
test "$(cat "$file")" = created
printf 'updated\n' >"$file"
test "$(cat "$file")" = updated
rm "$file"
test ! -e "$file"
printf 'RAW_TMP_OK\n'
TASK
  raw_admit flake.nix task.sh

  run raw_run sandbox -- bash task.sh "$RAW_HOST_TMP"

  raw_assert_status 0
  [[ "$output" == *RAW_TMP_OK* ]]
  [ "$(cat "$RAW_HOST_TMP/public.txt")" = host-only ]
}

@test "raw return preserves unchanged tracked symlinks and gitlinks without exposing their host contents" {
  raw_fixture
  ln -s .env "$RAW_BASE/work/public-link"
  git -C "$RAW_BASE/work" add public-link
  git -C "$RAW_BASE/work" update-index --add --cacheinfo "160000,$(git -C "$RAW_BASE/work" rev-parse HEAD),vendor"
  mkdir "$RAW_BASE/work/vendor"
  printf 'private-submodule-content\n' > "$RAW_BASE/work/vendor/private.txt"
  printf 'original\n' > "$RAW_BASE/work/source.txt"
  cat > "$RAW_BASE/work/task.sh" <<'TASK'
set -eu
test ! -L public-link
test ! -e public-link
test ! -e vendor
printf 'changed\n' >> source.txt
git add source.txt
git commit -qm 'test: ordinary edit beside unchanged links'
TASK
  raw_admit flake.nix task.sh source.txt
  local linked_entries
  linked_entries="$(git -C "$RAW_BASE/work" ls-files --stage -- public-link vendor)"
  run raw_run sandbox -- bash task.sh
  raw_assert_status 0
  [ "$(cat "$RAW_BASE/work/source.txt")" = $'original\nchanged' ]
  [ "$(readlink "$RAW_BASE/work/public-link")" = .env ]
  [ "$(cat "$RAW_BASE/work/vendor/private.txt")" = private-submodule-content ]
  [ "$(git -C "$RAW_BASE/work" ls-files --stage -- public-link vendor)" = "$linked_entries" ]
  git -C "$RAW_BASE/work" diff --exit-code HEAD -- source.txt
  run raw_run sandbox -- true
  raw_assert_status 0
  [ "$(git -C "$RAW_BASE/work" ls-files --stage -- public-link vendor)" = "$linked_entries" ]
  git -C "$RAW_BASE/work" diff --cached --exit-code -- public-link vendor
}

raw_reject_linked_result() {
  local mode="$1" existing="$2" phase="$3" head index_tree
  raw_fixture
  printf 'original\n' > "$RAW_BASE/work/source.txt"
  if [ "$existing" = yes ]; then
    if [ "$mode" = 120000 ]; then
      ln -s .env "$RAW_BASE/work/linked"
      git -C "$RAW_BASE/work" add linked
    else
      git -C "$RAW_BASE/work" update-index --add --cacheinfo "160000,$(git -C "$RAW_BASE/work" rev-parse HEAD),linked"
    fi
  fi
  raw_admit flake.nix task.sh source.txt
  head="$(git -C "$RAW_BASE/work" rev-parse HEAD)"
  index_tree="$(git -C "$RAW_BASE/work" write-tree)"
  run raw_run sandbox -- bash -c '
    set -eu
    printf "changed\n" > source.txt
    git add source.txt
    if [ "$1" = 120000 ]; then
      ln -s different-target linked
      git add linked
    else
      git update-index --add --cacheinfo "160000,$(git rev-parse HEAD),linked"
    fi
    if [ "$2" = committed ]; then git commit -qm "test: linked output"; fi
  ' _ "$mode" "$phase"
  raw_assert_status 1
  [[ "$output" == *'result tree contains a new or changed linked or unsupported file'* ]]
  [ "$(git -C "$RAW_BASE/work" rev-parse HEAD)" = "$head" ]
  [ "$(git -C "$RAW_BASE/work" write-tree)" = "$index_tree" ]
  [ "$(cat "$RAW_BASE/work/source.txt")" = original ]
  if [ "$existing" = yes ] && [ "$mode" = 120000 ]; then
    [ "$(readlink "$RAW_BASE/work/linked")" = .env ]
  else
    [ ! -e "$RAW_BASE/work/linked" ]
    [ ! -L "$RAW_BASE/work/linked" ]
  fi
}

@test "raw return rejects a newly staged symlink before publishing any result" {
  raw_reject_linked_result 120000 no staged
}

@test "raw return rejects a changed committed symlink before publishing any result" {
  raw_reject_linked_result 120000 yes committed
}

@test "raw return rejects a newly committed gitlink before publishing any result" {
  raw_reject_linked_result 160000 no committed
}

@test "raw return rejects a changed staged gitlink before publishing any result" {
  raw_reject_linked_result 160000 yes staged
}

@test "raw commits succeed when host signing is enabled without changing host signing configuration" {
  raw_fixture
  cat > "$RAW_BASE/work/task.sh" <<'TASK'
set -eu
printf 'committed without host signing credentials\n' > result.txt
git add result.txt
git commit -qm 'test: commit with host signing enabled'
TASK
  raw_admit flake.nix task.sh
  git -C "$RAW_BASE/work" config commit.gpgsign true
  raw_cli admit --git-head "$(git -C "$RAW_BASE/work" rev-parse HEAD)" -- flake.nix task.sh
  run raw_run sandbox -- bash task.sh
  raw_assert_status 0
  [ "$(git -C "$RAW_BASE/work" config --get commit.gpgsign)" = true ]
  [ "$(git -C "$RAW_BASE/work" show HEAD:result.txt)" = 'committed without host signing credentials' ]
  [ "$(git -C "$RAW_BASE/work" log -1 --format='%an <%ae>')" = 'Fixture <fixture@example.invalid>' ]
  [ "$(git -C "$RAW_BASE/work" log -1 --format=%G?)" = N ]
}

@test "raw Codex refuses project configuration that conflicts with the immutable standard profile" {
  raw_fixture
  mkdir "$RAW_BASE/work/.codex"
  cat > "$RAW_BASE/work/.codex/config.toml" <<'TOML'
default_permissions = "dotfiles-secure"
[permissions.dotfiles-secure]
extends = ":workspace"
[permissions.dotfiles-secure.filesystem]
":root" = "write"
[features]
network_proxy = false
TOML
  # Trust the fixture so Codex really loads the conflicting project layer.
  printf '\n[projects."%s"]\ntrust_level="trusted"\n' "$RAW_BASE/work" >> "$RAW_BASE/home/.codex/config.toml"
  raw_admit flake.nix task.sh .codex/config.toml
  run raw_run sandbox -- touch launched
  raw_assert_status 1
  [[ "$output" == *'conflicts with a config-defined profile'* ]]
  [ ! -e "$RAW_BASE/work/launched" ]
}

@test "explicit model and decoded effort reach isolated Codex while trust and required policy remain fixed" {
  raw_fixture
  # No model request is made: exercise the same real config RPC as TUI onboarding.
  printf '{"tokens":{"access_token":"dummy-unused","account_id":"dummy-unused"}}\n' > "$RAW_BASE/home/.codex/auth.json"
  raw_admit flake.nix task.sh
  run python3 - "$RAW_BASE" <<'PY'
import json, os, select, subprocess, sys, time
from pathlib import Path
base = Path(sys.argv[1])
host_config = (base / 'home/.codex/config.toml').read_bytes()
environment = os.environ | {'HOME': str(base / 'home'), 'CODEX_HOME': str(base / 'home/.codex'), 'XDG_STATE_HOME': str(base / 'state')}
with (base / 'config-rpc.log').open('w') as log:
    process = subprocess.Popen([str(base / 'bin/codex-worktree'), '--config=model_reasoning_effort="xh\\u0069gh"', 'app-server'], cwd=base / 'work', env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
    pending = bytearray()
    def rpc(identifier, method, params):
        process.stdin.write((json.dumps({'id': identifier, 'method': method, 'params': params}) + '\n').encode())
        process.stdin.flush()
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if b'\n' not in pending:
                if not select.select([process.stdout], [], [], 1)[0]:
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                assert chunk, (base / 'config-rpc.log').read_text()
                pending.extend(chunk)
            while b'\n' in pending:
                line, _, remaining = pending.partition(b'\n')
                pending[:] = remaining
                if not line.startswith(b'{'):
                    continue
                response = json.loads(line)
                if response.get('id') == identifier:
                    return response
        raise AssertionError('raw app-server response timed out')
    try:
        assert 'result' in rpc(1, 'initialize', {'clientInfo': {'name': 'raw-trust-test', 'version': '1'}, 'capabilities': {'experimentalApi': True}})
        key = 'projects.' + json.dumps(str(base / 'repo')) + '.trust_level'
        response = rpc(2, 'config/batchWrite', {'edits': [{'keyPath': key, 'value': 'trusted', 'mergeStrategy': 'replace'}], 'reloadUserConfig': True})
        assert 'result' in response, response
        response = rpc(3, 'config/read', {'includeLayers': False})
        config = response['result']['config']
        assert config['projects'][str(base / 'repo')]['trust_level'] == 'trusted'
        assert config['model_reasoning_effort'] == 'xhigh'
        assert config['default_permissions'] == 'dotfiles-secure'
        assert config['model_provider'] == 'isolated'
        assert config['model_providers']['isolated']['base_url'] == 'http://127.0.0.1:8123/v1'
        assert config['features']['network_proxy'] is True
        assert config['approval_policy'] == 'on-request'
        assert config['approvals_reviewer'] == 'auto_review'
        started = rpc(6, 'thread/start', {'cwd': str(base / 'work'), 'model': 'gpt-6-luna'})['result']
        assert (started['model'], started['reasoningEffort'], started['modelProvider'], started['cwd']) == ('gpt-6-luna', 'xhigh', 'isolated', str(base / 'work'))
        response = rpc(4, 'config/batchWrite', {'edits': [{'keyPath': 'permissions.dotfiles-secure', 'value': {'extends': ':workspace', 'filesystem': {':root': 'write'}}, 'mergeStrategy': 'replace'}], 'reloadUserConfig': True})
        assert 'result' in response, response
        checked = rpc(5, 'config/read', {'includeLayers': False})
        assert 'conflicts with a config-defined profile' in checked.get('error', {}).get('message', ''), 'onboarding config write replaced the required profile'
        assert (base / 'home/.codex/config.toml').read_bytes() == host_config
        log.flush()
        session = Path(next(line.split('isolated session ', 1)[1].strip() for line in (base / 'config-rpc.log').read_text().splitlines() if 'isolated session ' in line))
        assert session.is_relative_to(base / 'state/devshell-env/sessions')
        assert not (session / 'config/auth.json').exists()
        # 独自 cleanup patch の撤去後は Codex が空の mask を残し得る（ADR-0045 2026-10-23）。秘密値の持込みだけを拒否する。
        dotenv = session / 'root' / str(base / 'work').lstrip('/') / '.env'
        assert not dotenv.is_symlink() and (not dotenv.exists() or (dotenv.is_file() and dotenv.stat().st_size == 0)), dotenv
        print('SESSION_TRUST_SAVED_POLICY_FIXED')
    finally:
        process.stdin.close()
        process.wait(timeout=30)
PY
  raw_assert_status 0
  [[ "$output" == *SESSION_TRUST_SAVED_POLICY_FIXED* ]]
}

@test "raw input admission and startup reject changed, linked and newly added secret inputs" {
  raw_fixture
  raw_admit flake.nix task.sh
  mv "$RAW_BASE/work/task.sh" "$RAW_BASE/task-original"
  ln -s .env "$RAW_BASE/work/task.sh"
  run raw_run sandbox -- true
  raw_assert_status 1
  mv "$RAW_BASE/work/task.sh" "$RAW_BASE/rejected-link"
  ln "$RAW_BASE/work/.env" "$RAW_BASE/work/task.sh"
  run raw_run sandbox -- true
  raw_assert_status 1
  mv "$RAW_BASE/work/task.sh" "$RAW_BASE/rejected-hardlink"
  cp "$RAW_BASE/work/.env" "$RAW_BASE/work/task.sh"
  run raw_run sandbox -- true
  raw_assert_status 1
  [[ "$output" != *dummy-root-secret* ]]
  mv "$RAW_BASE/work/task.sh" "$RAW_BASE/rejected-replacement"
  mv "$RAW_BASE/task-original" "$RAW_BASE/work/task.sh"
  printf dummy-late-secret > "$RAW_BASE/work/late.txt"
  run raw_run sandbox -- bash -c 'test ! -e late.txt; test -z "$(cat .env 2>/dev/null || true)"'
  raw_assert_status 0
}

@test "raw dependency initialization and the managed Codex proxy use the selected domain gateway" {
  [ "${SECRET_ISOLATION_REAL_DEPENDENCIES:-0}" = 1 ] || skip "opt in with SECRET_ISOLATION_REAL_DEPENDENCIES=1; downloads pinned public nixpkgs and hello"
  raw_fixture
  local revision
  revision="$(cat "$PROJECT_ROOT/tests/fixtures/raw-codex/nixpkgs-revision")"
  cat > "$RAW_BASE/work/flake.nix" <<EOF
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/$revision";
  outputs = { nixpkgs, ... }: { devShells.x86_64-linux.default =
    let pkgs = import nixpkgs { system = "x86_64-linux"; }; in pkgs.mkShell {
      packages = [ pkgs.hello ];
      shellHook = "hello > initialized.txt";
    };
  };
}
EOF
  cat > "$RAW_BASE/work/task.sh" <<'TASK'
set -eu
hello
python3 - <<'PY'
import os,urllib.request,urllib.error
assert os.environ.get('CODEX_NETWORK_PROXY_ACTIVE')
with urllib.request.urlopen('https://cache.nixos.org/nix-cache-info',timeout=30) as response:
    assert b'StoreDir: /nix/store' in response.read()
try:
    urllib.request.urlopen('https://example.com/',timeout=10)
except (urllib.error.URLError, OSError):
    pass
else:
    raise AssertionError('unapproved network destination was reachable')
print('RAW_NETWORK_OK')
PY
TASK
  raw_admit flake.nix task.sh
  run raw_run sandbox -- bash task.sh
  raw_assert_status 0
  [[ "$output" == *RAW_NETWORK_OK* ]]
  [ -s "$RAW_BASE/work/initialized.txt" ]
}

@test "the common raw entry uses the existing host model login to edit, test and commit inside isolation" {
  [ "${SECRET_ISOLATION_REAL_MODEL:-0}" = 1 ] || skip "opt in with SECRET_ISOLATION_REAL_MODEL=1; uses the existing ChatGPT login"
  local host_codex_home="${CODEX_HOME:-$HOME/.codex}"
  raw_fixture
  ln -s "$host_codex_home/auth.json" "$RAW_BASE/home/.codex/auth.json"
  cat > "$RAW_BASE/work/task.sh" <<'TASK'
set -eu
test -z "${RAW_DUMMY_SECRET+x}"
for path in .env ordinary-looking-name nested/.env nested/renamed ../repo/.env /home/agent/.codex/auth.json; do test -z "$(cat "$path" 2>/dev/null || true)"; done
with-env --prepared -- bash -c 'test -z "${RAW_DUMMY_SECRET+x}"'
printf 'def add(a, b): return a + b\n' > calculator.py
python3 -c 'from calculator import add; assert add(2,3) == 5'
git add calculator.py
git commit -qm 'test: real raw Codex calculation'
printf HOSTED_RAW_TASK_OK
TASK
  raw_admit flake.nix task.sh
  export RAW_DUMMY_SECRET=dummy-inherited-secret
  run python3 "$PROJECT_ROOT/tests/helpers/raw-codex-handoff.py" "$RAW_BASE"
  raw_assert_status 0
  [[ "$output" == *HOSTED_RAW_TASK_OK* && "$output" == *HOSTED_RAW_OK* ]]
  [ -f "$RAW_BASE/work/calculator.py" ]
  [ "$(git -C "$RAW_BASE/work" log -1 --format=%s)" = 'test: real raw Codex calculation' ]
  [[ "$output" != *dummy-inherited-secret* && "$output" != *dummy-root-secret* ]]
}

@test "host replacements and additions after startup cannot enter the running raw session" {
  raw_fixture
  printf 'public source\n' > "$RAW_BASE/work/data.txt"
  cat > "$RAW_BASE/work/task.sh" <<'TASK'
set -eu
printf 'LIVE_READY\n'
sleep 2
test "$(cat data.txt)" = 'public source'
test ! -e late.txt
printf 'LIVE_BOUNDARY_OK\n'
TASK
  raw_admit flake.nix task.sh data.txt
  run python3 - "$RAW_BASE" <<'PY'
import os,subprocess,sys
from pathlib import Path
base=Path(sys.argv[1])
env=os.environ|{'HOME':str(base/'home'),'CODEX_HOME':str(base/'home/.codex'),'XDG_STATE_HOME':str(base/'state')}
process=subprocess.Popen([str(base/'bin/codex-worktree'),'sandbox','--','bash','task.sh'],cwd=base/'work',env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
lines=[]
for line in process.stdout:
    lines.append(line)
    if line.strip()=='LIVE_READY':
        (base/'work/data.txt').write_text('dummy-late-replacement')
        (base/'work/late.txt').write_text('dummy-late-addition')
status=process.wait(timeout=30)
output=''.join(lines)
assert status!=0 and 'LIVE_BOUNDARY_OK' in output,output
assert 'host input changed' in output,output
assert 'dummy-late' not in output
assert (base/'work/data.txt').read_text()=='dummy-late-replacement'
print('live snapshot and host conflict checks passed')
PY
  raw_assert_status 0
}

@test "the installed entry ignores inherited shell and Python startup code before isolation" {
  raw_fixture
  raw_admit flake.nix task.sh
  mkdir "$RAW_BASE/startup"
  printf 'touch "%s"\n' "$RAW_BASE/shell-started" > "$RAW_BASE/startup/bash-env"
  printf 'from pathlib import Path\nPath("%s").touch()\n' "$RAW_BASE/python-started" > "$RAW_BASE/startup/sitecustomize.py"
  cd "$RAW_BASE/work"
  run env HOME="$RAW_BASE/home" CODEX_HOME="$RAW_BASE/home/.codex" XDG_STATE_HOME="$RAW_BASE/state" \
    BASH_ENV="$RAW_BASE/startup/bash-env" PYTHONPATH="$RAW_BASE/startup" \
    "$RAW_BASE/bin/codex-worktree" --version
  raw_assert_status 0
  [ ! -e "$RAW_BASE/shell-started" ]
  [ ! -e "$RAW_BASE/python-started" ]
}
