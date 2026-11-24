#!/usr/bin/env python3
"""Install per-user launcher and URL desktop integration (never the image).

Run as the desktop user after the sealed image has been installed:
  python3 install_desktop.py --image ~/.local/opt/hit-welink-native-r45.8/image

The existing native profile is reused, not imported or modified. The launcher's
singleton routing keeps activations on an older running release until it exits.
HOME/.local/share is intentional: inherited instrumentation XDG_DATA_HOME must
not move the existing HIT desktop entry. --home is for an offline fixture HOME;
--direct-launch is for sessions without systemd (the normal launcher retains
systemd-run --user, Type=exec and --collect). No application is started here.
--apm-package keeps activation in Amber PM, uses a separate desktop identity and
profile, and always preserves existing URL defaults.
"""

import argparse
import base64
import json
import hashlib
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import stat
import tempfile


SCHEMES = ("hwwelink", "hwwemeeting", "cloudlink")
DESKTOP_ID = "hit-welink-native.desktop"
APM_PACKAGE = "cn.edu.hit.welink.native.apm"
APM_DESKTOP_ID = APM_PACKAGE + ".desktop"

# Warm activations go to the live package's same-user socket. APM's own `run`
# mounts a shared overlay on every invocation, so it must be used only cold.
APM_DISPATCH = r'''if [[ ${IS_ACE_ENV:-} != 1 || ${APM_PKG_NAME:-} != "$WELINK_NATIVE_APM_PACKAGE" ]]; then
    exec /usr/bin/python3 -I - "$@" <<'APM_DISPATCH'
import errno
import fcntl
import json
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import sys
import time

state = Path.home().resolve() / '.local/state/welink-native-apm'
state.mkdir(parents=True, mode=0o700, exist_ok=True)
info = state.stat()
if state.resolve() != state or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
    raise SystemExit('The APM launch state directory must be canonical, user-owned and mode 0700')
payload = json.dumps(sys.argv[1:]).encode() + b'\n'
if len(payload) > 65536:
    raise SystemExit('APM activation arguments are too large')

def activate():
    filename = state / 'launch.sock'
    try:
        info = filename.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise SystemExit('Refusing an unrelated APM activation socket')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(10)
            connection.connect(str(filename))
            _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != os.getuid():
                raise SystemExit('The APM activation server belongs to another user')
            connection.sendall(payload)
            data = b''
            while b'\n' not in data and len(data) <= 4096:
                chunk = connection.recv(4096)
                if not chunk:
                    raise SystemExit('The APM activation server closed without acknowledging the request')
                data += chunk
            if len(data) > 4096:
                raise SystemExit('Invalid APM activation reply')
            reply = json.loads(data)
            if reply.get('ok') is not True:
                raise SystemExit(reply.get('error', 'APM activation failed'))
            return True
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.ECONNREFUSED):
            raise
        return False

if activate():
    raise SystemExit(0)
lock = os.open(state / 'launch.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
info = os.fstat(lock)
if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
    raise SystemExit('Invalid APM cold-launch lock')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    for _ in range(100):
        if activate():
            raise SystemExit(0)
        time.sleep(0.1)
    raise SystemExit('The APM package is still starting or shutting down; try again once it is ready')
if not activate():
    candidates = ('/var/lib/apm/apm/files/ace-env/var/lib/apm/cn.edu.hit.welink.native.apm/files/launch',
                  '/var/lib/apm/cn.edu.hit.welink.native.apm/files/launch')
    host_launcher = next((candidate for candidate in candidates if os.path.isfile(candidate)), None)
    if host_launcher is None:
        raise SystemExit('The installed APM host launcher is missing')
    info = os.lstat(host_launcher)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise SystemExit('The APM host launcher must be a protected root-owned package file')
    result = subprocess.run(['/bin/bash', '--', host_launcher, *sys.argv[1:]])
    raise SystemExit(result.returncode)
APM_DISPATCH
fi'''


def desktop_value(value):
    if any(char in value for char in "\0\r\n"):
        raise ValueError("A desktop entry path must not contain NUL or newlines")
    return value.replace("\\", "\\\\").replace("\t", "\\t")


def exec_argument(value):
    # Desktop Entry Exec quoting is not shell quoting. Escape its quoting layer
    # first and its string layer second, including literal percent field codes.
    quoted = "".join("\\" + char if char in '\\"`$' else char for char in value)
    return desktop_value('"' + quoted.replace("%", "%%") + '"')


