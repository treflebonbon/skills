import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { basename, join, resolve } from "node:path";
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
const directPath = "development/probe-linux-namespace-uid-write.py";
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

/** 確定した再現の所有PIDと時刻だけを読取対象にする。 */
function auditTargets(
  data: any,
  execution: ReturnType<typeof proofIdentity>,
  root: string,
  now: number,
  direct: boolean,
  callerPidNamespace: string,
) {
  const comparison = direct ? "uid-write" : "bash";
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    data.schema !== `linux-namespace-${comparison}-comparison/v1` ||
    execution.sourceSha !== execution.workflowSha ||
    !Object.entries(execution).every(([key, value]) => data.identity?.[key] === value)
  )
    throw new AuditInputError("測定記録の出所が一致しません");
  for (const [key, path] of Object.entries(controllerPaths)) {
    if (data.controllerHashes?.[key] !== committedHash(root, execution.sourceSha, path))
      throw new AuditInputError("測定器のhashが一致しません");
  }
  const clear = direct ? "direct-write-not-reproduced" : "perl-layer-dependent";
  if (["not-reproduced", clear, "unavailable"].includes(data.outcome)) return [];
  const reproduced = direct ? "direct-write-reproduced" : "perl-layer-not-required";
  if (data.outcome !== reproduced)
    throw new AuditInputError(
      direct ? "直接UID-map比較の結果が不正です" : "Bash比較の結果が不正です",
    );

  const bash = direct ? data.measurements?.direct : data.measurements?.bash;
  const executable = direct ? data.runtime : data.unshare;
  const baseline = data.baseline;
  const baselineBash = baseline?.measurements?.bash;
  if (
    direct &&
    (data.controllerHashes?.direct !== committedHash(root, execution.sourceSha, directPath) ||
      data.identity.arch !== "arm64" ||
      !isDeepStrictEqual(data.stages, [43, 48, 0]) ||
      baseline?.schema !== "linux-namespace-uid-comparison/v1" ||
      baseline.outcome !== "uid-mapping-reproduced" ||
      !isDeepStrictEqual(baseline.identity, data.identity) ||
      !Object.keys(controllerPaths).every(
        (key) => baseline.controllerHashes?.[key] === data.controllerHashes[key],
      ) ||
      baseline.runtimeHashes?.python !== executable?.hash ||
      !isDeepStrictEqual(baselineBash?.runtime, bash?.runtime) ||
      !isDeepStrictEqual(baselineBash?.ancestry, bash?.ancestry) ||
      !isDeepStrictEqual(baselineBash?.before, bash?.before) ||
      !isDeepStrictEqual(baselineBash?.unshare, baseline.unshare) ||
      bash?.before?.namespaces?.pid !== callerPidNamespace ||
      executable?.name !== "python" ||
      !/^3\.12\./.test(executable.version))
  )
    throw new AuditInputError("直接UID-map再現の前提が一致しません");

  const measured = measurementTargets(bash, executable, now, direct ? "direct" : "bash");
  if (!direct) return measured.targets;

  const prior = measurementTargets(baselineBash, baseline.unshare, now, "bash-baseline");
  if (prior.probePids.some((pid) => measured.probePids.includes(pid)))
    throw new AuditInputError("Bash基準と直接UID-mapのPIDが重複しています");
  if (prior.lastEnd > Date.parse(measured.targets[0].startedAt))
    throw new AuditInputError("Bash基準と直接UID-mapの測定順序が不正です");
  return [...measured.targets, ...prior.targets];
}

type AuditTarget = {
  pid: number;
  startedAt: string;
  endedAt: string;
  role?: "map" | "control" | "bash-baseline";
};

