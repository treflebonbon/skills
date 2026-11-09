#!/usr/bin/env bats

@test "PR body attachment publishes the confirmed asset and deduplicates concurrent requests" {
  run node --input-type=module - "$BATS_TEST_DIRNAME/../libexec/pr-evidence.mjs" "$BATS_TEST_TMPDIR" <<'JS'
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const { attachEvidenceToPullRequestBody } = await import(process.argv[2]);
const directory = process.argv[3];
const image = path.join(directory, 'image.png');
await writeFile(image, 'image bytes');
let body = 'Before\nPLACE';
let uploads = 0;
let edits = 0;
let connections = 0;
const github = async (args) => {
  assert.equal(args[0], 'pr');
  assert.equal(args[2], '42');
  assert.equal(args[args.indexOf('--repo') + 1], 'owner/repo');
  if (args[1] === 'view') return JSON.stringify({ body });
  if (args[1] === 'edit') {
    edits += 1;
    body = await readFile(args.at(-1), 'utf8');
    return '';
  }
  throw new Error(`unexpected GitHub command: ${args.join(' ')}`);
};
const withUploadContext = async (action) => {
  connections += 1;
  let text = '';
  const textarea = { waitFor: async () => {}, inputValue: async () => text };
  const input = {
    waitFor: async () => {},
    setInputFiles: async (filename) => {
      assert.equal(path.basename(filename), path.basename(image));
      assert.equal(await readFile(filename, 'utf8'), 'image bytes');
      await delay(40);
      uploads += 1;
      text = 'https://github.com/user-attachments/assets/confirmed';
    },
  };
  const editor = {
    locator: (selector) => {
      if (selector === 'textarea[name="pull_request[body]"]') return textarea;
      if (selector === 'input[type=file]') return input;
      throw new Error(`unexpected editor selector: ${selector}`);
    },
    getByText: (value, options) => {
      assert.equal(value, 'Edit');
      assert.deepEqual(options, { exact: true });
      return { click: async () => {} };
    },
  };
  const container = {
    locator: (selector) => {
      if (selector === 'summary.timeline-comment-action') return { click: async () => {} };
      return editor.locator(selector);
    },
    getByText: editor.getByText,
  };
  const page = {
    goto: async () => {},
    url: () => 'https://github.com/owner/repo/pull/42',
    locator: (selector) => {
      assert.equal(selector, '.js-comment-container');
      return { first: () => container };
    },
    close: async () => {},
  };
  return action({ newPage: async () => page });
};
const options = {
  repo: 'owner/repo', pr: 42, image, placeholder: 'PLACE', requestId: 'same-request',
  directory, github, withUploadContext,
};
const results = await Promise.all([
  attachEvidenceToPullRequestBody(options),
  attachEvidenceToPullRequestBody(options),
]);
assert.equal(uploads, 1);
assert.equal(connections, 1);
assert.equal(edits, 1);
assert.ok(!body.includes('PLACE'));
assert.ok(body.includes('![Evidence](https://github.com/user-attachments/assets/confirmed)'));
const differentImage = path.join(directory, 'different.png');
await writeFile(differentImage, 'different image bytes');
await assert.rejects(
  attachEvidenceToPullRequestBody({ ...options, image: differentImage }),
  /request-conflict:/
);
await assert.rejects(
  attachEvidenceToPullRequestBody({ ...options, placeholder: 'OTHER' }),
  /request-conflict:/
);
assert.equal(uploads, 1);
assert.equal(edits, 1);
for (const result of results) {
  assert.equal(result.asset, 'https://github.com/user-attachments/assets/confirmed');
  assert.equal(result.requestId, 'same-request');
  assert.ok(Number.isFinite(result.started));
  assert.ok(Number.isFinite(result.finished));
  assert.ok(result.started <= result.finished);
}
JS
  [ "$status" -eq 0 ]
}

