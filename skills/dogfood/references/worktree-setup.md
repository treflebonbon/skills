---

metadata:
  depends_on: "skills/dogfood/SKILL.md"
  topics: "dogfood, worktree, evidence"
  source: "human"
---

# Worktree Setup

Use a dedicated branch and worktree for each dogfood run so screenshots, videos, and reports never dirty the caller's current branch.

## Resolve Names

```bash
TARGET_SLUG="$(printf '%s' "$TARGET_URL" | sed -E 's#^[a-zA-Z]+://##; s#[/?#].*$##; s#[^A-Za-z0-9]+#-#g; s#^-|-$##g' | tr '[:upper:]' '[:lower:]')"
SESSION="$(date -u +%Y%m%dT%H%M%SZ)"
BRANCH="dogfood/$(date -u +%F)-$TARGET_SLUG"
WT_DIR=".worktrees/dogfood-$TARGET_SLUG"
OUTPUT_DIR="dogfood-output/$SESSION"
```

If the slug is empty, stop and ask for a concrete target URL.

## Create

```bash
git worktree add -b "$BRANCH" "$WT_DIR" HEAD
mkdir -p "$WT_DIR/$OUTPUT_DIR"
```

Use local `HEAD` as the base: the worktree isolates evidence, while `TARGET_URL` selects the running app to inspect. No remote, fetch, or GitHub authentication is required. Follow the runtime’s native worktree entry rules when applicable. The branch is never pushed; evidence stays local under the gitignored `.worktrees/` directory.

> **Note on paths**: `WT_DIR` is relative to the repo root (inside the repository at `.worktrees/`). `OUTPUT_DIR` is relative to `WT_DIR`. All dogfood artifacts therefore live under `.worktrees/`, which is gitignored, so they stay a local-only audit trail (the `dogfood-output/` subtree is covered transitively by `.worktrees/`, not by a `dogfood-output/` entry).

## Resume

When `--resume <path>` is supplied, do not run dogfood again. Accept either the output root or a retained `attempts/<id>/` directory, and apply the run-status rules in [report-parsing.md](report-parsing.md). Resolve `<path>` to an absolute directory, validate that `report.md` exists, and validate evidence paths against that directory. It is the read-only evidence root. If it is already inside a `dogfood/*` worktree, reuse that worktree. Otherwise leave the external directory in place: do not create a wrapper worktree, move/copy its files, or mutate it.

## Dogfood Invocation

`SKILL_DIR` は現在の runtime が読み込んだ `SKILL.md` の絶対 directory に設定します。current directory や旧 home 配備先から推測しません。

```bash
SKILL_DIR="/absolute/path/to/the/loaded/skills/dogfood"
OUT_ABS="$(readlink -f "$WT_DIR/$OUTPUT_DIR")"
node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run \
  --target "$TARGET_URL" \
  --output "$OUT_ABS"
```

`--extension <path>` がある場合は `--extension "$(readlink -f "$EXTENSION_PATH")"` を追加します。`--annotate` がある場合は `--annotate` を追加し、`--resume` と同時なら拒否します。runner は自動検査の後に Playwright Dashboard の入力を待ちます。headless の MV3 run が exit 2 を返した場合に限り、同じ output 起点の Managed Dogfood profile identity で `--headed` を一度だけ再試行します。WSL2 では CDP 経由の Windows Chrome を使い、`xvfb-run` を使いません。WSL2 以外では環境に合わせた display wrapper を指定できます。

runner は `$WT_DIR/$OUTPUT_DIR` の下に新しい `attempts/<id>/` directory を作り、report と収集した証跡を保存します。output root の `report.md` は、root 起点の証跡 path を使って最新 attempt を表示します。annotation CLI の出力と response JSON も attempt 内に保存します。取得失敗は warning として記録し、存在しない path は証跡に含めません。過去の attempt は監査と `--resume` に使えます。profile identity は attempt directory ではなく output root に結び付けます。exit 1 では停止し、report の文面を retry の判定に使いません。

## Cleanup

Do not auto-remove the worktree. The final summary may include manual cleanup commands after the evidence has been reviewed:

```bash
git worktree remove "$WT_DIR"
git branch -D "$BRANCH"
```
