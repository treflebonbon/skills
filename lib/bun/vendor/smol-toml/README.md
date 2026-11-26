# smol-toml 1.9.1

npm の `smol-toml@1.9.1` から parser が参照する `dist/*.js` と BSD-3-Clause の `LICENSE` を同梱しています。npm tarball の integrity は `sha512-j7WyPdf0CJoutMzMoPLF/bVXHtKZIT9Rb4eGeEbWw8X2t5oirjPgpL+OpaENZrILYaXqYwnVH+qgUwVbl+pUJQ==` です。 [配布元](https://www.npmjs.com/package/smol-toml/v/1.9.1)

raw 入力登録は Python 3.14 の TOML 1.0 と比較します。`parse.js`・`struct.js`・`primitive.js`・`extract.js` では、旧 reader の BOM、文字列エスケープ、inline table と時刻の構文、およびキーの入力順を再現しています。整数は BigInt、浮動小数点数は number として受け取り、埋め込み TOML は旧版と同じ writer で出力します。
