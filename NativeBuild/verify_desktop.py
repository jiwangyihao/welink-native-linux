#!/usr/bin/env python3
"""Parent-run desktop/URL and X11-opacity proof against an integrated sealed image.

  sudo python3 NativeBuild/verify_desktop.py --image /sealed/r45.8/image \
      --output /new/evidence/desktop

Requires Linux root for private mount/network/PID namespaces, Node >=22 (native
WebSocket), Python 3, unshare, mount, ip, runuser, Xvfb/xvfb-run/xauth, openbox,
xprop (x11-utils), wmctrl, gio, and the host's working ia32 glibc. The
real Electron/renderer runs as nobody. Neither production image nor real user
profile/defaults are written. A second read-only mount of the SAME sealed image
is only a cross-release routing fixture, not a different release claim.
--tool-prefix /extracted/package/usr/bin supplies real optional tools such as
wmctrl through a read-only private bind, without installing them on the host.
"""

import argparse
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import tempfile


NAMESPACE = r'''#!/bin/bash
set -euo pipefail
work=$1
image=$2
output=$3
tools=$4
mount --make-rprivate /
ip link set lo up
[[ -z $(ip -4 route show default) && -z $(ip -6 route show default) ]]
primary="$work/releases/hit-welink-native-r45.8/image"
alternate="$work/releases/hit-welink-native-r45.8-routing-fixture/image"
for destination in "$primary" "$alternate"; do
  mount -t tmpfs -o mode=0755,nodev tmpfs "$destination"
  for src in "$image"/*; do
    dst="$destination/${src##*/}"
    if [[ ${src##*/} == chrome-sandbox ]]; then
      # Same pinned image bytes, with the SUID mode required by genuine Electron.
      install -m4755 -- "$src" "$dst"
    elif [[ -L $src ]]; then
      ln -s -- "$(readlink -- "$src")" "$dst"
    else
      if [[ -d $src ]]; then mkdir "$dst"; else touch "$dst"; fi
      mount --bind "$src" "$dst"
      mount -o remount,bind,ro "$dst"
    fi
  done
  mount -o remount,ro,nodev "$destination"
done
mount --bind "$output" "$work/evidence"
if [[ -n $tools ]]; then
  mount --bind "$tools" "$work/tools"
  mount -o remount,bind,ro "$work/tools"
fi
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /tmp
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /dev/shm
mount -t tmpfs -o mode=755,nosuid,nodev tmpfs /run
for home in /root /home; do
  if [[ -d $home ]]; then mount -t tmpfs -o mode=700,nosuid,nodev tmpfs "$home"; fi
done
if [[ -d /dev/snd ]]; then mount -t tmpfs -o mode=000 tmpfs /dev/snd; fi
shopt -s nullglob
for device in /dev/video* /dev/media*; do mount --bind /dev/null "$device"; done
mkdir -m1777 /tmp/.X11-unix
runuser -u nobody -- env -i HOME="$work/homes/bootstrap" USER=nobody LOGNAME=nobody \
  LANG=C.UTF-8 PATH="$work/tools:/usr/bin:/bin" XDG_RUNTIME_DIR="$work/user-runtime" \
  WELINK_DESKTOP_QA_ROOT="$work" WELINK_DESKTOP_QA_ISOLATED=1 LIBGL_ALWAYS_SOFTWARE=1 \
  LD_LIBRARY_PATH="$primary:$primary/resources/app/native/lib/runtime" \
  CHROME_DEVEL_SANDBOX="$primary/chrome-sandbox" \
  timeout -k 5s 240s xvfb-run -a -e "$work/evidence/xvfb.log" \
  -s '-screen 0 1280x900x24 -noreset -nolisten tcp +extension Composite' \
  dbus-run-session -- /bin/bash "$work/display.sh"
'''

DISPLAY = r'''#!/bin/bash
set -euo pipefail
work=$WELINK_DESKTOP_QA_ROOT
openbox >"$work/evidence/window-manager.log" 2>&1 &
manager=$!
trap 'kill "$manager" 2>/dev/null || true; wait "$manager" 2>/dev/null || true' EXIT
for attempt in {1..100}; do
  if xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id'; then break; fi
  kill -0 "$manager"
  sleep .05
done
xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id'
node "$work/verify_desktop_integration.js"
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tool-prefix", type=Path, help="Read-only directory of real extra tools (for example extracted wmctrl)")
    parser.add_argument("--slice", choices=("all", "urls", "opacity"), default="all", help="Select independent functional proof; default runs both")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Root is required only to create the private namespaces; Electron runs as nobody")
    required_tools = ("unshare", "mount", "ip", "runuser", "timeout", "xvfb-run", "Xvfb", "xauth", "openbox", "xprop", "wmctrl", "gio", "node", "python3")
    tools = args.tool_prefix.resolve(strict=True) if args.tool_prefix else None
    if tools and not tools.is_dir():
        parser.error("--tool-prefix must be a directory")
    search_path = str(tools) + os.pathsep + os.environ.get("PATH", "") if tools else None
    missing = [name for name in required_tools if not shutil.which(name, path=search_path)]
    if missing:
        parser.error("Missing real verification prerequisites: " + ", ".join(missing))
    image = args.image.resolve(strict=True)
    for name in ("electron", "chrome-sandbox", "launch-welink", "resources/app/main.jsc", "resources/app/native/desktop_main.js"):
        if not (image / name).is_file():
            parser.error("Missing integrated image input: " + str(image / name))
    output = args.output.absolute()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        parser.error("Output must be an empty/new evidence directory")
    nobody = pwd.getpwnam("nobody")
    os.chown(output, nobody.pw_uid, nobody.pw_gid)
    output.chmod(0o700)
    source = Path(__file__).resolve().parent
    work = Path(tempfile.mkdtemp(prefix="welink-desktop-qa.", dir="/var/tmp"))
    work.chmod(0o755)
    succeeded = False
    try:
        for name in ("releases/hit-welink-native-r45.8/image", "releases/hit-welink-native-r45.8-routing-fixture/image", "evidence", "homes/bootstrap", "user-runtime", "tools"):
            (work / name).mkdir(parents=True, exist_ok=True)
        for name in ("homes", "homes/bootstrap", "user-runtime"):
            os.chown(work / name, nobody.pw_uid, nobody.pw_gid)
            (work / name).chmod(0o700)
        shutil.copyfile(source / "install_desktop.py", work / "install_desktop.py")
        shutil.copyfile(source.parent / "NativeIntegration/verify_desktop_integration.js", work / "verify_desktop_integration.js")
        (work / "namespace.sh").write_text(NAMESPACE)
        (work / "display.sh").write_text(DISPLAY)
        (work / "selection").write_text(args.slice)
        command = ["unshare", "--mount", "--net", "--pid", "--fork", "--mount-proc", "--propagation", "private",
                   "/bin/bash", str(work / "namespace.sh"), str(work), str(image), str(output), str(tools) if tools else ""]
        with (output / "runner.log").open("w") as log:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=255)
        succeeded = result.returncode == 0
        print("Desktop proof exit:", result.returncode)
        print("Evidence:", output)
        return result.returncode
    finally:
        try:
            if not succeeded:
                for log in (work / "homes").rglob("*.log"):
                    if log.is_file() and not log.is_symlink():
                        destination = output / "failure-profile-logs" / log.relative_to(work / "homes")
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(log, destination)
        finally:
            shutil.rmtree(work)


if __name__ == "__main__":
    raise SystemExit(main())
