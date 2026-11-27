import { readFileSync } from "node:fs";
import { validateHeaderValue, type IncomingMessage, type ServerResponse } from "node:http";
import { request } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseStrictJSON, strictJSON } from "./strict-json.ts";

const fields = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "stream_options",
  "include",
  "service_tier",
  "prompt_cache_key",
  "text",
  "client_metadata",
]);
const localItems = new Set([
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "reasoning",
  "compaction",
]);
const localContent = new Set([
  "input_text",
  "output_text",
  "summary_text",
  "reasoning_text",
  "encrypted_content",
]);

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function localTools(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (tool) =>
        record(tool) &&
        (tool.type === "namespace"
          ? localTools(Object.hasOwn(tool, "tools") ? tool.tools : [])
          : tool.type === "function" || tool.type === "custom"),
    )
  );
}

function localRequest(payload: unknown): payload is Record<string, unknown> {
  if (
    !record(payload) ||
    !Object.keys(payload).every((field) => fields.has(field)) ||
    !localTools(Object.hasOwn(payload, "tools") ? payload.tools : [])
  )
    return false;
  const items = Object.hasOwn(payload, "input") ? payload.input : [];
  return (
    Array.isArray(items) &&
    items.every((item) => {
      if (!record(item) || typeof item.type !== "string") return false;
      if (item.type === "additional_tools")
        return localTools(Object.hasOwn(item, "tools") ? item.tools : []);
      if (item.type === "message" || item.type === "agent_message") {
        return (
          Array.isArray(item.content) &&
          item.content.every(
            (content) =>
              record(content) &&
              ((typeof content.type === "string" && localContent.has(content.type)) ||
                (content.type === "input_image" &&
                  typeof content.image_url === "string" &&
                  content.image_url.startsWith("data:image/")) ||
                (content.type === "input_audio" &&
                  typeof content.audio_url === "string" &&
                  content.audio_url.startsWith("data:audio/"))),
          )
        );
      }
      return localItems.has(item.type);
    })
  );
}

export function modelUpstream(codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
  let authorization: string;
  let account: string;
  try {
    const { tokens } = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
    if (
      typeof tokens.access_token !== "string" ||
      !tokens.access_token ||
      typeof tokens.account_id !== "string" ||
      !tokens.account_id
    )
      throw new Error();
    authorization = `Bearer ${tokens.access_token}`;
    account = tokens.account_id;
    validateHeaderValue("Authorization", authorization);
    validateHeaderValue("ChatGPT-Account-Id", account);
  } catch {
    throw new Error("host ChatGPT login is unavailable");
  }

  return async (raw: Buffer, response: ServerResponse): Promise<number> => {
    const payload: unknown = parseStrictJSON(raw);
    if (!localRequest(payload)) return 403;
    payload.store = false;
    const body = strictJSON(payload, 0).trimEnd();
    if (response.destroyed) return 502;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    response.once("close", cancel);
    let upstream: IncomingMessage | undefined;
    try {
      upstream = await new Promise<IncomingMessage>((resolve, reject) => {
        const outgoing = request(
          {
            protocol: "https:",
            hostname: "chatgpt.com",
            port: 443,
            method: "POST",
            path: "/backend-api/codex/responses",
            agent: false,
            signal: abort.signal,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              Accept: "text/event-stream",
              Authorization: authorization,
              "ChatGPT-Account-Id": account,
              "User-Agent": "codex-isolation-probe/270",
            },
          },
          resolve,
        );
        outgoing.on("error", reject);
        outgoing.setTimeout(120_000, () => outgoing.destroy(new Error("model upstream timed out")));
        outgoing.end(body);
      });
      const status = upstream.statusCode ?? 502;
      if (status !== 200) return status;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
      await pipeline(upstream, response);
      return 200;
    } finally {
      upstream?.destroy();
      response.off("close", cancel);
    }
  };
}