def launcher_text(image, profile, direct_launch=False, apm_package=None):
    # Only releases beside this image may replace it for singleton activation.
    # The lock is scoped to this profile, host and uid, not just a window title.
    release_root = image.parent.parent
    dispatch = ('exec "$image/launch-welink" "$@"' if direct_launch or apm_package else "\n".join((
        'session=()',
        'for name in HOME PATH DISPLAY WAYLAND_DISPLAY XAUTHORITY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS LANG LC_ALL XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME XDG_CONFIG_DIRS XDG_DATA_DIRS; do',
        '    if [[ -v $name ]]; then session+=(--setenv="$name=${!name}"); fi',
        'done',
        'exec systemd-run --user --quiet --collect --property=Type=exec --working-directory="$HOME" "${session[@]}" \\',
        '    --setenv="WELINK_NATIVE_PROFILE_DIR=$WELINK_NATIVE_PROFILE_DIR" -- "$image/launch-welink" "$@"',
    )))
    context = (() if not apm_package else (
        "export WELINK_NATIVE_APM_PACKAGE=" + shlex.quote(apm_package),
        APM_DISPATCH,
    ))
    return "\n".join((
        "#!/bin/bash", "set -eu", "# HIT native desktop integration r45.8; generated by install_desktop.py.",
        "export WELINK_NATIVE_PROFILE_DIR=" + shlex.quote(str(profile)),
        "image=" + shlex.quote(str(image)),
        "release_root=" + shlex.quote(str(release_root)),
        *context,
        '# A running profile receives both activations and URLs, even across an update.',
        'lock=$(readlink -- "$WELINK_NATIVE_PROFILE_DIR/runtime/SingletonLock" 2>/dev/null) || lock=',
        'owner=${lock##*-}',
        'owned_instance=false',
        'if [[ $owner =~ ^[1-9][0-9]*$ && ${lock%-*} == "$(hostname)" && -O /proc/$owner ]]; then',
        '    owned_instance=true',
        '    running=$(readlink -- "/proc/$owner/exe" 2>/dev/null) || running=',
        '    case "$running" in',
        '        "$release_root"/hit-welink-native-r*/image/electron) image=${running%/electron} ;;',
        '    esac',
        'fi',
        '# A URL must reach Electron\'s existing second-instance/console handler.',
        '# Focus-only activation is safe solely with no arguments and the lock owner.',
        'if [[ $# -eq 0 && $owned_instance == true ]] && command -v wmctrl >/dev/null 2>&1; then',
        '    while read -r window desktop pid rest; do',
        '        [[ $pid == "$owner" ]] || continue',
        '        executable=$(readlink -- "/proc/$pid/exe" 2>/dev/null) || continue',
        '        if [[ $executable == "$image/electron" ]]; then',
        '            wmctrl -ia "$window" && exit 0',
        '        fi',
        '    done < <(wmctrl -lp)',
        'fi',
        dispatch, "",
    ))


def desktop_text(image, launcher, apm_package=None):
    icon = image / "resources/app/pedestal/resources/icon/app.png"
    # GIO validates Exec's argv[0] before expanding percent field codes. Keep the
    # executable fixed; a launcher path containing '%' belongs in an argument.
    # There is no shell command string: bash receives the script and URI directly.
    return "\n".join((
        "[Desktop Entry]", "Type=Application", "Version=1.0",
        "Name=WeLink (HIT Native" + (" / APM)" if apm_package else ")"),
        "Name[zh_CN]=哈工大 WeLink（" + ("原生 APM 版）" if apm_package else "原生版）"),
        "Exec=/bin/bash -- " + exec_argument(str(launcher)) + " %u",
        "TryExec=" + desktop_value(str(launcher)),
        "Icon=" + desktop_value(str(icon)), "Terminal=false",
        "Categories=Network;InstantMessaging;", "StartupWMClass=HIT APP",
        "MimeType=" + ";".join("x-scheme-handler/" + scheme for scheme in SCHEMES) + ";",
        *(("X-APM-APPID=" + apm_package,) if apm_package else ()),
        "X-WeLink-Native-Desktop-Version=r45.14", "",
    ))


