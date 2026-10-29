#!/usr/bin/env bash
# runtime-preflight.sh — capability 宣言型の skill 実行前検査。
# 使い方: runtime-preflight.sh --need <gh-read|gh-write|gh-issues|git-push|network> [--need ...]
# 失敗時は stderr に "PREFLIGHT_FAIL:<capability> <理由>" を出して exit 1。
# Codex sandbox では本 script の network 呼び出し自体が承認を入口に集約する (意図した仕様)。
set -euo pipefail

usage() {
  echo "usage: runtime-preflight.sh --need <gh-read|gh-write|gh-issues|git-push|network> [--need ...]" >&2
}

fail() {
  echo "PREFLIGHT_FAIL:$1 $2" >&2
  exit 1
}

NEEDS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
  --need)
    [[ $# -ge 2 ]] || { usage && fail usage "--need requires a value"; }
    NEEDS+=("$2")
    shift 2
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage
    fail usage "unknown argument: $1"
    ;;
  esac
done
[[ ${#NEEDS[@]} -gt 0 ]] || { usage && fail usage "no --need given"; }

for cap in "${NEEDS[@]}"; do
  case "$cap" in
  gh-read)
    gh auth status >/dev/null 2>&1 || fail gh-read "gh is not authenticated. Check: gh auth status"
    ;;
  gh-write)
    gh auth status >/dev/null 2>&1 || fail gh-write "gh is not authenticated. Check: gh auth status"
    repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) ||
      fail gh-write "cannot resolve repository via gh repo view"
    perm=$(gh api "repos/$repo" --jq .permissions.push 2>/dev/null) ||
      fail gh-write "cannot read permissions for $repo (network/approval?)"
    [[ "$perm" == "true" ]] || fail gh-write "no push permission on $repo"
    ;;
  gh-issues)
    # issue 作成は push 権限不要 (gh-write より弱い検査)。auth + repo 解決 + issues 有効のみ確認する。
    gh auth status >/dev/null 2>&1 || fail gh-issues "gh is not authenticated. Check: gh auth status"
    repo="${REPO:-}"
    if [[ -z "$repo" ]]; then
      repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) ||
        fail gh-issues "cannot resolve repository via gh repo view"
    fi
    has_issues=$(gh api "repos/$repo" --jq .has_issues 2>/dev/null) ||
      fail gh-issues "cannot read repository metadata for $repo (network/approval?)"
    [[ "$has_issues" == "true" ]] || fail gh-issues "issues are disabled on $repo"
    ;;
  git-push)
    git ls-remote --heads origin >/dev/null 2>&1 ||
      fail git-push "cannot reach origin (network/credential/approval?)"
    ;;
  network)
    gh api rate_limit >/dev/null 2>&1 ||
      fail network "GitHub API unreachable (sandbox/approval?). Approve network access and retry"
    ;;
  *)
    fail usage "unknown capability: $cap"
    ;;
  esac
done

echo "PREFLIGHT_OK: ${NEEDS[*]}"
