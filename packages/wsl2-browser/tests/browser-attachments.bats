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
  cat >"$BROWSER_ATTACHMENTS_GH" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$GH_CALLS"
if [[ "$1" != pr || "$3" != 42 || "$5" != owner/repo ]]; then
  printf 'unexpected PR target: %s\n' "$*" >&2
  exit 2
fi
if [[ "$2" == view ]]; then
  jq -n --rawfile body "$PR_BODY_FIXTURE" '{body:$body}'
elif [[ "$2" == edit ]]; then
  cp "$7" "$PR_BODY_FIXTURE"
else
  printf 'unexpected GitHub command: %s\n' "$*" >&2
  exit 2
fi
SH
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
  [ "$status" -eq 0 ] || { printf '%s\n' "$output" >&2; false; }
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

prepare_comment_fixture() {
  export BROWSER_ATTACHMENTS_GH="$BATS_TEST_TMPDIR/github"
  export COMMENT_FIXTURE="$BATS_TEST_TMPDIR/comments.json"
  export GH_CALLS="$BATS_TEST_TMPDIR/gh-post-calls"
  export GH_API_CALLS="$BATS_TEST_TMPDIR/gh-api-calls"
  export COMMENT_LOOKUP_COUNT="$BATS_TEST_TMPDIR/lookup-count"
  export COMMENT_FAIL_USER=0 COMMENT_FAIL_LOOKUP_ON=0 COMMENT_WRONG_TARGET=0
  export COMMENT_ATTACH_LIMIT=2 COMMENT_DROP_RESPONSE=0 COMMENT_POST_EXIT=0
  export COMMENT_POST_ERROR='connection reset by peer'
  export COMMENT_HIDE_THROUGH=0 COMMENT_NO_POST=0
  printf '[]\n' >"$COMMENT_FIXTURE"
  printf 'before image\n' >"$BATS_TEST_TMPDIR/before.png"
  printf 'after image\n' >"$BATS_TEST_TMPDIR/after.png"
  cat >"$BATS_TEST_TMPDIR/body.md" <<EOF
変更前
![Before]($BATS_TEST_TMPDIR/before.png)

変更後
![After]($BATS_TEST_TMPDIR/after.png)
EOF
  cat >"$BROWSER_ATTACHMENTS_GH" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == api ]]; then
  printf '%s\n' "$*" >>"$GH_API_CALLS"
fi
if [[ "$1" == api && "$2" == user ]]; then
  if [[ "$COMMENT_FAIL_USER" == 1 ]]; then
    printf 'not logged in\n' >&2
    exit 1
  fi
  printf 'me'
