import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFixtureInterpreter } from "../helpers/linux-namespace-fixture";

const root = resolve(import.meta.dir, "../..");
const perlModule = join(root, "development/probe-linux-namespace-parent.pl");
const pythonModule = join(root, "development/probe-linux-namespace-parent.py");

test.skipIf(process.platform !== "linux")(
  "stdin比較のcaptureはexec前にfd 0だけを閉じ、子から閉鎖を観測できる",
  () => {
    const child = [
      "import errno,fcntl,json,os,stat",
      "try:",
      " fd=fcntl.fcntl(0,fcntl.F_GETFD);closed=False",
      "except OSError as error:",
      " assert error.errno==errno.EBADF;closed=True",
      "result={'pid':os.getpid(),'ppid':os.getppid(),'closed':int(closed),'stdin':None if closed else os.readlink('/proc/self/fd/0'),'mode':None if closed else fcntl.fcntl(0,fcntl.F_GETFL)&os.O_ACCMODE,'stdoutPipe':int(stat.S_ISFIFO(os.fstat(1).st_mode)),'stderrPipe':int(stat.S_ISFIFO(os.fstat(2).st_mode)),'keys':len(os.environ),'locale':os.environ.get('LC_CTYPE'),'sentinel':'PROBE_ENV_SENTINEL' in os.environ,'cwd':os.getcwd()}",
      "print(json.dumps(result))",
    ].join("\n");
    const driver = [
      "require shift @ARGV;",
      "my $python=shift @ARGV;my $code=shift @ARGV;",
      "my @rows=map { capture($python,['-I','-c',$code],5,65536,0,$_) } ('devnull','closed');",
      "print JSON::PP->new->encode({parent=>0+$$,rows=>\\@rows});",
    ].join("\n");
    const result = spawnSync(
      Bun.which("perl")!,
      ["-e", driver, perlModule, Bun.which("python3")!, child],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, PROBE_ENV_SENTINEL: "public-fixture" },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const data = JSON.parse(result.stdout);
    for (const [index, probe] of data.rows.entries()) {
      expect(probe.status).toBe(0);
      expect(probe.signal).toBeNull();
      expect(probe.error).toBeUndefined();
      expect(probe.stderr).toBe("");
      const observed = JSON.parse(probe.stdout);
      expect(observed.pid).toBe(probe.pid);
      expect(observed.ppid).toBe(data.parent);
      expect(observed.closed).toBe(index);
      expect(observed.stdin).toBe(index === 0 ? "/dev/null" : null);
      expect(observed.mode).toBe(index === 0 ? 0 : null);
      expect(observed.stdoutPipe).toBe(1);
      expect(observed.stderrPipe).toBe(1);
      // CPythonが空環境へ追加するLC_CTYPEだけを許す。
      expect(observed.keys === 0 || (observed.keys === 1 && observed.locale === "C.UTF-8")).toBe(
        true,
      );
      expect(observed.sentinel).toBe(false);
      expect(observed.cwd).toBe("/");
    }
  },
  20_000,
);

