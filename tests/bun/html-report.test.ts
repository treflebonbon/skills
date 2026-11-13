import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { artifactText } from "../../lib/bun/html-report.ts";
import corpus from "../fixtures/html-report-python.json";

const root = resolve(import.meta.dir, "../..");
const peers = ["herdr-peer-refactor", "orca-peer-refactor"];

function fingerprint(directory: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(directory, { recursive: true, encoding: "utf8" }).sort()) {
    const path = resolve(directory, name);
    const stat = lstatSync(path);
    hash.update(`${name}:${stat.mode}\0`);
    if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
    else if (stat.isFile()) hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

test("読み取り専用 payload は node_modules なしで起動し、cwd と環境の preload を実行しない", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "html-report-payload-"));
  const payload = resolve(temporary, "payload");
  const poison = resolve(temporary, "poison");
  mkdirSync(poison);
  const marker = resolve(temporary, "unexpected-preload");
  writeFileSync(
    resolve(poison, "preload.ts"),
    'import { writeFileSync } from "node:fs"; writeFileSync(process.env.HTML_REPORT_CAPTURE!, "executed");',
  );
  for (const config of ["bunfig.toml", ".bunfig.toml"])
    writeFileSync(resolve(poison, config), 'preload = ["./preload.ts"]\n');
  const files = [
    "lib/bun/run",
    "lib/bun/bunfig.toml",
    "lib/bun/tsconfig.json",
    "lib/bun/html-report.ts",
    "lib/bun/vendor/html-tokenizer.js",
    ...peers.map((peer) => `skills/${peer}/scripts/check-architecture-report`),
  ];
  for (const name of files) {
    const destination = resolve(payload, name);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(resolve(root, name), destination);
    chmodSync(
      destination,
      name.endsWith("/run") || name.endsWith("/check-architecture-report") ? 0o555 : 0o444,
    );
  }
  const directories = [
    payload,
    ...readdirSync(payload, { recursive: true, encoding: "utf8" })
      .map((name) => resolve(payload, name))
      .filter((path) => lstatSync(path).isDirectory()),
  ];
  for (const path of directories) chmodSync(path, 0o555);
  const before = fingerprint(payload);
  const report = resolve(temporary, "report.html");
  writeFileSync(report, '<pre class="mermaid">A --> B</pre>');
  const commands = resolve(temporary, "bin");
  mkdirSync(commands);
  for (const [name, executable] of [
    ["bun", process.execPath],
    ["dirname", Bun.which("dirname")!],
    ["readlink", Bun.which("readlink")!],
  ] as const) {
    symlinkSync(realpathSync(executable), resolve(commands, name));
  }
  const env = {
    ...process.env,
    HOME: poison,
    PATH: commands,
    BUN_OPTIONS: `--preload=${resolve(poison, "preload.ts")}`,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: resolve(payload, "forbidden-cache"),
    HTML_REPORT_CAPTURE: marker,
  };
  try {
    expect(
      (spawnSync("python3", ["--version"], { env }).error as NodeJS.ErrnoException)?.code,
    ).toBe("ENOENT");
    for (const peer of peers) {
      const entry = resolve(temporary, peer);
      symlinkSync(resolve(payload, "skills", peer, "scripts/check-architecture-report"), entry);
      const result = spawnSync(entry, [report], {
        cwd: poison,
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        static_check: "passed",
        expected_mermaid_diagrams: 1,
        render_check: "not_performed",
      });
    }
    expect(existsSync(marker)).toBe(false);
    expect(fingerprint(payload)).toBe(before);
  } finally {
    for (const path of directories) chmodSync(path, 0o700);
    rmSync(temporary, { recursive: true, force: true });
  }
});

for (const peer of peers) {
  test(`${peer}: 引数不足と読めない report の診断を維持する`, () => {
    const entry = resolve(root, "skills", peer, "scripts/check-architecture-report");
    for (const [args, message] of [
      [[], "使い方: check-architecture-report <report.html>"],
      [[resolve(root, "missing-report.html")], "HTML report を UTF-8 で読めません"],
    ] as const) {
      const result = spawnSync(entry, [...args], { encoding: "utf8", timeout: 10_000 });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`エラー: ${message}\n`);
    }
  });
}

test("数値 entity の制御文字・非文字を旧版と同じ text に抽出する", () => {
  const entry = corpus.cases.find((item) => item.name === "numeric-controls")!;
  expect(artifactText(Buffer.from(entry.inputBase64, "base64"))).toBe(entry.text.value!);
});

test.each(corpus.cases)("旧 HTML text 抽出 corpus $name", (entry) => {
  const raw = Buffer.from(entry.inputBase64, "base64");
  if (entry.text.error !== undefined) expect(() => artifactText(raw)).toThrow(entry.text.error);
  else expect(artifactText(raw)).toBe(entry.text.value);
});

for (const peer of peers) {
  test.each(corpus.cases)(`${peer}: 旧 HTML corpus $name`, (entry) => {
    const temporary = mkdtempSync(resolve(tmpdir(), "html-report-corpus-"));
    const report = resolve(temporary, "report.html");
    writeFileSync(report, Buffer.from(entry.inputBase64, "base64"));
    try {
      const result = spawnSync(
        resolve(root, "skills", peer, "scripts/check-architecture-report"),
        [report],
        {
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(entry.checker.status);
      expect(result.stderr).toBe(entry.checker.stderr);
      if (entry.checker.status === 0)
        expect(JSON.parse(result.stdout)).toEqual(JSON.parse(entry.checker.stdout));
      else expect(result.stdout).toBe(entry.checker.stdout);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test(`${peer}: 静的 HTML 検査は図数と描画未実施を返す`, () => {
    const temporary = mkdtempSync(resolve(tmpdir(), "html-report-"));
    const report = resolve(temporary, "report.html");
    writeFileSync(report, '<pre class="mermaid">flowchart TD\nA --> B</pre>');
    try {
      const result = spawnSync(
        resolve(root, "skills", peer, "scripts/check-architecture-report"),
        [report],
        {
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        static_check: "passed",
        expected_mermaid_diagrams: 1,
        render_check: "not_performed",
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
