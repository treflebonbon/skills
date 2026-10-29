import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { DogfoodResult } from "./dogfood-result.mjs";
import { acquireManagedDogfoodChrome } from "./managed-dogfood-browser.mjs";

const execFileAsync = promisify(execFile);
const playwrightModule = process.env.DOGFOOD_PLAYWRIGHT_MODULE
  ? pathToFileURL(path.resolve(process.env.DOGFOOD_PLAYWRIGHT_MODULE)).href
  : "playwright";
const { chromium } = await import(playwrightModule);

const parseArgs = (argv) => {
  const out = { annotate: false, headed: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--headed") {
      out.headed = true;
    } else if (a === "--annotate") {
      out.annotate = true;
    } else if (a === "--target") {
      i += 1;
      out.target = argv[i];
    } else if (a === "--extension") {
      i += 1;
      out.extension = argv[i];
    } else if (a === "--output") {
      i += 1;
      out.output = argv[i];
    } else if (a === "--resume") {
      i += 1;
      out.resume = true;
    }
  }
  if (!out.target || !out.output) {
    throw new Error(
      "usage: playwright-dogfood-runner.mjs --target <url> --output <dir> [--extension <dir>] [--headed] [--annotate]"
    );
  }
  if (out.annotate && out.resume) {
    throw new Error("--annotate cannot be combined with --resume");
  }
  if (out.resume) {
    throw new Error(
      "--resume is a skill option; the runner only starts new runs"
    );
  }
  return out;
};

const isExtSw = (w) => w.url().startsWith("chrome-extension://");

const titleFromComment = (comment) => {
  const [firstLine = ""] = comment.split("\n");
  return [...firstLine.trim()].slice(0, 120).join("") || "Visual annotation";
};

const parseAnnotationResponse = (raw, target, responseRel) => {
  const payload = JSON.parse(raw);
  if (payload.isError) {
    throw new TypeError(payload.error ?? "Playwright CLI annotation failed");
  }
  if (payload.result === "No annotations were submitted.") {
    return [];
  }
  if (typeof payload.result !== "string") {
    throw new TypeError(
      "Playwright CLI annotation response has no result text"
    );
  }

  const frames = [];
  const feedback = [];
  let frame;
  let lastAnnotation;
  for (const line of payload.result.split("\n")) {
    if (line.startsWith("## Screenshot ")) {
      lastAnnotation = undefined;
      continue;
    }
    const header = line.match(
      /^.+? \/ .+? @ (?<url>.+) \((?<width>\d+)x(?<height>\d+)\)$/u
    );
    if (header) {
      const { height, url, width } = header.groups;
      frame = {
        annotations: [],
        evidence: [],
        height: Number(height),
        url,
        width: Number(width),
      };
      frames.push(frame);
      lastAnnotation = undefined;
      continue;
    }
    const annotation = line.match(
      /^\s*\{ x: (?<x>[^,]+), y: (?<y>[^,]+), width: (?<width>[^,]+), height: (?<height>[^}]+) \}: (?<comment>.*)$/u
    );
    if (annotation && frame) {
      const { comment, height, width, x, y } = annotation.groups;
      lastAnnotation = {
        comment,
        height,
        width,
        x,
        y,
      };
      frame.annotations.push(lastAnnotation);
      continue;
    }
    const evidence = line.match(
      /^- \[Annotation (?:image|snapshot)(?: \d+)?\]\((?<path>[^)]+)\)$/u
    );
    if (evidence && frame) {
      frame.evidence.push(evidence.groups.path);
      lastAnnotation = undefined;
      continue;
    }
    if (frame && lastAnnotation) {
      lastAnnotation.comment += `\n${line}`;
      continue;
    }
    if (!frame && line) {
      feedback.push(line);
    }
  }

  const findings = [];
  const overallFeedback = feedback.join("\n").trim();
  if (overallFeedback) {
    findings.push({
      actual: `Feedback: ${overallFeedback}`,
      category: "visual",
      evidence: [responseRel],
      severity: "Medium",
      summary: overallFeedback.replaceAll("\n", " "),
      title: titleFromComment(overallFeedback),
      url: target,
    });
  }
  for (const annotatedFrame of frames) {
    for (const annotation of annotatedFrame.annotations) {
      findings.push({
        actual: [
          `Comment: ${annotation.comment}`,
          `Coordinates: x=${annotation.x}, y=${annotation.y}, width=${annotation.width}, height=${annotation.height}`,
          `Viewport: ${annotatedFrame.width}x${annotatedFrame.height}`,
        ].join("\n"),
        category: "visual",
        evidence: [...annotatedFrame.evidence, responseRel],
        severity: "Medium",
        summary: annotation.comment.replaceAll("\n", " "),
        title: titleFromComment(annotation.comment),
        url: annotatedFrame.url,
      });
    }
  }
  return findings;
};

