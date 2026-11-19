import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { probeAudit, proofIdentity } from "./run-linux-process-proof.ts";

const self = fileURLToPath(import.meta.url);
const control = resolve(self, "../..");
const controllerPaths: Record<string, string> = {
  parent: "development/probe-linux-namespace-parent.py",
  python: "development/probe-linux-namespace-launch.py",
  perl: "development/probe-linux-namespace-parent.pl",
  driver: "development/probe-linux-namespace-parent.sh",
  bash: "development/probe-linux-namespace-bash.sh",
  observer: "development/probe-linux-namespace-bash.py",
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
class AuditInputError extends Error {}

/** source commit・両checkoutの同じファイルを照合してからhashを返す。 */
function committedHash(root: string, sha: string, path: string) {
  const committed = spawnSync("git", ["show", sha + ":" + path], {
    cwd: root,
    timeout: 5000,
    maxBuffer: 256 * 1024,
  });
  if (committed.error || committed.status !== 0 || !Buffer.isBuffer(committed.stdout))
    throw new AuditInputError("測定器のhashを取得できません");
  const expected = digest(committed.stdout);
  if (
    expected !== digest(fs.readFileSync(join(root, path))) ||
    expected !== digest(fs.readFileSync(join(control, path)))
  )
    throw new AuditInputError("測定器のhashが一致しません");
  return expected;
}

/** 検査済みBash測定から、3つの最小argv probeだけを読取対象にする。 */
function bashAuditTargets(
  data: any,
  execution: ReturnType<typeof proofIdentity>,
  root: string,
  now: number,
) {
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    data.schema !== "linux-namespace-bash-comparison/v1" ||
    execution.sourceSha !== execution.workflowSha ||
    !Object.entries(execution).every(([key, value]) => data.identity?.[key] === value)
  )
    throw new AuditInputError("測定記録の出所が一致しません");
  for (const [key, path] of Object.entries(controllerPaths)) {
    if (data.controllerHashes?.[key] !== committedHash(root, execution.sourceSha, path))
      throw new AuditInputError("測定器のhashが一致しません");
  }
  if (["not-reproduced", "perl-layer-dependent", "unavailable"].includes(data.outcome)) return [];
  if (data.outcome !== "perl-layer-not-required")
    throw new AuditInputError("Bash比較の結果が不正です");
  const bash = data.measurements?.bash;
  if (
    !bash ||
    bash.before?.uid !== process.getuid!() ||
    bash.before?.euid !== process.geteuid!() ||
    !isDeepStrictEqual(bash.before, bash.after) ||
    bash.forkCount !== 6 ||
    bash.probeEnvironment !== "empty" ||
    bash.cwd !== "/" ||
    bash.stdinType !== "closed" ||
    bash.stdoutType !== "pipe" ||
    bash.stderrType !== "pipe" ||
    !Number.isSafeInteger(bash.runtime?.pid) ||
    bash.runtime.pid <= 1 ||
    !Array.isArray(bash.ancestry) ||
    bash.ancestry[0]?.pid !== bash.runtime.pid ||
    !isDeepStrictEqual(
      bash.cases?.map((item: any) => item.name),
      ["minimal", "control"],
    ) ||
    data.unshare?.path !== "/usr/bin/unshare" ||
    data.unshare.hash !== digest(fs.readFileSync("/usr/bin/unshare"))
  )
    throw new AuditInputError("Bash測定の条件が一致しません");
  const seen = new Set(bash.ancestry.map((entry: any) => entry.pid));
  const selected: Array<{ pid: number; startedAt: string; endedAt: string }> = [];
  for (const item of bash.cases) {
    const minimal = item.name === "minimal";
    const argv = minimal ? ["--map-current-user", "--", "/usr/bin/true"] : ["--", "/usr/bin/true"];
    if (
      !isDeepStrictEqual(item.argv, argv) ||
      !Array.isArray(item.probes) ||
      item.probes.length !== 3
    )
      throw new AuditInputError("Bash測定のargv・回数が一致しません");
    for (const [index, probe] of item.probes.entries()) {
      if (
        !Number.isSafeInteger(probe.pid) ||
        probe.pid <= 1 ||
        seen.has(probe.pid) ||
        probe.ownerPid !== bash.runtime.pid ||
        probe.childBefore?.pid !== probe.pid ||
        probe.childBefore.ppid !== bash.runtime.pid ||
        probe.childBefore.path !== bash.runtime.path ||
        probe.childBefore.processGroup !== bash.ancestry[0].processGroup ||
        probe.childBefore.session !== bash.ancestry[0].session ||
        !Number.isSafeInteger(probe.childBefore.startTimeTicks) ||
        probe.childBefore.startTimeTicks < 0 ||
        !Number.isSafeInteger(probe.observerPid) ||
        probe.observerPid <= 1 ||
        probe.observerPid === probe.pid ||
        bash.ancestry.some((entry: any) => entry.pid === probe.observerPid)
      )
        throw new AuditInputError("Bash測定のPID対応が不正です");
      seen.add(probe.pid);
      const expectedStatus = minimal ? 1 : 0;
      if (
        probe.repetition !== index + 1 ||
        !isDeepStrictEqual(probe.argv, argv) ||
        probe.status !== expectedStatus ||
        probe.waitStatus !== expectedStatus ||
        probe.observerStatus !== 0 ||
        probe.signal !== null ||
        probe.error !== undefined ||
        probe.stdout !== "" ||
        probe.stderr !==
          (minimal ? "unshare: write failed /proc/self/uid_map: Operation not permitted\n" : "") ||
        probe.executableHash !== data.unshare.hash ||
        probe.executableHashAfter !== data.unshare.hash
      )
        throw new AuditInputError("Bash測定の終了結果が一致しません");
      const start = Date.parse(probe.startedAt),
        end = Date.parse(probe.endedAt);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end < start ||
        end - start > 5000 ||
        start < now - 120000 ||
        end > now ||
        !Number.isFinite(probe.elapsedMs) ||
        probe.elapsedMs < 0 ||
        probe.elapsedMs >= 5000
      )
        throw new AuditInputError("Bash測定の時刻が範囲外です");
      if (minimal)
        selected.push({ pid: probe.pid, startedAt: probe.startedAt, endedAt: probe.endedAt });
    }
  }
  return selected;
}

