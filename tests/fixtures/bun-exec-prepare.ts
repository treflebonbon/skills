const [requestedMode, executable, ...arguments_] = process.argv.slice(2);
if (!executable) throw new Error("実証用 executable が必要です");
if (requestedMode === "prep-hang" || requestedMode === "prep-before-ready") {
  console.error(`${requestedMode === "prep-hang" ? "prep-ready" : "prep-started"}:${process.pid}`);
  setInterval(() => {}, 1_000);
} else {
  const mode = requestedMode?.startsWith("search") ? "search" : "reviewer";
  const removed = [
    "EXEC_PROOF_TARGET_PATH",
    ...(mode === "reviewer"
      ? Object.keys(process.env).filter((key) => key.startsWith("GIT_"))
      : []),
    ...(requestedMode === "search-no-path" ? ["PATH"] : []),
  ];
  const changed =
    process.env.EXEC_PROOF_TARGET_PATH !== undefined && requestedMode !== "search-no-path"
      ? [`PATH=${process.env.EXEC_PROOF_TARGET_PATH}`]
      : [];
  const argv = [mode === "reviewer" ? "codex" : executable, ...arguments_];
  const fields = [
    "exec-proof-v1",
    mode,
    executable,
    String(argv.length),
    ...argv,
    String(removed.length),
    ...removed,
    String(changed.length),
    ...changed,
  ];
  if (requestedMode === "prep-fail") process.exit(17);
  if (requestedMode === "prep-partial") {
    process.stdout.write("exec-proof-v1\0reviewer");
  } else {
    if (requestedMode === "prep-trailing") fields.push("unexpected");
    process.stdout.write(`${fields.join("\0")}\0`);
  }
  if (requestedMode === "prep-complete-fail") process.exitCode = 17;
}
