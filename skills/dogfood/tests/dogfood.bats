setup_file() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SKILL_DIR="$PROJECT_ROOT/skills/dogfood"
  SOURCE_REF_DIR="$SKILL_DIR/references"
  TEST_REF_DIR="$BATS_FILE_TMPDIR/references"
  mkdir -p "$TEST_REF_DIR"
  cp "$SOURCE_REF_DIR/package.json" \
    "$SOURCE_REF_DIR/package-lock.json" \
    "$SOURCE_REF_DIR/playwright-dogfood-runner.mjs" \
    "$SOURCE_REF_DIR/dogfood-result.mjs" \
    "$SOURCE_REF_DIR/managed-dogfood-browser.mjs" \
    "$TEST_REF_DIR/"
  mkdir -p "$TEST_REF_DIR/fixtures"
  cp -R "$SOURCE_REF_DIR/fixtures/mv3-min" "$TEST_REF_DIR/fixtures/"
  mkdir -p "$TEST_REF_DIR/node_modules/playwright"
  cp "$SKILL_DIR/tests/fixtures/dogfood-playwright.mjs" \
    "$TEST_REF_DIR/node_modules/playwright/index.mjs"
  printf '%s\n' '{"type":"module","version":"1.63.0","exports":"./index.mjs"}' \
    >"$TEST_REF_DIR/node_modules/playwright/package.json"
}

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  SKILL_DIR="$PROJECT_ROOT/skills/dogfood"
  REF_DIR="$BATS_FILE_TMPDIR/references"
  RUNNER="$REF_DIR/playwright-dogfood-runner.mjs"
  export DOGFOOD_PLAYWRIGHT_MODULE="$REF_DIR/node_modules/playwright/index.mjs"
  export DOGFOOD_PLAYWRIGHT_CLI=playwright-cli
  export NODE_BIN="$(command -v node)"
  # The runner fixture models a local browser. WSL2 lifecycle mocks live in
  # managed-dogfood-browser.bats; the Windows helper test opts in separately.
  export DOGFOOD_TEST_WSL=0
  export DOGFOOD_OBSERVATION=none
  export DOGFOOD_WINDOWS_SCRIPT="$PROJECT_ROOT/packages/wsl2-browser/libexec/dogfood-chrome-windows.ps1"
  export MANAGED_CHROME_OWNER="$PROJECT_ROOT/packages/wsl2-browser/bin/managed-chrome-owner"
  export BROWSER_OWNERSHIP_DIR="$BATS_TEST_TMPDIR/browser-ownership"
  export FAKE_CLI_LOG="$BATS_TEST_TMPDIR/playwright-cli.log"
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  cat >"$BATS_TEST_TMPDIR/bin/playwright-cli" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$FAKE_CLI_LOG"

if [[ -n "${FAKE_CLI_TMPDIR:-}" ]]; then
  export TMPDIR="$FAKE_CLI_TMPDIR"
fi

case " $* " in
  *" show --help "*)
    if [[ "${FAKE_CLI_MODE:-}" == "unsupported" ]]; then
      printf '%s\n' 'Options:'
    else
      printf '%s\n' 'Options:' '  --annotate  switch the dashboard into annotation mode.'
    fi
    ;;
  *" attach "*)
    if [[ "${FAKE_CLI_MODE:-}" == "attach-fail" ]]; then
      printf '%s\n' 'attach failed' >&2
      exit 1
    fi
    ;;
  *" show --annotate --json "*)
    mkdir -p .playwright-cli
    printf 'png' >.playwright-cli/annotations.png
    printf '%s\n' '- button "Save"' >.playwright-cli/annotations.yaml
    if [[ "${FAKE_CLI_MODE:-}" == "show-fail" ]]; then
      printf '%s\n' 'dashboard failed' >&2
      exit 1
    elif [[ "${FAKE_CLI_MODE:-}" == "empty" ]]; then
      printf '%s\n' '{"result":"No annotations were submitted."}'
    else
      printf '%s\n' '{"result":"Overall contrast needs attention.\nsession / tab @ https://example.com/frame (1440x1000)\n  { x: 10, y: 20, width: 30, height: 40 }: First annotation\n\nSecond line of the same comment\n  { x: 50, y: 60, width: 70, height: 80 }: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n- [Annotation image](.playwright-cli/annotations.png)\n- [Annotation snapshot](.playwright-cli/annotations.yaml)"}'
    fi
    ;;
  *" detach "*)
    ;;
  *)
    printf 'unexpected command: %s\n' "$*" >&2
    exit 2
    ;;
