#!/usr/bin/env bats

bats_require_minimum_version 1.5.0

setup_file() {
  # 並列実行の別ファイルが先に作った場合も、次行で種類と所有者を確かめる。
  mkdir -m 700 /tmp/codex 2>/dev/null || :
  [ -d /tmp/codex ] && [ ! -L /tmp/codex ] && [ -O /tmp/codex ]
}

setup() {
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX
  local project_root
  project_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$project_root/skills/herdr-peer-refactor/scripts/run-evidence.py"
  PIN="$project_root/skills/herdr-peer-refactor/scripts/candidate-record.py"
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
  FINGERPRINT="$(cd "$REPO" && python3 "$PIN" pin "$REPORT" "$COMMON" "$SHA" "$CANDIDATES" "$RECORD")"
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
  (cd "$REPO" && python3 "$SCRIPT" checkpoint "$RECORD" "$CANDIDATES" "$FINGERPRINT" "$@")
}

save_checkpoint() {
  run checkpoint "$EVIDENCE/peer/run-id" "$EVIDENCE/peer/waited-s" "$EVIDENCE/peer/round" "$EVIDENCE/peer/REQ-1.failures" "$EVIDENCE/mutation.log" "$@"
  [ "$status" -eq 0 ]
  CHECKPOINT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["checkpoint"])' "$output")"
  ARCHIVE="$COMMON/peer-refactor-evidence/$FINGERPRINT/$CHECKPOINT.json"
  [ -f "$ARCHIVE" ]
}

restore() {
  (cd "$REPO" && python3 "$SCRIPT" restore "$FINGERPRINT" "$CHECKPOINT")
}

probe() {
  (cd "$REPO" && python3 "$SCRIPT" probe "$RECORD" "$CANDIDATES" "$FINGERPRINT" "${1-0123456789abcdef}" "${2-$EVIDENCE/probe.json}")
}

