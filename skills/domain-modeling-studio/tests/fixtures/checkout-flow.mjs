// ROP function-flow layer for the TypeScript Effect and Rust checkout
// fixtures (references/rop-semantics.md), grounded in real evidence lines in
// effect-checkout.ts.fixture / rust-checkout.rs.fixture. Shared by the
// schema/evidence test (model.test.mjs) and the real-generated-content
// drilldown check (real-content.test.mjs, browser-real-content.mjs).
export const FIXTURE_REVISION = "0".repeat(40);
export const TS_PATH =
  "skills/domain-modeling-studio/tests/fixtures/effect-checkout.ts.fixture";
export const RS_PATH =
  "skills/domain-modeling-studio/tests/fixtures/rust-checkout.rs.fixture";

export const flowNode = (id, kind, extra = {}) => ({
  data: { evidence: [], kind, label: id, origin: "inference", ...extra },
  height: 90,
  id,
  position: { x: 40, y: 80 },
  width: 180,
});
export const edge = (id, source, target, label) => ({
  data: { evidence: [], origin: "inference" },
  id,
  label,
  source,
  target,
});
const ref = (path, symbol, line) => ({
  line,
  path,
  revision: FIXTURE_REVISION,
  symbol,
});

export const checkoutFunctionFlow = () => {
  const businessNode = flowNode("checkout-flow", "COMMAND", {
    label: "注文を確定する",
  });
  const nodes = [
    businessNode,
    // Effect: bind (reserve/charge), recovery scoped to reserve's OutOfStock,
    // a synthetic bypass around catchTag, and mapError as a failure-only handler.
    flowNode("ts-reserve", "STAGE", {
      evidence: [ref(TS_PATH, "reserve", 12)],
      label: "予約する(reserve)",
      origin: "code",
    }),
    flowNode("ts-charge", "STAGE", {
      evidence: [ref(TS_PATH, "charge", 13)],
      label: "請求する(charge)",
      origin: "code",
    }),
    flowNode("ts-recovery", "RECOVERY", {
      evidence: [ref(TS_PATH, "catchTag", 15)],
      label: "在庫切れを代替入荷へ回復する(catchTag)",
      origin: "code",
    }),
    flowNode("ts-bypass", "BYPASS", {
      label: "PaymentDeclinedはcatchTagの対象外のため素通りする",
    }),
    flowNode("ts-map-error", "FAILURE_HANDLER", {
      evidence: [ref(TS_PATH, "mapError", 16)],
      label: "残った失敗をCheckoutFailedへ変換する(mapError)",
      origin: "code",
    }),
    flowNode("ts-success-end", "TERMINATION", {
      drillInto: "checkout-flow",
      evidence: [ref(TS_PATH, "checkout", 13)],
      label: "確定応答を返す",
      origin: "code",
    }),
    flowNode("ts-recovered-end", "TERMINATION", {
      drillInto: "checkout-flow",
      evidence: [ref(TS_PATH, "catchTag", 15)],
      label: "代替入荷で確定する",
      origin: "code",
    }),
    flowNode("ts-failure-end", "TERMINATION", {
      evidence: [ref(TS_PATH, "mapError", 16)],
      label: "失敗を返す",
      origin: "code",
    }),
    // Rust: `?` bind/early-return, or_else recovery scoped to tax_rate, its
    // executed non-recovering `other => Err(other)` arm as a real bypass, and
    // expect() turning a returned Err into a panic outside the typed lane.
    flowNode("rs-normalize", "STAGE", {
      evidence: [ref(RS_PATH, "normalize_country", 22)],
      label: "国コードを正規化する(normalize_country)",
      origin: "code",
    }),
    flowNode("rs-quote", "STAGE", {
      evidence: [ref(RS_PATH, "quote_tax", 23)],
      label: "税率を照会する(quote_tax)",
      origin: "code",
    }),
    flowNode("rs-recovery", "RECOVERY", {
      evidence: [ref(RS_PATH, "tax_rate", 24)],
      label: "ServiceDownを0円へ回復する(or_else)",
      origin: "code",
    }),
    flowNode("rs-bypass", "BYPASS", {
      evidence: [ref(RS_PATH, "tax_rate", 25)],
      label: "ServiceDown以外はor_elseの対象外のまま伝播する",
      origin: "code",
    }),
    flowNode("rs-tax-rate-failure", "TERMINATION", {
      evidence: [
        ref(RS_PATH, "normalize_country", 8),
        ref(RS_PATH, "tax_rate", 25),
      ],
      label: "tax_rateがErrを返す",
      origin: "code",
    }),
    flowNode("rs-tax-rate-success", "STAGE", {
      evidence: [ref(RS_PATH, "quote_tax", 23), ref(RS_PATH, "tax_rate", 24)],
      label: "tax_rateがOkを返す",
      origin: "code",
    }),
    flowNode("rs-outside-error", "OUTSIDE_TYPED_ERROR", {
      evidence: [ref(RS_PATH, "charge_invoice", 30)],
      label: "expectがErrでpanicする(型付きエラー外)",
      origin: "code",
    }),
    flowNode("rs-success-end", "TERMINATION", {
      drillInto: "checkout-flow",
      evidence: [ref(RS_PATH, "charge_invoice", 30)],
      label: "税率込みの金額を返す",
      origin: "code",
    }),
  ];
  const edges = [
    edge("e-ts-reserve-charge", "ts-reserve", "ts-charge", "予約成功"),
    edge("e-ts-charge-success", "ts-charge", "ts-success-end", "請求成功"),
    edge(
      "e-ts-reserve-recovery",
      "ts-reserve",
      "ts-recovery",
      "OutOfStock（在庫切れ）"
    ),
    edge(
      "e-ts-recovery-end",
      "ts-recovery",
      "ts-recovered-end",
      "backorderへ回復"
    ),
    edge(
      "e-ts-charge-bypass",
      "ts-charge",
      "ts-bypass",
      "PaymentDeclined（catchTagの対象外）"
    ),
    edge(
      "e-ts-bypass-maperror",
      "ts-bypass",
      "ts-map-error",
      "素通りしてmapErrorへ"
    ),
    edge(
      "e-ts-maperror-end",
      "ts-map-error",
      "ts-failure-end",
      "CheckoutFailedとして返す"
    ),
    edge("e-rs-normalize-quote", "rs-normalize", "rs-quote", "正規化成功"),
    edge(
      "e-rs-normalize-failure",
      "rs-normalize",
      "rs-tax-rate-failure",
      "InvalidCountryで早期return"
    ),
    edge(
      "e-rs-quote-success",
      "rs-quote",
      "rs-tax-rate-success",
      "税率取得成功"
    ),
    edge("e-rs-quote-recovery", "rs-quote", "rs-recovery", "ServiceDown"),
    edge(
      "e-rs-recovery-success",
      "rs-recovery",
      "rs-tax-rate-success",
      "0円へ回復"
    ),
    edge("e-rs-quote-bypass", "rs-quote", "rs-bypass", "ServiceDown以外のErr"),
    edge(
      "e-rs-bypass-failure",
      "rs-bypass",
      "rs-tax-rate-failure",
      "Errのまま伝播"
    ),
    edge(
      "e-rs-success-end",
      "rs-tax-rate-success",
      "rs-success-end",
      "expectが値を取り出す"
    ),
    edge(
      "e-rs-failure-outside",
      "rs-tax-rate-failure",
      "rs-outside-error",
      "expectがErrでpanicする"
    ),
  ];
  return { businessNode, edges, nodes };
};
