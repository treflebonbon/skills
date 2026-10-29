"""Create the private network before bubblewrap seals the filesystem and PID tree."""

import fcntl
import os
from pathlib import Path
import socket
import struct
import sys


def main():
    uid, gid = os.getuid(), os.getgid()
    original_network = Path("/proc/self/ns/net").stat().st_ino
    os.unshare(os.CLONE_NEWUSER)
    Path("/proc/self/setgroups").write_text("deny")
    Path("/proc/self/uid_map").write_text(f"{uid} {uid} 1")
    Path("/proc/self/gid_map").write_text(f"{gid} {gid} 1")
    os.unshare(os.CLONE_NEWNET)
    if Path("/proc/self/ns/net").stat().st_ino == original_network:
        raise OSError("private network namespace was not created")
    # This sysctl belongs to the new network namespace. It lets the public-only
    # DNS listener bind port 53 after bubblewrap drops every capability.
    Path("/proc/sys/net/ipv4/ip_unprivileged_port_start").write_text("0")
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
        fcntl.ioctl(
            control, 0x8914, struct.pack("16sH14x", b"lo", 1)
        )  # SIOCSIFFLAGS, IFF_UP
    os.execv(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    try:
        main()
    except OSError:
        print(
            "codex-worktree: private network setup failed; Codex was not started",
            file=sys.stderr,
        )
        sys.exit(1)
