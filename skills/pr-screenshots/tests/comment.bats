#!/usr/bin/env bats

setup() {
  export BROWSER_OWNERSHIP_DIR="$BATS_TEST_TMPDIR/ownership"
  export OWNER_CALLS="$BATS_TEST_TMPDIR/owner-calls"
  export MANAGED_CHROME_OWNER="$BATS_TEST_TMPDIR/unexpected-browser-owner"
  cat >"$MANAGED_CHROME_OWNER" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$OWNER_CALLS"
exit 99
SH
  chmod +x "$MANAGED_CHROME_OWNER"
  COMMENT_CLI="$BATS_TEST_DIRNAME/../scripts/pr-screenshots-comment.mjs"
}

prepare_comment_fixture() {
  export PR_SCREENSHOTS_GH="$BATS_TEST_TMPDIR/github"
  export COMMENT_FIXTURE="$BATS_TEST_TMPDIR/comments.json"
  export GH_CALLS="$BATS_TEST_TMPDIR/gh-post-calls"
  export GH_API_CALLS="$BATS_TEST_TMPDIR/gh-api-calls"
  export COMMENT_SENT_IMAGES="$BATS_TEST_TMPDIR/sent-images"
  export COMMENT_MUTATE_IMAGE=0
  export COMMENT_LOOKUP_COUNT="$BATS_TEST_TMPDIR/lookup-count"
  export COMMENT_FAIL_USER=0 COMMENT_FAIL_TARGET=0 COMMENT_FAIL_LOOKUP_ON=0 COMMENT_WRONG_TARGET=0
  export COMMENT_ATTACH_LIMIT=2 COMMENT_DROP_RESPONSE=0 COMMENT_POST_EXIT=0
  export COMMENT_POST_ERROR='connection reset by peer'
  export COMMENT_HIDE_THROUGH=0 COMMENT_NO_POST=0 COMMENT_NO_ATTACH=0
  printf '[]\n' >"$COMMENT_FIXTURE"
  printf 'before image\n' >"$BATS_TEST_TMPDIR/before.png"
  printf 'after image\n' >"$BATS_TEST_TMPDIR/after.png"
  cat >"$BATS_TEST_TMPDIR/body.md" <<EOF
変更前
![Before]($BATS_TEST_TMPDIR/before.png)

変更後
![After]($BATS_TEST_TMPDIR/after.png)
EOF
  cat >"$PR_SCREENSHOTS_GH" <<'SH'
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
  if [[ "$COMMENT_FAIL_TARGET" == 1 ]]; then
    printf 'temporary target failure\n' >&2
    exit 1
  fi
  repo=owner/repo
  if [[ "$COMMENT_MUTATE_IMAGE" == 1 ]]; then
    printf 'overwritten image\n' >"$BATS_TEST_TMPDIR/before.png"
  fi
  if [[ "$COMMENT_WRONG_TARGET" == 1 ]]; then repo=wrong/repo; fi
  printf '{"number":42,"base":{"repo":{"full_name":"%s"}}}' "$repo"
elif [[ "$1" == pr && "$2" == comment && "$3" == --help ]]; then
  if [[ "$COMMENT_NO_ATTACH" == 0 ]]; then printf '%s\n' '      --attach file'; fi
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
    cat "${image_paths[index]}" >>"$COMMENT_SENT_IMAGES"
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
  chmod +x "$PR_SCREENSHOTS_GH"
  export PWCLI_TEST_WSL=0
}