@test "PR body attachment resumes before-send failures and blocks uncertain uploads" {
  run node --input-type=module - "$BATS_TEST_DIRNAME/../libexec/pr-evidence.mjs" "$BATS_TEST_TMPDIR" <<'JS'
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const { attachEvidenceToPullRequestBody } = await import(process.argv[2]);
const directory = process.argv[3];
const image = path.join(directory, 'image.png');
await writeFile(image, 'image bytes');
let body = 'CONNECT_PLACE\nAUTH_PLACE\nUNCERTAIN_PLACE';
let failConnection = true;
let needsAuthentication = false;
let uncertainUpload = false;
let connections = 0;
let uploadAttempts = 0;
const github = async (args) => {
  assert.equal(args[0], 'pr');
  assert.equal(args[2], '42');
  assert.equal(args[args.indexOf('--repo') + 1], 'owner/repo');
  if (args[1] === 'view') return JSON.stringify({ body });
  if (args[1] === 'edit') {
    body = await readFile(args.at(-1), 'utf8');
    return '';
  }
  throw new Error(`unexpected GitHub command: ${args.join(' ')}`);
};
const makeContext = () => {
  let text = '';
  const textarea = { waitFor: async () => {}, inputValue: async () => text };
  const input = {
    waitFor: async () => {},
    setInputFiles: async () => {
      uploadAttempts += 1;
      if (uncertainUpload) throw new Error('connection lost after send');
      text = `https://github.com/user-attachments/assets/${uploadAttempts}`;
    },
  };
  const editor = {
    locator: (selector) => {
      if (selector === 'textarea[name="pull_request[body]"]') return textarea;
      if (selector === 'input[type=file]') return input;
      throw new Error(`unexpected editor selector: ${selector}`);
    },
    getByText: () => ({ click: async () => {} }),
  };
  const container = {
    locator: (selector) => selector === 'summary.timeline-comment-action'
      ? { click: async () => {} }
      : editor.locator(selector),
    getByText: editor.getByText,
  };
  const page = {
    goto: async () => {},
    url: () => needsAuthentication
      ? 'https://github.com/login'
      : 'https://github.com/owner/repo/pull/42',
    locator: () => ({ first: () => container }),
    close: async () => {},
  };
  return { newPage: async () => page };
};
const withUploadContext = async (action) => {
  connections += 1;
  if (failConnection) {
    failConnection = false;
    throw new Error('cdp-unavailable: browser is not connected');
  }
  return action(makeContext());
};
const options = (placeholder, requestId) => ({
  repo: 'owner/repo', pr: 42, image, placeholder, requestId, directory, github, withUploadContext,
});
await assert.rejects(
  attachEvidenceToPullRequestBody(options('CONNECT_PLACE', 'connect-request')),
  /cdp-unavailable:/
);
const connected = await attachEvidenceToPullRequestBody(options('CONNECT_PLACE', 'connect-request'));
assert.equal(connected.requestId, 'connect-request');
needsAuthentication = true;
await assert.rejects(
  attachEvidenceToPullRequestBody(options('AUTH_PLACE', 'auth-request')),
  /authentication-required:/
);
needsAuthentication = false;
const authenticated = await attachEvidenceToPullRequestBody(options('AUTH_PLACE', 'auth-request'));
assert.equal(authenticated.requestId, 'auth-request');
uncertainUpload = true;
await assert.rejects(
  attachEvidenceToPullRequestBody(options('UNCERTAIN_PLACE', 'uncertain-request')),
  /upload-failed:/
);
const afterUncertainFailure = { connections, uploadAttempts };
await assert.rejects(
  attachEvidenceToPullRequestBody(options('UNCERTAIN_PLACE', 'uncertain-request')),
  /upload-unconfirmed:/
);
assert.equal(connections, afterUncertainFailure.connections);
assert.equal(uploadAttempts, afterUncertainFailure.uploadAttempts);
assert.ok(body.includes('![Evidence](https://github.com/user-attachments/assets/1)'));
assert.ok(body.includes('![Evidence](https://github.com/user-attachments/assets/2)'));
assert.ok(body.includes('UNCERTAIN_PLACE'));
JS
  [ "$status" -eq 0 ]
}

