#!/usr/bin/env python3
"""Unpack pinned source inputs and assemble the real Linux ia32 addon layout.

No npm lifecycle scripts, source-package JavaScript, native addons or SDKs are
executed here. The private vendor ffi/ref versions are not reused: see the
compatibility record in source-lock.json. Both JavaScript and native sources
always come from the same upstream release pair.
"""

import argparse
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile


INPUTS = Path(__file__).resolve().parent


def digest(path, algorithm="sha256"):
    value = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value


def load_locks():
    source_lock = json.loads((INPUTS / "source-lock.json").read_text())
    package_lock = INPUTS / "package-lock.json"
    if digest(package_lock).hexdigest() != source_lock["packageLockSha256"]:
        raise RuntimeError("package-lock.json differs from the pinned source lock")
    packages = json.loads(package_lock.read_text())["packages"]
    return source_lock, [(path, entry) for path, entry in packages.items() if path]


def verify_elf32(path):
    with path.open("rb") as stream:
        header = stream.read(20)
    # ELF32, little-endian, current ELF version, ET_DYN, EM_386.
    if (header[:7] != b"\x7fELF\x01\x01\x01"
            or header[16:20] != b"\x03\x00\x03\x00"):
        raise RuntimeError(f"Expected Linux ia32 ELF shared object/PIE: {path}")


def verify_toolchain(electron_source, source_lock):
    toolchain = source_lock["toolchain"]
    revision = electron_source / "third_party/llvm-build/Release+Asserts/cr_build_revision"
    if revision.read_text().strip() != toolchain["clangRevision"]:
        raise RuntimeError("The bundled clang revision differs from the pinned compiler")
    stamp = electron_source / toolchain["sysroot"] / ".stamp"
    if stamp.read_text().strip() != toolchain["sysrootUrl"]:
        raise RuntimeError("The sysroot is not the pinned Electron Bullseye i386 sysroot")
    hashes = {}
    for relative, expected_hash in toolchain["sha256"].items():
        path = (electron_source / relative).resolve(strict=True)
        if path not in hashes:
            hashes[path] = digest(path).hexdigest()
        if hashes[path] != expected_hash:
            raise RuntimeError(f"Compiler/linker integrity mismatch: {path}")


def package_destination(root, package_path):
    # Preserve npm's nested dependency resolution, but ffiPath points outside
    # node_modules at node-ffi/ffi-napi in the application.
    relative = PurePosixPath(package_path)
    if (relative.is_absolute() or ".." in relative.parts
            or relative.parts[0] != "node_modules"):
        raise RuntimeError(f"Invalid package path in lockfile: {package_path}")
    if package_path == "node_modules/ffi-napi":
        return root / "ffi-napi"
    return root.joinpath(*relative.parts)