elif [[ "$1" == api && "$2" == --paginate && "$3" == repos/owner/repo/issues/42/comments?per_page=100 ]]; then
  count=0
  marker="$(printf '%s\n' "$5" | sed -n 's/.*contains("\(<!-- pr-screenshots:[^"]*:\)").*/\1/p')"
  if [[ -z "$marker" ]]; then
    printf 'unexpected comment lookup query: %s\n' "$5" >&2
    exit 2
  fi
  if [[ -f "$COMMENT_LOOKUP_COUNT" ]]; then
    read -r count <"$COMMENT_LOOKUP_COUNT"
  fi
  count=$((count + 1))
  printf '%s\n' "$count" >"$COMMENT_LOOKUP_COUNT"
  if [[ "$COMMENT_FAIL_LOOKUP_ON" == "$count" ]]; then
    printf 'temporary lookup failure\n' >&2
    exit 1
  fi
  if [[ "$count" -le "$COMMENT_HIDE_THROUGH" ]]; then exit 0; fi
  if [[ "${COMMENT_PAGED:-0}" == 1 ]]; then
    jq -c --arg marker "$marker" '.[0:100][] | select(.user.login == "me" and (.body | contains($marker))) | {body,html_url}' "$COMMENT_FIXTURE"
    jq -c --arg marker "$marker" '.[100:][] | select(.user.login == "me" and (.body | contains($marker))) | {body,html_url}' "$COMMENT_FIXTURE"
  else
    jq -c --arg marker "$marker" '.[] | select(.user.login == "me" and (.body | contains($marker))) | {body,html_url}' "$COMMENT_FIXTURE"
  fi
elif [[ "$1" == api && "$2" == repos/owner/repo/pulls/42 ]]; then
  repo=owner/repo
  if [[ "$COMMENT_WRONG_TARGET" == 1 ]]; then repo=wrong/repo; fi
  printf '{"number":42,"base":{"repo":{"full_name":"%s"}}}' "$repo"
elif [[ "$1" == pr && "$2" == comment ]]; then
  if [[ "$3" != 42 || "$4" != --repo || "$5" != owner/repo ]]; then
    printf 'unexpected comment target: %s\n' "$*" >&2
    exit 2
  fi
  printf '%s\n' --POST-- "$@" >>"$GH_CALLS"
  if [[ "$COMMENT_NO_POST" == 1 ]]; then
    printf '%s\n' "$COMMENT_POST_ERROR" >&2
    exit "$COMMENT_POST_EXIT"
  fi
  shift 2
  image_paths=()
  body_file=''
  while (($#)); do
    case "$1" in
      --body-file) body_file="$2"; shift 2 ;;
      --attach) image_paths+=("$2"); shift 2 ;;
      *) shift ;;
    esac
  done
  body="$(cat "$body_file")"
  for index in "${!image_paths[@]}"; do
    if [[ "$COMMENT_ATTACH_LIMIT" -ge $((index + 1)) ]]; then
      body="$(printf '%s' "$body" | sed "s|](${image_paths[index]})|](https://github.com/user-attachments/assets/$((index + 1)))|g")"
    fi
  done
  url='https://github.com/owner/repo/pull/42#issuecomment-1'
  comment="$(jq -n --arg body "$body" --arg url "$url" '{body:$body,user:{login:"me"},html_url:$url}')"
  jq --argjson comment "$comment" '. + [$comment]' "$COMMENT_FIXTURE" >"$COMMENT_FIXTURE.tmp"
  mv "$COMMENT_FIXTURE.tmp" "$COMMENT_FIXTURE"
  if [[ "$COMMENT_DROP_RESPONSE" == 1 ]]; then
    printf '%s\n' "$COMMENT_POST_ERROR" >&2
    exit "$COMMENT_POST_EXIT"
  fi
  printf '%s' "$url"
  exit "$COMMENT_POST_EXIT"
else
  printf 'unexpected gh command: %s\n' "$*" >&2
  exit 2
fi
SH
  chmod +x "$BROWSER_ATTACHMENTS_GH"
  unset BROWSER_ATTACHMENTS_PLAYWRIGHT
  export PWCLI_TEST_WSL=0
}

comment_cli() {
  local request_id=gh-comment
  local pr="${COMMENT_PR:-42}"
  local repo="${COMMENT_REPO:-owner/repo}"
  if [[ "$#" -gt 0 ]]; then request_id="$1"; fi
  "$BATS_TEST_DIRNAME/../bin/browser-attachments" comment --repo "$repo" --pr "$pr" \
    --image "$BATS_TEST_TMPDIR/before.png" --image "$BATS_TEST_TMPDIR/after.png" \
    --body-file "$BATS_TEST_TMPDIR/body.md" --request-id "$request_id"
}

@test "comment CLI posts normal Markdown images through gh without a browser runtime" {
  prepare_comment_fixture
  run comment_cli
  [ "$status" -eq 0 ]
  [[ "$output" == *'"state":"complete"'* ]]
  [[ "$output" == *'https://github.com/owner/repo/pull/42#issuecomment-1'* ]]
  [ ! -s "$OWNER_CALLS" ]

  node - "$COMMENT_FIXTURE" <<'JS'
const fs = require('node:fs');
const comments = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
comments.unshift({...comments[0], user:{login:'another-user'}, html_url:'https://github.com/owner/repo/pull/42#issuecomment-other'});
fs.writeFileSync(process.argv[2], JSON.stringify(comments));
JS
  run comment_cli
  [ "$status" -eq 0 ]
  [[ "$output" == *'"reused":true'* ]]
  run node --input-type=module - "$COMMENT_FIXTURE" "$GH_CALLS" "$GH_API_CALLS" <<'JS'
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const comments = JSON.parse(await readFile(process.argv[2], 'utf8'));
const calls = (await readFile(process.argv[3], 'utf8')).split('\n');
const apiCalls = await readFile(process.argv[4], 'utf8');
const own = comments.filter(comment => comment.user?.login === 'me');
assert.equal(own.length, 1);
assert.equal(comments.length, 2);
assert.ok(own[0].body.indexOf('![Before](https://github.com/user-attachments/assets/1)') <
  own[0].body.indexOf('![After](https://github.com/user-attachments/assets/2)'));
assert.ok(own[0].body.includes('<!-- pr-screenshots:'));
assert.equal(calls.filter(line => line === '--POST--').length, 1);
assert.ok(calls.includes('--attach'));
assert.ok(apiCalls.includes('--paginate'));
assert.ok(apiCalls.includes('repos/owner/repo/issues/42/comments?per_page=100'));
JS
  [ "$status" -eq 0 ]
}

