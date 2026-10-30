import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";

export const withBrowserLock = async (filename, nonblocking, update) => {
  const handle = await fs.open(filename, "a", 0o600);
  try {
    // flock and this process share one open file description. The parent's FD
    // keeps the lock through update even after the acquisition child exits.
    const child = spawn(
      process.env.MANAGED_CHROME_FLOCK || "flock",
      [
        "--exclusive",
        ...(nonblocking ? ["--nonblock"] : ["--wait", "30"]),
        "3",
      ],
      { stdio: ["ignore", "ignore", "pipe", handle.fd] }
    );
    let detail = "";
    child.stderr.on("data", (chunk) => {
      detail += chunk;
    });
    const [code] = await once(child, "close");
    if (code !== 0) {
      throw new Error(`Browser lock unavailable at ${filename}: ${detail}`);
    }
    return await update();
  } finally {
    await handle.close();
  }
};
