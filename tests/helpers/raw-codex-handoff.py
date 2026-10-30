"""実モデル opt-in 試験: 同じ隔離 process/thread の確認後に実タスクを渡す。"""

import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading


base = Path(sys.argv[1])
root = str(base / "work")
environment = os.environ | {
    "HOME": str(base / "home"),
    "CODEX_HOME": str(base / "home/.codex"),
    "XDG_STATE_HOME": str(base / "state"),
}
expected = ("gpt-6-luna", "low", "isolated", root)
with (base / "handoff.stderr").open("w") as log:
    process = subprocess.Popen(
        [str(base / "bin/codex-worktree"),
         "-c", 'model_reasoning_effort="low"', "app-server"],
        cwd=root, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=log, text=True,
    )
    inbox = queue.Queue()

    def read_messages():
        for line in process.stdout:
            if line.startswith("{"):
                inbox.put(json.loads(line))
        inbox.put(None)

    threading.Thread(target=read_messages, daemon=True).start()
    # shortcut: unmatched events last until exit, bound them if this helper becomes long-lived.
    turn_notifications = []

    def send(message):
        process.stdin.write(json.dumps(message) + "\n")
        process.stdin.flush()

    def receive():
        message = inbox.get(timeout=180)
        assert message is not None, (base / "handoff.stderr").read_text()
        assert "error" not in message, message.get("error")
        assert not ("id" in message and "method" in message), "想定外の承認・入力要求"
        return message

    def rpc(identifier, method, params):
        send({"id": identifier, "method": method, "params": params})
        while True:
            message = receive()
            if message.get("id") == identifier:
                return message["result"]
            if message.get("method") in ("item/completed", "turn/completed"):
                turn_notifications.append(message)

    def verify_ready(started):
        actual = tuple(started[key] for key in ("model", "reasoningEffort", "modelProvider", "cwd"))
        assert actual == expected, "指定値と有効値が不一致"
        session = Path(next(line.split("isolated session ", 1)[1].strip()
                            for line in (base / "handoff.stderr").read_text().splitlines()
                            if "isolated session " in line))
        assert session.is_relative_to(base / "state/devshell-env/sessions")
        contexts = []
        for rollout in (session / "config/sessions").rglob(f"*{started['thread']['id']}*.jsonl"):
            for line in rollout.read_text().splitlines():
                # hidden reasoning や認証情報は抽出しない。
                if re.search(r'"type"\s*:\s*"turn_context"', line):
                    payload = json.loads(line)["payload"]
                    contexts.append({key: payload.get(key) for key in ("model", "effort", "cwd")})
        assert contexts, "対象 thread の turn_context がない"
        assert all((item["model"], item["effort"], item["cwd"]) == (expected[0], expected[1], root)
                   for item in contexts), "turn_context の設定が不一致"
        return contexts

    def assert_blocked(started, reason):
        try:
            verify_ready(started)
        except AssertionError as error:
            assert str(error) == reason, str(error)
        else:
            raise AssertionError("未確認の thread を受理した")

    def next_turn_message(thread_id, turn_id):
        while True:
            for index, message in enumerate(turn_notifications):
                params = message["params"]
                notification_turn_id = params.get("turnId")
                if notification_turn_id is None:
                    notification_turn_id = params["turn"]["id"]
                if params["threadId"] == thread_id and notification_turn_id == turn_id:
                    return turn_notifications.pop(index)
            message = receive()
            if message.get("method") in ("item/completed", "turn/completed"):
                turn_notifications.append(message)

    def turn(identifier, started, prompt):
        result = rpc(identifier, "turn/start", {"threadId": started["thread"]["id"],
                     "input": [{"type": "text", "text": prompt}]})
        answers = []
        while True:
            message = next_turn_message(started["thread"]["id"], result["turn"]["id"])
            if message.get("method") == "item/completed":
                item = message["params"]["item"]
                if item.get("type") == "agentMessage":
                    answers.append(item["text"])
            if message.get("method") == "turn/completed":
                params = message["params"]
                assert params["threadId"] == started["thread"]["id"]
                assert params["turn"]["id"] == result["turn"]["id"]
                assert params["turn"]["status"] == "completed"
                return "\n".join(answers)

    try:
        rpc(1, "initialize", {"clientInfo": {"name": "raw-handoff-test", "version": "1"}})
        send({"method": "initialized"})
        mismatched = rpc(2, "thread/start", {"cwd": root, "model": expected[0], "config": {"model_reasoning_effort": "high"}})
        assert_blocked(mismatched, "指定値と有効値が不一致")
        started = rpc(3, "thread/start", {"cwd": root, "model": expected[0]})
        assert_blocked(started, "対象 thread の turn_context がない")
        answer = turn(4, started, "読み取りのみの readiness 確認です。ファイルを編集せず pwd、git branch --show-current、git rev-parse HEAD、git rev-parse --path-format=absolute --git-dir --git-common-dir を実行し、結果と READY を返してください。task.sh はまだ実行しないでください。")
        assert "READY" in answer and root in answer and "task" in answer
        for arguments in (["rev-parse", "HEAD"], ["branch", "--show-current"],
                          ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]):
            values = subprocess.check_output(["git", *arguments], cwd=root, text=True).splitlines()
            assert all(value in answer for value in values), "readiness の Git 所属が不一致"
        contexts = verify_ready(started)
        fresh = rpc(5, "thread/start", {"cwd": root, "model": expected[0]})
        assert_blocked(fresh, "対象 thread の turn_context がない")
        assert not (base / "work/calculator.py").exists(), "gate より前に本タスクが実行された"
        verify_ready(started)
        answer = turn(6, started, "この working directory で bash task.sh を実行してください。fixture や権限を変更せず、成功したら HOSTED_RAW_OK とだけ返してください。失敗したらエラーを報告してください。")
        assert "HOSTED_RAW_OK" in answer
        contexts = verify_ready(started)
        assert len(contexts) >= 2
        print("HOSTED_RAW_TASK_OK HOSTED_RAW_OK")
        print(json.dumps({"thread_id": started["thread"]["id"], "turn_contexts": contexts}))
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=10)
    assert process.returncode == 0
