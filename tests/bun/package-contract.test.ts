import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { resolve, dirname, basename, extname } from "node:path";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => fs.readFileSync(resolve(root, path), "utf8");
const json = (path: string): any => JSON.parse(read(path));
const version = json("plugin.json").version;
const skills = [
  "dogfood",
  "domain-modeling-studio",
  "herdr-peer-refactor",
  "marp",
  "md-agents-review",
  "md-claude-review",
  "orca-peer-refactor",
  "pr-screenshots",
  "product-guide",
  "rop",
  "ui-grill-with-docs",
  "worktree-gc",
];
const environment = (name: string) => name === ".env" || name.startsWith(".env.");
const frontmatter = (name: string) => {
  const match = read("skills/" + name + "/SKILL.md").match(/^---\n([\s\S]*?)\n---\n/);
  expect(match, name + " frontmatter").not.toBeNull();
  return match![1];
};

test("test_skill_directories_are_the_exact_public_set", () => {
  const names = fs
    .readdirSync(resolve(root, "skills"))
    .filter((name) => fs.existsSync(resolve(root, "skills", name, "SKILL.md")));
  expect(names.sort(), "公開 skill 集合").toEqual([...skills].sort());
  for (const name of skills) {
    expect(frontmatter(name), name + " name").toMatch(new RegExp("^name: " + name + "$", "m"));
    expect(frontmatter(name), name + " description").toMatch(/^description:\s*\S/m);
  }
});

test("test_every_manifest_and_package_uses_plugin_version", () => {
  expect(version, "plugin.json version").toMatch(
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/,
  );
  for (const path of [".claude-plugin/plugin.json", "package.json"])
    expect(json(path).version, path + " version").toBe(version);
  const marketplace = json(".claude-plugin/marketplace.json");
  expect(marketplace.plugins, "Claude marketplace").toHaveLength(1);
  expect(marketplace.plugins[0].version, "Claude marketplace version").toBe(version);
  const codex = json(".agents/plugins/marketplace.json").plugins;
  expect(codex, "Codex marketplace").toHaveLength(1);
  expect(codex[0].source, "Codex source").toEqual({ source: "local", path: "./" });
  expect(codex[0].policy, "Codex policy").toEqual({
    installation: "AVAILABLE",
    authentication: "ON_INSTALL",
  });
  expect(codex[0].category, "Codex category").toBe("Productivity");
});

test("test_release_manifest_tracks_the_plugin_version", () =>
  expect(json(".release-please-manifest.json"), "release manifest").toEqual({ ".": version }));

test("test_release_config_updates_every_version_location", () => {
  const config = json("release-please-config.json");
  expect(Object.keys(config.packages)).toEqual(["."]);
  expect(config["release-type"]).toBe("node");
  const extra = new Map<string, any>(
    config.packages["."]["extra-files"].map((entry: any) => [entry.path, entry]),
  );
  expect([...extra.keys()].sort()).toEqual(
    ["plugin.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"].sort(),
  );
  for (const [path, entry] of extra) {
    expect(entry.type, path).toBe("json");
    expect(entry.jsonpath, path + " JSON path").toMatch(/^\$(?:\.[A-Za-z_]+|\[\d+\])+$/);
    let value = json(path);
    for (const step of entry.jsonpath.matchAll(/\.([A-Za-z_]+)|\[(\d+)\]/g))
      value = value[step[1] || Number(step[2])];
    expect(value, path + " release version").toBe(version);
  }
});

test("test_formatter_dependencies_live_outside_the_plugin_root", () => {
  expect(json("package.json").devDependencies).toBeUndefined();
  expect(fs.existsSync(resolve(root, "package-lock.json"))).toBe(false);
  const development = json("development/package.json"),
    lock = json("development/package-lock.json");
  expect(development.private).toBe(true);
  expect(development.devDependencies).toEqual({
    oxfmt: "0.67.0",
    typescript: "7.0.2",
    "@types/bun": "1.4.4",
    htmlparser2: "12.0.0",
  });
  for (const document of [lock, lock.packages[""]]) {
    expect(document.name).toBe(development.name);
    expect(document.version).toBe(development.version);
  }
  expect(lock.packages[""].devDependencies).toEqual(development.devDependencies);
  expect(lock.packages["node_modules/oxfmt"].version, "formatter lock").toBe("0.67.0");
});

test("test_quality_commands_and_docs_install_the_development_formatter", () => {
  const scripts = json("package.json").scripts;
  expect(scripts["format:check"].split(/\s+/).slice(2)).toEqual(
    scripts.format.split(/\s+/).slice(1),
  );
  for (const name of ["format", "format:check"])
    for (const value of [
      "development/node_modules/.bin/oxfmt",
      "development/package.json",
      "development/package-lock.json",
    ])
      expect(scripts[name], name).toContain(value);
  for (const path of ["README.md", "docs/verification.md"])
    expect(read(path), path).toContain("npm ci --prefix development");
});

