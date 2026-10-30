"""Repository-scoped GitHub authority; no credentials cross the service socket."""

import base64
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
from urllib.parse import quote


def validate_policy(policy):
    fields = {
        "repository",
        "branch",
        "default_branch",
        "reviewed_commit",
        "automation",
        "review",
    }
    if not isinstance(policy, dict) or set(policy) != fields:
        raise ValueError(
            "GitHub policy requires repository, branch, default_branch, reviewed_commit, automation and review"
        )
    if not all(isinstance(value, str) and value for value in policy.values()):
        raise ValueError("GitHub policy values must be nonempty strings")
    if not re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+", policy["repository"]):
        raise ValueError("GitHub policy requires an owner/repository")
    if not re.fullmatch(r"[a-f0-9]{40}", policy["reviewed_commit"]):
        raise ValueError("GitHub policy requires a full reviewed commit SHA")
    if policy["branch"] in ("main", "master", policy["default_branch"]):
        raise ValueError("GitHub policy must select a topic branch")
    for name in ("branch", "default_branch"):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9/_.-]*", policy[name]):
            raise ValueError("GitHub policy contains an unsupported branch name")
    if policy["automation"] not in ("no-project-secrets", "human-reviewed-external"):
        raise ValueError(
            "review secret-free automation or human-reviewed external execution before enabling GitHub"
        )
    return policy


