import { spawnSync } from "node:child_process";

type ObjectValue = Record<string, unknown>;
export type Verdict = { verified: boolean; reasons: string[] };

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const sha = (value: unknown, length = 40) =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const identifier = (value: unknown) => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const validId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < 0xffffffff;

export function validGroupCredentials(value: unknown): boolean {
  if (
    !object(value) ||
    !validId(value.uid) ||
    value.uid === 0 ||
    value.euid !== value.uid ||
    !validId(value.gid) ||
    !Array.isArray(value.groups) ||
    !value.groups.every(validId) ||
    !object(value.group)
  )
    return false;
  const fixture = value.group;
  return (
    validId(fixture.ownerUid) &&
    fixture.ownerUid !== value.uid &&
    validId(fixture.gid) &&
    fixture.gid > 0 &&
    fixture.gid !== value.gid &&
    !value.groups.includes(fixture.gid) &&
    fixture.mode === 0o060 &&
    typeof fixture.path === "string" &&
    fixture.path.startsWith("/") &&
    typeof fixture.dev === "string" &&
    /^(0|[1-9][0-9]*)$/.test(fixture.dev) &&
    identifier(fixture.ino)
  );
}

export function groupsInNamespace(
  groups: readonly number[],
  gidMap: readonly (readonly [number, number, number])[],
  overflowGid: number,
): number[] {
  if (
    !validId(overflowGid) ||
    !groups.every(validId) ||
    gidMap.length === 0 ||
    !gidMap.every(
      (row) =>
        row.length === 3 &&
        validId(row[0]) &&
        validId(row[1]) &&
        Number.isSafeInteger(row[2]) &&
        row[2] > 0 &&
        row[0] + row[2] <= 0xffffffff &&
        row[1] + row[2] <= 0xffffffff,
    )
  )
    throw new Error("補助 group の GID mapping が不正です");
  return groups.map((gid) => {
    const row = gidMap.find(([, outside, length]) => gid >= outside && gid < outside + length);
    return row ? row[0] + gid - row[1] : overflowGid;
  });
}

export function parseTrial(log: string, exitCode: number | null, repetition: number) {
  const lines = log.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const observations = lines.filter((line) => line.startsWith('{"boundary":"process-namespace",'));
  if (observations.length !== 1) throw new Error("観測 JSON が1件必要です");
  const counts: Record<string, number> = {};
  for (const status of ["pass", "fail", "skip", "todo"]) {
    const matches = lines
      .map((line) => new RegExp(`^\\s+(\\d+) ${status}$`).exec(line))
      .filter(Boolean);
    if (matches.length > 1 || (matches.length === 0 && ["pass", "fail"].includes(status)))
      throw new Error("試験集計を一意に確認できません");
    counts[status] = matches.length ? Number(matches[0]![1]) : 0;
  }
  const cases = lines.flatMap((line) => {
    const match = /^\((pass|fail|skip|todo)\) (.+?)(?: \[[0-9.]+(?:ms|s)\])?$/.exec(line);
    return match ? [{ status: match[1]!, name: match[2]! }] : [];
  });
  return {
    repetition,
    exitCode,
    counts,
    cases,
    observation: JSON.parse(observations[0]!) as unknown,
  };
}

export type Containment = "namespace" | "cgroup";
export const namespaceProbe = [
  "--user",
  "--map-current-user",
  "--pid",
  "--fork",
  "--kill-child=SIGKILL",
  "--mount-proc",
  "--",
  "/usr/bin/true",
];
export const cgroupProbe = [
  "--user",
  "--scope",
  "--quiet",
  "--collect",
  "-p",
  "Delegate=yes",
  "--",
  "/usr/bin/true",
];

/** launcher と同じ順に実際に試して方式を選ぶ。sysctl などの設定値からは推定しない。 */
export function selectContainment(env: NodeJS.ProcessEnv = process.env): Containment | "refused" {
  const succeeds = (command: string, args: string[]) =>
    spawnSync(command, args, { env, stdio: "ignore", timeout: 10_000 }).status === 0;
  if (succeeds("unshare", namespaceProbe)) return "namespace";
  if (succeeds("systemd-run", cgroupProbe)) return "cgroup";
  return "refused";
}
type Manifest = {
  required: Record<Containment, string[]>;
  observed: Record<Containment, string[]>;
};
const names = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((name) => typeof name === "string" && name.length > 0) &&
  new Set(value).size === value.length;