bounded_probe() {
  (cd "$REPO" && python3 - "$SCRIPT" probe "$RECORD" "$CANDIDATES" "$FINGERPRINT" 0123456789abcdef "$EVIDENCE/probe.json" <<'PY'
import os, signal, subprocess, sys

process = subprocess.Popen([sys.executable, *sys.argv[1:]], start_new_session=True)
try:
    code = process.wait(timeout=45)
except subprocess.TimeoutExpired:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()
    print('テスト外側の制限時間を超えました', file=sys.stderr)
    code = 125
sys.exit(code)
PY
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
  python3 - "$EVIDENCE/probe.json" "$output" "$SHA" "$FINGERPRINT" <<'PY'
import json, sys
from pathlib import Path

receipt = json.loads(Path(sys.argv[1]).read_text())
assert receipt == json.loads(sys.argv[2])
assert receipt['exit_code'] == 124
assert receipt['head'] == sys.argv[3]
assert receipt['fingerprint'] == sys.argv[4]
assert receipt['nonce'] == '0123456789abcdef'
PY
}

@test "probe runs the pinned checker and saves its result with the current HEAD and nonce" {
  run probe
  [ "$status" -eq 0 ]
  python3 - "$EVIDENCE/probe.json" "$SHA" "$FINGERPRINT" "$PIN" "$RECORD" "$CANDIDATES" "$output" "$REPO" <<'PY'
import json, stat, sys
from pathlib import Path

path = Path(sys.argv[1])
receipt = json.loads(path.read_text())
assert receipt == json.loads(sys.argv[7])
assert set(receipt) == {'version', 'nonce', 'head', 'cwd', 'fingerprint', 'command', 'exit_code'}
assert receipt['version'] == 1
assert receipt['nonce'] == '0123456789abcdef'
assert receipt['head'] == sys.argv[2]
assert receipt['cwd'] == str(Path(sys.argv[8]).resolve())
assert receipt['fingerprint'] == sys.argv[3]
assert receipt['command'][1:] == ['-B', sys.argv[4], 'check', sys.argv[5], sys.argv[6], sys.argv[3]]
assert receipt['exit_code'] == 0
assert stat.S_IMODE(path.stat().st_mode) == 0o600
PY
}

@test "probe preserves a checker failure without recording public input bodies" {
  printf 'public-body-not-for-receipt\n' >>"$REPORT"
  run --separate-stderr probe
  [ "$status" -eq 1 ]
  [[ "$stderr" == *'変更または移動'* ]]
  python3 - "$EVIDENCE/probe.json" "$output" <<'PY'
import json, sys
from pathlib import Path

raw = Path(sys.argv[1]).read_text()
receipt = json.loads(raw)
assert receipt == json.loads(sys.argv[2])
assert receipt['exit_code'] == 1
assert receipt['nonce'] == '0123456789abcdef'
assert 'public-body-not-for-receipt' not in raw
PY
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
  run bash -c 'cd "$1" && python3 "$2" restore "$3" "$4"' _ "$BATS_TEST_TMPDIR/linked" "$SCRIPT" "$FINGERPRINT" "$CHECKPOINT"
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
  FINGERPRINT="$(cd "$REPO" && python3 "$PIN" pin "$REPORT" "$COMMON" "$SHA" "$CANDIDATES" "$RECORD")"
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
  run bash -c 'cd "$1" && python3 "$2" restore "$3" "$4"' _ "$other" "$SCRIPT" "$FINGERPRINT" "$CHECKPOINT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'別の Git リポジトリ'* ]]
  [ ! -e "$REPORT" ]
}

@test "restore validates candidate provenance even for an internally consistent checkpoint" {
  save_checkpoint
  CHECKPOINT="$(
    python3 - "$ARCHIVE" <<'PY'
import base64, hashlib, json, sys
from pathlib import Path
p = Path(sys.argv[1])
data = json.loads(p.read_bytes())
record_path = data['record_path']
record = json.loads(base64.b64decode(data['files'][record_path]))
record['candidates'][0]['acceptance'] = ['changed intent']
data['files'][record_path] = base64.b64encode(json.dumps(record).encode()).decode()
raw = json.dumps(data).encode()
digest = hashlib.sha256(raw).hexdigest()
p.with_name(digest + '.json').write_bytes(raw)
print(digest)
PY
  )"
  rm -- "$REPORT"
  run restore
  [ "$status" -ne 0 ]
  [[ "$output" == *'fingerprint が一致しません'* ]]
  [ ! -e "$REPORT" ]
}

