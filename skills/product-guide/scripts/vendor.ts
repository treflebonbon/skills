// 同梱 bundle（vendor/）の再生成。配布先では実行しない。
//   1. 一時ディレクトリへ package.json と package-lock.json を複製し `npm ci --ignore-scripts`
//   2. lib/bun/run run scripts/vendor.ts <その node_modules>
// 実行時は vendor/ の bundle だけを読み、node_modules を使わない。
// 依存を足すとき（ELK.js、ast-grep など）は VENDORED に 1 行足す。
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// package の dist 内の単一ファイル bundle を vendor/<to> へ写す。
const VENDORED = [{ pkg: "@dagrejs/dagre", from: "dist/dagre.esm.js", to: "dagre.esm.js" }];

// ast-grep（WASM）一式。vendor/ast-grep/ へそのまま写す。bundle ではなく WASM を含むため
// `replace` で import 先だけを同梱ファイルへ向ける。実行は scripts/collect-evidence.ts が行う。
const ASSETS = [
  {
    pkg: "@ast-grep/wasm",
    from: "wasm_bg.js",
    replace: ["from 'web-tree-sitter'", "from './web-tree-sitter.js'"],
  },
  { pkg: "@ast-grep/wasm", from: "wasm_bg.wasm" },
  { pkg: "web-tree-sitter", from: "web-tree-sitter.js" },
  { pkg: "web-tree-sitter", from: "web-tree-sitter.wasm" },
  { pkg: "tree-sitter-typescript", from: "tree-sitter-typescript.wasm" },
  { pkg: "tree-sitter-typescript", from: "tree-sitter-tsx.wasm" },
  { pkg: "tree-sitter-javascript", from: "tree-sitter-javascript.wasm" },
] as { pkg: string; from: string; replace?: [string, string] }[];

const skill = resolve(import.meta.dir, "..");
const nodeModules = process.argv[2];
if (!nodeModules) {
  console.error("使い方: vendor.ts <npm ci 済みの node_modules>");
  process.exit(2);
}
const lock = JSON.parse(readFileSync(join(skill, "package-lock.json"), "utf8"));
const vendor = join(skill, "vendor");
mkdirSync(vendor, { recursive: true });

for (const { pkg, from, to } of VENDORED) {
  const version = lock.packages[`node_modules/${pkg}`].version;
  const code = readFileSync(join(nodeModules, pkg, from), "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("//# sourceMappingURL=") && !l.startsWith("/*! For license"))
    .join("\n");
  writeFileSync(
    join(vendor, to),
    `/* ${pkg}@${version} (THIRD-PARTY-LICENSES.txt を参照) */\n${code}`,
  );
}

const astGrep = join(vendor, "ast-grep");
mkdirSync(astGrep, { recursive: true });
for (const { pkg, from, replace } of ASSETS) {
  const src = join(nodeModules, pkg, from);
  if (!replace) copyFileSync(src, join(astGrep, from));
  else {
    const code = readFileSync(src, "utf8");
    if (!code.includes(replace[0])) throw new Error(`${pkg}/${from}: ${replace[0]} がありません`);
    writeFileSync(join(astGrep, from), code.replace(replace[0], replace[1]));
  }
}

// lock の全 package（推移依存を含む）の license を notice に集める。
const notices = Object.entries<{ version: string }>(lock.packages)
  .filter(([name]) => name)
  .map(([name, { version }]) => {
    const dir = join(nodeModules, name.replace(/^node_modules\//, ""));
    const texts = readdirSync(dir)
      .filter((f) => /^licen[sc]e(?:\.|$)/iu.test(f))
      .map((f) => readFileSync(join(dir, f), "utf8"));
    // @ast-grep/wasm は license ファイルを同梱しない（package.json は MIT）。上流の LICENSE を写した控えを使う。
    if (!texts.length && name.endsWith("@ast-grep/wasm"))
      texts.push(readFileSync(join(skill, "references/ast-grep-wasm.LICENSE"), "utf8"));
    if (!texts.length) throw new Error(`${name}: license ファイルがありません`);
    return `${name.replace(/^node_modules\//, "")}@${version}\n${texts.join("\n")}`;
  });
writeFileSync(join(vendor, "THIRD-PARTY-LICENSES.txt"), notices.join("\n\n---\n\n"));
