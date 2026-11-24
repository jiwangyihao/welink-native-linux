#!/usr/bin/env python3
"""Acquire pinned public inputs and build JSON-C; no proprietary input is fetched."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from acquire import download, materialize, verify
from prepare_deps import prepare as prepare_deps


ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
COMPONENTS = ("toolchain", "deps", "sources", "ffi", "npm", "json-c", "runtime")


def fetch(record, cache):
    return download(record["url"], cache / record["archive"], record["sha256"])


def toolchain(args, sources, ffi):
    compiler = sources["clang"]
    sysroot = sources["ffi-sysroot"]
    destination = args.toolchain_prefix / compiler["destination"]
    archive = fetch(compiler, args.cache)
    materialize(archive, destination, compiler["sha256"],
                generated={"cr_build_revision": compiler["revision"] + "\n"})
    for relative, expected in ffi["toolchain"]["sha256"].items():
        verify(args.toolchain_prefix / relative, expected)
    destination = args.toolchain_prefix / sysroot["destination"]
    archive = fetch(sysroot, args.cache)
    materialize(archive, destination, sysroot["sha256"],
                generated={".stamp": sysroot["url"] + "\n"})


def source_archives(args, sources):
    record = sources["json-c"]
    materialize(fetch(record, args.cache), args.deps_prefix / "sources" / record["root"],
                record["sha256"], record["root"])
    record = sources["sqlite3mc"]
    materialize(fetch(record, args.cache), args.sqlite_source, record["sha256"])


def ffi_archives(args, ffi):
    package_lock = ROOT / "ffi/package-lock.json"
    verify(package_lock, ffi["packageLockSha256"])
    for name, record in json.loads(package_lock.read_text())["packages"].items():
        if name:
            download(record["resolved"], args.ffi_archives / record["resolved"].rsplit("/", 1)[1], record["integrity"])
    for record in [ffi["electron"]["headers"], *ffi["electron"]["licenses"]]:
        fetch(record, args.ffi_archives)


def build_json(args):
    llvm = args.toolchain_prefix / "third_party/llvm-build/Release+Asserts/bin"
    sysroot = args.deps_prefix / "sysroot"
    source = args.deps_prefix / "sources/json-c-0.19"
    for required in (source / "CMakeLists.txt", sysroot / "usr/include/stdio.h", llvm / "clang"):
        if not required.is_file():
            raise RuntimeError(f"Missing JSON-C prerequisite: {required}; acquire toolchain, deps and sources first")
    work = args.work / "json-c"
    environment = {key: value for key, value in os.environ.items()
                   if key not in ("CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "LIBRARY_PATH", "CFLAGS", "CPPFLAGS", "LDFLAGS")}
    environment.update(LC_ALL="C", SOURCE_DATE_EPOCH="1616074138")
    subprocess.run(["cmake", "-S", str(source), "-B", str(work),
                    "-DCMAKE_SYSTEM_NAME=Linux", "-DCMAKE_SYSTEM_PROCESSOR=i686",
                    f"-DCMAKE_C_COMPILER={llvm / 'clang'}", "-DCMAKE_C_COMPILER_TARGET=i686-linux-gnu",
                    f"-DCMAKE_C_COMPILER_EXTERNAL_TOOLCHAIN={sysroot / 'usr'}", f"-DCMAKE_SYSROOT={sysroot}",
                    f"-DCMAKE_AR={llvm / 'llvm-ar'}", "-DCMAKE_BUILD_TYPE=Release",
                    "-DCMAKE_C_FLAGS=-fPIC -fvisibility=hidden", f"-DCMAKE_INSTALL_PREFIX={args.json_prefix}",
                    "-DBUILD_SHARED_LIBS=OFF", "-DBUILD_STATIC_LIBS=ON", "-DBUILD_APPS=OFF",
                    "-DBUILD_TESTING=OFF", "-DENABLE_THREADING=ON", "-DENABLE_RDRAND=OFF"],
                   env=environment, check=True)
    subprocess.run(["cmake", "--build", str(work), "--parallel", str(args.jobs)], env=environment, check=True)
    subprocess.run(["cmake", "--install", str(work)], env=environment, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--component", choices=COMPONENTS, action="append", help="repeat to select components; default: all")
    parser.add_argument("--cache", type=Path, default=REPO / ".inputs/archives")
    parser.add_argument("--deps-prefix", type=Path, default=REPO / ".inputs/native-deps")
    parser.add_argument("--deps-archives", type=Path, help="hash-verified Debian development-package cache")
    parser.add_argument("--toolchain-prefix", type=Path, default=REPO / ".inputs/electron-toolchain")
    parser.add_argument("--json-prefix", type=Path, default=ROOT / "json-c")
    parser.add_argument("--sqlite-source", type=Path, default=REPO / "vendor/sqlite3mc-1.4.6")
    parser.add_argument("--ffi-archives", type=Path, default=ROOT / "ffi/archives")
    parser.add_argument("--runtime-prefix", type=Path, default=REPO / ".inputs/electron-runtime")
    parser.add_argument("--runtime-archives", type=Path, help="hash-verified Debian runtime-package cache")
    parser.add_argument("--work", type=Path, default=REPO / ".work/bootstrap")
    parser.add_argument("--jobs", type=int, default=2)
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        parser.error("Python >= 3.12 is required for safe archive extraction")
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    for name, value in vars(args).items():
        if isinstance(value, Path):
            setattr(args, name, value.resolve())
    sources = json.loads((ROOT / "sources.lock.json").read_text())
    ffi = json.loads((ROOT / "ffi/source-lock.json").read_text())
    selected = set(args.component or COMPONENTS)
    if "toolchain" in selected:
        toolchain(args, sources, ffi)
    if "deps" in selected:
        prepare_deps(args.deps_prefix, archives=args.deps_archives)
    if "sources" in selected:
        source_archives(args, sources)
    if "ffi" in selected:
        ffi_archives(args, ffi)
    if "npm" in selected:
        for prefix in (REPO, REPO / "Conference/vendor/management"):
            subprocess.run(["npm", "ci", "--prefix", str(prefix), "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional"], check=True)
    if "json-c" in selected:
        build_json(args)
    if "runtime" in selected:
        command = [sys.executable, str(ROOT / "electron-runtime/fetch_packages.py"),
                   "--prefix", str(args.runtime_prefix)]
        if args.runtime_archives:
            command += ["--archives", str(args.runtime_archives)]
        subprocess.run(command, check=True)
    print("Prepared components: " + ", ".join(component for component in COMPONENTS if component in selected))
    print(f"Native build: WELINK_NATIVE_DEPS={args.deps_prefix} WELINK_ELECTRON_SOURCE={args.toolchain_prefix} WELINK_JSON_PREFIX={args.json_prefix} WELINK_SQLITE_SOURCE={args.sqlite_source} ./build.sh NativeIntegration/lib native-only")


if __name__ == "__main__":
    main()
