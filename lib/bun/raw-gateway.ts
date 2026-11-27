import { once } from "node:events";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelUpstream } from "./raw-gateway-model.ts";
import { allowedDestination, publicAddresses, tunnel } from "./raw-gateway-network.ts";
import {
  GitHubOperationDenied,
  GitHubService,
  githubProbe,
  type GitHubSeed,
} from "./raw-github-service.ts";
import { strictJSON } from "./strict-json.ts";

type Service = "dependencies" | "github" | "model";
type GatewayOptions = {
  domains?: readonly string[];
  deniedDomains?: readonly string[];
  codexHome?: string;
  githubPolicy?: unknown;
  githubSeed?: GitHubSeed;
};
type StartGateway = (service: Service, options?: GatewayOptions) => Promise<string>;

export class GatewayCleanupError extends Error {}

function reply(
  response: ServerResponse,
  status: number,
  body: string | Buffer = "",
  contentType?: string,
) {
  response.setHeader("Content-Length", Buffer.byteLength(body));
  if (contentType) response.setHeader("Content-Type", contentType);
  response.writeHead(status).end(body);
}

function contentLength(request: IncomingMessage, fallback = "") {
  const length = request.headers["content-length"] ?? fallback;
  return /^[0-9]+(?![\s\S])/.test(length) ? Number(length) : NaN;
}

async function readBody(request: IncomingMessage, length: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > length) throw new Error("unexpected request body");
    chunks.push(chunk);
  }
  if (total !== length) throw new Error("truncated request body");
  return Buffer.concat(chunks, total);
}

function githubPath(target: string) {
  // URL によるドットセグメントの正規化前に、受信したパスで操作を検査する。
  const match = /^[Hh][Tt][Tt][Pp]:\/\/api\.github\.com(?=[/?#]|$)([^#]*)#?(?![\s\S])/.exec(target);
  if (!match) return;
  const path = match[1];
  return path.indexOf("?") === path.length - 1 ? path.slice(0, -1) : path;
}

function requestHandler(
  service: Service,
  admitted: (host: string) => boolean,
  model: ReturnType<typeof modelUpstream> | undefined,
  github: GitHubService | undefined,
  probe: ReturnType<typeof githubProbe> | undefined,
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "";
    const target = request.url ?? "";
    const headers = request.headers;
    if (model && method === "POST" && target === "/v1/responses") {
      const length = contentLength(request);
      if (
        request.headers["transfer-encoding"] ||
        request.headers["content-encoding"] ||
        !(length > 0 && length <= 16 * 1024 * 1024)
      )
        return reply(response, 403);
      try {
        const status = await model(await readBody(request, length), response);
        if (!response.headersSent) reply(response, status);
      } catch {
        if (response.headersSent) response.destroy();
        else reply(response, 502);
      }
      return;
    }
    if (service === "dependencies" && method === "POST" && target === "/resolve") {
      const length = contentLength(request);
      if (headers["transfer-encoding"] || !(length > 0 && length <= 1024))
        return reply(response, 403);
      try {
        const body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(await readBody(request, length)),
        );
        if (
          !body ||
          typeof body !== "object" ||
          Object.keys(body).length !== 2 ||
          typeof body.host !== "string" ||
          !admitted(body.host) ||
          ![1, 28].includes(body.type)
        )
          return reply(response, 403);
        const addresses = await publicAddresses(body.host);
        if (!addresses) return reply(response, 403);
        const family = body.type === 1 ? 4 : 6;
        const answer = new Set(
          addresses.filter((item) => item.family === family).map((item) => item.address),
        );
        return reply(response, 200, JSON.stringify([...answer].slice(0, 4)));
      } catch {
        return reply(response, 502);
      }
    }
    if (github && ["GET", "POST", "PATCH"].includes(method)) {
      const path = service === "dependencies" ? githubPath(target) : target;
      if (
        !path ||
        (service === "dependencies" && !admitted("api.github.com")) ||
        headers.host !== "api.github.com" ||
        headers["transfer-encoding"] ||
        headers["content-encoding"]
      )
        return reply(response, 403);
      const length = contentLength(request, "0");
      if (
        !(length <= (path === "/topic-push" ? 64 * 1024 * 1024 : 1024 * 1024)) ||
        (method === "GET" && length !== 0)
      )
        return reply(response, 403);
      let payload: unknown;
      try {
        if (length)
          payload = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(await readBody(request, length)),
          );
      } catch {
        return reply(response, 403);
      }
      try {
        const answer = await github.dispatch(method, path, payload);
        return reply(response, 200, strictJSON(answer), "application/json");
      } catch (error) {
        return reply(response, error instanceof GitHubOperationDenied ? 403 : 502);
      }
    }
    if (
      probe &&
      method === "GET" &&
      target === "/repos/octocat/Hello-World" &&
      headers.host === "api.github.com" &&
      !headers["transfer-encoding"] &&
      (headers["content-length"] ?? "0") === "0"
    ) {
      try {
        const result = await probe();
        return result.status
          ? reply(response, 502)
          : reply(response, 200, result.output, "application/json");
      } catch {
        return reply(response, 502);
      }
    }
    reply(response, 403);
  };
}

