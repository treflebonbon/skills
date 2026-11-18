import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

test("手順の JSON 検査は入れ子・escape 後の重複と旧 Python の整数桁数超過を拒否する", () => {
  const directory = fs.mkdtempSync(resolve(tmpdir(), "coordination-json-"));
  try {
    const invoke = (input: string) =>
      spawnSync(
        resolve(root, "lib/bun/run"),
        ["run", resolve(root, "lib/bun/coordination-json.ts"), "-"],
        { cwd: directory, input, encoding: "utf8" },
      );
    for (const [input, diagnostic] of [
      ['{"a":[{"x":1},{"x":2}],"text":"\\\"x\\\":3"}', ""],
      ['{"outer":[{"x":1,"\\u0078":2}]}', "重複キー"],
      ['{"ok":true,"ok":true}', "重複キー"],
      ['{"number":' + "1".repeat(4300) + "}", ""],
      ['{"number":' + "1".repeat(4301) + "}", "4300"],
      ['{"text":"\\\"' + "1".repeat(100_000) + '\\u0031"}', ""],
      ['{"number":-' + "1".repeat(100_000) + "}", "4300"],
      ['{"number":' + "1".repeat(100_000) + ".0}", ""],
      ['{"number":' + "1".repeat(100_000) + "e1}", ""],
      ['{"number":' + "1".repeat(100_000) + ',"truncated":', "4300"],
    ]) {
      const result = invoke(input!);
      expect(result.status, result.stderr).toBe(diagnostic ? 1 : 0);
      if (diagnostic) expect(result.stderr).toContain(diagnostic);
      expect(result.stdout).toBe("");
    }
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
