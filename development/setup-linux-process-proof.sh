#!/usr/bin/env bash
set -euo pipefail

# workflow_dispatch の使い捨て VM だけで呼ぶ。製品 runtime の導入入口ではない。
[[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_EVENT_NAME:-}" == workflow_dispatch ]]
[[ $(id -u) != 0 ]]
source_root=$1
evidence_root=$2
mkdir -p "$evidence_root"
case "$(uname -m)" in
x86_64)
  nix_system=x86_64-linux
  nix_hash=311b9f406f0239ef640a1e3fbea1df1bac9d3a7c316c4def30df3206dd964960
  ;;
aarch64)
  nix_system=aarch64-linux
  nix_hash=09edae3ed146b1a47de84eda6135ef12ee74783d409e7a207c912cb94e14aa35
  ;;
*)
  echo '対象 architecture が不一致です' >&2
  exit 1
  ;;
esac
[[ ! -e /nix && ! -e /etc/nix/nix.conf ]]
install_root=$(mktemp -d "$RUNNER_TEMP/nix-proof.XXXXXX")
curl --fail --location --proto '=https' --tlsv1.2 \
  "https://releases.nixos.org/nix/nix-2.34.6/nix-2.34.6-$nix_system.tar.xz" -o "$install_root/nix.tar.xz"
printf '%s  %s\n' "$nix_hash" "$install_root/nix.tar.xz" | sha256sum --check
printf '%s\n' "$nix_hash" >"$evidence_root/nix-installer.sha256"
tar -xJf "$install_root/nix.tar.xz" -C "$install_root"
NIX_INSTALLER_YES=1 NIX_EXTRA_CONF=$'sandbox = true\nexperimental-features = nix-command flakes' \
  bash "$install_root/nix-2.34.6-$nix_system/install" --daemon --no-channel-add
# shellcheck disable=SC1091
source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
export NIX_REMOTE=daemon
[[ $(nix --version) == 'nix (Nix) 2.34.6' ]]
systemctl is-active nix-daemon.socket
revision=$(cat "$source_root/tests/fixtures/raw-codex/nixpkgs-revision")
[[ "$revision" == 7fd4004d0511991fff3a0524856a9be09e28c5f0 ]]
expression="$(dirname "$0")/linux-process-proof.nix"
for attribute in bash stdenv; do
  store_root=$(nix-build "$expression" --argstr system "$nix_system" --argstr revision "$revision" \
    -A "$attribute" --out-link "$install_root/$attribute")
  [[ "$store_root" == /nix/store/* && -d "$store_root" ]]
  printf '%s\n' "$store_root" >"$evidence_root/nix-$attribute-root.txt"
  nix-store --query --requisites "$store_root" | sort >"$evidence_root/nix-$attribute-closure.txt"
done

# 元の補助 group は変更せず、専用 GID は追加試験で setpriv にだけ渡す。
proof_group="proof${GITHUB_RUN_ID}a${GITHUB_RUN_ATTEMPT}"
sudo -n groupadd "$proof_group"
proof_gid=$(getent group "$proof_group" | cut -d: -f3)
proof_group_dir=$(mktemp -d "$RUNNER_TEMP/group-proof.XXXXXX")
chmod 755 "$proof_group_dir"
printf 'group-proof\n' >"$proof_group_dir/data"
sudo -n chown "0:$proof_gid" "$proof_group_dir/data"
sudo -n chmod 0060 "$proof_group_dir/data"
{
  printf 'PATH=%s\n' "$PATH"
  printf 'NIX_REMOTE=daemon\n'
  printf 'PROCESS_PROOF_NIX_BASH=%s\n' "$(cat "$evidence_root/nix-bash-root.txt")"
  printf 'PROCESS_PROOF_NIX_STDENV=%s\n' "$(cat "$evidence_root/nix-stdenv-root.txt")"
  printf 'PROCESS_PROOF_GROUP_FILE=%s\n' "$proof_group_dir/data"
  printf 'PROCESS_PROOF_GROUP_GID=%s\n' "$proof_gid"
} >>"$GITHUB_ENV"
