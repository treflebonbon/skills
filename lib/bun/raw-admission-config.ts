import { posix as path } from "node:path";
import type { Repository } from "./git-context.ts";
import { parse } from "./vendor/smol-toml/parse.js";

export type Table = Record<string, unknown>;

export function isTable(value: unknown): value is Table {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent === "/" ? "/" : parent + "/");
}

function canonical(value: string, absolute: boolean): boolean {
  return (
    path.isAbsolute(value) === absolute &&
    value !== "" &&
    !value.includes("\0") &&
    !value.split("/").includes("..") &&
    path.normalize(value) === value &&
    (value === "/" || !value.endsWith("/"))
  );
}

function namespacePolicy(value: unknown, modes: readonly string[]): boolean {
  if (typeof value === "string") return modes.includes(value);
  return (
    isTable(value) &&
    Object.entries(value).every(
      ([key, mode]) =>
        key !== "" &&
        !key.startsWith("/") &&
        !key.split("/").includes("..") &&
        namespacePolicy(mode, modes),
    )
  );
}

function hostReadPolicy(value: unknown): boolean {
  if (typeof value === "string") return value === "read" || value === "deny";
  return (
    isTable(value) &&
    Object.entries(value).every(([key, mode]) => key !== "" && key !== ".." && hostReadPolicy(mode))
  );
}

function workspacePolicy(value: unknown): boolean {
  return (
    isTable(value) &&
    value["."] === "write" &&
    Object.entries(value).every(
      ([key, mode]) => key === "." || (key !== "" && key !== ".." && mode === "deny"),
    )
  );
}

function relativeRule(key: string): string {
  if (key.includes("\\") || !canonical(key, false))
    throw new Error("managed host filesystem contains an invalid relative path rule");
  return key;
}

function validateHostRules(value: unknown): void {
  if (!isTable(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key !== ".") relativeRule(key);
    validateHostRules(child);
  }
}

const wildcard = /[*?\[\]{}]/;
const readOnly = ["read", "deny"];
const publicModes = [...readOnly, "write"];

