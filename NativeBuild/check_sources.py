#!/usr/bin/env python3
"""Self-contained syntax and input-lock checks; not vendor/runtime acceptance."""
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parent.parent
EXCLUDED = {".git", ".inputs", ".work", "node_modules", "vendor", "app-overrides", "lib", "__pycache__", "releases",
            "json-c", "json-c-work", "archives", "root", "output", "work"}


def main():
    counts = {"python": 0, "javascript": 0, "json": 0}
    for directory, directories, files in os.walk(ROOT):
        directories[:] = sorted(name for name in directories if name not in EXCLUDED)
        for name in sorted(files):
            path = Path(directory) / name
            if path.suffix == ".py":
                ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
                counts["python"] += 1
            elif path.suffix == ".js":
                subprocess.run(["node", "--check", str(path)], check=True)
                counts["javascript"] += 1
            elif path.suffix == ".json":
                json.loads(path.read_text(encoding="utf-8"))
                counts["json"] += 1
    for relative in ("build.sh", "NativeBuild/build_ffi.sh", "NativeBuild/cc-ia32"):
        subprocess.run(["bash", "-n", str(ROOT / relative)], check=True)
    ffi = json.loads((ROOT / "NativeBuild/ffi/source-lock.json").read_text())
    actual = hashlib.sha256((ROOT / "NativeBuild/ffi/package-lock.json").read_bytes()).hexdigest()
    if actual != ffi["packageLockSha256"]:
        raise RuntimeError("FFI package lock does not match its source-lock hash")
    runtime = ROOT / "NativeBuild/electron-runtime"
    for record in json.loads((runtime / "source-lock.json").read_text())["repositories"].values():
        if "portPatch" in record:
            actual = hashlib.sha256((runtime / record["portPatch"]).read_bytes()).hexdigest()
            if actual != record["patchSha256"]:
                raise RuntimeError(f"Runtime patch hash changed: {record['portPatch']}")
    for relative in ("package-lock.json", "NativeBuild/ffi/package-lock.json", "Conference/vendor/management/package-lock.json"):
        lock = json.loads((ROOT / relative).read_text())
        manifest = json.loads((ROOT / relative).with_name("package.json").read_text())
        for kind in ("dependencies", "devDependencies"):
            if manifest.get(kind, {}) != lock["packages"][""].get(kind, {}):
                raise RuntimeError(f"Manifest and lock disagree: {relative} {kind}")
        for name, record in lock["packages"].items():
            if name and (not record["resolved"].startswith("https://registry.npmjs.org/")
                         or not record["integrity"].startswith("sha512-")):
                raise RuntimeError(f"Unpinned npm source: {name}")
    print("PASS self-contained syntax/lock checks: " + json.dumps(counts, sort_keys=True))
    print("This does not test the vendor UI, bytecode, integrity checker, Electron, media providers, accounts or meetings.")


if __name__ == "__main__":
    main()
