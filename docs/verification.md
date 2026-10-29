# 検証記録

2026-10-29。初期実装の rop、plugin version 0.1.0 を対象にした。OS は Linux x86_64。macOS aarch64・Linux aarch64・WSL2 の実機確認は未実施。

| 境界                                              | 結果                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Antigravity CLI 1.4.8 strict validation           | 成功。portable manifest と rop 1件を検出                                                                            |
| Claude Code 2.1.312 公式ローカル marketplace 導入 | 一時 HOME/XDG で成功。skill inventory に rop を検出                                                                 |
| Codex 0.165.0 公式ローカル marketplace 導入       | 一時 HOME/XDG で成功。導入済みの Rust reference の内容が配布元と一致                                                |
| Antigravity CLI 1.4.8 公式ローカル plugin 導入    | 一時 HOME/XDG で成功。enabled、version 0.1.0、skill rop を検出                                                      |
| Claude Code 新規セッションの呼出し                | 成功。公式名による呼出しで Rust reference に基づく応答を確認。permission denial なし                                |
| Codex 新規セッションの呼出し                      | 成功。導入 cache 内の SKILL.md と Rust reference を読んだ command の exit 0 と応答を確認                            |
| Antigravity CLI 新規セッションの呼出し            | 成功。既存認証と隔離 workspace で `/rop` を呼び出し、導入済みの SKILL.md と Rust reference の読取り完了と応答を確認 |
| Antigravity App/IDE                               | 未確認。公式の surface 別手順を README から案内                                                                     |

認証付きセッションは既存の認証を CLI から参照した。資格情報の実値を直接取得・複製・出力していない。

Antigravity の公式導入テストは一時 HOME/XDG で実行した。実セッションは通常の HOME/XDG とログイン済みの認証を使い、隔離 workspace の `.agents/plugins/treflebonbon-skills` から、その公式導入済み plugin を参照した。`/rop` の実行記録で、同じ plugin 配下の `skills/rop/SKILL.md` と `skills/rop/references/rust.md` に対する `read_file` の `DONE`、最終結果の `SUCCESS` を確認した。rop の全5ファイルが配布元と一致し、旧配備先の skill を読んでいないことも照合した。通常環境の plugin 登録や認証設定は変更していない。

当初の未認証エラーは、認証のない一時 HOME で実セッションを起動したために生じた。通常環境はログイン済みで応答でき、追加ログインは不要だった。

実行の公開証跡は作業環境の `/tmp/codex/skills-implementation.9Q3WhO/` と `/tmp/codex/agy-auth-diagnosis.fwYLk7/` に保持している。これは永続的な配布資産ではない。実際の push・merge・外部コメント投稿・利用者データの削除は検証の副作用にしていない。

Issue #529 の3 CLI における導入・新規セッションの呼出し・資源解決を確認した。残り10件を含む配布版の受入は後続の Issue #540 で改めて行う。
