#!/usr/bin/env bats

# gh の API 応答を再現し、ページングや検査状態を CLI の公開入口で検証する。
setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$PROJECT_ROOT/bin/gh-review-thread"
  MOCK_BIN="$BATS_TEST_TMPDIR/bin"
  MOCK_LOG="$BATS_TEST_TMPDIR/gh.log"
  mkdir -p "$MOCK_BIN"

  cat >"$MOCK_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$MOCK_LOG"

case "$*" in
"auth status")
  ;;
"pr view 42 --repo owner/repo --json number,url,title,state,headRefOid,headRefName,baseRefName")
  printf '%s\n' '{"number":42,"url":"https://github.com/owner/repo/pull/42","title":"Review me","state":"OPEN","headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headRefName":"feature","baseRefName":"main"}'
  ;;
"pr diff 42 --repo owner/repo --patch")
  printf '%s\n' 'diff --git a/a.txt b/a.txt'
  ;;
*"query ReviewQualityChecks"*)
  if [[ "$*" == *"cursor=NEXT"* ]]; then
    jq '.checks_next' "$MOCK_CHECKS_FILE"
  else
    jq '.checks' "$MOCK_CHECKS_FILE"
  fi
  ;;
*"query ReviewQualityComments"*)
  if [[ "$*" == *"cursor=NEXT"* ]]; then
    jq '.comments_next' "$MOCK_CHECKS_FILE"
  else
    jq '.comments' "$MOCK_CHECKS_FILE"
  fi
  ;;
*"reviewThreads(first:"*)
  printf '%s\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"PRRT_1","isResolved":false,"isOutdated":false,"path":"a.txt","line":3,"diffSide":"RIGHT","startLine":null,"startDiffSide":null,"originalLine":3,"originalStartLine":null,"resolvedBy":null,"comments":{"nodes":[{"id":"PRRC_1","body":"Please fix","createdAt":"2026-07-31T00:00:00Z","updatedAt":"2026-07-31T00:00:00Z","author":{"login":"reviewer"}}]}}]}}}}}'
  ;;
