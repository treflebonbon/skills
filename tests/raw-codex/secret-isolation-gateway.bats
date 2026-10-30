#!/usr/bin/env bats

@test "gateways serve independent long paths and release their socket resources" {
  [ "$(uname -s)" = Linux ] || skip "long-path raw isolation requires Linux/WSL2"
  run python3 - "$BATS_TEST_DIRNAME/../../share/codex-isolation/secret-isolation-gateway.py" "$BATS_TEST_TMPDIR" <<'PY'
import http.client, os, runpy, socket, stat, subprocess, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1])
parent = Path(sys.argv[2]) / ('long-gateway-parent-' * 8)
parent.mkdir()
before = set(os.listdir('/proc/self/fd'))
servers = []
try:
    for name in ('first', 'second'):
        directory = parent / name
        assert len(os.fsencode(directory / 'service.sock')) > 107
        server = module['start_gateway'](directory, 'dependencies', domains=[])
        servers.append(server)
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700
        assert (directory / 'service.sock').is_socket()
        # A separate client process must be able to use the published address.
        subprocess.run([sys.executable, '-c', '''
import http.client, socket, sys
client = http.client.HTTPConnection('gateway', timeout=3)
client.sock = socket.socket(socket.AF_UNIX)
client.sock.settimeout(3)
client.sock.connect(sys.argv[1])
client.request('GET', '/forbidden')
response = client.getresponse()
assert response.status == 403
assert response.read() == b''
client.close()
''', server.server_address], check=True)
    assert servers[0].server_address != servers[1].server_address
finally:
    for server in servers:
        server.shutdown()
        server.server_close()
        server.server_close()
assert set(os.listdir('/proc/self/fd')) == before
PY
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "gateway setup failure releases socket resources" {
  [ "$(uname -s)" = Linux ] || skip "descriptor accounting requires Linux procfs"
  run python3 - "$BATS_TEST_DIRNAME/../../share/codex-isolation/secret-isolation-gateway.py" "$BATS_TEST_TMPDIR" <<'PY'
import os, runpy, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1])
parent = Path(sys.argv[2]) / ('long-setup-parent-' * 8)
parent.mkdir()
before = set(os.listdir('/proc/self/fd'))
try:
    module['start_gateway'](parent / 'socket', 'model',
                            codex_home=Path(sys.argv[2]) / 'missing-login')
except FileNotFoundError:
    pass
else:
    raise AssertionError('missing login must reject gateway setup')
assert set(os.listdir('/proc/self/fd')) == before
PY
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "the model socket rejects remote state, remote tools, malformed requests and other routes without upstream access" {
  local project_root
  project_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  mkdir -p "$BATS_TEST_TMPDIR/home/.codex"
  printf '{"tokens":{"access_token":"dummy-access","account_id":"dummy-account"}}\n' >"$BATS_TEST_TMPDIR/home/.codex/auth.json"
  run env HOME="$BATS_TEST_TMPDIR/home" CODEX_HOME="$BATS_TEST_TMPDIR/home/.codex" \
    python3 - "$project_root/share/codex-isolation/secret-isolation-gateway.py" "$BATS_TEST_TMPDIR/socket" <<'PY'
import http.client, json, runpy, socket, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1])
called = []
def unavailable_upstream(*args, **kwargs):
    called.append(True)
    raise OSError('the negative test must not contact a real service')
