import { readFileSync, statSync, writeFileSync } from "node:fs";
import { rawArguments } from "./raw-exec-frame.ts";

try {
  const [user, network, ip] = rawArguments();
  if (
    !user ||
    !network ||
    !ip ||
    String(statSync("/proc/self/ns/user").ino) === user ||
    String(statSync("/proc/self/ns/net").ino) === network ||
    readFileSync("/proc/self/setgroups", "utf8").trim() !== "deny"
  )
    throw new Error("private network namespace was not created");
  writeFileSync("/proc/sys/net/ipv4/ip_unprivileged_port_start", "0");
  const result = Bun.spawnSync([ip, "link", "set", "lo", "up"], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if (!result.success) throw new Error("loopback setup failed");
} catch (error) {
  console.error((error as Error).message);
  console.error("codex-worktree: private network setup failed; Codex was not started");
  process.exitCode = 1;
}
