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
  evidence: [testRef],
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
  evidence: [testRef],
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
  assert.throws(
    () =>
      validateDocument(
        v3((d) => {
          d.verificationCandidates[0].evidence = [];
        })
      ),
    /保留以外の検証候補には理由の根拠が必要です/u
  );
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

  // The commented rule itself retires with its dependents; the comment stays
  // attributable to the retired record.
  const retiredRule = update((d) => {
    d.retired.push(
      retire("rule", d.rules.pop()),
      retire("existingTest", d.existingTests.pop()),
      ...d.verificationCandidates
        .splice(0)
        .map((item) => retire("verificationCandidate", item))
    );
  });
  assert.equal(retiredRule, false);
  const afterRetire = validateDocument({
    ...structuredClone(before),
    existingTests: [],
    retired: [{ entity: "rule", item: rule(), view: "verification" }],
    rules: [],
    verificationCandidates: [],
  });
  const attributed = afterRetire.retired.filter(
    (r) =>
      r.view === comment.target.view && r.item.id === comment.target.id
  );
  assert.equal(attributed.length, 1);
  assert.deepEqual(afterRetire.comments.at(-1), comment);

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

// schemaVersion 4 (#105): representative examples and properties.
const scenario = (extra = {}) => ({
  evidence: [testRef],
  given: ["依頼を受諾済みである"],
  id: "accept-twice",
  model: "current",
  rules: ["accept-once"],
  status: "confirmed",
  then: ["受諾は拒否される"],
  title: "受諾済みの依頼をもう一度受諾する",
  when: "同じ依頼を受諾する",
  ...extra,
});
const v4 = (mutate = () => {}) =>
  v3((d) => {
    d.schemaVersion = 4;
    d.scenarios = [scenario()];
    mutate(d);
  });

test("代表例は参照できるviewの業務ルールだけに紐づく", () => {
  assert.doesNotThrow(() => validateDocument(v4()));
  assert.doesNotThrow(() =>
    validateDocument(
      v4((d) => {
        d.rules.push(rule({ id: "accept-proposed", model: "proposed" }));
        d.scenarios[0].model = "proposed";
        d.scenarios[0].rules = ["accept-once", "accept-proposed"];
      })
    )
  );
  for (const [mutate, message] of [
    [
      (d) => {
        d.scenarios[0].rules = ["missing"];
      },
      /代表例の業務ルールが見つかりません/u,
    ],
    [
      (d) => {
        d.rules.push(rule({ id: "accept-proposed", model: "proposed" }));
        d.scenarios[0].rules = ["accept-proposed"];
      },
      /現状の代表例は改善案の業務ルールを参照できません/u,
    ],
    [
      (d) => {
        d.scenarios[0].rules = "accept-once";
      },
      /代表例の業務ルールが見つかりません/u,
    ],
  ]) {
    assert.throws(() => validateDocument(v4(mutate)), message);
  }
});

test("v4の項目を持つv2・v3の文書はschemaVersion: 4が必要と拒否し、持たなければ読み込める", () => {
  const property = {
    evidence: [],
    inputs: ["受諾の回数: 2〜10回"],
    observation: "成功する受諾の件数",
    origin: "inference",
    preconditions: ["依頼は受諾できる状態にある"],
    statement: "何回受諾しても成功するのは最初の1回だけ",
  };
  const failedRun = {
    command: "npm test -- accept",
    revision: REVISION,
    source: "CI",
    status: "FAILED",
  };
  for (const mutate of [
    (d) => {
      d.scenarios = [scenario()];
    },
    (d) => {
      d.verificationCandidates[0].method = "PROPERTY";
    },
    (d) => {
      d.verificationCandidates[0].property = property;
    },
    (d) => {
      d.existingTests[0].method = "PROPERTY";
    },
    (d) => {
      d.existingTests[0].result = { ...failedRun, seed: "42" };
    },
    (d) => {
      d.existingTests[0].result = { ...failedRun, counterexample: "[0]" };
    },
  ]) {
    assert.throws(() => validateDocument(v3(mutate)), /schemaVersion: 4/u);
  }
  const legacy = example();
  legacy.scenarios = [scenario({ rules: ["accept-once"] })];
  assert.throws(() => validateDocument(legacy), /schemaVersion: 4/u);
  // Retired records stay as stored; they are not displayed field by field.
  assert.doesNotThrow(() =>
    validateDocument(
      v3((d) => {
        d.retired.push({
          entity: "verificationCandidate",
          item: { ...candidate({ id: "old" }), method: "PROPERTY" },
          view: "verification",
        });
      })
    )
  );
  assert.doesNotThrow(() => validateDocument(v3()));
  assert.doesNotThrow(() => validateDocument(example()));
});

