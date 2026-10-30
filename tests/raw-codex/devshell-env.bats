#!/usr/bin/env bats

bats_require_minimum_version 1.5.0
load ../helpers/raw-codex

teardown() { raw_cleanup; }

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  CLI="$PROJECT_ROOT/bin/devshell-env"
  export CODEX_CONFIG_READER_FIXTURE="$PROJECT_ROOT/tests/helpers/codex-config-reader.py"
  FIXTURE="$BATS_TEST_TMPDIR/fixture"
  mkdir -p "$FIXTURE/bin" "$FIXTURE/home"
  ADAPTER="$FIXTURE/bin/codex-worktree"
  cp "$PROJECT_ROOT/bin/codex-worktree" "$ADAPTER"
  git init -q "$FIXTURE/repo"
  git -C "$FIXTURE/repo" -c user.name=Test -c user.email=test@example.com \
    commit --allow-empty -qm 'test: initialize repository'
  git -C "$FIXTURE/repo" worktree add -qb task "$FIXTURE/worktree"
  ln -s "$CLI" "$FIXTURE/bin/devshell-env"
}

cli() {
  env HOME="$FIXTURE/home" XDG_STATE_HOME="$FIXTURE/state" \
    PATH="$FIXTURE/bin:$PATH" "$CLI" "$@"
}

adapter() {
  env HOME="$FIXTURE/home" XDG_STATE_HOME="$FIXTURE/state" \
    PATH="$FIXTURE/bin:$PATH" bash -c 'cd "$1"; shift; exec "$@"' \
    _ "$FIXTURE/worktree" "$ADAPTER" "$@"
}

install_runtime_fixture() {
  cat >"$FIXTURE/bin/nix" <<EOF
#!/bin/bash
printf '%s\\n' "\$@" >> '$FIXTURE/nix-calls'
cat '$FIXTURE/nix-env'
printf '\\neval "\${shellHook:-}"\\n'
EOF
  cat >"$FIXTURE/nix-env" <<EOF
export PATH='$FIXTURE/tools:/path-not-set'
export PROJECT_255=from-flake
shellHook='export HOOK_255=from-hook'
EOF
  mkdir -p "$FIXTURE/tools"
  cat >"$FIXTURE/tools/project-tool" <<'EOF'
#!/bin/bash
printf 'tool=%s/%s\n' "$PROJECT_255" "$HOOK_255"
EOF
  cat >"$FIXTURE/bin/codex" <<'EOF'
#!/bin/bash
project-tool
printf 'arg=<%s>\n' "$@"
exit 23
EOF
  chmod +x "$FIXTURE/bin/nix" "$FIXTURE/bin/codex" "$FIXTURE/tools/project-tool"
  touch "$FIXTURE/worktree/flake.nix"
}

@test "trusted raw Codex receives real devShell variables and preserves command argv and exit code" {
  raw_fixture
  cat > "$RAW_BASE/work/task.sh" <<'SH'
set -eu
test "$PUBLIC_VAR/$HOOK_VAR" = normal/ready
printf 'arg=<%s>\n' "$@"
exit 23
SH
  raw_admit flake.nix task.sh
  run raw_run sandbox -- bash task.sh 'model with spaces' 'prompt with spaces'
  raw_assert_status 23
  [[ "$output" == *'arg=<model with spaces>'* && "$output" == *'arg=<prompt with spaces>'* ]]
}

@test "trust follows a repository's linked worktrees and untrust revokes it" {
  run cli status "$FIXTURE/worktree"
  [ "$status" -eq 0 ]
  [[ "$output" == *"untrusted"* ]]

  run cli trust "$FIXTURE/repo"
  [ "$status" -eq 0 ]
  run cli status "$FIXTURE/worktree"
  [ "$status" -eq 0 ]
  [[ "$output" == *"trusted"* && "$output" != *"untrusted"* ]]

  run cli untrust "$FIXTURE/worktree"
  [ "$status" -eq 0 ]
  run cli status "$FIXTURE/repo"
  [[ "$output" == *"untrusted"* ]]
  [ -z "$(git -C "$FIXTURE/repo" status --porcelain)" ]
  [ -z "$(git -C "$FIXTURE/worktree" status --porcelain)" ]
}

