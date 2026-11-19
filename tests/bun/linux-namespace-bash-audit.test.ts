import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const entry = join(root, "development/probe-linux-namespace-bash-audit.ts");
const sourcePaths: Record<string, string> = {
  parent: "development/probe-linux-namespace-parent.py",
  python: "development/probe-linux-namespace-launch.py",
  perl: "development/probe-linux-namespace-parent.pl",
  driver: "development/probe-linux-namespace-parent.sh",
  bash: "development/probe-linux-namespace-bash.sh",
  observer: "development/probe-linux-namespace-bash.py",
};
const digest = (path: string) => createHash("sha256").update(fs.readFileSync(path)).digest("hex");

test("Bash監査modeだけが比較後の読取を要求し、専用準備と正式実証を増やさない", () => {
  const workflow = fs.readFileSync(join(root, ".github/workflows/linux-process-proof.yml"), "utf8");
  expect(workflow).toContain("          - probe-bash-audit");
  const comparison = workflow
    .split("- name: 共通BashからPerlを経由せず直接起動して比較\n")[1]!
    .split("      - name: ")[0]!;
  const audit = workflow
    .split("- name: Bash直接の失敗PIDに対応するkernel監査を非rootで取得\n")[1]!
    .split("      - name: ")[0]!;
  expect(comparison).toContain(
    "if: inputs.mode == 'probe-bash' || inputs.mode == 'probe-bash-audit'",
  );
  expect(audit.match(/^\s+if:\s*(.+)$/m)?.[1]).toBe(
    "always() && inputs.mode == 'probe-bash-audit'",
  );
  expect(audit).toContain("timeout-minutes: 2");
  expect(audit).toContain(
    'run: bun control/development/probe-linux-namespace-bash-audit.ts "$GITHUB_WORKSPACE/subject" "$RUNNER_TEMP/linux-proof"',
  );
  expect(audit).not.toContain("sudo");
  expect(audit).not.toContain("probe-userns");
  expect(audit).not.toContain("probe-uid");
  expect(comparison).toContain("|| inputs.mode == 'probe-uid'");
  expect(workflow).toContain("          - probe-uid");
  expect(workflow).toContain('"$PROOF_MODE" == probe-uid');
  expect(workflow).toContain("&& inputs.mode != 'probe-uid'");
  expect(workflow).toContain("inputs.mode == 'probe-uid' && 'namespace-uid'");
  expect(comparison).toContain("|| inputs.mode == 'probe-userns'");
  expect(workflow).toContain("          - probe-userns");
  expect(workflow).toContain('"$PROOF_MODE" == probe-userns');
  expect(workflow).toContain("&& inputs.mode != 'probe-userns'");
  expect(workflow).toContain("inputs.mode == 'probe-userns' && 'namespace-userns'");
  expect(workflow.indexOf("- name: 共通BashからPerl")).toBeLessThan(
    workflow.indexOf("- name: Bash直接の失敗PID"),
  );
  expect(workflow).toContain("&& inputs.mode != 'probe-bash-audit'");
  expect(workflow).toContain("inputs.mode == 'probe-bash-audit' && 'namespace-bash-audit'");
});

const supported =
  process.platform === "linux" &&
  Bun.version === "1.4.4" &&
  process.getuid?.() !== 0 &&
  process.geteuid?.() !== 0 &&
  fs.existsSync("/usr/bin/journalctl");

