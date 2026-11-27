import { expect, test } from "bun:test";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GatewayCleanupError, withGatewayScope } from "../../lib/bun/raw-gateway.ts";

function unixRequest(
  socketPath: string,
  method: string,
  path: string,
  body = "",
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const client = request(
      {
        socketPath,
        method,
        path,
        headers: { "Content-Length": `${Buffer.byteLength(body)}`, ...headers },
      },
      async (response) => {
        try {
          const chunks = [];
          for await (const chunk of response) chunks.push(chunk);
          resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() });
        } catch (error) {
          reject(error);
        }
      },
    );
    client.setTimeout(3000, () => client.destroy(new Error("gateway response timed out")));
    client.on("error", reject);
    client.end(body);
  });
}

test("a gateway publishes its Unix socket in an owner-only directory and removes it on scope exit", async () => {
  const directory = await withGatewayScope(async (start) => {
    const directory = await start("dependencies");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, "service.sock")).isSocket()).toBe(true);
    return directory;
  });
  expect(existsSync(directory)).toBe(false);
});

test("scope exit closes an idle client and releases its Unix listener", async () => {
  const { directory, closed } = await withGatewayScope(async (start) => {
    const directory = await start("dependencies");
    const client = connect(join(directory, "service.sock"));
    const closed = once(client, "close", { signal: AbortSignal.timeout(3000) });
    await once(client, "connect");
    return { directory, closed };
  });
  await closed;
  expect(existsSync(directory)).toBe(false);
});

test.skipIf(process.platform !== "linux")(
  "two scopes bind independent Unix sockets under a long TMPDIR",
  async () => {
    const fixture = mkdtempSync(join(tmpdir(), "cxi-long-"));
    const previous = process.env.TMPDIR;
    const long = join(fixture, "long-gateway-parent-".repeat(8));
    mkdirSync(long);
    process.env.TMPDIR = long;
    try {
      await withGatewayScope(async (first) => {
        await withGatewayScope(async (second) => {
          const directories = await Promise.all([first("dependencies"), second("dependencies")]);
          expect(directories[0]).not.toBe(directories[1]);
          for (const [i, directory] of directories.entries()) {
            const alias = join(fixture, `bound-${i}`);
            symlinkSync(directory, alias);
            expect(statSync(join(directory, "service.sock")).isSocket()).toBe(true);
            expect(await unixRequest(join(alias, "service.sock"), "GET", "/forbidden")).toEqual({
              status: 403,
              body: "",
            });
          }
        });
      });
      expect(existsSync(join(fixture, "bound-0"))).toBe(false);
      expect(existsSync(join(fixture, "bound-1"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      rmSync(fixture, { recursive: true });
    }
  },
);

test("a directory cleanup error is reported and preserves an earlier callback error", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "cxi-cleanup-"));
  const primary = new Error("fixture callback failed");
  try {
    for (const callbackError of [undefined, primary]) {
      const result = withGatewayScope(async (start) => {
        const directory = await start("dependencies");
        renameSync(dirname(directory), join(fixture, callbackError ? "primary" : "cleanup"));
        if (callbackError) throw callbackError;
      });
      if (callbackError) await expect(result).rejects.toBe(primary);
      else await expect(result).rejects.toBeInstanceOf(GatewayCleanupError);
    }
  } finally {
    rmSync(fixture, { recursive: true });
  }
});

