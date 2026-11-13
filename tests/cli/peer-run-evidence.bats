#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup_file() {
  "$BATS_TEST_DIRNAME/../../bin/prepare-file-safety" >/dev/null
  # 並列実行の別ファイルが先に作った場合も、次行で種類と所有者を確かめる。
  mkdir -m 700 /tmp/codex 2>/dev/null || :
  [ -d /tmp/codex ] && [ ! -L /tmp/codex ] && [ -O /tmp/codex ]
}

setup() {
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX
  local project_root
  project_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$project_root/skills/herdr-peer-refactor/scripts/run-evidence"
  PIN="$project_root/skills/herdr-peer-refactor/scripts/candidate-record"
  EVIDENCE="$(mktemp -d /tmp/codex/peer-evidence-test.XXXXXX)"
  REPO="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$REPO" "$EVIDENCE/peer"
  git init -q "$REPO"
  git -C "$REPO" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm initial --allow-empty
  SHA="$(git -C "$REPO" rev-parse HEAD)"
  COMMON="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)"
  RECORD="$EVIDENCE/record.json"
  CANDIDATES="$EVIDENCE/candidates.json"
  REPORT="$EVIDENCE/report.md"
  printf '# Gateway preparation\n' >"$REPORT"
  printf '%s\n' '[{"id":"C2","title":"Gateway preparation","acceptance":["ready"],"non_goals":[],"owned_files":["gateway.py"]}]' >"$CANDIDATES"
  FINGERPRINT="$(cd "$REPO" && "$PIN" pin "$REPORT" "$COMMON" "$SHA" "$CANDIDATES" "$RECORD")"
  printf 'run-1\n' >"$EVIDENCE/peer/run-id"
  printf '271\n' >"$EVIDENCE/peer/waited-s"
  printf '2\n' >"$EVIDENCE/peer/round"
  printf 'missing\n' >"$EVIDENCE/peer/REQ-1.failures"
  printf 'mutation detected\n' >"$EVIDENCE/mutation.log"
}

teardown() {
  if [[ "${EVIDENCE:-}" == /tmp/codex/peer-evidence-test.* ]]; then
    rm -r -- "$EVIDENCE"
  fi
}

checkpoint() {
  (cd "$REPO" && "$SCRIPT" checkpoint "$RECORD" "$CANDIDATES" "$FINGERPRINT" "$@")
}

save_checkpoint() {
  run checkpoint "$EVIDENCE/peer/run-id" "$EVIDENCE/peer/waited-s" "$EVIDENCE/peer/round" "$EVIDENCE/peer/REQ-1.failures" "$EVIDENCE/mutation.log" "$@"
  [ "$status" -eq 0 ]
  CHECKPOINT="$(node -e 'console.log(JSON.parse(process.argv[1]).checkpoint)' "$output")"
  ARCHIVE="$COMMON/peer-refactor-evidence/$FINGERPRINT/$CHECKPOINT.json"
  [ -f "$ARCHIVE" ]
}

restore() {
  (cd "$REPO" && "$SCRIPT" restore "$FINGERPRINT" "$CHECKPOINT")
}

probe() {
  (cd "$REPO" && "$SCRIPT" probe "$RECORD" "$CANDIDATES" "$FINGERPRINT" "${1-0123456789abcdef}" "${2-$EVIDENCE/probe.json}")
}

bounded_probe() {
  (cd "$REPO" && node - "$SCRIPT" probe "$RECORD" "$CANDIDATES" "$FINGERPRINT" 0123456789abcdef "$EVIDENCE/probe.json" <<'JS'
const { spawn } = require('node:child_process');
const child = spawn(process.argv[2], process.argv.slice(3), { detached: true, stdio: 'inherit' });
let expired = false;
const timer = setTimeout(() => {
  expired = true;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  console.error('テスト外側の制限時間を超えました');
}, 45000);
child.on('exit', code => { clearTimeout(timer); process.exitCode = expired ? 125 : code ?? 1; });
JS
  )
}

