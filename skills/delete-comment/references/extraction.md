# コメント抽出の手順

Git リポジトリのルートから、対象パスをリポジトリ相対のリテラルとして絞る。次は指定のコミット参照 `ref`（未指定なら HEAD）を固定し、ファイル名と blob ID を調べる例。

```sh
revision=$(git rev-parse --verify --end-of-options "${ref:-HEAD}^{commit}")
git --literal-pathspecs ls-tree -r -z --full-tree "$revision" -- "${scope:-.}"
```

列挙結果から通常ファイル（mode `100644` または `100755`）の blob ID を使う。ディレクトリ直下だけが対象なら、ディレクトリ名を除いた相対名に `/` が含まれないファイルを選ぶ。文字列用の glob では `*` が `/` にも一致する場合がある。

インストール済みの `ast-grep` を使う TypeScript の例。ファイル名は最初の列挙結果と対応付ける。`.ts` には `TypeScript`、`.tsx` には `Tsx` を選ぶ。別言語では対応する grammar とコメントのノード種別を確認する。

```sh
git cat-file blob "$blob" | ast-grep scan --stdin --json=stream --inline-rules '
id: comment-inventory
language: TypeScript
severity: hint
rule:
  kind: comment
'
```

結果の行番号は 0 始まりなので、表示用に 1 を足す。

コメント抽出の後、同じ blob を対応する grammar で構文診断する。Tree-sitter のルートノードの `hasError`（Python では `has_error`）で、`ERROR` ノードとパーサーが挿入した欠落トークンの両方を検出できる。

Python の `tree-sitter-language-pack` が利用できる場合の例。末尾の引数は `.ts` なら `typescript`、`.tsx` なら `tsx` を使う。

```sh
python3 - "$blob" typescript <<'PY'
import subprocess
import sys
from tree_sitter_language_pack import get_parser

blob, grammar = sys.argv[1:]
source = subprocess.check_output(["git", "cat-file", "blob", blob])
tree = get_parser(grammar).parse(source)
print(tree.root_node.has_error)
PY
```

構文エラーが見つかったファイルや診断できなかったファイルは、検出済み件数（0 件を含む）と未確認範囲を示し、ファイル全体の件数は未確定とする。

`ast-grep-ignore` のあるファイルは走査結果からコメントが欠けることがあるため、別の構文解析器で補うか、集計の未確認範囲として示す。
