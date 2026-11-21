import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Linux の個別 PID は subprocess の起動時間を生存判定へ混ぜずに観測する。 */
export function stateOf(pid: number): boolean {
  if (process.platform === "linux" && pid > 0) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return false;
      throw new Error("process の状態を観測できません: " + JSON.stringify({ pid, code }));
    }
    // comm には空白・括弧が入るため、その最後の閉じ括弧より後の state を読む。
    const state = /^\s+([RSDZTtXxKWPI])\s/.exec(stat.slice(stat.lastIndexOf(")") + 1));
    if (!stat.startsWith(`${pid} (`) || !state)
      throw new Error("process の状態を解釈できません: " + pid);
    return !["Z", "X", "x"].includes(state[1]!);
  }
  const args = pid > 0 ? ["-o", "stat=", "-p", String(pid)] : ["-A", "-o", "pgid=,stat="];
  const state = spawnSync("ps", args, { encoding: "utf8", timeout: 500 });
  if (state.error || (state.status !== 0 && (pid < 0 || state.status !== 1)))
    throw new Error(
      "process の状態を観測できません: " +
        JSON.stringify({
          pid,
          status: state.status,
          signal: state.signal,
          code: (state.error as NodeJS.ErrnoException | undefined)?.code,
        }),
    );
  if (pid > 0) return state.status === 0 && !state.stdout.trim().startsWith("Z");
  return state.stdout
    .trim()
    .split("\n")
    .some((line) => {
      const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
      if (!match) throw new Error("process group の状態を解釈できません");
      return Number(match[1]) === -pid && !match[2]!.startsWith("Z");
    });
}
