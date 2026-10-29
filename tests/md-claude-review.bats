#!/usr/bin/env bats

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  SKILL="$PROJECT_ROOT/skills/md-claude-review/SKILL.md"
  CRITERIA="$PROJECT_ROOT/skills/md-claude-review/references/criteria.md"
}

@test "Move-to criteria require an existing path in the reviewed repository" {
  local section
  section="$(sed -n '/^## 6\./,/^## 7\./p' "$CRITERIA")"
  printf '%s\n' "$section" | grep -Fq 'レビュー対象 repository に既にある'
  printf '%s\n' "$section" | grep -Fq '候補のパスを提案する前に実在を確認する'
  printf '%s\n' "$section" | grep -Fq '適切な移動先がなければ Delete を提示する'
}

@test "the skill avoids fixing a model generation and points to current guidance" {
  ! grep -Eq 'Opus [0-9]|Sonnet [0-9]' "$SKILL"
  grep -Fq '判定基準にある公式文書の最新化手順' "$SKILL"
  grep -Fq 'https://code.claude.com/docs/en/best-practices' "$CRITERIA"
}

@test "model-specific judgments delegate to prompt-audit without fixing its bundled path" {
  grep -Fq '`claude-api` skill' "$SKILL"
  grep -Fq '`prompt-audit` 引数付き' "$SKILL"
  grep -Fq '第一手段: prompt-audit に委譲する' "$CRITERIA"
  ! grep -Eq 'bundled-skills|shared/prompt-audit' "$SKILL"
}

@test "criteria record the update procedure, sources, model provenance, and verification date" {
  grep -Fq '最新化手順' "$CRITERIA"
  grep -Fq 'https://code.claude.com/docs/en/best-practices' "$CRITERIA"
  grep -Fq '### 7b. 世代別の再テスト候補' "$CRITERIA"
  grep -Fq 'Claude API skill 同梱の model-migration ガイド' "$CRITERIA"
  grep -Eq '^最終検証: [0-9]{4}-[0-9]{2}-[0-9]{2}' "$CRITERIA"
}