@test "partial attachments are reported and same-ID retry does not repost or fill missing images" {
  prepare_comment_fixture
  export COMMENT_ATTACH_LIMIT=1
  export COMMENT_POST_EXIT=1
  run comment_cli partial
  [ "$status" -eq 1 ]
  local first_result="$output"
  run node --input-type=module - "$first_result" "$BATS_TEST_TMPDIR/body.md" <<'JS'
import assert from 'node:assert/strict';
const result = JSON.parse(process.argv[2]);
assert.equal(result.state, 'partial');
assert.equal(result.assets[0], 'https://github.com/user-attachments/assets/1');
assert.equal(result.assets[1], null);
assert.deepEqual(result.missing, [result.images[1]]);
assert.equal(result.bodyFile, process.argv[3]);
assert.match(result.reason, /Some requested images/);
JS
  [ "$status" -eq 0 ] || { printf '%s\\n' "$output" >&2; false; }
  run comment_cli partial
  [ "$status" -eq 1 ]
  [[ "$output" == *'"state":"partial"'* ]]
  [[ "$output" == *'"reused":true'* ]]
  [ "$(jq 'length' "$COMMENT_FIXTURE")" -eq 1 ]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]
}

@test "a failed gh post reports its comment URL and does not duplicate a no-image result" {
  prepare_comment_fixture
  export COMMENT_ATTACH_LIMIT=0
  export COMMENT_POST_EXIT=1
  run comment_cli no-image
  [ "$status" -eq 1 ]
  [[ "$output" == *'"state":"failed"'* ]]
  [[ "$output" == *'https://github.com/owner/repo/pull/42#issuecomment-1'* ]]
  run comment_cli no-image
  [ "$status" -eq 1 ]
  [[ "$output" == *'"state":"failed"'* ]]
  [[ "$output" == *'"reused":true'* ]]
  [ "$(jq 'length' "$COMMENT_FIXTURE")" -eq 1 ]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]
}

@test "lost post response and failed lookup stay unknown until the saved comment is found" {
  prepare_comment_fixture
  export COMMENT_DROP_RESPONSE=1
  export COMMENT_POST_EXIT=1
  export COMMENT_FAIL_LOOKUP_ON=2
  run comment_cli response-lost
  [ "$status" -eq 1 ]
  [[ "$output" == *'"state":"unknown"'* ]]
  [[ "$output" == *'The post result could not be looked up.'* ]]
  run node --input-type=module - "$BROWSER_OWNERSHIP_DIR/attachments" "$BATS_TEST_TMPDIR/body.md" <<'JS'
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
const directory = process.argv[2];
const receiptName = (await readdir(directory)).find(name => name.startsWith('comment-') && name.endsWith('.json'));
const receipt = JSON.parse(await readFile(path.join(directory, receiptName), 'utf8'));
assert.equal(receipt.phase, 'query-failed');
assert.equal(receipt.bodyFile, process.argv[3]);
assert.equal(receipt.images.length, 2);
assert.equal(receipt.missing.length, 2);
assert.equal((await readFile(process.argv[3], 'utf8')).includes('![Before]'), true);
JS
  [ "$status" -eq 0 ]
  run comment_cli response-lost
  [ "$status" -eq 0 ]
  [[ "$output" == *'"state":"complete"'* ]]
  [[ "$output" == *'"reused":true'* ]]
  [ "$(jq 'length' "$COMMENT_FIXTURE")" -eq 1 ]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]
}

