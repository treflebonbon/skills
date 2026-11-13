# 依存関係と供給元

CLI は Bun 1.4.4 以上で動きます。Bun は[公式手順](https://bun.com/docs/installation)で導入し、`lib/bun/run` 経由で実行します。Bun がない場合、`lib/bun/run` は終了コード 2 で止まります。`lib/bun/run` は `--no-install` なので、配布先で npm package は取得されません。

## 同梱する第三者コード

| package          | 版      | 用途                     | 供給元                                                                                           |
| ---------------- | ------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `@dagrejs/dagre` | `3.1.3` | 流れ（`flow`）の図の配置 | 公式 registry `https://registry.npmjs.org/`（2026-10-24 公開。lock に tarball URL と integrity） |

- 版は `package.json` で完全一致に固定し、`package-lock.json` に tarball URL（公式 registry）と integrity を記録します。推移依存 `@dagrejs/graphlib` `4.0.6` も lock に含まれます（Dagre の bundle に内包済み）。
- 実行時に読むのは `vendor/dagre.esm.js` だけです。`node_modules` は不要で、配布物に含めません。第三者 license 表示は `vendor/THIRD-PARTY-LICENSES.txt` です。
- 依存を足す・上げるときは、一時ディレクトリへ `package.json` と `package-lock.json` を複製して `npm ci --ignore-scripts` を実行し、`lib/bun/run run scripts/vendor.ts <その node_modules>` で `vendor/` を再生成します。`scripts/vendor.ts` の `VENDORED` に 1 行足すと bundle と notice が増えます（ELK.js・ast-grep を後続で足す場合も同じ経路）。
- `tests/test_plugin.py` が、lock の公式 registry URL と integrity、`package.json` と lock の版の一致、bundle の版表示、lock の全 package の notice を検査します。repo root に `package-lock.json` は作らず、skill 直下に `node_modules` も置きません。

生成する HTML は外部通信、外部フォント、script を使いません。図は生成時に配置した SVG を HTML に埋め込むため、ブラウザに Dagre は渡りません。ブラウザでの閲覧に追加の導入は不要です。

通常の導入済み Bun での実行だけを対象とします。raw Codex isolation 内での実行は保証しません。Nix 上の Bun 起動は別の実証であり、この skill の実行経路ではありません。

調査と文章化には、対象リポジトリの GLOSSARY・ADR を読む権限だけが必要です。入れ子フローの図（ELK.js）、前版との比較、ast-grep による根拠収集は、この版では提供しません。
