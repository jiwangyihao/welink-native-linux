#!/usr/bin/env python3
"""Build a Spark-compatible DEB without redistributing the commercial client."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))
import seed

PACKAGE = "cn.edu.hit.welink.native"
APPROOT = Path("opt/apps") / PACKAGE
DEPENDENCIES = ("bash, python3 (>= 3.11), libc6-i386 (>= 2.34), innoextract (>= 1.9), "
                "ca-certificates, zenity, x11-utils, xdg-utils, wmctrl, libglib2.0-bin, "
                "pkexec, sudo, dbus-user-session, coreutils, desktop-file-utils, util-linux")
LAUNCH = '''#!/bin/bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
exec /usr/bin/python3 -I "$root/package_install.py" -- "$@"
'''
SETUP = '''#!/bin/bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
exec /usr/bin/python3 -I "$root/package_install.py" "$@"
'''
ICON = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="8" y="8" width="112" height="112" rx="26" fill="#1673c9"/><path d="M32 40h64v42H62L43 98V82H32z" fill="none" stroke="white" stroke-width="7" stroke-linejoin="round"/><circle cx="48" cy="61" r="4" fill="white"/><circle cx="64" cy="61" r="4" fill="white"/><circle cx="80" cy="61" r="4" fill="white"/></svg>
'''


def put(root, relative, content, mode=0o644):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(mode)
    return path


def link(root, relative, target):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.symlink_to(target)


def build(args):
    os.umask(0o022)
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".welink-deb-", dir=args.output) as temporary:
        tree = Path(temporary) / "package"
        app = tree / APPROOT
        app.mkdir(parents=True)
        manifest = seed.create(args.image, args.inputs, app / "files", args.source_commit)
        version = manifest["version"].removeprefix("r") + "-1"
        destination = args.output / f"{PACKAGE}_{version}_amd64.deb"
        if destination.exists() or destination.is_symlink():
            raise ValueError("Refusing to replace an existing release package")
        files = app / "files"
        for name in ("seed.py", "package_install.py", "sandbox_helper.py"):
            shutil.copyfile(HERE / name, files / name)
            (files / name).chmod(0o755)
        tools = files / "tools"
        tools.mkdir()
        for name in ("acquire.py", "acquire_image_inputs.py", "delta.py", "image-inputs.lock.json",
                     "custom-background.integrity.json", "install_desktop.py"):
            shutil.copyfile(REPO / "NativeBuild" / name, tools / name)
            (tools / name).chmod(0o644)
        (files / "chrome-sandbox").chmod(0o4755)
        put(tree, APPROOT / "files/bin/launch", LAUNCH, 0o755)
        put(tree, APPROOT / "files/bin/setup", SETUP, 0o755)
        info = {"appid": PACKAGE, "name": "WeLink Native (HIT, unofficial)", "version": version,
                "arch": ["amd64"], "sourceCommit": args.source_commit}
        put(tree, APPROOT / "info", json.dumps(info, indent=2) + "\n")
        desktop = ("[Desktop Entry]\nType=Application\nVersion=1.0\nName=WeLink Native (HIT)\n"
                   "Name[zh_CN]=WeLink 原生版（HIT，非官方）\n"
                   "Comment=First-party native port; verifies lawful upstream inputs at first launch\n"
                   f"Exec=/{APPROOT}/files/bin/launch %u\nTryExec=/{APPROOT}/files/bin/launch\n"
                   f"Icon={PACKAGE}\nTerminal=false\nCategories=Network;InstantMessaging;\n"
                   "StartupWMClass=HIT APP\nMimeType=x-scheme-handler/hwwelink;x-scheme-handler/hwwemeeting;x-scheme-handler/cloudlink;\n")
        desktop_path = APPROOT / "entries/applications" / (PACKAGE + ".desktop")
        icon_path = APPROOT / "entries/icons/hicolor/scalable/apps" / (PACKAGE + ".svg")
        put(tree, desktop_path, desktop)
        put(tree, icon_path, ICON)
        link(tree, "usr/share/applications/" + PACKAGE + ".desktop", "/" + str(desktop_path))
        link(tree, "usr/share/icons/hicolor/scalable/apps/" + PACKAGE + ".svg", "/" + str(icon_path))
        link(tree, "usr/bin/welink-native", "/" + str(APPROOT / "files/bin/launch"))
        link(tree, "usr/bin/welink-native-setup", "/" + str(APPROOT / "files/bin/setup"))
        documentation = Path("usr/share/doc") / PACKAGE
        for source, target in (("LICENSE", "LICENSE.MPL-2.0"), ("PUBLICATION_SCOPE.md", "PUBLICATION_SCOPE.md")):
            path = tree / documentation / target
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / source, path)
        put(tree, documentation / "copyright", (
            "Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\n"
            "Upstream-Name: WeLink Native for Linux (unofficial)\n"
            "Source: https://github.com/jiwangyihao/welink-native-linux\n\n"
            "Files: first-party integration, package bootstrap and native implementation\n"
            "Copyright: WeLink Native contributors\nLicense: MPL-2.0\n"
            " See LICENSE.MPL-2.0 and PUBLICATION_SCOPE.md.\n\n"
            "Files: open-source runtime, native dependency closure and FFI\n"
            "Copyright: Respective upstream authors\nLicense: assorted-upstream-licenses\n"
            f" Original notices are included under /{APPROOT}/files/payload/resources/app/native/licenses/\n"
            f" and /{APPROOT}/files/payload/LICENSE and LICENSES.chromium.html.\n"
            " Pinned source URLs and build recipes are in the corresponding public source tree.\n\n"
            "Comment: No complete proprietary client, provider bundle, model or user data is shipped.\n"
            " Upstream resources are acquired only after explicit user consent and hash verification.\n"))
        put(tree, documentation / "README.Debian", (
            "Launch WeLink Native from the application menu or run welink-native.\n"
            "First launch asks authorization before fetching exact upstream inputs; no compilation is performed.\n"
            "The package manages bootstrap/public components; signed native updates manage private user images.\n"
            "Do not run the app as root. No profile/default associations are changed by dpkg scripts.\n"
            "Existing running sessions are never terminated by installation.\n"
            "Removing/purging this package retains user profiles, backups and user-installed native images.\n"
            "Use the native application's normal settings to manage desktop and autostart integration.\n"
            "Offline setup: welink-native-setup --accept-vendor-terms --vendor-installer FILE\n"
            "  --hrtc-bundle FILE --background-archive FILE --background-license FILE\n"))
        size = sum(p.stat().st_size for p in tree.rglob("*") if p.is_file() and not p.is_symlink())
        control = (f"Package: {PACKAGE}\nVersion: {version}\nArchitecture: amd64\n"
                   "Section: contrib/net\nPriority: optional\n"
                   "Maintainer: WeLink Native contributors <jiwangyihao@users.noreply.github.com>\n"
                   "Homepage: https://github.com/jiwangyihao/welink-native-linux\n"
                   f"Installed-Size: {(size + 1023) // 1024}\nDepends: {DEPENDENCIES}\n"
                   "Description: Unofficial native Linux WeLink interoperability bootstrap\n"
                   " Precompiled native implementation and verified first-user installation for\n"
                   " the pinned HIT frontend. Proprietary inputs are not bundled. First launch\n"
                   " requires authorization and network access or exact lawful offline inputs.\n"
                   " User images and profiles remain private; Wine is not used.\n")
        put(tree, "DEBIAN/control", control)
        put(tree, "DEBIAN/postinst", "#!/bin/sh\nset -e\nif [ \"$1\" = configure ]; then\n"
            f"  chown 0:0 /{APPROOT}/files/chrome-sandbox\n"
            f"  chmod 4755 /{APPROOT}/files/chrome-sandbox\n"
            "  update-desktop-database /usr/share/applications\nfi\n", 0o755)
        put(tree, "DEBIAN/postrm", "#!/bin/sh\nset -e\nif command -v update-desktop-database >/dev/null 2>&1; then\n"
            "  update-desktop-database /usr/share/applications\nfi\n", 0o755)
        epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "1609459200"))
        for path in sorted(tree.rglob("*"), reverse=True):
            os.utime(path, (epoch, epoch), follow_symlinks=False)
        os.utime(tree, (epoch, epoch))
        subprocess.run(["dpkg-deb", "--root-owner-group", "--uniform-compression", "-Zxz", "-z6",
                        "--build", str(tree), str(destination)], check=True)
        print(json.dumps({"deb": str(destination), "version": version, "build": manifest["build"],
                          "sourceCommit": args.source_commit, "sha256": seed.digest(destination),
                          "size": destination.stat().st_size}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True, help="finalized native image")
    parser.add_argument("--inputs", type=Path, required=True, help="verified full-build image-inputs directory")
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    build(args)


if __name__ == "__main__":
    main()
