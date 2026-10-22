"""Prepare Assisted-by trailers; Python 3 standard library only."""

import json
import os
from pathlib import Path
import subprocess
import sys


def git(*args, data=None, env=None):
    return subprocess.run(
        ["git", *args], input=data, env=env, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=True,
    ).stdout


def config(key, default):
    result = subprocess.run(["git", "config", "--get", key], stdout=subprocess.PIPE, check=False)
    if result.returncode not in (0, 1):
        raise ValueError("cannot read " + key)
    return result.stdout.decode().rstrip("\n") if result.returncode == 0 else default


def prepare(args):
    common = Path(os.fsdecode(
        git("rev-parse", "--path-format=absolute", "--git-common-dir")
    ).rstrip("\n")).resolve()
    # A custom hooks directory can be shared by unrelated repositories.
    if common != Path(__file__).resolve().parent.parent:
        return

    settings = json.loads((common / "trailmate/settings.json").read_text(encoding="utf-8"))
    if settings["enabled"] is not True:
        return

    root = os.path.realpath(os.fsdecode(git("rev-parse", "--show-toplevel")).rstrip("\n"))
    models = settings["models"].get(root, [])

    if not models or (len(args) > 1 and args[1] in ("merge", "squash")):
        return

    git_dir = Path(os.fsdecode(git("rev-parse", "--absolute-git-dir")).rstrip("\n"))
    if any((git_dir / name).exists() for name in ("rebase-merge", "rebase-apply", "MERGE_HEAD", "SQUASH_MSG")):
        return

    # Ignore configured trailer commands, which can replace supplied values.
    environment = dict(os.environ)
    for name in ("GIT_CONFIG_PARAMETERS", "GIT_CONFIG", "GIT_WORK_TREE"):
        environment.pop(name, None)
    environment.update(
        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
        GIT_CONFIG_SYSTEM=os.devnull, GIT_CONFIG_COUNT="0",
    )

    options = []
    for model in sorted(set(models)):
        options.extend(["--trailer", "Assisted-by: " + model])

    comment = config("core.commentString", config("core.commentChar", "#"))
    message = Path(args[0])
    message.write_bytes(git(
        "--git-dir=" + os.devnull,
        "-c", "core.commentChar=" + comment, "-c", "core.commentString=" + comment,
        "interpret-trailers", "--no-divider", "--if-exists=addIfDifferent", "--if-missing=add",
        *options, data=message.read_bytes(), env=environment,
    ))


if __name__ == "__main__":
    try:
        prepare(sys.argv[1:])
    except Exception as error:
        print("Trailmate: " + str(error), file=sys.stderr)
