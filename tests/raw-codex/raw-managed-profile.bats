#!/usr/bin/env bats

bats_require_minimum_version 1.5.0
load ../helpers/raw-codex

setup() { PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"; }
teardown() { raw_cleanup; }

raw_managed_profile() {
  python3 - "$RAW_BASE" "$RAW_BASE/home/.codex/config.toml" <<'PY'
import json
from pathlib import Path
import subprocess
import sys

base = Path(sys.argv[1])
home = base / "home"
state = base / "state"
pin = home / ".config/nix-devshell/skills-plugin.json"
receipt = state / "treflebonbon-skills/plugin-sync/receipt.json"
checkout = home / ".cache/treflebonbon-skills/checkouts/revision-fixture"
source = home / ".cache/treflebonbon-skills/marketplaces/revision-fixture"
legacy = state / "treflebonbon-skills/legacy/revision-fixture"
common_dir = Path(subprocess.check_output(
    ["git", "-C", str(base / "work"), "rev-parse", "--path-format=absolute", "--git-common-dir"],
    text=True,
).strip())
host_files = {
    home / ".gitconfig": "[user]\nname = Fixture\n",
    pin: '{"revision":"fixture"}\n',
    receipt: '{"synced":true}\n',
    home / ".config/git/config": "[safe]\ndirectory = fixture\n",
    home / ".config/gh/hosts.yml": "fixture-only: true\n",
}
for path, contents in host_files.items():
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents)
for directory, marker in ((checkout, "checkout"), (source, "source"), (legacy, "legacy")):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "fixture-marker.txt").write_text(marker + "\n")
(home / ".local/bin").mkdir(parents=True, exist_ok=True)
(home / ".local/bin/fixture-tool").write_text("host-only tool\n")

q = lambda value: json.dumps(str(value))
config = f'''model = "gpt-6-luna"
model_reasoning_effort = "xhigh"
model_provider = "isolated"
approval_policy = "on-request"
approvals_reviewer = "auto_review"
default_permissions = "dotfiles-secure"
web_search = "disabled"

[features]
network_proxy = true
shell_snapshot = false

[marketplaces.treflebonbon]
source_type = "local"
source = {q(source)}

[permissions."dotfiles-secure"]
extends = ":workspace"

[permissions."dotfiles-secure".filesystem]
glob_scan_max_depth = 16
":root" = "deny"
":minimal" = "read"
":slash_tmp" = "deny"
"/nix" = "read"
"/nix/store" = "read"
"~/.gitconfig" = "read"
"~/.config/nix-devshell/skills-plugin.json" = "read"
{q(pin)} = "read"
{q(receipt)} = "read"
{q(checkout)} = "read"
{q(source)} = "read"
{q(legacy)} = "read"

[permissions."dotfiles-secure".filesystem.{q(common_dir)}]
"." = "write"
"profile-deny-fixture" = "deny"

[permissions."dotfiles-secure".filesystem.{q(base / "work")}]
"." = "write"
".env" = "deny"
"**/*.key" = "deny"

[permissions."dotfiles-secure".filesystem."~/.local/bin"]
"." = "read"
".env" = "deny"
"*/**/.env" = "deny"

[permissions."dotfiles-secure".filesystem."~/.config/git"]
"." = "read"
".env" = "deny"
"*/**/.env" = "deny"

[permissions."dotfiles-secure".filesystem."~/.config/gh"]
"." = "read"
".env" = "deny"
"*/**/.env" = "deny"

[permissions."dotfiles-secure".filesystem.":workspace_roots"]
"." = "write"
".env" = "deny"
"*/**/.env" = "deny"
"**/*.key" = "deny"
"**/credentials.json" = "deny"

[permissions."dotfiles-secure".filesystem."/tmp/codex"]
"." = "write"
"**/.env" = "deny"
"**/*.key" = "deny"
"**/credentials.json" = "deny"

[permissions."dotfiles-secure".network]
enabled = true

[permissions."dotfiles-secure".network.domains]
"registry.npmjs.org" = "allow"
"**.github.com" = "allow"
"denied.example" = "deny"

[permissions."dotfiles-peer"]
extends = ":workspace"

[permissions."dotfiles-peer".filesystem."~/.codex-peer/gh"]
"." = "read"
".env" = "deny"
'''
Path(sys.argv[2]).write_text(config)
PY
}

