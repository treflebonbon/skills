import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
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

test("未対応の入力（比較元など）は理由付きでエラーになり、1 つ手前の入力は通る", () => {
  const baseline = cli("validate", setup(model({ compareTo: { commit: COMMIT } })).file);
  expect(baseline.code).toBe(1);
  expect(baseline.err).toContain("model.compareTo: 未対応の項目です");
  const s = setup(model());
  const flag = cli("generate", s.file, "--audience", "internal", "--out", s.out, "--base", "main");
  expect(flag.code).toBe(2);
  expect(flag.err).toContain("未対応または不正な引数: --base");
  expect(existsSync(s.out)).toBe(false);
  const ok = cli("generate", s.file, "--audience", "internal", "--out", s.out);
  expect(ok.code).toBe(0);
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

test("public は自由記述への内部情報の混入を、形式ごとに拒否メッセージ付きで拒否し、1 つ手前は通す", () => {
  const publicFlow = (text: string) => {
    const m = model();
    m.features[0].flow[0].text = text;
    return generate(m, "public");
  };
  // [混入する文, 期待するメッセージ, 境界の 1 つ手前（同じ形式に一致しない）]
  const cases: [string, string, string][] = [
    ["src/invoice/submit.ts を参照する。", "登録済みの内部情報", "src を参照する。"],
    ["submitInvoice を呼ぶ。", "登録済みの内部情報", "submit を呼ぶ。"],
    [`版 ${COMMIT} を使う。`, "登録済みの内部情報", "版 0123 を使う。"],
    [`版 ${"f".repeat(40)} を使う。`, "{40}", `版 ${"f".repeat(41)} を使う。`],
    ["短縮 ID 0123abc を使う。", "{7,39}", "短縮 ID 0123ab を使う。"],
    ["ADR-12 に従う。", "ADR", "ADR に従う。"],
    ["issue 56 を参照。", "issues?", "issue を参照。"],
    ["手順 #56 を参照。", "#", "手順 #タグ を参照。"],
    ["origin/feat/x ブランチ。", "origin", "origin の説明。"],
    ["手順書.md を開く。", "(?:ts|js", "手順書を開く。"],
  ];
  for (const [leak, message, ok] of cases) {
    const g = publicFlow(leak);
    expect(g.r.code, leak).toBe(1);
    expect(g.r.err, leak).toContain("出力.current[0].flow[0].text");
    expect(g.r.err, leak).toContain(message);
    expect(g.r.err, leak).toMatch(/登録済みの内部情報|内部情報の形式/);
    expect(existsSync(g.out), leak).toBe(false);
    expect(publicFlow(ok).r.code, ok).toBe(0);
  }
  // 自由記述以外（用語集・未確認・題名）への混入も、出力上の位置付きで拒否する
  const others: [Record<string, unknown>, string][] = [
    [{ glossary: [{ term: "t", meaning: "submitInvoice のこと" }] }, "出力.glossary[0].meaning"],
    [{ unconfirmed: ["src/invoice/submit.ts の挙動"] }, "出力.unconfirmed[0]"],
    [{ title: `ガイド ${COMMIT}` }, "出力.title"],
  ];
  for (const [patch, where] of others) {
    const g = generate(model(patch), "public");
    expect(g.r.code).toBe(1);
    expect(g.r.err).toContain(where);
    expect(g.r.err).toContain("登録済みの内部情報");
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

// ---- #74: 実文の fixture と、表示の磨き込み（実ブラウザでの確認は docs/verification.md） ----
const FIXTURE = JSON.parse(
  readFileSync(resolve(root, "tests/fixtures/product-guide-model.json"), "utf8"),
);
const FIXTURE_COMMIT = FIXTURE.target.commit as string;

function generateFixture(audience: string) {
  const s = setup(FIXTURE);
  const r = cli("generate", s.file, "--audience", audience, "--out", s.out);
  const html = join(s.out, `${FIXTURE_COMMIT}-${audience}`, "index.html");
  return { ...s, r, text: existsSync(html) ? readFileSync(html, "utf8") : "" };
}

test("実文の fixture: internal と public の両方が生成でき、public に内部情報・実行可能な内容がない", () => {
  const i = generateFixture("internal");
  const p = generateFixture("public");
  expect(i.r.code).toBe(0);
  expect(p.r.code).toBe(0);
  expect(i.text).toContain("src/loan/request.ts");
  for (const s of [FIXTURE_COMMIT, "src/loan", "requestLoan", "returnItem", "extendLoan"])
    expect(p.text).not.toContain(s);
  for (const t of [i.text, p.text]) expect(t).not.toMatch(/<script|<meta http|url\(|https?:\/\//);
  // 長い見出しは省略せず、目次と本文の両方に出る。提案は現行の節に出ない。
  const long = FIXTURE.features[2].name as string;
  expect(p.text.split(long).length - 1).toBeGreaterThanOrEqual(2);
  expect(p.text.slice(0, p.text.indexOf('id="proposed"'))).not.toContain("備品の自動予約");
  expect(p.text).toContain("<svg");
});

test("読みやすさ: 本文 1rem 以上・行長の上限・目次固定の下限幅・日本語の折返しを CSS で指定する", () => {
  const { text } = generateFixture("public");
  expect(text).toMatch(/font:1rem\/1\.85 /);
  expect(text).toContain("main{max-width:42rem;");
  // 固定の目次(14rem)と本文(42rem)が重ならない幅からだけ固定する。
  expect(text).toContain("@media(min-width:88rem){nav{position:fixed");
  expect(text).toContain("word-break:auto-phrase");
  expect(text).toContain("overflow-wrap:anywhere");
});

test("入れ子の図: 区分をまたいで往復する流れは、連続する手順ごとに別の枠になる", () => {
  const { text } = generateFixture("public");
  // 「備品を借りる」の流れは 社員 → 上長 → 社員。同じ区分でも離れた手順は別の枠。
  const feature = text.slice(text.indexOf('id="feature-1"'), text.indexOf('id="feature-2"'));
  expect(feature.match(/<g class="group">/g)?.length).toBe(3);
  expect(feature.match(/>社員<\/text>/g)?.length).toBe(2);
});

// ---- validate / generate の境界値（拒否メッセージと、1 つ手前の通る対比） ----
const rejects = (m: unknown, reason: string) => {
  const r = cli("validate", setup(m).file);
  expect(r.code, reason).toBe(1);
  expect(r.err, reason).toContain(reason);
};
const accepts = (m: unknown) => {
  const r = cli("validate", setup(m).file);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
};

test("changes は status ごとに必要な版の根拠を要求し、満たせば通る", () => {
  const one = (status: string, ev: string[]) => cmp([change(status, "請求書の申請", ev)]);
  rejects(one("added", ["B1"]), "追加には対象版の根拠が必要です");
  rejects(one("added", ["E1", "B1"]), "追加に比較元の根拠は使えません");
  rejects(one("removed", ["E1"]), "削除には比較元の根拠が必要です");
  rejects(one("removed", ["E1", "B1"]), "削除に対象版の根拠は使えません");
  rejects(one("changed", ["E1"]), "変更には比較元の根拠が必要です");
  rejects(one("changed", ["B1"]), "変更には対象版の根拠が必要です");
  rejects(one("moved", ["E1"]), "変更の種別は");
  accepts(one("added", ["E1"]));
  accepts(one("removed", ["B1"]));
  accepts(one("changed", ["E1", "B1"]));
  accepts(one("unchanged", ["B1"]));
});

test("比較元が対象版と同じコミットなら拒否し、1 文字違えば通る", () => {
  const withBase = (commit: string) =>
    cmp(allChanges(), {
      baseline: { commit, confirmedOn: "2026-10-01" },
      evidence: [...evidence, { ...cmpEvidence[3], commit }],
    });
  rejects(withBase(COMMIT), "比較元が対象版と同じです");
  accepts(withBase(`${COMMIT.slice(0, 39)}8`));
});

const manySteps = (n: number, group?: string[]) =>
  Array.from({ length: n }, (_, i) => ({
    text: `手順 ${i + 1}`,
    evidence: ["E1"],
    ...(group ? { group } : {}),
  }));

test("手順数の上限 MAX_STEPS は 30 件まで通り、31 件で拒否される（単純・入れ子とも）", () => {
  for (const group of [undefined, ["区分"]]) {
    const at = (n: number) => {
      const m = model();
      m.features[0].flow = manySteps(n, group);
      return generate(m, "internal");
    };
    expect(at(30).r.code).toBe(0);
    const over = at(31);
    expect(over.r.code).toBe(1);
    expect(over.r.err).toContain("手順が 30 件を超え");
    expect(over.r.err).toContain("請求書の申請");
    expect(existsSync(over.out)).toBe(false);
  }
});

test("業務区分の深さ MAX_GROUP_DEPTH は 4 段まで通り、5 段で拒否される", () => {
  const at = (depth: number) => {
    const m = model();
    m.features[0].flow = manySteps(2, ["a", "b", "c", "d", "e"].slice(0, depth));
    return generate(m, "internal");
  };
  expect(at(4).r.code).toBe(0);
  const over = at(5);
  expect(over.r.code).toBe(1);
  expect(over.r.err).toContain("業務区分の入れ子が 4 段を超え");
  expect(existsSync(over.out)).toBe(false);
});

// ---- 提案の機能は変更点（現行の変更）に載らない ----
test("proposed の機能は removed 以外の changes に載せられず、現行の機能なら通る", () => {
  const proposed = "自動仕訳"; // model() で availability: proposed
  const reason = "proposed のため";
  rejects(cmp([change("added", proposed, ["E1"])]), reason);
  rejects(cmp([change("changed", proposed, ["E1", "B1"])]), reason);
  rejects(cmp([change("unchanged", proposed, ["E1"])]), reason);
  accepts(cmp([change("removed", proposed, ["B1"])]));
  accepts(cmp([change("added", "請求書の申請", ["E1"])]));
});

// ---- 出力先の作成 ----
const dirPerm = (dir: string, mode: number) => chmodSync(dir, mode);

test("出力先を作れない理由は実際のエラーで報告し、既存扱いにしない", () => {
  const s = setup(model());
  writeFileSync(s.out, "file"); // --out が通常ファイル
  const underFile = cli("generate", s.file, "--audience", "internal", "--out", join(s.out, "sub"));
  expect(underFile.code).toBe(1);
  expect(underFile.err).toContain("出力先を作成できません");
  expect(underFile.err).not.toContain("既に存在");
  expect(readFileSync(s.out, "utf8")).toBe("file");
});

test.skipIf(process.getuid?.() === 0)(
  "親ディレクトリが書込み不可なら権限エラーを報告し、何も残さない",
  () => {
    const s = setup(model());
    mkdirSync(s.out);
    dirPerm(s.out, 0o555);
    try {
      const r = cli("generate", s.file, "--audience", "internal", "--out", s.out);
      expect(r.code).toBe(1);
      expect(r.err).toContain("EACCES");
      expect(r.err).not.toContain("既に存在");
      expect(readdirSync(s.out)).toEqual([]);
    } finally {
      dirPerm(s.out, 0o755);
    }
    // 対比: 書込み可なら通り、同じ出力先の再実行は「既に存在」で拒否される
    expect(cli("generate", s.file, "--audience", "internal", "--out", s.out).code).toBe(0);
    const again = cli("generate", s.file, "--audience", "internal", "--out", s.out);
    expect(again.code).toBe(1);
    expect(again.err).toContain("既に存在");
  },
);

test("検査や描画に失敗したら、存在しない親ディレクトリも作らない", () => {
  const m = model();
  m.features[0].flow[0].text = "submitInvoice を呼ぶ。";
  const s = setup(m);
  const deep = join(s.dir, "a", "b");
  const r = cli("generate", s.file, "--audience", "public", "--out", deep);
  expect(r.code).toBe(1);
  expect(existsSync(join(s.dir, "a"))).toBe(false);
  const bad = model();
  bad.features[0].flow = manySteps(31);
  expect(cli("generate", setup(bad).file, "--audience", "internal", "--out", deep).code).toBe(1);
  expect(existsSync(join(s.dir, "a"))).toBe(false);
});