@test "PR body attachment uploads the signed image snapshot after the original changes" {
  run node --input-type=module - "$BATS_TEST_DIRNAME/../libexec/pr-evidence.mjs" "$BATS_TEST_TMPDIR" <<'JS'
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const { attachEvidenceToPullRequestBody } = await import(process.argv[2]);
const directory = process.argv[3];
const image = path.join(directory, 'image.png');
const signedBytes = Buffer.from('signed image bytes');
await writeFile(image, signedBytes);
let body = 'PLACE';
let uploadedName;
let uploadedBytes;
const github = async (args) => {
  assert.equal(args[0], 'pr');
  assert.equal(args[2], '42');
  assert.equal(args[args.indexOf('--repo') + 1], 'owner/repo');
  if (args[1] === 'view') return JSON.stringify({ body });
  if (args[1] === 'edit') {
    body = await readFile(args.at(-1), 'utf8');
    return '';
  }
  throw new Error(`unexpected GitHub command: ${args.join(' ')}`);
};
const withUploadContext = async (action) => {
  await writeFile(image, 'replacement bytes');
  const textarea = { waitFor: async () => {}, inputValue: async () => '' };
  const input = {
    waitFor: async () => {},
    setInputFiles: async (filename) => {
      uploadedName = path.basename(filename);
      uploadedBytes = await readFile(filename);
      textarea.inputValue = async () => 'https://github.com/user-attachments/assets/signed';
    },
  };
  const editor = {
    locator: (selector) => selector.includes('textarea') ? textarea : input,
    getByText: () => ({ click: async () => {} }),
  };
  const container = {
    locator: (selector) => selector === 'summary.timeline-comment-action'
      ? { click: async () => {} }
      : editor.locator(selector),
    getByText: editor.getByText,
  };
  const page = {
    goto: async () => {},
    url: () => 'https://github.com/owner/repo/pull/42',
    locator: () => ({ first: () => container }),
    close: async () => {},
  };
  return action({ newPage: async () => page });
};
await attachEvidenceToPullRequestBody({
  repo: 'owner/repo', pr: 42, image, placeholder: 'PLACE', requestId: 'signed-bytes',
  directory, github, withUploadContext,
});
assert.equal(uploadedName, 'image.png');
assert.deepEqual(uploadedBytes, signedBytes);
assert.ok(body.includes('![Evidence](https://github.com/user-attachments/assets/signed)'));
JS
  if [ "$status" -ne 0 ]; then printf '%s\n' "$output"; fi
  [ "$status" -eq 0 ]
}

@test "PR body attachment can retry the same request after failures before sending" {
  run node --input-type=module - "$BATS_TEST_DIRNAME/../libexec/pr-evidence.mjs" "$BATS_TEST_TMPDIR" <<'JS'
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const { attachEvidenceToPullRequestBody } = await import(process.argv[2]);
const directory = process.argv[3];
const image = path.join(directory, 'image.png');
await writeFile(image, 'image bytes');
let body = '';
let failStage;
let sends = 0;
const github = async (args) => {
  assert.equal(args[0], 'pr');
  assert.equal(args[2], '42');
  assert.equal(args[args.indexOf('--repo') + 1], 'owner/repo');
  if (args[1] === 'view') return JSON.stringify({ body });
  if (args[1] === 'edit') {
    body = await readFile(args.at(-1), 'utf8');
    return '';
  }
  throw new Error(`unexpected GitHub command: ${args.join(' ')}`);
};
const withUploadContext = async (action) => {
  let text = '';
  const textarea = { waitFor: async () => {}, inputValue: async () => text };
  const input = {
    waitFor: async () => {
      if (failStage === 'input') throw new Error('input wait failed');
    },
    setInputFiles: async () => {
      sends += 1;
      text = `https://github.com/user-attachments/assets/${sends}`;
    },
  };
  const editor = {
    locator: (selector) => selector.includes('textarea') ? textarea : input,
    getByText: (value) => ({ click: async () => {
      if (value === 'Edit' && failStage === 'edit') throw new Error('edit click failed');
    } }),
  };
  const container = {
    locator: (selector) => selector === 'summary.timeline-comment-action'
      ? { click: async () => {} }
      : editor.locator(selector),
    getByText: editor.getByText,
  };
  const page = {
    goto: async () => { if (failStage === 'goto') throw new Error('goto failed'); },
    url: () => 'https://github.com/owner/repo/pull/42',
    locator: () => ({ first: () => container }),
    close: async () => {},
  };
  return action({
    newPage: async () => {
      if (failStage === 'newPage') throw new Error('newPage failed');
      return page;
    },
  });
};
for (const [stage, expected] of [
  ['newPage', /newPage failed/],
  ['goto', /upload-failed:/],
  ['edit', /upload-failed:/],
  ['input', /upload-failed:/],
]) {
  const placeholder = `PLACE_${stage}`;
  const requestId = `retry-${stage}`;
  body += `${placeholder}\n`;
  const options = {
    repo: 'owner/repo', pr: 42, image, placeholder, requestId,
    directory, github, withUploadContext,
  };
  failStage = stage;
  await assert.rejects(attachEvidenceToPullRequestBody(options), expected);
  assert.equal(sends, ['newPage', 'goto', 'edit', 'input'].indexOf(stage));
  failStage = undefined;
  const resumed = await attachEvidenceToPullRequestBody(options);
  assert.equal(resumed.requestId, requestId);
  assert.equal(sends, ['newPage', 'goto', 'edit', 'input'].indexOf(stage) + 1);
}
JS
  if [ "$status" -ne 0 ]; then printf '%s\n' "$output"; fi
  [ "$status" -eq 0 ]
}

