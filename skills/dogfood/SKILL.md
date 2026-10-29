---
name: dogfood
description: "WebアプリやChrome MV3拡張をPlaywright runnerで検査し、ローカル証跡を報告します。実装QA向けで、コードレビュー、機能設計、自由な手動ブラウザー調査には使いません。"
license: MIT
allowed-tools: "AskUserQuestion Read Write Edit Grep Glob Bash(git:*) Bash(gh:*) Bash(mkdir:*) Bash(date:*) Bash(find:*) Bash(readlink:*) Bash(npm:*) Bash(node:*) Bash(xvfb-run:*) Bash(bash:*)"
metadata:
  topics: "dogfood, qa, issues, github, worktree, evidence"
  source: "treflebonbon/skills"
---

# Dogfood

Run automated inspection and report findings with local evidence. Annotation and Issue creation are independent opt-ins:

```text
Codex: $dogfood <URL>
Claude Code: /treflebonbon-skills:dogfood <URL>
Antigravity CLI: /dogfood <URL>

Add --annotate, --issues, or --resume <path> as needed.
```

Without `--issues`, finish with the report and findings summary, including run/evidence status and warnings. Do not invoke `gh`, require GitHub authentication, ask about Issue creation, or load Issue-only procedures. `--issues` enables candidate review and creation after the user settles the candidates; it does not approve every finding automatically. `--issues` and `--resume` are skill options, not runner arguments.

## Steps