@test "untrusted, revoked and flake-free worktrees refuse startup before initialization" {
  raw_fixture
  run raw_run sandbox -- true
  raw_assert_status 1
  [[ "$output" == *untrusted* ]]
  raw_cli trust
  raw_cli untrust
  run raw_run sandbox -- true
  raw_assert_status 1
  [[ "$output" == *untrusted* ]]
  raw_cli trust
  mv "$RAW_BASE/work/flake.nix" "$RAW_BASE/work/absent.nix"
  run raw_run sandbox -- true
  raw_assert_status 1
  [[ "$output" == *'no flake.nix'* ]]
  [ ! -e "$RAW_BASE/state/devshell-env/sessions" ]
}

@test "untrusted worktrees cannot shadow the installed helper through inherited PATH" {
  raw_fixture
  printf '#!/bin/bash\ntouch "%s"\n' "$RAW_BASE/shadow" > "$RAW_BASE/work/devshell-env"
  chmod +x "$RAW_BASE/work/devshell-env"
  run env PATH="$RAW_BASE/work:$PATH" HOME="$RAW_BASE/home" XDG_STATE_HOME="$RAW_BASE/state" \
    bash -c 'cd "$1"; exec "$2"' _ "$RAW_BASE/work" "$RAW_BASE/bin/codex-worktree"
  raw_assert_status 1
  [[ "$output" == *untrusted* ]]
  [ ! -e "$RAW_BASE/shadow" ]
}

@test "a missing sibling helper fails closed instead of falling back to PATH" {
  install_runtime_fixture
  mkdir "$FIXTURE/incomplete install"
  cp "$ADAPTER" "$FIXTURE/incomplete install/codex-worktree"
  cat >"$FIXTURE/bin/codex" <<EOF
#!/bin/bash
touch '$FIXTURE/launched'
EOF
  ADAPTER="$FIXTURE/incomplete install/codex-worktree"

  run -127 adapter

  [[ "$output" == *"$FIXTURE/incomplete install/devshell-env"* ]]
  [ ! -e "$FIXTURE/launched" ]
  [ ! -e "$FIXTURE/nix-calls" ]
}

@test "trust rejects forged membership, symlink pointers and unresolved metadata but accepts physical aliases" {
  cli trust "$FIXTURE/repo"
  ln -s "$FIXTURE/worktree" "$FIXTURE/alias"
  run cli status "$FIXTURE/alias"
  [ "$status" -eq 0 ]
  [[ "$output" != *"untrusted"* ]]
  mkdir "$FIXTURE/forged"
  cp "$FIXTURE/worktree/.git" "$FIXTURE/forged/.git"
  run cli status "$FIXTURE/forged"
  [ "$status" -ne 0 ]
  mv "$FIXTURE/forged/.git" "$FIXTURE/saved-pointer"
  ln -s "$FIXTURE/worktree/.git" "$FIXTURE/forged/.git"
  run cli trust "$FIXTURE/forged"
  [ "$status" -ne 0 ]
  mv "$FIXTURE/repo/.git/worktrees" "$FIXTURE/repo/.git/unresolved"
  run cli status "$FIXTURE/worktree"
  [ "$status" -ne 0 ]
}

@test "another clone and a replaced common directory do not inherit registration" {
  cli trust "$FIXTURE/repo"
  git clone -q "$FIXTURE/repo" "$FIXTURE/clone"
  run cli status "$FIXTURE/clone"
  [[ "$output" == *"untrusted"* ]]
  mv "$FIXTURE/repo/.git" "$FIXTURE/old-git"
  cp -a "$FIXTURE/old-git" "$FIXTURE/repo/.git"
  run cli status "$FIXTURE/worktree"
  [ "$status" -eq 0 ]
  [[ "$output" == *"untrusted"* ]]
}

@test "trust refuses to store registration inside a repository" {
  run env XDG_STATE_HOME="$FIXTURE/worktree/state" "$CLI" trust "$FIXTURE/worktree"
  [ "$status" -ne 0 ]
  [[ "$output" == *"outside repositories"* ]]
  [ ! -e "$FIXTURE/worktree/state" ]
}

