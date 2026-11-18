import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const helper = resolve(import.meta.dir, "../helpers/process-state.ts");

test.skipIf(process.platform !== "linux")(
  "PID 生存確認は ps の遅延に依存せず、終了済みの所有子を生存扱いしない",
  () => {
    const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "process-state-"));
    try {
      const calls = join(directory, "ps-calls");
      const reader = join(directory, "reader.ts");
      fs.writeFileSync(
        join(directory, "ps"),
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " +
          JSON.stringify(calls) +
          "\nsleep 1\nprintf 'S\\n'\nexit 0\n",
        { mode: 0o700 },
      );
      fs.writeFileSync(
        reader,
        [
          "import {stateOf} from " + JSON.stringify(helper) + ";",
          "const child=Bun.spawn([process.execPath,'-e','process.exit(0)'],{stdout:'ignore',stderr:'ignore'});",
          "await child.exited;",
          "console.log(JSON.stringify({live:stateOf(process.pid),reaped:stateOf(child.pid)}));",
        ].join("\n"),
      );
      const environment = { ...process.env, PATH: directory + ":" + process.env.PATH };
      const control = spawnSync("ps", ["-o", "stat=", "-p", String(process.pid)], {
        encoding: "utf8",
        env: environment,
        timeout: 3000,
      });
      expect(control.status).toBe(0);
      expect(control.stdout).toBe("S\n");
      expect(control.stderr).toBe("");
      expect(fs.readFileSync(calls, "utf8")).toBe(`-o stat= -p ${process.pid}\n`);
      fs.unlinkSync(calls);
      const result = spawnSync(process.execPath, [reader], {
        encoding: "utf8",
        env: environment,
        timeout: 5000,
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ live: true, reaped: false });
      expect(fs.existsSync(calls)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("process group は指定 PGID の非 zombie を照合し、ps の観測失敗を区別する", () => {
  const directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "process-group-state-"));
  try {
    const calls = join(directory, "ps-calls");
    const reader = join(directory, "reader.ts");
    fs.writeFileSync(
      join(directory, "ps"),
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " +
        JSON.stringify(calls) +
        '\nprintf \'%s\' "$FIXTURE_PS_OUTPUT"\nexit "$FIXTURE_PS_STATUS"\n',
      { mode: 0o700 },
    );
    fs.writeFileSync(
      reader,
      "import {stateOf} from " +
        JSON.stringify(helper) +
        ";\ntry{console.log(JSON.stringify({alive:stateOf(-4242)}))}" +
        "catch(error){console.error(error.message);process.exitCode=1}\n",
    );
    const check = (output: string, status = "0") =>
      spawnSync(process.execPath, [reader], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: directory + ":" + process.env.PATH,
          FIXTURE_PS_OUTPUT: output,
          FIXTURE_PS_STATUS: status,
        },
        timeout: 5000,
      });
    for (const [output, alive] of [
      ["4242 Z\n4243 S\n", false],
      ["4242 Z\n4242 S\n", true],
    ] as const) {
      const result = check(output);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({ alive });
    }
    const malformed = check("unknown\n");
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("process group の状態を解釈できません");
    const failure = check("", "2");
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain("process の状態を観測できません");
    expect(failure.stderr).toContain('"status":2');
    expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toEqual(
      Array(4).fill("-A -o pgid=,stat="),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