/** 比較終了後にだけ、呼出しユーザーの権限でPID・時刻を限定したkernel journalを読む。 */
function collectBashAudit(root: string, output: string) {
  const directory = fs.lstatSync(output);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid!() ||
    (directory.mode & 0o077) !== 0
  )
    throw new AuditInputError("所有する非公開OUTPUT directoryが必要です");
  const descriptor = fs.openSync(join(output, "namespace-bash-audit.json"), "wx", 0o600);
  const record: {
    schema: string;
    status: string;
    readerPrivilege: string;
    caller?: {
      uid: number;
      euid: number;
      gid: number;
      egid: number;
      groups: number[];
      pidNamespace: string;
    };
    collectorHash: string;
    readerImplementationHash: string;
    identity?: ReturnType<typeof proofIdentity>;
    reason?: string;
    error?: string;
    plannedQueries: number;
    probes: Array<{
      pid: number;
      startedAt: string;
      endedAt: string;
      audit: ReturnType<typeof probeAudit>;
    }>;
  } = {
    schema: "linux-namespace-bash-audit/v1",
    status: "unavailable",
    readerPrivilege: "caller",
    collectorHash: "",
    readerImplementationHash: "",
    plannedQueries: 0,
    probes: [],
  };
  try {
    if (
      process.platform !== "linux" ||
      Bun.version !== "1.4.4" ||
      process.getuid!() === 0 ||
      process.geteuid!() === 0
    )
      throw new AuditInputError("Linux・Bun 1.4.4・非root条件が必要です");
    record.caller = {
      uid: process.getuid!(),
      euid: process.geteuid!(),
      gid: process.getgid!(),
      egid: process.getegid!(),
      groups: process.getgroups!(),
      pidNamespace: fs.readlinkSync("/proc/self/ns/pid"),
    };
    record.identity = proofIdentity(root);
    record.collectorHash = committedHash(
      root,
      record.identity.sourceSha,
      "development/probe-linux-namespace-bash-audit.ts",
    );
    record.readerImplementationHash = committedHash(
      root,
      record.identity.sourceSha,
      "development/run-linux-process-proof.ts",
    );
    const input = fs.openSync(
      join(output, "namespace-bash.json"),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    let data;
    try {
      const inputLimit = 256 * 1024;
      const stat = fs.fstatSync(input);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid!() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > inputLimit
      )
        throw new AuditInputError("非公開の測定記録が必要です（上限256KiB）");
      const bytes = Buffer.alloc(inputLimit + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(input, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > inputLimit) throw new AuditInputError("測定記録の上限256KiBを超えました");
      data = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    } finally {
      fs.closeSync(input);
    }
    const selected = bashAuditTargets(data, record.identity, root, Date.now());
    record.plannedQueries = selected.length;
    if (!selected.length) {
      record.status = "not-requested";
      record.reason = "Bash側の正確なEPERM再現がありません";
    } else {
      record.status = "collected";
      for (const target of selected) {
        const audit = probeAudit(target, undefined, root);
        record.probes.push({ ...target, audit });
        if (!["matched", "no-matching-events", "empty"].includes(audit.status)) {
          record.status = "unavailable";
          record.reason = "監査記録が不完全なため後続の検索を省略しました";
          break;
        }
      }
    }
  } catch (error) {
    record.status = "unavailable";
    record.error =
      error instanceof AuditInputError
        ? error.message
        : "監査記録を完了できません: " +
          (typeof (error as NodeJS.ErrnoException)?.code === "string" &&
          /^[A-Z][A-Z0-9_]{0,31}$/.test((error as NodeJS.ErrnoException).code!)
            ? (error as NodeJS.ErrnoException).code
            : error instanceof Error
              ? error.name
              : "Unknown");
  } finally {
    try {
      fs.writeFileSync(descriptor, JSON.stringify(record, null, 2) + "\n");
    } finally {
      fs.closeSync(descriptor);
    }
    const emit = (value: unknown) => console.log("[DEBUG-ns-bash-audit] " + JSON.stringify(value));
    const { probes, ...summary } = record;
    emit({ recordType: "summary", ...summary });
    for (const probe of probes) {
      const { events, ...audit } = probe.audit;
      emit({ recordType: "probe", ...probe, audit });
      for (const event of events) emit({ recordType: "event", pid: probe.pid, ...event });
    }
  }
  return record.status === "unavailable" ? 2 : 0;
}

if (import.meta.main) {
  try {
    const [source, output, ...extra] = process.argv.slice(2);
    if (!source || !output || extra.length) throw new AuditInputError("SOURCE OUTPUTが必要です");
    process.exitCode = collectBashAudit(resolve(source), resolve(output));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(
      "Bash監査: " +
        (code ??
          (error instanceof AuditInputError
            ? error.message
            : error instanceof Error
              ? error.name
              : "Unknown")),
    );
    process.exitCode = 2;
  }
}
