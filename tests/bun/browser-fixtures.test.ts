import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { resolve, dirname } from "node:path";
import corpus from "../fixtures/quality-python.json";

const root = resolve(import.meta.dir, "../..");
type SnapshotInput = {
  path: string;
  mode: number;
  kind: string;
  target?: string;
  pathBase64?: string;
  targetBase64?: string;
  base64?: string;
  patternBase64?: string;
  repeat?: number;
};
function snapshots(cases: typeof corpus.snapshot.cases) {
  fs.mkdirSync("/tmp/codex", { recursive: true, mode: 0o700 });
  const shared = fs.lstatSync("/tmp/codex");
  if (!shared.isDirectory() || shared.uid !== process.getuid!())
    throw Error("/tmp/codex は実行ユーザー所有の通常 directory が必要です");
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/codex/quality-snapshot-50-"));
  try {
    for (const item of cases) {
      const base = resolve(directory, item.name),
        payload = resolve(base, "payload");
      fs.mkdirSync(payload, { recursive: true, mode: item.rootMode });
      fs.chmodSync(payload, item.rootMode);
      for (const input of item.inputs as SnapshotInput[]) {
        const path = input.pathBase64
          ? Buffer.concat([Buffer.from(payload + "/"), Buffer.from(input.pathBase64, "base64")])
          : resolve(payload, input.path);
        fs.mkdirSync(dirname(resolve(payload, input.path)), { recursive: true });
        if (input.kind === "directory") fs.mkdirSync(path, { recursive: true, mode: input.mode });
        else if (input.kind === "symlink")
          fs.symlinkSync(
            input.targetBase64 ? Buffer.from(input.targetBase64, "base64") : input.target!,
            path,
          );
        else if (input.kind === "fifo") {
          const fifo = resolve(base, "fifo");
          const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
          expect(created.status, created.stderr).toBe(0);
          fs.renameSync(fifo, path);
        } else {
          const data =
            input.base64 !== undefined
              ? Buffer.from(input.base64, "base64")
              : Buffer.from(
                  Buffer.from(input.patternBase64!, "base64").toString().repeat(input.repeat!),
                );
          fs.writeFileSync(path, data);
        }
        if (input.kind !== "symlink") fs.chmodSync(path, input.mode);
      }
      const alias = resolve(base, "alias");
      fs.symlinkSync("payload", alias);
      const checked = spawnSync(
        resolve(root, "lib/bun/run"),
        [
          "run",
          resolve(root, "skills/dogfood/tests/helpers/payload-snapshot.ts"),
          item.name === "alias" ? alias : payload,
        ],
        { cwd: base, encoding: "utf8", timeout: 10_000 },
      );
      expect(checked.status, checked.stderr).toBe(item.status);
      expect(checked.stdout, item.name).toBe(Buffer.from(item.stdout, "base64").toString());
      expect(checked.stderr, item.name).toBe(item.stderr);
    }
  } finally {
    for (const item of cases)
      for (const input of item.inputs)
        if (input.kind === "directory") {
          const path = resolve(directory, item.name, "payload", input.path);
          if (fs.existsSync(path)) fs.chmodSync(path, 0o700);
        }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("payload snapshot は旧 CLI の bytes・mode・Unicode 順序と非通常ファイルを維持する", () =>
  snapshots(corpus.snapshot.cases.filter((item) => item.name !== "raw-names")));

test.skipIf(process.platform !== "linux")(
  "Linux の raw filename と link target は旧 surrogateescape を維持する",
  () => snapshots(corpus.snapshot.cases.filter((item) => item.name === "raw-names")),
);
