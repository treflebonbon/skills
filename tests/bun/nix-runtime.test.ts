import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { release, tmpdir } from "node:os";
import { resolve } from "node:path";
import type { RuntimeManifest } from "../fixtures/bun-nix-runtime.ts";

const root = resolve(import.meta.dir, "../..");
const runner = resolve(root, "lib/bun/run");
const fixture = resolve(root, "tests/fixtures/bun-nix-runtime.ts");
const real = process.platform === "linux" && process.env.NIX_BUN_PROOF_REAL === "1";

function digest(directory: string) {
  const hash = createHash("sha256");
  function visit(path: string) {
    const stat = lstatSync(path);
    hash.update(`${path.slice(directory.length)}:${stat.mode}\0`);
    if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
    else if (stat.isDirectory())
      for (const name of readdirSync(path).sort()) visit(resolve(path, name));
    else hash.update(readFileSync(path));
  }
  visit(directory);
  return hash.digest("hex");
}

function record(details: object) {
  const source = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(source.status).toBe(0);
  console.log(
    JSON.stringify({
      boundary: "nix-runtime",
      os: process.platform,
      kernel: release(),
      architecture: process.arch,
      bun: Bun.version,
      sourceRevision: source.stdout.trim(),
      fixtureSourceHash: createHash("sha256").update(readFileSync(fixture)).digest("hex"),
      realIsolation: real ? "executed-see-results" : "not-requested",
      adoption: "not-decided",
      ...details,
    }),
  );
}
afterAll(() => {
  if (!real) record({ manifest: null });
});

test("Nix store 外の Bun は copy や隔離起動の前に拒否する", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "nix-bun-reject-"));
  const state = resolve(temporary, "state");
  try {
    const result = spawnSync(runner, ["run", fixture, "prepare", state, "/usr/bin/env"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Nix store の Bun が必要です");
    expect(existsSync(state)).toBe(false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

describe.skipIf(!real)("Nix closure の実隔離（明示 opt-in）", () => {
  let temporary: string;
  let state: string;
  let manifest: RuntimeManifest;
  let payloadBefore: string;
  let sourceBefore: string;
  let setupMilliseconds: number;
  beforeAll(() => {
    const started = performance.now();
    sourceBefore = digest(resolve(root, "lib/bun"));
    temporary = mkdtempSync(resolve(tmpdir(), "nix-bun-runtime-"));
    state = resolve(temporary, "state");
    const result = spawnSync(runner, ["run", fixture, "prepare", state, process.execPath], {
      encoding: "utf8",
      timeout: 180_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    manifest = JSON.parse(readFileSync(resolve(state, "manifest.json"), "utf8"));
    payloadBefore = digest(resolve(state, "runtime"));
    setupMilliseconds = Math.round(performance.now() - started);
  }, 190_000);
  afterAll(() => {
    if (!temporary) return;
    function writable(path: string) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      chmodSync(path, stat.mode | 0o700);
      for (const name of readdirSync(path)) writable(resolve(path, name));
    }
    try {
      if (manifest) {
        const payloadUnchanged = digest(resolve(state, "runtime")) === payloadBefore;
        const sourceUnchanged = digest(resolve(root, "lib/bun")) === sourceBefore;
        record({ manifest, setupMilliseconds, payloadUnchanged, sourceUnchanged });
        expect(payloadUnchanged).toBe(true);
        expect(sourceUnchanged).toBe(true);
        expect(readFileSync(resolve(state, "outside"), "utf8")).toBe("host-only-fixture");
      }
    } finally {
      writable(temporary);
      rmSync(temporary, { recursive: true, force: true });
    }
  });
  test("コピーした closure と生成 wrapper で専用 HOME・scratch の Bun を起動する", () => {
    expect(readFileSync(resolve(state, "outside"), "utf8")).toBe("host-only-fixture");
    expect(manifest.closure).toContain(resolve(manifest.tools.bun, "../.."));
    expect(manifest.closure.length).toBeGreaterThan(manifest.roots.length);
    const result = spawnSync(runner, ["run", fixture, "run", state, "normal"], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, NIX_BUN_PROOF_POISON: "must-not-enter" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(37);
    expect(result.stderr).toBe("");
    const target = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((event) => event.event === "target");
    expect(target.version).toBe(manifest.bunVersion);
    expect(target.executable).toBe(manifest.tools.bun);
    expect(target.home).toBe("/home/agent");
    expect(target.scratch).toBe("/scratch");
    expect(target.poison).toBeNull();
    expect(target.readonly).toEqual({ runtime: "EROFS", bun: "EROFS" });
    expect(target.homeWrite).toBe("home-fixture");
    expect(target.scratchWrite).toBe("scratch-fixture");
    expect(target.hostVisible).toBe(false);
    expect(target.cache).toBe("0");
  });
  test("選択 Bun を mount しない対照は host Bun に fallback しない", () => {
    const result = spawnSync(runner, ["run", fixture, "run", state, "missing-bun"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Bun 1.4.4 以上が必要です");
    expect(result.stdout).not.toContain('"event":"target"');
  });
  test("package root だけの対照は closure 不足で起動を拒否する", () => {
    const result = spawnSync(runner, ["run", fixture, "run", state, "roots-only"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("execvp");
    expect(result.stderr).toContain("No such file or directory");
    expect(result.stdout).toContain('"event":"launch"');
    expect(result.stdout).not.toContain('"event":"target"');
  });
  test("隔離内の旧版を返す合成 Bun は本体実行前に拒否する", () => {
    const result = spawnSync(runner, ["run", fixture, "run", state, "unsupported-version"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Bun 1.4.4 以上が必要です");
    expect(existsSync(resolve(state, "scratch/old-bun-started"))).toBe(false);
    expect(result.stdout).not.toContain('"event":"target"');
  });
  test("未導入 package の解決は自動 install せず拒否する", () => {
    const result = spawnSync(runner, ["run", fixture, "run", state, "missing-import"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"event":"probe-started"');
    expect(result.stderr).toContain("nix-bun-proof-not-installed");
    expect(result.stdout).not.toContain('"event":"target"');
    expect(existsSync(resolve(state, "runtime/node_modules"))).toBe(false);
    expect(existsSync(resolve(state, "work/node_modules"))).toBe(false);
  });
  test("保存後に Nix store 外へ変更された tool は起動前に拒否する", () => {
    const file = resolve(state, "manifest.json");
    const saved = readFileSync(file);
    const fake = resolve(state, "untrusted-bwrap");
    const marker = resolve(state, "untrusted-called");
    writeFileSync(fake, '#!/bin/sh\nprintf executed > "$NIX_BUN_PROOF_CAPTURE"\n', { mode: 0o700 });
    writeFileSync(file, JSON.stringify({ ...manifest, tools: { ...manifest.tools, bwrap: fake } }));
    try {
      const result = spawnSync(runner, ["run", fixture, "run", state, "normal"], {
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, NIX_BUN_PROOF_CAPTURE: marker },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Nix store 内");
      expect(existsSync(marker)).toBe(false);
    } finally {
      writeFileSync(file, saved);
    }
  });
});