@test "PR body attachment reuses a confirmed asset after publish failure and preserves concurrent updates" {
  run node --input-type=module - "$BATS_TEST_DIRNAME/../libexec/pr-evidence.mjs" "$BATS_TEST_TMPDIR" <<'JS'
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const { attachEvidenceToPullRequestBody } = await import(process.argv[2]);
const directory = process.argv[3];
const images = Object.fromEntries(await Promise.all(
  ['fail', 'a', 'b'].map(async (name) => {
    const image = path.join(directory, `${name}.png`);
    await writeFile(image, `${name} image bytes`);
    return [name, image];
  })
));
let body = 'FAIL_PLACE\nA_PLACE\nB_PLACE';
let failNextEdit = true;
let connections = 0;
let uploads = 0;
const github = async (args) => {
  assert.equal(args[0], 'pr');
  assert.equal(args[2], '42');
  assert.equal(args[args.indexOf('--repo') + 1], 'owner/repo');
  if (args[1] === 'view') {
    const snapshot = body;
    await delay(40);
    return JSON.stringify({ body: snapshot });
  }
  if (args[1] === 'edit') {
    const updated = await readFile(args.at(-1), 'utf8');
    if (failNextEdit) {
      failNextEdit = false;
      throw new Error('temporary edit failure');
    }
    body = updated;
    return '';
  }
  throw new Error(`unexpected GitHub command: ${args.join(' ')}`);
};
const withUploadContext = async (action) => {
  connections += 1;
  let text = '';
  const textarea = { waitFor: async () => {}, inputValue: async () => text };
  const input = {
    waitFor: async () => {},
    setInputFiles: async (image) => {
      uploads += 1;
      const name = path.basename(image, '.png');
      text = `https://github.com/user-attachments/assets/${name}`;
    },
  };
  const editor = {
    locator: (selector) => selector === 'textarea[name="pull_request[body]"]'
      ? textarea
      : input,
    getByText: () => ({ click: async () => {} }),
  };
  const container = {
    locator: (selector) => selector === 'summary.timeline-comment-action'
      ? { click: async () => {} }
      : editor.locator(selector),
    getByText: editor.getByText,
  };
  const page = {
    goto: async () => {},
    url: () => 'https://github.com/owner/repo/pull/42',
    locator: () => ({ first: () => container }),
    close: async () => {},
  };
  return action({ newPage: async () => page });
};
const attach = (name, placeholder, requestId) => attachEvidenceToPullRequestBody({
  repo: 'owner/repo', pr: 42, image: images[name], placeholder, requestId,
  directory, github, withUploadContext,
});
await assert.rejects(attach('fail', 'FAIL_PLACE', 'failed-publish'), /temporary edit failure/);
const beforeRetry = { connections, uploads };
const resumed = await attach('fail', 'FAIL_PLACE', 'failed-publish');
assert.equal(resumed.asset, 'https://github.com/user-attachments/assets/fail');
assert.equal(resumed.requestId, 'failed-publish');
assert.deepEqual({ connections, uploads }, beforeRetry);
const [a, b] = await Promise.all([
  attach('a', 'A_PLACE', 'request-a'),
  attach('b', 'B_PLACE', 'request-b'),
]);
assert.equal(a.asset, 'https://github.com/user-attachments/assets/a');
assert.equal(b.asset, 'https://github.com/user-attachments/assets/b');
assert.equal(uploads, 3);
assert.ok(body.includes('/assets/fail'));
assert.ok(body.includes('/assets/a'));
assert.ok(body.includes('/assets/b'));
assert.ok(!body.includes('_PLACE'));
JS
  [ "$status" -eq 0 ]
}

