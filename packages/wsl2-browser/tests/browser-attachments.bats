#!/usr/bin/env bats

setup() {
  ATTACHMENTS="$BATS_TEST_DIRNAME/../libexec/browser-attachments.mjs"
  export BROWSER_OWNERSHIP_DIR="$BATS_TEST_TMPDIR/ownership"
  export MANAGED_CHROME_OWNER="$BATS_TEST_TMPDIR/owner"
  export PWCLI_POWERSHELL="$BATS_TEST_TMPDIR/powershell"
  export PWCLI_WINDOWS_SCRIPT='C:\fixture.ps1'
  export BROWSER_ATTACHMENTS_PLAYWRIGHT="$BATS_TEST_TMPDIR/playwright.mjs"
  export OWNER_CALLS="$BATS_TEST_TMPDIR/owner-calls"
  export FIXTURE_MODE=headless
  cat >"$MANAGED_CHROME_OWNER" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$OWNER_CALLS"
if [[ "$1" == locate ]]; then
  printf 'attachment-fixture\tC:\\fixture-profile\thttp://127.0.0.1:29999\t30000\n'
else
  printf '{"phase":"active","mode":"%s","browserPid":4242,"token":"fixture"}\n' "$FIXTURE_MODE"
fi
SH
  cat >"$PWCLI_POWERSHELL" <<'SH'
#!/usr/bin/env bash
printf 'managed:headless:4242\n'
SH
  chmod +x "$MANAGED_CHROME_OWNER" "$PWCLI_POWERSHELL"
  printf 'export const chromium={connectOverCDP:async()=>{throw new Error("connection refused");}};\n' >"$BROWSER_ATTACHMENTS_PLAYWRIGHT"
  printf image >"$BATS_TEST_TMPDIR/image.png"
}

upload() {
  node "$ATTACHMENTS" upload --repo owner/repo --pr 42 --image "$BATS_TEST_TMPDIR/image.png" --placeholder PLACE --request-id test
}

@test "attachment mode conflict preserves the existing owner before attempting upload" {
  export FIXTURE_MODE=headed
  run upload
  [ "$status" -ne 0 ]
  [[ "$output" == *ownership-conflict:* ]]
  ! grep -Eq 'release|run|reserve' "$OWNER_CALLS"
  [ -z "$(find "$BROWSER_OWNERSHIP_DIR" -name '*.json' -print)" ]
}

@test "attachment CDP failure is distinguished and does not create an upload receipt" {
  run upload
  [ "$status" -ne 0 ]
  [[ "$output" == *cdp-unavailable:* ]]
  ! grep -Eq 'release|run|reserve' "$OWNER_CALLS"
  [ -z "$(find "$BROWSER_OWNERSHIP_DIR" -name '*.json' -print)" ]
}

@test "upload CLI preserves its arguments, browser lifecycle and result" {
  export BROWSER_ATTACHMENTS_GH="$BATS_TEST_TMPDIR/github"
  export PR_BODY_FIXTURE="$BATS_TEST_TMPDIR/pr-body.md"
  export GH_CALLS="$BATS_TEST_TMPDIR/github-calls"
  export CONNECTION_LOG="$BATS_TEST_TMPDIR/connections"
  export EXPECTED_IMAGE="$BATS_TEST_TMPDIR/image.png"
  printf 'Before\nPLACE\nAfter\n' >"$PR_BODY_FIXTURE"
  cat >"$BROWSER_ATTACHMENTS_GH" <<'JS'
#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALLS, `${JSON.stringify(args)}\n`);
if (args[0] !== 'pr' || args[args.indexOf('--repo') + 1] !== 'owner/repo' || args[2] !== '42') {
  throw new Error(`unexpected PR target: ${args.join(' ')}`);
}
if (args[1] === 'view') {
  process.stdout.write(JSON.stringify({body: fs.readFileSync(process.env.PR_BODY_FIXTURE, 'utf8')}));
} else if (args[1] === 'edit') {
  fs.copyFileSync(args[args.indexOf('--body-file') + 1], process.env.PR_BODY_FIXTURE);
} else {
  throw new Error(`unexpected GitHub command: ${args.join(' ')}`);
}
JS
  chmod +x "$BROWSER_ATTACHMENTS_GH"
  cat >"$BROWSER_ATTACHMENTS_PLAYWRIGHT" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
let uploads = 0;
export const chromium = {
  connectOverCDP: async () => {
    fs.appendFileSync(process.env.CONNECTION_LOG, 'connect\n');
    let text = '';
    const textarea = {waitFor: async () => {}, inputValue: async () => text};
    const input = {
      waitFor: async () => {},
      setInputFiles: async image => {
        if (path.basename(image) !== path.basename(process.env.EXPECTED_IMAGE) ||
            fs.readFileSync(image, 'utf8') !== fs.readFileSync(process.env.EXPECTED_IMAGE, 'utf8')) {
          throw new Error(`wrong image payload: ${image}`);
        }
        uploads += 1;
        text = `https://github.com/user-attachments/assets/cli-${uploads}`;
      },
    };
    const editor = {
      locator: selector => selector === 'textarea[name="pull_request[body]"]' ? textarea : input,
      getByText: () => ({click: async () => {}}),
    };
    const container = {
      locator: selector => selector === 'summary.timeline-comment-action'
        ? {click: async () => {}}
        : editor.locator(selector),
      getByText: editor.getByText,
    };
    const page = {
      goto: async () => {},
      url: () => 'https://github.com/owner/repo/pull/42',
      locator: () => ({first: () => container}),
      close: async () => {},
    };
    return {
      contexts: () => [{newPage: async () => page}],
      close: async () => fs.appendFileSync(process.env.CONNECTION_LOG, 'close\n'),
    };
  },
};
JS
  run node "$ATTACHMENTS" upload --repo owner/repo --pr 42 \
    --image "$EXPECTED_IMAGE" --placeholder PLACE --request-id cli-request
  [ "$status" -eq 0 ]
  local cli_output="$output"
  run node --input-type=module - "$cli_output" <<'JS'
import assert from 'node:assert/strict';
const result = JSON.parse(process.argv[2]);
assert.deepEqual(Object.keys(result).sort(), ['asset', 'finished', 'requestId', 'started']);
assert.equal(result.asset, 'https://github.com/user-attachments/assets/cli-1');
assert.equal(result.requestId, 'cli-request');
assert.ok(Number.isFinite(result.started));
assert.ok(Number.isFinite(result.finished));
assert.ok(result.started <= result.finished);
JS
  [ "$status" -eq 0 ]
  [[ "$(cat "$PR_BODY_FIXTURE")" == *'![Evidence](https://github.com/user-attachments/assets/cli-1)'* ]]
  [[ "$(cat "$PR_BODY_FIXTURE")" != *PLACE* ]]
  [[ "$(cat "$CONNECTION_LOG")" == $'connect\nclose' ]]
  [ "$(wc -l <"$GH_CALLS")" -eq 3 ]
}

