import { lstatSync, statSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { validateDocument, artifacts } from "../src/model.mjs";

const { resolve, dirname } = path;

const [input, output, artifactsDir] = process.argv.slice(2);
if (!input || !output) {
  throw new Error(
    "Usage: node scripts/render.mjs model.json output.html [artifacts-directory]"
  );
}
if (resolve(input) === resolve(output)) {
  throw new Error("入力JSONと出力HTMLは別のパスにしてください");
}
const doc = validateDocument(JSON.parse(await readFile(input, "utf-8")));
const template = await readFile(
  new URL("../dist/studio.html", import.meta.url),
  "utf-8"
);
const html = template.replace("__STUDIO_DOCUMENT__", () =>
  JSON.stringify(doc).replaceAll("<", "\\u003c")
);
const entries = artifactsDir ? Object.entries(artifacts(doc)) : [];
// Preflight every destination, the HTML included, before writing any of them:
// without this, a collision found later leaves a partial output set that also
// can't be retried under the same output name.
for (const destination of [
  resolve(output),
  ...entries.map(([name]) => resolve(artifactsDir, name)),
]) {
  let ancestor = destination;
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
    ancestor = dirname(ancestor);
  }
  if (ancestor === destination) {
    throw new Error(`Output already exists: ${destination}`);
  }
  if (!statSync(ancestor).isDirectory()) {
    throw new Error(`出力先の親がディレクトリではありません: ${ancestor}`);
  }
}
await mkdir(dirname(resolve(output)), { recursive: true });
await writeFile(output, html, { flag: "wx" });
if (artifactsDir) {
  await mkdir(artifactsDir, { recursive: true });
  await Promise.all(
    entries.map(([name, content]) =>
      writeFile(resolve(artifactsDir, name), content, { flag: "wx" })
    )
  );
}
console.log(resolve(output));
