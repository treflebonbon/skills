# HTML report の静的検査と text 抽出の Bun 移行

[#36](https://github.com/treflebonbon/skills/issues/36) の比較記録。両 peer の静的 checker を、Bash wrapper と Bun / TypeScript へ切り替えた。図数・診断・JSON・終了状態を維持し、成功時の `render_check` は引き続き `not_performed` とする。実ブラウザ描画の受入は各 skill の別手順で行う。

## 入口と parser

新しい入口は各 skill の `scripts/check-architecture-report <report.html>`。wrapper が package 内の `lib/bun/run` を解決して起動するため、Bun 1.4.4 以上と Bash・標準の POSIX command が必要になる。引数不足・読めない UTF-8 report・markup の拒否は終了1。Bun の不足・未対応版は共通 runner が終了2で拒否する。

[htmlparser2 の Tokenizer](https://github.com/fb55/htmlparser2/blob/master/_autodocs/api-reference/Tokenizer.md) から source の tag・属性・text・entity・comment・宣言のイベントを受け取り、既存の Mermaid `<pre>` の状態と診断へ変換する。DOM の補正や Mermaid の実行を受入の根拠に使わない。

`htmlparser2` 12.0.0 は `development/package.json` と lock に固定した開発依存。実行に必要な Tokenizer と `entities` を [同梱 JavaScript](../lib/bun/vendor/html-tokenizer.js) に bundle する。利用時の npm install、`node_modules`、native build、FFI は不要。[生成入口](../development/build-html-tokenizer.ts) は次のコマンドで実行する。

```sh
npm ci --prefix development
npm run build:html-tokenizer
```

htmlparser2 / entities の [MIT license](../lib/bun/vendor/html-tokenizer.LICENSE) と、終了 tag の完了条件を継承した CPython の [license](../lib/bun/vendor/cpython.LICENSE) を同梱する。更新時は bundle と license を生成し直し、型検査と比較 corpus を再実行する。

## 移行前の比較 corpus

[比較用 JSON](../tests/fixtures/html-report-python.json) は、source revision `2a894eb1d3932cd800cdd40255690832ea57b354`、Python 3.14.7 で、旧 checker と candidate の `artifact_text` を両 peer から採取した。4ファイルの source hash と元 bytes・stdout / stderr・終了状態・text または拒否を保持する。初回64入力を旧実装の変更前に採取し、固定した旧 source hash を照合して終了 tag の属性内に `>` を含む2入力を追加した。計66入力の期待値はすべて旧実装から採取している。新実装から期待値を生成し直す手順にはしない。

| 入力                                                 | 確認する契約                           |
| ---------------------------------------------------- | -------------------------------------- |
| entity、重複 class、大小文字、Unicode 空白、BOM      | 属性の判定と text の復元・連結・正規化 |
| tag、self-closing、comment、doctype、CDATA、PI       | Mermaid 内の markup 拒否、診断順と図数 |
| 不完全な tag・属性・comment・宣言、raw text / RCDATA | EOF の扱いと誤受理の防止               |
| 既存 report fixture、不正 UTF-8                      | 実際の入力と読込拒否                   |

比較で見つかった数値 entity の制御文字・非文字の除外、quote が閉じない終了 tag の拒否、EOF の doctype の診断を明示的に維持する。text の空白は Python の `str.split()` と同じ集合を使い、BOM を空白として除去しない。

`lib/bun/html-report.ts` の `artifactText(raw)` が text 抽出の移植先になる。candidate/evidence の切り替えは [#38](https://github.com/treflebonbon/skills/issues/38) でまとめて行うため、今回の candidate Python 実装はそのまま利用する。

## 検証と残る範囲

2026-11-13 の Linux / WSL2 x86_64、Bun 1.4.4 で確認した。両 CLI の66入力と text 抽出の66入力を [Bun suite](../tests/bun/html-report.test.ts) で照合する。JSON は公開フィールドの値、拒否は終了状態と診断全文を比較する。

読み取り専用にした runtime copy に、wrapper・runner・config・TypeScript・同梱 Tokenizer だけを配置して起動した。`node_modules` を配置せず、fixture 専用の `bin` に Bun・`dirname`・`readlink` だけを置いて Python を PATH から除く。cwd / HOME の preload 設定と `BUN_OPTIONS` を注入しても marker を作らず、payload の bytes・mode・inventory を保持した。ホストの coreutils と Python が同じ directory にある場合も、この専用 PATH で検査できる。これは PATH 上の Python 不在の検査であり、絶対 path の interpreter まで排除する repo 全体の最終検査は #51 が担当する。

利用環境の保護された検証入口から、checkout の root で次を実行する。

```sh
npm run typecheck
lib/bun/run test tests/bun/html-report.test.ts
```

実ブラウザ、実モデル session、macOS / 通常 Linux / aarch64 の実機受入はこのローカル検証の対象外。静的検査の成功だけで report の描画を成功扱いにしない。

## repo 外の呼び出し元と更新

旧 `check-architecture-report.py` と専用の Python 動作テストを撤去し、両 skill の手順・依存説明と helper 同一性テストを新入口へ揃えた。旧 path を呼ぶ互換 shim は置かない。

repo 外で旧 helper を直接呼ぶ手順は、新しい payload の導入後に次の形へ更新する。`skill_dir` はロードした skill 自身から解決し、導入元・版・payload の照合は既存の [検証・受入手順](verification.md) に従う。

```sh
"$skill_dir/scripts/check-architecture-report" "$report"
```

導入済みの固定版 plugin は、その版の旧入口と手順を引き続き持つ。新しい版への更新・skill の再読込と外部の直接呼び出し手順の更新は配布先で行う。今回の変更では repo 外の設定・flake・導入済み plugin を更新しない。
