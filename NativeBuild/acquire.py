#!/usr/bin/env python3
"""Hash-locked HTTPS acquisition and safe extraction of open-source inputs."""
import base64
import hashlib
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
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
            with urllib.request.urlopen(request, timeout=120) as response:
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


def materialize(archive, output, expected, root_name=None):
    """Reuse only our recorded extraction of the same verified archive."""
    verify(archive, expected)
    output = Path(output)
    marker = output / ".source-archive.sha256"
    archive_hash = digest(archive).hexdigest()
    if output.exists():
        if not marker.is_file() or marker.read_text().strip() != archive_hash:
            raise RuntimeError(f"Unrecorded or changed extraction: {output}; use a fresh directory")
        return
    extract(archive, output, root_name)
    marker.write_text(archive_hash + "\n")
