# 依存関係と供給元

モデル、アーキテクチャ、HTML 生成スクリプトには Node.js 20 以上が必要です。オフラインのレビュー用 HTML は実行時に追加依存を使いません。同梱の編集画面を生成する各 npm package の版は、この skill の `package-lock.json` に固定しています。利用者は npm package を追加導入せず、同梱の `dist/studio.html` を使えます。編集画面を再生成するときは一時ディレクトリで `npm ci` を実行し、配布 template と license notice だけを `dist/` に書き込みます。

ドメインモデルを文書化する手順では、別途導入した `domain-modeling` skill が必要です。この package には `ui-grill-with-docs` も含まれています。内容と使い方は[隣接する skill](../../ui-grill-with-docs/SKILL.md)を参照してください。記録済みの外部 skill 集合は [`mattpocock/skills` の commit `49dd158d1076134a641b33efb035946536778336`](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336) です。第三者 skill は利用する runtime の公式導入経路から取得し、この package には同梱しません。

TypeScript の構文から証拠を抽出する経路だけで Bun 1.4.4 以上と `ast-grep` CLI を使います。Bun は[公式手順](https://bun.com/docs/installation)で導入し、`ast-grep` は公式 [Quick Start](https://ast-grep.github.io/guide/quick-start) の npm package [`@ast-grep/cli`](https://www.npmjs.com/package/@ast-grep/cli) から、例えば `npm install --global @ast-grep/cli@0.42.1` で導入できます。Bun 1.2.14 ではシンボリックリンクに続く `..` の解決が異なるため、正しい解決を確認した 1.4.4 を最低バージョンとし、未対応の版では helper が `unavailable` を返します。Bun 1.2.14 の拒否と、Bun 1.4.4・`ast-grep 0.42.1` での構文抽出を回帰テストで確認しています。配布先での plugin 導入と呼び出しはリリースごとの受入で確認します。

Bun が使えない場合は、起動できなかった理由を記録し、ソースコードを読んで調査を続けます。`ast-grep` が使えない場合や抽出に失敗した場合は、helper が出力する `unavailable` または `failed` とその理由を使います。不足した証拠のために挙動を確定できない場合は、未解決事項を追記します。

browser 上で対話的にレビューする場合だけ、別途導入した `playwright-cli` skill と CLI が必要です。使えない場合もオフライン HTML を生成し、その link を提示すればモデル作成を続けられます。モデル JSON、抽出証拠、review HTML、生成物は、導入済み skill の外にある session 所有の task scratch に置きます。generator は自身の script の位置を基準に template を読み込みます。
