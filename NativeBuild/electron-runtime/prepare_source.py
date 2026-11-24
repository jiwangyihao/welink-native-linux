#!/usr/bin/env python3
"""Fetch upstream Electron sources and apply only the recorded Linux ia32 patchset."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from acquire import verify


ROOT = Path(__file__).resolve().parent


def git(path, *arguments):
    return subprocess.check_output(["git", "-C", str(path), *arguments], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, required=True, help="new empty parent of src/electron")
    parser.add_argument("--depot-tools", type=Path, required=True, help="checkout at the locked depot_tools commit")
    args = parser.parse_args()
    lock = json.loads((ROOT / "source-lock.json").read_text())
    depot = args.depot_tools.resolve(strict=True)
    if git(depot, "rev-parse", "HEAD") != lock["depotTools"]["commit"]:
        raise RuntimeError("depot_tools must be checked out at the recorded commit")
    if git(depot, "status", "--porcelain", "--untracked-files=no"):
        raise RuntimeError("depot_tools contains tracked modifications")
    checkout = args.checkout.absolute()
    if checkout.is_symlink() or (checkout.exists() and any(checkout.iterdir())):
        raise RuntimeError("Use a new empty checkout; existing source trees are never changed")
    checkout.mkdir(parents=True, exist_ok=True)
    (checkout / ".gclient").write_text(
        "solutions = [{'name': 'src/electron', 'url': 'https://github.com/electron/electron', "
        "'deps_file': 'DEPS', 'managed': False, 'custom_deps': {}, 'custom_vars': {}}]\n")
    environment = dict(os.environ, DEPOT_TOOLS_UPDATE="0", DEPOT_TOOLS_WIN_TOOLCHAIN="0",
                       PATH=str(depot) + os.pathsep + os.environ["PATH"],
                       GIT_COMMITTER_NAME="WeLink native source builder", GIT_COMMITTER_EMAIL="build@localhost",
                       GIT_AUTHOR_NAME="WeLink native source builder", GIT_AUTHOR_EMAIL="build@localhost")
    electron = lock["repositories"]["electron"]["upstreamCommit"]
    subprocess.run([str(depot / "gclient"), "sync", "--nohooks", "--revision", "src/electron@" + electron],
                   cwd=checkout, env=environment, check=True)
    subprocess.run([str(depot / "gclient"), "runhooks"], cwd=checkout, env=environment, check=True)
    # Electron's official hooks apply its checked-in Chromium/V8/Node patches.
    # Git commit metadata may differ; exact resulting content must not.
    for name, record in lock["repositories"].items():
        repository = checkout / record["path"]
        if git(repository, "rev-parse", "HEAD^{tree}") != record["electronPatchedTree"]:
            raise RuntimeError(f"Electron upstream patch-stack content differs: {name}")
        if git(repository, "status", "--porcelain", "--untracked-files=no"):
            raise RuntimeError(f"Unexpected tracked source modifications: {name}")
        if "portPatch" in record:
            patch = ROOT / record["portPatch"]
            verify(patch, record["patchSha256"])
            subprocess.run(["git", "-C", str(repository), "apply", "--check", str(patch)], check=True)
            subprocess.run(["git", "-C", str(repository), "apply", str(patch)], check=True)
    output = checkout / "src/out/ia32"
    output.mkdir(parents=True)
    shutil.copy2(ROOT / "args.gn", output / "args.gn")
    print(f"Prepared locked Electron source: {checkout / 'src'}")
    print("Next: acquire the pinned ia32 sysroot with bootstrap.py --component toolchain --toolchain-prefix SRC, then gn gen out/ia32 and autoninja -C out/ia32 electron:electron_dist_zip")


if __name__ == "__main__":
    main()
