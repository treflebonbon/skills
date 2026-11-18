import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createUnshareFixture } from "../helpers/linux-namespace-fixture";

const root = resolve(import.meta.dir, "../..");
const perlModule = join(root, "development/probe-linux-namespace-parent.pl");

test.skipIf(process.platform !== "linux")(
  "Perl直接起動はPythonを親に挟まず空環境・cwd・別々の通常pipeで6回測る",
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-parent-contract-"));
    try {
      const node = fs.realpathSync(Bun.which("node")!);
      const perl = Bun.which("perl")!;
      const { capture, behavior, unshare, versionCapture } = createUnshareFixture(
        directory,
        node,
        "parent",
      );
      const driver =
        'require $ARGV[0]; print JSON::PP->new->canonical->encode(measure($ARGV[1],undef,"fixture-unshare"));';
      for (const variant of ["both-eperm", "dependent", "passes", "other", "mixed"]) {
        fs.writeFileSync(behavior, variant);
        fs.writeFileSync(capture, "");
        fs.writeFileSync(versionCapture, "");
        const result = spawnSync(perl, ["-e", driver, perlModule, unshare], {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, PROBE_ENV_SENTINEL: "public-fixture" },
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const record = JSON.parse(result.stdout);
        expect(fs.readFileSync(versionCapture, "utf8")).toBe("");
        const observed = fs
          .readFileSync(capture, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(observed).toHaveLength(6);
        expect(record.forkCount).toBe(6);
        expect(record.runtime.name).toBe("perl");
        expect(record.before).toEqual(record.after);
        expect(record.probeEnvironment).toBe("empty");
        expect(record.cwd).toBe("/");
        expect(record.stdoutType).toBe("pipe");
        expect(record.stderrType).toBe("pipe");
        expect(record.cases).toHaveLength(2);
        for (const [caseIndex, scenario] of record.cases.entries()) {
          expect(scenario.name).toBe(caseIndex === 0 ? "minimal" : "control");
          expect(scenario.probes).toHaveLength(3);
          for (const [index, probe] of scenario.probes.entries()) {
            const actual = observed.find((row) => row.pid === probe.pid);
            expect(actual.ppid).toBe(record.runtime.pid);
            expect(actual.parent).toBe(fs.realpathSync(perl));
            expect(actual.cwd).toBe("/");
            expect(actual.keys).toBe(0);
            expect(actual.sentinel).toBe(false);
            expect(actual.stdinNull).toBe(true);
            expect(actual.outPipe).toBe(true);
            expect(actual.errPipe).toBe(true);
            expect(actual.outSocket).toBe(false);
            expect(actual.errSocket).toBe(false);
            expect(actual.stdioLinks[1]).toMatch(/^pipe:\[\d+\]$/);
            expect(actual.stdioLinks[2]).toMatch(/^pipe:\[\d+\]$/);
            expect(actual.stdioLinks[1]).not.toBe(actual.stdioLinks[2]);
            expect(parseInt(actual.stdioFlags[0], 8) & 3).toBe(0);
            expect(parseInt(actual.stdioFlags[1], 8) & 3).toBe(1);
            expect(parseInt(actual.stdioFlags[2], 8) & 3).toBe(1);
            expect(probe.argv).toEqual(scenario.argv);
            expect(probe.repetition).toBe(index + 1);
            expect(probe.signal).toBeNull();
            expect(probe.error).toBeUndefined();
            expect(probe.stdout).toBe("");
            const passed =
              caseIndex === 1 ||
              variant === "dependent" ||
              variant === "passes" ||
              (variant === "mixed" && index === 1);
            expect(probe.status).toBe(passed ? 0 : 1);
            expect(probe.stderr).toBe(
              passed
                ? ""
                : variant === "other"
                  ? "unshare: other failure\n"
                  : "unshare: write failed /proc/self/uid_map: Operation not permitted\n",
            );
          }
        }
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "Perl captureは時間・合算出力上限・exec失敗を区別して所有子を回収する",
  () => {
    const driver = [
      "require $ARGV[0];",
      "my @results;",
      "for my $pair ([64,0],[0,64],[32,32],[33,32],[64,1]) {",
      " my($out,$err)=@$pair;",
      " my $code='syswrite STDOUT, \"x\" x '.$out.'; syswrite STDERR, \"y\" x '.$err.';' ;",
      " my $r=capture($^X,['-e',$code],5,64);",
      " push @results,{out=>$out,err=>$err,result=>$r,reaped=>waitpid($r->{pid},1)==-1 ? 1 : 0};",
      "}",
      "my @slow=map { capture($^X,['-e',$_],0.05,64) } ('select undef,undef,undef,2;', 'close STDOUT;close STDERR;select undef,undef,undef,2;');",
      "my $missing=capture('/namespace-fixture-missing-executable',[],5,64);",
      "my $bytes=capture($^X,['-e','syswrite STDOUT, chr(255);'],5,64);",
      "print JSON::PP->new->utf8->encode({boundaries=>\\@results,slow=>\\@slow,missing=>$missing,bytes=>$bytes});",
    ].join("\n");
    const result = spawnSync(Bun.which("perl")!, ["-e", driver, perlModule], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout);
    for (const { out, err, result: probe, reaped } of data.boundaries) {
      expect(reaped).toBe(1);
      expect(probe.stdout.length + probe.stderr.length).toBeLessThanOrEqual(64);
      expect(probe.error ?? null).toBe(out + err > 64 ? "ENOBUFS" : null);
      if (out + err <= 64) {
        expect(probe.status).toBe(0);
        expect(probe.signal).toBeNull();
        expect(probe.stdout).toBe("x".repeat(out));
        expect(probe.stderr).toBe("y".repeat(err));
      }
    }
    for (const slow of data.slow) {
      expect(slow.error).toBe("ETIMEDOUT");
      expect(slow.signal).toBe("SIGKILL");
      expect(slow.status).toBeNull();
      expect(slow.elapsedMs).toBeLessThan(1000);
    }
    expect(data.missing.error).toContain("exec:");
    expect(data.missing.status).toBe(127);
    expect(data.missing.stdout).toBe("");
    expect(data.missing.stderr).toBe("");
    expect(data.bytes.stdout).toBe("\uFFFD");
    expect(data.bytes.status).toBe(0);
  },
);

test.skipIf(process.platform !== "linux")(
  "PythonとPerlの共通Bash親・通常pipe・空環境を照合し追加測定のgateを固定する",
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-parent-pair-"));
    try {
      const python = Bun.which("python3")!;
      const perl = Bun.which("perl")!;
      const { capture, behavior, unshare } = createUnshareFixture(
        directory,
        fs.realpathSync(Bun.which("node")!),
        "parent",
      );
      const modulePath = join(root, "development/probe-linux-namespace-parent.py");
      const baseline = join(directory, "namespace-parent-python.json");
      const changed = join(directory, "namespace-parent-perl.json");
      const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
      const common = [
        "import copy,importlib.util,json,sys",
        "from pathlib import Path",
        'spec=importlib.util.spec_from_file_location("parent",' + JSON.stringify(modulePath) + ")",
        "parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)",
      ];
      const baselineCode = [
        ...common,
        "record=parent.measure_python(sys.argv[1])",
        'result=parent.measurement_outcome(record,"python",parent.ancestry()[1:])',
        'checkpoint={"schema":"linux-namespace-parent-checkpoint/v1","outcome":result,"measurement":record,"controllerHashes":{"perl":parent.launch.digest(parent.PERL_HELPER)},"runtimeHashes":{"perl":parent.launch.digest(parent.PERL)}}',
        "Path(sys.argv[2]).write_text(json.dumps(checkpoint))",
        'sys.exit(1 if result=="uid-map-eperm" else 0 if result=="not-reproduced" else 2)',
      ].join("\n");
      const finalizeCode = [
        ...common,
        'baseline=json.loads(Path(sys.argv[1]).read_text())["measurement"]',
        "changed=json.loads(Path(sys.argv[2]).read_text()) if Path(sys.argv[2]).exists() else None",
        "common=parent.ancestry()[1:]",
        'record={"python":baseline,"perl":changed,"outcome":parent.compare_parent(baseline,changed,common),"invalid":[]}',
        "if changed:",
        ' for field in ["runtime","parent","start","context","controller","unshare","stdoutType","stderrType","environment","count","pid","probe","emptyAncestry","invalidRecord","generation"]:',
        "  invalid=copy.deepcopy(changed)",
        '  if field=="runtime":invalid["runtime"]["hash"]="0"*64',
        '  if field=="parent":invalid["ancestry"][1]["pid"]+=1',
        '  if field=="start":invalid["ancestry"][1]["startTimeTicks"]+=1',
        '  if field=="context":invalid["before"]["namespaces"]["user"]=invalid["after"]["namespaces"]["user"]="different"',
        '  if field=="controller":invalid["controllerHash"]="0"*64',
        '  if field=="unshare":invalid["unshare"]["hash"]="0"*64',
        '  if field=="stdoutType":invalid["stdoutType"]="socket"',
        '  if field=="stderrType":invalid["stderrType"]="socket"',
        '  if field=="environment":invalid["probeEnvironment"]="inherited"',
        '  if field=="count":invalid["forkCount"]=7',
        '  if field=="pid":invalid["cases"][0]["probes"][1]["pid"]=invalid["cases"][0]["probes"][0]["pid"]',
        '  if field=="probe":invalid["cases"][0]["probes"][0]["status"]=7',
        '  if field=="emptyAncestry":invalid["ancestry"]=[]',
        '  if field=="invalidRecord":invalid=[]',
        '  if field=="generation": invalid["runtime"]["pid"]=invalid["ancestry"][0]["pid"]=baseline["runtime"]["pid"];invalid["ancestry"][0]["startTimeTicks"]=baseline["ancestry"][0]["startTimeTicks"]',
        '  record["invalid"].append(parent.compare_parent(baseline,invalid,common))',
        ' record["missing"]=parent.compare_parent(baseline,None,common)',
        ' parent.log_measurement("python",baseline)',
        ' parent.log_measurement("perl",changed)',
        'print("RESULT "+json.dumps(record))',
      ].join("\n");
      const script = join(directory, "compare.sh");
      fs.writeFileSync(
        script,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "status=0",
          quote(python) +
            " -I -B -c " +
            quote(baselineCode) +
            " " +
            quote(unshare) +
            " " +
            quote(baseline) +
            " || status=$?",
          'if [[ "$status" == 1 ]]; then',
          "  " +
            quote(perl) +
            " " +
            quote(perlModule) +
            " " +
            quote(unshare) +
            " " +
            quote(directory),
          "fi",
          quote(python) +
            " -I -B -c " +
            quote(finalizeCode) +
            " " +
            quote(baseline) +
            " " +
            quote(changed),
          ":",
          "",
        ].join("\n"),
      );
      for (const [variant, expected] of [
        ["both-eperm", "python-layer-not-required"],
        ["dependent", "python-layer-dependent"],
        ["passes", "not-reproduced"],
        ["other", "unavailable"],
        ["mixed", "unavailable"],
      ]) {
        fs.writeFileSync(behavior, variant!);
        fs.writeFileSync(capture, "");
        if (fs.existsSync(changed)) fs.unlinkSync(changed);
        const result = spawnSync("bash", [script], {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, PROBE_ENV_SENTINEL: "public-fixture" },
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const lines = result.stdout.trim().split("\n");
        const record = JSON.parse(lines.at(-1)!.slice("RESULT ".length));
        const shouldCompare = variant === "both-eperm" || variant === "dependent";
        expect(record.outcome).toBe(expected);
        expect(record.perl !== null).toBe(shouldCompare);
        const observed = fs
          .readFileSync(capture, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(observed).toHaveLength(shouldCompare ? 12 : 6);
        const pythonRows = observed.slice(0, 6);
        for (const [index, actual] of observed.entries()) {
          const measured = index < 6 ? record.python : record.perl;
          expect(actual.ppid).toBe(measured.runtime.pid);
          expect(actual.cwd).toBe("/");
          expect(actual.keys).toBe(0);
          expect(actual.stdinNull).toBe(true);
          expect(actual.outPipe).toBe(true);
          expect(actual.errPipe).toBe(true);
          expect(actual.stdioFlags).toEqual(pythonRows[0].stdioFlags);
        }
        if (shouldCompare) {
          expect(record.python.runtime.ppid).toBe(record.perl.runtime.ppid);
          expect(record.python.ancestry.slice(1)).toEqual(record.perl.ancestry.slice(1));
          expect(record.invalid).toEqual(Array(15).fill("unavailable"));
          expect(record.missing).toBe("unavailable");
          const logs = lines
            .filter((line) => line.startsWith("[DEBUG-ns-parent] "))
            .map((line) => JSON.parse(line.slice("[DEBUG-ns-parent] ".length)));
          expect(logs).toHaveLength(14);
          for (const log of logs) {
            expect(["python", "perl"]).toContain(log.parent);
            expect(log.stdoutType).toBe("pipe");
            expect(log.stderrType).toBe("pipe");
            if (log.case) expect(log.logTruncated).toBe(false);
          }
        }
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "親比較CLIはOS不足と途中記録を保存しwx0600の上書きを拒否する",
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-parent-partial-"));
    try {
      const python = Bun.which("python3")!;
      const modulePath = join(root, "development/probe-linux-namespace-parent.py");
      const output = join(directory, "failed-baseline");
      const result = spawnSync(python, ["-I", modulePath, "baseline", root, output], {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, ImageOS: "ubuntu22" },
      });
      expect(result.status).toBe(2);
      const path = join(output, "namespace-parent-python.json");
      const saved = fs.readFileSync(path, "utf8");
      expect(JSON.parse(saved).outcome).toBe("unavailable");
      expect(JSON.parse(saved).error).toContain("Ubuntu 24.04");
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
      const repeated = spawnSync(python, ["-I", modulePath, "baseline", root, output], {
        encoding: "utf8",
      });
      expect(repeated.status).toBe(2);
      expect(repeated.stdout).toContain("FileExistsError");
      expect(fs.readFileSync(path, "utf8")).toBe(saved);
      const partial = join(directory, "partial");
      fs.mkdirSync(partial);
      const baseline = { marker: "public-baseline", cases: [{ probes: [{}] }] };
      fs.writeFileSync(
        join(partial, "namespace-parent-python.json"),
        JSON.stringify({ measurement: baseline }),
      );
      fs.writeFileSync(join(partial, "namespace-parent-perl.json"), "[]");
      const finalized = spawnSync(python, ["-I", modulePath, "finalize", root, partial, "1", "0"], {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, ImageOS: "ubuntu22" },
      });
      expect(finalized.status).toBe(2);
      const record = JSON.parse(fs.readFileSync(join(partial, "namespace-parent.json"), "utf8"));
      expect(record.outcome).toBe("unavailable");
      expect(record.error).toContain("Ubuntu 24.04");
      expect(record.measurements.python).toEqual(baseline);
      expect(record.measurements.perl).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "Bash制御はbaseline exit1だけでPerlを起動し失敗時も後処理へ渡す",
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-parent-gate-"));
    try {
      const script = join(directory, "probe-linux-namespace-parent.sh");
      fs.copyFileSync(join(root, "development/probe-linux-namespace-parent.sh"), script);
      fs.writeFileSync(
        join(directory, "probe-linux-namespace-parent.py"),
        [
          "from pathlib import Path",
          "import sys",
          "root=Path(sys.argv[2])",
          'with (root/"trace").open("a") as f:',
          ' f.write("baseline\\n" if sys.argv[1]=="baseline" else "finalize:"+sys.argv[4]+":"+sys.argv[5]+"\\n")',
          'if sys.argv[1]=="baseline":sys.exit(int((root/"baseline-status").read_text()))',
          'print("fixture-finalized")',
        ].join("\n"),
      );
      fs.writeFileSync(
        join(directory, "probe-linux-namespace-parent.pl"),
        [
          "use strict;use warnings;",
          "die 'wrong executable' unless $ARGV[0] eq '/usr/bin/unshare';",
          "open my $trace,'>>','trace' or die $!;print {$trace} qq(perl\\n);close $trace;",
          "open my $status,'<','perl-status' or die $!;exit 0+<$status>;",
        ].join("\n"),
      );
      for (const [baseline, perl] of [
        [0, 0],
        [1, 0],
        [2, 0],
        [7, 0],
        [1, 2],
      ]) {
        fs.writeFileSync(join(directory, "trace"), "");
        fs.writeFileSync(join(directory, "baseline-status"), String(baseline));
        fs.writeFileSync(join(directory, "perl-status"), String(perl));
        const result = spawnSync("bash", [script, directory, join(directory, "output")], {
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("fixture-finalized");
        expect(fs.readFileSync(join(directory, "trace"), "utf8")).toBe(
          "baseline\n" +
            (baseline === 1 ? "perl\n" : "") +
            "finalize:" +
            baseline +
            ":" +
            (baseline === 1 ? perl : -1) +
            "\n",
        );
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
