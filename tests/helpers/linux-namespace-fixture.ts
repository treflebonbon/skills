import * as fs from "node:fs";
import { join } from "node:path";

/** 一条件ずつの比較で、同じ子の観測形式を使う。 */
export function createUnshareFixture(
  directory: string,
  node: string,
  dependentOn: "cwd" | "stdout" | "stderr" | { parent: string },
) {
  const capture = join(directory, "capture.jsonl");
  const behavior = join(directory, "behavior");
  const versionCapture = join(directory, "versions");
  fs.writeFileSync(versionCapture, "");
  const unshare = join(directory, "unshare.mjs");
  fs.writeFileSync(
    unshare,
    [
      "#!/usr/bin/env -S " + JSON.stringify(node).replaceAll("$", "\\$"),
      'import * as fs from "node:fs";',
      'if (process.argv[2] === "--version") { fs.appendFileSync(' +
        JSON.stringify(versionCapture) +
        ',"version\\n"); console.log("fixture-unshare"); process.exit(0); }',
      "const capture = " + JSON.stringify(capture) + ";",
      "const behavior = fs.readFileSync(" + JSON.stringify(behavior) + ', "utf8");',
      'const count = fs.readFileSync(capture,"utf8").trim().split("\\n").filter(Boolean).length;',
      "const outPipe = fs.fstatSync(1).isFIFO();",
      "const errPipe = fs.fstatSync(2).isFIFO();",
      'const parent = fs.realpathSync("/proc/"+process.ppid+"/exe");',
      'fs.appendFileSync(capture,JSON.stringify({pid:process.pid,ppid:process.ppid,cwd:process.cwd(),keys:Object.keys(process.env).length,sentinel:process.env.PROBE_ENV_SENTINEL==="public-fixture",stdinNull:fs.readlinkSync("/proc/self/fd/0")==="/dev/null",stdioFlags:[0,1,2].map(fd=>fs.readFileSync("/proc/self/fdinfo/"+fd,"utf8").match(/^flags:\\s+(.*)$/m)[1]),outSocket:fs.fstatSync(1).isSocket(),outPipe,errSocket:fs.fstatSync(2).isSocket(),errPipe,parent,stdioLinks:[0,1,2].map(fd=>fs.readlinkSync("/proc/self/fd/"+fd))})+"\\n");',
      'if (process.argv[2]==="--map-current-user" && behavior!=="passes") {',
      ' if (behavior==="dependent" && ' +
        (dependentOn === "cwd"
          ? 'process.cwd()==="/"'
          : typeof dependentOn === "object"
            ? "parent===" + JSON.stringify(dependentOn.parent)
            : dependentOn === "stdout"
              ? "outPipe"
              : "errPipe") +
        ") process.exit(0);",
      ' if (behavior==="mixed" && count===1) process.exit(0);',
      ' process.stderr.write(behavior==="other" ? "unshare: other failure\\n" : "unshare: write failed /proc/self/uid_map: Operation not permitted\\n");',
      " process.exitCode=1;",
      "}",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return { capture, behavior, unshare, versionCapture };
}