raw_managed_profile_rule() {
  python3 - "$RAW_BASE/home/.codex/config.toml" "$1" "$2" <<'PY'
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
contents = path.read_text()
marker = '[permissions."dotfiles-secure".filesystem]\n'
assert marker in contents
contents = contents.replace(
    marker, marker + json.dumps(sys.argv[2]) + " = " + json.dumps(sys.argv[3]) + "\n", 1
)
path.write_text(contents)
PY
}

raw_profile_host_state() {
  python3 - "$RAW_BASE/home" "$RAW_BASE/state/treflebonbon-skills" <<'PY'
import hashlib
import os
from pathlib import Path
import stat
import sys

for root in map(Path, sys.argv[1:]):
    for path in sorted(root.rglob("*")):
        metadata = path.lstat()
        if stat.S_ISREG(metadata.st_mode):
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            mode = stat.S_IMODE(metadata.st_mode)
            print(f"{path.relative_to(root)}\t{mode:o}\t{digest}")
PY
}

raw_profile_workspace_secrets() {
  python3 - "$RAW_BASE/work" <<'PY'
import hashlib
from pathlib import Path
import stat
import sys

root = Path(sys.argv[1])
for name in (".env", "ordinary-looking-name", "nested/.env", "nested/renamed"):
    path = root / name
    metadata = path.lstat()
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    print(f"{name}\t{stat.S_IMODE(metadata.st_mode):o}\t{digest}")
PY
}

@test "home-relative public workspace grants project to an absolute raw path" {
  run python3 - "$PROJECT_ROOT/share/codex-isolation/secret-isolation-worktree.py" "$BATS_TEST_TMPDIR" <<'PY'
import os
import runpy
import sys
import tomllib
from pathlib import Path
from types import SimpleNamespace

module = runpy.run_path(sys.argv[1])
home = Path(sys.argv[2]) / "host-home"
os.environ["HOME"] = str(home)
root = home / "projects/repo"
git_dir = root / ".git/worktrees/task"
common_dir = root / ".git"
repo = SimpleNamespace(root=root, git_dir=git_dir, common_dir=common_dir)
workspace_rules = {".": "write", ".env": "deny", "**/*.key": "deny"}
host_grant = home / ".config/gh"
filesystem = {
    ":root": "deny",
    ":minimal": "read",
    ":slash_tmp": "deny",
    "/tmp/codex": {".": "write", "**/.env": "deny"},
    "~/projects/repo": workspace_rules,
    "~/.config/gh": "read",
    "~/.config/nix-devshell/skills-plugin.json": "read",
    str(home / ".config/nix-devshell/skills-plugin.json"): "read",
    str(common_dir): {".": "write", "profile-deny-fixture": "deny"},
}
projected, private_tmp_codex = module["raw_filesystem_profile"](
    {"filesystem": filesystem}, repo
)
assert private_tmp_codex is True
document = module["toml_document"](
    {"permissions": {"dotfiles-secure": {"filesystem": projected}}}
)
normalized = tomllib.loads(document)["permissions"]["dotfiles-secure"]["filesystem"]
assert normalized[str(root)] == workspace_rules
assert normalized[str(common_dir)]["profile-deny-fixture"] == "deny"
assert "~/projects/repo" not in normalized
assert str(host_grant) not in normalized
assert str(home / ".config/nix-devshell/skills-plugin.json") not in normalized
assert str(Path("/home/agent") / "projects/repo") not in normalized

duplicate = dict(filesystem)
duplicate[str(root)] = {".": "write"}
try:
    module["raw_filesystem_profile"]({"filesystem": duplicate}, repo)
except ValueError as error:
    assert "duplicate normalized path grants" in str(error)
else:
    raise AssertionError("absolute and home-relative aliases were accepted together")
print("HOME_RELATIVE_PUBLIC_GRANT_OK")
PY
  [ "$status" -eq 0 ]
  [[ "$output" == *HOME_RELATIVE_PUBLIC_GRANT_OK* ]]
}

