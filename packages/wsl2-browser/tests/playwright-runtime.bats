#!/usr/bin/env bats

@test "Playwright runtime keeps locks and fails closed across records and process failures" {
  run node --test "$BATS_TEST_DIRNAME/fixtures/playwright-runtime.test.mjs"
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
}
