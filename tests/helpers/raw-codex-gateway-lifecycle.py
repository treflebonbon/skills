"""実 gateway と run_isolated を通して資源の取得・解放を検証する。"""

from contextlib import ExitStack, redirect_stderr
import io
import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SOURCE = Path(sys.argv[1])
TEMPORARY = Path(sys.argv[2])
WORKTREE = runpy.run_path(str(SOURCE / "secret-isolation-worktree.py"))
GATEWAY = runpy.run_path(str(SOURCE / "secret-isolation-gateway.py"))


class GatewayLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=TEMPORARY)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.session = self.root / "session"
        self.servers = []
        self.roots = []
        self.events = []
        self.executed = False
        self.failure = None
        self.cleanup_failure = False
        self.command_status = 0
        self.stderr = io.StringIO()
        self.home = self.root / "codex"
        self.home.mkdir()
        (self.home / "auth.json").write_text(
            json.dumps({"tokens": {"access_token": "fixture", "account_id": "fixture"}})
        )
        self.fds = set(os.listdir("/proc/self/fd"))
        self.addCleanup(self.close_servers)

    def close_servers(self):
        for _server, shutdown, close in self.servers:
            shutdown()
            close()

    def prepare(self, _repo, _policy, output):
        output.mkdir()
        (output / "public-snapshot").write_text("retained")

    def start_gateway(self, directory, service, **options):
        if service == "model":
            options["codex_home"] = (
                self.root / "missing-login" if self.failure == "second" else self.home
            )
        server = GATEWAY["start_gateway"](directory, service, **options)
        shutdown, close = server.shutdown, server.server_close
        self.servers.append((server, shutdown, close))

        def stop():
            self.events.append((service, "shutdown"))
            shutdown()
            if self.cleanup_failure and service == "github":
                raise OSError("fixture shutdown failure")

        def release():
            self.events.append((service, "close"))
            close()

        server.shutdown, server.server_close = stop, release
        return server

    def run_command(self, command, **_options):
        if command[1:2] == ["copy"]:
            return subprocess.CompletedProcess(command, 0)
        self.executed = True
        if self.failure == "execution":
            raise RuntimeError("fixture execution failure")
        if self.failure == "interrupt":
            signal.raise_signal(signal.SIGINT)
        if self.failure == "export":
            return subprocess.CompletedProcess(command, 17)
        (self.session / "result/exit-code").write_text(str(self.command_status))
        return subprocess.CompletedProcess(command, 0)

    def invoke(self, services=("github", "model"), ca_bundle=None):
        original_mkdtemp = tempfile.mkdtemp

        def mkdtemp(*args, **kwargs):
            kwargs["dir"] = self.root
            directory = original_mkdtemp(*args, **kwargs)
            self.roots.append(Path(directory))
            return directory

        work_globals = WORKTREE["run_isolated"].__globals__
        gateway_globals = GATEWAY["start_gateway"].__globals__
        gateway = GATEWAY | {"start_gateway": self.start_gateway}
        with ExitStack() as stack:
            stack.enter_context(redirect_stderr(self.stderr))
            stack.enter_context(patch.dict(work_globals, prepare=self.prepare))
            stack.enter_context(
                patch.dict(gateway_globals, start_gateway=self.start_gateway)
            )
            stack.enter_context(patch.object(runpy, "run_path", return_value=gateway))
            stack.enter_context(patch.object(tempfile, "mkdtemp", side_effect=mkdtemp))
            stack.enter_context(
                patch.object(
                    WORKTREE["shutil"],
                    "which",
                    return_value=str(Path(sys.executable).resolve()),
                )
            )
            stack.enter_context(
                patch.object(subprocess, "run", side_effect=self.run_command)
            )
            stack.enter_context(
                patch.object(
                    subprocess,
                    "check_output",
                    return_value="/nix/store/fixture-runtime\n",
                )
            )
            return WORKTREE["run_isolated"](
                SimpleNamespace(root=self.root / "repo", common_dir=self.root / "git"),
                self.root / "policy",
                self.session,
                ["fixture"],
                services,
                ca_bundle,
            )

    def assert_released(self):
        self.assertTrue(self.roots, "gateway directory was not created")
        for directory in self.roots:
            self.assertFalse(
                directory.exists(), f"gateway resources remain: {directory}"
            )
        self.assertEqual(set(os.listdir("/proc/self/fd")), self.fds)
        self.assertEqual((self.session / "public-snapshot").read_text(), "retained")
        for service, _action in self.events:
            self.assertIn((service, "close"), self.events)

    def test_normal_exit(self):
        self.assertEqual(self.invoke(), 0)
        self.assertTrue(self.executed)
        self.assertEqual(len(self.servers), 2)
        self.assert_released()

    def test_partial_start_failure(self):
        self.failure = "second"
        with self.assertRaisesRegex(ValueError, "host tool login is unavailable"):
            self.invoke()
        self.assertFalse(self.executed)
        self.assertEqual(len(self.servers), 1)
        self.assert_released()

    def test_preparation_failure(self):
        ca = self.root / "ca.pem"
        ca.write_text("fixture")
        with self.assertRaisesRegex(ValueError, "trusted Nix tool closure"):
            self.invoke(("dependencies",), ca)
        self.assertFalse(self.executed)
        self.assert_released()

    def test_setup_failure_survives_close_failure(self):
        self.failure = "second"
        close = GATEWAY["UnixServer"].server_close

        def failing_close(server):
            close(server)
            if getattr(server, "service", None) == "model":
                raise OSError("fixture setup close failure")

        with patch.object(GATEWAY["UnixServer"], "server_close", failing_close):
            with self.assertRaisesRegex(ValueError, "host tool login is unavailable"):
                self.invoke()
        self.assertIn("fixture setup close failure", self.stderr.getvalue())
        self.assertFalse(self.executed)
        self.assert_released()

    def test_execution_failure(self):
        self.failure = "execution"
        with self.assertRaisesRegex(RuntimeError, "fixture execution failure"):
            self.invoke()
        self.assert_released()

    def test_export_failure(self):
        self.failure = "export"
        with self.assertRaisesRegex(ValueError, "session is retained for recovery"):
            self.invoke()
        self.assert_released()

    def test_cleanup_failure(self):
        self.cleanup_failure = True
        with self.assertRaisesRegex(ValueError, "gateway cleanup failed"):
            self.invoke()
        self.assertIn("fixture shutdown failure", self.stderr.getvalue())
        self.assert_released()

    def test_primary_failure_survives_cleanup_failure(self):
        self.failure = "execution"
        self.cleanup_failure = True
        with self.assertRaisesRegex(RuntimeError, "fixture execution failure"):
            self.invoke()
        self.assertIn("fixture shutdown failure", self.stderr.getvalue())
        self.assert_released()

    def test_nonzero_command_survives_cleanup_failure(self):
        self.command_status = 23
        self.cleanup_failure = True
        self.assertEqual(self.invoke(), 23)
        self.assertIn("fixture shutdown failure", self.stderr.getvalue())
        self.assert_released()

    def test_directory_cleanup_failure(self):
        remove = GATEWAY["shutil"].rmtree

        def failing_remove(path, *args, **kwargs):
            if Path(path).name.startswith("cxi-"):
                raise PermissionError("fixture directory cleanup failure")
            return remove(path, *args, **kwargs)

        with patch.object(GATEWAY["shutil"], "rmtree", failing_remove):
            with self.assertRaisesRegex(ValueError, "gateway cleanup failed"):
                self.invoke()
        self.assertIn("fixture directory cleanup failure", self.stderr.getvalue())
        self.assertTrue(all(directory.exists() for directory in self.roots))
        self.assertEqual(set(os.listdir("/proc/self/fd")), self.fds)
        self.assertEqual((self.session / "public-snapshot").read_text(), "retained")

    def test_interrupt(self):
        self.failure = "interrupt"
        with self.assertRaises(KeyboardInterrupt):
            self.invoke()
        self.assert_released()


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *sys.argv[3:]])
