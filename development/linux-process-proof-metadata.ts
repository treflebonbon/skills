type Json = Record<string, unknown>;
type ReadApi = (path: string) => Promise<Json>;
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("履歴の開始日時を確認できません");
  return Date.parse(value);
}
type Resolution = {
  runId: string;
  attempt: number;
  sourceSha: string;
  classification: string;
  reason: string;
  evidence: string;
};

// public repository の read API だけを使う。失敗・打切りは呼出し側で証跡不足にする。
export async function collectMetadata(
  read: ReadApi,
  current: {
    runId: string;
    attempt: number;
    sourceSha: string;
    workflowSha: string;
  },
  resolutions: Resolution[],
) {
  const run = await read(`/actions/runs/${current.runId}`);
  if (
    run.head_sha !== current.workflowSha ||
    Number(run.run_attempt) !== current.attempt ||
    run.event !== "workflow_dispatch" ||
    run.display_title !== `Linux process proof: ${current.sourceSha}`
  )
    throw new Error("実行 metadata が source/workflow/run/attempt と一致しません");
  const cutoff = timestamp(run.run_started_at);
  const artifactResponse = await read(`/actions/runs/${current.runId}/artifacts?per_page=100`);
  if (
    !Array.isArray(artifactResponse.artifacts) ||
    artifactResponse.total_count !== artifactResponse.artifacts.length
  )
    throw new Error("artifact 一覧を完全に取得できません");
  const artifacts = ["x64", "arm64"].flatMap((arch) =>
    (artifactResponse.artifacts as Json[])
      .filter((value) => value.name === `linux-proof-${current.runId}-${current.attempt}-${arch}`)
      .map((value: Json) => ({
        arch,
        runId: current.runId,
        attempt: current.attempt,
        id: String(value.id),
        digest: String(value.digest).replace(/^sha256:/, ""),
        createdAt: value.created_at,
        expiresAt: value.expires_at,
        expired: value.expired,
        url: `https://github.com/treflebonbon/skills/actions/runs/${current.runId}/artifacts/${value.id}`,
      })),
  );
  const history: Json[] = [];
  const seenIds = new Set<string>();
  let seen = 0,
    total = Infinity;
  for (let page = 1; seen < total; page++) {
    const response = await read(
      `/actions/workflows/${run.workflow_id}/runs?event=workflow_dispatch&created=${encodeURIComponent(`<=${run.run_started_at}`)}&per_page=100&page=${page}`,
    );
    if (
      !Array.isArray(response.workflow_runs) ||
      !Number.isSafeInteger(response.total_count) ||
      Number(response.total_count) >= 1000 ||
      (page > 1 && response.total_count !== total)
    )
      throw new Error("workflow 履歴を完全に取得できません");
    total = Number(response.total_count);
    if (response.workflow_runs.length === 0 && seen < total)
      throw new Error("workflow 履歴が途中で欠けています");
    seen += response.workflow_runs.length;
    for (const previous of response.workflow_runs as Json[]) {
      if (seenIds.has(String(previous.id)))
        throw new Error("workflow 履歴に重複があるため完全性を確認できません");
      seenIds.add(String(previous.id));
      if (previous.display_title !== `Linux process proof: ${current.sourceSha}`) continue;
      if (String(previous.id) !== current.runId && timestamp(previous.created_at) > cutoff)
        continue;
      const attempts = Number(previous.run_attempt);
      if (!Number.isSafeInteger(attempts) || attempts < 1)
        throw new Error("履歴の attempt が不正です");
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (String(previous.id) === current.runId && attempt === current.attempt) continue;
        const detail = await read(`/actions/runs/${previous.id}/attempts/${attempt}`);
        if (
          Number(detail.run_attempt) !== attempt ||
          String(detail.id) !== String(previous.id) ||
          detail.display_title !== previous.display_title
        )
          throw new Error("attempt 履歴が一致しません");
        const started = timestamp(detail.run_started_at);
        if (
          started > cutoff ||
          (started === cutoff &&
            String(previous.id) !== current.runId &&
            BigInt(String(previous.id)) >= BigInt(current.runId))
        )
          continue;
        history.push({
          sourceSha: current.sourceSha,
          runId: String(previous.id),
          attempt,
          conclusion: detail.status === "completed" ? detail.conclusion : "incomplete",
          url: detail.html_url,
          resolution: resolutions.find(
            (resolution) =>
              resolution.runId === String(previous.id) &&
              resolution.attempt === attempt &&
              resolution.sourceSha === current.sourceSha,
          ),
        });
      }
    }
  }
  if (seen !== total || !seenIds.has(current.runId))
    throw new Error("workflow 履歴の件数・現在の run が一致しません");
  return { artifacts, history, historyComplete: true, historyCutoff: run.run_started_at };
}
