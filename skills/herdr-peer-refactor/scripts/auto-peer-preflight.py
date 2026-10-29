#!/usr/bin/env python3
"""Fail-closed preflight for the dedicated auto peer profiles."""

from __future__ import annotations

import argparse
import ast
import datetime as dt
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import tomllib


sys.dont_write_bytecode = True

SKILL_ROOT = Path(__file__).resolve().parents[1]
ASSETS = SKILL_ROOT / "assets/auto-peer"
CLAUDE_DENY = ASSETS / "auto-peer-deny.json"
CLAUDE_PROFILE = ASSETS / "claude-peer.settings.json"
CODEX_PROFILE = ASSETS / "codex-peer.config.toml"
CODEX_RULES = ASSETS / "auto-peer.rules"
PROBE_COMMAND = "treflebonbon-auto-policy-probe"
RECEIPT_VERSION = 1
RECEIPT_TTL = dt.timedelta(hours=24)
READ_ONLY_PERMISSIONS = {
    "contents": "read",
    "issues": "read",
    "metadata": "read",
    "pull_requests": "read",
}


class GuardError(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise GuardError(message)


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def digest_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def require_regular_file(path: Path, *, writable_by_others: bool = False) -> os.stat_result:
    try:
        info = path.lstat()
    except OSError as error:
        raise GuardError("required file is missing or unreadable") from error
    require(not stat.S_ISLNK(info.st_mode), "symlinked policy files are not accepted")
    require(stat.S_ISREG(info.st_mode), "policy path must be a regular file")
    require(info.st_uid == os.getuid(), "policy files must belong to the current user")
    if not writable_by_others:
        require(info.st_mode & 0o022 == 0, "policy files must not be writable by others")
    return info


def require_private_directory(path: Path) -> os.stat_result:
    try:
        info = path.lstat()
    except OSError as error:
        raise GuardError("required private directory is missing") from error
    require(not stat.S_ISLNK(info.st_mode), "private directory must not be a symlink")
    require(stat.S_ISDIR(info.st_mode), "private directory is not a directory")
    require(info.st_uid == os.getuid(), "private directory must belong to the current user")
    require(info.st_mode & 0o077 == 0, "private directory must not be accessible by group or others")
    return info


def require_owned_directory(path: Path) -> os.stat_result:
    try:
        info = path.lstat()
    except OSError as error:
        raise GuardError("required scratch directory is missing") from error
    require(not stat.S_ISLNK(info.st_mode), "scratch directory must not be a symlink")
    require(stat.S_ISDIR(info.st_mode), "scratch path is not a directory")
    require(info.st_uid == os.getuid(), "scratch directory must belong to the current user")
    require(info.st_mode & 0o022 == 0, "scratch directory must not be writable by others")
    return info


def child_environment(*, keep: set[str] = frozenset()) -> dict[str, str]:
    """Drop ambient credentials and Git context before invoking any CLI."""
    result = {
        key: value
        for key, value in os.environ.items()
        if key in keep
        or not re.search(r"(TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL)", key, re.IGNORECASE)
    }
    for key in list(result):
        if key.startswith("GIT_"):
            del result[key]
        if key.lower() in {"http_proxy", "https_proxy", "all_proxy"}:
            del result[key]
    return result


def run_cli(
    argv: list[str],
    *,
    env: dict[str, str],
    cwd: Path | None = None,
    timeout: int = 30,
    label: str,
) -> str:
    try:
        result = subprocess.run(
            argv,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GuardError(f"{label} could not be verified") from error
    if result.returncode != 0:
        raise GuardError(f"{label} did not pass")
    return result.stdout


def executable_identity(name: str, *, env: dict[str, str]) -> tuple[Path, str, str]:
    selected = shutil.which(name, path=env.get("PATH"))
    require(selected is not None, f"{name} CLI is unavailable")
    executable = Path(selected).resolve(strict=True)
    require(executable.is_file(), f"{name} CLI is not a regular executable")
    version_text = run_cli([str(executable), "--version"], env=env, label=f"{name} version")
    match = re.search(r"(?<!\d)(\d+)\.(\d+)\.(\d+)", version_text)
    require(match is not None, f"{name} version could not be identified")
    return executable, digest_file(executable), ".".join(match.groups())


def version_tuple(version: str) -> tuple[int, int, int]:
    return tuple(int(part) for part in version.split("."))


def claude_home(env: dict[str, str]) -> Path:
    home = Path(env["HOME"]).resolve(strict=True)
    expected = home / ".claude-peer"
    configured = Path(env.get("CLAUDE_CONFIG_DIR", ""))
    require(configured == expected, "CLAUDE_CONFIG_DIR must name the dedicated ~/.claude-peer home")
    require_private_directory(expected)
    return expected


def codex_home(env: dict[str, str]) -> tuple[Path, Path]:
    home = Path(env["HOME"]).resolve(strict=True)
    expected = home / ".codex-peer"
    configured = Path(env.get("CODEX_HOME", ""))
    require(configured == expected, "CODEX_HOME must name the dedicated ~/.codex-peer home")
    gh_expected = expected / "gh"
    gh_configured = Path(env.get("GH_CONFIG_DIR", ""))
    require(gh_configured == gh_expected, "GH_CONFIG_DIR must use the dedicated read-only credential home")
    require_private_directory(expected)
    require_private_directory(expected / "rules")
    require_private_directory(gh_expected)
    return expected, gh_expected


def load_peer_deny() -> tuple[str, list[dict[str, object]]]:
    tree = ast.parse(CODEX_RULES.read_text(encoding="utf-8"))
    values: dict[str, object] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            if node.targets[0].id in {"peer_deny", "AUTO_PEER_POLICY_PROBE"}:
                values[node.targets[0].id] = ast.literal_eval(node.value)
    require(isinstance(values.get("AUTO_PEER_POLICY_PROBE"), str), "policy probe is missing")
    require(isinstance(values.get("peer_deny"), list), "policy source is malformed")
    return str(values["AUTO_PEER_POLICY_PROBE"]), values["peer_deny"]


def claude_denied_commands() -> list[str]:
    _, records = load_peer_deny()
    result: list[str] = []
    for record in records:
        for command in record.get("claude_deny", []):
            if isinstance(command, str):
                result.append(command)
    return result


def codex_denied_commands() -> list[list[str]]:
    _, records = load_peer_deny()
    commands: list[list[str]] = []
    for record in records:
        for rule in record.get("codex", []):
            if isinstance(rule, dict):
                for example in rule.get("match", []):
                    if isinstance(example, str):
                        commands.append(shlex.split(example))
                    elif isinstance(example, list) and all(isinstance(token, str) for token in example):
                        commands.append(example)
    return commands


def expected_claude_settings() -> bytes:
    return CLAUDE_PROFILE.read_bytes()


def check_claude_settings(home: Path, settings: Path) -> str:
    expected = home / "auto-peer-settings.json"
    require(settings == expected, "Claude settings path must be the dedicated auto-peer settings file")
    require_regular_file(settings)
    data = settings.read_bytes()
    require(data == expected_claude_settings(), "Claude auto-peer settings differ from the published profile")
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError as error:
        raise GuardError("Claude auto-peer settings are invalid JSON") from error
    require(parsed.get("sandbox", {}).get("failIfUnavailable") is True, "Claude sandbox must fail closed")
    require(parsed.get("sandbox", {}).get("allowUnsandboxedCommands") is False, "Claude unsandboxed retry must be disabled")
    require(parsed.get("permissions", {}).get("blockReadsOutsideWorkingDirectories") is True, "Claude Bash reads must stay inside the worktree")
    deny = json.loads(CLAUDE_DENY.read_text(encoding="utf-8"))["permissions"]["deny"]
    require(parsed.get("permissions", {}).get("deny") == deny, "Claude deny rules are not the canonical policy projection")
    return digest_bytes(data)


def check_codex_assets(home: Path, gh_home: Path) -> tuple[str, str, str]:
    config = home / "config.toml"
    rules_dir = home / "rules"
    rules = rules_dir / "auto-peer.rules"
    attestation = home / "auto-peer-read-only-attestation.json"
    require_regular_file(config)
    require_regular_file(rules)
    require_regular_file(attestation)
    require(config.read_bytes() == CODEX_PROFILE.read_bytes(), "Codex dedicated profile differs from the published profile")
    require(rules.read_bytes() == CODEX_RULES.read_bytes(), "Codex auto-peer rules differ from the published policy")
    extra_rule_files = [path for path in rules_dir.iterdir() if path.suffix == ".rules" and path.name != rules.name]
    require(not extra_rule_files, "unexpected Codex rule files are present")
    try:
        config_data = tomllib.loads(config.read_text(encoding="utf-8"))
        attested = json.loads(attestation.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, json.JSONDecodeError) as error:
        raise GuardError("Codex profile or read-only attestation is malformed") from error
    filesystem = config_data.get("permissions", {}).get("dotfiles-peer", {}).get("filesystem", {})
    roots = filesystem.get(":workspace_roots", {})
    require(roots.get(".") == "read", "Codex peer workspace roots must be read-only")
    require(filesystem.get("/tmp/codex", {}).get(".") == "write", "Codex reply scratch access is missing")
    require(attested.get("credential_type") == "fine-grained personal access token", "attestation must name a fine-grained read-only token")
    require(attested.get("permissions") == READ_ONLY_PERMISSIONS, "GitHub credential permissions are not read-only")
    for key in ("repository", "verified_by", "activated_by"):
        value = attested.get(key)
        require(isinstance(value, str) and value.strip() and not value.lower().startswith("yyyy"), "read-only attestation is incomplete")
    for key in ("verified_at", "activated_at"):
        try:
            date = dt.date.fromisoformat(attested[key])
        except (KeyError, TypeError, ValueError) as error:
            raise GuardError("read-only attestation dates must be real ISO dates") from error
        require(date <= dt.date.today(), "read-only attestation date is in the future")
    require(attested["repository"].count("/") == 1, "attestation repository must be owner/name")
    gh_hosts = gh_home / "hosts.yml"
    require_regular_file(gh_hosts)
    return digest_file(config), digest_file(rules), digest_file(attestation)


def latest_tool_output(requests: list[dict[str, object]], call_id: str) -> str | None:
    for request in reversed(requests):
        for item in request.get("input", []):
            if isinstance(item, dict) and item.get("type") == "function_call_output" and item.get("call_id") == call_id:
                output = item.get("output")
                return output if isinstance(output, str) else None
    return None


def codex_git_paths(repo_root: Path, env: dict[str, str]) -> tuple[Path, Path]:
    git = shutil.which("git", path=env.get("PATH"))
    require(git is not None, "Git is unavailable")
    clean = child_environment(keep={"HOME", "PATH", "LANG", "LC_ALL", "TMPDIR"})
    clean.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull})
    try:
        top = subprocess.run([git, "-C", str(repo_root), "rev-parse", "--show-toplevel"], env=clean, capture_output=True, text=True, timeout=10, check=False)
        git_dir = subprocess.run([git, "-C", str(repo_root), "rev-parse", "--absolute-git-dir"], env=clean, capture_output=True, text=True, timeout=10, check=False)
        common_dir = subprocess.run([git, "-C", str(repo_root), "rev-parse", "--path-format=absolute", "--git-common-dir"], env=clean, capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GuardError("repository Git metadata could not be inspected") from error
    require(top.returncode == 0 and git_dir.returncode == 0 and common_dir.returncode == 0, "repository Git metadata could not be inspected")
    require(Path(top.stdout.strip()).resolve() == repo_root.resolve(), "preflight must run at the repository root")
    git_dir_path = Path(git_dir.stdout.strip()).resolve(strict=True)
    common_dir_path = Path(common_dir.stdout.strip()).resolve(strict=True)

    def pointer_target(path: Path, prefix: str = "") -> Path:
        try:
            info = path.lstat()
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            raise GuardError("linked Git worktree metadata could not be inspected") from error
        require(not stat.S_ISLNK(info.st_mode) and stat.S_ISREG(info.st_mode), "symlinked or invalid linked Git metadata is not accepted")
        require(len(lines) == 1 and lines[0].startswith(prefix), "linked Git metadata pointer is invalid")
        target_text = lines[0][len(prefix):].strip()
        require(bool(target_text), "linked Git metadata pointer is empty")
        try:
            return (path.parent / target_text).resolve(strict=True)
        except OSError as error:
            raise GuardError("linked Git metadata target could not be inspected") from error

    require(git_dir_path != common_dir_path, "Codex auto peer requires a linked Git worktree")
    require(git_dir_path.parent == common_dir_path / "worktrees", "linked Git worktree metadata is outside its common repository")
    require(pointer_target(repo_root / ".git", "gitdir:") == git_dir_path, "linked Git worktree pointer does not match")
    require(pointer_target(git_dir_path / "commondir") == common_dir_path, "linked Git common directory pointer does not match")
    require(pointer_target(git_dir_path / "gitdir") == (repo_root / ".git").resolve(strict=True), "linked Git backpointer does not match")
    return git_dir_path, common_dir_path


def create_codex_linked_fixture(env: dict[str, str], git: str) -> tuple[tempfile.TemporaryDirectory[str], Path]:
    """Create a disposable linked worktree outside the explicitly writable scratch root."""
    home = Path(env["HOME"]).resolve(strict=True)
    temporary = tempfile.TemporaryDirectory(prefix="auto-peer-codex-fixture.", dir=home)
    fixture_home = Path(temporary.name)
    primary = fixture_home / "primary"
    worktree = fixture_home / "linked"
    primary.mkdir(mode=0o700)
    git_env = child_environment(keep={"HOME", "PATH", "LANG", "LC_ALL", "TMPDIR"})
    git_env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull})

    commands = [
        [git, "init", "--quiet", str(primary)],
    ]
    for command in commands:
        try:
            result = subprocess.run(command, cwd=fixture_home, env=git_env, capture_output=True, timeout=10, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            temporary.cleanup()
            raise GuardError("disposable linked Git fixture could not be initialized") from error
        if result.returncode != 0:
            temporary.cleanup()
            raise GuardError("disposable linked Git fixture could not be initialized")

    (primary / "README.md").write_text("auto peer permission canary\n", encoding="utf-8")
    try:
        commands = [
            [git, "-C", str(primary), "add", "README.md"],
            [git, "-C", str(primary), "-c", "user.name=Auto Peer Canary", "-c", "user.email=auto-peer-canary@localhost", "commit", "--quiet", "-m", "canary fixture"],
            [git, "-C", str(primary), "worktree", "add", "--quiet", "-b", "auto-peer-canary", str(worktree), "HEAD"],
        ]
        for command in commands:
            result = subprocess.run(command, cwd=fixture_home, env=git_env, capture_output=True, timeout=10, check=False)
            if result.returncode != 0:
                temporary.cleanup()
                raise GuardError("disposable linked Git fixture could not be initialized")
        git_dir, common_dir = codex_git_paths(worktree, env)
        require(git_dir != common_dir and git_dir.parent == common_dir / "worktrees", "Codex canary fixture is not a linked worktree")
    except (OSError, subprocess.TimeoutExpired) as error:
        temporary.cleanup()
        raise GuardError("disposable linked Git fixture could not be initialized") from error
    return temporary, worktree


def codex_execpolicy_check(executable: Path, rules: Path, commands: list[list[str]], env: dict[str, str]) -> None:
    for command in commands:
        result = run_cli(
            [str(executable), "execpolicy", "check", "--rules", str(rules), "--", *command],
            env=env,
            label="Codex execpolicy evaluation",
        )
        try:
            decision = json.loads(result).get("decision")
        except json.JSONDecodeError as error:
            raise GuardError("Codex execpolicy returned invalid JSON") from error
        require(decision == "forbidden", "Codex execpolicy did not forbid every published deny example")


class CodexCanaryServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address: tuple[str, int], calls: list[dict[str, object]]):
        self.calls = calls
        self.requests: list[dict[str, object]] = []
        self.authorization_seen = False
        super().__init__(server_address, CodexCanaryHandler)


class CodexCanaryHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        has_authorization = any(name.lower() == "authorization" for name in self.headers.keys())
        self.server.authorization_seen = self.server.authorization_seen or has_authorization
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self.send_error(400)
            return
        outputs = [
            {"type": item["type"], "call_id": item.get("call_id"), "output": item.get("output")}
            for item in request.get("input", [])
            if isinstance(item, dict) and item.get("type") == "function_call_output"
        ]
        self.server.requests.append({"input": outputs})
        index = len(self.server.requests)
        if index <= len(self.server.calls):
            call = self.server.calls[index - 1]
            item = {
                "type": "function_call",
                "call_id": call["id"],
                "name": "exec_command",
                "arguments": json.dumps({"cmd": call["command"], "yield_time_ms": 1000, "max_output_tokens": 1200}),
            }
            events = [
                {"type": "response.created", "response": {"id": f"auto-peer-{index}", "status": "in_progress"}},
                {"type": "response.output_item.done", "item": item},
                {"type": "response.completed", "response": {"id": f"auto-peer-{index}", "usage": {"input_tokens": 0, "input_tokens_details": None, "output_tokens": 0, "output_tokens_details": None, "total_tokens": 0}}},
            ]
        else:
            events = [
                {"type": "response.created", "response": {"id": "auto-peer-finished", "status": "in_progress"}},
                {"type": "response.output_item.done", "item": {"type": "message", "role": "assistant", "id": "auto-peer-final", "content": [{"type": "output_text", "text": "policy canary finished"}]}},
                {"type": "response.completed", "response": {"id": "auto-peer-finished", "usage": {"input_tokens": 0, "input_tokens_details": None, "output_tokens": 0, "output_tokens_details": None, "total_tokens": 0}}},
            ]
        payload = "".join(f"data: {json.dumps(event, separators=(',', ':'))}\n\n" for event in events).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format: str, *args: object) -> None:
        return


