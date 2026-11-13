# 依存関係と供給元

CLI は Bun 1.4.4 以上と Bun の標準 API だけで動きます。新規の npm package・lockfile・第三者 notice はありません。Bun は[公式手順](https://bun.com/docs/installation)で導入し、`lib/bun/run` 経由で実行します。Bun がない場合、`lib/bun/run` は終了コード 2 で止まります。

生成する HTML は外部通信、外部フォント、script を使いません。ブラウザでの閲覧に追加の導入は不要です。

通常の導入済み Bun での実行だけを対象とします。raw Codex isolation 内での実行は保証しません。Nix 上の Bun 起動は別の実証であり、この skill の実行経路ではありません。

調査と文章化には、対象リポジトリの GLOSSARY・ADR を読む権限だけが必要です。図の生成（Dagre・ELK.js）、ast-grep による根拠収集は、この版では提供しません。