*"node(id:"*)
  if [ "${MOCK_SCENARIO:-}" = "bot-body" ]; then
    jq -cn --rawfile body "$MOCK_BODY_FILE" '{data:{viewer:{login:"agent"},node:{id:"PRRT_1",isResolved:false,pullRequest:{number:42,repository:{nameWithOwner:"owner/repo"}},comments:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[{id:"PRRC_1",body:$body,author:{login:"coderabbitai"}}]}}}}'
  elif [ "${MOCK_SCENARIO:-}" = "duplicate" ]; then
    printf '%s\n' '{"data":{"viewer":{"login":"agent"},"node":{"id":"PRRT_1","isResolved":false,"pullRequest":{"number":42,"repository":{"nameWithOwner":"owner/repo"}},"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"body":"対応しました（aaaaaaa）。指摘箇所を修正しました。\n\n確認: bats成功。","author":{"login":"agent"}}]}}}}'
  elif [ "${MOCK_SCENARIO:-}" = "duplicate-after-feedback" ]; then
    printf '%s\n' '{"data":{"viewer":{"login":"agent"},"node":{"id":"PRRT_1","isResolved":false,"pullRequest":{"number":42,"repository":{"nameWithOwner":"owner/repo"}},"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"body":"対応しました（aaaaaaa）。指摘箇所を修正しました。\n\n確認: bats成功。","author":{"login":"agent"}},{"body":"追加の指摘です。","author":{"login":"reviewer"}}]}}}}'
  elif [ "${MOCK_SCENARIO:-}" = "comment-pages" ] && [[ "$*" == *"cursor=NEXT"* ]]; then
    printf '%s\n' '{"data":{"viewer":{"login":"agent"},"node":{"id":"PRRT_1","isResolved":false,"pullRequest":{"number":42,"repository":{"nameWithOwner":"owner/repo"}},"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"PRRC_2","body":"second","createdAt":"2026-07-31T00:01:00Z","updatedAt":"2026-07-31T00:01:00Z","author":{"login":"reviewer"}}]}}}}'
  elif [ "${MOCK_SCENARIO:-}" = "comment-pages" ]; then
    printf '%s\n' '{"data":{"viewer":{"login":"agent"},"node":{"id":"PRRT_1","isResolved":false,"pullRequest":{"number":42,"repository":{"nameWithOwner":"owner/repo"}},"comments":{"pageInfo":{"hasNextPage":true,"endCursor":"NEXT"},"nodes":[{"id":"PRRC_1","body":"first","createdAt":"2026-07-31T00:00:00Z","updatedAt":"2026-07-31T00:00:00Z","author":{"login":"reviewer"}}]}}}}'
  elif [ "${MOCK_SCENARIO:-}" = "resolved" ]; then
    printf '%s\n' '{"data":{"viewer":{"login":"agent"},"node":{"id":"PRRT_1","isResolved":true,"pullRequest":{"number":42,"repository":{"nameWithOwner":"owner/repo"}},"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}'
  elif [ "${MOCK_SCENARIO:-}" = "resolved-replied" ]; then
    printf '%s\n' '{"data":{"viewer":{"login":"agent"},"node":{"id":"PRRT_1","isResolved":true,"pullRequest":{"number":42,"repository":{"nameWithOwner":"owner/repo"}},"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"body":"確認しました。既に対応済みです。\n\n根拠: threadがresolvedです。","author":{"login":"agent"}}]}}}}'
  elif [ "${MOCK_SCENARIO:-}" = "wrong-scope" ]; then
    printf '%s\n' '{"data":{"viewer":{"login":"agent"},"node":{"id":"PRRT_1","isResolved":false,"pullRequest":{"number":7,"repository":{"nameWithOwner":"other/repo"}},"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}'
  elif [ "${MOCK_SCENARIO:-}" = "null-author" ]; then
    printf '%s\n' '{"data":{"viewer":{"login":"agent"},"node":{"id":"PRRT_1","isResolved":false,"pullRequest":{"number":42,"repository":{"nameWithOwner":"owner/repo"}},"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"body":"old reply","author":null}]}}}}'
  else
    printf '%s\n' '{"data":{"viewer":{"login":"agent"},"node":{"id":"PRRT_1","isResolved":false,"pullRequest":{"number":42,"repository":{"nameWithOwner":"owner/repo"}},"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"body":"Please fix","author":{"login":"reviewer"}}]}}}}'
  fi
  ;;
*"commits(first:"*)
  python3 - "$@" <<'PY'
import json, os, sys
scenario = os.environ.get('MOCK_SCENARIO', '')
commits = ['a' * 40]
if scenario == 'unpublished':
    commits = []
elif scenario in ('commit-pages', 'unpublished-pages'):
    commits = [f'{index:040x}' for index in range(251)]
    if scenario == 'commit-pages':
        commits[-1] = 'a' * 40
start = next((int(arg.split('=', 1)[1]) for arg in sys.argv if arg.startswith('cursor=')), 0)
end = min(start + 100, len(commits))
connection = {'nodes': [{'commit': {'oid': sha}} for sha in commits[start:end]],
              'pageInfo': {'hasNextPage': end < len(commits), 'endCursor': str(end)}}
print(json.dumps({'data': {'repository': {'pullRequest': {'commits': connection}}}}))
PY
  ;;
*"addPullRequestReviewThreadReply"*)
  if [ "${MOCK_SCENARIO:-}" = "reply-failure" ]; then
    printf '%s\n' 'reply failed' >&2
    exit 1
  fi
  printf '%s\n' '{"data":{"addPullRequestReviewThreadReply":{"comment":{"id":"PRRC_REPLY"}}}}'
  ;;
*"resolveReviewThread"*)
  printf '%s\n' '{"data":{"resolveReviewThread":{"thread":{"id":"PRRT_1","isResolved":true}}}}'
  ;;
*)
  printf 'unexpected gh invocation: %s\n' "$*" >&2
  exit 2
  ;;
esac
EOF
  chmod +x "$MOCK_BIN/gh"
}

