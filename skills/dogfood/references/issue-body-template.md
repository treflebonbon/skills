---
  - skills/dogfood/templates/issue-body.md
metadata:
  depends_on: "skills/dogfood/SKILL.md"
  topics: "github-issues, template"
  source: "human"
---

# Issue Body Template

Render approved findings with [templates/issue-body.md](../templates/issue-body.md). Keep the body factual and evidence-forward.

## Required Sections

- Summary
- Severity and category
- Affected URL
- Steps to reproduce
- Expected
- Actual
- Evidence
- Environment
- Source

## Rendering Rules

- Use the dogfood report wording where available.
- Do not invent expected behavior. If the report lacks expected behavior, write `Not specified in dogfood report.`
- List evidence relative to its resolved local evidence root (audit trail; not committed, so no inline images or clickable URLs). For an external resumed output, add `Evidence root (local): <absolute-path>` to Source; normal worktree runs keep the `dogfood-output/<session>/...` form.
- Include parent issue only when `--parent #N` was explicitly supplied.

## Temporary Body Files

Create one temporary body file per approved issue. Keep paths in the final failure summary if issue creation stops mid-run.
