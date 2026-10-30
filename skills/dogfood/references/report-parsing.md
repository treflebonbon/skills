---

metadata:
  depends_on: "skills/dogfood/SKILL.md"
  topics: "dogfood, report, parsing"
  source: "human"
---

# Report Parsing

Parse the `dogfood` report into findings for the summary, or candidates for approval when `--issues` is supplied. Prefer structured Markdown parsing if available; otherwise use the block contract below.

## Required Inputs

- `REPORT_PATH="$OUTPUT_DIR/report.md"` unless `--resume` points elsewhere.
- `EVIDENCE_ROOT` is the absolute directory containing `report.md`, including for an external resumed output.

Stop if `report.md` is missing or empty.

## Run and Evidence Status

Read status only from the report header before the first section heading. New reports include `Run status`, `Evidence status`, and `Attempt directory`; warnings and failures explain missing evidence or unfinished work. Finding count alone never proves a run completed or a target loaded.

- `Run status: completed`: new runs may enter candidate review. `Evidence status: partial` or `unavailable` means warning-only completion; show every warning before reviewing candidates, including when no supplementary files exist.
- `Run status: failed`, `running`, or `retryable`: stop automatic review. Explicit `--resume` may review recorded candidates while preserving the failed/unfinished status. It does not finish or rerun that attempt.
- Missing, unrecognized, or inconsistent status in legacy/external reports: treat the run as unknown. Explicit `--resume` may review its candidates; do not infer success or rewrite the source report.

Only a newly executed, completed cycle with complete evidence and no warnings can count toward the consecutive-zero-finding condition in `SKILL.md`. Warning, failed, unfinished, retryable, and unknown outcomes break the streak. Reviewing saved reports never adds a cycle. WSL2 video is unsupported, not missing evidence.

## Finding Block Contract

Treat headings matching this shape as finding starts:

```text
### ISSUE-001: Submit button is hidden on mobile
```

Accepted aliases are `### Finding 001:` and `### Bug 001:`. The parser should collect text until the next same-or-higher-level heading.

Within each block, extract these fields when present:

- `Severity`: `Critical`, `High`, `Medium`, or `Low`. Normalize resumed priority aliases P0/P1/P2/P3 to Critical/High/Medium/Low respectively. GitHub label mapping is needed only with `--issues`.
- `Category`: `visual`, `functional`, `ux`, `content`, `perf`, `console`, `network`, or `a11y`
- `URL`
- `Summary`
- `Expected`
- `Actual`
- `Steps to reproduce`
- `Evidence`

If a field is absent, keep the original prose in `description` rather than inventing details.

Annotation-generated blocks use the same contract. Each rectangle defaults to `Medium` / `visual`, uses its frame URL, and retains the full comment, coordinates, and viewport in `Actual`. Its evidence includes the annotated PNG, ARIA snapshot, and `annotations/response.json`. Overall feedback without a rectangle is one candidate. An empty annotation submission creates no candidate.

## Candidate Schema

```json
{
  "id": "ISSUE-001",
  "title": "Submit button is hidden on mobile",
  "severity": "High",
  "category": "visual",
  "url": "http://localhost:3000/signup",
  "summary": "The primary submit button is clipped below the fold.",
  "expected": "The button is visible without horizontal scrolling.",
  "actual": "The button is clipped at 390px width.",
  "repro_steps": ["Open /signup at 390px width", "Scroll to the form footer"],
  "evidence": ["screenshots/signup-mobile.png", "videos/signup-mobile.webm"],
  "evidence_root": "/absolute/local/path/dogfood-output/20260529T010203Z",
  "source_report": "dogfood-output/20260529T010203Z/report.md"
}
```

## Evidence Paths

Normalize relative evidence paths against `EVIDENCE_ROOT` and keep paths relative to that root. Drop entries that escape the root after resolving symlinks, are missing, or are not nonempty regular files. Display dropped entries as evidence warnings without discarding the finding; never rewrite an external resumed report. For a normal dogfood worktree, render the familiar `dogfood-output/<session>/...` path. For an external resumed output, retain its absolute local evidence root in the Issue source section and render evidence paths relative to that root.

Root reports refer to `attempts/<id>/...`; historical reports inside an attempt refer to files relative to that attempt. Resolve each report independently against its own `EVIDENCE_ROOT`. The `Collected evidence` section lists available artifacts even when there are no finding blocks.

## Empty Reports

If the report contains no findings, report both the run status and evidence status, then stop before opening issues. For failed, unfinished, or unknown runs, say that no findings were recorded, not that the target passed or loaded. A completed run with evidence warnings is not a clean zero-finding cycle.
