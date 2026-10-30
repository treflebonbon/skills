"""Read-only resolution and verification of a Git worktree's metadata."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
from dataclasses import dataclass, field


class InvalidContext(Exception):
    """The current directory does not have valid Git worktree metadata."""


def git_environment() -> dict[str, str]:
    """Return the caller environment without variables that redirect Git."""
    return {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}


def _git_environment() -> dict[str, str]:
    environment = git_environment()
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    return environment


def _git_executable() -> str:
    executable = shutil.which("git")
    if not executable:
        raise InvalidContext("Git is required to resolve worktree metadata")
    try:
        return str(Path(executable).resolve(strict=True))
    except OSError as error:
        raise InvalidContext("Git executable is unavailable") from error


def git_path(directory: str | os.PathLike[str], option: str) -> Path:
    """Resolve one Git path from a directory without trusting inherited GIT_* values."""
    result = subprocess.run(
        [
            _git_executable(),
            "-C",
            str(directory),
            "rev-parse",
            "--path-format=absolute",
            option,
        ],
        env=_git_environment(),
        capture_output=True,
        text=True,
        check=True,
    )
    return Path(result.stdout.rstrip("\n")).resolve(strict=True)


def metadata_target(path: Path, prefix: str = "") -> Path:
    """Read a single-line Git metadata pointer and resolve its existing target."""
    if path.is_symlink():
        raise InvalidContext("symlinked Git metadata pointer")
    lines = path.read_text(encoding="utf-8").splitlines()
    if len(lines) != 1 or not lines[0].startswith(prefix):
        raise InvalidContext("invalid Git metadata pointer")
    target = lines[0][len(prefix) :].strip()
    if not target:
        raise InvalidContext("empty Git metadata pointer")
    return (path.parent / target).resolve(strict=True)


@dataclass(frozen=True)
class Repository:
    """The verified root and exact Git metadata paths for one checkout."""

    root: Path
    git_dir: Path
    common_dir: Path
    _linked_only: bool = field(default=False, compare=False, repr=False)
    _allow_gitfile: bool = field(default=False, compare=False, repr=False)

    @classmethod
    def discover(
        cls,
        directory: str | os.PathLike[str],
        linked_only: bool = False,
        *,
        allow_gitfile: bool = False,
    ) -> Repository:
        """Resolve metadata and verify the linked worktree's full ownership chain.

        `linked_only=True` rejects the primary checkout and unlinked gitfiles. The
        default accepts a primary checkout whose `.git` directory matches Git's
        resolved metadata. `allow_gitfile=True` is reserved for explicit callers
        that need to opt into an unlinked gitfile.
        """
        try:
            root = git_path(directory, "--show-toplevel")
            git_dir = git_path(root, "--git-dir")
            common = git_path(root, "--git-common-dir")
            pointer = root / ".git"
            if pointer.is_symlink():
                raise InvalidContext("symlinked worktree metadata")
            if git_dir == common:
                if linked_only or not (
                    (pointer.is_dir() and pointer.resolve() == common)
                    or (
                        allow_gitfile
                        and pointer.is_file()
                        and metadata_target(pointer, "gitdir:") == git_dir
                    )
                ):
                    raise InvalidContext("current directory is not a linked Git worktree")
            elif not (
                metadata_target(pointer, "gitdir:") == git_dir
                and metadata_target(git_dir / "commondir") == common
                and git_dir.parent == common / "worktrees"
                and metadata_target(git_dir / "gitdir") == pointer
            ):
                raise InvalidContext("linked worktree metadata ownership does not match")
            return cls(root, git_dir, common, linked_only, allow_gitfile)
        except (
            OSError,
            ValueError,
            RuntimeError,
            subprocess.CalledProcessError,
        ) as error:
            raise InvalidContext("cannot resolve Git worktree metadata") from error

    def check_unchanged(self, identity: dict[str, object]) -> None:
        """Revalidate the ownership chain and common Git directory identity."""
        if (
            self.discover(
                self.root,
                self._linked_only,
                allow_gitfile=self._allow_gitfile,
            )
            != self
            or self.identity() != identity
        ):
            raise InvalidContext("worktree metadata changed during preparation")

    def identity(self) -> dict[str, object]:
        """Return stable filesystem identity for the shared Git directory."""
        stat = self.common_dir.stat()
        return {
            "common_dir": str(self.common_dir),
            "device": stat.st_dev,
            "inode": stat.st_ino,
        }