@test "probe rejects a candidate FIFO before starting the checker" {
  CANDIDATES="$EVIDENCE/candidates.pipe"
  mkfifo "$CANDIDATES"
  run -1 bounded_probe
  [[ "$output" == *'通常ファイル'* ]]
  [ ! -e "$EVIDENCE/probe.json" ]
}

@test "probe bounds a stalled checker and records its timeout" {
  rm -- "$REPORT"
  mkfifo "$REPORT"
  run -124 --separate-stderr bounded_probe
  [[ "$stderr" == *'タイムアウト'* ]]
  node - "$EVIDENCE/probe.json" "$output" "$SHA" "$FINGERPRINT" <<'JS'
const fs = require('node:fs'), assert = require('node:assert/strict');
const [path, output, sha, fingerprint] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(path));
assert.deepEqual(receipt, JSON.parse(output));
assert.equal(receipt.exit_code, 124);
assert.equal(receipt.head, sha);
assert.equal(receipt.fingerprint, fingerprint);
assert.equal(receipt.nonce, '0123456789abcdef');
JS
}

@test "probe runs the pinned checker and saves its result with the current HEAD and nonce" {
  run probe
  [ "$status" -eq 0 ]
  node - "$EVIDENCE/probe.json" "$SHA" "$FINGERPRINT" "$PIN" "$RECORD" "$CANDIDATES" "$output" "$REPO" <<'JS'
const fs = require('node:fs'), assert = require('node:assert/strict');
const [path, sha, fingerprint, pin, record, candidates, output, repo] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(path));
assert.deepEqual(receipt, JSON.parse(output));
assert.deepEqual(Object.keys(receipt).sort(), ['version', 'nonce', 'head', 'cwd', 'fingerprint', 'command', 'exit_code'].sort());
assert.equal(receipt.version, 1);
assert.equal(receipt.nonce, '0123456789abcdef');
assert.equal(receipt.head, sha);
assert.equal(receipt.cwd, fs.realpathSync(repo));
assert.equal(receipt.fingerprint, fingerprint);
assert.deepEqual(receipt.command, [pin, 'check', record, candidates, fingerprint]);
assert.equal(receipt.exit_code, 0);
assert.equal(fs.statSync(path).mode & 0o777, 0o600);
JS
}

@test "probe preserves a checker failure without recording public input bodies" {
  printf 'public-body-not-for-receipt\n' >>"$REPORT"
  run --separate-stderr probe
  [ "$status" -eq 1 ]
  [[ "$stderr" == *'変更または移動'* ]]
  node - "$EVIDENCE/probe.json" "$output" <<'JS'
const fs = require('node:fs'), assert = require('node:assert/strict');
const [path, output] = process.argv.slice(2);
const raw = fs.readFileSync(path, 'utf8'), receipt = JSON.parse(raw);
assert.deepEqual(receipt, JSON.parse(output));
assert.equal(receipt.exit_code, 1);
assert.equal(receipt.nonce, '0123456789abcdef');
assert(!raw.includes('public-body-not-for-receipt'));
JS
}

@test "probe refuses unsafe paths invalid nonces and existing receipts" {
  local path nonce
  # This sentinel is only passed to the path validator and must stay outside
  # the shared /tmp/codex namespace, even when Bats itself uses that namespace.
  local outside_path="/tmp/outside-probe-${BASHPID:-$$}.json"
  for path in "$EVIDENCE/.env" "$EVIDENCE/private.key" "$outside_path"; do
    run probe 0123456789abcdef "$path"
    [ "$status" -ne 0 ]
    [ ! -e "$path" ]
  done
  for nonce in '' not-hex 0123456789abcde; do
    run probe "$nonce"
    [ "$status" -ne 0 ]
    [ ! -e "$EVIDENCE/probe.json" ]
  done
  ln -s "$REPORT" "$EVIDENCE/link.json"
  run probe 0123456789abcdef "$EVIDENCE/link.json"
  [ "$status" -ne 0 ]
  [ "$(cat "$REPORT")" = '# Gateway preparation' ]
  run probe
  [ "$status" -eq 0 ]
  local previous
  previous="$(cat "$EVIDENCE/probe.json")"
  run probe
  [ "$status" -ne 0 ]
  [ "$(cat "$EVIDENCE/probe.json")" = "$previous" ]
}

