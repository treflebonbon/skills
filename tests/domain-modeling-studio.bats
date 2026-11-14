#!/usr/bin/env bats

@test "domain-modeling-studio TypeScript evidence requires an output path" {
  local project_root
  project_root="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"

  run bun run --config=/dev/null --no-env-file \
    "$project_root/skills/domain-modeling-studio/scripts/extract-typescript.ts" \
    --repo-root "$BATS_TEST_TMPDIR" entry.ts
  [ "$status" -eq 2 ]
  [[ "$output" == *'--output'* ]]
}

@test "domain-modeling-studio TypeScript evidence preserves source and records source-only fallback" {
  local project_root criteria
  project_root="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  criteria="$project_root/skills/domain-modeling-studio/references/typescript-evidence.md"

  run "$project_root/lib/bun/run" test "$project_root/tests/helpers/rop-typescript-evidence.test.ts"
  [ "$status" -eq 0 ]
  grep -Fq 'Continue source reading' "$criteria"
  grep -Fq 'Other extensions remain source-only' "$criteria"
}
