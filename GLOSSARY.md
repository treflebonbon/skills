# treflebonbon-skills

Claude Code、Codex、Antigravity CLI で使う Agent Skills を 1 つの plugin として配布する repo。ここでは、リリースの流れで使う言葉を定義する。

## Language

**release PR**:
次の版の更新と変更履歴をまとめた PR。
_Avoid_: 候補版, リリース PR

**受入**:
release PR の head で、実 CLI の導入・呼出し・資源解決を人が確認すること。
_Avoid_: 再受入, 候補版の確認

**リリース**:
受入が済んだ release PR を merge すること。
_Avoid_: 手作業の tag 付け, 公開
