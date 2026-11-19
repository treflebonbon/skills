import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const helper = join(root, "development/probe-linux-namespace-uid-write.py");

function childFixture(variant: string, mode = "map") {
  const code = [
    "import importlib.util,json,os,sys",
    "spec=importlib.util.spec_from_file_location('uid_write',sys.argv[1])",
    "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)",
    "variant=sys.argv[2];mode=sys.argv[3];calls=[]",
    "m.os.getuid=lambda:0 if variant=='root' else 1001",
    "m.os.geteuid=lambda:1002 if variant=='caller' else 0 if variant=='root' else 1001",
    "m.os.getcwd=lambda:'/'",
    "def unsetenv(key):",
    " assert key=='LC_CTYPE';calls.append(['unsetenv',key])",
    "def unshare(flags):",
    " assert flags==268435456;calls.append(['unshare',flags])",
    " if variant=='unshare':raise OSError(m.errno.EPERM,'public-unshare')",
    "def opened(path,flags):",
    " assert path=='/proc/self/uid_map' and flags==os.O_WRONLY|os.O_CLOEXEC",
    " calls.append(['open',path,flags])",
    " if variant=='open':raise OSError(m.errno.EPERM,'public-open')",
    " return 0",
    "def written(fd,value):",
    " assert fd==0 and value==b'1001 1001 1\\n';calls.append(['write',fd,value.decode('ascii')])",
    " if variant=='write':raise OSError(m.errno.EPERM,'public-write')",
    " if variant=='other':raise OSError(m.errno.EINVAL,'public-other')",
    " return 1 if variant=='short' else len(value)",
    "def closed(fd):",
    " assert fd==0;calls.append(['close',fd])",
    " if variant=='close':raise OSError(m.errno.EIO,'public-close')",
    "m.os.unsetenv=unsetenv;m.os.unshare=unshare;m.os.open=opened;m.os.write=written;m.os.close=closed",
    "record,status=m.child(mode,1001)",
    "print(json.dumps({'record':record,'status':status,'calls':calls}))",
  ].join("\n");
  const result = spawnSync("python3", ["-I", "-B", "-c", code, helper, variant, mode], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

test.skipIf(process.platform !== "linux")(
  "直接UID-map probeは成功・作成・open・writeの失敗を混同せずfd 0を閉じる",
  () => {
    const passed = childFixture("passed");
    expect(passed.status).toBe(0);
    expect(passed.record.outcome).toBe("passed");
    expect(passed.record.uid).toBe(1001);
    expect(passed.record.euid).toBe(1001);
    expect(passed.record.steps).toEqual([
      { operation: "unshare", outcome: "passed" },
      { operation: "open", outcome: "passed" },
      { operation: "write", outcome: "passed", written: 12 },
    ]);
    expect(passed.calls).toEqual([
      ["unsetenv", "LC_CTYPE"],
      ["unshare", 268435456],
      ["open", "/proc/self/uid_map", 524289],
      ["write", 0, "1001 1001 1\n"],
      ["close", 0],
    ]);
    for (const stage of ["unshare", "open", "write"]) {
      const failed = childFixture(stage);
      expect(failed.status).toBe(1);
      expect(failed.record.outcome).toBe("failed");
      expect(failed.record.steps.at(-1)).toEqual({
        operation: stage,
        outcome: "failed",
        errno: 1,
        error: "EPERM",
      });
      expect(failed.calls.filter((row: any) => row[0] === "close")).toEqual(
        stage === "write" ? [["close", 0]] : [],
      );
      expect(failed.calls.some((row: any) => row[0] === "write")).toBe(stage === "write");
    }
    const other = childFixture("other");
    expect(other.record.steps.at(-1)).toEqual({
      operation: "write",
      outcome: "failed",
      errno: 22,
      error: "EINVAL",
    });
    const short = childFixture("short");
    expect(short.status).toBe(2);
    expect(short.record.error).toContain("UID-mapのwriteが完了していません");
    expect(short.calls.at(-1)).toEqual(["close", 0]);
    const closed = childFixture("close");
    expect(closed.status).toBe(2);
    expect(closed.record.cleanupError).toBe("EIO");
  },
);

test.skipIf(process.platform !== "linux")(
  "直接の成功対照はnamespace作成だけでmapを開かず、不正callerも起動前に拒否する",
  () => {
    const control = childFixture("passed", "control");
    expect(control.status).toBe(0);
    expect(control.record.steps).toEqual([{ operation: "unshare", outcome: "passed" }]);
    expect(control.calls).toEqual([
      ["unsetenv", "LC_CTYPE"],
      ["unshare", 268435456],
    ]);
    for (const variant of ["root", "caller"]) {
      const failed = childFixture(variant);
      expect(failed.status).toBe(2);
      expect(failed.record.error).toContain("直接UID-map probeのcaller条件が不正です");
      expect(failed.calls).toEqual([]);
    }
  },
);

test("直接UID-map modeだけが既存UID基準の後に接続され、監査を要求しない", () => {
  const workflow = fs.readFileSync(join(root, ".github/workflows/linux-process-proof.yml"), "utf8");
  expect(workflow).toContain("          - probe-uid-write");
  expect(workflow).toContain("inputs.mode == 'probe-uid-write' && 'namespace-uid-write'");
  expect(workflow).toContain("&& inputs.mode != 'probe-uid-write'");
  expect(workflow).toContain("|| inputs.mode == 'probe-uid-write'");
  const audit = workflow
    .split("- name: Bash直接の失敗PIDに対応するkernel監査を非rootで取得\n")[1]!
    .split("      - name: ")[0]!;
  expect(audit.match(/^\s+if:\s*(.+)$/m)?.[1]).toBe(
    "always() && inputs.mode == 'probe-bash-audit'",
  );
});
