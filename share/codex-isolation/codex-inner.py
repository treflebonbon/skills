"""Prepare the admitted project and start Codex inside the outer namespace."""

import json
import os
from pathlib import Path
import sys
import tempfile
import tomllib


RUNTIME = Path("/nix/codex-isolation")
sys.path.insert(0, str(RUNTIME / "lib/python"))
from treflebonbon_skills.devshell_environment import (  # noqa: E402
    InvalidContext,
    PreparationError,
    Repository,
    executable,
    prepare_environment,
)


def validate_codex_arguments(arguments):
    expect_profile = False
    effort_seen = False
    prohibited_long = {
        "--cd",
        "--worktree",
        "--enable",
        "--disable",
        "--sandbox",
        "--add-dir",
        "--profile",
        "--approve-for-me",
        "--dangerously-bypass-approvals-and-sandbox",
        "--yolo",
        "--ignore-user-config",
        "--ignore-rules",
        "--dangerously-bypass-hook-trust",
        "--remote",
        "--remote-auth-token-env",
        "--sandbox-state-json",
        "--sandbox-state-readable-root",
    }
    arguments = iter(arguments)
    for argument in arguments:
        if expect_profile:
            if argument != "dotfiles-secure":
                raise InvalidContext("permission profile must remain dotfiles-secure")
            expect_profile = False
        elif argument in ("-c", "--config") or argument.startswith(("-c", "--config=")):
            if effort_seen:
                raise InvalidContext("reasoning effort must be specified only once")
            value = (
                next(arguments, "")
                if argument in ("-c", "--config")
                else argument[2:]
                if argument.startswith("-c")
                else argument.split("=", 1)[1]
            )
            key, separator, raw_value = value.partition("=")
            # Codex does not resolve quoted TOML keys like a TOML document does.
            if key.strip() != "model_reasoning_effort" or not separator:
                raise InvalidContext("only model_reasoning_effort config is allowed")
            try:
                config = tomllib.loads("effort=" + raw_value)
            except tomllib.TOMLDecodeError as error:
                raise InvalidContext(
                    "reasoning effort must be a TOML string"
                ) from error
            if (
                set(config) != {"effort"}
                or not isinstance(config["effort"], str)
                or not config["effort"]
            ):
                raise InvalidContext(
                    "reasoning effort must be one nonempty TOML string"
                )
            effort_seen = True
        elif argument == "--":
            break
        elif argument in ("-P", "--permission-profile", "--permissions-profile"):
            expect_profile = True
        elif argument.startswith(
            ("-P", "--permission-profile=", "--permissions-profile=")
        ):
            profile = (
                argument[2:] if argument.startswith("-P") else argument.split("=", 1)[1]
            )
            if profile != "dotfiles-secure":
                raise InvalidContext("permission profile must remain dotfiles-secure")
        elif (
            argument == "features"
            or argument.split("=", 1)[0] in prohibited_long
            or argument.startswith(("-C", "-c", "-s", "-p"))
        ):
            raise InvalidContext(
                f"argument can replace the worktree runtime boundary: {argument}"
            )
    if expect_profile:
        raise InvalidContext("missing permission profile value")


def main():
    launch = json.loads((RUNTIME / "launch.json").read_text())
    arguments = sys.argv[1:]
    validate_codex_arguments(arguments)
    repo = Repository.discover(launch["root"], linked_only=True)
    if (
        str(repo.git_dir) != launch["git_dir"]
        or str(repo.common_dir) != launch["common_dir"]
    ):
        raise ValueError("isolated Git ownership does not match the selected worktree")
    codex = executable("codex")
    if not codex:
        raise ValueError("the selected Codex is unavailable")
    environment = prepare_environment(
        repo,
        dict(os.environ),
        require_trust=False,
        isolated=True,
    )
    # These values and arguments belong to the launcher, not shellHook output.
    environment["CODEX_HOME"] = "/home/agent/.codex"
    environment["TMPDIR"] = tempfile.mkdtemp(prefix="codex-worktree-", dir="/tmp/codex")
    for key in list(environment):
        if key.startswith("LD_"):
            del environment[key]
    for key in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "http_proxy",
        "https_proxy",
        "NO_PROXY",
        "no_proxy",
        "NIX_CONFIG",
        "NIX_REMOTE",
        "NIX_SSL_CERT_FILE",
        "SSL_CERT_FILE",
    ):
        if key in os.environ:
            environment[key] = os.environ[key]
    overrides = [
        'default_permissions="dotfiles-secure"',
        'model_provider="isolated"',
        'model_providers.isolated={name="Isolated model",base_url="http://127.0.0.1:8123/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}',
        'web_search="disabled"',
        "features.shell_snapshot=false",
        "features.network_proxy=true",
    ]
    argv = [codex, "-C", str(repo.root)]
    for override in overrides:
        argv.extend(["-c", override])
    (Path("/result") / "codex-started").touch()
    os.chdir(repo.root)
    os.execve(codex, [*argv, *arguments], environment)


if __name__ == "__main__":
    try:
        main()
    except (
        OSError,
        ValueError,
        InvalidContext,
        PreparationError,
    ) as error:
        print(f"codex-worktree: {error}; initialization incomplete", file=sys.stderr)
        sys.exit(1)
