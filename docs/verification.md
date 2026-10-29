# 検証記録

2026-10-29。初期実装の rop、plugin version 0.1.0 を対象にした。OS は Linux x86_64。macOS aarch64・Linux aarch64・WSL2 の実機確認は未実施。

| 境界                                              | 結果                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Antigravity CLI 1.4.8 strict validation           | 成功。portable manifest と rop 1件を検出                                                 |
| Claude Code 2.1.312 公式ローカル marketplace 導入 | 一時 HOME/XDG で成功。skill inventory に rop を検出                                      |
| Codex 0.165.0 公式ローカル marketplace 導入       | 一時 HOME/XDG で成功。導入済みの Rust reference の内容が配布元と一致                     |
| Antigravity CLI 1.4.8 公式ローカル plugin 導入    | 一時 HOME/XDG で成功。enabled、version 0.1.0、skill rop を検出                           |
| Claude Code 新規セッションの呼出し                | 成功。公式名による呼出しで Rust reference に基づく応答を確認。permission denial なし     |
| Codex 新規セッションの呼出し                      | 成功。導入 cache 内の SKILL.md と Rust reference を読んだ command の exit 0 と応答を確認 |
| Antigravity CLI 新規セッションの呼出し            | 未完了。一時 HOME の認証が必要なため保留                                                 |
| Antigravity App/IDE                               | 未確認。公式の surface 別手順を README から案内                                          |

認証付きセッションは既存の認証を CLI から参照した。資格情報の実値を直接取得・複製・出力していない。完全な一時 HOME で認証がない場合の失敗と、認証を参照した後の確認を区別した。新規ログインは人間の操作を必要とする。

実行の公開証跡は作業環境の `/tmp/codex/skills-implementation.9Q3WhO/` に保持している。これは永続的な配布資産ではない。実際の push・merge・外部コメント投稿・利用者データの削除は検証していない。

3 CLI の実セッションが揃うまでは Issue #529 の受入を完了扱いせず、残り10件を含む配布版の受入も後続の Issue #540 で改めて行う。