@test "same-ID concurrent comment CLI calls create one comment" {
  prepare_comment_fixture
  local cli="$BATS_TEST_DIRNAME/../bin/browser-attachments"
  "$cli" comment --repo owner/repo --pr 42 --image "$BATS_TEST_TMPDIR/before.png" --image "$BATS_TEST_TMPDIR/after.png" --body-file "$BATS_TEST_TMPDIR/body.md" --request-id concurrent >"$BATS_TEST_TMPDIR/first.json" 2>"$BATS_TEST_TMPDIR/first.err" &
  local first_pid=$!
  "$cli" comment --repo owner/repo --pr 42 --image "$BATS_TEST_TMPDIR/before.png" --image "$BATS_TEST_TMPDIR/after.png" --body-file "$BATS_TEST_TMPDIR/body.md" --request-id concurrent >"$BATS_TEST_TMPDIR/second.json" 2>"$BATS_TEST_TMPDIR/second.err" &
  local second_pid=$!
  local first_status=0
  local second_status=0
  wait "$first_pid" || first_status=$?
  wait "$second_pid" || second_status=$?
  [ "$first_status" -eq 0 ]
  [ "$second_status" -eq 0 ]
  run node --input-type=module - "$BATS_TEST_TMPDIR/first.json" "$BATS_TEST_TMPDIR/second.json" "$COMMENT_FIXTURE" "$GH_CALLS" <<'JS'
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const results = await Promise.all(process.argv.slice(2,4).map(async file => JSON.parse(await readFile(file, 'utf8'))));
const comments = JSON.parse(await readFile(process.argv[4], 'utf8'));
const calls = (await readFile(process.argv[5], 'utf8')).split('\n');
assert.deepEqual(results.map(result => result.state), ['complete','complete']);
assert.equal(results.filter(result => result.reused).length, 1);
assert.equal(comments.length, 1);
assert.equal(calls.filter(line => line === '--POST--').length, 1);
JS
  [ "$status" -eq 0 ]
}

@test "comment retry finds its own result on a later history page" {
  prepare_comment_fixture
  export COMMENT_PAGED=1
  jq -n '[range(0; 100) as $i | {user:{login:"other"},body:"unrelated",html_url:("https://github.com/owner/repo/pull/42#issuecomment-" + ($i|tostring))}]' >"$COMMENT_FIXTURE"
  run comment_cli paged-history
  [ "$status" -eq 0 ]
  run comment_cli paged-history
  [ "$status" -eq 0 ]
  [[ "$output" == *'"reused":true'* ]]
  [ "$(jq 'length' "$COMMENT_FIXTURE")" -eq 101 ]
  [ "$(jq '[.[] | select(.user.login == "me")] | length' "$COMMENT_FIXTURE")" -eq 1 ]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]
}

@test "comment input rejection reports its boundary and valid Markdown still posts" {
  prepare_comment_fixture
  local cli="$BATS_TEST_DIRNAME/../bin/browser-attachments"
  local args=()
  local images="$BATS_TEST_TMPDIR/many-images.md"
  printf 'Checked gallery\n' >"$images"
  for ((index = 0; index < 50; index += 1)); do
    local image="$BATS_TEST_TMPDIR/image-$index.png"
    printf 'image\n' >"$image"
    args+=(--image "$image")
    printf '![Image %s](%s)\n' "$index" "$image" >>"$images"
  done
  export COMMENT_ATTACH_LIMIT=50
  run "$cli" comment --repo owner/repo --pr 42 "${args[@]}" --body-file "$images" --request-id max-images
  [ "$status" -eq 0 ]
  [[ "$output" == *'"state":"complete"'* ]]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]

  args+=(--image "$BATS_TEST_TMPDIR/image-50.png")
  run "$cli" comment --repo owner/repo --pr 42 "${args[@]}" --body-file "$images" --request-id too-many-images
  [ "$status" -ne 0 ]
  [[ "$output" == *'comment-invalid: attach 1-50 unique image paths'* ]]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]

  run "$cli" comment --repo owner/repo --pr 42 \
    --image "$BATS_TEST_TMPDIR/before.png" --image "$BATS_TEST_TMPDIR/before.png" \
    --body-file "$BATS_TEST_TMPDIR/body.md" --request-id duplicate-path
  [ "$status" -ne 0 ]
  [[ "$output" == *'comment-invalid: attach 1-50 unique image paths'* ]]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]

  printf 'Checked these images\n![Before](%s)\n' "$BATS_TEST_TMPDIR/before.png" >"$BATS_TEST_TMPDIR/body.md"
  run comment_cli missing-reference
  [ "$status" -ne 0 ]
  [[ "$output" == *'comment-invalid: each --image needs exactly one ordinary Markdown image reference'* ]]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]

  printf '![Before](%s)\n![After](%s)\n' "$BATS_TEST_TMPDIR/before.png" "$BATS_TEST_TMPDIR/after.png" >"$BATS_TEST_TMPDIR/body.md"
  run comment_cli missing-explanation
  [ "$status" -ne 0 ]
  [[ "$output" == *'comment-invalid: include a short explanation'* ]]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]

  printf 'Checked images\n![Before](%s)\n\n![After](%s)\n' "$BATS_TEST_TMPDIR/before.png" "$BATS_TEST_TMPDIR/after.png" >"$BATS_TEST_TMPDIR/body.md"
  run comment_cli valid-boundary
  [ "$status" -eq 0 ]
  [[ "$output" == *'"state":"complete"'* ]]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 2 ]
}