test("test_manual_only_skills_keep_each_runtime_policy", () => {
  for (const name of ["pr-screenshots", "product-guide", "ui-grill-with-docs"]) {
    expect(frontmatter(name), name + " explicit invocation").toMatch(
      /^disable-model-invocation: true$/m,
    );
    expect(read("skills/" + name + "/agents/openai.yaml"), name).toMatch(
      /^policy:\n\s+allow_implicit_invocation: false\s*$/ms,
    );
  }
});

test("test_codex_invocation_guidance_uses_the_plugin_namespace", () => {
  expect(read("README.md")).toMatch(
    /^\| Codex\s+\| \x60\$treflebonbon-skills:<skill-name>\x60\s+\|$/m,
  );
  for (const path of ["skills/dogfood/SKILL.md", "skills/dogfood/references/verification.md"]) {
    expect(read(path), path).toMatch(/^Codex: \$treflebonbon-skills:dogfood(?:\s|$)/m);
    expect(read(path), path).not.toMatch(/^Codex: \$dogfood\b/m);
  }
});

test("test_readme_documents_all_skills_platforms_and_dependency_routes", () => {
  const readme = read("README.md");
  for (const name of skills)
    expect(readme).toContain(String.fromCharCode(96) + name + String.fromCharCode(96));
  for (const requirement of [
    "Linux x86_64",
    "Linux aarch64",
    "macOS aarch64",
    "WSL2",
    "Nix は必要ありません",
    "4.5.1",
    "1.63.0",
    "0.1.22",
    "Bash 4.0",
    "readlink -f",
    "skills/dogfood/references/dependencies.md",
    "skills/domain-modeling-studio/references/dependencies.md",
    "skills/product-guide/references/dependencies.md",
    "skills/herdr-peer-refactor/references/dependencies.md",
    "skills/herdr-peer-refactor/references/auto-session.md",
    "contracts/auto-peer-protection.md",
    "docs/raw-codex-isolation.md",
    "Python 3.9+",
    "Python 3.11+ (\x60tomllib\x60)",
  ])
    expect(readme, requirement).toContain(requirement);
  for (const cli of ["claude", "codex"])
    for (const source of ["treflebonbon/skills", "/absolute/path/to/skills"])
      expect(readme).toContain(cli + " plugin marketplace add " + source);
  for (const source of ["https://github.com/treflebonbon/skills", "/absolute/path/to/skills"])
    expect(readme).toContain("agy plugin install " + source);
});

test("test_optional_ast_grep_and_xvfb_dependencies_are_route_scoped", () => {
  for (const value of ["ast-grep", "0.42.1", "Xvfb", "xauth"])
    expect(read("README.md")).toContain(value);
  const studio = read("skills/domain-modeling-studio/references/dependencies.md");
  for (const value of [
    "ast-grep 0.42.1",
    "npm install --global @ast-grep/cli@0.42.1",
    "ソースコードを読んで調査を続けます",
    "TypeScript の構文から証拠を抽出する経路だけで Bun",
  ])
    expect(studio).toContain(value);
  const dogfood = read("skills/dogfood/references/dependencies.md");
  for (const value of [
    "sudo apt install xvfb xauth",
    "brew install xorg-server",
    "2:21.1.12-1ubuntu1.6",
    "1:1.1.2-1build1",
    "2:21.1.7-3+deb12u13",
    "1:1.1.2-1",
    "非 WSL2",
    "headed retry",
  ])
    expect(dogfood).toContain(value);
});

test("test_non_wsl_headed_retry_checks_xvfb_before_running", () => {
  const skill = read("skills/dogfood/SKILL.md");
  const initial = skill.indexOf('node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run "${ARGS[@]}"'),
    start = skill.indexOf('if [ "$runner_status" -eq 2 ]; then'),
    end = skill.indexOf('if [ "$runner_status" -ne 0 ]; then', start),
    retry = skill.slice(start, end);
  const wsl = retry.indexOf('if [[ -n "${WSL_DISTRO_NAME:-}" ]] || {'),
    xvfb = retry.indexOf('xvfb-run -a node "$SKILL_DIR/scripts/dogfood-runtime.mjs"'),
    guard = retry.indexOf("if ! command -v xvfb-run");
  expect(initial).toBeGreaterThanOrEqual(0);
  expect(start).toBeGreaterThan(initial);
  expect(wsl).toBeGreaterThan(0);
  expect(guard).toBeGreaterThan(wsl);
  expect(xvfb).toBeGreaterThan(guard);
  for (const binary of ["xvfb-run", "Xvfb", "xauth"]) {
    const check = retry.indexOf("command -v " + binary);
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(xvfb);
  }
  expect(retry.slice(0, xvfb)).toContain("sudo apt install xvfb xauth");
  expect(retry.slice(guard, xvfb)).toContain("runner_status=127");
  expect(skill).toContain(
    'node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run "${ARGS[@]}" --headed',
  );
});

