import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { example } from "./fixture.mjs";

const renderScript = fileURLToPath(
  new URL("../scripts/render.mjs", import.meta.url)
);

test("既存の成果物ファイルと衝突する場合は他の成果物も一切書き出さない", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "render-preflight-"));
  t.after(() => rm(dir, { force: true, recursive: true }));

  const input = path.join(dir, "model.json");
  const output = path.join(dir, "studio.html");
  const artifactsDir = path.join(dir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(input, JSON.stringify(example()));
  // Simulate a leftover artifact from a previous run colliding with this one.
  await writeFile(path.join(artifactsDir, "model.md"), "stale content");

  assert.throws(() =>
    execFileSync(process.execPath, [renderScript, input, output, artifactsDir])
  );

  // The other three artifacts (changes.md, glossary.md, scenarios.feature)
  // must not appear alongside the pre-existing model.md; a partial write
  // would also make a same-name retry fail forever.
  const remaining = await readdir(artifactsDir);
  assert.deepEqual(remaining, ["model.md"]);
  // The HTML is part of the same all-or-nothing set: it must not be written
  // before the collision is found, or a retry would fail on its own output.
  const files = await readdir(dir);
  assert.deepEqual(files.toSorted(), ["artifacts", "model.json"]);
});

test("壊れたリンクやディレクトリにできない出力先でも部分成果物を残さない", async (t) => {
  await Promise.all(
    ["dangling-artifact", "file-directory"].map((kind) =>
      t.test(kind, async () => {
        const dir = await mkdtemp(
          path.join(os.tmpdir(), "render-invalid-path-")
        );
        t.after(() => rm(dir, { force: true, recursive: true }));
        const input = path.join(dir, "model.json");
        const output = path.join(dir, "studio.html");
        const artifactsDir = path.join(dir, "artifacts");
        await writeFile(input, JSON.stringify(example()));
        if (kind === "dangling-artifact") {
          await mkdir(artifactsDir);
          await symlink("missing-model", path.join(artifactsDir, "model.md"));
        } else {
          await writeFile(artifactsDir, "保持する既存ファイル");
        }

        assert.throws(() =>
          execFileSync(
            process.execPath,
            [renderScript, input, output, artifactsDir],
            {
              stdio: "pipe",
            }
          )
        );
        const files = await readdir(dir);
        assert.deepEqual(files.toSorted(), ["artifacts", "model.json"]);
        if (kind === "dangling-artifact") {
          assert.deepEqual(await readdir(artifactsDir), ["model.md"]);
        }
      })
    )
  );
});
