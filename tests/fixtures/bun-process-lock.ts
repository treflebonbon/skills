const [mode, executable, ...arguments_] = process.argv.slice(2);
if (!executable) throw new Error("観測用 executable が必要です");
if (mode === "execve") {
  process.execve!(executable, [executable, ...arguments_], process.env);
} else if (mode === "execve-caught") {
  try {
    process.execve!(executable, [executable, ...arguments_], process.env);
  } catch (error) {
    console.error(`exec-error:${(error as NodeJS.ErrnoException).code}`);
    process.exit(1);
  }
} else if (mode === "spawn") {
  const child = Bun.spawnSync([executable, ...arguments_], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(child.exitCode);
} else {
  throw new Error(`未知の実証 mode: ${mode}`);
}
