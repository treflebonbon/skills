# AGENTS.md Review Criteria

This file contains the criteria used by [skills/md-agents-review](../SKILL.md).

Review has two orthogonal layers: **content curation** (§2–§5: keep / trim / move-to / delete) and **phrasing quality** (§6: reword kept sections to match GPT-5.5 prompt guidance).

## 1. Scope

- Target AGENTS.md, Codex rules, and repository-local agent guidance.
- Ordinary Markdown documents, product docs, API docs, and user-facing docs are out of scope.
- Send Claude-facing instruction files to `md-claude-review`.

### Review unit (what gets a decision)

Assign a decision to BOTH of the following; skip neither:

1. **Preamble block** — the body from the `# Title` down to the first `## ` heading. Real AGENTS.md files often put the most load-bearing guidance (edit-flow rules, the AGENTS.md/CLAUDE.md split, top warnings) in this preamble. Skipping it because it has no `## ` heading drops the highest-leverage instructions from the deliverable. Treat the preamble as one decision unit and give it Keep / Trim / Reword / Move-to / Delete. If it covers several topics, split the decision per topic — but split only when the topics would receive different verbs; if they all resolve to the same decision, keep it as one unit. A non-empty preamble always receives at least one decision.
2. **Each `## ` section** — one decision per heading.

The five decision verbs are Keep / Trim / Reword / Move-to / Delete (defined by the §7 Decision Matrix).

## 2. Project-Specific Brevity

- Write only what Codex is likely to get wrong in that repository, not general advice.
- Configuration explanations that are obvious from code, standard language conventions, and obvious quality goals are deletion candidates.
- Shorten long background explanations. Move them only to a repository-local documentation path that exists and fits the content; if no suitable destination exists, prefer Delete over inventing a path.

## 3. Progressive Disclosure

- Keep routinely needed rules in AGENTS.md.
- Move low-frequency, long-form, or reference-style knowledge into separate files or skill references.
- For moved information, briefly state in AGENTS.md when it should be read.

## 4. Codex Runtime Fit

| Item              | What to check                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Mode behavior     | Whether Plan Mode prioritizes planning, questions, and investigation, and Default mode can implement clear requests     |
| Tool use          | Whether conditions for file reads, edits, tests, and GitHub operations match the actual Codex tools                     |
| Sandbox approvals | Whether approval requirements are clear for network access, write boundaries, destructive commands, and visible actions |
| GitHub actions    | Whether visible actions such as issue assignment, PR comments, pushes, and PR creation are handled clearly              |
| Verification      | Whether the tests, lint, diffs, and manual verification required before completion claims are clear                     |
| User interaction  | Whether the guidance avoids assuming unavailable UI or nonexistent tool names                                           |

## 5. Grounded Claims

- When saying "do this in this repo", confirm it is based on actual file paths, scripts, tests, or workflows.
- Check that guesses, stale conventions, or other runtime constraints are not written as Codex rules.
- Separate claims from assumptions, and leave unverified items as verification steps or questions.

## 6. GPT-5.5 Phrasing Quality

Orthogonal to content curation (§2–§5). For sections you decide to **Keep**, check whether the wording follows GPT-5.5 prompt guidance. If not, propose a **Reword** (keep the content, fix only the phrasing).

| Anti-pattern              | Signal                                                 | Reword direction                                                                                                  | Source                           |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Excessive absolutes       | `ALWAYS` / `NEVER` / `MUST` / `only` on judgment calls | Reserve absolutes for true invariants (safety, required fields, must-never actions); use decision rules otherwise | Instruction phrasing             |
| Over-specification        | Step-by-step process written for older models          | Rewrite as outcome-oriented: state the destination, let the model choose the path                                 | Shorter, outcome-first prompts   |
| Verbose / over-structured | Mechanical headers and bullets everywhere              | Default to plain paragraphs; use headers/bullets only when they improve clarity                                   | Verbosity control                |
| Missing follow-through    | No reversible/irreversible action policy               | State it: proceed when reversible and low-risk; ask before irreversible or external-side-effect actions           | Agentic control & follow-through |

## 7. Decision Matrix

| Criterion                              | Keep | Trim | Reword | Move-to | Delete |
| -------------------------------------- | ---- | ---- | ------ | ------- | ------ |
| Project-specific and frequently needed | X    |      |        |         |        |
| Project-specific but long or rare      |      | X    |        | X       |        |
| Codex mode or sandbox behavior         | X    | X    |        |         |        |
| Visible GitHub action policy           | X    | X    |        |         |        |
| Validation reporting requirement       | X    | X    |        |         |        |
| Standard coding advice                 |      |      |        |         | X      |
| Duplicated docs or code-readable facts |      |      |        |         | X      |
| Unverified or stale tool behavior      |      | X    |        |         | X      |
| Excessive absolutes (§6)               | X    |      | X      |         |        |
| Over-specified process (§6)            | X    |      | X      |         |        |
| Verbose / over-structured (§6)         | X    |      | X      |         |        |
| Missing follow-through (§6)            | X    |      | X      |         |        |

**Tie-break (when several decisions apply)**: pick exactly one verb per unit.

- If a unit needs both shortening and relocation, choose **Trim** when something stays in AGENTS.md (shorten in place, move the detail out) and **Move-to** when nothing stays.
- A §6 row marked under both Keep and Reword means "keep the content, fix the wording"; the headline verb is **Reword** (do not report it as Keep+Reword).
- When a section mixes true-invariant absolutes (safety, must-never) with judgment-call absolutes, choose **Reword** and, in the reword, keep the genuine invariants absolute while converting the judgment calls to decision rules.

## 8. Review Output

- Findings first, ordered by severity. If no unit needs a change, say so explicitly (all Keep, no ranked findings) rather than inventing an ordering.
- Each finding names the file and line when possible.
- Each fix is concrete: keep, trim, reword, move, delete, or replace with a shorter rule.
- Verification notes state which commands or files were checked, and which checks remain manual.

## Sources

- OpenAI GPT-5.5 prompt guidance: https://developers.openai.com/api/docs/guides/prompt-guidance
