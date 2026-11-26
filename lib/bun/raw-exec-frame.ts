import { readFileSync, writeSync } from "node:fs";
import { decodeSurrogateEscape } from "./devshell-environment.ts";

export function rawArguments(): string[] {
  const argv = decodeSurrogateEscape(readFileSync("/proc/self/cmdline")).split("\0");
  argv.pop();
  return argv.slice(argv.length - (process.argv.length - 2));
}

export function writeExecFrame(argv: string[], environment: NodeJS.ProcessEnv = process.env) {
  const removed = Object.keys(process.env).filter((name) => environment[name] === undefined);
  const changed = Object.entries(environment)
    .filter(([name, value]) => value !== undefined && value !== process.env[name])
    .map(([name, value]) => name + "=" + value);
  const fields = [
    "exec-proof-v1",
    "search",
    argv[0],
    String(argv.length),
    ...argv,
    String(removed.length),
    ...removed,
    String(changed.length),
    ...changed,
  ];
  if (!argv[0] || fields.some((field) => field.includes("\0")))
    throw new Error("invalid exec argument or environment");

  const frame = fields.join("\0") + "\0";
  const parts: Buffer[] = [];
  let offset = 0;
  // Preserve Python's surrogateescaped bytes without changing valid UTF-8 arguments.
  for (const match of frame.matchAll(/[\udc80-\udcff]/gu)) {
    parts.push(
      Buffer.from(frame.slice(offset, match.index)),
      Buffer.from([match[0].charCodeAt(0) - 0xdc00]),
    );
    offset = match.index + 1;
  }
  parts.push(Buffer.from(frame.slice(offset)));
  const bytes = Buffer.concat(parts);
  for (let written = 0; written < bytes.length;)
    written += writeSync(1, bytes, written, bytes.length - written);
}
