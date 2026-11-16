import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTrial,
  verifyCohort,
  groupsInNamespace,
} from "../../development/linux-process-proof.ts";
import acceptedCases from "../../development/linux-process-proof-cases.json";
import { collectMetadata } from "../../development/linux-process-proof-metadata.ts";
import { readProofJob } from "../../development/run-linux-process-proof.ts";
import { createHash } from "node:crypto";

const sourceSha = "a".repeat(40);
const workflowSha = "b".repeat(40);
const manifest = { schema: "linux-process-proof-cases/v1", cases: ["終了保証", "実 caller"] };

test("namespace の補助 GID は観測 map と設定された overflow GID に従う", () => {
  expect(groupsInNamespace([1001, 2000], [[1001, 1001, 1]], 65534)).toEqual([1001, 65534]);
  expect(
    groupsInNamespace(
      [1001, 2000, 2001],
      [
        [1001, 1001, 1],
        [5000, 2000, 2],
      ],
      60000,
    ),
  ).toEqual([1001, 5000, 5001]);
  expect(groupsInNamespace([1001, 2000, 2001], [[1001, 1001, 1]], 60000)).toEqual([
    1001, 60000, 60000,
  ]);
  expect(() => groupsInNamespace([1001], [], 65534)).toThrow(
    "補助 group の GID mapping が不正です",
  );
  expect(() => groupsInNamespace([1001], [[1001, 1001, 0]], 65534)).toThrow(
    "補助 group の GID mapping が不正です",
  );
});

