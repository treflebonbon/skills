#!/usr/bin/env python3
"""Exercise explicit worktree input admission for the #270 isolation prototype."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import runpy
import shlex
import shutil
import ssl
import stat
import subprocess
import sys
import tempfile
import tomllib
import uuid


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PACKAGE_ROOT / "lib/python"))
from treflebonbon_skills import devshell_environment  # noqa: E402
from treflebonbon_skills.devshell_environment import (  # noqa: E402
    InvalidContext,
    Repository,
    selected_output,
    trust_file,
    trusted,
)

BIN = PACKAGE_ROOT / "bin"
HELPER = BIN / "devshell-env"
INNER = runpy.run_path(str(Path(__file__).with_name("codex-inner.py")))


def toml_value(value):
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(
                json.dumps(key) + "=" + toml_value(item) for key, item in value.items()
            )
            + "}"
        )
    if isinstance(value, list):
        return "[" + ",".join(map(toml_value, value)) + "]"
    if isinstance(value, (str, bool, int, float)):
        return json.dumps(value, ensure_ascii=False)
    raise ValueError("unsupported public configuration value")


def toml_document(value):
    lines = []

    def table(values, path):
        if path:
            lines.append("[" + ".".join(map(json.dumps, path)) + "]")
        for key, item in values.items():
            if not isinstance(item, dict):
                lines.append(json.dumps(key) + "=" + toml_value(item))
        for key, item in values.items():
            if isinstance(item, dict):
                table(item, [*path, key])

    table(value, [])
    return "\n".join(lines) + "\n"


def input_policy(repo):
    directory = trust_file(repo).parent.parent / "inputs"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if (
        directory.is_symlink()
        or directory.stat().st_uid != os.getuid()
        or directory.stat().st_mode & 0o077
    ):
        raise ValueError("input state must be private to the current user")
    return directory / (hashlib.sha256(os.fsencode(repo.root)).hexdigest() + ".json")


def managed_mcp(config, selected):
    """Select the managed stdio contracts, never an arbitrary host env or URL."""
    contracts = {
        "context7": ("bunx", ["-y", "@upstash/context7-mcp"], ("bunx", "node")),
        "serena": (
            "uvx",
            [
                "--from",
                "git+https://github.com/oraios/serena",
                "serena",
                "start-mcp-server",
                "--enable-web-dashboard",
                "false",
            ],
            ("uvx",),
        ),
    }
    servers, tools = {}, {}
    for name in selected:
        command, arguments, required_tools = contracts[name]
        entry = config.get("mcp_servers", {}).get(name, {})
        if entry != {"command": command, "args": arguments}:
            raise ValueError(
                f"managed MCP configuration differs: {name}; review it on the host"
            )
        for tool in required_tools:
            path = shutil.which(tool)
            resolved = Path(path).resolve(strict=True) if path else None
            if resolved is None or not resolved.is_relative_to("/nix/store"):
                raise ValueError(f"managed MCP requires a Nix store tool: {tool}")
            # Preserve argv[0] inside the copied store, independent of host profiles.
            alias = resolved.parent / tool
            if alias.resolve(strict=True) != resolved:
                raise ValueError(f"managed MCP requires the Nix store alias: {tool}")
            tools[tool] = str(alias)
        servers[name] = {
            "command": tools[command],
            "args": arguments,
            "enabled": True,
            "required": True,
            "startup_timeout_sec": 180,
            "env_vars": ["HTTPS_PROXY", "HTTP_PROXY", "SSL_CERT_FILE"],
        }
    return servers, tools


def raw_filesystem_profile(profile, repo):
    """Keep only the managed policy that the raw namespace can represent."""
    filesystem = profile.get("filesystem")
    if not isinstance(filesystem, dict):
        raise ValueError("managed filesystem policy must be a table")

    host_roots = set()
    home = os.environ.get("HOME")
    for name in (
        "HOME",
        "CODEX_HOME",
        "GH_CONFIG_DIR",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_RUNTIME_DIR",
    ):
        value = os.environ.get(name)
        if value is None:
            continue
        path = PurePosixPath(value)
        if (
            not path.is_absolute()
            or str(path) != value
            or ".." in path.parts
            or path == PurePosixPath("/")
        ):
            raise ValueError(
                "managed filesystem roots must be canonical absolute paths"
            )
        host_roots.add(path)

    def host_read_policy(value):
        if isinstance(value, str):
            return value in ("read", "deny")
        return isinstance(value, dict) and all(
            isinstance(key, str) and key not in ("", "..") and host_read_policy(mode)
            for key, mode in value.items()
        )

    def workspace_policy(value):
        return (
            isinstance(value, dict)
            and value.get(".") == "write"
            and all(
                isinstance(key, str) and key not in ("", ".", "..") and mode == "deny"
                for key, mode in value.items()
                if key != "."
            )
        )

    metadata_paths = {
        PurePosixPath(repo.git_dir),
        PurePosixPath(repo.common_dir),
    }
    exposed_roots = {
        PurePosixPath(repo.root),
        PurePosixPath(repo.git_dir),
        PurePosixPath(repo.common_dir),
    }

    def namespace_policy(value, modes):
        if isinstance(value, str):
            return value in modes
        if not isinstance(value, dict):
            return False
        return all(
            isinstance(key, str)
            and key
            and not key.startswith("/")
            and ".." not in PurePosixPath(key).parts
            and namespace_policy(mode, modes)
            for key, mode in value.items()
        )

    projected = {}

    def add_projected_path(path, value):
        key = str(path)
        if key in projected:
            raise ValueError(
                "managed filesystem contains duplicate normalized path grants"
            )
        projected[key] = value

    for key, value in filesystem.items():
        if key == "glob_scan_max_depth":
            if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                raise ValueError("managed filesystem scan depth is invalid")
            projected[key] = value
            continue
        if key == ":root":
            if value != "deny":
                raise ValueError("raw filesystem root access must remain denied")
            projected[key] = value
            continue
        if key == ":minimal":
            if value != "read":
                raise ValueError("raw minimal filesystem access must remain read-only")
            projected[key] = value
            continue
        if key == ":slash_tmp":
            if value != "deny":
                raise ValueError("raw host /tmp access must remain denied")
            projected[key] = value
            continue
        if key == ":workspace_roots":
            if not workspace_policy(value):
                raise ValueError(
                    "raw workspace policy must grant writes with deny rules only"
                )
            projected[key] = value
            continue
        home_grant = key == "~" or key.startswith("~/")
        path_value = key
        if home_grant:
            if not home:
                raise ValueError("managed home grants cannot be projected without HOME")
            path_value = home + key[1:]
        elif key.startswith("~"):
            raise ValueError("managed filesystem contains an unsupported home grant")

        path = PurePosixPath(path_value)
        if not path.is_absolute() or str(path) != path_value or ".." in path.parts:
            raise ValueError("managed filesystem contains an invalid path grant")

        if path in metadata_paths:
            if not namespace_policy(value, {"read", "write", "deny"}):
                raise ValueError("raw Git metadata policy is invalid")
            add_projected_path(path, value)
            continue
        if any(path == root or path.is_relative_to(root) for root in exposed_roots):
            if not namespace_policy(value, {"read", "write", "deny"}):
                raise ValueError("raw public filesystem policy is invalid")
            add_projected_path(path, value)
            continue
        if path == PurePosixPath("/nix"):
            if value != "read":
                raise ValueError("raw Nix runtime access must remain read-only")
            add_projected_path(path, value)
            continue
        if path.is_relative_to(PurePosixPath("/nix")):
            if not namespace_policy(value, {"read", "deny"}):
                raise ValueError("raw Nix filesystem policy must remain read-only")
            add_projected_path(path, value)
            continue
        if path == PurePosixPath("/tmp/codex"):
            if not workspace_policy(value):
                raise ValueError(
                    "raw private scratch policy must grant writes with deny rules only"
                )
            add_projected_path(path, value)
            continue
        if any(path == root or path.is_relative_to(root) for root in host_roots):
            if not host_read_policy(value):
                raise ValueError(
                    "host filesystem grants must be read-only before projection"
                )
            continue
        raise ValueError("managed filesystem contains an unrecognized namespace grant")

    if "/tmp/codex" not in projected:
        raise ValueError("managed filesystem must allow private /tmp/codex scratch")
    return projected, True


def enable_raw_git_metadata(filesystem, repo):
    """Grant Git writes without discarding path-specific metadata denials."""
    for path in (repo.git_dir, repo.common_dir):
        key = str(path)
        existing = filesystem.get(key)
        if existing is None:
            filesystem[key] = "write"
        elif existing == "write":
            continue
        elif isinstance(existing, dict):
            if existing.get(".", "write") != "write":
                raise ValueError("raw Git metadata root must remain writable")
            existing["."] = "write"
        else:
            raise ValueError("raw Git metadata root must remain writable")


def admit(repo, head, names, *, mcp=(), github_policy=None):
    """Human-only declaration of public project bytes and managed runtime policy."""
    policy = input_policy(repo)
    codex_home = Path(
        os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))
    ).resolve(strict=True)
    if codex_home.is_relative_to(repo.root) or codex_home.is_relative_to(
        repo.common_dir
    ):
        raise ValueError("Codex configuration must be outside the project")
    config = tomllib.loads(read_input(codex_home, "config.toml")[0].decode())
    profiles = config.pop("permissions", {})
    if not isinstance(profiles, dict):
        raise ValueError("managed permission profiles must be a table")
    profile = profiles.get("dotfiles-secure", {})
    if (
        not isinstance(profile, dict)
        or profile.get("extends") != ":workspace"
        or not isinstance(profile.get("network"), dict)
        or profile["network"].get("enabled") is not True
        or not isinstance(profile["network"].get("domains"), dict)
    ):
        raise ValueError(
            "managed dotfiles-secure filesystem and network policy is required"
        )
    domain_rules = profile["network"]["domains"]
    if any(
        not isinstance(name, str) or mode not in ("allow", "deny")
        for name, mode in domain_rules.items()
    ):
        raise ValueError("managed network domain policy is invalid")
    domains = [name for name, mode in domain_rules.items() if mode == "allow"]
    if not domains:
        raise ValueError("managed network domain policy is required")
    profile["filesystem"], private_tmp_codex = raw_filesystem_profile(profile, repo)
    profile["workspace_roots"] = {}
    enable_raw_git_metadata(profile["filesystem"], repo)
    config["default_permissions"] = "dotfiles-secure"
    servers, mcp_tools = managed_mcp(config, mcp)
    config["mcp_servers"] = servers
    config["plugins"] = {name: {"enabled": False} for name in config.get("plugins", {})}
    github, push_helper = None, None
    if github_policy is not None:
        if github_policy.resolve().is_relative_to(
            repo.root
        ) or github_policy.resolve().is_relative_to(repo.common_dir):
            raise ValueError("GitHub policy must be owned outside the project")
        module = runpy.run_path(str(Path(__file__).with_name("github-service.py")))
        github = module["validate_policy"](
            json.loads(read_input(github_policy.parent, github_policy.name)[0])
        )
        if (
            git(repo.root, "branch", "--show-current").decode().strip()
            != github["branch"]
        ):
            raise ValueError("GitHub policy belongs to another topic branch")
        remote = git(repo.root, "remote", "get-url", "origin").decode().strip()
        if remote not in (
            "https://github.com/" + github["repository"],
            "https://github.com/" + github["repository"] + ".git",
        ):
            raise ValueError("GitHub policy does not match the HTTPS origin")
        git(repo.root, "merge-base", "--is-ancestor", github["reviewed_commit"], head)
        helper = BIN / "git-push-topic"
        if not helper.is_file():
            helper = BIN / "executable_git-push-topic"
        push_helper = read_input(helper.parent, helper.name)[0].decode()
    files = {"config.toml": toml_document(config)}
    for name in ("AGENTS.md", "rules/default.rules"):
        if (codex_home / name).exists():
            files[name] = read_input(codex_home, name)[0].decode()
    profiles = {"dotfiles-secure": profile}
    requirements = {
        "default_permissions": "dotfiles-secure",
        "allowed_permission_profiles": {"dotfiles-secure": True},
        "permissions": profiles,
    }
    hooks = {}
    hooks_path = subprocess.check_output(
        [
            "git",
            "-C",
            str(repo.root),
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "hooks",
        ],
        env=devshell_environment.git_environment(),
        text=True,
    ).strip()
    if Path(hooks_path).is_dir():
        for hook in Path(hooks_path).iterdir():
            if hook.name.endswith(".sample") or not os.access(hook, os.X_OK):
                continue
            hooks[hook.name] = read_input(hook.parent, hook.name)[0].decode()
    identity = {}
    for key in ("user.name", "user.email"):
        result = subprocess.run(
            ["git", "-C", str(repo.root), "config", "--get", key],
            env=devshell_environment.git_environment(),
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            identity[key] = result.stdout.rstrip("\n")
    ca = (
        os.environ.get("CODEX_ISOLATION_CA_BUNDLE")
        or os.environ.get("NIX_SSL_CERT_FILE")
        or os.environ.get("SSL_CERT_FILE")
    )
    if not ca or not Path(ca).resolve(strict=True).is_relative_to("/nix/store"):
        raise ValueError(
            "select the public Nix CA bundle with CODEX_ISOLATION_CA_BUNDLE"
        )
    temporary = policy.with_name(policy.name + "." + uuid.uuid4().hex)
    approve(repo, temporary, head, names)
    record = json.loads(temporary.read_text())
    record["runtime"] = {
        "codex_home": str(codex_home),
        "config_files": files,
        "requirements": toml_document(requirements),
        "domains": domains,
        "denied_domains": [
            name for name, mode in domain_rules.items() if mode == "deny"
        ],
        "hooks": hooks,
        "git_identity": identity,
        "ca_bundle": str(Path(ca).resolve(strict=True)),
        "mcp_tools": mcp_tools,
        "private_tmp_codex": private_tmp_codex,
        "github": github,
        "push_helper": push_helper,
    }
    temporary.write_text(json.dumps(record, indent=2) + "\n")
    temporary.replace(policy)
    print("public files, reachable Git history and managed runtime policy admitted")


def launch(arguments):
    INNER["validate_codex_arguments"](arguments)
    if not sys.platform.startswith("linux"):
        raise ValueError("raw isolated Codex requires Linux or WSL2")
    tool_paths = {
        name: shutil.which(name)
        for name in (
            "nix",
            "bash",
            "cat",
            "python3",
            "git",
            "codex",
            "gh",
            "bwrap",
            "awk",
            "jq",
        )
    }

    def selected_tool(name):
        path = tool_paths[name]
        if not path or not Path(path).resolve(strict=True).is_relative_to("/nix/store"):
            raise ValueError(f"isolation tool must come from the Nix store: {name}")
        return str(Path(path).resolve(strict=True).parent)

    selected = {
        key: os.environ[key]
        for key in (
            "HOME",
            "GH_CONFIG_DIR",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "CODEX_HOME",
            "CODEX_ISOLATION_CA_BUNDLE",
            "NIX_SSL_CERT_FILE",
            "SSL_CERT_FILE",
            "DEVSHELL_ENV_OUTPUT",
            "WSL_DISTRO_NAME",
        )
        if key in os.environ
    }
    selected["PATH"] = selected_tool("git")
    os.environ.clear()
    os.environ.update(selected)
    repo = Repository.discover(Path.cwd(), linked_only=True)
    if not trusted(repo):
        raise ValueError("untrusted repository; run devshell-env trust")
    if not (repo.root / "flake.nix").is_file():
        raise ValueError("no flake.nix at the worktree root")
    os.environ["PATH"] = os.pathsep.join(
        dict.fromkeys(
            selected_tool(name) for name in tool_paths if name not in ("awk", "jq")
        )
    )
    policy = input_policy(repo)
    if not policy.is_file():
        raise ValueError(
            "public inputs are not admitted; run devshell-env admit --git-head FULL_SHA -- FILES"
        )
    with policy.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        record = json.loads(read_input(policy.parent, policy.name)[0])
        runtime = record["runtime"] | {"output": selected_output(repo)}
        if runtime.get("github"):
            os.environ["PATH"] += os.pathsep + os.pathsep.join(
                selected_tool(name) for name in ("awk", "jq")
            )
        if "flake.nix" not in record["files"]:
            raise ValueError("flake.nix must be an admitted public input")
        sessions = policy.parent.parent / "sessions"
        sessions.mkdir(mode=0o700, exist_ok=True)
        session = sessions / uuid.uuid4().hex
        print(f"codex-worktree: isolated session {session}", file=sys.stderr)
        services = ["dependencies"]
        if runtime.get("github"):
            if (
                git(repo.root, "branch", "--show-current").decode().strip()
                != runtime["github"]["branch"]
            ):
                raise ValueError(
                    "current branch differs from the admitted GitHub topic"
                )
        if arguments[:1] not in (["sandbox"], ["mcp"], ["--version"], ["--help"]):
            services.append("model")
        status = run_isolated(
            repo,
            policy,
            session,
            [
                "python3",
                "-I",
                "-B",
                "/nix/codex-isolation/share/codex-isolation/codex-inner.py",
                *arguments,
            ],
            services,
            Path(runtime["ca_bundle"]),
            runtime,
        )
        if not (session / "result/codex-started").is_file():
            raise ValueError(
                "initialization incomplete; session retained, review public inputs and restart"
            )
        return_result(repo, session)
    return status


def git_environment(root, git_dir=None):
    environment = {
        "PATH": os.environ["PATH"],
        "HOME": "/nonexistent",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_NO_REPLACE_OBJECTS": "1",
    }
    if git_dir is not None:
        environment.update(GIT_DIR=str(git_dir), GIT_WORK_TREE=str(root))
    return environment


def git(root, *arguments, git_dir=None, input=None):
    result = subprocess.run(
        [
            "git",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
            str(root),
            *arguments,
        ],
        env=git_environment(root, git_dir),
        capture_output=True,
        input=input,
    )
    if result.returncode:
        raise ValueError(f"Git {arguments[0]} failed; no input was published")
    return result.stdout


def read_input(root, name):
    parts = PurePosixPath(name).parts
    if (
        not parts
        or name != str(PurePosixPath(name))
        or any(part in ("/", ".", "..", ".git") for part in parts)
    ):
        raise ValueError("input must be a relative file outside Git metadata")
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory
            )
            os.close(directory)
            directory = child
        descriptor = os.open(
            parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
        )
    finally:
        os.close(directory)
    with os.fdopen(descriptor, "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ValueError("input must be a regular file with one link")
        data = source.read()
        after = os.fstat(source.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise ValueError("input changed while being read")
    return data, {
        "sha256": hashlib.sha256(data).hexdigest(),
        "executable": bool(before.st_mode & 0o111),
    }


def approve(repo, policy, head, names):
    if git(repo.root, "rev-parse", "HEAD").decode().strip() != head:
        raise ValueError("approval must name the current full Git HEAD")
    if policy.resolve().is_relative_to(repo.root) or policy.resolve().is_relative_to(
        repo.common_dir
    ):
        raise ValueError("input policy must be outside the worktree and Git metadata")
    files = {name: read_input(repo.root, name)[1] for name in names}
    if git(repo.root, "diff", "--cached", "--name-only"):
        raise ValueError("initial approval requires an index matching HEAD")
    if not files:
        raise ValueError("name the public input files explicitly")
    record = {
        "version": 1,
        "root": str(repo.root),
        "repository": repo.identity(),
        "git_head": head,
        "index_tree": git(repo.root, "write-tree").decode().strip(),
        "files": files,
    }
    with policy.open("x") as destination:
        os.chmod(policy, 0o600)
        json.dump(record, destination, indent=2)
        destination.write("\n")


def prepare(repo, policy, output):
    record = json.loads(read_input(policy.parent, policy.name)[0])
    if (
        record.get("version") != 1
        or record.get("root") != str(repo.root)
        or record.get("repository") != repo.identity()
    ):
        raise ValueError("input approval belongs to another worktree or repository")
    head = git(repo.root, "rev-parse", "HEAD").decode().strip()
    if record["git_head"] != head:
        raise ValueError("Git HEAD changed since input approval")
    if git(repo.root, "write-tree").decode().strip() != record["index_tree"]:
        raise ValueError("host index changed since input approval")
    admitted = {}
    for name, expected in record["files"].items():
        data, fingerprint = read_input(repo.root, name)
        if fingerprint != expected:
            raise ValueError("public input changed since approval")
        admitted[name] = data
    branch = git(repo.root, "symbolic-ref", "HEAD").decode().strip()
    git(repo.root, "check-ref-format", branch)
    output.mkdir(mode=0o700)
    fs = output / "root"
    work = fs / str(repo.root).lstrip("/")
    common = fs / str(repo.common_dir).lstrip("/")
    metadata = fs / str(repo.git_dir).lstrip("/")
    work.mkdir(parents=True)
    common.mkdir(parents=True)
    pack = git(
        repo.root,
        "pack-objects",
        "--stdout",
        "--revs",
        input=f"{head}\n{record['index_tree']}\n".encode(),
    )
    git(common, "init", "--bare", "--quiet")
    git(work, "index-pack", "--stdin", git_dir=common, input=pack)
    git(work, "fsck", "--full", "--no-reflogs", git_dir=common)
    git(work, "config", "core.bare", "false", git_dir=common)
    git(work, "update-ref", branch, head, git_dir=common)
    metadata.mkdir(parents=True)
    (metadata / "HEAD").write_text(f"ref: {branch}\n")
    (metadata / "commondir").write_text(str(repo.common_dir) + "\n")
    (metadata / "gitdir").write_text(str(repo.root / ".git") + "\n")
    (work / ".git").write_text(f"gitdir: {repo.git_dir}\n")
    # Build the index without consulting the absolute pointers, which refer to
    # the original repository until this tree is mounted inside the namespace.
    git(work, "read-tree", record["index_tree"], git_dir=common)
    (common / "index").replace(metadata / "index")
    for name, data in admitted.items():
        target = work / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o755 if record["files"][name]["executable"] else 0o644)
    if (
        Repository.discover(repo.root, linked_only=True) != repo
        or repo.identity() != record["repository"]
    ):
        raise ValueError("Git ownership changed while preparing input")
    if git(repo.root, "rev-parse", "HEAD").decode().strip() != head:
        raise ValueError("Git HEAD changed while preparing input")
    record.update(
        branch=branch,
        git_dir=str(repo.git_dir),
        common_dir=str(repo.common_dir),
        policy=str(policy.resolve()),
    )
    (output / "session.json").write_text(json.dumps(record, indent=2) + "\n")
    print("public worktree snapshot prepared; host files are not mounted")


def bridge_startup(service, port):
    # CPU 競合で10秒を超える正常な Python の初期化も待つ。
    # read status >128 is a timeout; other failures mean the bridge closed stdout.
    # Killing first keeps wait bounded if the bridge closed stdout but kept running.
    return f"""bridge_read_status=0
