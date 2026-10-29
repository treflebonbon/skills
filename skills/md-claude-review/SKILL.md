---
name: md-claude-review
description: CLAUDE.md のレビュー、監査、短縮、再編、progressive disclosure を依頼されたときに使う。humanlayer の best practices と Claude Code 公式ガイドに照らして確認する。AGENTS.md は md-agents-review に渡し、編集はユーザーの確認後、commit はユーザーに委ねる。
metadata:
  topics: claude-md, audit, progressive-disclosure, review
  source: treflebonbon/dotfiles
---

# CLAUDE.md レビュー

この skill は CLAUDE.md と Claude Code 向けの repository-local 指示を対象にする。AGENTS.md、Codex rules、Codex 向け指示は [md-agents-review](../md-agents-review/SKILL.md) に渡す。

## 手順

1. 対象 repository の CLAUDE.md を読み、[判定基準](references/criteria.md) を確認する。skill の資源はこの `SKILL.md` のディレクトリから読む。起点を特定できない場合は推測せず、理由を案内してレビューを保留する。
2. 判定基準に従い、前文ブロックと各 `## ` セクションへ **Keep / Trim / Reword / Move-to / Delete** のうち 1 つずつ割り当て、根拠となる行を示す。`Move-to` の候補は対象 repository に実在する場所から選び、提示前に確認する。適切な移動先がなければ `Delete` を示し、新規作成を提案するときはその旨を明記する。
3. Reword のモデル固有判定では、利用できる場合に外部 `claude-api` skill を `prompt-audit` 引数付きで呼び出す。この skill が利用できない、または呼び出しに失敗した場合は、判定基準にある公式文書の最新化手順を実行する。どの経路を使ったかと未確認範囲を結果に記す。
4. 判定を重大度順にまとめ、対象モデルとモデル固有判定の経路を表の前に示す。変更不要なら全て Keep と明記する。変更案を提示してユーザーの確認を待つ。
5. ユーザーが確認した変更だけを適用し、差分を確認する。skill package 内の判定基準は実行時に編集せず、更新が必要なら根拠と変更案を報告して保守者へ委ねる。変更を commit せず、結果を報告する。
