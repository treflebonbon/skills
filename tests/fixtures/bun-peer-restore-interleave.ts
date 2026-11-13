import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { resolve } from "node:path";

const [root, fingerprint, checkpoint, marker] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const children: ReturnType<typeof spawn>[] = [];
function restore(peer: string, fault: string) {
  const child = spawn(
    resolve(root, "lib/bun/run"),
    [
      "run",
      "--preload",
      resolve(root, "tests/fixtures/bun-peer-evidence-fault.ts"),
      resolve(root, `skills/${peer}/scripts/run-evidence.ts`),
      "restore",
      fingerprint,
      checkpoint,
    ],
    {
      env: { ...process.env, PEER_FAULT: JSON.stringify([fault, marker]) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  let stdout = "",
    stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const done = new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    },
  );
  return { child, done };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("restore の同期が期限切れです");
    await Bun.sleep(10);
  }
}
try {
  const a = restore("herdr-peer-refactor", "restore-a");
  await until(() => fs.existsSync(marker + ".a-ready") || a.child.exitCode !== null);
  if (!fs.existsSync(marker + ".a-ready")) throw new Error("A が書込み境界へ到達しませんでした");
  const b = restore("orca-peer-refactor", "restore-b");
  await until(() => fs.existsSync(marker + ".b-partial") || b.child.exitCode !== null);
  fs.writeFileSync(marker + ".a-release", "continue");
  const first = await a.done;
  fs.writeFileSync(marker + ".b-release", "continue");
  const second = await b.done;
  console.log(JSON.stringify({ first, second, interleaved: fs.existsSync(marker + ".b-partial") }));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
}
