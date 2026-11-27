# コメント抽出の手順

Git リポジトリのルートから、対象パスをリポジトリ相対のリテラルとして絞る。次は指定のコミット参照 `ref`（未指定なら HEAD）を固定し、ファイル名と blob ID を調べる例。

```sh
revision=$(git rev-parse --verify --end-of-options "${ref:-HEAD}^{commit}")
git --literal-pathspecs ls-tree -r -z --full-tree "$revision" -- "${scope:-.}"
```

列挙結果から通常ファイル（mode `100644` または `100755`）の blob ID を使う。ディレクトリ直下だけが対象なら、ディレクトリ名を除いた相対名に `/` が含まれないファイルを選ぶ。文字列用の glob では `*` が `/` にも一致する場合がある。

インストール済みの `ast-grep` を使う TypeScript の例。ファイル名は最初の列挙結果と対応付ける。別言語では対応する grammar とコメントのノード種別を確認する。

```sh
git cat-file blob "$blob" | ast-grep scan --stdin --json=stream --inline-rules '
id: comment-inventory
language: TypeScript
severity: hint
rule:
  kind: comment
'
```

結果の行番号は 0 始まりなので、表示用に 1 を足す。解析の失敗と、コメントが 0 件のファイルを区別する。`ast-grep-ignore` のあるファイルは走査結果からコメントが欠けることがあるため、別の構文解析器で補うか、集計の未確認範囲として示す。