@test "Nix and shellHook failures refuse Codex and retain the isolated session for recovery" {
  raw_fixture
  printf '{ outputs = _: throw "public evaluation failure"; }\n' > "$RAW_BASE/work/flake.nix"
  raw_admit flake.nix task.sh
  run raw_run sandbox -- touch launched
  raw_assert_status 1
  [[ "$output" == *'Nix preparation failed'* ]]
  [ ! -e "$RAW_BASE/work/launched" ]
  raw_flake
  sed -i 's/export HOOK_VAR=ready/export PARTIAL=bad; exit 41/' "$RAW_BASE/work/flake.nix"
  raw_admit flake.nix task.sh
  run raw_run sandbox -- touch launched
  raw_assert_status 1
  [[ "$output" == *'shellHook preparation failed (41)'* ]]
  [ ! -e "$RAW_BASE/work/launched" ]
  ! find "$RAW_BASE/state" -name codex-started -print | rg .
}

@test "Nix initialization cannot replace Codex, policy, working root or active Git ownership" {
  raw_fixture
  sed -i 's/export HOOK_VAR=ready/source .\/hook.sh; export HOOK_VAR=ready/' "$RAW_BASE/work/flake.nix"
  cat > "$RAW_BASE/work/hook.sh" <<'SH'
mkdir -p fake-bin
printf '#!/bin/bash\ntouch fake-codex-ran\nexit 97\n' > fake-bin/codex
chmod +x fake-bin/codex
export PATH="$PWD/fake-bin:$PATH"
export LD_LIBRARY_PATH="$PWD/fake-libraries"
export CODEX_HOME=/tmp/evil
export GIT_DIR=/tmp/evil
SH
  cat > "$RAW_BASE/work/task.sh" <<'SH'
set -eu
test "$CODEX_HOME" = /home/agent/.codex
test -z "${GIT_DIR+x}"
test -z "${LD_LIBRARY_PATH+x}"
test -f fake-bin/codex
test ! -e fake-codex-ran
test -f flake.nix
if printf changed >> /nix/codex-isolation/share/codex-isolation/codex-inner.py 2>/dev/null; then exit 1; fi
if printf changed >> /etc/codex/requirements.toml 2>/dev/null; then exit 1; fi
printf POLICY_FIXED
SH
  raw_admit flake.nix task.sh hook.sh
  run raw_run sandbox -- bash task.sh
  raw_assert_status 0
  [[ "$output" == *POLICY_FIXED* ]]
}

@test "WSL and explicit output selection stay fixed while normal devShell tools remain usable" {
  raw_fixture
  raw_flake wsl
  touch "$RAW_BASE/work/.wsl-browser-free"
  raw_admit flake.nix task.sh .wsl-browser-free
  export WSL_DISTRO_NAME=Fixture
  run raw_run sandbox -- bash -c 'test "$PUBLIC_VAR/$HOOK_VAR" = normal/ready'
  raw_assert_status 0
  [[ "$output" == *'#wsl'* ]]
  raw_flake custom
  raw_admit flake.nix task.sh .wsl-browser-free hook-calls
  export DEVSHELL_ENV_OUTPUT=custom
  run raw_run sandbox -- bash -c 'test "$PUBLIC_VAR/$HOOK_VAR" = normal/ready'
  raw_assert_status 0
  [[ "$output" == *'#custom'* ]]
}

@test "first store initialization and restart run the changed shellHook once and never execute envrc" {
  raw_fixture
  printf 'touch envrc-executed\n' > "$RAW_BASE/work/.envrc"
  raw_admit flake.nix task.sh .envrc
  run raw_run sandbox -- true
  raw_assert_status 0
  [ "$(wc -l < "$RAW_BASE/work/hook-calls")" -eq 1 ]
  [ ! -e "$RAW_BASE/work/envrc-executed" ]
  sed -i 's/HOOK_VAR=ready/HOOK_VAR=changed/' "$RAW_BASE/work/flake.nix"
  run raw_run sandbox -- true
  raw_assert_status 1
  [[ "$output" == *'changed since approval'* ]]
  raw_admit flake.nix task.sh .envrc hook-calls
  run raw_run sandbox -- bash -c 'test "$HOOK_VAR" = changed'
  raw_assert_status 0
  [ "$(wc -l < "$RAW_BASE/work/hook-calls")" -eq 2 ]
}