@test "checkpoint preserves the probe receipt for independent review after restore" {
  run probe
  [ "$status" -eq 0 ]
  local receipt="$output"
  save_checkpoint "$EVIDENCE/probe.json"
  rm -- "$EVIDENCE/probe.json"
  run restore
  [ "$status" -eq 0 ]
  [ "$(cat "$EVIDENCE/probe.json")" = "$receipt" ]
}

@test "checkpoint restores candidate bytes and all peer budgets after shared evidence disappears" {
  save_checkpoint
  local original
  original="$(sha256sum "$RECORD")"
  rm -- "$RECORD" "$CANDIDATES" "$REPORT" "$EVIDENCE/mutation.log" "$EVIDENCE/peer/"*
  git -C "$REPO" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm descendant --allow-empty
  git -C "$REPO" worktree add -qb task "$BATS_TEST_TMPDIR/linked"
  run bash -c 'cd "$1" && "$2" restore "$3" "$4"' _ "$BATS_TEST_TMPDIR/linked" "$SCRIPT" "$FINGERPRINT" "$CHECKPOINT"
  [ "$status" -eq 0 ]
  [ "$(sha256sum "$RECORD")" = "$original" ]
  [ "$(cat "$EVIDENCE/peer/waited-s")" = 271 ]
  [ "$(cat "$EVIDENCE/peer/round")" = 2 ]
  [ "$(cat "$EVIDENCE/peer/run-id")" = run-1 ]
  [ "$(cat "$EVIDENCE/peer/REQ-1.failures")" = missing ]
  [ "$(cat "$EVIDENCE/mutation.log")" = 'mutation detected' ]
  run restore
  [ "$status" -eq 0 ]
  run checkpoint "$EVIDENCE/peer/run-id" "$EVIDENCE/peer/waited-s" "$EVIDENCE/peer/round" "$EVIDENCE/peer/REQ-1.failures" "$EVIDENCE/mutation.log"
  [ "$status" -eq 0 ]
  [[ "$output" == *"$CHECKPOINT"* ]]
}

@test "restore rejects altered checkpoint bytes before writing any evidence" {
  save_checkpoint
  printf ' ' >>"$ARCHIVE"
  rm -- "$REPORT"
  run restore
  [ "$status" -ne 0 ]
  [[ "$output" == *'hash が一致しません'* ]]
  [ ! -e "$REPORT" ]
}

@test "restore refuses newer local ledger values without partially restoring missing files" {
  save_checkpoint
  printf '400\n' >"$EVIDENCE/peer/waited-s"
  printf '3\n' >"$EVIDENCE/peer/round"
  rm -- "$REPORT"
  run restore
  [ "$status" -ne 0 ]
  [[ "$output" == *'上書きしません'* ]]
  [ "$(cat "$EVIDENCE/peer/waited-s")" = 400 ]
  [ "$(cat "$EVIDENCE/peer/round")" = 3 ]
  [ ! -e "$REPORT" ]
}

@test "checkpoint validates the original fingerprint and artifact before archiving" {
  local good="$FINGERPRINT"
  FINGERPRINT="$(printf '%064d' 0)"
  run checkpoint
  [ "$status" -ne 0 ]
  [[ "$output" == *'fingerprint が一致しません'* ]]
  FINGERPRINT="$good"
  printf 'changed\n' >>"$REPORT"
  run checkpoint
  [ "$status" -ne 0 ]
  [[ "$output" == *'変更または移動'* ]]
  [ ! -e "$COMMON/peer-refactor-evidence" ]
}

