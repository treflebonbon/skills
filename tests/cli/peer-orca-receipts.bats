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
  run node - "$BATS_TEST_DIRNAME/../.." "$EVIDENCE" <<'JS'
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const [root, run] = process.argv.slice(2).map(p => fs.realpathSync(p));
const doc = fs.readFileSync(path.join(root, 'skills/orca-peer-refactor/references/orca.md'), 'utf8');
const example = doc.split('## ID を receipt から渡す\n')[1].split('```bash\n')[1].split('\n```')[0];
const calls = path.join(run, 'calls.jsonl'), cli = path.join(run, 'orca-fixture');
fs.writeFileSync(cli, [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  'const args = process.argv.slice(2);',
  "fs.appendFileSync(process.env.ORCA_CALLS, JSON.stringify(args) + '\\n');",
  "process.stdout.write(args[1] === 'worker-show' ? process.env.WORKER_OUTPUT : JSON.stringify({result:{runId:'run-1'}}));",
].join('\n')+'\n', { mode: 0o700 });
fs.writeFileSync(path.join(run, 'run-create.json'), JSON.stringify({ok:true,result:{run:{id:'run-1',coordinator_handle:'parent-1'}}}));
const started = {result:{dispatchId:'dispatch-1',taskId:'task-1',effects:[{kind:'terminal',role:'agent',id:'worker-1'}]}};
const valid = JSON.stringify({ok:true,result:{dispatch:{id:'dispatch-1',taskId:'task-1',assigneeHandle:'worker-1',status:'dispatched'}}});
const recorded = () => fs.existsSync(calls) ? fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse) : [];
const queries = () => recorded().filter(args => args[1] === 'worker-show');
const expectedChecks = [
 ['orchestration','check','--terminal','parent-1','--peek','--json'],
 ['orchestration','check','--terminal','parent-1','--run','run-1','--wait','--timeout-ms','45000','--json'],
];
for (const [name, output] of [['malformed','{"ok":'], ['rejected','{"ok":false,"result":{}}'], ['mismatch',valid.replace('dispatch-1','dispatch-other')], ['valid',valid]]) {
  const receipt = path.join(run, name); fs.mkdirSync(receipt);
  fs.writeFileSync(path.join(receipt,'worker-start.json'), JSON.stringify(started));
  const invoke = () => spawnSync('bash',['-c',example],{encoding:'utf8',env:{...process.env,run_dir:run,receipt_dir:receipt,ORCA_CLI:cli,ORCA_TERMINAL_HANDLE:'parent-1',SKILL_DIR:path.join(root,'skills/orca-peer-refactor'),ORCA_CALLS:calls,WORKER_OUTPUT:output}});
  const before = queries().length, commandCount = recorded().length, result = invoke();
  assert.deepEqual(recorded().slice(commandCount), [...expectedChecks, ['orchestration','worker-show','--dispatch','dispatch-1','--json']]);
  const final = path.join(receipt,'worker-show.json'), pending = final+'.part';
  if (name === 'valid') {
    assert.equal(result.status,0,result.stderr);
    const original=fs.readFileSync(final);
    assert.equal(invoke().status,0);
    assert.deepEqual(fs.readFileSync(final),original);
  } else {
    assert.notEqual(result.status,0);
    const diagnostic = name === 'malformed' ? /receipt を読み取れません/ : name === 'rejected' ? /receipt が成功応答ではありません/ : /Dispatch ID が期待値と一致しません/;
    assert.match(result.stderr,diagnostic);
    assert(!fs.existsSync(final));
    assert.equal(fs.readFileSync(pending,'utf8'),output);
    const retry=invoke();assert.notEqual(retry.status,0);assert.match(retry.stderr,/未確定の receipt/);
    assert.equal(fs.readFileSync(pending,'utf8'),output);
  }
  assert.equal(queries().length,before+1);
  assert.deepEqual(recorded().slice(commandCount + 3),expectedChecks);
  assert.deepEqual(queries().at(-1),['orchestration','worker-show','--dispatch','dispatch-1','--json']);
}
JS
  [ "$status" -eq 0 ]
}