function fixture() {
  const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "bash-audit-$fixture-"));
  const calls = join(directory, "calls.jsonl");
  const preload = join(directory, "preload.ts");
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  const records = JSON.parse(
    fs.readFileSync(
      join(root, "docs/evidence/linux-namespace-bash/44418918065-1/observations.json"),
      "utf8",
    ),
  ).jobs[0].records;
  const metadata = structuredClone(records.find((row: any) => row.schema));
  metadata.identity = {
    ...metadata.identity,
    sourceSha: head,
    workflowSha: head,
    runId: "123",
    attempt: 1,
    arch: process.arch,
  };
  metadata.controllerHashes = Object.fromEntries(
    Object.entries(sourcePaths).map(([key, path]) => [key, digest(join(root, path))]),
  );
  metadata.unshare.hash = digest("/usr/bin/unshare");
  const measurements: Record<string, any> = {};
  for (const parent of ["perl", "bash"]) {
    const header = structuredClone(records.find((row: any) => row.parent === parent && !row.case));
    header.before.uid = process.getuid!();
    header.before.euid = process.geteuid!();
    header.before.gid = process.getgid!();
    header.before.groups = process.getgroups!();
    header.after = structuredClone(header.before);
    header.unshare = structuredClone(metadata.unshare);
    header.cases = ["minimal", "control"].map((name) => ({
      name,
      argv:
        name === "minimal"
          ? ["--map-current-user", "--", "/usr/bin/true"]
          : ["--", "/usr/bin/true"],
      probes: structuredClone(
        records.filter((row: any) => row.parent === parent && row.case === name),
      ),
    }));
    measurements[parent] = header;
  }
  const now = Date.now();
  const all = Object.values(measurements).flatMap((item: any) =>
    item.cases.flatMap((c: any) => c.probes),
  );
  all.forEach((probe: any, index: number) => {
    probe.startedAt = new Date(now - 2000 + index * 20).toISOString();
    probe.endedAt = new Date(now - 1999 + index * 20).toISOString();
    if (probe.parent === "bash") {
      probe.executableHash = metadata.unshare.hash;
      probe.executableHashAfter = metadata.unshare.hash;
    }
  });
  const record = { ...metadata, outcome: "perl-layer-not-required", measurements };
  fs.writeFileSync(
    preload,
    [
      'import {mock} from "bun:test";import * as fs from "node:fs";import * as cp from "node:child_process";',
      'const real=cp.spawnSync.bind(cp);const journal=fs.realpathSync("/usr/bin/journalctl");',
      "if(process.env.FIXTURE_AUDIT_NOW)Date.now=()=>Number(process.env.FIXTURE_AUDIT_NOW);",
      "const realStat=fs.fstatSync.bind(fs);let grew=false;",
      'mock.module("node:fs",()=>({...fs,fstatSync:(fd,...args)=>{',
      " const stat=realStat(fd,...args);",
      ' if(!grew&&process.env.FIXTURE_AUDIT_MODE==="input-growth"&&fs.readlinkSync("/proc/self/fd/"+fd)===process.env.FIXTURE_AUDIT_INPUT){',
      '  grew=true;fs.appendFileSync(process.env.FIXTURE_AUDIT_INPUT!," ");',
      '  fs.writeFileSync(process.env.FIXTURE_AUDIT_CALLS!+".growth",JSON.stringify({sizeBefore:stat.size,sizeAfter:stat.size+1}));',
      " }return stat;",
      "}}));",
      'if(process.env.FIXTURE_AUDIT_ROOT==="1")Object.defineProperty(process,"geteuid",{value:()=>0});',
      'mock.module("node:child_process",()=>({...cp,spawnSync:(file,args,options)=>{',
      ' const observerPaths=["development/probe-linux-namespace-bash-audit.ts","development/run-linux-process-proof.ts","development/probe-linux-namespace-bash.py","development/probe-linux-namespace-launch.py","development/probe-linux-namespace-bash.sh"];',
      ' if(file==="git"&&args[0]==="show"&&observerPaths.some(p=>args[1].endsWith(":"+p))){',
      '  const path=args[1].split(":").slice(1).join(":");',
      '  fs.appendFileSync(process.env.FIXTURE_AUDIT_CALLS!+".sources",JSON.stringify({file,args})+"\\n");',
      '  const bytes=process.env.FIXTURE_AUDIT_MODE==="source-mismatch"?Buffer.from("public-different-source"):fs.readFileSync(' +
        JSON.stringify(root) +
        '+"/"+path);',
      "  return {status:0,stdout:bytes,stderr:Buffer.alloc(0),signal:null,error:undefined};",
      " }",
      ' if(file!==journal&&!String(file).endsWith("/sudo")&&file!=="sudo")return real(file,args,options);',
      ' fs.appendFileSync(process.env.FIXTURE_AUDIT_CALLS!,JSON.stringify({file,args,timeout:options.timeout,maxBuffer:options.maxBuffer})+"\\n");',
      ' const answer=(status,stdout="",stderr="")=>({status,stdout,stderr,signal:null,error:undefined});',
      ' if(file!==journal)return answer(1,"","fixture: sudo must not run");',
      ' if(args[0]==="--version")return answer(0,"systemd fixture\\n");',
      " const mode=process.env.FIXTURE_AUDIT_MODE;",
      ' if(mode==="denied")return answer(1,"","Permission denied");',
      ' if(mode==="empty")return answer(1);',
      ' const pid=Number(/pid=(\\d+)/.exec(args.find(x=>x.startsWith("--grep=")))[1]);',
      ' const since=Date.parse(args[args.indexOf("--since")+1]),until=Date.parse(args[args.indexOf("--until")+1]);',
      " const stamp=Math.floor((since+until)/2);",
      ' const row=(message)=>JSON.stringify({_PID:"0",__REALTIME_TIMESTAMP:String(stamp*1000),MESSAGE:message});',
      ' const prefix="audit: type=1400 audit("+(stamp/1000).toFixed(3)+":123): ";',
      ' const messages=[row(prefix+\'apparmor="AUDIT" operation="userns_create" pid=\'+pid+\' comm="unshare" target="unprivileged_userns"\'),row(prefix+\'apparmor="AUDIT" info="pid=\'+pid+\'" pid=\'+(pid+1)+\' comm="decoy"\')];',
      ' if(mode==="truncated")while(messages.length<101)messages.push(messages[0]);',
      ' return answer(0,messages.join("\\n")+"\\n");',
      "}}));",
    ].join("\n"),
  );
  let sequence = 0;
  const execute = (value: any, mode = "matched", rootMock = false, symlink = false) => {
    const output = join(directory, "run-" + sequence++);
    fs.mkdirSync(output, { mode: 0o700 });
    fs.writeFileSync(join(output, "namespace-bash.json"), JSON.stringify(value), { mode: 0o600 });
    const input = join(output, "namespace-bash.json");
    if (symlink) {
      const regular = join(output, "regular.json");
      fs.renameSync(input, regular);
      fs.symlinkSync(regular, input);
    }
    if (["input-limit", "input-overflow", "input-growth"].includes(mode)) {
      fs.appendFileSync(
        input,
        " ".repeat(256 * 1024 - fs.statSync(input).size + (mode === "input-overflow" ? 1 : 0)),
      );
    }
    if (mode === "fifo") {
      fs.renameSync(input, join(output, "regular.json"));
      expect(spawnSync("mkfifo", [input], { encoding: "utf8", timeout: 1000 }).status).toBe(0);
    }
    fs.writeFileSync(calls, "");
    const result = spawnSync(process.execPath, ["--preload", preload, entry, root, output], {
      cwd: root,
      encoding: "utf8",
      timeout: mode === "fifo" ? 2000 : 15_000,
      env: {
        ...process.env,
        PROOF_SOURCE_SHA: head,
        GITHUB_SHA: head,
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        FIXTURE_AUDIT_CALLS: calls,
        FIXTURE_AUDIT_INPUT: input,
        FIXTURE_AUDIT_NOW: String(now),
        FIXTURE_AUDIT_MODE: mode,
        FIXTURE_AUDIT_ROOT: rootMock ? "1" : "0",
      },
    });
    const raw = fs.readFileSync(calls, "utf8").trim();
    const invoked = raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];
    const path = join(output, "namespace-bash-audit.json");
    const savedText = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
    const saved = savedText ? JSON.parse(savedText) : undefined;
    return { result, invoked, saved, output };
  };
  return { directory, calls, preload, record, execute, now };
}