esac
EOF
  chmod +x "$BATS_TEST_TMPDIR/bin/playwright-cli"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH"
}

# A failed Cleanup preserves the owner record in this test's directory, which is removed
# with the test. Stop that profile's Chrome here so later runs do not hit port-conflict.
teardown() {
  [[ "$DOGFOOD_TEST_WSL" == 1 ]] || return 0
  # Bats runs teardown without errexit, so each failure is checked explicitly.
  local profile profiles helper failed=0
  helper="$(wslpath -w "$SKILL_DIR/tests/helpers/stop-dogfood-profile.ps1")" || return 1
  profiles="$("$NODE_BIN" -e '
    const fs = require("node:fs");
    const dir = process.argv[1];
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!/^(owner|identity-.*\.json)$/.test(name)) continue;
      const owner = JSON.parse(fs.readFileSync(`${dir}/${name}`, "utf8"));
      if (owner.role === "dogfood") console.log(owner.profile);
    }' "$BROWSER_OWNERSHIP_DIR")" || return 1
  while IFS= read -r profile; do
    [[ -n "$profile" ]] || continue
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$helper" -ProfileDir "$profile" </dev/null || failed=1
  done <<<"$profiles"
  return "$failed"
}

@test "teardown helper stops only Chrome whose profile matches exactly" {
  if [[ -z "${WSL_DISTRO_NAME:-}" ]] && ! grep -Eqi 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null; then
    skip "Windows PowerShell is unavailable"
  fi
  export DOGFOOD_TEST_WSL=1
  cat >"$BATS_TEST_TMPDIR/harness.ps1" <<'EOF'
param([string]$ScriptPath)
$global:Alive = [Collections.Generic.List[object]]@(
  @{ ProcessId = 1; CommandLine = 'chrome.exe --user-data-dir=C:\t\aiakos-dogfood-a --type=renderer' },
  @{ ProcessId = 2; CommandLine = 'chrome.exe --user-data-dir="C:\t\aiakos-dogfood-a" --no-first-run' },
  @{ ProcessId = 3; CommandLine = 'chrome.exe --user-data-dir=C:\t\aiakos-dogfood-ab' },
  @{ ProcessId = 5; CommandLine = 'chrome.exe --user-data-dir="C:\t\aiakos-dogfood-a personal" --no-first-run' },
  @{ ProcessId = 4; CommandLine = 'chrome.exe --user-data-dir=C:\Users\me\real' }
)
function Get-CimInstance { [CmdletBinding()] param([string]$ClassName, [string]$Filter) $global:Alive }
function Stop-Process { [CmdletBinding()] param([int]$Id, [switch]$Force) [void]$global:Alive.RemoveAll({ param($p) $p.ProcessId -eq $Id }) }
function Start-Sleep { param([int]$Milliseconds) }
& $ScriptPath -ProfileDir 'C:\t\aiakos-dogfood-a'
Write-Output "exit:$LASTEXITCODE alive:$(($global:Alive | ForEach-Object ProcessId) -join ',')"
EOF
  run powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
    -File "$(wslpath -w "$BATS_TEST_TMPDIR/harness.ps1")" \
    -ScriptPath "$(wslpath -w "$SKILL_DIR/tests/helpers/stop-dogfood-profile.ps1")"
  [ "$status" -eq 0 ]
  [ "${output//$'\r'/}" = "exit:0 alive:3,5,4" ]
}

@test "skill rejects annotation resume conflict before side effects" {
  local skill="$PROJECT_ROOT/skills/dogfood/SKILL.md"
  local reject_line preflight_line

  reject_line="$(grep -n '^0\. Reject `--annotate` together with `--resume <path>` before preflight' "$skill" | cut -d: -f1)"
  preflight_line="$(grep -n '^1\.' "$skill" | cut -d: -f1)"

  [ -n "$reject_line" ]
  [ -n "$preflight_line" ]
  [ "$reject_line" -lt "$preflight_line" ]
  grep -Fq 'Do not silently drop either option.' "$skill"
}

