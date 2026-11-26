import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { parseArgs } from "node:util";

type GitHubPolicy = {
  repository: string;
  branch: string;
  default_branch: string;
  reviewed_commit: string;
};
type Fields = Record<string, unknown>;

function policy(): GitHubPolicy {
  return JSON.parse(readFileSync("/nix/codex-isolation/launch.json", "utf8")).github;
}

async function request(method: string, path: string, payload?: unknown): Promise<unknown> {
  const proxy = /^http:\/\/127\.0\.0\.1:(\d+)(?:[/?#]|$)/.exec(process.env.HTTP_PROXY ?? "");
  const port = Number(proxy?.[1]);
  if (!port || port > 65535) throw new Error("the managed HTTP proxy is unavailable");
  const body = payload == null ? undefined : Buffer.from(JSON.stringify(payload));
  return await new Promise((resolve, reject) => {
    // The existing host authority performs the authenticated GitHub request over TLS.
    const connection = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        agent: false,
        path: "http://api.github.com" + path,
        headers: {
          Host: "api.github.com",
          "Content-Type": "application/json",
          ...(body
            ? { "Content-Length": body.length }
            : method === "POST"
              ? { "Content-Length": 0 }
              : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("error", reject);
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            if (response.statusCode === 403)
              throw new Error(
                "operation rejected: verify the admitted repository, topic, operation and reviewed automation",
              );
            if (response.statusCode !== 200)
              throw new Error(
                "GitHub connection failed: check host login, repository access, remote changes and network; no additional access was granted",
              );
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    connection.on("error", reject);
    connection.setTimeout(240_000, () => connection.destroy(new Error("timed out")));
    connection.end(body);
  });
}

function output(value: unknown, query?: string) {
  const text = JSON.stringify(value);
  if (query === undefined) {
    console.log(text);
    return;
  }
  const result = Bun.spawnSync(["jq", "-r", query], {
    stdin: Buffer.from(text),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!result.success) throw new Error("jq failed");
}

async function githubAPI(args: string[]) {
  const endpoint = args.shift();
  if (!endpoint)
    throw new Error(
      "isolated gh supports gh api for repository metadata and topic PR operations; see the isolation guide",
    );
  let method: string | undefined;
  let query: string | undefined;
  let payload: unknown;
  while (args.length) {
    const option = args.shift();
    const value = args.shift();
    if (value === undefined) throw new Error("unsupported isolated gh api option");
    switch (option) {
      case "--method":
      case "-X":
        method = value;
        break;
      case "--jq":
      case "-q":
        query = value;
        break;
      case "--input":
        payload = JSON.parse(value === "-" ? await Bun.stdin.text() : readFileSync(value, "utf8"));
        break;
      case "-f":
      case "--raw-field":
      case "-F":
      case "--field": {
        const separator = value.indexOf("=");
        if (separator < 0) throw new Error("gh api fields require key=value");
        const key = value.slice(0, separator);
        const literal = value.slice(separator + 1);
        let item: unknown = literal;
        if (option === "-F" || option === "--field") {
          if (literal.startsWith("@"))
            item =
              literal === "@-" ? await Bun.stdin.text() : readFileSync(literal.slice(1), "utf8");
          else {
            try {
              item = JSON.parse(literal);
            } catch {
              /* A non-JSON field is literal text. */
            }
          }
        }
        if (payload && (typeof payload !== "object" || Array.isArray(payload)))
          throw new Error("gh api fields require a JSON object");
        payload = { ...(payload as Fields | undefined), [key]: item };
        break;
      }
      default:
        throw new Error("unsupported isolated gh api option");
    }
  }
  output(
    await request(
      method ?? (payload == null ? "GET" : "POST"),
      "/" + endpoint.replace(/^\/+/, ""),
      payload,
    ),
    query,
  );
}

async function pullRequest(args: string[]) {
  const usage = "usage: gh pr {create,list,view,edit,comment} [number]";
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        repo: { type: "string", short: "R" },
        head: { type: "string" },
        base: { type: "string" },
        draft: { type: "boolean" },
        title: { type: "string" },
        body: { type: "string" },
        "body-file": { type: "string" },
        json: { type: "string" },
        jq: { type: "string", short: "q" },
        help: { type: "boolean", short: "h" },
      },
    });
    const [action] = parsed.positionals;
    if (
      !parsed.values.help &&
      (!["create", "list", "view", "edit", "comment"].includes(action) ||
        parsed.positionals.length > 2)
    )
      throw new Error("expected an action and an optional PR number");
    if (parsed.values.body !== undefined && parsed.values["body-file"] !== undefined)
      throw new Error("--body and --body-file are mutually exclusive");
  } catch (error) {
    console.error(usage);
    console.error("gh pr: error: " + (error as Error).message);
    process.exitCode = 2;
    return;
  }
  const { values } = parsed;
  if (values.help) {
    console.log(usage);
    return;
  }
  const [action, number] = parsed.positionals;
  if (action !== "create" && (values.head || values.base || values.draft))
    throw new Error("head/base/draft options are only supported for PR creation");
  if (
    (action === "view" || action === "list") &&
    (values.title !== undefined || values.body !== undefined || values["body-file"] !== undefined)
  )
    throw new Error("read-only PR commands do not accept edits");
  if ((action === "create" || action === "list") && number !== undefined)
    throw new Error("this PR command does not accept a number");
  if (action === "create" && values.title === undefined)
    throw new Error("gh pr create requires --title");
  const scope = policy();
  if (values.repo !== undefined && values.repo !== scope.repository)
    throw new Error("repository differs from the admitted GitHub scope");
  const prefix = "/repos/" + scope.repository;
  const payload: Fields = {};
  if (values.title !== undefined) payload.title = values.title;
  if (values.body !== undefined) payload.body = values.body;
  if (values["body-file"] !== undefined) payload.body = readFileSync(values["body-file"], "utf8");
  let result: unknown;
  if (action === "create") {
    result = await request("POST", prefix + "/pulls", {
      ...payload,
      head: values.head || scope.branch,
      base: values.base || scope.default_branch,
      draft: values.draft ?? false,
    });
  } else if (action === "list") {
    result = await request("GET", prefix + "/pulls");
  } else {
    let selected = number;
    if (selected === undefined) {
      const matches = await request("GET", prefix + "/pulls");
      if (!Array.isArray(matches) || matches.length !== 1)
        throw new Error("select one PR number for the admitted topic");
      selected = String(matches[0].number);
    }
    if (!/^\d+$/.test(selected) || !/[1-9]/.test(selected))
      throw new Error("an explicit positive PR number is required");
    if (action === "comment")
      result = await request("POST", prefix + "/issues/" + selected + "/comments", payload);
    else
      result = await request(
        action === "edit" ? "PATCH" : "GET",
        prefix + "/pulls/" + selected,
        action === "edit" ? payload : undefined,
      );
  }
  if (values.json !== undefined) {
    const names = values.json.split(",");
    const select = (value: Fields) => {
      const head = value.head as Fields | undefined;
      const base = value.base as Fields | undefined;
      const expanded: Fields = {
        ...value,
        url: value.html_url ?? null,
        headRefName: head?.ref ?? null,
        baseRefName: base?.ref ?? null,
        isDraft: value.draft ?? null,
      };
      if (!names.every((name) => Object.hasOwn(expanded, name)))
        throw new Error("unsupported PR JSON field");
      return Object.fromEntries(names.map((name) => [name, expanded[name]]));
    };
    result = Array.isArray(result) ? result.map(select) : select(result as Fields);
  }
  if (
    !values.jq &&
    values.json === undefined &&
    result &&
    typeof result === "object" &&
    "html_url" in result
  )
    console.log(result.html_url);
  else output(result, values.jq || undefined);
}

async function publish(args: string[]) {
  if (args.length) throw new Error("usage: git-push-topic");
  const scope = policy();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  });
  const git = (...argv: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...argv], {
      env,
      stderr: "ignore",
    });
    if (!result.success) throw new Error("Git command failed: " + argv[0]);
    return result.stdout;
  };
  if (git("branch", "--show-current").toString().trim() !== scope.branch)
    throw new Error("current branch differs from the admitted topic");
  const head = git("rev-parse", "HEAD").toString().trim();
  const bundle =
    head === scope.reviewed_commit
      ? ""
      : git("bundle", "create", "-", "HEAD", "^" + scope.reviewed_commit).toString("base64");
  const result = (await request("POST", "/topic-push", { head, bundle })) as Fields;
  console.log(`published ${result.head} to ${result.repository}:${result.branch}`);
}

try {
  const args = process.argv.slice(2);
  if (args[0] !== "gh") await publish(args);
  else if (args[1] === "pr") await pullRequest(args.slice(2));
  else await githubAPI(args[1] === "api" ? args.slice(2) : []);
} catch (error) {
  console.error("isolated GitHub: " + (error as Error).message);
  process.exitCode = 1;
}