0. Reject `--annotate` together with `--resume <path>` before preflight, worktree, report, browser, or GitHub operations. Do not silently drop either option. For an external `--resume <path>` with `--issues`, require an explicit `REPO=owner/name` before GitHub preflight; ask for the repository when missing. Never infer its destination from the caller's checkout. Without `--issues`, no repository is required.
1. `--issues` がある場合だけ、現在ロードされた `SKILL.md` の絶対ディレクトリーを `SKILL_DIR` に設定し、同梱 preflight を `REPO="${REPO:-}" bash "$SKILL_DIR/scripts/runtime-preflight.sh" --need gh-issues` で実行します。`PREFLIGHT_FAIL` なら停止します。指定された `REPO` は外部レポートの再開時も渡します。`--issues` がなければ GitHub preflight は省略します。`--issues` がない状態で `--parent` または `REPO` があれば、preflight その他の処理より前に拒否します。
2. Read [references/index.md](references/index.md), then load only the reference files needed for the current phase.
3. For a new run, resolve the required `TARGET_URL` and the local Git repository. With `--resume`, validate the existing report instead; no URL or local Git repository is required. Only with `--issues`, resolve the GitHub `REPO`, using the explicit destination for external resumed reports and otherwise defaulting to `gh repo view --json nameWithOwner`.
4. Create an isolated dogfood worktree on `dogfood/YYYY-MM-DD-<target-slug>` from local `HEAD` for a new run; no fetch or GitHub lookup is needed. With `--resume`, resolve the supplied output as the evidence root instead; reuse its dogfood worktree when present, but do not create a worktree merely to wrap an external output directory.
5. Unless `--resume <path>` is supplied, run the bundled runtime entrypoint. **If `--auth-from` is supplied, stop and report that authenticated Playwright dogfood state import is not yet supported (follow-up); never silently inspect an unauthenticated login page as if it covered the app.** Resolve the absolute directory of the `SKILL.md` loaded by the current runtime. If that path is unavailable, stop instead of guessing from the current directory or a legacy home location. With `--annotate`, first confirm that the official third-party `playwright-cli` skill is installed and load it; if it is missing, stop before preparing dependencies or opening a browser. The runner package and browser cache are prepared outside the plugin; the WSL2 browser assets resolve from the plugin root:

   ```bash
   SKILL_DIR="/absolute/path/to/the/loaded/skills/dogfood"
   SKILL_DIR="$(cd -- "$SKILL_DIR" && pwd -P)"
   OUT_ABS="$(readlink -f "$WT_DIR/$OUTPUT_DIR")"
   ARGS=(--target "$TARGET_URL" --output "$OUT_ABS")
   if [ -n "${EXTENSION_PATH:-}" ]; then
     ARGS+=(--extension "$(readlink -f "$EXTENSION_PATH")")
   fi
   if [ "${ANNOTATE:-0}" = 1 ]; then
     ARGS+=(--annotate)
   fi
   runner_status=0
   node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run "${ARGS[@]}" || runner_status=$?
   if [ "$runner_status" -eq 2 ]; then
     runner_status=0
     if [[ -n "${WSL_DISTRO_NAME:-}" ]] || {
       [ -r /proc/sys/kernel/osrelease ] && grep -Eqi '(microsoft|wsl)' /proc/sys/kernel/osrelease;
     }; then
       node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run "${ARGS[@]}" --headed || runner_status=$?
     else
       if ! command -v xvfb-run >/dev/null 2>&1 ||
         ! command -v Xvfb >/dev/null 2>&1 ||
         ! command -v xauth >/dev/null 2>&1; then
         printf '%s\n' \
           'WSL2以外のheaded retryには xvfb-run、Xvfb、xauth が必要です。' \
           'Ubuntu/Debian: sudo apt install xvfb xauth。macOS (Homebrew): brew install xorg-server。' >&2
         runner_status=127
       else
         xvfb-run -a node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run "${ARGS[@]}" --headed || runner_status=$?
       fi
     fi
   fi
   if [ "$runner_status" -ne 0 ]; then
     printf 'Dogfood did not complete (exit %s). Report: %s\n' "$runner_status" "$OUT_ABS/report.md" >&2
     exit "$runner_status"
   fi
   ```

   runtime entrypoint は固定 Playwright lock から依存を準備し、WSL2 以外では Chromium も `DOGFOOD_DEPS_DIR` または XDG cache に配置します。report と browser profile は証跡 output の下だけに書き、plugin 内の output/cache は symlink 解決後の path も含めて拒否します。WSL2 では loopback CDP 経由で Windows Managed Dogfood Chrome を取得します。通常 Web、MV3、annotation は output から決まる同じ profile identity と所有権記録を共有します。annotation のときだけ WSL2 browser CLI runtime を準備し、対象画面を screencast する別 Dashboard window を使います。検査対象 browser は headless のままです。headless を最初に実行し、exit 2 のときだけ同じ profile identity で MV3 を headed で一度再試行します。cleanup または report 公開の失敗を含む exit 1 では停止します。試行ごとの report と証跡を `attempts/<id>/` に残し、root の `report.md` は最新結果を表示します。WSL2 の再試行は WSL browser も `xvfb-run` も起動しません。

   WSL2 では `packages/wsl2-browser/bin/managed-chrome-owner` と Windows script が必要で、runtime entrypoint がその絶対 path を渡します。Chrome が停止したと確認できない起動・cleanup 失敗では所有権記録を保持します。owner CLI の `status` で利用者を特定し、その利用者を終了してから `recover` を実行します。復旧処理は Chrome が停止したことを確かめて所有権を解放するだけで、Chrome を閉じたり profile を削除したりしません。起動状態が不明なら調査のため所有権を保持し、所有権が残る間は headed 再試行をしません。managed session と Dashboard の停止後に、WSL2 browser package と dogfood skill を一緒に更新します。

   `--annotate` では、自動検査を終えてから Playwright Dashboard の入力を待つことを利用者へ通知します。Managed Dogfood Chrome の CDP endpoint に一意な Playwright CLI session を接続して視覚 annotation を集め、dogfood の所有権を解放する前に切断します。矩形と全体 feedback は finding 候補になり、空の送信から候補は作りません。annotation が失敗した場合は明示的な非ゼロ終了にしますが、report と trace は確定し、接続 browser が録画に対応する場合は video も確定します。

6. Read the run and evidence status using [report-parsing.md](references/report-parsing.md), then parse `report.md` into finding candidates. Exit 0 may include evidence warnings: display the missing artifacts and reasons before review. Failed runs stop automatic review; explicit `--resume` can review their recorded findings without rerunning the browser or treating them as completed.
7. Without `--issues`, report the findings, run/evidence status, warnings, and local report path, then finish. With `--issues` and nonempty candidates, run dedup preflight with `gh search issues` and label preflight with `gh label list`.
8. Ask for approval using [approval-protocol.md](references/approval-protocol.md). Use Keep, Skip, Edit, and Open all remaining as-is in a four-choice runtime. In a runtime limited to three choices, ask for individual versus batch review first, then use Keep, Skip, and Edit per finding.
9. Create approved issues with `gh issue create`, referencing paths relative to the resolved local evidence root (normally `dogfood-output/<session>/`). For an external resumed output, include its absolute local evidence root in the Issue source section. If `--parent #N` was explicitly supplied, append created sub-issue links to that parent.
10. Report created, skipped, edited, and duplicate-suspect findings. Leave the worktree in place for evidence audit.

## Scope Boundary

