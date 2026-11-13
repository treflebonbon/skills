import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";

function main(args: string[]) {
  const [directory, port] = args;
  if (args.length !== 2 || !directory || !port || !/^\d+$/.test(port) || Number(port) > 65535)
    throw new Error("使い方: serve-local <document-root> <port: 0-65535>");
  const root = realpathSync(directory);
  if (!statSync(root).isDirectory())
    throw new Error("document root は directory を指定してください");
  const pathInRoot = (requested: string) => {
    const path = realpathSync(requested);
    const name = relative(root, path);
    if (name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name))
      throw new Error("document root の外です");
    return path;
  };
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(501, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("未対応の method です\n");
      return;
    }
    try {
      const target = request.url!;
      const pathname = target.split(/[?#]/)[0]!;
      let requested = resolve(root, `.${decodeURIComponent(pathname)}`);
      let path = pathInRoot(requested);
      if (statSync(path).isDirectory()) {
        if (!pathname.endsWith("/")) {
          response.writeHead(301, { Location: `${pathname}/${target.slice(pathname.length)}` });
          response.end();
          return;
        }
        requested = resolve(requested, "index.html");
        path = pathInRoot(requested);
      }
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!fstatSync(fd).isFile()) throw new Error("通常ファイルではありません");
        const body = readFileSync(fd);
        response.writeHead(200, {
          "Content-Type": Bun.file(requested).type,
          "Content-Length": body.length,
        });
        response.end(body);
      } finally {
        closeSync(fd);
      }
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("見つかりません\n");
    }
  });
  server.on("error", (error) => {
    console.error(`エラー: ${(error as NodeJS.ErrnoException).code ?? "listen"}: ${error.message}`);
    process.exit(1);
  });
  server.listen(Number(port), "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listen 先を確認できません");
    console.log(JSON.stringify({ root, url: `http://${address.address}:${address.port}/` }));
  });
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`エラー: ${(error as Error).message}`);
  process.exit(1);
}
