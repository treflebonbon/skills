---

metadata:
  depends_on: "skills/dogfood/SKILL.md"
  topics: "dogfood, references"
  source: "human"
---

# dogfood references

Read this file first. Then open the reference needed for the active phase:

- [dependencies.md](dependencies.md) — 固定 runtime、browser、経路ごとの外部依存。
- [worktree-setup.md](worktree-setup.md) — create, resume, and preserve the `dogfood/*` evidence worktree.
- [report-parsing.md](report-parsing.md) — parse `report.md` into finding candidates.

Only with `--issues`:

- [approval-protocol.md](approval-protocol.md) — dedup preflight and per-finding approval loop.
- [severity-label-mapping.md](severity-label-mapping.md) — map dogfood severity/category to repository labels with fallback.
- [issue-body-template.md](issue-body-template.md) — render approved findings into GitHub Issue bodies.

For verification or MV3 inspection:

- [verification.md](verification.md) — smoke and end-to-end verification guidance.
- [mv3-extension.md](mv3-extension.md) — Playwright runner と `--extension` を使った MV3 拡張 dogfood 経路。
- [mv3-spike.md](mv3-spike.md) — MV3 SW 登録の spike (#955) 結果と採用経路。

Isolate the Playwright dogfood run and keep evidence as a local-only audit trail under `dogfood-output/`. Report findings by default. With `--issues`, review candidates individually or in an explicitly selected batch, then create approved issues referencing that evidence.
