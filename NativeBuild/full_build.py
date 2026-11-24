#!/usr/bin/env python3
"""Build a finalized native image from pinned inputs in a new private workspace."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys

from acquire import digest
from acquire_image_inputs import (INPUT_LOCK, RUNTIME_LOCK, add_input_arguments,
                                  prepare_binary_runtime, prepare_image_inputs,
                                  stage_runtime_archive)


ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent


def run(command, environment, cwd=REPO):
    command = [str(value) for value in command]
    print("+ " + shlex.join(command), flush=True)
    subprocess.run(command, cwd=cwd, env=environment, check=True)


def build_environment(cache, jobs):
    excluded = {"CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "OBJC_INCLUDE_PATH", "LIBRARY_PATH",
                "COMPILER_PATH", "GCC_EXEC_PREFIX", "SDKROOT", "CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS",
                "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH", "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE",
                "MAKEFLAGS", "MFLAGS", "GIT_CACHE_PATH", "GCLIENT_CACHE_DIR", "CC", "CXX", "AR"}
    environment = {key: value for key, value in os.environ.items()
                   if key not in excluded and not key.startswith("WELINK_")}
    environment.update(LC_ALL="C", SOURCE_DATE_EPOCH="1616074138", JOBS=str(jobs),
                       DEPOT_TOOLS_UPDATE="0", DEPOT_TOOLS_WIN_TOOLCHAIN="0",
                       npm_config_cache=str(cache / "npm"), npm_config_strict_ssl="true")
    return environment


def source_runtime(work, cache, jobs, environment):
    lock_path = ROOT / "electron-runtime/source-lock.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    depot = work / "depot_tools"
    run(["git", "clone", "--no-checkout", lock["depotTools"]["url"], depot], environment)
    run(["git", "-C", depot, "checkout", "--detach", lock["depotTools"]["commit"]], environment)
    checkout = work / "electron-source"
    run([sys.executable, ROOT / "electron-runtime/prepare_source.py", "--checkout", checkout,
         "--depot-tools", depot], environment)
    source = checkout / "src"
    # gclient's hooks need not fetch the ia32 sysroot. Use the same reviewed pin
    # as the documented source recipe, never a workstation compiler/sysroot.
    run([sys.executable, ROOT / "bootstrap.py", "--component", "toolchain",
         "--cache", cache / "public", "--toolchain-prefix", source], environment)
    runtime_environment = dict(environment, PATH=str(depot) + os.pathsep + environment["PATH"])
    run([depot / "gn", "gen", "out/ia32"], runtime_environment, source)
    run([depot / "autoninja", "-C", "out/ia32", "-j", jobs, "electron:electron_dist_zip"],
        runtime_environment, source)
    archive = source / "out/ia32/dist.zip"
    stage_runtime_archive(archive, work / "electron-runtime")
    return {"mode": "source", "sourceLockSha256": digest(lock_path).hexdigest(),
            "argsGnSha256": digest(ROOT / "electron-runtime/args.gn").hexdigest(),
            "archiveSha256": digest(archive).hexdigest(), "archiveSize": archive.stat().st_size}


def management_inputs(work, environment):
    source = REPO / "Conference/vendor/management"
    output = work / "management"
    output.mkdir()
    for name in ("package.json", "package-lock.json"):
        shutil.copyfile(source / name, output / name)
    run(["npm", "ci", "--prefix", output, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional"],
        environment)
    return output


def build(args):
    work = args.work
    cache = args.cache
    if work.exists() or work.is_symlink():
        raise RuntimeError(f"Full builds require a new workspace, including after failure: {work}")
    if work.is_relative_to(cache) or cache.is_relative_to(work):
        raise RuntimeError("The archive cache and build workspace must not contain one another")
    if any(character.isspace() for character in str(work) + str(REPO) + str(cache)):
        raise RuntimeError("The existing GNU make/FFI recipes require checkout, work and cache paths without whitespace")
    required = ["innoextract", "npm", "node", "make", "cmake", "pkg-config", "readelf", "dpkg-deb", "tar", "xz", "bash"]
    if args.runtime_mode == "source":
        required.append("git")
    missing = [name for name in required if shutil.which(name) is None]
    if missing:
        raise RuntimeError("Missing host tools: " + ", ".join(missing) + "; see docs/BUILD.md")
    if not args.accept_vendor_terms:
        raise RuntimeError("Read docs/BUILD.md and publisher terms; use --accept-vendor-terms only with authorization")
    work.mkdir(parents=True, mode=0o700)
    cache.mkdir(parents=True, exist_ok=True)
    environment = build_environment(cache, args.jobs)
    input_args = argparse.Namespace(**vars(args))
    input_args.output = work / "image-inputs"
    input_args.cache = cache / "image"
    inputs = prepare_image_inputs(input_args)
    runtime = work / "electron-runtime"
    if args.runtime_mode == "binary":
        runtime_provenance = {"mode": "verified-prebuilt",
                              "lock": prepare_binary_runtime(cache / "runtime", runtime, args.runtime_archive)}
    else:
        runtime_provenance = source_runtime(work, cache, args.jobs, environment)
    deps = work / "native-deps"
    toolchain = work / "electron-toolchain"
    json_prefix = work / "json-c"
    sqlite = work / "sources/vendor/sqlite3mc-1.4.6"
    runtime_packages = work / "runtime-packages"
    ffi_archives = cache / "ffi"
    bootstrap = [sys.executable, ROOT / "bootstrap.py"]
    for component in ("toolchain", "deps", "sources", "ffi", "json-c", "runtime"):
        bootstrap += ["--component", component]
    bootstrap += ["--cache", cache / "public", "--deps-prefix", deps,
                  "--deps-archives", cache / "debian-native", "--toolchain-prefix", toolchain,
                  "--json-prefix", json_prefix, "--sqlite-source", sqlite, "--ffi-archives", ffi_archives,
                  "--runtime-prefix", runtime_packages, "--runtime-archives", cache / "debian-runtime",
                  "--work", work / "bootstrap", "--jobs", args.jobs]
    run(bootstrap, environment)
    management = management_inputs(work, environment)
    environment.update(WELINK_NATIVE_DEPS=str(deps), WELINK_ELECTRON_SOURCE=str(toolchain),
                       WELINK_JSON_PREFIX=str(json_prefix), WELINK_SQLITE_SOURCE=str(sqlite))
    native = work / "native-libs"
    run(["bash", REPO / "build.sh", native, "native-only"], environment)
    ffi = work / "ffi-output"
    run(["bash", ROOT / "build_ffi.sh", "--build-dir", work / "ffi-build", "--output", ffi,
         "--electron-source", toolchain, "--archives", ffi_archives], environment)
    overrides = work / "vendor-overrides"
    run([sys.executable, ROOT / "prepare_overrides.py", "--vendor-app", inputs / "vendor-app",
         "--output", overrides], environment)
    image = work / "image"
    manifest = work / "integrity"
    run([sys.executable, ROOT / "assemble_app.py", "prepare", "--vendor-app", inputs / "vendor-app",
         "--native-integration", REPO / "NativeIntegration", "--conference", REPO / "Conference",
         "--vendor-overrides", overrides, "--provider-inputs", inputs / "providers",
         "--management-input", management, "--sqlite-source", sqlite,
         "--ffi-output", ffi, "--electron-out", runtime, "--native-libs", native,
         "--deps-prefix", deps, "--electron-prefix", runtime_packages / "root",
         "--output", image, "--manifest-dir", manifest, "--build-id", args.build_id,
         "--native-license", REPO / "LICENSE"], environment)
    # This is a real separate build, after preparation generated this image's
    # manifest. No placeholder checker or hand-written manifest is permitted.
    environment["WELINK_NATIVE_INTEGRITY_INCLUDE"] = str(manifest)
    run(["bash", REPO / "build.sh", native, "sqlite_plugin.dll.so"], environment)
    run([sys.executable, ROOT / "assemble_app.py", "finalize", "--output", image,
         "--manifest-dir", manifest, "--checker", native / "sqlite_plugin.dll.so"], environment)
    locks = [INPUT_LOCK, ROOT / "sources.lock.json", ROOT / "dependencies.lock.json",
             ROOT / "vendor-overrides.json", ROOT / "ffi/source-lock.json", ROOT / "ffi/package-lock.json",
             ROOT / "electron-runtime/packages.lock.json", ROOT / "electron-runtime/source-lock.json",
             ROOT / "electron-runtime/args.gn", REPO / "Conference/vendor/management/package-lock.json"]
    if args.runtime_mode == "binary":
        locks.append(RUNTIME_LOCK)
    provenance = {"formatVersion": 1, "build": args.build_id, "image": str(image),
                  "runtime": runtime_provenance,
                  "locks": {path.relative_to(REPO).as_posix(): digest(path).hexdigest() for path in locks},
                  "checkerSha256": digest(native / "sqlite_plugin.dll.so").hexdigest(),
                  "acceptance": "Finalized image only; desktop/account/meeting/update acceptance is separate."}
    (work / "build-inputs.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    print(f"Finalized image: {image}", flush=True)
    print(f"Input provenance: {work / 'build-inputs.json'}", flush=True)
    print("No application was started and no desktop/profile integration was changed.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, required=True, help="new workspace; existing output is never reused")
    parser.add_argument("--cache", type=Path, default=REPO / ".inputs/full-build-archives",
                        help="verified archives only; extracted inputs always live in the new workspace")
    parser.add_argument("--build-id", required=True, help="deliberate release identity, e.g. hit-native-linux-ia32-r45.11")
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--runtime-mode", choices=("binary", "source"), default="binary",
                        help="verified custom-runtime dependency (default) or fresh Electron/Chromium source build")
    parser.add_argument("--runtime-archive", type=Path, help="exact custom-runtime archive from the binary lock")
    add_input_arguments(parser)
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        parser.error("Python >= 3.12 is required for safe archive extraction")
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,119}", args.build_id):
        parser.error("--build-id must be a short printable release identifier")
    if args.runtime_mode == "source" and args.runtime_archive:
        parser.error("--runtime-archive cannot be used in source-runtime mode")
    if args.work.is_symlink():
        parser.error("--work cannot be a symlink")
    args.work = args.work.resolve()
    args.cache = args.cache.resolve()
    os.umask(0o077)
    try:
        build(args)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"full_build: {error}", file=sys.stderr)
        print("No failed workspace is reused; inspect it, then choose a new --work path.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
