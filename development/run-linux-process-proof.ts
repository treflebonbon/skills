import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { arch, release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTrial, verifyCohort, validGroupCredentials } from "./linux-process-proof.ts";
import { collectMetadata } from "./linux-process-proof-metadata.ts";
import resolutions from "./linux-process-proof-resolutions.json";

const control = fileURLToPath(new URL("..", import.meta.url));
const proofTools = [
  "cc",
  "unshare",
  "nix",
  "nix-build",
  "nix-store",
  "setpriv",
  "bun",
  "sudo",
  "python3",
  "git",
  "bash",
];
const hash = (path: string) => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
const json = (path: string) => JSON.parse(fs.readFileSync(path, "utf8"));
const write = (path: string, value: unknown) =>
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
function command(command: string, args: string[], cwd: string, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}
function checked(command_: string, args: string[], cwd: string) {
  const result = command(command_, args, cwd);
  if (result.status !== 0 || result.error)
    throw new Error(`${command_}: ${result.error ?? result.stderr}`);
  return result.stdout.trim();
}
function readContext(path: string) {
  try {
    return { value: fs.readFileSync(path, "utf8") };
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code };
  }
}
function identity(root: string) {
  const sourceSha = process.env.PROOF_SOURCE_SHA!,
    workflowSha = process.env.GITHUB_SHA!;
  const runId = process.env.GITHUB_RUN_ID!,
    attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (
    !/^[0-9a-f]{40}$/.test(sourceSha ?? "") ||
    !/^[0-9a-f]{40}$/.test(workflowSha ?? "") ||
    !/^[1-9][0-9]*$/.test(runId ?? "") ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    throw new Error("source/workflow/run/attempt の入力が不正です");
  if (
    checked("git", ["rev-parse", "HEAD"], root) !== sourceSha ||
    checked("git", ["rev-parse", "HEAD"], control) !== workflowSha
  )
    throw new Error("checkout の SHA が一致しません");
  return { sourceSha, workflowSha, runId, attempt };
}
function sources(root: string) {
  return Object.fromEntries(
    checked(
      "git",
      ["ls-files", "--", "lib", "tests", "development/linux-process-proof-cases.json"],
      root,
    )
      .split("\n")
      .filter(Boolean)
      .map((path) => [path, hash(join(root, path))]),
  );
}
function preflight(root: string) {
  const tools = Object.fromEntries(
    proofTools.map((name) => {
      const selected = name === "bash" ? "/bin/bash" : Bun.which(name);
      if (!selected) throw new Error(`必須 tool がありません: ${name}`);
      const path = fs.realpathSync(selected);
      return [
        name,
        { path, hash: hash(path), version: checked(path, ["--version"], root).split("\n")[0] },
      ];
    }),
  );
  const contexts = Object.fromEntries(
    [
      "/proc/self/status",
      "/proc/self/uid_map",
      "/proc/self/gid_map",
      "/proc/self/attr/current",
      "/sys/kernel/security/lsm",
      "/sys/module/apparmor/parameters/enabled",
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
      "/proc/sys/kernel/unprivileged_userns_clone",
      "/proc/sys/user/max_user_namespaces",
    ].map((path) => [path, readContext(path)]),
  );
  const namespaces = Object.fromEntries(
    ["user", "pid", "mnt"].map((name) => [name, fs.readlinkSync(`/proc/self/ns/${name}`)]),
  );
  const probe = command(
    tools.unshare!.path,
    [
      "--user",
      "--map-current-user",
      "--pid",
      "--fork",
      "--kill-child=SIGKILL",
      "--mount-proc",
      "--",
      "/usr/bin/true",
    ],
    root,
  );
  const config = JSON.parse(
    checked(
      "nix",
      ["--extra-experimental-features", "nix-command", "config", "show", "--json"],
      root,
    ),
  );
  const nix = {
    mode: "multi-user",
    remote: process.env.NIX_REMOTE,
    sandbox: config.sandbox?.value,
    buildUsersGroup: config["build-users-group"]?.value,
    daemon: command(
      "nix",
      [
        "--extra-experimental-features",
        "nix-command",
        "store",
        "ping",
        "--store",
        "daemon",
        "--json",
      ],
      root,
    ),
    bash: process.env.PROCESS_PROOF_NIX_BASH,
    stdenv: process.env.PROCESS_PROOF_NIX_STDENV,
  };
  const groupPath = process.env.PROCESS_PROOF_GROUP_FILE!;
  const group = fs.statSync(groupPath);
  const errors: string[] = [];
  if (
    process.platform !== "linux" ||
    arch() !== process.env.PROOF_ARCH ||
    Bun.version !== "1.4.4" ||
    process.getuid!() === 0 ||
    process.geteuid!() === 0
  )
    errors.push("OS・architecture・Bun・非root 条件が不一致です");
  if (
    process.env.ImageOS !== "ubuntu24" ||
    !process.env.ImageVersion ||
    !/^VERSION_ID="24\.04"$/m.test(fs.readFileSync("/etc/os-release", "utf8"))
  )
    errors.push("Ubuntu VM image が不一致です");
  if (probe.status !== 0 || probe.error)
    errors.push("同じ条件の namespace 前提検査が失敗しました。拒否原因は未確定です");
  if (
    tools.nix!.version !== "nix (Nix) 2.34.6" ||
    nix.remote !== "daemon" ||
    nix.sandbox !== true ||
    nix.buildUsersGroup !== "nixbld" ||
    nix.daemon.status !== 0 ||
    !nix.bash?.startsWith("/nix/store/") ||
    !nix.stdenv?.startsWith("/nix/store/")
  )
    errors.push("Nix daemon・設定・closure が不一致です");
  if (
    group.uid === process.getuid!() ||
    group.gid !== Number(process.env.PROCESS_PROOF_GROUP_GID) ||
    (group.mode & 0o777) !== 0o060 ||
    process.getgroups!().includes(group.gid) ||
    group.gid === process.getgid!()
  )
    errors.push("補助 group fixture の資格情報が不正です");
  return {
    verified: errors.length === 0,
    errors,
    platform: process.platform,
    arch: arch(),
    kernel: release(),
    imageOS: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    tools,
    contexts,
    namespaces,
    probe,
    nix,
    group: {
      path: groupPath,
      ownerUid: group.uid,
      gid: group.gid,
      mode: group.mode & 0o777,
      dev: String(group.dev),
      ino: String(group.ino),
    },
    environment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NIX_REMOTE: process.env.NIX_REMOTE,
      PROCESS_PROOF_NIX_BASH: process.env.PROCESS_PROOF_NIX_BASH,
      PROCESS_PROOF_NIX_STDENV: process.env.PROCESS_PROOF_NIX_STDENV,
      PROCESS_PROOF_GROUP_FILE: process.env.PROCESS_PROOF_GROUP_FILE,
      PROCESS_PROOF_GROUP_GID: process.env.PROCESS_PROOF_GROUP_GID,
    },
    uid: process.getuid!(),
    euid: process.geteuid!(),
    gid: process.getgid!(),
    groups: process.getgroups!(),
    bun: Bun.version,
  };
}

