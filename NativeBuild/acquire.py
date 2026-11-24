#!/usr/bin/env python3
"""Hash-locked HTTPS acquisition and safe extraction of open-source inputs."""
import base64
import hashlib
import os
from pathlib import Path
import shutil
import stat
import tarfile
import tempfile
import urllib.parse
import urllib.request
import zipfile


def digest(path, algorithm="sha256"):
    value = hashlib.new(algorithm)
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value


def verify(path, expected):
    if expected.startswith("sha512-"):
        actual = "sha512-" + base64.b64encode(digest(path, "sha512").digest()).decode("ascii")
    else:
        actual = digest(path).hexdigest()
    if actual != expected:
        raise RuntimeError(f"Integrity mismatch: {path}; expected {expected}, got {actual}")


class HTTPSRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise RuntimeError(f"Refusing insecure download redirect: {newurl}")
        return super().redirect_request(request, response, code, message, headers, newurl)


def download(url, path, expected):
    path = Path(path)
    if not url.startswith("https://"):
        raise RuntimeError(f"Refusing non-HTTPS source: {url}")
    if path.exists():
        verify(path, expected)
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", delete=False) as target:
        temporary = Path(target.name)
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "welink-native-linux-source-bootstrap/1"})
            with urllib.request.build_opener(HTTPSRedirectHandler()).open(request, timeout=120) as response:
                if not response.url.startswith("https://"):
                    raise RuntimeError(f"Insecure download redirect: {response.url}")
                shutil.copyfileobj(response, target)
            target.close()
            verify(temporary, expected)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return path


def extract(archive, output, root_name=None):
    """Extract a verified archive to a new directory; never overlay old inputs."""
    output = Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise RuntimeError(f"Refusing to overwrite extracted input: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix=".extract-") as directory:
        staging = Path(directory)
        if zipfile.is_zipfile(archive):
            with zipfile.ZipFile(archive) as source:
                for member in source.infolist():
                    relative = Path(member.filename)
                    if relative.is_absolute() or ".." in relative.parts or (member.external_attr >> 16) & 0o170000 == 0o120000:
                        raise RuntimeError(f"Unsafe ZIP member: {member.filename}")
                source.extractall(staging)
        else:
            with tarfile.open(archive) as source:
                # Python's data filter rejects links outside the destination,
                # devices, traversal and unsafe permissions. Python >= 3.12.
                source.extractall(staging, filter="data")
        selected = staging / root_name if root_name else staging
        if not selected.is_dir():
            raise RuntimeError(f"Archive does not contain expected root: {root_name}")
        if selected == staging:
            # Rename a child so TemporaryDirectory still owns its own directory.
            child = staging / ".publish"
            child.mkdir()
            for item in list(staging.iterdir()):
                if item != child:
                    item.rename(child / item.name)
            child.rename(output)
        else:
            selected.rename(output)


def tree_inventory(root, ignore=()):
    """Content, link targets and executable bits; never follow input symlinks."""
    inventory = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if relative in ignore:
            continue
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode):
            inventory[relative] = {"symlink": str(path.readlink())}
        elif stat.S_ISREG(mode):
            inventory[relative] = {"sha256": digest(path).hexdigest(), "executable": bool(mode & 0o111)}
        elif stat.S_ISDIR(mode):
            inventory[relative] = {"directory": True}
        else:
            raise RuntimeError(f"Unsupported extracted file type: {path}")
    return inventory


def materialize(archive, output, expected, root_name=None, generated=None):
    """Fresh extraction, or full comparison against a fresh verified extraction."""
    verify(archive, expected)
    output = Path(output)
    if output.is_symlink():
        raise RuntimeError(f"Refusing linked extracted input: {output}")
    marker = output / ".source-archive.sha256"
    archive_hash = digest(archive).hexdigest()

    def populate(destination):
        extract(archive, destination, root_name)
        for name, value in (generated or {}).items():
            (destination / name).write_text(value)

    if output.exists():
        if not output.is_dir():
            raise RuntimeError(f"Extracted input is not a directory: {output}")
        if marker.exists() and (marker.is_symlink() or marker.read_text().strip() != archive_hash):
            raise RuntimeError(f"Changed extraction marker: {output}; use a fresh directory")
        with tempfile.TemporaryDirectory(dir=output.parent, prefix=".verify-source-") as temporary:
            reference = Path(temporary) / "reference"
            populate(reference)
            if tree_inventory(output, (marker.name,)) != tree_inventory(reference):
                raise RuntimeError(f"Extracted files differ from the pinned archive: {output}; use a fresh directory")
        print(f"Verified entire extracted source against pinned archive: {output}", flush=True)
        return
    populate(output)
    marker.write_text(archive_hash + "\n")
