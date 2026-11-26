"""Host-side validation retained until the Python host is replaced."""

import tomllib

from treflebonbon_skills.devshell_environment import InvalidContext


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
