---
metadata:
  topics: "dogfood, runtime, dependencies"
  source: "treflebonbon/skills"
---

# Dogfood の依存

dogfood の依存は必要な処理の直前にだけ準備します。skill 本体、固定 lock、fixture は plugin に同梱し、実行時の `node_modules`、Chromium、browser profile、証跡は plugin root の外に置きます。

## 常に必要な依存

- Node.js 20 以上と npm: Playwright runner の固定依存を `references/package-lock.json` から `npm ci --ignore-scripts` で準備します。`playwright` と `playwright-core` は同じ版の `1.63.0`、供給元は `https://registry.npmjs.org/`、lock の license metadata は Apache-2.0 です（[license](https://www.apache.org/licenses/LICENSE-2.0)）。上流 source はコピーせず、`DOGFOOD_DEPS_DIR` または `${XDG_CACHE_HOME:-~/.cache}/treflebonbon/dogfood/` の外部 cache にインストールします。
- 新規 run の Git worktree: `git` の local operation だけを使います。`--resume` は既存 report の確認なので worktree を作りません。

`node <loaded-skill-dir>/scripts/dogfood-runtime.mjs prepare` は固定 lock と browser を準備します。通常の run では同じ helper が実行前に準備するため、直接 `npm ci` する必要はありません。非 WSL2 では公式 Playwright installer が Chromium を同じ外部 runtime cache の `ms-playwright` に配置します。WSL2 ではここへ browser を download せず、Windows Managed Dogfood Chrome を利用します。Playwright の package source と browser binary は plugin に複製・同梱しません。

## 選択した経路だけで必要な依存

- `--issues`: GitHub CLI `gh` と利用者の GitHub login が必要です。runtime preflight が `gh auth status`、repo と Issues の利用可否を確認します。Issue 候補の承認前には作成しません。
- `--annotate`: Microsoft の公式 [Playwright CLI skill](https://github.com/microsoft/playwright-cli) を別途インストールしてから読み込みます。skill は third-party 配布のままとし、この plugin へコピーしません。`packages/wsl2-browser` の `@playwright/cli` `0.1.22` 固定 runtime は、annotation を選んだときだけ `bin/wsl2-browser-prepare` が package 固有 lock から plugin 外へ準備します。WSL2 では Windows Chrome、mirrored networking、Windows interop が必要です。
- open-ended の browser exploration: 同じ公式 Playwright CLI skill を別途導入してから使います。dogfood runner は対象 page の初期状態だけを検査します。
- Issue 作成後の別工程として triage をユーザーが求めた場合: [Matt Pocock の公式 skills](https://github.com/mattpocock/skills) から `triage` を別途導入し、その runtime が表示する名前付き呼出しで起動します。この公開 plugin は `triage` の版を固定せず、Issue 作成や要約だけのためには読み込みません。未導入の場合は handoff で止めます。

`packages/wsl2-browser/USAGE.md` は WSL2 browser runtime、ownership、共有添付の条件と license を説明します。lock 内の tarball URL、integrity、license は変更時に一緒に検証してください。
