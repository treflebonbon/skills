import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createUnshareFixture } from "../helpers/linux-namespace-fixture";

const root = resolve(import.meta.dir, "../..");
const perlModule = join(root, "development/probe-linux-namespace-parent.pl");

test.skipIf(process.platform !== "linux")(
  "Perl直接起動はPythonを親に挟まず空環境・cwd・別々の通常pipeで6回測る",
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-parent-contract-"));
    let cleanup = () => {};
    try {
      const tools =
        "Node Tools " + "x".repeat(245 - Buffer.byteLength(join(directory, "Node Tools ", "node")));
      const node = join(directory, tools, "node");
      fs.mkdirSync(join(directory, tools));
      expect(Buffer.byteLength(node)).toBe(245);
      fs.symlinkSync(fs.realpathSync(Bun.which("node")!), node);
      const perl = Bun.which("perl")!;
      const {
        capture,
        behavior,
        unshare,
        versionCapture,
        cleanup: cleanFixture,
      } = createUnshareFixture(directory, node, {
        parent: fs.realpathSync(perl),
      });
      cleanup = cleanFixture;
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
      cleanup();
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

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0 || process.geteuid?.() === 0)(
  "非root専用: PythonとPerlの共通Bash親・通常pipe・空環境を照合し追加測定のgateを固定する",
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-parent-pair-"));
    const callerCwd = join(directory, "café");
    fs.mkdirSync(callerCwd);
    let cleanup = () => {};
    try {
      const python = join(directory, "perl-tools", "python3");
      fs.mkdirSync(join(directory, "perl-tools"));
      fs.copyFileSync(fs.realpathSync(Bun.which("python3")!), python);
      fs.chmodSync(python, 0o700);
      const perl = Bun.which("perl")!;
      const {
        capture,
        behavior,
        unshare,
        cleanup: cleanFixture,
      } = createUnshareFixture(directory, fs.realpathSync(Bun.which("node")!), {
        parent: fs.realpathSync(perl),
      });
      cleanup = cleanFixture;
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
          cwd: callerCwd,
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
      cleanup();
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
      const provenance = {
        identity: { sourceSha: "public-source" },
        controllerHashes: { parent: "public-controller" },
        runtimeHashes: { python: "public-runtime" },
      };
      fs.writeFileSync(
        join(partial, "namespace-parent-python.json"),
        JSON.stringify({ measurement: baseline, ...provenance }),
      );
      fs.writeFileSync(join(partial, "namespace-parent-perl.json"), "[");
      const finalized = spawnSync(python, ["-I", modulePath, "finalize", root, partial, "1", "0"], {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, ImageOS: "ubuntu22" },
      });
      expect(finalized.status).toBe(2);
      const record = JSON.parse(fs.readFileSync(join(partial, "namespace-parent.json"), "utf8"));
      expect(record.outcome).toBe("unavailable");
      expect(record.error).toContain("JSONDecodeError");
      expect(record.measurements.python).toEqual(baseline);
      for (const [key, value] of Object.entries(provenance)) expect(record[key]).toEqual(value);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "Bash制御は親比較とstdin比較の専用段階コードだけで測定・判定を許可する",
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
          "root=Path(sys.argv[2]);output=Path(sys.argv[3]);stage=sys.argv[1]",
          'preparing=stage in ("baseline","stdin-prepare")',
          'prefix="namespace-stdin" if stage.startswith("stdin-") else "namespace-parent"',
          'with (root/"trace").open("a") as f:',
          ' f.write(stage+"\\n" if preparing else stage+":"+sys.argv[4]+":"+sys.argv[5]+"\\n")',
          "if preparing:",
          ' with (output/(prefix+("-checkpoint.json" if stage=="stdin-prepare" else "-python.json"))).open("x") as f:f.write("owner-baseline")',
          ' sys.exit(int((root/"baseline-status").read_text()))',
          'with (output/(prefix+".json")).open("x") as f:f.write("owner-final")',
          'print("fixture-finalized")',
          'sys.exit(int((root/"final-status").read_text()))',
        ].join("\n"),
      );
      fs.writeFileSync(
        join(directory, "probe-linux-namespace-parent.pl"),
        [
          "use strict;use warnings;",
          "my $mode=@ARGV==3 && $ARGV[0] eq 'stdin' ? shift @ARGV : '';",
          "die 'wrong executable' unless @ARGV==2 && $ARGV[0] eq '/usr/bin/unshare';",
          "open my $trace,'>>','trace' or die $!;print {$trace} 'perl'.($mode?':stdin':'').qq(\\n);close $trace;",
          "open my $status,'<','perl-status' or die $!;exit 0+<$status>;",
        ].join("\n"),
      );
      const scenarios: Array<["parent" | "stdin", number, number, number, number]> = [
        ["parent", 41, 0, 44, 0],
        ["parent", 42, 0, 43, 1],
        ["parent", 2, 0, 2, 2],
        ["parent", 1, 0, 2, 2],
        ["parent", 0, 0, 2, 2],
        ["parent", 7, 0, 2, 2],
        ["parent", 42, 2, 2, 2],
        ["parent", 42, 0, 1, 2],
        ["parent", 42, 0, 0, 2],
        ["stdin", 45, 0, 43, 1],
        ["stdin", 45, 0, 44, 0],
        ["stdin", 45, 2, 2, 2],
        ["stdin", 1, 0, 2, 2],
        ["stdin", 0, 0, 2, 2],
        ["stdin", 2, 0, 2, 2],
        ["stdin", 7, 0, 2, 2],
        ["stdin", 42, 0, 2, 2],
        ["stdin", 41, 0, 2, 2],
        ["stdin", 45, 0, 1, 2],
        ["stdin", 45, 0, 0, 2],
      ];
      for (const [index, [mode, baseline, perl, final, status]] of scenarios.entries()) {
        fs.writeFileSync(join(directory, "trace"), "");
        fs.writeFileSync(join(directory, "baseline-status"), String(baseline));
        fs.writeFileSync(join(directory, "perl-status"), String(perl));
        fs.writeFileSync(join(directory, "final-status"), String(final));
        const output = join(directory, "output-" + index);
        const stdin = mode === "stdin";
        const allowed = baseline === (stdin ? 45 : 42);
        const relative = basename(directory);
        const result = spawnSync(
          "bash",
          [join(relative, basename(script)), relative, output, ...(stdin ? ["stdin"] : [])],
          {
            cwd: resolve(directory, ".."),
            env: { ...process.env, CDPATH: resolve(directory, "..") },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        expect(result.stderr).toBe("");
        expect(result.status).toBe(status);
        expect(result.stdout).toContain("fixture-finalized");
        expect(
          fs.readFileSync(
            join(output, stdin ? "namespace-stdin.json" : "namespace-parent.json"),
            "utf8",
          ),
        ).toBe("owner-final");
        expect(fs.readFileSync(join(directory, "trace"), "utf8")).toBe(
          (stdin ? "stdin-prepare\n" : "baseline\n") +
            (allowed ? (stdin ? "perl:stdin\n" : "perl\n") : "") +
            (stdin ? "stdin-finalize:" : "finalize:") +
            baseline +
            ":" +
            (allowed ? perl : -1) +
            "\n",
        );
      }
      const missing = spawnSync(
        "bash",
        [script, join(directory, "missing-source"), join(directory, "unused")],
        { encoding: "utf8" },
      );
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain("missing-source");
      expect(fs.existsSync(join(directory, "unused"))).toBe(false);
      const invalid = spawnSync(
        "bash",
        [script, directory, join(directory, "unused"), "bad-mode"],
        { encoding: "utf8" },
      );
      expect(invalid.status).toBe(2);
      expect(invalid.stderr).toContain("方式");
      expect(fs.existsSync(join(directory, "unused"))).toBe(false);
      fs.writeFileSync(join(directory, "trace"), "");
      const occupied = join(directory, "occupied");
      fs.mkdirSync(occupied);
      const checkpoint = join(occupied, "namespace-parent-python.json");
      const owner = fs.openSync(checkpoint, "wx", 0o600);
      try {
        fs.writeSync(owner, "owner-A-in-progress");
        for (const extra of [[], ["stdin"]]) {
          const competing = spawnSync("bash", [script, directory, occupied, ...extra], {
            encoding: "utf8",
          });
          expect(competing.status).toBe(2);
          expect(competing.stderr).toContain(occupied);
          expect(fs.readFileSync(join(directory, "trace"), "utf8")).toBe("");
          expect(fs.readFileSync(checkpoint, "utf8")).toBe("owner-A-in-progress");
          expect(fs.existsSync(join(occupied, "namespace-parent.json"))).toBe(false);
          expect(fs.existsSync(join(occupied, "namespace-stdin.json"))).toBe(false);
        }
      } finally {
        fs.closeSync(owner);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "Perl contextは空ファイルと読取失敗を区別しPythonと同じerrno名を残す",
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-parent-context-"));
    try {
      fs.writeFileSync(join(directory, "empty"), "");
      fs.writeFileSync(join(directory, "value"), "  public-value\n");
      const paths = [
        join(directory, "empty"),
        join(directory, "value"),
        join(directory, "missing"),
        directory,
      ];
      const actual = spawnSync(
        Bun.which("perl")!,
        [
          "-e",
          "require shift @ARGV;print JSON::PP->new->encode([map { read_context($_) } @ARGV]);",
          perlModule,
          ...paths,
        ],
        { encoding: "utf8" },
      );
      const expected = spawnSync(
        Bun.which("python3")!,
        [
          "-I",
          "-c",
          [
            "import errno,json,sys",
            "from pathlib import Path",
            "result=[]",
            "for path in sys.argv[1:]:",
            " try:result.append({'value':Path(path).read_text().strip()})",
            " except OSError as error:result.append({'error':errno.errorcode[error.errno]})",
            "print(json.dumps(result))",
          ].join("\n"),
          ...paths,
        ],
        { encoding: "utf8" },
      );
      expect(actual.stderr).toBe("");
      expect(actual.status).toBe(0);
      expect(expected.stderr).toBe("");
      expect(expected.status).toBe(0);
      expect(JSON.parse(actual.stdout)).toEqual(JSON.parse(expected.stdout));
      expect(JSON.parse(actual.stdout)).toEqual([
        { value: "" },
        { value: "public-value" },
        { error: "ENOENT" },
        { error: "EISDIR" },
      ]);
      for (const hex of ["2f686f6d652f636166c3a9", "ff"]) {
        const environment = spawnSync(
          Bun.which("perl")!,
          [
            "-e",
            "require shift @ARGV;%ENV=(HOME=>pack('H*',shift @ARGV),LANG=>'C',PROBE_ENV_SENTINEL=>pack('H*','ff'));my $ok=eval {print JSON::PP->new->utf8->encode(context()->{environment});1};print STDERR $@ unless $ok;exit($ok?0:2);",
            perlModule,
            hex,
          ],
          { encoding: "utf8", timeout: 10_000 },
        );
        expect(environment.status).toBe(hex === "ff" ? 2 : 0);
        if (hex === "ff") {
          expect(environment.stderr).toContain("UTF-8");
          expect(environment.stderr).toContain("does not map to Unicode");
        } else expect(environment.stderr).toBe("");
        if (hex !== "ff")
          expect(JSON.parse(environment.stdout)).toEqual({
            HOME: "/home/café",
            LANG: "C",
            PATH: null,
            LC_ALL: null,
            TMPDIR: null,
          });
        else expect(environment.stdout).toBe("");
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "親比較ログはprobeの限定項目と上限付きstreamだけを出しrawを保持する",
  () => {
    const modulePath = join(root, "development/probe-linux-namespace-parent.py");
    const result = spawnSync(
      Bun.which("python3")!,
      [
        "-I",
        "-c",
        [
          "import copy,importlib.util,json,sys",
          "spec=importlib.util.spec_from_file_location('parent',sys.argv[1])",
          "parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)",
          'probe={"argv":["--"],"pid":123,"status":1,"signal":None,"stdout":"x"*1025,"stderr":"y"*1025,"detail":"public-unbounded"*10000,"parent":"injected"}',
          'record={"stdoutType":"pipe","stderrType":"pipe","cases":[{"name":"minimal","probes":[probe]}]}',
          "before=copy.deepcopy(record)",
          'parent.log_measurement("python",record)',
          "assert record==before",
          'print("RAW "+json.dumps(record))',
        ].join("\n"),
        modulePath,
      ],
      { encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    const log = JSON.parse(lines[1]!.slice("[DEBUG-ns-parent] ".length));
    expect(log.parent).toBe("python");
    expect(log.detail).toBeUndefined();
    expect(log.stdout).toBe("x".repeat(1024));
    expect(log.stderr).toBe("y".repeat(1024));
    expect(log.logTruncated).toBe(true);
    const raw = JSON.parse(lines[2]!.slice("RAW ".length)).cases[0].probes[0];
    expect(raw.stdout).toHaveLength(1025);
    expect(raw.detail).toHaveLength(160000);
  },
);

test.skipIf(process.platform !== "linux")(
  "stdin比較はbaseline直後の実行体交換を追加起動前に拒否しbaselineを保持する",
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-stdin-replaced-"));
    let cleanup = () => {};
    try {
      const fixture = createUnshareFixture(directory, fs.realpathSync(Bun.which("node")!), "cwd");
      cleanup = fixture.cleanup;
      fs.writeFileSync(fixture.behavior, "both-eperm");
      const driver = [
        "require shift @ARGV;",
        "my ($executable,$variant)=@ARGV;",
        "my $original=\\&baseline_reproduced;",
        "no warnings 'redefine';",
        "*baseline_reproduced=sub { my $ok=$original->(@_); if ($ok && $variant eq 'replace') { open my $f,'>>:raw',$executable or die $!; print {$f} qq(\\n// changed fixture\\n); close $f; } return $ok; };",
        "my $record={};my $ok=eval {measure_stdin($executable,$record,'fixture-unshare');1};",
        "$record->{error}=$@ unless $ok;",
        "print JSON::PP->new->canonical->utf8->encode($record);",
      ].join("\n");
      for (const variant of ["stable", "replace"]) {
        fs.writeFileSync(fixture.capture, "");
        const result = spawnSync(
          Bun.which("perl")!,
          ["-e", driver, perlModule, fixture.unshare, variant],
          { cwd: root, encoding: "utf8", timeout: 20_000 },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        const record = JSON.parse(result.stdout);
        const count = fs.readFileSync(fixture.capture, "utf8").trim().split("\n").length;
        expect(count).toBe(variant === "stable" ? 12 : 6);
        expect(
          record.measurements.devnull.cases.flatMap((entry: { probes: unknown[] }) => entry.probes),
        ).toHaveLength(6);
        if (variant === "stable") {
          expect(record.error).toBeUndefined();
          expect(record.measurements.closed.unshare).toEqual(record.measurements.devnull.unshare);
        } else {
          expect(record.error).toContain("baselineの実行体");
          expect(record.measurements.closed.cases).toBeUndefined();
        }
      }
    } finally {
      cleanup();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0 || process.geteuid?.() === 0)(
  "非root専用: Python checkpointは祖先変化後の6件を保持し不正な環境値でもJSONを壊さない",
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-checkpoint-failures-"));
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const code = [
      "import copy,importlib.util,json,os,sys",
      "from pathlib import Path",
      "spec=importlib.util.spec_from_file_location('parent',sys.argv[1])",
      "parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)",
      "parent.validate=lambda root:{'sourceSha':'public-fixture'}",
      "calls=[]",
      "def capture(executable,argv,*args,**kwargs):",
      " assert str(executable)=='/usr/bin/unshare'",
      " calls.append(list(argv));version=argv==['--version'];minimal=argv[0]=='--map-current-user'",
      " return {'argv':list(argv),'pid':1000000+len(calls),'status':1 if minimal else 0,'signal':None,'stdout':'fixture-version\\n' if version else '', 'stderr':'unshare: write failed /proc/self/uid_map: Operation not permitted\\n' if minimal else ''}",
      "parent.launch.capture=capture",
      "ancestry=parent.ancestry;inspections=0",
      "def inspect():",
      " global inspections",
      " inspections+=1;value=ancestry()",
      " if sys.argv[5]=='ancestry' and inspections>1:value[0]['pid']+=1",
      " return value",
      "parent.ancestry=inspect",
      "os.environ['HOME']='/home/café'",
      "if sys.argv[5]=='invalid':os.environb[b'HOME']=b'\\xff'",
      "if sys.argv[5]=='unselected':os.environb[b'PROBE_UNUSED']=b'\\xff'",
      "output=Path(sys.argv[3]);stage=sys.argv[4];status=None;exception=None",
      "try:status=(parent.baseline if stage=='baseline' else parent.stdin_prepare)(Path(sys.argv[2]),output)",
      "except Exception as error:exception=type(error).__name__",
      "file=output/('namespace-parent-python.json' if stage=='baseline' else 'namespace-stdin-checkpoint.json')",
      "record=None;valid_json=True",
      "try:record=json.loads(file.read_text())",
      "except Exception:valid_json=False",
      "print('RESULT '+json.dumps({'status':status,'exception':exception,'validJson':valid_json,'record':record,'namespaceCalls':sum(row!=['--version'] for row in calls)}))",
    ].join("\n");
    const pythonModule = join(root, "development/probe-linux-namespace-parent.py");
    try {
      for (const stage of ["baseline", "stdin-prepare"])
        for (const variant of ["stable", "invalid", "ancestry", "unselected"]) {
          const output = join(directory, stage + "-" + variant);
          const command =
            [
              Bun.which("python3")!,
              "-I",
              "-B",
              "-c",
              code,
              pythonModule,
              root,
              output,
              stage,
              variant,
            ]
              .map(quote)
              .join(" ") + "\n:";
          const result = spawnSync("bash", ["-c", command], {
            cwd: root,
            encoding: "utf8",
            timeout: 15_000,
          });
          expect(result.status, result.stderr).toBe(0);
          expect(result.stderr).toBe("");
          const data = JSON.parse(result.stdout.trim().split("\n").at(-1)!.slice("RESULT ".length));
          expect(data.validJson).toBe(true);
          expect(data.exception).toBeNull();
          const refused = variant === "ancestry" || variant === "invalid";
          expect(data.status).toBe(refused ? 2 : stage === "baseline" ? 42 : 45);
          expect(data.record.outcome).toBe(
            refused ? "unavailable" : stage === "baseline" ? "uid-map-eperm" : "ready",
          );
          expect(data.record.identity.sourceSha).toBe("public-fixture");
          expect(data.record.controllerHashes).toBeDefined();
          expect(data.record.runtimeHashes).toBeDefined();
          expect(data.namespaceCalls).toBe(stage === "baseline" && variant !== "invalid" ? 6 : 0);
          if (variant === "invalid") {
            expect(data.record.error).toContain("HOME");
            expect(data.record.error).toContain("UTF-8");
          } else if (stage === "baseline") {
            expect(
              data.record.measurement.cases.flatMap((entry: { probes: unknown[] }) => entry.probes),
            ).toHaveLength(6);
            expect(data.record.measurement.before.environment.HOME).toBe("/home/café");
            if (variant === "ancestry") expect(data.record.error).toContain("祖先のidentity");
          } else {
            expect(data.record.context.environment.HOME).toBe("/home/café");
            if (variant === "ancestry") expect(data.record.error).toContain("準備中");
          }
        }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
