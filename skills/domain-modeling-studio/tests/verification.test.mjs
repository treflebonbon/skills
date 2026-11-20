import assert from "node:assert/strict";
import { test } from "node:test";

import {
  artifacts,
  reconcile,
  removeItem,
  signature,
  validateDocument,
} from "../src/model.mjs";
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
const candidate = (extra = {}) => ({
  boundary: { evidence: [], kind: "ADAPTER_INTEGRATION", origin: "inference" },
  decision: "ADD",
  error: "同時に届いた2件の受諾を両方成功させてしまう",
  evidence: [],
  id: "accept-race",
  reason:
    "既存テストは単一の受諾だけを観測し、同時実行時の保存の制約を確かめていない",
  rule: "accept-once",
  tests: [],
  title: "同時受諾の二重成功を検出する",
  ...extra,
});
const keep = candidate({
  boundary: { evidence: [testRef], kind: "DOMAIN", origin: "code" },
  decision: "KEEP",
  error: "受諾済みの依頼を再受諾できてしまう",
  id: "keep-accept-once",
  reason: "再受諾の拒否をドメインの境界で直接観測する唯一のテスト",
  tests: ["accept-once-test"],
  title: "再受諾の拒否を維持する",
});
const v3 = (mutate = () => {}) => {
  const doc = {
    ...example(),
    existingTests: [existingTest()],
    rules: [rule()],
    schemaVersion: 3,
    verificationCandidates: [candidate(), structuredClone(keep)],
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

test("保留以外の検証候補は誤り・業務ルール・境界・理由を必須とし、欠けた内容は保留なら受け付ける", () => {
  const required = /保留以外の検証候補には検出したい誤り・守る業務ルール・検証の境界・理由が必要です/u;
  for (const field of ["error", "rule", "boundary", "reason"]) {
    const missing = (d) => {
      delete d.verificationCandidates[0][field];
    };
    assert.throws(() => validateDocument(v3(missing)), required);
    assert.doesNotThrow(() =>
      validateDocument(
        v3((d) => {
          missing(d);
          d.verificationCandidates[0].decision = "HOLD";
        })
      )
    );
  }
  assert.throws(
    () =>
      validateDocument(
        v3((d) => {
          d.verificationCandidates[0].reason = " ";
        })
      ),
    required
  );
  assert.doesNotThrow(() =>
    validateDocument(
      v3((d) => {
        d.verificationCandidates = [
          { decision: "HOLD", evidence: [], id: "unknown", title: "根拠不足" },
        ];
      })
    )
  );
  for (const [mutate, message] of [
    [
      (d) => {
        d.verificationCandidates[0].decision = "IGNORE";
      },
      /検証候補の形式/u,
    ],
    [
      (d) => {
        d.verificationCandidates[0].rule = "missing";
      },
      /検証候補の業務ルールが見つかりません/u,
    ],
    [
      (d) => {
        d.verificationCandidates[0].boundary.kind = "LAYER";
      },
      /検証の境界/u,
    ],
    ...["KEEP", "MERGE", "DELETE"].map((decision) => [
      (d) => {
        Object.assign(d.verificationCandidates[1], { decision, tests: [] });
      },
      /維持・統合・削除の候補には対象の既存テストが必要です/u,
    ]),
    [
      (d) => {
        d.verificationCandidates[1].tests = ["missing"];
      },
      /対象の既存テストが見つかりません/u,
    ],
    [
      (d) => {
        d.rules.push(rule({ id: "request-valid", targets: ["request"] }));
        d.verificationCandidates[1].rule = "request-valid";
      },
      /対象の既存テストが守る業務ルールと一致しません/u,
    ],
  ]) {
    assert.throws(() => validateDocument(v3(mutate)), message);
  }
  assert.doesNotThrow(() =>
    validateDocument(
      v3((d) => {
        d.verificationCandidates[1].decision = "MERGE";
      })
    )
  );
});

test("改善案の要素を削除しても、その要素を指す業務ルールは削除記録で関連を保つ", () => {
  const doc = validateDocument(
    v3((d) => {
      d.rules.push(
        rule({ id: "accept-proposed", model: "proposed", targets: ["accept"] })
      );
    })
  );
  const removed = removeItem(doc, "node", "accept");
  assert.equal(
    removed.retired.some((r) => r.view === "proposed" && r.item.id === "accept"),
    true
  );
  assert.deepEqual(removed.rules.at(-1).targets, ["accept"]);
});

test("業務ルール・既存テスト・検証候補への指摘と削除記録を受け付け、AI更新で黙って消えたら競合にする", () => {
  const comment = {
    id: "c-rule",
    target: { id: "accept-once", view: "verification" },
    text: "取消後の再受諾は許す",
  };
  assert.doesNotThrow(() =>
    validateDocument(
      v3((d) => {
        d.comments.push(comment);
      })
    )
  );
  assert.throws(
    () =>
      validateDocument(
        v3((d) => {
          d.comments.push({ ...comment, target: { view: "verification" } });
        })
      ),
    /指摘対象が不正/u
  );
  assert.throws(
    () =>
      validateDocument(
        v3((d) => {
          d.retired.push({
            entity: "rule",
            item: { ...rule(), statement: "" },
            view: "verification",
          });
        })
      ),
    /削除記録が不正/u
  );

  const before = validateDocument(
    v3((d) => {
      d.comments.push(comment);
    })
  );
  const saved = {
    document: before,
    lastExport: { id: "export-1", signature: signature(before) },
    seed: signature(before),
  };
  const update = (mutate) => {
    const next = {
      ...structuredClone(before),
      basedOn: { exportId: "export-1", revision: "r1" },
      revision: "r2",
    };
    mutate(next);
    return reconcile(next, saved).conflict;
  };
  assert.equal(update(() => {}), false);
  assert.equal(
    update((d) => {
      d.rules[0].statement = "受諾済みの依頼は取消まで再受諾できない";
    }),
    false
  );
  const retire = (entity, item) => ({ entity, item, view: "verification" });
  assert.equal(
    update((d) => {
      d.verificationCandidates.shift();
    }),
    true
  );
  assert.equal(
    update((d) => {
      d.retired.push(
        retire("verificationCandidate", d.verificationCandidates.shift())
      );
    }),
    false
  );
  assert.equal(
    update((d) => {
      d.existingTests.pop();
      d.retired.push(
        retire("verificationCandidate", d.verificationCandidates.pop())
      );
    }),
    true
  );
  assert.equal(
    update((d) => {
      d.retired.push(
        retire("existingTest", d.existingTests.pop()),
        retire("verificationCandidate", d.verificationCandidates.pop())
      );
    }),
    false
  );

  const legacy = validateDocument(example());
  const legacySaved = {
    document: legacy,
    lastExport: { id: "export-1", signature: signature(legacy) },
    seed: signature(legacy),
  };
  const upgraded = {
    ...v3(),
    basedOn: { exportId: "export-1", revision: "r1" },
    revision: "r2",
  };
  assert.equal(reconcile(upgraded, legacySaved).conflict, false);
});

test("verification.mdは業務ルールから既存テストと検証候補を辿れ、根拠と検証結果を別に示す", () => {
  const doc = validateDocument(
    v3((d) => {
      d.existingTests.push(
        existingTest({
          boundary: { evidence: [], kind: "PORT_CONTRACT", origin: "inference" },
          id: "accept-port-test",
          result: {
            command: "npm test -- accept-port",
            revision: REVISION,
            source: "CI",
            status: "FAILED",
          },
          title: "受諾ポートの契約テスト",
        })
      );
      d.verificationCandidates.push({
        decision: "HOLD",
        evidence: [],
        id: "hold-expiry",
        title: "満了の扱いを確かめる",
      });
    })
  );
  const file = artifacts(doc)["verification.md"];
  const section = (heading) => {
    const start = file.indexOf(heading);
    assert.notEqual(start, -1, heading);
    const next = file.indexOf("\n#", start + heading.length);
    return file.slice(start, next === -1 ? undefined : next);
  };
  assert.match(file, /根拠と検証結果は別の区分です/u);
  const ruleSection = section("## 業務ルール: 受諾済みの依頼は再受諾できない");
  assert.match(ruleSection, /不変条件 \/ 現状 \/ AIの推測/u);
  assert.match(ruleSection, /関連要素: 受諾する（accept）/u);
  const read = section("### 既存テスト: 再受諾を拒否するテスト");
  assert.match(read, /検証の境界: ドメイン（コードで確認）/u);
  assert.match(read, /検証結果: 読んだのみ/u);
  assert.ok(read.includes("tests/accept\\.test\\.ts:12"));
  const failed = section("### 既存テスト: 受諾ポートの契約テスト");
  assert.match(failed, /検証の境界: ポート契約（AIの推測・構造は未確認）/u);
  assert.match(failed, /検証結果: 実行・失敗/u);
  assert.match(failed, /実行コマンド: ` npm test -- accept-port `/u);
  assert.match(failed, /出所: CI/u);
  const add = section("### 検証候補: 同時受諾の二重成功を検出する");
  assert.match(add, /判断: 追加/u);
  assert.match(add, /検出したい誤り: 同時に届いた2件の受諾/u);
  assert.match(add, /検証の境界: アダプター結合（AIの推測・構造は未確認）/u);
  assert.match(add, /理由: 既存テストは単一の受諾だけ/u);
  const kept = section("### 検証候補: 再受諾の拒否を維持する");
  assert.match(kept, /判断: 維持/u);
  assert.match(kept, /対象の既存テスト: 再受諾を拒否するテスト（accept\\-once\\-test）/u);
  assert.ok(
    file.indexOf("## 業務ルールが未定の検証候補") <
      file.indexOf("### 検証候補: 満了の扱いを確かめる")
  );
  assert.match(section("### 検証候補: 満了の扱いを確かめる"), /判断: 保留/u);
  const unknowns = section("## 未確認事項");
  assert.match(unknowns, /保留: 満了の扱いを確かめる/u);
  assert.match(unknowns, /実行結果なし: 再受諾を拒否するテスト（読んだのみ）/u);
  assert.match(
    unknowns,
    /境界の構造が未確認: 受諾ポートの契約テスト（ポート契約）/u
  );

  const model = artifacts(doc)["model.md"];
  assert.match(model, /## 業務ルールと図の要素/u);
  assert.match(
    model,
    /accept\\-once（現状 \/ 不変条件）: 受諾済みの依頼は再受諾できない → 受諾する（accept）/u
  );

  const retired = validateDocument(
    v3((d) => {
      d.retired.push({
        entity: "verificationCandidate",
        item: d.verificationCandidates.shift(),
        view: "verification",
      });
    })
  );
  assert.match(
    artifacts(retired)["model.md"],
    /verification \/ accept\\-race: 同時受諾の二重成功を検出する/u
  );
  assert.match(
    artifacts(validateDocument(example()))["verification.md"],
    /業務ルールは未登録です/u
  );
});
