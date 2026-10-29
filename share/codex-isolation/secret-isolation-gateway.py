#!/usr/bin/env python3
"""Single-service, fixed-endpoint gateways for the #270 runtime experiment."""

import argparse
from contextlib import ExitStack, contextmanager
import http.client
from http.server import BaseHTTPRequestHandler
import ipaddress
import json
import os
from pathlib import Path
import runpy
import select
import shutil
import socket
import socketserver
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit


# The probe needs only the public Nix binary cache. Production domain policy
# remains a separate #271 integration decision.
DEPENDENCY_HOSTS = frozenset({"cache.nixos.org"})


def allowed_destination(host, domains):
    if not host or any(
        character not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for character in host
    ):
        return False
    return any(
        host == domain
        or (
            domain.startswith("**.")
            and (host == domain[3:] or host.endswith("." + domain[3:]))
        )
        for domain in domains
    )


def relay(left, right):
    peers = [left, right]
    while peers:
        ready, _, _ = select.select(peers, [], [], 120)
        if not ready:
            return
        for peer in ready:
            data = peer.recv(65536)
            target = right if peer is left else left
            if data:
                target.sendall(data)
            else:
                peers.remove(peer)
                target.shutdown(socket.SHUT_WR)


def checked_client_hello(stream, host, connection=None, timeout=10):
    """Buffer a bounded TLS ClientHello before forwarding any tunnel bytes.

    With a connection, the whole read shares one deadline instead of a per-read timeout.
    """
    deadline = time.monotonic() + timeout

    def read_exact(size):
        data = bytearray()
        while len(data) < size:
            if connection is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("TLS ClientHello timed out")
                connection.settimeout(remaining)
            chunk = stream.read(size - len(data))
            if not chunk:
                raise ValueError("truncated TLS ClientHello")
            data.extend(chunk)
        return bytes(data)

    wire = bytearray()
    handshake = bytearray()
    while len(handshake) < 4 or len(handshake) < 4 + int.from_bytes(
        handshake[1:4], "big"
    ):
        header = read_exact(5)
        size = int.from_bytes(header[3:5], "big")
        if (
            header[0] != 22
            or header[1:3] not in (b"\x03\x01", b"\x03\x03")
            or not 0 < size <= 16384
        ):
            raise ValueError("expected TLS handshake record")
        if len(wire) + 5 + size > 65536:
            raise ValueError("TLS ClientHello too large")
        payload = read_exact(size)
        wire.extend(header + payload)
        handshake.extend(payload)
        if handshake[0] != 1:
            raise ValueError("expected TLS ClientHello")
    if len(handshake) != 4 + int.from_bytes(handshake[1:4], "big"):
        raise ValueError("unexpected data after ClientHello")
    data = memoryview(handshake)[4:]
    offset = 0

    def take(size):
        nonlocal offset
        if offset + size > len(data):
            raise ValueError("malformed TLS ClientHello")
        value = bytes(data[offset : offset + size])
        offset += size
        return value

    def vector(width):
        return take(int.from_bytes(take(width), "big"))

    if take(2) != b"\x03\x03":
        raise ValueError("TLS 1.2 or later required")
    take(32)
    if len(vector(1)) > 32:
        raise ValueError("invalid TLS session id")
    ciphers = vector(2)
    if not ciphers or len(ciphers) % 2 or vector(1) != b"\x00":
        raise ValueError("invalid TLS negotiation")
    extensions = vector(2)
    if offset != len(data):
        raise ValueError("trailing ClientHello data")
    data, offset = memoryview(extensions), 0
    seen = set()
    server_name = None
    while offset < len(data):
        kind = int.from_bytes(take(2), "big")
        value = vector(2)
        # ECH can hide a different inner name; never authorize by its cover name.
        if kind in seen or kind == 0xfe0d:
            raise ValueError("duplicate or encrypted TLS extension")
        seen.add(kind)
        if kind == 0:
            expected = host.encode("ascii")
            entry = b"\x00" + len(expected).to_bytes(2, "big") + expected
            if value != len(entry).to_bytes(2, "big") + entry:
                raise ValueError("TLS server name differs from CONNECT destination")
            server_name = host
    if server_name is None:
        raise ValueError("TLS server name required")
    return bytes(wire)


def local_tools(tools):
    if not isinstance(tools, list):
        return False
    for tool in tools:
        if not isinstance(tool, dict):
            return False
        kind = tool.get("type")
        if kind == "namespace":
            if not local_tools(tool.get("tools", [])):
                return False
        elif kind not in ("function", "custom"):
            return False
    return True