@test "resume normalizes priority aliases and external evidence roots" {
  local mapping="$PROJECT_ROOT/skills/dogfood/references/severity-label-mapping.md"
  local parsing="$PROJECT_ROOT/skills/dogfood/references/report-parsing.md"
  local worktree="$PROJECT_ROOT/skills/dogfood/references/worktree-setup.md"
  local body="$PROJECT_ROOT/skills/dogfood/references/issue-body-template.md"

  grep -Eq '\| P0 +\| Critical +' "$mapping"
  grep -Eq '\| P2 +\| Medium +' "$mapping"
  grep -Fq 'paths relative to that root' "$parsing"
  grep -Fq 'read-only evidence root' "$worktree"
  grep -Fq 'Evidence root (local)' "$body"
}

@test "WSL CDP dogfood uses an explicit viewport without requiring video" {
  local runner="$PROJECT_ROOT/skills/dogfood/references/playwright-dogfood-runner.mjs"
  local contract="$PROJECT_ROOT/skills/dogfood/references/mv3-extension.md"
  local verification="$PROJECT_ROOT/skills/dogfood/references/verification.md"

  grep -Fq 'const cdpContextOptions = { viewport: evidenceViewport };' "$runner"
  grep -Fq 'page.setViewportSize(evidenceViewport)' "$runner"
  grep -Fq 'WSL2 CDP runs therefore omit video capture' "$contract"
  grep -Fq 'intentionally does not produce a `.webm`' "$verification"
}

@test "approval protocol adapts to runtimes limited to three choices" {
  local skill="$PROJECT_ROOT/skills/dogfood/SKILL.md"
  local approval="$PROJECT_ROOT/skills/dogfood/references/approval-protocol.md"

  grep -Fq 'maximum of three choices' "$approval"
  grep -Fq 'Review individually' "$approval"
  grep -Fq 'Open all remaining non-duplicate candidates as-is' "$approval"
  grep -Fq 'Keep / Skip / Edit' "$approval"
  grep -Fq 'aggregate preview for every remaining non-duplicate candidate' "$approval"
  grep -Fq 'Only after showing that aggregate preview' "$approval"
  grep -Fq 'title, severity/category, URL, rendered Issue body, evidence count, source report, and dedup status' "$approval"
  ! grep -Fq 'runtime-adapter.md' "$skill"
}

@test "dogfood without annotation preserves the existing report path" {
  local out="$BATS_TEST_TMPDIR/output"

  run node "$RUNNER" --target about:blank --output "$out"

  [ "$status" -eq 0 ]
  grep -Fq 'No findings recorded.' "$out/report.md"
  [ ! -e "$FAKE_CLI_LOG" ]
  attempt="$(sed -n 's/^Attempt directory: //p' "$out/report.md")"
  [ ! -e "$out/$attempt/annotations" ]
}

@test "annotation cannot be combined with resume" {
  local out="$BATS_TEST_TMPDIR/output"

  run node "$RUNNER" --target about:blank --output "$out" --annotate --resume previous-output

  [ "$status" -ne 0 ]
  [[ "$output" == *"--annotate cannot be combined with --resume"* ]]
  [ ! -e "$out" ]
  [ ! -e "$FAKE_CLI_LOG" ]
}

@test "annotated dogfood converts submitted feedback into auditable findings" {
  local out="$BATS_TEST_TMPDIR/output"

  run node "$RUNNER" --target about:blank --output "$out" --annotate

  [ "$status" -eq 0 ]
  [ "$(grep -c '^### ISSUE-' "$out/report.md")" -eq 3 ]
  grep -Fq 'URL: https://example.com/frame' "$out/report.md"
  grep -Fq 'Coordinates: x=10, y=20, width=30, height=40' "$out/report.md"
  grep -Fq 'Second line of the same comment' "$out/report.md"
  [[ "$(<"$out/report.md")" == *$'Comment: First annotation\n\nSecond line of the same comment'* ]]
  grep -Fq 'Viewport: 1440x1000' "$out/report.md"
  attempt="$(sed -n 's/^Attempt directory: //p' "$out/report.md")"
  grep -Fq "Evidence: $attempt/.playwright-cli/annotations.png, $attempt/.playwright-cli/annotations.yaml, $attempt/annotations/response.json" "$out/report.md"
  [ "$(sed -n 's/^### ISSUE-[0-9][0-9][0-9]: //p' "$out/report.md" | tail -1 | wc -c)" -eq 121 ]
  [ -f "$out/$attempt/.playwright-cli/annotations.png" ]
  [ -f "$out/$attempt/.playwright-cli/annotations.yaml" ]
  [ -f "$out/$attempt/annotations/response.json" ]
  grep -Fq 'attach --cdp=http://127.0.0.1:' "$FAKE_CLI_LOG"
  grep -Fq 'show --annotate --json' "$FAKE_CLI_LOG"
  grep -Fq 'detach' "$FAKE_CLI_LOG"
}