@test "inspect returns thread-aware PR context from gh" {
  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
    "$SCRIPT" inspect --repo owner/repo --pr 42

  [ "$status" -eq 0 ]
  run jq -e '
    .pull_request.number == 42
    and .diff == "diff --git a/a.txt b/a.txt\n"
    and .review_threads[0].id == "PRRT_1"
    and .review_threads[0].isResolved == false
  ' <<<"$output"
  [ "$status" -eq 0 ]
  grep -Fq 'pr view 42 --repo owner/repo' "$MOCK_LOG"
  grep -Fq 'pr diff 42 --repo owner/repo --patch' "$MOCK_LOG"
  grep -Fq 'api graphql' "$MOCK_LOG"
}

@test "inspect checks reports a CodeRabbit warning when GitHub checks pass" {
  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
    MOCK_CHECKS_FILE="$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '
    .checks.head == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    and .checks.status == "failed"
    and .checks.github.status == "passed"
    and .checks.coderabbit.status == "failed"
    and .checks.coderabbit.items[0].name == "Docstring Coverage"
  ' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect checks includes a warning row that omits its leading pipe without summary counters" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  jq '.comments.data.repository.pullRequest.comments.nodes[0].body |=
      sub("\\| Docstring Coverage"; "| Title | ![Passed](passed.svg) |\nDocstring Coverage")' \
    "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '
    .checks.status == "failed"
    and .checks.coderabbit.items[1] == {name: "Docstring Coverage", status: "failed"}
  ' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect checks never passes a table with unparsed or unnamed rows" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  for row in 'Unparsed check' '| | ![Passed](passed.svg) |'; do
    jq --arg row "$row" '.comments.data.repository.pullRequest.comments.nodes[0].body |=
        (sub("Warning"; "Passed") |
         sub("<!-- pre_merge_checks_walkthrough_end -->";
             $row + "\n<!-- pre_merge_checks_walkthrough_end -->"))' \
      "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

    run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
      "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

    [ "$status" -eq 0 ]
    run jq -e '.checks.status == "unknown" and .checks.coderabbit.items[-1].status == "unknown"' <<<"$output"
    [ "$status" -eq 0 ]
  done
}

@test "inspect checks verifies the current head from CodeRabbit summary metadata" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  jq '.comments.data.repository.pullRequest.comments.nodes[0].body |=
      sub("Reviewing files.*";
          "<!-- change_assessment_commit:\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\" -->")' \
    "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '
    .checks.status == "failed"
    and .checks.coderabbit.reviewed_head == .pull_request.headRefOid
    and .checks.coderabbit.items[0].status == "failed"
  ' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect checks rejects stale or conflicting summary commit metadata" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  for mode in stale conflicting; do
    jq --arg mode "$mode" '.comments.data.repository.pullRequest.comments.nodes[0].body |=
        if $mode == "stale" then
          sub("Reviewing files.*";
              "<!-- change_assessment_commit:\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\" -->")
        else
          . + "\n<!-- change_assessment_commit:\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\" -->"
        end' \
      "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

    run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
      "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

    [ "$status" -eq 0 ]
    run jq -e '
      .checks.status == "unknown"
      and .checks.coderabbit.status == "unknown"
      and .checks.coderabbit.reason == "CodeRabbit の判定対象 HEAD を確認できません"
    ' <<<"$output"
    [ "$status" -eq 0 ]
  done
}

