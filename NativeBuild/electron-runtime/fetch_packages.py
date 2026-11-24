#!/usr/bin/env python3
"""Acquire the hash-locked Electron runtime packages, never host-install them.

The checked-in lock records the original signed Debian snapshot acquisition.
Normal builds consume that immutable selection rather than resolving new versions.
Maintainer scripts and downloaded binaries are never executed by this tool.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from acquire import digest, download


ROOT = Path(__file__).resolve().parent


def prepare(prefix, lock_path):
    prefix = prefix.resolve()
    prefix.mkdir(parents=True, exist_ok=True)
    lock = json.loads(lock_path.read_text())
    if lock["architecture"] != "i386" or not lock["packages"]:
        raise RuntimeError("Expected a nonempty pinned i386 runtime package set")
    stamp = prefix / ".extracted-lock.sha256"
    lock_hash = digest(lock_path).hexdigest()
    if stamp.exists() and stamp.read_text().strip() != lock_hash:
        raise RuntimeError("Runtime lock changed; select a fresh prefix")
    root = prefix / "root"
    inventory_path = prefix / "installed-files.json"
    reuse = stamp.exists()
    if root.is_symlink():
        raise RuntimeError("Runtime root must not be a symlink")
    if reuse:
        if not root.is_dir() or not inventory_path.is_file():
            raise RuntimeError("Stamped runtime root or original inventory is missing; select a fresh prefix")
        original_inventory = json.loads(inventory_path.read_text())
        if not isinstance(original_inventory, dict) or not original_inventory:
            raise RuntimeError("Stamped runtime inventory is invalid or empty; select a fresh prefix")
    else:
        if root.exists() and any(root.iterdir()):
            raise RuntimeError("Unrecorded runtime root; select a fresh prefix")
        root.mkdir(exist_ok=True)
    for name, record in lock["packages"].items():
        filename = Path(urllib.parse.urlparse(record["url"]).path).name
        archive = download(record["url"], prefix / "archives" / filename, record["sha256"])
        control = subprocess.check_output(["dpkg-deb", "--field", str(archive)], text=True)
        fields = dict(line.split(": ", 1) for line in control.splitlines()
                      if ": " in line and not line[0].isspace())
        if any(fields.get(field) != record["control"][field]
               for field in ("Package", "Version", "Architecture")):
            raise RuntimeError(f"Package control identity mismatch: {archive}")
        if not reuse:
            subprocess.run(["dpkg-deb", "--extract", str(archive), str(root)], check=True)
        print(f"verified original package: {name} {fields['Version']}", flush=True)
    installed = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            installed[relative] = {"symlink": str(path.readlink())}
        elif path.is_file():
            installed[relative] = {"sha256": digest(path).hexdigest()}
        elif not path.is_dir():
            raise RuntimeError(f"Unsupported runtime file type: {path}")
    if reuse:
        if installed != original_inventory:
            raise RuntimeError("Runtime files or symlinks differ from the original inventory; select a fresh prefix")
    else:
        inventory_path.write_text(json.dumps(installed, sort_keys=True, indent=2) + "\n")
        (prefix / "packages.lock.json").write_text(lock_path.read_text())
        stamp.write_text(lock_hash + "\n")
    print(f"Unmodified runtime package input prefix: {root}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, required=True, help="new isolated runtime cache")
    parser.add_argument("--lock", type=Path, default=ROOT / "packages.lock.json")
    args = parser.parse_args()
    prepare(args.prefix, args.lock)
