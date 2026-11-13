// product-guide CLI: validate (モデル検証) と generate (単体 HTML 生成)。Bun と標準 API のみ。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import dagre from "../vendor/dagre.esm.js"; // 同梱 bundle。node_modules には依存しない（references/dependencies.md）

const KINDS = ["code-verified", "approved-decision", "inferred", "unverified"] as const;
const AVAILABILITY = ["available", "in-development", "proposed", "unknown"] as const;
const KIND_LABEL: Record<string, string> = {
  "code-verified": "コードで確認",
  "approved-decision": "承認済み判断",
  inferred: "推測",
  unverified: "未確認",
};
const AVAIL_LABEL: Record<string, string> = {
  available: "利用可能",
  "in-development": "開発中",
  proposed: "提案",
  unknown: "不明",
};
const STATUS_LABEL: Record<string, string> = {
  added: "追加",
  changed: "変更",
  removed: "削除",
  unchanged: "変更なし",
};
const COMMIT = /^[0-9a-f]{40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Json = unknown;
type Rec = Record<string, unknown>;
type Claim = { text: string; evidence: string[]; group?: string[] };
type Evidence = {
  id: string;
  kind: string;
  version: "target" | "baseline";
  commit?: string;
  path?: string;
  symbol?: string;
  note?: string;
};
type Feature = {
  name: string;
  availability: string;
  purpose: string;
  operations: string[];
  flow: Claim[];
  conditions: Claim[];
  exceptions: Claim[];
  constraints: Claim[];
  actions: Claim[];
};
type Change = {
  feature: string;
  status: string;
  who: string;
  summary: string;
  action: string;
  evidence: string[];
};
type Model = {
  title: string;
  summary: string;
  target: { commit: string; versionName?: string; confirmedOn: string };
  baseline?: { commit: string; versionName?: string; confirmedOn: string };
  changes: Change[];
  scope: { investigated: string[]; notInvestigated: string[] };
  evidence: Evidence[];
  glossary: { term: string; meaning: string }[];
  unconfirmed: string[];
  conflicts: { summary: string; code: Claim; decision: Claim }[];
  features: Feature[];
};

// ---- 検証 ----
function validate(input: Json): { errors: string[]; model?: Model } {
  const errors: string[] = [];
  const err = (path: string, msg: string) => {
    errors.push(`${path}: ${msg}`);
  };
  const isObj = (v: Json): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
  const obj = (v: Json, path: string, keys: string[], required: string[]): Rec | undefined => {
    if (!isObj(v)) {
      err(path, "オブジェクトである必要があります");
      return undefined;
    }
    for (const k of Object.keys(v))
      if (!keys.includes(k)) err(`${path}.${k}`, "未対応の項目です（無視せず拒否します）");
    for (const k of required) if (!(k in v)) err(`${path}.${k}`, "必須です");
    return v;
  };
  const str = (v: Json, path: string, optional = false): string => {
    if (optional && v === undefined) return "";
    if (typeof v !== "string" || v.trim() === "") {
      err(path, "空でない文字列が必要です");
      return "";
    }
    return v;
  };
  const arr = (v: Json, path: string, optional = false): Json[] => {
    if (optional && v === undefined) return [];
    if (!Array.isArray(v)) {
      err(path, "配列である必要があります");
      return [];
    }
    return v;
  };
  const strs = (v: Json, path: string, optional = false) =>
    arr(v, path, optional).map((x, i) => str(x, `${path}[${i}]`));

  const root = obj(
    input,
    "model",
    [
      "title",
      "summary",
      "target",
      "baseline",
      "changes",
      "scope",
      "evidence",
      "glossary",
      "unconfirmed",
      "conflicts",
      "features",
    ],
    ["title", "summary", "target", "scope", "evidence", "features"],
  );
  if (!root) return { errors };
  const title = str(root.title, "model.title");
  const summary = str(root.summary, "model.summary");

  const t =
    obj(
      root.target,
      "model.target",
      ["commit", "versionName", "confirmedOn"],
      ["commit", "confirmedOn"],
    ) ?? {};
  const commit = str(t.commit, "model.target.commit");
  if (commit && !COMMIT.test(commit))
    err("model.target.commit", "対象版は 40 桁の小文字 16 進のコミット ID である必要があります");
  const confirmedOn = str(t.confirmedOn, "model.target.confirmedOn");
  if (confirmedOn && !DATE.test(confirmedOn))
    err("model.target.confirmedOn", "YYYY-MM-DD 形式である必要があります");
  const versionName = str(t.versionName, "model.target.versionName", true);

  let baseline: Model["baseline"];
  if (root.baseline !== undefined) {
    const b =
      obj(
        root.baseline,
        "model.baseline",
        ["commit", "versionName", "confirmedOn"],
        ["commit", "confirmedOn"],
      ) ?? {};
    const bc = str(b.commit, "model.baseline.commit");
    if (bc && !COMMIT.test(bc))
      err(
        "model.baseline.commit",
        "比較元は 40 桁の小文字 16 進のコミット ID である必要があります",
      );
    if (bc && bc === commit) err("model.baseline.commit", "比較元が対象版と同じです");
    const bd = str(b.confirmedOn, "model.baseline.confirmedOn");
    if (bd && !DATE.test(bd))
      err("model.baseline.confirmedOn", "YYYY-MM-DD 形式である必要があります");
    baseline = {
      commit: bc,
      versionName: str(b.versionName, "model.baseline.versionName", true) || undefined,
      confirmedOn: bd,
    };
  }

  const sc =
    obj(root.scope, "model.scope", ["investigated", "notInvestigated"], ["investigated"]) ?? {};
  const scope = {
    investigated: strs(sc.investigated, "model.scope.investigated"),
    notInvestigated: strs(sc.notInvestigated, "model.scope.notInvestigated", true),
  };

  const evidence: Evidence[] = [];
  const kinds = new Map<string, string>();
  const versions = new Map<string, "target" | "baseline">();
  arr(root.evidence, "model.evidence").forEach((v, i) => {
    const p = `model.evidence[${i}]`;
    const e = obj(
      v,
      p,
      ["id", "kind", "version", "commit", "path", "symbol", "note"],
      ["id", "kind"],
    );
    if (!e) return;
    const id = str(e.id, `${p}.id`);
    const version = e.version === undefined ? "target" : e.version;
    if (version !== "target" && version !== "baseline")
      err(`${p}.version`, "根拠の版は target / baseline のいずれかです");
    if (version === "baseline" && !baseline)
      err(`${p}.version`, "baseline の根拠には model.baseline が必要です");
    const kind = str(e.kind, `${p}.kind`);
    if (kind && !(KINDS as readonly string[]).includes(kind))
      err(`${p}.kind`, `根拠区分は ${KINDS.join(" / ")} のいずれかです`);
    if (id && kinds.has(id)) err(`${p}.id`, `根拠 ID "${id}" が重複しています`);
    kinds.set(id, kind);
    versions.set(id, version === "baseline" ? "baseline" : "target");
    const ec = str(e.commit, `${p}.commit`, true);
    if (ec && !COMMIT.test(ec))
      err(`${p}.commit`, "40 桁の小文字 16 進のコミット ID である必要があります");
    if (kind === "code-verified" && !ec)
      err(`${p}.commit`, "code-verified の根拠にはコミット ID が必要です");
    if (kind === "code-verified" && !e.path)
      err(`${p}.path`, "code-verified の根拠にはファイルパスが必要です");
    const expected = version === "baseline" ? baseline?.commit : commit;
    if (ec && expected && ec !== expected)
      err(
        `${p}.commit`,
        version === "baseline"
          ? "根拠の版が比較元と一致しません"
          : "根拠の版が対象版と一致しません",
      );
    evidence.push({
      id,
      kind,
      version: version === "baseline" ? "baseline" : "target",
      commit: ec || undefined,
      path: str(e.path, `${p}.path`, true) || undefined,
      symbol: str(e.symbol, `${p}.symbol`, true) || undefined,
      note: str(e.note, `${p}.note`, true) || undefined,
    });
  });

  const claim = (v: Json, p: string, grouped = false): Claim => {
    const c =
      obj(v, p, grouped ? ["text", "evidence", "group"] : ["text", "evidence"], [
        "text",
        "evidence",
      ]) ?? {};
    let group: string[] | undefined;
    if (c.group !== undefined) {
      group = strs(c.group, `${p}.group`);
      if (Array.isArray(c.group) && group.length === 0)
        err(`${p}.group`, "業務区分は 1 段以上の文字列の配列である必要があります");
    }
    const ids = arr(c.evidence, `${p}.evidence`).map((x, i) => str(x, `${p}.evidence[${i}]`));
    if (Array.isArray(c.evidence) && ids.length === 0)
      err(`${p}.evidence`, "根拠を 1 件以上参照する必要があります");
    for (const id of ids)
      if (id && !kinds.has(id)) err(`${p}.evidence`, `存在しない根拠 "${id}" を参照しています`);
      else if (id && versions.get(id) !== "target")
        err(`${p}.evidence`, `根拠 "${id}" は比較元のものです。対象版の主張には使えません`);
    return { text: str(c.text, `${p}.text`), evidence: ids, ...(group ? { group } : {}) };
  };
  const claims = (v: Json, p: string, optional = true, grouped = false) =>
    arr(v, p, optional).map((x, i) => claim(x, `${p}[${i}]`, grouped));

  const glossary = arr(root.glossary, "model.glossary", true).map((v, i) => {
    const p = `model.glossary[${i}]`;
    const g = obj(v, p, ["term", "meaning"], ["term", "meaning"]) ?? {};
    return { term: str(g.term, `${p}.term`), meaning: str(g.meaning, `${p}.meaning`) };
  });
  const unconfirmed = strs(root.unconfirmed, "model.unconfirmed", true);
  const conflicts = arr(root.conflicts, "model.conflicts", true).map((v, i) => {
    const p = `model.conflicts[${i}]`;
    const c = obj(v, p, ["summary", "code", "decision"], ["summary", "code", "decision"]) ?? {};
    const code = claim(c.code, `${p}.code`);
    const decision = claim(c.decision, `${p}.decision`);
    if (!code.evidence.some((id) => kinds.get(id) === "code-verified"))
      err(`${p}.code`, "コード側の主張には code-verified の根拠が必要です");
    if (!decision.evidence.some((id) => kinds.get(id) === "approved-decision"))
      err(`${p}.decision`, "業務判断側の主張には approved-decision の根拠が必要です");
    return { summary: str(c.summary, `${p}.summary`), code, decision };
  });

  const changes = arr(root.changes, "model.changes", true).map((v, i): Change => {
    const p = `model.changes[${i}]`;
    const c =
      obj(
        v,
        p,
        ["feature", "status", "who", "summary", "action", "evidence"],
        ["feature", "status", "who", "summary", "action", "evidence"],
      ) ?? {};
    const status = str(c.status, `${p}.status`);
    if (status && !(status in STATUS_LABEL))
      err(`${p}.status`, `変更の種別は ${Object.keys(STATUS_LABEL).join(" / ")} のいずれかです`);
    const ids = arr(c.evidence, `${p}.evidence`).map((x, j) => str(x, `${p}.evidence[${j}]`));
    if (Array.isArray(c.evidence) && ids.length === 0)
      err(`${p}.evidence`, "根拠を 1 件以上参照する必要があります");
    for (const id of ids)
      if (id && !kinds.has(id)) err(`${p}.evidence`, `存在しない根拠 "${id}" を参照しています`);
    const has = (v: string) => ids.some((id) => versions.get(id) === v);
    const need = { added: ["target"], removed: ["baseline"], changed: ["target", "baseline"] }[
      status as string
    ];
    for (const v of need ?? [])
      if (!has(v))
        err(
          `${p}.evidence`,
          `${STATUS_LABEL[status]}には${v === "target" ? "対象版" : "比較元"}の根拠が必要です`,
        );
    if (status === "added" && has("baseline"))
      err(`${p}.evidence`, "追加に比較元の根拠は使えません");
    if (status === "removed" && has("target"))
      err(`${p}.evidence`, "削除に対象版の根拠は使えません");
    return {
      feature: str(c.feature, `${p}.feature`),
      status,
      who: str(c.who, `${p}.who`),
      summary: str(c.summary, `${p}.summary`),
      action: str(c.action, `${p}.action`),
      evidence: ids,
    };
  });
  if (changes.length && !baseline)
    err("model.changes", "変更点には model.baseline（比較元）が必要です");
  if (baseline && !changes.length)
    err("model.changes", "比較元を指定したときは変更点が 1 件以上必要です");

  const features = arr(root.features, "model.features").map((v, i): Feature => {
    const p = `model.features[${i}]`;
    const f =
      obj(
        v,
        p,
        [
          "name",
          "availability",
          "purpose",
          "operations",
          "flow",
          "conditions",
          "exceptions",
          "constraints",
          "actions",
        ],
        ["name", "purpose", "flow"],
      ) ?? {};
    const availability =
      f.availability === undefined ? "unknown" : str(f.availability, `${p}.availability`);
    if (!(AVAILABILITY as readonly string[]).includes(availability))
      err(`${p}.availability`, `提供状況は ${AVAILABILITY.join(" / ")} のいずれかです`);
    const flow = claims(f.flow, `${p}.flow`, false, true);
    if (Array.isArray(f.flow) && f.flow.length === 0) err(`${p}.flow`, "手順が 1 件以上必要です");
    return {
      name: str(f.name, `${p}.name`),
      availability,
      purpose: str(f.purpose, `${p}.purpose`),
      operations: strs(f.operations, `${p}.operations`, true),
      flow,
      conditions: claims(f.conditions, `${p}.conditions`),
      exceptions: claims(f.exceptions, `${p}.exceptions`),
      constraints: claims(f.constraints, `${p}.constraints`),
      actions: claims(f.actions, `${p}.actions`),
    };
  });

  if (errors.length) return { errors };
  return {
    errors,
    model: {
      title,
      summary,
      target: { commit, versionName: versionName || undefined, confirmedOn },
      baseline,
      changes,
      scope,
      evidence,
      glossary,
      unconfirmed,
      conflicts,
      features,
    },
  };
}

// ---- 投影 ----
// 出力に渡す項目だけを新しいデータへ写す。public は根拠・コミット ID を含めない。
function project(m: Model, audience: string) {
  const internal = audience === "internal";
  const byId = new Map(m.evidence.map((e) => [e.id, e]));
  const c = (x: Claim) => ({
    text: x.text,
    kinds: [...new Set(x.evidence.map((id) => byId.get(id)!.kind))],
    ...(x.group ? { group: x.group } : {}),
    ...(internal ? { evidence: x.evidence.map((id) => byId.get(id)!) } : {}),
  });
  const feature = (f: Feature) => ({
    name: f.name,
    availability: f.availability,
    purpose: f.purpose,
    operations: f.operations,
    flow: f.flow.map(c),
    conditions: f.conditions.map(c),
    exceptions: f.exceptions.map(c),
    constraints: f.constraints.map(c),
    actions: f.actions.map(c),
  });
  return {
    audience,
    title: m.title,
    summary: m.summary,
    version: {
      name: m.target.versionName ?? "",
      confirmedOn: m.target.confirmedOn,
      ...(internal ? { commit: m.target.commit } : {}),
    },
    ...(m.baseline
      ? {
          baseline: {
            name: m.baseline.versionName ?? "",
            confirmedOn: m.baseline.confirmedOn,
            ...(internal ? { commit: m.baseline.commit } : {}),
          },
        }
      : {}),
    changes: m.changes.map((x) => ({
      feature: x.feature,
      status: x.status,
      who: x.who,
      summary: x.summary,
      action: x.action,
      kinds: [...new Set(x.evidence.map((id) => byId.get(id)!.kind))],
      ...(internal ? { evidence: x.evidence.map((id) => byId.get(id)!) } : {}),
    })),
    scope: m.scope,
    glossary: m.glossary,
    unconfirmed: m.unconfirmed,
    conflicts: m.conflicts.map((x) => ({
      summary: x.summary,
      code: c(x.code),
      decision: c(x.decision),
    })),
    current: m.features.filter((f) => f.availability !== "proposed").map(feature),
    proposed: m.features.filter((f) => f.availability === "proposed").map(feature),
  };
}
type View = ReturnType<typeof project>;

// 最後の安全網。完全な保証ではなく、登録済みの値と典型的な形だけを検出する。
function leaks(m: Model, view: View): string[] {
  const secrets = new Set<string>([m.target.commit]);
  if (m.baseline) secrets.add(m.baseline.commit);
  for (const e of m.evidence) for (const s of [e.path, e.symbol, e.commit]) if (s) secrets.add(s);
  const patterns = [
    /\b[0-9a-f]{40}\b/,
    /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,39}\b/,
    /\bADR[- ]?\d+/i,
    /\bissues?[ #-]*\d+/i,
    /(^|[^\w&])#\d+\b/,
    /\b(?:refs\/heads|origin)\/[\w./-]+/,
    /\.(?:ts|js|mjs|py|md|json|tsx|rs|go)\b/,
  ];
  const found: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      for (const s of secrets)
        if (v.includes(s)) found.push(`${path}: 登録済みの内部情報を含みます`);
      for (const re of patterns)
        if (re.test(v)) found.push(`${path}: 内部情報の形式 ${re} に一致します`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(view, "出力");
  return found;
}

// ---- HTML ----
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#555;--line:#c8c8c8;--accent:#0b5cad}
@media(prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--muted:#aaa;--line:#444;--accent:#7ab7ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:1rem/1.85 "Hiragino Sans","Noto Sans JP","Yu Gothic",Meiryo,system-ui,sans-serif;overflow-wrap:anywhere;word-break:auto-phrase}h1,h2,h3{text-wrap:balance}p,li,figcaption{text-wrap:pretty}
main{max-width:42rem;margin:0 auto;padding:1rem 1.25rem 4rem}
h1{font-size:1.75rem;line-height:1.4}h2{font-size:1.4rem;border-bottom:2px solid var(--line);padding-bottom:.25rem;margin-top:2.5rem}h3{font-size:1.15rem;margin-top:1.75rem}
a{color:var(--accent)}a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.badge{display:inline-block;border:1px solid var(--fg);border-radius:.25rem;padding:0 .4rem;margin-left:.4rem;font-size:.875rem;line-height:1.6}
.muted{color:var(--muted)}.box{border:1px solid var(--line);border-left:6px solid var(--fg);padding:.5rem 1rem;margin:1rem 0}
details{margin:.25rem 0 .75rem}summary{cursor:pointer}ol,ul{padding-left:1.5rem}code{font-family:ui-monospace,monospace}
section[id],h2,h3{scroll-margin-top:1rem}
.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:1rem;background:var(--bg);padding:.25rem .5rem;z-index:2}
.box>strong:first-child{display:block}.box>strong:first-child::before{content:"\\26A0 "}
main:focus{outline:none}
@media(min-width:88rem){nav{position:fixed;top:1rem;left:1rem;width:14rem;max-height:calc(100vh - 2rem);overflow:auto;font-size:.9375rem}nav h2{margin-top:0;font-size:1.1rem}}
figure.flow{margin:1rem 0}.diagram{overflow:auto;border:1px solid var(--line);padding:.5rem}.diagram:focus-visible{outline:3px solid var(--accent)}svg{display:block;max-width:none;color:var(--fg)}svg text{fill:var(--fg)}svg .node rect{fill:var(--bg);stroke:var(--fg);stroke-width:2}svg .edge{fill:none;stroke:var(--fg);stroke-width:2}svg .head{fill:var(--fg)}svg .group rect{fill:none;stroke:var(--muted);stroke-width:2}figcaption{color:var(--muted)}
@media print{details:not([open])::details-content{content-visibility:visible;display:block}body{background:#fff;color:#000;font-size:11pt;line-height:1.7}nav{position:static}a{color:inherit;text-decoration:none}main{max-width:none;padding:0}.skip{display:none}li,.box{break-inside:avoid}h2,h3,h4{break-after:avoid}.diagram{overflow:visible}svg{max-width:100%;height:auto}}`;

// ---- 流れの図（Dagre） ----
const MAX_STEPS = 30; // これを超える流れは単純フローとして読めないので、配置せず失敗させる。
const DASH: Record<string, string> = {
  "code-verified": "",
  "approved-decision": "6 3",
  inferred: "2 3",
  unverified: "1 5",
};
const PX = 14; // 本文の文字サイズ（px）
const textWidth = (s: string) =>
  [...s].reduce((w, ch) => w + (ch.charCodeAt(0) < 256 ? PX * 0.6 : PX), 0);
function wrap(s: string, max: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (cur && textWidth(cur + ch) > max) {
      lines.push(cur);
      cur = "";
    }
    cur += ch;
  }
  return [...lines, cur];
}

type Step = { text: string; kinds: string[]; group?: string[] };
const layoutFail = (name: string, why: string): never => {
  throw new Error(`図の配置に失敗しました（機能「${name}」: ${why}）`);
};
const num = (name: string, n: number | undefined) =>
  n === undefined || !Number.isFinite(n)
    ? layoutFail(name, "配置結果の座標が不正です")
    : Math.round(n * 10) / 10;

// 手順の枠の寸法・文言・線種。Dagre と ELK.js の図で共有する。
function stepBox(s: Step, i: number) {
  const body = wrap(`${i + 1}. ${s.text}`, 280);
  const label = s.kinds.map((k) => KIND_LABEL[k]).join("・");
  return {
    body,
    label,
    width: Math.max(...body.map(textWidth), textWidth(label)) + 24,
    height: (body.length + 1) * 20 + 16,
    dash: DASH[KINDS.filter((k) => s.kinds.includes(k)).pop()!], // 最も確かでない区分で線種を決める
  };
}
type Box = ReturnType<typeof stepBox>;

function nodeSvg(name: string, b: Box, n: { x: number; y: number; width: number; height: number }) {
  const [x, y, w, h] = [n.x, n.y, n.width, n.height].map((v) => num(name, v));
  const lines = [...b.body, b.label];
  const texts = lines
    .map(
      (l, j) =>
        `<text x="${num(name, x + 12)}" y="${num(name, y + 24 + j * 20)}"${j === lines.length - 1 ? ' font-weight="bold"' : ""}>${esc(l)}</text>`,
    )
    .join("");
  return `<g class="node"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"${b.dash ? ` stroke-dasharray="${b.dash}"` : ""}/>${texts}</g>`;
}

function edgeSvg(name: string, p: { x: number; y: number }[]) {
  const [q, e] = [p[p.length - 2], p[p.length - 1]];
  const a = Math.atan2(e.y - q.y, e.x - q.x);
  const wing = (d: number) =>
    `${num(name, e.x - 9 * Math.cos(a - d))},${num(name, e.y - 9 * Math.sin(a - d))}`;
  return (
    `<polyline class="edge" points="${p.map((t) => `${num(name, t.x)},${num(name, t.y)}`).join(" ")}"/>` +
    `<polygon class="head" points="${num(name, e.x)},${num(name, e.y)} ${wing(0.4)} ${wing(-0.4)}"/>`
  );
}

function figureSvg(
  name: string,
  id: string,
  size: { width?: number; height?: number },
  body: string,
  caption: string,
) {
  const W = num(name, size.width);
  const H = num(name, size.height);
  return (
    `<figure class="flow"><div class="diagram" tabindex="0" role="region" aria-label="${esc(name)}の流れの図（スクロールできます）">` +
    `<svg role="img" aria-labelledby="${id}-title" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-size="${PX}">` +
    `<title id="${id}-title">${esc(name)}の流れの図</title>${body}</svg></div><figcaption>${esc(caption)}</figcaption></figure>`
  );
}

const firstLast = (steps: Step[]) =>
  `最初は「${steps[0].text}」、最後は「${steps[steps.length - 1].text}」です。`;
const STATE_NOTE =
  "各手順の枠には番号と根拠区分の文字があり、根拠区分は枠線の種類（実線・破線・点線）でも区別できます。";

// flow の手順を上から下へ並べた SVG を返す。配置できなければ例外（呼び出し側が生成を止める）。
function flowDiagram(name: string, steps: Step[], id: string) {
  if (steps.length > MAX_STEPS)
    layoutFail(name, `手順が ${MAX_STEPS} 件を超え、単純フローとして配置できません`);
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 24, ranksep: 36, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  const boxes = steps.map((s, i) => {
    const b = stepBox(s, i);
    g.setNode(`n${i}`, { width: b.width, height: b.height });
    if (i) g.setEdge(`n${i - 1}`, `n${i}`);
    return b;
  });
  try {
    dagre.layout(g);
  } catch (e) {
    layoutFail(name, (e as Error).message);
  }
  const nodes = boxes.map((b, i) => {
    const n = g.node(`n${i}`);
    return nodeSvg(name, b, { ...n, x: n.x - n.width / 2, y: n.y - n.height / 2 });
  });
  const edges = steps.slice(1).map((_, i) => edgeSvg(name, g.edge(`n${i}`, `n${i + 1}`).points));
  const caption = `この図は ${steps.length} 件の手順を上から下へ順に示します。${firstLast(steps)}${STATE_NOTE}`;
  return figureSvg(name, id, g.graph(), edges.join("") + nodes.join(""), caption);
}

// ---- 入れ子の流れの図（ELK.js） ----
const MAX_GROUP_DEPTH = 4;
type ElkNode = {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNode[];
  edges?: ElkEdge[];
  layoutOptions?: Record<string, string>;
};
type ElkEdge = {
  id: string;
  sources: string[];
  targets: string[];
  sections?: {
    startPoint: { x: number; y: number };
    bendPoints?: { x: number; y: number }[];
    endPoint: { x: number; y: number };
  }[];
};

// ELK.js は入れ子のフローを描くときだけ読む。同期実行の worker は `self` があると worker 側として
// 動いてしまう（Bun は `self` を持つ）ため、読み込み中だけ `self` を隠す。
async function elk(): Promise<{ layout(g: object): Promise<object> }> {
  const g = globalThis as { self?: unknown };
  const saved = g.self;
  g.self = undefined;
  try {
    const { default: Api } = await import("../vendor/elk-api.js");
    const { Worker } = await import("../vendor/elk-worker.min.js");
    return new Api({ workerFactory: (url: string) => new Worker(url) });
  } finally {
    g.self = saved;
  }
}

// 入れ子の業務区分（group）を持つ flow を、区分の枠で囲んだ SVG にする。配置できなければ例外。
async function nestedFlowDiagram(name: string, steps: Step[], id: string) {
  if (steps.length > MAX_STEPS) layoutFail(name, `手順が ${MAX_STEPS} 件を超え、配置できません`);
  if (steps.some((s) => (s.group?.length ?? 0) > MAX_GROUP_DEPTH))
    layoutFail(name, `業務区分の入れ子が ${MAX_GROUP_DEPTH} 段を超え、配置できません`);
  const boxes = steps.map(stepBox);
  const root: ElkNode = {
    id: "root",
    children: [],
    edges: [],
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
      "elk.padding": "[top=16,left=16,bottom=16,right=16]",
      "elk.spacing.nodeNode": "24",
      "elk.layered.spacing.nodeNodeBetweenLayers": "36",
    },
  };
  const groups = new Map<string, { node: ElkNode; label: string }>();
  // 同じ区分でも、手順が連続している間だけ 1 つの枠にする。離れた手順を 1 枠へ集めると、
  // 区分をまたいで往復する流れで矢印が枠の外を大きく迂回し、上から下への順に読めなくなる。
  const live: { label: string; node: ElkNode }[] = [];
  const parentOf = (path: string[]): ElkNode => {
    let common = 0;
    while (common < live.length && common < path.length && live[common].label === path[common])
      common++;
    live.length = common;
    for (const label of path.slice(common)) {
      const node: ElkNode = {
        id: `g${groups.size}`,
        children: [],
        layoutOptions: {
          "elk.padding": "[top=32,left=12,bottom=12,right=12]",
          "elk.nodeSize.constraints": "MINIMUM_SIZE",
          "elk.nodeSize.minimum": `(${textWidth(label) + 24},40)`,
        },
      };
      groups.set(node.id, { node, label });
      (live.at(-1)?.node ?? root).children!.push(node);
      live.push({ label, node });
    }
    return live.at(-1)?.node ?? root;
  };
  steps.forEach((s, i) => {
    parentOf(s.group ?? []).children!.push({
      id: `n${i}`,
      width: boxes[i].width,
      height: boxes[i].height,
    });
    if (i) root.edges!.push({ id: `e${i}`, sources: [`n${i - 1}`], targets: [`n${i}`] });
  });
  let laid: ElkNode;
  try {
    laid = (await (await elk()).layout(root)) as ElkNode;
  } catch (e) {
    return layoutFail(name, (e as Error).message);
  }
  const found = new Map<string, ElkNode>();
  const collect = (n: ElkNode) => {
    found.set(n.id, n);
    n.children?.forEach(collect);
  };
  collect(laid);
  const at = (nid: string) => found.get(nid) ?? layoutFail(name, "配置結果に枠がありません");
  const frames = [...groups.values()]
    .map(({ node, label }) => {
      const n = at(node.id);
      const [x, y, w, h] = [n.x, n.y, n.width, n.height].map((v) => num(name, v));
      return `<g class="group"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" stroke-dasharray="10 4"/><text x="${num(name, x + 12)}" y="${num(name, y + 22)}" font-weight="bold">${esc(label)}</text></g>`;
    })
    .join("");
  const nodes = boxes.map((b, i) => nodeSvg(name, b, at(`n${i}`) as Required<ElkNode>));
  const edges = (laid.edges ?? []).map((e) => {
    const sec = e.sections?.[0];
    if (!sec) return layoutFail(name, "配置結果に矢印の経路がありません");
    return edgeSvg(name, [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint]);
  });
  const names = [...new Set(steps.flatMap((s) => s.group ?? []))];
  const caption = `この図は ${steps.length} 件の手順を、業務区分（${names.join("、")}）の枠で囲んで上から下へ順に示します。入れ子の区分は外側の枠の中に内側の枠が入ります。${firstLast(steps)}${STATE_NOTE}`;
  return figureSvg(name, id, laid, frames + edges.join("") + nodes.join(""), caption);
}

async function render(v: View): Promise<string> {
  const nested = new Map<unknown, string>(); // group を持つ flow だけ ELK.js（非同期）で先に配置する
  for (const [i, f] of [...v.current, ...v.proposed].entries())
    if (f.flow.some((c) => "group" in c))
      nested.set(f, await nestedFlowDiagram(f.name, f.flow, `nested-${i}-flow`));
  // 現在位置: 目次から飛んだ節（:target）を、文字の印（▶）と太字で示す。script は使わない。
  const sel = v.current.map(
    (_, i) => `body:has(#feature-${i + 1}:target) nav a[href="#feature-${i + 1}"]`,
  );
  const current = sel.length
    ? `${sel.join(",")}{font-weight:700}${sel.map((x) => `${x}::before`).join(",")}{content:"\\25B6 "}`
    : "";
  const internal = v.audience === "internal";
  const badges = (kinds: string[]) =>
    kinds.map((k) => `<span class="badge">${esc(KIND_LABEL[k])}</span>`).join("");
  const ev = (c: { evidence?: Evidence[] }) =>
    !internal || !c.evidence
      ? ""
      : `<details><summary>根拠を表示</summary><ul>${c.evidence
          .map(
            (e) =>
              `<li><code>${esc(e.id)}</code> ${esc(KIND_LABEL[e.kind])}${v.baseline ? (e.version === "baseline" ? "（比較元）" : "（対象版）") : ""}${e.path ? ` ${esc(e.path)}` : ""}${e.symbol ? ` <code>${esc(e.symbol)}</code>` : ""}${e.commit ? ` @<code>${esc(e.commit)}</code>` : ""}${e.note ? ` - ${esc(e.note)}` : ""}</li>`,
          )
          .join("")}</ul></details>`;
  type F = (typeof v.current)[number];
  type C = F["flow"][number];
  const list = (tag: "ol" | "ul", items: C[]) =>
    items.length
      ? `<${tag}>${items.map((c) => `<li>${"group" in c ? `<span class="muted">［${esc((c as { group: string[] }).group.join(" / "))}］</span>` : ""}${esc(c.text)}${badges(c.kinds)}${ev(c)}</li>`).join("")}</${tag}>`
      : "";
  const section = (label: string, items: C[]) =>
    items.length ? `<h4>${label}</h4>${list("ul", items)}` : "";
  const feature = (f: F, id: string) =>
    `<section id="${id}"><h3><a href="#${id}">${esc(f.name)}</a><span class="badge">${AVAIL_LABEL[f.availability]}</span></h3><p>${esc(f.purpose)}</p>` +
    (f.operations.length
      ? `<h4>画面上の表記</h4><ul>${f.operations.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>`
      : "") +
    `<h4>通常の流れ</h4>${list("ol", f.flow)}${nested.get(f) ?? flowDiagram(f.name, f.flow, `${id}-flow`)}${section("条件", f.conditions)}${section("例外", f.exceptions)}${section("制約", f.constraints)}${section("必要な対応", f.actions)}</section>`;
  const ver = `${v.version.name ? `${esc(v.version.name)} / ` : ""}確認日 ${esc(v.version.confirmedOn)}`;
  const changes = v.baseline
    ? `<section id="changes"><h2><a href="#changes">前回からの変更点</a></h2><p class="muted">比較元: ${v.baseline.name ? `${esc(v.baseline.name)} / ` : ""}確認日 ${esc(v.baseline.confirmedOn)}${internal && v.baseline.commit ? ` / コミット <code>${esc(v.baseline.commit)}</code>` : ""}</p>${v.changes
        .map(
          (c) =>
            `<div class="box"><h3>${esc(c.feature)}<span class="badge">${STATUS_LABEL[c.status]}</span></h3><ul><li>誰に何が変わるか: ${esc(c.who)} ${esc(c.summary)}${badges(c.kinds)}</li><li>必要な対応: ${esc(c.action)}</li></ul>${ev(c)}</div>`,
        )
        .join("")}</section>`
    : "";
  const toc = v.current
    .map(
      (f, i) =>
        `<li><a href="#feature-${i + 1}">${esc(f.name)}</a><span class="badge">${AVAIL_LABEL[f.availability]}</span></li>`,
    )
    .join("");
  const conflicts = v.conflicts.length
    ? `<section id="conflicts"><h2><a href="#conflicts">コードと業務判断の食い違い</a></h2>${v.conflicts
        .map(
          (c) =>
            `<div class="box"><strong>注意</strong><p>${esc(c.summary)}</p><ul><li>コード: ${esc(c.code.text)}${ev(c.code)}</li><li>業務判断: ${esc(c.decision.text)}${ev(c.decision)}</li></ul></div>`,
        )
        .join("")}</section>`
    : "";
  const proposed = v.proposed.length
    ? `<section id="proposed"><h2><a href="#proposed">提案（現行の機能ではありません）</a></h2>${v.proposed.map((f, i) => feature(f, `proposed-${i + 1}`)).join("")}</section>`
    : "";
  const notInv = v.scope.notInvestigated.length
    ? `<ul>${v.scope.notInvestigated.map((s) => `<li>${esc(s)}<span class="badge">未調査</span></li>`).join("")}</ul>`
    : "<p>未調査として宣言された機能はありません。</p>";
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(v.title)}</title><style>${CSS}${current}</style></head>
<body><a class="skip" href="#main">本文へ移動</a><main id="main" tabindex="-1">
<h1>${esc(v.title)}</h1><p>${esc(v.summary)}</p>
<p class="muted">対象版: ${ver}${internal && v.version.commit ? ` / コミット <code>${esc(v.version.commit)}</code>` : ""}</p>
${changes}
<nav aria-label="機能目次"><h2>機能目次</h2><ul>${toc}</ul></nav>
<section id="scope"><h2><a href="#scope">調査範囲</a></h2><h4>調査した機能</h4><ul>${v.scope.investigated.map((s) => `<li>${esc(s)}</li>`).join("")}</ul><h4>未調査</h4>${notInv}</section>
<section id="features"><h2><a href="#features">機能</a></h2>${v.current.map((f, i) => feature(f, `feature-${i + 1}`)).join("")}</section>
${conflicts}${proposed}
<section id="unconfirmed"><h2><a href="#unconfirmed">未確認事項</a></h2>${v.unconfirmed.length ? `<ul>${v.unconfirmed.map((u) => `<li>${esc(u)}<span class="badge">未確認</span></li>`).join("")}</ul>` : "<p>なし</p>"}</section>
<section id="glossary"><h2><a href="#glossary">用語集</a></h2><dl>${v.glossary.map((g) => `<dt>${esc(g.term)}</dt><dd>${esc(g.meaning)}</dd>`).join("")}</dl></section>
</main></body></html>
`;
}

// ---- CLI ----
const usage = `使い方:
  product-guide validate <model.json>
  product-guide generate <model.json> --audience internal|public --out <出力親ディレクトリ>`;
// 比較元はモデルの baseline で指定する（CLI 引数では受けない）。
const fail = (code: number, ...lines: string[]): never => {
  console.error(lines.join("\n"));
  process.exit(code);
};

function load(path: string): Model {
  let json: Json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return fail(1, `${path}: モデルを読めません（${(e as Error).message}）`);
  }
  const { errors, model } = validate(json);
  if (!model) return fail(1, ...errors);
  return model;
}

const [command, file, ...rest] = process.argv.slice(2);
if (command === "validate" && file && rest.length === 0) {
  load(file);
  console.log("ok");
} else if (command === "generate" && file) {
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if ((k !== "--audience" && k !== "--out") || rest[i + 1] === undefined || opts.has(k))
      fail(2, `未対応または不正な引数: ${k}`, usage);
    opts.set(k, rest[i + 1]);
  }
  const audience = opts.get("--audience");
  const out = opts.get("--out");
  if ((audience !== "internal" && audience !== "public") || !out) fail(2, usage);
  const model = load(file);
  const view = project(model, audience as string);
  if (audience === "public") {
    const found = leaks(model, view);
    if (found.length)
      fail(1, "public に出せない内部情報が見つかりました。成果物は作成しません。", ...found);
  }
  let html = "";
  try {
    html = await render(view); // 図の配置失敗はここで止め、書込み前なので成果物は残らない。
  } catch (e) {
    fail(1, (e as Error).message);
  }
  const parent = resolve(out as string);
  const dir = join(
    parent,
    `${model.target.commit}${model.baseline ? `-vs-${model.baseline.commit}` : ""}-${audience}`,
  );
  mkdirSync(parent, { recursive: true });
  try {
    mkdirSync(dir); // 既存なら EEXIST。強制上書きは提供しない。
  } catch {
    fail(1, `出力先が既に存在します。上書きしません: ${basename(dir)}`);
  }
  try {
    writeFileSync(join(dir, "index.html"), html, { flag: "wx" });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    fail(1, `書込みに失敗しました: ${(e as Error).message}`);
  }
  console.log(join(dir, "index.html"));
} else fail(2, usage);
