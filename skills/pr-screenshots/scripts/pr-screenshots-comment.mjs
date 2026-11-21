#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

import { commentEvidence } from "./comment-evidence.mjs";

const exec = promisify(execFile);
const github = async (args) => {
  const result = await exec(process.env.PR_SCREENSHOTS_GH || "gh", args, {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 90_000,
  });
  return result.stdout.trim();
};

// Keep resolving the receipt directory the same way as the previous comment CLI.
const directory = path.resolve(
  process.env.BROWSER_OWNERSHIP_DIR ||
    path.join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || "/tmp", "browser-ownership"),
  "attachments",
);

try {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      image: { multiple: true, type: "string" },
      "body-file": { type: "string" },
      "request-id": { type: "string" },
    },
  });
  if (
    !/^[\w.-]+\/[\w.-]+$/u.test(values.repo || "") ||
    !/^[1-9][0-9]*$/u.test(values.pr || "") ||
    !values.image?.length ||
    !values["body-file"] ||
    values["body-file"] === "-" ||
    !values["request-id"]
  ) {
    throw new Error(
      "Usage: pr-screenshots-comment.mjs --repo OWNER/REPO --pr NUMBER --image PATH [--image PATH] --body-file MARKDOWN --request-id ID",
    );
  }
  const result = await commentEvidence({
    bodyFile: values["body-file"],
    directory,
    github,
    images: values.image,
    pr: values.pr,
    repo: values.repo,
    requestId: values["request-id"],
  });
  console.log(JSON.stringify(result));
  if (result.state !== "complete") {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`pr-screenshots-comment: ${error.message}`);
  process.exitCode = 1;
}
