---
name: product-guide
description: "対象版のコードと承認済みの用語・仕様・ADR を調べ、根拠付きモデルから利用者向けの単体 HTML の利用ガイドを生成する。"
disable-model-invocation: true
---

# product-guide

対象版の「今、何ができるか」を、利用者向けの単体 HTML の**利用ガイド**にする。調査と文章化はあなた（エージェント）が行い、決定的な CLI がモデルを検証して HTML を生成する。語彙は `GLOSSARY.md` の「利用ガイド」「対象版」「調査範囲」「根拠区分」「提供状況」に従う。

## 手順

1. 対象の Git 参照をコミット ID（40 桁）へ解決する。CLI は解決しない。ブランチ名のままモデルへ入れない。
2. 対象版のコードと、承認済みの用語・仕様・ADR を調べ、[モデル仕様](references/model.md)の JSON を書く。モデルは session 所有の scratch に置く。
3. 各主張に根拠を付ける。根拠区分は `code-verified`（対象版のコードで確認した事実）、`approved-decision`（承認済みの業務判断）、`inferred`、`unverified`。コードの事実と業務判断が食い違うときは `conflicts` に両方の主張を残す。どちらかへ寄せない。
4. 提供状況（`available` / `in-development` / `proposed` / `unknown`）は人から指定された値だけを書く。コミットから推定しない。未指定は `unknown`。`proposed` は現行機能と別枠に出る。
5. `validate` で検証し、`generate` で出力する。

```bash
skill_dir="<読み込んだ SKILL.md の絶対パスの親 directory>"
plugin_root="$(cd -- "$skill_dir/../.." && pwd -P)"
"$plugin_root/lib/bun/run" run "$skill_dir/scripts/product-guide.ts" validate model.json
"$plugin_root/lib/bun/run" run "$skill_dir/scripts/product-guide.ts" generate model.json --audience internal --out <出力親 directory>
```

`--audience` は `internal` か `public`。出力は `<out>/<完全なコミット ID>-<audience>/index.html`。既存があれば上書きせず失敗し、強制上書きの手段はない。比較元などの未対応の入力は、黙って無視せずエラーになる。

## 保証の範囲

- `validate` が保証するのは構造の整合だけ。対象版 ID の形式、主張から根拠への参照、根拠の版が対象版と一致すること、`code-verified` の根拠にコミット ID とパスがあること。**実コードとの一致は、調べたあなたの責任**で、CLI は検証済みとして扱わない。
- `public` は、根拠・コミット ID・パス・シンボルをモデルから取り除いた別データから HTML を作る（投影方式）。さらに最後の安全網として、自由記述を登録済みのパス・シンボル・コミット ID、40 桁／短縮の 16 進 ID、ADR／issue 番号、ブランチ名、ファイル拡張子の形式で検査し、一致すれば成果物を作らず失敗する。この検査は完全な保証ではない。検査の対象は投影後の自由記述（題名・要約・操作名・用語集・未確認事項・主張・矛盾）で、範囲外の形式（言い換えた内部名や一般的な語に見える識別子など）は検出できない。逆に、`.md` や `.json` のような拡張子形式を含む通常の文章（例: 手順書.md）も誤検知して拒否する。この誤検知は既知の限界で、`public` では拡張子形式を避けて書き換える。**`public` の自由記述に実装詳細を書かない。** 利用者が画面と照合する操作名は `operations` に、内部のシンボルは `evidence.symbol` に分けて書く。
- `public` の共有単位は `index.html` だけ。ディレクトリ名にコミット ID が含まれるため、ディレクトリごと共有しない。
- 見た目と閲覧（ネットワーク遮断、折りたたみ、キーボード、印刷）の確認は人手で行う。手順は [検証記録](../../docs/verification.md) を参照。

依存と対応範囲は[依存関係](references/dependencies.md)を参照。
