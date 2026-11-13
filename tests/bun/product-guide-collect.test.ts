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
  for (const commit of ["main", a.slice(0, 7), "0".repeat(40)]) {
    const { r, json } = collectAt(dir, commit);
    expect(r.code).not.toBe(0);
    expect(json).toBeUndefined();
  }
  const first = collectAt(dir, a);
  const again = spawn([run, "run", collect, dir, "--commit", a, "--out", first.out]);
  expect(again.code).not.toBe(0); // 既存の出力は上書きしない
});
