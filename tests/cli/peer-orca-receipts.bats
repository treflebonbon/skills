#!/usr/bin/env bats

setup() {
  mkdir -m 700 /tmp/codex 2>/dev/null || :
  if ! [ -d /tmp/codex ] || [ -L /tmp/codex ] || ! [ -O /tmp/codex ]; then
    echo '/tmp/codex は実行ユーザー所有の通常 directory が必要です' >&2
    return 1
  fi
  EVIDENCE="$(mktemp -d /tmp/codex/peer-orca-receipts.XXXXXX)"
}

teardown() {
  if [[ "${EVIDENCE:-}" == /tmp/codex/peer-orca-receipts.* ]]; then
    rm -r -- "$EVIDENCE"
  fi
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

@test "単独 receipt テストは共有先を準備し、通常ファイルと symlink を拒否する" {
  run node - "$BATS_TEST_DIRNAME/../.." "$EVIDENCE" <<'JS'
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const [root, evidence] = process.argv.slice(2).map(p => fs.realpathSync(p));
const source = fs.readFileSync(path.join(root, 'tests/cli/peer-orca-receipts.bats'), 'utf8');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
for (const kind of ['missing', 'owned', 'file', 'symlink', 'dangling']) {
  const shared = path.join(evidence, 'shared-' + kind);
  if (kind === 'owned') {
    fs.mkdirSync(shared, { mode: 0o700 });
    fs.writeFileSync(path.join(shared, 'keep'), 'unchanged');
  } else if (kind === 'file') fs.writeFileSync(shared, 'unchanged');
  else if (kind === 'symlink') {
    const target = shared + '.target';
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, shared);
  } else if (kind === 'dangling') fs.symlinkSync(shared + '.absent', shared);
  const fixture = path.join(evidence, kind + '.bats');
  fs.writeFileSync(fixture, source.replaceAll('/tmp/codex', shared).replaceAll('"$BATS_TEST_DIRNAME/../.."', quote(root)));
  const result = spawnSync('bats', ['--tap', '--filter', '^Orca receipt example validates', fixture], { encoding: 'utf8' });
  if (['missing', 'owned'].includes(kind)) {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.lstatSync(shared).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(shared), kind === 'owned' ? ['keep'] : []);
  } else {
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /実行ユーザー所有の通常 directory/);
    if (kind === 'file') assert.equal(fs.readFileSync(shared, 'utf8'), 'unchanged');
    else assert(fs.lstatSync(shared).isSymbolicLink());
  }
}
JS
  [ "$status" -eq 0 ]
}
