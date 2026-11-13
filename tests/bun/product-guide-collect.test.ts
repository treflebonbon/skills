import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const run = resolve(root, "lib/bun/run");
const collect = resolve(root, "skills/product-guide/scripts/collect-evidence.ts");
const guide = resolve(root, "skills/product-guide/scripts/product-guide.ts");

const spawn = (cmd: string[], cwd?: string) => {
  const p = Bun.spawnSync(cmd, { cwd, stderr: "pipe", stdout: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString() };
};
const git = (cwd: string, ...a: string[]) =>
  spawn(
    [
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      ...a,
    ],
    cwd,
  );

// commit A: 2 ファイル。その後、作業ツリーと commit B で内容を変える。
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "pg-collect-"));
  git(dir, "init", "-q");
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src/invoice.ts"),
    [
      "export function submitInvoice(amount: number): boolean {",
      "  return amount > 0;",
      "}",
      "export class Ledger {",
      "  post(entry: string) {}",
      "}",
      "export const approve = (id: string) => id;",
      "export interface Invoice { id: string }",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "src/view.jsx"), "export function Button() { return <b>ok</b>; }\n");
  writeFileSync(join(dir, "notes.py"), "def ignored(): pass\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "a");
  const a = git(dir, "rev-parse", "HEAD").out;
  writeFileSync(join(dir, "src/invoice.ts"), "export function renamedLater() {}\n");
  git(dir, "commit", "-qam", "b");
  writeFileSync(join(dir, "src/invoice.ts"), "export function dirtyWorktree() {}\n");
  return { dir, a, b: git(dir, "rev-parse", "HEAD").out };
}

function collectAt(dir: string, commit: string, ...extra: string[]) {
  const out = join(mkdtempSync(join(tmpdir(), "pg-out-")), "evidence.json");
  const r = spawn([run, "run", collect, dir, "--commit", commit, "--out", out, ...extra]);
  return { r, out, json: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : undefined };
}

test("指定コミットの版から TS/JS のシンボルと位置を収集する（作業ツリーや他の版ではない）", () => {
  const { dir, a } = repo();
  const { r, json } = collectAt(dir, a);
  expect(r.code).toBe(0);
  const list = json.evidence.map((e: any) => `${e.path}#${e.symbol}`);
  expect(list).toEqual([
    "src/invoice.ts#submitInvoice",
    "src/invoice.ts#Ledger",
    "src/invoice.ts#Ledger.post",
    "src/invoice.ts#approve",
    "src/invoice.ts#Invoice",
    "src/view.jsx#Button",
  ]);
  expect(json.evidence[0]).toMatchObject({ id: "AG1", commit: a });
  expect(json.evidence[0].note).toContain("L1-3");
  expect(json.evidence.every((e: any) => e.commit === a)).toBe(true);
});

test("抽出結果は unverified で出力され、そのままモデルの根拠として validate を通る", () => {
  const { dir, a } = repo();
  const { json } = collectAt(dir, a);
  expect(json.evidence.every((e: any) => e.kind === "unverified")).toBe(true);
  const model = {
    title: "t",
    summary: "s",
    target: { commit: a, confirmedOn: "2026-11-13" },
    scope: { investigated: ["x"] },
    evidence: json.evidence,
    features: [
      {
        name: "f",
        purpose: "p",
        flow: [{ text: "手順", evidence: ["AG1"] }],
      },
    ],
  };
  const f = join(mkdtempSync(join(tmpdir(), "pg-model-")), "model.json");
  writeFileSync(f, JSON.stringify(model));
  expect(spawn([run, "run", guide, "validate", f]).code).toBe(0);
});

test("--path で範囲を絞れる", () => {
  const { dir, a } = repo();
  const { json } = collectAt(dir, a, "--path", "src/view.jsx");
  expect(json.evidence.map((e: any) => e.symbol)).toEqual(["Button"]);
});

test("不正な入力は失敗し、出力を作らない", () => {
  const { dir, a } = repo();
  // [入力, 期待する拒否理由]。形式の誤りは --commit の検査、形式が正しくても存在しなければ git の失敗。
  const rejected: [string, string][] = [
    ["main", "--commit は 40 桁の小文字 16 進のコミット ID が必要です"],
    [a.slice(0, 7), "--commit は 40 桁の小文字 16 進のコミット ID が必要です"],
    [a.toUpperCase(), "--commit は 40 桁の小文字 16 進のコミット ID が必要です"],
    ["0".repeat(40), "git cat-file に失敗しました"],
  ];
  for (const [commit, reason] of rejected) {
    const { r, json } = collectAt(dir, commit);
    expect(r.code, commit).toBe(1);
    expect(r.err, commit).toContain(reason);
    expect(json).toBeUndefined();
  }
  const first = collectAt(dir, a);
  expect(first.r.code).toBe(0); // 境界の 1 つ手前: 正しい完全なコミット ID は通る
  const again = spawn([run, "run", collect, dir, "--commit", a, "--out", first.out]);
  expect(again.code).toBe(1); // 既存の出力は上書きしない
  expect(again.err).toContain("出力先が既に存在します。上書きしません");
});

test("repo のパスや出力先が使えないときは、スタックトレースではなく使い方のエラーにする", () => {
  const { dir, a } = repo();
  const missingRepo = collectAt(join(dir, "no-such-repo"), a);
  expect(missingRepo.r.code).toBe(1);
  expect(missingRepo.r.err).toContain("git を実行できません");
  expect(missingRepo.r.err).not.toContain("    at ");
  // 出力先のディレクトリが無ければ書けない。理由を報告し、何も作らない。
  const out = join(dir, "no-such-dir", "evidence.json");
  const noDir = spawn([run, "run", collect, dir, "--commit", a, "--out", out]);
  expect(noDir.code).toBe(1);
  expect(noDir.err).toContain("出力を書けません");
  expect(noDir.err).not.toContain("    at ");
  expect(existsSync(out)).toBe(false);
});

// 括弧付きの関数値は収集し、メソッドは直近の所有ノード（クラス宣言）の名前だけを所属として記録する。
function repoWith(file: string, source: string) {
  const dir = mkdtempSync(join(tmpdir(), "pg-collect-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, file), source);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "a");
  return { dir, a: git(dir, "rev-parse", "HEAD").out };
}
const symbols = (json: { evidence: { symbol: string }[] }) => json.evidence.map((e) => e.symbol);

test("括弧付きの関数値の const も収集する。関数でない値の const は収集しない", () => {
  const { dir, a } = repoWith(
    "src.js",
    [
      "export const approve = (() => true);",
      "export const nested = ((function () {}));",
      "export const plain = (1 + 2);",
      "export const direct = () => 1;",
      "",
    ].join("\n"),
  );
  expect(symbols(collectAt(dir, a).json)).toEqual(["approve", "nested", "direct"]);
});

test("メソッドの所属は直近の所有ノードで決め、オブジェクトやクラス式を越えて外側のクラス名を付けない", () => {
  const { dir, a } = repoWith(
    "src.js",
    [
      "class Outer {",
      "  build() { return { submit() {} }; }",
      "  make() { return class { inner() {} }; }",
      "}",
      "",
    ].join("\n"),
  );
  // Outer.build と Outer.make は所属が Outer。オブジェクトの submit とクラス式の inner は外側の Outer を付けない。
  expect(symbols(collectAt(dir, a).json).sort()).toEqual([
    "Outer",
    "Outer.build",
    "Outer.make",
    "inner",
    "submit",
  ]);
});
