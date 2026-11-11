"""Opt-in native skill sessions and offline checks of their tool evidence."""

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import signal
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
SKILLS = sorted(path.parent.name for path in (ROOT / "skills").glob("*/SKILL.md"))
RUNTIMES = ("claude", "codex", "agy")


def codex_read(command):
    """Accept only a direct cat command, never arbitrary successful shell text."""
    def words(script):
        lexer = shlex.shlex(script, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        lexer.commenters = ""
        return list(lexer)

    argv = words(command)
    if len(argv) == 3 and Path(argv[0]).name in ("bash", "sh", "zsh") and argv[1] in ("-lc", "-c"):
        argv = words(argv[2])
    if len(argv) == 3 and argv[:2] == ["cat", "--"]:
        path = argv[2]
    elif len(argv) == 2 and argv[0] == "cat":
        path = argv[1]
    else:
        return None
    return None if any(char in path for char in "$`*?[]{}") else path


def official_invocation(command, runtime, skill):
    """Verify the recorded native command requested the namespaced skill explicitly."""
    if not isinstance(command, list) or not command or not all(isinstance(arg, str) for arg in command):
        return False
    continuation_flags = ("resume", "--resume", "--continue", "--conversation")
    if runtime != "codex":
        continuation_flags += ("-c",)
    if Path(command[0]).name != runtime or any(arg in command for arg in continuation_flags):
        return False
    prefix = ("$" if runtime == "codex" else "/") + f"treflebonbon-skills:{skill} "
    if runtime == "codex":
        return len(command) > 2 and command[1] == "exec" and "--ephemeral" in command and command[-1].startswith(prefix)
    flags = [index for index, arg in enumerate(command) if arg in ("-p", "--print")]
    return len(flags) == 1 and flags[0] + 1 < len(command) and command[flags[0] + 1].startswith(prefix)


def check_case(runtime, skill, events, inventory, process):
    """Require inventory, native completion and successful reads of both files."""
    reads = []
    complete = False
    tools = {}
    detected = False
    session_id = None
    session_ids = set()
    if runtime == "agy":
        names = [line.split("\t", 1)[0] for line in inventory.get("response", "").splitlines()]
        detected = inventory.get("status") == "SUCCESS" and f"treflebonbon-skills:{skill}" in names
    elif runtime == "codex":
        detected = any(
            plugin.get("name") == "treflebonbon-skills"
            and plugin.get("installed") is True and plugin.get("enabled") is True
            for plugin in inventory.get("installed", [])
        )
    for event in events:
        if runtime == "claude":
            if event.get("type") == "system" and event.get("subtype") == "init":
                detected = f"treflebonbon-skills:{skill}" in event.get("skills", [])
                session_id = event.get("session_id")
            for content in event.get("message", {}).get("content", []):
                if content.get("type") == "tool_use":
                    tools[content["id"]] = content
                if content.get("type") == "tool_result" and not content.get("is_error"):
                    tool = tools.get(content.get("tool_use_id"), {})
                    if tool.get("name") == "Read":
                        reads.append(tool.get("input", {}).get("file_path", ""))
            if event.get("type") == "result":
                complete = event.get("subtype") == "success" and event.get("is_error") is False
        elif runtime == "codex":
            if event.get("type") == "thread.started":
                session_id = event.get("thread_id")
            item = event.get("item", {})
            if (event.get("type") == "item.completed" and item.get("type") == "command_execution"
                    and item.get("exit_code") == 0 and item.get("aggregated_output")):
                reads.append(codex_read(item.get("command", "")))
            if event.get("type") == "turn.completed":
                complete = True
            elif event.get("type") in ("turn.failed", "error"):
                complete = False
        else:
            if event.get("event") == "init":
                session_id = event.get("conversation_id")
            step = event.get("step_update", {})
            tool = step.get("tool_info", {})
            if (step.get("state") == "DONE" and tool.get("name") == "read_file"
                and re.fullmatch(r"\d+ lines, \d+ bytes", tool.get("output", ""))):
                reads.append(tool.get("parameters", {}).get("Path", ""))
            if event.get("event") == "result":
                complete = event.get("result", {}).get("status") == "SUCCESS"
        if isinstance(session_id, str) and session_id:
            session_ids.add(session_id)
    reads = list(dict.fromkeys(
        str(PurePosixPath(path)) for path in reads
        if isinstance(path, str) and PurePosixPath(path).is_absolute()
        and ".." not in PurePosixPath(path).parts
    ))
    suffix = f"/skills/{skill}/SKILL.md"
    skill_paths = [path for path in reads if path.endswith(suffix)]
    skill_path = skill_paths[0] if len(skill_paths) == 1 else None
    resources = [
        path for path in reads
        if skill_path and path != skill_path
        and path.startswith(skill_path.removesuffix("SKILL.md"))
    ]
    reasons = []
    if not official_invocation(process.get("command"), runtime, skill):
        reasons.append("official_invocation_missing")
    if len(session_ids) != 1:
        reasons.append("session_id_missing_or_ambiguous")
    if not detected:
        reasons.append("skill_not_detected")
    if process.get("exit_code") != 0:
        reasons.append("process_failed")
    if not complete:
        reasons.append("incomplete_session")
    if not skill_path:
        reasons.append("skill_not_read")
    if not resources:
        reasons.append("resource_not_read")
    return {
        "runtime": runtime, "skill": skill,
        "session_id": session_id,
        "status": "failed" if reasons else "passed", "reasons": reasons,
        "observed_read_paths": reads,
        "skill_path": skill_path, "resource_paths": resources,
        "dependencies_status": "unconfirmed", "auxiliary_status": "unconfirmed",
    }


def read_case(directory):
    """Convert malformed or missing evidence to a non-success JSON result."""
    try:
        process = json.loads((directory / "process.json").read_text())
        runtime, skill = process["runtime"], process["skill"]
        if runtime not in RUNTIMES or skill not in SKILLS:
            raise ValueError("invalid_case")
        if type(process.get("exit_code")) is not int:
            raise ValueError("invalid_exit_code")
        events = [json.loads(line) for line in (directory / "events.jsonl").read_text().splitlines() if line.strip()]
        inventory = json.loads((directory.parent / "inventory.json").read_text())
        return check_case(runtime, skill, events, inventory, process)
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        return {"status": "unconfirmed", "reasons": ["invalid_evidence"]}


def write_json(path, value):
    """Keep session metadata private and refuse to replace an existing artifact."""
    with path.open("x", encoding="utf-8") as output:
        path.chmod(0o600)
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write("\n")


def inventory_for(runtime, executable):
    """Read native inventory without persisting unrelated installed plugins."""
    if runtime == "claude":
        return {}  # Each session's init event supplies the actual skill inventory.
    command = ([executable, "plugin", "list", "--json"] if runtime == "codex" else
               [executable, "--print", "/skills", "--output-format", "json"])
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError("inventory_unavailable")
    document = json.loads(result.stdout)
    if runtime == "codex":
        return {"installed": [plugin for plugin in document.get("installed", [])
                              if plugin.get("name") == "treflebonbon-skills"]}
    return {"status": document.get("status"), "response": "\n".join(
        line.split("\t", 1)[0] for line in document.get("response", "").splitlines()
        if line.startswith("treflebonbon-skills:")
    )}


def session_command(runtime, executable, skill, timeout):
    """Use native explicit invocation with file reads and no workflow side effects."""
    invocation = ("$" if runtime == "codex" else "/") + "treflebonbon-skills:" + skill
    prompt = invocation + " " + (
        "新規セッションの受入確認です。今回は正式名で指定した skill の検出・読込と同梱資源の解決だけを確認します。"
        "この明示的な範囲指定を skill の一般的な業務ワークフローより優先してください。"
        "native metadata で検出したインストール済み SKILL.md を、起動時に本文が展開済みでも、実ファイルとして Read/file tool で改めて読んでください。"
        "その directory を起点に同梱 reference を1件、別の tool call で読んで終了してください。"
        "rop は references/rust.md、それ以外は reference が無ければ DEPENDENCIES.md または helper source を選んでください。"
        "Codex は各ファイルを別々の tool call で、単独の cat -- <絶対パス> により読んでください。"
        "未検出なら配布元や別コピーへの迂回をせず、そのまま報告してください。"
        "補助 CLI・第三者依存 skill は存在確認できた範囲だけ報告し、未確認を成功扱いしないでください。"
        "ファイル変更、削除、Git操作、他エージェント起動、browser起動、外部書込、credential読取は行わないでください。"
    )
    if runtime == "claude":
        return [executable, "-p", prompt, "--tools", "Read", "--allowedTools", "Read",
                "--permission-prompts", "none", "--no-session-persistence",
                "--output-format", "stream-json", "--verbose"]
    if runtime == "codex":
        return [executable, "exec", "--json", "--ephemeral", "--skip-git-repo-check",
                "--sandbox", "read-only", prompt]
    return [executable, "--print", prompt, "--mode", "plan", "--output-format", "stream-json",
            "--print-timeout", f"{timeout}s"]


def capture_session(command, directory, timeout):
    """Preserve separate private streams and stop the owned process group on timeout."""
    with (directory / "events.jsonl").open("x") as output, (directory / "stderr.log").open("x") as error:
        (directory / "events.jsonl").chmod(0o600)
        (directory / "stderr.log").chmod(0o600)
        try:
            process = subprocess.Popen(command, cwd=directory, stdin=subprocess.DEVNULL,
                                       stdout=output, stderr=error, start_new_session=True)
        except OSError:
            return 127
        try:
            return process.wait(timeout=timeout)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            finally:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            if isinstance(error, KeyboardInterrupt):
                raise
            return 124


def run_sessions(args):
    """Run selected native sessions, retaining failures instead of skipping cases."""
    output = args.output_dir.resolve()
    if output == ROOT or ROOT in output.parents:
        raise ValueError("output_inside_payload")
    if output.exists():
        raise ValueError("output_exists")
    output.mkdir(mode=0o700)
    records = []
    versions = {}
    session_ids = set()
    for runtime in dict.fromkeys(args.runtime or RUNTIMES):
        directory = output / runtime
        directory.mkdir(mode=0o700)
        executable = shutil.which(runtime)
        inventory = {}
        failure = None
        try:
            if not executable:
                raise ValueError("cli_unavailable")
            version = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=30)
            if version.returncode:
                raise ValueError("version_unavailable")
            versions[runtime] = {"path": executable, "version": version.stdout.strip()[:256]}
            inventory = inventory_for(runtime, executable)
        except (OSError, ValueError, TypeError, AttributeError, subprocess.TimeoutExpired):
            failure = "cli_or_inventory_unavailable"
        write_json(directory / "inventory.json", inventory)
        for skill in dict.fromkeys(args.skill or SKILLS):
            case = directory / skill
            case.mkdir(mode=0o700)
            if failure:
                record = {"runtime": runtime, "skill": skill, "status": "unconfirmed", "reasons": [failure]}
            else:
                command = session_command(runtime, executable, skill, args.timeout)
                code = capture_session(command, case, args.timeout)
                write_json(case / "process.json", {"runtime": runtime, "skill": skill,
                                                   "command": command, "exit_code": code})
                record = read_case(case)
                session_id = record.get("session_id")
                if session_id and session_id in session_ids:
                    record["status"] = "failed"
                    record["reasons"].append("session_reused")
                if session_id:
                    session_ids.add(session_id)
            write_json(case / "result.json", record)
            records.append(record)
            print(f"{runtime}/{skill}: {record['status']}", file=sys.stderr, flush=True)
    report = {"passed": sum(record["status"] == "passed" for record in records),
              "expected": len(records), "versions": versions, "cases": records}
    report["status"] = "passed" if report["passed"] == report["expected"] else "failed"
    write_json(output / "summary.json", report)
    return report


def main():
    """Expose offline checks and explicitly opted-in native model sessions."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check")
    check.add_argument("case", type=Path)
    run = commands.add_parser("run", help="実モデルを呼ぶ opt-in 検証")
    run.add_argument("--output-dir", type=Path, required=True)
    run.add_argument("--runtime", choices=RUNTIMES, action="append")
    run.add_argument("--skill", choices=SKILLS, action="append")
    run.add_argument("--timeout", type=int, default=240)
    args = parser.parse_args()
    try:
        if args.command == "run":
            if args.timeout <= 0:
                raise ValueError("invalid_timeout")
            record = run_sessions(args)
        else:
            record = read_case(args.case)
    except (OSError, ValueError, TypeError, AttributeError) as error:
        reason = str(error) if str(error) in {"output_exists", "output_inside_payload", "invalid_timeout"} else "execution_unconfirmed"
        record = {"status": "unconfirmed", "reasons": [reason]}
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0 if record["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
