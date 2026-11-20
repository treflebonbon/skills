"""Exercise the pilot recipe through its WSL entry point and a fake Sprite CLI."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/orca-vm/sprites-wsl.sh"
SHA = "0123456789abcdef0123456789abcdef01234567"
INSTANCE = "fixture-instance"
FAKE_SPRITE = """#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

args = sys.argv[1:]
assert args[:2] == ["-o", "fixture-org"]
log = Path(os.environ["FIXTURE_LOG"])
with log.open("a") as handle:
    handle.write(json.dumps(args) + "\\n")
action = args[2]
if action == "list":
    current = Path(os.environ["FIXTURE_NAME"])
    if current.exists():
        print(current.read_text())
elif action == "create":
    if os.environ.get("FIXTURE_CREATE_ERROR"):
        sys.exit(1)
    Path(os.environ["FIXTURE_NAME"]).write_text(args[-1])
elif action == "info":
    name = Path(os.environ["FIXTURE_NAME"]).read_text()
    print(f"URL: https://{name}-fixture.sprites.app")
    print("Labels: " + name)
elif action == "config":
    assert args[3:6] == ["update", "--url-auth", "public"]
elif action == "exec":
    if os.environ.get("FIXTURE_GIT_MIRROR"):
        import subprocess
        source = args[args.index("--file") + 1].split(":", 1)[0]
        env = dict(item.split("=", 1) for item in args[args.index("--env") + 1].split(","))
        env.update({
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": f"url.{os.environ['FIXTURE_GIT_MIRROR']}.insteadOf",
            "GIT_CONFIG_VALUE_0": "https://github.com/treflebonbon/skills.git",
            "HOME": os.environ["FIXTURE_REMOTE_HOME"],
        })
        sys.exit(subprocess.run(["/bin/bash", source, args[-1]], env={**os.environ, **env}).returncode)
    print(json.dumps({"schemaVersion": 1, "pairingCode": "fixture-pair", "projectRoot": "/home/sprite/skills"}))
elif action == "destroy":
    Path(os.environ["FIXTURE_NAME"]).unlink(missing_ok=True)
else:
    raise AssertionError(args)
