"""Run the Bun gateway behind a Unix socket for existing protocol fixtures."""

import base64
import json
import select
import subprocess


class GatewayFixture:
    def __init__(self, root, service, *, domains=None, github_policy=None, github_seed=None):
        self.child = subprocess.Popen(
            [root / "lib/bun/run", "run", root / "tests/helpers/raw-gateway-fixture.ts"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            request = {"service": service, "domains": domains, "githubPolicy": github_policy}
            if github_seed:
                request["githubSeed"] = {
                    "pack": base64.b64encode(github_seed["pack"]).decode("ascii"),
                    "pushHelper": github_seed["push_helper"],
                }
            self.child.stdin.write(json.dumps(request) + "\n")
            self.child.stdin.flush()
            if not select.select([self.child.stdout], [], [], 30)[0]:
                raise AssertionError("gateway fixture did not become ready")
            self.server_address = self.child.stdout.readline().strip()
            if not self.server_address:
                raise AssertionError("gateway fixture exited before publishing the socket")
        except BaseException as error:
            try:
                self.shutdown()
            except BaseException as cleanup_error:
                error.add_note(f"gateway fixture cleanup failed: {cleanup_error}")
            raise

    def shutdown(self):
        try:
            try:
                self.child.stdin.close()
            except BrokenPipeError:
                pass
            returncode = self.child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait()
            raise
        finally:
            self.child.stdout.close()
        if returncode != 0:
            raise AssertionError(f"gateway fixture exited with status {returncode}")
