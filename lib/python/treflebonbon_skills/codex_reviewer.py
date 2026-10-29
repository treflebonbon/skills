"""Start a read-only reviewer Codex with access to its linked worktree metadata."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import sys


PACKAGE_PYTHON = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_PYTHON))

from treflebonbon_skills.git_context import InvalidContext, Repository, git_environment


BOUNDARY_OPTIONS = {
    "--cd",
    "--sandbox",
    "--add-dir",
    "--profile",
    "--permission-profile",
    "--permissions-profile",
    "--worktree",
    "--yolo",
    "--approve-for-me",
    "--ignore-user-config",
    "--ignore-rules",
    "--remote",
    "--remote-auth-token-env",
    "--sandbox-state-json",
    "--sandbox-state-readable-root",
}
# Other keys can start commands outside the sandbox (mcp_servers, notify) or replace it.
ALLOWED_CONFIG_KEYS = {
    "model",
    "model_reasoning_effort",
    "model_reasoning_summary",
    "model_verbosity",
}


def validate_arguments(arguments: list[str]) -> None:
    """Reject arguments that replace the root, profile, or sandbox set here."""
    arguments = iter(arguments)
    for argument in arguments:
        if argument == "--":
            return
        name = argument.split("=", 1)[0]
        if argument.startswith(("-c", "--config")):
            if argument in ("-c", "--config"):
                value = next(arguments, "")
            elif argument.startswith("-c"):
                value = argument[2:]
            else:
                value = argument.split("=", 1)[1]
            key = value.split("=", 1)[0].strip()
            # A line break could smuggle a later TOML table past the key check.
            if key not in ALLOWED_CONFIG_KEYS or "\n" in value or "\r" in value:
                raise InvalidContext(f"only model config is allowed: {value}")
        elif (
            name in BOUNDARY_OPTIONS
            or name.startswith("--dangerously-")
            or argument.startswith(("-C", "-s", "-P", "-p"))
        ):
            raise InvalidContext(f"argument can replace the reviewer boundary: {argument}")


def main() -> None:
    profile = "dotfiles-secure"
    arguments = sys.argv[1:]
    if arguments[:1] == ["--peer"]:
        profile = "dotfiles-peer"
        arguments = arguments[1:]
    validate_arguments(arguments)

    repository = Repository.discover(Path.cwd(), linked_only=True)
    filesystem_entries = ",".join(
        f'{json.dumps(str(path))}="read"'
        for path in (repository.git_dir, repository.common_dir)
    )
    executable = shutil.which("codex")
    if not executable:
        raise InvalidContext("Codex CLI is required")
    executable = str(Path(executable).resolve(strict=True))

    os.execvpe(
        executable,
        [
            "codex",
            "-C",
            str(repository.root),
            "-c",
            f'default_permissions="{profile}"',
            "-c",
            f"permissions.{profile}.filesystem={{{filesystem_entries}}}",
            *arguments,
        ],
        git_environment(),
    )


if __name__ == "__main__":
    try:
        main()
    except (InvalidContext, OSError, RuntimeError) as error:
        print(f"codex-reviewer: {error}", file=sys.stderr)
        sys.exit(1)