IFS= read -r -t 30 bridge_ready < <(
    python3 /gateway-bridge.py /gateway/{service}/service.sock {port} </dev/null
) || bridge_read_status=$?
if [ "$bridge_read_status" -gt 128 ]; then
    printf '%s\\n' 'gateway bridge did not start: no readiness within 30s' >&2
    exit 1
elif [ "$bridge_read_status" -ne 0 ]; then
    kill "$!" 2>/dev/null || :
    bridge_status=0
    wait "$!" || bridge_status=$?
    printf 'gateway bridge did not start: bridge exited with status %s\\n' "$bridge_status" >&2
    exit 1
elif [ "$bridge_ready" != ready ]; then
    printf '%s\\n' 'gateway bridge did not start: unexpected readiness line' >&2
    exit 1
fi
"""


def run_isolated(repo, policy, output, command, services, ca_bundle=None, runtime=None):
    if "dependencies" in services and ca_bundle is None:
        raise ValueError(
            "dependency access requires an explicitly selected public CA bundle"
        )
    prepare(repo, policy, output)
    paths = {}
    for name in ("nix", "bash", "cat", "python3", "git", "codex", "gh", "bwrap"):
        executable = shutil.which(name)
        if executable is None:
            raise ValueError(f"missing isolation tool: {name}")
        path = Path(executable).resolve(strict=True)
        if path.parts[:3] != ("/", "nix", "store"):
            raise ValueError(f"isolation tool must come from the Nix store: {name}")
        paths[name] = Path(*path.parts[:4])
    for name, executable in (runtime or {}).get("mcp_tools", {}).items():
        path = Path(executable).resolve(strict=True)
        if not path.is_relative_to("/nix/store"):
            raise ValueError("admitted MCP tool is no longer in the Nix store")
        paths[name] = Path(*path.parts[:4])
    if runtime and runtime.get("github"):
        path = Path(shutil.which("jq")).resolve(strict=True)
        if not path.is_relative_to("/nix/store"):
            raise ValueError("the isolated GitHub CLI requires Nix jq")
        paths["jq"] = Path(*path.parts[:4])
    store = output / "store"
    bootstrap = output / "bootstrap"
    bootstrap.mkdir()
    environment = {
        "HOME": str(bootstrap),
        "PATH": os.pathsep.join(str(path / "bin") for path in paths.values()),
        "NIX_CONF_DIR": str(bootstrap),
        "NIX_CONFIG": "experimental-features = nix-command flakes\n",
    }
    with (output / "store-copy.log").open("w") as log:
        subprocess.run(
            [
                str(paths["nix"] / "bin/nix"),
                "copy",
                "--to",
                str(store),
                "--no-check-sigs",
                *map(str, paths.values()),
            ],
            env=environment,
            stdout=log,
            stderr=log,
            check=True,
            timeout=300,
        )
    closure = subprocess.check_output(
        [
            str(paths["nix"] / "bin/nix-store"),
            "--query",
            "--requisites",
            *map(str, paths.values()),
        ],
        env=environment,
        text=True,
    ).splitlines()
    result = output / "result"
    result.mkdir()
    mounts = []
    for name in closure:
        path = Path(name)
        if path.parent != Path("/nix/store"):
            raise ValueError("invalid runtime closure path")
        mounts.extend(["--ro-bind", str(store / name.lstrip("/")), name])
    gateway_module = runpy.run_path(
        str(Path(__file__).with_name("secret-isolation-gateway.py"))
    )
    status = 0
    try:
        with gateway_module["gateway_scope"]() as start_gateway:
            try:
                for service in services:
                    options = {}
                    if runtime:
                        options = {
                            "domains": runtime["domains"],
                            "denied_domains": runtime.get("denied_domains", []),
                            "codex_home": Path(runtime["codex_home"]),
                        }
                        if service == "dependencies" and runtime.get("github"):
                            common = output / "root" / str(repo.common_dir).lstrip("/")
                            head = json.loads((output / "session.json").read_text())[
                                "git_head"
                            ]
                            options.update(
                                github_policy=runtime["github"],
                                github_seed={
                                    "pack": git(
                                        common,
                                        "pack-objects",
                                        "--stdout",
                                        "--revs",
                                        git_dir=common,
                                        input=(head + "\n").encode(),
                                    ),
                                    "push_helper": runtime["push_helper"],
                                },
                            )
                    directory = start_gateway(service, **options)
                    mounts.extend(["--ro-bind", str(directory), f"/gateway/{service}"])
            except ValueError as error:
                raise ValueError(
                    f"service setup failed: {error}; no isolated command was started"
                ) from None
            except (KeyError, OSError):
                raise ValueError(
                    "host tool login is unavailable; no isolated command was started"
                ) from None
            script = output / "inside.sh"
            startup = ""
            if "model" in services or "dependencies" in services:
                bridge_script = (
                    Path(__file__).with_name("secret-isolation-gateway.py").resolve()
                )
                mounts.extend(["--ro-bind", str(bridge_script), "/gateway-bridge.py"])
                for service, port in (("model", 8123), ("dependencies", 8124)):
                    if service not in services:
                        continue
                    startup += bridge_startup(service, port)
            if "dependencies" in services:
                ca = output / "ca-bundle.crt"
                resolved_ca = ca_bundle.resolve(strict=True)
                if not resolved_ca.is_relative_to("/nix/store"):
                    raise ValueError(
                        "select the public CA bundle from a trusted Nix tool closure"
                    )
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                context.load_verify_locations(cafile=str(resolved_ca))
                ca.write_text(
                    "".join(
                        ssl.DER_cert_to_PEM_cert(cert)
                        for cert in context.get_ca_certs(binary_form=True)
                    )
                )
                certificate_path = (
                    "/nix/codex-ca-bundle.crt" if runtime else "/ca-bundle.crt"
                )
                mounts.extend(["--ro-bind", str(ca), certificate_path])
                startup += """export HTTPS_PROXY=http://127.0.0.1:8124 HTTP_PROXY=http://127.0.0.1:8124
