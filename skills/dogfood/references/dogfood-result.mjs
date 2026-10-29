import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const diagnostic = (value) => value.replaceAll(/\r?\n/gu, "\n    ");

export class DogfoodResult {
  static async start({ output, target }) {
    const outputRoot = path.resolve(output);
    const attempts = path.join(outputRoot, "attempts");
    await fs.mkdir(attempts, { recursive: true });
    const attemptDir = await fs.mkdtemp(path.join(attempts, "attempt-"));
    await Promise.all(
      ["screenshots", "videos", "traces"].map((name) =>
        fs.mkdir(path.join(attemptDir, name))
      )
    );
    const result = new DogfoodResult({ attemptDir, outputRoot, target });
    await result.publish("running");
    return result;
  }

  constructor({ attemptDir, outputRoot, target }) {
    this.attemptDir = attemptDir;
    this.outputRoot = outputRoot;
    this.target = target;
    this.findings = [];
    this.failures = [];
    this.warnings = [];
    this.artifacts = new Set();
    this.inspectionCompleted = false;
  }

  fail(stage, error) {
    this.failures.push(`${stage}: ${error.message || String(error)}`);
  }

  async retainFile(relative) {
    const file = path.join(this.attemptDir, relative);
    const resolved = await fs.realpath(file);
    const within = path.relative(await fs.realpath(this.attemptDir), resolved);
    const stat = await fs.stat(file);
    if (
      within.startsWith("..") ||
      path.isAbsolute(within) ||
      !stat.isFile() ||
      !stat.size
    ) {
      throw new Error(
        `Evidence is missing, empty or outside the attempt: ${relative}`
      );
    }
    this.artifacts.add(relative);
  }

  async capture(stage, operation, files = []) {
    try {
      const value = await operation();
      for (const relative of files) {
        // eslint-disable-next-line no-await-in-loop -- validate each collected file before advertising it
        await this.retainFile(relative);
      }
      return value;
    } catch (error) {
      this.warnings.push(`${stage}: ${error.message || String(error)}`);
    }
  }

  render(status, reportRoot) {
    const evidencePath = (relative) =>
      path.relative(reportRoot, path.join(this.attemptDir, relative));
    let evidenceStatus = "unavailable";
    if (this.artifacts.size) {
      evidenceStatus = this.warnings.length ? "partial" : "complete";
    }
    const lines = [
      "# Playwright Dogfood Report",
      "",
      `Target: ${this.target}`,
      `Attempt directory: ${path.relative(reportRoot, this.attemptDir) || "."}`,
      `Run status: ${status}`,
      `Evidence status: ${evidenceStatus}`,
      ...(this.inspectionCompleted
        ? []
        : ["Unverified: inspection completion"]),
      ...(this.extensionId ? [`Extension ID: ${this.extensionId}`] : []),
      "",
      ...this.failures.map((failure) => `Failure: ${diagnostic(failure)}`),
      ...this.warnings.map((warning) => `Warning: ${diagnostic(warning)}`),
      "",
      "## Collected evidence",
      "",
      ...[...this.artifacts].map(
        (relative) => `- [${relative}](${evidencePath(relative)})`
      ),
      "",
      "## Findings",
      "",
    ];
    if (!this.findings.length) {
      lines.push("No findings recorded.", "");
    }
    for (const [index, finding] of this.findings.entries()) {
      const number = String(index + 1).padStart(3, "0");
      lines.push(
        `### ISSUE-${number}: ${finding.title}`,
        `Severity: ${finding.severity}`,
        `Category: ${finding.category}`,
        `URL: ${finding.url ?? this.target}`,
        `Summary: ${finding.summary}`,
        `Actual: ${finding.actual}`,
        `Evidence: ${finding.evidence
          .filter((relative) => this.artifacts.has(relative))
          .map(evidencePath)
          .join(", ")}`,
        ""
      );
    }
    return lines.join("\n");
  }

  async publish(status) {
    for (const directory of [this.attemptDir, this.outputRoot]) {
      const file = path.join(directory, "report.md");
      const temporary = `${file}.${randomUUID()}.tmp`;
      // eslint-disable-next-line no-await-in-loop -- publish the historical report before its latest view
      await fs.writeFile(temporary, this.render(status, directory));
      // eslint-disable-next-line no-await-in-loop -- replace only fully written reports
      await fs.rename(temporary, file);
    }
  }

  async finish({
    retryable = false,
    videoSupported = false,
    videoFinalized = false,
  } = {}) {
    if (videoSupported) {
      const videos = await this.capture("video", async () => {
        if (!videoFinalized) {
          throw new Error(
            "Video finalization was not confirmed because context close failed"
          );
        }
        const entries = await fs.readdir(path.join(this.attemptDir, "videos"));
        const files = entries
          .filter((file) => file.endsWith(".webm"))
          .map((file) => `videos/${file}`);
        if (!files.length) {
          throw new Error("No finalized video was recorded");
        }
        for (const file of files) {
          // eslint-disable-next-line no-await-in-loop -- validate finalized recordings
          await this.retainFile(file);
        }
        return files;
      });
      for (const finding of this.findings) {
        finding.evidence.push(...(videos || []));
      }
    }
    let status = "completed";
    let exitCode = 0;
    if (this.failures.length) {
      status = "failed";
      exitCode = 1;
    } else if (retryable) {
      status = "retryable";
      exitCode = 2;
    }
    try {
      await this.publish(status);
    } catch (error) {
      this.fail("report", error);
      exitCode = 1;
      await this.publish("failed").catch((publicationError) =>
        this.fail("report recovery", publicationError)
      );
    }
    for (const failure of this.failures) {
      process.stderr.write(`${failure}\n`);
    }
    return exitCode;
  }
}