@test "PR evidence preserves both concurrent updates to one PR" {
  run node --input-type=module - "$BATS_TEST_DIRNAME/../libexec/pr-evidence.mjs" "$BATS_TEST_TMPDIR" <<'JS'
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const { publishEvidence } = await import(process.argv[2]);
let body = 'Existing text\nPLACE_A\nPLACE_B';
const github = async (args) => {
 if(args[1] === 'view') { const snapshot=body; await delay(50); return JSON.stringify({body:snapshot}); }
 if(args[1] === 'edit') {const {readFile}=await import('node:fs/promises');body=await readFile(args.at(-1),'utf8');return '';}
 throw new Error('unexpected command');
};
await Promise.all(['A','B'].map(label=>publishEvidence({repo:'owner/repo',pr:42,placeholder:`PLACE_${label}`,asset:`https://github.com/user-attachments/assets/${label}`,directory:process.argv[3],github})));
assert.ok(body.startsWith('Existing text'));
assert.ok(body.includes('/assets/A'));
assert.ok(body.includes('/assets/B'));
JS
  [ "$status" -eq 0 ]
}

@test "upload failure closes only its owned page and preserves the sibling page" {
  run node --input-type=module - "$BATS_TEST_DIRNAME/../libexec/pr-evidence.mjs" <<'JS'
import assert from 'node:assert/strict';
const { uploadEvidence }=await import(process.argv[2]);
let closed=0; const sibling={closed:false};
const editor={inputValue:async()=>'',waitFor:async()=>{},evaluate:async()=>{},setInputFiles:async()=>{throw new Error('network failed');}};
const body={locator:()=>editor,getByText:()=>({click:async()=>{}})};
const page={goto:async()=>{},url:()=> 'https://github.com/owner/repo/pull/42',locator:()=>({first:()=>body}),close:async()=>{closed++;}};
editor.click=async()=>{};
await assert.rejects(uploadEvidence({newPage:async()=>page,pages:()=>[sibling,page],close:async()=>{sibling.closed=true;}},{repo:'owner/repo',pr:42,image:'/dummy.png'}), /upload-failed/);
assert.equal(closed,1);assert.equal(sibling.closed,false);
JS
  [ "$status" -eq 0 ]
}

@test "reusing an existing asset still replaces a different requested placeholder" {
  run node --input-type=module - "$BATS_TEST_DIRNAME/../libexec/pr-evidence.mjs" "$BATS_TEST_TMPDIR" <<'JS'
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {publishEvidence}=await import(process.argv[2]);
let body='![Earlier](https://github.com/user-attachments/assets/A)\nNEW_PLACE';
const github=async args=>{if(args[1]==='view')return JSON.stringify({body});body=await readFile(args.at(-1),'utf8');return '';};
await publishEvidence({repo:'owner/repo',pr:42,placeholder:'NEW_PLACE',asset:'https://github.com/user-attachments/assets/A',directory:process.argv[3],github});
assert.ok(!body.includes('NEW_PLACE'));
assert.equal(body.split('/assets/A').length,3);
JS
  [ "$status" -eq 0 ]
}