function run(root: string, out: string) {
  fs.mkdirSync(out, { recursive: true });
  const job: Record<string, unknown> = {
    schema: "linux-process-proof-job/v1",
    arch: process.env.PROOF_ARCH,
    trials: [],
  };
  try {
    Object.assign(job, identity(root));
    job.sources = sources(root);
    job.controllerHash = hash(fileURLToPath(import.meta.url));
    job.preflight = preflight(root);
    const before = JSON.stringify(job.sources);
    if (!(job.preflight as { verified: boolean }).verified)
      throw new Error("前提検査未達のため実証を開始しません");
    const trials: unknown[] = [];
    job.trials = trials;
    for (const repetition of [1, 2, 3]) {
      const temporary = fs.mkdtempSync(join(out, `temporary-${repetition}-`));
      const logName = `trial-${repetition}.log`;
      const environment = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: temporary,
        NO_COLOR: "1",
        PROCESS_PROOF_PID_NAMESPACE: "1",
        PROCESS_PROOF_RETAIN_TEMP: "1",
      };
      const result = command(
        process.execPath,
        ["test", join(root, "tests/bun/process-namespace.test.ts")],
        root,
        { ...process.env, ...environment },
      );
      fs.writeFileSync(join(out, logName), result.stdout + result.stderr);
      let trial: unknown;
      try {
        trial = parseTrial(result.stdout + result.stderr, result.status, repetition);
      } catch (error) {
        trial = { repetition, exitCode: result.status, error: String(error) };
      }
      trials.push({
        ...(trial as object),
        environment,
        temporary: temporary.slice(out.length + 1),
        log: logName,
        logHash: hash(join(out, logName)),
        signal: result.signal,
        error: result.error,
      });
    }
    job.sourcesAfter = sources(root);
    job.callerAfter = {
      status: readContext("/proc/self/status"),
      uidMap: readContext("/proc/self/uid_map"),
      gidMap: readContext("/proc/self/gid_map"),
      namespaces: Object.fromEntries(
        ["user", "pid", "mnt"].map((name) => [name, fs.readlinkSync(`/proc/self/ns/${name}`)]),
      ),
    };
    if (before !== JSON.stringify(job.sourcesAfter))
      throw new Error("実行中に source が変化しました");
  } catch (error) {
    job.error = String(error);
  }
  write(join(out, "job.json"), job);
  if (job.error) throw new Error(String(job.error));
}

