import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "lib/python"))

from treflebonbon_skills.git_context import InvalidContext, Repository, git_environment


def git(*arguments):
    return subprocess.run(
        ["git", *map(str, arguments)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


class GitContextTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="skills-git-context.")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.repository = self.base / "repo"
        self.worktree = self.base / "review"
        git("init", "-q", self.repository)
        git("-C", self.repository, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "initial")
        git("-C", self.repository, "worktree", "add", "-q", "-b", "review", self.worktree)

    def test_discovery_returns_only_the_linked_worktree_git_metadata(self):
        repository = Repository.discover(self.worktree, linked_only=True)

        self.assertEqual(repository.root, self.worktree.resolve())
        self.assertEqual(repository.git_dir, (self.repository / ".git/worktrees/review").resolve())
        self.assertEqual(repository.common_dir, (self.repository / ".git").resolve())
        self.assertNotEqual(repository.git_dir, repository.common_dir)

    def test_primary_checkout_is_rejected_when_linked_worktree_is_required(self):
        with self.assertRaisesRegex(InvalidContext, "not a linked Git worktree"):
            Repository.discover(self.repository, linked_only=True)

    def test_primary_checkout_is_resolved_by_default(self):
        repository = Repository.discover(self.repository)

        self.assertEqual(repository.root, self.repository.resolve())
        self.assertEqual(repository.git_dir, repository.common_dir)

    def test_repository_identity_can_be_revalidated(self):
        repository = Repository.discover(self.worktree, linked_only=True)
        identity = repository.identity()

        self.assertEqual(identity["common_dir"], str(repository.common_dir))
        self.assertIsInstance(identity["device"], int)
        self.assertIsInstance(identity["inode"], int)
        repository.check_unchanged(identity)

    def test_broken_back_pointer_is_rejected(self):
        git_dir = self.repository / ".git/worktrees/review"
        (git_dir / "gitdir").write_text(str(self.base / "elsewhere/.git") + "\n", encoding="utf-8")

        with self.assertRaises(InvalidContext):
            Repository.discover(self.worktree, linked_only=True)

    def test_git_environment_removes_inherited_git_redirection(self):
        with patch.dict(os.environ, {"GIT_DIR": "/tmp/untrusted", "GIT_WORK_TREE": "/tmp/elsewhere"}):
            environment = git_environment()

        self.assertNotIn("GIT_DIR", environment)
        self.assertNotIn("GIT_WORK_TREE", environment)
        self.assertIn("PATH", environment)


if __name__ == "__main__":
    unittest.main()
