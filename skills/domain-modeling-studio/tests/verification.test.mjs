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
const v3 = (mutate = () => {}) => {
  const doc = {
    ...example(),
    existingTests: [],
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