@test "checkpoint refuses sensitive names symlinks directories and paths outside shared evidence" {
  local path outside_path="/tmp/outside-checkpoint-${BASHPID:-$$}.md"
  for path in .env private.key credentials.json auth.json secret.json secrets.json service-account-test.json .ENV .envrc token.json .aws/credentials .ssh/config .config/gh/hosts.yml .docker/config.json .azure/accessTokens.json .git-credentials .credentials.json id_rsa id_ed25519 id_ecdsa id_dsa; do
    mkdir -p "$(dirname "$EVIDENCE/$path")"
    printf 'synthetic\n' >"$EVIDENCE/$path"
    run checkpoint "$EVIDENCE/$path"
    [ "$status" -ne 0 ]
    [[ "$output" == *'機密ファイル名'* ]]
  done
  ln -s "$REPORT" "$EVIDENCE/link.md"
  run checkpoint "$EVIDENCE/link.md"
  [ "$status" -ne 0 ]
  [[ "$output" == *'symlink'* ]]
  run checkpoint "$EVIDENCE/peer"
  [ "$status" -ne 0 ]
  run checkpoint "$outside_path"
  [ "$status" -ne 0 ]
  [[ "$output" == *'/tmp/codex'* ]]
  [ ! -e "$COMMON/peer-refactor-evidence" ]
}

@test "checkpoint preserves an existing pinned report outside the shared run directory" {
  local previous="$REPORT"
  REPORT="$BATS_TEST_TMPDIR/external.md"
  cp "$previous" "$REPORT"
  rm -- "$RECORD"
  FINGERPRINT="$(cd "$REPO" && "$PIN" pin "$REPORT" "$COMMON" "$SHA" "$CANDIDATES" "$RECORD")"
  save_checkpoint
  rm -- "$REPORT"
  run restore
  [ "$status" -eq 0 ]
  cmp "$previous" "$REPORT"
}

@test "restore refuses symlink destinations and leaves their target unchanged" {
  save_checkpoint
  local target="$BATS_TEST_TMPDIR/target"
  printf 'unchanged\n' >"$target"
  rm -- "$REPORT"
  ln -s "$target" "$REPORT"
  run restore
  [ "$status" -ne 0 ]
  [[ "$output" == *'symlink'* ]]
  [ "$(cat "$target")" = unchanged ]
}

@test "restore checks all parent paths before writing any missing evidence" {
  save_checkpoint
  rm -- "$EVIDENCE/peer/"*
  rmdir "$EVIDENCE/peer"
  printf 'unchanged\n' >"$EVIDENCE/peer"
  rm -- "$REPORT"
  run restore
  [ "$status" -ne 0 ]
  [[ "$output" == *'親パス'* ]]
  [ "$(cat "$EVIDENCE/peer")" = unchanged ]
  [ ! -e "$REPORT" ]
}

@test "restore rejects the same checkpoint copied into another repository" {
  save_checkpoint
  local other="$BATS_TEST_TMPDIR/other"
  git clone -q "$REPO" "$other"
  mkdir -p "$other/.git/peer-refactor-evidence/$FINGERPRINT"
  cp "$ARCHIVE" "$other/.git/peer-refactor-evidence/$FINGERPRINT/"
  rm -- "$REPORT"
  run bash -c 'cd "$1" && "$2" restore "$3" "$4"' _ "$other" "$SCRIPT" "$FINGERPRINT" "$CHECKPOINT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'別の Git リポジトリ'* ]]
  [ ! -e "$REPORT" ]
}

