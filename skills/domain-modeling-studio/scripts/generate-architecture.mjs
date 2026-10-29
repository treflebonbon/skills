import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { posix } = path;

const REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;

// ponytail: single-line regex scan, not a real parser — misses multi-line or
// grouped import blocks (e.g. Go's `import (...)`, Python's parenthesised
// `from x import (a, b)`). Upgrade to a per-language parser only if a real
// fixture repository actually needs one; exhaustive resolution is outside the
// bounded scope described in ../references/architecture-scope.md.
const IMPORT_PATTERNS = [
  { pattern: /^\s*import\s+.*?\bfrom\s+["'](?<spec>[^"']+)["']/u },
  { pattern: /^\s*import\s+["'](?<spec>[^"']+)["']/u },
  { pattern: /^\s*export\s+.*?\bfrom\s+["'](?<spec>[^"']+)["']/u },
  { pattern: /\brequire\(\s*["'](?<spec>[^"']+)["']\s*\)/u },
  { pattern: /^\s*require_relative\s+["'](?<spec>[^"']+)["']/u },
  { pattern: /^\s*require\s+["'](?<spec>[^"']+)["']/u },
  { pattern: /^\s*from\s+(?<spec>[\w.]+)\s+import\b/u },
  { pattern: /^\s*import\s+(?<spec>[\w.]+)/u },
  { pattern: /^\s*use\s+(?<spec>[\w:]+)/u },
  { alwaysRelative: true, pattern: /^\s*#include\s*"(?<spec>[^"]+)"/u },
  { alwaysExternal: true, pattern: /^\s*#include\s*<(?<spec>[^>]+)>/u },
];

const scanImports = (content) => {
  const found = [];
  for (const [index, line] of content.split("\n").entries()) {
    for (const candidate of IMPORT_PATTERNS) {
      const match = candidate.pattern.exec(line);
      if (match) {
        found.push({
          alwaysExternal: candidate.alwaysExternal,
          alwaysRelative: candidate.alwaysRelative,
          line: index + 1,
          specifier: match.groups.spec,
        });
        break;
      }
    }
  }
  return found;
};

const RELATIVE_SUFFIXES = [
  "",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".rs",
  "/index.js",
  "/index.jsx",
  "/index.ts",
  "/index.tsx",
  "/index.mjs",
  "/index.cjs",
  "/__init__.py",
  "/mod.rs",
];

// Rust's `crate::`/`self::`/`super::` prefixes are the only bare (dot-less)
// specifiers this heuristic treats as internal; a plain `use serde::...` is
// indistinguishable from a third-party crate without reading Cargo.toml. The
// trailing segment is often an item (function/struct), not a module, so
// candidates are tried from the full path down to its first segment.
const rustCandidates = (specifier, fromDir) => {
  let base;
  let rest;
  if (specifier.startsWith("crate::")) {
    [base, rest] = ["src", specifier.slice("crate::".length)];
  } else if (specifier.startsWith("self::")) {
    [base, rest] = [fromDir, specifier.slice("self::".length)];
  } else if (specifier.startsWith("super::")) {
    [base, rest] = [posix.dirname(fromDir), specifier.slice("super::".length)];
  } else {
    return null;
  }
  const segments = posix
    .join(base, rest.replaceAll("::", "/"))
    .split("/")
    .filter(Boolean);
  return segments.map((_, i) =>
    segments.slice(0, segments.length - i).join("/")
  );
};

// Python's leading-dot syntax (`.mod`, `..pkg.mod`) counts package levels
// instead of being a literal path segment like JS's `./mod`.
const pythonCandidate = (specifier, fromDir) => {
  const match = /^(?<dots>\.+)(?<rest>[\w.]*)$/u.exec(specifier);
  if (!match) {
    return null;
  }
  let dir = fromDir;
  for (let i = 1; i < match.groups.dots.length; i += 1) {
    dir = posix.dirname(dir);
  }
  const rest = match.groups.rest.replaceAll(".", "/");
  return rest ? posix.join(dir, rest) : dir;
};

const relativeCandidates = (specifier, fromDir) =>
  rustCandidates(specifier, fromDir) ??
  (specifier.startsWith(".") &&
  !specifier.startsWith("./") &&
  !specifier.startsWith("../")
    ? [pythonCandidate(specifier, fromDir)]
    : [posix.join(fromDir, specifier)]);

const resolveRelative = (repoRoot, fromRelPath, specifier) => {
  const fromDir = posix.dirname(fromRelPath);
  for (const base of relativeCandidates(specifier, fromDir)) {
    for (const suffix of RELATIVE_SUFFIXES) {
      const candidate = posix.normalize(base + suffix);
      if (candidate === ".." || candidate.startsWith("../")) {
        continue;
      }
      // An empty suffix matches a directory too (existsSync alone can't
      // tell), which would record e.g. "src/foo" as a MODULE for
      // `import x from "./foo"` when only "src/foo/index.js" is a real
      // source file; require the candidate to resolve to an actual file.
      const absoluteCandidate = path.join(repoRoot, candidate);
      if (
        existsSync(absoluteCandidate) &&
        statSync(absoluteCandidate).isFile()
      ) {
        return candidate;
      }
    }
  }
  return null;
};

const isRelativeSpecifier = (specifier, { alwaysRelative, alwaysExternal }) => {
  if (alwaysExternal) {
    return false;
  }
  return (
    alwaysRelative ||
    specifier.startsWith(".") ||
    specifier.startsWith("crate::") ||
    specifier.startsWith("self::") ||
    specifier.startsWith("super::")
  );
};

// An unresolved `use serde::Deserialize;` names an item, not a module; group
// it under its crate ("serde") so it has the same package-level granularity
// as a JS/Python EXTERNAL node instead of one node per imported item.
const externalLabel = (specifier) =>
  specifier.includes("::") ? specifier.split("::")[0] : specifier;

const hashId = (seed) =>
  createHash("sha1").update(seed).digest("hex").slice(0, 16);

const makeNode = (id, label, kind, x, y) => ({
  data: { evidence: [], kind, label, origin: "inference" },
  height: 70,
  id,
  position: { x, y },
  width: 220,
});

/**
 * Scan only the given seed files' import/require-like statements and add one
 * hop of neighbors (resolvable relative imports become MODULE nodes,
 * everything else becomes EXTERNAL). Neighbors are never themselves scanned,
 * so the result is bounded by the seed list plus one hop — never the whole
 * repository.
 */
export const generateArchitecture = async ({ repoRoot, revision, seeds }) => {
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error(
      "revisionは完全な40/64桁の16進コミットIDで指定してください"
    );
  }
  for (const seed of seeds) {
    if (seed.startsWith("/") || seed.split("/").includes("..")) {
      throw new Error(`seedはリポジトリ相対パスで指定してください: ${seed}`);
    }
  }

  const contents = await Promise.all(
    seeds.map((seed) => readFile(path.join(repoRoot, seed), "utf-8"))
  );

  const nodeIdByKey = new Map();
  const nodes = [];
  const edges = [];
  const edgeKeys = new Set();
  let row = 0;

  const getOrCreateNode = (prefix, label, kind, x) => {
    const key = `${prefix}:${label}`;
    if (!nodeIdByKey.has(key)) {
      const id = hashId(key);
      nodeIdByKey.set(key, id);
      nodes.push(makeNode(id, label, kind, x, row * 100));
      row += 1;
    }
    return nodeIdByKey.get(key);
  };
  const moduleNode = (relPath) =>
    getOrCreateNode("module", relPath, "MODULE", 0);
  const externalNode = (specifier) =>
    getOrCreateNode("external", externalLabel(specifier), "EXTERNAL", 400);

  for (const [index, seed] of seeds.entries()) {
    const sourceId = moduleNode(seed);
    for (const match of scanImports(contents[index])) {
      const resolved = isRelativeSpecifier(match.specifier, match)
        ? resolveRelative(repoRoot, seed, match.specifier)
        : null;
      const targetId = resolved
        ? moduleNode(resolved)
        : externalNode(match.specifier);
      if (targetId === sourceId) {
        continue;
      }
      const edgeKey = `${sourceId}->${targetId}`;
      if (edgeKeys.has(edgeKey)) {
        continue;
      }
      edgeKeys.add(edgeKey);
      edges.push({
        data: {
          evidence: [
            { line: match.line, path: seed, revision, symbol: match.specifier },
          ],
          origin: "inference",
        },
        id: hashId(`edge:${edgeKey}`),
        label: "imports",
        source: sourceId,
        target: targetId,
      });
    }
  }
  return { edges, nodes };
};

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [repoRoot, revision, ...seeds] = process.argv.slice(2);
  if (!repoRoot || !revision || seeds.length === 0) {
    throw new Error(
      "Usage: node scripts/generate-architecture.mjs <repo-root> <revision> <seed-file...>"
    );
  }
  const graph = await generateArchitecture({
    repoRoot: path.resolve(repoRoot),
    revision,
    seeds,
  });
  console.log(JSON.stringify(graph, null, 2));
}
