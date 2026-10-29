# Real public raw entry fixtures. Only dummy, explicitly enumerated inputs enter.
raw_fixture() {
  RAW_BASE="$BATS_TEST_TMPDIR/raw"
  mkdir -p "$RAW_BASE/home/.codex" "$RAW_BASE/bin"
  git init -q "$RAW_BASE/repo"
  git -C "$RAW_BASE/repo" config user.name Fixture
  git -C "$RAW_BASE/repo" config user.email fixture@example.invalid
  git -C "$RAW_BASE/repo" commit --allow-empty -qm 'test: baseline'
  git -C "$RAW_BASE/repo" worktree add -qb task "$RAW_BASE/work"
  cp "$PROJECT_ROOT/bin/codex-worktree" "$RAW_BASE/bin/codex-worktree"
  chmod +x "$RAW_BASE/bin/codex-worktree"
  ln -s "$PROJECT_ROOT/bin/devshell-env" "$RAW_BASE/bin/devshell-env"
  cp "$PROJECT_ROOT/tests/fixtures/raw-codex/config.toml" "$RAW_BASE/home/.codex/config.toml"
  RAW_CA="${CODEX_ISOLATION_CA_BUNDLE:-${NIX_SSL_CERT_FILE:-${SSL_CERT_FILE:-}}}"
  [ -f "$RAW_CA" ]
  raw_flake
  printf 'RAW_DUMMY_SECRET=dummy-root-secret\n' >"$RAW_BASE/work/.env"
  printf 'dummy-renamed-secret\n' >"$RAW_BASE/work/ordinary-looking-name"
  printf 'dummy-other-worktree-secret\n' >"$RAW_BASE/repo/.env"
  mkdir "$RAW_BASE/work/nested"
  cp "$RAW_BASE/work/.env" "$RAW_BASE/work/nested/.env"
  cp "$RAW_BASE/work/.env" "$RAW_BASE/work/nested/renamed"
  printf 'test -z "${RAW_DUMMY_SECRET+x}"\n' >"$RAW_BASE/work/task.sh"
}

raw_flake() {
  python3 - "$RAW_BASE/work/flake.nix" "${1:-default}" <<'PY'
import json, shutil, sys
from pathlib import Path
bash = Path(shutil.which('bash')).resolve().parents[1]
utils = Path(shutil.which('cat')).resolve().parents[1]
hook = 'test -z "${RAW_DUMMY_SECRET+x}"; test ! -e .env; test ! -e ordinary-looking-name; printf "run\\n" >> hook-calls; export HOOK_VAR=ready'
Path(sys.argv[1]).write_text('''{ outputs = { self }: { devShells.x86_64-linux.%s = builtins.derivation {
 name = "raw-test"; system = "x86_64-linux"; builder = "%s/bin/bash"; args = [ "-c" "exit 0" ];
 outputs = [ "out" ]; PATH = "%s/bin:%s/bin"; PUBLIC_VAR = "normal"; shellHook = %s;
}; }; }''' % (sys.argv[2], bash, bash, utils, json.dumps(hook).replace('${', '\\${')))
PY
}

raw_cli() {
  env HOME="$RAW_BASE/home" CODEX_HOME="$RAW_BASE/home/.codex" XDG_STATE_HOME="$RAW_BASE/state" \
    CODEX_ISOLATION_CA_BUNDLE="$RAW_CA" \
    bash -c 'cd "$1"; shift; exec "$@"' _ "$RAW_BASE/work" "$RAW_BASE/bin/devshell-env" "$@"
}

raw_admit() {
  git -C "$RAW_BASE/work" add -- "$@"
  if ! git -C "$RAW_BASE/work" diff --cached --quiet; then
    git -C "$RAW_BASE/work" commit -qm 'test: public fixture'
  fi
  raw_cli trust
  raw_cli admit --git-head "$(git -C "$RAW_BASE/work" rev-parse HEAD)" -- "$@"
}

raw_run() {
  env HOME="$RAW_BASE/home" CODEX_HOME="$RAW_BASE/home/.codex" XDG_STATE_HOME="$RAW_BASE/state" \
    bash -c 'cd "$1"; shift; exec "$@"' _ "$RAW_BASE/work" "$RAW_BASE/bin/codex-worktree" "$@"
}

raw_assert_status() {
  if [ "$status" -ne "$1" ]; then printf '%s\n' "$output" >&3; fi
  [ "$status" -eq "$1" ]
}

raw_cleanup() {
  # Bats owns these disposable copied stores; make its normal cleanup possible.
  python3 - "$BATS_TEST_TMPDIR" <<'PY'
import os, sys
from pathlib import Path
for root, directories, _ in os.walk(sys.argv[1], followlinks=False):
    os.chmod(root, os.stat(root).st_mode | 0o700)
    directories[:] = [name for name in directories if not (Path(root) / name).is_symlink()]
PY
}
