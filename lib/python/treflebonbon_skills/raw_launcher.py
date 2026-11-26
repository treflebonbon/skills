"""Validate an explicitly selected launcher before and after copying its closure."""

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from typing import Collection

NIX_STORE = Path("/nix/store")
STORE_OUTPUT = re.compile(r"/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-[a-zA-Z0-9+._?=-]+")
EXECUTABLE = Path("bin/raw-codex-launcher")
MANIFEST = Path("share/raw-codex-launcher/manifest.json")
VERSION = "1"


def _open_store_file(root: Path, relative: Path, owner: int, mode: int):
    path = root / relative
    if root.resolve(strict=True) != root:
        raise ValueError(f"raw launcher must use its real Nix store path: {root}")
    for directory in (root, *(root / parent for parent in relative.parents[:-1])):
        metadata = directory.lstat()
        if metadata.st_uid != owner or metadata.st_mode != (stat.S_IFDIR | 0o555):
            raise ValueError(f"invalid Nix store directory owner or mode: {directory}")
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    stream = os.fdopen(fd, "rb")
    metadata = os.fstat(stream.fileno())
    if metadata.st_uid != owner or metadata.st_mode != (stat.S_IFREG | mode):
        stream.close()
        raise ValueError(f"invalid Nix store file owner or mode: {path}")
    return stream


def _verify_digest(root: Path, owner: int, expected: str):
    with _open_store_file(root, EXECUTABLE, owner, 0o555) as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != expected:
        raise ValueError("raw launcher executable digest does not match the selected package")


@dataclass(frozen=True)
class RawLauncher:
    """A validated package selected by trusted configuration."""

    package: Path
    digest: str

    @property
    def executable(self) -> Path:
        return self.package / EXECUTABLE

    def verify_copy(self, store: Path, closure: Collection[str]) -> None:
        """Check the executable in the exact store and closure about to be mounted."""
        if str(self.package) not in closure:
            raise ValueError("raw launcher package is missing from the selected closure")
        _verify_digest(store / self.package.name, os.geteuid(), self.digest)


def select_raw_launcher(package: str, source_sha256: str) -> RawLauncher:
    """Validate a canonical Nix output path and a source digest from the same release."""
    if not STORE_OUTPUT.fullmatch(package):
        raise ValueError("select a canonical Nix store output for the raw launcher")
    root = Path(package)
    owner = NIX_STORE.stat().st_uid
    with _open_store_file(root, MANIFEST, owner, 0o444) as stream:
        manifest = json.load(stream)
    if (
        not isinstance(manifest, dict)
        or manifest.get("version") != VERSION
        or manifest.get("sourceSha256") != source_sha256
        or re.fullmatch(r"[0-9a-f]{64}", source_sha256) is None
    ):
        raise ValueError("raw launcher source or version does not match trusted configuration")
    digest = manifest.get("sha256")
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ValueError("invalid raw launcher executable digest")
    _verify_digest(root, owner, digest)
    return RawLauncher(root, digest)
