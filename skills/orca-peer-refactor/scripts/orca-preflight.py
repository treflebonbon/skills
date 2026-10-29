#!/usr/bin/env python3
"""Read-only identity checks for Orca Run and Dispatch receipts."""

import argparse
import json
import os
import re
import subprocess
import sys


class InvalidReceipt(ValueError):
    pass


class InvalidObservation(ValueError):
    pass


OBSERVATION_SCHEMA = "orca-worker-readiness-observation/v1"
OBSERVATION_FIELDS = {
    "schema", "task_id", "dispatch_id", "assignee_handle", "cwd",
    "physical_root", "branch", "head", "git_dir", "common_dir",
}
CHECKOUT_FIELDS = ("cwd", "physical_root", "branch", "head", "git_dir", "common_dir")


def load_receipt(path):
    try:
        with open(path, encoding="utf-8") as stream:
            receipt = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise InvalidReceipt("receipt を読み取れません") from error
    if not isinstance(receipt, dict) or receipt.get("ok") is not True:
        raise InvalidReceipt("receipt が成功応答ではありません")
    if receipt.get("error") is not None:
        raise InvalidReceipt("receipt に error があります")
    result = receipt.get("result")
    if not isinstance(result, dict):
        raise InvalidReceipt("receipt に result がありません")
    return result


def require_match(actual, expected, label):
    if (
        not isinstance(actual, str)
        or not actual.strip()
        or not isinstance(expected, str)
        or not expected.strip()
        or actual != expected
    ):
        raise InvalidReceipt(f"{label} が期待値と一致しません")


def validate_coordinator(result, args):
    run = result.get("run")
    if not isinstance(run, dict):
        raise InvalidReceipt("result.run がありません")
    require_match(run.get("id"), args.run, "Run ID")
    require_match(run.get("coordinator_handle"), args.handle, "coordinator handle")


def validate_worker(result, args):
    dispatch = result.get("dispatch")
    if not isinstance(dispatch, dict):
        raise InvalidReceipt("result.dispatch がありません")
    require_match(dispatch.get("id"), args.dispatch, "Dispatch ID")
    require_match(dispatch.get("taskId"), args.task, "Task ID")
    require_match(dispatch.get("assigneeHandle"), args.assignee, "assignee handle")
    require_match(dispatch.get("status"), "dispatched", "Dispatch status")


def require_nonempty(value, label):
    if not isinstance(value, str) or not value.strip():
        raise InvalidObservation(f"{label} が空または不正です")


def git_value(cwd, *args):
    env = {key: os.environ[key] for key in os.environ if not key.startswith("GIT_")}
    try:
        result = subprocess.run(
            ["git", "-C", cwd, *args], env=env, capture_output=True, text=True
        )
    except OSError as error:
        raise InvalidObservation("Git metadata を取得できません") from error
    if result.returncode != 0:
        raise InvalidObservation("Git metadata を取得できません")
    return result.stdout[:-1] if result.stdout.endswith("\n") else result.stdout