@test "restore validates candidate provenance even for an internally consistent checkpoint" {
  save_checkpoint
  CHECKPOINT="$(
    node - "$ARCHIVE" <<'JS'
const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
const archive = process.argv[2], data = JSON.parse(fs.readFileSync(archive));
const record = JSON.parse(Buffer.from(data.files[data.record_path], 'base64'));
record.candidates[0].acceptance = ['changed intent'];
data.files[data.record_path] = Buffer.from(JSON.stringify(record)).toString('base64');
const raw = Buffer.from(JSON.stringify(data));
const digest = crypto.createHash('sha256').update(raw).digest('hex');
fs.writeFileSync(path.join(path.dirname(archive), digest + '.json'), raw);
console.log(digest);
JS
  )"
  rm -- "$REPORT"
  run restore
  [ "$status" -ne 0 ]
  [[ "$output" == *'fingerprint が一致しません'* ]]
  [ ! -e "$REPORT" ]
}

@test "standalone evidence tests prepare a private shared root and reject unsafe roots" {
  run node - "$BATS_TEST_DIRNAME/../.." "$EVIDENCE" <<'JS'
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const [root, evidence] = process.argv.slice(2).map(p => path.resolve(p));
const source = fs.readFileSync(path.join(root, 'tests/cli/peer-run-evidence.bats'), 'utf8');
const assignment = '  project_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"';
assert.equal(source.split('\n').filter(line => line === assignment).length, 1);
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
for (const kind of ['missing', 'owned', 'file', 'symlink', 'dangling']) {
  const shared = path.join(evidence, 'shared-' + kind);
  if (kind === 'owned') {
    fs.mkdirSync(shared, { mode: 0o700 });
    fs.writeFileSync(path.join(shared, 'keep'), 'unchanged');
  } else if (kind === 'file') fs.writeFileSync(shared, 'unchanged');
  else if (kind === 'symlink') {
    const target = path.join(evidence, 'link-target');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.writeFileSync(path.join(target, 'keep'), 'unchanged');
    fs.symlinkSync(target, shared);
  } else if (kind === 'dangling') fs.symlinkSync(path.join(evidence, 'missing-target'), shared);
  const fixture = path.join(evidence, kind + '.bats');
  fs.writeFileSync(fixture, source.replaceAll('/tmp/codex', shared).replace(assignment, '  project_root=' + quote(root)).replace('"$BATS_TEST_DIRNAME/../../bin/prepare-file-safety"', quote(path.join(root, 'bin/prepare-file-safety'))));
  const result = spawnSync('bats', ['--tap', '--print-output-on-failure', '--filter', '^checkpoint validates the original fingerprint', fixture], { encoding: 'utf8' });
  if (['missing', 'owned'].includes(kind)) {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const stat = fs.lstatSync(shared);
    assert(stat.isDirectory() && stat.uid === process.getuid());
    assert.equal(stat.mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(shared), kind === 'missing' ? [] : ['keep']);
  } else {
    assert.notEqual(result.status, 0, kind);
    assert(result.stdout.includes('setup_file failed'), result.stdout);
    if (kind === 'file') assert.equal(fs.readFileSync(shared, 'utf8'), 'unchanged');
    else assert(fs.lstatSync(shared).isSymbolicLink());
    if (kind === 'symlink') assert.deepEqual(fs.readdirSync(path.join(evidence, 'link-target')), ['keep']);
    if (kind === 'dangling') assert(!fs.existsSync(path.join(evidence, 'missing-target')));
  }
}
const setup = source.match(/^setup_file\(\) \{\n.*?^\}/ms)[0];
if (fs.statSync('/').uid !== process.getuid()) {
  const result = spawnSync('bash', ['-c', setup.replaceAll('/tmp/codex', '/').replace('"$BATS_TEST_DIRNAME/../../bin/prepare-file-safety"', quote(path.join(root, 'bin/prepare-file-safety'))) + '\nsetup_file'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
}
const teardown = source.match(/^teardown\(\) \{\n.*?^\}/ms)[0];
for (const state of ['unset EVIDENCE', "EVIDENCE=''"]) {
  const result = spawnSync('bash', ['-c', 'set -u\n' + teardown + '\n' + state + '\nteardown'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
JS
  [ "$status" -eq 0 ]
}