@test "comment rejects malformed local references with actionable reasons" {
  prepare_comment_fixture
  local cli="$BATS_TEST_DIRNAME/../bin/browser-attachments"
  local unsafe_image="$BATS_TEST_TMPDIR/before#fragment.png"
  printf image >"$unsafe_image"
  run "$cli" comment --repo owner/repo --pr 42 \
    --image "$BATS_TEST_TMPDIR/before.png" --image "$BATS_TEST_TMPDIR/before.png" \
    --body-file "$BATS_TEST_TMPDIR/body.md" --request-id duplicate-path
  [ "$status" -ne 0 ]
  [[ "$output" == *'comment-invalid: attach 1-50 unique image paths'* ]]
  [ ! -s "$GH_CALLS" ]

  run "$cli" comment --repo owner/repo --pr 42 \
    --image "$unsafe_image" --image "$BATS_TEST_TMPDIR/after.png" \
    --body-file "$BATS_TEST_TMPDIR/body.md" --request-id unsafe-path
  [ "$status" -ne 0 ]
  [[ "$output" == *'comment-invalid: attach 1-50 unique image paths'* ]]
  [ ! -s "$GH_CALLS" ]

  printf 'Checked images\n![Before](%s)\n' "$BATS_TEST_TMPDIR/before.png" >"$BATS_TEST_TMPDIR/body.md"
  run comment_cli missing-reference
  [ "$status" -ne 0 ]
  [[ "$output" == *'comment-invalid: each --image needs exactly one ordinary Markdown image reference'* ]]
  [ ! -s "$GH_CALLS" ]

  printf 'Checked images\n![Before](%s)\n![Again](%s)\n![After](%s)\n' \
    "$BATS_TEST_TMPDIR/before.png" "$BATS_TEST_TMPDIR/before.png" "$BATS_TEST_TMPDIR/after.png" >"$BATS_TEST_TMPDIR/body.md"
  run comment_cli duplicate-reference
  [ "$status" -ne 0 ]
  [[ "$output" == *'comment-invalid: each local Markdown image must match one --image path exactly once'* ]]
  [ ! -s "$GH_CALLS" ]

  printf '![Before](%s)\n![After](%s)\n' "$BATS_TEST_TMPDIR/before.png" "$BATS_TEST_TMPDIR/after.png" >"$BATS_TEST_TMPDIR/body.md"
  run comment_cli missing-explanation
  [ "$status" -ne 0 ]
  [[ "$output" == *'comment-invalid: include a short explanation'* ]]
  [ ! -s "$GH_CALLS" ]

  printf 'Checked images\n![Before](%s)\n\n![After](%s)\n' "$BATS_TEST_TMPDIR/before.png" "$BATS_TEST_TMPDIR/after.png" >"$BATS_TEST_TMPDIR/body.md"
  run comment_cli valid-markdown
  [ "$status" -eq 0 ]
  [[ "$output" == *'"state":"complete"'* ]]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]
}

@test "connection loss with a temporarily invisible comment stays unknown and never reposts" {
  prepare_comment_fixture
  export COMMENT_DROP_RESPONSE=1
  export COMMENT_POST_EXIT=1
  export COMMENT_HIDE_THROUGH=3
  run comment_cli invisible
  [ "$status" -eq 1 ]
  [[ "$output" == *'"state":"unknown"'* ]]
  run comment_cli invisible
  [ "$status" -eq 1 ]
  [[ "$output" == *'"state":"unknown"'* ]]
  [ "$(jq 'length' "$COMMENT_FIXTURE")" -eq 1 ]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]
}

