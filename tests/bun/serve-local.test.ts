import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  closeSync,
  existsSync,
  lstatSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import corpus from "../fixtures/loopback-python.json";

const root = resolve(import.meta.dir, "../..");
const entry = resolve(root, "bin/serve-local");

async function response(port: number, path: string, method = "GET") {
  return await new Promise<{
    status: number;
    body: Buffer;
    location?: string;
    type?: string;
    length?: string;
  }>((accept, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("error", reject);
      res.on("end", () =>
        accept({
          status: res.statusCode!,
          body: Buffer.concat(chunks),
          location: res.headers.location,
          type: res.headers["content-type"],
          length: res.headers["content-length"],
        }),
      );
    });
    req.on("error", reject);
    req.setTimeout(2_000, () => req.destroy(new Error("HTTP の応答期限を超えました")));
    req.end();
  });
}

async function withServer(
  directory: string,
  use: (ready: { url: string; root: string }, child: ReturnType<typeof Bun.spawn>) => Promise<void>,
  executable = entry,
  env = process.env,
  cwd = root,
) {
  const child = Bun.spawn([executable, directory, "0"], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const errors = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  try {
    let line = "";
    while (!line.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`server を起動できません: ${await errors}`);
      line += new TextDecoder().decode(chunk.value);
    }
    await use(JSON.parse(line.split("\n")[0]!), child);
  } finally {
    reader.releaseLock();
    if (child.exitCode === null) child.kill();
    await child.exited;
    clearTimeout(timer);
  }
  expect(await errors).toBe("");
}