export https_proxy=$HTTPS_PROXY http_proxy=$HTTP_PROXY
export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
"""
                startup += f"export NIX_SSL_CERT_FILE={certificate_path} SSL_CERT_FILE={certificate_path}\n"
                if runtime:
                    resolver = output / "resolv.conf"
                    resolver.write_text(
                        "nameserver 127.0.0.1\noptions timeout:2 attempts:2\n"
                    )
                    mounts.extend(["--ro-bind", str(resolver), "/etc/resolv.conf"])
                    startup += "python3 /gateway-bridge.py --dns /gateway/dependencies/service.sock </dev/null &\n"
            if runtime:
                runtime_source = Path(__file__).resolve().parent
                runtime_copy = output / "runtime"
                (runtime_copy / "bin").mkdir(parents=True)
                shutil.copyfile(HELPER, runtime_copy / "bin/devshell-env")
                shutil.copytree(
                    PACKAGE_ROOT / "lib/python/treflebonbon_skills",
                    runtime_copy / "lib/python/treflebonbon_skills",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
                )
                shutil.copytree(
                    runtime_source,
                    runtime_copy / "share/codex-isolation",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
                )
                if runtime.get("github"):
                    shutil.copyfile(
                        runtime_source / "github-client.py",
                        runtime_copy / "github-client.py",
                    )
                    publisher = runtime_copy / "bin/git-push-topic"
                    publisher.write_text(
                        f'#!{paths["bash"]}/bin/bash\nexec {paths["python3"]}/bin/python3 -I /nix/codex-isolation/github-client.py "$@"\n'
                    )
                    publisher.chmod(0o755)
                    github_cli = runtime_copy / "bin/gh"
                    github_cli.write_text(
                        f'#!{paths["bash"]}/bin/bash\nexec {paths["python3"]}/bin/python3 -I /nix/codex-isolation/github-client.py gh "$@"\n'
                    )
                    github_cli.chmod(0o755)
                with_env = runtime_copy / "bin/with-env"
                with_env.write_text(
                    f'#!{paths["bash"]}/bin/bash\nexec {paths["python3"]}/bin/python3 -I -B /nix/codex-isolation/bin/devshell-env with-env "$@"\n'
                )
                with_env.chmod(0o755)
                mounts.extend(["--ro-bind", str(runtime_copy), "/nix/codex-isolation"])
                (output / "config").mkdir()
                # Codex atomically replaces its session config when saving TUI trust.
                # Permissions remain in the separate, immutable requirements layer.
                mounts.extend(["--bind", str(output / "config"), "/home/agent/.codex"])
                for name, content in runtime["config_files"].items():
                    public = output / "config" / name
                    public.parent.mkdir(parents=True, exist_ok=True)
                    public.write_text(content)
                    if name != "config.toml":
                        mounts.extend(
                            ["--ro-bind", str(public), "/home/agent/.codex/" + name]
                        )
                specification = runtime_copy / "launch.json"
                specification.write_text(
                    json.dumps(
                        {
                            "root": str(repo.root),
                            "output": runtime["output"],
                            "git_dir": str(repo.git_dir),
                            "common_dir": str(repo.common_dir),
                            "github": runtime.get("github"),
                        }
                    )
                )
                requirements = output / "requirements.toml"
                requirements.write_text(runtime["requirements"])
                mounts.extend(
                    ["--ro-bind", str(requirements), "/etc/codex/requirements.toml"]
                )
                common = output / "root" / str(repo.common_dir).lstrip("/")
                (common / "hooks").mkdir(exist_ok=True)
                for name, contents in runtime["hooks"].items():
                    hook = common / "hooks" / name
                    hook.write_text(contents)
                    hook.chmod(0o755)
                for name, value in runtime["git_identity"].items():
                    git(common, "config", name, value)
                # Signing credentials are absent, including for previously admitted inputs.
                git(common, "config", "commit.gpgsign", "false")
                startup += (
                    "export CODEX_HOME=/home/agent/.codex\nexport PATH=/nix/codex-isolation/bin:$PATH\nexport DEVSHELL_ENV_OUTPUT="
                    + shlex.quote(runtime["output"])
                    + "\n"
                )
            script.write_text(
                """set -eu
