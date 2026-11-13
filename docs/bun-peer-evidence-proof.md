# candidate と公開証跡の Bun 移行

[#38](https://github.com/treflebonbon/skills/issues/38) は、両 peer の candidate pin/check と公開証跡 probe/checkpoint/restore を同時に切り替える。[#32 の採用済み6操作](bun-file-safety-proof.md)と [#36 の artifact text 抽出](html-report-parser-proof.md)を引き継ぐ。

## 入口と準備

両 peer の `scripts/candidate-record` と `scripts/run-evidence` は Bash から共用 Bun runner を起動する。引数と終了コード、version 1 の保存形式を維持する。旧 `.py` 入口と Python import は撤去し、shim は置かない。

通常の実行には Bash、Git、Bun 1.4.4 以上と準備済み Node-API module が必要。準備時だけ、導入済み Node.js とその実行ファイルに対応する `include/node/node_api.h`、`cc` を使う。自動 download、npm install、node-gyp は使わない。

```bash
"$plugin_root/bin/prepare-file-safety"
```

既定の生成先は `${XDG_CACHE_HOME:-$HOME/.cache}/treflebonbon-skills/file-safety/<C source hash>-<platform>-<arch>/`。別の保存先を使う場合は、準備時と実行時の両方で、同じ絶対パスを `TREFLEBONBON_FILE_SAFETY_DIR` に指定する。保存先は実 owner の private directory、祖先は root または実 owner の所有で他 owner に書込みを許さない directory に限る。system の sticky `/tmp` と、その上の macOS の system alias は許容する。payload 内への生成は拒否する。

準備コマンドは `.node` と `build.json` を排他的に公開する。source / binary hash、Bun・Node.js・compiler の版、header、compile argv、OS / architecture を記録する。既存成果物を上書きせず、存在する場合も検査してから再利用する。不完全な準備や競合は失敗として保持し、他の writer の成果を自動で削除・修復しない。

実行時には directory の保護、module と記録の通常ファイル・owner・mode・link 数、source / binary hash、OS / architecture を照合する。検査した module の file FD を `process.dlopen` に渡し、別の path に差し替えられた binary を読み直さない。module 不足・不一致時は明示的な準備を案内して失敗し、自動 build しない。対応範囲は #32 で採用した Linux x64 / arm64、macOS arm64。

## 旧 bytes と比較元

[比較 corpus](../tests/fixtures/peer-evidence-python.json)は、移植前の source `0c61435fa7ebf585789f851cf046efbe9e4ec2a1` の Python helper を実行して採取した。生成した空 Git commit、元 artifact、候補、record、実 probe receipt、待機台帳、checkpoint の bytes を保存し、各ファイルに SHA-256 を付けた。helper の hash と Python の版も記録している。新実装から期待値を作り直していない。

テストは元の絶対パスと Git commit を再現する。既存 directory があれば排他的な作成に失敗し、その中を削除しない。旧 record の fingerprint・artifact hash・repo common dir・source commit を検査し、旧 checkpoint から receipt と待機台帳を含む全ファイルを元 bytes に復元する。同じ入力で再 checkpoint した hash も旧値と照合する。receipt 内の旧 command は履歴として保持し、復旧中に実行しない。

新しい probe は、実際に起動した同じ skill の `candidate-record check` の argv を保存する。nonce・fingerprint・実 HEAD・cwd・終了状態を記録し、checker の30秒 timeout は kill 後に124として保存する。元資料の本文と checker の生出力は receipt に含めない。

候補の JSON は、大きな整数を BigInt として比較・保存し、非有限値を `null` に置換しない。float は旧 Python と同じ IEEE 754 として扱い、整数との比較で丸めを許さない。元 bytes の hash を JSON の再 serialize で代用しない。文字列の空白集合と title の casefold は旧 Python の Unicode 16.0.0 を引き継ぐ。固定 casefold table は移植前の Python `str.casefold()` から生成し、[Unicode license](../lib/bun/vendor/peer-casefold.LICENSE)を同梱する。

## ファイル操作と検証

production の [C helper](../lib/bun/file-safety-native.c)は、採用済み [実証用 source](../tests/fixtures/bun-file-safety-native.c)と同じ6操作で、C source の SHA-256 は `e6143d1f0b81216ab2cfce4febb6a000c3d969746fe05f32142b933f165029c2`。directory FD を保持し、ancestor と leaf の no-follow、通常ファイル、排他的作成を確認する。公開証跡の hard link は引き続き読める。raw 入力専用の link 数1制限は証跡へ追加しない。

checkpoint は書込みと fsync を終えた一時ファイルから link で公開し、同じ内容の同時保存は既存 bytes と照合する。restore は全入力と既存内容を先に検査する。失敗時には保持 directory FD と BigInt の device / inode を使って、自分の作成分だけを戻す。別 writer のファイル、symlink、directory は残す。検査と unlink/link は別 syscall であり、任意の非協調 writer に対する原子的な CAS を保証するものではない。

[CLI テスト](../tests/bun/peer-evidence.test.ts)は旧 corpus、整数・Unicode、record 読込み後の置換、chmod・部分 write・close・後続ファイルの失敗、競合と置換先の保持を検査する。native cache の欠落・改変・symlink・mode・環境不一致を拒否し、自動修復しないことも確認する。Python・compiler・node_modules を PATH と payload に持たない実行で、read-only payload の前後の bytes / mode と preload の不実行を照合する。既存 Bats の provenance・FIFO・timeout・機密名・復旧検査も維持する。HTML parser の75入力は #36 の suite を引き継ぐ。

ローカルの対象検査は Linux x64 / WSL2、Bun 1.4.4 で実行する。全体 suite とレビューの結果は実装の検証記録に残す。#32 の3環境の実証は採用方式の根拠であり、この production loader の macOS arm64 / Linux arm64 の実行結果とは区別する。後者は、この変更の CI 実行まで未確認。

## repo 外で必要な更新

今回確認した外部参照は次のとおり。外部 repo、固定 pin、導入済み cache、runtime 設定は変更していない。

- `treflebonbon/dotfiles/docs/adr/0075-adopt-peer-refactor-skills.md` は `candidate-record.py` の同一性に言及する。採用更新時に、新しい wrapper と `.ts` の同一性検査への参照を揃える。
- `~/.config/nix-devshell/skills-plugin.json` の観測 pin は `fd2a50c558288b3661e5066b94b1196453ef9269` / `0.2.10`。`~/runtime/autonomous-peer-contract.md` はこの固定 source の `contracts/` と peer 手順を参照する。通常の release 受入手順で新 source を採用し、配備 source / version / hash を照合する。旧 `.py` を呼ぶ保存済み手順は、同じ引数で拡張子なしの wrapper を直接呼ぶ形に更新する。
- 導入先ごとに上の準備コマンドを明示実行し、native peer から同じ cache が読めることを既存の権限内で確認する。不足時は起動を保留し、read grant や raw 境界を拡大しない。native module の追加要件は、旧 Python の receipt を新しい readiness の成功証拠として再利用する理由にはならない。

参照した API は [Bun の Node-API](https://bun.com/docs/runtime/node-api)と [child process](https://bun.com/docs/runtime/child-process)。source build と配布上の制約は #32 の採用記録を正本とする。
