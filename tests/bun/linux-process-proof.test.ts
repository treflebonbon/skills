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
import { createFixtureInterpreter } from "../helpers/linux-namespace-fixture";

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
  artifacts.push({ ...artifacts[0]!, name: "namespace-loop-42-1-x64", id: 4 });
  artifacts.push({ ...artifacts[0]!, name: "namespace-minimize-42-1-x64", id: 5 });
  artifacts.push({ ...artifacts[0]!, name: "namespace-isolate-42-1-x64", id: 6 });
  artifacts.push({ ...artifacts[0]!, name: "namespace-caller-42-1-x64", id: 7 });
  artifacts.push({ ...artifacts[0]!, name: "namespace-environment-42-1-x64", id: 8 });
  artifacts.push({ ...artifacts[0]!, name: "namespace-launch-42-1-x64", id: 9 });
  artifacts.push({ ...artifacts[0]!, name: "namespace-cwd-42-1-x64", id: 10 });
  artifacts.push({ ...artifacts[0]!, name: "namespace-stdout-42-1-x64", id: 11 });
  artifacts.push({ ...artifacts[0]!, name: "namespace-stderr-42-1-x64", id: 12 });
  artifacts.push({ ...artifacts[0]!, name: "namespace-parent-42-1-x64", id: 13 });
  artifacts.push({ ...artifacts[0]!, name: "namespace-stdin-42-1-x64", id: 14 });
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
        total_count: 11,
        workflow_runs: [
          { id: 42, run_attempt: 1, display_title: `Linux process proof: ${sourceSha}` },
          {
            id: 41,
            run_attempt: 1,
            created_at: "2026-11-16T00:00:00Z",
            conclusion: "failure",
            display_title: `Linux namespace 再現ループ: ${sourceSha}`,
          },
          {
            id: 40,
            run_attempt: 1,
            created_at: "2026-11-15T00:00:00Z",
            conclusion: "failure",
            display_title: `Linux namespace オプション削減: ${sourceSha}`,
          },
          {
            id: 39,
            run_attempt: 1,
            created_at: "2026-11-14T00:00:00Z",
            conclusion: "failure",
            display_title: `Linux namespace 独立測定: ${sourceSha}`,
          },
          {
            id: 38,
            run_attempt: 1,
            created_at: "2026-11-13T00:00:00Z",
            conclusion: "failure",
            display_title: `Linux namespace caller比較: ${sourceSha}`,
          },
          {
            id: 37,
            run_attempt: 1,
            created_at: "2026-11-12T00:00:00Z",
            conclusion: "failure",
            display_title: `Linux namespace 環境比較: ${sourceSha}`,
          },
          {
            id: 36,
            run_attempt: 1,
            created_at: "2026-11-11T00:00:00Z",
            conclusion: "failure",
            display_title: `Linux namespace 起動経路比較: ${sourceSha}`,
          },
          {
            id: 35,
            run_attempt: 1,
            created_at: "2026-11-10T00:00:00Z",
            conclusion: "failure",
            display_title: `Linux namespace cwd比較: ${sourceSha}`,
          },
          {
            id: 34,
            run_attempt: 1,
            created_at: "2026-11-09T00:00:00Z",
            conclusion: "failure",
            display_title: `Linux namespace stdout比較: ${sourceSha}`,
          },
          {
            id: 33,
            run_attempt: 1,
            created_at: "2026-11-08T00:00:00Z",
            conclusion: "failure",
            display_title: `Linux namespace stderr比較: ${sourceSha}`,
          },
          {
            id: 32,
            run_attempt: 1,
            created_at: "2026-11-07T00:00:00Z",
            conclusion: "failure",
            display_title: `Linux namespace Python起動層比較: ${sourceSha}`,
          },
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
      async (path) =>
        path.includes("/artifacts?")
          ? { total_count: artifacts.length + 1, artifacts }
          : read(path),
      current,
      [],
    ),
  ).rejects.toThrow("artifact 一覧を完全に取得できません");
  for (const title of [
    "Linux namespace 再現ループ",
    "Linux namespace オプション削減",
    "Linux namespace 独立測定",
    "Linux namespace caller比較",
    "Linux namespace 環境比較",
    "Linux namespace 起動経路比較",
    "Linux namespace cwd比較",
    "Linux namespace stdout比較",
    "Linux namespace stderr比較",
    "Linux namespace Python起動層比較",
  ])
    await expect(
      collectMetadata(
        async (path) =>
          path === "/actions/runs/42"
            ? { ...(await read(path)), display_title: `${title}: ${sourceSha}` }
            : read(path),
        current,
        [],
      ),
    ).rejects.toThrow("実行 metadata が source/workflow/run/attempt と一致しません");
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
      // CLAUDECODE があると bun test は case ごとの行を出さず、case 名を取れない
      env: {
        ...process.env,
        CLAUDECODE: undefined,
        PROCESS_PROOF_PID_NAMESPACE: "0",
        NO_COLOR: "1",
      },
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
    const arm64Job = {
      ...job,
      arch: "arm64",
      preflight: { ...job.preflight, arch: "arm64", imageOS: "ubuntu24-arm64" },
    };
    const installer = join(directory, "nix-installer.sha256");
    const x64Installer = fs.readFileSync(installer, "utf8");
    fs.writeFileSync(
      installer,
      "09edae3ed146b1a47de84eda6135ef12ee74783d409e7a207c912cb94e14aa35\n",
    );
    write(join(directory, "job.json"), arm64Job);
    expect(readProofJob(root, directory, "arm64").trials).toHaveLength(3);
    for (const imageOS of ["ubuntu24", "ubuntu22", "", undefined]) {
      write(join(directory, "job.json"), {
        ...arm64Job,
        preflight: { ...arm64Job.preflight, imageOS },
      });
      expect(() => readProofJob(root, directory, "arm64")).toThrow(
        "実行環境・資格情報・namespace の必須観測が不足しています",
      );
    }
    fs.writeFileSync(installer, x64Installer);
    write(join(directory, "job.json"), {
      ...job,
      preflight: { ...job.preflight, imageOS: "ubuntu24-arm64" },
    });
    expect(() => readProofJob(root, directory, "x64")).toThrow(
      "実行環境・資格情報・namespace の必須観測が不足しています",
    );
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

