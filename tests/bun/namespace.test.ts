import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { resolve } from "node:path";
import type { NamespaceSnapshot } from "../fixtures/bun-namespace.ts";

const root = resolve(import.meta.dir, "../..");
const runner = resolve(root, "lib/bun/run");
const fixture = resolve(root, "tests/fixtures/bun-namespace.ts");
const legacy = resolve(root, "share/codex-isolation/codex-namespace.py");
const real = process.platform === "linux" && process.env.NAMESPACE_PROOF_REAL === "1";
type Observation = { event: string; snapshot: NamespaceSnapshot; port53?: string };
const records: object[] = [];
const directories: string[] = [];
const hostState = () => ({
  namespaces: ["/proc/self/ns/user", "/proc/self/ns/net"].map((path) => statSync(path).ino),
  settings: [
    "/proc/self/uid_map",
    "/proc/self/gid_map",
    "/proc/self/setgroups",
    "/proc/sys/net/ipv4/ip_unprivileged_port_start",
  ].map((path) => readFileSync(path, "utf8")),
});
const originalHostState = process.platform === "linux" ? hostState() : null;

function run(args: string[], executable = runner, env = process.env) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 15_000, env });
  expect(result.error).toBeUndefined();
  return result;
}

function events(stdout: string): Observation[] {
  return stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

afterAll(() => {
  if (originalHostState) expect(hostState()).toEqual(originalHostState);
  console.log(
    JSON.stringify({
      boundary: "namespace",
      os: process.platform,
      kernel: release(),
      architecture: process.arch,
      bun: Bun.version,
      realNamespace: real ? "executed-see-results" : "not-requested",
      sourceRevision: run(["rev-parse", "HEAD"], "git").stdout.trim(),
      legacySourceHash: createHash("sha256").update(readFileSync(legacy)).digest("hex"),
      fixtureSourceHash: createHash("sha256").update(readFileSync(fixture)).digest("hex"),
      tools: real
        ? Object.fromEntries(
            ["unshare", "setpriv", "bwrap", "python3"].map((tool) => {
              const result = run(["--version"], tool);
              expect(result.status).toBe(0);
              return [tool, result.stdout.trim()];
            }),
          )
        : null,
      ip: real ? run(["-Version"], "ip").stdout.trim() : null,
      records,
      adoption: "not-decided",
    }),
  );
  for (const path of directories) rmSync(path, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("namespace の準備境界", () => {
  test("共有 network namespace では設定を書き換えず target を起動しない", () => {
    const result = spawnSync(
      runner,
      [
        "run",
        fixture,
        "prepare",
        String(statSync("/proc/self/ns/user").ino),
        String(statSync("/proc/self/ns/net").ino),
        "normal",
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("private network namespace が必要です");
    expect(result.stdout).not.toContain('"event":"target"');
  });
});

describe.skipIf(!real)("実 namespace（明示 opt-in）", () => {
  test("OS ツールと Bun で loopback と port 53 を準備し bubblewrap 内では全 capability を落とす", () => {
    const result = spawnSync(runner, ["run", fixture, "launch", "normal"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(37);
    const target = events(result.stdout).find((event) => event.event === "target")!;
    expect(target.port53).toBe("bound");
    expect(target.snapshot.setgroups).toBe("deny");
    expect(target.snapshot.unprivilegedPortStart).toBe(0);
    expect(target.snapshot.addresses).toContain("127.0.0.1");
    for (const value of Object.values(target.snapshot.capabilities))
      expect(value).toBe("0000000000000000");
  });

  test("旧 namespace の実 main と mapping・exec 前後の capability を比較する", () => {
    const reference = run(
      [
        "-I",
        "-c",
        String.raw`
import json, os, runpy, sys
from pathlib import Path
source = sys.argv.pop(1)
original = os.execv
def observe(path, argv):
    def mapping(name):
        return [list(map(int, line.split())) for line in Path('/proc/self/' + name + '_map').read_text().splitlines()]
    caps = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if line.startswith('Cap'))
    print(json.dumps({'event': 'legacy-prepared', 'snapshot': {
        'uid': os.getuid(), 'gid': os.getgid(), 'uidMap': mapping('uid'), 'gidMap': mapping('gid'),
        'setgroups': Path('/proc/self/setgroups').read_text().strip(),
        'capabilities': {key: value.strip() for key, value in caps.items()},
        'namespaces': {key: str(Path('/proc/self/ns/' + key).stat().st_ino) for key in ['user', 'net']},
        'unprivilegedPortStart': int(Path('/proc/sys/net/ipv4/ip_unprivileged_port_start').read_text())
    }}), flush=True)
    original(path, argv)
os.execv = observe
runpy.run_path(source)['main']()
`,
        legacy,
        runner,
        "run",
        fixture,
        "bwrap",
      ],
      "python3",
    );
    const candidate = run(["run", fixture, "launch", "normal"]);
    expect(reference.stderr).toBe("");
    expect(reference.status).toBe(37);
    expect(candidate.stderr).toBe("");
    expect(candidate.status).toBe(37);
    const oldEvents = events(reference.stdout);
    const newEvents = events(candidate.stdout);
    const direct = run(["-I", legacy, runner, "run", fixture, "bwrap"], "python3");
    expect(direct.status).toBe(37);
    expect(direct.stderr).toBe("");
    const old = oldEvents.find((event) => event.event === "legacy-prepared")!.snapshot;
    const prepared = newEvents.find((event) => event.event === "prepared")!.snapshot;
    const parent = newEvents.find((event) => event.event === "parent")!.snapshot;
    expect(prepared.namespaces.user).not.toBe(parent.namespaces.user);
    expect(prepared.namespaces.net).not.toBe(parent.namespaces.net);
    expect(prepared.interfaces).toEqual(["lo"]);
    for (const observation of [old, prepared]) {
      expect(observation.uid).toBe(process.getuid!());
      expect(observation.gid).toBe(process.getgid!());
      expect(observation.uidMap).toEqual([[process.getuid!(), process.getuid!(), 1]]);
      expect(observation.gidMap).toEqual([[process.getgid!(), process.getgid!(), 1]]);
      expect(observation.setgroups).toBe("deny");
      expect(observation.unprivilegedPortStart).toBe(0);
      for (const key of ["CapPrm", "CapEff", "CapBnd"])
        expect(BigInt("0x" + observation.capabilities[key]!)).toBeGreaterThan(0n);
    }
    expect(old.capabilities.CapInh).toBe("0000000000000000");
    expect(old.capabilities.CapAmb).toBe("0000000000000000");
    expect(Object.keys(prepared.capabilities).sort()).toEqual([
      "CapAmb",
      "CapBnd",
      "CapEff",
      "CapInh",
      "CapPrm",
    ]);
    for (const value of Object.values(prepared.capabilities))
      expect(value).toBe(old.capabilities.CapEff!);
    for (const observations of [oldEvents, newEvents]) {
      const before = observations.find((event) => event.event === "before-bwrap")!.snapshot;
      for (const key of ["CapInh", "CapPrm", "CapEff", "CapAmb"])
        expect(before.capabilities[key]).toBe("0000000000000000");
      expect(before.capabilities.CapBnd).toBe(old.capabilities.CapBnd!);
      const inside = observations.find((event) => event.event === "target")!.snapshot;
      expect(Object.keys(inside.capabilities).sort()).toEqual([
        "CapAmb",
        "CapBnd",
        "CapEff",
        "CapInh",
        "CapPrm",
      ]);
      expect(inside.interfaces).toEqual(["lo"]);
      expect(inside.namespaces.net).toBe(before.namespaces.net);
      expect(inside.namespaces.user).not.toBe(before.namespaces.user);
      const oldInside = oldEvents.find((event) => event.event === "target")!.snapshot;
      expect(inside.uid).toBe(old.uid);
      expect(inside.gid).toBe(old.gid);
      expect(inside.uidMap).toEqual(oldInside.uidMap);
      expect(inside.gidMap).toEqual(oldInside.gidMap);
      expect(inside.addresses).toContain("127.0.0.1");
      for (const value of Object.values(inside.capabilities))
        expect(value).toBe("0000000000000000");
    }
    records.push({ reference: oldEvents, candidate: newEvents });
  });

  test("capability を保持したまま bubblewrap へ渡す対照は拒否され target を起動しない", () => {
    const result = run(["run", fixture, "launch", "retain-caps"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unexpected capabilities but not setuid");
    expect(result.stdout).not.toContain('"event":"target"');
  });

  test("exec で capability を失う対照は sysctl 設定で停止する", () => {
    const result = run(["run", fixture, "launch", "no-keep-caps"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/EACCES|EPERM/);
    expect(result.stdout).not.toContain('"event":"prepared"');
    expect(result.stdout).not.toContain('"event":"target"');
  });

  test("sysctl=1024 の対照は capability 除去後に port 53 を bind できない", () => {
    const result = run(["run", fixture, "launch", "privileged-port"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("EACCES");
    expect(result.stdout).toContain('"event":"before-bwrap"');
    expect(result.stdout).not.toContain('"event":"target"');
  });

  for (const [tool, status] of [
    ["unshare", 23],
    ["ip", 24],
    ["setpriv", 25],
    ["bwrap", 26],
  ] as const) {
    test(`${tool} の失敗理由と終了状態を保持し隔離なしで起動しない`, () => {
      const directory = mkdtempSync(resolve(tmpdir(), "namespace-tools-"));
      directories.push(directory);
      writeFileSync(
        resolve(directory, tool),
        `#!/bin/sh\nprintf 'fixture-${tool}-failure\\n' >&2\nexit ${status}\n`,
        { mode: 0o700 },
      );
      const before = readFileSync("/proc/sys/net/ipv4/ip_unprivileged_port_start", "utf8");
      const net = statSync("/proc/self/ns/net").ino;
      const result = run(["run", fixture, "launch", "normal"], runner, {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
      });
      expect(result.status).toBe(status);
      expect(result.stderr).toContain(`fixture-${tool}-failure`);
      if (tool === "ip") expect(result.stderr).toContain('"status":24');
      expect(result.stdout).not.toContain('"event":"target"');
      expect(readFileSync("/proc/sys/net/ipv4/ip_unprivileged_port_start", "utf8")).toBe(before);
      expect(statSync("/proc/self/ns/net").ino).toBe(net);
      records.push({ tool, status: result.status, stderr: result.stderr });
    });
  }

  test("unshare が見つからない環境では明示的に停止する", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "namespace-missing-"));
    directories.push(directory);
    for (const tool of ["bun", "dirname"]) symlinkSync(Bun.which(tool)!, resolve(directory, tool));
    const result = run(["run", fixture, "launch", "normal"], runner, {
      ...process.env,
      PATH: directory,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unshare");
    expect(result.stderr).toMatch(/ENOENT|Executable not found/);
    expect(result.stdout).not.toContain('"event":"target"');
  });

  test("候補の正常系は Python のない PATH でも成立する", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "namespace-no-python-"));
    directories.push(directory);
    for (const tool of ["bun", "dirname", "unshare", "ip", "setpriv", "bwrap"])
      symlinkSync(Bun.which(tool)!, resolve(directory, tool));
    const result = run(["run", fixture, "launch", "normal"], runner, {
      ...process.env,
      PATH: directory,
    });
    expect(result.status).toBe(37);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"event":"target"');
  });

  test("OS ツールの signal 終了を記録し target を起動しない", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "namespace-signal-"));
    directories.push(directory);
    writeFileSync(resolve(directory, "unshare"), "#!/bin/sh\nkill -TERM $$\n", { mode: 0o700 });
    const result = run(["run", fixture, "launch", "normal"], runner, {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
    });
    expect(result.status).toBe(143);
    expect(result.stdout).toContain('"signal":"SIGTERM"');
    expect(result.stdout).not.toContain('"event":"target"');
  });
});
