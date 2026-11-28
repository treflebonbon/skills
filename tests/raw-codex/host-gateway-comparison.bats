#!/usr/bin/env bats

@test "Bun host gateway preserves wire and lifecycle behavior" {
  [ "$(uname -s)" = Linux ] || skip "raw host gateway is supported on Linux and WSL2"
  local root fixture
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  fixture="$BATS_TEST_TMPDIR"
  printf '%s\n' '127.0.0.1 localhost chatgpt.com' '8.8.8.8 allowed.example mixed.example' \
    '127.0.0.1 mixed.example' '8.8.4.4 capture.example' '::ffff:127.0.0.1 mapped-private.example' \
    '::ffff:8.8.8.8 mapped-public.example' '2001:db8::1 documentation.example' >"$fixture/hosts"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=chatgpt.com \
    -addext subjectAltName=DNS:chatgpt.com,DNS:allowed.example \
    -keyout "$fixture/key.pem" -out "$fixture/cert.pem" >/dev/null 2>&1
  run timeout 45s unshare --user --map-current-user --net --keep-caps bash -p -ec '
    fixture="$1"
    shift
    ip link set lo up
    ip addr add 8.8.8.8/32 dev lo
    ip addr add 8.8.4.4/32 dev lo
    printf 0 > /proc/sys/net/ipv4/ip_unprivileged_port_start
    exec setpriv --inh-caps=-all --ambient-caps=-all bwrap --unshare-user --unshare-pid \
      --die-with-parent --ro-bind / / --tmpfs /run --bind "$fixture" /run/cxi \
      --ro-bind "$fixture/hosts" /etc/hosts --proc /proc --dev /dev --clearenv \
      --setenv PATH "$PATH" --setenv HOME /run/cxi --setenv TMPDIR /run/cxi \
      --setenv GH_CONFIG_DIR /run/cxi \
      --setenv SSL_CERT_FILE /run/cxi/cert.pem --setenv NODE_EXTRA_CA_CERTS /run/cxi/cert.pem \
      "$@" /run/cxi
  ' _ "$fixture" "$root/lib/bun/run" run "$root/tests/helpers/raw-host-gateway-comparison.ts"
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
  [[ "$output" == *'gateway wire and lifecycle checks passed'* ]]
}