def codex_session_canary(
    executable: Path,
    home: Path,
    repo_root: Path,
    env: dict[str, str],
) -> dict[str, str]:
    """Exercise the actual Codex session against a loopback-only model fixture."""
    require(platform.system() == "Linux", "Codex auto-peer session canary requires Linux sandbox support")
    require(shutil.which("touch", path=env.get("PATH")) is not None, "touch is required for the workspace canary")
    real_git = shutil.which("git", path=env.get("PATH"))
    require(real_git is not None, "Git is required for the raw-push canary")
    # Validate that this guard was invoked from the caller's repository root, but
    # exercise permissions only against an owned, disposable linked worktree.
    codex_git_paths(repo_root, env)
    require_private_directory(home)
    canary_home_temporary = tempfile.TemporaryDirectory(prefix="auto-peer-codex-home.", dir=Path(env["HOME"]).resolve(strict=True))
    canary_root = Path(canary_home_temporary.name)
    canary_home = canary_root / ".codex-peer"
    canary_home.mkdir(mode=0o700)
    (canary_home / "rules").mkdir(mode=0o700)
    (canary_home / "gh").mkdir(mode=0o700)
    (canary_home / "config.toml").write_bytes((home / "config.toml").read_bytes())
    (canary_home / "rules/auto-peer.rules").write_bytes((home / "rules/auto-peer.rules").read_bytes())
    (canary_home / "config.toml").chmod(0o600)
    (canary_home / "rules/auto-peer.rules").chmod(0o600)
    fixture_temporary, fixture_root = create_codex_linked_fixture(env, real_git)
    git_dir, common_dir = codex_git_paths(fixture_root, env)
    workspace_marker = fixture_root / f".codex-auto-peer-write-{secrets.token_hex(10)}"
    scratch_root = Path("/tmp/codex")
    require_owned_directory(scratch_root)
    scratch_temporary = tempfile.TemporaryDirectory(prefix="auto-peer-codex.", dir=scratch_root)
    scratch = Path(scratch_temporary.name)
    raw_marker = scratch / "raw-push-executed"
    fakebin = scratch / "bin"
    fakebin.mkdir(mode=0o700)
    fake_git = fakebin / "git"
    fake_git.write_text(
        "#!/bin/sh\n"
        f"if [ \"$1\" = push ]; then printf executed > {shlex.quote(str(raw_marker))}; exit 0; fi\n"
        f"exec {shlex.quote(str(Path(real_git).resolve()))} \"$@\"\n",
        encoding="utf-8",
    )
    fake_git.chmod(0o700)
    calls = [
        {"id": "auto-peer-read-control", "command": "git status --short"},
        {"id": "auto-peer-workspace-write", "command": f"{shutil.which('touch', path=env.get('PATH'))} {shlex.quote(str(workspace_marker))}"},
        {"id": "auto-peer-raw-push", "command": "git push origin HEAD"},
    ]
    server = CodexCanaryServer(("127.0.0.1", 0), calls)
    thread = threading.Thread(target=server.serve_forever, name="auto-peer-codex-canary", daemon=True)
    thread.start()
    provider = (
        "model_providers.mock={name=\"Local policy fixture\","
        f"base_url=\"http://127.0.0.1:{server.server_port}/v1\","
        "wire_api=\"responses\",requires_openai_auth=false,supports_websockets=false,"
        "request_max_retries=0,stream_max_retries=0}"
    )
    profile_paths = ", ".join(f"{json.dumps(str(path))}=\"read\"" for path in (git_dir, common_dir))
    mock_env = dict(env)
    mock_env.update(
        {
            "HOME": str(canary_root),
            "CODEX_HOME": str(canary_home),
            "GH_CONFIG_DIR": str(canary_home / "gh"),
            "PATH": f"{fakebin}:{env.get('PATH', '')}",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
        }
    )
    for key in ("OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"):
        mock_env.pop(key, None)
    arguments = [
        str(executable), "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--disable", "apps",
        "-C", str(fixture_root),
        "-c", 'model="mock-model"',
        "-c", 'model_provider="mock"',
        "-c", provider,
        "-c", "features.unified_exec=false",
        "-c", 'default_permissions="dotfiles-peer"',
        "-c", f"permissions.dotfiles-peer.filesystem={{{profile_paths}}}",
        "Run the supplied policy canary calls exactly as provided, then stop.",
    ]

    def cleanup_canary() -> None:
        if workspace_marker.exists():
            workspace_marker.unlink()
        scratch_temporary.cleanup()
        fixture_temporary.cleanup()
        canary_home_temporary.cleanup()

    try:
        try:
            result = subprocess.run(arguments, env=mock_env, cwd=fixture_root, capture_output=True, text=True, timeout=35, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise GuardError("Codex local policy canary did not finish") from error
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        require(result.returncode == 0, "Codex local policy canary session failed")
        events = []
        for line in result.stdout.splitlines():
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        require(any(event.get("type") == "turn.completed" for event in events), "Codex local policy canary did not complete a turn")
        require(len(server.requests) == 4, "Codex local policy canary did not complete every probe")
        require(not server.authorization_seen, "Codex local policy canary sent an Authorization header to its loopback provider")
        read_output = latest_tool_output(server.requests, "auto-peer-read-control")
        write_output = latest_tool_output(server.requests, "auto-peer-workspace-write")
        push_output = latest_tool_output(server.requests, "auto-peer-raw-push")
        require(read_output is not None and re.search(r"Process exited with code 0\b", read_output), "Codex could not read the disposable linked worktree metadata")
        require(write_output is not None and re.search(r"Process exited with code [1-9][0-9]*\b", write_output), "Codex workspace write was not refused")
        require(re.search(r"read-only file system|permission denied|operation not permitted|rejected\(", write_output, re.IGNORECASE) is not None, "Codex workspace write failed without a sandbox refusal")
        require(push_output is not None and re.search(r"rejected\(", push_output, re.IGNORECASE) is not None, "Codex raw push was not rejected by its active policy")
        require(not workspace_marker.exists(), "Codex wrote inside a read-only workspace")
        require(not raw_marker.exists(), "Codex raw push reached the fake Git executable")
        return {
            "workspace_read": "allowed",
            "workspace_write": "denied",
            "raw_push": "forbidden",
            "loopback_authorization": "absent",
        }
    finally:
        cleanup_canary()


def parse_claude_result(output: str) -> dict[str, object]:
    try:
        result = json.loads(output)
    except json.JSONDecodeError as error:
        raise GuardError("Claude Code returned invalid JSON for its canary") from error
    require(isinstance(result, dict), "Claude Code returned an unexpected canary result")
    return result


def claude_canary_invocation(
    executable: Path,
    *,
    settings: Path,
    cwd: Path,
    allowed: list[str],
    prompt: str,
    env: dict[str, str],
) -> dict[str, object]:
    argv = [
        str(executable),
        "--permission-mode", "dontAsk",
        "--permission-prompts", "none",
        "--print",
        "--output-format", "json",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--tools", "Bash",
        "--allowedTools", *allowed,
        "--settings", str(settings),
        "--max-turns", "5",
        "--max-budget-usd", "0.02",
        prompt,
    ]
    output = run_cli(argv, env=env, cwd=cwd, timeout=120, label="Claude runtime policy canary")
    return parse_claude_result(output)


def claude_session_canary(executable: Path, settings: Path, env: dict[str, str]) -> dict[str, object]:
    require(platform.system() in {"Linux", "Darwin"}, "Claude Bash sandbox is unsupported on this platform")
    require(shutil.which("bash", path=env.get("PATH")) is not None, "Bash is required for the Claude canary")
    root = Path("/tmp/codex")
    require_private_directory(root)
    temp_root = Path(tempfile.mkdtemp(prefix="auto-peer-claude.", dir=root))
    cwd = temp_root / "workspace"
    bindir = cwd / "bin"
    cwd.mkdir(mode=0o700)
    bindir.mkdir(mode=0o700)
    probe_marker = cwd / "probe-executed"
    outside_started = cwd / "outside-read-ran"
    outside_readable = cwd / "outside-settings-readable"
    push_marker = cwd / "raw-push-executed"
    probe = bindir / PROBE_COMMAND
    probe.write_text(f"#!/bin/sh\nprintf executed > {shlex.quote(str(probe_marker))}\n", encoding="utf-8")
    probe.chmod(0o700)
    outside_probe = bindir / "treflebonbon-outside-read-canary"
    outside_settings = shlex.quote(str(settings))
    outside_probe.write_text(
        "#!/bin/sh\n"
        f"printf ran > {shlex.quote(str(outside_started))}\n"
        f"if test -r {outside_settings}; then printf readable > {shlex.quote(str(outside_readable))}; fi\n",
        encoding="utf-8",
    )
    outside_probe.chmod(0o700)
    fake_git = bindir / "git"
    fake_git.write_text(
        "#!/bin/sh\n"
        f"if [ \"$1\" = push ]; then printf executed > {shlex.quote(str(push_marker))}; exit 0; fi\n"
        "exit 64\n",
        encoding="utf-8",
    )
    fake_git.chmod(0o700)
    baseline = json.loads(CLAUDE_PROFILE.read_text(encoding="utf-8"))
    baseline["permissions"]["deny"] = []
    baseline_path = temp_root / "baseline.settings.json"
    baseline_path.write_text(json.dumps(baseline), encoding="utf-8")
    canary_env = dict(env)
    canary_env.update(
        {
            "PATH": f"{bindir}:{env.get('PATH', '')}",
            "CLAUDE_CONFIG_DIR": str(settings.parent),
            "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB": "1",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
            "TMPDIR": str(cwd),
        }
    )
    for key in ("ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "GH_ENTERPRISE_TOKEN", "GH_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY"):
        canary_env.pop(key, None)
    try:
        control = claude_canary_invocation(
            executable,
            settings=baseline_path,
            cwd=cwd,
            allowed=[f"Bash({PROBE_COMMAND})", "Bash(treflebonbon-outside-read-canary)"],
            prompt=f"Run exactly these two commands in order: {PROBE_COMMAND}; treflebonbon-outside-read-canary. Do not run any other command.",
            env=canary_env,
        )
        require(probe_marker.exists(), "Claude no-deny control did not execute the harmless probe")
        require(outside_started.exists(), "Claude sandbox control command did not run")
        require(not outside_readable.exists(), "Claude Bash could read its settings outside the workspace")
        require(not control.get("permission_denials"), "Claude control unexpectedly denied its harmless command")
        probe_marker.unlink()
        outside_started.unlink()
        configured = claude_canary_invocation(
            executable,
            settings=settings,
            cwd=cwd,
            allowed=[f"Bash({PROBE_COMMAND})", "Bash(git push origin HEAD)"],
            prompt=f"Run exactly these two commands in order: {PROBE_COMMAND}; git push origin HEAD. Do not run any other command.",
            env=canary_env,
        )
        denials = configured.get("permission_denials")
        require(isinstance(denials, list), "Claude did not report runtime permission denials")
        denied_commands = {
            item.get("tool_input", {}).get("command")
            for item in denials
            if isinstance(item, dict) and item.get("tool_name") == "Bash" and isinstance(item.get("tool_input"), dict)
        }
        require(PROBE_COMMAND in denied_commands, "Claude active settings did not reject the canary command")
        require("git push origin HEAD" in denied_commands, "Claude active settings did not reject raw push")
        require(not probe_marker.exists(), "Claude canary command ran despite the deny rule")
        require(not push_marker.exists(), "Claude raw push reached the fake Git executable")
        return {"sandbox_outside_read": "denied", "configured_denials": [PROBE_COMMAND, "git push origin HEAD"]}
    finally:
        for path in (probe_marker, outside_started, outside_readable, push_marker, probe, outside_probe, fake_git, baseline_path):
            if path.exists():
                path.unlink()
        try:
            bindir.rmdir()
            cwd.rmdir()
            temp_root.rmdir()
        except OSError:
            pass


def claude_environment() -> tuple[Path, Path, dict[str, str], str, str]:
    env = child_environment(keep={"HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "CLAUDE_CONFIG_DIR"})
    home = claude_home(env)
    settings = home / "auto-peer-settings.json"
    settings_hash = check_claude_settings(home, settings)
    executable, executable_hash, version = executable_identity("claude", env=env)
    require(version_tuple(version) >= (2, 1, 268), "Claude Code 2.1.268 or newer is required for JSON auth status and no-prompt canaries")
    env["CLAUDE_CONFIG_DIR"] = str(home)
    auth_output = run_cli([str(executable), "auth", "status", "--json"], env=env, label="Claude dedicated authentication")
    try:
        auth = json.loads(auth_output)
    except json.JSONDecodeError as error:
        raise GuardError("Claude dedicated authentication status is invalid") from error
    require(isinstance(auth, dict) and auth.get("authMethod") not in (None, "none"), "Claude dedicated home is not authenticated")
    require(Path(str(auth.get("configDirectory", ""))) == home, "Claude authentication is not from the dedicated home")
    return executable, settings, env, settings_hash, executable_hash + ":" + version


def codex_environment(repository: str) -> tuple[Path, Path, Path, dict[str, str], str, str, str, str]:
    env = child_environment(keep={"HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "CODEX_HOME", "GH_CONFIG_DIR"})
    home, gh_home = codex_home(env)
    repository_root = Path.cwd().resolve(strict=True)
    codex_git_paths(repository_root, env)
    codex_hash, rules_hash, attestation_hash = check_codex_assets(home, gh_home)
    try:
        attestation = json.loads((home / "auto-peer-read-only-attestation.json").read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise GuardError("Codex read-only attestation is invalid") from error
    require(attestation.get("repository") == repository, "read-only credential attestation does not match the requested repository")
    executable, executable_hash, version = executable_identity("codex", env=env)
    auth_env = dict(env)
    auth_env.update({"CODEX_HOME": str(home)})
    run_cli([str(executable), "login", "status"], env=auth_env, label="Codex dedicated authentication")
    gh_env = dict(env)
    gh_env["GH_CONFIG_DIR"] = str(gh_home)
    run_cli(["gh", "auth", "status", "--active", "--hostname", "github.com"], env=gh_env, cwd=repository_root, label="GitHub read-only credential status")
    actual_repository = run_cli(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], env=gh_env, cwd=repository_root, label="GitHub repository identity").strip()
    require(actual_repository == repository, "current repository does not match the read-only credential scope")
    return executable, home, gh_home, env, codex_hash, rules_hash, attestation_hash, executable_hash + ":" + version


def receipt_path(path_value: str) -> Path:
    path = Path(path_value).absolute()
    require(not is_within(path, SKILL_ROOT), "receipt must be stored outside the installed package")
    require(path.parent.exists(), "receipt parent directory must already exist")
    require_private_directory(path.parent)
    require(not path.exists() and not path.is_symlink(), "receipt path already exists")
    return path


def write_receipt(path: Path, payload: dict[str, object]) -> None:
    data = (json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as error:
        raise GuardError("preflight receipt could not be created") from error
    with os.fdopen(descriptor, "wb") as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    path.chmod(0o400)


def read_receipt(path: Path, runtime: str) -> dict[str, object]:
    info = require_regular_file(path)
    require(info.st_mode & 0o222 == 0, "preflight receipt must be read-only")
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise GuardError("preflight receipt is invalid") from error
    require(isinstance(receipt, dict) and receipt.get("version") == RECEIPT_VERSION, "preflight receipt version is unsupported")
    require(receipt.get("runtime") == runtime, "preflight receipt is for another runtime")
    try:
        created = dt.datetime.fromisoformat(receipt["created_at"])
    except (KeyError, TypeError, ValueError) as error:
        raise GuardError("preflight receipt timestamp is invalid") from error
    require(dt.datetime.now(dt.timezone.utc) - created <= RECEIPT_TTL, "preflight receipt has expired")
    require(receipt.get("uid") == os.getuid(), "preflight receipt belongs to another user")
    return receipt


def make_receipt(runtime: str, payload: dict[str, object]) -> dict[str, object]:
    return {
        "version": RECEIPT_VERSION,
        "runtime": runtime,
        "uid": os.getuid(),
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        **payload,
    }


def claude_preflight(settings_arg: str, receipt_arg: str) -> None:
    out = receipt_path(receipt_arg)
    requested_settings = Path(settings_arg).absolute()
    executable, settings, env, settings_hash, runtime_identity = claude_environment()
    require(requested_settings == settings, "use the dedicated Claude auto-peer settings file")
    observed = claude_session_canary(executable, settings, env)
    write_receipt(
        out,
        make_receipt(
            "claude",
            {
                "home_sha256": digest_bytes(str(settings.parent).encode()),
                "settings_sha256": settings_hash,
                "runtime_identity": runtime_identity,
                "observed": observed,
            },
        ),
    )


def codex_preflight(repository: str, receipt_arg: str) -> None:
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) is not None, "repository must be owner/name")
    out = receipt_path(receipt_arg)
    executable, home, _gh_home, env, config_hash, rules_hash, attestation_hash, runtime_identity = codex_environment(repository)
    rules = home / "rules/auto-peer.rules"
    codex_execpolicy_check(executable, rules, codex_denied_commands(), env)
    observed = codex_session_canary(executable, home, Path.cwd().resolve(strict=True), env)
    write_receipt(
        out,
        make_receipt(
            "codex",
            {
                "repository": repository,
                "home_sha256": digest_bytes(str(home).encode()),
                "config_sha256": config_hash,
                "rules_sha256": rules_hash,
                "attestation_sha256": attestation_hash,
                "runtime_identity": runtime_identity,
                "observed": observed,
            },
        ),
    )


def verify_claude(settings_arg: str, receipt_arg: str) -> None:
    receipt = read_receipt(Path(receipt_arg), "claude")
    executable, settings, env, settings_hash, runtime_identity = claude_environment()
    require(Path(settings_arg).absolute() == settings, "Claude settings path changed")
    require(receipt.get("settings_sha256") == settings_hash, "Claude settings changed after preflight")
    require(receipt.get("runtime_identity") == runtime_identity, "Claude CLI changed after preflight")
    require(receipt.get("home_sha256") == digest_bytes(str(settings.parent).encode()), "Claude dedicated home changed after preflight")
    require(receipt.get("observed", {}).get("configured_denials") == [PROBE_COMMAND, "git push origin HEAD"], "Claude receipt lacks runtime denial evidence")
    observed = claude_session_canary(executable, settings, env)
    require(observed == receipt["observed"], "Claude active policy canary no longer matches its preflight receipt")


def verify_codex(repository: str, receipt_arg: str) -> None:
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) is not None, "repository must be owner/name")
    receipt = read_receipt(Path(receipt_arg), "codex")
    executable, home, _gh_home, env, config_hash, rules_hash, attestation_hash, runtime_identity = codex_environment(repository)
    require(receipt.get("repository") == repository, "Codex receipt is for another repository")
    require(receipt.get("home_sha256") == digest_bytes(str(home).encode()), "Codex dedicated home changed after preflight")
    require(receipt.get("config_sha256") == config_hash, "Codex profile changed after preflight")
    require(receipt.get("rules_sha256") == rules_hash, "Codex rules changed after preflight")
    require(receipt.get("attestation_sha256") == attestation_hash, "read-only credential attestation changed after preflight")
    require(receipt.get("runtime_identity") == runtime_identity, "Codex CLI changed after preflight")
    codex_execpolicy_check(executable, home / "rules/auto-peer.rules", codex_denied_commands(), env)
    observed = codex_session_canary(executable, home, Path.cwd().resolve(strict=True), env)
    require(
        observed == {
            "workspace_read": "allowed",
            "workspace_write": "denied",
            "raw_push": "forbidden",
            "loopback_authorization": "absent",
        },
        "Codex active-session policy canary failed",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify the dedicated auto peer's active runtime policy before launch.")
    subparsers = parser.add_subparsers(dest="action", required=True)
    claude = subparsers.add_parser("claude")
    claude.add_argument("--settings", required=True)
    claude.add_argument("--receipt", required=True)
    codex = subparsers.add_parser("codex")
    codex.add_argument("--repository", required=True)
    codex.add_argument("--receipt", required=True)
    verify = subparsers.add_parser("verify")
    verify.add_argument("--runtime", choices=("claude", "codex"), required=True)
    verify.add_argument("--settings")
    verify.add_argument("--repository")
    verify.add_argument("--receipt", required=True)
    args = parser.parse_args()
    if args.action == "claude":
        claude_preflight(args.settings, args.receipt)
    elif args.action == "codex":
        codex_preflight(args.repository, args.receipt)
    elif args.runtime == "claude":
        require(args.settings is not None, "Claude receipt verification requires --settings")
        verify_claude(args.settings, args.receipt)
    else:
        require(args.repository is not None, "Codex receipt verification requires --repository")
        verify_codex(args.repository, args.receipt)
    print("auto-peer preflight passed")


if __name__ == "__main__":
    try:
        main()
    except (GuardError, OSError, ValueError, KeyError) as error:
        print(f"auto-peer preflight held: {error}", file=sys.stderr)
        sys.exit(1)
