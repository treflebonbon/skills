import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROBE = Path(__file__).resolve().parents[1] / "development" / "probe-linux-cgroup.py"


def select(tmp, unshare):
    marker = Path(tmp) / "marker"
    env = {**os.environ, "PROBE_UNSHARE": unshare,
           "PROBE_CGROUP_ROOT": str(Path(tmp) / "missing")}
    done = subprocess.run([sys.executable, "-I", str(PROBE), "select", str(marker)],
                          env=env, capture_output=True, text=True, timeout=30)
    events = [json.loads(line.split(" ", 1)[1]) for line in done.stdout.splitlines()]
    return done.returncode, marker.exists(), events[-1]


class SelectTest(unittest.TestCase):
    def test_refuses_without_starting_preparation_when_userns_and_cgroup_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(select(tmp, "/usr/bin/false"),
                             (3, False, {"event": "select", "selected": "refused",
                                         "preparation_started": False}))

    def test_starts_preparation_when_userns_succeeds(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(select(tmp, "/usr/bin/true"),
                             (0, True, {"event": "select", "selected": "userns",
                                        "preparation_started": True}))


if __name__ == "__main__":
    unittest.main()