const readDevToolsPort = async (userDataDir, attemptsLeft = 100) => {
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  const contents = await fs.readFile(portFile, "utf-8").catch(() => "");
  const [port] = contents.split("\n");
  if (/^\d+$/u.test(port)) {
    return port;
  }
  if (attemptsLeft === 1) {
    throw new Error("Chromium did not publish DevToolsActivePort");
  }
  await delay(50);
  return readDevToolsPort(userDataDir, attemptsLeft - 1);
};

const runCli = async (cliArgs, cwd, extraEnv = {}) => {
  try {
    return await execFileAsync(
      process.env.DOGFOOD_PLAYWRIGHT_CLI || "playwright-cli",
      cliArgs,
      {
      cwd,
      env: { ...process.env, ...extraEnv },
      maxBuffer: 10 * 1024 * 1024,
      },
    );
  } catch (error) {
    const detail =
      [error.stdout?.trim(), error.stderr?.trim()].filter(Boolean).join("\n") ||
      error.message;
    throw new Error(`playwright-cli ${cliArgs.join(" ")} failed: ${detail}`, {
      cause: error,
    });
  }
};

const collectAnnotations = async ({ cdpEndpoint, result, userDataDir }) => {
  const { attemptDir, target } = result;
  const help = await runCli(["show", "--help"], attemptDir);
  if (!help.stdout.includes("--annotate")) {
    throw new Error("playwright-cli does not support show --annotate");
  }

  const endpoint =
    cdpEndpoint || `http://127.0.0.1:${await readDevToolsPort(userDataDir)}`;
  const session = `dogfood-annotate-${process.pid}-${Date.now()}`;
  try {
    await runCli([`-s=${session}`, "attach", `--cdp=${endpoint}`], attemptDir);
    process.stderr.write(
      "Waiting for visual annotations in Playwright Dashboard...\n"
    );
    const response = await runCli(
      [`-s=${session}`, "show", "--annotate", "--json"],
      attemptDir,
      { PWCLI_EXTERNAL_CDP: "1" }
    );
    const responseRel = "annotations/response.json";
    await result.capture(
      "annotation response",
      async () => {
        await fs.mkdir(path.join(attemptDir, "annotations"), {
          recursive: true,
        });
        await fs.writeFile(path.join(attemptDir, responseRel), response.stdout);
      },
      [responseRel]
    );
    const annotations = parseAnnotationResponse(
      response.stdout,
      target,
      responseRel
    );
    result.findings.push(...annotations);
    const files = new Set(annotations.flatMap((finding) => finding.evidence));
    files.delete(responseRel);
    for (const relative of files) {
      // eslint-disable-next-line no-await-in-loop -- validate each annotation file before publishing its reference
      await result.capture("annotation evidence", () =>
        result.retainFile(relative)
      );
    }
  } finally {
    await runCli([`-s=${session}`, "detach"], attemptDir).catch((error) =>
      result.fail("annotation detach", error)
    );
  }
};

const args = parseArgs(process.argv);
const result = await DogfoodResult.start(args);

