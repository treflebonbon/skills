import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");

const withRequestLock = async (filename, action) => {
  await fs.mkdir(path.dirname(filename), { mode: 0o700, recursive: true });
  const guard = spawn(
    process.env.PR_SCREENSHOTS_FLOCK || "flock",
    [
      "--exclusive",
      "--wait",
      "30",
      filename,
      "/bin/sh",
      "-c",
      "printf 'locked\\n'; exec cat >/dev/null",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const started = new Promise((resolve, reject) => {
    guard.once("spawn", resolve);
    guard.once("error", (error) => {
      reject(
        new Error(
          error.code === "ENOENT"
            ? "dependency-missing: install util-linux so flock is available to serialize attachment requests."
            : "lock-start-failed: could not start flock.",
          { cause: error },
        ),
      );
    });
  });
  let detail = "";
  guard.stderr.on("data", (chunk) => {
    detail += chunk;
  });
  guard.stdin.on("error", () => {
    /* empty */
  });
  const ended = new Promise((resolve) => guard.once("close", resolve));
  try {
    await started;
    await Promise.race([
      once(guard.stdout, "data"),
      ended.then(() => {
        throw new Error(`resource-busy: ${detail}`);
      }),
    ]);
    return await action();
  } finally {
    guard.stdin.end();
    await ended;
  }
};

export const commentEvidence = async ({
  repo,
  pr,
  images,
  bodyFile,
  requestId,
  directory,
  github,
}) => {
  const inputBodyFile = path.resolve(bodyFile);
  const imagePaths = images.map((image) => path.resolve(image));
  const describeInputs = (receipt) =>
    "body: " + inputBodyFile + "; images: " + imagePaths.join(", ") + "; receipt: " + receipt;
  if (
    !images.length ||
    images.length > 50 ||
    new Set(imagePaths).size !== imagePaths.length ||
    imagePaths.some((image) => /[#\r\n]/u.test(image))
  ) {
    throw new Error(
      "comment-invalid: attach 1-50 unique image paths without # or newlines; " +
        describeInputs(path.join(directory, "comment-pending.json")),
    );
  }
  const sourceBody = await fs.readFile(inputBodyFile, "utf-8");
  const buffers = await Promise.all(imagePaths.map((image) => fs.readFile(image)));
  if (
    !sourceBody.trim() ||
    sourceBody.includes("<!-- pr-screenshots:") ||
    !sourceBody.replace(/!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/gu, "").trim()
  ) {
    throw new Error(
      "comment-invalid: include a short explanation and unmarked Markdown image references; " +
        describeInputs(path.join(directory, "comment-pending.json")),
    );
  }
  const external = (destination) => /^(?:https?:|data:|\/\/)/iu.test(destination);
  const unwrap = (destination) =>
    destination.startsWith("<") && destination.endsWith(">")
      ? destination.slice(1, -1)
      : destination;
  const references = [];
  const imageCounts = imagePaths.map(() => 0);
  const matches = [...sourceBody.matchAll(/!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/gu)];
  let normalizedBody = sourceBody;
  const replacements = [];
  for (const match of matches) {
    const destination = match[2];
    const localPath = unwrap(destination);
    if (external(localPath)) {
      references.push({
        alt: match[1],
        destination,
        imageIndex: -1,
      });
      continue;
    }
    const resolved = path.resolve(path.dirname(inputBodyFile), localPath);
    const imageIndex = imagePaths.indexOf(resolved);
    if (imageIndex < 0 || imageCounts[imageIndex]) {
      throw new Error(
        "comment-invalid: each local Markdown image must match one --image path exactly once; " +
          describeInputs(path.join(directory, "comment-pending.json")),
      );
    }
    imageCounts[imageIndex] += 1;
    const markdownPath = /[\s()<>]/u.test(resolved) ? "<" + resolved + ">" : resolved;
    references.push({
      alt: match[1],
      destination: markdownPath,
      imageIndex,
    });
    replacements.push({
      start: match.index,
      end: match.index + match[0].length,
      text: "![" + match[1] + "](" + markdownPath + ")",
    });
  }
  if (imageCounts.some((count) => count !== 1)) {
    throw new Error(
      "comment-invalid: each --image needs exactly one ordinary Markdown image reference; " +
        describeInputs(path.join(directory, "comment-pending.json")),
    );
  }
  for (const replacement of replacements.reverse()) {
    normalizedBody =
      normalizedBody.slice(0, replacement.start) +
      replacement.text +
      normalizedBody.slice(replacement.end);
  }
  const signature = digest(
    JSON.stringify([
      repo.toLowerCase(),
      Number(pr),
      inputBodyFile,
      sourceBody,
      ...imagePaths.map((image, index) => [image, digest(buffers[index])]),
    ]),
  );
  const key = digest("comment:" + requestId);
  const prefix = "<!-- pr-screenshots:" + key + ":";
  const marker = prefix + signature + " -->";
  const filename = path.join(directory, "comment-" + key + ".json");
  const context = describeInputs(filename);
  const isTransientNetworkFailure = (error) =>
    /timeout|timed out|connection|network|socket|ECONN|EAI_AGAIN|ENOTFOUND|reset|gateway|HTTP 5[0-9]{2}/iu.test(
      String(error?.message || ""),
    );
  const safeReason = (error) => {
    const message = String(error?.message || "");
    if (/^(?:target-conflict|dependency-missing):/u.test(message)) return message;
    if (error?.code === "ENOENT") return "GitHub CLI gh or an input file was not found.";
    if (/401|authentication|not logged in/iu.test(message)) {
      return "GitHub CLI authentication is required.";
    }
    if (/403|permission|write access/iu.test(message)) {
      return "GitHub repository read or write permission is missing.";
    }
    if (/404|not found/iu.test(message)) {
      return "The target repository or pull request was not found or is inaccessible.";
    }
    if (isTransientNetworkFailure(error)) {
      return "The GitHub CLI request did not complete.";
    }
    if (typeof error?.code === "number") {
      return "GitHub CLI exited with status " + error.code + ".";
    }
    return "GitHub CLI request failed.";
  };
  const outputUrl = (output) =>
    String(output || "").match(/https?:\/\/[^\s]+\/pull\/[0-9]+#issuecomment-[0-9]+/u)?.[0];
  const definitelyNotPosted = (error) =>
    error?.code === "ENOENT" ||
    (typeof error?.code === "number" &&
      !error.signal &&
      /(?:^|\r?\n)no comment was posted\s*$/u.test(String(error.stderr || "")));
  const result = (state, target, comment, assets, missing, reason, reused) => ({
    state,
    repository: repo,
    pr: Number(pr),
    pullRequest: target?.html_url || null,
    comment: comment || null,
    assets,
    images: imagePaths,
    bodyFile: inputBodyFile,
    missing,
    reason: reason || null,
    requestId,
    reused,
  });
  const classifyComment = (target, comment, reused) => {
    const body = comment.body || "";
    const markerAt = body.lastIndexOf(marker);
    if (markerAt < 0) {
      throw new Error(
        "request-conflict: matching comment does not contain the exact request marker; " + context,
      );
    }
    const postedContent = body.slice(0, markerAt).trimEnd();
    const postedReferences = [
      ...postedContent.matchAll(/!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/gu),
    ];
    const assets = imagePaths.map(() => null);
    const missing = [];
    let explanationMatches = markerAt + marker.length === body.trimEnd().length;
    for (let index = 0; index < references.length; index += 1) {
      const expected = references[index];
      const posted = postedReferences[index];
      if (!posted || posted[1] !== expected.alt) {
        if (expected.imageIndex >= 0) {
          missing.push(imagePaths[expected.imageIndex]);
        }
        explanationMatches = false;
        continue;
      }
      const postedDestination = unwrap(posted[2]);
      if (expected.imageIndex >= 0) {
        if (
          /^https:\/\/github\.com\/user-attachments\/assets\/[A-Za-z0-9-]+$/u.test(
            postedDestination,
          )
        ) {
          assets[expected.imageIndex] = postedDestination;
        } else {
          missing.push(imagePaths[expected.imageIndex]);
        }
      } else if (posted[2] !== expected.destination) {
        explanationMatches = false;
      }
    }
    const assetCounts = new Map();
    for (const asset of assets) {
      if (asset) assetCounts.set(asset, (assetCounts.get(asset) || 0) + 1);
    }
    let duplicateAssets = false;
    for (let index = 0; index < assets.length; index += 1) {
      if (assetCounts.get(assets[index]) > 1) {
        duplicateAssets = true;
        assets[index] = null;
        missing.push(imagePaths[index]);
      }
    }
    const canonical = (text) => {
      let referenceIndex = 0;
      return text.replace(/!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/gu, (full, alt) => {
        const requested = references[referenceIndex++]?.imageIndex >= 0;
        return requested ? "![" + alt + "](__attached_image__)" : full;
      });
    };
    explanationMatches =
      explanationMatches && canonical(normalizedBody.trimEnd()) === canonical(postedContent);
    const uniqueMissing = [...new Set(missing)];
    const uploaded = assets.filter(Boolean).length;
    const state =
      !uniqueMissing.length && explanationMatches ? "complete" : uploaded ? "partial" : "failed";
    const reason =
      state === "complete"
        ? null
        : duplicateAssets
          ? "The same attachment URL was used for multiple requested images."
          : explanationMatches
            ? uploaded
              ? "Some requested images were not attached."
              : "The comment was found, but no requested image was attached."
            : "The saved explanation or image placement could not be fully verified.";
    return result(state, target, comment.html_url, assets, uniqueMissing, reason, reused);
  };
  const receiptPhase = { complete: "complete", partial: "partial", failed: "failed-posted" };
  return withRequestLock(path.join(directory, "comment-" + key + ".lock"), async () => {
    const previous = await fs
      .readFile(filename, "utf-8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
    if (previous && previous.signature !== signature) {
      throw new Error(
        "request-conflict: request-id was already used with different content; " + context,
      );
    }
    const receipt = previous || {
      signature,
      repository: repo,
      pr: Number(pr),
      requestId,
      bodyFile: inputBodyFile,
      images: imagePaths,
      assets: imagePaths.map(() => null),
      missing: imagePaths,
      phase: "ready",
      reason: null,
    };
    const save = async () => {
      const temporary = filename + "." + process.pid + ".tmp";
      await fs.writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 });
      await fs.rename(temporary, filename);
    };
    const mayHavePosted = [
      "posting",
      "query-failed",
      "post-unconfirmed",
      "complete",
      "partial",
      "failed-posted",
    ].includes(receipt.phase);
    await save();
    let target;
    const query = async () => {
      target = JSON.parse(await github(["api", "repos/" + repo + "/pulls/" + pr]));
      if (
        String(target.number) !== String(pr) ||
        target.base?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()
      ) {
        throw new Error("target-conflict: resolved pull request does not match repo/pr");
      }
      const login = await github(["api", "user", "--jq", ".login"]);
      const matchesOutput = await github([
        "api",
        "--paginate",
        "repos/" + repo + "/issues/" + pr + "/comments?per_page=100",
        "--jq",
        ".[] | select(.user.login == " +
          JSON.stringify(login) +
          ' and ((.body // "") | contains(' +
          JSON.stringify(prefix) +
          "))) | {body, html_url} | tojson",
      ]);
      const matches = String(matchesOutput || "")
        .split(/\r?\n/u)
        .filter(Boolean)
        .map(JSON.parse);
      if (matches.length > 1) {
        throw new Error("request-conflict: multiple comments use this request id");
      }
      const existing = matches[0];
      if (existing && !existing.body?.includes(marker)) {
        throw new Error("request-conflict: request-id was already used with different content");
      }
      return existing;
    };
    let existing;
    try {
      existing = await query();
      if (!existing && !mayHavePosted) {
        const help = await github(["pr", "comment", "--help"]);
        if (!/--attach\b/u.test(help)) {
          throw new Error(
            "dependency-missing: install GitHub CLI with gh pr comment --attach support (verified with 2.102.0)",
          );
        }
      }
    } catch (error) {
      if (mayHavePosted) {
        receipt.phase = "query-failed";
        receipt.reason = safeReason(error);
        receipt.missing = imagePaths;
        await save();
        return result(
          "unknown",
          target,
          receipt.comment,
          receipt.assets,
          imagePaths,
          "Previous posting may have completed; comment lookup failed. " + receipt.reason,
          false,
        );
      }
      receipt.phase = "preflight-failed";
      receipt.reason = safeReason(error);
      await save();
      throw new Error("preflight-failed: " + receipt.reason + "; " + context);
    }
    if (existing) {
      const classified = classifyComment(target, existing, true);
      receipt.phase = receiptPhase[classified.state];
      receipt.comment = existing.html_url;
      receipt.assets = classified.assets;
      receipt.missing = classified.missing;
      receipt.reason = classified.reason;
      await save();
      return classified;
    }
    if (mayHavePosted) {
      receipt.phase = "post-unconfirmed";
      receipt.reason = "A previous posting attempt has no matching visible comment.";
      receipt.missing = imagePaths;
      await save();
      return result(
        "unknown",
        target,
        receipt.comment,
        receipt.assets,
        imagePaths,
        receipt.reason,
        false,
      );
    }
    const snapshotDirectory = await fs.mkdtemp(path.join(directory, "comment-images-"));
    const snapshotImages = imagePaths.map((image, index) =>
      path.join(snapshotDirectory, index + path.extname(image)),
    );
    const temporaryBody = path.join(snapshotDirectory, "body.md");
    let sentOutput = "";
    let sendError;
    try {
      await Promise.all(
        snapshotImages.map((image, index) =>
          fs.writeFile(image, buffers[index], { flag: "wx", mode: 0o600 }),
        ),
      );
      let referenceIndex = 0;
      const uploadBody = normalizedBody.replace(
        /!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/gu,
        (full, alt) => {
          const imageIndex = references[referenceIndex++].imageIndex;
          if (imageIndex < 0) return full;
          const image = snapshotImages[imageIndex];
          const destination = /[\s()<>]/u.test(image) ? "<" + image + ">" : image;
          return "![" + alt + "](" + destination + ")";
        },
      );
      await fs.writeFile(temporaryBody, uploadBody.trimEnd() + "\n\n" + marker + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      receipt.phase = "posting";
      receipt.reason = null;
      await save();
      try {
        sentOutput = await github([
          "pr",
          "comment",
          String(pr),
          "--repo",
          repo,
          "--body-file",
          temporaryBody,
          ...snapshotImages.flatMap((image) => ["--attach", image]),
        ]);
      } catch (error) {
        sendError = error;
        sentOutput = error.stdout || "";
      }
    } finally {
      await fs.rm(snapshotDirectory, { recursive: true, force: true });
    }
    const sentUrl = outputUrl(sentOutput);
    let posted;
    try {
      posted = await query();
    } catch (error) {
      receipt.phase = "query-failed";
      receipt.comment = sentUrl || null;
      receipt.postOutputUrl = sentUrl || null;
      receipt.reason = safeReason(error);
      receipt.missing = imagePaths;
      await save();
      return result(
        "unknown",
        target,
        sentUrl,
        receipt.assets,
        imagePaths,
        "The post result could not be looked up. " + receipt.reason,
        false,
      );
    }
    if (posted) {
      const classified = classifyComment(target, posted, false);
      receipt.phase = receiptPhase[classified.state];
      receipt.comment = posted.html_url;
      receipt.assets = classified.assets;
      receipt.missing = classified.missing;
      receipt.reason = classified.reason;
      receipt.postOutputUrl = sentUrl || null;
      await save();
      return classified;
    }
    if (sendError && !sentUrl && definitelyNotPosted(sendError)) {
      receipt.phase = "failed";
      receipt.comment = null;
      receipt.postOutputUrl = null;
      receipt.assets = imagePaths.map(() => null);
      receipt.missing = imagePaths;
      receipt.reason = safeReason(sendError);
      await save();
      return result(
        "failed",
        target,
        null,
        receipt.assets,
        imagePaths,
        receipt.reason + " No matching comment was found after the attempt.",
        false,
      );
    }
    receipt.phase = "post-unconfirmed";
    receipt.comment = sentUrl || null;
    receipt.postOutputUrl = sentUrl || null;
    receipt.missing = imagePaths;
    receipt.reason = safeReason(sendError || new Error("comment not found"));
    await save();
    return result(
      "unknown",
      target,
      sentUrl,
      receipt.assets,
      imagePaths,
      "No matching comment could be confirmed. " + receipt.reason,
      false,
    );
  });
};
