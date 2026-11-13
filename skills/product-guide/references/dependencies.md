# 依存関係と供給元

CLI は Bun 1.4.4 以上で動きます。Bun は[公式手順](https://bun.com/docs/installation)で導入し、`lib/bun/run` 経由で実行します。Bun がない場合、`lib/bun/run` は終了コード 2 で止まります。`lib/bun/run` は `--no-install` なので、配布先で npm package は取得されません。

## 同梱する第三者コード

| package                  | 版        | 用途                                                       | 供給元                                                                                           |
| ------------------------ | --------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `@dagrejs/dagre`         | `3.1.3`   | 流れ（`flow`）の図の配置                                   | 公式 registry `https://registry.npmjs.org/`（2026-10-24 公開。lock に tarball URL と integrity） |
| `elkjs`                  | `0.11.1`  | 入れ子の業務区分（`group`）を持つ流れの図の配置（EPL-2.0） | 公式 registry `https://registry.npmjs.org/`（2026-03-03 公開。lock に tarball URL と integrity） |
| `@ast-grep/wasm`         | `0.51.0`  | TS/JS の構文上の根拠の収集                                 | 公式 registry（2026-10-15 公開。lock に tarball URL と integrity）                               |
| `web-tree-sitter`        | `0.26.13` | 上記の実行基盤（WASM）                                     | 公式 registry（2026-08-23 公開）                                                                 |
| `tree-sitter-typescript` | `0.23.2`  | TypeScript／TSX の文法（WASM）                             | 公式 registry（2024-11-11 公開）                                                                 |
| `tree-sitter-javascript` | `0.25.0`  | JavaScript の文法（WASM）                                  | 公式 registry（2025-09-01 公開）                                                                 |

- ast-grep は **WASM 版**（`@ast-grep/wasm`）を使います。ネイティブ binary（`@ast-grep/napi`・CLI）はプラットフォーム別に 9 種類（各 7〜9 MB）あり、全てを同梱すると約 70 MB になるため採りません。WASM 版は OS・CPU に依存せず、同梱は `vendor/ast-grep/` の約 5.7 MB です。`@ast-grep/wasm` は license ファイルを同梱しないため、上流の LICENSE（MIT）の控えを `references/ast-grep-wasm.LICENSE` に置き、notice へ取り込みます。
- Bun は `.wasm` の ESM import に対応しないため、`scripts/collect-evidence.ts` が `WebAssembly.Instance` で読み込みます。`vendor/ast-grep/wasm_bg.js` は `web-tree-sitter` の import 先を同梱ファイルへ向ける 1 か所だけ書き換えています（`scripts/vendor.ts` の `ASSETS`）。
- 版は `package.json` で完全一致に固定し、`package-lock.json` に tarball URL（公式 registry）と integrity を記録します。推移依存 `@dagrejs/graphlib` `4.0.6` も lock に含まれます（Dagre の bundle に内包済み）。
- 実行時に読むのは `vendor/dagre.esm.js`、入れ子フローのときだけ `vendor/elk-api.js` と `vendor/elk-worker.min.js` です（ELK.js の `bundled` 版は browser 用で Bun では動かないため、API と同期実行 worker の 2 ファイルを同梱します）。`node_modules` は不要で、配布物に含めません。第三者 license 表示は `vendor/THIRD-PARTY-LICENSES.txt` です。
- 依存を足す・上げるときは、一時ディレクトリへ `package.json` と `package-lock.json` を複製して `npm ci --ignore-scripts` を実行し、リポジトリ直下から `lib/bun/run run skills/product-guide/scripts/vendor.ts <その node_modules>` で `vendor/` を再生成します。`scripts/vendor.ts` の `VENDORED` に 1 行足すと bundle と notice が増えます（ELK.js は同じ経路で追加済み）。ast-grep の WASM 一式は `ASSETS` に足します。
- `tests/test_plugin.py` が、lock の公式 registry URL と integrity、`package.json` と lock の版の一致、bundle の版表示、lock の全 package の notice を検査します。repo root に `package-lock.json` は作らず、skill 直下に `node_modules` も置きません。

生成する HTML は外部通信、外部フォント、script を使いません。図は生成時に配置した SVG を HTML に埋め込むため、ブラウザに Dagre・ELK.js は渡りません。ブラウザでの閲覧に追加の導入は不要です。

通常の導入済み Bun での実行だけを対象とします。raw Codex isolation 内での実行は保証しません。Nix 上の Bun 起動は別の実証であり、この skill の実行経路ではありません。

調査と文章化には、対象リポジトリの GLOSSARY・ADR を読む権限だけが必要です。ast-grep による根拠収集は `collect-evidence.ts`（TypeScript/JavaScript のみ）で、対象リポジトリの `git` を読み取り専用で呼びます。
