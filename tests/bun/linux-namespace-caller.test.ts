import { test, expect } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "../..");
const modulePath = join(root, "development/probe-linux-namespace-caller.mjs");

test.skipIf(process.platform !== "linux")(
  "caller比較は同じ測定コードでBunとNodeの正確なEPERM・成功対照を検査する",
  async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-caller-contract-"));
    try {
      const unshare = join(directory, "unshare");
      fs.writeFileSync(
        unshare,
        [
          "#!/bin/bash",
          'if [[ "$1" == --map-current-user ]]; then',
          '  case "$CALLER_FIXTURE" in',
          "    passes) exit 0 ;;",
          '    other) echo "unshare: different failure" >&2; exit 1 ;;',
          '    stdout) echo "unexpected output" ;;',
          "  esac",
          '  echo "unshare: write failed /proc/self/uid_map: Operation not permitted" >&2',
          "  exit 1",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const driver = join(directory, "driver.mjs");
      fs.writeFileSync(
        driver,
        [
          `import { measure } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
          "console.log(JSON.stringify(measure(process.argv[2], process.argv[3])));",
        ].join("\n"),
      );
      const node = Bun.which("node");
      expect(node).not.toBeNull();
      const api = await import(pathToFileURL(modulePath).href);
      const records = new Map<string, any>();
      for (const fixture of ["minimal", "passes", "other", "stdout"]) {
        const pair: Record<string, any> = {};
        for (const [name, runtime] of [
          ["bun", process.execPath],
          ["node", node!],
        ]) {
          const result = spawnSync(runtime!, [driver, unshare, root], {
            cwd: root,
            encoding: "utf8",
            timeout: 20_000,
            env: { ...process.env, CALLER_FIXTURE: fixture },
          });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(0);
          expect(result.stderr).toBe("");
          const record = JSON.parse(result.stdout);
          expect(record.runtime.name).toBe(name);
          expect(record.runtime.path).toBe(fs.realpathSync(runtime!));
          expect(record.runtime.hash).toMatch(/^[a-f0-9]{64}$/);
          expect(record.controllerHash).toMatch(/^[a-f0-9]{64}$/);
          expect(record.before).toEqual(record.after);
          expect(record.before.namespaces).toEqual(
            Object.fromEntries(
              ["user", "pid", "mnt"].map((name) => [
                name,
                fs.readlinkSync("/proc/self/ns/" + name),
              ]),
            ),
          );
          expect(record.cases).toHaveLength(2);
          for (const [index, scenario] of record.cases.entries()) {
            expect(scenario.argv).toEqual(
              index === 0 ? ["--map-current-user", "--", "/usr/bin/true"] : ["--", "/usr/bin/true"],
            );
            expect(scenario.probes).toHaveLength(3);
            for (const probe of scenario.probes) {
              expect(probe.pid).toBeGreaterThan(0);
              expect(probe.argv).toEqual(scenario.argv);
              expect(probe.elapsedMs).toBeGreaterThanOrEqual(0);
              expect(Date.parse(probe.endedAt)).toBeGreaterThanOrEqual(Date.parse(probe.startedAt));
              expect(probe.signal).toBeNull();
              expect(probe.error).toBeUndefined();
              if (fixture === "minimal" && index === 0) {
                expect(probe.status).toBe(1);
                expect(probe.stderr).toBe(
                  "unshare: write failed /proc/self/uid_map: Operation not permitted\n",
                );
              }
              if (index === 1) {
                expect(probe.status).toBe(0);
                expect(probe.stdout).toBe("");
                expect(probe.stderr).toBe("");
              }
            }
          }
          pair[name!] = record;
        }
        expect(api.compare(pair.bun, pair.node)).toBe(
          fixture === "minimal"
            ? "bun-not-required"
            : fixture === "passes"
              ? "not-reproduced"
              : "unavailable",
        );
        records.set(fixture, pair);
      }
      const red = records.get("minimal");
      const green = records.get("passes");
      expect(api.compare(red.bun, green.node)).toBe("caller-dependent");
      for (const mutate of [
        (record: any) => {
          record.cases[0].probes[1].status = 0;
          record.cases[0].probes[1].stderr = "";
        },
        (record: any) => {
          record.cases[0].probes[0].signal = "SIGKILL";
        },
        (record: any) => {
          record.cases[0].probes[0].error = "ETIMEDOUT";
        },
        (record: any) => {
          record.cases[0].probes[0].pid = 0;
        },
        (record: any) => {
          record.cases[0].probes[0].argv = ["--", "/usr/bin/true"];
        },
        (record: any) => {
          record.cases[1].probes[0].status = 1;
        },
        (record: any) => {
          record.cases[1].probes[0].stdout = "unexpected";
        },
        (record: any) => {
          record.cases[0].probes.pop();
        },
        (record: any) => {
          record.before.uid = 0;
          record.after.uid = 0;
        },
        (record: any) => {
          record.after.contexts["/proc/self/attr/current"] = { value: "changed" };
        },
        (record: any) => {
          record.before.namespaces.user = "user:[different]";
          record.after.namespaces.user = "user:[different]";
        },
        (record: any) => {
          record.unshare.hash = "0".repeat(64);
        },
        (record: any) => {
          record.controllerHash = "0".repeat(64);
        },
        (record: any) => {
          record.probeEnvironment = "empty";
        },
      ]) {
        const changed = structuredClone(red.node);
        mutate(changed);
        expect(api.compare(red.bun, changed)).toBe("unavailable");
      }
      const invalidMode = spawnSync(node!, [modulePath, "unknown", root, directory], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(invalidMode.status).toBe(2);
      expect(invalidMode.stdout).toContain(
        "run SOURCE OUTPUT BUN / environment SOURCE OUTPUT / measure SOURCE OUTPUT が必要です",
      );
      const invalid = join(directory, "invalid");
      const failed = spawnSync(node!, [modulePath, "run", root, invalid, process.execPath], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, ImageOS: "ubuntu22", PROOF_SOURCE_SHA: "invalid" },
      });
      expect(failed.status).toBe(2);
      const failurePath = join(invalid, "namespace-caller.json");
      const saved = fs.readFileSync(failurePath, "utf8");
      expect(JSON.parse(saved).outcome).toBe("unavailable");
      expect(JSON.parse(saved).error).toContain("namespace比較はUbuntu 24.04");
      expect(JSON.parse(saved).schema).toBe("linux-namespace-caller-comparison/v1");
      expect(fs.existsSync(join(invalid, "namespace-environment.json"))).toBe(false);
      expect(failed.stdout).not.toContain(
        "run SOURCE OUTPUT BUN / environment SOURCE OUTPUT / measure SOURCE OUTPUT が必要です",
      );
      expect(fs.statSync(failurePath).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(join(invalid, "caller-bun.json"))).toBe(false);
      const repeated = spawnSync(node!, [modulePath, "run", root, invalid, process.execPath], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(repeated.status).toBe(2);
      expect(repeated.stdout).toContain("EEXIST");
      expect(fs.readFileSync(failurePath, "utf8")).toBe(saved);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  40_000,
);

test.skipIf(process.platform !== "linux")(
  "環境比較はNodeを固定しunshareへ渡すenvだけを空にして判定する",
  async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-environment-contract-"));
    try {
      const node = Bun.which("node");
      expect(node).not.toBeNull();
      const capture = join(directory, "capture.jsonl");
      const behavior = join(directory, "behavior");
      const unshare = join(directory, "unshare.mjs");
      fs.writeFileSync(
        unshare,
        [
          "#!" + fs.realpathSync(node!),
          'import * as fs from "node:fs";',
          'if (process.argv[2] === "--version") { console.log("fixture-unshare"); process.exit(0); }',
          `const capture = ${JSON.stringify(capture)};`,
          `const behavior = fs.readFileSync(${JSON.stringify(behavior)}, "utf8");`,
          'const sentinel = process.env.PROBE_ENV_SENTINEL === "public-fixture";',
          'fs.appendFileSync(capture, JSON.stringify({pid:process.pid, keys:Object.keys(process.env).length, sentinel}) + "\\n");',
          'if (process.argv[2] === "--map-current-user" && behavior !== "passes" && (behavior !== "dependent" || sentinel)) {',
          '  process.stderr.write("unshare: write failed /proc/self/uid_map: Operation not permitted\\n");',
          "  process.exitCode = 1;",
          "}",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const driver = join(directory, "driver.mjs");
      fs.writeFileSync(
        driver,
        [
          `import { measure } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
          "console.log(JSON.stringify(measure(process.argv[2], process.argv[3], process.argv[4])));",
        ].join("\n"),
      );
      const api = await import(pathToFileURL(modulePath).href);
      const pairs = new Map<string, Record<string, any>>();
      for (const [variant, expected] of [
        ["red", "environment-not-required"],
        ["dependent", "environment-dependent"],
        ["passes", "not-reproduced"],
      ]) {
        fs.writeFileSync(behavior, variant!);
        const pair: Record<string, any> = {};
        for (const policy of ["inherited", "empty"]) {
          fs.writeFileSync(capture, "");
          const result = spawnSync(node!, [driver, unshare, root, policy], {
            cwd: root,
            encoding: "utf8",
            timeout: 20_000,
            env: { ...process.env, PROBE_ENV_SENTINEL: "public-fixture" },
          });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(0);
          expect(result.stderr).toBe("");
          const record = JSON.parse(result.stdout);
          const observed = fs
            .readFileSync(capture, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(observed).toHaveLength(6);
          for (const observation of observed) {
            if (policy === "empty") {
              expect(observation.keys).toBe(0);
              expect(observation.sentinel).toBe(false);
            } else {
              expect(observation.keys).toBeGreaterThan(0);
              expect(observation.sentinel).toBe(true);
            }
          }
          expect(record.runtime.name).toBe("node");
          expect(record.before).toEqual(record.after);
          expect(record.cases).toHaveLength(2);
          const probes = record.cases.flatMap((entry: any) => entry.probes);
          expect(probes.map((probe: any) => probe.pid)).toEqual(
            observed.map((observation) => observation.pid),
          );
          for (const [index, scenario] of record.cases.entries()) {
            expect(scenario.probes).toHaveLength(3);
            expect(scenario.argv).toEqual(
              index === 0 ? ["--map-current-user", "--", "/usr/bin/true"] : ["--", "/usr/bin/true"],
            );
            for (const probe of scenario.probes) {
              const red =
                index === 0 &&
                variant !== "passes" &&
                (variant !== "dependent" || policy === "inherited");
              expect(probe.status).toBe(red ? 1 : 0);
              expect(probe.stdout).toBe("");
              expect(probe.stderr).toBe(
                red ? "unshare: write failed /proc/self/uid_map: Operation not permitted\n" : "",
              );
            }
          }
          pair[policy] = record;
        }
        expect(pair.inherited.probeEnvironment).toBe("inherited");
        expect(pair.empty.probeEnvironment).toBe("empty");
        expect(api.compareEnvironment(pair.inherited, pair.empty)).toBe(expected);
        pairs.set(variant!, pair);
      }
      const red = pairs.get("red")!;
      const green = pairs.get("passes")!;
      expect(api.compareEnvironment(green.inherited, red.empty)).toBe("unavailable");
      for (const mutate of [
        (record: any) => {
          record.probeEnvironment = "inherited";
        },
        (record: any) => {
          record.runtime.name = "bun";
        },
        (record: any) => {
          record.runtime.version = "0.0.0";
        },
        (record: any) => {
          record.runtime.path += "-other";
        },
        (record: any) => {
          record.runtime.hash = "0".repeat(64);
        },
        (record: any) => {
          record.runtime.ppid += 1;
        },
        (record: any) => {
          record.before.namespaces.user = "user:[different]";
          record.after.namespaces.user = "user:[different]";
        },
      ]) {
        const changed = structuredClone(red.empty);
        mutate(changed);
        expect(api.compareEnvironment(red.inherited, changed)).toBe("unavailable");
      }
      expect(() => api.measure(unshare, root, "unknown")).toThrow("probeの環境方式が不正です");
      const output = join(directory, "invalid");
      const failed = spawnSync(node!, [modulePath, "environment", root, output], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, ImageOS: "ubuntu22" },
      });
      expect(failed.status).toBe(2);
      const evidencePath = join(output, "namespace-environment.json");
      const saved = fs.readFileSync(evidencePath, "utf8");
      expect(JSON.parse(saved).error).toContain("namespace比較はUbuntu 24.04");
      expect(JSON.parse(saved).schema).toBe("linux-namespace-environment-comparison/v1");
      expect(fs.existsSync(join(output, "namespace-caller.json"))).toBe(false);
      expect(JSON.parse(saved).outcome).toBe("unavailable");
      expect(fs.statSync(evidencePath).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(join(output, "environment-inherited.json"))).toBe(false);
      const repeated = spawnSync(node!, [modulePath, "environment", root, output], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(repeated.status).toBe(2);
      expect(repeated.stdout).toContain("EEXIST");
      expect(fs.readFileSync(evidencePath, "utf8")).toBe(saved);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  40_000,
);
