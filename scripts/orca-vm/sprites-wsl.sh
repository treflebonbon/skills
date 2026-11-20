#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf '[sprites-pilot] %s\n' "$*" >&2
  exit 1
}

mode=$1
[[ ${ORCA_VM_MODE:-} == "$mode" && ${ORCA_RECIPE_ID:-} == sprites-wsl-pilot ]] ||
  fail 'Orca recipe context does not match this operation'
git_dir=$(git rev-parse --absolute-git-dir)
config="$git_dir/orca-sprites-pilot.json"
state="$git_dir/orca-sprites-pilot-state.json"
sprite_cli=${ORCA_SPRITES_PILOT_CLI:-sprite}
exec 9>"$git_dir/orca-sprites-pilot.lock"
flock -n 9 || fail 'another Sprite operation is running'

sp() { "$sprite_cli" -o "$org" "$@"; }

list_name() {
  local names
  names=$(sp list --prefix "$name") || return 2
  printf '%s\n' "$names" | grep -Fx -- "$name" >/dev/null
}

read_info() {
  local info
  info=$(sp info "$name") || return 1
  [[ $(awk -F ':[[:space:]]+' '$1 == "Labels" { print $2 }' <<<"$info") == "$name" ]] ||
    return 1
  url=$(awk -F ':[[:space:]]+' '$1 == "URL" { print $2 }' <<<"$info")
  [[ $url == "https://$name-"* && $url =~ ^https://[a-z0-9-]+\.sprites\.app$ ]]
}

destroy_sprite() {
  local status=0
  list_name || status=$?
  case "$status" in
  1)
    if [[ $create_confirmed != true ]]; then
      printf '[sprites-pilot] creation outcome could not be confirmed for %s in %s\n' "$name" "$org" >&2
      return 1
    fi
    return 0
    ;;
  0) read_info || return 1 ;;
  *) return 1 ;;
  esac
  sp destroy --force "$name" >/dev/null || return 1
  list_name && return 1
  [[ $? == 1 ]]
}

cleanup_failed_create() {
  local status=$?
  if [[ $status != 0 ]]; then
    if destroy_sprite; then
      rm -- "$state"
    else
      printf '[sprites-pilot] cleanup could not be confirmed for %s in %s\n' "$name" "$org" >&2
    fi
  fi
}

emit_result() {
  if ! jq -e --arg name "$name" --arg org "$org" '
    select(.schemaVersion == 1 and (.pairingCode | type == "string" and length > 0)
      and (.projectRoot | type == "string" and startswith("/")))
    | {schemaVersion, pairingCode, projectRoot, userData: {resourceId: $name, org: $org}}
  ' 2>/dev/null <<<"$1"; then
    fail 'invalid Orca pairing response'
  fi
}

remote() {
  local remote_script
  remote_script="$(dirname -- "${BASH_SOURCE[0]}")/sprites-remote.sh"
  sp exec -s "$name" --no-port-forward \
    --file "$remote_script:/tmp/orca-sprites-pilot.sh" \
    --env "PILOT_REF=$ref,PILOT_SHA=$sha,PILOT_URL=$url" \
    -- /bin/bash /tmp/orca-sprites-pilot.sh "$1" </dev/null
}

write_state() {
  jq -n --arg org "$org" --arg name "$name" --arg ref "$ref" --arg sha "$sha" \
    --arg instance "$instance" --argjson created "$create_confirmed" \
    '{org:$org, name:$name, ref:$ref, sha:$sha, instance:$instance, created:$created}' >"$state.tmp"
  mv -- "$state.tmp" "$state"
}

if [[ $mode == create ]]; then
  [[ -f $config ]] || fail 'pilot target is unset; configure the approved organization, ref and SHA'
  [[ ! -e $state ]] || fail 'the pilot already has an active or unconfirmed Sprite'
  org=$(jq -er '.org | strings | select(test("^[a-zA-Z0-9][a-zA-Z0-9_-]*$"))' "$config")
  ref=$(jq -er '.ref | strings | select(test("^refs/heads/[A-Za-z0-9_./-]+$"))' "$config")
  git check-ref-format "$ref" || fail 'invalid public Git ref'
  sha=$(jq -er '.sha | strings | select(test("^[a-f0-9]{40}$"))' "$config")
  instance=${ORCA_VM_INSTANCE_ID:-}
  [[ -z ${ORCA_REPO_REF_HEAD:-} || $ORCA_REPO_REF_HEAD == "$sha" ]] ||
    fail 'requested Orca base SHA differs from the approved public SHA'
  uuid=$(cat /proc/sys/kernel/random/uuid)
  name="orca-skills-pilot-${uuid//-/}"
  name=${name:0:34}
  status=0
  list_name || status=$?
  [[ $status == 1 ]] || fail 'could not confirm the trial Sprite name is unused'
  create_confirmed=false
  write_state
  trap cleanup_failed_create EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  sp create --skip-console --label "$name" "$name" >/dev/null
  create_confirmed=true
  write_state
  read_info || fail 'could not verify the new Sprite identity and URL'
  pairing=$(remote create) || fail 'Sprite setup failed'
  result=$(emit_result "$pairing") || exit 1
  sp config update --url-auth public "$name" >/dev/null
  printf '%s\n' "$result"
  exit 0
fi

case "$mode" in suspend | resume | destroy) ;; *) fail 'unknown lifecycle operation' ;; esac
payload=$(cat)
jq -e --arg mode "$mode" --arg instance "${ORCA_VM_INSTANCE_ID:-}" '
  .schemaVersion == 1 and .mode == $mode and .recipeId == "sprites-wsl-pilot"
  and (.instanceId // "") == $instance
' >/dev/null <<<"$payload" || fail 'lifecycle payload does not match Orca context'
if [[ ! -f $state ]]; then
  [[ $mode == destroy ]] || fail 'pilot Sprite state is missing'
  printf '{"ok":true}\n'
  exit 0
fi
org=$(jq -er '.org' "$state")
name=$(jq -er '.name' "$state")
ref=$(jq -er '.ref' "$state")
sha=$(jq -er '.sha' "$state")
instance=$(jq -er '.instance' "$state")
create_confirmed=$(jq -r '.created' "$state")
[[ $instance == "${ORCA_VM_INSTANCE_ID:-}" ]] || fail 'pilot state belongs to a different Orca instance'
jq -e --arg name "$name" --arg org "$org" --arg mode "$mode" '
  if .recipeResult == null then $mode == "destroy"
  else .recipeResult.userData.resourceId == $name and .recipeResult.userData.org == $org end
' >/dev/null <<<"$payload" || fail 'lifecycle payload names a different Sprite'

if [[ $mode == destroy ]]; then
  destroy_sprite || fail "could not confirm removal of $name in $org"
  rm -- "$state"
elif [[ $mode == suspend ]]; then
  read_info || fail 'could not verify the pilot Sprite'
  remote suspend >/dev/null
else
  read_info || fail 'could not verify the pilot Sprite'
  pairing=$(remote resume) || fail 'could not restart the Orca service'
  emit_result "$pairing"
  exit 0
fi
printf '{"ok":true}\n'