export function readProofJob(root: string, directory: string, architecture: string) {
  const job = json(join(directory, "job.json"));
  const expectedSources = sources(root);
  if (
    job.schema !== "linux-process-proof-job/v1" ||
    job.arch !== architecture ||
    job.error ||
    job.preflight?.verified !== true ||
    !Number.isSafeInteger(job.preflight?.uid) ||
    job.preflight.uid <= 0 ||
    job.controllerHash !== hash(fileURLToPath(import.meta.url)) ||
    JSON.stringify(job.sources) !== JSON.stringify(expectedSources) ||
    JSON.stringify(job.sourcesAfter) !== JSON.stringify(expectedSources)
  )
    throw new Error("source・前提検査・controller の証跡が不正です");
  const environment = job.preflight;
  if (!validGroupCredentials(environment))
    throw new Error("資格情報・補助 group fixture の必須観測が不正です");
  if (
    environment.euid !== environment.uid ||
    environment.platform !== "linux" ||
    environment.arch !== architecture ||
    environment.bun !== "1.4.4" ||
    !["PATH", "HOME"].every(
      (name) =>
        typeof environment.environment?.[name] === "string" && environment.environment[name],
    ) ||
    environment.imageOS !== "ubuntu24" ||
    typeof environment.imageVersion !== "string" ||
    !environment.imageVersion ||
    typeof environment.kernel !== "string" ||
    !environment.kernel ||
    environment.probe?.status !== 0 ||
    environment.nix?.mode !== "multi-user" ||
    environment.nix.remote !== "daemon" ||
    environment.nix.sandbox !== true ||
    environment.nix.buildUsersGroup !== "nixbld" ||
    environment.nix.daemon?.status !== 0 ||
    !proofTools.every((name) => {
      const tool = environment.tools?.[name];
      return (
        typeof tool?.path === "string" &&
        tool.path.startsWith("/") &&
        typeof tool.version === "string" &&
        tool.version &&
        /^[a-f0-9]{64}$/.test(tool.hash)
      );
    }) ||
    !["/proc/self/status", "/proc/self/uid_map", "/proc/self/gid_map"].every(
      (path) => typeof environment.contexts?.[path]?.value === "string",
    ) ||
    !["user", "pid", "mnt"].every(
      (name) =>
        typeof environment.namespaces?.[name] === "string" &&
        job.callerAfter?.namespaces?.[name] === environment.namespaces[name],
    ) ||
    !["status", "uidMap", "gidMap"].every(
      (name) => typeof job.callerAfter?.[name]?.value === "string",
    )
  )
    throw new Error("実行環境・資格情報・namespace の必須観測が不足しています");
  const installerHash = fs.readFileSync(join(directory, "nix-installer.sha256"), "utf8").trim();
  if (
    installerHash !==
    (architecture === "x64"
      ? "311b9f406f0239ef640a1e3fbea1df1bac9d3a7c316c4def30df3206dd964960"
      : "09edae3ed146b1a47de84eda6135ef12ee74783d409e7a207c912cb94e14aa35")
  )
    throw new Error("Nix installer の hash が不一致です");
  for (const name of ["bash", "stdenv"]) {
    const storeRoot = fs.readFileSync(join(directory, `nix-${name}-root.txt`), "utf8").trim();
    const closure = fs
      .readFileSync(join(directory, `nix-${name}-closure.txt`), "utf8")
      .trim()
      .split("\n");
    if (
      job.preflight.nix[name] !== storeRoot ||
      !closure.includes(storeRoot) ||
      !closure.every((path: string) => /^\/nix\/store\/[a-z0-9]{32}-[^/]+$/.test(path))
    )
      throw new Error("Nix closure の証跡が不正です");
  }
  if (
    !Array.isArray(job.trials) ||
    JSON.stringify(job.trials.map((trial: { repetition: number }) => trial.repetition).sort()) !==
      "[1,2,3]"
  )
    throw new Error("反復1・2・3が一意に必要です");
  const rebuilt = [1, 2, 3].map((repetition) => {
    const trial = job.trials.find(
      (trial: { repetition: number }) => trial.repetition === repetition,
    );
    const path = join(directory, `trial-${repetition}.log`);
    if (
      trial?.log !== `trial-${repetition}.log` ||
      hash(path) !== trial.logHash ||
      trial.signal ||
      trial.error ||
      trial.environment?.PATH !== environment.environment.PATH ||
      trial.environment?.HOME !== environment.environment.HOME ||
      trial.environment?.PROCESS_PROOF_PID_NAMESPACE !== "1" ||
      trial.environment?.PROCESS_PROOF_RETAIN_TEMP !== "1" ||
      typeof trial.environment?.TMPDIR !== "string" ||
      !trial.environment.TMPDIR.endsWith(`/${trial.temporary}`)
    )
      throw new Error(`反復 ${repetition} の log 同一性・終了状態を確認できません`);
    const parsed = parseTrial(fs.readFileSync(path, "utf8"), trial.exitCode, repetition);
    if (JSON.stringify(parsed.observation) !== JSON.stringify(trial.observation))
      throw new Error("観測と raw log が一致しません");
    const build = (parsed.observation as { build?: { builds?: Record<string, string>[] } }).build;
    if (
      !build?.builds ||
      build.builds.length !== 6 ||
      !build.builds.every(
        (item) =>
          /^[a-f0-9]{64}$/.test(item.sourceHash!) && /^[a-f0-9]{64}$/.test(item.binaryHash!),
      )
    )
      throw new Error("source/binary hash が不足しています");
    if (
      JSON.stringify(build.builds.map((item) => `${item.source}/${item.variant}`).sort()) !==
      JSON.stringify(
        [
          "bun-process-namespace-observer.c/observer",
          "bun-process-pidfds.c/pidfds",
          "bun-exec-launcher.c/baseline",
          "bun-exec-pid-namespace.c/launcher",
          "bun-exec-pid-namespace.c/without-proc",
          "bun-exec-namespace-delay.c/delay.so",
        ].sort(),
      )
    )
      throw new Error("build fixture が一意に揃っていません");
    if (!new RegExp(`^temporary-${repetition}-[a-zA-Z0-9]+$`).test(trial.temporary))
      throw new Error("一時領域の対応が不正です");
    const temporary = join(directory, trial.temporary);
    const roots = fs
      .readdirSync(temporary)
      .filter((name) => name.startsWith("bun-process-namespace-"));
    if (roots.length !== 1) throw new Error("build 一時領域が1件必要です");
    for (const item of build.builds) {
      if (
        !/^[a-z.-]+$/.test(item.variant!) ||
        !/^[a-z.-]+$/.test(item.source!) ||
        expectedSources[`tests/fixtures/${item.source}`] !== item.sourceHash ||
        hash(join(temporary, roots[0]!, item.variant!)) !== item.binaryHash
      )
        throw new Error("保存された source/binary と hash が一致しません");
    }
    return parsed;
  });
  return { ...job, trials: rebuilt };
}