export async function withGatewayScope<T>(run: (start: StartGateway) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "cxi-"));
  const starts: Promise<string>[] = [];
  const stops: (() => void | Promise<void>)[] = [];
  const scope = new AbortController();
  let closing = false;
  let failed = false;

  async function start(service: Service, options: GatewayOptions = {}) {
    if (closing || !["dependencies", "github", "model"].includes(service))
      throw new Error("invalid gateway start");
    const directory = join(root, service);
    mkdirSync(directory, { mode: 0o700 });
    let address = join(directory, "service.sock");
    if (Buffer.byteLength(address) > 107 && process.platform === "linux") {
      const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      stops.push(() => closeSync(fd));
      address = `/proc/${process.pid}/fd/${fd}/service.sock`;
    }
    const { domains = ["cache.nixos.org"], deniedDomains = [] } = options;
    const admitted = (host: string) =>
      allowedDestination(host, domains) && !allowedDestination(host, deniedDomains);
    const model = service === "model" ? modelUpstream(options.codexHome) : undefined;
    let github: GitHubService | undefined;
    if (options.githubPolicy !== undefined) {
      if (service === "dependencies" && !admitted("api.github.com"))
        throw new Error("GitHub is denied by the managed network policy");
      github = await GitHubService.open(
        options.githubPolicy,
        scope.signal,
        options.githubSeed && { directory: `${directory}-publish`, input: options.githubSeed },
      );
    }
    const probe = service === "github" && !github ? githubProbe(scope.signal) : undefined;
    const handler = requestHandler(service, admitted, model, github, probe);
    const connections = new Set<Socket>();
    const handled = new WeakSet<Socket>();
    const active = new Set<Promise<unknown>>();
    const track = (request: Promise<unknown>) => {
      active.add(request);
      void request.then(
        () => active.delete(request),
        () => active.delete(request),
      );
    };
    const respond = (request: IncomingMessage, response: ServerResponse) => {
      response.shouldKeepAlive = false;
      if (handled.has(request.socket)) return reply(response, 403);
      handled.add(request.socket);
      track(handler(request, response));
    };
    const server = createServer(respond);
    server.on("checkContinue", respond);
    server.on("connect", (request, connection, head) => {
      const socket = connection as Socket;
      const target = request.url ?? "";
      const host = target.slice(0, -4);
      if (
        handled.has(socket) ||
        service !== "dependencies" ||
        !target.endsWith(":443") ||
        !admitted(host) ||
        request.headers["transfer-encoding"] ||
        (request.headers["content-length"] ?? "0") !== "0" ||
        request.headers["proxy-authorization"]
      ) {
        socket.end("HTTP/1.0 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      handled.add(socket);
      track(tunnel(socket, head, host));
    });
    server.maxRequestsPerSocket = 1;
    server.setTimeout(120_000, (socket) => socket.destroy());
    server.on("connection", (socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
    });
    const listening = once(server, "listening");
    server.listen(address);
    await listening;
    stops.push(async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      for (const socket of connections) socket.destroy();
      try {
        await closed;
      } finally {
        await Promise.allSettled(active);
      }
    });
    return directory;
  }

  try {
    return await run((service, options) => {
      const started = start(service, options);
      starts.push(started);
      void started.catch(() => {});
      return started;
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    closing = true;
    scope.abort();
    await Promise.allSettled(starts);
    let cleanupFailed = false;
    for (const stop of [...stops.reverse(), () => rmSync(root, { recursive: true })]) {
      try {
        await stop();
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      console.error("gateway cleanup failed");
      if (!failed) throw new GatewayCleanupError("gateway cleanup failed");
    }
  }
}
