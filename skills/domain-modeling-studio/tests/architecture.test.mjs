import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { generateArchitecture } from "../scripts/generate-architecture.mjs";
import { validateDocument } from "../src/model.mjs";
import { example } from "./fixture.mjs";

const REVISION = "a".repeat(40);

const buildFixtureRepo = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arch-fixture-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  const files = {
    "src/lib.rs":
      "use crate::util::helper;\nuse serde::Deserialize;\nuse serde::Serialize;\n",
    "src/logger.js": "export const log = () => {};\n",
    "src/orderFlow.js":
      'import { charge } from "./payment.js";\nimport React from "react";\n',
    "src/payment.js": 'import { log } from "./logger.js";\n',
    "src/report.py": "from .summary import build_report\nimport os\n",
    "src/summary.py": "def build_report():\n    pass\n",
    "src/util.rs": "pub fn helper() {}\n",
  };
  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      writeFile(path.join(root, name), content)
    )
  );
  return root;
};

test("業務フローが触れるモジュール(seed)と依存先1ホップだけを、言語非依存のimport/require解析で拾う", async (t) => {
  const root = await buildFixtureRepo();
  t.after(() => rm(root, { force: true, recursive: true }));

  const { nodes, edges } = await generateArchitecture({
    repoRoot: root,
    revision: REVISION,
    seeds: ["src/orderFlow.js", "src/report.py", "src/lib.rs"],
  });

  const labels = nodes.map((n) => n.data.label).toSorted();
  assert.deepEqual(labels, [
    "os",
    "react",
    "serde",
    "src/lib.rs",
    "src/orderFlow.js",
    "src/payment.js",
    "src/report.py",
    "src/summary.py",
    "src/util.rs",
  ]);
  // 同じクレートの複数アイテム(Deserialize/Serialize)は1つの"serde"ノードに集約される
  assert.equal(nodes.filter((n) => n.data.label === "serde").length, 1);
  // 2ホップ先(payment.js経由のlogger.js)はリポジトリ全体走査していれば見えるはずだが、含まれない
  assert.ok(!labels.includes("src/logger.js"));

  assert.ok(nodes.every((n) => n.data.origin === "inference"));
  assert.ok(edges.every((e) => e.data.origin === "inference"));
  assert.ok(nodes.every((n) => ["MODULE", "EXTERNAL"].includes(n.data.kind)));

  const labelOf = (id) => nodes.find((n) => n.id === id).data.label;
  const kindOf = (id) => nodes.find((n) => n.id === id).data.kind;
  const pairs = edges
    .map((e) => [labelOf(e.source), labelOf(e.target)])
    .toSorted();
  assert.deepEqual(pairs, [
    ["src/lib.rs", "serde"],
    ["src/lib.rs", "src/util.rs"],
    ["src/orderFlow.js", "react"],
    ["src/orderFlow.js", "src/payment.js"],
    ["src/report.py", "os"],
    ["src/report.py", "src/summary.py"],
  ]);
  assert.equal(
    kindOf(edges.find((e) => labelOf(e.target) === "react").target),
    "EXTERNAL"
  );
  assert.equal(
    kindOf(edges.find((e) => labelOf(e.target) === "src/payment.js").target),
    "MODULE"
  );

  const doc = example();
  doc.models.proposed.nodes.push(...nodes);
  doc.models.proposed.edges.push(...edges);
  assert.doesNotThrow(() => validateDocument(doc));
});

test("ディレクトリを指すimportをindexファイルへ解決し、ディレクトリ自体はMODULEにしない", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arch-fixture-dir-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "src/foo"), { recursive: true });
  await writeFile(
    path.join(root, "src/orderFlow.js"),
    'import x from "./foo";\n'
  );
  await writeFile(path.join(root, "src/foo/index.js"), "export default 1;\n");

  const { nodes } = await generateArchitecture({
    repoRoot: root,
    revision: REVISION,
    seeds: ["src/orderFlow.js"],
  });

  const labels = nodes.map((n) => n.data.label).toSorted();
  assert.deepEqual(labels, ["src/foo/index.js", "src/orderFlow.js"]);
});

test("拡張子なしのimportは対応する全てのindex拡張子へ解決する", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arch-fixture-index-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const indexes = ["foo/index.jsx", "bar/index.tsx", "baz/index.cjs"];
  await Promise.all(
    indexes.map(async (index) => {
      await mkdir(path.join(root, "src", path.dirname(index)), {
        recursive: true,
      });
      await writeFile(path.join(root, "src", index), "export default 1;\n");
    })
  );
  await writeFile(
    path.join(root, "src/orderFlow.js"),
    'import a from "./foo";\nimport b from "./bar";\nimport c from "./baz";\n'
  );

  const { nodes } = await generateArchitecture({
    repoRoot: root,
    revision: REVISION,
    seeds: ["src/orderFlow.js"],
  });

  const labels = nodes.map((n) => n.data.label).toSorted();
  assert.deepEqual(labels, [
    "src/bar/index.tsx",
    "src/baz/index.cjs",
    "src/foo/index.jsx",
    "src/orderFlow.js",
  ]);
});

test("不正なrevision・リポジトリ外へ出るseedパスを拒否する", async (t) => {
  const root = await buildFixtureRepo();
  t.after(() => rm(root, { force: true, recursive: true }));

  await assert.rejects(
    () =>
      generateArchitecture({
        repoRoot: root,
        revision: "not-a-commit-id",
        seeds: ["src/orderFlow.js"],
      }),
    /revision/u
  );
  await assert.rejects(
    () =>
      generateArchitecture({
        repoRoot: root,
        revision: REVISION,
        seeds: ["../outside.js"],
      }),
    /seed/u
  );
});
