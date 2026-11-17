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
        "run SOURCE OUTPUT BUN / measure SOURCE OUTPUT が必要です",
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
      expect(JSON.parse(saved).error).toContain("caller比較はUbuntu 24.04");
      expect(failed.stdout).not.toContain(
        "run SOURCE OUTPUT BUN / measure SOURCE OUTPUT が必要です",
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
