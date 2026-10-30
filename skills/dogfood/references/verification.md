---

metadata:
  depends_on: "skills/dogfood/SKILL.md"
  topics: "verification, smoke-test"
  source: "human"
---

# Verification

Use the smallest verification path that matches the change.

## Static Checks

The skill is distributed under `skills/dogfood/` in this plugin. Its loaded directory is the base for references and runtime entrypoints.

## Runner Smoke Test

Run the bundled runtime entrypoint so browser automation is verified without creating GitHub Issues. On WSL2 the helper resolves the Windows PowerShell script and Managed Dogfood Chrome from `packages/wsl2-browser`:

```bash
SKILL_DIR="/absolute/path/to/the/loaded/skills/dogfood"
OUT_DIR="$(readlink -m .worktrees/dogfood-smoke)"
node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run --target about:blank --output "$OUT_DIR"
test -f "$OUT_DIR/report.md"
ATTEMPT="$(sed -n 's/^Attempt directory: //p' "$OUT_DIR/report.md")"
test -n "$ATTEMPT"
grep -Fx 'Run status: completed' "$OUT_DIR/report.md"
grep -Fx 'Evidence status: complete' "$OUT_DIR/report.md"
test -s "$OUT_DIR/$ATTEMPT/screenshots/initial.png"
test -s "$OUT_DIR/$ATTEMPT/traces/playwright-trace.zip"
```

For WSL2, the runner uses Windows Chrome over CDP and intentionally does not produce a `.webm` because `connectOverCDP` cannot reliably record video. Verify the screenshot and trace at the fixed 1440x1000 viewport instead. Locally launched non-WSL contexts retain the video assertion.

## Annotation Integration Tests

Run the subprocess-level Bats coverage for the opt-in path:

```bash
node --test "$SKILL_DIR/tests/runtime.test.mjs"
bats "$SKILL_DIR/tests/"*.bats
```

Node test は一時 plugin copy と fake npm/browser installer を使い、依存準備・通常 run・再実行の前後で plugin payload が不変か確認します。通常 Bats suite は Web/MV3 runner fixture、CLI fault injection、WSL ownership lifecycle mock を検証します。`dogfood-real-browser.bats` は固定 Playwright と Chromium を `dogfood-runtime.mjs prepare` で外部 cache に準備し、public helper の Web run/re-run、実 CLI の CDP attach/eval/detach、MV3 service worker と annotation の同一 browser context を確認します。live suite は Linux Chromium を使うため WSL2 の Windows Chrome 設定や認証に依存しません。依存準備と各実行の前後で `.env` と `.env.*` を読まずに plugin payload を照合します。CLI fault injection は証跡不足、cleanup 失敗、中断 retry、古い report の扱いも確認します。

For a manual dashboard check, run the runner with `--annotate` against a disposable page, submit two rectangles, and confirm the latest and attempt reports, the Playwright CLI PNG/YAML files, and `annotations/response.json` are present inside the attempt. Review an older attempt through `--resume` to verify historical evidence paths. Do not treat Submit as approval to create issues; candidates still go through Keep/Skip/Edit.

## Read-only Resume Check

Resume is a skill procedure, not a runner CLI mode. Verify its report-reading step using an external, read-only output directory and [report-parsing.md](report-parsing.md). Include a legacy report without run status, a priority alias, valid evidence, and missing or escaping evidence paths. Confirm that the candidate survives, its severity is normalized, invalid evidence is shown as warnings, and the run remains unknown. Also review empty legacy, failed, and warning-only reports: none adds a clean cycle or proves the target passed. Compare file hashes, symlink targets, and directory contents before and after review to confirm no mutation. Without `--issues`, this check ends with the findings summary and does not launch a browser, invoke GitHub commands, or ask for candidate approval. For an external report, `--resume <path> --issues` requires an explicit `REPO=owner/name` before preflight (ask if missing, even from an unrelated checkout), then adds the normal approval and creation phase; `--resume <path> --annotate` is rejected before side effects.

## Skill Smoke Test

Run against a low-risk public page with the plugin's named invocation:

```text
Codex: $treflebonbon-skills:dogfood https://example.com
Claude Code: /treflebonbon-skills:dogfood https://example.com
Antigravity CLI: /dogfood https://example.com
```

Expected:

- a `dogfood/YYYY-MM-DD-example-com` branch/worktree is created
- Playwright runner writes `dogfood-output/<session>/report.md`
- zero findings exits with explicit run/evidence status; warnings do not count as a clean cycle
- no GitHub commands, authentication preflight, or Issue-creation questions occur, including when findings exist
- no annotation Dashboard opens unless `--annotate` was supplied
- no GitHub Issues are created
- no commit or push of evidence happens

## End-to-End Test

Use a small app with known visual or functional defects:

1. Use the plugin's named dogfood skill with `<local-app-url> --issues --parent #N`.
2. Approve one finding, skip one, and edit one.
3. Confirm created issues contain repro steps and local evidence path references (no committed URLs).
4. Confirm parent issue body is updated only because `--parent` was explicit.

## Rollback Check

For accidental issues:

```bash
gh issue close <number> --repo "$REPO" --reason "not planned"
```

For evidence cleanup after audit:

```bash
git worktree remove "$WT_DIR"
git branch -D "$BRANCH"
```