@test "empty annotation submission keeps only automated findings" {
  local out="$BATS_TEST_TMPDIR/output"
  export FAKE_CLI_MODE=empty

  run node "$RUNNER" --target about:blank --output "$out" --annotate

  [ "$status" -eq 0 ]
  grep -Fq 'No findings recorded.' "$out/report.md"
  attempt="$(sed -n 's/^Attempt directory: //p' "$out/report.md")"
  [ -f "$out/$attempt/annotations/response.json" ]
}

@test "annotation attach failure still finalizes automated evidence" {
  local out="$BATS_TEST_TMPDIR/output"
  export FAKE_CLI_MODE=attach-fail

  run node "$RUNNER" --target about:blank --output "$out" --annotate

  [ "$status" -ne 0 ]
  [[ "$output" == *"attach failed"* ]]
  [ -f "$out/report.md" ]
  attempt="$(sed -n 's/^Attempt directory: //p' "$out/report.md")"
  [ -f "$out/$attempt/traces/playwright-trace.zip" ]
  if [ "$DOGFOOD_TEST_WSL" = 0 ]; then
    [ "$(find "$out/$attempt/videos" -name '*.webm' | wc -l)" -ge 1 ]
  fi
}

@test "missing Playwright CLI still finalizes automated evidence" {
  local out="$BATS_TEST_TMPDIR/output"
  local path_without_cli="" entry
  IFS=: read -r -a path_entries <<<"$PATH"
  for entry in "${path_entries[@]}"; do
    if [ ! -x "$entry/playwright-cli" ]; then
      path_without_cli="${path_without_cli:+$path_without_cli:}$entry"
    fi
  done

  run env PATH="$path_without_cli" "$NODE_BIN" "$RUNNER" --target about:blank --output "$out" --annotate

  [ "$status" -ne 0 ]
  [[ "$output" == *"playwright-cli show --help failed"* ]]
  [ -f "$out/report.md" ]
  attempt="$(sed -n 's/^Attempt directory: //p' "$out/report.md")"
  [ -f "$out/$attempt/traces/playwright-trace.zip" ]
  if [ "$DOGFOOD_TEST_WSL" = 0 ]; then
    [ "$(find "$out/$attempt/videos" -name '*.webm' | wc -l)" -ge 1 ]
  fi
}

@test "unsupported annotation command still finalizes automated evidence" {
  local out="$BATS_TEST_TMPDIR/output"
  export FAKE_CLI_MODE=unsupported

  run node "$RUNNER" --target about:blank --output "$out" --annotate

  [ "$status" -ne 0 ]
  [[ "$output" == *"does not support show --annotate"* ]]
  [ -f "$out/report.md" ]
  attempt="$(sed -n 's/^Attempt directory: //p' "$out/report.md")"
  [ -f "$out/$attempt/traces/playwright-trace.zip" ]
}

@test "annotation dashboard failure detaches and finalizes automated evidence" {
  local out="$BATS_TEST_TMPDIR/output"
  export FAKE_CLI_MODE=show-fail

  run node "$RUNNER" --target about:blank --output "$out" --annotate

  [ "$status" -ne 0 ]
  [[ "$output" == *"dashboard failed"* ]]
  grep -Fq 'detach' "$FAKE_CLI_LOG"
  [ -f "$out/report.md" ]
  attempt="$(sed -n 's/^Attempt directory: //p' "$out/report.md")"
  [ -f "$out/$attempt/traces/playwright-trace.zip" ]
}
