import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const run = resolve(root, "lib/bun/run");
const script = resolve(root, "skills/product-guide/scripts/product-guide.ts");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function cli(...args: string[]) {
  const p = Bun.spawnSync([run, "run", script, ...args], { stderr: "pipe", stdout: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const evidence = [
  {
    id: "E1",
    kind: "code-verified",
    commit: COMMIT,
    path: "src/invoice/submit.ts",
    symbol: "submitInvoice",
  },
  { id: "E2", kind: "approved-decision", note: "経理部の承認済み方針" },
  { id: "E3", kind: "unverified" },
];

function model(patch: Record<string, unknown> = {}) {
  return {
    title: "請求書申請ガイド",
    summary: "経理担当者が請求書を申請する手順です。",
    target: { commit: COMMIT, versionName: "v1.2", confirmedOn: "2026-11-13" },
    scope: { investigated: ["請求書の申請"], notInvestigated: ["請求書の取消"] },
    evidence,
    glossary: [{ term: "締め日", meaning: "月次の申請受付の終了日" }],
    unconfirmed: ["承認者の代理設定の有無"],
    conflicts: [
      {
        summary: "上限額の扱いが異なります。",
        code: { text: "上限は 100 万円です。", evidence: ["E1"] },
        decision: { text: "上限は 200 万円とする方針です。", evidence: ["E2"] },
      },
    ],
    features: [
      {
        name: "請求書の申請",
        availability: "available",
        purpose: "請求書を経理へ提出する。",
        operations: ["申請する", "下書き保存"],
        flow: [
          { text: "「申請する」を押す。", evidence: ["E1"] },
          { text: "承認者へ通知される。", evidence: ["E3"] },
        ],
        conditions: [{ text: "締め日前に限る。", evidence: ["E2"] }],
        actions: [{ text: "金額を確認する。", evidence: ["E1"] }],
      },
      {
        name: "自動仕訳",
        availability: "proposed",
        purpose: "仕訳を自動化する。",
        flow: [{ text: "提案中の手順です。", evidence: ["E2"] }],
      },
    ],
    ...patch,
  };
}

function setup(m: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "product-guide-"));
  const file = join(dir, "model.json");
  writeFileSync(file, JSON.stringify(m));
  return { dir, file, out: join(dir, "out") };
}

function generate(m: unknown, audience: string) {
  const s = setup(m);
  const r = cli("generate", s.file, "--audience", audience, "--out", s.out);
  const html = join(s.out, `${COMMIT}-${audience}`, "index.html");
  return { ...s, r, html, text: existsSync(html) ? readFileSync(html, "utf8") : "" };
}

test("internal: 比較元なしで単体 HTML を生成し、根拠を辿れる", () => {
  const g = generate(model(), "internal");
  expect(g.r.code).toBe(0);
  expect(g.text).toContain("<ol><li>「申請する」を押す。");
  expect(g.text).toContain("src/invoice/submit.ts");
  expect(g.text).toContain(COMMIT);
  expect(g.text).toContain("請求書の取消");
  expect(g.text).toContain("承認者の代理設定の有無");
  expect(g.text).toContain("上限は 100 万円です。");
  expect(g.text).toContain("上限は 200 万円とする方針です。");
  expect(g.text).not.toMatch(/https?:\/\//);
  expect(g.text).not.toContain("<script");
});

test("同じモデルから同じ出力が得られる", () => {
  const a = generate(model(), "internal");
  const b = generate(model(), "internal");
  expect(a.text).toBe(b.text);
});

test("提案は現行の目次・節に出ず、別枠に隔離される", () => {
  const { text } = generate(model(), "internal");
  const tocEnd = text.indexOf('id="scope"');
  expect(text.slice(0, tocEnd)).not.toContain("自動仕訳");
  expect(text.indexOf("自動仕訳")).toBeGreaterThan(text.indexOf('id="proposed"'));
  expect(text.slice(text.indexOf('id="features"'), text.indexOf('id="proposed"'))).not.toContain(
    "自動仕訳",
  );
});

test("validate は不正なモデルを理由付きで拒否する", () => {
  const bad = (m: unknown, reason: string) => {
    const r = cli("validate", setup(m).file);
    expect(r.code).toBe(1);
    expect(r.err).toContain(reason);
  };
  bad(model({ target: { commit: "abc123", confirmedOn: "2026-11-13" } }), "40 桁");
  bad(model({ target: { commit: COMMIT.toUpperCase(), confirmedOn: "2026-11-13" } }), "40 桁");
  bad(
    model({ evidence: [{ ...evidence[0], commit: "f".repeat(40) }, ...evidence.slice(1)] }),
    "対象版と一致しません",
  );
  bad(
    model({ evidence: [{ id: "E1", kind: "code-verified", path: "a.ts" }, ...evidence.slice(1)] }),
    "コミット ID が必要",
  );
  bad(
    model({ features: [{ name: "x", purpose: "y", flow: [{ text: "a", evidence: ["E9"] }] }] }),
    "存在しない根拠",
  );
  bad(
    model({ features: [{ name: "x", purpose: "y", flow: [{ text: "a", evidence: [] }] }] }),
    "1 件以上",
  );
  bad(
    model({
      features: [
        {
          name: "x",
          availability: "shipped",
          purpose: "y",
          flow: [{ text: "a", evidence: ["E1"] }],
        },
      ],
    }),
    "提供状況",
  );
  expect(cli("validate", setup(model()).file).code).toBe(0);
});

test("未対応の入力（比較元など）はエラーになる", () => {
  const baseline = cli("validate", setup(model({ compareTo: { commit: COMMIT } })).file);
  expect(baseline.code).toBe(1);
  expect(baseline.err).toContain("未対応");
  const s = setup(model());
  const flag = cli("generate", s.file, "--audience", "internal", "--out", s.out, "--base", "main");
  expect(flag.code).toBe(2);
  expect(existsSync(s.out)).toBe(false);
});

test("HTML 入力は実行可能な内容として出力されない", () => {
  const payload = '<script>alert(1)</script><img src=x onerror="alert(2)">';
  const m = model({ title: payload, summary: payload });
  m.features[0].name = payload;
  m.features[0].flow[0].text = payload;
  const { text } = generate(m, "internal");
  expect(text).not.toContain("<script>alert");
  expect(text).not.toContain("<img");
  expect(text).toContain("&lt;script&gt;");
});

test("既存の出力先は上書きされず失敗する", () => {
  const g = generate(model(), "internal");
  const before = readFileSync(g.html, "utf8");
  const again = cli("generate", g.file, "--audience", "internal", "--out", g.out);
  expect(again.code).toBe(1);
  expect(readFileSync(g.html, "utf8")).toBe(before);
  expect(readdirSync(g.out)).toEqual([`${COMMIT}-internal`]);
});

test("public は根拠・コミット ID・パス・シンボルを出さない", () => {
  const g = generate(model(), "public");
  expect(g.r.code).toBe(0);
  expect(g.text).not.toContain(COMMIT);
  expect(g.text).not.toContain("src/invoice/submit.ts");
  expect(g.text).not.toContain("submitInvoice");
  expect(g.text).not.toContain("<details");
  expect(g.text).toContain("v1.2");
  expect(g.text).toContain("コードで確認");
});

test("目次リンクと見出しリンクの飛び先 ID が実在する", () => {
  const { text } = generate(model(), "internal");
  const ids = new Set([...text.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  const hrefs = [...text.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  expect(hrefs.length).toBeGreaterThan(5);
  for (const h of hrefs) expect(ids.has(h)).toBe(true);
  expect(text).toContain('href="#main"'); // スキップリンク
  expect(text).toContain('<nav aria-label="機能目次">');
});

test("折りたたみは native の details で、キーボード操作と印刷展開を備える", () => {
  const { text } = generate(model(), "internal");
  expect(text).toContain("<details><summary>根拠を表示</summary>");
  expect(text).toContain(":focus-visible");
  expect(text).toContain("@media print");
  expect(text).toContain("::details-content{content-visibility:visible");
  expect(text).toContain(':target) nav a[href="#feature-1"]');
});

test("外部通信・外部フォントを前提にしない（参照なし）", () => {
  for (const audience of ["internal", "public"]) {
    const { text } = generate(model(), audience);
    expect(text).not.toMatch(/@font-face|@import|url\(|<link|<img|<iframe|src=|https?:/);
    expect(text).toContain('<html lang="ja">');
    expect(text).toMatch(/font:\s*1rem\//);
  }
});

test("状態と注意は文字でも示される（色だけに頼らない）", () => {
  const { text } = generate(model(), "public");
  expect(text).toContain("利用可能");
  expect(text).toContain("提案（現行の機能ではありません）");
  expect(text).toContain("注意");
  expect(text).toContain("未調査");
  expect(text).toContain("未確認");
});

test("public は自由記述への内部情報の混入を拒否し、成果物を残さない", () => {
  const leaks = [
    "src/invoice/submit.ts を参照する。",
    "submitInvoice を呼ぶ。",
    `版 ${COMMIT} を使う。`,
    "短縮 ID 0123abc を使う。",
    "ADR-12 に従う。",
    "issue #56 を参照。",
    "origin/feat/x ブランチ。",
  ];
  for (const leak of leaks) {
    const m = model();
    m.features[0].flow[0].text = leak;
    const g = generate(m, "public");
    expect(g.r.code).toBe(1);
    expect(existsSync(g.out)).toBe(false);
  }
  // 自由記述以外（用語集・未確認・矛盾・用語）への混入も拒否する
  for (const patch of [
    { glossary: [{ term: "t", meaning: "submitInvoice のこと" }] },
    { unconfirmed: ["src/invoice/submit.ts の挙動"] },
    { title: `ガイド ${COMMIT}` },
  ]) {
    const g = generate(model(patch), "public");
    expect(g.r.code).toBe(1);
    expect(existsSync(g.out)).toBe(false);
  }
  // internal では同じ内容でも生成できる
  const m = model();
  m.features[0].flow[0].text = "submitInvoice を呼ぶ。";
  expect(generate(m, "internal").r.code).toBe(0);
});

test("flow は Dagre の SVG 図になり、手順リスト・文章説明と同じモデルに由来する", () => {
  const { r, text } = generate(model(), "internal");
  expect(r.code).toBe(0);
  const figure = text.slice(text.indexOf("<figure"), text.indexOf("</figure>"));
  expect(figure).toContain("<svg");
  expect(figure).toContain('role="img"');
  expect(figure).toContain("viewBox=");
  // 図の手順は本文の flow と同じ文言・順序
  const first = figure.indexOf("「申請する」を押す。");
  const second = figure.indexOf("承認者へ通知される。");
  expect(first).toBeGreaterThan(-1);
  expect(second).toBeGreaterThan(first);
  // 文章による説明
  expect(figure).toContain("<figcaption");
  expect(figure).toContain("2 件の手順");
  // 提案の flow の図は、提案枠の中だけに出る
  expect(text.slice(0, text.indexOf('id="proposed"'))).not.toContain("提案中の手順です。");
  expect(text.slice(text.indexOf('id="proposed"'))).toContain("<svg");
});

test("図は拡大して読め、状態を色以外（文字と線種）でも識別できる", () => {
  const { text } = generate(model(), "internal");
  const figure = text.slice(text.indexOf("<figure"), text.indexOf("</figure>"));
  expect(figure).toContain('tabindex="0"'); // キーボードでスクロール・拡大表示できる領域
  expect(figure).toContain("コードで確認");
  expect(figure).toContain("未確認");
  expect(figure).toContain("stroke-dasharray"); // 線種でも区別する
  expect(figure).toContain("1.");
  expect(figure).toContain("2.");
});

test("図は外部通信も script も使わず、public でも内部情報を含めない", () => {
  for (const audience of ["internal", "public"]) {
    const { r, text } = generate(model(), audience);
    expect(r.code).toBe(0);
    expect(text).toContain("<svg");
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain("<script");
  }
  const pub = generate(model(), "public").text;
  expect(pub).not.toContain(COMMIT);
  expect(pub).not.toContain("submitInvoice");
});

test("配置に失敗したら明示して失敗し、図を省いた成果物を残さない", () => {
  const m = model();
  m.features[0].flow = Array.from({ length: 31 }, (_, i) => ({
    text: `手順 ${i + 1}`,
    evidence: ["E1"],
  }));
  for (const audience of ["internal", "public"]) {
    const g = generate(m, audience);
    expect(g.r.code).toBe(1);
    expect(g.r.err).toContain("図の配置に失敗");
    expect(g.r.err).toContain("請求書の申請");
    expect(existsSync(g.out)).toBe(false);
  }
});

function nestedModel() {
  const m = model();
  (m.features as unknown[]).push({
    name: "経費精算",
    availability: "available",
    purpose: "経費を精算する。",
    flow: [
      { text: "申請書を作る。", group: ["申請部門"], evidence: ["E1"] },
      { text: "上長が確認する。", group: ["申請部門", "上長"], evidence: ["E1"] },
      { text: "経理が支払う。", group: ["経理部"], evidence: ["E3"] },
    ],
  });
  return m;
}

test("入れ子の業務区分を持つ flow は ELK.js の SVG 図になり、文章説明も同じモデルに由来する", () => {
  const { r, text } = generate(nestedModel(), "internal");
  expect(r.code).toBe(0);
  const start = text.indexOf("経費精算の流れの図");
  const figure = text.slice(text.lastIndexOf("<figure", start), text.indexOf("</figure>", start));
  expect(figure).toContain("<svg");
  expect(figure).toContain('class="group"');
  for (const s of [
    "申請書を作る。",
    "上長が確認する。",
    "経理が支払う。",
    "申請部門",
    "上長",
    "経理部",
  ])
    expect(figure).toContain(s);
  // 手順リストにも区分が文字で出る
  expect(text).toContain("申請部門 / 上長");
  expect(figure).toContain("<figcaption");
  expect(figure).toContain("3 件の手順");
  expect(figure).toContain("経理部");
  expect(figure).toContain("stroke-dasharray");
  expect(figure).not.toContain("url(");
  // 区分のない既存の flow は Dagre のまま（group クラスを持たない）
  expect(text.slice(0, start)).not.toContain('class="group"');
});

test("入れ子の図も外部通信・script なしで、public に内部情報を含めない", () => {
  for (const audience of ["internal", "public"]) {
    const { r, text } = generate(nestedModel(), audience);
    expect(r.code).toBe(0);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain("<script");
    expect(text).not.toContain("url(");
  }
  const m = nestedModel();
  (m.features as any)[2].flow[0].group = ["src/billing.ts"];
  const g = generate(m, "public");
  expect(g.r.code).toBe(1);
  expect(existsSync(g.out)).toBe(false);
});

test("不正な group は理由付きで失敗する", () => {
  for (const bad of [[], [""], "経理部", [1]]) {
    const m = nestedModel();
    (m.features as any)[2].flow[0].group = bad;
    const s = setup(m);
    const r = cli("validate", s.file);
    expect(r.code).toBe(1);
    expect(r.err).toContain("group");
  }
});

test("入れ子の配置に失敗したら明示して失敗し、図を省いた成果物を残さない", () => {
  const m = nestedModel();
  (m.features as any)[2].flow[0].group = ["a", "b", "c", "d", "e"]; // 深さ上限を超える
  for (const audience of ["internal", "public"]) {
    const g = generate(m, audience);
    expect(g.r.code).toBe(1);
    expect(g.r.err).toContain("図の配置に失敗");
    expect(g.r.err).toContain("経費精算");
    expect(existsSync(g.out)).toBe(false);
  }
});

test("根拠区分と提供状況は別の軸で、同じ文書に複数の提供状況が混在する", () => {
  const m = model();
  (m.features as unknown[]).push(
    {
      name: "開発中の機能",
      availability: "in-development",
      purpose: "p",
      flow: [{ text: "手順", evidence: ["E1"] }],
    },
    { name: "状態未指定の機能", purpose: "p", flow: [{ text: "手順", evidence: ["E3"] }] },
  );
  for (const audience of ["internal", "public"]) {
    const { text } = generate(m, audience);
    const current = text.slice(text.indexOf('id="features"'), text.indexOf('id="proposed"'));
    for (const label of ["利用可能", "開発中", "不明"]) expect(current).toContain(label);
    expect(current).not.toContain("提案");
    for (const label of ["コードで確認", "承認済み判断", "未確認"])
      expect(current).toContain(label);
    expect(text).toContain("未調査");
  }
});

test("矛盾は、コード側と業務判断側の両方の根拠参照付きで表示される", () => {
  const { text } = generate(model(), "internal");
  const block = text.slice(text.indexOf('id="conflicts"'), text.indexOf('id="proposed"'));
  expect(block).toContain("<code>E1</code>");
  expect(block).toContain("src/invoice/submit.ts");
  expect(block).toContain("<code>E2</code>");
  expect(block).toContain("経理部の承認済み方針");
});

test("validate は根拠のない code-verified と、根拠区分の合わない矛盾を拒否する", () => {
  const bad = (m: unknown, reason: string) => {
    const r = cli("validate", setup(m).file);
    expect(r.code).toBe(1);
    expect(r.err).toContain(reason);
  };
  bad(
    model({
      evidence: [{ id: "E1", kind: "code-verified", commit: COMMIT }, ...evidence.slice(1)],
    }),
    "ファイルパスが必要",
  );
  const conflict = (code: string, decision: string) => ({
    conflicts: [
      {
        summary: "s",
        code: { text: "c", evidence: [code] },
        decision: { text: "d", evidence: [decision] },
      },
    ],
  });
  bad(model(conflict("E3", "E2")), "code-verified の根拠が必要");
  bad(model(conflict("E1", "E9")), "存在しない根拠");
});

const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const cmpEvidence = [
  ...evidence,
  { id: "B1", kind: "code-verified", version: "baseline", commit: BASE, path: "src/old.ts" },
];
function cmp(changes: unknown[], patch: Record<string, unknown> = {}) {
  return model({
    baseline: { commit: BASE, versionName: "v1.1", confirmedOn: "2026-10-01" },
    evidence: cmpEvidence,
    changes,
    ...patch,
  });
}
const change = (status: string, feature: string, ev: string[]) => ({
  feature,
  status,
  who: "経理担当者に",
  summary: `${feature}が${status}されます。`,
  action: `${feature}の確認が必要です。`,
  evidence: ev,
});
const allChanges = () => [
  change("added", "一括申請", ["E1"]),
  change("changed", "請求書の申請", ["E1", "B1"]),
  change("removed", "FAX 申請", ["B1"]),
  change("unchanged", "下書き保存", ["E1"]),
];

test("比較元ありで、追加・変更・削除・変更なしが誰に何が変わるかと必要な対応の形で出る", () => {
  const dir = (a: string) => `${COMMIT}-vs-${BASE}-${a}`;
  const s = setup(cmp(allChanges()));
  expect(cli("generate", s.file, "--audience", "internal", "--out", s.out).code).toBe(0);
  const text = readFileSync(join(s.out, dir("internal"), "index.html"), "utf8");
  for (const l of [
    "前回からの変更点",
    "追加",
    "変更",
    "削除",
    "変更なし",
    "誰に何が変わるか",
    "必要な対応",
  ])
    expect(text).toContain(l);
  expect(text).toContain("FAX 申請");
  expect(text).toContain("（比較元）");
  expect(text).toContain("src/old.ts");
  // 再実行は上書きせず失敗、対象版のみの出力とは別名
  expect(cli("generate", s.file, "--audience", "internal", "--out", s.out).code).toBe(1);
  expect(readdirSync(s.out)).toEqual([dir("internal")]);
});

test("比較元なしでは変更点の節が出ない", () => {
  expect(generate(model(), "internal").text).not.toContain("前回からの変更点");
});

test("根拠の版の不一致は validate が拒否する", () => {
  const bad = (m: unknown, reason: string) => {
    const r = cli("validate", setup(m).file);
    expect(r.code).toBe(1);
    expect(r.err).toContain(reason);
  };
  bad(cmp([change("added", "x", ["B1"])]), "対象版の根拠が必要");
  bad(cmp([change("removed", "x", ["E1"])]), "比較元の根拠が必要");
  bad(cmp([change("changed", "x", ["E1"])]), "比較元の根拠が必要");
  bad(cmp([change("added", "x", ["E1", "B1"])]), "比較元の根拠は使えません");
  bad(
    cmp(allChanges(), {
      evidence: [...evidence, { ...cmpEvidence[3], commit: COMMIT }],
    }),
    "比較元と一致しません",
  );
  bad(
    cmp(allChanges(), {
      features: [{ name: "x", purpose: "y", flow: [{ text: "a", evidence: ["B1"] }] }],
    }),
    "比較元のものです",
  );
  bad(model({ changes: allChanges() }), "baseline");
  bad(cmp([]), "1 件以上");
  expect(cli("validate", setup(cmp(allChanges())).file).code).toBe(0);
});

test("public の比較版にもコミット ID・パスは出ず、混入は拒否される", () => {
  const s = setup(cmp(allChanges()));
  expect(cli("generate", s.file, "--audience", "public", "--out", s.out).code).toBe(0);
  const text = readFileSync(join(s.out, `${COMMIT}-vs-${BASE}-public`, "index.html"), "utf8");
  expect(text).toContain("前回からの変更点");
  expect(text).toContain("v1.1");
  for (const x of [COMMIT, BASE, "src/old.ts", "<details"]) expect(text).not.toContain(x);
  const leaky = setup(cmp([{ ...change("added", "x", ["E1"]), summary: `比較元 ${BASE} から` }]));
  expect(cli("generate", leaky.file, "--audience", "public", "--out", leaky.out).code).toBe(1);
  expect(existsSync(leaky.out)).toBe(false);
});

test("public: 出力全体（本文・属性・コメント・title・ID）に禁止情報が出ない", () => {
  const m = model({
    evidence: [
      { ...evidence[0], note: "内部メモ-SECRETNOTE" },
      { ...evidence[1], note: "ADR-7 の判断" },
      evidence[2],
    ],
  });
  const g = generate(m, "public");
  expect(g.r.code).toBe(0);
  for (const s of [COMMIT, "src/", "submit.ts", "submitInvoice", "SECRETNOTE", "ADR-7", "<!--"])
    expect(g.text).not.toContain(s);
  expect(g.text).not.toMatch(/\b[0-9a-f]{7,40}\b/);
  expect(g.text).not.toMatch(/<script|<link|<meta http|data:/);
  expect(readdirSync(join(g.out, `${COMMIT}-public`))).toEqual(["index.html"]);
});

test("public: 公開操作名と未知の項目への混入も拒否し、internal では操作名と根拠が別々に出る", () => {
  const ops = model();
  ops.features[0].operations = ["submitInvoice"];
  const unknown = model({ embedded: { path: "src/a.ts" } });
  for (const m of [ops, unknown]) {
    const g = generate(m, "public");
    expect(g.r.code).toBe(1);
    expect(existsSync(g.out)).toBe(false);
  }
  const g = generate(model(), "internal");
  expect(g.text).toContain("申請する");
  expect(g.text).toContain("submitInvoice");
});

test("既知の限界: 拡張子形式を含む通常の文章も public では誤検知して拒否される", () => {
  const m = model();
  m.features[0].flow[0].text = "手順書.md を開く。";
  const g = generate(m, "public");
  expect(g.r.code).toBe(1);
  expect(existsSync(g.out)).toBe(false);
  expect(generate(m, "internal").r.code).toBe(0);
});
