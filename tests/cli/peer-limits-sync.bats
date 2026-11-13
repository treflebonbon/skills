#!/usr/bin/env bats

# The contract table is the norm; peer-request.sh duplicates its limits as
# constants. Compare only the two (not wording elsewhere), failing closed when
# a row or constant is missing, duplicated, or not a plain integer.

@test "peer limits in the contract table match peer-request.sh constants" {
  run node - "$BATS_TEST_DIRNAME/../.." <<'JS'
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.argv[2];
const contract = fs.readFileSync(path.join(root, 'contracts/autonomous-peer-contract.md'), 'utf8');
const script = fs.readFileSync(path.join(root, 'skills/herdr-peer-refactor/scripts/peer-request.sh'), 'utf8');
function one(items, label) { assert.equal(items.length, 1, `${label}: ${items.length}件あります`); return items[0]; }
const cells = line => line.trim().split('|').map(c => c.trim());
const lines = contract.split('\n');
const head = one(lines.flatMap((line, i) => JSON.stringify(cells(line)) === '["","上限","値",""]' ? [i] : []), 'limits table');
const rows = [];
for (const line of lines.slice(head + 2)) {
  if (!line.trimStart().startsWith('|')) break;
  const row = cells(line); assert.equal(row.length, 4, `limits table: 不正な行 ${line}`);
  rows.push([row[1].replace(/\s+/g, ''), row[2]]);
}
for (const [label, name, units] of [
  ['peer1回の待機', 'PEER_TIMEOUT_S', {分: 60n, 時間: 3600n}],
  ['1候補の累積待機', 'TOTAL_WAIT_S', {分: 60n, 時間: 3600n}],
  ['ReviewRound', 'MAX_ROUNDS', {回: 1n}],
]) {
  const value = one(rows.filter(([key]) => key === label).map(([, value]) => value), label);
  const match = new RegExp('^(\\d+)\\s*(' + Object.keys(units).join('|') + ')$').exec(value);
  assert(match, `${label}: 不正な値 ${value}`);
  // 条件付きの重複宣言と、Bash が8進数として読む先頭0も拒否する。
  const literal = one([...script.matchAll(new RegExp('^[ \\t]*' + name + '=(.*)$', 'gm'))].map(m => m[1]), name);
  assert.match(literal, /^[1-9]\d*$/, `${name}: 10進整数の literal が必要です`);
  assert.equal(BigInt(match[1]) * units[match[2]], BigInt(literal), `${label}: 契約と定数が不一致です`);
}
JS
  echo "$output"
  [ "$status" -eq 0 ]
}
