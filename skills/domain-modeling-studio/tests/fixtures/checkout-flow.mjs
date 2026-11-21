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

// Fictional verification records for the checkout flow (#58, #105). The test
// paths and runs below are illustrative only: no checkout test suite exists in
// this repo.
const CHECKOUT_TEST = "tests/checkout.test.ts";
const CHECKOUT_PROPERTY_TEST = "tests/checkout.property.test.ts";
export const checkoutVerification = () => {
  const recoveryTest = ref(CHECKOUT_TEST, "OutOfStockを代替入荷で確定する", 20);
  const declinedProperty = ref(
    CHECKOUT_PROPERTY_TEST,
    "支払い拒否の注文は内容によらず確定しない",
    8
  );
  return {
    scenarios: [
      {
        evidence: [ref(TS_PATH, "catchTag", 15)],
        given: ["注文した品目の在庫が切れている"],
        id: "scenario-backorder",
        model: "current",
        rules: ["rule-backorder"],
        status: "confirmed",
        then: ["注文は代替入荷で確定する"],
        title: "在庫切れの注文を代替入荷で確定する",
        when: "注文を確定する",
      },
      {
        evidence: [ref(TS_PATH, "mapError", 16)],
        given: ["在庫を予約できる", "支払いが拒否される"],
        id: "scenario-declined",
        model: "current",
        rules: ["rule-declined"],
        status: "confirmed",
        then: ["注文は確定しない", "CheckoutFailedが返る"],
        title: "支払いを拒否された注文は確定しない",
        when: "注文を確定する",
      },
      {
        evidence: [],
        given: ["在庫を予約できる", "請求が成功する"],
        id: "scenario-confirmed",
        model: "current",
        rules: ["rule-confirmed"],
        status: "draft",
        then: ["注文は確定済みになる"],
        title: "請求に成功した注文を確定する",
        when: "注文を確定する",
      },
    ],
    existingTests: [
      {
        boundary: { evidence: [recoveryTest], kind: "FUNCTION", origin: "code" },
        evidence: [recoveryTest],
        id: "test-backorder",
        result: { status: "READ" },
        rules: ["rule-backorder"],
        title: "在庫切れを代替入荷で確定するテスト",
      },
      {
        boundary: { evidence: [], kind: "PORT_CONTRACT", origin: "inference" },
        evidence: [ref(CHECKOUT_TEST, "PaymentDeclinedをCheckoutFailedで返す", 34)],
        id: "test-declined",
        result: {
          command: "npm test -- checkout",
          revision: FIXTURE_REVISION,
          source: "架空の実行記録（説明用）",
          status: "PASSED",
        },
        rules: ["rule-declined"],
        title: "支払い拒否を確定しないテスト",
      },
      {
        boundary: { evidence: [declinedProperty], kind: "DOMAIN", origin: "code" },
        evidence: [declinedProperty],
        id: "test-declined-property",
        method: "PROPERTY",
        result: {
          command: "npm test -- checkout.property",
          counterexample: "明細: [{ 数量: 1, 単価: 0 }], 支払い: 拒否",
          revision: FIXTURE_REVISION,
          seed: "1729",
          source: "架空の実行記録（説明用）",
          status: "FAILED",
        },
        rules: ["rule-declined"],
        title: "支払い拒否の注文は内容によらず確定しないプロパティテスト",
      },
    ],
    rules: [
      {
        evidence: [ref(TS_PATH, "catchTag", 15)],
        id: "rule-backorder",
        kind: "RULE",
        model: "current",
        origin: "code",
        statement: "在庫切れの注文は代替入荷で確定する",
        targets: ["ts-recovery", "e-ts-recovery-end"],
      },
      {
        evidence: [ref(TS_PATH, "mapError", 16)],
        id: "rule-declined",
        kind: "INVARIANT",
        model: "current",
        origin: "code",
        statement: "支払いが拒否された注文は確定しない",
        targets: ["ts-bypass", "ts-map-error", "ts-failure-end"],
      },
      {
        evidence: [ref(TS_PATH, "charge", 13)],
        id: "rule-confirmed",
        kind: "TRANSITION",
        model: "current",
        origin: "code",
        statement: "注文は請求が成功したときだけ確定済みになる",
        targets: ["e-ts-charge-success", "ts-success-end"],
      },
    ],
    verificationCandidates: [
      {
        boundary: { evidence: [recoveryTest], kind: "FUNCTION", origin: "code" },
        decision: "KEEP",
        error: "在庫切れを失敗として返してしまう",
        evidence: [recoveryTest],
        id: "keep-backorder",
        reason:
          "OutOfStockだけを回復する条件を関数の境界で直接観測する唯一のテストのため、同じ役割のテストは追加しない",
        rule: "rule-backorder",
        tests: ["test-backorder"],
        title: "代替入荷の確定テストを維持する",
      },
      {
        boundary: { evidence: [], kind: "SLICE", origin: "inference" },
        decision: "ADD",
        error: "請求が失敗しても確定応答を返してしまう",
        evidence: [ref(TS_PATH, "charge", 13)],
        id: "add-confirmed",
        reason: "この状態遷移を観測する既存テストがない",
        rule: "rule-confirmed",
        tests: [],
        title: "請求成功時だけ確定することを検証する",
      },
      {
        boundary: { evidence: [declinedProperty], kind: "DOMAIN", origin: "code" },
        decision: "KEEP",
        error: "金額や明細によっては、支払いを拒否された注文を確定してしまう",
        evidence: [declinedProperty],
        id: "keep-declined-property",
        method: "PROPERTY",
        property: {
          evidence: [],
          inputs: ["明細: 1〜20件", "各明細の数量: 1〜99、単価: 0〜100,000円"],
          observation: "注文が確定済みになったかどうか",
          origin: "agreement",
          preconditions: ["在庫を予約できる", "支払いが拒否される"],
          statement: "支払いが拒否された注文は、明細や金額によらず確定しない",
        },
        reason:
          "反例で失敗しているが、注文内容を変えても拒否時に確定しないことを直接観測する唯一のテストのため維持し、反例を実装の修正で解消する",
        rule: "rule-declined",
        tests: ["test-declined-property"],
        title: "支払い拒否の性質テストを維持する",
      },
      {
        boundary: { evidence: [], kind: "FUNCTION", origin: "inference" },
        decision: "ADD",
        error: "拒否理由によってはCheckoutFailed以外の失敗を返してしまう",
        evidence: [ref(TS_PATH, "mapError", 16)],
        id: "add-declined-reasons",
        method: "PROPERTY",
        property: {
          evidence: [],
          inputs: ["支払いの拒否理由: 残高不足・期限切れ・不正の疑いなど決済代行が返す全種別"],
          observation: "返る失敗の種類",
          origin: "inference",
          preconditions: ["在庫を予約できる", "支払いが拒否される"],
          statement: "支払いの拒否理由が何であっても、失敗はCheckoutFailedとして返る",
        },
        reason:
          "既存テストは1種類の拒否理由だけを観測し、mapErrorがすべての拒否理由を同じ失敗へ変換するかを確かめていない",
        rule: "rule-declined",
        tests: [],
        title: "拒否理由によらずCheckoutFailedを返すことを確かめる",
      },
      {
        decision: "HOLD",
        evidence: [ref(TS_PATH, "catchTag", 15)],
        id: "hold-backorder-formula",
        method: "PROPERTY",
        property: {
          evidence: [ref(TS_PATH, "catchTag", 15)],
          inputs: ["在庫切れの品目を含む注文"],
          observation: "確定応答",
          origin: "code",
          preconditions: ["予約でOutOfStockが起きる"],
          statement: "在庫切れの注文の確定応答は、catchTagが呼ぶbackorder(order)の戻り値に等しい",
        },
        reason:
          "実装の式をそのまま期待値に写しており、代替入荷で確定する業務上の条件を確かめないため、条件を合意するまで保留する",
        rule: "rule-backorder",
        title: "実装の式を写した代替入荷の性質を保留する",
      },
      {
        decision: "HOLD",
        evidence: [ref(RS_PATH, "tax_rate", 24)],
        id: "hold-tax-recovery",
        title: "税率照会の0円回復を検証対象にするか決める",
      },
    ],
  };
};