http.client.HTTPSConnection = unavailable_upstream
server = module['start_gateway'](Path(sys.argv[2]), 'model')
class Client(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(3)
        self.sock.connect(server.server_address)
cases = [
    ('POST', '/v1/responses', {'previous_response_id': 'old-private-response'}),
    ('POST', '/v1/responses', {'conversation': 'old-private-conversation'}),
    ('POST', '/v1/responses', {'tools': [{'type': 'file_search', 'vector_store_ids': ['private-store']}]}),
    ('POST', '/v1/responses', {'tools': [{'type': 'namespace', 'tools': [{'type': 'mcp'}]}]}),
    ('POST', '/v1/responses', {'input': [{'type': 'item_reference', 'id': 'private-item'}]}),
    ('POST', '/v1/responses', {'input': [{'type': 'additional_tools', 'tools': [{'type': 'file_search'}]}]}),
    ('POST', '/v1/responses', {'input': [{'type': 'message', 'content': [{'type': 'input_file', 'file_id': 'private-file'}]}]}),
    ('POST', '/v1/responses', []),
    ('POST', '/v1/responses', {'tools': [None]}),
    ('POST', '/v1/responses/../files', {}),
    ('GET', '/v1/responses', {}),
    ('CONNECT', 'chatgpt.com:443', {}),
]
try:
    for method, path, payload in cases:
        client = Client('model', timeout=3)
        try:
            client.request(method, path, json.dumps(payload), {'Content-Type': 'application/json'})
        except BrokenPipeError:
            # A forbidden route may receive its 403 before the body is sent.
            pass
        response = client.getresponse()
        assert response.status == 403, (method, path, payload, response.status)
        assert response.read() == b''
        client.close()
    assert not called, 'a forbidden request reached the authenticated upstream'
finally:
    server.shutdown()
    server.server_close()
PY
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "the resolver admits only allowlisted public addresses and rejects local or unsupported queries" {
  local project_root
  project_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  run python3 - "$project_root/share/codex-isolation/secret-isolation-gateway.py" "$BATS_TEST_TMPDIR/resolver" <<'PY'
import http.client,json,runpy,socket,sys
from pathlib import Path
module=runpy.run_path(sys.argv[1])
lookups=[]
def lookup(host,port,**kwargs):
    lookups.append(host)
    address='127.0.0.1' if host == 'private.github.com' else '8.8.8.8'
    return [(socket.AF_INET,socket.SOCK_STREAM,6,'',(address,port))]
socket.getaddrinfo=lookup
server=module['start_gateway'](Path(sys.argv[2]),'dependencies',domains=['cache.nixos.org','**.github.com'],denied_domains=['blocked.github.com'])
class Client(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX)
        self.sock.connect(server.server_address)
try:
    for payload,status in [({'host':'cache.nixos.org','type':1},200),({'host':'cache.nixos.org','type':28},200),
                           ({'host':'private.github.com','type':1},403),({'host':'blocked.github.com','type':1},403),({'host':'127.0.0.1','type':1},403),
                           ({'host':'example.com','type':1},403),({'host':'cache.nixos.org','type':12},403)]:
        client=Client('resolver')
        client.request('POST','/resolve',json.dumps(payload))
        response=client.getresponse()
        assert response.status == status,(payload,response.status)
        answer=response.read()
        if status==200:
            assert json.loads(answer)==(['8.8.8.8'] if payload['type']==1 else [])
        else:
            assert answer==b''
        client.close()
    assert lookups==['cache.nixos.org','cache.nixos.org','private.github.com']
finally:
    server.shutdown()
    server.server_close()
PY
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "the dependency proxy tries another validated public address when the first cannot connect" {
  local project_root
  project_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  run python3 - "$project_root/share/codex-isolation/secret-isolation-gateway.py" "$BATS_TEST_TMPDIR/proxy" <<'PY'
import http.client, runpy, socket, socketserver, ssl, sys, threading
from pathlib import Path
module = runpy.run_path(sys.argv[1])
outgoing = ssl.MemoryBIO()
# Keep the SSLObject alive while generating its first handshake flight.
client_tls = ssl.create_default_context().wrap_bio(ssl.MemoryBIO(), outgoing, server_hostname='cache.nixos.org')
try:
    client_tls.do_handshake()
except ssl.SSLWantReadError:
    pass
hello = outgoing.read()
class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        received = bytearray()
        while len(received) < len(hello):
            chunk = self.request.recv(len(hello) - len(received))
            if not chunk:
                return
            received.extend(chunk)
        assert received == hello
        self.request.sendall(b'pong')
upstream = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Echo)
threading.Thread(target=upstream.serve_forever, daemon=True).start()
server = module['start_gateway'](Path(sys.argv[2]), 'dependencies', domains=['cache.nixos.org'])
attempts = []
original_socket = socket.socket
class FixtureSocket(original_socket):
    def connect(self, address):
        if self.family == socket.AF_INET and address[1] == 443:
            attempts.append(address[0])
            if address[0] == '8.8.8.8':
                raise TimeoutError('first public address is unreachable')
            assert address[0] == '1.1.1.1'
            address = upstream.server_address
        return super().connect(address)
socket.socket = FixtureSocket
socket.getaddrinfo = lambda *a, **kw: [
    (socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 443))
    for address in ('8.8.8.8', '1.1.1.1')
]
class Client(http.client.HTTPConnection):
    def connect(self):
        self.sock = original_socket(socket.AF_UNIX)
        self.sock.settimeout(3)
        self.sock.connect(server.server_address)
try:
    client = Client('proxy')
    client.connect()
    tunnel = client.sock
    client.request('CONNECT', 'cache.nixos.org:443')
    response = client.getresponse()
    assert response.status == 200, response.status
    tunnel.sendall(hello)
    assert response.read(4) == b'pong'
    response.close()
    client.close()
    assert attempts == ['8.8.8.8', '1.1.1.1'], attempts
finally:
    server.shutdown()
    server.server_close()
    upstream.shutdown()
    upstream.server_close()
PY
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "request bodies delivered in fragments are read completely" {
  run python3 - "$BATS_TEST_DIRNAME/../../share/codex-isolation/secret-isolation-gateway.py" "$BATS_TEST_TMPDIR/socket" <<'PYTEST'
import json, runpy, socket, sys, time
from pathlib import Path
from unittest.mock import patch
module = runpy.run_path(sys.argv[1])
server = module['start_gateway'](Path(sys.argv[2]), 'dependencies', domains=['cache.nixos.org'])
body = json.dumps({'host': 'cache.nixos.org', 'type': 1}).encode()
try:
    with patch('socket.getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))]):
        client = socket.socket(socket.AF_UNIX)
        client.settimeout(5)
        client.connect(server.server_address)
        client.sendall(b'POST /resolve HTTP/1.1\r\nHost: resolver\r\nContent-Length: %d\r\n\r\n' % len(body))
        for start in range(0, len(body), 7):
            client.sendall(body[start:start + 7])
            time.sleep(0.05)
        response = client.recv(4096)
        client.close()
    assert response.startswith(b'HTTP/1.0 200') or response.startswith(b'HTTP/1.1 200'), response
    assert response.endswith(b'["8.8.8.8"]'), response
finally:
    server.shutdown()
    server.server_close()
PYTEST
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "a trickled TLS ClientHello is rejected by one overall deadline" {
  run python3 - "$BATS_TEST_DIRNAME/../../share/codex-isolation/secret-isolation-gateway.py" <<'PYTEST'
import runpy, socket, sys, threading, time
check = runpy.run_path(sys.argv[1])['checked_client_hello']
reader, writer = socket.socketpair()
stop = threading.Event()
def trickle():
    try:
        while not stop.is_set():
            writer.sendall(b'\x16')
            time.sleep(0.2)
    except OSError:
        pass
thread = threading.Thread(target=trickle)
thread.start()
started = time.monotonic()
try:
    check(reader.makefile('rb', 0), 'allowed.example', reader, timeout=1)
except ValueError:
    pass
else:
    raise AssertionError('a trickled hello must be rejected')
finally:
    stop.set()
    reader.close()
    writer.close()
    thread.join()
assert time.monotonic() - started < 3, 'deadline was not enforced for the whole hello'
PYTEST
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "CONNECT refuses a different TLS virtual host on the same permitted IP" {
  run python3 - "$BATS_TEST_DIRNAME/../../share/codex-isolation/secret-isolation-gateway.py" "$BATS_TEST_TMPDIR/socket" <<'PYTEST'
import http.client, runpy, socket, socketserver, ssl, sys, threading
from pathlib import Path
from unittest.mock import patch
module = runpy.run_path(sys.argv[1])
received = []
class Capture(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(3)
        received.append(self.request.recv(65536))
upstream = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Capture)
thread = threading.Thread(target=upstream.serve_forever)
thread.start()
server = module['start_gateway'](Path(sys.argv[2]), 'dependencies',
    domains=['allowed.example'], denied_domains=['denied.example'])
original_socket = socket.socket
class FixtureSocket(original_socket):
    def connect(self, address):
        if self.family == socket.AF_INET and address == ('8.8.8.8', 443):
            address = upstream.server_address
        return super().connect(address)
try:
    with patch('socket.socket', FixtureSocket), patch('socket.getaddrinfo', return_value=[
        (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))]):
        for hostname in ('unlisted.example', 'denied.example', None):
            outgoing = ssl.MemoryBIO()
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False
            tls = context.wrap_bio(ssl.MemoryBIO(), outgoing, server_hostname=hostname)
            try:
                tls.do_handshake()
            except ssl.SSLWantReadError:
                pass
            client = http.client.HTTPConnection('gateway')
            client.sock = original_socket(socket.AF_UNIX)
            client.sock.settimeout(3)
            client.sock.connect(server.server_address)
            tunnel = client.sock
            client.request('CONNECT', 'allowed.example:443')
            response = client.getresponse()
            assert response.status == 200
            tunnel.sendall(outgoing.read())
            assert response.read() == b''
            response.close()
            client.close()
finally:
    server.shutdown()
    server.server_close()
    upstream.shutdown()
    upstream.server_close()
    thread.join()
assert received == [b'', b'', b''], [len(data) for data in received]
assert server.requests == 0
PYTEST
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "TLS destination validation accepts fragmented hello and rejects hidden or malformed names" {
  run python3 - "$BATS_TEST_DIRNAME/../../share/codex-isolation/secret-isolation-gateway.py" <<'PYTEST'
import io, runpy, ssl, sys
check = runpy.run_path(sys.argv[1])['checked_client_hello']
outgoing = ssl.MemoryBIO()
tls = ssl.create_default_context().wrap_bio(ssl.MemoryBIO(), outgoing, server_hostname='allowed.example')
try:
    tls.do_handshake()
except ssl.SSLWantReadError:
    pass
hello = outgoing.read()
assert check(io.BytesIO(hello), 'allowed.example') == hello
payload = hello[5:]
def record(data):
    return b'\x16\x03\x03' + len(data).to_bytes(2, 'big') + data
fragmented = b''.join(record(payload[n:n+3]) for n in range(0, len(payload), 3))
assert check(io.BytesIO(fragmented), 'allowed.example') == fragmented
# Add an ECH extension, maintaining all enclosing lengths.
body = bytearray(payload[4:])
pos = 34
pos += 1 + body[pos]
pos += 2 + int.from_bytes(body[pos:pos+2], 'big')
pos += 1 + body[pos]
size = int.from_bytes(body[pos:pos+2], 'big')
body[pos:pos+2] = (size + 4).to_bytes(2, 'big')
body.extend(b'\xfe\x0d\x00\x00')
ech = record(b'\x01' + len(body).to_bytes(3, 'big') + body)
for bad in (hello[:-1], b'GET /', record(b'\x02\x00\x00\x00'), ech,
            record(payload + b'extra'), b'\x16\x03\x03\xff\xff'):
    try:
        check(io.BytesIO(bad), 'allowed.example')
    except ValueError:
        pass
    else:
        raise AssertionError('invalid hello accepted')
PYTEST
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "validated CONNECT tunnels complete TLS 1.2 and TLS 1.3 handshakes" {
  run python3 - "$BATS_TEST_DIRNAME/../../share/codex-isolation/secret-isolation-gateway.py" "$BATS_TEST_TMPDIR" <<'PYTEST'
import http.client, runpy, socket, socketserver, ssl, subprocess, sys, threading
from pathlib import Path
from unittest.mock import patch
module = runpy.run_path(sys.argv[1])
root = Path(sys.argv[2])
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', str(root / 'key.pem'), '-out', str(root / 'cert.pem'), '-days', '1',
    '-subj', '/CN=allowed.example', '-addext', 'subjectAltName=DNS:allowed.example'],
    check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(root / 'cert.pem', root / 'key.pem')
names = []
context.set_servername_callback(lambda sock, name, ctx: names.append(name))
class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        with context.wrap_socket(self.request, server_side=True) as tls:
            assert tls.recv(4) == b'ping'
            tls.sendall(b'pong')
upstream = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Echo)
thread = threading.Thread(target=upstream.serve_forever)
thread.start()
server = module['start_gateway'](root / 'socket', 'dependencies', domains=['allowed.example'])
original_socket = socket.socket
class FixtureSocket(original_socket):
    def connect(self, address):
        if self.family == socket.AF_INET and address == ('8.8.8.8', 443):
            address = upstream.server_address
        return super().connect(address)
try:
    with patch('socket.socket', FixtureSocket), patch('socket.getaddrinfo', return_value=[
        (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))]):
        for version in (ssl.TLSVersion.TLSv1_2, ssl.TLSVersion.TLSv1_3):
            client = http.client.HTTPConnection('gateway')
            client.sock = original_socket(socket.AF_UNIX)
            client.sock.settimeout(5)
            client.sock.connect(server.server_address)
            tunnel = client.sock
            client.request('CONNECT', 'allowed.example:443')
            response = client.getresponse()
            assert response.status == 200
            context_client = ssl.create_default_context(cafile=str(root / 'cert.pem'))
            context_client.minimum_version = context_client.maximum_version = version
            with context_client.wrap_socket(tunnel, server_hostname='allowed.example') as tls:
                tls.sendall(b'ping')
                assert tls.recv(4) == b'pong'
            response.close()
            client.close()
finally:
    server.shutdown()
    server.server_close()
    upstream.shutdown()
    upstream.server_close()
    thread.join()
assert names == ['allowed.example', 'allowed.example']
PYTEST
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "isolated startup cleans gateways after partial service and later setup failures" {
  [ "$(uname -s)" = Linux ] || skip "descriptor accounting requires Linux procfs"
  run python3 - "$BATS_TEST_DIRNAME/../../share/codex-isolation/secret-isolation-worktree.py" "$BATS_TEST_TMPDIR" <<'PYTEST'
import os, runpy, shutil, sys, threading
from pathlib import Path
from unittest.mock import patch

module = runpy.run_path(sys.argv[1])
gateway_module = runpy.run_path(str(Path(sys.argv[1]).with_name('secret-isolation-gateway.py')))
run_isolated = module['run_isolated']
parent = Path(sys.argv[2])
ca = parent / 'untrusted-ca.crt'
ca.touch()
for label, services, expected in (
    ('partial', ['dependencies', 'model'], 'host tool login is unavailable'),
    ('later', ['dependencies'], 'select the public CA bundle'),
):
    output = parent / label
    output.mkdir()
    root = parent / (label + '-gateways')
    root.mkdir()
    servers = []
    def start_gateway(*args, **kwargs):
        server = gateway_module['start_gateway'](*args, **kwargs)
        servers.append(server)
        return server
    before_fds = set(os.listdir('/proc/self/fd'))
    before_threads = set(threading.enumerate())
    try:
        with patch.dict(run_isolated.__globals__, prepare=lambda *a: None), \
             patch.dict(gateway_module['start_gateway'].__globals__, start_gateway=start_gateway), \
             patch('shutil.which', return_value=sys.executable), \
             patch('subprocess.run') as run, \
             patch('subprocess.check_output', return_value=''), \
             patch('tempfile.mkdtemp', return_value=str(root)), \
             patch('runpy.run_path', return_value=gateway_module):
            try:
                run_isolated(None, None, output, ['true'], services, ca_bundle=ca,
                             runtime={'domains': [], 'codex_home': str(parent / 'missing-login')})
            except ValueError as error:
                assert expected in str(error), str(error)
            else:
                raise AssertionError('startup must fail')
            assert run.call_count == 1, 'isolated command must not start'
        assert len(servers) == 1, 'first gateway must have started'
        assert not root.exists(), 'gateway directory leaked'
        assert set(os.listdir('/proc/self/fd')) == before_fds, 'gateway descriptors leaked'
        assert set(threading.enumerate()) == before_threads, 'gateway thread leaked'
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        if root.exists():
            shutil.rmtree(root)
PYTEST
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "isolated bridge startup waits for readiness and rejects failed or stalled bridges" {
  [ "$(uname -s)" = Linux ] || skip "raw bridge startup requires Linux namespaces"
  run python3 - "$BATS_TEST_DIRNAME/../../share/codex-isolation" "$BATS_TEST_TMPDIR" <<'PY'
import runpy, shutil, subprocess, sys, tempfile
from pathlib import Path
source, fixture = map(Path, sys.argv[1:])
startup = runpy.run_path(str(source / 'secret-isolation-worktree.py'))['bridge_startup']
gateway = runpy.run_path(str(source / 'secret-isolation-gateway.py'))
python = Path(sys.executable).resolve()
bash = Path(shutil.which('bash')).resolve()
with tempfile.TemporaryDirectory(prefix='cxi-ready-', dir='/tmp') as temporary:
    server = gateway['start_gateway'](Path(temporary) / 'dependencies', 'dependencies', domains=[])
    try:
        for mode, expected, reason in [
            ('slow', 0, ''),
            ('failed', 1, 'bridge exited with status 17'),
            ('stalled', 1, 'no readiness within 30s'),
            ('closed', 1, 'bridge exited with status 143'),
            ('invalid', 1, 'unexpected readiness line'),
        ]:
            wrapper = fixture / f'{mode}.py'
            wrapper.write_text('import runpy, time\n' + {
                'slow': 'time.sleep(12)\n',
                'failed': 'import sys\nprint("bridge stderr marker", file=sys.stderr)\nraise SystemExit(17)\n',
                'stalled': 'time.sleep(60)\n',
                'closed': 'import os\nos.close(1)\ntime.sleep(20)\n',
                'invalid': 'print("unexpected", flush=True)\ntime.sleep(20)\n',
            }[mode] + 'runpy.run_path("/gateway-source.py", run_name="__main__")\n')
            script = fixture / f'{mode}.sh'
            script.write_text('set -eu\n' + startup('dependencies', 8124) + '''
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
                '--tmpfs', '/tmp', '--ro-bind', temporary, '/gateway',
                '--ro-bind', str(source / 'secret-isolation-gateway.py'), '/gateway-source.py',
                '--ro-bind', str(wrapper), '/gateway-bridge.py', '--ro-bind', str(script), '/startup.sh',
                '--clearenv', '--setenv', 'PATH', f'{bash.parent}:{python.parent}',
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
        server.server_close()
PY
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}
