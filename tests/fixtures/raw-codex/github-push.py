"""Exercise the public GitHub socket with real Git objects and a dummy publisher."""

import base64
import http.client
import json
import os
from pathlib import Path
import runpy
import socket
import subprocess
import sys

root, temporary = map(Path, sys.argv[1:3])
mode = sys.argv[3]
os.environ.pop("GH_CONFIG_DIR", None)
os.environ.pop("XDG_CONFIG_HOME", None)
os.environ["HOME"] = str(temporary / "home")
config = temporary / "home/.config/gh"
if mode == "gh":
    config = temporary / "selected-gh"
    os.environ["GH_CONFIG_DIR"] = str(config)
    os.environ["XDG_CONFIG_HOME"] = str(temporary / "unused-xdg")
elif mode == "xdg":
    config = temporary / "selected-xdg/gh"
    os.environ["XDG_CONFIG_HOME"] = str(config.parent)
config.mkdir(parents=True)
(config / "marker").touch()
os.environ["GH_TOKEN"] = os.environ["GITHUB_TOKEN"] = "dummy-not-forwarded"
repo = temporary / "repo"
repo.mkdir()


def git(*arguments):
    return subprocess.check_output(["git", "-C", str(repo), *arguments])


git("init", "-q")
git("config", "user.name", "Fixture")
git("config", "user.email", "fixture@example.invalid")
git("commit", "--allow-empty", "-qm", "test: baseline")
baseline = git("rev-parse", "HEAD").decode().strip()
pack = subprocess.check_output(
    ["git", "-C", str(repo), "pack-objects", "--stdout", "--revs"],
    input=(baseline + "\n").encode(),
)
git("checkout", "-qb", "task")
(repo / "public.txt").write_text("normal change\n")
git("add", "public.txt")
git("commit", "-qm", "test: public change")
policy = {
    "repository": "example/public",
    "branch": "task",
    "default_branch": "main",
    "reviewed_commit": baseline,
    "automation": "no-project-secrets",
    "review": "dummy CI review",
}
publisher = (
    '#!/bin/sh\nset -eu\ntest "$(git branch --show-current)" = task\ntest -z "${DUMMY_HOST_SECRET+x}"\ntest -z "${GH_TOKEN+x}${GITHUB_TOKEN+x}"\ntest -f "$GH_CONFIG_DIR/marker"\nprintf published >> '
    + str(temporary / "published")
    + "\n"
)
gateway = runpy.run_path(
    str(root / "share/codex-isolation/secret-isolation-gateway.py")
)
server = gateway["start_gateway"](
    temporary / "socket",
    "github",
    github_policy=policy,
    github_seed={"pack": pack, "push_helper": publisher},
)


class Client(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect(server.server_address)


def push(head=None):
    client = Client("api.github.com")
    payload = {
        "head": head or git("rev-parse", "HEAD").decode().strip(),
        "bundle": base64.b64encode(
            git("bundle", "create", "-", "HEAD", "^" + baseline)
        ).decode(),
    }
    client.request("POST", "/topic-push", json.dumps(payload))
    response = client.getresponse()
    result = response.status
    response.read()
    client.close()
    return result


try:
    assert push(baseline) == 403
    assert not (temporary / "published").exists()
    assert push() == 200
    assert (temporary / "published").read_text() == "published"
    (repo / ".github/workflows").mkdir(parents=True)
    (repo / ".github/workflows/leak.yml").write_text("dummy secret-using workflow\n")
    git("add", ".github")
    git("commit", "-qm", "test: unreviewed automation")
    assert push() == 403
    assert (temporary / "published").read_text() == "published"
finally:
    server.shutdown()
    server.server_close()