@test "managed host grants project to the raw namespace without exposing host resources" {
  raw_fixture
  mkdir -p "$RAW_BASE/state/treflebonbon-skills/plugin-sync" \
    "$RAW_BASE/state/treflebonbon-skills/legacy"
  raw_managed_profile
  printf 'public fixture\n' >"$RAW_BASE/work/fixture.txt"
  cat >"$RAW_BASE/work/task.sh" <<'TASK'
set -eu
test "$(cat fixture.txt)" = 'public fixture'
test ! -e ordinary-looking-name
secret_contents="$(cat .env 2>/dev/null || true)"
[[ "$secret_contents" != *RAW_DUMMY_SECRET* && "$secret_contents" != *dummy-root-secret* ]]
for path in "$@"; do
  test ! -e "$path"
  test ! -L "$path"
  if cat "$path" >/dev/null 2>&1; then exit 32; fi
done
for path in \
  /home/agent/.gitconfig \
  /home/agent/.config/nix-devshell/skills-plugin.json \
  /home/agent/.cache/treflebonbon-skills/checkouts/revision-fixture \
  /home/agent/.cache/treflebonbon-skills/marketplaces/revision-fixture \
  /home/agent/.local/bin/fixture-tool \
  /home/agent/.config/git/config \
  /home/agent/.config/gh/hosts.yml \
  /home/agent/.codex-peer/gh; do
  test ! -e "$path"
  test ! -L "$path"
done
python3 - "$@" <<'PY'
import sys
import tomllib
from pathlib import Path
import subprocess

raw = Path('/etc/codex/requirements.toml').read_text()
requirements = tomllib.loads(raw)
assert requirements['default_permissions'] == 'dotfiles-secure'
assert requirements['allowed_permission_profiles'] == {'dotfiles-secure': True}
assert set(requirements['permissions']) == {'dotfiles-secure'}
profile = requirements['permissions']['dotfiles-secure']
filesystem = profile['filesystem']
assert profile['extends'] == ':workspace'
assert profile['workspace_roots'] == {}
assert filesystem[':root'] == 'deny'
assert filesystem[':minimal'] == 'read'
assert filesystem[':slash_tmp'] == 'deny'
assert filesystem[':workspace_roots']['.'] == 'write'
assert filesystem[':workspace_roots']['.env'] == 'deny'
assert filesystem[':workspace_roots']['**/*.key'] == 'deny'
assert filesystem[':workspace_roots']['**/credentials.json'] == 'deny'
assert filesystem['/nix'] == 'read'
assert filesystem['/nix/store'] == 'read'
workspace = filesystem[str(Path.cwd())]
assert workspace['.'] == 'write'
assert workspace['.env'] == 'deny'
assert workspace['**/*.key'] == 'deny'
common_dir = subprocess.check_output(
    ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], text=True
).strip()
git_dir = subprocess.check_output(['git', 'rev-parse', '--absolute-git-dir'], text=True).strip()
assert filesystem[common_dir]['.'] == 'write'
assert filesystem[common_dir]['profile-deny-fixture'] == 'deny'
assert filesystem[git_dir] == 'write'
assert filesystem['/tmp/codex']['.'] == 'write'
assert filesystem['/tmp/codex']['**/.env'] == 'deny'
assert filesystem['/tmp/codex']['**/*.key'] == 'deny'
assert profile['network']['enabled'] is True
assert profile['network']['domains']['registry.npmjs.org'] == 'allow'
assert profile['network']['domains']['**.github.com'] == 'allow'
assert profile['network']['domains']['denied.example'] == 'deny'
host_paths = sys.argv[1:]
assert not any(path in raw for path in host_paths[:-1]), host_paths
assert not any(path in filesystem for path in host_paths), host_paths
assert not any(key.startswith('~') for key in filesystem), filesystem
PY
mkdir -p /tmp/codex/raw-profile-evidence
printf 'private isolated evidence\n' >/tmp/codex/raw-profile-evidence/evidence.txt
test "$(cat /tmp/codex/raw-profile-evidence/evidence.txt)" = 'private isolated evidence'
mkdir -p "${10}"
printf 'private namespace write\n' >"${10}/private-write"
test "$(cat "${10}/private-write")" = 'private namespace write'
printf 'updated public fixture\n' >fixture.txt
if printf 'blocked\n' >.env 2>/dev/null; then
  printf 'UNSAFE_WORKSPACE_ENV_WRITE_SUCCEEDED\n'
  exit 33
