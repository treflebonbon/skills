#!/usr/bin/env bats

@test "GitHub socket permits only selected repository metadata and rejects secret and administrative routes" {
  local root
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  mkdir "$BATS_TEST_TMPDIR/bin"
  cat > "$BATS_TEST_TMPDIR/bin/gh" <<'SH'
#!/bin/sh
case "$*" in
  'api repos/example/public --method GET') printf '{"full_name":"example/public","private":false,"default_branch":"main"}\n' ;;
  *) exit 70 ;;
esac
SH
  chmod +x "$BATS_TEST_TMPDIR/bin/gh"
  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" python3 - "$root/share/codex-isolation/secret-isolation-gateway.py" "$BATS_TEST_TMPDIR/socket" <<'PY'
import http.client, json, runpy, socket, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1])
policy = {'repository': 'example/public', 'branch': 'task', 'default_branch': 'main',
          'reviewed_commit': 'a' * 40, 'automation': 'no-project-secrets', 'review': 'dummy reviewed fixture'}
server = module['start_gateway'](Path(sys.argv[2]), 'github', github_policy=policy)
class Client(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect(server.server_address)
try:
    for method, path, expected in [
        ('GET', '/repos/example/public', 200),
        ('GET', '/repos/other/private', 403),
        ('GET', '/repos/example/public/actions/secrets', 403),
        ('GET', '/repos/example/public/actions/runs/1/logs', 403),
        ('GET', '/repos/example/public/contents/.env', 403),
        ('POST', '/graphql', 403),
        ('POST', '/repos/example/public/actions/workflows/a/dispatches', 403),
        ('PUT', '/repos/example/public/pulls/1/merge', 403),
        ('PATCH', '/repos/example/public/pulls/1', 403),
        ('CONNECT', 'api.github.com:443', 403),
    ]:
        client = Client('api.github.com')
        client.request(method, path, headers={'Authorization': 'Bearer dummy-not-forwarded'})
        response = client.getresponse()
        body = response.read()
        assert response.status == expected, (method, path, response.status)
        assert b'dummy-not-forwarded' not in body
        client.close()
finally:
    server.shutdown()
    server.server_close()
PY
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "topic publication validates real Git history and rejects unreviewed automation before invoking the publisher" {
  local root
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  mkdir "$BATS_TEST_TMPDIR/bin"
  cat > "$BATS_TEST_TMPDIR/bin/gh" <<'SH'
#!/bin/sh
test -f "$GH_CONFIG_DIR/marker" || exit 71
test -z "${GH_TOKEN+x}${GITHUB_TOKEN+x}" || exit 72
case "$*" in
  'api repos/example/public --method GET') printf '{"full_name":"example/public","private":false,"default_branch":"main"}\n' ;;
  'api repos/example/public/git/trees/'*' --method GET') printf '{"tree":[]}\n' ;;
  *) exit 70 ;;
esac
SH
  chmod +x "$BATS_TEST_TMPDIR/bin/gh"
  local mode
  for mode in gh xdg home; do
    mkdir "$BATS_TEST_TMPDIR/$mode"
    run env DUMMY_HOST_SECRET=dummy-host-secret PATH="$BATS_TEST_TMPDIR/bin:$PATH" \
      python3 "$root/tests/fixtures/raw-codex/github-push.py" "$root" "$BATS_TEST_TMPDIR/$mode" "$mode"
    [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
    [ "$status" -eq 0 ]
  done
}

@test "GitHub PR writes are restricted to the selected topic and reject state changes and extra fields" {
  local root
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  mkdir "$BATS_TEST_TMPDIR/bin"
  ln -s "$(command -v cat)" "$BATS_TEST_TMPDIR/bin/cat"
  cat > "$BATS_TEST_TMPDIR/bin/gh" <<'SH'
#!/bin/sh
case "$*" in
  'api repos/example/public --method GET') printf '{"full_name":"example/public","private":false,"default_branch":"main"}\n' ;;
  'api repos/example/public/git/trees/'*' --method GET') cat "$HOME/tree.json" ;;
  'api repos/example/public/pulls --method POST --input -')
    cat >/dev/null
    printf '{"number":7,"html_url":"https://github.com/example/public/pull/7","head":{"ref":"task","repo":{"full_name":"example/public"}},"base":{"ref":"main"}}\n' ;;
  *) exit 70 ;;
esac
SH
  chmod +x "$BATS_TEST_TMPDIR/bin/gh"
  printf '{"tree":[]}\n' > "$BATS_TEST_TMPDIR/tree.json"
  run env HOME="$BATS_TEST_TMPDIR" PATH="$BATS_TEST_TMPDIR/bin:$PATH" python3 - "$root/share/codex-isolation/secret-isolation-gateway.py" "$BATS_TEST_TMPDIR/socket" <<'PY'
import http.client, json, runpy, socket, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1])
policy = {'repository':'example/public','branch':'task','default_branch':'main',
          'reviewed_commit':'a'*40,'automation':'no-project-secrets','review':'dummy CI review'}