const userDataDir = path.join(args.output, ".chromium-profile");
const dogfoodRunId = `dogfood-${createHash("sha256")
  .update(path.resolve(args.output))
  .digest("hex")
  .slice(0, 16)}`;
const launchArgs = [];
if (args.extension) {
  launchArgs.push(
    `--disable-extensions-except=${args.extension}`,
    `--load-extension=${args.extension}`
  );
}
if (args.annotate) {
  launchArgs.push("--remote-debugging-port=0");
}
const evidenceViewport = { height: 1000, width: 1440 };
const contextOptions = {
  recordVideo: {
    dir: path.join(result.attemptDir, "videos"),
    size: { height: 1000, width: 1440 },
  },
  viewport: evidenceViewport,
};
const cdpContextOptions = { viewport: evidenceViewport };
let browser;
let context;
let managedDogfood;
let startupError;
try {
  managedDogfood = await acquireManagedDogfoodChrome({
    extension: args.extension,
    headed: args.headed || args.annotate,
    runId: dogfoodRunId,
  });
  if (managedDogfood) {
    browser = await chromium.connectOverCDP(managedDogfood.endpoint);
    context = args.extension
      ? browser.contexts()[0] || (await browser.newContext(cdpContextOptions))
      : await browser.newContext(cdpContextOptions);
  } else {
    let executablePath;
    const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (browsersPath && browsersPath !== "0") {
      const browserRoot = path.resolve(browsersPath);
      const entries = await fs.readdir(browserRoot);
      const bundles = entries.filter((entry) => /^chromium-\d+$/u.test(entry));
      const layouts = [
        "chrome-linux64/chrome",
        "chrome-linux/chrome",
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      ];
      const candidates = bundles.flatMap((bundle) =>
        layouts.map((layout) => path.join(browserRoot, bundle, layout))
      );
      const resolved = await Promise.all(
        candidates.map(async (candidate) => {
          try {
            // Follow external browser-cache symlinks and require an executable file.
            const stat = await fs.stat(candidate);
            if (!stat.isFile()) {
              return null;
            }
            await fs.access(candidate, fs.constants.X_OK);
            return candidate;
          } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
              throw error;
            }
            return null;
          }
        })
      );
      const executables = resolved.filter((candidate) => candidate !== null);
      if (executables.length !== 1) {
        throw new Error(
          `Expected one Chromium executable in ${browserRoot}; found ${executables.length}`
        );
      }
      [executablePath] = executables;
    }
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      ...contextOptions,
      args: launchArgs,
      channel: "chromium",
      headless: !args.headed,
    });
  }
} catch (error) {
  startupError = error;
}

const { findings } = result;
const screenshotRel = "screenshots/initial.png";
let extensionId;
let swRegistered = !args.extension;
const consoleErrors = [];
const failedRequests = [];
const traceRel = "traces/playwright-trace.zip";
let videoFinalized = false;
if (startupError) {
  result.fail("startup", startupError);
}

