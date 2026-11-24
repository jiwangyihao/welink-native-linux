#!/usr/bin/env python3
"""Standalone image recipes: public binaries plus references to lawful private inputs."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys

ROOT = Path(__file__).resolve().parent
TOOLS = ROOT / "tools" if (ROOT / "tools").is_dir() else ROOT.parent / "NativeBuild"
sys.path.insert(0, str(TOOLS))
from delta import apply_patch, literal_size, make_patch

HASH = re.compile(r"[0-9a-f]{64}\Z")
VERSION = re.compile(r"hit-native-linux-ia32-(r45\.(?:0|[1-9][0-9]*))\Z")
ELECTRON = frozenset(("electron", "chrome_crashpad_handler", "chrome_100_percent.pak",
    "chrome_200_percent.pak", "resources.pak", "icudtl.dat", "snapshot_blob.bin",
    "v8_context_snapshot.bin", "libEGL.so", "libGLESv2.so", "libffmpeg.so",
    "libvk_swiftshader.so", "libvulkan.so.1", "vk_swiftshader_icd.json", "version",
    "LICENSE", "LICENSES.chromium.html"))


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def relative(value):
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        raise ValueError("Invalid image-relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(p in ("", ".", "..") for p in value.split("/")):
        raise ValueError("Unsafe image-relative path: " + value)
    return Path(value)


def link_target(name, value):
    if not isinstance(value, str) or not value or "\0" in value or "\\" in value:
        raise ValueError("Invalid image symlink")
    target = os.path.normpath(str(relative(name).parent / value))
    if Path(value).is_absolute() or target == ".." or target.startswith("../"):
        raise ValueError("Image symlink escapes image: " + name)
    return value


def public_literal(name):
    if name in ELECTRON or (name.startswith("locales/") and name.endswith(".pak")):
        return True
    return (name.startswith("resources/app/native/") and
            not name.startswith("resources/app/native/vendor/")) or name.startswith(
                "resources/app/libraries/node_extends/node-ffi/") or name == (
                "resources/app/shared/meeting_link_admission.js")


def create(image, inputs, output, source_commit):
    """Only a publisher runs this; output contains no complete proprietary inputs."""
    image, inputs, output = (Path(p).resolve() for p in (image, inputs, output))
    if output.exists():
        raise ValueError("Refusing existing seed directory")
    if not re.fullmatch(r"[0-9a-f]{40}", source_commit):
        raise ValueError("Require the committed public source identity")
    identity = json.loads((image / "resources/app/native/build.json").read_text())
    match = VERSION.fullmatch(identity["build"])
    if not match:
        raise ValueError("Unsupported native image identity")
    if (inputs / "image-inputs.lock.json").read_bytes() != (TOOLS / "image-inputs.lock.json").read_bytes():
        raise ValueError("Image inputs differ from the published acquisition lock")
    output.mkdir(mode=0o755)
    payload = output / "payload"
    records = {}
    copied = patched = literal_bytes = 0
    for source in sorted(image.rglob("*")):
        name = source.relative_to(image).as_posix()
        relative(name)
        if source.is_symlink():
            records[name] = {"link": link_target(name, source.readlink().as_posix())}
            continue
        if source.is_dir():
            continue
        if not source.is_file():
            raise ValueError("Special image entry: " + name)
        mode = stat.S_IMODE(source.stat().st_mode)
        if name != "chrome-sandbox" and mode not in (0o644, 0o755):
            raise ValueError("Unexpected image permissions: " + name)
        item = {"sha256": digest(source), "size": source.stat().st_size,
                "mode": 0o755 if name == "chrome-sandbox" else mode}
        if name == "chrome-sandbox":
            item["source"] = "sandbox"
            shutil.copyfile(source, output / "chrome-sandbox")
            (output / "chrome-sandbox").chmod(0o755)
        elif name.startswith("resources/app/native/vendor/"):
            origin = name.removeprefix("resources/app/native/vendor/")
            base = inputs / "providers" / relative(origin)
            if not base.is_file() or base.is_symlink() or digest(base) != item["sha256"]:
                raise ValueError("Provider bytes must be unmodified private inputs: " + name)
            item.update(source="providers", path=origin, baseSha256=item["sha256"])
            copied += 1
        elif public_literal(name):
            target = payload / relative(name)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            target.chmod(mode)
            item["source"] = "payload"
        else:
            if not name.startswith("resources/app/"):
                raise ValueError("Unclassified public package bytes: " + name)
            origin = name.removeprefix("resources/app/")
            base = inputs / "vendor-app" / relative(origin)
            if not base.is_file() or base.is_symlink():
                raise ValueError("No lawful vendor base for: " + name)
            item.update(source="vendor", path=origin, baseSha256=digest(base))
            if item["baseSha256"] != item["sha256"]:
                if source.suffix.lower() in (".jsc", ".exe", ".dll", ".node"):
                    raise ValueError("Changed proprietary executable cannot be published: " + name)
                before, after = base.read_bytes(), source.read_bytes()
                operations = make_patch(before, after)
                amount = literal_size(operations)
                if amount > max(4096, len(after) // 10):
                    raise ValueError("Too much upstream literal data in public recipe: " + name)
                if apply_patch(before, operations, len(after)) != after:
                    raise ValueError("Invalid image recipe: " + name)
                item["operations"] = operations
                patched += 1
                literal_bytes += amount
            else:
                copied += 1
        records[name] = item
    manifest = {"format": 1, "build": identity["build"], "version": match.group(1),
                "sourceCommit": source_commit, "files": records}
    (output / "seed.json").write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n")
    print(json.dumps({"seed": str(output), "build": identity["build"], "files": len(records),
                      "privateInputCopies": copied, "vendorPatches": patched,
                      "vendorLiteralBytes": literal_bytes}), flush=True)
    return manifest


def load(root):
    value = json.loads((Path(root) / "seed.json").read_bytes())
    if value.get("format") != 1 or not VERSION.fullmatch(value.get("build", "")):
        raise ValueError("Unsupported package seed")
    if value.get("version") != VERSION.fullmatch(value["build"]).group(1):
        raise ValueError("Inconsistent package version")
    files = value.get("files")
    if not isinstance(files, dict) or not 0 < len(files) <= 20000:
        raise ValueError("Invalid package inventory")
    for name, item in files.items():
        relative(name)
        if not isinstance(item, dict):
            raise ValueError("Invalid image descriptor")
        if "link" in item:
            if set(item) != {"link"}:
                raise ValueError("Ambiguous image symlink")
            link_target(name, item["link"])
            continue
        if not HASH.fullmatch(item.get("sha256", "")) or type(item.get("size")) is not int or not 0 <= item["size"] <= 512 * 1024 * 1024:
            raise ValueError("Invalid image digest or size")
        if item.get("mode") not in (0o644, 0o755):
            raise ValueError("Unsafe image permissions")
        source = item.get("source")
        if source == "sandbox":
            if name != "chrome-sandbox":
                raise ValueError("Invalid privileged image entry")
        elif source == "payload":
            if not public_literal(name):
                raise ValueError("Undeclared public payload")
        elif source in ("vendor", "providers"):
            relative(item.get("path"))
            if not HASH.fullmatch(item.get("baseSha256", "")):
                raise ValueError("Invalid input digest")
        else:
            raise ValueError("Unsupported image source")
    return value


def verify(image, manifest, namespace_sandbox=False):
    image = Path(image)
    actual = {p.relative_to(image).as_posix() for p in image.rglob("*") if not p.is_dir() or p.is_symlink()}
    if actual != set(manifest["files"]):
        raise ValueError("Installed image differs from package file set")
    for name, item in manifest["files"].items():
        target = image / relative(name)
        if "link" in item:
            if not target.is_symlink() or target.readlink().as_posix() != item["link"]:
                raise ValueError("Image symlink mismatch: " + name)
            continue
        if target.is_symlink() or not target.is_file() or target.stat().st_size != item["size"] or digest(target) != item["sha256"]:
            raise ValueError("Image bytes differ: " + name)
        info = target.stat()
        sandbox_mode = 0o755 if namespace_sandbox else 0o4755
        expected = sandbox_mode if name == "chrome-sandbox" else item["mode"]
        owner = os.getuid() if namespace_sandbox else 0
        if stat.S_IMODE(info.st_mode) != expected or (name == "chrome-sandbox" and info.st_uid != owner):
            raise ValueError("Image permissions differ: " + name)


def materialize(root, inputs, image, manifest, sandbox, progress=print, namespace_sandbox=False):
    root, inputs, image = map(Path, (root, inputs, image))
    image.mkdir(mode=0o700)
    total = len(manifest["files"])
    for index, (name, item) in enumerate(manifest["files"].items(), 1):
        target = image / relative(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.parent.resolve() != target.parent:
            raise ValueError("Image parent traverses a symlink")
        if "link" in item:
            target.symlink_to(item["link"])
        elif item["source"] == "sandbox":
            sandbox(root / "chrome-sandbox", image, item["sha256"])
        else:
            source = root / "payload" / relative(name) if item["source"] == "payload" else (
                inputs / ("vendor-app" if item["source"] == "vendor" else "providers") / relative(item["path"]))
            if source.is_symlink() or not source.is_file():
                raise ValueError("Missing regular package input: " + name)
            expected = item["sha256"] if item["source"] == "payload" else item["baseSha256"]
            if digest(source) != expected:
                raise ValueError("Input bytes differ: " + name)
            if "operations" in item:
                target.write_bytes(apply_patch(source.read_bytes(), item["operations"], item["size"]))
            else:
                shutil.copyfile(source, target)
            target.chmod(item["mode"])
        if index == total or index % 250 == 0:
            progress(f"重建原生镜像：{index}/{total}")
    progress("校验全部镜像文件与沙箱权限")
    verify(image, manifest, namespace_sandbox)
