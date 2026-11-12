#!/usr/bin/env bats

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  ORCA_SEND="$PROJECT_ROOT/bin/orca-send"
}

# 本文・拒否・設定混入・payload 不変性は npm run test:bun で検査する。
@test "orca-send explains the literal UTF-8 body contract" {
  run "$ORCA_SEND" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"UTF-8本文ファイル"* ]]
  [[ "$output" == *"8 KiB"* ]]
  [[ "$output" == *"argv"* ]]
}

@test "orca-send rejects a missing Bun runtime before starting Orca" {
  local path="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$path"
  ln -s "$(command -v dirname)" "$path/dirname"
  run env PATH="$path" "$ORCA_SEND" --help
  [ "$status" -eq 2 ]
  [[ "$output" == *"Bun 1.4.4 以上が必要です"* ]]
}