@test "wrong PR, changed input, and missing gh authentication fail without browser fallback" {
  prepare_comment_fixture
  export COMMENT_WRONG_TARGET=1
  run comment_cli wrong-target
  [ "$status" -ne 0 ]
  [[ "$output" == *'target-conflict: resolved pull request does not match repo/pr'* ]]
  [ ! -s "$GH_CALLS" ]
  [ -f "$BATS_TEST_TMPDIR/body.md" ]
  [ -f "$BATS_TEST_TMPDIR/before.png" ]

  export COMMENT_WRONG_TARGET=0
  export COMMENT_FAIL_USER=1
  run comment_cli no-auth
  [ "$status" -ne 0 ]
  [[ "$output" == *'GitHub CLI authentication is required'* ]]
  [ ! -s "$OWNER_CALLS" ]
  [ -f "$BATS_TEST_TMPDIR/body.md" ]
  [ -f "$BATS_TEST_TMPDIR/before.png" ]

  export COMMENT_FAIL_USER=0
  run comment_cli changed-input
  [ "$status" -eq 0 ]
  printf 'different explanation\n![Before](%s)\n\n![After](%s)\n' "$BATS_TEST_TMPDIR/before.png" "$BATS_TEST_TMPDIR/after.png" >"$BATS_TEST_TMPDIR/body.md"
  run comment_cli changed-input
  [ "$status" -ne 0 ]
  [[ "$output" == *'request-conflict: request-id was already used with different content'* ]]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]
}

@test "the same request ID cannot be reused for another PR" {
  prepare_comment_fixture
  run comment_cli target-conflict
  [ "$status" -eq 0 ]
  export COMMENT_PR=43
  run comment_cli target-conflict
  [ "$status" -ne 0 ]
  [[ "$output" == *'request-conflict: request-id was already used with different content'* ]]
  [ "$(jq 'length' "$COMMENT_FIXTURE")" -eq 1 ]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]

  unset COMMENT_PR
  export COMMENT_REPO=other/repo
  run comment_cli target-conflict
  [ "$status" -ne 0 ]
  [[ "$output" == *'request-conflict: request-id was already used with different content'* ]]
  [ "$(jq 'length' "$COMMENT_FIXTURE")" -eq 1 ]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]
}

@test "missing flock explains the dependency and preserves comment inputs" {
  prepare_comment_fixture
  export MANAGED_CHROME_FLOCK="$BATS_TEST_TMPDIR/missing-flock"
  run comment_cli missing-flock
  [ "$status" -ne 0 ]
  [[ "$output" == *'dependency-missing: install util-linux so flock is available'* ]]
  [ ! -s "$GH_CALLS" ]
  [ ! -s "$OWNER_CALLS" ]
  [ -f "$BATS_TEST_TMPDIR/body.md" ]
  [ -f "$BATS_TEST_TMPDIR/before.png" ]
  [ -f "$BATS_TEST_TMPDIR/after.png" ]
}

check_unknown_post_error() {
  prepare_comment_fixture
  export COMMENT_DROP_RESPONSE=1 COMMENT_POST_EXIT=1 COMMENT_HIDE_THROUGH=3
  export COMMENT_POST_ERROR="$1"
  run comment_cli unknown-response
  [ "$status" -eq 1 ]
  local first_result="$output"
  run comment_cli unknown-response
  [ "$status" -eq 1 ]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]
  [ "$(jq 'length' "$COMMENT_FIXTURE")" -eq 1 ]
  [[ "$first_result" == *'"state":"unknown"'* ]]
  [[ "$output" == *'"state":"unknown"'* ]]
}

@test "EOF after posting never resends a temporarily invisible comment" {
  check_unknown_post_error 'unexpected EOF'
}

@test "an unrecognized post error never resends a temporarily invisible comment" {
  check_unknown_post_error 'opaque service failure'
}

@test "explicit no-comment confirmation allows the same request to retry after all uploads fail" {
  prepare_comment_fixture
  export COMMENT_NO_POST=1 COMMENT_POST_EXIT=1
  export COMMENT_POST_ERROR=$'upload failed\nno comment was posted'
  run comment_cli no-post
  [ "$status" -eq 1 ]
  [[ "$output" == *'"state":"failed"'* ]]
  [ "$(jq 'length' "$COMMENT_FIXTURE")" -eq 0 ]
  [ -f "$BATS_TEST_TMPDIR/body.md" ]
  [ -f "$BATS_TEST_TMPDIR/before.png" ]
  [ -f "$BATS_TEST_TMPDIR/after.png" ]
  export COMMENT_NO_POST=0 COMMENT_POST_EXIT=0
  run comment_cli no-post
  [ "$status" -eq 0 ]
  [[ "$output" == *'"state":"complete"'* ]]
  [ "$(jq 'length' "$COMMENT_FIXTURE")" -eq 1 ]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 2 ]
}
