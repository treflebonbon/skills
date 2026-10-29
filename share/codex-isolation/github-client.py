"""Publish the current isolated topic through its admitted GitHub authority."""

import argparse
import base64
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit


def request(method, path, payload=None):
    # Only the existing proxy chain carries this credential-free HTTP envelope.
    # The host authority performs the authenticated GitHub request over TLS.
    proxy = urlsplit(os.environ.get("HTTP_PROXY", ""))
    if proxy.scheme != "http" or proxy.hostname != "127.0.0.1" or not proxy.port:
        raise ValueError("the managed HTTP proxy is unavailable")
    connection = http.client.HTTPConnection(proxy.hostname, proxy.port, timeout=240)
    try:
        connection.request(
            method,
            "http://api.github.com" + path,
            json.dumps(payload) if payload is not None else None,
            {"Host": "api.github.com", "Content-Type": "application/json"},
        )
        response = connection.getresponse()
        body = response.read()
        if response.status == 403:
            raise ValueError(
                "operation rejected: verify the admitted repository, topic, operation and reviewed automation"
            )
        if response.status != 200:
            raise ValueError(
                "GitHub connection failed: check host login, repository access, remote changes and network; no additional access was granted"
            )
        return json.loads(body)
    finally:
        connection.close()


def github_cli():
    arguments = sys.argv[2:]
    if arguments[:1] == ["pr"]:
        return pull_request_cli(arguments[1:])
    if not arguments or arguments.pop(0) != "api" or not arguments:
        raise ValueError(
            "isolated gh supports gh api for repository metadata and topic PR operations; see the isolation guide"
        )
    path = "/" + arguments.pop(0).lstrip("/")
    method, payload, query = None, None, None
    while arguments:
        option = arguments.pop(0)
        if (
            option
            not in (
                "--method",
                "-X",
                "--input",
                "--jq",
                "-q",
                "-f",
                "--raw-field",
                "-F",
                "--field",
            )
            or not arguments
        ):
            raise ValueError("unsupported isolated gh api option")
        value = arguments.pop(0)
        if option in ("--method", "-X"):
            method = value
        elif option in ("--jq", "-q"):
            query = value
        elif option == "--input":
            payload = (
                json.load(sys.stdin)
                if value == "-"
                else json.loads(Path(value).read_text())
            )
        else:
            key, separator, item = value.partition("=")
            if not separator:
                raise ValueError("gh api fields require key=value")
            if option in ("-F", "--field"):
                if item.startswith("@"):
                    item = (
                        sys.stdin.read() if item == "@-" else Path(item[1:]).read_text()
                    )
                else:
                    try:
                        item = json.loads(item)
                    except ValueError:
                        pass
            payload = (payload or {}) | {key: item}
    if method is None:
        method = "POST" if payload is not None else "GET"
    result = json.dumps(request(method, path, payload))
    if query is not None:
        subprocess.run(["jq", "-r", query], input=result.encode(), check=True)
    else:
        print(result)


