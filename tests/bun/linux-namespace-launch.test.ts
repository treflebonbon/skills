import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "../..");
const modulePath = join(root, "development/probe-linux-namespace-launch.py");

test.skipIf(process.platform !== "linux")(
  "起動経路比較は共通Python親からNode経由と直接起動を空環境・pipeで照合する",
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-launch-contract-"));
    try {
      const node = Bun.which("node")!;
      const python = Bun.which("python3")!;
      expect(node).not.toBeNull();
      expect(python).not.toBeNull();
      const version = spawnSync(node, ["--version"], { encoding: "utf8" });
      expect(version.status).toBe(0);
      expect(version.stderr).toBe("");
      const supportsProbe = Number(version.stdout.trim().replace(/^v/, "").split(".")[0]) >= 22;
      const capture = join(directory, "capture.jsonl");
      const behavior = join(directory, "behavior");
      const unshare = join(directory, "unshare.mjs");
      fs.writeFileSync(
        unshare,
        [
          "#!" + fs.realpathSync(node),
          'import * as fs from "node:fs";',
          'if (process.argv[2] === "--version") { console.log("fixture-unshare"); process.exit(0); }',
          "const capture = " + JSON.stringify(capture) + ";",
          "const behavior = fs.readFileSync(" + JSON.stringify(behavior) + ', "utf8");',
          'const parent = fs.realpathSync("/proc/" + process.ppid + "/exe");',
          "const fromNode = parent === " + JSON.stringify(fs.realpathSync(node)) + ";",
          'const count = fs.readFileSync(capture, "utf8").trim().split("\\n").filter(Boolean).length;',
          'fs.appendFileSync(capture, JSON.stringify({pid:process.pid, ppid:process.ppid, keys:Object.keys(process.env).length, sentinel:process.env.PROBE_ENV_SENTINEL === "public-fixture", cwd:process.cwd(), stdinNull:fs.readlinkSync("/proc/self/fd/0") === "/dev/null", stdioFlags:[0,1,2].map(fd => fs.readFileSync("/proc/self/fdinfo/" + fd,"utf8").match(/^flags:\\s+(.*)$/m)[1]), outSocket:fs.fstatSync(1).isSocket(), errSocket:fs.fstatSync(2).isSocket()}) + "\\n");',
          'if (process.argv[2] === "--map-current-user" && behavior !== "passes") {',
          '  if (behavior === "dependent" && !fromNode) process.exit(0);',
          '  if (behavior === "mixed" && count === 1) process.exit(0);',
          '  process.stderr.write(behavior === "other" ? "unshare: other failure\\n" : "unshare: write failed /proc/self/uid_map: Operation not permitted\\n");',
          "  process.exitCode = 1;",
          "}",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const nodeDriver = join(directory, "node.mjs");
      fs.writeFileSync(
        nodeDriver,
        [
          "import { measure } from " +
            JSON.stringify(
              pathToFileURL(join(root, "development/probe-linux-namespace-caller.mjs")).href,
            ) +
            ";",
          'console.log(JSON.stringify(measure(process.argv[2], process.argv[3], "empty")));',
        ].join("\n"),
      );
      const driver = join(directory, "driver.py");
      fs.writeFileSync(
        driver,
        [
          "import copy, importlib.util, json, subprocess, sys",
          'spec=importlib.util.spec_from_file_location("probe",' + JSON.stringify(modulePath) + ")",
          "probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)",
          "node=json.loads(subprocess.check_output(sys.argv[1:5],text=True))",
          'direct=probe.measure(sys.argv[3],sys.argv[4]) if node["outcome"]=="uid-map-eperm" else None',
          'result={"node":node,"direct":direct,"outcome":probe.compare(node,direct),"baseline":probe.node_outcome(node)}',
          "if direct:",
          ' result["invalid"]=[]',
          ' for field in ["environment","parent","context","controller","probe","unshare"]:',
          "  changed=copy.deepcopy(direct)",
          '  if field=="environment": changed["probeEnvironment"]="inherited"',
          '  if field=="parent": changed["runtime"]["pid"]+=1',
          '  if field=="context": changed["before"]["namespaces"]["user"]=changed["after"]["namespaces"]["user"]="user:[different]"',
          '  if field=="controller": changed["controllerHash"]="0"*64',
          '  if field=="probe": changed["cases"][0]["probes"][0]["status"]=7',
          '  if field=="unshare": changed["unshare"]["hash"]="0"*64',
          '  result["invalid"].append(probe.compare(node,changed))',
          "  changed=copy.deepcopy(node)",
          '  changed["cases"][0]["probes"][0]["status"]=7',
          '  result["invalidNode"]=probe.node_outcome(changed)',
          ' result["versions"]=[]',
          ' for version in ["20.19.0","22.12.0"]:',
          "  changed=copy.deepcopy(node)",
          '  changed["runtime"]["version"]=version',
          '  result["versions"].append(probe.compare(changed,direct))',
          "print(json.dumps(result))",
        ].join("\n"),
      );
      for (const [variant, expected] of [
        ["red", "node-not-required"],
        ["dependent", "node-launch-dependent"],
        ["passes", "not-reproduced"],
        ["other", "unavailable"],
        ["mixed", "unavailable"],
      ]) {
        fs.writeFileSync(behavior, variant!);
        fs.writeFileSync(capture, "");
        const result = spawnSync(python, ["-I", "-B", driver, node, nodeDriver, unshare, root], {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, PROBE_ENV_SENTINEL: "public-fixture" },
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        const record = JSON.parse(result.stdout);
        expect(record.outcome).toBe(supportsProbe ? expected : "unavailable");
        const observed = fs
          .readFileSync(capture, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(observed).toHaveLength(record.direct ? 12 : 6);
        for (const observation of observed) {
          expect(observation.keys).toBe(0);
          expect(observation.sentinel).toBe(false);
          expect(observation.cwd).toBe(root);
          expect(observation.stdinNull).toBe(true);
          expect(observation.stdioFlags).toEqual(observed[0].stdioFlags);
          expect(observation.outSocket).toBe(true);
          expect(observation.errSocket).toBe(true);
        }
        const records = [record.node, ...(record.direct ? [record.direct] : [])];
        for (const measurement of records) {
          expect(measurement.before).toEqual(measurement.after);
          expect(measurement.probeEnvironment).toBe("empty");
          expect(measurement.cases).toHaveLength(2);
          for (const scenario of measurement.cases) {
            expect(scenario.probes).toHaveLength(3);
            for (const probe of scenario.probes) {
              const actual = observed.find((row: any) => row.pid === probe.pid);
              expect(actual.ppid).toBe(measurement.runtime.pid);
              expect(probe.argv).toEqual(scenario.argv);
              expect(probe.signal).toBeNull();
              expect(probe.error ?? undefined).toBeUndefined();
              expect(probe.elapsedMs).toBeGreaterThanOrEqual(0);
              expect(Date.parse(probe.endedAt)).toBeGreaterThanOrEqual(Date.parse(probe.startedAt));
            }
          }
        }
        if (record.direct) {
          expect(record.direct.runtime.name).toBe("python");
          expect(record.node.runtime.ppid).toBe(record.direct.runtime.pid);
          expect(record.invalid).toEqual(Array(6).fill("unavailable"));
          expect(record.baseline).toBe(supportsProbe ? "uid-map-eperm" : "unavailable");
          expect(record.invalidNode).toBe("unavailable");
          expect(record.versions).toEqual(["unavailable", expected]);
          expect(record.direct.before).toEqual(record.node.before);
          for (const measurement of records)
            for (const scenario of measurement.cases) {
              expect(scenario.argv).toEqual(
                scenario.name === "minimal"
                  ? ["--map-current-user", "--", "/usr/bin/true"]
                  : ["--", "/usr/bin/true"],
              );
              for (const probe of scenario.probes) {
                const red =
                  scenario.name === "minimal" &&
                  (variant === "red" || measurement.runtime.name === "node");
                expect(probe.status).toBe(red ? 1 : 0);
                expect(probe.stdout).toBe("");
                expect(probe.stderr).toBe(
                  red ? "unshare: write failed /proc/self/uid_map: Operation not permitted\n" : "",
                );
              }
            }
        }
      }
      const output = join(directory, "invalid");
      const args = ["-I", modulePath, root, output, node];
      const failed = spawnSync(python, args, {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, ImageOS: "ubuntu22" },
      });
      expect(failed.status).toBe(2);
      const path = join(output, "namespace-launch.json");
      const saved = fs.readFileSync(path, "utf8");
      expect(JSON.parse(saved).outcome).toBe("unavailable");
      expect(JSON.parse(saved).error).toContain("起動経路比較はUbuntu 24.04");
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(join(output, "launch-node.json"))).toBe(false);
      const repeated = spawnSync(python, args, { encoding: "utf8", timeout: 10_000 });
      expect(repeated.status).toBe(2);
      expect(repeated.stdout).toContain("FileExistsError");
      expect(fs.readFileSync(path, "utf8")).toBe(saved);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "直接起動のcaptureは時間・出力上限を超えた結果を成功にしない",
  () => {
    const python = Bun.which("python3")!;
    const code = [
      "import importlib.util,json,sys",
      'spec=importlib.util.spec_from_file_location("probe",' + JSON.stringify(modulePath) + ")",
      "probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)",
      "root=" + JSON.stringify(root),
      'large=probe.capture(sys.executable,["-c","print(\'x\'*1000)"],root,{},limit=64)',
      'slow=probe.capture(sys.executable,["-c","import time;time.sleep(2)"],root,{},timeout=0.05)',
      "boundaries=[]",
      "for out,err in [(64,0),(0,64),(32,32),(33,32),(64,1)]:",
      ' child="import os;os.write(1,b\\\'x\\\'*"+str(out)+");os.write(2,b\\\'y\\\'*"+str(err)+")"',
      ' boundaries.append({"out":out,"err":err,"probe":probe.capture(sys.executable,["-I","-c",child],root,{},limit=64)})',
      "print(json.dumps([large,slow,boundaries]))",
    ].join("\n");
    const result = spawnSync(python, ["-I", "-B", "-c", code], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const [large, slow, boundaries] = JSON.parse(result.stdout);
    expect(large.error).toBe("ENOBUFS");
    expect(large.stdout.length).toBeLessThanOrEqual(64);
    expect(slow.error).toBe("ETIMEDOUT");
    expect(slow.signal).toBe("SIGKILL");
    const node = Bun.which("node")!;
    for (const { out, err, probe } of boundaries) {
      const child =
        "const fs=require('node:fs');fs.writeSync(1,Buffer.alloc(" +
        out +
        "));fs.writeSync(2,Buffer.alloc(" +
        err +
        "));";
      const refCode =
        "const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,['-e'," +
        JSON.stringify(child) +
        "],{maxBuffer:64,killSignal:'SIGKILL'});console.log(JSON.stringify({error:r.error?.code??null,status:r.status}));";
      const rawReference = spawnSync(node, ["-e", refCode], { encoding: "utf8", timeout: 10_000 });
      expect(rawReference.status).toBe(0);
      expect(rawReference.stderr).toBe("");
      const reference = JSON.parse(rawReference.stdout);
      const error = out + err > 64 ? "ENOBUFS" : null;
      expect(reference.error).toBe(error);
      expect(probe.error ?? null).toBe(error);
      expect(probe.stdout.length + probe.stderr.length).toBeLessThanOrEqual(64);
      if (error === null) {
        expect(reference.status).toBe(0);
        expect(probe.status).toBe(0);
      }
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "cwd比較は同じPython親・空環境のままcheckoutと/だけを切り替える",
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-cwd-contract-"));
    try {
      const node = fs.realpathSync(Bun.which("node")!);
      const python = Bun.which("python3")!;
      const capture = join(directory, "cwd.jsonl");
      const behavior = join(directory, "behavior");
      const unshare = join(directory, "unshare.mjs");
      fs.writeFileSync(
        unshare,
        [
          "#!" + node,
          'import * as fs from "node:fs";',
          'if (process.argv[2] === "--version") { console.log("fixture-unshare"); process.exit(0); }',
          "const capture = " + JSON.stringify(capture) + ";",
          "const behavior = fs.readFileSync(" + JSON.stringify(behavior) + ', "utf8");',
          'const count = fs.readFileSync(capture, "utf8").trim().split("\\n").filter(Boolean).length;',
          'fs.appendFileSync(capture, JSON.stringify({pid:process.pid,ppid:process.ppid,cwd:process.cwd(),keys:Object.keys(process.env).length,sentinel:process.env.PROBE_ENV_SENTINEL === "public-fixture",stdinNull:fs.readlinkSync("/proc/self/fd/0") === "/dev/null",stdioFlags:[0,1,2].map(fd=>fs.readFileSync("/proc/self/fdinfo/"+fd,"utf8").match(/^flags:\\s+(.*)$/m)[1]),outSocket:fs.fstatSync(1).isSocket(),errSocket:fs.fstatSync(2).isSocket()})+"\\n");',
          'if (process.argv[2] === "--map-current-user" && behavior !== "passes") {',
          ' if (behavior === "dependent" && process.cwd() === "/") process.exit(0);',
          ' if (behavior === "mixed" && count === 1) process.exit(0);',
          ' process.stderr.write(behavior === "other" ? "unshare: other failure\\n" : "unshare: write failed /proc/self/uid_map: Operation not permitted\\n");',
          " process.exitCode=1;",
          "}",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const code = [
        "import copy,importlib.util,json,sys",
        'spec=importlib.util.spec_from_file_location("probe",' + JSON.stringify(modulePath) + ")",
        "probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)",
        "record=probe.measure_cwd(sys.argv[1],sys.argv[2])",
        'source=record["measurements"]["source"];changed=record["measurements"].get("root")',
        'record["invalid"]=[]',
        "if changed:",
        ' for field in ["cwd","environment","runtime","context","controller","probe","unshare"]:',
        "  invalid=copy.deepcopy(changed)",
        '  if field=="cwd": invalid["cwd"]=sys.argv[2]',
        '  if field=="environment": invalid["probeEnvironment"]="inherited"',
        '  if field=="runtime": invalid["runtime"]["pid"]+=1',
        '  if field=="context": invalid["before"]["namespaces"]["user"]=invalid["after"]["namespaces"]["user"]="user:[different]"',
        '  if field=="controller": invalid["controllerHash"]="0"*64',
        '  if field=="probe": invalid["cases"][0]["probes"][0]["status"]=7',
        '  if field=="unshare": invalid["unshare"]["hash"]="0"*64',
        '  record["invalid"].append(probe.compare_cwd(source,invalid,sys.argv[2]))',
        ' record["missing"]=probe.compare_cwd(source,None,sys.argv[2])',
        ' invalid=copy.deepcopy(source);invalid["controllerHash"]="0"*64',
        ' record["invalidSource"]=probe.compare_cwd(invalid,changed,sys.argv[2])',
        ' partial={"measurements":{},"outcome":"unavailable"}',
        " def fail_on_root(executable,cwd):",
        '  if cwd=="/": raise OSError("fixture root failure")',
        "  return copy.deepcopy(source)",
        " probe.measure=fail_on_root",
        " try: probe.measure_cwd(sys.argv[1],sys.argv[2],partial)",
        ' except OSError as error: partial["error"]=str(error)',
        ' record["partial"]=partial',
        'probe.log_measurement("source",source,"cwd")',
        'if changed: probe.log_measurement("root",changed,"cwd")',
        'print("RESULT "+json.dumps(record))',
      ].join("\n");
      for (const [variant, expected] of [
        ["red", "cwd-not-required"],
        ["dependent", "cwd-dependent"],
        ["passes", "not-reproduced"],
        ["other", "unavailable"],
        ["mixed", "unavailable"],
      ]) {
        fs.writeFileSync(behavior, variant!);
        fs.writeFileSync(capture, "");
        const result = spawnSync(python, ["-I", "-B", "-c", code, unshare, root], {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, PROBE_ENV_SENTINEL: "public-fixture" },
        });
        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const lines = result.stdout.trim().split("\n");
        const record = JSON.parse(lines.at(-1)!.slice("RESULT ".length));
        expect(record.outcome).toBe(expected);
        const changed = record.measurements.root;
        const measurements = [record.measurements.source, ...(changed ? [changed] : [])];
        const observed = fs
          .readFileSync(capture, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(observed).toHaveLength(changed ? 12 : 6);
        const logged = lines
          .filter((line) => line.startsWith("[DEBUG-ns-cwd] "))
          .map((line) => JSON.parse(line.slice("[DEBUG-ns-cwd] ".length)));
        expect(logged).toHaveLength(changed ? 14 : 7);
        for (const [index, measurement] of measurements.entries()) {
          const expectedCwd = index === 0 ? root : "/";
          expect(measurement.cwd).toBe(expectedCwd);
          expect(measurement.runtime.name).toBe("python");
          expect(measurement.runtime).toEqual(measurements[0].runtime);
          expect(measurement.before).toEqual(measurement.after);
          expect(measurement.before).toEqual(measurements[0].before);
          expect(measurement.probeEnvironment).toBe("empty");
          expect(logged[index * 7].workingDirectory).toBe(expectedCwd);
          for (const scenario of measurement.cases) {
            expect(scenario.probes).toHaveLength(3);
            for (const probe of scenario.probes) {
              const actual = observed.find((row) => row.pid === probe.pid);
              expect(actual.ppid).toBe(measurement.runtime.pid);
              expect(actual.cwd).toBe(expectedCwd);
              expect(actual.keys).toBe(0);
              expect(actual.sentinel).toBe(false);
              expect(actual.stdinNull).toBe(true);
              expect(actual.stdioFlags).toEqual(observed[0].stdioFlags);
              expect(actual.outSocket).toBe(true);
              expect(actual.errSocket).toBe(true);
              expect(probe.argv).toEqual(scenario.argv);
              expect(probe.signal).toBeNull();
              expect(probe.error).toBeUndefined();
              const log = logged.find((row) => row.pid === probe.pid);
              expect(log.logTruncated).toBe(false);
              expect(log.stderr).toBe(probe.stderr);
            }
          }
        }
        if (changed) {
          expect(record.invalid).toEqual(Array(7).fill("unavailable"));
          expect(record.missing).toBe("unavailable");
          expect(record.invalidSource).toBe("unavailable");
          expect(record.partial.outcome).toBe("unavailable");
          expect(record.partial.error).toBe("fixture root failure");
          expect(record.partial.measurements.source).toEqual(record.measurements.source);
          expect(record.partial.measurements.root).toBeUndefined();
        }
      }
      const output = join(directory, "invalid");
      const args = ["-I", modulePath, "compare-cwd", root, output];
      const failed = spawnSync(python, args, {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, ImageOS: "ubuntu22" },
      });
      expect(failed.status).toBe(2);
      const path = join(output, "namespace-cwd.json");
      const saved = fs.readFileSync(path, "utf8");
      expect(JSON.parse(saved).outcome).toBe("unavailable");
      expect(JSON.parse(saved).error).toContain("Ubuntu 24.04");
      expect(failed.stdout).toContain("[DEBUG-ns-cwd]");
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
      const repeated = spawnSync(python, args, { encoding: "utf8", timeout: 10_000 });
      expect(repeated.status).toBe(2);
      expect(repeated.stdout).toContain("FileExistsError");
      expect(fs.readFileSync(path, "utf8")).toBe(saved);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
