---
name: md-agents-review
description: AGENTS.md、Codex rules、Codex 向け repository-local 指示のレビュー、監査、短縮、再編、progressive disclosure を依頼されたときに使う。CLAUDE.md は md-claude-review に渡し、commit はユーザーに委ねる。
metadata:
  topics: agents-md, codex, audit, progressive-disclosure, review
  source: treflebonbon/dotfiles
---

# AGENTS.md レビュー

この skill は AGENTS.md、Codex rules、Codex 向けの repository-local 指示を対象にする。通常の Markdown、製品文書、API 文書、利用者向け文書は対象外。Claude Code 向けの指示ファイルは [md-claude-review](../md-claude-review/SKILL.md) に渡す。

## 手順

1. 対象 repository の指示文を読み、[判定基準](references/criteria.md) を確認する。skill の資源はこの `SKILL.md` のディレクトリから読む。起点を特定できない場合は推測せず、理由を案内してレビューを保留する。
2. 前文ブロックと各 `## ` セクションを判定単位にする。空でない前文も必ず含め、各単位へ **Keep / Trim / Reword / Move-to / Delete** のうち 1 つを割り当て、判定基準の行を引用する。
3. `Move-to` を提案するときは、対象 repository に実在する移動先を確認する。適切な場所がなければ `Delete` を示す。新規作成を提案するときは新規作成だと明記する。
4. 指摘を重大度順に示し、各指摘にファイル・行、具体的な変更案、検証メモを添える。変更が不要なら全て Keep と明示する。
5. 提案を確認してもらい、ユーザーが選んだ変更だけを適用する。編集後に差分を確認し、変更を commit せず結果を報告する。
