import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request, Server as HttpServer, type IncomingMessage } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect, createServer as tcpServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { connect as tlsConnect, createServer as tlsServer, type SecureVersion } from "node:tls";
import { withGatewayScope } from "../../lib/bun/raw-gateway.ts";

const fixture = process.argv[2];
const root = resolve(import.meta.dir, "../..");
const runner = join(root, "lib/bun/run");
const auth = join(fixture, "auth");
mkdirSync(auth, { mode: 0o700 });
writeFileSync(
  join(auth, "auth.json"),
  JSON.stringify({
    tokens: { access_token: "synthetic-host-token", account_id: "synthetic-host-account" },
  }),
  { mode: 0o600 },
);
writeFileSync(
  join(fixture, "gh"),
  `#!/bin/sh
test "$GH_CONFIG_DIR" = "$HOME" && test -z "\${GH_TOKEN+x}\${GITHUB_TOKEN+x}" || exit 71
case "$1 $2 $3 $4" in
  'api repos/example/public --method GET') printf '{"full_name":"example/public","private":false,"default_branch":"main","ignored":true}' ;;
  'api repos/example/public/git/trees/'*' --method GET') printf '{"tree":[]}' ;;
  'api repos/example/public/pulls?head=example%3Atask --method GET') printf '[{"number":7,"ignored":true}]' ;;
  'api repos/example/public/pulls/7 --method GET') printf '{"number":7,"head":{"ref":"task","repo":{"full_name":"example/public"}},"base":{"ref":"main"}}' ;;
  'api repos/example/public/pulls/8 --method GET') printf '{"number":8,"head":{"ref":"task","repo":{"full_name":"example/other"}},"base":{"ref":"main"}}' ;;
  'api repos/example/public/pulls --method POST'|'api repos/example/public/pulls/7 --method PATCH')
    IFS= read -r body || [ -n "$body" ] || exit 72
    printf '{"number":7}' ;;
  'api repos/example/public/issues/7/comments --method POST') printf '{"id":9007199254740993,"html_url":"fixture","body":"public fixture"}' ;;
  *) exit 70 ;;
esac
`,
  { mode: 0o700 },
);
process.env.PATH = `${fixture}:${process.env.PATH}`;
process.env.GH_TOKEN = "synthetic-inherited-token";

