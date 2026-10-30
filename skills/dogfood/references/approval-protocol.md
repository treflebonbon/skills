---

metadata:
  depends_on: "skills/dogfood/SKILL.md"
  topics: "approval, dedup, github-issues"
  source: "human"
---

# Approval Protocol

Every GitHub Issue is user-approved unless the user explicitly selects the batch escape hatch.

## Dedup Preflight

Before approval, search open issues for likely duplicates:

```bash
gh search issues --repo "$REPO" --state open "$TITLE_KEYWORDS" --json number,title,url,labels
```

Use the finding title's meaningful words for `TITLE_KEYWORDS`. Include dedup matches in the approval preview. When likely duplicates exist, make `Skip` the recommended option.

## Per-Finding Question

Use `AskUserQuestion` with a preview containing:

- title
- severity/category
- URL
- dedup hits
- rendered issue body preview
- evidence count and source report link

Options:

- `Keep (Recommended)` when there are no dedup hits.
- `Skip (Recommended)` when dedup hits exist.
- `Edit` to revise title, severity, category, or body, then show the preview again.
- `Open all remaining as-is` to approve this and every remaining non-duplicate candidate without further prompts.

If the runtime supports four choices, present all four together. If the runtime accepts a maximum of three choices, preserve both approval modes with two stages:

1. Render an aggregate preview for every remaining non-duplicate candidate. Include each title, severity/category, URL, rendered Issue body, evidence count, source report, and dedup status; list duplicate suspects separately as excluded from the batch.
2. Only after showing that aggregate preview, ask `Review individually (Recommended)` or `Open all remaining non-duplicate candidates as-is`.
3. In individual mode, present `Keep / Skip / Edit` for each finding. After `Edit`, show the updated preview and ask the same three choices again.

Never merge batch approval into `Keep`, infer it from a previous answer, or omit it silently because of a runtime limit.

## Edit Rules

- Edits apply only to the current candidate unless the user selects the batch escape hatch after editing.
- Re-run label mapping after severity/category edits.
- Preserve original dogfood evidence links.

## Create Issues

For each approved candidate:

```bash
gh issue create --repo "$REPO" --title "$TITLE" --body-file "$BODY_FILE" --label "$LABELS"
```

If `--parent #N` was explicitly supplied, append a line to the parent issue body after successful creation:

```text
- [ ] #123 - Submit button is hidden on mobile
```

Do not infer a parent from repository state, branch names, or titles.

## Failure Handling

If issue creation fails, stop. Print:

- issue numbers created so far
- the failed candidate ID and title
- the body file path
- rollback commands such as `gh issue close <N> --reason "not planned"`