@test "inspect checks passes when the current head has successful GitHub and CodeRabbit results" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  jq '.comments.data.repository.pullRequest.comments.nodes[0].body |=
      (sub("Warning"; "Passed") | sub("checks-warning"; "checks-passed") | sub("0[.]00%"; "100.00%"))' \
    "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '.checks.status == "passed" and .checks.coderabbit.reviewed_head == .pull_request.headRefOid' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect checks treats an unrecognized CodeRabbit table row as unknown" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  jq '.comments.data.repository.pullRequest.comments.nodes[0].body |=
      (sub("Warning"; "Passed") | sub("checks-warning"; "checks-passed") |
       sub("<!-- pre_merge_checks_walkthrough_end -->";
           "| Future check | new-format | No known verdict |\n<!-- pre_merge_checks_walkthrough_end -->"))' \
    "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '.checks.status == "unknown" and .checks.coderabbit.items[1].status == "unknown"' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect checks reports a running GitHub check as pending" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  jq '.checks.data.repository.object.statusCheckRollup.contexts.nodes[0] |=
        (.status = "IN_PROGRESS" | .conclusion = null)
      | .comments.data.repository.pullRequest.comments.nodes = []' \
    "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '.checks.status == "pending" and .checks.github.status == "pending"' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect checks treats a stale CodeRabbit review as unknown" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  jq '.comments.data.repository.pullRequest.comments.nodes[0].body |=
      sub("and aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; "and cccccccccccccccccccccccccccccccccccccccc")' \
    "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '.checks.status == "unknown" and .checks.coderabbit.reviewed_head == "cccccccccccccccccccccccccccccccccccccccc"' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect checks reports missing or nonofficial CodeRabbit summaries as unknown" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  jq '.comments.data.repository.pullRequest.comments.nodes[0].author.login = "other-user"' \
    "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '.checks.status == "unknown" and .checks.coderabbit.items == []' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect checks never passes after the PR head changes while reading comments" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  jq '.comments.data.repository.pullRequest.headRefOid = "cccccccccccccccccccccccccccccccccccccccc"' \
    "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '.checks.status == "unknown" and .checks.coderabbit.status == "unknown"' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect checks includes a failing commit status on a later checks page" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  jq '.checks_next = .checks
      | .checks.data.repository.object.statusCheckRollup.contexts.pageInfo = {hasNextPage:true,endCursor:"NEXT"}
      | .checks_next.data.repository.object.statusCheckRollup.contexts.nodes =
        [{"__typename":"StatusContext","context":"external-quality","state":"FAILURE","targetUrl":"https://example.com/check"}]' \
    "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '.checks.github.status == "failed" and .checks.github.items[1].name == "external-quality"' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect checks uses the latest CodeRabbit summary even on a later comments page" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  jq '.comments_next = .comments
      | .comments.data.repository.pullRequest.comments.pageInfo = {hasNextPage:true,endCursor:"NEXT"}
      | .comments_next.data.repository.pullRequest.comments.nodes[0] |=
        (.updatedAt = "2026-11-11T00:01:00Z" | .url = "https://github.com/owner/repo/pull/42#issuecomment-2"
         | .body |= (sub("Warning"; "Passed") | sub("checks-warning"; "checks-passed") | sub("0[.]00%"; "100.00%")))' \
    "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '.checks.status == "passed" and (.checks.coderabbit.url | endswith("issuecomment-2"))' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect checks keeps a warning whose check name resembles the table header" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  jq '.comments.data.repository.pullRequest.comments.nodes[0].body |=
      (sub("Docstring Coverage"; "Check name") |
       sub("<!-- pre_merge_checks_walkthrough_end -->";
           "| Title check | ![Passed](https://example.com/passed.svg) | Valid title |\n<!-- pre_merge_checks_walkthrough_end -->"))' \
    "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '.checks.status == "failed" and .checks.coderabbit.items[0].name == "Check name"' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect checks does not accept a partial badge match as a successful verdict" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  jq '.comments.data.repository.pullRequest.comments.nodes[0].body |=
      sub("!\\[Warning\\]\\([^)]*\\)"; "unsupported ![Passed](https://example.com/passed.svg) suffix")' \
    "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '.checks.status == "unknown" and .checks.coderabbit.items[0].status == "unknown"' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect checks treats a skipped GitHub check as unknown" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  jq '.checks.data.repository.object.statusCheckRollup.contexts.nodes[0].conclusion = "SKIPPED"
      | .comments.data.repository.pullRequest.comments.nodes[0].body |=
        (sub("Warning"; "Passed") | sub("checks-warning"; "checks-passed") | sub("0[.]00%"; "100.00%"))' \
    "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '.checks.status == "unknown" and .checks.github.status == "unknown" and .checks.coderabbit.status == "passed"' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect checks rejects a summary whose counters disagree with the parsed rows" {
  fixture="$BATS_TEST_TMPDIR/checks.json"
  jq '.comments.data.repository.pullRequest.comments.nodes[0].body |=
      (sub("Warning"; "Passed") | sub("checks-warning"; "checks-passed") |
       sub("<!-- pre_merge_checks_walkthrough_start -->";
           "<!-- pre_merge_checks_walkthrough_start -->\n<summary>Pre-merge checks: <sup><picture><img alt=\"Failed\" src=\"https://example.com/failed.svg\"></picture></sup> 1</summary>"))' \
    "$PROJECT_ROOT/tests/fixtures/gh-review-checks.json" >"$fixture"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_CHECKS_FILE="$fixture" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --checks

  [ "$status" -eq 0 ]
  run jq -e '.checks.status == "unknown" and .checks.coderabbit.status == "unknown"' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "reply-resolve publishes a verified reply before resolving the thread" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n\n%s\n' \
    '対応しました（aaaaaaa）。指摘箇所を修正しました。' \
    '確認: bats成功。' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
    "$SCRIPT" reply-resolve \
    --repo owner/repo \
    --pr 42 \
    --thread-id PRRT_1 \
    --commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --body-file "$body_file"

  [ "$status" -eq 0 ]
  run jq -e '
    .thread_id == "PRRT_1"
    and .reply == "created"
    and .resolve == "resolved"
  ' <<<"$output"
  [ "$status" -eq 0 ]

  reply_line="$(grep -n 'addPullRequestReviewThreadReply' "$MOCK_LOG" | head -n1 | cut -d: -f1)"
  resolve_line="$(grep -n 'resolveReviewThread' "$MOCK_LOG" | head -n1 | cut -d: -f1)"
  [ "$reply_line" -lt "$resolve_line" ]
}

