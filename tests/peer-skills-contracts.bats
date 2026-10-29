#!/usr/bin/env bats

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  HERDR="$PROJECT_ROOT/skills/herdr-peer-refactor"
  ORCA="$PROJECT_ROOT/skills/orca-peer-refactor"
  CONTRACT="$PROJECT_ROOT/contracts/autonomous-peer-contract.md"
}

@test "Herdr and Orca keep shared helpers, evidence, and workflow sections aligned" {
  local script section
  for script in run-evidence.py candidate-record.py check-owned.sh gh-once.sh check-architecture-report.py check-architecture-render.js; do
    cmp "$HERDR/scripts/$script" "$ORCA/scripts/$script"
  done
  cmp "$HERDR/references/evidence.md" "$ORCA/references/evidence.md"
  for section in '1\. 元の候補を固定' '3\. peer と設計' '4\. 実装と検証' '5\. 独立レビュー' '6\. PR と報告'; do
    cmp <(sed -n "/^## $section/,/^## [0-9]\\./p" "$HERDR/SKILL.md") \
      <(sed -n "/^## $section/,/^## [0-9]\\./p" "$ORCA/SKILL.md")
  done
}

@test "both peer skills are normally invocable and expose the six workflow steps" {
  local name skill front
  for name in herdr orca; do
    skill="$PROJECT_ROOT/skills/$name-peer-refactor/SKILL.md"
    front="$(awk 'NR>1 && /^---$/{exit} NR>1' "$skill")"
    run grep -Fq 'disable-model-invocation' <<<"$front"
    [ "$status" -eq 1 ]
    grep -Fq 'description:' <<<"$front"
    for heading in \
      '^## 1\. 元の候補を固定' \
      '^## 2\. worktree と担当' \
      '^## 3\. peer と設計' \
      '^## 4\. 実装と検証' \
      '^## 5\. 独立レビュー' \
      '^## 6\. PR と報告'; do
      grep -Eq "$heading" "$skill"
    done
    grep -Fq "references/$name.md" "$skill"
    [ -f "$PROJECT_ROOT/skills/$name-peer-refactor/references/$name.md" ]
  done
  [ -f "$HERDR/references/auto-session.md" ]
}

@test "both peer skills pin the presented candidate and verify it before design and publication" {
  local name skill candidates design pin_line check_line design_line
  for name in herdr orca; do
    skill="$PROJECT_ROOT/skills/$name-peer-refactor/SKILL.md"
    candidates="$(sed -n '/^## 1\. 元の候補を固定/,/^## 2\./p' "$skill")"
    design="$(sed -n '/^## 3\. peer と設計/,/^## 4\./p' "$skill")"
    printf '%s\n' "$candidates" | grep -Fq 'candidate-record.py pin'
    printf '%s\n' "$candidates" | grep -Fq '提示済み artifact'
    for field in artifact repo 'source SHA' acceptance non_goals owned_files; do
      grep -Fq "$field" "$skill"
    done
    printf '%s\n' "$candidates" | grep -Fq '`check` は設計前、再開時、公開前'
    printf '%s\n' "$candidates" | grep -Fq '人が選んだ候補'
    printf '%s\n' "$candidates" | grep -Fq '未選択なら'
    printf '%s\n' "$design" | grep -Fq '根拠'
    pin_line="$(grep -n 'candidate-record.py pin' "$skill" | head -1 | cut -d: -f1)"
    check_line="$(grep -n '`check` は設計前、再開時、公開前' "$skill" | cut -d: -f1)"
    design_line="$(grep -n '^## 3\. peer と設計' "$skill" | cut -d: -f1)"
    [ -n "$pin_line" ] && [ -n "$check_line" ]
    [ "$pin_line" -lt "$design_line" ]
    [ "$check_line" -lt "$design_line" ]
  done
}

@test "peer design uses evidence and model-independent decisions" {
  local name skill peer
  for name in herdr orca; do
    skill="$PROJECT_ROOT/skills/$name-peer-refactor/SKILL.md"
    peer="$(sed -n '/^## 3\. peer と設計/,/^## 4\./p' "$skill")"
    run grep -Fq 'same model' <<<"$peer"
    [ "$status" -eq 1 ]
    run grep -Fq '同一モデル' <<<"$peer"
    [ "$status" -eq 1 ]
    printf '%s\n' "$peer" | grep -Fq 'Held Candidate'
    printf '%s\n' "$peer" | grep -Fq 'Peer Decision'
    printf '%s\n' "$peer" | grep -Fq '反例または peer 自身の検証'
    printf '%s\n' "$peer" | grep -Fq '新しい ADR'
  done
}