test.skipIf(process.platform !== "linux" || process.env.PROCESS_PROOF_PID_NAMESPACE !== "1")(
  "実 user namespace の getgroups を観測した GID map で説明できる",
  () => {
    const result = spawnSync(
      "unshare",
      [
        "--user",
        "--map-current-user",
        "--",
        process.execPath,
        "-e",
        `
    const fs = require("node:fs");
    console.log(JSON.stringify({groups: process.getgroups(), gidMap: fs.readFileSync("/proc/self/gid_map", "utf8").trim().split("\\n").map(line => line.trim().split(/\\s+/).map(Number))}));
  `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout);
    const overflow = Number(fs.readFileSync("/proc/sys/kernel/overflowgid", "utf8").trim());
    expect(observed.groups.sort((a: number, b: number) => a - b)).toEqual(
      groupsInNamespace(process.getgroups!(), observed.gidMap, overflow).sort((a, b) => a - b),
    );
  },
);

function cohort() {
  return {
    schema: "linux-process-proof-cohort/v1",
    sourceSha,
    workflowSha,
    runId: "42",
    attempt: 1,
    jobs: ["x64", "arm64"].map((arch) => ({
      arch,
      sourceSha,
      workflowSha,
      runId: "42",
      attempt: 1,
      preflight: {
        verified: true,
        uid: 1000,
        euid: 1000,
        gid: 1000,
        groups: [1000, 1001],
        group: { path: "/fixture/data", ownerUid: 0, gid: 2000, mode: 0o060, dev: "1", ino: "2" },
      },
      trials: [1, 2, 3].map((repetition) => ({
        repetition,
        exitCode: 0,
        counts: { pass: 2, fail: 0, skip: 0, todo: 0 },
        cases: [
          { name: "終了保証", status: "pass" },
          { name: "実 caller", status: "pass" },
        ],
        observation: {
          boundary: "process-namespace",
          arch,
          realCallerRequested: true,
          records: [
            {
              realCaller: {
                observations: [
                  { binary: "baseline", status: 37, stderr: 'real-caller:{"hook": "hook-ok"}' },
                  { binary: "namespace", status: 37, stderr: 'real-caller:{"hook": "hook-ok"}' },
                ],
              },
            },
          ],
        },
      })),
    })),
    artifacts: ["x64", "arm64"].map((arch, i) => ({
      arch,
      id: String(i + 1),
      runId: "42",
      attempt: 1,
      digest: String(i + 1).repeat(64),
      expired: false,
      createdAt: "2026-11-16T00:00:00Z",
      expiresAt: "2027-02-14T00:00:00Z",
    })),
    historyComplete: true,
    history: [] as unknown[],
  };
}

test("同じ run・attempt の両 architecture が各3回成功した一組を認定する", () => {
  expect(verifyCohort(cohort(), manifest)).toEqual({ verified: true, reasons: [] });
});

test("primary GID・補助 group・fixture の必須証跡が欠けた一組を拒否する", () => {
  for (const field of ["gid", "groups", "group"] as const) {
    const input = cohort();
    delete (input.jobs[0]!.preflight as Partial<(typeof input.jobs)[0]["preflight"]>)[field];
    expect(verifyCohort(input, manifest).reasons).toContain(
      "x64: 資格情報・補助 group fixture の必須観測が不正です",
    );
  }
});

test("資格情報の値と group 専用 file の条件も再検証する", () => {
  const valid = cohort().jobs[0]!.preflight;
  for (const preflight of [
    { ...valid, verified: false },
    { ...valid, gid: -1 },
    { ...valid, groups: [NaN] },
    { ...valid, groups: [2000] },
    { ...valid, group: { ...valid.group, ownerUid: 1000 } },
    { ...valid, group: { ...valid.group, gid: 1000 } },
    { ...valid, group: { ...valid.group, mode: 0o666 } },
  ]) {
    const input = cohort();
    input.jobs[0]!.preflight = preflight;
    expect(verifyCohort(input, manifest).reasons).toContain(
      "x64: 資格情報・補助 group fixture の必須観測が不正です",
    );
  }
  const input = cohort();
  input.jobs[0]!.preflight.groups = [];
  expect(verifyCohort(input, manifest).verified).toBe(true);
});

test("部分再実行と古い attempt の成功を混ぜた一組を拒否する", () => {
  const input = cohort();
  input.jobs[1]!.attempt = 2;
  const verdict = verifyCohort(input, manifest);
  expect(verdict.verified).toBe(false);
  expect(verdict.reasons).toContain("arm64: run/attempt が一組と一致しません");
});

test("件数が成功に見えても必須 case が欠けた一組を拒否する", () => {
  const input = cohort();
  input.jobs[0]!.trials[0]!.cases.pop();
  const verdict = verifyCohort(input, manifest);
  expect(verdict.verified).toBe(false);
  expect(verdict.reasons).toContain("x64/1: 期待 case の全件成功を確認できません");
});

test("3回の完了・終了状態・集計・実 caller 観測をすべて要求する", () => {
  const missing = cohort();
  missing.jobs[0]!.trials.pop();
  expect(verifyCohort(missing, manifest).reasons).toContain("x64: 反復1・2・3が必要です");
  const failed = cohort();
  failed.jobs[0]!.trials[0]!.exitCode = 1;
  expect(verifyCohort(failed, manifest).reasons).toContain(
    "x64/1: 終了状態・試験集計が成功条件を満たしません",
  );
  const counts = cohort();
  counts.jobs[0]!.trials[0]!.counts.skip = 1;
  expect(verifyCohort(counts, manifest).reasons).toContain(
    "x64/1: 終了状態・試験集計が成功条件を満たしません",
  );
  const caller = cohort();
  caller.jobs[0]!.trials[0]!.observation.realCallerRequested = false;
  expect(verifyCohort(caller, manifest).reasons).toContain(
    "x64/1: 実 caller の実行を確認できません",
  );
  caller.jobs[0]!.trials[0]!.observation.realCallerRequested = true;
  caller.jobs[0]!.trials[0]!.observation.records = [];
  expect(verifyCohort(caller, manifest).reasons).toContain(
    "x64/1: 実 caller の実行を確認できません",
  );
});

test("同じ SHA の未解明失敗は後続の3回成功でも認定を保留する", () => {
  const input = cohort();
  input.history.push({ sourceSha, runId: "41", attempt: 1, conclusion: "failure" });
  expect(verifyCohort(input, manifest).reasons).toContain(
    "同じ SHA に未解明の失敗があります: 41/1",
  );
});

test("根拠付きで環境起因と確定した履歴は保持して新しい一組を評価できる", () => {
  const input = cohort();
  input.history.push({
    sourceSha,
    runId: "41",
    attempt: 1,
    conclusion: "failure",
    resolution: {
      classification: "environment",
      reason: "依存取得が停止した",
      evidence: "docs/evidence/network-41.json",
    },
  });
  expect(verifyCohort(input, manifest).verified).toBe(true);
});

test("対象 SHA と異なる source の job を拒否する", () => {
  const input = cohort();
  input.jobs[0]!.sourceSha = "c".repeat(40);
  expect(verifyCohort(input, manifest).reasons).toContain(
    "x64: source/workflow SHA が一致しません",
  );
});

test("artifact の実保存期間が90日に足りない場合は証跡不足にする", () => {
  const input = cohort();
  input.artifacts[0]!.expiresAt = "2026-12-16T00:00:00Z";
  expect(verifyCohort(input, manifest).reasons).toContain(
    "x64: artifact の同一性・保存期間を確認できません",
  );
});

test("片方の artifact が欠ける場合は測定成功でも認定しない", () => {
  const input = cohort();
  input.artifacts.pop();
  expect(verifyCohort(input, manifest).reasons).toContain(
    "arm64: artifact の同一性・保存期間を確認できません",
  );
});

test("Bun の case と集計を観測 JSON と一緒に採取する", () => {
  const observation = cohort().jobs[0]!.trials[0]!.observation;
  const log = `(pass) 終了保証 [1.00ms]\n(pass) 実 caller [2.00ms]\n${JSON.stringify(observation)}\n 2 pass\n 0 fail\n`;
  expect(parseTrial(log, 0, 1)).toEqual(cohort().jobs[0]!.trials[0]);
});

test("成功件数だけがあり観測 JSON がないログは拒否する", () => {
  expect(() => parseTrial(" 44 pass\n 0 fail\n", 0, 1)).toThrow("観測 JSON が1件必要です");
});

test("public API の最終成功だけで過去の失敗 attempt を隠さない", async () => {
  const paths: string[] = [];
  const read = async (path: string): Promise<Record<string, unknown>> => {
    paths.push(path);
    if (path === "/actions/runs/42")
      return {
        head_sha: workflowSha,
        run_attempt: 2,
        run_started_at: "2026-11-16T02:00:00Z",
        event: "workflow_dispatch",
        workflow_id: 7,
        display_title: `Linux process proof: ${sourceSha}`,
      };
    if (path.includes("/artifacts?")) return { total_count: 0, artifacts: [] };
    if (path.includes("/workflows/7/runs?"))
      return {
        total_count: 1,
        workflow_runs: [
          {
            id: 42,
            run_attempt: 2,
            conclusion: "success",
            display_title: `Linux process proof: ${sourceSha}`,
          },
        ],
      };
    if (path === "/actions/runs/42/attempts/1")
      return {
        id: 42,
        run_attempt: 1,
        status: "completed",
        run_started_at: "2026-11-16T01:00:00Z",
        conclusion: "failure",
        display_title: `Linux process proof: ${sourceSha}`,
      };
    throw new Error(`未定義の API 呼出し: ${path}`);
  };
  const metadata = await collectMetadata(
    read,
    { runId: "42", attempt: 2, sourceSha, workflowSha },
    [],
  );
  expect(paths).toContain("/actions/runs/42/attempts/1");
  expect(metadata.history).toMatchObject([{ runId: "42", attempt: 1, conclusion: "failure" }]);
  expect(verifyCohort({ ...cohort(), history: metadata.history }, manifest).reasons).toContain(
    "同じ SHA に未解明の失敗があります: 42/1",
  );
  await expect(
    collectMetadata(
      async (path) =>
        path.includes("/workflows/") ? { total_count: 1000, workflow_runs: [] } : read(path),
      { runId: "42", attempt: 2, sourceSha, workflowSha },
      [],
    ),
  ).rejects.toThrow("workflow 履歴を完全に取得できません");
});

test("artifact API から同じ attempt の実 metadata だけを残す", async () => {
  const artifacts = cohort().artifacts.map((artifact) => ({
    name: `linux-proof-42-1-${artifact.arch}`,
    id: Number(artifact.id),
    digest: `sha256:${artifact.digest}`,
    created_at: artifact.createdAt,
    expires_at: artifact.expiresAt,
    expired: false,
  }));
  artifacts.push({ ...artifacts[0]!, name: "linux-proof-42-2-x64", id: 3 });
  const read = async (path: string): Promise<Record<string, unknown>> => {
    if (path === "/actions/runs/42")
      return {
        head_sha: workflowSha,
        run_attempt: 1,
        run_started_at: "2026-11-16T01:00:00Z",
        event: "workflow_dispatch",
        workflow_id: 7,
        display_title: `Linux process proof: ${sourceSha}`,
      };
    if (path === "/actions/runs/42/artifacts?per_page=100")
      return { total_count: artifacts.length, artifacts };
    if (path.startsWith("/actions/workflows/7/runs?")) {
      expect(new URL(path, "https://api.github.com").searchParams.get("created")).toBe(
        "<=2026-11-16T01:00:00Z",
      );
      return {
        total_count: 1,
        workflow_runs: [
          { id: 42, run_attempt: 1, display_title: `Linux process proof: ${sourceSha}` },
        ],
      };
    }
    throw new Error(`未定義の API 呼出し: ${path}`);
  };
  const current = { runId: "42", attempt: 1, sourceSha, workflowSha };
  const metadata = await collectMetadata(read, current, []);
  expect(metadata.artifacts.map((artifact) => artifact.id)).toEqual(["1", "2"]);
  expect(metadata.artifacts[0]!.url).toBe(
    "https://github.com/treflebonbon/skills/actions/runs/42/artifacts/1",
  );
  expect(verifyCohort({ ...cohort(), ...metadata }, manifest).verified).toBe(true);
  await expect(
    collectMetadata(
      async (path) => (path.includes("/artifacts?") ? { total_count: 4, artifacts } : read(path)),
      current,
      [],
    ),
  ).rejects.toThrow("artifact 一覧を完全に取得できません");
});

test("現在の attempt 開始後の待機 run と後続 attempt を過去の失敗にしない", async () => {
  const paths: string[] = [];
  const title = `Linux process proof: ${sourceSha}`;
  const read = async (path: string): Promise<Record<string, unknown>> => {
    paths.push(path);
    if (path === "/actions/runs/42")
      return {
        head_sha: workflowSha,
        run_attempt: 1,
        run_started_at: "2026-11-16T02:00:00Z",
        event: "workflow_dispatch",
        workflow_id: 7,
        display_title: title,
      };
    if (path.includes("/artifacts?")) return { total_count: 0, artifacts: [] };
    if (path.includes("/workflows/7/runs?"))
      return {
        total_count: 3,
        workflow_runs: [
          {
            id: 43,
            run_attempt: 1,
            status: "queued",
            created_at: "2026-11-16T03:00:00Z",
            display_title: title,
          },
          { id: 42, run_attempt: 1, display_title: title },
          { id: 41, run_attempt: 2, created_at: "2026-11-16T00:00:00Z", display_title: title },
        ],
      };
    if (path.includes("/attempts/")) {
      const earlier = path === "/actions/runs/41/attempts/1";
      return {
        id: path.includes("/runs/41/") ? 41 : 43,
        run_attempt: path.endsWith("/2") ? 2 : 1,
        display_title: title,
        status: earlier ? "completed" : "queued",
        conclusion: earlier ? "failure" : null,
        run_started_at: earlier ? "2026-11-16T01:00:00Z" : "2026-11-16T03:00:00Z",
      };
    }
    throw new Error(`未定義の API 呼出し: ${path}`);
  };
  const metadata = await collectMetadata(
    read,
    { runId: "42", attempt: 1, sourceSha, workflowSha },
    [],
  );
  expect(metadata.history).toMatchObject([{ runId: "41", attempt: 1, conclusion: "failure" }]);
  expect(metadata.history).toHaveLength(1);
  expect(paths).not.toContain("/actions/runs/43/attempts/1");
  expect(verifyCohort({ ...cohort(), history: metadata.history }, manifest).reasons).toContain(
    "同じ SHA に未解明の失敗があります: 41/1",
  );
  const onlyFuture = await collectMetadata(
    async (path) =>
      path.includes("/workflows/7/runs?")
        ? {
            total_count: 2,
            workflow_runs: [
              {
                id: 43,
                run_attempt: 1,
                status: "queued",
                created_at: "2026-11-16T03:00:00Z",
                display_title: title,
              },
              { id: 42, run_attempt: 1, display_title: title },
            ],
          }
        : read(path),
    { runId: "42", attempt: 1, sourceSha, workflowSha },
    [],
  );
  expect(onlyFuture.history).toEqual([]);
  expect(verifyCohort({ ...cohort(), history: onlyFuture.history }, manifest).verified).toBe(true);
  await expect(
    collectMetadata(
      async (path) =>
        path === "/actions/runs/42"
          ? { ...(await read(path)), run_started_at: undefined }
          : read(path),
      { runId: "42", attempt: 1, sourceSha, workflowSha },
      [],
    ),
  ).rejects.toThrow("履歴の開始日時を確認できません");
});

test("独立した manifest の全 case が対象 test file に存在する", () => {
  const result = spawnSync(
    process.execPath,
    ["test", fileURLToPath(new URL("./process-namespace.test.ts", import.meta.url))],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, PROCESS_PROOF_PID_NAMESPACE: "0", NO_COLOR: "1" },
    },
  );
  expect(result.status).toBe(0);
  const trial = parseTrial(result.stdout + result.stderr, result.status, 1);
  expect(trial.cases.map((item) => item.name).sort()).toEqual([...acceptedCases.cases].sort());
  expect(trial.counts.skip).toBe(acceptedCases.cases.length);
});