@test "reply-resolve ignores trailing newlines when resuming an identical viewer reply" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n\n%s\n' \
    '対応しました（aaaaaaa）。指摘箇所を修正しました。' \
    '確認: bats成功。' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="duplicate" \
    "$SCRIPT" reply-resolve \
    --repo owner/repo \
    --pr 42 \
    --thread-id PRRT_1 \
    --commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --body-file "$body_file"

  [ "$status" -eq 0 ]
  run jq -e '.reply == "skipped" and .resolve == "resolved"' <<<"$output"
  [ "$status" -eq 0 ]
  ! grep -Fq 'addPullRequestReviewThreadReply' "$MOCK_LOG"
  grep -Fq 'resolveReviewThread' "$MOCK_LOG"
}

@test "reply-resolve replies again when newer reviewer feedback follows a matching reply" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n\n%s\n' \
    '対応しました（aaaaaaa）。指摘箇所を修正しました。' \
    '確認: bats成功。' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="duplicate-after-feedback" \
    "$SCRIPT" reply-resolve \
    --repo owner/repo \
    --pr 42 \
    --thread-id PRRT_1 \
    --commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --body-file "$body_file"

  [ "$status" -eq 0 ]
  run jq -e '.reply == "created" and .resolve == "resolved"' <<<"$output"
  [ "$status" -eq 0 ]
  grep -Fq 'addPullRequestReviewThreadReply' "$MOCK_LOG"
  grep -Fq 'resolveReviewThread' "$MOCK_LOG"
}

@test "reply-resolve still replies to a thread resolved before the reply" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n\n%s\n' \
    '対応しました（aaaaaaa）。指摘箇所を修正しました。' \
    '確認: bats成功。' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="resolved" \
    "$SCRIPT" reply-resolve \
    --repo owner/repo \
    --pr 42 \
    --thread-id PRRT_1 \
    --commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --body-file "$body_file"

  [ "$status" -eq 0 ]
  run jq -e '.reply == "created" and .resolve == "resolved"' <<<"$output"
  [ "$status" -eq 0 ]
  grep -Fq 'commits(first:' "$MOCK_LOG"
  grep -Fq 'addPullRequestReviewThreadReply' "$MOCK_LOG"
  # 取得後に resolve が外されても完了させるため、取得時の状態によらず resolve する。
  grep -Fq 'resolveReviewThread' "$MOCK_LOG"
}