def replace_file(filename, content, mode):
    filename.parent.mkdir(parents=True, exist_ok=True)
    if filename.is_symlink():
        raise ValueError("Refusing to replace symlink: " + str(filename))
    if filename.exists() and (not filename.is_file() or filename.stat().st_uid != os.getuid()):
        raise ValueError("Integration file is not a regular file owned by this user: " + str(filename))
    fd, temporary = tempfile.mkstemp(prefix="." + filename.name + ".", dir=filename.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
        os.replace(temporary, filename)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install(image, home, profile=None, direct_launch=False, preserve_defaults=False, desktop_id=None,
            previous_image=None, autostart_file=None, plan_only=False, apm_package=None):
    image = image.absolute()
    home = home.absolute()
    if apm_package is not None and apm_package != APM_PACKAGE:
        raise ValueError("Unsupported APM package identity")
    if apm_package:
        direct_launch = True
        preserve_defaults = True
    profile_name = "hit-welink-native-apm" if apm_package else "hit-welink-native"
    profile = profile.absolute() if profile else home / ".local/share" / profile_name / "profile"
    if apm_package and profile == home / ".local/share/hit-welink-native/profile":
        raise ValueError("APM must not share the host native profile")
    if profile.resolve() != profile or profile.is_symlink():
        raise ValueError("The explicit native profile must be canonical")
    # Activation is never an in-place change to a live native session.
    for process in Path("/proc").iterdir():
        if not process.name.isdecimal():
            continue
        try:
            if process.stat().st_uid != os.getuid() or process.resolve() == Path("/proc/self").resolve():
                continue
            executable = (process / "exe").readlink()
            environment_bytes = (process / "environ").read_bytes().split(b"\0")
            if executable.name == "electron" and (
                    os.fsencode("WELINK_NATIVE_PROFILE_DIR=" + str(profile)) in environment_bytes or
                    executable == image / "electron"):
                raise ValueError("Exit the running native application normally before activating its profile")
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    for required in (image / "electron", image / "launch-welink"):
        if not required.is_file() or not os.access(required, os.X_OK):
            raise ValueError("Missing executable in installed image: " + str(required))
    if not (image / "resources/app/pedestal/resources/icon/app.png").is_file():
        raise ValueError("Missing installed Linux application icon")
    if not home.is_dir() or home.stat().st_uid != os.getuid():
        raise ValueError("HOME must exist and belong to the installing user")
    mime_tool = shutil.which("gio")
    if not preserve_defaults and not mime_tool:
        raise ValueError("gio is required to register URL schemes safely; install the libglib2.0-bin package")
    if not shutil.which("xprop"):
        raise ValueError("xprop is required for real X11 window opacity; install the x11-utils package")
    if not direct_launch and not shutil.which("systemd-run"):
        raise ValueError("systemd-run is required (or explicitly choose --direct-launch)")
    launcher = home / ".local/bin" / ("hit-welink-native-apm" if apm_package else "hit-welink-native")
    applications = home / ".local/share/applications"
    supported_ids = (APM_DESKTOP_ID,) if apm_package else (DESKTOP_ID, "cn.edu.hit.welink.native.desktop")
    if desktop_id is not None and desktop_id not in supported_ids:
        raise ValueError("Unsupported desktop identity")
    requested_id = desktop_id
    desktop_id = desktop_id or (APM_DESKTOP_ID if apm_package else DESKTOP_ID)
    legacy = applications / "cn.edu.hit.welink.native.desktop"
    if not apm_package and not requested_id and not (applications / desktop_id).exists() and legacy.is_file() and not legacy.is_symlink():
        lines = legacy.read_text(encoding="utf-8").splitlines()
        if ("TryExec=" + desktop_value(str(launcher)) in lines and
                "Name=WeLink (HIT Native)" in lines and "StartupWMClass=HIT APP" in lines):
            # Keep existing menu/pinned-launcher identity when upgrading rina.
            desktop_id = legacy.name
    autostart_update = None
    if autostart_file is not None:
        if previous_image is None or autostart_file.parent.resolve() != autostart_file.parent:
            raise ValueError("Autostart migration requires a canonical existing entry and previous image")
        identifier = (apm_package or "cn.edu.hit.welink.native") + "-" + hashlib.sha256(os.fsencode(profile)).hexdigest()[:16]
        if autostart_file.name != identifier + ".desktop":
            raise ValueError("Autostart entry is not owned by this profile")
        if autostart_file.is_symlink() or not autostart_file.is_file() or autostart_file.stat().st_uid != os.getuid():
            raise ValueError("Autostart entry is not a regular user-owned file")
        text = autostart_file.read_text()
        if ("X-WeLink-Native-Owner=" + identifier not in text.splitlines() or
                "X-WeLink-Native-Profile=" + desktop_value(str(profile)) not in text.splitlines()):
            raise ValueError("Autostart ownership marker differs")
        old_app = previous_image.absolute() / "resources/app"
        new_app = image / "resources/app"
        expected = {
            "Exec": "env " + exec_argument("WELINK_NATIVE_PROFILE_DIR=" + str(profile)) + " " +
                    exec_argument(str(old_app / "native/launch-welink")) + " " + exec_argument(str(old_app)),
            "TryExec": desktop_value(str(old_app / "native/launch-welink"))
        }
        replacement = {
            "Exec": "env " + exec_argument("WELINK_NATIVE_PROFILE_DIR=" + str(profile)) + " " +
                    exec_argument(str(new_app / "native/launch-welink")) + " " + exec_argument(str(new_app)),
            "TryExec": desktop_value(str(new_app / "native/launch-welink"))
        }
        if apm_package:
            expected = replacement = {
                "Exec": "/bin/bash -- " + exec_argument(str(launcher)),
                "TryExec": desktop_value(str(launcher)),
            }
            if "X-WeLink-Native-APM-Package=" + apm_package not in text.splitlines():
                raise ValueError("Autostart APM context differs")
        lines = text.splitlines()
        for key, value in expected.items():
            if lines.count(key + "=" + value) != 1:
                raise ValueError("Autostart launch command was changed outside this installation")
        autostart_update = "\n".join(
            key + "=" + replacement[key] if (key := line.partition("=")[0]) in replacement else line
            for line in lines) + "\n"
    entry = applications / desktop_id
    writes = [(launcher, launcher_text(image, profile, direct_launch, apm_package), 0o755),
              (entry, desktop_text(image, launcher, apm_package), 0o644)]
    if autostart_update is not None:
        writes.append((autostart_file, autostart_update, stat.S_IMODE(autostart_file.stat().st_mode)))
    if plan_only:
        if not preserve_defaults:
            raise ValueError("Activation plans require --preserve-defaults")
        return [{"path": str(filename), "data": base64.b64encode(text.encode()).decode(),
                 "mode": mode, "sha256": hashlib.sha256(text.encode()).hexdigest()}
                for filename, text, mode in writes]
    for filename, text, mode in writes:
        replace_file(filename, text, mode)
    # Use the existing desktop user's normal config, not a bridge/test XDG override.
    # GIO updates only the requested associations and handles HOME/application
    # paths as paths; xdg-mime's shell implementation splits paths with spaces.
    # Fix the query language so its actual default can be checked unambiguously.
    environment = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"),
                       XDG_DATA_HOME=str(home / ".local/share"), LC_ALL="C")
    environment.pop("XDG_CONFIG_DIRS", None)
    environment.pop("XDG_DATA_DIRS", None)
    for scheme in (() if preserve_defaults else SCHEMES):
        mime = "x-scheme-handler/" + scheme
        subprocess.run([mime_tool, "mime", mime, desktop_id], env=environment, check=True)
        query = subprocess.check_output([mime_tool, "mime", mime], env=environment, text=True)
        defaults = [line.partition(": ")[2] for line in query.splitlines()
                    if line.startswith("Default application for ")]
        if defaults != [desktop_id]:
            raise RuntimeError("Desktop default was not registered for " + mime + ": " + query.strip())
    update = shutil.which("update-desktop-database")
    if update:
        subprocess.run([update, str(applications)], env=environment, check=True)
    return launcher, entry


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--image", type=Path, required=True, help="Installed sealed r45.8 image directory")
    parser.add_argument("--home", type=Path, default=Path.home(), help="Desktop user's HOME (default: current HOME)")
    parser.add_argument("--profile", type=Path, help="Existing native profile (default: HOME/.local/share/hit-welink-native/profile)")
    parser.add_argument("--direct-launch", action="store_true", help="Explicitly use exec instead of systemd-run (isolated/non-systemd sessions)")
    parser.add_argument("--preserve-defaults", action="store_true", help="Preserve all current desktop/MIME defaults without invoking registration")
    parser.add_argument("--desktop-id", choices=[DESKTOP_ID, "cn.edu.hit.welink.native.desktop", APM_DESKTOP_ID], help="Preserve the exact current desktop identity")
    parser.add_argument("--apm-package", choices=[APM_PACKAGE], help="Use isolated Amber PM launch/profile/desktop context; preserve all MIME defaults")
    parser.add_argument("--previous-image", type=Path, help="Previous image, for owned autostart migration")
    parser.add_argument("--autostart-file", type=Path, help="Exact existing profile-owned autostart entry to migrate without enabling it")
    parser.add_argument("--plan", action="store_true", help="Output exact activation writes as JSON without modifying integration")
    args = parser.parse_args()
    result = install(args.image, args.home, args.profile, args.direct_launch, args.preserve_defaults,
                     args.desktop_id, args.previous_image, args.autostart_file, args.plan, args.apm_package)
    if args.plan:
        print(json.dumps(result, separators=(",", ":")))
        return
    launcher, entry = result
    print("Installed launcher:", launcher)
    print("Installed desktop entry:", entry)
    print("Preserved existing MIME defaults" if args.preserve_defaults or args.apm_package else "Registered schemes: " + ", ".join(SCHEMES))
    print("The application was not started; existing authentication/profile state was not changed.")


if __name__ == "__main__":
    main()