test("model startup uses only the selected auth file and rejects remote Responses state", async () => {
  const home = mkdtempSync(join(tmpdir(), "cxi-fixture-"));
  try {
    let directory = "";
    await expect(
      withGatewayScope(async (start) => {
        directory = await start("dependencies");
        await start("model", { codexHome: join(home, "missing") });
      }),
    ).rejects.toThrow("host ChatGPT login is unavailable");
    expect(existsSync(directory)).toBe(false);

    writeFileSync(
      join(home, "auth.json"),
      '{"tokens":{"access_token":"synthetic","account_id":"fixture"}}',
      { mode: 0o600 },
    );
    await withGatewayScope(async (start) => {
      const socket = join(await start("model", { codexHome: home }), "service.sock");
      for (const payload of [
        { previous_response_id: "fixture" },
        { tools: [{ type: "namespace", tools: [{ type: "mcp" }] }] },
        {
          input: [
            {
              type: "message",
              content: [{ type: "input_image", image_url: "https://example.invalid" }],
            },
          ],
        },
      ])
        expect(
          (await unixRequest(socket, "POST", "/v1/responses", JSON.stringify(payload))).status,
        ).toBe(403);
      expect((await unixRequest(socket, "POST", "/v1/responses", "{")).status).toBe(502);
      expect((await unixRequest(socket, "POST", "/backend-api/codex/responses", "{}")).status).toBe(
        403,
      );
    });
  } finally {
    rmSync(home, { recursive: true });
  }
});

test("the Unix resolver returns public addresses and refuses nonpublic or denied answers", async () => {
  await withGatewayScope(async (start) => {
    const directory = await start("dependencies", {
      domains: ["8.8.8.8", "9.9.9.9", "127.0.0.1", "100.64.0.1"],
      deniedDomains: ["9.9.9.9"],
    });
    const socket = join(directory, "service.sock");
    for (const host of ["8.8.8.8", "9.9.9.9", "127.0.0.1", "100.64.0.1", "1.1.1.1"]) {
      const reply = await unixRequest(
        socket,
        "POST",
        "/resolve",
        JSON.stringify({ host, type: 1 }),
      );
      expect(reply).toEqual(
        host === "8.8.8.8" ? { status: 200, body: '["8.8.8.8"]' } : { status: 403, body: "" },
      );
    }
  });
});

test("the dependency proxy admits only the reviewed public GitHub topic", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "cxi-gh-"));
  const originalPath = process.env.PATH;
  const originalConfig = process.env.GH_CONFIG_DIR;
  try {
    writeFileSync(join(fixture, "fixture-config"), "");
    writeFileSync(
      join(fixture, "gh"),
      `#!/bin/sh
test -z "\${GH_TOKEN+x}\${GITHUB_TOKEN+x}" || exit 71
test -f "$GH_CONFIG_DIR/fixture-config" || exit 72
case "$*" in
  'api repos/example/public --method GET') printf '{"full_name":"example/public","private":false,"default_branch":"main","unprojected":"fixture"}' ;;
  'api repos/example/public/pulls?head=example%3Atask%2Fnarrow --method GET') printf '[{"number":7,"private_field":"fixture"}]' ;;
  *) exit 70 ;;
esac
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${fixture}:${originalPath}`;
    process.env.GH_CONFIG_DIR = fixture;
    await withGatewayScope(async (start) => {
      const githubPolicy = {
        repository: "example/public",
        branch: "task/narrow",
        default_branch: "main",
        reviewed_commit: "a".repeat(40),
        automation: "no-project-secrets",
        review: "synthetic",
      };
      const socket = join(
        await start("dependencies", { domains: ["api.github.com"], githubPolicy }),
        "service.sock",
      );
      const send = (target: string) =>
        unixRequest(socket, "GET", target, "", { Host: "api.github.com" });
      const metadata = await send("http://api.github.com/repos/example/public");
      expect(metadata.status).toBe(200);
      expect(JSON.parse(metadata.body)).toEqual({
        full_name: "example/public",
        private: false,
        default_branch: "main",
      });
      const pulls = await send("http://api.github.com/repos/example/public/pulls");
      expect(pulls.status).toBe(200);
      expect(JSON.parse(pulls.body)).toEqual([{ number: 7 }]);
      for (const target of [
        "/repos/example/public",
        "https://api.github.com/repos/example/public",
        "http://api.github.com:80/repos/example/public",
        "http://api.github.com/repos/example/other",
        "http://api.github.com/repos/example/../example/public",
        "http://api.github.com/repos/example/public/pulls?head=other",
      ])
        expect(await send(target)).toEqual({ status: 403, body: "" });
    });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalConfig === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = originalConfig;
    rmSync(fixture, { recursive: true });
  }
});
