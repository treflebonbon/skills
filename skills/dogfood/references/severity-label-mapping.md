---

metadata:
  depends_on: "skills/dogfood/SKILL.md"
  topics: "labels, severity, github"
  source: "human"
---

# Severity Label Mapping

Map dogfood severity and category to repository labels, but tolerate repositories without pre-provisioned label setup.

## Preflight

```bash
EXISTING_LABELS="$(gh label list --repo "$REPO" --limit 200 --json name --jq '.[].name')"
```

Only pass labels that exist. If any preferred label is missing, omit it instead of creating labels.

## Preferred Labels

Always prefer:

- `bug`
- `dogfood`

Severity mapping:

| Dogfood severity | Preferred label     |
| ---------------- | ------------------- |
| Critical         | `severity:critical` |
| High             | `severity:high`     |
| Medium           | `severity:medium`   |
| Low              | `severity:low`      |

For resumed reports that use priority aliases, normalize before label mapping:

| Priority alias | Dogfood severity |
| -------------- | ---------------- |
| P0             | Critical         |
| P1             | High             |
| P2             | Medium           |
| P3             | Low              |

Category mapping:

| Dogfood category | Preferred label      |
| ---------------- | -------------------- |
| visual           | `area:visual`        |
| functional       | `area:functional`    |
| ux               | `area:ux`            |
| content          | `area:content`       |
| perf             | `area:performance`   |
| console          | `area:console`       |
| a11y             | `area:accessibility` |

## Fallback

If preferred labels are unavailable, fall back to `bug,dogfood` by using the subset that exists. If neither exists, create the issue without labels and mention the missing labels in the final summary.

Do not call `setup-repo` or create labels from this skill.