@test "standalone evidence tests prepare a private shared root and reject unsafe roots" {
  run python3 - "$BATS_TEST_DIRNAME/../.." "$EVIDENCE" <<'PY'
import os, re, shlex, stat, subprocess, sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
evidence = Path(sys.argv[2])
source = (root / 'tests/cli/peer-run-evidence.bats').read_text()
assignment = '  project_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"'
assert source.splitlines().count(assignment) == 1
for kind in ['missing', 'owned', 'file', 'symlink', 'dangling']:
    shared = evidence / f'shared-{kind}'
    if kind == 'owned':
        shared.mkdir(mode=0o700)
        (shared / 'keep').write_text('unchanged')
    elif kind == 'file':
        shared.write_text('unchanged')
    elif kind == 'symlink':
        (evidence / 'link-target').mkdir(mode=0o700)
        (evidence / 'link-target' / 'keep').write_text('unchanged')
        shared.symlink_to(evidence / 'link-target')
    elif kind == 'dangling':
        shared.symlink_to(evidence / 'missing-target')
    fixture = evidence / f'{kind}.bats'
    fixture.write_text(source.replace('/tmp/codex', str(shared)).replace(assignment, '  project_root=' + shlex.quote(str(root)), 1))
    result = subprocess.run(['bats', '--tap', '--print-output-on-failure', '--filter', '^checkpoint validates the original fingerprint', str(fixture)], capture_output=True, text=True)
    if kind in ['missing', 'owned']:
        assert result.returncode == 0, result.stdout + result.stderr
        assert shared.is_dir() and not shared.is_symlink()
        assert shared.stat().st_uid == os.getuid()
        assert stat.S_IMODE(shared.stat().st_mode) == 0o700
        assert list(shared.iterdir()) == ([] if kind == 'missing' else [shared / 'keep'])
    else:
        assert result.returncode != 0, kind
        assert 'setup_file failed' in result.stdout, result.stdout
        if kind == 'file':
            assert shared.read_text() == 'unchanged'
        elif kind == 'symlink':
            assert shared.is_symlink()
            assert list((evidence / 'link-target').iterdir()) == [evidence / 'link-target' / 'keep']
        else:
            assert shared.is_symlink() and not (evidence / 'missing-target').exists()

setup_file = re.search(r'^setup_file\(\) \{\n.*?^\}', source, re.M | re.S).group()
if Path('/').stat().st_uid != os.getuid():
    rejected = subprocess.run(['bash', '-c', setup_file.replace('/tmp/codex', '/') + '\nsetup_file'], capture_output=True, text=True)
    assert rejected.returncode != 0
teardown = re.search(r'^teardown\(\) \{\n.*?^\}', source, re.M | re.S).group()
for state in ['unset EVIDENCE', "EVIDENCE=''"]:
    result = subprocess.run(['bash', '-c', 'set -u\n' + teardown + '\n' + state + '\nteardown'], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
PY
  [ "$status" -eq 0 ]
}

@test "restore cleans up failed writes but preserves a concurrently created destination" {
  save_checkpoint
  run python3 - "$SCRIPT" "$REPO" "$REPORT" "$FINGERPRINT" "$CHECKPOINT" <<'PY'
import os, runpy, sys
from pathlib import Path
from unittest.mock import patch

script, repo, report, fingerprint, checkpoint = sys.argv[1:]
os.chdir(repo)
restore = runpy.run_path(script)['restore']
report = Path(report)
original = report.read_bytes()
actual_open, actual_chmod = Path.open, os.fchmod

class FailingStream:
    def __init__(self, stream, fault):
        self.stream, self.fault = stream, fault
    def __enter__(self):
        self.stream.__enter__()
        return self
    def __exit__(self, *args):
        self.stream.__exit__(*args)
        if self.fault == 'close':
            raise OSError('injected close failure')
    def fileno(self):
        return self.stream.fileno()
    def write(self, content):
        if self.fault == 'write':
            self.stream.write(content[:3])
            self.stream.flush()
            raise OSError('injected write failure')
        return self.stream.write(content)

for fault in ['chmod', 'write', 'close', 'concurrent']:
    report.unlink()
    def faulty_open(path, mode='r', *args, **kwargs):
        if path != report or mode != 'xb':
            return actual_open(path, mode, *args, **kwargs)
        if fault == 'concurrent':
            with actual_open(path, 'xb') as stream:
                stream.write(b'newer evidence')
        stream = actual_open(path, mode, *args, **kwargs)
        return FailingStream(stream, fault)
    chmod = OSError('injected chmod failure') if fault == 'chmod' else actual_chmod
    with patch.object(Path, 'open', faulty_open), patch.object(os, 'fchmod', side_effect=chmod):
        try:
            restore(fingerprint, checkpoint)
        except OSError as error:
            if fault == 'concurrent':
                assert isinstance(error, FileExistsError), error
            else:
                assert str(error) == f'injected {fault} failure', error
        else:
            raise AssertionError(f'{fault}: expected restore failure')
    if fault == 'concurrent':
        assert report.read_bytes() == b'newer evidence'
        report.unlink()
    else:
        assert not report.exists(), f'{fault}: incomplete evidence remains'
    restore(fingerprint, checkpoint)
    assert report.read_bytes() == original
PY
  [ "$status" -eq 0 ]
}

@test "restore removes every file it created when a later write fails" {
  save_checkpoint
  run python3 - "$SCRIPT" "$REPO" "$REPORT" "$EVIDENCE/mutation.log" "$FINGERPRINT" "$CHECKPOINT" <<'PY'
import os, runpy, sys
from pathlib import Path
from unittest.mock import patch

script, repo, first, second, fingerprint, checkpoint = sys.argv[1:]
os.chdir(repo)
restore = runpy.run_path(script)['restore']
first, second = Path(first), Path(second)
originals = {path: path.read_bytes() for path in (first, second)}
actual_open = Path.open

for path in originals:
    path.unlink()
created = []
def faulty_open(path, mode='r', *args, **kwargs):
    if mode == 'xb':
        created.append(path)
        if len(created) == 2:
            raise OSError('injected second-file failure')
    return actual_open(path, mode, *args, **kwargs)
with patch.object(Path, 'open', faulty_open):
    try:
        restore(fingerprint, checkpoint)
    except OSError as error:
        assert str(error) == 'injected second-file failure', error
    else:
        raise AssertionError('expected restore failure')
assert len(created) == 2, created
assert not any(path.exists() for path in originals), 'partial evidence remains'
restore(fingerprint, checkpoint)
assert all(path.read_bytes() == content for path, content in originals.items())
PY
  [ "$status" -eq 0 ]
}

@test "restore rollback preserves a destination another writer replaced after creation" {
  save_checkpoint
  run python3 - "$SCRIPT" "$REPO" "$REPORT" "$EVIDENCE/mutation.log" "$FINGERPRINT" "$CHECKPOINT" <<'PY'
import os, runpy, sys
from pathlib import Path
from unittest.mock import patch

script, repo, first, second, fingerprint, checkpoint = sys.argv[1:]
os.chdir(repo)
restore = runpy.run_path(script)['restore']
first, second = Path(first), Path(second)
originals = {path: path.read_bytes() for path in (first, second)}
actual_open = Path.open

for path in originals:
    path.unlink()
created = []
def faulty_open(path, mode='r', *args, **kwargs):
    if mode == 'xb':
        created.append(path)
        if len(created) == 2:
            # 別 writer が先に作った宛先を、旧 inode が残るうちに新しい inode で置き換える。
            victim = created[0]
            replacement = victim.with_name(victim.name + '.other')
            replacement.write_bytes(b'newer evidence')
            os.replace(replacement, victim)
            raise OSError('injected second-file failure')
    return actual_open(path, mode, *args, **kwargs)
with patch.object(Path, 'open', faulty_open):
    try:
        restore(fingerprint, checkpoint)
    except OSError as error:
        assert str(error) == 'injected second-file failure', error
    else:
        raise AssertionError('expected restore failure')
victim = created[0]
assert victim.exists(), 'replaced destination was deleted'
assert victim.read_bytes() == b'newer evidence', 'replaced destination was deleted'
assert not (set(originals) - {victim}) & {p for p in originals if p.exists()}, 'other created file remains'
PY
  [ "$status" -eq 0 ]
}

@test "Orca receipt example validates before publishing and reuses saved worker receipts" {
  run python3 - "$BATS_TEST_DIRNAME/../.." "$EVIDENCE" <<'PY'
import json, os, subprocess, sys
from pathlib import Path
from unittest.mock import patch

root, run = (Path(p).resolve() for p in sys.argv[1:])
receipt = run / 'worker-one'
receipt.mkdir()
(run / 'run-create.json').write_text(json.dumps({'ok': True, 'result': {'run': {'id': 'run-1', 'coordinator_handle': 'parent-1'}}}))
(receipt / 'worker-start.json').write_text(json.dumps({'result': {'dispatchId': 'dispatch-1', 'taskId': 'task-1', 'effects': [{'kind': 'terminal', 'role': 'agent', 'id': 'worker-1'}]}}))
doc = root / 'skills/orca-peer-refactor/references/orca.md'
source = doc.read_text().split("<<'PY'\n", 1)[1].split('\nPY\n```', 1)[0]
source = source.replace('<skill-dir>', str(root / 'skills/orca-peer-refactor'))
actual_run = subprocess.run
queries = []
worker_output = json.dumps({'ok': True, 'result': {'dispatch': {'id': 'dispatch-1', 'taskId': 'task-1', 'assigneeHandle': 'worker-1', 'status': 'dispatched'}}})
def fake_orca(argv, **kwargs):
    if argv[0] != 'orca-ide':
        return actual_run(argv, **kwargs)
    if 'worker-show' in argv:
        queries.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=worker_output)
    return subprocess.CompletedProcess(argv, 0, stdout=json.dumps({'result': {'runId': 'run-1'}}))

valid_output = worker_output
for name, worker_output in [('malformed', '{"ok":'), ('rejected', '{"ok":false,"result":{}}'), ('mismatch', valid_output.replace('dispatch-1', 'dispatch-other'))]:
    failed_receipt = run / name
    failed_receipt.mkdir()
    (failed_receipt / 'worker-start.json').write_bytes((receipt / 'worker-start.json').read_bytes())
    with patch.object(sys, 'argv', ['example', str(run), str(failed_receipt)]), patch.dict(os.environ, {'ORCA_TERMINAL_HANDLE': 'parent-1', 'ORCA_CLI': 'orca-ide', 'SKILL_DIR': str(root / 'skills/orca-peer-refactor')}), patch.object(subprocess, 'run', fake_orca):
        try:
            exec(compile(source, str(doc), 'exec'), {})
        except subprocess.CalledProcessError:
            pass
        else:
            raise AssertionError(f'{name}: invalid receipt was accepted')
        assert not (failed_receipt / 'worker-show.json').exists(), name
        pending = failed_receipt / 'worker-show.json.part'
        assert pending.read_text() == worker_output, name
        before_retry = len(queries)
        try:
            exec(compile(source, str(doc), 'exec'), {})
        except SystemExit:
            pass
        else:
            raise AssertionError(f'{name}: unfinished receipt was ignored')
        assert len(queries) == before_retry, name
        assert pending.read_text() == worker_output, name

worker_output = valid_output
queries.clear()

with patch.object(sys, 'argv', ['example', str(run), str(receipt)]), patch.dict(os.environ, {'ORCA_TERMINAL_HANDLE': 'parent-1', 'ORCA_CLI': 'orca-ide', 'SKILL_DIR': str(root / 'skills/orca-peer-refactor')}), patch.object(subprocess, 'run', fake_orca):
    exec(compile(source, str(doc), 'exec'), {})
    original = (receipt / 'worker-show.json').read_bytes()
    exec(compile(source, str(doc), 'exec'), {})
assert len(queries) == 1, queries
assert (receipt / 'worker-show.json').read_bytes() == original
PY
  [ "$status" -eq 0 ]
}

