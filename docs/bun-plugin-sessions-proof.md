# plugin 導入 smoke と session 証跡の Bun 移行

[#49](https://github.com/treflebonbon/skills/issues/49) は公式 CLI 導入 smoke と session の `run/check` を Bun へ移す。静的な package 契約と他領域の Python fixture は後続の #50、最後の Python 非依存検査は #51 に残す。

## 入口と依存

公開名 `npm run test:plugin-cli` と `npm run test:plugin-sessions -- ...`、`run/check` の引数と証跡形式を保つ。

- `test:plugin-cli` は `development/plugin-cli.test.ts` の4検査を明示的に実行する。Bun 1.4.4+ と3つの公式 CLI を要求し、不足を skip にしない。公式導入は検査ごとの隔離 HOME に限定し、配布元の全 skill、共用 CLI と payload の不変性を確認する。Bats があれば導入物に対する既存 CLI suite も実行する。混在期間の Bats が必要とする各 CLI の依存は残る。
- `test:plugin-sessions` は Bash の `development/plugin-sessions` から共用 runner 経由で `development/plugin_sessions.ts` を実行する。`check` は保存済み case だけを読み、native CLI・実モデル・導入済みファイルを参照しない。`run` は従来どおり明示的に native CLI と実モデルを呼び、既存の通常認証を使う。

session helper 自体は Python、Node.js、compiler、native cache を要求しない。npm の利用と各外部 CLI の導入要件は別である。共用 runner は ambient 設定・dotenv・preload・auto-install と payload 内 cache を無効にする。session helper は plugin の自動導入を行わない。

旧 `development/plugin_sessions.py` と `tests/test_plugin_sessions.py`、共有 Python test の `OfficialPluginTest` を同じ変更で撤去した。旧 Python path の shim は配布しない。既存 JSON codec と Unicode decimal 表を使い、新規 native helper は追加しない。

## 旧実装の固定と比較

比較元は `eefd6c355dbef2c1408b38e6a043a15b249f5f18`。旧 `development/plugin_sessions.py` の SHA-256 は `dd8eff730f76fe55a4fd1f35fe18e1b1896269c9717337e7a7080f29d15bd077`。WSL2 / Linux x86_64、Python 3.14.7 で採取した。

移行前に既存 session テスト26件から77回の CLI 呼出しを観測し、型・Unicode・shell・JSON の境界27回を加えた104ケースを固定した。fake 公式 CLI による旧導入 smoke 4件も成功し、9回の native 呼出しを記録した。元 source と専用テストの hash を、採取後に照合している。

移行中に、不正な read event の型5件、version・inventory・session の段階別失敗や不正 ID など14件を同じ不変の旧 source で追加測定した。最終的な [`plugin-sessions-python.json`](../tests/fixtures/plugin-sessions-python.json) は `check` 101件と `run` 22件の123ケースを持つ。入力・出力の bytes、stdout hash、終了状態、証跡の mode、native argv / cwd / 応答を保存している。[`plugin-smoke-python.json`](../tests/fixtures/plugin-smoke-python.json) は導入 smoke の native 呼出しを保持する。新実装の出力から期待値を作っていない。

`check` は旧 stdout / stderr をそのまま比較し、入力ファイルを変更しないことも確認する。`run` は source root・一時 directory・確認用 client の配置だけを新しい実行場所へ置換し、stdout / stderr、全保存ファイルの bytes / mode と呼出し順を比較する。旧 bytes と stdout hash は原本のまま保持する。help は内部入口の basename 変更だけを正規化する。

## 確認する契約

- 正式名、確認済み installed root、対象 marketplace に限定した inventory、新規 session ID、対応する成功 tool result、同じ skill directory 内の資源読込を要求する。別 root、resume、自己申告、失敗・途中切れ・不正型の event を成功にしない。
- Codex の shell command は評価せずに字句解析する。単独の literal `cat` だけを読込証拠とし、連結・展開・改行を拒否する。引用された空白・句読点と既存の shell envelope は保持する。
- 保存済み case の再判定で native CLI を呼ばない。installed path は filesystem に問い合わせず字句正規化し、case directory 自体の symlink / `..` は kernel の open と同じ対象を読む。
- 欠けた CLI と inventory 失敗を未確認として全 case に残し、実行失敗と未確認を区別する。重複選択を除き、既定の3 runtime × 12 skill を維持する。複数 case の session ID 再利用も検出する。
- version / inventory の30秒上限、session の既定240秒と `--timeout`、timeout 後の TERM → 最大5秒 → KILL を保つ。stdout と stderr を分け、起動失敗127・timeout124・子の signal 終了を記録する。
- CLI 検索は `shutil.which` と同じ PATH 表記を返す。相対 PATH の記録と、case cwd へ切り替えた後の inventory 失敗も旧 Python と対照し、Bun の絶対化によって成功・失敗や command の記録を変えない。
- directory 作成の指定0700と既存 umask を保ち、保存ファイルは umask によらず0600に固定する。既存出力の上書きと symlink 経由の payload 内出力を拒否する。

`plugin-session-process.test.ts` は、親だけの終了では同じ fixture の孫が残る対照を置き、timeout と SIGINT で SIGTERM を無視する孫まで回収することを確認する。同じ検査を固定した旧 Python でも実行した。SIGINT の終了 signal と残す証跡を比較し、言語固有の console traceback は一致対象にしない。

読み取り専用 payload、空白を含む配置パス、Python / Node / compiler のない PATH、poison した cwd / HOME / 環境変数でも公開入口を検査する。payload と入力の未変更、preload と native cache の未生成を確認する。導入 smoke の fake は native argv・隔離 HOME・環境の限定を照合し、必要 CLI の欠落と配布元改変の拒否を成功対照と組み合わせる。

## 外部の呼出し元と切替

repo 内の README、検証手順、npm 入口と shell 検査を更新した。調査した dotfiles の `docs/`・`scripts/`・`tests/` と `~/runtime/` には、旧 Python path や旧 unittest class の直接呼出しは見つからなかった。この調査外の caller の有無は未確認。

npm の公開名・引数は維持する。別環境に `python3 -I development/plugin_sessions.py` の直接呼出しがあれば、`development/plugin-sessions` の直接実行または `npm run test:plugin-sessions -- ...` へ更新する。旧 `tests.test_plugin.OfficialPluginTest` の直接実行は `npm run test:plugin-cli` へ更新する。配布側は通常の受入で固定 source / version / hash と Bun 1.4.4+ を揃える。外部の caller・導入済み payload・共有設定は本変更では更新しない。

## 未確認の範囲

ローカルの比較は WSL2 / Linux x86_64、Bun 1.4.4 で行った。fake による導入検査は公式 CLI の実導入ではなく、実モデル・通常認証・実 browser・App / IDE・Nix / raw isolation の受入も実行していない。macOS aarch64 / Linux aarch64 は既存 CI matrix の当該 checkout で別に確認する。skip と runner の定義を成功の証拠に数えない。