const property = (extra = {}) => ({
  evidence: [],
  inputs: ["受諾の回数: 2〜10回", "受諾の間隔: 0〜1000ミリ秒"],
  observation: "成功する受諾の件数",
  origin: "inference",
  preconditions: ["依頼は受諾できる状態にある"],
  statement: "何回受諾しても成功するのは最初の1回だけ",
  ...extra,
});
const propertyCandidate = (extra = {}) =>
  candidate({
    id: "accept-once-property",
    method: "PROPERTY",
    property: property(),
    title: "受諾の回数を変えても成功は1回だけと確かめる",
    ...extra,
  });

test("PROPERTYの検証候補は保留でも性質の4項目を必須とし、未知の検証手法を拒否する", () => {
  const withCandidate = (extra, mutate = () => {}) =>
    v4((d) => {
      d.verificationCandidates.push(propertyCandidate(extra));
      mutate(d);
    });
  assert.doesNotThrow(() => validateDocument(withCandidate({})));
  assert.doesNotThrow(() =>
    validateDocument(
      withCandidate({
        decision: "HOLD",
        property: property({
          evidence: [testRef],
          origin: "code",
          statement: "受諾の結果は accepted === previous + 1 に等しい",
        }),
      })
    )
  );
  const invalid = /性質には成り立つ性質・事前条件・生成範囲・観測する結果が必要です/u;
  for (const decision of ["ADD", "HOLD"]) {
    for (const [extra, message] of [
      [{ property: undefined }, invalid],
      [{ property: property({ statement: " " }) }, invalid],
      [{ property: property({ observation: "" }) }, invalid],
      [{ property: property({ preconditions: [] }) }, invalid],
      [{ property: property({ preconditions: [""] }) }, invalid],
      [{ property: property({ inputs: [] }) }, invalid],
      [{ property: property({ inputs: "受諾の回数" }) }, invalid],
      [{ property: property({ origin: "test" }) }, /確度が不正/u],
      [{ property: property({ origin: "code" }) }, /根拠が必要/u],
      [{ method: "TIA" }, /検証手法が不正です/u],
      [{ method: undefined }, /性質にはmethod: PROPERTYが必要です/u],
    ]) {
      assert.throws(
        () => validateDocument(withCandidate({ decision, ...extra })),
        message,
        `${decision} ${JSON.stringify(extra)}`
      );
    }
  }
});

test("PROPERTYの既存テストが失敗したら反例を必須とし、seed・反例は実際の実行結果にだけ記録できる", () => {
  const run = (status, extra = {}) => ({
    command: "npm test -- accept.property",
    revision: REVISION,
    source: "CI",
    status,
    ...extra,
  });
  const withTest = (extra) =>
    v4((d) => {
      Object.assign(d.existingTests[0], { method: "PROPERTY", ...extra });
    });
  for (const result of [
    run("FAILED", { counterexample: "受諾の回数: 2, 間隔: 0" }),
    run("FAILED", { counterexample: "[2, 0]", seed: "1729" }),
    run("PASSED"),
    run("PASSED", { seed: "1729" }),
    { status: "READ" },
  ]) {
    assert.doesNotThrow(() => validateDocument(withTest({ result })));
  }
  // Without method, a failed run still needs no counterexample (as in v3).
  assert.doesNotThrow(() =>
    validateDocument(
      v4((d) => {
        d.existingTests[0].result = run("FAILED");
      })
    )
  );
  for (const [extra, message] of [
    [{ result: run("FAILED") }, /失敗したプロパティベーステストには縮小された反例が必要です/u],
    [{ result: run("FAILED", { counterexample: " " }) }, /seed・反例は空でない文字列/u],
    [{ result: run("PASSED", { seed: "" }) }, /seed・反例は空でない文字列/u],
    [{ result: run("PASSED", { seed: 1729 }) }, /seed・反例は空でない文字列/u],
    [
      { result: { counterexample: "[2]", status: "READ" } },
      /seed・反例は実際の実行結果にだけ記録できます/u,
    ],
    [
      { result: { seed: "1", status: "NOT_RUN" } },
      /seed・反例は実際の実行結果にだけ記録できます/u,
    ],
    [{ method: "TIA" }, /検証手法が不正です/u],
  ]) {
    assert.throws(() => validateDocument(withTest(extra)), message, JSON.stringify(extra));
  }
});