comment_cli() {
  local request_id=gh-comment
  local pr="${COMMENT_PR:-42}"
  local repo="${COMMENT_REPO:-owner/repo}"
  if [[ "$#" -gt 0 ]]; then request_id="$1"; fi
  "$COMMENT_CLI" --repo "$repo" --pr "$pr" \
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
  local cli="$COMMENT_CLI"
  "$cli" --repo owner/repo --pr 42 --image "$BATS_TEST_TMPDIR/before.png" --image "$BATS_TEST_TMPDIR/after.png" --body-file "$BATS_TEST_TMPDIR/body.md" --request-id concurrent >"$BATS_TEST_TMPDIR/first.json" 2>"$BATS_TEST_TMPDIR/first.err" &
  local first_pid=$!
  "$cli" --repo owner/repo --pr 42 --image "$BATS_TEST_TMPDIR/before.png" --image "$BATS_TEST_TMPDIR/after.png" --body-file "$BATS_TEST_TMPDIR/body.md" --request-id concurrent >"$BATS_TEST_TMPDIR/second.json" 2>"$BATS_TEST_TMPDIR/second.err" &
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
  local cli="$COMMENT_CLI"
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
  run "$cli" --repo owner/repo --pr 42 "${args[@]}" --body-file "$images" --request-id max-images
  [ "$status" -eq 0 ]
  [[ "$output" == *'"state":"complete"'* ]]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]

  args+=(--image "$BATS_TEST_TMPDIR/image-50.png")
  run "$cli" --repo owner/repo --pr 42 "${args[@]}" --body-file "$images" --request-id too-many-images
  [ "$status" -ne 0 ]
  [[ "$output" == *'comment-invalid: attach 1-50 unique image paths'* ]]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]

  run "$cli" --repo owner/repo --pr 42 \
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
  local cli="$COMMENT_CLI"
  local unsafe_image="$BATS_TEST_TMPDIR/before#fragment.png"
  printf image >"$unsafe_image"
  run "$cli" --repo owner/repo --pr 42 \
    --image "$BATS_TEST_TMPDIR/before.png" --image "$BATS_TEST_TMPDIR/before.png" \
    --body-file "$BATS_TEST_TMPDIR/body.md" --request-id duplicate-path
  [ "$status" -ne 0 ]
  [[ "$output" == *'comment-invalid: attach 1-50 unique image paths'* ]]
  [ ! -s "$GH_CALLS" ]

  run "$cli" --repo owner/repo --pr 42 \
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
  export PR_SCREENSHOTS_FLOCK="$BATS_TEST_TMPDIR/missing-flock"
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

@test "existing remote Markdown attachments are preserved with local uploads" {
  prepare_comment_fixture
  printf '\n![Existing](https://github.com/user-attachments/assets/existing)\n' >>"$BATS_TEST_TMPDIR/body.md"
  run comment_cli remote-reference
  [ "$status" -eq 0 ]
  [[ "$output" == *'"state":"complete"'* ]]
  [[ "$(jq -r '.[0].body' "$COMMENT_FIXTURE")" == *'![Existing](https://github.com/user-attachments/assets/existing)'* ]]
  run comment_cli remote-reference
  [ "$status" -eq 0 ]
  [[ "$output" == *'"reused":true'* ]]
  [ "$(jq 'length' "$COMMENT_FIXTURE")" -eq 1 ]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]
}

@test "unsupported gh fails before posting and upgrading permits the same request to retry" {
  prepare_comment_fixture
  export COMMENT_NO_ATTACH=1
  run comment_cli unsupported-gh
  [ "$status" -ne 0 ]
  [[ "$output" == *'dependency-missing: install GitHub CLI with gh pr comment --attach support'* ]]
  [ ! -s "$GH_CALLS" ]
  [ "$(jq 'length' "$COMMENT_FIXTURE")" -eq 0 ]

  export COMMENT_NO_ATTACH=0
  run comment_cli unsupported-gh
  [ "$status" -eq 0 ]
  [[ "$output" == *'"state":"complete"'* ]]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]

  export COMMENT_NO_ATTACH=1
  run comment_cli unsupported-gh
  [ "$status" -eq 0 ]
  [[ "$output" == *'"reused":true'* ]]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]
}