@test "implementation, independent final-SHA review, and safe publication stay ordered" {
  local name skill implementation review publication
  for name in herdr orca; do
    skill="$PROJECT_ROOT/skills/$name-peer-refactor/SKILL.md"
    implementation="$(sed -n '/^## 4\. 実装と検証/,/^## 5\./p' "$skill")"
    review="$(sed -n '/^## 5\. 独立レビュー/,/^## 6\./p' "$skill")"
    publication="$(sed -n '/^## 6\. PR と報告/,$p' "$skill")"
    printf '%s\n' "$implementation" | grep -Fq '最小の変更'
    printf '%s\n' "$implementation" | grep -Fq 'base を固定'
    printf '%s\n' "$implementation" | grep -Fq 'repo の必要な全チェック'
    printf '%s\n' "$implementation" | grep -Fq '再検証'
    printf '%s\n' "$review" | grep -Fq 'Standards'
    printf '%s\n' "$review" | grep -Fq 'Spec'
    printf '%s\n' "$review" | grep -Fq '最終 SHA'
    printf '%s\n' "$publication" | grep -Fq 'git-push-topic'
    printf '%s\n' "$publication" | grep -Fq 'gh pr view'
    printf '%s\n' "$publication" | grep -Fq 'state'
    printf '%s\n' "$publication" | grep -Fq 'head'
    printf '%s\n' "$publication" | grep -Fq 'merge と issue の直接 close は行わない'
    grep -Fq 'grilling' "$skill"
    printf '%s\n' "$publication" | grep -Fq 'issue がある場合だけ `Closes #N`'
  done
}

@test "issue creation is optional and external writes stay within approval" {
  local name skill design publication
  for name in herdr orca; do
    skill="$PROJECT_ROOT/skills/$name-peer-refactor/SKILL.md"
    design="$(sed -n '/^## 3\. peer と設計/,/^## 4\./p' "$skill")"
    publication="$(sed -n '/^## 6\. PR と報告/,$p' "$skill")"
    printf '%s\n' "$design" | grep -Fq 'issue は任意'
    printf '%s\n' "$design" | grep -Fq '承認済みの場合だけ'
    printf '%s\n' "$design" | grep -Fq '小さな候補は設計記録から直接実装'
    printf '%s\n' "$publication" | grep -Fq '外部書込みは依頼の承認範囲に限り'
    printf '%s\n' "$publication" | grep -Fq 'issue がある場合だけ'
  done
}

@test "dedicated auto guidance names its assets and keeps normal peer work separate" {
  local skill="$HERDR/SKILL.md"
  local auto="$HERDR/references/auto-session.md"
  local protection="$PROJECT_ROOT/contracts/auto-peer-protection.md"
  grep -Fq 'references/auto-session.md' "$skill"
  grep -Fq '通常 session の明示 peer 協働は専用 auto の資格情報や preflight を要求しない' "$skill"
  for asset in auto-peer.rules auto-peer-deny.json claude-peer.settings.json codex-peer.config.toml; do
    grep -Fq "$asset" "$auto"
  done
  for helper in auto-peer-preflight.py launch-child.sh codex-auto-peer.sh; do
    grep -Fq "$helper" "$protection"
  done
  grep -Fq 'preflight が失敗したとき、通常 session や別 profile へ自動で切り替えない' "$protection"
}

@test "reports and idempotent GitHub writes remain part of both peer workflows" {
  local name skill publication
  for name in herdr orca; do
    skill="$PROJECT_ROOT/skills/$name-peer-refactor/SKILL.md"
    publication="$(sed -n '/^## 6\. PR と報告/,$p' "$skill")"
    printf '%s\n' "$publication" | grep -Fq '承認範囲'
    printf '%s\n' "$publication" | grep -Fq 'gh-once.sh'
    printf '%s\n' "$publication" | grep -Fq 'gh pr view --json state,headRefOid,isDraft'
    [ -x "$PROJECT_ROOT/skills/$name-peer-refactor/scripts/gh-once.sh" ]
  done
}

@test "all shell helpers shipped by the peer skills stay executable" {
  local name script
  for name in herdr orca; do
    while IFS= read -r script; do
      [ -x "$script" ] || { echo "not executable: $script" >&2; return 1; }
    done < <(find "$PROJECT_ROOT/skills/$name-peer-refactor" -path '*/scripts/*.sh')
  done
}

@test "Run Scope identifies approved external operations and excluded actions" {
  local scope
  scope="$(grep -F 'Run Scope は' "$CONTRACT")"
  printf '%s\n' "$scope" | grep -Fq 'git-push-topic'
  printf '%s\n' "$scope" | grep -Fq 'draft PR'
  printf '%s\n' "$scope" | grep -Fq 'ready 化・merge・issue の直接 close・force push・secret は承認に含めない'
}

@test "HTML candidate reports require evidence and a real render check before pinning" {
  local skill="$HERDR/SKILL.md"
  local candidate
  candidate="$(sed -n '/^## 1\. 元の候補を固定/,/^## 2\./p' "$skill")"
  printf '%s\n' "$candidate" | grep -Fq '候補がゼロなら Top recommendation は「該当候補なし」'
  printf '%s\n' "$candidate" | grep -Fq 'peer 依頼未承認で未選択なら pin しない'
  printf '%s\n' "$candidate" | grep -Fq 'peer にコード・ADR・反例から元候補を選ばせ'
  printf '%s\n' "$candidate" | grep -Fq 'favicon.ico 取得失敗以外の console error'
  printf '%s\n' "$candidate" | grep -Fq '実 browser を使えなければ HTML report は検査済みと扱わず'
  printf '%s\n' "$candidate" | grep -Fq 'packages/wsl2-browser/bin/playwright-cli" run-code'
  printf '%s\n' "$candidate" | grep -Fq "sed '\$s/;\$//'"
  printf '%s\n' "$candidate" | grep -Fq '新しい artifact として再検査・提示する'
}
