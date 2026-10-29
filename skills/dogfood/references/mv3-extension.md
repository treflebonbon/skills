---

metadata:
  depends_on: "skills/dogfood/SKILL.md"
  topics: "dogfood, mv3, chrome-extension, playwright"
  source: "human"
---

# Playwright Dogfood Runner and MV3 Extension Path

## When to use this runner

`dogfood` uses the bundled Playwright dogfood runner (`playwright-dogfood-runner.mjs`) for normal web targets and for Chrome MV3 extension targets. Pass `--extension <path>` when the run must load an unpacked MV3 Chrome extension directory (i.e. a directory containing `manifest.json` with `"manifest_version": 3`).

## Why Playwright is the standard path

The runner writes deterministic artifacts (`report.md`, screenshots, traces, console/network JSON, and videos when the browser supports Playwright recording) without feeding DOM dumps or trace bodies into the model context. This keeps `dogfood` evidence reproducible and low-token. WSL2's CDP path is intentionally video-free because `connectOverCDP` cannot reliably provide `recordVideo`; it uses an explicit 1440x1000 viewport instead.

With the opt-in `--annotate` flag, Playwright CLI attaches over CDP to this same Managed Dogfood Chrome context after service-worker inspection. It does not launch a second browser. The runner detaches the CLI session before releasing the dogfood ownership record and retains annotation artifacts with the other evidence.

For MV3 extensions, the runner always verifies a `chrome-extension://` service worker. On WSL2 the Windows Managed Dogfood Chrome process receives `--disable-extensions-except` and `--load-extension` and is reached over loopback CDP; no browser binary or X server is installed in WSL. Non-WSL environments retain the local Playwright persistent-context path.

## Playwright version and browser supply

runner API 用に `references/package.json` は `playwright@1.63.0` を固定します。WSL2 では CDP client としてだけ使い、WSL 内の browser は download も起動もしません。

WSL2 以外では固定 Playwright 版に対応した Chromium executable を外部 `PLAYWRIGHT_BROWSERS_PATH` cache に一つだけ install して使います。browser bundle がない、または複数ある場合は起動前に失敗します。WSL2 では Windows Managed Dogfood Chrome package を使い、WSL browser を install しません。

Prepare the fixed dependency and browser cache (the canonical invocation lives in `SKILL.md`; set `SKILL_DIR` to the absolute directory of the loaded skill):

```bash
node "$SKILL_DIR/scripts/dogfood-runtime.mjs" prepare
```

helper は commit 済みの `references/package-lock.json` から依存を install し、`node_modules` と browser file を plugin の外に置きます。WSL2 ではローカル browser の install を省きます。

## Evidence contract

The runner keeps each attempt under `<output>/attempts/<id>/`. Its report and collected evidence use the paths below, relative to that attempt. The output root also has `report.md`, presenting the latest attempt with evidence paths prefixed by `attempts/<id>/`; the root retains the local `.chromium-profile/` identity. Use `dogfood-output/<session>/` as the output root.

| Path | Contents |
| --- | --- |
| `report.md` | Finding candidates as `### ISSUE-NNN:` blocks (see [report-parsing.md](report-parsing.md)); MV3 runs include an Extension ID header; clean runs emit no ISSUE block |
| `screenshots/initial.png` | Full-page screenshot after navigation |
| `videos/` | Screen recording for locally launched contexts (finalized after `context.close()`); not produced by WSL2 CDP runs |
| `traces/playwright-trace.zip` | Playwright trace archive for deterministic local replay |
| `console.json` | Captured console/page errors |
| `network.json` | Captured failed requests and 5xx responses |

The runner emits findings in the `report-parsing.md` block contract so Step 5 parses them directly: console/page errors become a `Category: console` finding, failed requests and 5xx responses become a `Category: network` finding, a missing MV3 service worker becomes a `Critical` `functional` finding, and navigation failures become `High` `functional` findings. Video files are finalized only after `context.close()`; the runner enumerates them after closing and lists them under each finding's `Evidence`.

