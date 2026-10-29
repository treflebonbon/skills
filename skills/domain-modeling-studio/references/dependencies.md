# 依存関係と供給元

モデル、アーキテクチャ、HTML 生成スクリプトには Node.js 20 以上が必要です。オフラインのレビュー用 HTML は実行時に追加依存を使いません。同梱の編集画面を生成する各 npm package の版は、この skill の `package-lock.json` に固定しています。利用者は npm package を追加導入せず、同梱の `dist/studio.html` を使えます。編集画面を再生成するときは一時ディレクトリで `npm ci` を実行し、配布 template と license notice だけを `dist/` に書き込みます。

ドメインモデルを文書化する手順では、別途導入した `domain-modeling` skill が必要です。この package には `ui-grill-with-docs` も含まれています。内容と使い方は[隣接する skill](../../ui-grill-with-docs/SKILL.md)を参照してください。記録済みの外部 skill 集合は [`mattpocock/skills` の commit `49dd158d1076134a641b33efb035946536778336`](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336) です。第三者 skill は利用する runtime の公式導入経路から取得し、この package には同梱しません。

TypeScript の構文から証拠を抽出する経路だけで Python 3 と `ast-grep` CLI を使います。公式 [Quick Start](https://ast-grep.github.io/guide/quick-start) は TypeScript コードの検索例と CLI の導入方法を示しています。`ast-grep` は案内されている npm package [`@ast-grep/cli`](https://www.npmjs.com/package/@ast-grep/cli) から、例えば `npm install --global @ast-grep/cli@0.42.1` で導入できます。公式 [0.42.1 release](https://github.com/ast-grep/ast-grep/releases/tag/0.42.1) がこの版の出所です。この作業環境で `ast-grep --version` が返した値は `ast-grep 0.42.1` でした。これは環境で観測した版で、推奨下限や互換性保証ではありません。CLI の導入元はこの作業では検証しておらず、構文抽出 helper 自体も実行していません。

Python または `ast-grep` が使えない場合、helper の結果を `unavailable` または `failed` と記録し、ソースコードを読んで調査を続けます。不足した証拠のために挙動を確定できない場合は、未解決事項を追記します。他のモデル作成・描画経路には Python、`ast-grep`、Nix は必要ありません。

browser 上で対話的にレビューする場合だけ、別途導入した `playwright-cli` skill と CLI が必要です。使えない場合もオフライン HTML を生成し、その link を提示すればモデル作成を続けられます。モデル JSON、抽出証拠、review HTML、生成物は、導入済み skill の外にある session 所有の task scratch に置きます。generator は自身の script の位置を基準に template を読み込みます。
