const COMMITS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      commits(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { commit { oid } }
      }
    }
  }
}
`.trim();

const REPLY_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(
    input: {
      pullRequestReviewThreadId: $threadId
      body: $body
    }
  ) {
    comment { id }
  }
}
`.trim();

const RESOLVE_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}
`.trim();

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          diffSide
          startLine
          startDiffSide
          originalLine
          originalStartLine
          resolvedBy { login }
        }
      }
    }
  }
}
`.trim();

const THREAD_QUERY = `
query($threadId: ID!, $cursor: String) {
  viewer { login }
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      id
      isResolved
      pullRequest {
        number
        repository { nameWithOwner }
      }
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          body
          createdAt
          updatedAt
          author { login }
        }
      }
    }
  }
}
`.trim();

const CHECKS_QUERY = `
query ReviewQualityChecks($owner: String!, $repo: String!, $head: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    object(expression: $head) {
      ... on Commit {
        oid
        statusCheckRollup {
          contexts(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
}
`.trim();

const QUALITY_COMMENTS_QUERY = `
query ReviewQualityComments($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { body updatedAt url author { login } }
      }
    }
  }
}
`.trim();

const HELP: Record<string, string> = {
  "": "usage: gh-review-thread [-h] {inspect,reply-resolve} ...\n\npositional arguments:\n  {inspect,reply-resolve}\n\noptions:\n  -h, --help            show this help message and exit\n",
  inspect:
    "usage: gh-review-thread inspect [-h] --repo REPO --pr PR [--no-diff] [--plain]\n                                [--checks]\n\noptions:\n  -h, --help   show this help message and exit\n  --repo REPO\n  --pr PR\n  --no-diff    omit the PR diff (about 40KB)\n  --plain      strip known review-bot HTML and badges from comment bodies\n  --checks     対象 HEAD の GitHub / CodeRabbit 検査結果を集計する\n",
  "reply-resolve":
    "usage: gh-review-thread reply-resolve [-h] --repo REPO --pr PR\n                                      --thread-id THREAD_ID (--commit COMMIT |\n                                      --explanation-only)\n                                      --body-file BODY_FILE\n\noptions:\n  -h, --help            show this help message and exit\n  --repo REPO\n  --pr PR\n  --thread-id THREAD_ID\n  --commit COMMIT\n  --explanation-only\n  --body-file BODY_FILE\n\n返信本文の形式（ADR-0032）:\n  --commit の場合:\n    対応しました（<commitの先頭7文字>）。<修正要約>\n    （本文は短縮 SHA、--commit には40桁の完全な SHA を渡す）\n\n    確認: <検証結果>\n\n  --explanation-only の場合:\n    確認しました。<回答>\n\n    根拠: <根拠>\n",
};
const USAGE: Record<string, string> = {
  "": "usage: gh-review-thread [-h] {inspect,reply-resolve} ...\n",
  inspect:
    "usage: gh-review-thread inspect [-h] --repo REPO --pr PR [--no-diff] [--plain]\n                                [--checks]\n",
  "reply-resolve":
    "usage: gh-review-thread reply-resolve [-h] --repo REPO --pr PR\n                                      --thread-id THREAD_ID (--commit COMMIT |\n                                      --explanation-only)\n                                      --body-file BODY_FILE\n",
};

import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parsePeerJSON, peerJSON, equalPeerJSON } from "./peer-json.ts";
import { object, strip, stripEnd } from "./coordination-json.ts";
import casefoldTable from "./vendor/peer-casefold.json";
import digitZeros from "./vendor/peer-decimal.json";

type Data = Record<string, any>;
class Failure extends Error {
  constructor(
    message: string,
    readonly status = 1,
  ) {
    super(message);
  }
}
function fail(message: string, status = 1): never {
  throw new Failure(message, status);
}
function pythonTruthy(value: any): boolean {
  if (value == null || value === false || value === 0 || value === 0n || value === "") return false;
  return Array.isArray(value)
    ? value.length > 0
    : typeof value === "object"
      ? Object.keys(value).length > 0
      : true;
}
function commentLogin(comment: unknown): any {
  if (!object(comment)) fail("GitHub returned a malformed review comment");
  const author = pythonTruthy(comment.author) ? comment.author : {};
  if (!object(author)) fail("GitHub returned a malformed review comment author");
  return author.login;
}
function knownStatus(statuses: Record<string, string>, key: string): string {
  return Object.hasOwn(statuses, key) ? statuses[key]! : "unknown";
}
function json(value: unknown, ascii = false): string {
  return peerJSON(value).replace(/"(?:[^"\\]|\\[\s\S])*"|\s+|[,:]/g, (token) => {
    if (token.startsWith('"'))
      return ascii
        ? token.replace(
            /[\x7f-\uffff]/g,
            (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
          )
        : token;
    return token === "," || token === ":" ? token + " " : "";
  });
}
const fold = (text: string) =>
  Array.from(text, (c) => (casefoldTable as Record<string, string>)[c] ?? c).join("");