def pull_request_cli(arguments):
    parser = argparse.ArgumentParser(prog="gh pr")
    parser.add_argument("action", choices=("create", "list", "view", "edit", "comment"))
    parser.add_argument("number", nargs="?")
    parser.add_argument("--repo", "-R")
    parser.add_argument("--head")
    parser.add_argument("--base")
    parser.add_argument("--draft", action="store_true")
    parser.add_argument("--title")
    body = parser.add_mutually_exclusive_group()
    body.add_argument("--body")
    body.add_argument("--body-file", type=Path)
    parser.add_argument("--json")
    parser.add_argument("--jq", "-q")
    options = parser.parse_args(arguments)
    if options.action != "create" and (options.head or options.base or options.draft):
        raise ValueError("head/base/draft options are only supported for PR creation")
    if options.action in ("view", "list") and (
        options.title is not None
        or options.body is not None
        or options.body_file is not None
    ):
        raise ValueError("read-only PR commands do not accept edits")
    if options.action in ("create", "list") and options.number is not None:
        raise ValueError("this PR command does not accept a number")
    if options.action == "create" and options.title is None:
        raise ValueError("gh pr create requires --title")
    policy = json.loads(Path("/nix/codex-isolation/launch.json").read_text())["github"]
    if options.repo not in (None, policy["repository"]):
        raise ValueError("repository differs from the admitted GitHub scope")
    prefix = "/repos/" + policy["repository"]
    payload = {}
    if options.title is not None:
        payload["title"] = options.title
    if options.body is not None or options.body_file is not None:
        payload["body"] = (
            options.body if options.body_file is None else options.body_file.read_text()
        )
    if options.action == "create":
        payload.update(
            head=options.head or policy["branch"],
            base=options.base or policy["default_branch"],
            draft=options.draft,
        )
        result = request("POST", prefix + "/pulls", payload)
    elif options.action == "list":
        result = request("GET", prefix + "/pulls")
    else:
        number = options.number
        if number is None:
            matches = request("GET", prefix + "/pulls")
            if len(matches) != 1:
                raise ValueError("select one PR number for the admitted topic")
            number = str(matches[0]["number"])
        if not number.isdigit() or int(number) < 1:
            raise ValueError("an explicit positive PR number is required")
        if options.action == "comment":
            result = request(
                "POST", prefix + "/issues/" + number + "/comments", payload
            )
        else:
            method = "PATCH" if options.action == "edit" else "GET"
            result = request(
                method,
                prefix + "/pulls/" + number,
                payload if method == "PATCH" else None,
            )
    if options.json is not None:

        def fields(value):
            expanded = value | {
                "url": value.get("html_url"),
                "headRefName": value.get("head", {}).get("ref"),
                "baseRefName": value.get("base", {}).get("ref"),
                "isDraft": value.get("draft"),
            }
            names = options.json.split(",")
            if not all(name in expanded for name in names):
                raise ValueError("unsupported PR JSON field")
            return {name: expanded[name] for name in names}

        result = (
            [fields(value) for value in result]
            if isinstance(result, list)
            else fields(result)
        )
    if options.jq:
        subprocess.run(
            ["jq", "-r", options.jq], input=json.dumps(result).encode(), check=True
        )
    elif options.json is None and isinstance(result, dict) and "html_url" in result:
        print(result["html_url"])
    else:
        print(json.dumps(result))


def main():
    if len(sys.argv) != 1:
        raise ValueError("usage: git-push-topic")
    policy = json.loads(Path("/nix/codex-isolation/launch.json").read_text())["github"]
    environment = {
        key: value for key, value in os.environ.items() if not key.startswith("GIT_")
    }
    environment.update(
        GIT_CONFIG_GLOBAL="/dev/null",
        GIT_CONFIG_NOSYSTEM="1",
        GIT_NO_REPLACE_OBJECTS="1",
    )

    def git(*arguments):
        return subprocess.check_output(
            ["git", "-c", "core.hooksPath=/dev/null", *arguments],
            env=environment,
            stderr=subprocess.DEVNULL,
        )

    if git("branch", "--show-current").decode().strip() != policy["branch"]:
        raise ValueError("current branch differs from the admitted topic")
    head = git("rev-parse", "HEAD").decode().strip()
    bundle = (
        b""
        if head == policy["reviewed_commit"]
        else git("bundle", "create", "-", "HEAD", "^" + policy["reviewed_commit"])
    )
    payload = {"head": head, "bundle": base64.b64encode(bundle).decode()}
    result = request("POST", "/topic-push", payload)
    print(f"published {result['head']} to {result['repository']}:{result['branch']}")


if __name__ == "__main__":
    try:
        if sys.argv[1:2] == ["gh"]:
            github_cli()
        else:
            main()
    except (
        ValueError,
        OSError,
        subprocess.SubprocessError,
        http.client.HTTPException,
    ) as error:
        print(f"isolated GitHub: {error}", file=sys.stderr)
        sys.exit(1)
