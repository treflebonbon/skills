// 対象の完全なコミット ID の版から、TypeScript/JavaScript の構文上の根拠（シンボルと位置）を
// ast-grep（同梱 WASM。vendor/ast-grep、references/dependencies.md）で集め、モデルの evidence 配列として出力する。
// 抽出結果は kind を常に unverified にする。code-verified への格上げは、ソースを読んだ人（エージェント）が行う。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const usage = `使い方:
  collect-evidence <git repo> --commit <40 桁のコミット ID> --out <出力 JSON> [--path <接頭辞>]`;
function fail(code: number, ...lines: string[]): never {
  console.error(lines.join("\n"));
  process.exit(code);
}

const args = process.argv.slice(2);
const repo = args.shift();
const opts = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const k = args[i];
  if (!["--commit", "--out", "--path"].includes(k) || args[i + 1] === undefined || opts.has(k))
    fail(2, `未対応または不正な引数: ${k}`, usage);
  opts.set(k, args[i + 1]);
}
const commit = opts.get("--commit");
const outArg = opts.get("--out");
const prefix = opts.get("--path") ?? "";
if (!repo || !commit || !outArg) fail(2, usage);
if (!/^[0-9a-f]{40}$/.test(commit))
  fail(1, "--commit は 40 桁の小文字 16 進のコミット ID が必要です");
const out = resolve(outArg);
if (existsSync(out)) fail(1, `出力先が既に存在します。上書きしません: ${out}`);

const git = (...a: string[]) => {
  const p = Bun.spawnSync(["git", ...a], { cwd: repo, stderr: "pipe", stdout: "pipe" });
  if (p.exitCode !== 0) fail(1, `git ${a[0]} に失敗しました: ${p.stderr.toString().trim()}`);
  return p.stdout;
};
git("cat-file", "-e", `${commit}^{commit}`);

// ---- ast-grep（WASM）の初期化。import 先は vendor/ のみ ----
const vendorDir = join(import.meta.dir, "../vendor/ast-grep");
const sg = await import(join(vendorDir, "wasm_bg.js"));
const mod = new WebAssembly.Module(readFileSync(join(vendorDir, "wasm_bg.wasm")));
const inst = new WebAssembly.Instance(mod, { "./wasm_bg.js": sg });
sg.__wbg_set_wasm(inst.exports);
(inst.exports as { __wbindgen_start(): void }).__wbindgen_start();
await sg.initializeTreeSitter();
await sg.registerDynamicLanguage({
  typescript: { libraryPath: join(vendorDir, "tree-sitter-typescript.wasm") },
  tsx: { libraryPath: join(vendorDir, "tree-sitter-tsx.wasm") },
  javascript: { libraryPath: join(vendorDir, "tree-sitter-javascript.wasm") },
});

// ast-grep の node のうち、ここで使う分だけの型（sg は動的 import のため型が付かない）。
type SgNode = {
  kind(): string;
  text(): string;
  field(name: string): SgNode | null;
  ancestors(): SgNode[];
  namedChildren(): SgNode[];
  range(): { start: { line: number }; end: { line: number } };
  findAll(matcher: object): SgNode[];
  free(): void;
};
type SgTree = { root(): SgNode; free(): void };

// ast-grep（WASM）の node は、JS の GC では解放が遅れ、ファイルが多いと実行中にメモリが増え続ける。
// ファイルごとに作った node をすべて記録し、そのファイルの処理後に free() する（計測: 300 ファイルの
// パースで WASM のメモリが約 83 MiB から約 5.5 MiB に減る）。node を返す呼び出しは own() を通す。
const owned: SgNode[] = [];
function own(node: SgNode | null): SgNode | null;
function own(nodes: SgNode[]): SgNode[];
function own(x: SgNode | SgNode[] | null): SgNode | SgNode[] | null {
  if (Array.isArray(x)) owned.push(...x);
  else if (x) owned.push(x);
  return x;
}

const LANG: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
};
const DECLS = [
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "method_definition",
  "variable_declarator",
];
// 文法ごとに存在する kind だけを使う（JS に interface はない、等）。
const kindsFor = (lang: string) =>
  DECLS.filter((k) => sg.kind(lang, k) !== 0).map((kind) => ({ kind })); // 存在しない kind は 0
const FN_VALUE = ["arrow_function", "function_expression", "generator_function"];
// メソッドの所属は直近の所有ノードで決める。オブジェクトやクラス式は、外側のクラスの名前を引き継がない境界。
const OWNER = ["class_declaration", "abstract_class_declaration", "class", "object"];
// `(() => true)` のような括弧を外して、中の式を返す。
const unwrap = (node: SgNode | null): SgNode | null => {
  let cur = node;
  while (cur?.kind() === "parenthesized_expression")
    cur = own(cur.namedChildren()).find((child) => child.kind() !== "comment") ?? null;
  return cur;
};

const files = git("ls-tree", "-r", "--name-only", "-z", commit)
  .toString()
  .split("\0")
  .filter((p) => p.startsWith(prefix) && LANG[p.slice(p.lastIndexOf("."))])
  .sort();

const evidence: Record<string, string>[] = [];
for (const path of files) {
  const src = git("cat-file", "blob", `${commit}:${path}`).toString();
  const lang = LANG[path.slice(path.lastIndexOf("."))];
  const tree: SgTree = sg.parse(lang, src);
  try {
    const root = own(tree.root())!;
    for (const decl of own(root.findAll({ rule: { any: kindsFor(lang) } }))) {
      const name = own(decl.field("name"))?.text();
      if (!name) continue;
      if (
        decl.kind() === "variable_declarator" &&
        !FN_VALUE.includes(unwrap(own(decl.field("value")))?.kind() ?? "")
      )
        continue;
      let symbol = name;
      if (decl.kind() === "method_definition") {
        const owner = own(decl.ancestors()).find((ancestor) => OWNER.includes(ancestor.kind()));
        const clsName = owner?.kind().endsWith("class_declaration")
          ? own(owner.field("name"))?.text()
          : undefined;
        if (clsName) symbol = `${clsName}.${name}`;
      }
      const { start, end } = decl.range();
      const exported = own(decl.ancestors()).some(
        (ancestor) => ancestor.kind() === "export_statement",
      );
      evidence.push({
        id: `AG${evidence.length + 1}`,
        kind: "unverified",
        commit,
        path,
        symbol,
        note: `ast-grep: ${decl.kind()}${exported ? " (export)" : ""} L${start.line + 1}-${end.line + 1}`,
      });
    }
  } finally {
    for (const node of owned.splice(0)) node.free();
    tree.free();
  }
}

writeFileSync(out, `${JSON.stringify({ evidence }, null, 2)}\n`, { flag: "wx" });
console.log(`${evidence.length} 件の構文上の根拠を ${out} へ書きました（kind は全て unverified）`);