const digitClass =
  "[" +
  digitZeros
    .map((start) => `\\u{${start.toString(16)}}-\\u{${(start + 9).toString(16)}}`)
    .join("") +
  "]";
function decimal(text: string): bigint {
  const characters = Array.from(text);
  if (characters.length > 4300) fail("integer exceeds the Python 4300-digit limit");
  return BigInt(
    characters
      .map((character) => {
        const point = character.codePointAt(0)!;
        const start = digitZeros.find((start) => start <= point && point < start + 10);
        if (start === undefined) throw new Error("invalid decimal digit");
        return String(point - start);
      })
      .join(""),
  );
}
function runGh(args: string[]): string {
  const found = Bun.which("gh");
  if (!found) fail("GitHub CLI is required");
  let result;
  try {
    result = spawnSync(realpathSync(found), args, { maxBuffer: Infinity });
  } catch (error) {
    fail(`GitHub CLI could not be started: ${(error as Error).message}`);
  }
  if (result.error) fail(`GitHub CLI could not be started: ${result.error.message}`);
  const decode = (raw: Uint8Array) =>
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw).replace(/\r\n?/g, "\n");
  if (result.status !== 0) fail(strip(decode(result.stderr)) || `gh ${args.join(" ")} failed`);
  return decode(result.stdout);
}
function ghJSON(args: string[]): Data {
  let payload: Data;
  try {
    payload = parsePeerJSON(Buffer.from(runGh(args)));
  } catch (error) {
    if (error instanceof Failure) throw error;
    fail(`gh returned invalid JSON: ${(error as Error).message}`);
  }
  if (pythonTruthy(payload.errors)) fail(`GitHub GraphQL error: ${json(payload.errors, true)}`);
  return payload;
}
function repoParts(repo: string): [string, string] {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail("--repo must use OWNER/REPO", 2);
  return repo.split("/") as [string, string];
}
function fetchThreads(repo: string, pr: string): Data[] {
  const [owner, name] = repoParts(repo),
    threads: Data[] = [];
  let cursor: string | null = null;
  while (true) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${THREADS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${name}`,
      "-F",
      `number=${pr}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const pull = ghJSON(args).data.repository.pullRequest;
    if (pull === null) fail(`pull request ${repo}#${pr} was not found`);
    const connection = pull.reviewThreads;
    threads.push(...(connection.nodes || []));
    if (!connection.pageInfo.hasNextPage) return threads;
    cursor = connection.pageInfo.endCursor;
  }
}
function fetchThread(threadId: string): Data {
  let cursor: string | null = null,
    thread: Data | undefined;
  const comments: Data[] = [];
  while (true) {
    const args = ["api", "graphql", "-f", `query=${THREAD_QUERY}`, "-f", `threadId=${threadId}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const payload = ghJSON(args),
      node = payload.data.node;
    if (node === null) fail(`review thread ${threadId} was not found`);
    thread ??= {
      id: node.id,
      isResolved: node.isResolved,
      pullRequest: node.pullRequest,
      viewer: payload.data.viewer.login,
    };
    comments.push(...(node.comments.nodes || []));
    if (!node.comments.pageInfo.hasNextPage) return { ...thread, comments };
    cursor = node.comments.pageInfo.endCursor;
  }
}
const CODE =
  /(?<![^\n])[ \t]*(`{3,}|~{3,}).*?(?:(?<![^\n])[ \t]*\1[^\n]*(?=\n|(?![\s\S]))|(?![\s\S]))|(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n).)+?(?<!`)\2(?!`)/gs;
const REVIEW_MARKUP =
  /<!--[\s\S]*?-->|<\/?(?:deta[iİı]ls|summary|sub|br|p|blockquote)(?![\p{L}\p{N}_])[^>]*>|<[iİı]mg(?![\p{L}\p{N}_])[^>]*(?<![\p{L}\p{N}_])src=["']?https:\/\/[iİı]mg\.sh[iİı]elds\.[iİı]o\/[^>]*>|!\[[^\]]*\]\(https:\/\/[iİı]mg\.sh[iİı]elds\.[iİı]o\/[^)]*\)/gisu;
// 旧 Python の行境界は LF のみ。\s と単語境界も JS の既定値に置き換えない。
const SPACE =
  "[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
function stripMarkup(text: string): string {
  return text.replace(REVIEW_MARKUP, "").replace(/\n(?:[ \t]*\n){2,}/g, "\n\n");
}
function plainBody(body: string): string {
  const parts: string[] = [];
  let position = 0;
  for (const code of body.matchAll(CODE)) {
    parts.push(stripMarkup(body.slice(position, code.index)), code[0]);
    position = code.index + code[0].length;
  }
  parts.push(stripMarkup(body.slice(position)));
  parts[0] = parts[0]!.replace(
    /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/,
    "",
  );
  parts[parts.length - 1] = stripEnd(parts.at(-1)!);
  return parts.join("");
}
function combined(statuses: string[]): string {
  if (!statuses.length) return "unknown";
  for (const status of ["failed", "pending", "unknown"])
    if (statuses.includes(status)) return status;
  return statuses.every((status) => status === "passed") ? "passed" : "unknown";
}
function githubCheck(item: Data): Data {
  if (item.__typename === "CheckRun") {
    let status = "unknown";
    if (["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"].includes(item.status))
      status = "pending";
    else if (item.status === "COMPLETED")
      status = knownStatus(
        {
          SUCCESS: "passed",
          FAILURE: "failed",
          TIMED_OUT: "failed",
          CANCELLED: "failed",
          ACTION_REQUIRED: "failed",
          STARTUP_FAILURE: "failed",
        },
        item.conclusion,
      );
    return {
      name: item.name ?? null,
      status,
      url: item.detailsUrl ?? null,
      source: {
        type: "CheckRun",
        status: item.status ?? null,
        conclusion: item.conclusion ?? null,
      },
    };
  }
  const status = knownStatus(
    {
      SUCCESS: "passed",
      FAILURE: "failed",
      ERROR: "failed",
      PENDING: "pending",
      EXPECTED: "pending",
    },
    item.state,
  );
  return {
    name: item.context ?? null,
    status,
    url: item.targetUrl ?? null,
    source: { type: item.__typename ?? null, state: item.state ?? null },
  };
}
function githubChecks(repo: string, head: string): Data {
  const [owner, name] = repoParts(repo),
    items: Data[] = [];
  let cursor: string | null = null;
  while (true) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${CHECKS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${name}`,
      "-f",
      `head=${head}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const commit = ghJSON(args).data.repository.object,
      rollup = commit?.statusCheckRollup;
    if (!pythonTruthy(commit) || commit.oid !== head || !pythonTruthy(rollup))
      return { status: "unknown", items, reason: "対象 commit の検査結果がありません" };
    const connection = rollup.contexts;
    items.push(...(connection.nodes || []).map(githubCheck));
    if (!connection.pageInfo.hasNextPage)
      return { status: combined(items.map((item) => item.status)), items };
    cursor = connection.pageInfo.endCursor;
  }
}
function coderabbitChecks(repo: string, pr: string, head: string): Data {
  const result: Data = {
    status: "unknown",
    reviewed_head: null,
    evaluated_head: null,
    head_evidence: [],
    items: [],
  };
  const [owner, name] = repoParts(repo),
    comments: Data[] = [];
  let cursor: string | null = null;
  while (true) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${QUALITY_COMMENTS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${name}`,
      "-F",
      `number=${pr}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const pull = ghJSON(args).data.repository.pullRequest;
    if (!pull || pull.headRefOid !== head)
      return { ...result, reason: "取得中に PR の HEAD が変わりました" };
    for (const comment of pull.comments.nodes || [])
      if (
        ["coderabbitai", "coderabbitai[bot]"].includes(commentLogin(comment)) &&
        (comment.body || "").includes("<!-- pre_merge_checks_walkthrough_start -->")
      )
        comments.push(comment);
    if (!pull.comments.pageInfo.hasNextPage) break;
    cursor = pull.comments.pageInfo.endCursor;
  }
  if (!comments.length)
    return { ...result, reason: "CodeRabbit の pre-merge サマリーがありません" };
  const comment = comments.reduce((previous, current) =>
      (current.updatedAt || "") > (previous.updatedAt || "") ? current : previous,
    ),
    body = comment.body || "";
  const evidence: Data[] = Array.from(
    body.matchAll(
      /(?<![^\n])Reviewing files that changed from the base of the PR and between [0-9a-f]{40} and ([0-9a-f]{40})\.(?=\n|(?![\s\S]))/g,
    ),
    (m: any) => ({ source: "review_range", head: m[1] }),
  );
  evidence.push(
    ...Array.from(
      body.matchAll(
        /(?<![^\n])<!-- change_assessment_commit:"([0-9a-f]{40})" -->(?=\n|(?![\s\S]))/g,
      ),
      (m: any) => ({ source: "change_assessment_commit", head: m[1] }),
    ),
  );
  const heads = new Set(evidence.map((item) => item.head)),
    reviewedHead = heads.size === 1 ? [...heads][0] : null;
  Object.assign(result, {
    url: comment.url ?? null,
    reviewed_head: reviewedHead,
    head_evidence: evidence,
  });
  if (reviewedHead !== head)
    return { ...result, reason: "CodeRabbit の判定対象 HEAD を確認できません" };
  const blocks = Array.from(
    body.matchAll(
      new RegExp(
        `(?<![^\\n])<!-- pre_merge_checks_walkthrough_start -->${SPACE}*\\n(.*?)(?<![^\\n])<!-- pre_merge_checks_walkthrough_end -->${SPACE}*(?=\\n|(?![\\s\\S]))`,
        "gs",
      ),
    ),
    (m: any) => m[1],
  );
  if (blocks.length !== 1)
    return { ...result, reason: "CodeRabbit のサマリー形式を確認できません" };
  let inTable = false;
  for (const line of blocks[0].split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)) {
    const row = strip(line);
    if (
      !row ||
      (!row.includes("|") && /^<\/?(?:details|summary|dl|dd)(?![\p{L}\p{N}_])/u.test(row))
    ) {
      inTable = false;
      continue;
    }
    if (!inTable && !row.includes("|")) continue;
    inTable = true;
    const cells = row.replace(/^\|/, "").replace(/\|$/, "").split("|"),
      name = strip(cells[0]!),
      cell = cells.length > 1 ? strip(cells[1]!) : "";
    if (
      (name.toLowerCase() === "check name" && cell.toLowerCase() === "status") ||
      (/^[-: ]+$/.test(name) && /^[-: ]+$/.test(cell))
    )
      continue;
    const badge = name ? /^!\[([^\]]+)\]\([^)]+\)$/.exec(cell) : null;
    const status = knownStatus(
      {
        passed: "passed",
        warning: "failed",
        failed: "failed",
        error: "failed",
        pending: "pending",
        running: "pending",
      },
      badge?.[1]?.toLowerCase() ?? "",
    );
    result.items.push({ name, status });
  }
  const countPattern = new RegExp(
    `<img(?![\\p{L}\\p{N}_])[^>]*(?<![\\p{L}\\p{N}_])alt=["'](Passed|Failed)["'][^>]*>.*?</picture>${SPACE}*</sup>${SPACE}*(${digitClass}+)`,
    "gsu",
  );
  const counts = Array.from(
    blocks[0].split("</summary>", 1)[0].matchAll(countPattern),
    (m: any) => ({ kind: m[1], count: decimal(m[2]) }),
  );
  if (
    counts.length &&
    (counts.reduce((sum, item) => sum + item.count, 0n) !== BigInt(result.items.length) ||
      counts
        .filter((item) => item.kind === "Failed")
        .reduce((sum, item) => sum + item.count, 0n) !==
        BigInt(result.items.filter((item: Data) => item.status === "failed").length))
  )
    return { ...result, reason: "CodeRabbit の件数と検査項目が一致しません" };
  return { ...result, status: combined(result.items.map((item: Data) => item.status)) };
}
function inspect(repo: string, pr: string, noDiff: boolean, plain: boolean, checks: boolean): void {
  const metadata = parsePeerJSON(
    Buffer.from(
      runGh([
        "pr",
        "view",
        pr,
        "--repo",
        repo,
        "--json",
        "number,url,title,state,headRefOid,headRefName,baseRefName",
      ]),
    ),
  );
  const diff = noDiff ? "" : runGh(["pr", "diff", pr, "--repo", repo, "--patch"]),
    threads = fetchThreads(repo, pr);
  for (const thread of threads) {
    const comments = fetchThread(thread.id).comments;
    if (plain) for (const comment of comments) comment.body = plainBody(comment.body || "");
    thread.comments = { nodes: comments };
  }
  const output: Data = {
    pull_request: metadata,
    ...(noDiff ? {} : { diff }),
    review_threads: threads,
  };
  if (checks) {
    const head = metadata.headRefOid,
      github = githubChecks(repo, head),
      coderabbit = coderabbitChecks(repo, pr, head);
    output.checks = {
      head,
      observed_at: new Date().toISOString(),
      status: combined([github.status, coderabbit.status]),
      github,
      coderabbit,
    };
  }
  console.log(json(output));
}
function verifyCommit(repo: string, pr: string, commit: string): void {
  if (!/^[0-9a-fA-F]{40}$/.test(commit)) fail("--commit must be a full 40-character SHA", 2);
  const [owner, name] = repoParts(repo);
  let cursor: string | null = null;
  while (true) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${COMMITS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${name}`,
      "-F",
      `number=${pr}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const pull = ghJSON(args).data.repository.pullRequest;
    if (pull === null) fail(`pull request ${repo}#${pr} was not found`);
    const connection = pull.commits;
    if (connection.nodes.some((node: Data) => fold(node.commit.oid) === fold(commit))) return;
    if (!connection.pageInfo.hasNextPage)
      fail(`commit ${commit} is not published in ${repo}#${pr}`);
    cursor = connection.pageInfo.endCursor;
  }
}
function validateReply(body: string, commit?: string): void {
  const prefix =
    commit !== undefined ? `対応しました（${commit.slice(0, 7)}）。` : "確認しました。";
  const marker = commit !== undefined ? "\n\n確認:" : "\n\n根拠:";
  const type = commit !== undefined ? "fix" : "explanation-only";
  const format =
    commit !== undefined
      ? `${prefix}<summary>\\n\\n確認: <verification>`
      : "確認しました。<answer>\\n\\n根拠: <evidence>";
  if (!body.startsWith(prefix) || !body.includes(marker))
    fail(`${type} replies must use '${format}'`, 2);
  const at = body.indexOf(marker, prefix.length);
  if (!strip(body.slice(prefix.length, at)) || !strip(body.slice(at + marker.length)))
    fail(
      `${type} replies must include a non-empty ${commit !== undefined ? "summary and verification" : "answer and evidence"}`,
      2,
    );
}
function replyResolve(
  repo: string,
  pr: string,
  threadId: string,
  file: string,
  commit?: string,
): void {
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(readFileSync(file))
      .replace(/\r\n?/g, "\n");
  } catch (error) {
    fail(
      `cannot read --body-file: ${(error as Error).message}`,
      (error as NodeJS.ErrnoException).code ? 2 : 1,
    );
  }
  if (!strip(body)) fail("--body-file must not be empty", 2);
  validateReply(body, commit);
  const thread = fetchThread(threadId),
    pull = thread.pullRequest,
    actualRepo = pull.repository.nameWithOwner,
    actualPr = pull.number;
  if (fold(actualRepo) !== fold(repo) || !equalPeerJSON(actualPr, BigInt(pr)))
    fail(`review thread belongs to ${actualRepo}#${actualPr}, not ${repo}#${pr}`);
  if (commit !== undefined) verifyCommit(repo, pr, commit);
  const normalize = (text: string) => text.replace(/[\r\n]+$/, "");
  const comments: Data[] = thread.comments,
    normalized = normalize(body);
  const index = comments.findLastIndex(
    (comment) =>
      commentLogin(comment) === thread.viewer && normalize(comment.body || "") === normalized,
  );
  const duplicate =
    index >= 0 &&
    comments.slice(index + 1).every((comment) => commentLogin(comment) === thread.viewer);
  if (!duplicate)
    ghJSON([
      "api",
      "graphql",
      "-f",
      `query=${REPLY_MUTATION}`,
      "-f",
      `threadId=${threadId}`,
      "-f",
      `body=${body}`,
    ]);
  ghJSON(["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-f", `threadId=${threadId}`]);
  console.log(
    json(
      { thread_id: threadId, reply: duplicate ? "skipped" : "created", resolve: "resolved" },
      true,
    ),
  );
}
function argumentsForCLI(): Data {
  const [command, ...argv] = process.argv.slice(2);
  let mode = command ?? "";
  const argumentError = (message: string): never => {
    process.stderr.write(USAGE[mode] ?? USAGE[""]!);
    process.stderr.write(`gh-review-thread${mode ? " " + mode : ""}: error: ${message}\n`);
    process.exit(2);
  };
  if (mode === "-h" || (mode.length > 2 && "--help".startsWith(mode))) {
    process.stdout.write(HELP[""]!);
    process.exit(0);
  }
  if (!mode) argumentError("the following arguments are required: command");
  if (!["inspect", "reply-resolve"].includes(mode)) {
    const invalid = mode;
    mode = "";
    argumentError(
      `argument command: invalid choice: '${invalid}' (choose from 'inspect', 'reply-resolve')`,
    );
  }
  const stringOptions = [
    "--repo",
    "--pr",
    ...(mode === "reply-resolve" ? ["--thread-id", "--commit", "--body-file"] : []),
  ];
  const booleans =
    mode === "inspect" ? ["--no-diff", "--plain", "--checks"] : ["--explanation-only"];
  const values: Data = { command: mode };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (argument === "-h" || argument === "--help") {
      process.stdout.write(HELP[mode]!);
      process.exit(0);
    }
    const [key, ...tail] = argument.split("="),
      matches = ["--help", ...stringOptions, ...booleans].filter((name) => name.startsWith(key!));
    if (matches.length !== 1) argumentError(`unrecognized arguments: ${argv.slice(i).join(" ")}`);
    const option = matches[0]!;
    if (booleans.includes(option) || option === "--help") {
      if (tail.length)
        argumentError(`argument ${option}: ignored explicit argument '${tail.join("=")}'`);
      if (option === "--help") {
        process.stdout.write(HELP[mode]!);
        process.exit(0);
      }
      values[option] = true;
      continue;
    }
    const value = tail.length ? tail.join("=") : argv[++i];
    const negativeNumber = new RegExp(`^-(?:${digitClass}+|${digitClass}*\\.${digitClass}+)$`, "u");
    if (
      value === undefined ||
      (!tail.length && value.startsWith("-") && !negativeNumber.test(value))
    )
      argumentError(`argument ${option}: expected one argument`);
    values[option] = value;
  }
  const missing = [
    "--repo",
    "--pr",
    ...(mode === "reply-resolve" ? ["--thread-id", "--body-file"] : []),
  ].filter((name) => values[name] === undefined);
  if (missing.length) argumentError(`the following arguments are required: ${missing.join(", ")}`);
  if (mode === "reply-resolve") {
    if (values["--commit"] !== undefined && values["--explanation-only"])
      argumentError("argument --explanation-only: not allowed with argument --commit");
    if (values["--commit"] === undefined && !values["--explanation-only"])
      argumentError("one of the arguments --commit --explanation-only is required");
  }
  const raw = strip(values["--pr"]),
    sign = raw.startsWith("-") ? -1n : 1n,
    digits = raw.replace(/^[+-]/, "");
  const integerPattern = new RegExp("^" + digitClass + "+(?:_" + digitClass + "+)*$", "u");
  if (!integerPattern.test(digits))
    argumentError(`argument --pr: invalid int value: '${values["--pr"]}'`);
  if (Array.from(digits.replaceAll("_", "")).length > 4300)
    argumentError(`argument --pr: invalid int value: '${values["--pr"]}'`);
  values.pr = sign * decimal(digits.replaceAll("_", ""));
  return values;
}
function main(): void {
  const args = argumentsForCLI();
  if (args.pr < 1n) fail("--pr must be a positive integer", 2);
  repoParts(args["--repo"]);
  runGh(["auth", "status"]);
  if (args.command === "inspect")
    inspect(
      args["--repo"],
      String(args.pr),
      !!args["--no-diff"],
      !!args["--plain"],
      !!args["--checks"],
    );
  else
    replyResolve(
      args["--repo"],
      String(args.pr),
      args["--thread-id"],
      args["--body-file"],
      args["--commit"],
    );
}
try {
  main();
} catch (error) {
  if (error instanceof Failure) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = error.status;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