def local_content(content):
    if not isinstance(content, list):
        return False
    for item in content:
        if not isinstance(item, dict):
            return False
        kind = item.get("type")
        if kind in (
            "input_text",
            "output_text",
            "summary_text",
            "reasoning_text",
            "encrypted_content",
        ):
            continue
        if kind == "input_image" and str(item.get("image_url", "")).startswith(
            "data:image/"
        ):
            continue
        if kind == "input_audio" and str(item.get("audio_url", "")).startswith(
            "data:audio/"
        ):
            continue
        return False
    return True


def local_request(payload):
    # Match the text/function Responses request emitted by the pinned Codex.
    # In particular, IDs must never grant access to an existing account item,
    # conversation, uploaded file, or server-executed tool.
    fields = {
        "model",
        "instructions",
        "input",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "reasoning",
        "store",
        "stream",
        "stream_options",
        "include",
        "service_tier",
        "prompt_cache_key",
        "text",
        "client_metadata",
    }
    if (
        not isinstance(payload, dict)
        or not payload.keys() <= fields
        or not local_tools(payload.get("tools", []))
    ):
        return False
    items = payload.get("input", [])
    if not isinstance(items, list):
        return False
    for item in items:
        if not isinstance(item, dict):
            return False
        kind = item.get("type")
        if kind == "additional_tools":
            if not local_tools(item.get("tools", [])):
                return False
        elif kind in ("message", "agent_message"):
            if not local_content(item.get("content")):
                return False
        elif kind in (
            "function_call",
            "function_call_output",
            "custom_tool_call",
            "custom_tool_call_output",
            "reasoning",
            "compaction",
        ):
            pass
        else:
            return False
    return True


def _cleanup(operation, *arguments):
    try:
        operation(*arguments)
    except Exception as error:
        message = f"gateway cleanup failed ({operation.__name__}): {error}"
        print(message, file=sys.stderr)
        return message


class UnixServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def __init__(self, directory, handler):
        address = str(directory / "service.sock")
        self.directory_fd = None
        # Linux isolation mounts this directory at a short /gateway path. Only
        # the host bind address needs a descriptor when TMPDIR is too long.
        if sys.platform == "linux" and len(os.fsencode(address)) > 107:
            self.directory_fd = os.open(
                directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
            )
            address = f"/proc/{os.getpid()}/fd/{self.directory_fd}/service.sock"
        try:
            super().__init__(address, handler)
        except BaseException:
            _cleanup(self.server_close)
            raise

    def server_close(self):
        try:
            if hasattr(self, "socket"):
                super().server_close()
        finally:
            if self.directory_fd is not None:
                os.close(self.directory_fd)
                self.directory_fd = None


