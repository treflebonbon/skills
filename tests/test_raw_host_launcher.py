"""Exercise the plugin's explicit preparation and host launcher entry points."""

import errno
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
PREPARE = ROOT / "bin/prepare-raw-codex-launcher"
LAUNCH = ROOT / "bin/raw-codex-launcher"
FIXTURES = ROOT / "tests/fixtures"
HOST = os.environ.get("RAW_HOST_LAUNCHER_CONTAINMENT")
PRODUCT = unittest.skipUnless(
    HOST in {"namespace", "cgroup"}, "select a real host's expected containment"
)


@unittest.skipUnless(
    sys.platform == "linux" and shutil.which("cc") and Path("/usr/bin/perl").is_file(),
    "Linux host compiler and Perl required",
)
class RawHostLauncherTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.env = os.environ | {"XDG_CACHE_HOME": str(self.root / "cache")}

    def command(self, entry, *args, env=None):
        return subprocess.run(
            [entry, *args],
            env=env or self.env,
            capture_output=True,
            text=True,
            timeout=40,
        )

    def prepare(self):
        result = self.command(PREPARE)
        self.assertEqual(result.returncode, 0, result.stderr)
        return Path(result.stdout.strip())

    def fake_bin(self, name, body):
        directory = self.root / "bin"
        directory.mkdir(exist_ok=True)
        entry = directory / name
        entry.write_text(body)
        entry.chmod(0o700)
        return self.env | {"PATH": f"{directory}:{self.env['PATH']}"}

    def bun_probe(self):
        path = FIXTURES / "raw-host-launcher-probe.py"
        environment = self.fake_bin("bun", f"#!{sys.executable}\n" + path.read_text())
        return environment | {"LAUNCHER_TEST_BUN": shutil.which("bun")}

    def test_missing_cache_then_explicit_preparation(self):
        missing = self.command(LAUNCH, self.root / "prepare.ts")
        self.assertEqual(missing.returncode, 1)
        self.assertIn("prepare-raw-codex-launcher", missing.stderr)
        self.assertFalse((self.root / "cache").exists())

        prepared = self.command(PREPARE)
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        artifact = Path(prepared.stdout.strip())
        self.assertTrue(artifact.is_relative_to(self.root / "cache"))
        self.assertEqual((artifact / "launcher").stat().st_mode & 0o777, 0o500)
        repeated = self.command(PREPARE)
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(repeated.stdout, prepared.stdout)

    def test_failed_compiler_and_concurrent_publication_protect_generations(self):
        environment = self.fake_bin(
            "cc", "#!/bin/sh\necho intentional-compiler-failure >&2\nexit 41\n"
        )
        failed = self.command(PREPARE, env=environment)
        self.assertIn("intentional-compiler-failure", failed.stderr)
        self.assertEqual(failed.returncode, 1)
        parent = self.root / "cache/treflebonbon-skills/raw-codex-launcher"
        self.assertEqual(list(parent.iterdir()), [])
        with subprocess.Popen(
            [PREPARE], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        ) as first:
            second = self.command(PREPARE)
            stdout, stderr = first.communicate(timeout=40)
        self.assertEqual(first.returncode, 0, stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(stdout, second.stdout)
        self.assertEqual(list(parent.iterdir()), [Path(stdout.strip())])
        artifact = Path(stdout.strip())
        binary = artifact / "launcher"
        binary.chmod(0o700)
        self.assertEqual(self.command(PREPARE).returncode, 1)
        mismatch = self.command(LAUNCH, "unused.ts")
        self.assertEqual(mismatch.returncode, 1)
        self.assertIn("prepare-raw-codex-launcher", mismatch.stderr)
        self.assertEqual(binary.stat().st_mode & 0o777, 0o700)
        artifact.rename(artifact.with_suffix(".saved"))
        artifact.mkdir(mode=0o700)
        identity = artifact.stat().st_ino
        self.assertEqual(self.command(PREPARE).returncode, 1)
        self.assertEqual(artifact.stat().st_ino, identity)
        self.assertEqual(list(artifact.iterdir()), [])

    def test_rejects_payload_and_symlink_ancestors(self):
        result = self.command(PREPARE, env=self.env | {"XDG_CACHE_HOME": str(ROOT / "test-cache")})
        self.assertEqual(result.returncode, 1)
        self.assertIn("payload", result.stderr)
        self.assertFalse((ROOT / "test-cache").exists())
        (self.root / "point").symlink_to(self.root)
        result = self.command(
            PREPARE, env=self.env | {"XDG_CACHE_HOME": str(self.root / "point/cache")}
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("祖先 directory", result.stderr)
        self.assertFalse((self.root / "cache").exists())

    @unittest.skipUnless(HOST == "refused", "select a host that cannot provide containment")
    def test_refusal_starts_neither_bun_nor_target(self):
        self.prepare()
        env = self.fake_bin("bun", "#!/bin/sh\necho verifier-started >&2\nexit 9\n")
        result = self.command(LAUNCH, "unused.ts", env=env)
        self.assertEqual(result.returncode, 69, result.stderr)
        self.assertIn("containment=refused reason=", result.stderr)
        self.assertNotIn("verifier-started", result.stderr)
        self.assertEqual(result.stdout, "")

    @PRODUCT
    def test_verified_launcher_replaces_entry_and_reports_exec_failure(self):
        payload = self.root / "plugin"
        files = (
            PREPARE,
            LAUNCH,
            ROOT / "lib/perl/RawCodexLauncher.pm",
            *(
                ROOT / "lib/bun" / name
                for name in (
                    "run",
                    "bunfig.toml",
                    "tsconfig.json",
                    "file-safety.ts",
                    "verify-raw-codex-launcher.ts",
                )
            ),
            FIXTURES / "bun-exec-pid-namespace.c",
            FIXTURES / "bun-exec-launcher.c",
        )
        for original in files:
            destination = payload / original.relative_to(ROOT)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, destination)

        def fingerprint():
            return {
                path.relative_to(payload): (
                    path.stat().st_mode,
                    hashlib.sha256(path.read_bytes()).hexdigest(),
                )
                for path in payload.rglob("*")
                if path.is_file()
            }

        before = fingerprint()
        prepared = self.command(
            payload / PREPARE.relative_to(ROOT), env=self.env | {"TMPDIR": str(payload)}
        )
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        environment = self.fake_bin("cc", "#!/bin/sh\necho unexpected-compiler >&2\nexit 97\n")
        launch = payload / LAUNCH.relative_to(ROOT)
        script = self.root / "prepare.ts"
        script.write_text("""
const [target, ...args] = process.argv.slice(2);
process.stdout.write(["exec-proof-v1", "search", target, String(args.length + 1), target,
  ...args, "0", "0", ""].join("\\0"));
""")
        with subprocess.Popen(
            [launch, script, "/bin/sh", "-c", 'printf "%s:%s" "$$" "$1"; exit 37', "--", "a b"],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ) as entry:
            stdout, stderr = entry.communicate(timeout=40)
        self.assertEqual(entry.returncode, 37, stderr)
        self.assertEqual(stdout, f"{entry.pid}:a b")
        method = self.env["RAW_HOST_LAUNCHER_CONTAINMENT"]
        self.assertIn(f"containment={method} reason=", stderr)

        failure = self.command(launch, script, "/nonexistent/raw-launcher-test", env=environment)
        self.assertEqual(failure.returncode, 1, failure.stderr)
        self.assertIn("raw-codex-launcher: exec-error:ENOENT errno=2", failure.stderr)
        self.assertIn("target=/nonexistent/raw-launcher-test", failure.stderr)
        self.assertEqual(fingerprint(), before)

    @PRODUCT
    def test_replacement_after_bun_verification_prevents_preparation(self):
        self.prepare()
        environment = self.bun_probe() | {"LAUNCHER_TEST_REPLACE": "1"}
        result = self.command(
            LAUNCH,
            FIXTURES / "bun-exec-prepare.ts",
            "search",
            "/usr/bin/printf",
            "ran",
            env=environment,
        )
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("検査中に cache が変わりました", result.stderr)
        self.assertEqual(result.stdout, "")

    @PRODUCT
    def test_existing_corpus_on_real_pty(self):
        self.prepare()
        observer = self.root / "observer"
        subprocess.run(
            ["cc", str(FIXTURES / "bun-process-observer.c"), "-o", str(observer)], check=True
        )
        corpus = json.loads((FIXTURES / "bun-process-lock-python.json").read_text())
        lock = self.root / "fd"
        for case in corpus["cases"]:
            with self.subTest(case=case["name"]):
                configuration = case["command"]
                expectation = case["expected"]
                arguments = [
                    observer,
                    "seed",
                    lock,
                    *configuration[3:5],
                    LAUNCH,
                    FIXTURES / "bun-exec-prepare.ts",
                    "search",
                    observer,
                    *configuration[7:],
                ]
                pid, tty = pty.fork()
                if pid == 0:
                    os.execve(observer, arguments, self.env | {"PROCESS_PROOF_MARKER": "literal🙂"})
                self.addCleanup(os.close, tty)
                os.set_inheritable(tty, False)
                chunks = []
                while select.select([tty], [], [], 10)[0]:
                    try:
                        chunk = os.read(tty, 65536)
                    except OSError as error:
                        if error.errno != 5:
                            raise
                        break
                    if not chunk:
                        break
                    chunks.append(chunk)
                else:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                    self.fail("PTY did not close")
                _, status = os.waitpid(pid, 0)
                output = b"".join(chunks).decode()
                self.assertEqual(os.waitstatus_to_exitcode(status), expectation["exitCode"], output)
                seed, target = [
                    json.loads(line) for line in output.splitlines() if line.startswith("{")
                ]
                for key in ("pid", "ppid", "pgid", "sid", "foreground"):
                    self.assertEqual(target[key], seed[key])
                self.assertEqual(target["tty"], [1, 1, 1])
                self.assertEqual(target["usr1Blocked"], expectation["usr1Blocked"])
                self.assertEqual(target["fd9"], seed["fd9"] if expectation["fdInherited"] else None)
                self.assertEqual(target["fds"], [9] if expectation["fdInherited"] else [])
                self.assertEqual(target["ignored"], {"int": 0, "pipe": 1, "xfsz": 1})
                self.assertEqual(target["argv"][1:], expectation["literalTail"][1:])
                self.assertEqual(target["marker"], expectation["marker"])

    @PRODUCT
    def test_existing_frame_and_target_arg_max_limits(self):
        self.prepare()
        observer = self.root / "observer"
        subprocess.run(
            ["cc", str(FIXTURES / "bun-process-observer.c"), "-o", str(observer)], check=True
        )
        script = self.root / "prepare.ts"
        script.write_text("""
const [target, kind, size] = process.argv.slice(2);
const args = kind === "argv" ? Array(Number(size)).fill("x".repeat(1024)) : [];
const fields = ["exec-proof-v1", "reviewer", target, String(args.length + 1), "codex", ...args];
fields.push(...(kind === "argv" ? ["0", "0"] : ["1", "", "0"]));
if (kind === "frame") fields[6] = "x".repeat(Number(size) - Buffer.byteLength(fields.join("\\0") + "\\0"));
process.stdout.write(fields.join("\\0") + "\\0");
""")
        low, high = 0, os.sysconf("SC_ARG_MAX") // 1024 + 1
        while low + 1 < high:
            middle = (low + high) // 2
            result = self.command(observer, "exec-limit", observer, str(middle))
            if result.returncode == 37:
                low = middle
            else:
                self.assertIn("errno=7", result.stderr)
                high = middle
        for size, expected in ((low, 37), (high, 1)):
            result = self.command(LAUNCH, script, observer, "argv", str(size))
            self.assertEqual(result.returncode, expected, result.stderr)
            if expected == 1:
                self.assertIn("exec-error:E2BIG errno=7", result.stderr)
        for size, expected in ((16 * 1024 * 1024 - 1, 37), (16 * 1024 * 1024, 1)):
            result = self.command(LAUNCH, script, observer, "frame", str(size))
            self.assertEqual(result.returncode, expected, result.stderr)
            if expected == 1:
                self.assertIn("preparation failed", result.stderr)

    @PRODUCT
    def test_existing_wrapper_arg_max_input(self):
        self.prepare()
        observer, baseline = self.root / "observer", self.root / "baseline"
        for source, executable in (
            ("bun-process-observer.c", observer),
            ("bun-exec-launcher.c", baseline),
        ):
            subprocess.run(["cc", str(FIXTURES / source), "-o", str(executable)], check=True)
        script = FIXTURES / "bun-exec-prepare.ts"
        old = [FIXTURES / "bun-exec-entry.sh", ROOT / "lib/bun/run", script, baseline]
        new = [LAUNCH, script]

        def accepted(command, count, tail):
            try:
                result = subprocess.run(
                    [*command, "reviewer", observer, "--", *(["x" * 1024] * count), "y" * tail],
                    env=self.env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=30,
                )
            except OSError as error:
                if error.errno == errno.E2BIG:
                    return False
                raise
            if result.returncode == 37:
                return True
            self.assertRegex(
                result.stderr, "Argument list too long|exec-error:E2BIG|preparation failed"
            )
            return False

        low, high = 0, os.sysconf("SC_ARG_MAX") // 1024 + 1
        self.assertTrue(accepted(old, low, 0))
        while low + 1 < high:
            middle = (low + high) // 2
            if accepted(old, middle, 0):
                low = middle
            else:
                high = middle
        tail, too_long = 0, 2048
        while tail + 1 < too_long:
            middle = (tail + too_long) // 2
            if accepted(old, low, middle):
                tail = middle
            else:
                too_long = middle
        self.assertTrue(
            accepted(new, low, tail), f"old entry accepted {low} chunks and {tail} bytes"
        )

    @PRODUCT
    def test_interruption_finishes_detached_descendants_before_target(self):
        self.prepare()
        script = self.root / "prepare.ts"
        script.write_text("""
const [python, helper, phase] = process.argv.slice(2);
process.stdout.write(["exec-proof-v1", "search", "/usr/bin/printf", "2", "printf", "ran", "0", "0", ""].join("\\0"));
if (phase === "prepare") await Bun.spawn([python, helper, "hold"]).exited;
""")
        maximum = 0.0
        for phase in ("verify", "prepare"):
            for disposition in ("blocked", "ignored", "no-response"):
                for received in (signal.SIGTERM, signal.SIGKILL):
                    with self.subTest(phase=phase, disposition=disposition, signal=received):
                        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as channel:
                            endpoint = self.root / f"{phase}-{disposition}-{received}"
                            channel.bind(str(endpoint))
                            channel.settimeout(10)
                            env = (self.bun_probe() if phase == "verify" else self.env) | {
                                "LAUNCHER_TEST_STALL": disposition,
                                "LAUNCHER_TEST_READY": str(endpoint),
                            }
                            arguments = [
                                LAUNCH,
                                script,
                                sys.executable,
                                FIXTURES / "raw-host-launcher-probe.py",
                                phase,
                            ]
                            with subprocess.Popen(
                                arguments,
                                env=env,
                                stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE,
                                text=True,
                            ) as entry:
                                try:
                                    data, ancillary, *_ = channel.recvmsg(1, socket.CMSG_SPACE(8))
                                    self.assertEqual(data, b"R")
                                    level, kind, identity = ancillary[0]
                                    self.assertEqual(
                                        (level, kind), (socket.SOL_SOCKET, socket.SCM_RIGHTS)
                                    )
                                    descriptors = struct.unpack("ii", identity)
                                    try:
                                        poll = select.poll()
                                        pending = set(descriptors)
                                        for descriptor in descriptors:
                                            poll.register(descriptor, select.POLLIN)
                                        started = time.monotonic()
                                        entry.send_signal(received)
                                        while pending:
                                            remaining = max(
                                                0, int((started + 5 - time.monotonic()) * 1000)
                                            )
                                            events = poll.poll(remaining)
                                            self.assertTrue(
                                                events, "preparation or descendant remained alive"
                                            )
                                            for descriptor, flags in events:
                                                self.assertTrue(flags & select.POLLIN)
                                                poll.unregister(descriptor)
                                                pending.remove(descriptor)
                                        elapsed = time.monotonic() - started
                                        self.assertLessEqual(elapsed, 5)
                                        maximum = max(maximum, elapsed)
                                    finally:
                                        for descriptor in descriptors:
                                            os.close(descriptor)
                                    stdout, stderr = entry.communicate(timeout=5)
                                    self.assertEqual(entry.returncode, -received, stderr)
                                    self.assertEqual(stdout, "")
                                finally:
                                    if entry.poll() is None:
                                        entry.kill()
        print(f"{HOST}: 12 signal cases, maximum observed {maximum * 1000:.3f} ms", flush=True)
