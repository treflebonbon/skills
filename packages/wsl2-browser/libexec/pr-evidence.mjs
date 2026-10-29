import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");

export const withBrowserLock = async (filename, action, shared = false) => {
  await fs.mkdir(path.dirname(filename), { mode: 0o700, recursive: true });
  const guard = spawn(
    process.env.MANAGED_CHROME_FLOCK || "flock",
    [
      shared ? "--shared" : "--exclusive",
      "--wait",
      "30",
      filename,
      process.execPath,
      "-e",
      "process.stdout.write('locked\\n');process.stdin.resume()",
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let detail = "";
  guard.stderr.on("data", (chunk) => {
    detail += chunk;
  });
  guard.stdin.on("error", () => {
    /* empty */
  });
  const ended = once(guard, "close");
  try {
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

export const publishEvidence = ({
  repo,
  pr,
  placeholder,
  asset,
  directory,
  github,
}) => {
  const key = digest(`${repo.toLowerCase()}#${pr}`);
  return withBrowserLock(path.join(directory, `pr-${key}.lock`), async () => {
    const current = JSON.parse(
      await github(["pr", "view", String(pr), "--repo", repo, "--json", "body"])
    ).body;
    if (
      !current.includes(placeholder) &&
      current.includes(`![Evidence](${asset})`)
    ) {
      return;
    }
    if (!placeholder || current.split(placeholder).length !== 2) {
      throw new Error(
        "body-conflict: expected exactly one placeholder in the fresh PR body"
      );
    }
    const updated = current.replace(placeholder, `![Evidence](${asset})`);
    const filename = path.join(directory, `body-${randomUUID()}.md`);
    await fs.writeFile(filename, updated, { flag: "wx", mode: 0o600 });
    try {
      await github([
        "pr",
        "edit",
        String(pr),
        "--repo",
        repo,
        "--body-file",
        filename,
      ]);
      const verified = JSON.parse(
        await github([
          "pr",
          "view",
          String(pr),
          "--repo",
          repo,
          "--json",
          "body",
        ])
      ).body;
      if (!verified.includes(asset)) {
        throw new Error("body-conflict: published image missing after update");
      }
    } finally {
      await fs.unlink(filename);
    }
  });
};

export const uploadEvidence = async (
  context,
  { repo, pr, image, comment = false }
) => {
  const page = await context.newPage();
  let sent = false;
  try {
    await page.goto(`https://github.com/${repo}/pull/${pr}`, {
      timeout: 30_000,
    });
    if (new URL(page.url()).pathname.startsWith("/login")) {
      throw new Error("authentication-required");
    }
    let body;
    let textarea;
    if (comment) {
      textarea = page.locator("#new_comment_field");
      if (
        !(await textarea.count()) &&
        (await page.locator('a[href^="/login"]').count())
      ) {
        throw new Error("authentication-required");
      }
      body = textarea.locator("xpath=ancestor::form[1]");
    } else {
      body = page.locator(".js-comment-container").first();
      await body.locator("summary.timeline-comment-action").click();
      await body.getByText("Edit", { exact: true }).click();
      textarea = body.locator('textarea[name="pull_request[body]"]');
    }
    await textarea.waitFor({ state: "visible" });
    const pattern =
      /https:\/\/github\.com\/user-attachments\/assets\/[a-zA-Z0-9-]+/gu;
    const initialBody = await textarea.inputValue();
    const before = new Set(initialBody.match(pattern) || []);
    const input = body.locator("input[type=file]");
    await input.waitFor({ state: "attached", timeout: 30_000 });
    const started = Date.now();
    sent = true;
    await input.setInputFiles(image);
    let asset;
    while (Date.now() - started < 60_000) {
      // eslint-disable-next-line no-await-in-loop -- Poll this owned editor until GitHub inserts its asset.
      const text = await textarea.inputValue();
      asset = (text.match(pattern) || []).find((url) => !before.has(url));
      if (asset) {
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- Bound polling cadence.
      await delay(100);
    }
    if (!asset) {
      throw new Error("upload timeout");
    }
    return { asset, finished: Date.now(), started };
  } catch (error) {
    let message =
      "upload-failed: verify PR edit access and connectivity; other requests were preserved";
    if (error.message === "authentication-required") {
      message =
        "authentication-required: complete dedicated browser setup before requesting an upload";
    } else if (comment && !sent) {
      message =
        "upload-not-started: comment form was unavailable; no image was sent";
    }
    throw new Error(message, { cause: error });
  } finally {
    await page.close();
  }
};

export const commentEvidence = async ({
  repo,
  pr,
  images,
  body,
  requestId,
  directory,
  github,
  upload,
}) => {
  const buffers = await Promise.all(images.map((image) => fs.readFile(image)));
  if (
    !images.length ||
    (body.match(/<!-- screenshot-\d+ -->/gu) || []).length !== images.length ||
    body.includes("<!-- pr-screenshots:")
  ) {
    throw new Error(
      "comment-invalid: use one screenshot-N placeholder per image"
    );
  }
  for (let n = 0; n < images.length; n += 1) {
    if (body.split(`<!-- screenshot-${n + 1} -->`).length !== 2) {
      throw new Error(
        "comment-invalid: each image needs exactly one screenshot-N placeholder"
      );
    }
  }
  const key = digest(`${repo.toLowerCase()}#${pr}:${requestId}`);
  const signature = digest(JSON.stringify([body, ...buffers.map(digest)]));
  const prefix = `<!-- pr-screenshots:${key}:`;
  const marker = `${prefix}${signature} -->`;
  const filename = path.join(directory, `comment-${key}.json`);
  return withBrowserLock(
    path.join(directory, `comment-${key}.lock`),
    async () => {
      const target = JSON.parse(
        await github(["api", `repos/${repo}/pulls/${pr}`])
      );
      if (
        String(target.number) !== String(pr) ||
        target.base.repo.full_name.toLowerCase() !== repo.toLowerCase()
      ) {
        throw new Error(
          "target-conflict: resolved pull request does not match repo/pr"
        );
      }
      const login = await github(["api", "user", "--jq", ".login"]);
      const matches = await github([
        "api",
        "--paginate",
        `repos/${repo}/issues/${pr}/comments?per_page=100`,
        "--jq",
        `.[] | select(.user.login == ${JSON.stringify(login)} and ((.body // "") | contains(${JSON.stringify(prefix)}))) | {body, html_url} | tojson`,
      ]);
      const existing = matches
        ? JSON.parse(matches.split("\n", 1)[0])
        : undefined;
      if (existing) {
        if (!existing.body.includes(marker)) {
          throw new Error(
            "request-conflict: request-id was already used with different content"
          );
        }
        return { comment: existing.html_url, reused: true };
      }
      const receipt = await fs
        .readFile(filename, "utf-8")
        .then(JSON.parse)
        .catch((error) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
          return { assets: [], signature };
        });
      if (receipt.signature !== signature) {
        throw new Error(
          "request-conflict: request-id was already used with different content"
        );
      }
      if (["posting", "published"].includes(receipt.phase)) {
        throw new Error(
          "post-unconfirmed: inspect the previous comment request before posting again"
        );
      }
      const save = async () => {
        const temporary = `${filename}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 });
        await fs.rename(temporary, filename);
      };
      let content = body;
      /* eslint-disable no-await-in-loop -- 外部送信の前後で画像ごとの状態を順番に保存する。 */
      for (let n = 0; n < images.length; n += 1) {
        if (!receipt.assets[n]) {
          if (receipt.phase === "uploading") {
            throw new Error(
              "upload-unconfirmed: inspect the previous image upload before retrying"
            );
          }
          receipt.phase = "uploading";
          await save();
          try {
            const uploaded = await upload(images[n]);
            receipt.assets[n] = uploaded.asset;
          } catch (error) {
            if (
              /^(?:authentication-required|ownership-conflict|cdp-unavailable|resource-busy|upload-not-started):/u.test(
                error.message
              )
            ) {
              receipt.phase = "ready";
              await save();
            }
            throw new Error(
              `${error.message}; image: ${images[n]}; receipt: ${filename}`,
              { cause: error }
            );
          }
          receipt.phase = "ready";
          await save();
        }
        content = content.replace(
          `<!-- screenshot-${n + 1} -->`,
          `![Evidence](${receipt.assets[n]})`
        );
      }
      /* eslint-enable no-await-in-loop */
      const input = path.join(directory, `comment-${randomUUID()}.json`);
      await fs.writeFile(
        input,
        JSON.stringify({ body: `${content}\n\n${marker}` }),
        { flag: "wx", mode: 0o600 }
      );
      try {
        receipt.phase = "posting";
        await save();
        const result = JSON.parse(
          await github([
            "api",
            "--method",
            "POST",
            `repos/${repo}/issues/${pr}/comments`,
            "--input",
            input,
          ])
        );
        if (!result.html_url || !result.body?.includes(marker)) {
          throw new Error(
            "post-unconfirmed: comment response did not confirm the requested marker"
          );
        }
        receipt.phase = "published";
        receipt.comment = result.html_url;
        await save();
        return {
          assets: receipt.assets,
          comment: result.html_url,
          reused: false,
        };
      } finally {
        await fs.unlink(input);
      }
    }
  );
};
