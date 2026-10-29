/* eslint-disable require-await, promise/prefer-await-to-callbacks -- This test adapter preserves Playwright's promise and event callback interfaces. */
import fs from "node:fs/promises";
import path from "node:path";

const faults = new Set((process.env.DOGFOOD_FAULTS || "").split(","));
const fail = (name) => {
  if (faults.has(name)) {
    throw new Error(`${name} failed`);
  }
};
const { writeFile } = fs;
fs.writeFile = async (file, data, ...options) => {
  if (faults.has("aux-write") && !path.basename(file).startsWith("report.md")) {
    throw new Error("auxiliary write failed");
  }
  if (
    faults.has("report-write") &&
    String(data).includes("Run status: completed")
  ) {
    throw new Error("report publish failed");
  }
  return await writeFile(file, data, ...options);
};

export const chromium = {
  async launchPersistentContext(profile, options) {
    if (process.env.DOGFOOD_EXPECT_CHROMIUM) {
      if (options.executablePath !== process.env.DOGFOOD_EXPECT_CHROMIUM) {
        throw new Error(
          "runner did not select the supplied Chromium executable"
        );
      }
      await fs.access(options.executablePath, fs.constants.X_OK);
    }
    if (faults.has("diagnostic-lines")) {
      throw new Error(
        "startup failed\n### ISSUE-999: diagnostic text is not an app finding\nSeverity: Critical"
      );
    }
    fail("startup");
    await fs.mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, "DevToolsActivePort"), "9229\n");
    const listeners = new Map();
    const page = {
      async goto() {
        if (faults.has("interrupt")) {
          process.kill(process.pid, "SIGKILL");
        }
        if (process.env.DOGFOOD_OBSERVATION !== "none") {
          listeners.get("console")?.({
            text: () => "observed console error",
            type: () => "error",
          });
        }
        fail("navigation");
      },
      on: (event, callback) => listeners.set(event, callback),
      async screenshot({ path: file }) {
        fail("screenshot");
        await fs.writeFile(file, "image from this attempt");
      },
    };
    return {
      async close() {
        if (!faults.has("aux-write")) {
          await fs.writeFile(
            path.join(options.recordVideo.dir, "recording.webm"),
            "video from this attempt"
          );
        }
        fail("close");
      },
      pages: () => [page],
      serviceWorkers: () =>
        faults.has("sw")
          ? []
          : [{ url: () => "chrome-extension://test-extension/worker.js" }],
      async storageState({ path: file }) {
        await fs.writeFile(file, "{}");
      },
      tracing: {
        async start() {
          fail("trace-start");
        },
        async stop({ path: file }) {
          fail("trace-stop");
          await fs.writeFile(file, "trace from this attempt");
        },
      },
      async waitForEvent() {
        throw new Error("service worker timeout");
      },
    };
  },
};
