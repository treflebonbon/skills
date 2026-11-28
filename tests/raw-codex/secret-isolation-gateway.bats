#!/usr/bin/env bats

@test "isolated DNS bridge preserves the query, Unix HTTP and answer packets" {
  local root
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  run unshare --user --map-current-user --net --keep-caps bash -p -c '
    set -eu
    printf 0 > /proc/sys/net/ipv4/ip_unprivileged_port_start
    ip link set lo up
    exec setpriv --inh-caps=-all --ambient-caps=-all python3 -B "$@"
  ' _ "$root/tests/fixtures/raw-dns-command.py" \
      "$root/lib/bun/run" run "$root/lib/bun/raw-gateway-bridge.ts"
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | rg '^RAW_DNS ' | python3 -c '
import json, sys
from pathlib import Path
observed = json.loads(sys.stdin.read().removeprefix("RAW_DNS "))
expected = json.loads(Path(sys.argv[1]).read_text())["observed"]
assert observed == expected, (observed, expected)
' "$root/tests/fixtures/raw-dns-python.json"
}

@test "isolated bridge startup waits for readiness and rejects failed or stalled bridges" {
  [ "$(uname -s)" = Linux ] || skip "raw bridge startup requires Linux namespaces"
  local root
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  run env PYTHONPATH="$root/tests/helpers" python3 -B - "$root" "$BATS_TEST_TMPDIR" <<'PY'
import shutil, subprocess, sys
from pathlib import Path
source, fixture = map(Path, sys.argv[1:])
from raw_gateway_fixture import GatewayFixture
startup = subprocess.check_output([source / 'lib/bun/run', 'run',
                                   source / 'tests/helpers/raw-gateway-fixture.ts',
                                   'bridge-script'], text=True)
python = Path(sys.executable).resolve()
bash = Path(shutil.which('bash')).resolve()
bun = Path(shutil.which('bun')).resolve()
utils = Path(shutil.which('dirname')).resolve().parent
bun_source = source / 'lib/bun'
server = GatewayFixture(source, 'dependencies', domains=[])
temporary = Path(server.server_address).parent.parent
try:
    for mode, expected, reason in [
        ('slow', 0, ''),
        ('failed', 1, 'bridge exited with status 17'),
        ('stalled', 1, 'no readiness within 30s'),
        ('closed', 1, 'bridge exited with status 143'),
        ('invalid', 1, 'unexpected readiness line'),
    ]:
        wrapper = fixture / f'{mode}.ts'
        wrapper.write_text('import { closeSync } from "node:fs";\n' + {
            'slow': 'await Bun.sleep(12000);\n',
            'failed': 'console.error("bridge stderr marker"); process.exit(17);\n',
            'stalled': 'await Bun.sleep(60000);\n',
            'closed': 'closeSync(1); await Bun.sleep(20000);\n',
            'invalid': 'console.log("unexpected"); await Bun.sleep(20000);\n',
        }[mode] + 'await import("/gateway-source.ts");\n')
        script = fixture / f'{mode}.sh'
        script.write_text('set -eu\n' + startup + '''
python3 - <<'CLIENT'
import http.client
client = http.client.HTTPConnection('127.0.0.1', 8124, timeout=2)
client.request('GET', '/forbidden')
response = client.getresponse()
assert response.status == 403
assert response.read() == b''
print('BRIDGE_COMMAND_STARTED')
CLIENT
''')
        result = subprocess.run([
            'bwrap', '--unshare-all', '--die-with-parent', '--new-session',
            '--ro-bind', '/nix/store', '/nix/store', '--proc', '/proc', '--dev', '/dev',
            '--tmpfs', '/tmp', '--ro-bind', str(temporary), '/gateway',
            '--ro-bind', str(bun_source / 'raw-gateway-bridge.ts'), '/gateway-source.ts',
            '--ro-bind', str(bun_source / 'run'), '/nix/codex-isolation/lib/bun/run',
            '--ro-bind', str(bun_source / 'bunfig.toml'), '/nix/codex-isolation/lib/bun/bunfig.toml',
            '--ro-bind', str(bun_source / 'tsconfig.json'), '/nix/codex-isolation/lib/bun/tsconfig.json',
            '--ro-bind', str(wrapper), '/nix/codex-isolation/lib/bun/raw-gateway-bridge.ts',
            '--ro-bind', str(script), '/startup.sh',
            '--symlink', str(bash), '/bin/bash',
            '--clearenv', '--setenv', 'PATH', f'{bash.parent}:{bun.parent}:{python.parent}:{utils}',
            str(bash), '/startup.sh',
        ], text=True, capture_output=True, timeout=45)
        assert result.returncode == expected, (mode, result.returncode, result.stdout, result.stderr)
        if expected == 0:
            assert result.stdout.strip() == 'BRIDGE_COMMAND_STARTED', result.stdout
        else:
            assert f'gateway bridge did not start: {reason}' in result.stderr, (mode, result.stderr)
            if mode == 'failed':
                assert 'bridge stderr marker' in result.stderr, result.stderr
            assert 'BRIDGE_COMMAND_STARTED' not in result.stdout, mode
        print(f'{mode}: exit={result.returncode}', flush=True)
finally:
    server.shutdown()
PY
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}