@test "Orca shell receipt examples publish only complete successful output and preserve failed attempts" {
  run node - "$BATS_TEST_DIRNAME/../.." "$EVIDENCE" <<'JS'
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const [root,evidence]=process.argv.slice(2).map(p=>fs.realpathSync(p));
const doc=fs.readFileSync(path.join(root,'skills/orca-peer-refactor/references/orca.md'),'utf8');
const examples=[...doc.matchAll(/\(set -C\b[\s\S]*?\)/g)].map(match=>match[0]);
assert.equal(examples.length,5);
const binary=path.join(evidence,'bin');fs.mkdirSync(binary);
fs.writeFileSync(path.join(binary,'ORCA'),[
 '#!/usr/bin/env node',"const fs = require('node:fs');",
 "fs.appendFileSync(process.env.RECEIPT_CALLS,JSON.stringify(process.argv.slice(2))+'\\n');",
 "fs.writeSync(1,process.env.RECEIPT_OUTPUT);",
 "if(process.env.RECEIPT_MODE === 'interrupted') process.kill(process.pid,'SIGTERM');",
 "process.exit(process.env.RECEIPT_MODE === 'failed' ? 1 : 0);",
].join('\n')+'\n',{mode:0o700});
const complete=JSON.stringify({ok:true,result:{id:'receipt-1'}});
const commandFor = source => source.replaceAll('<skill-dir>',path.join(root,'skills/orca-peer-refactor')).replace(/<[^>]+>/g,'fixture');
const expectedArgs = [
 ['orchestration','run-create','--objective','fixture','--from','fixture','--json'],
 ['orchestration','worker-start','--task','fixture','--worktree','id:fixture','--agent','claude','--run','fixture','--from','fixture','--json'],
 ['orchestration','worker-show','--dispatch','fixture','--json'],
 ['orchestration','run-create','--objective','fixture','--from','fixture','--json'],
 ['orchestration','worker-start','--task','fixture','--worktree','id:fixture','--agent','codex','--run','fixture','--from','fixture','--json'],
];
const recorded = calls => fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);
for (const [index,example] of examples.entries()) {
 const command=commandFor(example), operation=/ORCA orchestration (run-create|worker-start|worker-show)/.exec(command)[1];
 for (const [mode,output] of [['failed',complete],['interrupted','{"ok":'],['empty',''],['malformed','{"ok":'],['success',complete],['existing',complete]]) {
  const folder=path.join(evidence,index+'-'+mode);fs.mkdirSync(folder);
  const final=path.join(folder,operation+'.json'),pending=final+'.part',calls=path.join(folder,'calls');
  const env={...process.env,PATH:binary+path.delimiter+process.env.PATH,RECEIPT_MODE:mode,RECEIPT_OUTPUT:output,RECEIPT_CALLS:calls};
  for (const key of ['run_dir','receipt_dir','child_run_dir','child_receipt_dir']) env[key]=folder;
  if (mode==='existing') fs.writeFileSync(final,'original receipt\n');
  const result=spawnSync('bash',['-c',command],{env,encoding:'utf8'});
  if (mode !== 'existing') assert.deepEqual(recorded(calls),[expectedArgs[index]]);
  if (mode==='success') { assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(final,'utf8'),complete); }
  else if (mode==='existing') { assert.notEqual(result.status,0);assert.equal(fs.readFileSync(final,'utf8'),'original receipt\n');assert(!fs.existsSync(calls)); }
  else {
   assert.notEqual(result.status,0);assert(!fs.existsSync(final));assert.equal(fs.readFileSync(pending,'utf8'),output);
   const before=fs.readFileSync(calls);assert.notEqual(spawnSync('bash',['-c',command],{env,encoding:'utf8'}).status,0);
   assert.deepEqual(fs.readFileSync(calls),before);assert.equal(fs.readFileSync(pending,'utf8'),output);
  }
 }
}
for (const [index,heading] of ['### coordinator\n','### nested coordinator\n'].entries()) {
 const block=doc.split(heading)[1].split('```text\n')[1].split('\n```')[0],command=commandFor(block);
 for (const mode of ['failed','interrupted','malformed']) {
  const folder=path.join(evidence,'sequence-'+index+'-'+mode);fs.mkdirSync(folder);const calls=path.join(folder,'calls');
  const env={...process.env,PATH:binary+path.delimiter+process.env.PATH,run_dir:folder,RECEIPT_MODE:mode,RECEIPT_OUTPUT:'{"ok":',RECEIPT_CALLS:calls};
  const result=spawnSync('bash',['-c',command],{env,encoding:'utf8'});assert.notEqual(result.status,0);
  assert.deepEqual(recorded(calls),[expectedArgs[index === 0 ? 0 : 3]],'後続の操作が実行されました');
 }
}
JS
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
