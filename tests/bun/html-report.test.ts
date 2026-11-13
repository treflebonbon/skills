import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const peers = ["herdr-peer-refactor", "orca-peer-refactor"];

for (const peer of peers) {
  test(`${peer}: 静的 HTML 検査は図数と描画未実施を返す`, () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "html-report-"));
    const report = resolve(temporary, "report.html");
    writeFileSync(report, '<pre class="mermaid">flowchart TD\nA --> B</pre>');
    try {
      const result = spawnSync(
        resolve(root, "skills", peer, "scripts/check-architecture-report"),
        [report],
        {
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        static_check: "passed",
        expected_mermaid_diagrams: 1,
        render_check: "not_performed",
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