test.skipIf(!supported)(
  "Bash監査は失敗した実測PIDだけを非rootで検索し、AUDITをそのまま保持する",
  () => {
    const f = fixture();
    try {
      const { result, invoked, saved } = f.execute(f.record);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(saved.status).toBe("collected");
      expect(saved.readerPrivilege).toBe("caller");
      expect(saved.caller).toEqual({
        uid: process.getuid!(),
        euid: process.geteuid!(),
        gid: process.getgid!(),
        egid: process.getegid!(),
        groups: process.getgroups!(),
        pidNamespace: fs.readlinkSync("/proc/self/ns/pid"),
      });
      expect(saved.collectorHash).toBe(digest(entry));
      expect(saved.readerImplementationHash).toBe(
        digest(join(root, "development/run-linux-process-proof.ts")),
      );
      const sourceCalls = fs
        .readFileSync(f.calls + ".sources", "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(sourceCalls).toHaveLength(5);
      expect(sourceCalls.every((item: any) => item.file === "git" && item.args[0] === "show")).toBe(
        true,
      );
      expect(saved.probes).toHaveLength(3);
      const publicRows = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("[DEBUG-ns-bash-audit] "))
        .map((line) => JSON.parse(line.slice("[DEBUG-ns-bash-audit] ".length)));
      expect(publicRows).toHaveLength(7);
      expect(publicRows[0].recordType).toBe("summary");
      expect(publicRows.filter((row) => row.recordType === "event").map((row) => row.pid)).toEqual(
        saved.probes.map((row: any) => row.pid),
      );
      const expected = f.record.measurements.bash.cases[0].probes;
      expect(saved.probes.map((p: any) => p.pid)).toEqual(expected.map((p: any) => p.pid));
      expect(invoked).toHaveLength(6);
      for (const [i, probe] of saved.probes.entries()) {
        expect(probe.audit.status).toBe("matched");
        expect(probe.audit.events).toHaveLength(1);
        expect(probe.audit.events[0].messagePid).toBe(expected[i].pid);
        expect(probe.audit.events[0].message).toContain('apparmor="AUDIT"');
        expect(probe.audit.events[0].message).not.toContain("decoy");
        const call = invoked[i * 2 + 1];
        const reader = fs.realpathSync("/usr/bin/journalctl");
        expect(invoked[i * 2]).toEqual({
          file: reader,
          args: ["--version"],
          timeout: 5000,
          maxBuffer: 8 * 1024,
        });
        expect(call).toEqual({
          file: reader,
          args: [
            "--dmesg",
            "--since",
            new Date(Date.parse(expected[i].startedAt) - 1000).toISOString(),
            "--until",
            new Date(Date.parse(expected[i].endedAt) + 1000).toISOString(),
            "--grep=(^|[^[:alnum:]_])pid=" + expected[i].pid + "([^[:alnum:]_]|$)",
            "--output=json",
            "--output-fields=__REALTIME_TIMESTAMP,_PID,MESSAGE",
            "--no-pager",
            "--lines=101",
          ],
          timeout: 5000,
          maxBuffer: 256 * 1024,
        });
      }
      for (const [mode, status, count] of [
        ["empty", "collected", 3],
        ["denied", "unavailable", 1],
        ["truncated", "unavailable", 1],
      ] as const) {
        const item = f.execute(f.record, mode);
        expect(item.result.status).toBe(mode === "empty" ? 0 : 2);
        expect(item.saved.status).toBe(status);
        expect(item.saved.probes).toHaveLength(count);
        expect(item.saved.probes[0].audit.status).toBe(
          mode === "empty"
            ? "no-matching-events"
            : mode === "denied"
              ? "permission-denied"
              : "truncated",
        );
        expect(
          item.invoked.every((call: any) => call.file === fs.realpathSync("/usr/bin/journalctl")),
        ).toBe(true);
      }
    } finally {
      fs.rmSync(f.directory, { recursive: true, force: true });
    }
  },
  30_000,
);

