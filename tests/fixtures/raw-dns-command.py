"""Capture the UDP DNS wire result against the unchanged Unix-socket HTTP protocol."""

from http.server import BaseHTTPRequestHandler
import json
from pathlib import Path
import socket
from socketserver import UnixStreamServer
import struct
import subprocess
import sys
import tempfile
from threading import Thread
import time


requests = []


class Resolver(BaseHTTPRequestHandler):
    def do_POST(self):
        assert self.path == "/resolve", self.path
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(data)
        addresses = {1: ["192.0.2.1"], 28: ["2001:db8::1"]}
        value = json.dumps(addresses[data["type"]]).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(value)))
        self.end_headers()
        self.wfile.write(value)

    def log_message(self, *args):
        pass


def query(client, kind):
    packet = struct.pack("!6H", 123, 0x0100, 1, 0, 0, 0)
    packet += b"\x07EXample\x07invalid\x00" + struct.pack("!HH", kind, 1)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        client.sendto(packet, ("127.0.0.1", 53))
        try:
            return client.recv(512).hex()
        except TimeoutError:
            continue
    raise TimeoutError("DNS bridge did not reply")


with tempfile.TemporaryDirectory(prefix="raw-dns-", dir="/tmp") as directory:
    path = str(Path(directory) / "socket")
    with UnixStreamServer(path, Resolver) as authority:
        worker = Thread(target=authority.serve_forever, daemon=True)
        worker.start()
        bridge = subprocess.Popen([*sys.argv[1:], "--dns", path])
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
                client.settimeout(0.1)
                observed = {str(kind): query(client, kind) for kind in (1, 28, 16)}
            assert all(request["host"] == "example.invalid" for request in requests), requests
            assert {request["type"] for request in requests} == {1, 28}, requests
            print("RAW_DNS " + json.dumps(observed, sort_keys=True))
        finally:
            bridge.terminate()
            bridge.wait(timeout=5)
            authority.shutdown()
            worker.join(timeout=5)