@test "Orca shell receipt examples publish only complete successful output and preserve failed attempts" {
  run python3 - "$BATS_TEST_DIRNAME/../.." "$EVIDENCE" <<'PY'
import json, os, re, subprocess, sys
from pathlib import Path

root, evidence = (Path(p).resolve() for p in sys.argv[1:])
doc = root / 'skills/orca-peer-refactor/references/orca.md'
examples = re.findall(r'\(set -C\b.*?\)', doc.read_text(), re.S)
assert len(examples) == 5, examples
binary = evidence / 'bin'
binary.mkdir()
fake = binary / 'ORCA'
fake.write_text('''#!/usr/bin/env python3
import os, signal, sys
with open(os.environ['RECEIPT_CALLS'], 'a') as stream:
    stream.write('called\\n')
sys.stdout.write(os.environ['RECEIPT_OUTPUT'])
sys.stdout.flush()
if os.environ['RECEIPT_MODE'] == 'interrupted':
    os.kill(os.getpid(), signal.SIGTERM)
sys.exit(1 if os.environ['RECEIPT_MODE'] == 'failed' else 0)
''')
fake.chmod(0o700)
complete = json.dumps({'ok': True, 'result': {'id': 'receipt-1'}})
for index, example in enumerate(examples):
    command = re.sub(r'<[^>]+>', 'fixture', example)
    operation = re.search(r'ORCA orchestration (run-create|worker-start|worker-show)', command).group(1)
    for mode, output in [('failed', complete), ('interrupted', '{"ok":'), ('empty', ''), ('malformed', '{"ok":'), ('success', complete), ('existing', complete)]:
        folder = evidence / f'{index}-{mode}'
        folder.mkdir()
        final = folder / f'{operation}.json'
        pending = folder / f'{operation}.json.part'
        calls = folder / 'calls'
        env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ['PATH'], RECEIPT_MODE=mode, RECEIPT_OUTPUT=output, RECEIPT_CALLS=str(calls))
        env.update({key: str(folder) for key in ['run_dir', 'receipt_dir', 'child_run_dir', 'child_receipt_dir']})
        if mode == 'existing':
            final.write_text('original receipt\n')
        result = subprocess.run(['bash', '-c', command], env=env, capture_output=True, text=True)
        if mode == 'success':
            assert result.returncode == 0, result.stderr
            assert final.read_text() == complete
        elif mode == 'existing':
            assert result.returncode != 0
            assert final.read_text() == 'original receipt\n'
            assert not calls.exists(), command
        else:
            assert result.returncode != 0, (mode, command)
            assert not final.exists(), (mode, command)
            assert pending.read_text() == output
            before_retry = calls.read_bytes()
            retried = subprocess.run(['bash', '-c', command], env=env, capture_output=True, text=True)
            assert retried.returncode != 0
            assert calls.read_bytes() == before_retry, command
            assert pending.read_text() == output