function componentMatches(value: string, pattern: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      expression += ".*";
    } else if (character === "?") {
      expression += ".";
    } else if (character === "[") {
      let start = index + 1;
      const negated = pattern[start] === "!";
      if (negated) start++;
      const end = pattern.indexOf("]", pattern[start] === "]" ? start + 1 : start);
      if (end === -1) {
        expression += "\\[";
      } else {
        const escape = (part: string) => part.replace(/[\\\[\]^]/g, "\\$&");
        expression += "[" + (negated ? "^" : "") + escape(pattern.slice(start, end)) + "]";
        index = end;
      }
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  try {
    return new RegExp(expression + "(?![\\s\\S])", "su").test(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Ambiguous bracket ranges may restrict a public path.
    return true;
  }
}

function projectFilesystem(filesystem: unknown, repo: Repository): Table {
  if (!isTable(filesystem)) throw new Error("managed filesystem policy must be a table");

  const home = process.env.HOME;
  const hostRoots = new Set<string>();
  for (const name of [
    "HOME",
    "CODEX_HOME",
    "GH_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
  ]) {
    const value = process.env[name];
    if (value === undefined) continue;
    if (!canonical(value, true) || value === "/")
      throw new Error("managed filesystem roots must be canonical absolute paths");
    hostRoots.add(value);
  }

  const metadata = new Set([repo.gitDir, repo.commonDir]);
  const exposed = [...new Set([repo.root, ...metadata])];
  const inPublic = (value: string) => exposed.some((root) => within(value, root));
  const containsPublic = (value: string) => exposed.some((root) => within(root, value));
  const projected: Table = Object.create(null);

  function add(name: string, value: unknown): void {
    if (Object.hasOwn(projected, name))
      throw new Error("managed filesystem contains duplicate normalized path grants");
    projected[name] = value;
  }

  function addHostRestriction(name: string, value: unknown): void {
    if (!namespacePolicy(value, readOnly))
      throw new Error("host ancestor restrictions for public paths must be read-only");
    for (const target of exposed)
      if (within(name, target) || within(target, name)) add(target, value);
  }

  function patternMayMatch(base: string, pattern: string): boolean {
    return exposed.some((root) => {
      if (!within(root, base)) return false;
      const rootParts = root === base ? [] : root.slice(base.length + 1).split("/");
      for (const [index, part] of pattern.split("/").entries()) {
        if (part === "**" || /[{}]/.test(part) || index === rootParts.length) return true;
        if (
          wildcard.test(part)
            ? !componentMatches(rootParts[index], part)
            : part !== rootParts[index]
        )
          return false;
      }
      return true;
    });
  }

  function projectHostRules(base: string, value: unknown, includeBase = false): void {
    if (!isTable(value)) {
      if (includeBase) addHostRestriction(base, value);
      return;
    }
    if (includeBase && Object.hasOwn(value, ".")) addHostRestriction(base, value["."]);
    for (const [key, child] of Object.entries(value)) {
      if (key === ".") continue;
      const relative = relativeRule(key);
      if (wildcard.test(relative)) {
        if (patternMayMatch(base, relative))
          throw new Error("managed ancestor pattern may affect a public path");
        continue;
      }
      const target = path.join(base, relative);
      if (inPublic(target)) {
        if (!namespacePolicy(child, readOnly))
          throw new Error("host ancestor restrictions for public paths must be read-only");
        add(target, child);
      } else if (containsPublic(target)) {
        projectHostRules(target, child, true);
      }
    }
  }

  for (const [key, value] of Object.entries(filesystem)) {
    if (key === "glob_scan_max_depth") {
      if (typeof value !== "bigint" || value < 1n)
        throw new Error("managed filesystem scan depth is invalid");
      add(key, value);
      continue;
    }
    if (key === ":root" || key === ":minimal" || key === ":slash_tmp") {
      if (key === ":root" && value !== "deny")
        throw new Error("raw filesystem root access must remain denied");
      if (key === ":minimal" && value !== "read")
        throw new Error("raw minimal filesystem access must remain read-only");
      if (key === ":slash_tmp" && value !== "deny")
        throw new Error("raw host /tmp access must remain denied");
      add(key, value);
      continue;
    }
    if (key === ":workspace_roots") {
      if (!workspacePolicy(value))
        throw new Error("raw workspace policy must grant writes with deny rules only");
      add(key, value);
      continue;
    }

    let name = key;
    if (key === "~" || key.startsWith("~/")) {
      if (!home) throw new Error("managed home grants cannot be projected without HOME");
      name = home + key.slice(1);
    } else if (key.startsWith("~")) {
      throw new Error("managed filesystem contains an unsupported home grant");
    }
    if (!canonical(name, true))
      throw new Error("managed filesystem contains an invalid path grant");

    if (metadata.has(name)) {
      if (!namespacePolicy(value, publicModes))
        throw new Error("raw Git metadata policy is invalid");
    } else if (inPublic(name)) {
      if (!namespacePolicy(value, publicModes))
        throw new Error("raw public filesystem policy is invalid");
    } else if (name === "/nix") {
      if (value !== "read") throw new Error("raw Nix runtime access must remain read-only");
    } else if (within(name, "/nix")) {
      if (!namespacePolicy(value, readOnly))
        throw new Error("raw Nix filesystem policy must remain read-only");
    } else if (name === "/tmp/codex") {
      if (!workspacePolicy(value))
        throw new Error("raw private scratch policy must grant writes with deny rules only");
    } else if ([...hostRoots].some((root) => within(name, root))) {
      validateHostRules(value);
      if (!hostReadPolicy(value))
        throw new Error("host filesystem grants must be read-only before projection");
      if (isTable(value) && containsPublic(name)) projectHostRules(name, value);
      continue;
    } else {
      throw new Error("managed filesystem contains an unrecognized namespace grant");
    }
    add(name, value);
  }

  if (!Object.hasOwn(projected, "/tmp/codex"))
    throw new Error("managed filesystem must allow private /tmp/codex scratch");

  for (const name of metadata) {
    const existing = projected[name];
    if (existing === undefined) {
      projected[name] = "write";
    } else if (isTable(existing) && (existing["."] ?? "write") === "write") {
      existing["."] = "write";
    } else if (existing !== "write") {
      throw new Error("raw Git metadata root must remain writable");
    }
  }
  return projected;
}

export function readManagedConfig(text: string, repo: Repository) {
  let config: Table;
  try {
    config = parse(text.replaceAll("\r\n", "\n"), { integersAsBigInt: true, useLegacyDate: false });
  } catch {
    throw new Error("invalid managed TOML configuration");
  }
  const profiles = Object.hasOwn(config, "permissions") ? config.permissions : {};
  delete config.permissions;
  if (!isTable(profiles)) throw new Error("managed permission profiles must be a table");
  const profile = profiles["dotfiles-secure"];
  if (
    !isTable(profile) ||
    profile.extends !== ":workspace" ||
    !isTable(profile.network) ||
    profile.network.enabled !== true ||
    !isTable(profile.network.domains)
  ) {
    throw new Error("managed dotfiles-secure filesystem and network policy is required");
  }
  const domains: string[] = [];
  const denied: string[] = [];
  for (const [name, mode] of Object.entries(profile.network.domains)) {
    if (mode === "allow") domains.push(name);
    else if (mode === "deny") denied.push(name);
    else throw new Error("managed network domain policy is invalid");
  }
  if (!domains.length) throw new Error("managed network domain policy is required");

  profile.filesystem = projectFilesystem(profile.filesystem, repo);
  profile.workspace_roots = {};
  config.default_permissions = "dotfiles-secure";
  return { config, profile, domains, denied };
}

export function asciiJSON(text: string): string {
  return text.replace(
    /[\u007f-\uffff]/g,
    (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function tomlKey(key: string): string {
  return asciiJSON(JSON.stringify(key));
}

function pythonFloat(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Object.is(value, -0)) return "-0.0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e16 || (magnitude !== 0 && magnitude < 1e-4))
    return value.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
  return Number.isInteger(value) ? value.toString() + ".0" : value.toString();
}

function tomlValue(value: unknown): string {
  if (isTable(value))
    return (
      "{" +
      Object.entries(value)
        .map(([key, item]) => tomlKey(key) + "=" + tomlValue(item))
        .join(",") +
      "}"
    );
  if (Array.isArray(value)) return "[" + value.map(tomlValue).join(",") + "]";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return pythonFloat(value);
  throw new Error("unsupported public configuration value");
}

export function tomlDocument(document: Table): string {
  const lines: string[] = [];
  function table(values: Table, keys: string[]): void {
    if (keys.length) lines.push("[" + keys.map(tomlKey).join(".") + "]");
    const entries = Object.entries(values);
    for (const [key, value] of entries) {
      if (!isTable(value)) lines.push(tomlKey(key) + "=" + tomlValue(value));
    }
    for (const [key, value] of entries) if (isTable(value)) table(value, [...keys, key]);
  }
  table(document, []);
  return lines.join("\n") + "\n";
}