test("test_all_package_markdown_links_resolve_inside_the_package", () => {
  const git = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  expect(git.status, git.stderr).toBe(0);
  for (const path of git.stdout.split("\0").filter(Boolean)) {
    expect(environment(basename(path)), path).toBe(false);
    if (
      extname(path) !== ".md" ||
      path.split("/").some((part) => ["evals", "dist", "vendor"].includes(part))
    )
      continue;
    const document = resolve(root, path),
      content = fs.readFileSync(document, "utf8").replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g, "");
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]!.trim().replace(/^[<>]+|[<>]+$/g, "");
      if (/^(https?:\/\/|mailto:|#|\/\/)/.test(target)) continue;
      const local = target.split("#")[0]!.split("?")[0]!;
      if (local) {
        const link = resolve(dirname(document), local);
        expect(
          fs.existsSync(link) && fs.statSync(link).isFile(),
          "markdown link " + path + " -> " + target,
        ).toBe(true);
      }
    }
  }
});

test("test_default_quality_entry_runs_nested_node_and_fixture_bats", () => {
  const scripts = json("package.json").scripts;
  for (const command of ["test:bun", "test:python", "test:node", "test:bats"])
    expect(scripts.test, "quality entry").toContain(command);
  for (const target of [
    "skills/dogfood/tests/runtime.test.mjs",
    "skills/domain-modeling-studio",
    "packages/wsl2-browser",
  ])
    expect(scripts["test:node"]).toContain(target);
  for (const suite of [
    "dogfood.bats",
    "dogfood-results.bats",
    "managed-dogfood-browser.bats",
    "packages/wsl2-browser/tests/*.bats",
    "tests/raw-codex/*.bats",
    "tests/*.bats",
    "tests/cli/*.bats",
  ])
    expect(scripts["test:bats"]).toContain(suite);
  expect(scripts["test:bats"]).not.toContain("dogfood-real-browser.bats");
  expect(scripts["test:plugin-cli"]).toContain("TREFLEBONBON_PLUGIN_CLI_E2E=1");
});

test("test_formatter_ignores_generated_and_vendor_assets", () => {
  const patterns = json(".oxfmtrc.json").ignorePatterns;
  expect(patterns).toContain("skills/domain-modeling-studio/dist/**");
  expect(patterns).toContain("**/vendor/**");
});

test("test_license_and_third_party_notices_are_packaged", () => {
  expect(read("LICENSE"), "package license").toContain("MIT License");
  for (const file of [
    "skills/domain-modeling-studio/dist/THIRD-PARTY-LICENSES.txt",
    "packages/wsl2-browser/THIRD_PARTY_NOTICES.md",
  ])
    expect(fs.statSync(resolve(root, file)).isFile(), file).toBe(true);
});

test("test_product_guide_vendored_bundles_match_lock_and_have_notices", () => {
  const path = "skills/product-guide/",
    lock = json(path + "package-lock.json"),
    notice = read(path + "vendor/THIRD-PARTY-LICENSES.txt");
  for (const [name, expected] of Object.entries(json(path + "package.json").dependencies))
    expect(lock.packages["node_modules/" + name].version, name).toBe(expected);
  for (const [name, value] of Object.entries(lock.packages) as [string, any][])
    if (name) {
      expect(notice, name).toContain(name.replace(/^node_modules\//, "") + "@" + value.version);
      expect(notice).toMatch(/Permission is hereby granted|Eclipse Public License/);
    }
  for (const [file, header] of [
    ["dagre.esm.js", "/* @dagrejs/dagre@3.1.3 "],
    ["elk-api.js", "/* elkjs@0.11.1 "],
    ["elk-worker.min.js", "/* elkjs@0.11.1 "],
  ])
    expect(read(path + "vendor/" + file).startsWith(header!), file).toBe(true);
  for (const [name, expected] of Object.entries({
    "@ast-grep/wasm": "0.51.0",
    "web-tree-sitter": "0.26.13",
  }))
    expect(lock.packages["node_modules/" + name].version).toBe(expected);
  for (const file of [
    "wasm_bg.wasm",
    "web-tree-sitter.wasm",
    "tree-sitter-typescript.wasm",
    "tree-sitter-tsx.wasm",
    "tree-sitter-javascript.wasm",
  ])
    expect(fs.statSync(resolve(root, path, "vendor/ast-grep", file)).isFile(), file).toBe(true);
  expect(fs.existsSync(resolve(root, path, "node_modules"))).toBe(false);
});

test("test_npm_locks_use_public_registry_urls_and_integrity", () => {
  for (const path of [
    "development/package-lock.json",
    "skills/dogfood/references/package-lock.json",
    "skills/domain-modeling-studio/package-lock.json",
    "skills/product-guide/package-lock.json",
    "packages/wsl2-browser/package-lock.json",
  ]) {
    const packages = json(path).packages ?? {};
    expect(Object.keys(packages).length, path).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(packages) as [string, any][])
      if (name) {
        expect(value.resolved, path + " registry " + name).toStartWith(
          "https://registry.npmjs.org/",
        );
        expect(value.integrity, path + " integrity " + name).toMatch(/^sha(256|384|512)-/);
      }
  }
});
