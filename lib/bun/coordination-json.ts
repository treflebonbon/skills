import { parsePeerJSON } from "./peer-json.ts";
import { readFileSync } from "node:fs";

export const strip = (value: string) =>
  value.replace(
    /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,
    "",
  );
export const object = (value: any): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export class DuplicateKey extends Error {}
export const stripEnd = (value: string) =>
  value.replace(/[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, "");
export function coordinationJSON(raw: Uint8Array): any {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,]/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (/^-?\d+$/.test(token) && token.replace(/^-/, "").length > 4300)
      throw new RangeError("JSON の整数は旧 Python と同じ4300桁以内で指定してください");
  }
  const value = parsePeerJSON(raw);
  const stack: (Set<string> | null)[] = [];
  let previous = "";
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token === ":") {
      const key = JSON.parse(previous),
        keys = stack.at(-1)!;
      if (keys!.has(key)) throw new DuplicateKey("JSON に重複キーがあります");
      keys!.add(key);
    }
    previous = token;
  }
  return value;
}

if (import.meta.main) {
  if (process.argv.length !== 3) {
    console.error("使い方: coordination-json.ts <JSON file | ->");
    process.exitCode = 2;
  } else {
    try {
      coordinationJSON(readFileSync(process.argv[2] === "-" ? 0 : process.argv[2]!));
    } catch (error) {
      console.error(
        error instanceof DuplicateKey || error instanceof RangeError
          ? error.message
          : "JSON を読み取れません",
      );
      process.exitCode = 1;
    }
  }
}