This skill ends with the report and findings summary, or with approved Issue creation and its summary when `--issues` is supplied. Do not implement fixes, create code branches, commit application changes, push code, open implementation PRs, close issues, or run finalization inside this skill.

If the user includes a follow-on workflow, finish only the dogfood phase first, then report an explicit handoff summary:

- report path and findings, plus created issue numbers and skipped/duplicate candidates when `--issues` is supplied
- current cycle number and zero-finding streak when the request is multi-cycle
- any visible GitHub actions that still need user approval

Created issues enter the separate triage workflow. `triage` is a third-party skill and is not bundled here; load its official separately installed version only when the user asks to continue. If it is unavailable, stop at the handoff and say so. Continue into implementation only within the user's authorized follow-on scope.

For multi-cycle requests, track cycle count and zero-finding streak separately from this skill's single-cycle inspection. A single zero-finding dogfood run completes only the current cycle; never claim a "2 consecutive zero findings" stop condition unless two completed consecutive dogfood cycles both found zero Critical, High, or Medium findings (priority aliases P0-P2) after the most recent positive-finding cycle. Count only newly executed cycles whose final report has `Run status: completed` and `Evidence status: complete`, with no warnings. Evidence warnings reset the streak even when exit is 0. A run that reached only a login screen never counts, whatever its status. Failed, unfinished, retryable, and unknown runs also break the streak; headless/headed attempts together are one cycle, and `--resume` is review of an existing attempt, never a new cycle. If a cycle records no findings, skip follow-on implementation/finalization steps for that cycle and report the next required cycle or stop condition.

## Inputs

- `TARGET_URL`: required URL for a new run; not required with `--resume`.
- `REPO`: optional `owner/name`, valid only with `--issues`; required for an external resumed report; otherwise defaults to the current GitHub repository.
- `--issues`: opt into GitHub dedup, label lookup, candidate approval, and Issue creation. Without it, finish with the report and findings summary.
- `--resume <path>`: optional existing dogfood output directory containing `report.md`. The directory is a read-only evidence root. It may be an output root or an individual `attempts/<id>/` directory. Legacy/external reports without run status are reviewed as status unknown and never count toward consecutive zero-finding cycles.
- `--annotate`: optional visual feedback collection through Playwright CLI. It waits for human submission after automated checks and is incompatible with `--resume`.
- `--parent #N`: optional parent issue; requires `--issues`. Never infer a parent automatically.
- `--auth-from <profile|notes>`: optional authentication context. Not yet supported by the Playwright runner; supplying it stops the run so authenticated dogfood does not degrade into an unauthenticated login-page check.
- `--extension <path>`: optional path to an unpacked MV3 Chrome extension. On WSL2 the Managed Dogfood Chrome process receives the extension flags; the runner verifies a `chrome-extension://` service worker. Not compatible with `--auth-from` until authenticated MV3 state import is implemented.

## Guardrails

- Do not commit or push dogfood evidence. New runs stay under a gitignored `.worktrees/` dogfood worktree. An external resumed output remains in place as a read-only evidence root; issues identify that local root and reference evidence relative to it, never by committed URL.
- Do not auto-remove the worktree; it is the audit trail for screenshots, videos, and the source report.
- Do not add setup-repo labels in this flow. Missing severity or area labels fall back to `bug,dogfood`.
- Stop on `gh issue create` failure and print already-created issue numbers plus rollback commands.
- Adapt the approval questions to the current runtime's choice limit without dropping either per-finding editing or the explicit batch escape hatch.
- The Playwright dogfood runner is the standard path for both normal web targets and `--extension` MV3 targets. For open-ended manual browser exploration, load the official third-party `playwright-cli` skill only for that path; do not copy its source into this plugin.
- The runner inspects only the target's initial page: it neither signs in nor navigates. For a target behind authentication it sees only the login screen, so "no findings" there does not mean the app is clean, and the run does not count toward the zero-finding streak. Explore such a target with the separately installed `playwright-cli` skill after signing in with throwaway credentials the target itself provides (a local demo's invitation, a test account); never reuse real credentials. In the summary, name the areas the run did not cover.
- Before clicking a control that looks destructive or irreversible (delete, revoke, send, publish), read its label and the state around it, and act only on throwaway data. Apps differ: some open a confirmation dialog (`alertdialog`), others act at once. Take a fresh snapshot after the click; an open dialog is not a no-op.

## References

- [index.md](references/index.md)
- [mv3-extension.md](references/mv3-extension.md)
- [mv3-spike.md](references/mv3-spike.md)
