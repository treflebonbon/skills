import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";

const kinds = new Set([
  "call_expression",
  "return_statement",
  "if_statement",
  "ternary_expression",
  "yield_expression",
  "throw_statement",
  "arrow_function",
  "function_declaration",
  "function_expression",
]);
const languages = new Map([
  [".ts", "TypeScript"],
  [".tsx", "Tsx"],
]);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type SyntaxNode = {
  path: string;
  kind: string;
  start: number;
  end: number;
  byte_start: number;
  byte_end: number;
  text: string;
  text_truncated: boolean;
  id: number;
  parent: number | null;
};

type Evidence = {
  schema_version: 1;
  status: "ok" | "unavailable" | "failed";
  reason: string | null;
  capabilities: "syntax-only";
  files: { path: string; sha256: string }[];
  nodes: SyntaxNode[];
};

function lineAt(contents: Buffer, offset: number) {
  let line = 1;
  for (
    let newline = contents.indexOf(10);
    newline !== -1 && newline < offset;
    newline = contents.indexOf(10, newline + 1)
  ) {
    line++;
  }
  return line;
}

function collect(repoRoot: string, files: string[]): Evidence {
  const result: Evidence = {
    schema_version: 1,
    status: "failed",
    reason: null,
    capabilities: "syntax-only",
    files: [],
    nodes: [],
  };
  const executable = Bun.which("ast-grep");
  if (!executable) {
    return { ...result, status: "unavailable", reason: "ast-grep is not on PATH" };
  }

  try {
    const root = realpathSync.native(repoRoot);
    const sources = [];
    for (const name of new Set(files)) {
      // Preserve .. until realpath resolves any preceding symlink.
      const source = realpathSync.native(isAbsolute(name) ? name : root + sep + name);
      const path = relative(root, source);
      if (path === ".." || path.startsWith(".." + sep) || isAbsolute(path)) {
        throw new Error("File is outside the repository root: " + name);
      }
      const language = languages.get(extname(source));
      if (!language || !statSync(source).isFile()) {
        throw new Error("Expected a .ts or .tsx file: " + name);
      }
      const contents = readFileSync(source);
      sources.push({ path, language, contents });
      result.files.push({ path, sha256: createHash("sha256").update(contents).digest("hex") });
    }

    const nodes: SyntaxNode[] = [];
    const deadline = performance.now() + 30_000;
    // Run ast-grep outside the target repository's configuration.
    const directory = mkdtempSync(join(tmpdir(), "rop-syntax-"));
    try {
      for (const { path, language, contents } of sources) {
        const rules = [...kinds, "ERROR"].map((kind) => ({ id: kind, language, rule: { kind } }));
        // Recovered missing tokens have empty text, including unnamed tokens.
        const missingToken = {
          id: "missing-token",
          language,
          rule: { kind: "program", has: { regex: "^$", stopBy: "end" } },
        };
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0) throw new Error("ast-grep extraction exceeded 30 seconds");

        const proc = spawnSync(
          executable,
          [
            "scan",
            "--stdin",
            "--inline-rules",
            [...rules, missingToken].map((rule) => JSON.stringify(rule)).join("\n---\n"),
            "--json=compact",
          ],
          {
            input: utf8.decode(contents),
            cwd: directory,
            timeout: remaining,
            killSignal: "SIGKILL",
            maxBuffer: Infinity,
          },
        );
        if (proc.error) {
          if ("code" in proc.error && proc.error.code === "ETIMEDOUT") {
            throw new Error("ast-grep extraction exceeded 30 seconds");
          }
          throw proc.error;
        }
        if (proc.status !== 0 && proc.status !== 1) {
          throw new Error(
            "ast-grep exited " +
              (proc.status ?? proc.signal) +
              ": " +
              utf8.decode(proc.stderr).slice(0, 500),
          );
        }
        const matches: unknown = JSON.parse(utf8.decode(proc.stdout));
        if (!Array.isArray(matches)) throw new Error("ast-grep returned a non-array result");

        for (const match of matches) {
          const kind = match.ruleId;
          if (kind === "ERROR" || kind === "missing-token") {
            throw new Error("ast-grep reported a syntax error (" + kind + ") in " + path);
          }
          if (!kinds.has(kind)) throw new Error("Unexpected syntax kind: " + kind);
          const { start, end } = match.range.byteOffset;
          if (
            !Number.isInteger(start) ||
            !Number.isInteger(end) ||
            start < 0 ||
            start >= end ||
            end > contents.length
          ) {
            throw new Error("ast-grep returned an invalid source range");
          }
          const text = utf8.decode(contents.subarray(start, end));
          if (text !== match.text)
            throw new Error("ast-grep text does not match the supplied source");
          const characters = Array.from(text);
          nodes.push({
            path,
            kind,
            start: lineAt(contents, start),
            end: lineAt(contents, end - 1),
            byte_start: start,
            byte_end: end,
            text: characters.slice(0, 180).join(""),
            text_truncated: characters.length > 180,
            id: 0,
            parent: null,
          });
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    nodes.sort(
      (a, b) =>
        Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)) ||
        a.byte_start - b.byte_start ||
        b.byte_end - a.byte_end ||
        Buffer.compare(Buffer.from(a.kind), Buffer.from(b.kind)),
    );
    const stack: SyntaxNode[] = [];
    for (const [id, node] of nodes.entries()) {
      node.id = id;
      let enclosing = stack.at(-1);
      while (
        enclosing &&
        (enclosing.path !== node.path ||
          enclosing.byte_end < node.byte_end ||
          enclosing.byte_end <= node.byte_start)
      ) {
        stack.pop();
        enclosing = stack.at(-1);
      }
      // Equal spans share a parent and leave the first match as the enclosing node.
      if (
        enclosing &&
        enclosing.byte_start === node.byte_start &&
        enclosing.byte_end === node.byte_end
      ) {
        node.parent = enclosing.parent;
      } else {
        node.parent = enclosing?.id ?? null;
        stack.push(node);
      }
    }
    return { ...result, status: "ok", nodes };
  } catch (error) {
    const reason = error instanceof Error ? error.name + ": " + error.message : String(error);
    return { ...result, reason: Array.from(reason).slice(0, 600).join("") };
  }
}

const usage =
  "Usage: extract-typescript.ts --repo-root ROOT --output FILE source.ts [source.tsx ...]";

function main() {
  let args;
  try {
    args = parseArgs({
      options: {
        "repo-root": { type: "string" },
        output: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    console.error(usage + "\n" + String(error));
    process.exitCode = 2;
    return;
  }
  const { values, positionals } = args;
  if (values.help) {
    console.log(usage);
    return;
  }
  if (values["repo-root"] === undefined || values.output === undefined || !positionals.length) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const output = values.output || ".";
  const result = collect(values["repo-root"] || ".", positionals);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(result.status + ": " + output);
}

main();