@test "reply-resolve does not repeat its reply on an already resolved thread" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n\n%s\n' \
    '確認しました。既に対応済みです。' \
    '根拠: threadがresolvedです。' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="resolved-replied" \
    "$SCRIPT" reply-resolve \
    --repo owner/repo \
    --pr 42 \
    --thread-id PRRT_1 \
    --explanation-only \
    --body-file "$body_file"

  [ "$status" -eq 0 ]
  run jq -e '.reply == "skipped" and .resolve == "resolved"' <<<"$output"
  [ "$status" -eq 0 ]
  ! grep -Fq 'addPullRequestReviewThreadReply' "$MOCK_LOG"
  grep -Fq 'resolveReviewThread' "$MOCK_LOG"
}

@test "reply-resolve refuses a thread from another pull request" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n\n%s\n' \
    '確認しました。対象を確認しました。' \
    '根拠: PR metadataです。' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="wrong-scope" \
    "$SCRIPT" reply-resolve \
    --repo owner/repo \
    --pr 42 \
    --thread-id PRRT_1 \
    --explanation-only \
    --body-file "$body_file"

  [ "$status" -ne 0 ]
  [[ "$output" == *"review thread belongs to other/repo#7"* ]]
  ! grep -Fq 'addPullRequestReviewThreadReply' "$MOCK_LOG"
  ! grep -Fq 'resolveReviewThread' "$MOCK_LOG"
}

@test "reply-resolve accepts a commit merged elsewhere that remains in a non-default-base PR" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n\n%s\n' \
    '対応しました（aaaaaaa）。指摘箇所を修正しました。' \
    '確認: bats成功。' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="merged-elsewhere" \
    "$SCRIPT" reply-resolve --repo owner/repo --pr 42 \
    --thread-id PRRT_1 --commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --body-file "$body_file"

  [ "$status" -eq 0 ]
  run jq -e '.reply == "created" and .resolve == "resolved"' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "reply-resolve checks all pages beyond 250 commits before accepting or rejecting a fix" {
  local scenario
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n\n%s\n' \
    '対応しました（aaaaaaa）。指摘箇所を修正しました。' \
    '確認: bats成功。' >"$body_file"

  for scenario in commit-pages unpublished-pages; do
    : >"$MOCK_LOG"
    run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="$scenario" \
      "$SCRIPT" reply-resolve --repo owner/repo --pr 42 \
      --thread-id PRRT_1 --commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
      --body-file "$body_file"

    if [ "$scenario" = commit-pages ]; then
      [ "$status" -eq 0 ]
      run jq -e '.reply == "created" and .resolve == "resolved"' <<<"$output"
      [ "$status" -eq 0 ]
    else
      [ "$status" -ne 0 ]
      [[ "$output" == *"is not published in owner/repo#42"* ]]
      ! grep -Fq 'addPullRequestReviewThreadReply' "$MOCK_LOG"
      ! grep -Fq 'resolveReviewThread' "$MOCK_LOG"
    fi
  done
}

@test "reply-resolve refuses to resolve an unpublished fix commit" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n\n%s\n' \
    '対応しました（aaaaaaa）。指摘箇所を修正しました。' \
    '確認: bats成功。' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="unpublished" \
    "$SCRIPT" reply-resolve \
    --repo owner/repo \
    --pr 42 \
    --thread-id PRRT_1 \
    --commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --body-file "$body_file"

  [ "$status" -ne 0 ]
  [[ "$output" == *"is not published in owner/repo#42"* ]]
  ! grep -Fq 'addPullRequestReviewThreadReply' "$MOCK_LOG"
  ! grep -Fq 'resolveReviewThread' "$MOCK_LOG"
}

@test "reply-resolve never resolves when publishing the reply fails" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n\n%s\n' \
    '確認しました。挙動を確認しました。' \
    '根拠: ADR-0032です。' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="reply-failure" \
    "$SCRIPT" reply-resolve \
    --repo owner/repo \
    --pr 42 \
    --thread-id PRRT_1 \
    --explanation-only \
    --body-file "$body_file"

  [ "$status" -ne 0 ]
  grep -Fq 'addPullRequestReviewThreadReply' "$MOCK_LOG"
  ! grep -Fq 'resolveReviewThread' "$MOCK_LOG"
}