@test "screenshot comments group images and recover posted requests without duplicate or body edits" {
  run node --input-type=module - "$BATS_TEST_DIRNAME/../libexec/pr-evidence.mjs" "$BATS_TEST_TMPDIR" <<'JS'
import assert from 'node:assert/strict';
import {writeFile, readFile, readdir, unlink} from 'node:fs/promises';
import path from 'node:path';
const {commentEvidence}=await import(process.argv[2]);
const {execFileSync}=await import('node:child_process');
const directory=process.argv[3];
const images=['before.png','after.png'].map(name=>path.join(directory,name));
await Promise.all(images.map((image,n)=>writeFile(image,String(n))));
const comments=[{user:null,body:'deleted account'}];let uploads=0;let posts=0;
const github=async args=>{
 assert.equal(args[0],'api');
 if(args.includes('user')) return 'me';
 if(args.includes('--method')) {
  const payload=JSON.parse(await readFile(args.at(-1),'utf8'));
  const comment={...payload,user:{login:'me'},html_url:'https://github.com/owner/repo/pull/42#issuecomment-1'};
  comments.push(comment);posts++;return JSON.stringify(comment);
 }
 if(args.includes('--paginate')) return execFileSync('jq',['-r',args.at(-1)],{input:JSON.stringify(comments)}).toString().trim();
 return JSON.stringify({number:42,base:{repo:{full_name:'owner/repo'}}});
};
const options={repo:'owner/repo',pr:42,images,body:'変更前\n<!-- screenshot-1 -->\n変更後\n<!-- screenshot-2 -->',requestId:'round-1',directory,github,upload:async()=>({asset:`https://github.com/user-attachments/assets/${++uploads}`})};
const results=await Promise.all([commentEvidence(options),commentEvidence(options)]);
assert.equal(posts,1);assert.equal(uploads,2);
assert.equal(results.filter(result=>result.reused).length,1);
assert.ok(comments[1].body.includes('/assets/1'));assert.ok(comments[1].body.includes('/assets/2'));
assert.ok(!comments[1].body.includes('<!-- screenshot-'));
const receipt=(await readdir(directory)).find(name=>name.startsWith('comment-')&&name.endsWith('.json'));
await unlink(path.join(directory,receipt));
assert.equal((await commentEvidence(options)).reused,true);
assert.equal(uploads,2);
await assert.rejects(commentEvidence({...options,body:options.body+' changed'}),/request-conflict/);
await assert.rejects(commentEvidence({...options,body:'<!-- screenshot-1 -->'}),/comment-invalid/);
await commentEvidence({...options,requestId:'round-2'});
assert.equal(posts,2);
const wrongTarget=async args=>args.includes('user')?'me':JSON.stringify({number:42,base:{repo:{full_name:'wrong/repo'}}});
await assert.rejects(commentEvidence({...options,github:wrongTarget}),/target-conflict/);
JS
  [ "$status" -eq 0 ]
}

