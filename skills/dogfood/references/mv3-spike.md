---

metadata:
  depends_on: "skills/dogfood/SKILL.md"
  topics: "dogfood, mv3, service-worker, spike"
  source: "human"
---

# MV3 SW registration spike (#955)

> この記録は2026-06-18当時の Nix 環境で実施した歴史的な検証です。現在の配布経路では `playwright@1.63.0` を固定 lock から外部 cache へ準備し、WSL2 では Windows Managed Dogfood Chrome を使います。現行の依存と起動手順は [dependencies.md](dependencies.md) と [mv3-extension.md](mv3-extension.md) を参照してください。

## 目的

`agent-browser --headless=new` + `--load-extension` で MV3 Service Worker が登録され、agent-browser 経由で観測・制御できるか検証し、`--extension` 経路の実装方式 (c)/(a) を確定する。

- (c): agent-browser を流用する最小変更
- (a): skill 同梱の Playwright runner（`launchPersistentContext` + `channel: 'chromium'` + `--load-extension`）

## 判定基準

CDP `Target.getTargets` に `type: "service_worker"` かつ `chrome-extension://` の target が現れ、かつ agent-browser の CLI 面でそれを観測・制御できること。

## 手順と結果（2026-06-18, agent-browser 0.28.0, Chrome via nix）

### 1. agent-browser `--headless=new` + `--extension`

```bash
agent-browser --session mv3-probe --extension references/fixtures/mv3-min --args "--headless=new" open about:blank
agent-browser --session mv3-probe get cdp-url   # ws://127.0.0.1:PORT/devtools/browser/<id>
# raw CDP WebSocket で Target.getTargets（agent-browser CLI に target 列挙コマンドが無いため node で実施）
```

- `Target.getTargets`: **service_worker target 0 件**（page/iframe のみ）。
- HTTP `/json/list`: fixture の SW は出ず、built-in component 拡張の `background_page` のみ。
- fixture の extension ID はどちらにも現れず。

### 2. agent-browser `--headed`（単一 xvfb-run セッション）

- `Target.getTargets`: **service_worker target 0 件**。headed でも fixture の MV3 SW は観測できず。
- 補足: `xvfb-run` を別呼び出しすると別 DISPLAY/別 daemon が立ち、`get cdp-url` が別インスタンスを指す（#952 が指摘した DISPLAY/daemon カップリングを再現）。

### 3. agent-browser CLI surface

- `0.28.0` の CLI に Target 列挙コマンドは無い。SW 観測には raw CDP WebSocket へ落ちる必要があり、skill の自動化面として不十分。

### 4. Playwright (a) path（実証）

```js
const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let sw =
  ctx.serviceWorkers()[0] ??
  (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
```

- 結果: **SW を観測**。`chrome-extension://<id>/service-worker.js`、Extension ID 取得可。**headless でも成立**。

## 採用経路: **(a) Playwright runner**

agent-browser（headless/headed とも）は MV3 SW を観測・制御できず、CLI 面も不足。Playwright の `launchPersistentContext` + `channel: 'chromium'` + `--load-extension` は headless で MV3 SW を観測できる。よって #956 は skill 同梱の Playwright runner（案 (a)）で実装する。

## #956 への申し送り（重要: pin 訂正）

- **Playwright の pin は `1.59.x`（1.59.0 / 1.59.1）にすること。** nix `PLAYWRIGHT_BROWSERS_PATH` のブラウザは `chromium-1217` で、これは playwright `1.59.x` に対応する。
  - playwright `1.58.2`（uxaudit の pin）→ `chromium-1208` を要求し **不一致**（`Executable doesn't exist .../chromium-1208`）。
  - playwright `1.60.0` → `chromium-1223` で **不一致**。
- したがって design/plan に書いた「uxaudit と同一 pin (`1.58.2`)」は、この環境の nix browsers とは整合しない。**nix `playwright-driver` のブラウザ build に合わせて `1.59.x` を pin する**のが正。（将来 nix 側が更新されたら browsers dir の `chromium-<N>` に対応する playwright バージョンへ再 pin する。）
- runner は `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 前提で nix browsers を使う。
