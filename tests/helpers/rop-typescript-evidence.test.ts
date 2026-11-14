import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { resolve } from "node:path";
import corpus from "../fixtures/quality-python.json";

const script = resolve(
  import.meta.dir,
  "../../skills/domain-modeling-studio/scripts/extract-typescript.ts",
);
const native = !!Bun.which("ast-grep");
const oldBun = process.env.TYPESCRIPT_EVIDENCE_OLD_BUN;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

class Fixture {
  root: string;
  bin: string;
  index = 0;
  constructor(readonly name: string) {
    fs.mkdirSync("/tmp/codex", { recursive: true, mode: 0o700 });
    const shared = fs.lstatSync("/tmp/codex");
    if (!shared.isDirectory() || shared.uid !== process.getuid!())
      throw Error("/tmp/codex は実行ユーザー所有の通常 directory が必要です");
    this.root = fs.realpathSync(fs.mkdtempSync("/tmp/codex/quality-evidence-50-"));
    this.bin = resolve(this.root, "bin");
    fs.mkdirSync(this.bin);
    this.write("main.ts", "const value = work();\n");
  }
  write(path: string, contents: string) {
    fs.writeFileSync(resolve(this.root, path), contents);
  }
  stub(status: number, stdout: string, stderr = "") {
    const program =
      [
        "#!/bin/sh",
        '[ "$#" -eq 5 ] && [ "$1" = scan ] && [ "$2" = --stdin ] && [ "$3" = --inline-rules ] && [ "$5" = --json=compact ] || { echo "fixture: unexpected ast-grep argv" >&2; exit 93; }',
        "while IFS= read -r line; do :; done",
        "printf %s " + quote(stdout),
        "printf %s " + quote(stderr) + " >&2",
        "exit " + status,
      ].join("\n") + "\n";
    fs.writeFileSync(resolve(this.bin, "ast-grep"), program, { mode: 0o755 });
  }
  scan(
    files = ["main.ts"],
    path?: string,
    binary = process.execPath,
    filename = "report/evidence.json",
  ): any {
    const output = resolve(this.root, filename);
    const checked = spawnSync(
      binary,
      [
        "run",
        "--config=/dev/null",
        "--no-env-file",
        script,
        "--repo-root",
        this.root,
        "--output",
        output,
        ...files,
      ],
      {
        cwd: this.root,
        env: { ...process.env, ...(path === undefined ? {} : { PATH: path }) },
        encoding: "utf8",
        timeout: 45_000,
      },
    );
    expect(checked.status, checked.stderr).toBe(0);
    const raw = fs.readFileSync(output, "utf8"),
      result = JSON.parse(raw);
    expect(checked.stdout).toBe(result.status + ": " + output + "\n");
    const legacy = corpus.evidence.cases.filter((item) => item.test.endsWith("." + this.name))[
      this.index++
    ];
    expect(legacy, this.name + " corpus").toBeDefined();
    const expectedRaw = Buffer.from(legacy!.output!, "base64")
      .toString()
      .replaceAll(legacy!.cwd, this.root);
    const expected = JSON.parse(expectedRaw);
    const normalize = (value: any) => {
      if (value.status === "unavailable" && value.reason?.startsWith("Bun 1.4.4 or newer"))
        return { ...value, reason: value.reason.replace(/\(found [^)]+\)/, "(found @OLD_BUN@)") };
      return value;
    };
    expect(normalize(result), this.name + " legacy result").toEqual(normalize(expected));
    const normalizeRaw = (value: string) =>
      this.name === "test_unsupported_bun_is_explicit_before_scanning"
        ? value.replace(/\(found [^)]+\)/g, "(found @OLD_BUN@)")
        : value;
    expect(normalizeRaw(raw), this.name + " legacy bytes").toBe(normalizeRaw(expectedRaw));
    expect(checked.stdout).toBe(legacy!.stdout.replaceAll(legacy!.cwd, this.root));
    expect(checked.stderr).toBe(legacy!.stderr);
    return result;
  }
}
function contract(name: string, body: (fixture: Fixture) => void, enabled = true) {
  (enabled ? test : test.skip)(
    name,
    () => {
      const fixture = new Fixture(name);
      try {
        body(fixture);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    60_000,
  );
}

contract("test_missing_tool_is_explicit", (f) => {
  const result = f.scan(["main.ts"], f.bin);
  expect(result.status).toBe("unavailable");
  expect(result.reason).toContain("PATH");
  expect(result.nodes).toEqual([]);
});
contract(
  "test_unsupported_bun_is_explicit_before_scanning",
  (f) => {
    f.stub(0, "[]");
    const result = f.scan(["main.ts"], f.bin, oldBun!, "unsupported.json");
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("Bun 1.4.4 or newer is required");
    expect(result.files).toEqual([]);
    expect(result.nodes).toEqual([]);
  },
  !!oldBun,
);
contract("test_no_matches_is_success_not_failure", (f) => {
  f.stub(0, "[]");
  const result = f.scan(["main.ts"], f.bin);
  expect(result.status).toBe("ok");
  expect(result.nodes).toEqual([]);
  expect(result.reason).toBeNull();
  expect(result.files[0].sha256).toHaveLength(64);
});
contract("test_nearest_parent_handles_equal_spans_siblings_and_files", (f) => {
  const source = "x".repeat(100),
    spans = [
      [0, 100],
      [0, 80],
      [0, 80],
      [5, 20],
      [20, 40],
      [25, 40],
      [80, 100],
    ];
  const matches = spans.map(([start, end]) => ({
    ruleId: "call_expression",
    text: source.slice(start, end),
    range: { byteOffset: { start, end } },
  }));
  for (const name of ["main.ts", "second.ts"]) f.write(name, source);
  f.stub(0, JSON.stringify(matches));
  const result = f.scan(["second.ts", "main.ts"], f.bin);
  expect(result.status, result.reason).toBe("ok");
  expect(result.nodes.map((node: any) => node.parent)).toEqual([
    null,
    0,
    0,
    1,
    1,
    4,
    0,
    null,
    7,
    7,
    8,
    8,
    11,
    7,
  ]);
});
contract("test_command_and_json_failures_are_recorded", (f) => {
  for (const [status, stdout, stderr, reason] of [
    [2, "", "bad rules", "bad rules"],
    [0, "invalid JSON", "", "SyntaxError"],
    [0, "{}", "", "non-array result"],
  ] as const) {
    f.stub(status, stdout, stderr);
    const result = f.scan(["main.ts"], f.bin);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain(reason);
    expect(result.nodes).toEqual([]);
  }
});
contract("test_timeout_is_recorded_as_a_failed_scan", (f) => {
  const sleep = Bun.which("sleep");
  expect(sleep).not.toBeNull();
  fs.writeFileSync(resolve(f.bin, "ast-grep"), "#!/bin/sh\nexec " + quote(sleep!) + " 40\n", {
    mode: 0o755,
  });
  const result = f.scan(["main.ts"], f.bin);
  expect(result.status).toBe("failed");
  expect(result.reason).toContain("exceeded 30 seconds");
  expect(result.nodes).toEqual([]);
});
contract("test_mismatched_source_and_parser_error_are_rejected", (f) => {
  const cases: [any, string][] = [
    [{ ruleId: "ERROR" }, "syntax error (ERROR)"],
    [
      { ruleId: "call_expression", text: "other()", range: { byteOffset: { start: 14, end: 20 } } },
      "text does not match",
    ],
    [
      { ruleId: "call_expression", text: "work()", range: { byteOffset: { start: -1, end: 100 } } },
      "invalid source range",
    ],
  ];
  for (const [match, reason] of cases) {
    f.stub(0, JSON.stringify([match]));
    const result = f.scan(["main.ts"], f.bin);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain(reason);
    expect(result.nodes).toEqual([]);
  }
});
contract("test_directories_outside_root_and_other_languages_are_not_scanned", (f) => {
  f.write("other.rs", "fn main() {}");
  f.stub(0, "[]");
  expect(f.scan(["main.ts"], f.bin).status).toBe("ok");
  fs.mkdirSync(resolve(f.root, "nested/directory"), { recursive: true });
  f.write("nested/entry.ts", "work();\n");
  fs.symlinkSync(resolve(f.root, "nested/directory"), resolve(f.root, "directory-link"));
  for (const shadow of [false, true]) {
    if (shadow) f.write("entry.ts", "wrong();\n");
    const result = f.scan(["directory-link/../entry.ts"], f.bin);
    expect(result.status).toBe("ok");
    expect(result.files[0].path).toBe("nested/entry.ts");
  }
  for (const [name, reason] of [
    [".", "Expected a .ts or .tsx file"],
    ["other.rs", "Expected a .ts or .tsx file"],
    ["missing.ts", "ENOENT"],
  ]) {
    const result = f.scan([name!], f.bin);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain(reason!);
  }
  const outside = fs.realpathSync(fs.mkdtempSync("/tmp/codex/quality-evidence-outside-50-"));
  try {
    fs.writeFileSync(resolve(outside, "outside.ts"), "const outside = work();\n");
    fs.symlinkSync(resolve(outside, "outside.ts"), resolve(f.root, "linked.ts"));
    const result = f.scan(["linked.ts"], f.bin);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("outside the repository root");
    expect(result.files).toEqual([]);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
contract(
  "test_native_ts_tsx_unicode_and_source_containment",
  (f) => {
    f.write(
      "main.ts",
      'class Label { catchTag() { return "plain"; } }\nexport const run = () => { const 日本語 = new Label().catchTag(); return Fx.catchTag(load(日本語), "Missing", () => backup()); };\n' +
        'longCall("' +
        "🦊".repeat(200) +
        '");\n',
    );
    f.write("view.tsx", "export const View = () => <p>{run()}</p>;\n");
    f.write("unselected.ts", "unexpected();");
    f.write("sgconfig.yml", "invalid: [");
    const result = f.scan(["main.ts", "view.tsx"]);
    expect(result.status, result.reason).toBe("ok");
    expect(result.capabilities).toBe("syntax-only");
    expect(new Set(result.nodes.map((node: any) => node.path))).toEqual(
      new Set(["main.ts", "view.tsx"]),
    );
    expect(result.nodes.some((node: any) => node.text === "run()")).toBe(true);
    expect(result.nodes.some((node: any) => node.text === "new Label().catchTag()")).toBe(true);
    expect(result.nodes.find((node: any) => node.text.startsWith("longCall(")).text_truncated).toBe(
      true,
    );
    for (const node of result.nodes) {
      const raw = fs.readFileSync(resolve(f.root, node.path));
      expect(
        Array.from(raw.subarray(node.byte_start, node.byte_end).toString()).slice(0, 180).join(""),
      ).toBe(node.text);
      expect(node.end).toBeLessThanOrEqual(raw.toString().trimEnd().split("\n").length);
      expect(node).not.toHaveProperty("type");
      if (node.parent !== null) {
        const parent = result.nodes[node.parent];
        expect(parent.path).toBe(node.path);
        expect(parent.byte_start).toBeLessThanOrEqual(node.byte_start);
        expect(parent.byte_end).toBeGreaterThanOrEqual(node.byte_end);
      }
    }
  },
  native,
);
contract(
  "test_native_parse_failure_discards_partial_batch",
  (f) => {
    f.write("broken.tsx", "const x = <p>{broken(</p>");
    const result = f.scan(["main.ts", "broken.tsx"]);
    expect(result.status).toBe("failed");
    expect(result.nodes).toEqual([]);
  },
  native,
);
contract(
  "test_native_missing_tokens_discard_partial_batch",
  (f) => {
    for (const extension of ["ts", "tsx"])
      for (const contents of ["const a = (1;", "function f() { return 1;", "foo("]) {
        const name = "broken." + extension;
        f.write(name, contents);
        const result = f.scan(["main.ts", name]);
        expect(result.status).toBe("failed");
        expect(result.reason).toContain(name);
        expect(result.nodes).toEqual([]);
      }
  },
  native,
);
contract(
  "test_native_valid_empty_syntax_is_not_a_missing_token",
  (f) => {
    for (const contents of [
      "",
      "// comment\n",
      'const a = ""; const b = \x60\x60; const c = [];',
      "function f() {}",
      "const View = () => <><p />{null}</>;",
    ]) {
      f.write("valid.tsx", contents);
      const result = f.scan(["valid.tsx"]);
      expect(result.status, result.reason).toBe("ok");
    }
  },
  native,
);
contract(
  "test_effect_checkout_fixture_reports_recovery_and_error_mapping_evidence",
  (f) => {
    f.write(
      "checkout.ts",
      fs.readFileSync(resolve(script, "../../tests/fixtures/effect-checkout.ts.fixture"), "utf8"),
    );
    const result = f.scan(["checkout.ts"]);
    expect(result.status, result.reason).toBe("ok");
    const calls = result.nodes
      .filter((node: any) => node.kind === "call_expression")
      .map((node: any) => node.text);
    expect(calls.some((text: string) => text.includes('catchTag("OutOfStock"'))).toBe(true);
    expect(calls.some((text: string) => text.startsWith("Effect.mapError("))).toBe(true);
    expect(calls).toContain("reserve(id)");
    expect(calls).toContain("charge(reserved)");
  },
  native,
);
contract("test_target_bun_config_cannot_preload_target_code", (f) => {
  f.write("bunfig.toml", 'preload = ["./preload.ts"]\n');
  f.write("preload.ts", 'throw new Error("unexpected preload");\n');
  f.stub(0, "[]");
  expect(f.scan(["main.ts"], f.bin).status).toBe("ok");
});