@test "screenshot failures preserve assets, resume authentication, and avoid uncertain reposts" {
  run node --input-type=module - "$BATS_TEST_DIRNAME/../libexec/pr-evidence.mjs" "$BATS_TEST_TMPDIR" <<'JS'
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
const {commentEvidence}=await import(process.argv[2]);
const {execFileSync}=await import('node:child_process');
const directory=process.argv[3];const images=['a.png','b.png'].map(name=>path.join(directory,name));
await Promise.all(images.map(image=>writeFile(image,image)));
let posts=0;let failPost=false;let saveRemote=true;let failUpload=true;const comments=[];const uploaded=[];
const github=async args=>{
 if(args.includes('user')) return 'me';
 if(args.includes('--paginate')) return execFileSync('jq',['-r',args.at(-1)],{input:JSON.stringify(comments)}).toString().trim();
 if(args.includes('--method')) {
  posts++;const payload=JSON.parse(await readFile(args.at(-1),'utf8'));
  const comment={...payload,user:{login:'me'},html_url:`https://github.com/owner/repo/pull/42#issuecomment-${posts}`};
  if(saveRemote) comments.push(comment);
  if(failPost) throw new Error('connection lost');
  return JSON.stringify(comment);
 }
 return JSON.stringify({number:42,base:{repo:{full_name:'owner/repo'}}});
};
const options={repo:'owner/repo',pr:42,images,body:'<!-- screenshot-1 -->\n<!-- screenshot-2 -->',requestId:'retry',directory,github,upload:async image=>{
 uploaded.push(image);
 if(image===images[1]&&failUpload) throw new Error('authentication-required: expired');
 return {asset:`https://github.com/user-attachments/assets/${path.basename(image)}`};
}};
await assert.rejects(commentEvidence(options),/authentication-required.*receipt:/);
assert.equal(posts,0);
failUpload=false;await commentEvidence(options);
assert.deepEqual(uploaded,[images[0],images[1],images[1]]);
await assert.rejects(commentEvidence({...options,requestId:'not-started',upload:async()=>{throw new Error('upload-not-started: missing form');}}),/upload-not-started/);
await commentEvidence({...options,requestId:'not-started'});
assert.equal(posts,2);
failPost=true;
await assert.rejects(commentEvidence({...options,requestId:'post-lost'}),/connection lost/);
assert.equal((await commentEvidence({...options,requestId:'post-lost'})).reused,true);
assert.equal(posts,3);
saveRemote=false;
await assert.rejects(commentEvidence({...options,requestId:'post-unknown'}),/connection lost/);
await assert.rejects(commentEvidence({...options,requestId:'post-unknown'}),/post-unconfirmed/);
assert.equal(posts,4);
await assert.rejects(commentEvidence({...options,requestId:'upload-unknown',upload:async()=>{throw new Error('upload-failed: timeout');}}),/upload-failed/);
await assert.rejects(commentEvidence({...options,requestId:'upload-unknown'}),/upload-unconfirmed/);
assert.equal(posts,4);
JS
  [ "$status" -eq 0 ]
}

@test "comment uploads use only the new comment form and preserve neighboring tabs on failure" {
  run node --input-type=module - "$BATS_TEST_DIRNAME/../libexec/pr-evidence.mjs" <<'JS'
import assert from 'node:assert/strict';
const {uploadEvidence}=await import(process.argv[2]);
let closed=0;let uploaded=false;let signedIn=true;let fail=false;let missing=false;
const textarea={count:async()=>signedIn?1:0,waitFor:async()=>{if(missing)throw new Error('no form');},inputValue:async()=>uploaded?'https://github.com/user-attachments/assets/new':'',locator:selector=>{assert.equal(selector,'xpath=ancestor::form[1]');return form;}};
const form={locator:selector=>{assert.equal(selector,'input[type=file]');return {waitFor:async()=>{},setInputFiles:async()=>{if(fail)throw new Error('network failure');uploaded=true;}};}};
const page={goto:async()=>{},url:()=> 'https://github.com/owner/repo/pull/42',locator:selector=>{
 if(selector==='#new_comment_field')return textarea;
 assert.equal(selector,'a[href^="/login"]');return {count:async()=>1};
},close:async()=>{closed++;}};
const sibling={closed:false};const context={newPage:async()=>page,pages:()=>[sibling,page]};
assert.equal((await uploadEvidence(context,{repo:'owner/repo',pr:42,image:'/a.png',comment:true})).asset,'https://github.com/user-attachments/assets/new');
fail=true;await assert.rejects(uploadEvidence(context,{repo:'owner/repo',pr:42,image:'/b.png',comment:true}),/upload-failed/);
signedIn=false;await assert.rejects(uploadEvidence(context,{repo:'owner/repo',pr:42,image:'/b.png',comment:true}),/authentication-required/);
signedIn=true;missing=true;await assert.rejects(uploadEvidence(context,{repo:'owner/repo',pr:42,image:'/b.png',comment:true}),/upload-not-started/);
assert.equal(closed,4);assert.equal(sibling.closed,false);
JS
  [ "$status" -eq 0 ]
}