fi
if printf 'blocked\n' >/nix/store/codex-isolation-policy-probe 2>/dev/null; then
  printf 'UNSAFE_NIX_STORE_WRITE_SUCCEEDED\n'
  exit 34
fi
if printf 'blocked\n' >/etc/codex/requirements.toml 2>/dev/null; then
  printf 'UNSAFE_REQUIREMENTS_WRITE_SUCCEEDED\n'
  exit 35
fi
printf 'RAW_MANAGED_PROFILE_OK\n'
TASK

  local host_paths before after
  host_paths=(
    "$RAW_BASE/home/.gitconfig"
    "$RAW_BASE/home/.config/nix-devshell/skills-plugin.json"
    "$RAW_BASE/state/treflebonbon-skills/plugin-sync/receipt.json"
    "$RAW_BASE/home/.cache/treflebonbon-skills/checkouts/revision-fixture"
    "$RAW_BASE/home/.cache/treflebonbon-skills/marketplaces/revision-fixture"
    "$RAW_BASE/state/treflebonbon-skills/legacy/revision-fixture"
    "$RAW_BASE/home/.local/bin/fixture-tool"
    "$RAW_BASE/home/.config/git/config"
    "$RAW_BASE/home/.config/gh/hosts.yml"
    "$RAW_BASE/state"
  )
  git -C "$RAW_BASE/work" add -- flake.nix task.sh fixture.txt
  git -C "$RAW_BASE/work" commit -qm 'test: managed permission fixture'
  raw_cli trust
  local head receipt
  head="$(git -C "$RAW_BASE/work" rev-parse HEAD)"
  receipt="$RAW_BASE/state/treflebonbon-skills/plugin-sync/receipt.json"

  raw_managed_profile_rule /var/lib/unrecognized-raw-grant read
  run raw_cli admit --git-head "$head" -- flake.nix task.sh fixture.txt
  [ "$status" -ne 0 ]
  [[ "$output" == *'unrecognized namespace grant'* ]]

  raw_managed_profile
  python3 - "$RAW_BASE/home/.codex/config.toml" "$receipt" <<'PY'
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
contents = path.read_text()
rule = json.dumps(sys.argv[2]) + ' = "read"'
assert rule in contents
path.write_text(contents.replace(rule, json.dumps(sys.argv[2]) + ' = "write"', 1))
PY
  run raw_cli admit --git-head "$head" -- flake.nix task.sh fixture.txt
  [ "$status" -ne 0 ]
  [[ "$output" == *'host filesystem grants must be read-only'* ]]

  raw_managed_profile
  python3 - "$RAW_BASE/home/.codex/config.toml" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
contents = path.read_text()
start = '[permissions."dotfiles-secure".filesystem."/tmp/codex"]\n'
end = '\n[permissions."dotfiles-secure".network]\n'
assert start in contents and end in contents
before, rest = contents.split(start, 1)
_, after = rest.split(end, 1)
path.write_text(before + end + after)
PY
  run raw_cli admit --git-head "$head" -- flake.nix task.sh fixture.txt
  [ "$status" -ne 0 ]
  [[ "$output" == *'must allow private /tmp/codex scratch'* ]]

  raw_managed_profile
  run raw_cli admit --git-head "$head" -- flake.nix task.sh fixture.txt
  raw_assert_status 0
  before="$(raw_profile_host_state)"
  before_secrets="$(raw_profile_workspace_secrets)"

  run --separate-stderr raw_run sandbox -- bash task.sh "${host_paths[@]}"

  if [ "$status" -ne 0 ]; then printf '%s\n' "$stderr" >&3; fi
  raw_assert_status 0
  [[ "$output" == *RAW_MANAGED_PROFILE_OK* ]]
  [ "$(cat "$RAW_BASE/work/fixture.txt")" = 'updated public fixture' ]
  after="$(raw_profile_host_state)"
  [ "$after" = "$before" ]
  after_secrets="$(raw_profile_workspace_secrets)"
  [ "$after_secrets" = "$before_secrets" ]
  [ ! -e "$RAW_BASE/state/private-write" ]
  [ "$(cat "$RAW_BASE/work/.env")" = 'RAW_DUMMY_SECRET=dummy-root-secret' ]
}