test("bundle の raw log・binary・closure の欠落や改変を成功にしない", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = fs.mkdtempSync(join(tmpdir(), "proof-bundle-"));
  const digest = (path: string) => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
  const write = (path: string, value: unknown) =>
    fs.writeFileSync(path, JSON.stringify(value) + "\n");
  try {
    const listing = spawnSync(
      "git",
      ["ls-files", "--", "lib", "tests", "development/linux-process-proof-cases.json"],
      { cwd: root, encoding: "utf8" },
    );
    expect(listing.status).toBe(0);
    const sources = Object.fromEntries(
      listing.stdout
        .trim()
        .split("\n")
        .map((path) => [path, digest(join(root, path))]),
    );
    const job = {
      ...cohort().jobs[0]!,
      schema: "linux-process-proof-job/v1",
      sources,
      sourcesAfter: sources,
      controllerHash: digest(join(root, "development/run-linux-process-proof.ts")),
      preflight: {
        ...cohort().jobs[0]!.preflight,
        verified: true,
        uid: 1000,
        euid: 1000,
        platform: "linux",
        arch: "x64",
        bun: "1.4.4",
        imageOS: "ubuntu24",
        imageVersion: "fixture",
        environment: { PATH: "/bin", HOME: "/home/runner" },
        kernel: "fixture",
        probe: { status: 0 },
        nix: {
          mode: "multi-user",
          remote: "daemon",
          sandbox: true,
          buildUsersGroup: "nixbld",
          daemon: { status: 0 },
        } as Record<string, unknown>,
        tools: Object.fromEntries(
          [
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
          ].map((name) => [
            name,
            { path: `/bin/${name}`, version: "fixture", hash: "a".repeat(64) },
          ]),
        ),
        contexts: Object.fromEntries(
          ["/proc/self/status", "/proc/self/uid_map", "/proc/self/gid_map"].map((path) => [
            path,
            { value: "fixture" },
          ]),
        ),
        namespaces: { user: "user:[1]", pid: "pid:[1]", mnt: "mnt:[1]" },
      },
      callerAfter: {
        status: { value: "fixture" },
        uidMap: { value: "fixture" },
        gidMap: { value: "fixture" },
        namespaces: { user: "user:[1]", pid: "pid:[1]", mnt: "mnt:[1]" },
      },
      trials: [] as unknown[],
    };
    fs.writeFileSync(
      join(directory, "nix-installer.sha256"),
      "311b9f406f0239ef640a1e3fbea1df1bac9d3a7c316c4def30df3206dd964960\n",
    );
    for (const name of ["bash", "stdenv"]) {
      const storeRoot = `/nix/store/${"a".repeat(32)}-${name}`;
      job.preflight.nix[name] = storeRoot;
      fs.writeFileSync(join(directory, `nix-${name}-root.txt`), storeRoot + "\n");
      fs.writeFileSync(join(directory, `nix-${name}-closure.txt`), storeRoot + "\n");
    }
    for (const repetition of [1, 2, 3]) {
      const temporary = `temporary-${repetition}-fixture`;
      const binaries = join(directory, temporary, "bun-process-namespace-fixture");
      fs.mkdirSync(binaries, { recursive: true });
      const pairs = [
        ["bun-process-namespace-observer.c", "observer"],
        ["bun-process-pidfds.c", "pidfds"],
        ["bun-exec-launcher.c", "baseline"],
        ["bun-exec-pid-namespace.c", "launcher"],
        ["bun-exec-pid-namespace.c", "without-proc"],
        ["bun-exec-namespace-delay.c", "delay.so"],
      ];
      const builds = pairs.map(([source, variant]) => {
        fs.writeFileSync(join(binaries, variant!), variant!);
        return {
          source,
          variant,
          sourceHash: sources[`tests/fixtures/${source}`],
          binaryHash: digest(join(binaries, variant!)),
        };
      });
      const observation = { ...cohort().jobs[0]!.trials[0]!.observation, build: { builds } };
      const log = `(pass) 終了保証 [1.00ms]\n(pass) 実 caller [2.00ms]\n${JSON.stringify(observation)}\n 2 pass\n 0 fail\n`;
      const name = `trial-${repetition}.log`;
      fs.writeFileSync(join(directory, name), log);
      job.trials.push({
        ...parseTrial(log, 0, repetition),
        environment: {
          PATH: "/bin",
          HOME: "/home/runner",
          TMPDIR: `/tmp/${temporary}`,
          PROCESS_PROOF_PID_NAMESPACE: "1",
          PROCESS_PROOF_RETAIN_TEMP: "1",
        },
        temporary,
        log: name,
        logHash: digest(join(directory, name)),
      });
    }
    write(join(directory, "job.json"), job);
    expect(readProofJob(root, directory, "x64").trials).toHaveLength(3);
    for (const field of ["gid", "groups", "group"] as const) {
      const missing = { ...job.preflight } as Partial<typeof job.preflight>;
      delete missing[field];
      write(join(directory, "job.json"), { ...job, preflight: missing });
      expect(() => readProofJob(root, directory, "x64")).toThrow(
        "資格情報・補助 group fixture の必須観測が不正です",
      );
    }
    write(join(directory, "job.json"), job);
    const pythonTool = job.preflight.tools.python3!;
    delete job.preflight.tools.python3;
    write(join(directory, "job.json"), job);
    expect(() => readProofJob(root, directory, "x64")).toThrow(
      "実行環境・資格情報・namespace の必須観測が不足しています",
    );
    job.preflight.tools.python3 = pythonTool;
    write(join(directory, "job.json"), job);
    expect(readProofJob(root, directory, "x64").trials).toHaveLength(3);
    const binary = join(directory, "temporary-1-fixture/bun-process-namespace-fixture/observer");
    fs.appendFileSync(binary, "changed");
    expect(() => readProofJob(root, directory, "x64")).toThrow(
      "保存された source/binary と hash が一致しません",
    );
    fs.writeFileSync(binary, "observer");
    const closure = join(directory, "nix-bash-closure.txt");
    const savedClosure = fs.readFileSync(closure, "utf8");
    fs.writeFileSync(closure, "");
    expect(() => readProofJob(root, directory, "x64")).toThrow("Nix closure の証跡が不正です");
    fs.writeFileSync(closure, savedClosure);
    expect(readProofJob(root, directory, "x64").trials).toHaveLength(3);
    fs.appendFileSync(join(directory, "trial-1.log"), "changed");
    expect(() => readProofJob(root, directory, "x64")).toThrow(
      "反復 1 の log 同一性・終了状態を確認できません",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "group 観測用 fixture は実際の読み書きと file identity を返す",
  () => {
    const root = fs.mkdtempSync(join(tmpdir(), "group-observer-"));
    try {
      const binary = join(root, "observer"),
        file = join(root, "data");
      const build = spawnSync(
        "cc",
        [
          "-std=c11",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          fileURLToPath(new URL("../fixtures/bun-process-namespace-observer.c", import.meta.url)),
          "-o",
          binary,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(build.error).toBeUndefined();
      expect(build.status).toBe(0);
      fs.writeFileSync(file, "group-proof\n", { mode: 0o600 });
      const before = fs.statSync(file);
      const result = spawnSync(binary, ["group-access", file], {
        encoding: "utf8",
        timeout: 3_000,
      });
      expect(result.status).toBe(0);
      const line = result.stderr
        .split("\n")
        .find((line) => line.startsWith("namespace-group-access:"));
      expect(line).toBeDefined();
      const report = JSON.parse(line!.slice("namespace-group-access:".length));
      expect(report.dev).toBe(String(before.dev));
      expect(report.ino).toBe(String(before.ino));
      expect(report.readErrno).toBe(0);
      expect(report.writeErrno).toBe(0);
      expect(report.readMarker).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe("group-proof\nwrite-proof\n");
      const missing = spawnSync(binary, ["group-access", join(root, "missing")], {
        encoding: "utf8",
        timeout: 3_000,
      });
      expect(missing.status).toBe(90);
      expect(missing.stderr).toContain("group file stat");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