@test "comment command filters large paginated history and posts two images only once" {
  export BROWSER_ATTACHMENTS_GH="$BATS_TEST_TMPDIR/github"
  export COMMENT_FIXTURE="$BATS_TEST_TMPDIR/comments.json"
  node - "$COMMENT_FIXTURE" <<'JS'
const fs=require('node:fs');
fs.writeFileSync(process.argv[2],JSON.stringify(Array.from({length:101},()=>({user:null,body:'x'.repeat(32000)}))));
JS
  cat >"$BROWSER_ATTACHMENTS_GH" <<'JS'
#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]!=='api')throw new Error('PR body must not be edited');
if(args.includes('user')){process.stdout.write('me');}
else if(args.includes('--paginate')){
 const comments=JSON.parse(fs.readFileSync(process.env.COMMENT_FIXTURE,'utf8'));
 if(args.includes('--slurp')){process.stdout.write(JSON.stringify([comments]));}
 else {
  const {execFileSync}=require('node:child_process');
  for(let n=0;n<comments.length;n+=100){
   process.stdout.write(execFileSync('jq',['-r',args[args.indexOf('--jq')+1]],{input:JSON.stringify(comments.slice(n,n+100))}));
  }
 }
}
else if(args.includes('--method')){
 const payload=JSON.parse(fs.readFileSync(args.at(-1),'utf8'));
 const comments=JSON.parse(fs.readFileSync(process.env.COMMENT_FIXTURE,'utf8'));
 const comment={...payload,user:{login:'me'},html_url:'https://github.com/owner/repo/pull/42#issuecomment-1'};
 comments.push(comment);fs.writeFileSync(process.env.COMMENT_FIXTURE,JSON.stringify(comments));process.stdout.write(JSON.stringify(comment));
}else{process.stdout.write(JSON.stringify({number:42,base:{repo:{full_name:'owner/repo'}}}));}
JS
  chmod +x "$BROWSER_ATTACHMENTS_GH"
  cat >"$BROWSER_ATTACHMENTS_PLAYWRIGHT" <<'JS'
let number=0;
export const chromium={connectOverCDP:async()=>({contexts:()=>[{newPage:async()=>{
 let asset='';const form={locator:()=>({waitFor:async()=>{},setInputFiles:async()=>{asset=`https://github.com/user-attachments/assets/${++number}`;}})};
 const textarea={count:async()=>1,waitFor:async()=>{},locator:()=>form,inputValue:async()=>asset};
 return {goto:async()=>{},url:()=> 'https://github.com/owner/repo/pull/42',locator:()=>textarea,close:async()=>{}};
}}],close:async()=>{}})};
JS
  printf 'second image\n' >"$BATS_TEST_TMPDIR/after.png"
  printf '変更前\n<!-- screenshot-1 -->\n変更後\n<!-- screenshot-2 -->\n' >"$BATS_TEST_TMPDIR/body.md"
  local attempt
  for attempt in 1 2; do
    run node "$ATTACHMENTS" comment --repo owner/repo --pr 42 \
      --image "$BATS_TEST_TMPDIR/image.png" --image "$BATS_TEST_TMPDIR/after.png" \
      --body-file "$BATS_TEST_TMPDIR/body.md" --request-id retry
    [ "$status" -eq 0 ]
    if [[ "$attempt" == 1 ]]; then
      node - "$COMMENT_FIXTURE" <<'JS'
const fs=require('node:fs');const p=process.argv[2];const comments=JSON.parse(fs.readFileSync(p,'utf8'));
comments.unshift({...comments.at(-1),user:{login:'another-user'},html_url:'https://github.com/owner/repo/pull/42#issuecomment-other'});
fs.writeFileSync(p,JSON.stringify(comments));
JS
    fi
  done
  [[ "$output" == *'"reused":true'* ]]
  run node --input-type=module - "$COMMENT_FIXTURE" <<'JS'
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const comments=JSON.parse(await readFile(process.argv[2],'utf8'));
const own=comments.filter(comment=>comment.user?.login==='me');
assert.equal(own.length,1);assert.equal((own[0].body.match(/!\[Evidence\]/g)||[]).length,2);
JS
  [ "$status" -eq 0 ]
}