@test "inherited and unadmitted file secrets never reach initialization, Codex or child commands" {
  raw_fixture
  cat > "$RAW_BASE/work/task.sh" <<'SH'
set -eu
test -z "${RAW_DUMMY_SECRET+x}"
for path in .env ordinary-looking-name nested/.env nested/renamed ../repo/.env; do test -z "$(cat "$path" 2>/dev/null || true)"; done
test ! -e /nix/var/nix/daemon-socket/socket
test -z "$(cat /home/agent/.codex/auth.json 2>/dev/null || true)"
with-env --prepared -- bash -c 'test -z "${RAW_DUMMY_SECRET+x}"; test -z "$(cat .env 2>/dev/null || true)"'
printf SECRETS_ABSENT
SH
  raw_admit flake.nix task.sh
  export RAW_DUMMY_SECRET=dummy-inherited-secret
  run raw_run sandbox -- bash task.sh
  raw_assert_status 0
  [[ "$output" == *SECRETS_ABSENT* ]]
  ! rg -a -q 'dummy-inherited-secret|dummy-root-secret|dummy-renamed-secret' "$RAW_BASE/state"
}

@test "raw public input admission rejects invalid managed permission configuration" {
  raw_fixture
  printf 'invalid configuration\n' > "$RAW_BASE/home/.codex/config.toml"
  run raw_cli admit --git-head "$(git -C "$RAW_BASE/work" rev-parse HEAD)" -- flake.nix
  raw_assert_status 1
  [ ! -e "$RAW_BASE/state/devshell-env/sessions" ]
}

@test "metadata changed by initialization refuses Codex without changing host ownership" {
  raw_fixture
  sed -i 's/export HOOK_VAR=ready/printf bad > .git/' "$RAW_BASE/work/flake.nix"
  raw_admit flake.nix task.sh
  run raw_run sandbox -- touch launched
  raw_assert_status 1
  [[ "$output" == *'initialization incomplete'* ]]
  [ ! -e "$RAW_BASE/work/launched" ]
  git -C "$RAW_BASE/work" rev-parse --git-common-dir
}

@test "invalid launch arguments are rejected before a trusted flake is evaluated" {
  raw_fixture
  raw_cli trust
  run raw_run --add-dir /tmp
  raw_assert_status 1
  [[ "$output" == *'runtime boundary'* ]]
  [ ! -e "$RAW_BASE/state/devshell-env/sessions" ]
}

@test "ordinary devShell search paths reach Codex while host runtime state stays outside" {
  raw_fixture
  sed -i 's/export HOOK_VAR=ready/export XDG_DATA_DIRS=\/nix\/public-data; export XDG_STATE_HOME=\/tmp\/evil; export HOOK_VAR=ready/' "$RAW_BASE/work/flake.nix"
  raw_admit flake.nix task.sh
  export XDG_CACHE_HOME="$RAW_BASE/host-cache"
  run raw_run sandbox -- bash -c 'test "$XDG_DATA_DIRS" = /nix/public-data; test -z "${XDG_CACHE_HOME+x}"; test -z "${XDG_STATE_HOME+x}"'
  raw_assert_status 0
}

@test "a project-relative Codex executable is refused before any project code runs" {
  raw_fixture
  raw_cli trust
  printf '#!/bin/bash\ntouch "%s"\n' "$RAW_BASE/shadow" > "$RAW_BASE/work/codex"
  chmod +x "$RAW_BASE/work/codex"
  run env PATH=".:$PATH" HOME="$RAW_BASE/home" XDG_STATE_HOME="$RAW_BASE/state" \
    bash -c 'cd "$1"; exec "$2"' _ "$RAW_BASE/work" "$RAW_BASE/bin/codex-worktree"
  raw_assert_status 1
  [[ "$output" == *'Nix store: codex'* ]]
  [ ! -e "$RAW_BASE/shadow" ]
}

@test "real Nix and Codex preserve normal worktree edits and the same stage and commit result" {
  raw_fixture
  cat > "$RAW_BASE/work/task.sh" <<'SH'
set -eu
printf 'def add(a, b): return a + b\n' > calculator.py
python3 -c 'from calculator import add; assert add(2,3) == 5'
git add calculator.py
git commit -qm 'test: raw isolated calculation'
git rev-parse HEAD
SH
  raw_admit flake.nix task.sh
  run raw_run sandbox -- bash task.sh
  raw_assert_status 0
  local head
  head="$(git -C "$RAW_BASE/work" rev-parse HEAD)"
  [[ "$output" == *"$head"* ]]
  [ "$(git -C "$RAW_BASE/work" log -1 --format=%s)" = 'test: raw isolated calculation' ]
  [ -f "$RAW_BASE/work/calculator.py" ]
}
