type ObjectValue = Record<string, unknown>;
export type Verdict = { verified: boolean; reasons: string[] };

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const sha = (value: unknown, length = 40) =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const identifier = (value: unknown) => typeof value === "string" && /^[1-9][0-9]*$/.test(value);

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

export function verifyCohort(input: unknown, manifest: unknown): Verdict {
  const reasons: string[] = [];
  if (
    !object(manifest) ||
    manifest.schema !== "linux-process-proof-cases/v1" ||
    !Array.isArray(manifest.cases)
  )
    return { verified: false, reasons: ["期待 case manifest が不正です"] };
  if (
    manifest.cases.length === 0 ||
    !manifest.cases.every((name) => typeof name === "string" && name.length > 0) ||
    new Set(manifest.cases).size !== manifest.cases.length
  )
    return { verified: false, reasons: ["期待 case manifest が不正です"] };
  const expected = [...manifest.cases].sort();
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
    if (jobs.length !== 1 || !object(job)) reasons.push(`${arch}: job が1件必要です`);
    else if (job.runId !== input.runId || job.attempt !== input.attempt)
      reasons.push(`${arch}: run/attempt が一組と一致しません`);
    if (object(job) && (job.sourceSha !== input.sourceSha || job.workflowSha !== input.workflowSha))
      reasons.push(`${arch}: source/workflow SHA が一致しません`);
    if (!object(job) || !Array.isArray(job.trials)) {
      reasons.push(`${arch}: 反復1・2・3が必要です`);
      continue;
    }
    const repetitions = job.trials.map((trial) => (object(trial) ? trial.repetition : null)).sort();
    if (JSON.stringify(repetitions) !== "[1,2,3]") reasons.push(`${arch}: 反復1・2・3が必要です`);
    for (const trial of job.trials) {
      if (!object(trial)) {
        reasons.push(`${arch}: 反復の記録が不正です`);
        continue;
      }
      const cases = Array.isArray(trial.cases) ? trial.cases : [];
      const names = cases.map((item) => (object(item) ? item.name : null)).sort();
      if (
        JSON.stringify(names) !== JSON.stringify(expected) ||
        !cases.every((item) => object(item) && item.status === "pass")
      )
        reasons.push(`${arch}/${trial.repetition}: 期待 case の全件成功を確認できません`);
      const counts = trial.counts;
      if (
        trial.exitCode !== 0 ||
        !object(counts) ||
        counts.pass !== expected.length ||
        counts.fail !== 0 ||
        counts.skip !== 0 ||
        counts.todo !== 0
      )
        reasons.push(`${arch}/${trial.repetition}: 終了状態・試験集計が成功条件を満たしません`);
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
        observation.arch !== arch ||
        observation.realCallerRequested !== true ||
        !["baseline", "namespace"].every((binary) =>
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
        reasons.push(`${arch}/${trial.repetition}: 実 caller の実行を確認できません`);
    }
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
      Date.parse(artifact.expiresAt) - Date.parse(artifact.createdAt) < 90 * 86400_000 - 60_000
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