/** fd 0を再オープンしない観測用の子で、stdin以外の設定も残す。 */
function createStdinFixture(directory: string) {
  const capture = join(directory, "capture.jsonl");
  const behavior = join(directory, "behavior");
  const versions = join(directory, "versions");
  const unshare = join(directory, "unshare.py");
  fs.writeFileSync(capture, "");
  fs.writeFileSync(versions, "");
  const interpreter = createFixtureInterpreter(Bun.which("python3")!);
  try {
    fs.writeFileSync(
      unshare,
      [
        "#!" + interpreter.path + " -IB",
        "import errno,fcntl,json,os,stat,sys",
        "try:",
        " fcntl.fcntl(0,fcntl.F_GETFD);closed=False",
        "except OSError as error:",
        " assert error.errno==errno.EBADF;closed=True",
        "stdin=None if closed else os.readlink('/proc/self/fd/0')",
        "stdin_mode=None if closed else fcntl.fcntl(0,fcntl.F_GETFL)&os.O_ACCMODE",
        "if sys.argv[1:]==['--version']:",
        " with open(" + JSON.stringify(versions) + ",'a') as stream:stream.write('version\\n')",
        " print('fixture-unshare');sys.exit(0)",
        "with open(" + JSON.stringify(behavior) + ") as stream:behavior=stream.read()",
        "with open(" + JSON.stringify(capture) + ") as stream:count=len(stream.readlines())",
        "environment_ok=len(os.environ)==0 or len(os.environ)==1 and os.environ.get('LC_CTYPE')=='C.UTF-8'",
        "observed={'pid':os.getpid(),'ppid':os.getppid(),'parent':os.readlink('/proc/'+str(os.getppid())+'/exe'),'closed':closed,'stdin':stdin,'stdinMode':stdin_mode,'environmentOk':environment_ok,'sentinel':'PROBE_ENV_SENTINEL' in os.environ,'cwd':os.getcwd(),'pipes':[stat.S_ISFIFO(os.fstat(fd).st_mode) for fd in (1,2)],'flags':[fcntl.fcntl(fd,fcntl.F_GETFL) for fd in (1,2)],'fdFlags':[fcntl.fcntl(fd,fcntl.F_GETFD) for fd in (1,2)],'links':[os.readlink('/proc/self/fd/'+str(fd)) for fd in (1,2)]}",
        "with open(" +
          JSON.stringify(capture) +
          ",'a') as stream:stream.write(json.dumps(observed)+'\\n')",
        "if sys.argv[1]=='--map-current-user' and behavior!='passes':",
        " if behavior=='dependent' and closed:sys.exit(0)",
        " if behavior=='mixed' and count==1:sys.exit(0)",
        " sys.stderr.write('unshare: other failure\\n' if behavior=='other' or behavior=='closed-other' and closed else 'unshare: write failed /proc/self/uid_map: Operation not permitted\\n')",
        " sys.exit(1)",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
  } catch (error) {
    interpreter.cleanup();
    throw error;
  }
  return { capture, behavior, unshare, versions, cleanup: interpreter.cleanup };
}

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0 || process.geteuid?.() === 0)(
  "非root専用: 同じPerl親でstdinだけを比較し正確な再現時だけ閉じた条件へ進む",
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace stdin pair "));
    let cleanup = () => {};
    try {
      const {
        capture,
        behavior,
        unshare,
        versions,
        cleanup: cleanFixture,
      } = createStdinFixture(directory);
      cleanup = cleanFixture;
      const pair = join(directory, "namespace-stdin-perl.json");
      const checkpoint = join(directory, "namespace-stdin-checkpoint.json");
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const producer =
        "import importlib.util,json,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('parent',sys.argv[1])\nparent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)\ncheckpoint={'schema':'linux-namespace-stdin-checkpoint/v1','outcome':'ready','controllerHashes':{'perl':parent.launch.digest(parent.PERL_HELPER)},'runtimeHashes':{'perl':parent.launch.digest(parent.PERL)},'unshare':{'path':sys.argv[2],'hash':parent.launch.digest(sys.argv[2]),'version':'fixture-unshare'},'context':parent.launch.context(),'ancestry':parent.ancestry()}\nif sys.argv[4]=='context':checkpoint['context']['namespaces']['user']='different'\nif sys.argv[4]=='controller':checkpoint['controllerHashes']['perl']='0'*64\nPath(sys.argv[3]).write_text(json.dumps(checkpoint))";
      const post = [
        "import copy,importlib.util,json,sys",
        "from pathlib import Path",
        "spec=importlib.util.spec_from_file_location('parent',sys.argv[1])",
        "parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)",
        "pair=json.loads(Path(sys.argv[2]).read_text())",
        "assert not pair.get('error'),pair",
        "measurements=pair['measurements'];baseline=measurements['devnull'];changed=measurements.get('closed')",
        "common=parent.ancestry()[1:]",
        "result={'pair':pair,'outcome':parent.compare_stdin(baseline,changed,common),'invalid':[]}",
        "if changed:",
        " for field in ['runtime','parent','generation','context','controller','unshare','stdoutType','stdinType','environment','count','pid','probe','shape','after']:",
        "  invalid=copy.deepcopy(changed)",
        "  if field=='runtime':invalid['runtime']['hash']='0'*64",
        "  if field=='parent':invalid['ancestry'][1]['pid']+=1",
        "  if field=='generation':invalid['ancestry'][0]['startTimeTicks']+=1",
        "  if field=='context':invalid['before']['namespaces']['user']=invalid['after']['namespaces']['user']='other'",
        "  if field=='controller':invalid['controllerHash']='0'*64",
        "  if field=='unshare':invalid['unshare']['hash']='0'*64",
        "  if field=='stdoutType':invalid['stdoutType']='socket'",
        "  if field=='stdinType':invalid['stdinType']='devnull'",
        "  if field=='environment':invalid['probeEnvironment']='inherited'",
        "  if field=='count':invalid['forkCount']=7",
        "  if field=='pid':invalid['cases'][0]['probes'][1]['pid']=baseline['cases'][0]['probes'][0]['pid']",
        "  if field=='probe':invalid['cases'][0]['probes'][0]['status']=7",
        "  if field=='shape':invalid=[]",
        "  if field=='after':invalid['after']['uid']=0",
        "  result['invalid'].append(parent.compare_stdin(baseline,invalid,common))",
        "for record in measurements.values():parent.log_measurement('perl',record,prefix='stdin')",
        "original_digest=parent.launch.digest;identity={'sourceSha':'public-fixture'}",
        "parent.validate=lambda root:identity",
        "parent.launch.digest=lambda path:original_digest(sys.argv[3] if str(path)=='/usr/bin/unshare' else path)",
        "final_pair=copy.deepcopy(pair)",
        "for record in final_pair['measurements'].values():record['unshare']['path']='/usr/bin/unshare'",
        "checkpoint={'schema':'linux-namespace-stdin-checkpoint/v1','outcome':'ready','identity':identity,'controllerHashes':parent.controller_hashes(),'runtimeHashes':{'python':original_digest(sys.executable),'perl':original_digest(parent.PERL)},'unshare':final_pair['measurements']['devnull']['unshare'],'context':parent.launch.context(),'ancestry':parent.ancestry()}",
        "result['finals']=[]",
        "variants=[('valid',final_pair,0)]",
        "if result['outcome']=='not-reproduced':variants.append(('null-closed',{**final_pair,'measurements':{**final_pair['measurements'],'closed':None}},0))",
        "if changed:variants.append(('producer-error',{**final_pair,'error':'public-producer-marker:'+'x'*2048,'measurements':{'devnull':final_pair['measurements']['devnull']}},2))",
        "for label,export,status in variants:",
        " output=Path(sys.argv[2]).parent/('final-'+label);output.mkdir(exist_ok=True)",
        " final=output/'namespace-stdin.json'",
        " if final.exists():final.unlink()",
        " (output/'namespace-stdin-checkpoint.json').write_text(json.dumps(checkpoint))",
        " (output/'namespace-stdin-perl.json').write_text(json.dumps(export))",
        " import contextlib,io",
        " logs=io.StringIO()",
        " with contextlib.redirect_stdout(logs):status=parent.stdin_finalize(Path.cwd(),output,45,status)",
        " result['finals'].append({'label':label,'status':status,'record':json.loads(final.read_text()),'logs':logs.getvalue()})",
        "print('RESULT '+json.dumps(result))",
      ].join("\n");
      const script = join(directory, "compare.sh");
      fs.writeFileSync(
        script,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          quote(Bun.which("python3")!) +
            " -I -B -c " +
            quote(producer) +
            " " +
            [pythonModule, unshare, checkpoint].map(quote).join(" ") +
            ' "$1"',
          quote(Bun.which("perl")!) +
            " " +
            [perlModule, "stdin", unshare, directory].map(quote).join(" "),
          quote(Bun.which("python3")!) +
            " -I -B -c " +
            quote(post) +
            " " +
            [pythonModule, pair, unshare].map(quote).join(" "),
          ":",
          "",
        ].join("\n"),
      );
      for (const [variant, expected] of [
        ["both-eperm", "stdin-devnull-not-required"],
        ["dependent", "stdin-devnull-dependent"],
        ["passes", "not-reproduced"],
        ["other", "unavailable"],
        ["mixed", "unavailable"],
        ["closed-other", "unavailable"],
      ]) {
        fs.writeFileSync(capture, "");
        fs.writeFileSync(behavior, variant!);
        if (fs.existsSync(pair)) fs.unlinkSync(pair);
        const result = spawnSync("bash", [script, "valid"], {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, HOME: "/home/café", PROBE_ENV_SENTINEL: "public-fixture" },
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const lines = result.stdout.trim().split("\n");
        const {
          pair: data,
          outcome,
          invalid,
          finals,
        } = JSON.parse(lines.at(-1)!.slice("RESULT ".length));
        expect(outcome).toBe(expected);
        expect(data.measurements.devnull.before.environment.HOME).toBe("/home/café");
        for (const item of finals) {
          expect(item.record.measurements.devnull).toBeDefined();
          if (item.label === "valid") {
            expect(item.record.outcome).toBe(expected);
            expect(item.status).toBe(
              expected === "not-reproduced" ? 44 : expected === "unavailable" ? 2 : 43,
            );
          } else {
            expect(item.record.outcome).toBe("unavailable");
            expect(item.status).toBe(2);
            if (item.label === "producer-error") {
              expect(item.record.collectorError.stage).toBe("perl-stdin");
              expect(item.record.collectorError.message).toStartWith("public-producer-marker:");
              expect(item.record.collectorError.message.length).toBe(1024);
              expect(item.record.collectorError.truncated).toBe(true);
              expect(item.logs).toContain("public-producer-marker:");
              expect(item.logs).not.toContain("x".repeat(1025));
            } else expect(item.record.error).toContain("closed測定がobjectではありません");
          }
        }
        const compared = ["both-eperm", "dependent", "closed-other"].includes(variant!);
        const observed = fs
          .readFileSync(capture, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(observed).toHaveLength(compared ? 12 : 6);
        expect(fs.readFileSync(versions, "utf8")).toBe("");
        expect(Object.keys(data.measurements)).toEqual(
          compared ? ["closed", "devnull"] : ["devnull"],
        );
        const baseline = data.measurements.devnull;
        for (const [index, actual] of observed.entries()) {
          const name = index < 6 ? "devnull" : "closed";
          const measured = data.measurements[name];
          const probes = measured.cases.flatMap(
            (scenario: { probes: unknown[] }) => scenario.probes,
          );
          expect(probes.some((probe: { pid: number }) => probe.pid === actual.pid)).toBe(true);
          expect(actual.ppid).toBe(baseline.runtime.pid);
          expect(actual.parent).toBe(fs.realpathSync(Bun.which("perl")!));
          expect(actual.closed).toBe(index >= 6);
          expect(actual.stdin).toBe(index < 6 ? "/dev/null" : null);
          expect(actual.stdinMode).toBe(index < 6 ? 0 : null);
          expect(actual.environmentOk).toBe(true);
          expect(actual.sentinel).toBe(false);
          expect(actual.cwd).toBe("/");
          expect(actual.pipes).toEqual([true, true]);
          expect(actual.flags).toEqual(observed[0].flags);
          expect(actual.fdFlags).toEqual(observed[0].fdFlags);
          expect(actual.links[0]).not.toBe(actual.links[1]);
          expect(measured.forkCount).toBe(6);
          expect(measured.stdinType).toBe(name);
          expect(measured.before).toEqual(measured.after);
        }
        if (compared) {
          expect(data.measurements.closed.runtime).toEqual(baseline.runtime);
          expect(data.measurements.closed.ancestry).toEqual(baseline.ancestry);
          expect(invalid).toEqual(Array(14).fill("unavailable"));
        }
        const logs = lines
          .filter((line) => line.startsWith("[DEBUG-ns-stdin] "))
          .map((line) => JSON.parse(line.slice("[DEBUG-ns-stdin] ".length)));
        expect(logs).toHaveLength(compared ? 14 : 7);
        for (const log of logs) {
          expect(log.parent).toBe("perl");
          expect(["devnull", "closed"]).toContain(log.stdinType);
          if (log.case) expect(log.logTruncated).toBe(false);
        }
      }
      for (const invalid of ["context", "controller"]) {
        fs.writeFileSync(capture, "");
        fs.unlinkSync(pair);
        const rejected = spawnSync("bash", [script, invalid], {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(rejected.status).toBe(2);
        expect(JSON.parse(fs.readFileSync(pair, "utf8")).error).toContain(
          "stdin比較の準備またはcaller",
        );
        expect(fs.readFileSync(capture, "utf8")).toBe("");
      }
      const saved = fs.readFileSync(pair, "utf8");
      const repeated = spawnSync(Bun.which("perl")!, [perlModule, "stdin", unshare, directory], {
        encoding: "utf8",
      });
      expect(repeated.status).toBe(2);
      expect(repeated.stderr).toContain("出力を作成できません");
      expect(fs.readFileSync(pair, "utf8")).toBe(saved);
      expect(fs.statSync(pair).mode & 0o777).toBe(0o600);
    } finally {
      cleanup();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "stdin比較CLIは実VM前提の拒否と途中記録をwx0600で保存する",
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-stdin-partial-"));
    try {
      const output = join(directory, "prepare");
      const run = (args: string[]) =>
        spawnSync(Bun.which("python3")!, ["-I", pythonModule, ...args], {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, ImageOS: "ubuntu22" },
        });
      const prepared = run(["stdin-prepare", root, output]);
      expect(prepared.status).toBe(2);
      const checkpoint = join(output, "namespace-stdin-checkpoint.json");
      const saved = fs.readFileSync(checkpoint, "utf8");
      expect(JSON.parse(saved).error).toContain("Ubuntu 24.04");
      expect(JSON.parse(saved).outcome).toBe("unavailable");
      expect(fs.statSync(checkpoint).mode & 0o777).toBe(0o600);
      const repeated = run(["stdin-prepare", root, output]);
      expect(repeated.status).toBe(2);
      expect(repeated.stdout).toContain("FileExistsError");
      expect(fs.readFileSync(checkpoint, "utf8")).toBe(saved);
      const finalized = run(["stdin-finalize", root, output, "2", "-1"]);
      expect(finalized.status).toBe(2);
      expect(
        JSON.parse(fs.readFileSync(join(output, "namespace-stdin.json"), "utf8")).error,
      ).toContain("Ubuntu 24.04");
      const partial = join(directory, "partial");
      fs.mkdirSync(partial);
      const provenance = {
        identity: { sourceSha: "public-source" },
        controllerHashes: { parent: "public-controller" },
        runtimeHashes: { perl: "public-runtime" },
      };
      fs.writeFileSync(
        join(partial, "namespace-stdin-checkpoint.json"),
        JSON.stringify(provenance),
      );
      fs.writeFileSync(join(partial, "namespace-stdin-perl.json"), "[");
      const broken = run(["stdin-finalize", root, partial, "45", "0"]);
      expect(broken.status).toBe(2);
      const record = JSON.parse(fs.readFileSync(join(partial, "namespace-stdin.json"), "utf8"));
      expect(record.error).toContain("JSONDecodeError");
      for (const [key, value] of Object.entries(provenance)) expect(record[key]).toEqual(value);
      expect(fs.statSync(join(partial, "namespace-stdin.json")).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "stdin準備は版取得前後のhashを照合し途中の実行体交換を拒否する",
  () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "namespace-stdin-version-"));
    try {
      const code = [
        "import importlib.util,json,sys",
        "from pathlib import Path",
        "spec=importlib.util.spec_from_file_location('parent',sys.argv[1])",
        "parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)",
        "base=Path(sys.argv[2]);binary=base/'version-source';binary.write_text('before')",
        "digest=parent.launch.digest",
        "parent.launch.digest=lambda path:digest(binary) if str(path)=='/usr/bin/unshare' else digest(path)",
        "parent.validate=lambda root:{'sourceSha':'public-fixture'}",
        "parent.controller_hashes=lambda:{'parent':'public-controller'}",
        "parent.launch.context=lambda:{'uid':1001}",
        "parent.ancestry=lambda:[]",
        "calls=[]",
        "def capture(executable,argv,*args,**kwargs):",
        " assert executable=='/usr/bin/unshare' and argv==['--version']",
        " calls.append(argv)",
        " if sys.argv[3]=='replace':binary.write_text('after')",
        " return {'status':0,'signal':None,'stdout':'fixture-version\\n','stderr':''}",
        "parent.launch.capture=capture",
        "status=parent.stdin_prepare(Path.cwd(),base/'output')",
        "print('RESULT '+json.dumps({'status':status,'calls':calls,'record':json.loads((base/'output/namespace-stdin-checkpoint.json').read_text())}))",
      ].join("\n");
      for (const variant of ["stable", "replace"]) {
        const scenario = join(directory, variant);
        fs.mkdirSync(scenario);
        const result = spawnSync(
          Bun.which("python3")!,
          ["-I", "-B", "-c", code, pythonModule, scenario, variant],
          { cwd: root, encoding: "utf8", timeout: 10_000 },
        );
        expect(result.status, result.stderr).toBe(0);
        const data = JSON.parse(result.stdout.trim().split("\n").at(-1)!.slice("RESULT ".length));
        expect(data.calls).toEqual([["--version"]]);
        expect(data.status).toBe(variant === "stable" ? 45 : 2);
        expect(data.record.outcome).toBe(variant === "stable" ? "ready" : "unavailable");
        if (variant === "stable") expect(data.record.unshare.version).toBe("fixture-version");
        else {
          expect(data.record.error).toContain("版取得中");
          expect(data.record.unshare).toBeUndefined();
        }
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