if (context) {
  try {
    await result.capture("trace start", () =>
      context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: false,
      })
    );

    if (args.extension) {
      // Resolve the target extension's MV3 service worker. Filter to chrome-extension:// workers so a
      // reused profile or an unrelated worker cannot be mistaken for the extension under test.
      let sw = context.serviceWorkers().find(isExtSw);
      if (!sw) {
        try {
          sw = await context.waitForEvent("serviceworker", {
            predicate: isExtSw,
            timeout: 15_000,
          });
        } catch {
          sw = undefined;
        }
      }
      if (sw) {
        swRegistered = true;
        extensionId = sw.url().split("/").at(2);
      } else {
        extensionId = "(unknown - service worker not registered)";
        findings.push({
          actual: `Loaded extension: ${args.extension}. Observed service workers: ${JSON.stringify(context.serviceWorkers().map((w) => w.url()))}.`,
          category: "functional",
          evidence: [screenshotRel, traceRel],
          severity: "Critical",
          summary:
            "The unpacked MV3 extension loaded but no chrome-extension:// service worker registered within 15s.",
          title: "MV3 service worker did not register",
        });
      }
    }

    const page = context.pages()[0] ?? (await context.newPage());
    if (managedDogfood) {
      await page.setViewportSize(evidenceViewport);
    }
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") {
        consoleErrors.push(m.text());
      }
    });
    page.on("requestfailed", (request) => {
      failedRequests.push({
        error: request.failure()?.errorText ?? "request failed",
        method: request.method(),
        url: request.url(),
      });
    });
    page.on("response", (response) => {
      if (response.status() >= 500) {
        failedRequests.push({
          error: `HTTP ${response.status()}`,
          method: response.request().method(),
          url: response.url(),
        });
      }
    });

    try {
      // 'load' (not 'networkidle') so SPAs with sockets/polling do not hang until the nav timeout.
      await page.goto(args.target, { timeout: 30_000, waitUntil: "load" });
    } catch (error) {
      findings.push({
        actual: String(error),
        category: "functional",
        evidence: [screenshotRel, traceRel],
        severity: "High",
        summary: "The page did not finish loading.",
        title: "Navigation to target failed",
      });
    }
    await result.capture(
      "screenshot",
      () =>
        page.screenshot({
          fullPage: true,
          path: path.join(result.attemptDir, screenshotRel),
          timeout: 5000,
        }),
      [screenshotRel]
    );

    if (consoleErrors.length) {
      findings.push({
        actual: consoleErrors.map((e) => `- ${e}`).join("\n"),
        category: "console",
        evidence: ["console.json", screenshotRel, traceRel],
        severity: "Medium",
        summary: `${consoleErrors.length} console/page error(s) were logged.`,
        title: "Console errors detected while dogfooding the target",
      });
    }
    if (failedRequests.length) {
      findings.push({
        actual: failedRequests
          .map((r) => `- ${r.method} ${r.url}: ${r.error}`)
          .join("\n"),
        category: "network",
        evidence: ["network.json", screenshotRel, traceRel],
        severity: "Medium",
        summary: `${failedRequests.length} failed request(s) or 5xx response(s) were observed.`,
        title: "Network failures detected while dogfooding the target",
      });
    }
    if (args.annotate) {
      await collectAnnotations({
        cdpEndpoint: managedDogfood?.endpoint,
        result,
        userDataDir,
      });
    }
    result.inspectionCompleted = true;
  } catch (error) {
    result.fail("inspection", error);
  } finally {
    await result.capture(
      "console",
      () =>
        fs.writeFile(
          path.join(result.attemptDir, "console.json"),
          `${JSON.stringify(consoleErrors, null, 2)}\n`
        ),
      ["console.json"]
    );
    await result.capture(
      "network",
      () =>
        fs.writeFile(
          path.join(result.attemptDir, "network.json"),
          `${JSON.stringify(failedRequests, null, 2)}\n`
        ),
      ["network.json"]
    );
    await result.capture(
      "trace stop",
      () =>
        context.tracing.stop({ path: path.join(result.attemptDir, traceRel) }),
      [traceRel]
    );
    // Always close: releases the profile lock and finalizes local recordings.
    try {
      await context.close();
      videoFinalized = true;
    } catch (error) {
      result.fail("context close", error);
    }
    await browser
      ?.close()
      .catch((error) => result.fail("browser close", error));
    await managedDogfood?.close().catch((error) => {
      result.fail("managed Chrome cleanup", error);
    });
  }
} else if (managedDogfood) {
  await browser?.close().catch((error) => result.fail("browser close", error));
  await managedDogfood.close().catch((error) => {
    result.fail("managed Chrome cleanup", error);
  });
}

result.extensionId = extensionId;
process.exitCode = await result.finish({
  retryable: !swRegistered && !args.headed,
  videoFinalized,
  videoSupported: Boolean(context && !managedDogfood),
});
