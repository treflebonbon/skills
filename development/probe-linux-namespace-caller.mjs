import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { arch, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const exactError = "unshare: write failed /proc/self/uid_map: Operation not permitted\n";
const scenarios = [
  ["minimal", ["--map-current-user", "--", "/usr/bin/true"]],
  ["control", ["--", "/usr/bin/true"]],
];
const hash = (path) => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
const emit = (value) => console.log("[DEBUG-ns-caller] " + JSON.stringify(value));
const contexts = [
  "/proc/self/uid_map",
  "/proc/self/gid_map",
  "/proc/self/attr/current",
  "/sys/module/apparmor/parameters/enabled",
  "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
  "/proc/sys/kernel/unprivileged_userns_clone",
  "/proc/sys/user/max_user_namespaces",
];
function context() {
  const status = fs.readFileSync("/proc/self/status", "utf8");
  return {
    uid: process.getuid(),
    euid: process.geteuid(),
    gid: process.getgid(),
    groups: [...new Set(process.getgroups())].sort((a, b) => a - b),
    namespaces: Object.fromEntries(
      ["user", "pid", "mnt"].map((name) => [name, fs.readlinkSync("/proc/self/ns/" + name)]),
    ),
    status: status
      .split("\n")
      .filter((line) =>
        /^(Uid|Gid|Groups|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):/.test(line),
      ),
    contexts: Object.fromEntries(
      contexts.map((path) => {
        try {
          return [path, { value: fs.readFileSync(path, "utf8").trim() }];
        } catch (error) {
          return [path, { error: error.code }];
        }
      }),
    ),
    environment: Object.fromEntries(
      ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"].map((key) => [key, process.env[key] ?? null]),
    ),
  };
}
function classify(probe) {
  if (probe.error || probe.signal || !Number.isInteger(probe.pid) || probe.pid <= 0)
    return "unavailable";
  if (probe.stdout !== "") return "unavailable";
  if (probe.status === 0 && probe.stderr === "") return "passed";
  if (probe.status === 1 && probe.stderr === exactError) return "uid-map-eperm";
  return "unavailable";
}
function outcome(record) {
  if (JSON.stringify(record.before) !== JSON.stringify(record.after)) return "unavailable";
  if (record.cases?.length !== 2) return "unavailable";
  const results = record.cases.map((scenario, index) => {
    if (
      scenario.name !== scenarios[index][0] ||
      JSON.stringify(scenario.argv) !== JSON.stringify(scenarios[index][1]) ||
      scenario.probes.length !== 3
    )
      return "unavailable";
    const results = scenario.probes.map((probe) =>
      JSON.stringify(probe.argv) === JSON.stringify(scenario.argv)
        ? classify(probe)
        : "unavailable",
    );
    return results.every((result) => result === results[0]) ? results[0] : "unavailable";
  });
  if (results[0] === "uid-map-eperm" && results[1] === "passed") return "uid-map-eperm";
  if (results.every((result) => result === "passed")) return "not-reproduced";
  return "unavailable";
}

// 両runtimeで同じコード・spawnSync API・argv・stdio・継承環境を使う。
export function measure(executable, root) {
  const record = {
    schema: "linux-namespace-caller/v1",
    runtime: {
      name: process.versions.bun ? "bun" : "node",
      version: process.versions.bun ?? process.versions.node,
      path: fs.realpathSync(process.execPath),
      hash: hash(process.execPath),
      pid: process.pid,
      ppid: process.ppid,
    },
    controllerHash: hash(self),
    unshare: {
      path: executable,
      hash: hash(executable),
      version: checked(executable, ["--version"], root),
    },
    before: context(),
    cases: [],
  };
  for (const [name, argv] of scenarios) {
    const scenario = { name, argv, probes: [] };
    record.cases.push(scenario);
    for (const repetition of [1, 2, 3]) {
      const startedAt = new Date().toISOString();
      const started = performance.now();
      const result = spawnSync(executable, argv, {
        cwd: root,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 32 * 1024 * 1024,
      });
      const probe = {
        repetition,
        argv,
        pid: result.pid,
        startedAt,
        endedAt: new Date().toISOString(),
        elapsedMs: performance.now() - started,
        status: result.status,
        signal: result.signal,
        error: result.error?.code,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
      scenario.probes.push(probe);
    }
  }
  record.after = context();
  record.outcome = hash(executable) === record.unshare.hash ? outcome(record) : "unavailable";
  return record;
}

export function compare(bun, node) {
  if (
    bun.runtime?.name !== "bun" ||
    bun.runtime.version !== "1.4.4" ||
    node.runtime?.name !== "node" ||
    Number(node.runtime.version.split(".")[0]) < 22 ||
    bun.controllerHash !== node.controllerHash ||
    JSON.stringify(bun.unshare) !== JSON.stringify(node.unshare) ||
    JSON.stringify(bun.before) !== JSON.stringify(node.before) ||
    bun.outcome !== outcome(bun) ||
    node.outcome !== outcome(node)
  )
    return "unavailable";
  if (bun.outcome === "uid-map-eperm" && node.outcome === "uid-map-eperm")
    return "bun-not-required";
  if (bun.outcome === "uid-map-eperm" && node.outcome === "not-reproduced")
    return "caller-dependent";
  if (bun.outcome === "not-reproduced" && node.outcome === "not-reproduced")
    return "not-reproduced";
  return "unavailable";
}

function checked(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: 5_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.signal || result.status !== 0)
    throw new Error("実行条件を確認できません");
  return result.stdout.trim();
}
function validate(root) {
  const env = process.env;
  if (
    process.platform !== "linux" ||
    process.getuid() === 0 ||
    process.geteuid() === 0 ||
    arch() !== env.PROOF_ARCH ||
    env.ImageOS !== (arch() === "x64" ? "ubuntu24" : arch() === "arm64" ? "ubuntu24-arm64" : "") ||
    !env.ImageVersion ||
    !/^VERSION_ID="24\.04"$/m.test(fs.readFileSync("/etc/os-release", "utf8")) ||
    (process.versions.bun
      ? process.versions.bun !== "1.4.4"
      : Number(process.versions.node.split(".")[0]) < 22)
  )
    throw new Error(
      "caller比較はUbuntu 24.04・指定architecture・Bun 1.4.4 / Node 22以上・非rootで実行してください",
    );
  if (
    fs.existsSync("/nix") ||
    fs.existsSync("/etc/nix/nix.conf") ||
    [
      "NIX_REMOTE",
      "PROCESS_PROOF_NIX_BASH",
      "PROCESS_PROOF_NIX_STDENV",
      "PROCESS_PROOF_GROUP_FILE",
      "PROCESS_PROOF_GROUP_GID",
    ].some((key) => env[key] !== undefined)
  )
    throw new Error("caller比較では専用のNix・group準備を省略してください");
  if (["NODE_OPTIONS", "BUN_OPTIONS", "LD_PRELOAD"].some((key) => env[key] !== undefined))
    throw new Error("caller比較では追加runtime optionを指定できません");
  const sourceSha = env.PROOF_SOURCE_SHA,
    workflowSha = env.GITHUB_SHA;
  const runId = env.GITHUB_RUN_ID,
    attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (
    !/^[a-f0-9]{40}$/.test(sourceSha ?? "") ||
    workflowSha !== sourceSha ||
    !/^[1-9][0-9]*$/.test(runId ?? "") ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    throw new Error("source/workflow/run/attempt の入力が不正です");
  const control = resolve(dirname(self), "..");
  if (
    checked("git", ["rev-parse", "HEAD"], root) !== sourceSha ||
    checked("git", ["rev-parse", "HEAD"], control) !== workflowSha ||
    hash(join(root, "development/probe-linux-namespace-caller.mjs")) !== hash(self)
  )
    throw new Error("checkout の SHA またはcontrollerが一致しません");
  const committed = checked(
    "git",
    ["show", sourceSha + ":development/probe-linux-namespace-caller.mjs"],
    root,
  );
  if (
    createHash("sha256")
      .update(committed + "\n")
      .digest("hex") !== hash(self)
  )
    throw new Error("controllerが対象commitと一致しません");
  const before = context();
  for (const path of contexts.slice(0, 3))
    if (before.contexts[path].error) throw new Error("callerのnamespace / LSM条件を観測できません");
  return {
    sourceSha,
    workflowSha,
    runId,
    attempt,
    arch: arch(),
    kernel: release(),
    imageOS: env.ImageOS,
    imageVersion: env.ImageVersion,
    setupAbsent: true,
  };
}

function logMeasurement(record) {
  emit({
    runtime: record.runtime,
    controllerHash: record.controllerHash,
    unshare: record.unshare,
    before: record.before,
    after: record.after,
    outcome: record.outcome,
  });
  for (const scenario of record.cases)
    for (const probe of scenario.probes)
      emit({
        runtime: record.runtime.name,
        case: scenario.name,
        ...probe,
        stdout: probe.stdout.slice(0, 1024),
        stderr: probe.stderr.slice(0, 1024),
        logTruncated: probe.stdout.length > 1024 || probe.stderr.length > 1024,
        outcome: classify(probe),
      });
}
function main(args) {
  const [mode, source, output, bunPath] = args;
  if (!["run", "measure"].includes(mode) || !source || !output)
    throw new Error("run SOURCE OUTPUT BUN / measure SOURCE OUTPUT が必要です");
  const root = resolve(source);
  if (mode === "run") fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const path = mode === "run" ? join(output, "namespace-caller.json") : output;
  const fd = fs.openSync(path, "wx", 0o600);
  let record = { schema: "linux-namespace-caller-comparison/v1", outcome: "unavailable" };
  try {
    const identity = validate(root);
    if (mode === "measure") {
      record = { ...measure("/usr/bin/unshare", root), identity };
      logMeasurement(record);
    } else {
      if (process.versions.bun || !bunPath) throw new Error("比較の親はNode.jsで起動してください");
      const runtimes = { bun: fs.realpathSync(bunPath), node: fs.realpathSync(process.execPath) };
      const hashes = Object.fromEntries(
        Object.entries(runtimes).map(([name, path]) => [name, hash(path)]),
      );
      record = { ...record, identity, runtimes, runtimeHashes: hashes, measurements: {} };
      emit({
        schema: record.schema,
        ...identity,
        controllerHash: hash(self),
        runtimes,
        runtimeHashes: hashes,
      });
      for (const [name, runtime] of Object.entries(runtimes)) {
        const resultPath = join(output, "caller-" + name + ".json");
        const result = spawnSync(runtime, [self, "measure", root, resultPath], {
          cwd: root,
          env: process.env,
          encoding: "utf8",
          timeout: 40_000,
          killSignal: "SIGKILL",
          maxBuffer: 256 * 1024,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.error || result.signal || ![0, 1].includes(result.status) || result.stderr)
          throw new Error(name + "の測定を完了できません");
        const observed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
        record.measurements[name] = observed;
        if (
          observed.runtime.name !== name ||
          observed.runtime.path !== runtime ||
          observed.runtime.hash !== hashes[name] ||
          JSON.stringify(observed.identity) !== JSON.stringify(identity) ||
          result.status !== (observed.outcome === "not-reproduced" ? 0 : 1)
        )
          throw new Error(name + "の測定条件が一致しません");
      }
      record.outcome = compare(record.measurements.bun, record.measurements.node);
      if (
        Object.entries(runtimes).some(([name, path]) => hash(path) !== hashes[name]) ||
        hash(self) !== record.measurements.bun.controllerHash
      )
        throw new Error("測定中に実行体またはcontrollerが変化しました");
      validate(root);
    }
  } catch (error) {
    record.outcome = "unavailable";
    record.error = String(error);
  } finally {
    emit({ outcome: record.outcome, error: record.error });
    try {
      fs.writeFileSync(fd, JSON.stringify(record, null, 2) + "\n");
    } finally {
      fs.closeSync(fd);
    }
  }
  return ["uid-map-eperm", "bun-not-required", "caller-dependent"].includes(record.outcome)
    ? 1
    : record.outcome === "not-reproduced"
      ? 0
      : 2;
}
if (process.argv[1] && resolve(process.argv[1]) === self) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    emit({ outcome: "unavailable", error: String(error) });
    process.exitCode = 2;
  }
}
