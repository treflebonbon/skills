import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => fs.readFileSync(resolve(root, path), "utf8");
const skill = (name: string) => read("skills/" + name + "/SKILL.md");
function markdown(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const path = resolve(directory, item.name);
    return item.isDirectory() ? markdown(path) : item.name.endsWith(".md") ? [path] : [];
  });
}
function links(names: string[], ignored: RegExp, selected = (_target: string) => true) {
  for (const name of names)
    for (const document of markdown(resolve(root, "skills", name)))
      for (const match of fs.readFileSync(document, "utf8").matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1]!;
        if (ignored.test(target)) continue;
        const local = target.split("#")[0]!;
        if (local && selected(local)) {
          const path = resolve(dirname(document), local);
          expect(
            fs.existsSync(path) && fs.statSync(path).isFile(),
            document + " -> " + target,
          ).toBe(true);
        }
      }
}
function temporary(action: (directory: string) => void) {
  fs.mkdirSync("/tmp/codex", { recursive: true, mode: 0o700 });
  const info = fs.lstatSync("/tmp/codex");
  if (!info.isDirectory() || info.uid !== process.getuid!())
    throw Error("/tmp/codex は実行ユーザー所有の通常 directory が必要です");
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/codex/quality-skills-50-"));
  try {
    action(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("test_marp_templates_are_packaged_beside_the_skill", () => {
  for (const resource of ["references/design-template.md", "references/slide-guidelines.md"]) {
    expect(skill("marp")).toContain(resource);
    expect(fs.statSync(resolve(root, "skills/marp", resource)).isFile()).toBe(true);
  }
});
test("test_instruction_reviews_keep_their_distinct_scopes", () => {
  expect(skill("md-agents-review")).toContain("AGENTS.md");
  expect(skill("md-agents-review")).toContain("md-claude-review");
  expect(skill("md-claude-review")).toContain("CLAUDE.md");
  expect(skill("md-claude-review")).toContain("md-agents-review");
});
test("test_skill_local_links_resolve_from_their_markdown_files", () =>
  links(["marp", "md-agents-review", "md-claude-review"], /^(https?:\/\/|#)/, (target) =>
    /^(references\/|\.\.\/)/.test(target),
  ));
test("test_claude_api_remains_optional_and_the_document_fallback_remains_available", () => {
  const content = skill("md-claude-review"),
    criteria = read("skills/md-claude-review/references/criteria.md");
  expect(content).toContain("claude-api");
  expect(criteria).toContain("prompt-audit");
  expect(criteria).toContain("https://code.claude.com/docs/en/best-practices");
  expect(content.split("---", 3)[1]).not.toContain("claude-api");
});
test("test_existing_claude_review_evaluation_inputs_resolve_from_the_skill", () => {
  const evaluation = JSON.parse(read("skills/md-claude-review/evals/evals.json"));
  expect(evaluation.skill_name).toBe("md-claude-review");
  expect(evaluation.evals.length).toBeGreaterThan(0);
  for (const item of evaluation.evals)
    for (const path of item.files)
      expect(fs.statSync(resolve(root, "skills/md-claude-review", path)).isFile(), path).toBe(true);
});
test("test_skill_payload_does_not_require_dotfiles_installation_paths", () => {
  for (const name of ["marp", "md-agents-review", "md-claude-review"])
    for (const path of markdown(resolve(root, "skills", name)))
      for (const fragment of ["~/.claude/skills", "local-skills/", "dotfiles checkout"])
        expect(fs.readFileSync(path, "utf8"), path).not.toContain(fragment);
});

test("test_skill_resources_resolve_from_their_markdown_files", () =>
  links(["ui-grill-with-docs", "domain-modeling-studio"], /^(https?:\/\/|#|mailto:)/));
test("test_studio_render_cli_loads_its_template_and_writes_outside_the_payload", () =>
  temporary((directory) => {
    const model = resolve(directory, "model.json"),
      output = resolve(directory, "review.html");
    const fixture = pathToFileURL(
      resolve(root, "skills/domain-modeling-studio/tests/fixture.mjs"),
    ).href;
    const program =
      "import { example } from " +
      JSON.stringify(fixture) +
      "; import { writeFileSync } from 'node:fs'; writeFileSync(" +
      JSON.stringify(model) +
      ", JSON.stringify(example()));";
    for (const args of [
      ["--input-type=module", "-e", program],
      [resolve(root, "skills/domain-modeling-studio/scripts/render.mjs"), model, output],
    ]) {
      const result = spawnSync("node", args, { cwd: directory, encoding: "utf8", timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(fs.statSync(output).isFile()).toBe(true);
    const rendered = fs.readFileSync(output, "utf8");
    expect(rendered).toContain('id="studio-document"');
    expect(rendered).toContain('"sessionId":"example-session"');
    expect(fs.existsSync(resolve(root, "skills/domain-modeling-studio/review.html"))).toBe(false);
  }));
test("test_studio_build_and_third_party_license_are_packaged", () => {
  const prefix = "skills/domain-modeling-studio/";
  for (const path of [
    "package.json",
    "package-lock.json",
    "dist/studio.html",
    "dist/THIRD-PARTY-LICENSES.txt",
  ])
    expect(fs.statSync(resolve(root, prefix, path)).isFile()).toBe(true);
  const notices = read(prefix + "dist/THIRD-PARTY-LICENSES.txt").trim();
  expect(notices.length).toBeGreaterThan(0);
  expect(read(prefix + "dist/studio.html")).toContain(notices.replaceAll("--", "—"));
});
test("test_external_skills_remain_separate_from_the_package", () => {
  for (const name of ["grilling", "domain-modeling", "codebase-design", "playwright-cli"])
    expect(fs.existsSync(resolve(root, "skills", name)), name).toBe(false);
});

test("test_bundled_cli_path_is_absolute_and_independent_of_cwd", () =>
  temporary((directory) => {
    const resolver = resolve(root, "skills/pr-screenshots/scripts/browser-tool-path");
    expect(fs.statSync(resolver).isFile()).toBe(true);
    fs.symlinkSync(resolve(root, "skills/pr-screenshots"), resolve(directory, "installed-skill"));
    for (const entry of [
      "browser-attachments",
      "managed-chrome-owner",
      "playwright-cli",
      "wsl2-browser-prepare",
    ])
      for (const script of [
        resolver,
        resolve(directory, "installed-skill/scripts/browser-tool-path"),
      ]) {
        const result = spawnSync(script, [entry], { cwd: directory, encoding: "utf8" });
        const expected = fs.realpathSync(resolve(root, "packages/wsl2-browser/bin", entry));
        expect(result.status, result.stderr).toBe(0);
        expect(fs.realpathSync(result.stdout.trim())).toBe(expected);
        expect(isAbsolute(expected)).toBe(true);
      }
    const invalid = spawnSync(resolver, ["../../bin/sh"], { cwd: directory, encoding: "utf8" });
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("unsupported bundled CLI: ../../bin/sh");
  }));
test("test_both_supported_skill_hosts_require_explicit_invocation", () => {
  const frontmatter = skill("pr-screenshots").match(/^---\n([\s\S]*?)\n---\n/);
  expect(frontmatter).not.toBeNull();
  expect(frontmatter![1]).toMatch(/^name: pr-screenshots$/m);
  expect(frontmatter![1]).toMatch(/^disable-model-invocation: true$/m);
  expect(read("skills/pr-screenshots/agents/openai.yaml")).toMatch(
    /^policy:\n\s+allow_implicit_invocation: false\s*$/ms,
  );
});
test("test_dependency_guide_explains_optional_capture_and_wsl2_requirements", () => {
  for (const text of [
    "GitHub CLI `gh`",
    "Node.js 20.19",
    "WSL2",
    "mirrored networking",
    "playwright-cli",
    "Nix は不要",
    "手動",
  ])
    expect(read("skills/pr-screenshots/DEPENDENCIES.md")).toContain(text);
});
test("test_skill_document_links_resolve_inside_the_plugin", () =>
  links(["pr-screenshots"], /^(https?:\/\/|#|mailto:)/));
test("test_existing_evaluation_cases_are_preserved", () => {
  const scenarios = JSON.parse(read("skills/pr-screenshots/evals/scenarios.json")),
    results = JSON.parse(read("skills/pr-screenshots/evals/results.json"));
  expect(Object.keys(scenarios).sort()).toEqual(["A", "B", "C", "D"]);
  expect(scenarios.B.requirements.some((value: string) => value.includes("ID"))).toBe(true);
  expect(scenarios.C.requirements.some((value: string) => value.includes("認証不足"))).toBe(true);
  expect(scenarios.B.scenario).toContain("送信結果不明");
  expect(results.runs.some((run: any) => run.scenario === "D")).toBe(true);
  expect(
    read("skills/pr-screenshots/evals/evaluation.md").startsWith(
      "# pr-screenshots 配備前の実行評価",
    ),
  ).toBe(true);
});