test("v4の項目を持つ文書のAI更新でも、消えた検証候補はretiredがなければ競合にする", () => {
  const before = validateDocument(
    v4((d) => {
      d.verificationCandidates.push(propertyCandidate());
      Object.assign(d.existingTests[0], { method: "PROPERTY" });
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
  assert.equal(
    update((d) => {
      d.verificationCandidates.at(-1).property.origin = "agreement";
      d.scenarios[0].rules = [];
    }),
    false
  );
  assert.equal(
    update((d) => {
      d.verificationCandidates.pop();
    }),
    true
  );
  assert.equal(
    update((d) => {
      d.retired.push({
        entity: "verificationCandidate",
        item: d.verificationCandidates.pop(),
        view: "verification",
      });
    }),
    false
  );
  const legacy = validateDocument(v3());
  const legacySaved = {
    document: legacy,
    lastExport: { id: "export-1", signature: signature(legacy) },
    seed: signature(legacy),
  };
  assert.equal(
    reconcile(
      { ...before, basedOn: { exportId: "export-1", revision: "r1" }, revision: "r2" },
      legacySaved
    ).conflict,
    false
  );
});

test("生成物は業務ルールから代表例・性質・seed・反例を辿れ、合意済みの性質はagreementだけに出す", () => {
  const doc = validateDocument(
    v4((d) => {
      d.scenarios.push(
        scenario({ id: "accept-first", rules: undefined, title: "初めて受諾する" })
      );
      d.existingTests[0] = existingTest({
        method: "PROPERTY",
        result: {
          command: "npm test -- accept.property",
          counterexample: "受諾の回数: 2, 間隔: `0`",
          revision: REVISION,
          seed: "1729",
          source: "CI",
          status: "FAILED",
        },
      });
      d.verificationCandidates.push(
        propertyCandidate({ property: property({ origin: "agreement" }) }),
        propertyCandidate({
          decision: "HOLD",
          id: "accept-formula",
          property: property({
            evidence: [testRef],
            origin: "code",
            statement: "受諾件数は previous + 1 に等しい",
          }),
          title: "実装の式を写した性質を保留する",
        })
      );
    })
  );
  const out = artifacts(doc);
  const feature = out["scenarios.feature"];
  assert.match(
    feature,
    /# 業務ルール: accept-once\n {2}Scenario: 受諾済みの依頼をもう一度受諾する/u
  );
  assert.equal(feature.match(/# 業務ルール:/gu).length, 1);

  const file = out["verification.md"];
  const section = (heading) => {
    const start = file.indexOf(heading);
    assert.notEqual(start, -1, heading);
    const next = file.indexOf("\n#", start + heading.length);
    return file.slice(start, next === -1 ? undefined : next);
  };
  const ruleSection = file.slice(
    file.indexOf("## 業務ルール: 受諾済みの依頼は再受諾できない"),
    file.indexOf("\n## ", file.indexOf("## 業務ルール:") + 1)
  );
  assert.match(
    ruleSection,
    /代表例: 受諾済みの依頼をもう一度受諾する（現状 \/ 確認済み）/u
  );
  assert.doesNotMatch(ruleSection, /初めて受諾する/u);
  const failed = section("### 既存テスト: 再受諾を拒否するテスト");
  assert.match(failed, /検証手法: プロパティベーステスト/u);
  assert.match(failed, /seed: ` 1729 `/u);
  assert.match(failed, /反例: `` 受諾の回数: 2, 間隔: `0` ``/u);
  const agreed = section("### 検証候補: 受諾の回数を変えても成功は1回だけと確かめる");
  assert.match(agreed, /検証手法: プロパティベーステスト/u);
  assert.match(agreed, /合意済みの性質（業務上の合意）: 何回受諾しても成功するのは最初の1回だけ/u);
  assert.match(agreed, /事前条件: 依頼は受諾できる状態にある/u);
  assert.match(agreed, /生成範囲: 受諾の回数: 2〜10回、受諾の間隔: 0〜1000ミリ秒/u);
  assert.match(agreed, /観測する結果: 成功する受諾の件数/u);
  const held = section("### 検証候補: 実装の式を写した性質を保留する");
  assert.match(held, /未合意の性質（コードで確認）: 受諾件数は previous \\\+ 1 に等しい/u);
  assert.equal(file.match(/合意済みの性質/gu).length, 1);
  const unknowns = section("## 未確認事項");
  assert.match(unknowns, /未合意の性質: 実装の式を写した性質を保留する（コードで確認）/u);
  assert.doesNotMatch(unknowns, /未合意の性質: 受諾の回数を変えても/u);
});

test("列挙値は文字列だけを受け付け、配列に包んだ値で検査をすり抜けさせない", () => {
  for (const [mutate, message] of [
    [
      (d) => {
        d.verificationCandidates.push(propertyCandidate({ method: ["PROPERTY"] }));
      },
      /検証手法が不正です/u,
    ],
    [
      (d) => {
        d.existingTests[0].method = ["PROPERTY"];
      },
      /検証手法が不正です/u,
    ],
    [
      (d) => {
        d.rules[0].origin = ["code"];
      },
      /確度が不正/u,
    ],
    [
      (d) => {
        d.verificationCandidates[0].decision = ["HOLD"];
      },
      /検証候補の形式/u,
    ],
    [
      (d) => {
        d.existingTests[0].result = { status: ["READ"] };
      },
      /検証結果の区分/u,
    ],
  ]) {
    assert.throws(() => validateDocument(v4(mutate)), message);
  }
});

// #106: verification methods beyond PROPERTY, declined methods and plans.
const decline = (extra = {}) => ({
  decision: "DECLINE",
  evidence: [],
  id: "decline-alloy",
  method: "ALLOY",
  reason: "再受諾の拒否は1件の依頼の状態だけで決まり、関係の制約を探索する必要がない",
  rule: "accept-once",
  title: "再受諾の拒否にAlloyは使わない",
  ...extra,
});

test("不採用の検証候補は手法・業務ルール・理由を必須とし、根拠は空の配列でもよい", () => {
  const withDecline = (extra) =>
    v4((d) => {
      d.verificationCandidates.push(decline(extra));
    });
  for (const extra of [
    {},
    { evidence: [testRef] },
    { method: "PROPERTY" },
    { method: "MUTATION" },
    { method: "MBT" },
  ]) {
    assert.doesNotThrow(() => validateDocument(withDecline(extra)), JSON.stringify(extra));
  }
  const required = /不採用の検証候補には検証手法・業務ルール・理由が必要です/u;
  for (const [extra, message] of [
    [{ method: undefined }, required],
    [{ rule: undefined }, required],
    [{ reason: " " }, required],
    [{ reason: undefined }, required],
    [{ rule: "missing" }, /検証候補の業務ルールが見つかりません/u],
    [{ evidence: undefined }, /根拠は配列で指定してください/u],
    [{ evidence: {} }, /根拠は配列で指定してください/u],
    [{ method: "TIA" }, /検証手法が不正です/u],
  ]) {
    assert.throws(() => validateDocument(withDecline(extra)), message, JSON.stringify(extra));
  }
});

const plan = (extra = {}) => ({
  evidence: [],
  expectedEvidence: "受諾済みの依頼への受諾がすべて拒否されること",
  limits: "保存先の同時実行制御が正しいことは保証しない",
  origin: "inference",
  target: "依頼の受諾待ち・受諾済みの状態と受諾の操作",
  ...extra,
});
const mbtPlan = (extra = {}) =>
  plan({
    coverage: "受諾済みからの再受諾と、受諾待ちからの受諾の遷移を一度ずつ通る",
    mapping: "モデルの受諾操作をAPIの受諾要求に、モデルの状態を依頼の状態の照会結果に対応させる",
    ...extra,
  });
const methodCandidate = (method, extra = {}) =>
  candidate({
    id: `accept-${method.toLowerCase()}`,
    method,
    plan: { MBT: mbtPlan(), ALLOY: plan({ scope: "依頼3件・受諾者3人まで" }) }[method] ?? plan(),
    title: `${method}で再受諾の拒否を確かめる`,
    ...(method === "MUTATION" ? { tests: ["accept-once-test"] } : {}),
    ...extra,
  });

test("MBT・QUINT・ALLOY・MUTATIONの候補は保留でも計画を必須とし、手法ごとの項目を検査する", () => {
  const withCandidate = (method, extra) =>
    v4((d) => {
      d.verificationCandidates.push(methodCandidate(method, extra));
    });
  for (const method of ["MBT", "QUINT", "ALLOY", "MUTATION"]) {
    assert.doesNotThrow(() => validateDocument(withCandidate(method)), method);
    assert.doesNotThrow(
      () => validateDocument(withCandidate(method, { decision: "HOLD", tests: [] })),
      `${method} HOLD`
    );
    assert.doesNotThrow(
      () => validateDocument(withCandidate(method, { plan: undefined, ...decline({ method }) })),
      `${method} DECLINE`
    );
    const missing = /計画には対象・確かめたことになる観測・保証しないことが必要です/u;
    for (const decision of ["ADD", "HOLD"]) {
      for (const [extra, message] of [
        [{ plan: undefined }, missing],
        [{ plan: { ...methodCandidate(method).plan, target: " " } }, missing],
        [{ plan: { ...methodCandidate(method).plan, expectedEvidence: undefined } }, missing],
        [{ plan: { ...methodCandidate(method).plan, limits: "" } }, missing],
        [{ plan: { ...methodCandidate(method).plan, origin: "code" } }, /根拠が必要/u],
        [{ plan: { ...methodCandidate(method).plan, evidence: undefined } }, /根拠は配列/u],
      ]) {
        assert.throws(
          () => validateDocument(withCandidate(method, { decision, ...extra })),
          message,
          `${method} ${decision} ${JSON.stringify(extra)}`
        );
      }
    }
  }
  for (const [method, extra, message] of [
    ["MBT", { plan: plan({ coverage: "全遷移" }) }, /モデルベーステストの計画には対応と被覆目標が必要です/u],
    ["MBT", { plan: plan({ mapping: "対応" }) }, /モデルベーステストの計画には対応と被覆目標が必要です/u],
    ["MBT", { decision: "HOLD", plan: mbtPlan({ coverage: " " }) }, /対応と被覆目標/u],
    ["ALLOY", { plan: plan() }, /Alloyの計画には探索上限と制約が必要です/u],
    ["ALLOY", { decision: "HOLD", plan: plan({ scope: "" }) }, /探索上限と制約/u],
    ["MUTATION", { tests: [] }, /ミューテーションテストの候補には検出を確かめる既存テストが必要です/u],
    ["MUTATION", { tests: undefined }, /検出を確かめる既存テスト/u],
    ["PROPERTY", { plan: plan(), property: property() }, /計画にはMBT・QUINT・ALLOY・MUTATIONのいずれかの検証手法が必要です/u],
  ]) {
    assert.throws(() => validateDocument(withCandidate(method, extra)), message, `${method} ${JSON.stringify(extra)}`);
  }
  // A method-less candidate carries no plan either.
  assert.throws(
    () => validateDocument(v4((d) => { d.verificationCandidates[0].plan = plan(); })),
    /計画にはMBT・QUINT・ALLOY・MUTATIONのいずれかの検証手法が必要です/u
  );
});

test("QUINT・ALLOYと明示した既存テストだけ反例と探索した範囲を必須とし、手法のない古い文書は従来どおり受け付ける", () => {
  const run = (status, extra = {}) => ({
    command: "alloy exec specs/accept.als",
    revision: REVISION,
    source: "CI",
    status,
    ...extra,
  });
  const withTest = (extra, schemaVersion = 4) =>
    (schemaVersion === 4 ? v4 : v3)((d) => {
      Object.assign(d.existingTests[0], extra);
    });
  for (const extra of [
    { method: "ALLOY", result: run("MODEL_NO_COUNTEREXAMPLE", { scope: "依頼3件・受諾者3人まで" }) },
    { method: "ALLOY", result: run("MODEL_COUNTEREXAMPLE", { counterexample: "依頼1件に受諾2件" }) },
    { method: "QUINT", result: run("MODEL_COUNTEREXAMPLE", { counterexample: "受諾→受諾" }) },
    { method: "QUINT", result: run("MODEL_NO_COUNTEREXAMPLE") },
    { method: "QUINT", result: run("MODEL_NO_COUNTEREXAMPLE", { scope: "最大10手順" }) },
    { method: "ALLOY", result: { status: "READ" } },
    // MODEL_* is not limited to formal-model methods.
    { method: "MBT", result: run("MODEL_COUNTEREXAMPLE") },
    { method: "PROPERTY", result: run("PASSED", { scope: "1000件の入力" }) },
    { result: run("MODEL_COUNTEREXAMPLE") },
  ]) {
    assert.doesNotThrow(() => validateDocument(withTest(extra)), JSON.stringify(extra));
  }
  // v3 documents without method keep accepting a bare MODEL_COUNTEREXAMPLE.
  assert.doesNotThrow(() => validateDocument(withTest({ result: run("MODEL_COUNTEREXAMPLE") }, 3)));
  for (const [extra, message] of [
    [{ method: "ALLOY", result: run("MODEL_COUNTEREXAMPLE") }, /形式モデルで反例ありの結果には反例が必要です/u],
    [{ method: "QUINT", result: run("MODEL_COUNTEREXAMPLE") }, /形式モデルで反例ありの結果には反例が必要です/u],
    [{ method: "ALLOY", result: run("MODEL_NO_COUNTEREXAMPLE") }, /Alloyで反例なしの結果には実際に探索した範囲が必要です/u],
    [{ result: run("PASSED", { scope: " " }) }, /探索した範囲は空でない文字列/u],
    [{ result: { scope: "依頼3件", status: "READ" } }, /探索した範囲は実際の実行結果にだけ記録できます/u],
    [{ result: { scope: "依頼3件", status: "NOT_RUN" } }, /探索した範囲は実際の実行結果にだけ記録できます/u],
  ]) {
    assert.throws(() => validateDocument(withTest(extra)), message, JSON.stringify(extra));
  }
  // The new fields need schemaVersion 4 so an older template never drops them.
  for (const mutate of [
    (d) => {
      d.existingTests[0].result = run("PASSED", { scope: "依頼3件" });
    },
    (d) => {
      d.verificationCandidates[0].plan = plan();
    },
  ]) {
    assert.throws(() => validateDocument(v3(mutate)), /schemaVersion: 4/u);
  }
});

test("AI更新で消えた不採用や手法付きの候補は、retiredがなければ競合にする", () => {
  const before = validateDocument(
    v4((d) => {
      d.verificationCandidates.push(decline(), methodCandidate("MBT"), methodCandidate("MUTATION"));
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
  for (const id of ["decline-alloy", "accept-mbt", "accept-mutation"]) {
    const drop = (d) => {
      const index = d.verificationCandidates.findIndex((c) => c.id === id);
      return d.verificationCandidates.splice(index, 1)[0];
    };
    assert.equal(update(drop), true, id);
    assert.equal(
      update((d) => {
        d.retired.push({ entity: "verificationCandidate", item: drop(d), view: "verification" });
      }),
      false,
      id
    );
  }
  // Reconsidering under the same ID may change the decision.
  assert.equal(
    update((d) => {
      Object.assign(d.verificationCandidates.find((c) => c.id === "decline-alloy"), {
        boundary: { evidence: [], kind: "DOMAIN", origin: "inference" },
        decision: "HOLD",
        plan: plan({ scope: "依頼3件まで" }),
      });
    }),
    false
  );
});

test("verification.mdは業務ルールごとに手法でまとめ、計画・保証しないこと・不採用・探索した範囲を区別して示す", () => {
  const doc = validateDocument(
    v4((d) => {
      d.existingTests[0] = existingTest({
        method: "ALLOY",
        result: {
          command: "alloy exec specs/accept.als",
          counterexample: "依頼1件に受諾2件",
          revision: REVISION,
          scope: "依頼3件・受諾者3人まで",
          source: "CI",
          status: "MODEL_COUNTEREXAMPLE",
        },
      });
      d.verificationCandidates.push(
        methodCandidate("MBT"),
        methodCandidate("ALLOY", { decision: "KEEP", tests: ["accept-once-test"] }),
        methodCandidate("MUTATION"),
        decline({ method: "QUINT", title: "再受諾の拒否にQuintは使わない" })
      );
    })
  );
  const file = artifacts(doc)["verification.md"];
  const section = (heading) => {
    const start = file.indexOf(heading);
    assert.notEqual(start, -1, heading);
    const next = file.indexOf("\n#", start + heading.length);
    return file.slice(start, next === -1 ? undefined : next);
  };
  const ruleBlock = file.slice(file.indexOf("## 業務ルール:"), file.indexOf("\n## 未確認事項"));
  const order = [
    "### 既存テスト: 再受諾を拒否するテスト",
    "### 検証手法: モデルベーステスト",
    "#### 検証候補: MBTで再受諾の拒否を確かめる",
    "### 検証手法: Alloy",
    "### 検証手法: ミューテーションテスト",
    "### 検証手法: 未定",
    "#### 検証候補: 同時受諾の二重成功を検出する",
    "### 不採用の検証手法",
    "#### 検証候補: 再受諾の拒否にQuintは使わない",
  ].map((heading) => ruleBlock.indexOf(heading));
  assert.ok(order.every((at) => at !== -1), JSON.stringify(order));
  assert.deepEqual(order, order.toSorted((a, b) => a - b));
  assert.doesNotMatch(ruleBlock, /### 検証手法: Quint/u);

  const mbt = section("#### 検証候補: MBTで再受諾の拒否を確かめる");
  assert.match(mbt, /計画の対象（AIの推測）: 依頼の受諾待ち・受諾済みの状態と受諾の操作/u);
  assert.match(mbt, /確かめたことになる観測: 受諾済みの依頼への受諾がすべて拒否されること/u);
  assert.match(mbt, /モデルと実装の対応: モデルの受諾操作をAPIの受諾要求に/u);
  assert.match(mbt, /被覆目標: 受諾済みからの再受諾と/u);
  assert.match(mbt, /\*\*保証しないこと\*\*: 保存先の同時実行制御が正しいことは保証しない/u);
  const alloy = section("#### 検証候補: ALLOYで再受諾の拒否を確かめる");
  assert.match(alloy, /計画時の探索範囲: 依頼3件・受諾者3人まで/u);
  assert.doesNotMatch(alloy, /実際に探索した範囲/u);
  const declined = section("#### 検証候補: 再受諾の拒否にQuintは使わない");
  assert.match(declined, /判断: 不採用/u);
  assert.match(declined, /検証手法: Quint/u);
  assert.match(declined, /理由: 再受諾の拒否は1件の依頼の状態だけで決まり/u);
  const tested = section("### 既存テスト: 再受諾を拒否するテスト");
  assert.match(tested, /検証手法: Alloy/u);
  assert.match(tested, /検証結果: 形式モデルで反例あり/u);
  assert.match(tested, /実際に探索した範囲: 依頼3件・受諾者3人まで/u);
  assert.doesNotMatch(tested, /計画時の探索範囲/u);
  assert.match(tested, /反例: ` 依頼1件に受諾2件 `/u);

  // The TIA note appears only when a merge or delete is proposed.
  const tia = /TIA（変更時に先に実行するテストの選択）の選外は、統合・削除の理由になりません/u;
  assert.doesNotMatch(file, tia);
  for (const decision of ["MERGE", "DELETE"]) {
    const withChange = validateDocument(
      v4((d) => {
        d.verificationCandidates[1].decision = decision;
      })
    );
    assert.equal(artifacts(withChange)["verification.md"].match(new RegExp(tia, "gu"))?.length, 1, decision);
  }
});