const repository = join(fixture, "repository");
mkdirSync(repository);
function git(args: string[], stdin?: Buffer) {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    stdin,
    stderr: "ignore",
    env: {
      HOME: fixture,
      PATH: process.env.PATH!,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  assert(result.success, `fixture git ${args[0]} failed`);
  return result.stdout;
}
git(["init", "-q", "-b", "task"]);
git(["commit", "-qm", "Initial", "--allow-empty"]);
const base = git(["rev-parse", "HEAD"]).toString().trim();
const pack = git(["pack-objects", "--stdout", "--revs"], Buffer.from(`${base}\n`));
writeFileSync(join(fixture, "pack"), pack);
function bundle(name: string) {
  const path = join(fixture, name);
  git(["bundle", "create", path, "HEAD", `^${base}`]);
  const bytes = readFileSync(path);
  // prerequisite の説明欄に空白を足して、正規 Base64 が padding なしになるようにする。
  const description = bytes.indexOf(0x0a, bytes.indexOf(0x0a) + 1);
  const aligned = Buffer.concat([
    bytes.subarray(0, description),
    Buffer.alloc((3 - (bytes.length % 3)) % 3, 0x20),
    bytes.subarray(description),
  ]);
  return {
    head: git(["rev-parse", "HEAD"]).toString().trim(),
    bundle: aligned.toString("base64"),
  };
}
git(["commit", "-qm", "Topic", "--allow-empty"]);
const topic = bundle("topic.bundle");
mkdirSync(join(repository, ".github"));
writeFileSync(join(repository, ".github", "workflow"), "fixture");
git(["add", ".github/workflow"]);
git(["commit", "-qm", "Unreviewed automation"]);
git(["revert", "--no-edit", "HEAD"]);
const automation = bundle("automation.bundle");

const policy = {
  repository: "example/public",
  branch: "task",
  default_branch: "main",
  reviewed_commit: base,
  automation: "no-project-secrets",
  review: "synthetic fixture",
};
type Run = typeof withGatewayScope;
type Start = Parameters<Parameters<Run>[0]>[0];

const pythonScope = String.raw`
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("gateway", sys.argv[1])
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
try:
    with gateway.gateway_scope() as start:
        for line in sys.stdin:
            service, options = json.loads(line)
            if 'codex_home' in options:
                options['codex_home'] = Path(options['codex_home'])
            if 'github_seed' in options:
                options['github_seed']['pack'] = (Path(sys.argv[2]) / 'pack').read_bytes()
            try:
                directory = start(service, **options)
            except FileNotFoundError as error:
                if service == 'model' and 'codex_home' in options and error.filename == str(options['codex_home'] / 'auth.json'):
                    print(json.dumps({'error': 'host ChatGPT login is unavailable'}), flush=True)
                raise
            print(json.dumps(str(directory)), flush=True)
except Exception:
    sys.exit(2)
`;

const withPythonScope: Run = async (run) => {
  const child = spawn(
    "python3",
    [
      "-B",
      "-c",
      pythonScope,
      join(root, "share/codex-isolation/secret-isolation-gateway.py"),
      fixture,
    ],
    {
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const exited = once(child, "exit");
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let failed = false;
  try {
    return await run(async (service, options = {}) => {
      child.stdin.write(
        JSON.stringify([
          service,
          {
            domains: options.domains,
            denied_domains: options.deniedDomains,
            codex_home: options.codexHome,
            github_policy: options.githubPolicy,
            github_seed: options.githubSeed && { push_helper: options.githubSeed.pushHelper },
          },
        ]) + "\n",
      );
      const answer = await replies.next();
      if (answer.done) {
        failed = true;
        throw new Error("Python gateway setup failed");
      }
      const result = JSON.parse(answer.value);
      if (typeof result === "string") return result;
      failed = true;
      throw new Error(result.error);
    });
  } finally {
    child.stdin.end();
    assert.equal((await exited)[0], failed ? 2 : 0);
  }
};

async function readBody(req: IncomingMessage) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function send(
  directory: string,
  method: string,
  path: string,
  payload?: unknown,
  headers = {},
  firstChunk?: () => void,
) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  return new Promise<[number, string]>((resolve, reject) => {
    const client = request(
      {
        socketPath: join(directory, "service.sock"),
        agent: false,
        method,
        path,
        headers: { Host: "api.github.com", "Content-Length": Buffer.byteLength(body), ...headers },
      },
      async (response) => {
        try {
          if (firstChunk) response.once("data", firstChunk);
          resolve([response.statusCode!, await readBody(response)]);
        } catch (error) {
          reject(error);
        }
      },
    );
    client.setTimeout(3000, () => client.destroy(new Error("fixture response timed out")));
    client.on("error", reject);
    client.end(body);
  });
}

const credentials = {
  key: readFileSync(join(fixture, "key.pem")),
  cert: readFileSync(join(fixture, "cert.pem")),
};
let validModelRequest = false;
let multilineModelRequest = false;
let modelRequests = 0;
let nextModelChunk: Promise<void>;
const model = httpsServer(credentials, async (req, res) => {
  modelRequests++;
  const text = await readBody(req);
  multilineModelRequest = text.includes("\n");
  const payload = JSON.parse(text);
  validModelRequest =
    req.method === "POST" &&
    req.url === "/backend-api/codex/responses" &&
    req.headers.authorization === "Bearer synthetic-host-token" &&
    req.headers["chatgpt-account-id"] === "synthetic-host-account" &&
    payload.store === false &&
    payload.tools[0].type === "function" &&
    text.includes("9007199254740993");
  if (!validModelRequest) return res.writeHead(400).end();
  if (payload.model === "refused")
    return res.writeHead(429).end("fixture private upstream response");
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write("data: first\n\n");
  await nextModelChunk;
  res.end("data: second\n\n");
});
model.listen(443, "127.0.0.1");
await once(model, "listening");
const tls = tlsServer(credentials, (socket) => socket.once("data", () => socket.end("pong")));
tls.listen(443, "8.8.8.8");
await once(tls, "listening");

const captureHost = "capture.example";
function clientHello(host: string) {
  const name = Buffer.from(host);
  const sni = Buffer.concat([
    Buffer.from([0, 0, 0, name.length + 5, 0, name.length + 3, 0, 0, name.length]),
    name,
  ]);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0, 0, 2, 0x13, 1, 1, 0, 0, sni.length]),
    sni,
  ]);
  const bytes = Buffer.concat([Buffer.from([1, 0, 0, body.length]), body]);
  return [bytes.subarray(0, 2), bytes.subarray(2)].map((part) =>
    Buffer.concat([Buffer.from([22, 3, 3, 0, part.length]), part]),
  );
}
const hello = clientHello(captureHost);
const expectedTunnel = Buffer.concat([...hello, Buffer.from("tail")]);
const tunnelReply = Buffer.alloc(2 * 1024 * 1024, 0x61);
const capture = tcpServer({ allowHalfOpen: true }, (socket) => {
  let bytes = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
  });
  socket.once("end", () => socket.end(bytes.equals(expectedTunnel) ? tunnelReply : ""));
});
capture.listen(443, "8.8.4.4");
await once(capture, "listening");