@test "a missing comment attachment input allows retry with the same request ID" {
  run node --input-type=module - "$BATS_TEST_DIRNAME/../libexec/pr-evidence.mjs" "$BATS_TEST_TMPDIR" <<'JS'
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const {uploadEvidence,commentEvidence,digest}=await import(process.argv[2]);
const directory=process.argv[3];const image=path.join(directory,'image.png');
await writeFile(image,'image');
let missing=true;let selected=0;let posts=0;let closed=0;
const input={
 waitFor:async options=>{assert.equal(options.state,'attached');assert.equal(options.timeout,30_000);if(missing)throw new Error('attachment input absent');},
 setInputFiles:async()=>{if(missing)throw new Error('attachment input absent');selected++;},
};
const form={locator:selector=>{assert.equal(selector,'input[type=file]');return input;}};
const textarea={count:async()=>1,waitFor:async()=>{},inputValue:async()=>selected?'https://github.com/user-attachments/assets/retry':'',locator:selector=>{assert.equal(selector,'xpath=ancestor::form[1]');return form;}};
const context={newPage:async()=>({goto:async()=>{},url:()=> 'https://github.com/owner/repo/pull/42',locator:selector=>{assert.equal(selector,'#new_comment_field');return textarea;},close:async()=>{closed++;}})};
const github=async args=>{
 if(args.includes('user'))return 'me';
 if(args.includes('--paginate'))return '';
 if(args.includes('--method')){posts++;return JSON.stringify({...JSON.parse(await readFile(args.at(-1),'utf8')),html_url:'https://github.com/owner/repo/pull/42#issuecomment-1'});}
 return JSON.stringify({number:42,base:{repo:{full_name:'owner/repo'}}});
};
const options={repo:'owner/repo',pr:42,images:[image],body:'<!-- screenshot-1 -->',requestId:'retry-input',directory,github,upload:image=>uploadEvidence(context,{repo:'owner/repo',pr:42,image,comment:true})};
await assert.rejects(commentEvidence(options),/upload-not-started/);
const receipt=JSON.parse(await readFile(path.join(directory,`comment-${digest('owner/repo#42:retry-input')}.json`),'utf8'));
assert.equal(receipt.phase,'ready');assert.deepEqual(receipt.assets,[]);
assert.equal(selected,0);assert.equal(posts,0);
missing=false;
const result=await commentEvidence(options);
assert.equal(result.reused,false);assert.equal(posts,1);assert.equal(selected,1);assert.equal(closed,2);
JS
  [ "$status" -eq 0 ]
}

@test "PR body attachment reports both auth and save errors" {
  local module="$BATS_TEST_DIRNAME/../libexec/pr-evidence.mjs"
  run node --input-type=module - "$module" "$BATS_TEST_TMPDIR" <<"JS"
import assert from "node:assert/strict";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
const { attachEvidenceToPullRequestBody } =
  await import(process.argv[2]);
const base = process.argv[3];
const directory = path.join(base, "receipts");
const image = path.join(base, "image.png");
await mkdir(directory);
await writeFile(image, "image bytes");
let closed = 0;
const page = {
  goto: async (url) => {
    assert.equal(url, "https://github.com/owner/repo/pull/42");
  },
  url: () => "https://github.com/login",
  close: async () => { closed += 1; },
};
await assert.rejects(
  attachEvidenceToPullRequestBody({
    repo: "owner/repo", pr: 42, image,
    placeholder: "PLACE", requestId: "auth-save-failure",
    directory,
    github: async () => assert.fail("must not publish"),
    withUploadContext: async (action) => {
      await rename(directory, path.join(base, "old-receipts"));
      await writeFile(directory, "blocked");
      return action({ newPage: async () => page });
    },
  }),
  (error) => {
    assert.match(error.message, /authentication-required:/u);
    assert.match(error.message, /receipt-save-failed:.*ENOTDIR/u);
    return true;
  },
);
assert.equal(closed, 1);
JS
  if [ "$status" -ne 0 ]; then printf "%s\n" "$output"; fi
  [ "$status" -eq 0 ]
}
