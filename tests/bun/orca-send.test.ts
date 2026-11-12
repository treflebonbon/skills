import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "orca-send-"));
  directories.push(directory);
  const cli = join(directory, "orca");
  const capture = join(directory, "argv");
  const body = join(directory, "body.md");
  writeFileSync(body, "本文🙂\r\nliteral $HOME、$(echo no)、`echo no`\n");
  writeFileSync(
    cli,
    '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$ARGV_CAPTURE"\nprintf \'%s\' "$ORCA_STDOUT"\nprintf \'%s\' "$ORCA_STDERR" >&2\nif [ -n "$ORCA_SIGNAL" ]; then kill -s "$ORCA_SIGNAL" $$; fi\nexit "${ORCA_EXIT:-0}"\n',
  );
  chmodSync(cli, 0o755);
  return { directory, cli, capture, body };
}

test("orca-send は Python のない PATH で本文を literal argv として送る", () => {
  const f = fixture();
  const path = join(f.directory, "bin");
  mkdirSync(path);
  symlinkSync(process.execPath, join(path, "bun"));
  for (const name of ["dirname", "readlink"]) {
    symlinkSync(Bun.which(name)!, join(path, name));
  }
  const result = spawnSync(
    join(root, "bin/orca-send"),
    ["--cli", f.cli, "--body-file", f.body, "--", "--to", "dispatch:1"],
    {
      env: { ...process.env, PATH: path, ARGV_CAPTURE: f.capture },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(readFileSync(f.capture, "utf8").split("\0").slice(0, -1)).toEqual([
    "orchestration",
    "send",
    "--body",
    "本文🙂\r\nliteral $HOME、$(echo no)、`echo no`\n",
    "--to",
    "dispatch:1",
  ]);
});

type Scenario = {
  name: string;
  body?: string | { repeat: string; count: number; suffix: string };
  bodyBase64?: string;
  missing?: boolean;
  nativeArgs?: string[];
  env?: Record<string, string>;
  expected: { status: number; stdout: string; stderr: string; argv: string[] | null };
};
const corpus: { scenarios: Scenario[] } = JSON.parse(
  readFileSync(join(root, "tests/fixtures/orca-send-python.json"), "utf8"),
);
for (const scenario of corpus.scenarios) {
  test(`Python 版との比較: ${scenario.name}`, () => {
    const f = fixture();
    const body = scenario.bodyBase64
      ? Buffer.from(scenario.bodyBase64, "base64")
      : Buffer.from(
          typeof scenario.body === "object"
            ? scenario.body.repeat.repeat(scenario.body.count) + scenario.body.suffix
            : (scenario.body ?? ""),
        );
    if (scenario.missing) rmSync(f.body);
    else writeFileSync(f.body, body);
    const result = spawnSync(
      join(root, "bin/orca-send"),
      [
        "--cli",
        f.cli,
        "--body-file",
        f.body,
        "--",
        ...(scenario.nativeArgs ?? [
          "--to",
          "dispatch:dispatch-1",
          "--subject",
          "status",
          "--type",
          "status",
          "--json",
        ]),
      ],
      {
        env: { ...process.env, ARGV_CAPTURE: f.capture, ...scenario.env },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: scenario.expected.status,
      stdout: scenario.expected.stdout,
      stderr: scenario.expected.stderr,
    });
    if (scenario.expected.argv) {
      expect(readFileSync(f.capture, "utf8").split("\0").slice(0, -1)).toEqual(
        scenario.expected.argv.map((arg) => (arg === "{{body}}" ? body.toString("utf8") : arg)),
      );
    } else {
      expect(existsSync(f.capture)).toBe(false);
    }
  });
}

test("ambient 設定・preload・dotenv を無視し、payload と cwd を変更しない", async () => {
  const f = fixture();
  const home = join(f.directory, "home");
  const xdg = join(f.directory, "xdg");
  const cwd = join(f.directory, "cwd");
  for (const path of [home, xdg, cwd]) mkdirSync(path);
  const marker = join(f.directory, "executed");
  const preload = join(f.directory, "preload.ts");
  const payload = join(f.directory, "payload with spaces");
  mkdirSync(payload);
  cpSync(join(root, "bin"), join(payload, "bin"), { recursive: true });
  mkdirSync(join(payload, "lib"));
  cpSync(join(root, "lib/bun"), join(payload, "lib/bun"), { recursive: true });
  const sender = join(f.directory, "sender");
  symlinkSync(join(payload, "bin/orca-send"), sender);
  writeFileSync(
    f.cli,
    '#!/bin/sh\npwd -P > "$CWD_CAPTURE"\nprintf \'%s\\n\' "$HOME" "$XDG_CONFIG_HOME" "$ORCA_PUBLIC_FIXTURE" > "$ENV_CAPTURE"\nprintf \'%s\\0\' "$@" > "$ARGV_CAPTURE"\n',
  );
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      requests++;
      return new Response("{}");
    },
  });
  try {
    writeFileSync(
      preload,
      `await Bun.write(${JSON.stringify(marker)}, "injected"); await fetch("http://127.0.0.1:${server.port}/injected"); throw new Error("injected-preload");`,
    );
    const config = `preload = [${JSON.stringify(preload)}]\n[install]\nauto = "force"\nregistry = "http://127.0.0.1:${server.port}"\n[test]\npreload = [${JSON.stringify(preload)}]\n`;
    for (const path of [
      join(cwd, "bunfig.toml"),
      join(home, ".bunfig.toml"),
      join(xdg, ".bunfig.toml"),
    ])
      writeFileSync(path, config);
    writeFileSync(join(cwd, ".env"), "ORCA_EXIT=55\n");
    writeFileSync(
      join(cwd, "tsconfig.json"),
      JSON.stringify({
        extends: "uninstalled-orca-send-probe/tsconfig.json",
        compilerOptions: { paths: { "node:*": [preload] } },
      }),
    );
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: { pretest: `touch ${marker}` },
        dependencies: { "uninstalled-orca-send-probe": "0.0.0" },
      }),
    );
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, ARGV_CAPTURE: f.capture };
    // 対照実験では preload が実行されることも確かめる。
    const control = Bun.spawn(
      [process.execPath, "run", join(root, "lib/bun/orca-send.ts"), "--help"],
      { cwd, env, stdout: "pipe", stderr: "pipe" },
    );
    const controlError = new Response(control.stderr).text();
    expect(await control.exited).toBe(1);
    expect(await controlError).toContain("injected-preload");
    expect(readFileSync(marker, "utf8")).toBe("injected");
    expect(requests).toBe(1);
    rmSync(marker);
    requests = 0;
    const before = payloadSnapshot(payload);
    // HTTP サーバーのイベントループを止めず、応答を待たない通信も監視する。
    const child = Bun.spawn(
      [sender, "--cli", f.cli, "--body-file", f.body, "--", "--to", "dispatch:1"],
      {
        cwd,
        env: {
          ...env,
          BUN_OPTIONS: `--preload=${preload}`,
          NODE_OPTIONS: `--require=${preload}`,
          NODE_PATH: cwd,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(payload, "unexpected-cache"),
          BASH_ENV: preload,
          CWD_CAPTURE: join(f.directory, "cwd-capture"),
          ENV_CAPTURE: join(f.directory, "env-capture"),
          ORCA_PUBLIC_FIXTURE: "public-fixture",
        },
        stdout: "ignore",
        stderr: "pipe",
        timeout: 10000,
      },
    );
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(requests).toBe(0);
    expect(readFileSync(f.capture, "utf8")).toContain("dispatch:1\0");
    expect(readFileSync(join(f.directory, "cwd-capture"), "utf8").trim()).toBe(realpathSync(cwd));
    expect(readFileSync(join(f.directory, "env-capture"), "utf8")).toBe(
      `${home}\n${xdg}\npublic-fixture\n`,
    );
    expect(payloadSnapshot(payload)).toEqual(before);
  } finally {
    server.stop(true);
  }
}, 15000);