/** 読取前に各比較のargv・終了状態・所有PIDを照合する。 */
function measurementTargets(
  bash: any,
  executable: any,
  now: number,
  mode: "bash" | "direct" | "bash-baseline",
) {
  const direct = mode === "direct";
  const baseline = mode === "bash-baseline";
  const executablePath = direct ? fs.realpathSync("/usr/bin/python3") : "/usr/bin/unshare";
  const uid = process.geteuid!();
  const cases = direct
    ? ["direct-map", "direct-control"]
    : baseline
      ? ["minimal", "uid-only", "control"]
      : ["minimal", "control"];
  if (
    !bash ||
    bash.before?.uid !== process.getuid!() ||
    bash.before?.euid !== process.geteuid!() ||
    !isDeepStrictEqual(bash.before, bash.after) ||
    bash.forkCount !== cases.length * 3 ||
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
      cases,
    ) ||
    executable?.path !== executablePath ||
    executable.hash !== digest(fs.readFileSync(executablePath))
  )
    throw new AuditInputError("Bash測定の条件が一致しません");
  const seen = new Set(bash.ancestry.map((entry: any) => entry.pid));
  const targets: AuditTarget[] = [];
  const probePids: number[] = [];
  let previousEnd = -Infinity;
  for (const item of bash.cases) {
    const minimal = item.name === cases[0];
    const uidOnly = item.name === "uid-only";
    const mapping = minimal || uidOnly;
    const role = mapping ? "map" : "control";
    const mappingArgs = minimal
      ? ["--map-current-user"]
      : uidOnly
        ? [`--map-user=${uid}`]
        : baseline
          ? ["--user"]
          : [];
    const argv = direct
      ? ["-I", join(control, directPath), "child", role, String(uid)]
      : [...mappingArgs, "--", "/usr/bin/true"];
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
      probePids.push(probe.pid);
      const expectedStatus = mapping ? 1 : 0;
      if (
        probe.repetition !== index + 1 ||
        !isDeepStrictEqual(probe.argv, argv) ||
        probe.status !== expectedStatus ||
        probe.waitStatus !== expectedStatus ||
        probe.observerStatus !== 0 ||
        probe.signal !== null ||
        probe.error !== undefined ||
        (direct ? !directChildMatches(probe.stdout, uid, role) : probe.stdout !== "") ||
        probe.stderr !==
          (!direct && mapping
            ? "unshare: write failed /proc/self/uid_map: Operation not permitted\n"
            : "") ||
        probe.executableHash !== executable.hash ||
        probe.executableHashAfter !== executable.hash
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
        (mode !== "bash" && start < previousEnd) ||
        !Number.isFinite(probe.elapsedMs) ||
        probe.elapsedMs < 0 ||
        probe.elapsedMs >= 5000
      )
        throw new AuditInputError("Bash測定の時刻が範囲外です");
      previousEnd = end;
      if (minimal || direct)
        targets.push({
          pid: probe.pid,
          startedAt: probe.startedAt,
          endedAt: probe.endedAt,
          ...(direct ? { role } : baseline ? { role: "bash-baseline" } : {}),
        });
    }
  }
  return { targets, probePids, lastEnd: previousEnd };
}

/** 作成やopenでのEPERMをwrite拒否として扱わない。 */
function directChildMatches(stdout: unknown, uid: number, role: "map" | "control") {
  if (typeof stdout !== "string" || stdout.length > 1024) return false;
  const steps: object[] = [{ operation: "unshare", outcome: "passed" }];
  if (role === "map")
    steps.push(
      { operation: "open", outcome: "passed" },
      { operation: "write", outcome: "failed", errno: 1, error: "EPERM" },
    );
  try {
    return isDeepStrictEqual(JSON.parse(stdout), {
      schema: "linux-namespace-uid-write-child/v1",
      mode: role,
      uid,
      euid: uid,
      steps,
      outcome: role === "map" ? "failed" : "passed",
    });
  } catch {
    return false;
  }
}