test("明示した専用 root の report を loopback HTTP で返す", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "serve-local-"));
  const documentRoot = resolve(directory, "root");
  mkdirSync(documentRoot, { mode: 0o700 });
  writeFileSync(resolve(documentRoot, "report.html"), "<h1>report</h1>\n");
  try {
    await withServer(documentRoot, async (ready) => {
      const url = new URL(ready.url);
      expect(url.hostname).toBe("127.0.0.1");
      const result = await response(Number(url.port), "/report.html");
      expect(result.status).toBe(200);
      expect(result.body.toString()).toBe("<h1>report</h1>\n");
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("不正な引数・directory 以外の root・使用中 port を拒否して既存 server を保持する", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "serve-local-errors-"));
  const file = resolve(directory, "file");
  writeFileSync(file, "file\n");
  const occupied = createServer((_req, res) => res.end("existing-server\n"));
  try {
    for (const args of [
      [],
      [directory],
      [directory, "-1"],
      [directory, "65536"],
      [directory, "NaN"],
      [directory, "0", "--bind", "0.0.0.0"],
    ]) {
      const result = spawnSync(entry, args, { encoding: "utf8", timeout: 5_000 });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("エラー: 使い方: serve-local <document-root> <port: 0-65535>\n");
    }
    const invalidRoot = spawnSync(entry, [file, "0"], { encoding: "utf8", timeout: 5_000 });
    expect(invalidRoot.status).toBe(1);
    expect(invalidRoot.stderr).toBe("エラー: document root は directory を指定してください\n");
    await new Promise<void>((accept) => occupied.listen(0, "127.0.0.1", accept));
    const address = occupied.address();
    if (!address || typeof address === "string")
      throw new Error("対照 server の port がありません");
    const busy = spawnSync(entry, [directory, String(address.port)], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(busy.status).toBe(1);
    expect(busy.stdout).toBe("");
    expect(busy.stderr).toContain("EADDRINUSE");
    expect((await response(address.port, "/")).body.toString()).toBe("existing-server\n");
  } finally {
    occupied.close();
    occupied.closeAllConnections();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("不正な URL と FIFO を拒否した後も同じ server が通常ファイルを返す", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "serve-local-invalid-"));
  writeFileSync(resolve(directory, "file.txt"), "inside\n");
  expect(spawnSync("mkfifo", [resolve(directory, "fifo")]).status).toBe(0);
  try {
    await withServer(directory, async (ready) => {
      const port = Number(new URL(ready.url).port);
      for (const path of ["/%00", "/%FF", "/%", "/fifo"]) {
        const result = await response(port, path);
        expect(result.status).toBe(404);
        expect(result.body.toString()).toBe("見つかりません\n");
      }
      expect((await response(port, "/file.txt")).body.toString()).toBe("inside\n");
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Python と node_modules がない読み取り専用 payload を symlink 経由で使い、preload と書込みを防ぐ", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "serve-local-payload-"));
  const payload = resolve(directory, "payload");
  const poison = resolve(directory, "poison");
  const documentRoot = resolve(directory, "document-root");
  mkdirSync(poison);
  mkdirSync(documentRoot, { mode: 0o700 });
  writeFileSync(resolve(documentRoot, "index.html"), "<h1>sheet</h1>\n");
  const marker = resolve(directory, "preload-ran");
  writeFileSync(
    resolve(poison, "preload.ts"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "injected");`,
  );
  for (const name of ["bunfig.toml", ".bunfig.toml"])
    writeFileSync(resolve(poison, name), 'preload = ["./preload.ts"]\n');
  const files = [
    "bin/serve-local",
    "lib/bun/run",
    "lib/bun/serve-local.ts",
    "lib/bun/tsconfig.json",
    "lib/bun/bunfig.toml",
  ];
  for (const name of files) {
    const destination = resolve(payload, name);
    mkdirSync(resolve(destination, ".."), { recursive: true });
    copyFileSync(resolve(root, name), destination);
    chmodSync(destination, name === "bin/serve-local" || name === "lib/bun/run" ? 0o555 : 0o444);
  }
  const directories = [
    payload,
    ...readdirSync(payload, { recursive: true, encoding: "utf8" })
      .map((name) => resolve(payload, name))
      .filter((path) => lstatSync(path).isDirectory()),
  ];
  for (const path of directories) chmodSync(path, 0o555);
  const snapshot = () =>
    readdirSync(payload, { recursive: true, encoding: "utf8" })
      .sort()
      .map((name) => {
        const path = resolve(payload, name);
        const stat = lstatSync(path);
        return [name, stat.mode, stat.isFile() ? readFileSync(path).toString("base64") : null];
      });
  const before = snapshot();
  const commands = resolve(directory, "bin");
  mkdirSync(commands);
  for (const [name, command] of [
    ["bun", process.execPath],
    ["dirname", Bun.which("dirname")!],
    ["readlink", Bun.which("readlink")!],
  ])
    symlinkSync(realpathSync(command!), resolve(commands, name!));
  const executable = resolve(directory, "serve-local");
  symlinkSync(resolve(payload, "bin/serve-local"), executable);
  const env = {
    ...process.env,
    PATH: commands,
    HOME: poison,
    XDG_CONFIG_HOME: poison,
    BUN_OPTIONS: `--preload=${resolve(poison, "preload.ts")}`,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: resolve(payload, "forbidden-cache"),
  };
  try {
    expect(
      (spawnSync("python3", ["--version"], { env }).error as NodeJS.ErrnoException)?.code,
    ).toBe("ENOENT");
    await withServer(
      documentRoot,
      async (ready) => {
        expect((await response(Number(new URL(ready.url).port), "/")).body.toString()).toBe(
          "<h1>sheet</h1>\n",
        );
      },
      executable,
      env,
      poison,
    );
    expect(existsSync(marker)).toBe(false);
    expect(snapshot()).toEqual(before);
  } finally {
    for (const path of directories) chmodSync(path, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("親参照と root 外を指す symlink は配信せず、root 内のファイルは返す", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "serve-local-boundary-"));
  const documentRoot = resolve(directory, "root");
  mkdirSync(documentRoot, { mode: 0o700 });
  writeFileSync(resolve(documentRoot, "inside.txt"), "inside\n");
  writeFileSync(resolve(directory, "outside.txt"), "outside-canary\n");
  symlinkSync(resolve(directory, "outside.txt"), resolve(documentRoot, "outside-link"));
  mkdirSync(resolve(documentRoot, "nested"));
  symlinkSync(resolve(directory, "outside.txt"), resolve(documentRoot, "nested/index.html"));
  try {
    await withServer(documentRoot, async (ready) => {
      const port = Number(new URL(ready.url).port);
      expect((await response(port, "/inside.txt")).body.toString()).toBe("inside\n");
      for (const path of ["/../outside.txt", "/%2e%2e/outside.txt", "/outside-link", "/nested/"]) {
        const result = await response(port, path);
        expect(result.status).toBe(404);
        expect(result.body.toString()).toBe("見つかりません\n");
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("質問シートの同じ URL が次の round を返し、所有 process の終了後は配信しない", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "serve-local-round-"));
  writeFileSync(resolve(directory, "index.html"), "<h1>round r1</h1>\n");
  mkdirSync(resolve(directory, "nested"));
  writeFileSync(resolve(directory, "nested/index.html"), "<h1>nested</h1>\n");
  try {
    await withServer(directory, async (ready, child) => {
      const port = Number(new URL(ready.url).port);
      expect((await response(port, "/")).body.toString()).toBe("<h1>round r1</h1>\n");
      const redirect = await response(port, "/nested?round=1");
      expect(redirect.status).toBe(301);
      expect(redirect.location).toBe("/nested/?round=1");
      expect((await response(port, "/nested/")).body.toString()).toBe("<h1>nested</h1>\n");
      writeFileSync(resolve(directory, "index.html"), "<h1>round r2</h1>\n");
      expect((await response(port, "/")).body.toString()).toBe("<h1>round r2</h1>\n");
      child.kill("SIGTERM");
      await child.exited;
      await expect(response(port, "/")).rejects.toThrow();
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("旧 HTTP corpus を照合し、root 外 symlink と index のない directory は公開しない", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "serve-local-corpus-"));
  const documentRoot = resolve(directory, "root");
  mkdirSync(documentRoot, { mode: 0o700 });
  for (const [name, value] of Object.entries(corpus.files)) {
    const path = resolve(documentRoot, name);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, Buffer.from(value, "base64"));
  }
  mkdirSync(resolve(documentRoot, "empty"));
  writeFileSync(resolve(directory, "outside.txt"), "outside-canary\n");
  mkdirSync(resolve(directory, "other-session"));
  writeFileSync(resolve(directory, "other-session/sheet.html"), "other-session-canary\n");
  for (const [name, target] of [
    ["inside-link", resolve(documentRoot, "asset.txt")],
    ["outside-link", resolve(directory, "outside.txt")],
    ["outside-dir", resolve(directory, "other-session")],
    ["dangling-link", resolve(directory, "missing")],
  ])
    symlinkSync(target!, resolve(documentRoot, name!));
  const restricted = new Set(["outside-symlink", "outside-directory-symlink", "directory-listing"]);
  try {
    await withServer(documentRoot, async (ready) => {
      const port = Number(new URL(ready.url).port);
      for (const item of corpus.cases) {
        if (item.name === "refresh-same-url")
          writeFileSync(resolve(documentRoot, "index.html"), "<h1>round r2</h1>\n");
        const result = await response(port, item.path, item.method);
        expect(result.status, item.name).toBe(restricted.has(item.name) ? 404 : item.status);
        if (result.status === 200) {
          expect(result.body.toString("base64"), item.name).toBe(item.bodyBase64);
          expect(result.type?.split(";")[0], item.name).toBe(item.contentType!.split(";")[0]);
        } else if (result.status === 301) {
          expect(result.location).toBe(item.location!);
          expect(new URL(result.location!, ready.url).origin).toBe(new URL(ready.url).origin);
        } else {
          expect(result.body.toString()).toBe(
            result.status === 501 ? "未対応の method です\n" : "見つかりません\n",
          );
        }
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HEAD は通常ファイルの長さだけを返し、Linux では本文の読込み I/O を増やさない", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "serve-local-head-"));
  const size = 8 * 1024 * 1024;
  const fd = openSync(resolve(directory, "large.bin"), "w");
  ftruncateSync(fd, size);
  closeSync(fd);
  writeFileSync(resolve(directory, "warm.txt"), "warm\n");
  try {
    await withServer(directory, async (ready, child) => {
      const port = Number(new URL(ready.url).port);
      await response(port, "/warm.txt");
      const readBytes = () =>
        Number(/^rchar: (\d+)$/m.exec(readFileSync(`/proc/${child.pid}/io`, "utf8"))![1]);
      const before = process.platform === "linux" ? readBytes() : undefined;
      const head = await response(port, "/large.bin", "HEAD");
      expect(head.status).toBe(200);
      expect(head.length).toBe(String(size));
      expect(head.type).toBe("application/octet-stream");
      expect(head.body.length).toBe(0);
      const afterHead = before === undefined ? undefined : readBytes();
      if (afterHead !== undefined) expect(afterHead - before!).toBeLessThan(64 * 1024);
      const get = await response(port, "/large.bin");
      expect(get.status).toBe(200);
      expect(get.length).toBe(head.length);
      expect(get.body.length).toBe(size);
      if (afterHead !== undefined) expect(readBytes() - afterHead).toBeGreaterThanOrEqual(size);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
