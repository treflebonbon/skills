import assert from "node:assert/strict";
import { test } from "node:test";

import { validateDocument } from "../src/model.mjs";
import { example } from "./fixture.mjs";

const rule = (extra = {}) => ({
  evidence: [],
  id: "accept-once",
  kind: "INVARIANT",
  model: "current",
  origin: "inference",
  statement: "受諾済みの依頼は再受諾できない",
  targets: ["accept"],
  ...extra,
});
const REVISION = "b".repeat(40);
const testRef = {
  line: 12,
  path: "tests/accept.test.ts",
  revision: REVISION,
  symbol: "再受諾を拒否する",
};
const existingTest = (extra = {}) => ({
  boundary: { evidence: [testRef], kind: "DOMAIN", origin: "code" },
  evidence: [testRef],
  id: "accept-once-test",
  result: { status: "READ" },
  rules: ["accept-once"],
  title: "再受諾を拒否するテスト",
  ...extra,
});
const v3 = (mutate = () => {}) => {
  const doc = {
    ...example(),
    existingTests: [existingTest()],
    rules: [rule()],
    schemaVersion: 3,
    verificationCandidates: [],
  };
  mutate(doc);
  return doc;
};

test("schemaVersion 3の業務ルールは同じviewの要素へ関連付け、v2は従来どおり受け付ける", () => {
  assert.doesNotThrow(() => validateDocument(v3()));
  assert.doesNotThrow(() => validateDocument(example()));
  assert.doesNotThrow(() =>
    validateDocument(
      v3((d) => {
        d.rules[0].targets = ["request-accept"];
      })
    )
  );
  for (const [mutate, message] of [
    [
      (d) => {
        delete d.rules;
      },
      /rulesは配列/u,
    ],
    [
      (d) => {
        d.rules[0].targets = ["missing"];
      },
      /業務ルールの関連先/u,
    ],
    [
      (d) => {
        d.rules[0].targets = [];
      },
      /業務ルールの関連先/u,
    ],
    [
      (d) => {
        d.rules[0].kind = "POLICY";
      },
      /業務ルールの形式/u,
    ],
    [
      (d) => {
        d.rules[0].origin = "code";
      },
      /根拠が必要/u,
    ],
    [
      (d) => {
        d.rules.push(rule());
      },
      /IDが不正または重複/u,
    ],
  ]) {
    assert.throws(() => validateDocument(v3(mutate)), message);
  }
  const legacy = example();
  legacy.rules = [rule()];
  assert.throws(() => validateDocument(legacy), /schemaVersion: 3/u);
});


test("既存テストは読んだ位置・現状の業務ルール・検証の境界を持ち、実行結果には出所が必要", () => {
  const passed = {
    command: "npm test -- accept",
    revision: REVISION,
    source: "ユーザーの許可を得てセッション内で実行",
    status: "PASSED",
  };
  for (const result of [{ status: "READ" }, { status: "NOT_RUN" }, passed]) {
    assert.doesNotThrow(() =>
      validateDocument(
        v3((d) => {
          d.existingTests[0].result = result;
        })
      )
    );
  }
  for (const [mutate, message] of [
    [
      (d) => {
        d.existingTests[0].evidence = [];
      },
      /既存テストの形式/u,
    ],
    [
      (d) => {
        d.existingTests[0].rules = ["missing"];
      },
      /既存テストが守る業務ルール/u,
    ],
    [
      (d) => {
        d.existingTests[0].rules = [];
      },
      /既存テストが守る業務ルール/u,
    ],
    [
      (d) => {
        d.rules[0].model = "proposed";
      },
      /改善案の業務ルールには既存テストを紐づけられません/u,
    ],
    [
      (d) => {
        d.existingTests[0].boundary.kind = "LAYER";
      },
      /検証の境界/u,
    ],
    [
      (d) => {
        d.existingTests[0].boundary.origin = "unknown";
      },
      /確度が不正/u,
    ],
    [
      (d) => {
        d.existingTests[0].result = { status: "GREEN" };
      },
      /検証結果の区分/u,
    ],
    ...["command", "revision", "source"].map((field) => [
      (d) => {
        d.existingTests[0].result = { ...passed, [field]: undefined };
      },
      /実行結果には実行コマンド・対象revision・出所/u,
    ]),
    [
      (d) => {
        d.existingTests[0].result = { ...passed, revision: "main" };
      },
      /実行結果には実行コマンド・対象revision・出所/u,
    ],
    [
      (d) => {
        d.existingTests[0].result = { ...passed, status: "SKIPPED" };
        delete d.existingTests[0].result.source;
      },
      /実行結果には実行コマンド・対象revision・出所/u,
    ],
  ]) {
    assert.throws(() => validateDocument(v3(mutate)), message);
  }
});