def extract_source(archive, destination, root_name):
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or path.parts[0] != root_name:
                raise RuntimeError(f"Unsafe archive member: {archive}: {member.name}")
            relative = PurePosixPath(*path.parts[1:])
            if not relative.parts:
                continue
            # Published upstream archives contain foreign-platform prebuilds.
            # They are never unpacked, used as build inputs or deployed.
            if "prebuilds" in relative.parts or relative.suffix == ".node":
                continue
            target = destination.joinpath(*relative.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as reader, target.open("xb") as writer:
                    shutil.copyfileobj(reader, writer)
                target.chmod(member.mode & 0o755)
            else:
                raise RuntimeError(f"Unsupported archive link/device: {member.name}")


def unpack(work, electron_source, archive_root):
    source_lock, packages = load_locks()
    verify_toolchain(electron_source, source_lock)
    headers = source_lock["electron"]["headers"]
    header_archive = archive_root / headers["archive"]
    if digest(header_archive).hexdigest() != headers["sha256"]:
        raise RuntimeError("Electron header archive integrity mismatch")
    archives = []
    for package_path, entry in packages:
        archive = archive_root / entry["resolved"].rsplit("/", 1)[1]
        actual = "sha512-" + base64.b64encode(digest(archive, "sha512").digest()).decode("ascii")
        if actual != entry["integrity"]:
            raise RuntimeError(f"npm archive integrity mismatch: {archive}")
        archives.append((package_path, entry, archive))
    sources = work / "sources"
    sources.mkdir()
    for package_path, entry, archive in archives:
        destination = package_destination(sources, package_path)
        extract_source(archive, destination, "package")
        metadata = json.loads((destination / "package.json").read_text())
        expected_name = package_path.rsplit("node_modules/", 1)[1]
        if metadata["name"] != expected_name or metadata["version"] != entry["version"]:
            raise RuntimeError(f"Package identity does not match lockfile: {archive}")
    extract_source(header_archive, work / "headers", headers["archiveRoot"])
    for license in source_lock["electron"]["licenses"]:
        source = archive_root / license["archive"]
        if digest(source).hexdigest() != license["sha256"]:
            raise RuntimeError(f"License integrity mismatch: {source}")
        destination = work / "licenses" / license["directory"]
        destination.mkdir(parents=True)
        shutil.copy2(source, destination / "LICENSE")


def install(work, output):
    _, packages = load_locks()
    sources = work / "sources"
    ffi_binding = sources / "ffi-napi/build/Release/ffi_bindings.node"
    ref_binding = sources / "node_modules/ref-napi/build/Release/binding.node"
    verify_elf32(ffi_binding)
    verify_elf32(ref_binding)
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise RuntimeError(f"Refusing to merge into a non-empty runtime directory: {output}")
    for package_path, _ in packages:
        source = package_destination(sources, package_path)
        destination = package_destination(output, package_path)
        if package_path in ("node_modules/ffi-napi", "node_modules/ref-napi"):
            destination.mkdir(parents=True)
            for filename in ("package.json", "LICENSE"):
                shutil.copy2(source / filename, destination / filename)
            shutil.copytree(source / "lib", destination / "lib")
            shutil.copytree(source / "build/Release", destination / "build/Release")
            if package_path == "node_modules/ref-napi":
                shutil.copytree(source / "include", destination / "include")
            else:
                licenses = destination / "deps/libffi"
                licenses.mkdir(parents=True)
                for filename in ("LICENSE", "LICENSE-BUILDTOOLS"):
                    shutil.copy2(source / "deps/libffi" / filename, licenses / filename)
        else:
            # Each nested dependency has its own lock entry; never duplicate it
            # by recursively copying a parent's node_modules.
            shutil.copytree(source, destination,
                            ignore=shutil.ignore_patterns("node_modules", "prebuilds"))
    shutil.copytree(work / "licenses", output / "licenses")
    for package_path, entry in packages:
        source = package_destination(sources, package_path)
        name = package_path.rsplit("node_modules/", 1)[1]
        notices = [p for p in source.iterdir()
                   if p.is_file() and p.name.lower().startswith(("license", "copying", "notice"))]
        if not notices:
            raise RuntimeError(f"Upstream package has no legal notice: {name}")
        destination = output / "licenses" / f"{name}-{entry['version']}"
        destination.mkdir(parents=True)
        for notice in notices:
            shutil.copy2(notice, destination / notice.name)
    shutil.copytree(sources / "ffi-napi/deps/libffi", output / "licenses/libffi",
                    ignore=lambda directory, names: [name for name in names
                                                     if name not in ("LICENSE", "LICENSE-BUILDTOOLS")])
    shutil.copytree(INPUTS / "metadata", output / "metadata")
    for filename in ("source-lock.json", "package-lock.json"):
        shutil.copy2(INPUTS / filename, output / filename)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    unpack_parser = commands.add_parser("unpack")
    unpack_parser.add_argument("--work", type=Path, required=True)
    unpack_parser.add_argument("--electron-source", type=Path, required=True)
    unpack_parser.add_argument("--archives", type=Path, default=INPUTS / "archives")
    install_parser = commands.add_parser("install")
    install_parser.add_argument("--work", type=Path, required=True)
    install_parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "unpack":
        unpack(args.work, args.electron_source, args.archives)
    else:
        install(args.work, args.output)


if __name__ == "__main__":
    main()
