# Bun 起動と orca-send の移行記録

Issue [#30](https://github.com/treflebonbon/skills/issues/30) では、`bin/orca-send` を最初の Bun CLI として移行する。採用方式は、startup file を読まない Bash 入口から、runtime 環境変数を除去し、package 内の bunfig / tsconfig と install・dotenv・macro を無効にする明示フラグを渡す方式である。呼出し先の cwd と通常の環境は保持する。詳細は[共用 CLI](shared-cli.md#bun-cli-の起動)を参照する。

## 比較データ

移行直前の Python 版は `fd2a50c558288b3661e5066b94b1196453ef9269:bin/orca-send` である。合成本文と fake Orca CLI で取得した17ケースの入力・stdout・stderr・終了状態・native argv を [`tests/fixtures/orca-send-python.json`](../tests/fixtures/orca-send-python.json) に保存した。長い本文は repeat/count/suffix で表し、native argv 中の本文は `{{body}}` に正規化した。実ユーザーの本文や認証値は含まない。

`npm run test:bun` はその固定データを Bun 版へ入力して比較する。8 KiB の上下、CRLF、UTF-8、BOM、Python の空白集合、NUL、不正 UTF-8、重複 body 引数、子 CLI の通常終了・signal 終了を含む。signal の終了状態も Python の `sys.exit(負の returncode)` に合わせる（SIGTERM は241）。

後続の各移行は、変更直前の source SHA・入口・合成入力と期待結果をその機能の fixture として保存する。比較記録には実行コマンド、OS/architecture、runtime の版、成功・拒否・未確認範囲を記す。巨大な raw log と実機の受入記録は既存の[検証記録の入口](verification.md)に従って package 外へ置く。共通 corpus framework は追加しない。

## 起動実証

Bun 1.4.4 / Linux x86_64 で、`tests/bun/orca-send.test.ts` の公開 CLI テストを実行する。

- Python のない PATH で送信でき、選択した fake CLI に本文と native argv がそのまま届く。
- 合成 cwd の bunfig・dotenv・tsconfig・package.json、HOME と XDG の global bunfig、環境の BUN_OPTIONS・NODE_OPTIONS・NODE_PATH・BASH_ENV を配置する。対照の無保護な Bun 起動では preload の marker と loopback HTTP request を検出し、公開入口ではいずれも起きず、正常送信が成功する。
- 不足する bare import は auto-install の代わりに明示的なエラーで拒否する。合成 registry への通信は0件で、正常な CLI の成功例と対比する。
- 空白を含む配置先、入口自身と親 directory の symlink を使う。実行前後で配布する bin/lib のファイル集合・mode・symlink・SHA-256 を照合し、cache・lock・node_modules などを追加しないことを検査する。
- 子 CLI の cwd、HOME、XDG_CONFIG_HOME と合成の公開環境値が保持されることを検査する。

Bun の[設定](https://bun.com/docs/runtime/bunfig)、[環境変数](https://bun.com/docs/runtime/environment-variables)、[auto-install](https://bun.com/docs/runtime/auto-install)を参照し、実物の Bun で上記の境界を確認する。起動フラグは `--config=絶対パス` のように値を連結して渡し、Bun にフラグとして解釈させる。

この先行実証の採用方式は Linux x86_64 で確認した。macOS ARM64 の継続検査は後続の #31、namespace・process/lock・Nix の互換性は別の実証 ticket が担当する。Bun 1.4.4 を移行全体の確定下限とする判断は、それらの結果を待つ。通常 CI は fake CLI と loopback のみを使い、実モデルを呼ばない。

## 呼び出し元と配布

公開入口 `bin/orca-send` と引数は維持し、Python で入口ファイルを直接解釈する方法は使わない。repo 内の Orca 手順を Bash の直接実行へ更新した。repo 外では dotfiles の `private_dot_local/bin/executable_orca-send.tmpl` と配備先 `~/.local/bin/orca-send` が独立した旧実装を持つため、別の更新が必要である。外部 source は本変更では更新しない。利用者は導入先 payload と Bun 1.4.4 以上を揃え、公開入口を直接実行する。
