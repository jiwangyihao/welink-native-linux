#!/usr/bin/env python3
"""Acquire exact lawful image inputs; never execute the commercial installer."""
import argparse
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error

from acquire import digest, download, extract, verify


ROOT = Path(__file__).resolve().parent
INPUT_LOCK = ROOT / "image-inputs.lock.json"
RUNTIME_LOCK = ROOT / "electron-runtime/runtime-binary.lock.json"


def relative_name(value):
    path = Path(value)
    if path.is_absolute() or not path.parts or any(part in (".", "..") for part in path.parts):
        raise ValueError(f"Unsafe locked relative path: {value}")
    return path


def check_record(path, record):
    if not path.is_file() or path.is_symlink():
        raise RuntimeError(f"Input must be a regular file, not a symlink: {path}")
    verify(path, record["sha256"])
    if "integrity" in record:
        verify(path, record["integrity"])
    if "size" in record and path.stat().st_size != record["size"]:
        raise RuntimeError(f"Input size differs from lock: {path}")


def acquire_record(record, cache, local=None, local_option=None):
    name = relative_name(record["archive"])
    if len(name.parts) != 1:
        raise ValueError("Archive cache names must be basenames")
    destination = cache / name
    cache.mkdir(parents=True, exist_ok=True)
    if local is not None:
        local = local.resolve(strict=True)
        check_record(local, record)
        if destination.exists() or destination.is_symlink():
            check_record(destination, record)
        else:
            with tempfile.NamedTemporaryFile(dir=cache, prefix=".input-", delete=False) as target:
                temporary = Path(target.name)
                try:
                    with local.open("rb") as source:
                        shutil.copyfileobj(source, target)
                    target.close()
                    check_record(temporary, record)
                    temporary.replace(destination)
                finally:
                    temporary.unlink(missing_ok=True)
    else:
        try:
            download(record["url"], destination, record["sha256"])
        except (urllib.error.URLError, TimeoutError) as error:
            alternative = f" Supply the exact authorized file with {local_option}." if local_option else ""
            raise RuntimeError(f"Cannot acquire {record['url']}: {error}.{alternative} "
                               "Do not substitute another version or bypass upstream authorization.") from error
    check_record(destination, record)
    return destination


def regular_tree(root):
    for path in root.rglob("*"):
        mode = path.lstat().st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise RuntimeError(f"Unexpected linked or special input: {path}")


def prepare_vendor(archive, record, output, innoextract):
    # The whole immutable installer, not a few override hashes, is the trust root.
    check_record(archive, record)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix=".inno-") as temporary:
        root = Path(temporary)
        app_path = relative_name(record["appPath"])
        subprocess.run([innoextract, "--extract", "--silent", "--include", app_path.as_posix(),
                        "--output-dir", str(root), str(archive)], check=True)
        app = root / app_path
        if not app.is_dir() or app.is_symlink():
            raise RuntimeError(f"Pinned installer does not contain {app_path}")
        regular_tree(root)
        for name in ("main.js", "main.jsc", "package.json"):
            if not (app / name).is_file():
                raise RuntimeError(f"Incomplete extracted vendor application: {name}")
        package = json.loads((app / "package.json").read_text(encoding="utf-8"))
        if package.get("version") != record["packageVersion"] or package.get("productName") != record["product"]:
            raise RuntimeError("Extracted vendor application identity differs from the installer lock")
        app.rename(output)


