"""Public, dummy-only task used by the real hosted Codex integration probe."""

import json
import os
from pathlib import Path
import subprocess
import sys


def boundary():
    for name in (".env", "ordinary-looking-name", "nested/.env", "nested/renamed", "../repo/.env"):
        try:
            Path(name).read_bytes()
        except OSError:
            pass
        else:
            raise AssertionError("unapproved host input was readable")
    assert "WORKTREE_DUMMY_SECRET" not in os.environ
    assert not Path("/nix/var/nix/daemon-socket/socket").exists()
    assert not Path("/home/ubuntu/.codex/auth.json").exists()


def task():
    boundary()
    assert os.environ["PROBE_HOOK"] == "ready"
    subprocess.run([sys.executable, "worktree-task.py", "boundary"], check=True)
    Path("calculator.py").write_text("def add(a, b):\n    return a + b\n")
    subprocess.run([sys.executable, "-m", "py_compile", "calculator.py"], check=True)
    subprocess.run([sys.executable, "-c", "from calculator import add; assert add(2, 3) == 5"], check=True)
    subprocess.run(["git", "add", "calculator.py"], check=True)
    subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "test: hosted isolated calculation"], check=True)
    result = subprocess.check_output(["gh", "api", "repos/octocat/Hello-World", "--jq", ".full_name"],
                                     env=os.environ | {"GH_TOKEN": "isolated-placeholder"}, text=True)
    assert result.strip() == "octocat/Hello-World"
    print("WORKTREE_TASK_OK")


def mcp():
    for line in sys.stdin:
        message = json.loads(line)
        if "id" not in message:
            continue
        if message["method"] == "initialize":
            result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "boundary", "version": "1"}}
        elif message["method"] == "tools/list":
            result = {"tools": [{"name": "boundary", "description": "Verify the isolated MCP boundary", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}]}
        elif message["method"] == "tools/call":
            boundary()
            Path("mcp-ok").write_text("MCP_BOUNDARY_OK\n")
            result = {"content": [{"type": "text", "text": "MCP_BOUNDARY_OK"}]}
        else:
            result = {}
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)


if __name__ == "__main__":
    {"task": task, "boundary": boundary, "mcp": mcp}[sys.argv[1]]()