@test "reply-resolve allows explanation-only threads without an empty commit" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n\n%s\n' \
    '確認しました。この挙動は意図的に選択しています。' \
    '根拠: ADR-0032です。' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
    "$SCRIPT" reply-resolve \
    --repo owner/repo \
    --pr 42 \
    --thread-id PRRT_1 \
    --explanation-only \
    --body-file "$body_file"

  [ "$status" -eq 0 ]
  ! grep -Fq 'commits(first:' "$MOCK_LOG"
  grep -Fq 'addPullRequestReviewThreadReply' "$MOCK_LOG"
  grep -Fq 'resolveReviewThread' "$MOCK_LOG"
}

@test "reply-resolve tolerates comments whose author was deleted" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n\n%s\n' \
    '確認しました。挙動を確認しました。' \
    '根拠: ADR-0032です。' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="null-author" \
    "$SCRIPT" reply-resolve \
    --repo owner/repo \
    --pr 42 \
    --thread-id PRRT_1 \
    --explanation-only \
    --body-file "$body_file"

  [ "$status" -eq 0 ]
  grep -Fq 'addPullRequestReviewThreadReply' "$MOCK_LOG"
  grep -Fq 'resolveReviewThread' "$MOCK_LOG"
}

@test "reply-resolve requires an explicit fix commit or explanation-only mode" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n' '任意の返信です。' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
    "$SCRIPT" reply-resolve \
    --repo owner/repo \
    --pr 42 \
    --thread-id PRRT_1 \
    --body-file "$body_file"

  [ "$status" -eq 2 ]
  [[ "$output" == *"one of the arguments --commit --explanation-only is required"* ]]
  [ ! -e "$MOCK_LOG" ]
}

@test "reply-resolve rejects a fix reply without the Japanese evidence template" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n' '対応しました。' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
    "$SCRIPT" reply-resolve \
    --repo owner/repo \
    --pr 42 \
    --thread-id PRRT_1 \
    --commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --body-file "$body_file"

  [ "$status" -eq 2 ]
  [[ "$output" == *"fix replies must use"* ]]
  ! grep -Fq 'addPullRequestReviewThreadReply' "$MOCK_LOG"
  ! grep -Fq 'resolveReviewThread' "$MOCK_LOG"
}

@test "reply-resolve rejects an empty fix summary and verification" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n\n%s\n' '対応しました（aaaaaaa）。' '確認:' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
    "$SCRIPT" reply-resolve \
    --repo owner/repo \
    --pr 42 \
    --thread-id PRRT_1 \
    --commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --body-file "$body_file"

  [ "$status" -eq 2 ]
  [[ "$output" == *"fix replies must include a non-empty summary and verification"* ]]
  ! grep -Fq 'addPullRequestReviewThreadReply' "$MOCK_LOG"
}

@test "reply-resolve rejects an empty explanation and evidence" {
  body_file="$BATS_TEST_TMPDIR/reply.md"
  printf '%s\n\n%s\n' '確認しました。' '根拠:' >"$body_file"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
    "$SCRIPT" reply-resolve \
    --repo owner/repo \
    --pr 42 \
    --thread-id PRRT_1 \
    --explanation-only \
    --body-file "$body_file"

  [ "$status" -eq 2 ]
  [[ "$output" == *"explanation-only replies must include a non-empty answer and evidence"* ]]
  ! grep -Fq 'addPullRequestReviewThreadReply' "$MOCK_LOG"
}

