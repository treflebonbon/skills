import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { resolve } from "node:path";
import linuxCorpus from "../fixtures/peer-evidence-python.json";
import macosCorpus from "../fixtures/peer-evidence-macos-python.json";

const corpus: Omit<typeof linuxCorpus, "files"> & {
  files: Record<string, { base64: string; sha256: string }>;
} = process.platform === "darwin" ? macosCorpus : linuxCorpus;

const root = resolve(import.meta.dir, "../..");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const peers = ["herdr-peer-refactor", "orca-peer-refactor"];

beforeAll(() => {
  try {
    fs.mkdirSync("/tmp/codex", { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const shared = fs.lstatSync("/tmp/codex");
  if (!shared.isDirectory() || shared.uid !== process.getuid!())
    throw new Error("テスト共有先は実 owner の directory が必要です");
});

function payloadState(directory: string): string {
  const entries = fs.readdirSync(directory, { recursive: true, encoding: "utf8" }).sort();
  const hashes = entries.map((name) => {
    const path = resolve(directory, name),
      info = fs.lstatSync(path);
    return [
      name,
      info.mode,
      info.isFile()
        ? hash(fs.readFileSync(path))
        : info.isSymbolicLink()
          ? fs.readlinkSync(path)
          : "",
    ];
  });
  return JSON.stringify(hashes);
}

function withCorpus(action: (repo: string) => void): void {
  fs.mkdirSync(corpus.base, { mode: 0o700 });
  try {
    const repo = resolve(corpus.base, "repo");
    fs.mkdirSync(repo);
    const git = (args: string[], input?: string) => {
      const result = spawnSync("git", args, { cwd: repo, input, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git(["init", "-q"]);
    git(["hash-object", "-t", "tree", "-w", "--stdin"], "");
    expect(git(["hash-object", "-t", "commit", "-w", "--stdin"], corpus.commit)).toBe(
      corpus.sourceSha,
    );
    git(["update-ref", "HEAD", corpus.sourceSha]);
    for (const [path, entry] of Object.entries(corpus.files)) {
      const bytes = Buffer.from(entry.base64, "base64");
      expect(hash(bytes)).toBe(entry.sha256);
      fs.mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path, bytes);
    }
    action(repo);
  } finally {
    fs.rmSync(corpus.base, { recursive: true });
  }
}

test("旧 Python の record bytes を両 peer が同じ provenance と候補で検査する", () => {
  withCorpus((repo) => {
    for (const peer of peers) {
      const result = spawnSync(
        resolve(root, `skills/${peer}/scripts/candidate-record`),
        ["check", corpus.recordPath, corpus.candidatesPath, corpus.fingerprint],
        { cwd: repo, encoding: "utf8" },
      );
      expect(result.status, result.stderr || String(result.error)).toBe(0);
    }
  });
});

test("両 peer は旧 checkpoint から元 bytes と receipt を復元し同じ hash を再作成する", () => {
  withCorpus((repo) => {
    const prepared = spawnSync(resolve(root, "bin/prepare-file-safety"), [], { encoding: "utf8" });
    expect(prepared.status, prepared.stderr).toBe(0);
    for (const peer of peers) {
      for (const path of Object.keys(corpus.files).filter((path) => !path.startsWith(repo + "/")))
        fs.unlinkSync(path);
      const script = resolve(root, `skills/${peer}/scripts/run-evidence`);
      const result = spawnSync(script, ["restore", corpus.fingerprint, corpus.checkpoint], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(result.status, result.stderr || String(result.error)).toBe(0);
      for (const [path, entry] of Object.entries(corpus.files))
        expect(hash(fs.readFileSync(path))).toBe(entry.sha256);
      const checkpoint = spawnSync(
        script,
        [
          "checkpoint",
          corpus.recordPath,
          corpus.candidatesPath,
          corpus.fingerprint,
          corpus.receiptPath,
          resolve(corpus.base, "waited-s"),
        ],
        { cwd: repo, encoding: "utf8" },
      );
      expect(checkpoint.status, checkpoint.stderr).toBe(0);
      expect(JSON.parse(checkpoint.stdout).checkpoint).toBe(corpus.checkpoint);
    }
  });
});

test("新 pin は大きな整数・非有限値を保持し、旧 corpus と同じ候補だけを受け入れる", () => {
  withCorpus((repo) => {
    const prepared = spawnSync(resolve(root, "bin/prepare-file-safety"), [], { encoding: "utf8" });
    expect(prepared.status, prepared.stderr).toBe(0);
    for (const peer of peers) {
      const script = resolve(root, `skills/${peer}/scripts/candidate-record`);
      const record = resolve(corpus.base, peer + ".json");
      const result = spawnSync(
        script,
        [
          "pin",
          corpus.artifactPath,
          resolve(repo, ".git"),
          corpus.sourceSha,
          corpus.candidatesPath,
          record,
        ],
        { cwd: repo, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      const raw = fs.readFileSync(record);
      expect(hash(raw)).toBe(result.stdout.trim());
      for (const literal of [
        "9007199254740993",
        "-9007199254740993",
        "NaN",
        "Infinity",
        "-Infinity",
      ])
        expect(raw.toString()).toContain(literal);
      const fingerprint = result.stdout.trim();
      const check = () =>
        spawnSync(script, ["check", record, corpus.candidatesPath, fingerprint], {
          cwd: repo,
          encoding: "utf8",
        });
      expect(check().status).toBe(0);
      const original = fs.readFileSync(corpus.candidatesPath);
      fs.writeFileSync(
        corpus.candidatesPath,
        original.toString().replace("9007199254740993", "9007199254740992"),
      );
      const changed = check();
      expect(changed.status).toBe(1);
      expect(changed.stderr).toContain("候補が固定記録と一致しません");
      fs.writeFileSync(corpus.candidatesPath, original);
      for (const [index, entry] of corpus.cases.entries()) {
        fs.writeFileSync(corpus.candidatesPath, entry.candidates);
        const candidate = spawnSync(
          script,
          [
            "pin",
            corpus.artifactPath,
            resolve(repo, ".git"),
            corpus.sourceSha,
            corpus.candidatesPath,
            resolve(corpus.base, `${peer}-${index}.json`),
          ],
          { cwd: repo, encoding: "utf8" },
        );
        expect(candidate.status, candidate.stderr).toBe(entry.exitCode);
        expect(candidate.stderr).toBe(entry.stderr);
      }
      fs.writeFileSync(corpus.candidatesPath, original);
    }
  });
});

test("record 読込み後の同時置換でも最初に検証した候補を差し替えられない", () => {
  withCorpus((repo) => {
    const script = resolve(root, "skills/orca-peer-refactor/scripts/candidate-record");
    const control = spawnSync(
      script,
      ["check", corpus.recordPath, corpus.candidatesPath, corpus.fingerprint],
      { cwd: repo, encoding: "utf8" },
    );
    expect(control.status, control.stderr).toBe(0);
    const result = spawnSync(
      resolve(root, "lib/bun/run"),
      [
        "run",
        "--preload",
        resolve(root, "tests/fixtures/bun-peer-evidence-fault.ts"),
        script + ".ts",
        "check",
        corpus.recordPath,
        corpus.candidatesPath,
        corpus.fingerprint,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          PEER_FAULT: JSON.stringify(["record-read", corpus.recordPath, corpus.candidatesPath]),
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("候補が固定記録と一致しません");
    expect(hash(fs.readFileSync(corpus.recordPath))).not.toBe(corpus.fingerprint);
  });
});

test("公開証跡の検査後に祖先を symlink へ差し替えても外部の bytes を採用しない", () => {
  withCorpus((repo) => {
    const prepared = spawnSync(resolve(root, "bin/prepare-file-safety"), [], { encoding: "utf8" });
    expect(prepared.status, prepared.stderr).toBe(0);
    const directory = resolve(corpus.base, "ancestor"),
      target = resolve(directory, "public.txt"),
      outside = directory + ".outside";
    fs.mkdirSync(directory);
    fs.mkdirSync(outside);
    fs.writeFileSync(target, "inside");
    fs.writeFileSync(resolve(outside, "public.txt"), "outside");
    const args = [
      "checkpoint",
      corpus.recordPath,
      corpus.candidatesPath,
      corpus.fingerprint,
      target,
    ];
    const script = resolve(root, "skills/orca-peer-refactor/scripts/run-evidence");
    const control = spawnSync(script, args, { cwd: repo, encoding: "utf8" });
    expect(control.status, control.stderr).toBe(0);
    const saved = JSON.parse(fs.readFileSync(JSON.parse(control.stdout).path, "utf8"));
    expect(Buffer.from(saved.files[target], "base64").toString()).toBe("inside");
    const result = spawnSync(
      resolve(root, "lib/bun/run"),
      [
        "run",
        "--preload",
        resolve(root, "tests/fixtures/bun-peer-evidence-fault.ts"),
        script + ".ts",
        ...args,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, PEER_FAULT: JSON.stringify(["ancestor-read", target, directory]) },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("証跡のパスを安全に開けません");
    expect(fs.readFileSync(resolve(outside, "public.txt"), "utf8")).toBe("outside");
    expect(fs.readFileSync(resolve(directory + ".moved", "public.txt"), "utf8")).toBe("inside");
    expect(fs.lstatSync(directory).isSymbolicLink()).toBe(true);
  });
});

test("Python・compiler・node_modules がない読み取り専用 payload で probe を実行し、設定混入と書込みを防ぐ", () => {
  withCorpus((repo) => {
    const directory = fs.mkdtempSync(resolve(corpus.base, "runtime-"));
    const payload = resolve(directory, "payload"),
      cache = resolve(directory, "cache"),
      commands = resolve(directory, "bin"),
      poison = resolve(directory, "poison");
    fs.mkdirSync(resolve(payload, "lib"), { recursive: true });
    fs.cpSync(resolve(root, "lib/bun"), resolve(payload, "lib/bun"), { recursive: true });
    for (const peer of peers) {
      const scripts = resolve(payload, `skills/${peer}/scripts`);
      fs.mkdirSync(scripts, { recursive: true });
      for (const name of [
        "candidate-record",
        "candidate-record.ts",
        "run-evidence",
        "run-evidence.ts",
      ])
        fs.copyFileSync(resolve(root, `skills/${peer}/scripts/${name}`), resolve(scripts, name));
    }
    fs.mkdirSync(commands);
    fs.mkdirSync(poison);
    for (const [name, executable] of [
      ["bun", process.execPath],
      ...["bash", "git", "dirname", "readlink"].map((name) => [name, Bun.which(name)!]),
    ] as [string, string][])
      fs.symlinkSync(fs.realpathSync(executable), resolve(commands, name));
    const marker = resolve(poison, "preload-ran");
    const preload = resolve(poison, "preload.ts");
    fs.writeFileSync(
      preload,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unexpected");`,
    );
    fs.writeFileSync(
      resolve(repo, "bunfig.toml"),
      `preload = [${JSON.stringify(preload)}]\n[install]\nauto = "force"\n`,
    );
    fs.writeFileSync(resolve(repo, ".env"), "PEER_POISON=loaded\n");
    const env = { ...process.env, TREFLEBONBON_FILE_SAFETY_DIR: cache };
    const prepared = spawnSync(resolve(root, "bin/prepare-file-safety"), [], {
      env,
      encoding: "utf8",
    });
    expect(prepared.status, prepared.stderr).toBe(0);
    const paths = [
      payload,
      ...fs
        .readdirSync(payload, { recursive: true, encoding: "utf8" })
        .map((name) => resolve(payload, name)),
    ];
    for (const path of paths)
      fs.chmodSync(
        path,
        fs.statSync(path).isDirectory() ||
          ["run", "candidate-record", "run-evidence"].some((name) => path.endsWith("/" + name))
          ? 0o555
          : 0o444,
      );
    const before = payloadState(payload);
    try {
      for (const peer of peers) {
        const result = spawnSync(
          resolve(payload, `skills/${peer}/scripts/run-evidence`),
          [
            "probe",
            corpus.recordPath,
            corpus.candidatesPath,
            corpus.fingerprint,
            "0123456789abcdef",
            resolve(directory, peer + "-probe.json"),
          ],
          {
            cwd: repo,
            encoding: "utf8",
            env: {
              ...env,
              PATH: commands,
              HOME: poison,
              BUN_OPTIONS: `--preload=${preload}`,
              NODE_OPTIONS: `--require=${preload}`,
              BASH_ENV: preload,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).command).toEqual([
          resolve(payload, `skills/${peer}/scripts/candidate-record`),
          "check",
          corpus.recordPath,
          corpus.candidatesPath,
          corpus.fingerprint,
        ]);
      }
      expect(fs.existsSync(marker)).toBe(false);
      expect(payloadState(payload)).toBe(before);
    } finally {
      for (const path of paths) if (fs.statSync(path).isDirectory()) fs.chmodSync(path, 0o700);
    }
  });
});

for (const damage of [
  "missing",
  "binary",
  "symlink",
  "mode",
  "directory",
  "manifest-symlink",
  "platform",
]) {
  test(`native cache の ${damage} を拒否し、自動 build や修復を行わない`, () => {
    withCorpus((repo) => {
      const cache = fs.mkdtempSync(resolve(corpus.base, "native-"));
      const env = { ...process.env, TREFLEBONBON_FILE_SAFETY_DIR: cache };
      const prepared = spawnSync(resolve(root, "bin/prepare-file-safety"), [], {
        env,
        encoding: "utf8",
      });
      expect(prepared.status, prepared.stderr).toBe(0);
      const folder = prepared.stdout.trim(),
        binary = resolve(folder, "file-safety.node"),
        manifest = resolve(folder, "build.json");
      const run = (suffix: string) =>
        spawnSync(
          resolve(root, "skills/orca-peer-refactor/scripts/run-evidence"),
          [
            "probe",
            corpus.recordPath,
            corpus.candidatesPath,
            corpus.fingerprint,
            "0123456789abcdef",
            resolve(corpus.base, suffix + ".json"),
          ],
          { cwd: repo, env, encoding: "utf8" },
        );
      const control = run("control");
      expect(control.status, control.stderr).toBe(0);
      if (damage === "missing") fs.renameSync(folder, folder + ".saved");
      else if (damage === "binary") {
        fs.chmodSync(binary, 0o700);
        fs.appendFileSync(binary, "changed");
      } else if (damage === "mode") fs.chmodSync(binary, 0o777);
      else if (damage === "directory") fs.chmodSync(folder, 0o755);
      else if (damage === "platform") {
        const record = JSON.parse(fs.readFileSync(manifest, "utf8"));
        record.platform = "other";
        fs.writeFileSync(manifest, JSON.stringify(record));
      } else {
        const target = damage === "symlink" ? binary : manifest;
        fs.renameSync(target, target + ".saved");
        fs.symlinkSync(target + ".saved", target);
      }
      const before = payloadState(cache);
      const rejected = run("rejected");
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("bin/prepare-file-safety を明示実行");
      expect(fs.existsSync(resolve(corpus.base, "rejected.json"))).toBe(false);
      expect(payloadState(cache)).toBe(before);
    });
  }, 45_000); // 明示 build の30秒上限に、CLI の成功・拒否対照の時間を加える。
}

for (const fault of [
  "chmod",
  "write",
  "close",
  "second",
  "concurrent",
  "replaced",
  "symlink",
  "directory",
  "unreadable",
]) {
  test(`復元の ${fault} 失敗は作成分を戻し、別 writer の結果を保持する`, () => {
    withCorpus((repo) => {
      const prepared = spawnSync(resolve(root, "bin/prepare-file-safety"), [], {
        encoding: "utf8",
      });
      expect(prepared.status, prepared.stderr).toBe(0);
      // 旧 checkpoint の files 順を使い、実際に作成する宛先と assertion を対応させる。
      const archive = JSON.parse(
        Buffer.from(
          Object.entries(corpus.files).find(([path]) => path.startsWith(repo + "/"))![1].base64,
          "base64",
        ).toString(),
      );
      const paths = Object.keys(archive.files);
      const [first, second] = paths as [string, string];
      for (const path of paths) fs.unlinkSync(path);
      const result = spawnSync(
        resolve(root, "lib/bun/run"),
        [
          "run",
          "--preload",
          resolve(root, "tests/fixtures/bun-peer-evidence-fault.ts"),
          resolve(root, "skills/orca-peer-refactor/scripts/run-evidence.ts"),
          "restore",
          corpus.fingerprint,
          corpus.checkpoint,
        ],
        {
          cwd: repo,
          encoding: "utf8",
          env: { ...process.env, PEER_FAULT: JSON.stringify([fault, first, second]) },
        },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        fault === "concurrent"
          ? "上書きしません"
          : `injected ${["second", "replaced", "symlink", "directory", "unreadable"].includes(fault) ? "second-file" : fault} failure`,
      );
      if (fault === "concurrent") expect(fs.readFileSync(second, "utf8")).toBe("newer evidence");
      else if (fault === "replaced") expect(fs.readFileSync(first, "utf8")).toBe("newer evidence");
      else if (fault === "symlink") expect(fs.lstatSync(first).isSymbolicLink()).toBe(true);
      else if (fault === "directory") expect(fs.lstatSync(first).isDirectory()).toBe(true);
      const preserved =
        fault === "concurrent"
          ? second
          : ["replaced", "symlink", "directory"].includes(fault)
            ? first
            : undefined;
      for (const path of paths.filter((path) => path !== preserved))
        expect(fs.existsSync(path), path).toBe(false);
      if (preserved) fs.rmSync(preserved, { recursive: true });
      // 同じ fixture を失敗注入なしで復元できる対照。
      const control = spawnSync(
        resolve(root, "skills/orca-peer-refactor/scripts/run-evidence"),
        ["restore", corpus.fingerprint, corpus.checkpoint],
        { cwd: repo, encoding: "utf8" },
      );
      expect(control.status, control.stderr).toBe(0);
      for (const path of paths)
        expect(hash(fs.readFileSync(path))).toBe(
          corpus.files[path as keyof typeof corpus.files].sha256,
        );
    });
  });
}
