#!/usr/bin/env bats

@test "domain-modeling-studio TypeScript evidence preserves source and records source-only fallback" {
  local project_root criteria
  project_root="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  criteria="$project_root/skills/domain-modeling-studio/references/typescript-evidence.md"

  run python3 "$project_root/tests/helpers/rop-typescript-evidence.py" \
    "$project_root/skills/domain-modeling-studio/scripts/extract-typescript.py"
  [ "$status" -eq 0 ]
  grep -Fq 'Continue source reading' "$criteria"
  grep -Fq 'Other extensions remain source-only' "$criteria"
}