async function connectTunnel(directory: string, host: string) {
  const client = connect(join(directory, "service.sock"));
  client.setTimeout(4000, () => client.destroy(new Error("fixture tunnel timed out")));
  await once(client, "connect");
  const status = new Promise<number>((resolve, reject) => {
    let header = "";
    const earlyClose = () => reject(new Error("fixture tunnel closed before responding"));
    client.once("close", earlyClose);
    client.once("error", reject);
    function data(chunk: Buffer) {
      header += chunk.toString("ascii");
      if (!header.includes("\r\n\r\n")) return;
      client.pause();
      client.off("data", data);
      client.off("error", reject);
      client.off("close", earlyClose);
      resolve(Number(header.split(" ")[1]));
    }
    client.on("data", data);
  });
  client.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
  return { client, status: await status };
}

async function fragmentedTunnel(directory: string) {
  const client = connect({ path: join(directory, "service.sock"), allowHalfOpen: true });
  client.setTimeout(3000, () => client.destroy(new Error("fragmented hello timed out")));
  await once(client, "connect");
  const header = Buffer.from(
    `CONNECT ${captureHost}:443 HTTP/1.1\r\nHost: ${captureHost}:443\r\n\r\n`,
  );
  client.write(Buffer.concat([header, hello[0]]));
  await Bun.sleep(50);
  client.end(Buffer.concat([hello[1], Buffer.from("tail")]));
  await Bun.sleep(100);
  const chunks = [];
  for await (const chunk of client) chunks.push(chunk);
  const response = Buffer.concat(chunks);
  const end = response.indexOf("\r\n\r\n");
  assert(end !== -1, "CONNECT did not return a response header");
  assert.match(
    response.subarray(0, end).toString(),
    /^HTTP\/1\.0 200 Connection established(?:\r\n[^\r\n]+)*$/,
  );
  assert(response.subarray(end + 4).equals(tunnelReply), "CONNECT truncated the upstream reply");
}

async function tlsEcho(client: Socket, servername: string, version: SecureVersion) {
  const socket = tlsConnect({
    socket: client,
    servername,
    ca: credentials.cert,
    minVersion: version,
    maxVersion: version,
  });
  try {
    await once(socket, "secureConnect");
    const received = once(socket, "data");
    socket.write("ping");
    return (await received)[0].toString();
  } finally {
    socket.destroy();
  }
}