@test "inspect --no-diff omits the diff" {
  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff

  [ "$status" -eq 0 ]
  run jq -e 'has("diff") | not' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "inspect paginates comments within each review thread" {
  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="comment-pages" \
    "$SCRIPT" inspect --repo owner/repo --pr 42

  [ "$status" -eq 0 ]
  run jq -e '
    .review_threads[0].comments.nodes | map(.body) == ["first", "second"]
  ' <<<"$output"
  [ "$status" -eq 0 ]
  grep -Fq 'cursor=NEXT' "$MOCK_LOG"
}

write_bot_body() {
  MOCK_BODY_FILE="$BATS_TEST_TMPDIR/body.md"
  cat >"$MOCK_BODY_FILE" <<'BODY'
_⚠️ Potential issue_ | _🟠 Major_

<details>
<summary>🧩 Analysis chain</summary>

Run log line
</details>

Keep `cat <<EOF` and `Result<T>` intact.<br>
<sub>Footnote</sub>

<p>Paragraph</p>

<blockquote>Quoted</blockquote>

```diff
-<p>old</p>
+cat <<EOF
```

<!-- This is an auto-generated comment by CodeRabbit -->
<img src="https://img.shields.io/badge/x-y-z" alt="badge">
![badge](https://img.shields.io/badge/a-b-c)

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding.
```

</details>
BODY
}

@test "inspect --plain strips known review HTML and badges but keeps code angle brackets" {
  write_bot_body

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="bot-body" \
    MOCK_BODY_FILE="$MOCK_BODY_FILE" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --plain

  [ "$status" -eq 0 ]
  body="$(jq -r '.review_threads[0].comments.nodes[0].body' <<<"$output")"
  local kept
  for kept in 'cat <<EOF' 'Result<T>' '-<p>old</p>' '+cat <<EOF' \
    'Analysis chain' 'Run log line' 'Footnote' 'Paragraph' 'Quoted' \
    'Prompt for AI Agents' 'Verify each finding.' '```diff'; do
    [[ "$body" == *"$kept"* ]]
  done
  local removed
  for removed in '<details' '</details>' '<summary' '<sub>' '<br>' \
    '<p>Paragraph' '<blockquote' '<!--' '<img' 'img.shields.io'; do
    [[ "$body" != *"$removed"* ]]
  done
  [[ "$body" != *$'\n\n\n'* ]]
}

@test "inspect --plain leaves code spans, every fence style and non-badge images untouched" {
  MOCK_BODY_FILE="$BATS_TEST_TMPDIR/body.md"
  cat >"$MOCK_BODY_FILE" <<'BODY'
<details>
Use `<br>` here.
Keep ``literal `<p>` tag`` okay.
Span ``across
<sub>lines``.

~~~html
<p>tilde</p>
~~~

````md
```
<p>nested</p>
```
````

```text
a


b
```

<img src="https://example.com/shot.png">
BODY

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="bot-body" \
    MOCK_BODY_FILE="$MOCK_BODY_FILE" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --plain

  [ "$status" -eq 0 ]
  body="$(jq -r '.review_threads[0].comments.nodes[0].body' <<<"$output")"
  [[ "$body" != *'<details>'* ]]
  local kept
  for kept in 'Use `<br>` here.' 'Keep ``literal `<p>` tag`` okay.' \
    $'Span ``across\n<sub>lines``.' '<p>tilde</p>' '<p>nested</p>' $'a\n\n\nb' \
    '<img src="https://example.com/shot.png">'; do
    [[ "$body" == *"$kept"* ]]
  done
}

@test "inspect --plain trims only outside protected code at the body edges" {
  MOCK_BODY_FILE="$BATS_TEST_TMPDIR/body.md"
  printf '  ```text\n<p>x</p>\n  ```\n\n<br>\n```\nopen  ' >"$MOCK_BODY_FILE"

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="bot-body" \
    MOCK_BODY_FILE="$MOCK_BODY_FILE" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff --plain

  [ "$status" -eq 0 ]
  [ "$(jq -r '.review_threads[0].comments.nodes[0].body' <<<"$output")" = \
    $'  ```text\n<p>x</p>\n  ```\n\n```\nopen  ' ]
}

@test "inspect keeps the raw review body by default" {
  write_bot_body

  run env PATH="$MOCK_BIN:$PATH" MOCK_LOG="$MOCK_LOG" MOCK_SCENARIO="bot-body" \
    MOCK_BODY_FILE="$MOCK_BODY_FILE" \
    "$SCRIPT" inspect --repo owner/repo --pr 42 --no-diff

  [ "$status" -eq 0 ]
  [ "$(jq -r '.review_threads[0].comments.nodes[0].body' <<<"$output")" = "$(cat "$MOCK_BODY_FILE")" ]
}