def checkout_identity(cwd):
    cwd = os.path.realpath(cwd)
    root = git_value(cwd, "rev-parse", "--show-toplevel")
    identity = {
        "cwd": cwd,
        "physical_root": os.path.realpath(root),
        "branch": git_value(cwd, "branch", "--show-current"),
        "head": git_value(cwd, "rev-parse", "--verify", "HEAD"),
        "git_dir": os.path.realpath(git_value(cwd, "rev-parse", "--absolute-git-dir")),
        "common_dir": os.path.realpath(git_value(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")),
    }
    validate_checkout(identity)
    return identity


def validate_checkout(identity):
    for field in CHECKOUT_FIELDS:
        value = identity.get(field)
        require_nonempty(value, field)
        if field in {"cwd", "physical_root", "git_dir", "common_dir"} and not os.path.isabs(value):
            raise InvalidObservation(f"{field} が絶対パスではありません")
    if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", identity["head"]):
        raise InvalidObservation("HEAD が不正です")


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidObservation("worker readiness に重複キーがあります")
        result[key] = value
    return result


def load_observation(path):
    try:
        with open(path, encoding="utf-8") as stream:
            observation = json.load(stream, object_pairs_hook=reject_duplicate_keys)
    except (OSError, UnicodeError, json.JSONDecodeError, InvalidObservation) as error:
        raise InvalidObservation("worker readiness JSON を読み取れません") from error
    if not isinstance(observation, dict) or set(observation) != OBSERVATION_FIELDS:
        raise InvalidObservation("worker readiness の schema が不正です")
    if observation.get("schema") != OBSERVATION_SCHEMA:
        raise InvalidObservation("worker readiness の schema が不正です")
    for field in ("task_id", "dispatch_id", "assignee_handle"):
        require_nonempty(observation.get(field), field)
    validate_checkout(observation)
    return observation


def validate_readiness_context(observation, args):
    require_match(observation.get("task_id"), args.task, "Task ID")
    require_match(observation.get("dispatch_id"), args.dispatch, "Dispatch ID")
    require_match(observation.get("assignee_handle"), args.assignee, "assignee handle")


def record_worker_readiness(args):
    for field in ("task", "dispatch", "assignee"):
        require_nonempty(getattr(args, field), field)
    require_nonempty(args.observation, "observation")
    if not os.path.isabs(args.observation):
        raise InvalidObservation("observation は絶対パスで指定してください")
    observation = {
        "schema": OBSERVATION_SCHEMA,
        "task_id": args.task,
        "dispatch_id": args.dispatch,
        "assignee_handle": args.assignee,
        **checkout_identity(os.getcwd()),
    }
    with open(args.observation, "x", encoding="utf-8") as stream:
        json.dump(observation, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def verify_worker_readiness(args):
    for field in ("task", "dispatch", "assignee"):
        require_nonempty(getattr(args, field), field)
    require_nonempty(args.worktree, "worktree")
    require_nonempty(args.observation, "observation")
    if not os.path.isabs(args.worktree):
        raise InvalidObservation("worktree は絶対パスで指定してください")
    if not os.path.isabs(args.observation):
        raise InvalidObservation("observation は絶対パスで指定してください")
    observation = load_observation(args.observation)
    validate_readiness_context(observation, args)
    expected = checkout_identity(args.worktree)
    if expected["cwd"] != expected["physical_root"]:
        raise InvalidObservation("指定された worktree が physical root ではありません")
    if expected["git_dir"] == expected["common_dir"]:
        raise InvalidObservation("割当先が linked worktree ではありません")
    require_match(expected["branch"], args.branch, "割当 branch")
    require_match(expected["head"], args.head, "割当 HEAD")
    for field in CHECKOUT_FIELDS:
        if field == "branch":
            expected_value = args.branch
        elif field == "head":
            expected_value = args.head
        else:
            expected_value = expected[field]
        require_match(observation[field], expected_value, field)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="kind", required=True)
    coordinator = subparsers.add_parser("coordinator", help="validate a Run receipt")
    coordinator.add_argument("receipt")
    coordinator.add_argument("--run", required=True)
    coordinator.add_argument("--handle", required=True)
    worker = subparsers.add_parser("worker-show", help="validate a dispatched worker-show receipt")
    worker.add_argument("receipt")
    worker.add_argument("--dispatch", required=True)
    worker.add_argument("--task", required=True)
    worker.add_argument("--assignee", required=True)
    readiness = subparsers.add_parser("worker-readiness", help="record or verify worker checkout readiness")
    readiness_actions = readiness.add_subparsers(dest="action", required=True)
    record = readiness_actions.add_parser("record", help="record the current worker checkout")
    record.add_argument("observation")
    record.add_argument("--dispatch", required=True)
    record.add_argument("--task", required=True)
    record.add_argument("--assignee", required=True)
    verify = readiness_actions.add_parser("verify", help="compare a worker record with its assigned worktree")
    verify.add_argument("observation")
    verify.add_argument("--worktree", required=True)
    verify.add_argument("--branch", required=True)
    verify.add_argument("--head", required=True)
    verify.add_argument("--dispatch", required=True)
    verify.add_argument("--task", required=True)
    verify.add_argument("--assignee", required=True)
    args = parser.parse_args(argv)

    try:
        if args.kind == "worker-readiness":
            if args.action == "record":
                record_worker_readiness(args)
            else:
                verify_worker_readiness(args)
        else:
            result = load_receipt(args.receipt)
            if args.kind == "coordinator":
                validate_coordinator(result, args)
            else:
                validate_worker(result, args)
    except (InvalidObservation, InvalidReceipt, OSError) as error:
        print(f"preflight 拒否: {error}", file=sys.stderr)
        return 1

    if args.kind == "worker-readiness" and args.action == "record":
        print("preflight OK: worker checkout observation saved")
    elif args.kind == "worker-readiness":
        print("preflight OK: worker checkout matches assigned worktree")
    else:
        print("preflight OK: receipt identity matches")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