class GitHubService:
    def __init__(self, policy):
        self.policy = validate_policy(policy)
        self.prefix = "/repos/" + policy["repository"]
        self.gh = str(Path(shutil.which("gh")).resolve(strict=True))
        self.environment = {
            "HOME": str(Path.home()),
            "PATH": os.pathsep.join(
                {
                    str(Path(shutil.which(name)).resolve().parent)
                    for name in ("gh", "git")
                }
            ),
            "GH_HOST": "github.com",
            "GH_PROMPT_DISABLED": "1",
            "GH_CONFIG_DIR": str(
                Path(
                    os.environ.get("GH_CONFIG_DIR")
                    or Path(
                        os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config"
                    )
                    / "gh"
                ).absolute()
            ),
        }
        self.metadata()
        self.publication = None
        self.lock = threading.Lock()

    def git(self, *arguments, data=None):
        result = subprocess.run(
            ["git", "-C", str(self.publication), *arguments],
            env=self.git_environment,
            input=data,
            capture_output=True,
            timeout=120,
        )
        if result.returncode:
            raise PermissionError(
                "invalid publication history or non-fast-forward update"
            )
        return result.stdout

    def enable_push(self, directory, pack, push_helper):
        directory.mkdir(mode=0o700)
        self.publication = directory
        self.git_environment = self.environment | {
            "PATH": os.pathsep.join(
                dict.fromkeys(
                    str(Path(shutil.which(name)).resolve().parent)
                    for name in ("git", "gh", "bash", "cat", "awk")
                )
            ),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_CONFIG_COUNT": "6",
            "GIT_CONFIG_KEY_0": "credential.helper",
            "GIT_CONFIG_VALUE_0": "",
            "GIT_CONFIG_KEY_1": "credential.helper",
            "GIT_CONFIG_VALUE_1": "!gh auth git-credential",
            "GIT_CONFIG_KEY_2": "core.hooksPath",
            "GIT_CONFIG_VALUE_2": "/dev/null",
            "GIT_CONFIG_KEY_3": "protocol.file.allow",
            "GIT_CONFIG_VALUE_3": "always",
            "GIT_CONFIG_KEY_4": "fetch.fsckObjects",
            "GIT_CONFIG_VALUE_4": "true",
            "GIT_CONFIG_KEY_5": "transfer.fsckObjects",
            "GIT_CONFIG_VALUE_5": "true",
        }
        self.git("init", "-q")
        self.git("index-pack", "--strict", "--stdin", data=pack)
        self.git("check-ref-format", "refs/heads/" + self.policy["branch"])
        self.git("symbolic-ref", "HEAD", "refs/heads/" + self.policy["branch"])
        self.git("update-ref", "HEAD", self.policy["reviewed_commit"])
        self.git(
            "remote",
            "add",
            "origin",
            "https://github.com/" + self.policy["repository"] + ".git",
        )
        self.push_helper = directory / "git-push-topic"
        self.push_helper.write_text(push_helper)
        self.published_head = self.policy["reviewed_commit"]

    def push(self, payload):
        if (
            self.publication is None
            or not isinstance(payload, dict)
            or set(payload) != {"head", "bundle"}
            or not isinstance(payload["head"], str)
            or not re.fullmatch(r"[0-9a-f]{40}", payload["head"])
            or not isinstance(payload["bundle"], str)
        ):
            raise PermissionError("topic publication is not admitted")
        with self.lock:
            try:
                bundle = base64.b64decode(payload["bundle"], validate=True)
            except ValueError:
                raise PermissionError("invalid publication bundle") from None
            if bundle:
                bundle_path = self.publication / "incoming.bundle"
                bundle_path.write_bytes(bundle)
                advertised = (
                    self.git("bundle", "list-heads", str(bundle_path)).decode().strip()
                )
                if advertised != payload["head"] + " HEAD":
                    raise PermissionError(
                        "publication bundle must contain only the selected HEAD"
                    )
                self.git(
                    "fetch",
                    "--no-tags",
                    "--no-recurse-submodules",
                    "--no-write-fetch-head",
                    str(bundle_path),
                    "HEAD",
                )
            head = payload["head"]
            self.git("merge-base", "--is-ancestor", self.published_head, head)
            baseline = self.policy["reviewed_commit"]
            automation = self.git("ls-tree", baseline, "--", ".github")
            for commit in (
                self.git("rev-list", baseline + ".." + head).decode().splitlines()
            ):
                if self.git("ls-tree", commit, "--", ".github") != automation:
                    raise PermissionError(
                        "unreviewed automation changes cannot be published"
                    )
            self.check_automation()
            self.git("update-ref", "HEAD", head)
            result = subprocess.run(
                ["bash", str(self.push_helper)],
                cwd=self.publication,
                env=self.git_environment,
                capture_output=True,
                timeout=180,
            )
            if result.returncode:
                raise ValueError(
                    "topic push failed; inspect host authorization or remote divergence"
                )
            self.published_head = head
            return {
                "head": head,
                "branch": self.policy["branch"],
                "repository": self.policy["repository"],
            }

    def api(self, method, path, payload=None):
        arguments = [self.gh, "api", path.lstrip("/"), "--method", method]
        data = None
        if payload is not None:
            arguments.extend(["--input", "-"])
            data = json.dumps(payload).encode()
        result = subprocess.run(
            arguments,
            input=data,
            env=self.environment,
            cwd="/",
            capture_output=True,
            timeout=60,
        )
        if result.returncode:
            raise ValueError(
                "GitHub request failed; check host login, granted repository access and network"
            )
        try:
            return json.loads(result.stdout)
        except ValueError:
            raise ValueError("GitHub returned an invalid response") from None

    def metadata(self):
        value = self.api("GET", self.prefix)
        if (
            value.get("full_name") != self.policy["repository"]
            or value.get("private") is not False
            or value.get("default_branch") != self.policy["default_branch"]
        ):
            raise ValueError(
                "GitHub repository visibility or default branch differs from the reviewed public scope"
            )
        return {
            name: value[name] for name in ("full_name", "private", "default_branch")
        }

    def automation_tree(self, revision):
        value = self.api("GET", self.prefix + "/git/trees/" + quote(revision, safe=""))
        if (
            not isinstance(value, dict)
            or value.get("truncated")
            or not isinstance(value.get("tree"), list)
            or any(
                not isinstance(entry, dict) or not isinstance(entry.get("path"), str)
                for entry in value["tree"]
            )
        ):
            raise ValueError("cannot verify the reviewed automation tree")
        return next(
            (entry for entry in value["tree"] if entry["path"] == ".github"), None
        )

    def check_automation(self, *, topic=False):
        self.metadata()
        reviewed = self.automation_tree(self.policy["reviewed_commit"])
        if reviewed != self.automation_tree(self.policy["default_branch"]):
            raise ValueError(
                "remote automation changed; review it on the host before publishing"
            )
        if topic and reviewed != self.automation_tree(self.policy["branch"]):
            raise PermissionError("topic automation differs from the reviewed commit")

    def selected_pr(self, number):
        value = self.api("GET", self.prefix + "/pulls/" + number)
        if (
            value.get("head", {}).get("ref") != self.policy["branch"]
            or value.get("head", {}).get("repo", {}).get("full_name")
            != self.policy["repository"]
            or value.get("base", {}).get("ref") != self.policy["default_branch"]
        ):
            raise PermissionError("PR is outside the selected topic")
        return value

    @staticmethod
    def pr_result(value):
        return {
            key: value[key]
            for key in (
                "number",
                "html_url",
                "title",
                "body",
                "state",
                "draft",
                "head",
                "base",
            )
            if key in value
        }

    @staticmethod
    def text_fields(payload, fields):
        return (
            isinstance(payload, dict)
            and bool(payload)
            and payload.keys() <= fields
            and all(
                isinstance(value, str) and len(value) <= 65536
                for value in payload.values()
            )
            and (
                "title" not in payload
                or re.match(r"[a-z]+(?:\([^)]+\))?!?: .+", payload["title"])
            )
        )

    def dispatch(self, method, path, payload):
        if method == "POST" and path == "/topic-push":
            return self.push(payload)
        if method == "GET" and path == self.prefix:
            return self.metadata()
        pulls = self.prefix + "/pulls"
        if method == "GET" and path == pulls:
            query = "?head=" + quote(
                self.policy["repository"].split("/")[0] + ":" + self.policy["branch"],
                safe="",
            )
            values = self.api("GET", pulls + query)
            return [self.pr_result(value) for value in values]
        if method == "POST" and path == pulls:
            if (
                not isinstance(payload, dict)
                or not payload.keys() <= {"title", "body", "head", "base", "draft"}
                or not {"title", "head", "base"} <= payload.keys()
                or payload["head"] != self.policy["branch"]
                or payload["base"] != self.policy["default_branch"]
                or not isinstance(payload.get("draft", False), bool)
                or not self.text_fields(
                    {key: payload[key] for key in ("title", "body") if key in payload},
                    {"title", "body"},
                )
            ):
                raise PermissionError("PR creation is outside the selected topic")
            self.check_automation(topic=True)
            return self.pr_result(self.api("POST", pulls, payload))
        match = re.fullmatch(re.escape(pulls) + r"/([1-9][0-9]*)", path)
        if match and method in ("GET", "PATCH"):
            if method == "PATCH" and not self.text_fields(payload, {"title", "body"}):
                raise PermissionError("only PR title and body edits are permitted")
            value = self.selected_pr(match[1])
            if method == "PATCH":
                self.check_automation(topic=True)
                value = self.api("PATCH", path, payload)
            return self.pr_result(value)
        match = re.fullmatch(
            re.escape(self.prefix) + r"/issues/([1-9][0-9]*)/comments", path
        )
        if match and method == "POST" and self.text_fields(payload, {"body"}):
            self.selected_pr(match[1])
            self.check_automation(topic=True)
            value = self.api("POST", path, payload)
            return {key: value[key] for key in ("id", "html_url", "body")}
        raise PermissionError("GitHub operation is outside the admitted scope")

    def handle(self, request):
        if (
            request.headers.get("Host") != "api.github.com"
            or request.headers.get("Transfer-Encoding")
            or request.headers.get("Content-Encoding")
        ):
            return request.reject()
        length = request.headers.get("Content-Length", "0")
        limit = 64 * 1024 * 1024 if request.path == "/topic-push" else 1024 * 1024
        if not length.isdigit() or int(length) > limit:
            return request.reject()
        try:
            if request.command == "GET" and int(length):
                return request.reject()
            payload = (
                json.loads(request.read_body(int(length))) if int(length) else None
            )
        except ValueError:
            return request.reject()
        try:
            body = json.dumps(
                self.dispatch(request.command, request.path, payload)
            ).encode()
        except PermissionError:
            return request.reject()
        except (ValueError, OSError, subprocess.SubprocessError):
            return request.fail_upstream()
        request.send_response(200)
        request.send_header("Content-Type", "application/json")
        request.send_header("Content-Length", str(len(body)))
        request.end_headers()
        request.wfile.write(body)