function readManifest(manifest: unknown): Manifest | undefined {
  if (
    !object(manifest) ||
    manifest.schema !== "linux-process-proof-cases/v2" ||
    !object(manifest.cases) ||
    !object(manifest.observations)
  )
    return;
  const { common, namespace, cgroup } = manifest.cases;
  const observations = manifest.observations;
  if (
    !names(common) ||
    common.length === 0 ||
    !names(namespace) ||
    !names(cgroup) ||
    !names(observations.namespace) ||
    !names(observations.cgroup)
  )
    return;
  const all = [
    ...common,
    ...namespace,
    ...cgroup,
    ...observations.namespace,
    ...observations.cgroup,
  ];
  // 観測は方式ごとに重ならないため、同じ名前が別区分にあれば manifest を不正にする。
  if (new Set(all).size !== all.length) return;
  return {
    required: { namespace: [...common, ...namespace], cgroup: [...common, ...cgroup] },
    observed: { namespace: observations.namespace, cgroup: observations.cgroup },
  };
}

/** 1 job の反復3回を、選ばれた方式のケース一覧と照合する。 */
function verifyTrials(
  label: string,
  job: ObjectValue,
  manifest: Manifest,
  expected: Containment,
  reasons: string[],
) {
  const containment = object(job.preflight) ? job.preflight.containment : undefined;
  if (containment !== expected) {
    reasons.push(`${label}: 選ばれた方式 ${String(containment)} は ${expected} の実証に数えません`);
    return;
  }
  const required = manifest.required[expected];
  const observed = manifest.observed[expected];
  const expectedNames = JSON.stringify([...required, ...observed].sort());
  if (!Array.isArray(job.trials)) {
    reasons.push(`${label}: 反復1・2・3が必要です`);
    return;
  }
  const repetitions = job.trials.map((trial) => (object(trial) ? trial.repetition : null)).sort();
  if (JSON.stringify(repetitions) !== "[1,2,3]") reasons.push(`${label}: 反復1・2・3が必要です`);
  for (const trial of job.trials) {
    if (!object(trial)) {
      reasons.push(`${label}: 反復の記録が不正です`);
      continue;
    }
    const cases = (Array.isArray(trial.cases) ? trial.cases : []).filter(object);
    const status = new Map(cases.map((item) => [item.name, item.status]));
    if (
      cases.length !== status.size ||
      JSON.stringify([...status.keys()].sort()) !== expectedNames ||
      !required.every((name) => status.get(name) === "pass")
    )
      reasons.push(`${label}/${trial.repetition}: 期待 case の全件成功を確認できません`);
    if (
      !observed.every((name) => {
        const result = status.get(name);
        return result === "pass" || result === "fail";
      })
    )
      reasons.push(`${label}/${trial.repetition}: 観測 case に pass または fail が必要です`);
    // 観測ケースの結果は合否に数えないが、集計と終了状態はその失敗分だけを許す。
    const observedFailures = observed.filter((name) => status.get(name) === "fail").length;
    const counts = trial.counts;
    if (
      trial.exitCode !== (observedFailures ? 1 : 0) ||
      !object(counts) ||
      counts.pass !== required.length + observed.length - observedFailures ||
      counts.fail !== observedFailures ||
      counts.skip !== 0 ||
      counts.todo !== 0
    )
      reasons.push(`${label}/${trial.repetition}: 終了状態・試験集計が成功条件を満たしません`);
    const observation = trial.observation;
    const caller =
      object(observation) && Array.isArray(observation.records)
        ? observation.records.find((record) => object(record) && object(record.realCaller))
            ?.realCaller
        : undefined;
    const observations =
      object(caller) && Array.isArray(caller.observations) ? caller.observations : [];
    if (
      !object(observation) ||
      observation.boundary !== "process-namespace" ||
      observation.arch !== job.arch ||
      observation.realCallerRequested !== true ||
      !["baseline", "candidate"].every((binary) =>
        observations.some(
          (item: unknown) =>
            object(item) &&
            item.binary === binary &&
            item.status === 37 &&
            typeof item.stderr === "string" &&
            item.stderr.includes('real-caller:{"hook": "hook-ok"}'),
        ),
      )
    )
      reasons.push(`${label}/${trial.repetition}: 実 caller の実行を確認できません`);
    if (!object(observation) || observation.containment !== expected)
      reasons.push(`${label}/${trial.repetition}: 試験が使った方式が ${expected} ではありません`);
  }
}