for index, heading in enumerate(['### coordinator\n', '### nested coordinator\n']):
    block = doc.read_text().split(heading, 1)[1].split('```text\n', 1)[1].split('\n```', 1)[0]
    block = block.replace('<skill-dir>', str(root / 'skills/orca-peer-refactor'))
    command = re.sub(r'<[^>]+>', 'fixture', block)
    for mode in ['failed', 'interrupted', 'malformed']:
        folder = evidence / f'sequence-{index}-{mode}'
        folder.mkdir()
        calls = folder / 'calls'
        env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ['PATH'], run_dir=str(folder), RECEIPT_MODE=mode, RECEIPT_OUTPUT='{"ok":', RECEIPT_CALLS=str(calls))
        result = subprocess.run(['bash', '-c', command], env=env, capture_output=True, text=True)
        assert result.returncode != 0, (heading, mode)
        assert calls.read_text().splitlines() == ['called'], (heading, mode, 'later operation ran')
PY
  [ "$status" -eq 0 ]
}

@test "read_public は検査後に祖先 directory が symlink へ差し替えられても外部を読まない" {
  mkdir -p "$EVIDENCE/dir" "$BATS_TEST_TMPDIR/outside"
  printf 'inside\n' >"$EVIDENCE/dir/f"
  printf 'outside\n' >"$BATS_TEST_TMPDIR/outside/f"
  run python3 -B -I - "$SCRIPT" "$EVIDENCE/dir/f" "$EVIDENCE/dir" "$BATS_TEST_TMPDIR/outside" <<'PY'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("run_evidence", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
target, anc, outside = sys.argv[2:5]
checked = m.public_path
def swap(value, artifact_path=None):
    path = checked(value, artifact_path)
    os.rename(anc, anc + ".moved")
    os.symlink(outside, anc)
    return path
m.public_path = swap
try:
    data = m.read_public(target)
except ValueError:
    data = b"rejected"
print(data.decode().strip())
PY
  [ "$status" -eq 0 ]
  [ "$output" = rejected ]
}

@test "read_public は共有 directory 自体が system の symlink 配下にあっても読める" {
  mkdir -p "$BATS_TEST_TMPDIR/real/codex"
  ln -s "$BATS_TEST_TMPDIR/real" "$BATS_TEST_TMPDIR/tmp"
  printf 'inside\n' >"$BATS_TEST_TMPDIR/real/codex/f"
  run python3 -B -I - "$SCRIPT" "$BATS_TEST_TMPDIR/tmp/codex" <<'PY'
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("run_evidence", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.SHARED = Path(sys.argv[2])
print(m.read_public(str(m.SHARED / "f")).decode().strip())
PY
  [ "$status" -eq 0 ]
  [ "$output" = inside ]
}