## Launch mechanism

On WSL2 the runner uses `chromium.connectOverCDP` to the Managed Dogfood Chrome endpoint. For `--extension` runs the Windows process also receives:

- `--disable-extensions-except=<extension>` — disables all other extensions
- `--load-extension=<extension>` — loads the unpacked MV3 extension

Playwright does not reliably support `recordVideo` for an existing browser reached through `connectOverCDP`. WSL2 CDP runs therefore omit video capture and apply the required 1440x1000 viewport with `page.setViewportSize`, including when an extension run reuses `browser.contexts()[0]`. Healthy-run verification requires report, screenshot, trace, console/network data; a `.webm` is required only for locally launched contexts. Collection failures are explicitly reported: completed inspection with missing evidence returns 0 with warnings, while execution/cleanup/report failures return 1. The report retains observed findings, and Evidence includes only successfully saved files.

The service worker is obtained by filtering for `chrome-extension://` workers (so a reused profile or an unrelated worker is not mistaken for the extension under test), with the `waitForEvent` wrapped so a timeout does not throw:

```js
const isExtSw = (w) => w.url().startsWith("chrome-extension://");
let sw = context.serviceWorkers().find(isExtSw);
if (!sw) {
  try {
    sw = await context.waitForEvent("serviceworker", {
      predicate: isExtSw,
      timeout: 15000,
    });
  } catch {
    sw = undefined; // recorded as a Critical finding instead of crashing
  }
}
const extensionId = sw
  ? sw.url().split("/")[2]
  : "(unknown - service worker not registered)";
```

This derives the extension ID from the SW URL (`chrome-extension://<id>/...`) without relying on `chrome.management` or a fixed ID. The context is always closed in a `finally` block so the profile lock is released and any supported local video is finalized even when the SW or navigation fails.

## Headless vs headed

headless を先に実行します。runner が exit 2（headless で service worker が登録されず、実行・cleanup・report 公開の失敗がない場合）を返したときだけ、同じ output 起点の profile identity で `--headed` を一度だけ再試行します。headed でも SW が登録されない場合は Critical finding として記録し、終了します。

```bash
node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run --target "$TARGET_URL" --extension "$EXT_ABS" --output "$OUT_ABS" --headed
```

WSL2 の retry は headed Windows Chrome を使い、`xvfb-run` を使いません。WSL2 以外では通常の display provider で command を wrap できます。

## Self-test (no external extension required)

`references/fixtures/mv3-min/` is a minimal MV3 extension (manifest + service worker) included in this repository for smoke testing.

```bash
OUT_DIR="$(readlink -m .worktrees/dogfood-mv3-smoke)"
node "$SKILL_DIR/scripts/dogfood-runtime.mjs" run --target about:blank --extension "$SKILL_DIR/references/fixtures/mv3-min" --output "$OUT_DIR"
```

Expected outputs inside the latest attempt after the runner exits (the fixture's SW registers, so a clean run reports no findings):

- `report.md` containing an `Extension ID:` line (and `No findings recorded.` for the clean fixture)
- `screenshots/initial.png`
- `traces/playwright-trace.zip`
- `videos/` directory with a `.webm` file when run through a locally launched context; WSL2 CDP runs intentionally omit this directory entry

## Limitations

- **`--auth-from` is not yet supported on this runner.** The Playwright runner launches a fresh persistent context and does not apply the `--auth-from` profile/notes, so an authenticated target would be dogfooded unauthenticated (degrading the run into a login-page check or misleading findings). `SKILL.md` Step 4 therefore stops with an error when `--auth-from` is supplied. Applying auth state (e.g. `storageState` input or `context.addCookies()` from a stored profile) is a follow-up. The runner does not export cookies or localStorage into a separate authentication-state evidence file.
