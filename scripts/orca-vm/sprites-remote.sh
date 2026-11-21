#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf '[sprites-pilot] %s\n' "$*" >&2
  exit 1
}

mode=$1
project="$HOME/skills"
runtime="$HOME/.orca-sprites-pilot"
service="orca-sprites-pilot"
orca="$runtime/server/bin/orca-ide"
port=8080
address="wss://${PILOT_URL#https://}"

if [[ $mode == create ]]; then
  origin=https://github.com/treflebonbon/skills.git
  remote_ref="refs/remotes/origin/${PILOT_REF#refs/heads/}"
  git init -q "$project"
  git -C "$project" remote add origin "$origin"
  GIT_TERMINAL_PROMPT=0 git -C "$project" fetch --quiet --depth=1 --no-tags origin "$PILOT_REF:$remote_ref"
  [[ $(git -C "$project" rev-parse "$remote_ref") == "$PILOT_SHA" ]] ||
    fail 'public Git ref does not match the approved target SHA'
  # Orca creates the remote workspace from the default base ref, not the desktop selection.
  git -C "$project" symbolic-ref refs/remotes/origin/HEAD "$remote_ref"
  git -C "$project" switch --quiet --detach "$PILOT_SHA"

  # Pin the package for the desktop Orca version used by this pilot.
  case "$(uname -m)" in
  x86_64)
    arch=x64
    sum=eaba2039f351d47e2ddc5d1c1f0335df3ae81b5830565adc1bcba23fc7004d0c
    ;;
  aarch64)
    arch=arm64
    sum=9ccf8e04491e102f5d349aa5eee4667f4e1cdcaaddcfca3daf6b872da962ae2c
    ;;
  *) fail 'unsupported Sprite architecture' ;;
  esac
  mkdir -p "$runtime/server"
  archive="$runtime/orca-server.tar.gz"
  curl --fail --silent --show-error --location --max-time 180 \
    "https://github.com/stablyai/orca/releases/download/v1.4.265/orca-server-linux-$arch.tar.gz" -o "$archive"
  printf '%s  %s\n' "$sum" "$archive" | sha256sum --check --status
  tar -xzf "$archive" -C "$runtime/server" --strip-components=1
  rm -- "$archive"
  "$orca" --version >/dev/null

  # Serve writes a pairing offer to its terminal. Keep it out of service logs.
  printf '#!/bin/bash\nexec %q serve --supervise --port %q --project-root %q --pairing-address %q >/dev/null 2>&1\n' \
    "$orca" "$port" "$project" "$address" >"$runtime/serve.sh"
  chmod 700 "$runtime/serve.sh"
  options=(--cmd "$runtime/serve.sh" --http-port "$port" --dir "$HOME")
  help=$(sprite-env services help 2>&1 || true)
  [[ $help != *--restart* ]] || options+=(--restart always)
  [[ $help != *--no-stream* ]] || options+=(--no-stream)
  sprite-env services create "$service" "${options[@]}" >/dev/null
elif [[ $mode == suspend ]]; then
  sprite-env services stop "$service" >/dev/null
  exit 0
elif [[ $mode == resume ]]; then
  sprite-env services start "$service" >/dev/null
else
  fail 'unknown remote operation'
fi

# The Orca CLI creates an offer through its local runtime once the service is ready.
for ((attempt = 0; attempt < 40; attempt++)); do
  if response=$("$orca" pair --address "$address" --json 2>/dev/null) &&
    result=$(jq -ec --arg root "$project" '
      .result | select(.available == true and (.pairingUrl | startswith("orca://")))
      | {schemaVersion: 1, pairingCode: .pairingUrl, projectRoot: $root}
    ' 2>/dev/null <<<"$response"); then
    printf '%s\n' "$result"
    exit 0
  fi
  sleep 1
done
fail 'Orca service did not produce a pairing offer'