"""


class SpritePilotTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="sprites-pilot-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        subprocess.run(["git", "init", "-q", self.root], check=True)
        self.config = self.root / ".git/orca-sprites-pilot.json"
        self.config.write_text(json.dumps({"org": "fixture-org", "ref": "refs/heads/main", "sha": SHA}))
        self.log = self.root / "sprite.log"
        mock = self.root / "sprite"
        mock.write_text(FAKE_SPRITE)
        mock.chmod(0o700)
        self.env = {
            **os.environ,
            "ORCA_VM_INSTANCE_ID": INSTANCE,
            "ORCA_RECIPE_ID": "sprites-wsl-pilot",
            "ORCA_REPO_PATH": str(self.root),
            "ORCA_REPO_REF_HEAD": SHA,
            "ORCA_SPRITES_PILOT_CLI": str(mock),
            "FIXTURE_LOG": str(self.log),
            "FIXTURE_NAME": str(self.root / "mock-name"),
        }

    def invoke(self, mode, payload=None, env=None):
        return subprocess.run(
            ["/bin/bash", SCRIPT, mode],
            cwd=self.root,
            env={**self.env, "ORCA_VM_MODE": mode, **(env or {})},
            input="" if payload is None else json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=15,
        )

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_create_provisions_one_named_sprite_and_emits_pairing_result(self):
        result = self.invoke("create")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        name = data["userData"]["resourceId"]
        self.assertRegex(name, r"^orca-skills-pilot-[a-f0-9]{16}$")
        self.assertEqual(data["pairingCode"], "fixture-pair")
        self.assertNotIn("fixture-pair", result.stderr)
        calls = self.calls()
        self.assertEqual([call[2] for call in calls], ["list", "create", "info", "exec", "config"])
        self.assertEqual(calls[1][-1], name)
        self.assertIn(f"PILOT_REF=refs/heads/main,PILOT_SHA={SHA}", " ".join(calls[3]))

    def payload(self, mode, data, instance=INSTANCE):
        return {
            "schemaVersion": 1,
            "mode": mode,
            "recipeId": "sprites-wsl-pilot",
            "instanceId": instance,
            "recipeResult": data,
        }

    def test_requested_base_sha_must_match_the_pilot_target(self):
        result = self.invoke("create", env={"ORCA_REPO_REF_HEAD": "f" * 40})
        self.assertEqual(result.returncode, 1)
        self.assertIn("requested Orca base SHA differs", result.stderr)
        self.assertFalse(self.log.exists(), "a different base SHA must never call Sprite")

    def test_same_sprite_suspends_resumes_and_is_confirmed_removed(self):
        data = json.loads(self.invoke("create").stdout)
        name = data["userData"]["resourceId"]
        for mode in ("suspend", "resume", "destroy"):
            with self.subTest(mode=mode):
                response = self.invoke(mode, self.payload(mode, data))
                self.assertEqual(response.returncode, 0, response.stderr)
                if mode == "resume":
                    self.assertEqual(json.loads(response.stdout), data)
        calls = self.calls()
        self.assertEqual([a[-1] for a in calls if a[2] == "exec"], ["create", "suspend", "resume"])
        self.assertEqual([a for a in calls if a[2] == "destroy"], [
            ["-o", "fixture-org", "destroy", "--force", name],
        ])
        self.assertEqual(calls[-1], ["-o", "fixture-org", "list", "--prefix", name])
        self.assertFalse((self.root / "mock-name").exists())

    def test_foreign_resource_in_payload_is_rejected_before_sprite_access(self):
        data = json.loads(self.invoke("create").stdout)
        history = self.calls()
        data["userData"]["resourceId"] = "someone-elses-sprite"
        response = self.invoke("destroy", self.payload("destroy", data))
        self.assertEqual(response.returncode, 1)
        self.assertIn("lifecycle payload names a different Sprite", response.stderr)
        self.assertEqual(self.calls(), history)

    def test_remote_sha_mismatch_destroys_only_this_sprite_before_public_access(self):
        repo = self.root / "public"
        repo.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "main", repo], check=True)
        subprocess.run([
            "git", "-C", repo, "-c", "user.name=Fixture",
            "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture",
        ], check=True)
        home = self.root / "remote-home"
        home.mkdir()
        result = self.invoke("create", env={"FIXTURE_GIT_MIRROR": repo.as_uri(), "FIXTURE_REMOTE_HOME": str(home)})
        self.assertEqual(result.returncode, 1)
        self.assertIn("public Git ref does not match the approved target SHA", result.stderr)
        self.assertIn("Sprite setup failed", result.stderr)
        self.assertEqual(result.stdout, "")
        calls = self.calls()
        name = calls[1][-1]
        self.assertEqual([call[2] for call in calls],
                         ["list", "create", "info", "exec", "list", "info", "destroy", "list"])
        self.assertEqual(calls[-2][-1], name)
        self.assertFalse((self.root / "mock-name").exists())
        self.assertFalse((self.root / ".git/orca-sprites-pilot-state.json").exists())

    def test_ambiguous_creation_failure_keeps_the_trial_identity_for_recovery(self):
        result = self.invoke("create", env={"FIXTURE_CREATE_ERROR": "1"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("creation outcome could not be confirmed", result.stderr)
        state = json.loads((self.root / ".git/orca-sprites-pilot-state.json").read_text())
        self.assertEqual(state["name"], self.calls()[1][-1])
        self.assertNotIn("destroy", [a[2] for a in self.calls()])
        next_try = self.invoke("create")
        self.assertIn("already has an active or unconfirmed Sprite", next_try.stderr)
