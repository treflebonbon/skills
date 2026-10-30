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

- 非 WSL2 で headless 実行の終了値が `2` となった後の headed retry だけで、`xvfb-run`、`Xvfb`、`xauth` が必要です。`xvfb-run` は Xvfb を起動する wrapper で、認証 cookie 用の `xauth` も要求します（[Ubuntu の `xvfb-run` manual](https://manpages.ubuntu.com/manpages/noble/man1/xvfb-run.1.html)）。通常の headless 実行と WSL2 retry には必要ありません。
  - Ubuntu/Debian は OS 公式 package repository から `sudo apt install xvfb xauth` で導入します。Ubuntu の [`xvfb` package](https://packages.ubuntu.com/noble/xvfb) は `Xvfb` と `xvfb-run` を含み、[`xauth` package](https://packages.ubuntu.com/noble/xauth) は認証 utility を提供します。今回の Ubuntu 24.04.4 確認環境で導入済みだった版は `xvfb 2:21.1.12-1ubuntu1.6`、`xauth 1:1.1.2-1build1` です。
  - Debian の公式 [`xvfb` package](https://packages.debian.org/bookworm/xvfb) も `Xvfb` と `xvfb-run` を含み、[`xauth` package](https://packages.debian.org/bookworm/amd64/xauth) は認証 utility を提供します。2026-10-29 に確認した Bookworm package page は `xvfb 2:21.1.7-3+deb12u13`、`xauth 1:1.1.2-1` を示していました。Debian host での導入・実行はこの作業では確認していません。
  - macOS は Homebrew の公式 [`xorg-server` formula](https://formulae.brew.sh/formula/xorg-server) が `Xvfb` と `xvfb-run` を含み、`xauth` を依存に持ちます。`brew install xorg-server` で導入できます。2026-10-29 に公式 formula が示していた版は `xorg-server 21.1.25`、[`xauth 1.1.5`](https://formulae.brew.sh/formula/xauth) です。macOS での実行はこの作業では確認していません。
  - これらは供給元と確認時の版を示すもので、最低対応版や導入・実行の動作保証ではありません。retry の直前に3 command の有無を検査し、不足していれば package 準備方法を案内して headed retry だけを止めます。
- `--issues`: GitHub CLI `gh` と利用者の GitHub login が必要です。runtime preflight が `gh auth status`、repo と Issues の利用可否を確認します。Issue 候補の承認前には作成しません。
- `--annotate`: Microsoft の公式 [Playwright CLI skill](https://github.com/microsoft/playwright-cli) を別途インストールしてから読み込みます。skill は third-party 配布のままとし、この plugin へコピーしません。`packages/wsl2-browser` の `@playwright/cli` `0.1.22` 固定 runtime は、annotation を選んだときだけ `bin/wsl2-browser-prepare` が package 固有 lock から plugin 外へ準備します。WSL2 では Windows Chrome、mirrored networking、Windows interop が必要です。
- open-ended の browser exploration: 同じ公式 Playwright CLI skill を別途導入してから使います。dogfood runner は対象 page の初期状態だけを検査します。
- Issue 作成後の別工程として triage をユーザーが求めた場合: [Matt Pocock の公式 skills](https://github.com/mattpocock/skills) から `triage` を別途導入し、その runtime が表示する名前付き呼出しで起動します。この公開 plugin は `triage` の版を固定せず、Issue 作成や要約だけのためには読み込みません。未導入の場合は handoff で止めます。

`packages/wsl2-browser/USAGE.md` は WSL2 browser runtime、ownership、共有添付の条件と license を説明します。lock 内の tarball URL、integrity、license は変更時に一緒に検証してください。
