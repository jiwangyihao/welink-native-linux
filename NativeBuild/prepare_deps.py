#!/usr/bin/env python3
"""Extract the locked Debian ia32 build dependencies without installing packages."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tarfile

from acquire import digest, download, tree_inventory


LOCK = Path(__file__).with_name("dependencies.lock.json")


def prepare(prefix, lock_path=LOCK, archives=None):
    prefix = prefix.resolve()
    prefix.mkdir(parents=True, exist_ok=True)
    lock = json.loads(lock_path.read_text())
    selected = lock["packages"]
    if lock["target"] != "i686-linux-gnu" or not selected:
        raise RuntimeError("Expected a nonempty locked i686-linux-gnu dependency set")
    archives = (archives or prefix / "archives").resolve()
    archives.mkdir(parents=True, exist_ok=True)
    root = prefix / "sysroot"
    stamp = prefix / ".extracted-lock.sha256"
    inventory_path = prefix / "installed-files.json"
    lock_hash = digest(lock_path).hexdigest()
    if stamp.exists() and stamp.read_text().strip() != lock_hash:
        raise RuntimeError("Dependency lock changed; select a fresh prefix")
    reuse = stamp.exists()
    if root.is_symlink() or (prefix / "runtime").is_symlink():
        raise RuntimeError("Extracted dependency roots must not be symlinks")
    if root.exists() and any(root.iterdir()) and not reuse:
        raise RuntimeError("Unrecorded sysroot: use a fresh prefix")
    if reuse:
        if not root.is_dir() or not (prefix / "runtime").is_dir() or not inventory_path.is_file():
            raise RuntimeError("Original dependency inventory or root is missing; use a fresh prefix")
        original = json.loads(inventory_path.read_text())
        current = {"sysroot": tree_inventory(root), "runtime": tree_inventory(prefix / "runtime")}
        if current != original:
            raise RuntimeError("Dependency files or symlinks differ from the original inventory; use a fresh prefix")
    root.mkdir(exist_ok=True)
    library_root = root / "lib"
    if not library_root.exists() and not library_root.is_symlink():
        library_root.symlink_to("usr/lib", target_is_directory=True)
    runtime_files = set()
    names = set()
    for record in selected:
        name = record["Package"]
        if name in names or record["Architecture"] not in ("i386", "all"):
            raise RuntimeError(f"Duplicate or wrong-architecture package: {name}")
        names.add(name)
        archive = download(record["url"], archives / Path(record["Filename"]).name, record["SHA256"])
        control = subprocess.check_output(["dpkg-deb", "--field", str(archive)], text=True)
        fields = dict(line.split(": ", 1) for line in control.splitlines()
                      if ": " in line and not line[0].isspace())
        if any(fields.get(field) != record[field] for field in ("Package", "Version", "Architecture")):
            raise RuntimeError(f"Package control identity mismatch: {archive}")
        if not name.startswith(("libc6", "libc-dev")):
            process = subprocess.Popen(["dpkg-deb", "--fsys-tarfile", str(archive)], stdout=subprocess.PIPE)
            with tarfile.open(fileobj=process.stdout, mode="r|") as members:
                for member in members:
                    relative = Path(member.name)
                    if relative.is_absolute() or ".." in relative.parts:
                        raise RuntimeError(f"Unsafe package member: {member.name}")
                    if re.search(r"\.so(?:\.\d+)*$", relative.name) and (member.isfile() or member.issym()):
                        runtime_files.add(relative)
            process.stdout.close()
            if process.wait() != 0:
                raise RuntimeError(f"Package inventory failed: {name}")
        if not reuse:
            subprocess.run(["dpkg-deb", "--extract", str(archive), str(root)], check=True)
        print(f"prepared {name} {record['Version']} {record['Architecture']}", flush=True)
    runtime = prefix / "runtime"
    runtime.mkdir(exist_ok=True)
    # Resolve aliases only inside the sysroot, never through host absolute links.
    aliases = []
    for relative in sorted(runtime_files):
        source = root / relative
        if source.is_symlink():
            target = source.readlink()
            resolved = (root / target.relative_to("/") if target.is_absolute() else source.parent / target).resolve(strict=True)
            if not resolved.is_relative_to(root):
                raise RuntimeError(f"Library alias escapes the extracted root: {source}")
            aliases.append((source.name, resolved.name))
            continue
        if not source.is_file():
            raise RuntimeError(f"Missing locked runtime file: {source}")
        with source.open("rb") as stream:
            if stream.read(5) != b"\x7fELF\x01":
                continue
        destination = runtime / source.name
        if destination.is_symlink() and destination.readlink() == source:
            continue
        if destination.exists() or destination.is_symlink():
            raise RuntimeError(f"Runtime SONAME collision: {source.name}")
        destination.symlink_to(source)
    while aliases:
        remaining = []
        for name, target in aliases:
            if not (runtime / target).exists():
                remaining.append((name, target))
                continue
            destination = runtime / name
            if destination.is_symlink() and destination.resolve() == (runtime / target).resolve():
                continue
            if destination.exists() or destination.is_symlink():
                raise RuntimeError(f"Runtime alias collision: {name}")
            destination.symlink_to(target)
        if len(remaining) == len(aliases):
            raise RuntimeError(f"Unresolved runtime aliases: {remaining}")
        aliases = remaining
    if not reuse:
        installed = {"sysroot": tree_inventory(root), "runtime": tree_inventory(runtime)}
        inventory_path.write_text(json.dumps(installed, sort_keys=True, indent=2) + "\n")
    (prefix / "packages.lock.json").write_text(lock_path.read_text())
    stamp.write_text(lock_hash + "\n")
    print(json.dumps({"sysroot": str(root), "runtime": str(runtime), "packages": len(selected)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prefix", type=Path, help="new isolated dependency prefix")
    parser.add_argument("--lock", type=Path, default=LOCK)
    parser.add_argument("--archives", type=Path, help="optional existing archive cache (hashes are always checked)")
    args = parser.parse_args()
    prepare(args.prefix, args.lock, args.archives)