for (const diagnostic of [false, true]) {
  test.skipIf(
    process.platform !== "linux" ||
      !fs.existsSync("/usr/bin/journalctl") ||
      (diagnostic &&
        (Bun.version !== "1.4.4" || process.getuid?.() === 0 || process.geteuid?.() === 0)),
  )(
    diagnostic
      ? "namespace診断CLIは固定版Bun・非rootで反復・削減・独立測定を検証する"
      : "run CLI は失敗 probe の実行体・監査観測を限定保存し終了状態を返す",
    () => {
      const root = fileURLToPath(new URL("../../", import.meta.url));
      const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "linux-probe-cli-"));
      let cleanup = () => {};
      try {
        const interpreter = createFixtureInterpreter(process.execPath);
        cleanup = interpreter.cleanup;
        const bin = join(directory, "bin");
        const output = join(directory, "evidence");
        const pidFile = join(directory, "probe.pid");
        const argvFile = join(directory, "probe.argv");
        const sudoArgsFile = join(directory, "sudo.argv");
        fs.mkdirSync(bin);
        fs.mkdirSync(output);
        const executable = (name: string, source: string) => {
          const path = join(bin, name);
          fs.writeFileSync(path, "#!" + interpreter.path + "\n" + source + "\n");
          fs.chmodSync(path, 0o755);
          return path;
        };
        for (const name of ["cc", "nix-build", "nix-store", "setpriv", "bun", "python3"])
          executable(name, 'process.stdout.write("fixture version\\n");');
        executable(
          "unshare",
          [
            'const fs = require("node:fs");',
            'if (process.argv.includes("--version")) { process.stdout.write("unshare fixture\\n"); process.exit(0); }',
            "fs.writeFileSync(process.env.PROBE_PID_FILE, String(process.pid));",
            "fs.writeFileSync(process.env.PROBE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));",
            "const args = process.argv.slice(2);",
            "const variant = process.env.PROBE_MINIMIZE;",
            "if (variant) {",
            '  const hasMap = args.includes("--map-current-user");',
            '  if (!hasMap && variant === "other-failure") { process.stderr.write("unshare: different failure\\n"); process.exit(1); }',
            '  if (!hasMap || (variant === "revisit" && !args.includes("--user") && args.includes("--pid"))) process.exit(0);',
            '  if (variant === "inconsistent") { const file = process.env.PROBE_COUNTER_FILE; const count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0; fs.writeFileSync(file, String(count + 1)); if (count === 4) process.exit(0); }',
            "}",
            'const finish = () => { if (process.env.PROBE_SUCCESS === "1") process.exit(0); process.stderr.write((process.env.PROBE_FAILURE_MESSAGE || "unshare: write failed /proc/self/uid_map: Operation not permitted") + "\\n"); process.exitCode = 1; };',
            "if (process.env.PROBE_SAMPLE_READY) {",
            "  const deadline = Date.now() + 10000;",
            '  const wait = () => { if (fs.existsSync(process.env.PROBE_SAMPLE_READY)) return finish(); if (Date.now() >= deadline) { process.stderr.write("fixture sample notification timed out\\n"); process.exit(97); } setTimeout(wait, 5); };',
            "  wait();",
            "} else finish();",
          ].join("\n"),
        );
        executable(
          "nix",
          [
            "const args = process.argv.slice(2);",
            'if (args[0] === "--version") process.stdout.write("nix (Nix) 2.34.6\\n");',
            'else if (args.includes("config")) { if (process.env.PROBE_NIX_CONFIG_FAIL === "1") { process.stderr.write("fixture Nix config failure\\n"); process.exitCode = 1; } else process.stdout.write(JSON.stringify({ sandbox: { value: true }, "build-users-group": { value: "nixbld" } }) + "\\n"); }',
            'else if (args.includes("ping")) process.stdout.write("{}\\n");',
            "else process.exitCode = 1;",
          ].join("\n"),
        );
        executable(
          "sudo",
          [
            'const fs = require("node:fs");',
            "const args = process.argv.slice(2);",
            'if (args[0] === "--version") process.stdout.write("sudo fixture\\n");',
            "else {",
            "  fs.writeFileSync(process.env.PROBE_SUDO_ARGS_FILE, JSON.stringify(args));",
            '  const since = new Date(args[args.indexOf("--since") + 1]).getTime();',
            '  const until = new Date(args[args.indexOf("--until") + 1]).getTime();',
            "  const timestamp = Math.floor((since + until) / 2);",
            '  const pid = Number(fs.readFileSync(process.env.PROBE_PID_FILE, "utf8"));',
            '  const entry = (message) => JSON.stringify({ _PID: "0", __REALTIME_TIMESTAMP: String(timestamp * 1000), MESSAGE: message });',
            "  const quote = (value) => String.fromCharCode(34) + value + String.fromCharCode(34);",
            '  const stamp = (sequence) => "audit(" + (timestamp / 1000).toFixed(3) + ":" + sequence + "): ";',
            "  const entries = [",
            '    entry(stamp(1) + "apparmor=" + quote("DENIED") + " operation=" + quote("userns_create") + " info=" + quote("pid=" + pid) + " pid=" + (pid + 1) + " comm=" + quote("decoy")),',
            '    entry(stamp(2) + "apparmor=" + quote("DENIED") + " operation=" + quote("userns_create") + " pid=" + pid + " comm=" + quote("unshare")),',
            '    entry(stamp(3) + "apparmor=" + quote("DENIED") + " operation=" + quote("userns_create") + " ppid=" + pid + " comm=" + quote("parent")),',
            '    entry(stamp(4) + "apparmor=" + quote("DENIED") + " operation=" + quote("userns_create") + " pid=" + (pid + 1) + " comm=" + quote("other"))',
            "  ];",
            '  if (process.env.PROBE_JOURNAL_MODE === "truncated") while (entries.length < 101) entries.push(entry(stamp(entries.length + 1) + "apparmor=" + quote("DENIED") + " operation=" + quote("userns_create") + " pid=" + pid));',
            '  if (process.env.PROBE_JOURNAL_MODE === "null") process.stdout.write("null\\n");',
            '  else if (process.env.PROBE_JOURNAL_MODE === "empty") process.exitCode = 1;',
            '  else if (process.env.PROBE_JOURNAL_MODE === "empty-success") process.stdout.write("");',
            '  else if (process.env.PROBE_JOURNAL_MODE === "other-error") { process.stderr.write("journalctl: unexpected failure\\n"); process.exitCode = 1; }',
            '  else if (process.env.PROBE_JOURNAL_MODE === "partial-failure") { process.stdout.write(entries[1] + "\\n"); process.exitCode = 1; }',
            '  else if (process.env.PROBE_JOURNAL_MODE === "other-exit") process.exitCode = 2;',
            '  else if (process.env.PROBE_JOURNAL_MODE === "permission-denied") { process.stderr.write("sudo: a password is required\\n"); process.exitCode = 1; }',
            '  else process.stdout.write(entries.join("\\n") + "\\n");',
            "}",
          ].join("\n"),
        );
        const procPreload = join(directory, "probe-proc-preload.js");
        fs.writeFileSync(
          procPreload,
          [
            'import { mock } from "bun:test";',
            'import * as original from "node:fs";',
            "const originalExports = { ...original };",
            "const originalReadFileSync = original.readFileSync.bind(original);",
            "const originalWriteFileSync = original.writeFileSync.bind(original);",
            "const originalReadlinkSync = original.readlinkSync.bind(original);",
            "const originalStatSync = original.statSync.bind(original);",
            "const originalExistsSync = original.existsSync.bind(original);",
            "let statReads = 0;",
            "let statusReads = 0;",
            "let executableReads = 0;",
            "let profileRead = false;",
            'const sampled = () => { if (process.env.PROBE_SAMPLE_READY) originalWriteFileSync(process.env.PROBE_SAMPLE_READY, "ready\\n"); };',
            'const denied = () => Object.assign(new Error("EACCES"), { code: "EACCES" });',
            'const processPath = (path) => typeof path === "string" ? /^\\/proc\\/(\\d+)\\/(stat|status|attr\\/current)$/.exec(path) : null;',
            'mock.module("node:fs", () => ({',
            "  ...originalExports,",
            '  existsSync(path) { if (process.env.PROBE_ISOLATE === "1" && ["/nix", "/etc/nix/nix.conf"].includes(path)) return process.env.PROBE_ISOLATE_NIX_PRESENT === "1"; return originalExistsSync(path); },',
            "  readFileSync(path, ...args) {",
            '    if (path === "/etc/os-release" && process.env.PROBE_GROUP_VALID === "1") return "VERSION_ID=" + JSON.stringify("24.04") + "\\n";',
            "    const match = processPath(path);",
            "    if (!match) return originalReadFileSync(path, ...args);",
            "    const [, pid, file] = match;",
            "    const mode = process.env.PROBE_PROC_MODE;",
            '    if (file === "stat") {',
            "      const sequence = statReads++;",
            '      if (mode === "stable" && sequence === 0) {',
            "        const deadline = Date.now() + 5000;",
            '        while (true) { try { if (originalReadFileSync(process.env.PROBE_PID_FILE, "utf8") === pid) break; } catch {} if (Date.now() >= deadline) throw Error("fixture child start timeout"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }',
            "        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);",
            "      }",
            '      if ((mode === "initial-stat-denied" && sequence === 0) || (mode === "retry-stat-denied" && sequence > 0)) { sampled(); throw denied(); }',
            '      if (mode === "reuse" && sequence > 0) sampled();',
            '      const startTicks = mode === "reuse" && sequence > 0 ? "200" : "100";',
            '      const fields = Array.from({ length: 20 }, (_, index) => index === 0 ? "S" : index === 19 ? startTicks : "0");',
            '      return pid + " (probe) " + fields.join(" ") + "\\n";',
            "    }",
            '    if (file === "status") {',
            '      if ((mode === "reuse" || mode === "stable" || mode === "retry-stat-denied") && statusReads++ === 0) throw denied();',
            "      return [",
            '        "Uid:\\t1000\\t1000\\t1000\\t1000",',
            '        "Gid:\\t1000\\t1000\\t1000\\t1000",',
            '        "Groups:\\t1000",',
            '        "CapInh:\\t0000000000000000",',
            '        "CapPrm:\\t0000000000000000",',
            '        "CapEff:\\t0000000000000000",',
            '        "CapBnd:\\t0000000000000000",',
            '        "CapAmb:\\t0000000000000000",',
            '        "NoNewPrivs:\\t0",',
            '        "Seccomp:\\t0",',
            '      ].join("\\n");',
            "    }",
            "    profileRead = true;",
            '    return "unconfined\\n";',
            "  },",
            "  statSync(path, ...args) {",
            "    const value = originalStatSync(path, ...args);",
            '    if (path === process.env.PROCESS_PROOF_GROUP_FILE && process.env.PROBE_GROUP_VALID === "1") return Object.assign(value, { uid: process.getuid() + 1, gid: Number(process.env.PROCESS_PROOF_GROUP_GID), mode: (value.mode & ~0o777) | 0o060 });',
            "    return value;",
            "  },",
            "  readlinkSync(path, ...args) {",
            '    if (typeof path === "string" && /^\\/proc\\/\\d+\\/exe$/.test(path)) {',
            '      if (process.env.PROBE_PROC_MODE === "exec-transition" && executableReads++ < 2) return "/tmp/pre-exec";',
            "      if (profileRead) sampled();",
            "      return process.env.PROBE_EXPECTED_EXE;",
            "    }",
            "    return originalReadlinkSync(path, ...args);",
            "  },",
            "}));",
          ].join("\n"),
        );
        fs.symlinkSync(Bun.which("git")!, join(bin, "git"));
        const group = join(directory, "group-data");
        fs.writeFileSync(group, "fixture\n", { mode: 0o600 });
        const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
        expect(head.status).toBe(0);
        const cli = join(root, "development/run-linux-process-proof.ts");
        const memberGids = new Set([
          process.getgid!(),
          process.getegid!(),
          ...process.getgroups!(),
        ]);
        let groupGid = 60000;
        while (memberGids.has(groupGid)) groupGid++;
        const env = {
          ...process.env,
          PATH: bin + ":" + process.env.PATH,
          PROOF_SOURCE_SHA: head.stdout.trim(),
          PROOF_ARCH: process.arch === "arm64" ? "arm64" : "x64",
          GITHUB_SHA: head.stdout.trim(),
          GITHUB_RUN_ID: "42",
          GITHUB_RUN_ATTEMPT: "1",
          ImageOS: process.arch === "arm64" ? "ubuntu24-arm64" : "ubuntu24",
          ImageVersion: "fixture",
          NIX_REMOTE: "daemon",
          PROCESS_PROOF_NIX_BASH: "/nix/store/fixture-bash",
          PROCESS_PROOF_NIX_STDENV: "/nix/store/fixture-stdenv",
          PROCESS_PROOF_GROUP_FILE: group,
          PROCESS_PROOF_GROUP_GID: String(groupGid),
          PROBE_PID_FILE: pidFile,
          PROBE_ARGV_FILE: argvFile,
          PROBE_SUDO_ARGS_FILE: sudoArgsFile,
          PROBE_EXPECTED_EXE: join(bin, "unshare"),
        };
        const execute = (
          evidenceDirectory: string,
          extraEnv: NodeJS.ProcessEnv = {},
          preload?: string,
          mode = "run",
        ) =>
          spawnSync(
            process.execPath,
            [...(preload ? ["--preload", preload] : []), cli, mode, root, evidenceDirectory],
            {
              cwd: root,
              encoding: "utf8",
              timeout: 20_000,
              env: { ...env, ...extraEnv },
            },
          );
        const result = execute(output);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("前提検査未達のため実証を開始しません");
        const job = JSON.parse(fs.readFileSync(join(output, "job.json"), "utf8"));
        const probe = job.preflight.probe;
        const pid = Number(fs.readFileSync(pidFile, "utf8"));
        if (!diagnostic) {
          expect(probe.pid).toBe(pid);
          expect(probe.argv).toEqual([
            "--user",
            "--map-current-user",
            "--pid",
            "--fork",
            "--kill-child=SIGKILL",
            "--mount-proc",
            "--",
            "/usr/bin/true",
          ]);
          expect(JSON.parse(fs.readFileSync(argvFile, "utf8"))).toEqual(probe.argv);
          expect(probe.status).toBe(1);
          expect(probe.stdout).toBe("");
          expect(probe.stderr).toBe(
            "unshare: write failed /proc/self/uid_map: Operation not permitted\n",
          );
          expect(Date.parse(probe.startedAt)).toBeLessThanOrEqual(Date.parse(probe.endedAt));
          expect(["process-exited-before-sample", "exe-mismatch"]).toContain(
            probe.processObservation.status,
          );
          expect(probe.processObservation.pid).toBe(pid);
          expect(probe.processObservation.profile).toBeUndefined();
          expect(probe.processObservation.capabilities).toBeUndefined();
          expect(probe.audit.status).toBe("matched");
          const journalctlPath = fs.realpathSync("/usr/bin/journalctl");
          expect(probe.audit.reader.path).toBe(journalctlPath);
          expect(probe.audit.reader.hash).toMatch(/^[a-f0-9]{64}$/);
          expect(probe.audit.reader.version.status).toBe("recorded");
          expect(probe.audit.reader.version.argv).toEqual(["--version"]);
          expect(probe.audit.reader.version.value).toContain("systemd");
          expect(probe.audit.command.path).toBe(join(bin, "sudo"));
          expect(probe.audit.command.argv).toContain(
            "--output-fields=__REALTIME_TIMESTAMP,_PID,MESSAGE",
          );
          expect(probe.audit.events).toHaveLength(1);
          expect(probe.audit.events[0].journalPid).toBe("0");
          expect(probe.audit.events[0].message).toContain("pid=" + pid);
          expect(probe.audit.events[0].message).toContain('operation="userns_create"');
          const sudoArgs = JSON.parse(fs.readFileSync(sudoArgsFile, "utf8"));
          expect(sudoArgs).toContain(journalctlPath);
          expect(sudoArgs).toContain("--dmesg");
          expect(sudoArgs).toContain("--grep=(^|[^[:alnum:]_])pid=" + pid + "([^[:alnum:]_]|$)");
          expect(sudoArgs).toContain("--output-fields=__REALTIME_TIMESTAMP,_PID,MESSAGE");
          expect(probe.audit.events[0].messagePid).toBe(pid);
          expect(probe.audit.events[0].message).not.toContain("decoy");
          const formalPartialOutput = join(directory, "formal-config-failure");
          const formalPartialResult = execute(
            formalPartialOutput,
            { PROBE_GROUP_VALID: "1", PROBE_NIX_CONFIG_FAIL: "1" },
            procPreload,
          );
          expect(formalPartialResult.error).toBeUndefined();
          expect(formalPartialResult.status).toBe(1);
          expect(formalPartialResult.stderr).toContain("fixture Nix config failure");
          const formalPartial = JSON.parse(
            fs.readFileSync(join(formalPartialOutput, "job.json"), "utf8"),
          );
          expect(formalPartial.error).toContain("fixture Nix config failure");
          expect(formalPartial.trials).toEqual([]);
          expect(formalPartial.preflight).toBeDefined();
          expect(formalPartial.preflight.verified).toBe(false);
          expect(formalPartial.preflight.errors).toEqual([formalPartial.error]);
          expect(formalPartial.preflight.probe.pid).toBeGreaterThan(0);
          expect(formalPartial.preflight.probe.status).toBe(1);
          expect(formalPartial.preflight.probe.stderr).toBe(
            "unshare: write failed /proc/self/uid_map: Operation not permitted\n",
          );
          expect(formalPartial.preflight.probe.audit.status).toBe("matched");
          expect(formalPartial.preflight.tools.unshare.path).toBe(join(bin, "unshare"));
          expect(formalPartial.preflight.contexts["/proc/self/status"]).toBeDefined();
          expect(formalPartial.preflight.namespaces.user).toBeDefined();
          expect(formalPartial.preflight.nix).toBeUndefined();
          expect(formalPartial.preflight.group).toBeUndefined();
          const observeProbe = (name: string, mode: string) => {
            const evidenceDirectory = join(directory, name);
            fs.mkdirSync(evidenceDirectory);
            const result = execute(
              evidenceDirectory,
              {
                PROBE_PROC_MODE: mode,
                PROBE_SAMPLE_READY: join(evidenceDirectory, "sample.ready"),
              },
              procPreload,
            );
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("前提検査未達のため実証を開始しません");
            const probe = JSON.parse(fs.readFileSync(join(evidenceDirectory, "job.json"), "utf8"))
              .preflight.probe;
            expect(probe.status).toBe(1);
            expect(probe.stderr).toBe(
              "unshare: write failed /proc/self/uid_map: Operation not permitted\n",
            );
            expect(fs.existsSync(join(evidenceDirectory, "sample.ready"))).toBe(true);
            return probe.processObservation;
          };
          const reusedPid = observeProbe("pid-reuse-evidence", "reuse");
          expect(reusedPid).toMatchObject({
            status: "process-changed",
            expectedStartTicks: "100",
            observedStartTicks: "200",
          });
          expect(reusedPid.identity).toBeUndefined();
          const unidentified = observeProbe("unidentified-evidence", "initial-stat-denied");
          expect(unidentified).toMatchObject({ status: "permission-denied", error: "EACCES" });
          expect(unidentified.startTicks).toBeUndefined();
          const retryStatDenied = observeProbe("retry-stat-denied-evidence", "retry-stat-denied");
          expect(retryStatDenied).toMatchObject({ status: "permission-denied", startTicks: "100" });
          const stablePid = observeProbe("stable-pid-evidence", "stable");
          expect(stablePid).toMatchObject({ status: "observed", startTicks: "100" });
          const execTransition = observeProbe("exec-transition-evidence", "exec-transition");
          expect(execTransition).toMatchObject({ status: "observed", startTicks: "100" });
          for (const [mode, expectedAuditStatus, expectedReason] of [
            ["null", "unavailable", "record-not-object"],
            ["empty", "no-matching-events", undefined],
            ["empty-success", "empty", undefined],
            ["other-error", "unavailable", "journal-exit-1"],
            ["partial-failure", "unavailable", "journal-exit-1"],
            ["other-exit", "unavailable", "journal-exit-2"],
            ["permission-denied", "permission-denied", "journal-exit-1"],
          ] as const) {
            const evidenceDirectory = join(directory, mode + "-journal-evidence");
            fs.mkdirSync(evidenceDirectory);
            const result = execute(evidenceDirectory, { PROBE_JOURNAL_MODE: mode });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(1);
            const failedProbe = JSON.parse(
              fs.readFileSync(join(evidenceDirectory, "job.json"), "utf8"),
            ).preflight.probe;
            expect(failedProbe.status).toBe(1);
            expect(failedProbe.stderr).toBe(
              "unshare: write failed /proc/self/uid_map: Operation not permitted\n",
            );
            expect(failedProbe.audit.status).toBe(expectedAuditStatus);
            expect(failedProbe.audit.reason).toBe(expectedReason);
            if (mode === "empty") {
              expect(failedProbe.audit.readStatus).toBe("no-matching-events");
              expect(failedProbe.audit.recordCount).toBe(0);
              expect(failedProbe.audit.events).toEqual([]);
              expect(failedProbe.audit.command.argv).toContain(
                "--grep=(^|[^[:alnum:]_])pid=" + failedProbe.pid + "([^[:alnum:]_]|$)",
              );
            }
            expect(result.stderr).not.toContain("Cannot read properties of null");
          }
          const successfulOutput = join(directory, "successful-evidence");
          fs.mkdirSync(successfulOutput);
          fs.rmSync(sudoArgsFile, { force: true });
          const successfulResult = execute(successfulOutput, { PROBE_SUCCESS: "1" });
          expect(successfulResult.error).toBeUndefined();
          expect(successfulResult.status).toBe(1);
          const successfulProbe = JSON.parse(
            fs.readFileSync(join(successfulOutput, "job.json"), "utf8"),
          ).preflight.probe;
          expect(successfulProbe.status).toBe(0);
          expect(successfulProbe.audit.status).toBe("not-requested");
          expect(successfulProbe.audit.events).toEqual([]);
          expect(fs.existsSync(sudoArgsFile)).toBe(false);
          const truncatedOutput = join(directory, "truncated-evidence");
          fs.mkdirSync(truncatedOutput);
          const truncatedResult = execute(truncatedOutput, { PROBE_JOURNAL_MODE: "truncated" });
          expect(truncatedResult.error).toBeUndefined();
          expect(truncatedResult.status).toBe(1);
          const truncatedProbe = JSON.parse(
            fs.readFileSync(join(truncatedOutput, "job.json"), "utf8"),
          ).preflight.probe;
          expect(truncatedProbe.audit.status).toBe("truncated");
          expect(truncatedProbe.audit.reason).toBe("record-limit");
          expect(truncatedProbe.audit.recordCount).toBe(101);
          expect(truncatedProbe.audit.events).toEqual([]);
        } else {
          for (const [name, extraEnv, expectedExit, expectedOutcome, expectedCount] of [
            ["uid-map", { PROBE_GROUP_VALID: "1" }, 1, "uid-map-eperm", 3],
            ["passes", { PROBE_GROUP_VALID: "1", PROBE_SUCCESS: "1" }, 0, "passed", 3],
            [
              "other-error",
              {
                PROBE_GROUP_VALID: "1",
                PROBE_FAILURE_MESSAGE: "unshare: unshare failed: Operation not permitted",
              },
              2,
              "unavailable",
              1,
            ],
            ["other-precondition", {}, 2, "unavailable", 1],
            [
              "config-failure",
              { PROBE_GROUP_VALID: "1", PROBE_NIX_CONFIG_FAIL: "1" },
              2,
              "unavailable",
              1,
            ],
          ] as const) {
            const loopOutput = join(directory, "loop-" + name);
            const loopResult = execute(loopOutput, extraEnv, procPreload, "probe-loop");
            expect(loopResult.error).toBeUndefined();
            expect(loopResult.status).toBe(expectedExit);
            if (name !== "config-failure") expect(loopResult.stdout).toContain("[DEBUG-ns-loop]");
            const evidence = JSON.parse(
              fs.readFileSync(join(loopOutput, "namespace-loop.json"), "utf8"),
            );
            expect(evidence.schema).toBe("linux-namespace-probe-loop/v1");
            expect(evidence.outcome).toBe(expectedOutcome);
            expect(evidence.repetitions).toHaveLength(expectedCount);
            expect(fs.existsSync(join(loopOutput, "job.json"))).toBe(false);
            for (const repetition of evidence.repetitions) {
              expect(repetition.preflight.probe.argv).toEqual(probe.argv);
              expect(repetition.elapsedMs).toBeGreaterThanOrEqual(0);
            }
            if (name === "config-failure") {
              const repetition = evidence.repetitions[0];
              const partial = repetition.preflight;
              expect(repetition.error).toContain("fixture Nix config failure");
              expect(repetition.outcome).toBe("unavailable");
              expect(partial.verified).toBe(false);
              expect(partial.errors).toEqual([repetition.error]);
              expect(partial.probe.status).toBe(1);
              expect(partial.probe.stderr).toContain(
                "unshare: write failed /proc/self/uid_map: Operation not permitted",
              );
              expect(partial.probe.pid).toBeGreaterThan(0);
              expect(Date.parse(partial.probe.startedAt)).toBeLessThanOrEqual(
                Date.parse(partial.probe.endedAt),
              );
              expect(partial.probe.audit.status).toBe("matched");
              expect(partial.tools.unshare.path).toBe(join(bin, "unshare"));
              expect(partial.contexts["/proc/self/status"]).toBeDefined();
              expect(partial.namespaces.user).toBeDefined();
              expect(Object.keys(partial.environment).sort()).toEqual(
                [
                  "HOME",
                  "NIX_REMOTE",
                  "PATH",
                  "PROCESS_PROOF_GROUP_FILE",
                  "PROCESS_PROOF_GROUP_GID",
                  "PROCESS_PROOF_NIX_BASH",
                  "PROCESS_PROOF_NIX_STDENV",
                ].sort(),
              );
              expect(partial.nix).toBeUndefined();
              expect(partial.group).toBeUndefined();
            }
            if (name === "other-error") {
              const failed = evidence.repetitions[0].preflight;
              expect(failed.probe.stderr).toBe(
                "unshare: unshare failed: Operation not permitted\n",
              );
              expect(failed.errors).toContain(
                "同じ条件の namespace 前提検査が失敗しました。拒否原因は未確定です",
              );
            }
            if (name === "other-precondition") {
              const failed = evidence.repetitions[0].preflight;
              expect(failed.errors).toContain("補助 group fixture の資格情報が不正です");
              expect(failed.probe.stderr).toBe(
                "unshare: write failed /proc/self/uid_map: Operation not permitted\n",
              );
            }
            if (expectedCount === 3)
              expect(
                new Set(
                  evidence.repetitions.map(
                    (entry: { preflight: { probe: { pid: number } } }) => entry.preflight.probe.pid,
                  ),
                ).size,
              ).toBe(3);
            if (name === "passes") {
              expect(
                evidence.repetitions.every(
                  (entry: { preflight: { probe: { audit: { status: string } } } }) =>
                    entry.preflight.probe.audit.status === "not-requested",
                ),
              ).toBe(true);
              const before = fs.readFileSync(join(loopOutput, "namespace-loop.json"), "utf8");
              const repeated = execute(loopOutput, extraEnv, procPreload, "probe-loop");
              expect(repeated.status).toBe(2);
              expect(repeated.stderr).toContain("EEXIST");
              expect(fs.readFileSync(join(loopOutput, "namespace-loop.json"), "utf8")).toBe(before);
            }
          }
          for (const [variant, expectedExit, expectedOutcome] of [
            ["revisit", 1, "minimal-options"],
            ["other-failure", 2, "incomplete"],
            ["inconsistent", 2, "unavailable"],
            ["passes", 0, undefined],
          ] as const) {
            const output = join(directory, "minimize-" + variant);
            const result = execute(
              output,
              {
                PROBE_GROUP_VALID: "1",
                PROBE_MINIMIZE: variant === "passes" ? undefined : variant,
                PROBE_SUCCESS: variant === "passes" ? "1" : undefined,
                PROBE_COUNTER_FILE: join(directory, "counter"),
              },
              procPreload,
              "probe-minimize",
            );
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(expectedExit);
            const evidence = JSON.parse(
              fs.readFileSync(join(output, "namespace-minimize.json"), "utf8"),
            );
            expect(evidence.schema).toBe("linux-namespace-probe-minimize/v1");
            expect(evidence.repetitions).toHaveLength(3);
            expect(evidence.repetitions[0].preflight.probe.argv).toEqual(probe.argv);
            expect(evidence.minimization?.outcome).toBe(expectedOutcome);
            expect(fs.existsSync(join(output, "job.json"))).toBe(false);
            expect(fs.existsSync(join(output, "namespace-loop.json"))).toBe(false);
            if (variant === "passes") {
              expect(evidence.outcome).toBe("passed");
              expect(evidence.minimization).toBeUndefined();
              const before = fs.readFileSync(join(output, "namespace-minimize.json"), "utf8");
              const repeated = execute(output, {}, procPreload, "probe-minimize");
              expect(repeated.status).toBe(2);
              expect(repeated.stderr).toContain("EEXIST");
              expect(fs.readFileSync(join(output, "namespace-minimize.json"), "utf8")).toBe(before);
              continue;
            }
            const minimized = evidence.minimization;
            expect(minimized.attempts.length).toBeLessThanOrEqual(22);
            for (const attempt of minimized.attempts) {
              expect(attempt.argv.slice(-2)).toEqual(["--", "/usr/bin/true"]);
              expect(attempt.repetitions).toHaveLength(3);
              expect(
                attempt.repetitions.every(
                  (entry: { argv: string[] }) =>
                    JSON.stringify(entry.argv) === JSON.stringify(attempt.argv),
                ),
              ).toBe(true);
            }
            if (variant === "inconsistent") {
              expect(evidence.outcome).toBe("unavailable");
              expect(minimized.error).toContain("削減候補の3反復が一致しません");
              expect(minimized.attempts).toHaveLength(1);
              continue;
            }
            expect(minimized.remainingArgv).toEqual(["--map-current-user", "--", "/usr/bin/true"]);
            const last = minimized.attempts.at(-1);
            expect(last.removed).toBeUndefined();
            expect(last.argv).toEqual(minimized.remainingArgv);
            expect(last.outcome).toBe("uid-map-eperm");
            for (const repetition of last.repetitions) {
              expect(repetition.status).toBe(1);
              expect(repetition.stderr).toBe(
                "unshare: write failed /proc/self/uid_map: Operation not permitted\n",
              );
            }
            if (variant === "other-failure") {
              expect(evidence.outcome).toBe("unavailable");
              expect(minimized.error).toContain(
                "残るオプションの削除で別の失敗になり、最小性を確認できません",
              );
              expect(minimized.attempts.at(-2).outcome).toBe("other-failure");
              expect(minimized.attempts.at(-2).repetitions[0].stderr).toBe(
                "unshare: different failure\n",
              );
            } else {
              expect(evidence.outcome).toBe("uid-map-eperm");
              const userCuts = minimized.attempts.filter(
                (entry: { removed: string }) => entry.removed === "--user",
              );
              expect(userCuts[0].outcome).toBe("passed");
              expect(userCuts[1].outcome).toBe("uid-map-eperm");
              expect(minimized.attempts.at(-2).outcome).toBe("passed");
              expect(result.stdout).toContain("[DEBUG-ns-min]");
            }
          }
          for (const [variant, expectedExit, expectedOutcome] of [
            ["minimal", 1, "minimal-argv-reproduced"],
            ["passes", 0, "not-reproduced"],
            ["other-failure", 2, "unavailable"],
            ["inconsistent", 2, "unavailable"],
            ["setup-present", 2, "unavailable"],
            ["nix-present", 2, "unavailable"],
            ["image-invalid", 2, "unavailable"],
            ["source-invalid", 2, "unavailable"],
            ["long-error", 2, "unavailable"],
          ] as const) {
            const output = join(directory, "isolate-" + variant);
            const sudoBefore = fs.readFileSync(sudoArgsFile, "utf8");
            const extraEnv = {
              NIX_REMOTE: variant === "setup-present" ? "daemon" : undefined,
              PROCESS_PROOF_NIX_BASH: undefined,
              PROCESS_PROOF_NIX_STDENV: undefined,
              PROCESS_PROOF_GROUP_FILE: undefined,
              PROCESS_PROOF_GROUP_GID: undefined,
              PROBE_ISOLATE: "1",
              PROBE_GROUP_VALID: "1",
              PROBE_MINIMIZE: variant === "passes" ? undefined : variant,
              PROBE_SUCCESS: variant === "passes" ? "1" : undefined,
              PROBE_COUNTER_FILE: join(directory, "isolate-counter"),
              PROBE_ISOLATE_NIX_PRESENT: variant === "nix-present" ? "1" : undefined,
              ImageOS: variant === "image-invalid" ? "ubuntu22" : env.ImageOS,
              PROOF_SOURCE_SHA:
                variant === "source-invalid" ? "0".repeat(40) : env.PROOF_SOURCE_SHA,
              PROBE_FAILURE_MESSAGE: variant === "long-error" ? "x".repeat(2048) : undefined,
            };
            const result = execute(output, extraEnv, procPreload, "probe-isolate");
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(expectedExit);
            expect(result.stderr).toBe("");
            const evidence = JSON.parse(
              fs.readFileSync(join(output, "namespace-isolate.json"), "utf8"),
            );
            expect(evidence.schema).toBe("linux-namespace-probe-isolate/v1");
            expect(evidence.outcome).toBe(expectedOutcome);
            expect(fs.readFileSync(sudoArgsFile, "utf8")).toBe(sudoBefore);
            expect(fs.existsSync(join(output, "job.json"))).toBe(false);
            const logs = result.stdout
              .trim()
              .split("\n")
              .map((line) => {
                expect(line.startsWith("[DEBUG-ns-isolate] ")).toBe(true);
                return JSON.parse(line.slice("[DEBUG-ns-isolate] ".length));
              });
            if (
              ["setup-present", "nix-present", "image-invalid", "source-invalid"].includes(variant)
            ) {
              expect(evidence.error).toContain(
                variant === "image-invalid"
                  ? "独立probeはUbuntu 24.04・指定architecture・Bun 1.4.4・非rootで実行してください"
                  : variant === "source-invalid"
                    ? "checkout の SHA が一致しません"
                    : "独立probeでは専用のNix・group準備を省略してください",
              );
              expect(
                evidence.cases.every((entry: { probes: unknown[] }) => entry.probes.length === 0),
              ).toBe(true);
              expect(logs).toHaveLength(1);
              continue;
            }
            expect(logs[0].unshare.path).toBe(join(bin, "unshare"));
            expect(logs[0].unshare.hash).toMatch(/^[a-f0-9]{64}$/);
            expect(logs[0].sourceSha).toBe(head.stdout.trim());
            expect(logs[0].setupAbsent).toBe(true);
            expect(logs).toHaveLength(11);
            for (const [index, argv] of [
              probe.argv,
              ["--map-current-user", "--", "/usr/bin/true"],
              ["--", "/usr/bin/true"],
            ].entries()) {
              const scenario = evidence.cases[index];
              expect(scenario.argv).toEqual(argv);
              expect(scenario.probes).toHaveLength(3);
              const observations = logs.filter((entry) => entry.case === scenario.name);
              expect(observations).toHaveLength(3);
              for (const [repetition, observation] of observations.entries()) {
                expect(observation.argv).toEqual(argv);
                expect(observation.pid).toBe(scenario.probes[repetition].pid);
                expect(observation.status).toBe(scenario.probes[repetition].status);
                expect(observation.stderr).toBe(scenario.probes[repetition].stderr.slice(0, 1024));
                expect(observation.logTruncated).toBe(
                  variant === "long-error" && scenario.name !== "control",
                );
                expect(observation.elapsedMs).toBeGreaterThanOrEqual(0);
              }
            }
            if (variant === "minimal") {
              for (const scenario of evidence.cases.slice(0, 2))
                for (const probe of scenario.probes) {
                  expect(probe.status).toBe(1);
                  expect(probe.stderr).toBe(
                    "unshare: write failed /proc/self/uid_map: Operation not permitted\n",
                  );
                }
              expect(
                evidence.cases[2].probes.every(
                  (probe: { status: number; stderr: string }) =>
                    probe.status === 0 && probe.stderr === "",
                ),
              ).toBe(true);
              const before = fs.readFileSync(join(output, "namespace-isolate.json"), "utf8");
              const repeated = execute(output, extraEnv, procPreload, "probe-isolate");
              expect(repeated.status).toBe(2);
              expect(repeated.stderr).toContain("EEXIST");
              expect(fs.readFileSync(join(output, "namespace-isolate.json"), "utf8")).toBe(before);
            }
            if (
              variant === "other-failure" ||
              variant === "inconsistent" ||
              variant === "long-error"
            )
              expect(evidence.error).toContain("元argv・最小候補・成功対照の条件を満たしません");
          }
        }
      } finally {
        cleanup();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    90_000,
  );
}
