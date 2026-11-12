const [requestedMode, executable, ...arguments_] = process.argv.slice(2);
if (!executable) throw new Error("実証用 executable が必要です");
if (requestedMode === "prep-hang") {
  console.error(`prep-ready:${process.pid}`);
  setInterval(() => {}, 1_000);
} else {
  const mode = requestedMode?.startsWith("search") ? "search" : "reviewer";
  const targetEnvironment = { ...process.env };
  if (targetEnvironment.EXEC_PROOF_TARGET_PATH !== undefined)
    targetEnvironment.PATH = targetEnvironment.EXEC_PROOF_TARGET_PATH;
  delete targetEnvironment.EXEC_PROOF_TARGET_PATH;
  if (requestedMode === "search-no-path") delete targetEnvironment.PATH;
  const environment = Object.entries(targetEnvironment)
    .filter(([key]) => mode !== "reviewer" || !key.startsWith("GIT_"))
    .map(([key, value]) => `${key}=${value}`);
  const argv = [mode === "reviewer" ? "codex" : executable, ...arguments_];
  const fields = [
    "exec-proof-v1",
    mode,
    executable,
    String(argv.length),
    ...argv,
    String(environment.length),
    ...environment,
  ];
  if (requestedMode === "prep-fail") process.exit(17);
  if (requestedMode === "prep-partial") {
    process.stdout.write("exec-proof-v1\0reviewer");
  } else {
    if (requestedMode === "prep-trailing") fields.push("unexpected");
    process.stdout.write(`${fields.join("\0")}\0`);
  }
  if (requestedMode === "prep-complete-fail") process.exit(17);
}