/** 手元の WSL2 での3回連続実行を、GitHub 固有の項目（run・artifact・履歴）を要求せずに判定する。 */
export function verifyLocal(input: unknown, manifest: unknown): Verdict {
  const expected = readManifest(manifest);
  if (!expected) return { verified: false, reasons: ["期待 case manifest が不正です"] };
  if (
    !object(input) ||
    input.schema !== "linux-process-proof-local/v1" ||
    input.host !== "wsl2" ||
    !sha(input.sourceSha) ||
    !object(input.job)
  )
    return { verified: false, reasons: ["手元実行の記録が不正です"] };
  const reasons: string[] = [];
  const job = input.job;
  if (job.sourceSha !== input.sourceSha) reasons.push("wsl2: source SHA が一致しません");
  if (
    job.arch !== "x64" ||
    !object(job.preflight) ||
    job.preflight.verified !== true ||
    !validGroupCredentials(job.preflight)
  )
    reasons.push("wsl2: 資格情報・補助 group fixture の必須観測が不正です");
  verifyTrials("wsl2", job, expected, "namespace", reasons);
  return { verified: reasons.length === 0, reasons };
}

export function verifyCohort(input: unknown, manifest: unknown): Verdict {
  const reasons: string[] = [];
  const expected = readManifest(manifest);
  if (!expected) return { verified: false, reasons: ["期待 case manifest が不正です"] };
  if (
    !object(input) ||
    input.schema !== "linux-process-proof-cohort/v1" ||
    !sha(input.sourceSha) ||
    !sha(input.workflowSha) ||
    !identifier(input.runId) ||
    !Number.isSafeInteger(input.attempt) ||
    Number(input.attempt) < 1 ||
    !Array.isArray(input.jobs)
  )
    return { verified: false, reasons: ["一組の記録が不正です"] };
  if (input.jobs.length !== 2) reasons.push("architecture 別の job 記録は2件必要です");
  for (const arch of ["x64", "arm64"]) {
    const jobs = input.jobs.filter((job) => object(job) && job.arch === arch);
    const job = jobs[0];
    if (jobs.length !== 1 || !object(job)) {
      reasons.push(`${arch}: job が1件必要です`);
      continue;
    }
    if (job.runId !== input.runId || job.attempt !== input.attempt)
      reasons.push(`${arch}: run/attempt が一組と一致しません`);
    if (job.sourceSha !== input.sourceSha || job.workflowSha !== input.workflowSha)
      reasons.push(`${arch}: source/workflow SHA が一致しません`);
    if (
      !object(job.preflight) ||
      job.preflight.verified !== true ||
      !validGroupCredentials(job.preflight)
    )
      reasons.push(`${arch}: 資格情報・補助 group fixture の必須観測が不正です`);
    // runner は既定のままでは userns が使えないため、cgroup 経路の実証だけを数える。
    verifyTrials(arch, job, expected, "cgroup", reasons);
  }
  for (const arch of ["x64", "arm64"]) {
    const artifacts = Array.isArray(input.artifacts)
      ? input.artifacts.filter((artifact) => object(artifact) && artifact.arch === arch)
      : [];
    const artifact = artifacts[0];
    if (
      !object(artifact) ||
      artifacts.length !== 1 ||
      !identifier(artifact.id) ||
      artifact.expired !== false ||
      artifact.runId !== input.runId ||
      artifact.attempt !== input.attempt ||
      !sha(artifact.digest, 64) ||
      typeof artifact.createdAt !== "string" ||
      typeof artifact.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(artifact.createdAt)) ||
      !Number.isFinite(Date.parse(artifact.expiresAt)) ||
      typeof input.historyCutoff !== "string" ||
      !Number.isFinite(Date.parse(input.historyCutoff)) ||
      // Q5 の保存期間は対象 attempt の run 開始時刻（historyCutoff）から数える。
      Date.parse(artifact.expiresAt) - Date.parse(input.historyCutoff) < 90 * 86400_000 - 60_000
    )
      reasons.push(`${arch}: artifact の同一性・保存期間を確認できません`);
  }
  if (input.historyComplete !== true || !Array.isArray(input.history))
    reasons.push("同じ SHA の失敗履歴を確認できません");
  else
    for (const previous of input.history) {
      if (
        !object(previous) ||
        !sha(previous.sourceSha) ||
        !identifier(previous.runId) ||
        !Number.isSafeInteger(previous.attempt) ||
        Number(previous.attempt) < 1
      ) {
        reasons.push("失敗履歴の記録が不正です");
        continue;
      }
      if (previous.sourceSha !== input.sourceSha || previous.conclusion === "success") continue;
      const resolution = previous.resolution;
      if (
        !object(resolution) ||
        resolution.classification !== "environment" ||
        typeof resolution.reason !== "string" ||
        !resolution.reason.trim() ||
        typeof resolution.evidence !== "string" ||
        !resolution.evidence.trim()
      )
        reasons.push(`同じ SHA に未解明の失敗があります: ${previous.runId}/${previous.attempt}`);
    }
  return { verified: reasons.length === 0, reasons };
}