/** 固定のAppArmorイベントと時刻だけを公開記録へ移す。 */
function directAuditEvents(audit: ReturnType<typeof probeAudit>, executableName: string) {
  return audit.events.flatMap((event) => {
    if (
      event.messageTruncated ||
      typeof event.message !== "string" ||
      typeof event.timestamp !== "string" ||
      typeof event.messagePid !== "number"
    )
      return [];
    const auditID = /^audit: type=1400 audit\((\d+\.\d+):(\d+)\): /.exec(event.message);
    if (!auditID) return [];
    const fields = [
      ...event.message
        .slice(auditID[0].length)
        .matchAll(/(?:^|\s)(\w+)=("(?:[^"\\]|\\.)*"|[^\s"]+)/g),
    ];
    const entries = new Map(fields.map(([, key, value]) => [key, value]));
    if (entries.size !== fields.length || entries.get("comm") !== JSON.stringify(executableName))
      return [];
    const transition =
      entries.get("apparmor") === '"AUDIT"' &&
      entries.get("operation") === '"userns_create"' &&
      entries.get("target") === '"unprivileged_userns"';
    const denial =
      entries.get("apparmor") === '"DENIED"' &&
      entries.get("operation") === '"capable"' &&
      entries.get("profile") === '"unprivileged_userns"' &&
      entries.get("capability") === "21" &&
      entries.get("capname") === '"sys_admin"';
    if (!transition && !denial) return [];
    return [
      {
        timestamp: event.timestamp,
        messagePid: event.messagePid,
        auditTimestamp: auditID[1],
        auditSerial: auditID[2],
        kind: transition ? "userns-transition" : "sys-admin-denied",
      },
    ];
  });
}

/** 比較終了後にだけ、呼出しユーザーの権限でPID・時刻を限定したkernel journalを読む。 */
function collectAudit(root: string, output: string, direct: boolean) {
  const directory = fs.lstatSync(output);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid!() ||
    (directory.mode & 0o077) !== 0
  )
    throw new AuditInputError("所有する非公開OUTPUT directoryが必要です");
  const comparison = direct ? "uid-write" : "bash";
  const descriptor = fs.openSync(join(output, `namespace-${comparison}-audit.json`), "wx", 0o600);
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
    probes: Array<
      AuditTarget & {
        audit:
          | ReturnType<typeof probeAudit>
          | (Omit<ReturnType<typeof probeAudit>, "events"> & {
              events: ReturnType<typeof directAuditEvents>;
            });
      }
    >;
  } = {
    schema: `linux-namespace-${comparison}-audit/v${direct ? 2 : 1}`,
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
    if (
      direct &&
      (process.arch !== "arm64" ||
        process.env.PROOF_ARCH !== "arm64" ||
        process.env.PROOF_MODE !== "probe-uid-write")
    )
      throw new AuditInputError("直接UID-map監査にはarm64のprobe-uid-writeが必要です");
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
      join(output, `namespace-${comparison}.json`),
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
    const selected = auditTargets(
      data,
      record.identity,
      root,
      Date.now(),
      direct,
      record.caller.pidNamespace,
    );
    record.plannedQueries = selected.length;
    if (!selected.length) {
      record.status = "not-requested";
      record.reason = direct
        ? "直接writeの正確なEPERM再現がありません"
        : "Bash側の正確なEPERM再現がありません";
    } else {
      record.status = "collected";
      for (const target of selected) {
        const audit = probeAudit(target, undefined, root);
        const saved = direct
          ? {
              ...audit,
              events: directAuditEvents(
                audit,
                target.role === "bash-baseline"
                  ? "unshare"
                  : basename(data.runtime.path).slice(0, 15),
              ),
            }
          : audit;
        record.probes.push({ ...target, audit: saved });
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
    const emit = (value: unknown) =>
      console.log(`[DEBUG-ns-${comparison}-audit] ` + JSON.stringify(value));
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
    const direct = extra.length === 1 && extra[0] === "--uid-write";
    if (!source || !output || (extra.length && !direct))
      throw new AuditInputError("SOURCE OUTPUT [--uid-write] が必要です");
    process.exitCode = collectAudit(resolve(source), resolve(output), direct);
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
