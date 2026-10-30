#!/usr/bin/env python3
import json
from pathlib import Path
import subprocess
import sys


assert sys.argv[1:] == ["-c", 'model_reasoning_effort="low"', "app-server"]

work = Path.cwd()
base = work.parent
session = base / "state/devshell-env/sessions/fake-session"
session_dir = session / "config/sessions"
session_dir.mkdir(parents=True)
print(f"isolated session {session}", file=sys.stderr, flush=True)


def send(message):
    print(json.dumps(message), flush=True)


def reply(request, result):
    send({"id": request["id"], "result": result})


def started(thread_id, effort="low"):
    return {
        "thread": {
            "cliVersion": "fixture",
            "createdAt": 0,
            "cwd": str(work),
            "ephemeral": True,
            "id": thread_id,
            "modelProvider": "isolated",
            "preview": "fixture",
            "projectId": None,
            "sessionId": "fake-session",
            "source": "appServer",
            "status": {"type": "idle"},
            "turns": [],
            "updatedAt": 0,
        },
        "approvalPolicy": "never",
        "approvalsReviewer": "user",
        "cwd": str(work),
        "model": "gpt-6-luna",
        "reasoningEffort": effort,
        "modelProvider": "isolated",
        "sandbox": {"type": "workspaceWrite", "writableRoots": [str(work)]},
    }


def item(thread_id, turn_id, text):
    send({"method": "item/completed", "params": {
        "completedAtMs": 0,
        "threadId": thread_id,
        "turnId": turn_id,
        "item": {"id": f"message-{turn_id}", "type": "agentMessage", "text": text},
    }})


def completed(thread_id, turn_id):
    send({"method": "turn/completed", "params": {
        "threadId": thread_id,
        "turn": {"id": turn_id, "items": [], "itemsView": "full", "status": "completed"},
    }})


def add_turn_context(thread_id):
    path = session_dir / f"rollout-{thread_id}.jsonl"
    with path.open("a", encoding="utf-8") as rollout:
        rollout.write(json.dumps({"type": "turn_context", "payload": {
            "model": "gpt-6-luna", "effort": "low", "cwd": str(work),
        }}) + "\n")


thread_starts = 0
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        reply(request, {
            "codexHome": str(base / "home/.codex"),
            "platformFamily": "unix",
            "platformOs": "linux",
            "userAgent": "codex/fixture",
        })
    elif method == "thread/start":
        thread_starts += 1
        if thread_starts == 1:
            reply(request, started("mismatch-thread", "high"))
        elif thread_starts == 2:
            reply(request, started("target-thread"))
        else:
            reply(request, started("fresh-thread"))
    elif method == "turn/start":
        turn_id = "readiness-turn" if request["id"] == 4 else "task-turn"
        add_turn_context(request["params"]["threadId"])
        item("other-thread", turn_id, "OTHER_THREAD_MESSAGE")
        item("target-thread", "old-turn", "OLD_TURN_MESSAGE")
        if turn_id == "readiness-turn":
            git_values = []
            for arguments in (
                ["rev-parse", "HEAD"],
                ["branch", "--show-current"],
                ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
            ):
                git_values.extend(subprocess.check_output(
                    ["git", *arguments], cwd=work, text=True,
                ).splitlines())
            item("target-thread", turn_id, f"READY {work} task plus fixture {' '.join(git_values)}")
        else:
            item("target-thread", turn_id, "HOSTED_RAW_OK")
        completed("target-thread", turn_id)
        completed("other-thread", turn_id)
        completed("target-thread", "old-turn")
        reply(request, {"turn": {
            "id": turn_id, "items": [], "itemsView": "full", "status": "inProgress",
        }})
    elif method is None:
        continue