function payloadSnapshot(directory: string): Record<string, unknown> {
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => {
        const path = join(directory, name);
        const stat = lstatSync(path);
        const content = stat.isSymbolicLink()
          ? readlinkSync(path)
          : stat.isDirectory()
            ? payloadSnapshot(path)
            : createHash("sha256").update(readFileSync(path)).digest("hex");
        return [name, { mode: stat.mode, content }];
      }),
  );
}

test("不足する import を自動 install せず通信・payload 書込みなしで拒否する", async () => {
  const f = fixture();
  const payload = join(f.directory, "payload");
  cpSync(join(root, "lib/bun"), payload, { recursive: true });
  writeFileSync(join(payload, "missing.ts"), 'import "uninstalled-orca-send-proof-package";\n');
  const before = payloadSnapshot(payload);
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      requests++;
      return new Response("missing", { status: 404 });
    },
  });
  try {
    const home = join(f.directory, "home");
    mkdirSync(home);
    writeFileSync(
      join(home, ".bunfig.toml"),
      `[install]\nauto = "force"\nregistry = "http://127.0.0.1:${server.port}"\n`,
    );
    const child = Bun.spawn([join(payload, "run"), "run", join(payload, "missing.ts")], {
      cwd: f.directory,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      expect(await child.exited).toBe(1);
      expect(await stderr).toContain("Cannot find package");
    } finally {
      clearTimeout(timer);
    }
    expect(requests).toBe(0);
    expect(payloadSnapshot(payload)).toEqual(before);
  } finally {
    server.stop(true);
  }
});

test("Bun の版を確認できなければ CLI を実行せず明示的に拒否する", () => {
  const f = fixture();
  const path = join(f.directory, "bin");
  mkdirSync(path);
  symlinkSync(Bun.which("dirname")!, join(path, "dirname"));
  const bun = join(path, "bun");
  writeFileSync(
    bun,
    '#!/bin/sh\nif [ "$1" = --version ]; then exit 17; fi\nprintf called > "$RUNTIME_CALLED_MARKER"\n',
  );
  chmodSync(bun, 0o755);
  const marker = join(f.directory, "bun-called");
  const result = spawnSync(join(root, "bin/orca-send"), ["--help"], {
    env: { ...process.env, PATH: path, RUNTIME_CALLED_MARKER: marker },
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Bun 1.4.4 以上が必要です");
  expect(existsSync(marker)).toBe(false);
});

test("公開 help も Python 版の引数説明を維持する", () => {
  const expected: { help: string } = JSON.parse(
    readFileSync(join(root, "tests/fixtures/orca-send-python.json"), "utf8"),
  );
  const result = spawnSync(join(root, "bin/orca-send"), ["--help"], {
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(expected.help);
});

test("親 directory が symlink でも実体の package root から起動する", () => {
  const f = fixture();
  const link = join(f.directory, "linked-bin");
  symlinkSync(join(root, "bin"), link);
  const result = spawnSync(join(link, "orca-send"), ["--help"], {
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("UTF-8本文ファイル");
});