async function aggregate(root: string, raw: string, out: string) {
  fs.mkdirSync(out, { recursive: true });
  const current = identity(root);
  const cohort: Record<string, unknown> = {
    schema: "linux-process-proof-cohort/v1",
    ...current,
    jobs: [],
    historyComplete: false,
  };
  const errors: string[] = [];
  const jobs: unknown[] = [];
  cohort.jobs = jobs;
  for (const architecture of ["x64", "arm64"]) {
    try {
      const directory = join(
        raw,
        `linux-proof-${current.runId}-${current.attempt}-${architecture}`,
      );
      jobs.push(readProofJob(root, directory, architecture));
    } catch (error) {
      errors.push(`${architecture}: ${error}`);
    }
  }
  try {
    const metadata = await collectMetadata(
      async (path) => {
        const response = await fetch(`https://api.github.com/repos/treflebonbon/skills${path}`, {
          headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`public metadata API: HTTP ${response.status}`);
        return (await response.json()) as Record<string, unknown>;
      },
      current,
      resolutions.resolutions,
    );
    Object.assign(cohort, metadata);
  } catch (error) {
    errors.push(`metadata: ${error}`);
  }
  const verdict = verifyCohort(
    cohort,
    json(join(root, "development/linux-process-proof-cases.json")),
  );
  verdict.reasons.push(...errors);
  verdict.verified = verdict.reasons.length === 0;
  write(join(out, "cohort.json"), cohort);
  write(join(out, "verdict.json"), verdict);
  const summary =
    `# Linux 追加実証\n\n判定: ${verdict.verified ? "今回の追加実証は成功" : "成功条件未達"}\n\nsource: ${current.sourceSha}\nworkflow: ${current.workflowSha}\nrun/attempt: ${current.runId}/${current.attempt}\n\n` +
    verdict.reasons.map((reason) => `- ${reason.replaceAll("\n", " ")}`).join("\n") +
    "\n\n#33 は OPEN、#82 は #33 待ち、macOS 移行は保留。JSON と要約は人が確認したうえで Git 管理へ移す。\n";
  fs.writeFileSync(join(out, "summary.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (!verdict.verified) process.exitCode = 1;
}

if (import.meta.main) {
  const [mode, source, directory, output] = process.argv.slice(2);
  try {
    if (!source || !directory)
      throw new Error("run SOURCE OUTPUT / aggregate SOURCE RAW OUTPUT が必要です");
    if (mode === "run") run(resolve(source), resolve(directory));
    else if (mode === "aggregate" && output)
      await aggregate(resolve(source), resolve(directory), resolve(output));
    else throw new Error("不明な実行方式です");
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
