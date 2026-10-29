#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

payload_snapshot() {
  python3 "$SKILL_DIR/tests/helpers/payload-snapshot.py" "$PROJECT_ROOT"
}

setup_file() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SKILL_DIR="$PROJECT_ROOT/skills/dogfood"
  DOGFOOD_DEPS_DIR="${DOGFOOD_DEPS_DIR:-$BATS_FILE_TMPDIR/dogfood-runtime}"
  WSL2_BROWSER_DEPS_DIR="${WSL2_BROWSER_DEPS_DIR:-$BATS_FILE_TMPDIR/wsl2-browser-runtime}"
  export DOGFOOD_TEST_WSL=0 DOGFOOD_DEPS_DIR WSL2_BROWSER_DEPS_DIR
  mkdir -p "$BATS_FILE_TMPDIR"

  payload_snapshot >"$BATS_FILE_TMPDIR/payload.before"
  node "$SKILL_DIR/scripts/dogfood-runtime.mjs" prepare
  payload_snapshot >"$BATS_FILE_TMPDIR/payload.after-prepare"
  cmp "$BATS_FILE_TMPDIR/payload.before" "$BATS_FILE_TMPDIR/payload.after-prepare"
}

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SKILL_DIR="$PROJECT_ROOT/skills/dogfood"
  DOGFOOD_DEPS_DIR="${DOGFOOD_DEPS_DIR:-$BATS_FILE_TMPDIR/dogfood-runtime}"
  WSL2_BROWSER_DEPS_DIR="${WSL2_BROWSER_DEPS_DIR:-$BATS_FILE_TMPDIR/wsl2-browser-runtime}"
  export DOGFOOD_TEST_WSL=0 DOGFOOD_DEPS_DIR WSL2_BROWSER_DEPS_DIR
  export PWCLI_TEST_WSL=0
  export PWCLI_UPSTREAM="$BATS_TEST_TMPDIR/bin/playwright-cli"
  export REAL_PLAYWRIGHT_CLI="$PROJECT_ROOT/packages/wsl2-browser/bin/upstream-playwright-cli"
  export FAKE_CLI_LOG="$BATS_TEST_TMPDIR/playwright-cli.log"
  export PWTEST_DAEMON_SESSION_DIR="$BATS_FILE_TMPDIR/playwright-cli-daemon"
  export PWTEST_SERVER_REGISTRY="$BATS_FILE_TMPDIR/playwright-server-registry"
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  cat >"$PWCLI_UPSTREAM" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$FAKE_CLI_LOG"
if [[ -n "${FAKE_CLI_TMPDIR:-}" ]]; then
  export TMPDIR="$FAKE_CLI_TMPDIR"
fi

case " $* " in
  *" show --help "*)
    printf '%s\n' 'Options:' '  --annotate  switch the dashboard into annotation mode.'
    ;;
  *" attach "*)
    "$REAL_PLAYWRIGHT_CLI" "$@"
    ;;
  *" show --annotate --json "*)
    "$REAL_PLAYWRIGHT_CLI" "$1" eval '() => document.URL' --json >>"$FAKE_CLI_LOG"
    printf '%s\n' '{"result":"No annotations were submitted."}'
    ;;
  *" detach "*)
    "$REAL_PLAYWRIGHT_CLI" "$@"
    ;;
  *)
    printf 'unexpected command: %s\n' "$*" >&2
    exit 2
    ;;
esac
SH
  chmod +x "$PWCLI_UPSTREAM"
}

assert_payload_unchanged() {
  payload_snapshot >"$BATS_TEST_TMPDIR/payload.current"
  cmp "$BATS_FILE_TMPDIR/payload.before" "$BATS_TEST_TMPDIR/payload.current"
}

@test "public runtime helper runs and reruns a real web target outside the plugin" {
  local out="$BATS_TEST_TMPDIR/output-web" attempt first_attempt

  run node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run \
    --target about:blank --output "$out"

  [ "$status" -eq 0 ]
  grep -Fq 'Run status: completed' "$out/report.md"
  grep -Fq 'Evidence status: complete' "$out/report.md"
  first_attempt="$(sed -n 's/^Attempt directory: //p' "$out/report.md")"
  [ -s "$out/$first_attempt/screenshots/initial.png" ]
  [ -s "$out/$first_attempt/traces/playwright-trace.zip" ]
  [ "$(find "$out/$first_attempt/videos" -name '*.webm' | wc -l)" -eq 1 ]
  assert_payload_unchanged

  run node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run \
    --target about:blank --output "$out"

  [ "$status" -eq 0 ]
  attempt="$(sed -n 's/^Attempt directory: //p' "$out/report.md")"
  [ "$attempt" != "$first_attempt" ]
  [ -s "$out/$first_attempt/screenshots/initial.png" ]
  [ -s "$out/$attempt/screenshots/initial.png" ]
  assert_payload_unchanged
}

@test "annotation attaches to the runner-owned Chromium and leaves it alive" {
  local out="$BATS_TEST_TMPDIR/output-annotation"
  export FAKE_CLI_TMPDIR="$BATS_TEST_TMPDIR/long-socket-parent-for-nested-runtimes-and-bats/another-long-component-to-exceed-the-unix-socket-limit"
  mkdir -p "$FAKE_CLI_TMPDIR"

  run node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run \
    --target about:blank --output "$out" --annotate

  [ "$status" -eq 0 ]
  grep -Fq 'about:blank' "$FAKE_CLI_LOG"
  grep -Fq 'detach' "$FAKE_CLI_LOG"
  attempt="$(sed -n 's/^Attempt directory: //p' "$out/report.md")"
  [ -s "$out/$attempt/traces/playwright-trace.zip" ]
  assert_payload_unchanged
}

@test "MV3 inspection and annotation share the persistent Chromium context" {
  local out="$BATS_TEST_TMPDIR/output-mv3"
  local extension="$SKILL_DIR/references/fixtures/mv3-min"
  export FAKE_CLI_TMPDIR="$BATS_TEST_TMPDIR/long-socket-parent-for-nested-runtimes-and-bats/another-long-component-to-exceed-the-unix-socket-limit"
  mkdir -p "$FAKE_CLI_TMPDIR"

  run node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run \
    --target about:blank --extension "$extension" --output "$out" --annotate

  [ "$status" -eq 0 ]
  grep -Eq '^Extension ID: [a-z]+' "$out/report.md"
  grep -Fq 'about:blank' "$FAKE_CLI_LOG"
  ! grep -Fq 'MV3 service worker did not register' "$out/report.md"
  attempt="$(sed -n 's/^Attempt directory: //p' "$out/report.md")"
  [ -s "$out/$attempt/screenshots/initial.png" ]
  assert_payload_unchanged
}