"""
                + startup
                + """
set +e
"$@"
command_status=$?
set -e
git rev-parse HEAD > /result/head
git write-tree > /result/index-tree
git ls-files --cached --others --exclude-standard -z > /result/files
index_commit=$(GIT_AUTHOR_NAME=Isolation GIT_AUTHOR_EMAIL=isolation@example.invalid GIT_COMMITTER_NAME=Isolation GIT_COMMITTER_EMAIL=isolation@example.invalid git commit-tree "$(cat /result/index-tree)" -p HEAD -m 'test: preserve isolated index')
git update-ref refs/isolation/index "$index_commit"
git bundle create /result/commits.bundle HEAD refs/isolation/index
printf '%s\n' "$command_status" > /result/exit-code
"""
            )
            fs = output / "root"
            argv = [
                str(paths["bwrap"] / "bin/bwrap"),
                "--unshare-all",
                "--die-with-parent",
                "--new-session",
                "--cap-drop",
                "ALL",
                "--clearenv",
                # Runtime shares only the fresh network created by codex-namespace.py.
                *(["--share-net"] if runtime else []),
                "--tmpfs",
                "/",
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--dir",
                "/tmp",
                *(
                    ["--dir", "/tmp/codex"]
                    if runtime and runtime.get("private_tmp_codex")
                    else []
                ),
                "--dir",
                "/home/agent",
                "--bind",
                str(store / "nix"),
                "/nix",
                "--bind",
                str(store / "nix/store"),
                "/nix/store",
                "--bind",
                str(fs / str(repo.root).lstrip("/")),
                str(repo.root),
                "--bind",
                str(fs / str(repo.common_dir).lstrip("/")),
                str(repo.common_dir),
                "--bind",
                str(result),
                "/result",
                "--ro-bind",
                str(script),
                "/inside.sh",
                *mounts,
                "--symlink",
                str(paths["bash"] / "bin/bash"),
                "/bin/sh",
                "--symlink",
                str(paths["bash"] / "bin/bash"),
                "/bin/bash",
                "--symlink",
                str(paths["cat"] / "bin/env"),
                "/usr/bin/env",
                "--setenv",
                "HOME",
                "/home/agent",
                "--setenv",
                "PATH",
                environment["PATH"],
                "--setenv",
                "LANG",
                "C.UTF-8",
                "--setenv",
                "TERM",
                "xterm-256color",
                "--setenv",
                "NIX_REMOTE",
                "local",
                "--setenv",
                "NIX_CONFIG",
                "experimental-features = nix-command flakes\nbuild-users-group =\nsandbox = false\nsubstituters ="
                + (" https://cache.nixos.org" if runtime else "")
                + "\n",
                "--chdir",
                str(repo.root),
                str(paths["bash"] / "bin/bash"),
                "/inside.sh",
                *command,
            ]
            if runtime:
                argv = [
                    str(paths["python3"] / "bin/python3"),
                    "-I",
                    str(Path(__file__).with_name("codex-namespace.py")),
                    *argv,
                ]
            completed = subprocess.run(
                argv, env=environment, timeout=None if runtime else 180
            )
            if completed.returncode:
                raise ValueError(
                    "isolated execution or export failed; the session is retained for recovery"
                )
            status = int(read_input(result, "exit-code")[0])
    except gateway_module["GatewayCleanupError"]:
        if not status:
            raise
    return status


def tree_files(directory, revision):
    result = {}
    for entry in git(directory, "ls-tree", "-rz", revision).split(b"\0"):
        if not entry:
            continue
        metadata, name = entry.split(b"\t", 1)
        mode, kind, oid = metadata.split()
        result[os.fsdecode(name)] = (mode, kind, oid)
    return result


def check_host_file(root, name, expected):
    target = root
    for part in PurePosixPath(name).parts:
        if part in ("/", ".", "..", ".git"):
            raise ValueError("invalid result path")
        target = target / part
        if target.is_symlink():
            raise ValueError("result path crosses a host link")
    if expected is not None:
        if read_input(root, name)[1] != expected:
            raise ValueError("host input changed; result is retained for recovery")
    elif target.exists():
        raise ValueError("result would replace an unapproved host file")


def install_result_file(root, name, contents, expected):
    parts = PurePosixPath(name).parts
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            try:
                os.mkdir(part, mode=0o755, dir_fd=directory)
            except FileExistsError:
                pass
            child = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory
            )
            os.close(directory)
            directory = child
        check_host_file(root, name, expected)
        if contents is None:
            os.unlink(parts[-1], dir_fd=directory)
            return
        data, fingerprint = contents
        temporary = ".isolation-" + uuid.uuid4().hex
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=directory,
        )
        with os.fdopen(descriptor, "wb") as destination:
            destination.write(data)
            os.fchmod(
                destination.fileno(), 0o755 if fingerprint["executable"] else 0o644
            )
        os.rename(temporary, parts[-1], src_dir_fd=directory, dst_dir_fd=directory)
    finally:
        os.close(directory)


def return_result(repo, session):
    record = json.loads(read_input(session, "session.json")[0])
    if record["root"] != str(repo.root) or record["repository"] != repo.identity():
        raise ValueError("session belongs to another worktree or repository")
    before = record["git_head"]
    if (
        git(repo.root, "rev-parse", "HEAD").decode().strip() != before
        or git(repo.root, "symbolic-ref", "HEAD").decode().strip() != record["branch"]
    ):
        raise ValueError("host branch changed; result is retained for recovery")
    if git(repo.root, "write-tree").decode().strip() != record["index_tree"]:
        raise ValueError("host index changed; result is retained for recovery")
    head = read_input(session / "result", "head")[0].decode().strip()
    index_tree = read_input(session / "result", "index-tree")[0].decode().strip()
    if not all(
        re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", oid) for oid in (head, index_tree)
    ):
        raise ValueError("invalid result object")
    policy = Path(record["policy"])
    policy_before = read_input(policy.parent, policy.name)[0]
    original_policy = json.loads(policy_before)
    if any(original_policy[key] != record[key] for key in original_policy):
        raise ValueError("input approval changed; result is retained for recovery")
    quarantine = Path(tempfile.mkdtemp(prefix="return-", dir=session))
    git(quarantine, "init", "--bare", "--quiet")
    bundle = quarantine / "result.bundle"
    bundle.write_bytes(read_input(session / "result", "commits.bundle")[0])
    git(quarantine, "bundle", "unbundle", str(bundle))
    git(quarantine, "fsck", "--full", "--no-reflogs")
    git(quarantine, "merge-base", "--is-ancestor", before, head)
    old_tree = tree_files(quarantine, before)
    new_tree = tree_files(quarantine, head)
    staged_tree = tree_files(quarantine, index_tree)
    for tree in (new_tree, staged_tree):
        for name, entry in tree.items():
            mode, kind, _ = entry
            if (
                mode not in (b"100644", b"100755") or kind != b"blob"
            ) and entry != old_tree.get(name):
                raise ValueError(
                    "result tree contains a new or changed linked or unsupported file"
                )
    names = {
        os.fsdecode(name)
        for name in read_input(session / "result", "files")[0].split(b"\0")
        if name
    }
    names.update(record["files"])
    copied_worktree = session / "root" / str(repo.root).lstrip("/")
    files = {}
    for name in names:
        try:
            files[name] = read_input(copied_worktree, name)
        except FileNotFoundError:
            pass
    if "runtime" in record:
        profile = tomllib.loads(record["runtime"]["requirements"])["permissions"][
            "dotfiles-secure"
        ]
        denied = profile["filesystem"].get(":workspace_roots", {})
        # Codex materializes empty mount targets for concrete deny rules. They
        # are sandbox artifacts, not task edits, and must not replace host secrets.
        for name in list(files):
            if (
                denied.get(name) == "deny"
                and files[name][0] == b""
                and name not in record["files"]
                and name not in new_tree
                and name not in staged_tree
            ):
                del files[name]
    affected = set(record["files"]) | set(files)
    affected.update(
        name
        for name in set(old_tree) | set(new_tree)
        if old_tree.get(name) != new_tree.get(name)
    )
    affected.update(
        name
        for name in set(new_tree) | set(staged_tree)
        if new_tree.get(name) != staged_tree.get(name)
    )
    for name in affected:
        check_host_file(repo.root, name, record["files"].get(name))
    git(quarantine, "read-tree", index_tree)
    index_bytes = (quarantine / "index").read_bytes()
    git(repo.root, "bundle", "unbundle", str(bundle))
    index_lock = repo.git_dir / "index.lock"
    descriptor = os.open(
        index_lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644
    )
    with os.fdopen(descriptor, "wb") as locked_index:
        locked_index.write(index_bytes)
    process = subprocess.Popen(
        [
            "git",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
            str(repo.root),
            "update-ref",
            "--stdin",
        ],
        env=git_environment(repo.root),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    published = False
    try:
        process.stdin.write(
            f"start\nupdate {record['branch']} {head} {before}\nprepare\n"
        )
        process.stdin.flush()
        if (
            process.stdout.readline().strip() != "start: ok"
            or process.stdout.readline().strip() != "prepare: ok"
        ):
            raise ValueError("host ref changed; result is retained for recovery")
        if (
            Repository.discover(repo.root, linked_only=True) != repo
            or repo.identity() != record["repository"]
        ):
            raise ValueError("host Git ownership changed")
        # A host git add may have completed after the early check. Inspect its
        # index while our exclusive lock prevents another cooperative writer.
        (quarantine / "index").write_bytes(read_input(repo.git_dir, "index")[0])
        try:
            current_tree = git(quarantine, "write-tree").decode().strip()
        except ValueError:
            raise ValueError(
                "host index changed; result is retained for recovery"
            ) from None
        if current_tree != record["index_tree"]:
            raise ValueError("host index changed; result is retained for recovery")
        for name in sorted(affected):
            contents = files.get(name)
            expected = record["files"].get(name)
            if contents is None and expected is None:
                continue
            if contents is not None and contents[1] == expected:
                continue
            install_result_file(repo.root, name, contents, expected)
        index_lock.replace(repo.git_dir / "index")
        process.stdin.write("commit\n")
        process.stdin.flush()
        if process.stdout.readline().strip() != "commit: ok":
            raise ValueError(
                "ref update failed; staged result is retained for recovery"
            )
        published = True
    finally:
        process.stdin.close()
        process.wait(timeout=10)
        # This lock was exclusively created by this return operation.
        if not published:
            index_lock.unlink(missing_ok=True)
    original_policy.update(
        git_head=head,
        index_tree=index_tree,
        files={name: value[1] for name, value in files.items()},
    )
    with tempfile.NamedTemporaryFile(
        mode="w", dir=policy.parent, delete=False
    ) as destination:
        json.dump(original_policy, destination, indent=2)
        destination.write("\n")
    os.replace(destination.name, policy)
    print(f"returned HEAD {head}, index and ordinary worktree changes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("approve", "prepare", "run", "return"):
        command = sub.add_parser(name)
        command.add_argument("--root", type=Path, required=True)
        if name != "return":
            command.add_argument("--policy", type=Path, required=True)
        if name == "approve":
            command.add_argument(
                "--git-head",
                required=True,
                help="explicitly approve this commit and its reachable Git history as public input",
            )
            command.add_argument("files", nargs="+")
        elif name == "return":
            command.add_argument("--session", type=Path, required=True)
        else:
            command.add_argument("--output", type=Path, required=True)
            if name == "run":
                command.add_argument(
                    "--service",
                    action="append",
                    choices=("github", "model", "dependencies"),
                    default=[],
                )
                command.add_argument("--ca-bundle", type=Path)
                command.add_argument("argv", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        repo = Repository.discover(args.root, linked_only=True)
        if args.command == "approve":
            approve(repo, args.policy, args.git_head, args.files)
        elif args.command == "prepare":
            prepare(repo, args.policy, args.output)
        elif args.command == "run":
            command = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
            if not command:
                raise ValueError("run requires a command")
            return run_isolated(
                repo, args.policy, args.output, command, args.service, args.ca_bundle
            )
        else:
            return_result(repo, args.session)
    except (
        OSError,
        ValueError,
        InvalidContext,
        subprocess.SubprocessError,
    ) as error:
        print(f"secret-isolation-worktree: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
