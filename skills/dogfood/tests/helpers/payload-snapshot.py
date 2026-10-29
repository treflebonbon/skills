#!/usr/bin/env python3
import hashlib
import json
import os
import stat
import sys


def ignored(name):
    return name == ".env" or name.startswith(".env.")


root = os.path.realpath(sys.argv[1])
entries = []
root_info = os.lstat(root)
entries.append(
    {
        "kind": "directory",
        "mode": stat.S_IMODE(root_info.st_mode),
        "path": ".",
    }
)
for current, directories, files in os.walk(root, topdown=True, followlinks=False):
    directories[:] = sorted(
        name for name in directories if name != ".git" and not ignored(name)
    )

    for name in list(directories):
        filename = os.path.join(current, name)
        info = os.lstat(filename)
        relative = os.path.relpath(filename, root)
        if stat.S_ISLNK(info.st_mode):
            entries.append(
                {
                    "kind": "symlink",
                    "mode": stat.S_IMODE(info.st_mode),
                    "path": relative,
                    "target": os.readlink(filename),
                }
            )
            directories.remove(name)
        else:
            entries.append(
                {
                    "kind": "directory",
                    "mode": stat.S_IMODE(info.st_mode),
                    "path": relative,
                }
            )

    for name in sorted(files):
        if name == ".git" or ignored(name):
            continue
        filename = os.path.join(current, name)
        relative = os.path.relpath(filename, root)
        info = os.lstat(filename)
        if stat.S_ISLNK(info.st_mode):
            entry = {
                "kind": "symlink",
                "mode": stat.S_IMODE(info.st_mode),
                "path": relative,
                "target": os.readlink(filename),
            }
        elif stat.S_ISREG(info.st_mode):
            digest = hashlib.sha256()
            with open(filename, "rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            entry = {
                "kind": "file",
                "mode": stat.S_IMODE(info.st_mode),
                "path": relative,
                "sha256": digest.hexdigest(),
            }
        else:
            entry = {
                "kind": "other",
                "mode": stat.S_IMODE(info.st_mode),
                "path": relative,
            }
        entries.append(entry)

print(json.dumps(sorted(entries, key=lambda entry: entry["path"]), sort_keys=True))