class Gateway(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    # Tunnel handoff must not strand prefetched TLS bytes in rfile.
    rbufsize = 0

    def read_body(self, length):
        # An unbuffered rfile may return fewer bytes than requested.
        body = bytearray()
        while len(body) < length:
            chunk = self.rfile.read(length - len(body))
            if not chunk:
                raise ValueError("truncated request body")
            body.extend(chunk)
        return bytes(body)

    def log_message(self, *args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(120)

    def reject(self):
        self.send_response(403)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_PUT = do_DELETE = do_OPTIONS = do_HEAD = reject

    def do_PATCH(self):
        if getattr(self.server, "github", None) is not None:
            return self.github_request()
        return self.reject()

    def github_request(self):
        if self.server.service == "dependencies":
            address = urlsplit(self.path)
            if (
                address.scheme != "http"
                or address.netloc != "api.github.com"
                or address.fragment
                or not allowed_destination("api.github.com", self.server.domains)
                or allowed_destination("api.github.com", self.server.denied_domains)
            ):
                return self.reject()
            self.path = address.path + (("?" + address.query) if address.query else "")
        return self.server.github.handle(self)

    def do_CONNECT(self):
        if (
            self.server.service != "dependencies"
            or not self.path.endswith(":443")
            or not allowed_destination(self.path[:-4], self.server.domains)
            or allowed_destination(self.path[:-4], self.server.denied_domains)
        ):
            return self.reject()
        if (
            self.headers.get("Transfer-Encoding")
            or self.headers.get("Content-Length", "0") != "0"
            or self.headers.get("Proxy-Authorization")
        ):
            return self.reject()
        connected = False
        try:
            host = self.path[:-4]
            addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
            if not addresses or any(
                not ipaddress.ip_address(item[4][0]).is_global for item in addresses
            ):
                return self.reject()
            for family, kind, protocol, _, address in addresses:
                with socket.socket(family, kind, protocol) as upstream:
                    # Retry only addresses validated above; never resolve again.
                    upstream.settimeout(10)
                    try:
                        upstream.connect(address)
                    except OSError:
                        continue
                    upstream.settimeout(120)
                    self.send_response(200, "Connection established")
                    self.end_headers()
                    connected = True
                    hello = checked_client_hello(self.rfile, host, self.connection)
                    self.connection.settimeout(120)
                    upstream.sendall(hello)
                    self.server.requests += 1
                    relay(self.connection, upstream)
                    return
            self.fail_upstream()
        except (OSError, ValueError):
            if not connected:
                self.fail_upstream()

    def do_GET(self):
        if getattr(self.server, "github", None) is not None:
            return self.github_request()
        if (
            self.server.service != "github"
            or self.path != "/repos/octocat/Hello-World"
            or self.headers.get("Host") != "api.github.com"
        ):
            return self.reject()
        if (
            self.headers.get("Transfer-Encoding")
            or self.headers.get("Content-Length", "0") != "0"
        ):
            return self.reject()
        try:
            result = subprocess.run(
                [
                    self.server.gh,
                    "api",
                    "repos/octocat/Hello-World",
                    "--method",
                    "GET",
                    "--jq",
                    "{full_name:.full_name}",
                ],
                env={
                    "HOME": self.server.host_home,
                    "PATH": self.server.tool_path,
                    "GH_HOST": "github.com",
                    "GH_PROMPT_DISABLED": "1",
                },
                capture_output=True,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            return self.fail_upstream()
        if result.returncode:
            return self.fail_upstream()
        self.server.requests += 1
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(result.stdout)))
        self.end_headers()
        self.wfile.write(result.stdout)

    def fail_upstream(self):
        self.send_response(502)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if self.server.service == "dependencies" and self.path == "/resolve":
            return self.resolve_public_host()
        if getattr(self.server, "github", None) is not None:
            return self.github_request()
        if self.server.service != "model" or self.path != "/v1/responses":
            return self.reject()
        if self.headers.get("Transfer-Encoding") or self.headers.get(
            "Content-Encoding"
        ):
            return self.reject()
        length = self.headers.get("Content-Length", "")
        if not length.isdigit() or not 0 < int(length) <= 16 * 1024 * 1024:
            return self.reject()
        connection = None
        started = False
        try:
            payload = json.loads(self.read_body(int(length)))
            # Permit client-executed functions, never authenticated remote tools.
            if not local_request(payload):
                return self.reject()
            payload["store"] = False
            headers = {
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                "Authorization": "Bearer " + self.server.access_token,
                "ChatGPT-Account-Id": self.server.account_id,
                "User-Agent": "codex-isolation-probe/270",
            }
            connection = http.client.HTTPSConnection(
                "chatgpt.com", timeout=120, context=ssl.create_default_context()
            )
            connection.request(
                "POST",
                "/backend-api/codex/responses",
                body=json.dumps(payload).encode(),
                headers=headers,
            )
            response = connection.getresponse()
            self.server.last_status = response.status
            if response.status != 200:
                connection.close()
                self.send_response(response.status)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.server.requests += 1
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            started = True
            while chunk := response.read1(65536):
                self.wfile.write(chunk)
                self.wfile.flush()
        except (ValueError, TypeError, OSError, http.client.HTTPException):
            if not started:
                self.fail_upstream()
        finally:
            if connection is not None:
                connection.close()

    def resolve_public_host(self):
        length = self.headers.get("Content-Length", "")
        if (
            self.headers.get("Transfer-Encoding")
            or not length.isdigit()
            or not 0 < int(length) <= 1024
        ):
            return self.reject()
        try:
            request = json.loads(self.read_body(int(length)))
            if set(request) != {"host", "type"} or request["type"] not in (1, 28):
                return self.reject()
            if (
                not isinstance(request["host"], str)
                or not allowed_destination(request["host"], self.server.domains)
                or allowed_destination(request["host"], self.server.denied_domains)
            ):
                return self.reject()
            addresses = socket.getaddrinfo(
                request["host"], 443, type=socket.SOCK_STREAM
            )
            if any(
                not ipaddress.ip_address(item[4][0]).is_global for item in addresses
            ):
                return self.reject()
            family = socket.AF_INET if request["type"] == 1 else socket.AF_INET6
            answer = list(
                dict.fromkeys(item[4][0] for item in addresses if item[0] == family)
            )[:4]
            body = json.dumps(answer).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (OSError, ValueError, TypeError):
            self.fail_upstream()


def start_gateway(
    directory,
    service,
    *,
    domains=DEPENDENCY_HOSTS,
    denied_domains=(),
    codex_home=None,
    github_policy=None,
    github_seed=None,
):
    directory.mkdir(mode=0o700)
    server = UnixServer(directory, Gateway)
    try:
        server.service = service
        server.requests = 0
        server.last_status = None
        server.domains = domains
        server.denied_domains = denied_domains
        server.host_home = str(Path.home())
        if github_policy is not None:
            if service == "dependencies" and (
                not allowed_destination("api.github.com", domains)
                or allowed_destination("api.github.com", denied_domains)
            ):
                raise ValueError("GitHub is denied by the managed network policy")
            module = runpy.run_path(str(Path(__file__).with_name("github-service.py")))
            server.github = module["GitHubService"](github_policy)
            if github_seed is not None:
                server.github.enable_push(
                    directory.with_name(directory.name + "-publish"), **github_seed
                )
        if service == "github":
            server.gh = str(Path(shutil.which("gh")).resolve())
            server.tool_path = os.pathsep.join(
                {str(Path(shutil.which(name)).resolve().parent) for name in ("gh", "git")}
            )
        if service == "model":
            codex_home = codex_home or Path(
                os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))
            )
            with (codex_home / "auth.json").open() as source:
                tokens = json.load(source)["tokens"]
            server.access_token = tokens["access_token"]
            server.account_id = tokens["account_id"]
            if not server.access_token or not server.account_id:
                raise ValueError("host ChatGPT login is unavailable")
        threading.Thread(target=server.serve_forever, daemon=True).start()
    except BaseException:
        _cleanup(server.server_close)
        raise
    return server