server = module['start_gateway'](Path(sys.argv[2]), 'github', github_policy=policy)
class Client(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect(server.server_address)
try:
    good = {'title':'feat: isolated change','body':'Dummy public body','head':'task','base':'main','draft':True}
    for payload, expected in [(good,200),(good|{'head':'other'},403),(good|{'base':'release'},403),
                              (good|{'maintainer_can_modify':True},403),(good|{'state':'closed'},403)]:
        client = Client('api.github.com')
        client.request('POST','/repos/example/public/pulls',json.dumps(payload))
        response = client.getresponse()
        assert response.status == expected, response.status
        response.read()
        client.close()
    github = {'path':'.github','type':'tree','mode':'040000','sha':'c'*40}
    for tree in ({'tree':[github]}, {'tree':[], 'truncated':True}, {}, [],
                 *({'tree':[github, entry]} for entry in (None, [], {}, {'path':7}))):
        (Path.home() / 'tree.json').write_text(json.dumps(tree))
        client = Client('api.github.com')
        client.request('POST','/repos/example/public/pulls',json.dumps(good))
        response = client.getresponse()
        assert response.status == (200 if tree == {'tree':[github]} else 502), (tree, response.status)
        response.read()
        client.close()
finally:
    server.shutdown()
    server.server_close()
PY
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "GitHub socket は分割送信された PR 本文を欠落なく受け付ける" {
  local root
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  mkdir "$BATS_TEST_TMPDIR/bin"
  ln -s "$(command -v cat)" "$BATS_TEST_TMPDIR/bin/cat"
  cat >"$BATS_TEST_TMPDIR/bin/gh" <<'SH'
#!/bin/sh
case "$*" in
  'api repos/example/public --method GET') printf '{"full_name":"example/public","private":false,"default_branch":"main"}\n' ;;
  'api repos/example/public/git/trees/'*' --method GET') printf '{"tree":[]}\n' ;;
  'api repos/example/public/pulls --method POST --input -')
    cat >"$HOME/received.json"
    printf '{"number":7}\n' ;;
  *) exit 70 ;;
esac
SH
  chmod +x "$BATS_TEST_TMPDIR/bin/gh"
  run env HOME="$BATS_TEST_TMPDIR" PATH="$BATS_TEST_TMPDIR/bin:$PATH" python3 - \
    "$root/share/codex-isolation/secret-isolation-gateway.py" "$BATS_TEST_TMPDIR/socket" <<'PY'
import http.client, json, runpy, socket, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1])
policy = {'repository': 'example/public', 'branch': 'task', 'default_branch': 'main',
          'reviewed_commit': 'a' * 40, 'automation': 'no-project-secrets', 'review': 'public fixture'}
server = module['start_gateway'](Path(sys.argv[2]), 'github', github_policy=policy)
payload = {'title': 'fix: fragmented body', 'body': 'public fixture ' * 3000,
           'head': 'task', 'base': 'main'}
body = json.dumps(payload).encode()
try:
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(30)
        client.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1024)
        client.connect(server.server_address)
        client.sendall(b'POST /repos/example/public/pulls HTTP/1.0\r\nHost: api.github.com\r\nContent-Length: %d\r\n\r\n' % len(body))
        for offset in range(0, len(body), 4096):
            client.sendall(body[offset:offset + 4096])
        response = http.client.HTTPResponse(client)
        response.begin()
        assert response.status == 200, response.status
        assert json.loads(response.read()) == {'number': 7}
    assert json.loads((Path.home() / 'received.json').read_text()) == payload
finally:
    server.shutdown()
    server.server_close()
PY
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "isolated gh reads typed fields from stdin and files while raw fields stay literal" {
  local root
  root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  run python3 - "$root/share/codex-isolation/github-client.py" "$BATS_TEST_TMPDIR" <<'PY'
import http.server, json, os, subprocess, sys, threading
from pathlib import Path
requests = []
class Upstream(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        requests.append((self.path, json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'{}')
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(('127.0.0.1', 0), Upstream)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    env = os.environ | {'HTTP_PROXY': f'http://127.0.0.1:{server.server_port}'}
    text = 'first line\n日本語 and `literal` $value\n'
    path = Path(sys.argv[2]) / 'body.txt'
    path.write_text(text)
    for flag, value, expected in (('-F', '@-', text), ('--field', '@'+str(path), text), ('-f', '@-', '@-')):
        result = subprocess.run([sys.executable, sys.argv[1], 'gh', 'api', 'repos/example/public/pulls',
                                 flag, 'body='+value], input=text, text=True, env=env, capture_output=True)
        assert result.returncode == 0, result.stderr
        assert requests[-1] == ('http://api.github.com/repos/example/public/pulls', {'body':expected}), requests
    assert len(requests) == 3
finally:
    server.shutdown()
    server.server_close()
PY
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

@test "isolated gh reports a missing PR title before reading policy or contacting the gateway" {
  run python3 "$BATS_TEST_DIRNAME/../../share/codex-isolation/github-client.py" gh pr create --body 'public body'
  [ "$status" -eq 1 ]
  [[ "$output" == *'gh pr create requires --title'* ]]
}