for (const mode of ["fifo", "input-growth"]) {
  test.skipIf(!supported)(
    "Bash監査は不正な入力を検索前に拒否する: " + mode,
    () => {
      const f = fixture();
      try {
        const regular = f.execute(f.record, "input-limit");
        expect(regular.result.status).toBe(0);
        expect(regular.saved.status).toBe("collected");
        const invalid = f.execute(f.record, mode);
        if (mode === "input-growth") {
          expect(JSON.parse(fs.readFileSync(f.calls + ".growth", "utf8"))).toEqual({
            sizeBefore: 256 * 1024,
            sizeAfter: 256 * 1024 + 1,
          });
          expect(fs.statSync(join(invalid.output, "namespace-bash.json")).size).toBe(
            256 * 1024 + 1,
          );
        }
        expect(invalid.result.error).toBeUndefined();
        expect(invalid.result.status).toBe(2);
        expect(invalid.saved.status).toBe("unavailable");
        expect(invalid.saved.error).toContain(mode === "fifo" ? "非公開の測定記録" : "上限256KiB");
        expect(invalid.invoked).toEqual([]);
      } finally {
        fs.rmSync(f.directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
}

test.skipIf(!supported)(
  "Bash監査は未再現と不正な出所・PID・時刻を検索前に区別し、既存記録を上書きしない",
  () => {
    const f = fixture();
    try {
      const skipped = structuredClone(f.record);
      skipped.outcome = "not-reproduced";
      delete skipped.measurements.bash;
      const noAudit = f.execute(skipped);
      expect(noAudit.result.status).toBe(0);
      expect(noAudit.saved.status).toBe("not-requested");
      expect(noAudit.invoked).toEqual([]);
      for (const kind of ["time", "old"] as const) {
        const boundary = structuredClone(f.record);
        const probe = boundary.measurements.bash.cases[0].probes[0];
        probe.startedAt = new Date(f.now - (kind === "old" ? 120000 : 6000)).toISOString();
        probe.endedAt = new Date(
          Date.parse(probe.startedAt) + (kind === "time" ? 5000 : 1),
        ).toISOString();
        probe.elapsedMs = 4999;
        const passed = f.execute(boundary);
        expect(passed.result.status).toBe(0);
        expect(passed.saved.status).toBe("collected");
        expect(passed.saved.probes).toHaveLength(3);
      }
      for (const [kind, reason] of [
        ["source", "出所"],
        ["hash", "hash"],
        ["pid", "PID"],
        ["duplicate", "PID"],
        ["time", "時刻"],
        ["old", "時刻"],
        ["elapsed", "時刻"],
        ["elapsed-limit", "時刻"],
        ["root", "非root"],
      ] as const) {
        const data = structuredClone(f.record),
          probe = data.measurements.bash.cases[0].probes[0];
        if (kind === "source") data.identity.sourceSha = "0".repeat(40);
        if (kind === "hash") data.controllerHashes.bash = "0".repeat(64);
        if (kind === "pid") probe.pid = 1;
        if (kind === "duplicate") data.measurements.bash.cases[0].probes[1].pid = probe.pid;
        if (kind === "elapsed") delete probe.elapsedMs;
        if (kind === "elapsed-limit") probe.elapsedMs = 5000;
        if (kind === "time") {
          probe.startedAt = new Date(f.now - 6000).toISOString();
          probe.endedAt = new Date(Date.parse(probe.startedAt) + 5001).toISOString();
        }
        if (kind === "old") {
          probe.startedAt = new Date(f.now - 120001).toISOString();
          probe.endedAt = probe.startedAt;
        }
        const item = f.execute(data, "matched", kind === "root");
        expect(item.result.status).toBe(2);
        expect(item.saved.status).toBe("unavailable");
        expect(item.saved.error).toContain(reason);
        expect(item.invoked).toEqual([]);
      }
      const symlink = f.execute(f.record, "matched", false, true);
      expect(symlink.result.status).toBe(2);
      expect(symlink.saved.error).toContain("ELOOP");
      expect(symlink.invoked).toEqual([]);
      const exact = f.execute(f.record, "input-limit");
      expect(exact.result.status).toBe(0);
      expect(exact.saved.status).toBe("collected");
      const overflow = f.execute(f.record, "input-overflow");
      expect(overflow.result.status).toBe(2);
      expect(overflow.saved.error).toContain("上限256KiB");
      expect(overflow.invoked).toEqual([]);
      const sourceMismatch = f.execute(f.record, "source-mismatch");
      expect(sourceMismatch.result.status).toBe(2);
      expect(sourceMismatch.saved.error).toContain("hash");
      expect(sourceMismatch.invoked).toEqual([]);
      const first = f.execute(f.record),
        pristine = fs.readFileSync(join(first.output, "namespace-bash-audit.json"), "utf8");
      fs.writeFileSync(f.calls, "");
      const again = spawnSync(
        process.execPath,
        ["--preload", f.preload, entry, root, first.output],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 15000,
          env: { ...process.env, FIXTURE_AUDIT_CALLS: f.calls },
        },
      );
      expect(again.status).toBe(2);
      expect(again.stderr).toContain("EEXIST");
      expect(fs.readFileSync(join(first.output, "namespace-bash-audit.json"), "utf8")).toBe(
        pristine,
      );
      expect(fs.readFileSync(f.calls, "utf8")).toBe("");
    } finally {
      fs.rmSync(f.directory, { recursive: true, force: true });
    }
  },
  30_000,
);