class GatewayCleanupError(ValueError):
    pass


@contextmanager
def gateway_scope():
    errors = []

    def cleanup(operation, *arguments):
        if message := _cleanup(operation, *arguments):
            errors.append(message)

    with ExitStack() as resources:
        root = Path(tempfile.mkdtemp(prefix="cxi-"))
        resources.callback(cleanup, shutil.rmtree, root)

        def start(service, **options):
            directory = root / service
            server = start_gateway(directory, service, **options)
            resources.callback(cleanup, server.server_close)
            resources.callback(cleanup, server.shutdown)
            return directory

        failed = False
        try:
            yield start
        except BaseException:
            failed = True
            raise
        finally:
            resources.close()
            if errors and not failed:
                raise GatewayCleanupError("; ".join(errors))


def bridge(unix_socket, port):
    class Forward(socketserver.BaseRequestHandler):
        def handle(self):
            with socket.socket(socket.AF_UNIX) as upstream:
                upstream.connect(unix_socket)
                try:
                    relay(self.request, upstream)
                except OSError:
                    pass

    with socketserver.ThreadingTCPServer(("127.0.0.1", port), Forward) as server:
        print("ready", flush=True)
        server.serve_forever()


def dns_bridge(unix_socket):
    class Resolver(socketserver.BaseRequestHandler):
        def handle(self):
            packet, transport = self.request
            if len(packet) < 12:
                return
            try:
                identifier, flags, questions, _, _, _ = struct.unpack(
                    "!6H", packet[:12]
                )
                if flags & 0xF800 or questions != 1:
                    return
                offset, labels = 12, []
                while packet[offset]:
                    length = packet[offset]
                    if length > 63:
                        return
                    labels.append(
                        packet[offset + 1 : offset + 1 + length].decode("ascii")
                    )
                    offset += length + 1
                offset += 1
                kind, query_class = struct.unpack("!HH", packet[offset : offset + 4])
                question = packet[12 : offset + 4]
                host = ".".join(labels).lower()
                answer, error = b"", 3
                if kind in (1, 28) and query_class == 1 and len(host) <= 253:
                    connection = http.client.HTTPConnection("resolver", timeout=10)
                    connection.sock = socket.socket(socket.AF_UNIX)
                    connection.sock.settimeout(10)
                    connection.sock.connect(unix_socket)
                    try:
                        connection.request(
                            "POST", "/resolve", json.dumps({"host": host, "type": kind})
                        )
                        response = connection.getresponse()
                        if response.status == 200:
                            values = json.loads(response.read(1024))
                            error = 0
                            for value in values:
                                address = ipaddress.ip_address(value).packed
                                answer += (
                                    b"\xc0\x0c"
                                    + struct.pack("!HHIH", kind, 1, 30, len(address))
                                    + address
                                )
                    finally:
                        connection.close()
                count = len(answer) // (16 if kind == 1 else 28) if answer else 0
                header = struct.pack("!6H", identifier, 0x8180 | error, 1, count, 0, 0)
                transport.sendto(header + question + answer, self.client_address)
            except (
                OSError,
                ValueError,
                IndexError,
                struct.error,
                http.client.HTTPException,
            ):
                return

    with socketserver.ThreadingUDPServer(("127.0.0.1", 53), Resolver) as server:
        server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dns", action="store_true")
    parser.add_argument("socket")
    parser.add_argument("port", type=int, nargs="?")
    args = parser.parse_args()
    if args.dns:
        dns_bridge(args.socket)
    elif args.port is not None:
        bridge(args.socket, args.port)
    else:
        parser.error("a TCP port or --dns is required")