def prepare_image_inputs(args):
    if not args.accept_vendor_terms:
        raise RuntimeError("Read docs/BUILD.md and the publisher's terms, then pass --accept-vendor-terms "
                           "only if authorized to obtain and use the HIT application and Huawei provider input")
    innoextract = shutil.which("innoextract")
    if not innoextract:
        raise RuntimeError("Install innoextract (1.9 or newer) using your trusted OS package manager")
    lock = json.loads(INPUT_LOCK.read_text(encoding="utf-8"))
    if lock.get("formatVersion") != 1:
        raise ValueError("Unsupported image input lock")
    output = args.output.absolute()
    if output.exists() or output.is_symlink():
        raise RuntimeError(f"Use a new image-input directory; extracted inputs are never reused: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    vendor = acquire_record(lock["vendor"], args.cache, args.vendor_installer, "--vendor-installer")
    hrtc = acquire_record(lock["hrtc"], args.cache, args.hrtc_bundle, "--hrtc-bundle")
    background_record = lock["background"]
    background = acquire_record(background_record, args.cache, args.background_archive, "--background-archive")
    license_path = acquire_record(background_record["license"], args.cache,
                                  args.background_license, "--background-license")
    model_manifest = ROOT / relative_name(background_record["manifest"])
    verify(model_manifest, background_record["manifestSha256"])
    with tempfile.TemporaryDirectory(dir=output.parent, prefix=".image-inputs-") as temporary:
        staging = Path(temporary) / "inputs"
        staging.mkdir(mode=0o700)
        prepare_vendor(vendor, lock["vendor"], staging / "vendor-app", innoextract)
        providers = staging / "providers"
        providers.mkdir()
        shutil.copyfile(hrtc, providers / lock["hrtc"]["archive"])
        model_root = providers / "custom-background"
        extract(background, model_root, background_record["root"])
        regular_tree(model_root)
        package = json.loads((model_root / "package.json").read_text(encoding="utf-8"))
        if (package.get("name"), package.get("version"), package.get("license")) != (
                background_record["name"], background_record["version"], background_record["license"]["spdx"]):
            raise RuntimeError("Custom-background package identity differs from the lock")
        for name, expected in json.loads(model_manifest.read_text(encoding="utf-8"))["sha256"].items():
            verify(model_root / relative_name(name), expected)
        if (model_root / "LICENSE").exists():
            verify(model_root / "LICENSE", background_record["license"]["sha256"])
        shutil.copyfile(license_path, model_root / "LICENSE")
        shutil.copyfile(model_manifest, model_root / "integrity.json")
        shutil.copyfile(INPUT_LOCK, staging / "image-inputs.lock.json")
        if output.exists() or output.is_symlink():
            raise RuntimeError(f"Input output appeared during acquisition: {output}")
        staging.rename(output)
    print(f"Verified vendor application: {output / 'vendor-app'}", flush=True)
    print(f"Verified provider inputs: {output / 'providers'}", flush=True)
    return output


def stage_runtime_archive(archive, output, root=None):
    extract(archive, output, root)
    regular_tree(output)
    if (output / "chrome-sandbox").is_file():
        if (output / "chrome_sandbox").exists():
            raise RuntimeError("Ambiguous sandbox files in custom runtime")
        (output / "chrome-sandbox").rename(output / "chrome_sandbox")
    for name in ("electron", "chrome_sandbox", "chrome_crashpad_handler"):
        path = output / name
        if not path.is_file():
            raise RuntimeError(f"Missing custom-runtime executable: {name}")
        path.chmod(0o755)  # Never preserve setuid permissions from an archive.
    if (output / "version").read_text().strip() != "22.3.26":
        raise RuntimeError("Custom-runtime archive has the wrong Electron version")


def prepare_binary_runtime(cache, output, local=None, lock_path=RUNTIME_LOCK):
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if (lock.get("formatVersion"), lock.get("electronVersion"), lock.get("platform"), lock.get("architecture")) != (
            1, "22.3.26", "linux", "ia32"):
        raise ValueError("Expected the locked custom Electron 22.3.26 Linux ia32 dependency")
    verify(ROOT / "electron-runtime/source-lock.json", lock["sourceLockSha256"])
    verify(ROOT / "electron-runtime/args.gn", lock["argsGnSha256"])
    root = lock.get("root")
    if root is not None:
        root = relative_name(root).as_posix()
    archive = acquire_record(lock, cache, local, "--runtime-archive")
    stage_runtime_archive(archive, output, root)
    print(f"Verified prebuilt custom runtime dependency: {output}", flush=True)
    return lock


def add_input_arguments(parser):
    parser.add_argument("--accept-vendor-terms", action="store_true",
                        help="confirm your authorization under the HIT/Huawei terms; not a redistribution grant")
    parser.add_argument("--vendor-installer", type=Path, help="lawfully obtained exact original installer (hash checked)")
    parser.add_argument("--hrtc-bundle", type=Path, help="authorized exact HRTC chunk (hash checked)")
    parser.add_argument("--background-archive", type=Path, help="exact upstream MediaPipe npm archive (hash checked)")
    parser.add_argument("--background-license", type=Path, help="exact upstream MediaPipe license file (hash checked)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    add_input_arguments(parser)
    parser.add_argument("--output", type=Path, required=True, help="new private directory, never an existing extraction")
    parser.add_argument("--cache", type=Path, default=ROOT.parent / ".inputs/image-archives")
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        parser.error("Python >= 3.12 is required for safe archive extraction")
    os.umask(0o077)
    args.cache = args.cache.resolve()
    try:
        prepare_image_inputs(args)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"acquire_image_inputs: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
