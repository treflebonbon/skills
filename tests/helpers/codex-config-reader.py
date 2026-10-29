"""Codex app-server protocol fixture for launch/environment tests."""

import json
import sys

for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "initialize":
        result = {}
    elif request["method"] == "config/read":
        result = {
            "config": {"permissions": {"dotfiles-secure": {"extends": ":workspace"}}}
        }
    else:
        raise ValueError("unexpected request")
    print(json.dumps({"id": request["id"], "result": result}), flush=True)
