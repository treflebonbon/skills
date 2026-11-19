import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFixtureInterpreter } from "../helpers/linux-namespace-fixture";

const root = resolve(import.meta.dir, "../..");
const driver = join(root, "development/probe-linux-namespace-bash.sh");

test("観測streamが空または不正でもBashと観測子のwait結果を保存する", () => {
  const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "namespace-bash-merge-"));
  try {
    const executable = fs.realpathSync(Bun.which("true")!);
    const hash = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
    const argv = ["--map-current-user", "--", "/usr/bin/true"];
    const valid = {
      argv,
      pid: 4243,
      ownerPid: 4242,
      status: null,
      signal: null,
      stdout: "public-captured",
      stderr: "",
      marker: "public-valid-streams",
    };
    for (const [index, raw] of [JSON.stringify(valid), null, "", "{", "[]"].entries()) {
      const prefix = join(directory, String(index));
      if (raw !== null) fs.writeFileSync(prefix + "-streams.json", raw);
      const result = spawnSync(
        "python3",
        [
          "-I",
          "-B",
          join(root, "development/probe-linux-namespace-bash.py"),
          "merge",
          prefix,
          index === 0 ? "1" : "143",
          index === 0 ? "0" : "17",
          "4242",
          executable,
          hash,
          ...argv,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const saved = JSON.parse(fs.readFileSync(prefix + ".json", "utf8"));
      expect(saved.argv).toEqual(argv);
      expect(saved.ownerPid).toBe(4242);
      expect(saved.waitStatus).toBe(index === 0 ? 1 : 143);
      expect(saved.observerStatus).toBe(index === 0 ? 0 : 17);
      if (index === 0) {
        expect(saved.error).toBeUndefined();
        expect(saved.stdout).toBe("public-captured");
        expect(saved.marker).toBe("public-valid-streams");
        expect(saved.status).toBe(1);
      } else {
        expect(saved.error).toBe("EOBSERVER");
        expect(saved.stdout).toBe("");
        expect(saved.stderr).toBe("");
        expect(saved.status).toBeNull();
        expect(saved.signal).toBeNull();
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "Bash直接captureは合算上限・EOF後の生存・曖昧なwait状態を区別する",
  () => {
    const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "namespace-bash-limits-"));
    try {
      const exact = capture(
        directory,
        "exact",
        "import os;os.write(1,b'a'*512);os.write(2,b'b'*512)",
        5,
        1024,
      ).record;
      expect(exact.error).toBeUndefined();
      expect(exact.status).toBe(0);
      expect(exact.stdout.length + exact.stderr.length).toBe(1024);
      const overflow = capture(
        directory,
        "overflow",
        "import os;os.write(1,b'a'*512);os.write(2,b'b'*513)",
        5,
        1024,
      ).record;
      expect(overflow.error).toBe("ENOBUFS");
      expect(overflow.stdout.length + overflow.stderr.length).toBe(1024);
      const timeout = capture(
        directory,
        "timeout",
        "import os,time;os.close(1);os.close(2);time.sleep(2)",
        0.2,
      ).record;
      expect(timeout.error).toBe("ETIMEDOUT");
      expect(timeout.waitStatus).toBeGreaterThanOrEqual(128);
      expect(timeout.signal).toBeNull();
      for (const [name, code] of [
        ["exit143", "import sys;sys.exit(143)"],
        ["sigterm", "import os,signal;os.kill(os.getpid(),signal.SIGTERM)"],
      ]) {
        const result = capture(directory, name!, code!).record;
        expect(result.error).toBe("EWAITSTATUS");
        expect(result.waitStatus).toBe(143);
        expect(result.status).toBeNull();
        expect(result.signal).toBeNull();
      }
      const protocol = capture(directory, "protocol", "print('ACK')").record;
      expect(protocol.stdout).toBe("ACK\n");
      expect(protocol.error).toBeUndefined();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

/** Bash sourceへ渡すfixtureの引数だけをquoteする。 */
function quote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0 || process.geteuid?.() === 0)(
  "Perl baselineが正確な場合だけBash直接側を測り、callerと所有PIDの不一致を拒否する",
  () => {
    const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "namespace-bash-pair-"));
    const interpreter = createFixtureInterpreter(Bun.which("python3")!);
    try {
      const caller = join(directory, "caller café");
      fs.mkdirSync(caller);
      const observed = join(directory, "observed.jsonl");
      const behavior = join(directory, "behavior");
      const versions = join(directory, "versions");
      const executable = join(directory, "fixture-unshare.py");
      fs.writeFileSync(
        executable,
        [
          "#!" + interpreter.path + " -IB",
          "import errno,fcntl,json,os,stat,sys",
          "from pathlib import Path",
          "if sys.argv[1:]==['--version']:",
          " with open(" + JSON.stringify(versions) + ",'a') as f:f.write('version\\n')",
          " print('fixture-unshare');sys.exit(0)",
          "try:fcntl.fcntl(0,fcntl.F_GETFD);closed=False",
          "except OSError as e:assert e.errno==errno.EBADF;closed=True",
          "parent=os.readlink('/proc/'+str(os.getppid())+'/exe')",
          "mode=Path(" + JSON.stringify(behavior) + ").read_text()",
          "previous=Path(" + JSON.stringify(observed) + ").read_text().splitlines()",
          "row={'argv':sys.argv[1:],'pid':os.getpid(),'ppid':os.getppid(),'parent':parent,'closed':closed,'cwd':os.getcwd(),'keys':list(os.environ),'flags':[fcntl.fcntl(n,fcntl.F_GETFL) for n in [1,2]],'fdFlags':[fcntl.fcntl(n,fcntl.F_GETFD) for n in [1,2]],'pipes':[stat.S_ISFIFO(os.fstat(n).st_mode) for n in [1,2]]}",
          "with open(" + JSON.stringify(observed) + ",'a') as f:f.write(json.dumps(row)+'\\n')",
          "if sys.argv[1]=='--user' and mode in ['userns-control-fails','uid-control-fails']:sys.stderr.write('unshare: unshare failed: Operation not permitted\\n');sys.exit(1)",
          "if sys.argv[1].startswith('--map-user='):",
          " if mode=='uid-clears':sys.exit(0)",
          " if mode=='uid-mixed' and len(previous)==10:sys.exit(0)",
          " sys.stderr.write('unshare: other failure\\n' if mode=='uid-other' else 'unshare: write failed /proc/self/uid_map: Operation not permitted\\n');sys.exit(1)",
          "if sys.argv[1]=='--map-current-user' and mode not in ['passes','userns-passes','uid-passes']:",
          " if mode in ['dependent','userns-bash-passes','uid-baseline-passes'] and Path(parent).name=='bash':sys.exit(0)",
          " if mode=='mixed' and len(previous)==1:sys.exit(0)",
          " message='unshare: other failure\\n' if mode=='other' or mode=='bash-other' and Path(parent).name=='bash' else 'unshare: write failed /proc/self/uid_map: Operation not permitted\\n'",
          " sys.stderr.write(message);sys.exit(1)",
        ].join("\n"),
        { mode: 0o700 },
      );
      const module = join(root, "development/probe-linux-namespace-bash.py");
      const perl = join(root, "development/probe-linux-namespace-parent.pl");
      const wrapper = [
        "import contextlib,copy,importlib.util,io,json,sys,shutil",
        "from pathlib import Path",
        "spec=importlib.util.spec_from_file_location('bash_probe',sys.argv[1])",
        "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)",
        "m.UNSHARE=sys.argv[2]",
        // 実VMの前提だけを置換し、観測・capture・分類は実装を使う。
        "m.validate=lambda root:{'sourceSha':'public-fixture','workflowSha':'public-fixture'}",
        "stage=sys.argv[3];root=Path(sys.argv[4]);output=Path(sys.argv[5]);version=sys.argv[6]",
        "if stage=='prepare':sys.exit(m.prepare(root,output,version))",
        "if stage=='baseline-check':sys.exit(m.baseline_check(root,output,version,int(sys.argv[7])))",
        "if stage=='start':m.start_bash(root,output,version);sys.exit(0)",
        "if stage=='finalize':",
        " status=m.finalize(root,output,version,*map(int,sys.argv[7:11]))",
        " final=json.loads((output/('namespace-'+{'probe-userns':'userns','probe-uid':'uid'}.get(m.os.environ.get('PROOF_MODE'),'bash')+'.json')).read_text())",
        " if final['outcome']=='uid-mapping-reproduced':",
        "  checkpoint=json.loads((output/'namespace-bash-checkpoint.json').read_text());common=m.parent.ancestry()[1:]",
        "  print('UID-VALID '+m.bash_outcome(final['measurements']['bash'],common,checkpoint))",
        "  for field in ['uid-target','baseline','count']:",
        "   changed=copy.deepcopy(final['measurements']['bash'])",
        "   if field=='uid-target':",
        "    changed['cases'][1]['argv'][0]='--map-user='+str(m.os.geteuid()+1)",
        "    for probe in changed['cases'][1]['probes']:probe['argv']=changed['cases'][1]['argv'].copy()",
        "   if field=='baseline':",
        "    for probe in changed['cases'][0]['probes']:probe.update(status=0,waitStatus=0,stderr='')",
        "   if field=='count':changed['forkCount']=6",
        "   print('UID-INVALID '+m.bash_outcome(changed,common,checkpoint))",
        "  target=output.with_name(output.name+'-partial');shutil.copytree(output,target,ignore=shutil.ignore_patterns('namespace-uid.json'))",
        "  (target/'bash-uid-only-2.json').write_text('{')",
        "  with contextlib.redirect_stdout(io.StringIO()) as captured:answer=m.finalize(root,target,version,*map(int,sys.argv[7:11]))",
        "  saved=json.loads((target/'namespace-uid.json').read_text())",
        "  logged=[json.loads(line.split('] ',1)[1]) for line in captured.getvalue().splitlines()]",
        "  print('UID-PARTIAL '+json.dumps({'status':answer,'record':saved,'loggedProbes':[row for row in logged if row.get('parent')=='bash' and 'case' in row]}))",
        " if final['outcome']=='id-mapping-required':",
        "  checkpoint=json.loads((output/'namespace-bash-checkpoint.json').read_text());common=m.parent.ancestry()[1:]",
        "  print('USERNS-VALID '+m.bash_outcome(final['measurements']['bash'],common,checkpoint))",
        "  changed=copy.deepcopy(final['measurements']['bash']);changed['cases'][1]['argv']=['--','/usr/bin/true']",
        "  for probe in changed['cases'][1]['probes']:probe['argv']=['--','/usr/bin/true']",
        "  print('USERNS-INVALID '+m.bash_outcome(changed,common,checkpoint))",
        " if 'bash' in final['measurements'] and final['outcome']=='perl-layer-not-required':",
        "  m.os.environ['PROOF_MODE']='probe-userns'",
        "  try:m.check_checkpoint(root,output,version)",
        "  except ValueError as error:print('MODE-DRIFT '+str(error))",
        "  finally:m.os.environ['PROOF_MODE']='probe-bash'",
        "  checkpoint=json.loads((output/'namespace-bash-checkpoint.json').read_text());common=m.parent.ancestry()[1:]",
        "  print('VALID '+m.bash_outcome(final['measurements']['bash'],common,checkpoint))",
        "  for field in ['owner','generation','hash','context','observer']: ",
        "   changed=copy.deepcopy(final['measurements']['bash'])",
        "   if field=='owner':changed['cases'][0]['probes'][0]['ownerPid']=changed['cases'][0]['probes'][0]['observerPid']",
        "   if field=='generation':changed['ancestry'][0]['startTimeTicks']+=1",
        "   if field=='hash':changed['cases'][0]['probes'][0]['executableHashAfter']='0'*64",
        "   if field=='context':changed['after']['euid']=0",
        "   if field=='observer':changed['cases'][0]['probes'][0]['observerPid']='public-invalid-pid'",
        "   print('INVALID '+m.bash_outcome(changed,common,checkpoint))",
        "  original_snapshot=m.snapshot",
        "  for label in ['owner','corrupt','corrupt-middle','snapshot']:",
        "   target=output.with_name(output.name+'-'+label)",
        "   shutil.copytree(output,target,ignore=shutil.ignore_patterns('namespace-bash.json'))",
        "   raw=target/('bash-minimal-2.json' if label=='corrupt-middle' else 'bash-minimal-1.json')",
        "   if label=='owner':",
        "    data=json.loads(raw.read_text());data['ownerPid']+=1;raw.write_text(json.dumps(data))",
        "   elif label=='corrupt':raw.write_text('{')",
        "   elif label=='corrupt-middle':raw.write_text('')",
        "   if label=='snapshot':m.snapshot=lambda version: (_ for _ in ()).throw(OSError('public-final-snapshot'))",
        "   try:",
        "    with contextlib.redirect_stdout(io.StringIO()) as captured:answer=m.finalize(root,target,version,*map(int,sys.argv[7:11]))",
        "   finally:m.snapshot=original_snapshot",
        "   saved=json.loads((target/'namespace-bash.json').read_text())",
        "   logged=[json.loads(line.split('] ',1)[1]) for line in captured.getvalue().splitlines()]",
        "   print('PARTIAL '+json.dumps({'label':label,'status':answer,'outcome':saved['outcome'],'error':saved.get('error'),'baseline':saved['measurements']['perl'],'bash':saved['measurements'].get('bash'),'loggedBashProbes':[row for row in logged if row.get('parent')=='bash' and 'case' in row]}))",
        " if final['outcome']=='perl-layer-not-required':",
        "  original=m.os.readlink",
        "  m.os.readlink=lambda path: 'public-path-marker'+chr(0xdcff) if str(path).endswith('/cwd') else original(path)",
        "  try:",
        "   bad=output.with_name(output.name+'-bad-cwd');bad.mkdir(mode=0o700)",
        "   rejected=m.prepare(root,bad,version)",
        "   saved=json.loads((bad/'namespace-bash-checkpoint.json').read_text())",
        "   print('UTF8 '+json.dumps({'status':rejected,'record':saved}))",
        "  finally:m.os.readlink=original",
        " sys.exit(status)",
      ].join("\n");
      const script = [
        "set -euo pipefail",
        "source " + quote(driver),
        "stage() {",
        " python3 -I -B -c " +
          quote(wrapper) +
          " " +
          [module, executable].map(quote).join(" ") +
          ' "$1" "$PWD" "$output" "$BASH_VERSION" "@@{@:2}"',
        "}",
        'output="$1";mkdir -m 700 "$output"',
        "prepare_status=0;stage prepare || prepare_status=$?",
        "perl_status=-1;gate_status=-1;bash_status=-1",
        "if [[ $prepare_status == 46 ]];then",
        " perl_status=0;/usr/bin/perl " +
          quote(perl) +
          " bash " +
          quote(executable) +
          ' "$output" || perl_status=$?',
        ' gate_status=0;stage baseline-check "$perl_status" || gate_status=$?',
        " if [[ $gate_status == 47 ]];then",
        "  bash_status=0;stage start || bash_status=$?",
        "  if [[ $bash_status == 0 ]];then",
        "   names=(minimal control);[[ @@PROOF_MODE != probe-uid ]] || names=(minimal uid-only control)",
        '   for name in "@@{names[@]}";do',
        "    args=(-- /usr/bin/true);[[ @@PROOF_MODE != probe-userns && @@PROOF_MODE != probe-uid ]] || args=(--user -- /usr/bin/true);[[ $name != minimal ]] || args=(--map-current-user -- /usr/bin/true)",
        '    if [[ $name == uid-only ]];then args=("--map-user=@@EUID" -- /usr/bin/true);fi',
        "    for n in 1 2 3;do",
        "     capture_probe " +
          quote(executable) +
          ' "$output/bash-$name-$n" 5 33554432 "$fixture_hash" "@@{args[@]}" || { bash_status=$?;break 2; }',
        "    done",
        "   done",
        "  fi",
        " fi",
        "fi",
        'final_status=0;stage finalize "$prepare_status" "$perl_status" "$gate_status" "$bash_status" || final_status=$?',
        "printf 'FINAL %s\\n' \"$final_status\"",
      ]
        .join("\n")
        .replaceAll("@@", "$");
      const file = join(directory, "fixture.sh");
      fs.writeFileSync(file, script);
      const hash = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
      for (const [variant, expected] of [
        ["both-eperm", "perl-layer-not-required"],
        ["dependent", "perl-layer-dependent"],
        ["passes", "not-reproduced"],
        ["other", "unavailable"],
        ["mixed", "unavailable"],
        ["bash-other", "unavailable"],
        ["userns-both-eperm", "id-mapping-required"],
        ["userns-bash-passes", "bash-not-reproduced"],
        ["userns-control-fails", "unavailable"],
        ["userns-passes", "not-reproduced"],
        ["uid-reproduced", "uid-mapping-reproduced"],
        ["uid-clears", "uid-mapping-not-reproduced"],
        ["uid-other", "unavailable"],
        ["uid-mixed", "unavailable"],
        ["uid-baseline-passes", "unavailable"],
        ["uid-control-fails", "unavailable"],
        ["uid-passes", "not-reproduced"],
      ]) {
        fs.writeFileSync(observed, "");
        fs.writeFileSync(versions, "");
        fs.writeFileSync(behavior, variant!);
        const output = join(directory, variant!);
        const result = spawnSync("bash", [file, output], {
          cwd: caller,
          encoding: "utf8",
          timeout: 45_000,
          env: {
            ...process.env,
            fixture_hash: hash,
            PROOF_MODE: variant!.startsWith("uid-")
              ? "probe-uid"
              : variant!.startsWith("userns-")
                ? "probe-userns"
                : "probe-bash",
            HOME: "/home/café",
            PROBE_ENV_SENTINEL: "public-fixture",
          },
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        const uid = variant!.startsWith("uid-");
        const userns = variant!.startsWith("userns-");
        const kind = uid ? "uid" : userns ? "userns" : "bash";
        const data = JSON.parse(
          fs.readFileSync(join(output, "namespace-" + kind + ".json"), "utf8"),
        );
        expect(data.schema).toBe("linux-namespace-" + kind + "-comparison/v1");
        expect(data.outcome).toBe(expected);
        expect(result.stdout).toContain("[DEBUG-ns-" + kind + "]");
        const compared =
          (uid && variant !== "uid-passes") ||
          (userns && variant !== "userns-passes") ||
          ["both-eperm", "dependent", "bash-other"].includes(variant!);
        const rows = fs
          .readFileSync(observed, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(rows).toHaveLength(compared ? (uid ? 15 : 12) : 6);
        expect(fs.readFileSync(versions, "utf8")).toBe("version\n");
        const baseline = data.measurements.perl;
        expect(baseline.before.environment.HOME).toBe("/home/café");
        for (const [index, row] of rows.entries()) {
          let argv =
            index % 6 < 3 ? ["--map-current-user", "--", "/usr/bin/true"] : ["--", "/usr/bin/true"];
          if (index >= 6 && (userns || uid)) {
            argv =
              index < 9
                ? ["--map-current-user", "--", "/usr/bin/true"]
                : uid && index < 12
                  ? ["--map-user=" + process.geteuid?.(), "--", "/usr/bin/true"]
                  : ["--user", "--", "/usr/bin/true"];
          }
          expect(row.argv).toEqual(argv);
          expect(row.closed).toBe(true);
          expect(row.cwd).toBe("/");
          expect(row.flags).toEqual([1, 1]);
          expect(row.fdFlags).toEqual([0, 0]);
          expect(row.pipes).toEqual([true, true]);
          expect(row.keys).toEqual(row.keys.includes("LC_CTYPE") ? ["LC_CTYPE"] : []);
          expect(row.ppid).toBe(
            index < 6 ? baseline.runtime.pid : data.measurements.bash.runtime.pid,
          );
          expect(row.parent).toBe(
            fs.realpathSync(index < 6 ? "/usr/bin/perl" : Bun.which("bash")!),
          );
        }
        expect(result.stdout).toContain(
          "FINAL " + (expected === "not-reproduced" ? 44 : expected === "unavailable" ? 2 : 43),
        );
        if (uid && compared) {
          const cases = data.measurements.bash.cases;
          expect(cases.map((item: any) => item.name)).toEqual(["minimal", "uid-only", "control"]);
          expect(data.measurements.bash.forkCount).toBe(9);
          if (expected === "unavailable")
            expect(data.error).toContain("選択した対照の比較条件・raw結果が成立しません");
          if (variant === "uid-baseline-passes")
            expect(cases[0].probes.map((p: any) => [p.status, p.stderr])).toEqual([
              [0, ""],
              [0, ""],
              [0, ""],
            ]);
          if (variant === "uid-other")
            expect(cases[1].probes.map((p: any) => p.stderr)).toEqual(
              Array(3).fill("unshare: other failure\n"),
            );
          if (variant === "uid-mixed")
            expect(cases[1].probes.map((p: any) => p.status)).toEqual([1, 0, 1]);
          if (variant === "uid-control-fails")
            expect(cases[2].probes.map((p: any) => p.stderr)).toEqual(
              Array(3).fill("unshare: unshare failed: Operation not permitted\n"),
            );
        }
        if (variant === "uid-reproduced") {
          expect(result.stdout).toContain("UID-VALID uid-map-eperm");
          expect(result.stdout.match(/^UID-INVALID unavailable$/gm)).toHaveLength(3);
          const partial = JSON.parse(
            result.stdout
              .split("\n")
              .find((line) => line.startsWith("UID-PARTIAL "))!
              .slice(12),
          );
          expect(partial.status).toBe(2);
          expect(partial.record.outcome).toBe("unavailable");
          expect(partial.record.measurements.perl).toEqual(baseline);
          expect(partial.record.measurements.bash.error).toContain("capture");
          expect(partial.record.measurements.bash.captureErrors).toEqual([
            { case: "uid-only", repetition: 2, error: "JSONDecodeError" },
          ]);
          expect(
            partial.record.measurements.bash.cases.map((item: any) => item.probes.length),
          ).toEqual([3, 2, 3]);
          expect(partial.loggedProbes.map((p: any) => p.pid)).toEqual(
            partial.record.measurements.bash.cases.flatMap((item: any) =>
              item.probes.map((p: any) => p.pid),
            ),
          );
        }
        if (variant === "userns-both-eperm") {
          expect(result.stdout).toContain("USERNS-VALID uid-map-eperm");
          expect(result.stdout).toContain("USERNS-INVALID unavailable");
        }
        if (variant === "both-eperm") {
          expect(result.stdout).toContain(
            "MODE-DRIFT 段階間のsource・共通Bash・callerが一致しません",
          );
          expect(result.stdout).toContain("VALID uid-map-eperm");
          const utf8 = JSON.parse(
            result.stdout
              .split("\n")
              .find((line) => line.startsWith("UTF8 "))!
              .slice(5),
          );
          expect(utf8.status).toBe(2);
          expect(utf8.record.outcome).toBe("unavailable");
          expect(utf8.record.error).toContain("UTF-8");
          expect(JSON.stringify(utf8.record)).not.toContain("public-path-marker");
          expect(result.stdout.match(/^INVALID unavailable$/gm)).toHaveLength(5);
          const partials = result.stdout
            .split("\n")
            .filter((line) => line.startsWith("PARTIAL "))
            .map((line) => JSON.parse(line.slice(8)));
          expect(partials).toHaveLength(4);
          for (const partial of partials) {
            expect(partial.status).toBe(2);
            expect(partial.outcome).toBe("unavailable");
            expect(partial.baseline).toEqual(baseline);
          }
          const snapshotFailure = partials.find((partial) => partial.label === "snapshot");
          expect(snapshotFailure.error).toContain("public-final-snapshot");
          expect(snapshotFailure.bash?.cases).toEqual(data.measurements.bash.cases);
          const publicProbe = (probe: any) => ({
            pid: probe.pid,
            argv: probe.argv,
            status: probe.status,
            stderr: probe.stderr,
          });
          expect(snapshotFailure.loggedBashProbes.map(publicProbe)).toEqual(
            data.measurements.bash.cases.flatMap((item: any) => item.probes).map(publicProbe),
          );
          for (const label of ["corrupt", "corrupt-middle"]) {
            const partial = partials.find((item) => item.label === label);
            const repetition = label === "corrupt" ? 1 : 2;
            const expectedCases = structuredClone(data.measurements.bash.cases);
            expectedCases[0].probes.splice(repetition - 1, 1);
            expect(partial.bash?.cases).toEqual(expectedCases);
            expect(partial.bash?.error).toContain("capture");
            expect(partial.bash?.captureErrors).toEqual([
              { case: "minimal", repetition, error: "JSONDecodeError" },
            ]);
            expect(partial.loggedBashProbes.map(publicProbe)).toEqual(
              expectedCases.flatMap((item: any) => item.probes).map(publicProbe),
            );
          }
        }
      }
    } finally {
      interpreter.cleanup();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

test.skipIf(process.platform !== "linux")(
  "本番Bash driverは専用の段階コードで比較を制限し、既存OUTPUTへ測定を追加しない",
  () => {
    const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "namespace-bash-driver-"));
    try {
      const calls = join(directory, "calls.jsonl");
      const settings = join(directory, "settings.json");
      fs.copyFileSync(driver, join(directory, "probe-linux-namespace-bash.sh"));
      fs.writeFileSync(
        join(directory, "probe-linux-namespace-bash.py"),
        [
          "import json,os,sys",
          "from pathlib import Path",
          "config=json.loads(Path(" + JSON.stringify(settings) + ").read_text())",
          "stage=sys.argv[1]",
          "with open(" +
            JSON.stringify(calls) +
            ",'a') as f:f.write(json.dumps({'stage':stage,'args':sys.argv[2:]})+'\\n')",
          // READYを返さず、実unshareのfork/execへ進ませない。
          "if stage=='donor':sys.stdin.buffer.read();sys.exit(0)",
          "if stage=='observe':sys.exit(0)",
          "if stage=='settings':print('0'*64);sys.exit(0)",
          "if stage=='finalize':",
          " prepare,perl,gate,bash=map(int,sys.argv[5:9])",
          " sys.exit(44 if prepare==46 and perl==0 and gate==44 and bash==-1 else 43 if prepare==46 and perl==0 and gate==47 and bash==0 else 2)",
          "sys.exit(config.get(stage,0))",
        ].join("\n"),
      );
      fs.writeFileSync(
        join(directory, "probe-linux-namespace-parent.pl"),
        [
          "use strict;use warnings;use JSON::PP;",
          "open my $input,'<'," + quote(settings) + " or die $!;",
          "my $config=decode_json(do { local $/;<$input> });",
          "open my $output,'>>'," + quote(calls) + " or die $!;",
          "print {$output} encode_json({stage=>'perl',args=>\\@ARGV}),qq{\\n};",
          "exit $config->{perl};",
        ].join("\n"),
      );
      let index = 0;
      for (const [prepare, perl, gate, expectedExit, captures, mode] of [
        [46, 0, 47, 1, 6],
        [46, 0, 47, 1, 6, "probe-userns"],
        [46, 0, 47, 1, 9, "probe-uid"],
        [46, 0, 44, 0, 0],
        [46, 0, 2, 2, 0],
        [46, 2, 2, 2, 0],
        [2, 0, 47, 2, 0],
        [1, 0, 47, 2, 0],
      ] as const) {
        fs.writeFileSync(calls, "");
        fs.writeFileSync(settings, JSON.stringify({ prepare, perl, "baseline-check": gate }));
        const output = join(directory, "run-" + index++);
        const result = spawnSync(
          "bash",
          [join(directory, "probe-linux-namespace-bash.sh"), root, output],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 15_000,
            env: { ...process.env, PROOF_MODE: String(mode ?? "probe-bash") },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(expectedExit!);
        expect(result.stderr).toBe("");
        const rows = fs
          .readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(rows.filter((row) => row.stage === "observe")).toHaveLength(captures!);
        expect(rows.filter((row) => row.stage === "perl")).toHaveLength(prepare === 46 ? 1 : 0);
        expect(rows.filter((row) => row.stage === "start")).toHaveLength(captures ? 1 : 0);
        expect(rows.at(-1).stage).toBe("finalize");
        if (captures) {
          const observed = rows.filter((row) => row.stage === "observe");
          expect(
            observed
              .slice(0, 3)
              .every(
                (row) => row.args.slice(8).join(" ") === "--map-current-user -- /usr/bin/true",
              ),
          ).toBe(true);
          if (mode === "probe-uid")
            expect(
              observed
                .slice(3, 6)
                .every(
                  (row) =>
                    row.args.slice(8).join(" ") ===
                    "--map-user=" + process.geteuid?.() + " -- /usr/bin/true",
                ),
            ).toBe(true);
          expect(
            observed
              .slice(mode === "probe-uid" ? 6 : 3)
              .every(
                (row) =>
                  row.args.slice(8).join(" ") ===
                  (mode === "probe-userns" || mode === "probe-uid"
                    ? "--user -- /usr/bin/true"
                    : "-- /usr/bin/true"),
              ),
          ).toBe(true);
        }
        const previous = fs.readFileSync(calls, "utf8");
        const duplicate = spawnSync(
          "bash",
          [join(directory, "probe-linux-namespace-bash.sh"), root, output],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        expect(duplicate.status).toBe(2);
        expect(fs.readFileSync(calls, "utf8")).toBe(previous);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

/** 実子でBashの直接親・fd・空環境を観測する。 */
function capture(directory: string, name: string, code: string, timeout = 5, limit = 65536) {
  const executable = fs.realpathSync(Bun.which("python3")!);
  const hash = createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  const prefix = join(directory, name);
  const result = spawnSync(
    "bash",
    [driver, "capture", executable, prefix, String(timeout), String(limit), hash, "-I", "-c", code],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, PROBE_ENV_SENTINEL: "public-fixture" },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  const record = JSON.parse(fs.readFileSync(prefix + ".json", "utf8"));
  return { record, stderr: result.stderr };
}

test.skipIf(process.platform !== "linux")(
  "Bash直接captureは別の子で観測し、閉鎖stdinと匿名pipeのflagsを維持する",
  () => {
    const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "namespace-bash-"));
    try {
      const code = [
        "import errno,fcntl,json,os,stat",
        "try:fcntl.fcntl(0,fcntl.F_GETFD);closed=False",
        "except OSError as e:assert e.errno==errno.EBADF;closed=True",
        "extra=[]",
        "for fd in range(3,128):",
        " try:fcntl.fcntl(fd,fcntl.F_GETFD);extra.append(fd)",
        " except OSError as e:assert e.errno==errno.EBADF",
        "print(json.dumps({'pid':os.getpid(),'ppid':os.getppid(),'parent':os.readlink('/proc/'+str(os.getppid())+'/exe'),'closed':closed,'cwd':os.getcwd(),'environment':dict(os.environ),'flags':[fcntl.fcntl(n,fcntl.F_GETFL) for n in [1,2]],'fdFlags':[fcntl.fcntl(n,fcntl.F_GETFD) for n in [1,2]],'pipes':[stat.S_ISFIFO(os.fstat(n).st_mode) for n in [1,2]],'links':[os.readlink('/proc/self/fd/'+str(n)) for n in [1,2]],'extra':extra}))",
        "os.write(2,b'public-fixture-stderr')",
      ].join("\n");
      const { record, stderr } = capture(directory, "normal", code);
      expect(stderr).toBe("");
      expect(record.error).toBeUndefined();
      expect(record.status).toBe(0);
      expect(record.signal).toBeNull();
      expect(record.stderr).toBe("public-fixture-stderr");
      const row = JSON.parse(record.stdout);
      expect(row.pid).toBe(record.pid);
      expect(row.ppid).toBe(record.ownerPid);
      expect(row.parent).toBe(fs.realpathSync(Bun.which("bash")!));
      expect(row.closed).toBe(true);
      expect(row.cwd).toBe("/");
      expect(Object.keys(row.environment)).toEqual(
        row.environment.LC_CTYPE === "C.UTF-8" ? ["LC_CTYPE"] : [],
      );
      expect(row.flags).toEqual([1, 1]);
      expect(row.fdFlags).toEqual([0, 0]);
      expect(row.pipes).toEqual([true, true]);
      expect(row.links[0]).not.toBe(row.links[1]);
      expect(row.extra).toEqual([]);
      expect(record.childBefore.ppid).toBe(record.ownerPid);
      expect(record.childBefore.path).toBe(row.parent);
      expect(record.observerPid).not.toBe(row.ppid);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