@test "comment uploads the signed image bytes even if originals change during preflight" {
  prepare_comment_fixture
  export COMMENT_MUTATE_IMAGE=1
  run comment_cli snapshot
  [ "$status" -eq 0 ]
  [[ "$output" == *'"state":"complete"'* ]]
  run node --input-type=module - "$COMMENT_SENT_IMAGES" "$GH_CALLS" "$BATS_TEST_TMPDIR" <<'JS'
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
assert.equal(readFileSync(process.argv[2], 'utf8'), 'before image\nafter image\n');
const args = readFileSync(process.argv[3], 'utf8').trim().split('\n');
const attachments = args.flatMap((arg, index) => arg === '--attach' ? [args[index + 1]] : []);
assert.equal(attachments.length, 2);
assert.ok(attachments.every(image => ![path.join(process.argv[4], 'before.png'), path.join(process.argv[4], 'after.png')].includes(image)));
assert.ok(attachments.every(image => !existsSync(image)), 'temporary upload copies are removed');
assert.equal(readFileSync(path.join(process.argv[4], 'before.png'), 'utf8'), 'overwritten image\n');
assert.equal(readFileSync(path.join(process.argv[4], 'after.png'), 'utf8'), 'after image\n');
JS
  [ "$status" -eq 0 ] || { printf '%s\n' "$output" >&2; false; }
}

@test "reused attachment URLs cannot confirm distinct requested images" {
  prepare_comment_fixture
  run comment_cli duplicate-assets
  [ "$status" -eq 0 ]
  [[ "$output" == *'"state":"complete"'* ]]
  node - "$COMMENT_FIXTURE" <<'JS'
const fs = require('node:fs');
const comments = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
comments[0].body = comments[0].body.replaceAll('assets/2', 'assets/1');
fs.writeFileSync(process.argv[2], JSON.stringify(comments));
JS
  run comment_cli duplicate-assets
  [ "$status" -eq 1 ]
  local result="$output"
  run node --input-type=module - "$result" <<'JS'
import assert from 'node:assert/strict';
const result = JSON.parse(process.argv[2]);
assert.equal(result.state, 'failed');
assert.deepEqual(result.assets, [null, null]);
assert.deepEqual(result.missing, result.images);
assert.match(result.reason, /same attachment URL/);
JS
  [ "$status" -eq 0 ] || { printf '%s\n' "$output" >&2; false; }
  run comment_cli duplicate-assets
  [ "$status" -eq 1 ]
  [[ "$output" == *'same attachment URL'* ]]
  [ "$(grep -c '^--POST--$' "$GH_CALLS")" -eq 1 ]
}

@test "preflight failures can be retried without changing legacy attachment state" {
  prepare_comment_fixture
  local legacy="$BROWSER_OWNERSHIP_DIR/attachments/legacy-upload.json"
  mkdir -p "$(dirname "$legacy")"
  printf '%s\n' '{"phase":"uploading","signature":"old"}' >"$legacy"
  printf '%s\n' '{"port":9222}' >"$BROWSER_OWNERSHIP_DIR/allocations.json"

  export COMMENT_FAIL_TARGET=1
  run comment_cli
  [ "$status" -eq 1 ]
  [[ "$output" == *'preflight-failed: GitHub CLI exited with status 1.'* ]]
  [ "$(cat "$GH_API_CALLS")" = "api repos/owner/repo/pulls/42" ]
  export COMMENT_FAIL_TARGET=0 COMMENT_FAIL_LOOKUP_ON=1
  run comment_cli
  [ "$status" -eq 1 ]
  [[ "$output" == *'preflight-failed: GitHub CLI exited with status 1.'* ]]
  [ "$(cat "$COMMENT_LOOKUP_COUNT")" -eq 1 ]
  [ ! -e "$GH_CALLS" ]

  run comment_cli
  [ "$status" -eq 0 ]
  [[ "$output" == *'"state":"complete"'* ]]
  run comment_cli
  [ "$status" -eq 0 ]
  [[ "$output" == *'"reused":true'* ]]
  [ "$(grep -c -- --POST-- "$GH_CALLS")" -eq 1 ]
  [ ! -s "$OWNER_CALLS" ]
  [ "$(cat "$legacy")" = '{"phase":"uploading","signature":"old"}' ]
  [ "$(cat "$BROWSER_OWNERSHIP_DIR/allocations.json")" = '{"port":9222}' ]
}