async function dnsQuery(directory: string) {
  const child = spawn(
    runner,
    ["run", join(root, "lib/bun/raw-gateway-bridge.ts"), "--dns", join(directory, "service.sock")],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const exited = once(child, "exit");
  const udp = createSocket("udp4");
  const packet = Buffer.from(
    "12340100000100000000000007616c6c6f776564076578616d706c650000010001",
    "hex",
  );
  const signal = AbortSignal.timeout(3000);
  try {
    const response = once(udp, "message", { signal });
    const interval = setInterval(() => udp.send(packet, 53, "127.0.0.1"), 50);
    try {
      return (await response)[0].toString("hex");
    } finally {
      clearInterval(interval);
    }
  } finally {
    udp.close();
    child.kill();
    await exited;
  }
}

async function observe(scope: Run) {
  const directories: string[] = [];
  const markerName = scope === withPythonScope ? "published-python" : "published-bun";
  const marker = join(fixture, markerName);
  const pushHelper = `sleep 0.4\ngit rev-parse HEAD > "$HOME/${markerName}"\n`;
  const result = await scope(async (start: Start) => {
    const deps = await start("dependencies", {
      domains: ["**.example", "api.github.com"],
      deniedDomains: ["denied.example"],
      githubPolicy: policy,
      githubSeed: { pack, pushHelper },
    });
    const model = await start("model", { codexHome: auth });
    directories.push(deps, model);
    const proxied = (method: string, path: string, payload?: unknown, headers?: object) =>
      send(deps, method, `http://api.github.com${path}`, payload, headers);
    const prefix = "/repos/example/public";
    const observations: Record<string, unknown> = {};
    const cases = [
      ["metadata", 200, () => proxied("GET", prefix)],
      ["pulls", 200, () => proxied("GET", `${prefix}/pulls`)],
      [
        "create",
        200,
        () =>
          proxied("POST", `${prefix}/pulls`, {
            title: "feat: fixture",
            head: "task",
            base: "main",
            draft: true,
          }),
      ],
      ["edit", 200, () => proxied("PATCH", `${prefix}/pulls/7`, { body: "public fixture" })],
      [
        "comment",
        200,
        () => proxied("POST", `${prefix}/issues/7/comments`, { body: "public fixture" }),
      ],
      ["wrong topic", 403, () => proxied("PATCH", `${prefix}/pulls/8`, { body: "public fixture" })],
      ["state edit", 403, () => proxied("PATCH", `${prefix}/pulls/7`, { state: "closed" })],
      ["wrong repo", 403, () => proxied("GET", "/repos/example/other")],
      ["wrong host", 403, () => proxied("GET", prefix, undefined, { Host: "example.invalid" })],
      ["extra query", 403, () => proxied("GET", `${prefix}/pulls?head=other`)],
      ["secret route", 403, () => proxied("GET", `${prefix}/actions/secrets`)],
      [
        "dns allowed",
        200,
        () => send(deps, "POST", "/resolve", { host: "allowed.example", type: 1 }),
      ],
      [
        "dns denied",
        403,
        () => send(deps, "POST", "/resolve", { host: "denied.example", type: 1 }),
      ],
      ["dns mixed", 403, () => send(deps, "POST", "/resolve", { host: "mixed.example", type: 1 })],
      [
        "dns mapped public",
        200,
        () => send(deps, "POST", "/resolve", { host: "mapped-public.example", type: 28 }),
      ],
      [
        "dns mapped private",
        403,
        () => send(deps, "POST", "/resolve", { host: "mapped-private.example", type: 28 }),
      ],
      [
        "dns documentation",
        403,
        () => send(deps, "POST", "/resolve", { host: "documentation.example", type: 28 }),
      ],
    ] as const;
    for (const [name, expected, request] of cases) {
      const [status, body] = await request();
      assert.equal(status, expected, name);
      if (name === "comment") assert(body.includes("9007199254740993"), "comment ID changed");
      observations[name] = [status, body && JSON.parse(body)];
    }
    assert.deepEqual(observations["dns mapped public"], [200, ["::ffff:8.8.8.8"]]);

    assert.equal((await proxied("POST", "/topic-push", { ...topic, bundle: "!" }))[0], 403);
    if (scope === withGatewayScope) {
      const stalled = connect(join(deps, "service.sock"));
      try {
        const closed = once(stalled, "close", { signal: AbortSignal.timeout(2000) });
        stalled.write(
          "POST http://api.github.com/topic-push HTTP/1.1\r\nHost: api.github.com\r\nContent-Length: 2\r\n\r\n{",
        );
        await closed;
      } finally {
        stalled.destroy();
      }
      // 過剰 padding の扱いは旧 Python のバージョンで異なる。
      assert.equal(
        (await proxied("POST", "/topic-push", { ...topic, bundle: topic.bundle + "=" }))[0],
        403,
      );
    }
    assert(!existsSync(marker), "a rejected publication ran the helper");
    const publication = await proxied("POST", "/topic-push", topic);
    assert.equal(publication[0], 200, "valid publication");
    assert.equal(readFileSync(marker, "utf8").trim(), topic.head);
    observations.publication = JSON.parse(publication[1]);
    assert.equal((await proxied("POST", "/topic-push", { head: base, bundle: "" }))[0], 403);
    assert.equal((await proxied("POST", "/topic-push", automation))[0], 403);
    assert.equal(readFileSync(marker, "utf8").trim(), topic.head);

    const json = JSON as typeof JSON & { rawJSON(text: string): unknown };
    const payload = {
      model: "fixture",
      store: true,
      tools: [{ type: "function" }],
      reasoning: json.rawJSON("9007199254740993"),
    };
    const before = modelRequests;
    const streamed = Promise.withResolvers<void>();
    nextModelChunk = streamed.promise;
    let success: [number, string];
    try {
      success = await send(
        model,
        "POST",
        "/v1/responses",
        payload,
        { Authorization: "Bearer synthetic-client-token" },
        () => streamed.resolve(),
      );
    } finally {
      streamed.resolve();
    }
    assert.deepEqual(success, [200, "data: first\n\ndata: second\n\n"]);
    assert(validModelRequest, "model upstream route, body or authentication changed");
    assert(!multilineModelRequest, "model upstream JSON contains formatting newlines");
    const refused = await send(model, "POST", "/v1/responses", { ...payload, model: "refused" });
    assert.deepEqual(refused, [429, ""]);
    assert.deepEqual(
      await send(model, "POST", "/v1/responses", {
        input: [{ type: "item_reference", id: "fixture" }],
      }),
      [403, ""],
    );
    assert.equal(modelRequests - before, 2, "a rejected request reached the upstream");
    observations.model = [success, refused];

    const deny = await connectTunnel(deps, "mixed.example");
    assert.equal(deny.status, 403);
    deny.client.destroy();
    for (const version of ["TLSv1.2", "TLSv1.3"] as const) {
      const allowed = await connectTunnel(deps, "allowed.example");
      assert.equal(allowed.status, 200);
      assert.equal(await tlsEcho(allowed.client, "allowed.example", version), "pong");
    }
    const mismatch = await connectTunnel(deps, "allowed.example");
    assert.equal(mismatch.status, 200);
    await assert.rejects(tlsEcho(mismatch.client, "other.example", "TLSv1.3"));
    await fragmentedTunnel(deps);
    observations.dns = await dnsQuery(deps);
    assert.match(String(observations.dns), /08080808$/);
    return observations;
  });
  for (const directory of directories)
    assert(!existsSync(directory), "gateway scope left a published directory");

  let partial = "";
  await assert.rejects(
    scope(async (start) => {
      partial = await start("dependencies", { domains: [] });
      assert(statSync(join(partial, "service.sock")).isSocket());
      assert.deepEqual(await send(partial, "GET", "/unadmitted"), [403, ""]);
      await start("model", { codexHome: join(fixture, "no-login") });
    }),
    { message: "host ChatGPT login is unavailable" },
  );
  assert(partial, "the dependency gateway did not start");
  assert(!existsSync(partial), "partial start left a published directory");
  return result;
}

try {
  const legacy = await observe(withPythonScope);
  // 公開リクエストの受信期限を短縮して、タイムアウトを短時間で再現する。
  const setServerTimeout = HttpServer.prototype.setTimeout;
  HttpServer.prototype.setTimeout = function (...args) {
    this.prependListener("request", (request: IncomingMessage) => {
      if (request.method === "POST" && request.url === "http://api.github.com/topic-push")
        request.socket.setTimeout(100);
    });
    return Reflect.apply(setServerTimeout, this, args);
  };
  let migrated;
  try {
    migrated = await observe(withGatewayScope);
  } finally {
    HttpServer.prototype.setTimeout = setServerTimeout;
  }
  assert.deepEqual(migrated, legacy);
  console.log("gateway wire and lifecycle comparison passed");
} finally {
  capture.close();
  tls.close();
  model.closeAllConnections();
  model.close();
}
