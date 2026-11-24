#!/usr/bin/env python3
"""Offline, two-phase packaging of the real Linux ia32 application.

prepare creates NEW output and manifest directories. Build sqlite_plugin.dll.so
with the generated native_integrity_manifest.h, then finalize those same
immutable assets. Neither phase runs Electron, npm, SDKs, compilers or ld.so.
The build-side inventory is not shipped and is never a runtime trust source.
"""
import argparse
from collections import deque
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

FORMAT = 1
CHECKER = "native/lib/sqlite_plugin.dll.so"
NATIVE_LIBRARIES = {
    "common_utils.dll.so": ("common_utils_init", "common_utils_shutdown"),
    "conference_db.dll.so": ("conference_db_init", "conference_db_send_msg", "conference_db_set_log_path", "conference_db_shutdown"),
    "http_with_rs.dll.so": ("http_json_init", "HttpWithRsDispatchCallbacks"),
    "contact_sqlite_plugin.dll.so": (
        "SqliteRecvMsgImport", "ContactPluginSetLogPath", "SqliteServiceStartup",
        "GabSqliteQueryAll", "GabSqliteExec", "GabSqliteQueryAllWithKey", "GabSqliteExecWithKey",
        "ContactPluginDispatchCallbacks", "ContactPluginShutdown",
    ),
    "wk_login.dll.so": ("welink_login_init", "welink_login_dispatch"),
    "wk_security.dll.so": ("welink_security_init", "welink_security_dispatch"),
    "wk_tup_support.dll.so": ("tup_support_init", "tup_support_send_msg", "tup_support_set_log_path", "tup_support_shutdown", "tup_support_dispatch"),
    "meeting_adapter.dll.so": ("set_c2js_callback", "meeting_native_auth_dispatch"),
    "tup_im_logic_api.so": ("Startup", "ImDispatchCallbacks"),
    "tup_offlinefile_logic_api.so": ("OfflineFileInitService", "OfflineFileDispatchCallbacks"),
    "tup_nativetools_logic_api.so": ("NativeToolsInitService", "NativeToolsDispatchCallbacks"),
    "tup_sqlite_logic_api.so": ("InitSqliteService", "SqliteServiceDispatchCallbacks"),
    "db_import_export_tools.so": ("CallBack", "Startup", "Shutdown", "ImportExportDispatchCallbacks"),
}
NATIVE_EXECUTABLES = ("welink-import-export-worker", "welink-voice-worker", "welink-render-surface-worker")
NATIVE_HELPERS = (
    "main.js", "desktop_main.js", "ffi.js", "platform.js", "platform_main.js", "platform_settings.js",
    "update_config.js", "update_main.js", "update_renderer.js",
    "update_manifest.js", "update_download.js", "update_install.js", "update_supervisor.py",
    "update_readiness.js", "update_progress.html", "update_progress.js", "update_progress_preload.js",
    "update_profile_gate.js", "update_public_key.pem",
    "im_adapter.js", "im_adapter_files.js", "im_adapter_forward.js", "im_adapter_main.js", "im_readiness.js",
    "meeting_main.js", "meeting_menu.js", "meeting_renderer.js", "meeting_service.js",
    "meeting_render_host.js", "meeting_render_notes.js",
    "meeting_render_surface_host.js", "meeting_custom_background_menu.js",
    "meeting_complaint_host.js", "meeting_complaint_preload.js",
    "meeting_dial.js",
    "meeting_devices.html", "meeting_devices_preload.js",
    "meeting_directory.js", "meeting_directory_host.js", "meeting_directory.html",
    "meeting_picker.html", "meeting_picker_preload.js",
)
CONFERENCE_HELPERS = (
    "meeting_invitation_uri.js", "meeting_guest_site.js",
    "meeting_issuer_request.js", "meeting_pending_call.js",
    "meeting_p2p_call.js", "meeting_offline_control.js", "meeting_offline_transport.js",
    "meeting_offline_session.js",
    "meeting_render_windows.js", "meeting_native_capabilities.js", "meeting_p2p_mini.js",
    "meeting_render_surface.js", "meeting_moderation_capabilities.js", "meeting_moderation_capabilities_web.js",
    "meeting_voice_anonymous.js", "meeting_custom_background.js", "meeting_custom_background_host.js",
    "meeting_custom_background_policy.js",
    "meeting_invited_share.js",
    "meeting_snapshot_policy.js",
    "meeting_offline_window.js", "meeting_offline_preload.js", "meeting_offline_view.js", "meeting_offline.html",
    "meeting_offline_media.js", "meeting_offline_media.css",
    "meeting_audio_output.js",
    "meeting_native_web.js", "meeting_native_web_runtime.js", "meeting_native_web_preload.js",
    "meeting_native_web_ui.js", "meeting_native_web_watermark.js", "meeting_native_web_capture.js",
    "meeting_native_web_recording.js", "meeting_native_web_recording_control.js",
    "meeting_native_web_recording_tip.js",
    "meeting_sdk_log.js", "meeting_sdk_log_catalog.js", "meeting_sdk_log_runtime.js",
    "meeting_incoming_invite.js", "meeting_incoming_invite_preload.js", "meeting_incoming_invite.html",
    "meeting_voice_host.js", "meeting_voice_session.js", "meeting_voice_filter.js", "meeting_voice_media.js",
    "meeting_voice_recorder.html", "meeting_voice_recorder_preload.js",
    "meeting_native_web_management.js", "meeting_native_web_services.js",
)
ELECTRON_FILES = (
    "electron", "chrome_crashpad_handler", "chrome_sandbox", "chrome_100_percent.pak",
    "chrome_200_percent.pak", "resources.pak", "icudtl.dat", "snapshot_blob.bin",
    "libEGL.so", "libGLESv2.so", "libffmpeg.so", "libvk_swiftshader.so",
    "libvulkan.so.1", "vk_swiftshader_icd.json", "version", "LICENSE", "LICENSES.chromium.html",
)
FFI_ROOT = Path("libraries/node_extends/node-ffi")
HOOK = FFI_ROOT / "ffi-napi/lib/library.js"
FFI_PACKAGES = ("ref-napi", "ref-struct-di", "node-gyp-build", "debug", "ms")
# These belong to the host glibc installation. Mixing in a sysroot loader/libc,
# even indirectly via LD_LIBRARY_PATH, is expressly forbidden.
HOST_GLIBC = frozenset((
    "ld-linux.so.2", "libc.so.6", "libm.so.6", "libdl.so.2", "libpthread.so.0",
    "librt.so.1", "libresolv.so.2", "libutil.so.1", "libanl.so.1",
    "libnsl.so.1", "libBrokenLocale.so.1", "libthread_db.so.1",
    "libnss_files.so.2", "libnss_dns.so.2", "libnss_compat.so.2",
))
# Electron loads these at runtime, rather than through its DT_NEEDED entries.
DLOPEN_ROOTS = ("libpulse.so.0", "libgnome-keyring.so.0", "libsoftokn3.so",
                "libfreebl3.so", "libfreeblpriv3.so", "libnssckbi.so", "libX11-xcb.so.1", "libudev.so.1")
LEGAL_NAME = re.compile(r"^(?:licen[cs]e|copying|copyright|notice|authors)(?:[._-].*)?$", re.I)
DSO_NAME = re.compile(r".*\.so(?:\.[0-9]+)*$")

LAUNCHER = r'''#!/usr/bin/env bash
set -euo pipefail
fail() { printf 'welink-native: %s\n' "$*" >&2; exit 1; }
SELF=$(readlink -f -- "${BASH_SOURCE[0]}")
NATIVE=$(cd -- "$(dirname -- "$SELF")" && pwd -P)
APP=$(cd -- "$NATIVE/.." && pwd -P)
IMAGE=$(cd -- "$APP/../.." && pwd -P)
RUNTIME=$IMAGE
[[ -f "$NATIVE/lib/sqlite_plugin.dll.so" ]] || fail 'Image is not finalized: compile and install its integrity checker first.'
[[ -x "$RUNTIME/electron" ]] || fail 'The genuine ia32 Electron executable is missing.'
umask 077
if [[ -n ${WELINK_NATIVE_PROFILE_DIR:-} ]]; then
  PROFILE=$WELINK_NATIVE_PROFILE_DIR
else
  CONFIG=${XDG_CONFIG_HOME:-${HOME:?HOME is required}/.config}
  [[ $CONFIG = /* ]] || fail 'XDG_CONFIG_HOME must be absolute.'
  PROFILE=$CONFIG/cn.edu.hit.welink.native
fi
[[ $PROFILE = /* ]] || fail 'WELINK_NATIVE_PROFILE_DIR must be absolute.'
[[ ! -L $PROFILE ]] || fail 'The native profile directory must not be a symlink.'
PROFILE=$(realpath -m -- "$PROFILE")
case "$PROFILE/" in "$IMAGE/"*) fail 'The profile must be outside the immutable image.' ;; esac
case "$PROFILE/" in */.wine/*|*/drive_c/*|*/dosdevices/*) fail 'Wine state is not a native profile.' ;; esac
# Acquire a stable SH gate before mkdir, ownership markers or pixbuf-cache
# writes. The Python helper opens O_NOFOLLOW and execs back with a real inherited
# FD; the resumed launcher verifies inode ownership and obtains flock again.
# The descriptor remains open across exec, until Electron actually exits.
unset LD_PRELOAD LD_AUDIT LD_LIBRARY_PATH NODE_PATH NODE_OPTIONS ELECTRON_RUN_AS_NODE PYTHONPATH PYTHONHOME OPENSSL_CONF OPENSSL_MODULES
if [[ -n ${WELINK_NATIVE_PROFILE_GATE_FD:-} ]]; then
  /usr/bin/python3 -I "$NATIVE/update_supervisor.py" --check-profile-gate "$PROFILE" "$WELINK_NATIVE_PROFILE_GATE_FD" ||
    fail 'Invalid or unavailable inherited native profile gate.'
else
  exec /usr/bin/python3 -I "$NATIVE/update_supervisor.py" --launch-profile-gate "$PROFILE" "$SELF" "$@"
fi
if [[ -e $PROFILE ]]; then
  [[ -d $PROFILE && -O $PROFILE ]] || fail 'The native profile must be a directory owned by this user.'
else
  mkdir -p -m 700 -- "$PROFILE"
fi
MARKER=$PROFILE/.welink-native-profile
if [[ ! -e $MARKER && ! -L $MARKER ]]; then
  [[ -z $(find "$PROFILE" -mindepth 1 -maxdepth 1 -print -quit) ]] || fail 'Refusing to import an existing non-native profile.'
  (set -o noclobber; printf 'welink-native-profile-v1\n' > "$MARKER")
fi
[[ -f $MARKER && ! -L $MARKER && -O $MARKER ]] || fail 'Invalid native profile ownership marker.'
[[ $(cat -- "$MARKER") = welink-native-profile-v1 ]] || fail 'Unrecognized native profile.'
MODE=$(stat -c '%a' -- "$PROFILE")
(( (8#$MODE & 077) == 0 )) || fail 'The native profile must have private permissions (0700).'
# A separate native profile is the only writable application state. No registry,
# Wine account, key store or browser state is migrated or used as a fallback.
export WELINK_NATIVE_PROFILE_DIR=$PROFILE
unset LD_PRELOAD LD_AUDIT NODE_PATH NODE_OPTIONS ELECTRON_RUN_AS_NODE
unset PREBUILDS_ONLY FFI_NAPI_PREBUILD REF_NAPI_PREBUILD
export LD_LIBRARY_PATH="$RUNTIME:$NATIVE/lib/runtime"
SANDBOX_ARGS=()
if [[ -n ${WELINK_NATIVE_APM_PACKAGE:-} ]]; then
  [[ $WELINK_NATIVE_APM_PACKAGE = cn.edu.hit.welink.native.apm &&
     ${IS_ACE_ENV:-} = 1 && ${APM_PKG_NAME:-} = "$WELINK_NATIVE_APM_PACKAGE" ]] ||
    fail 'The APM sandbox backend requires the matching Amber PM application.'
  for argument in "$@"; do
    case "${argument%%=*}" in
      --no-sandbox|--disable-namespace-sandbox|--disable-seccomp-filter-sandbox|--disable-gpu-sandbox)
        fail 'Disabling Chromium sandbox protection is not supported in APM.' ;;
    esac
  done
  [[ -f $RUNTIME/chrome-sandbox && ! -L $RUNTIME/chrome-sandbox && -O $RUNTIME/chrome-sandbox &&
     $(stat -c '%a' -- "$RUNTIME/chrome-sandbox") = 755 ]] ||
    fail 'The APM image requires its sealed, user-owned non-setuid sandbox payload.'
  # Bubblewrap sets NO_NEW_PRIVS: setuid elevation is unavailable. Chromium must
  # retain its own nested user/PID/network namespaces and seccomp sandbox.
  /usr/bin/unshare --user --map-root-user --pid --net --fork /usr/bin/true ||
    fail 'Nested user/PID/network namespaces are unavailable; refusing unsandboxed APM launch.'
  unset CHROME_DEVEL_SANDBOX
  SANDBOX_ARGS=(--disable-setuid-sandbox)
else
  export CHROME_DEVEL_SANDBOX="$RUNTIME/chrome-sandbox"
fi
# GdkPixbuf's real registry helper discovers the shipped decoder modules. This
# disposable profile cache is NOT an integrity manifest or a trusted baseline.
export GDK_PIXBUF_MODULEDIR="$NATIVE/lib/pixbuf-loaders"
export GDK_PIXBUF_MODULE_FILE="$PROFILE/gdk-pixbuf-loaders.cache"
CACHE=$(mktemp "$PROFILE/.gdk-pixbuf-loaders.XXXXXXXX")
trap 'rm -f -- "$CACHE"' EXIT
"$NATIVE/libexec/gdk-pixbuf-query-loaders" "$GDK_PIXBUF_MODULEDIR"/*.so > "$CACHE"
[[ -s $CACHE ]] || fail 'The real GdkPixbuf module registry is empty.'
mv -f -- "$CACHE" "$GDK_PIXBUF_MODULE_FILE"
trap - EXIT
# platform autostart/relaunch may supply the explicit app argument.
if [[ ${1:-} = "$APP" ]]; then shift; fi
exec "$RUNTIME/electron" "$APP" "${SANDBOX_ARGS[@]}" "$@"
'''


class AssemblyError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise AssemblyError(message)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode()


def load_json(path):
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def safe_relative(value):
    path = Path(value)
    require(value and not path.is_absolute() and ".." not in path.parts and "\\" not in value
            and all(ord(c) >= 32 for c in value), f"Unsafe relative path: {value!r}")
    return path


def resolve_in(root, path):
    """Resolve package symlinks without following /usr or /lib into the host."""
    pending = deque(path.relative_to(root).parts)
    parts = []
    links = 0
    while pending:
        part = pending.popleft()
        if part in ("", "."):
            continue
        if part == "..":
            require(parts, f"Input symlink escapes its prefix: {path}")
            parts.pop()
            continue
        candidate = root.joinpath(*parts, part)
        if candidate.is_symlink():
            links += 1
            require(links <= 40, f"Input symlink loop: {path}")
            target = candidate.readlink()
            if target.is_absolute():
                target = target.relative_to(root) if target.is_relative_to(root) else target.relative_to("/")
                parts = []
            pending.extendleft(reversed(target.parts))
        else:
            parts.append(part)
    result = root.joinpath(*parts)
    require(result.is_file(), f"Missing regular input file: {path} (resolved as {result})")
    return result


def write_new(path, data, executable=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(data)
    path.chmod(0o755 if executable else 0o644)


def copy_file(source, destination, root=None):
    if root is not None:
        source = resolve_in(root, source)
    require(source.is_file() and not source.is_symlink(), f"Missing regular input: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as incoming, destination.open("xb") as outgoing:
        shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
    destination.chmod(0o755 if source.stat().st_mode & 0o111 else 0o644)


def tree_files(root):
    require(root.is_dir() and not root.is_symlink(), f"Missing input directory: {root}")
    for base, directories, names in os.walk(root, followlinks=False):
        directories.sort()
        for name in directories:
            require(not (Path(base) / name).is_symlink(), f"Directory symlink is not a production input: {Path(base) / name}")
        for name in sorted(names):
            path = Path(base) / name
            require(path.is_file() or path.is_symlink(), f"Non-file input: {path}")
            yield path


def production_js(relative):
    if any(p.startswith(".") or p.lower() in ("test", "tests", "example", "examples", "benchmark", "benchmarks", "fixtures", "coverage") for p in relative.parts):
        return False
    name = relative.name.lower()
    if name.startswith(("test", "verify_", "inspect_", "plan_")) or name.endswith((".test.js", ".spec.js")) or name == "build-test.js":
        return False
    return relative.suffix in (".js", ".mjs", ".json", ".node") or bool(LEGAL_NAME.match(relative.name))


def copy_js_tree(source, destination):
    for path in tree_files(source):
        relative = path.relative_to(source)
        if production_js(relative):
            copy_file(path, destination / relative, source)


def elf_info(path):
    with path.open("rb") as stream:
        header = stream.read(20)
    require(len(header) == 20 and header[:6] == b"\x7fELF\x01\x01" and header[18:20] == b"\x03\x00",
            f"Not a real little-endian Linux ia32 ELF input: {path}")
    environment = dict(os.environ, LC_ALL="C")
    text = subprocess.check_output(["readelf", "--wide", "--dynamic", "--dyn-syms", "--version-info", str(path)], text=True, env=environment)
    needed = re.findall(r"\(NEEDED\).*\[([^\]]+)\]", text)
    sonames = re.findall(r"\(SONAME\).*\[([^\]]+)\]", text)
    runpaths = re.findall(r"\(RUNPATH\).*\[([^\]]*)\]", text)
    require(all("/" not in name for name in needed), f"Absolute or path-qualified DT_NEEDED in {path}: {needed}")
    exports, imports = set(), set()
    for line in text.splitlines():
        fields = line.split()
        if len(fields) >= 8 and fields[0].endswith(":") and fields[4] in ("GLOBAL", "WEAK"):
            (imports if fields[6] == "UND" else exports).add(fields[7].split("@")[0])
    initializer_size = re.search(r"\(INIT_ARRAYSZ\)\s+(\d+)", text)
    return {"needed": needed, "soname": sonames[0] if sonames else None,
            "runpath": runpaths, "exports": exports, "imports": imports,
            "has_initializers": bool(initializer_size and int(initializer_size.group(1))),
            "glibc": sorted(set(re.findall(r"\bGLIBC_[A-Za-z0-9_.]+", text)))}


def native_elf(path, exports):
    info = elf_info(path)
    require(info["runpath"] == ["$ORIGIN/runtime"], f"Native DT_RUNPATH must be $ORIGIN/runtime: {path}")
    missing = set(exports) - info["exports"]
    require(not missing, f"Missing real native exports in {path}: {', '.join(sorted(missing))}")
    return info


class Provider:
    def __init__(self, label, root, directories):
        self.label, self.root = label, root
        self.index = {}
        inventory_path = root.parent / "installed-files.json"
        self.inventory = load_json(inventory_path) if inventory_path.is_file() else None
        for directory in directories:
            if not directory.is_dir():
                continue
            for path in sorted(directory.rglob("*")):
                if DSO_NAME.fullmatch(path.name) and (path.is_file() or path.is_symlink()):
                    self.index.setdefault(path.name, path)

    def find(self, name):
        path = self.index.get(name)
        return resolve_in(self.root, path) if path is not None else None

    def verify(self, path):
        if self.inventory is not None:
            entry = self.inventory.get(path.relative_to(self.root).as_posix())
            require(entry and entry.get("sha256") == digest(path),
                    f"Runtime package file differs from its acquired bytes: {path}")


def providers_for(args):
    providers = [Provider("native-deps", args.deps_prefix, [args.deps_prefix / "runtime"])]
    for number, root in enumerate([args.electron_prefix, *args.extra_runtime_prefix]):
        providers.append(Provider(f"electron-deps-{number}", root, [root / "lib", root / "usr/lib"]))
    return providers


def install_pixbuf(app, provider, source):
    directory = source.parent / "gdk-pixbuf-2.0"
    query = resolve_in(provider.root, directory / "gdk-pixbuf-query-loaders")
    modules = sorted(directory.glob("*/loaders/*.so"))
    require(modules, f"Missing real GdkPixbuf decoder modules: {directory}")
    result = []
    for source, target in [(query, app / "native/libexec/gdk-pixbuf-query-loaders"),
                           *((path, app / "native/lib/pixbuf-loaders" / path.name) for path in modules)]:
        source = resolve_in(provider.root, source)
        provider.verify(source)
        copy_file(source, target)
        result.append((target, "GdkPixbuf runtime-loaded decoder"))
    return result


def install_closure(image, app, roots, providers, dlopen):
    destination = app / "native/lib/runtime"
    destination.mkdir(parents=True)
    queue = deque(roots)
    selections = {}
    owners = {}
    host = set()
    glibc = set()
    bundled = {p.name: p for p in image.iterdir() if DSO_NAME.fullmatch(p.name)}
    missing = {}
    for name in dlopen:
        queue.append((name, "explicit runtime-loaded dependency"))
    while queue:
        item, owner = queue.popleft()
        if isinstance(item, Path):
            path = item
            info = elf_info(path)
        else:
            name = item
            owners.setdefault(name, set()).add(owner)
            if name in HOST_GLIBC:
                host.add(name)
                continue
            if name in selections:
                continue
            if name in bundled:
                path = bundled[name]
                selections[name] = {"provider": "electron", "source": path.relative_to(image).as_posix(), "sha256": digest(path)}
                info = elf_info(path)
            else:
                found = next(((provider, provider.find(name)) for provider in providers if name in provider.index), None)
                if found is None:
                    missing.setdefault(name, set()).add(owner)
                    continue
                provider, source = found
                info = elf_info(source)
                require(info["soname"] not in HOST_GLIBC, f"Refusing to bundle glibc via alias {name}: {source}")
                provider.verify(source)
                copy_file(source, destination / name)
                path = destination / name
                selections[name] = {"provider": provider.label, "source": source.relative_to(provider.root).as_posix(), "sha256": digest(path)}
                if name == "libgdk_pixbuf-2.0.so.0":
                    queue.extend(install_pixbuf(app, provider, source))
        glibc.update(info["glibc"])
        queue.extend((name, path.relative_to(image).as_posix()) for name in info["needed"])
    require(not missing, "Missing ia32 runtime DSOs (no host fallback):\n" + "\n".join(
        f"  {name}: needed by {', '.join(sorted(owners))}" for name, owners in sorted(missing.items())))
    for name, item in selections.items():
        item["neededBy"] = sorted(owners[name])
    return selections, sorted(host), sorted(glibc)


def install_licenses(args, app, providers, selections):
    destination = app / "native/licenses"
    # These are legal texts only, never the compiler sysroot or its executable tools.
    for provider in providers:
        used = {name: item for name, item in selections.items() if item["provider"] == provider.label}
        if not used:
            continue
        package_lock = provider.root / "packages.lock.json" if provider.label == "native-deps" else provider.root.parent / "packages.lock.json"
        if package_lock.is_file():
            copy_file(package_lock, app / "native/provenance" / (provider.label + ".packages.json"))
        root = provider.root / "sysroot" if provider.label == "native-deps" else provider.root
        docs = root / "usr/share/doc"
        notices = sorted(p for p in docs.glob("*/copyright") if p.is_file())
        if notices:
            for path in notices:
                copy_file(path, destination / provider.label / path.relative_to(docs), provider.root)
            # Keep any additional upstream license/notice files delivered with the packages.
            for path in sorted(docs.rglob("*")):
                if path.is_file() and LEGAL_NAME.match(path.name) and path.name != "copyright":
                    copy_file(path, destination / provider.label / path.relative_to(docs), provider.root)
        else:
            missing = []
            for name, item in sorted(used.items()):
                legal = args.notice_map.get(item["sha256"], [])
                if not legal:
                    missing.append(f"  {name} sha256={item['sha256']} source={provider.root / item['source']}")
                for number, path in enumerate(legal):
                    copy_file(path, destination / provider.label / name / f"{number}-{path.name}")
            require(not missing, "Missing legal notices for runtime inputs; supply --notice-map keyed by the exact DSO SHA256:\n" + "\n".join(missing))
    require(args.common_licenses.is_dir(), f"Missing common license texts: {args.common_licenses}")
    for path in tree_files(args.common_licenses):
        copy_file(path, destination / "common-licenses" / path.relative_to(args.common_licenses), args.common_licenses)
    copy_file(args.deps_prefix / "sources/json-c-0.19/COPYING", destination / "json-c/COPYING")
    legal = Path(__file__).resolve().parent / "electron-runtime/licenses"
    provenance = load_json(legal / "sqlite3mc-1.4.6.json")
    require(digest(legal / "sqlite3mc-1.4.6-LICENSE") == provenance["sha256"],
            "Pinned SQLite3MC license bytes changed")
    copy_file(legal / "sqlite3mc-1.4.6-LICENSE", destination / "sqlite3mc/LICENSE")
    copy_file(legal / "sqlite3mc-1.4.6.json", app / "native/provenance/sqlite3mc-license.json")
    # The pinned SQLite3MC amalgamation carries its incorporated ciphers' notices.
    # Extract actual legal comment blocks, not executable source or analysis code.
    sqlite = args.sqlite_source / "sqlite3mc_amalgamation.c"
    text = sqlite.read_text(encoding="utf-8")
    blocks = list(dict.fromkeys(block for block in re.findall(r"^/\*.*?^\s*\*/", text, re.M | re.S)
                               if re.search(r"copyright|permission is hereby granted|public domain|license|licence", block, re.I)))
    require(blocks and any("permission is hereby granted" in b.lower() for b in blocks), f"Missing complete SQLite3MC license notices in {sqlite}")
    write_new(destination / "sqlite3mc/NOTICES", ("\n\n".join(blocks) + "\n").encode())
    for number, source in enumerate(args.native_license):
        copy_file(source, destination / "additional" / f"{number}-{source.name}")


def install_ffi(args, app):
    source = args.ffi_output
    identity = load_json(source / "source-lock.json")
    require(identity["electron"]["version"] == "22.3.26" and identity["electron"]["nodeVersion"] == "16.17.1"
            and identity["electron"]["architecture"] == "ia32", "FFI provenance does not identify Electron 22.3.26/Node 16.17.1 ia32")
    for path, name, version in ((source / "ffi-napi", "ffi-napi", "4.0.3"), (source / "node_modules/ref-napi", "ref-napi", "3.0.3")):
        package = load_json(path / "package.json")
        require(package["name"] == name and package["version"] == version, f"Expected genuine {name} {version} sources: {path}")
    destination = app / FFI_ROOT
    require(not destination.exists(), f"Vendor FFI tree must be replaced, not overlaid: {destination}")
    copy_js_tree(source / "ffi-napi", destination / "ffi-napi")
    for name in FFI_PACKAGES:
        copy_js_tree(source / "node_modules" / name, destination / "node_modules" / name)
    copy_file(source / "package-lock.json", destination / "package-lock.json")
    for path in tree_files(source / "licenses"):
        copy_file(path, app / "native/licenses/ffi" / path.relative_to(source / "licenses"), source / "licenses")
    for name in ("LICENSE", "LICENSE-BUILDTOOLS"):
        copy_file(source / "ffi-napi/deps/libffi" / name, app / "native/licenses/libffi" / name)
    addons = [destination / "ffi-napi/build/Release/ffi_bindings.node", destination / "node_modules/ref-napi/build/Release/binding.node"]
    for path in addons:
        info = elf_info(path)
        # Node 16's upstream N-API addons may register from ELF constructors
        # instead of exporting the later explicit initialization entry point.
        registered = "napi_register_module_v1" in info["exports"] or (
            "napi_module_register" in info["imports"] and info["has_initializers"])
        require(registered, f"Unsupported N-API registration ABI: {path}")
    return addons


def install_management(args, app):
    source = args.management_input
    destination = app / "native/vendor/management"
    lock = load_json(source / "package-lock.json")
    copy_file(source / "package.json", destination / "package.json")
    copy_file(source / "package-lock.json", destination / "package-lock.json")
    for relative, metadata in sorted(lock["packages"].items()):
        if not relative or metadata.get("dev"):
            continue
        relative = safe_relative(relative)
        require(relative.parts[0] == "node_modules", f"Non-production management package path: {relative}")
        package = source / relative
        manifest = load_json(package / "package.json")
        require(manifest["version"] == metadata["version"], f"Management dependency differs from its lock: {package}")
        copy_js_tree(package, destination / relative)
        legal = [p for p in package.iterdir() if p.is_file() and LEGAL_NAME.match(p.name)]
        if not legal and manifest["name"] == "ms" and manifest["version"] == "2.1.3":
            copy_file(args.ffi_output / "licenses/ms-2.1.3/license.md", destination / relative / "license.md")
        else:
            require(legal, f"Missing production management license: {package}")


def install_vendor(args, app):
    excluded = []
    for path in tree_files(args.vendor_app):
        relative = path.relative_to(args.vendor_app)
        if relative.is_relative_to(FFI_ROOT):
            continue
        if path.suffix.lower() in (".dll", ".exe", ".node", ".pdb", ".lib", ".obj"):
            excluded.append(relative.as_posix())
            continue
        require(relative.parts[0] != "native", "Vendor app already contains an unrelated native/ tree")
        copy_file(path, app / relative, args.vendor_app)
    return excluded


def install_dial_receipts(app, conference_source):
    """Propagate the provider receipt through the shipped conference and redial views."""
    def change(source, old, new):
        require(source.count(old) == 1, f"Unexpected campus dial handler: {old[:80]}")
        return source.replace(old, new)

    for reason in ("NO_CALL_PERMISSION", "NO_CALL_PSTN", "NO_CALL_PSTN_PERSON"):
        toast = f"window.uiToast({{content:language.{reason}}}),"
        conference_source = change(conference_source, toast + "{result:0}",
                                   toast + '{result:1,param:{reason_code:"' + reason + '"}}')
    # Never create the original local callback record before the provider confirms
    # acceptance. Its later connected/ended state is a separate business event.
    conference_source = change(conference_source, 'if(f?Tc({calleeNum:c,callerNum:d}):wc(e),',
                               'const dialReply=await(f?Tc({calleeNum:c,callerNum:d,callRequestId:e.callRequestId}):wc(e));'
                               'if(dialReply?.result!==0||dialReply.dialAccepted!==true)'
                               'return dialReply??{result:1,param:{reason_code:"CALL_UNCONFIRMED"}};if(')
    tail = 'await Yo.add(s)}catch(e){Lc.error("[func handleStartCall], error: ",e)}}'
    conference_source = change(conference_source, tail + '}', tail + 'return dialReply}')
    public_start = '"method://conference/startCall":'
    controls = ("getPendingCall", "cancelPendingCall")
    conference_source = change(conference_source, public_start, ''.join(
        f'"method://conference/{name}":e=>Pedestal.callMethod("method://private_conference/hwm/{name}",e),'
        for name in controls) + public_start)
    conference_source = change(conference_source,
        'rs.startCtdCall({caller_number:n,callee_number:t});if(',
        'rs.startCtdCall({caller_number:n,callee_number:t,callRequestId:e.callRequestId});'
        'if(o?.result===0&&o.dialAccepted!==true)return o;if(')
    conference_source = change(conference_source, 'return Lc.info("start ctd call success"),o', 'return o')
    conference_source = change(conference_source,
        'function({caller_number:e,callee_number:t}){os.info("startCtdCall");let n=await Pedestal.callMethod('
        '"method://private_conference/hwm/startCtdCall",{caller_number:e,callee_number:t})',
        'function(e){os.info("startCtdCall");let n=await Pedestal.callMethod('
        '"method://private_conference/hwm/startCtdCall",e)')
    conference_source = change(conference_source,
        'rs.startCall({calleeNum:t,isVideo:n,userInfo:p})',
        'rs.startCall({calleeNum:t,isVideo:n,userInfo:p,callRequestId:e.callRequestId})')
    conference_source = change(conference_source,
        'function({calleeNum:e,isVideo:t,userInfo:n}){os.info("startCall"',
        'function({calleeNum:e,isVideo:t,userInfo:n,callRequestId:requestId}){os.info("startCall"')
    conference_source = change(conference_source,
        '"method://private_conference/hwm/startCall",{calleeNum:e,isVideo:t,userInfo:n}',
        '"method://private_conference/hwm/startCall",{calleeNum:e,isVideo:t,userInfo:n,callRequestId:requestId}')

    views = app / "plugin/callRecord/dist"
    start = ('function({calleeNum:e,isVideo:t,calleeInfo:n}){Pedestal.callMethod("method://conference/startCall",'
             '{calleeNum:e,isVideo:t,calleeInfo:n})}')
    for name, info in (("keypad", "u"), ("callRecord", "l")):
        html = views / (name + ".html")
        entry = '<script defer="defer" src="./js/' + name + '.js"></script>'
        html.write_text(change(html.read_text(encoding="utf-8"), entry,
                               '<script src="../../../native/meeting_dial.js"></script>' + entry), encoding="utf-8")
        asset = views / "js" / (name + ".js")
        source = asset.read_text(encoding="utf-8")
        args = '({calleeNum:a,isVideo:n,calleeInfo:' + info + '})'
        source = change(source, 'await ' + start + args + ',await Pedestal.callMethod("method://private_callRecord/hideCallRecordPage")',
                        'if(!await window.__welinkStartDial' + args + ')return;await Pedestal.callMethod("method://private_callRecord/hideCallRecordPage")')
        if name == "callRecord":
            args = '({calleeNum:i,isVideo:t,calleeInfo:a})'
            before = 'dh.info("[func onStartCall], before startCall")'
            after = 'dh.info("[func onStartCall], after startCall")'
            source = change(source, before + ',' + start + args + ',' + after,
                            before + ';if(!await window.__welinkStartDial' + args + ')return;' + after)
        asset.write_text(source, encoding="utf-8")
    return conference_source


def install_invitation_handoff(app, source):
    """Adapt the pinned campus entry points; admission and provider checks remain in the service."""
    def replace(old, new):
        nonlocal source
        require(source.count(old) == 1, f"Unexpected conference invitation facade: {old[:80]}")
        source = source.replace(old, new)

    page = app / "plugin/conference/dist/index.html"
    html = page.read_text(encoding="utf-8")
    bundle = '<script src="./js/bundle.js"></script>'
    require(html.count(bundle) == 1, "Unexpected conference renderer entry point")
    page.write_text(html.replace(bundle, '<script src="../../../native/meeting_invitation_uri.js"></script>' + bundle), encoding="utf-8")

    # The private lookup requests the operation, never submits its purported
    # result. Main owns the fixed-origin GET and issues from that exact response.
    resolve_invitation = (
        'async invite=>{'
        'const unavailable=()=>({failure:window.__welinkInvitation.failure("ISSUED_SITE_UNAVAILABLE")});'
        'try{const prepared=await Pedestal.callMethod("method://private_conference/hwm/prepareInvitationResolver");'
        'if(prepared?.ok!==true)return unavailable();'
        'const receipt=await window.require("electron").ipcRenderer.invoke("welink-native-meeting-v1",'
        '{kind:"resolve-invitation",confId:invite.confId,password:invite.password,'
        'expectedPrefix:invite.idPrefix,joinType:invite.joinType});'
        'if(receipt?.tag!=="welink-invitation-resolution-v1")return unavailable();'
        'if(receipt.ok!==true){const code=receipt.error?.code;'
        'return{failure:window.__welinkInvitation.failure('
        '["INVALID_MEETING_INVITATION","ISSUER_CONTEXT_UNAVAILABLE","ISSUER_REQUEST_UNAVAILABLE",'
        '"ISSUER_REQUEST_TIMEOUT","ISSUER_REDIRECT_UNAVAILABLE","ISSUER_CHANGED"].includes(code)?code:"ISSUED_SITE_UNAVAILABLE")}}'
        'if(!receipt.response||typeof receipt.response.result!=="boolean"||!receipt.response.recv_body||'
        'typeof receipt.response.recv_body!=="object"||Array.isArray(receipt.response.recv_body)||'
        'typeof receipt.requestURL!=="string")return unavailable();'
        'return{response:receipt.response,requestURL:receipt.requestURL};}catch(_){return unavailable();}}'
    )

    # Share the system and provider decoders.
    replace('const Ki=e=>{if(isNullOrEmpty(e))return Zi.info("url is empty"),!1;let t,n={},o=e.slice(e.indexOf("?")+1).split("&");for(var r=0;r<o.length;r++)t=o[r].split("="),n[t[0]]=isNullOrEmpty(t[1])?t[1]:t[1].replace(/[\\r\\n]/g,"");return n}',
            'const Ki=window.__welinkInvitation.parse,nativeResolveInvitation=' + resolve_invitation)
    replace('const as=e=>{if(isNullOrEmpty(e))return os.info("url is empty"),!1;let t,n=[],o=e.slice(e.indexOf("?")+1).split("&");for(var r=0;r<o.length;r++)t=o[r].split("="),n.push(t[0]),n[t[0]]=isNullOrEmpty(t[1])?t[1]:t[1].replace(/[\\r\\n]/g,"");return n}',
            'const as=Ki')

    # Decode the site without rebuilding the URI or inspecting query values as paths.
    replace('Zi.info("schemaProcess",t,n);let o={result:1},r=Ki(t);if(isNullOrEmpty(r))',
            'Zi.info("schemaProcess");let o=window.__welinkInvitation.failure(),r=Ki(t);if(!r)')
    replace('const a=(e=>{if(isNullOrEmpty(e))return Zi.info("[func getSiteValue] url is empty"),!1;let t="";const n=e.match(/site_url=([^&]+)/);return n&&(t=n[1]),t})(t);let i="";if(isBase64(a)&&(r.site_url=atob(a),i=(({schema:e,siteUrl:t})=>`${(null==e?void 0:e.split("?"))[0]}?site_url=${t}`)({schema:t,siteUrl:r.site_url}),Zi.info(`[func schemaProcess] decoding decodedSchema: ${i}, uriValues:`,r)),-1!==t.indexOf("/conference/joinconf")',
            'const route=t.split(/[?#]/,1)[0];if(route.endsWith("/conference/joinconf")')
    replace(',-1!==t.indexOf("/page/link"))',
            ',route.endsWith("/page/link"))')
    replace('confLink:i||t,willLogin:n',
            'confLink:t,willLogin:n')

    # Use parsed fields, not substrings elsewhere in the ticket, to choose an entry type.
    replace('if(Zi.info("[func joinConfByLink] joinConfByLink confLink",e,t),-1!==e.indexOf("meetingType=8"))return Zi.info("meetingType=8 goto xyconf"),-1!==e.indexOf("channelType=cdn")',
            'const o=Ki(e);if(!o)return window.__welinkInvitation.failure();if(o.meetingType==="8"&&window.__welinkInvitation.needsNativeVariant(o))return window.__welinkInvitation.failure("LINK_VARIANT_UNAVAILABLE");if(o.meetingType==="8")return Zi.info("meetingType=8 goto xyconf"),o.channelType==="cdn"')
    replace('const o=Ki(e);return"offline"===',
            'return"offline"===')

    # An inner public invitation is already decoded by the outer URI reader.
    replace('s=null==t?void 0:t.name,l=decodeURIComponent(o);if("string"!=typeof l||-1===l.indexOf("/#/j/"))return Zi.error("openJoinConfByLink originLink is error",l),{result:1};const[p,u=""]=l.split("/#/j/")[1].split("/");',
            's=t.name,invite=window.__welinkInvitation.publicLink(o,t);if(!invite)return window.__welinkInvitation.failure();')
    replace('let{meetingLink:o,open_mic:r,open_camera:a,conferenceID:i,joinType:c}=t',
            'let{meetingLink:o,open_mic:r,open_camera:a}=t')
    replace('Zi.info("openJoinConfByLink ",t);',
            'Zi.info("openJoinConfByLink");')
    replace('decodeURIComponent(s).substring(0,64)',
            's.substring(0,64)')
    replace('const b={url:`https://${await Pedestal.callMethod("method://pedestal/getMeetingLoginUrl")}/v1/mmc/management/conferences/authConf?conferenceID=${p}`,header:{"x-Password":u},body:{}};let d=await coreRsHttp.get({request:b,message:"openLinkEnterConf"});if(Zi.info("openJoinConfByLink",d),d&&d.result)',
            'const resolved=await nativeResolveInvitation(invite);if(resolved.failure)return resolved.failure;let d=resolved.response;if(Zi.info("openJoinConfByLink received"),d&&d.result)')
    replace('let o=t.siteUrl,l=t.random,u=t.idPrefix,b=isNullOrEmpty(s)?',
            'let b=isNullOrEmpty(s)?')
    replace('const z=i||p;let m=await e.joinConfByLink({confLink:`hwwelink://welinksoftclient/page/link?site_url=${o}&random=${l}&idPrefix=${u}&user_name=${b}&conferenceID=${z}&joinType=${c}`,willLogin:n});',
            'const issued=window.__welinkInvitation.issued(t,invite,b,resolved.requestURL);if(issued.failure)return issued.failure;let m=await e.joinConfByLink({confLink:window.__welinkInvitation.signed(issued.fields),willLogin:n});')

    # Do not let an ID-length heuristic drop a verified site, prefix or offline mode.
    replace('let t,n=as(e),o=n.user_name;',
            'let t,n=as(e);if(!n)return window.__welinkInvitation.failure();if(n.meetingType==="8"&&window.__welinkInvitation.needsNativeVariant(n))return window.__welinkInvitation.failure("LINK_VARIANT_UNAVAILABLE");let o=n.user_name;')
    replace('os.info("[func newJoinConfByLink] newJoinConfByLink the uriValues:",n);',
            'os.info("[func newJoinConfByLink] parsed invitation");')
    replace('8===n.meetingType||!isNullOrEmpty(r)&&(12===r.length||10===r.length)',
            'n.meetingType==="8"||!n.site_url&&!n.random&&!window.__welinkInvitation.needsNativeVariant(n)&&!isNullOrEmpty(r)&&(12===r.length||10===r.length)')
    replace('{random:n.random,site_url:n.site_url,nick_name:o,idPrefix:n.idPrefix,confId:(null==n?void 0:n.conferenceID)||"",isOfflineJoin:"offline"===(null==n?void 0:n.joinType)}',
            'window.__welinkInvitation.nativeParams(n,o)')
    replace('8!==e.meetingType&&isNullOrEmpty(e.confId)?',
            '8!==e.meetingType&&(isNullOrEmpty(e.confId)||e.site_url&&e.random)?')

    # The chat entry receives the same authConf result as the external URI entry.
    replace('const[n,o=""]=e.split("/#/j/")[1].split("/");if(12===n.length||10===n.length)return',
            'const invite=window.__welinkInvitation.publicLink(e);if(!invite)return window.__welinkInvitation.failure();const{confId:n,password:o}=invite;const r=window.$getState().meetingLoginUrl;if(window.__welinkInvitation.usesLegacyXY(invite,r))return')
    replace('-1!==e.indexOf("channelType=cdn")?void window.Toast({content:language.XY_JOIN_CONF_BY_LINK_FAILE}):void Wc({confId:n,random:o,meetingType:8})',
            'invite.channelType==="cdn"?void window.Toast({content:language.XY_JOIN_CONF_BY_LINK_FAILE}):Wc({confId:n,random:o,meetingType:8})')
    replace('const{meetingLoginUrl:r}=window.$getState(),a={url:`https://${r}/v1/mmc/management/conferences/authConf?conferenceID=${n}`,header:{"x-Password":o},body:{}};let i=await coreRsHttp.get({request:a,message:"openLinkEnterConf"});if(Mi.info("[func openLinkEnterConf] ret:",Object(On.a)(null==i?void 0:i.recv_body)),i&&i.result)',
            'const resolved=await nativeResolveInvitation(invite);if(resolved.failure)return resolved.failure;let i=resolved.response;if(Mi.info("[func openLinkEnterConf] received"),i&&i.result)')
    replace('const{siteUrl:t,random:n}=e,o=await fi();Wc({site_url:t,random:n,nick_name:o})',
            'const issued=window.__welinkInvitation.issued(e,invite,await fi(),resolved.requestURL);return issued.failure||Wc(window.__welinkInvitation.nativeParams(issued.fields))')

    # Neither the received ticket nor the public invitation password belongs in logs.
    replace('Lc.info("handleSchemaRequest param",Object(On.a)(e));',
            'Lc.info("handleSchemaRequest");')
    replace('Lc.info("[func newJoinConfByLinkWithObjParam] joinConfByLink params:",e)',
            'Lc.info("[func newJoinConfByLinkWithObjParam] joinConfByLink")')
    replace('Mi.info("[func openLinkEnterConf] join conf by link conf auth http request failed",i)',
            'Mi.info("[func openLinkEnterConf] join conf by link conf auth http request failed")')

    # Return the SDK failure rather than always reporting successful dispatch.
    replace('return Lc.info("handleSchemaRequest ret",t),{result:0}',
            'return t&&typeof t.result==="number"?t:window.__welinkInvitation.failure("JOIN_UNCONFIRMED")')
    return source


def install_render_notes(dist, service):
    """Keep request identity through the Linux facade and the pinned campus editor."""
    def change(text, before, after):
        require(text.count(before) == 1, f"Unexpected conference notes binding: {before[:72]}")
        return text.replace(before, after)

    facade = ('{key:"getRenderWindowInfo",value:async function({isSavePic:e}){return ne.info("getRenderWindowInfo in confApi"),'
              'await (window.require("os").platform()==="linux"?ae.initAuth():this.initConf()),await ae.getRenderWindowInfo({isSavePic:e})}}')
    service = change(service, facade, '{key:"getRenderWindowInfo",value:async function(e){'
                     'if(window.require("os").platform()==="linux")return ae.getRenderWindowInfo(typeof e==="boolean"?{isSavePic:e}:e);'
                     'await this.initConf();return ae.getRenderWindowInfo({isSavePic:e?.isSavePic})}}')
    service = change(service, '"method://private_conference/hwm/getRenderWindowInfoList":async({isSavePic:e})=>await g.default.getRenderWindowInfo({isSavePic:e})',
                     '"method://private_conference/hwm/getRenderWindowInfoList":e=>g.default.getRenderWindowInfo(e)')
    # Windows private 1050:7 is anonymous voiceprint denoising, not the public
    # macOS share-audio UI flag. Linux configures its named sound control itself.
    init = 'this.setEnableCapability({type:7,isEnable:!0})'
    service = change(service, init, 'window.require("os").platform()!=="linux"&&' + init)

    notes_file = dist / "js/listenAndNote.js"
    notes = notes_file.read_text(encoding="utf-8")
    handler = ',me=async e=>{var t;const{param:{filePath:n=""}}=e;'
    notes = change(notes, handler, ',nativeRenderNotes=window.require("os").platform()==="linux"?'
                   'Object.defineProperty(window,"__welinkRenderNotes",{value:window.require(window.require("path").resolve(window.__dirname,"../../../native/meeting_render_notes.js"))}).__welinkRenderNotes:null,'
                   'nativeNoteContext=()=>({conferenceId:c.getStore("conferenceID"),noteId:c.getStore("noteId")})' + handler)
    notes = change(notes, 'ge.info("[func handlePicPath] payload = ",e),me(e)',
                   'return nativeRenderNotes?nativeRenderNotes.receive(e):me(e)')
    button = ('let{hasShare:e}=n.props;e?window.Toast({content:language.GET_IMG_TIPS}):'
              'Pedestal.callMethod("method://private_conference/hwm/getRenderWindowInfoList",{isSavePic:!0})')
    notes = change(notes, button, 'let{hasShare:e}=n.props;if(e)return window.Toast({content:language.GET_IMG_TIPS});'
                   'return nativeRenderNotes?nativeRenderNotes.request({Pedestal,getContext:nativeNoteContext,insert:me,'
                   'notify:({message})=>window.Toast({content:message})}):'
                   'Pedestal.callMethod("method://private_conference/hwm/getRenderWindowInfoList",{isSavePic:!0})')
    upload = 'await Object(h.a)({filePath:n,noteId:r});'
    notes = change(notes, upload, upload + 'if(window.__welinkRenderNotes&&!window.__welinkRenderNotes.current(e,{conferenceId:c.getStore("conferenceID"),noteId:c.getStore("noteId")}))'
                   'throw Object.assign(Error("会议或笔记已切换，未插入截图"),{code:"NOTE_CONTEXT_CHANGED"});'
                   'if(!a)throw Object.assign(Error("上传未返回截图地址"),{code:"NOTE_UPLOAD_UNCONFIRMED"});')
    # HTMLCollection has no forEach. Use the actual editor document, not the
    # outer frame, and do not throw after a successful insertion on a cache hit.
    lookup = ('let d,m=document.getElementsByTagName("img");try{m.forEach(e=>{if(e.src===a)throw d=e,new Error("LoopInterrupt")})}'
              'catch(e){if("LoopInterrupt"!==e.message)throw e}ue.info("[func _getConfImg], imgDom: ",d),d.onload=function(){'
              'Object(_.d)("screenshot"),u&&Object(_.g)()}')
    notes = change(notes, lookup, 'const root=u?document:(l.getDoc?.()||document),imgs=root.getElementsByTagName("img");'
                   'let d;for(let k=imgs.length-1;k>=0;k--){if(imgs[k].src===a){d=imgs[k];break}}'
                   'const loaded=()=>{if(c.getStore("noteId")===r){Object(_.d)("screenshot");if(u)Object(_.g)()}};'
                   'if(d&&!d.complete)d.addEventListener("load",loaded,{once:true});else loaded()')
    notes_file.write_text(notes, encoding="utf-8")
    return service


def install_contact_lookup(common):
    """Honor the vendor directory's unresolved slots without inventing identities.

    Contact module 99202 dealContactList maps requested keys to canonical records
    or {}; 35046 getContactByNewWorkId also returns {} for unresolved work IDs.
    Neither array length nor position proves identity. The provider can also
    turn caught failures into empty results, so these are *unresolved*, never
    authoritative not-found records. Its existing error paths remain intact.
    Nonempty records without a string account are malformed, not placeholders.
    Actual IPC rejections and invalid response containers must still reject.
    """
    def change(before, after):
        nonlocal common
        require(common.count(before) == 1, f"Unexpected contact lookup anchor: {before[:100]}")
        common = common.replace(before, after)

    # The enrichment adapter must not throw on one malformed row before the
    # consumer can retain valid siblings and report the malformed-row count.
    change('if(!window.isRedblue&&l.length>0){const e=(0,s.default)(l).call(l,(e=>"2"===e.isExternal));',
           'if(!Array.isArray(l))throw new TypeError("Invalid contact account-list response");'
           'if(!window.isRedblue&&l.length>0){const e=(0,s.default)(l).call(l,'
           '(e=>e&&typeof e.account==="string"&&e.account&&"2"===e.isExternal));')
    change('S=(0,r.default)(l).call(l,(t=>t.account===e.account));',
           'S=(0,r.default)(l).call(l,(t=>t&&t.account===e.account));')
    change('const e=u(t,50);(0,i.default)(e).call(e,(e=>{a(e)}))',
           'await Promise.all(u(t,50).map(e=>a(e)))')
    change('return await window.Pedestal.callMethod("method://contact/getContactByNewWorkId",'
           '{list:t,uuid:(0,r.default)().toString(),entry:a})||[]',
           'const result=await window.Pedestal.callMethod("method://contact/getContactByNewWorkId",'
           '{list:t,uuid:(0,r.default)().toString(),entry:a});'
           'if(!Array.isArray(result))throw new TypeError("Invalid contact work-ID response");return result')
    start, end = '93444:(e,t,a)=>{', ',43370:(e,t,a)=>{'
    require(common.count(start) == 1 and common.count(end) == 1, "Unexpected IM contact consumer module")
    begin, finish = common.index(start), common.index(end)
    require(begin < finish, "Unexpected IM contact consumer module order")
    consumer = r'''93444:(e,t,a)=>{
"use strict";
a(53930)(t,"__esModule",{value:!0});
const state=a(83691),directory=a(43875),workDirectory=a(78205),status=a(40754),
      constants=a(54589),batch=a(86647),robot=a(5722);
const log=window.getLogger("Utils")("userDetailCache");
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const hasAccount=row=>row&&typeof row==="object"&&!Array.isArray(row)&&
    own(row,"account")&&typeof row.account==="string"&&row.account.trim().length>0;
// These are the provider/reducer's work-ID rules, not substitute identities.
const workKey=id=>id.slice(id.includes("_")?id.indexOf("_")+1:1).toLowerCase();
const alias=row=>window.isRedblue&&typeof row.workId==="string"&&row.workId&&
    !row.account.includes(row.workId)&&!row.account.includes("@")?row.account.charAt(0)+row.workId:"";
t.default=new class{
    constructor(){this.pending=null}
    async saveStore(value){state.globalDispatch({type:"SET_USER_MAP",payload:value})}
    async getUserInfoByContact({userIds,isSaveStore=true,isRetryWordId=false,tenantid}){
        const started=Date.now();
        if(!window.isRedblue)tenantid=tenantid||state.$imState().loginConfig.tenantid;
        const stale=()=>!window.isRedblue&&tenantid!==state.$imState().loginConfig.tenantid;
        const primary=await directory.getContactListByAccountList({list:userIds});
        if(stale()){log.info("getUserInfoByContact tenantid change");return[]}
        const remaining=new Set(userIds),rows=[],cache=Object.create(null);
        let invalidCount=0,placeholderCount=0;
        const consume=(response,retry)=>{
            if(!Array.isArray(response))throw new TypeError("Invalid contact lookup response");
            response.forEach(row=>{
                if(row&&Object.prototype.toString.call(row)==="[object Object]"&&
                   Object.keys(row).length===0){++placeholderCount;return}
                if(!hasAccount(row)){++invalidCount;return}
                const contact={...row};
                delete contact.nick_name;
                rows.push(contact);
                cache[contact.account]={...contact,englishName:contact.personNameEn||contact.foreign_name,
                    shouldGetUserMap:false};
                remaining.delete(contact.account);
                const key=alias(contact);
                if(key)remaining.delete(key);
                if(retry&&typeof contact.workId==="string"&&contact.workId){
                    const workId=contact.workId.toLowerCase();
                    for(const id of remaining)if(workKey(id)===workId)remaining.delete(id);
                }
                if(robot.isRobotUser(contact)){
                    log.info("updateUserStatus BOT");
                    status.updateUserStatus({userAccount:contact.account,newState:constants.USERSTATE.ONLINE,
                        newStateDesc:"",clientType:0,localTime:100});
                }
            });
        };
        try{
            consume(primary,false);
            // Omitted rows and an empty primary batch must be retryable too.
            if(isRetryWordId&&remaining.size){
                const retry=await workDirectory.getContactListByAccountOrW3accountList({list:Array.from(remaining)});
                if(!stale())consume(retry,true);
            }
        }finally{
            // Do not lose valid primary records when the retry itself rejects.
            // No empty/invalid record is cached, and tenant changes cannot write.
            if(invalidCount)log.error("getUserInfoByContact malformed records",{invalidCount});
            if(isSaveStore&&!stale()&&rows.length)await this.saveStore(cache);
        }
        if(stale()){log.info("getUserInfoByContact tenantid change");return[]}
        log.info("getUserInfoByContact outcomes",{requestedCount:userIds.length,returnedCount:primary.length,
            resolvedCount:rows.length,unresolvedCount:remaining.size,placeholderCount,invalidCount,
            duration:Date.now()-started});
        return rows;
    }
    getUsersDetail({userIds,shouldReturn=false,isSaveStore=true,isRetryWordId=false,tenantid}){
        if(!window.isRedblue)tenantid=tenantid||state.$imState().loginConfig.tenantid;
        if(userIds.length<100)return this.proxy(userIds,shouldReturn,isSaveStore,isRetryWordId,tenantid);
        if(this.pending){
            const next=()=>this.getUsersDetail({userIds,shouldReturn,isSaveStore,isRetryWordId,tenantid});
            return this.pending.then(next,next);
        }
        // The old resolve-only Promise wrapper hung forever after rejection.
        this.pending=this.proxy(userIds,shouldReturn,isSaveStore,isRetryWordId,tenantid)
            .finally(()=>{this.pending=null});
        return this.pending;
    }
    async proxy(userIds,shouldReturn=false,isSaveStore=true,isRetryWordId=false,tenantid=""){
        if(!userIds.length)return[];
        const {userMap,w3accountMap}=state.$imState().user,pending=new Set();
        for(const id of userIds){
            const account=w3accountMap[id]??id;
            if(account&&account!=="system"&&!userMap[account]?.account)pending.add(account);
        }
        if(!pending.size)return shouldReturn?userIds.map(id=>userMap[id]||userMap[w3accountMap[id]]):[];
        log.info("get userDetail start length=",pending.size);
        const started=Date.now(),resolved=new Map();
        for(const list of batch.splitByNum(Array.from(pending),500)){
            const rows=await this.getUserInfoByContact({userIds:list,isSaveStore,isRetryWordId,tenantid});
            if(shouldReturn)for(const row of rows)resolved.set(row.account,row);
        }
        log.info("get userDetail end request length=",userIds.length,"duration=",Date.now()-started);
        if(!shouldReturn)return[];
        // Resolve response-owned aliases locally even when cache writes are off.
        // Ambiguous aliases cannot choose an arbitrary canonical identity.
        const aliases=new Map(),workIds=new Map();
        const remember=(map,key,row)=>{
            if(!key)return;
            const previous=map.get(key);
            map.set(key,map.has(key)&&previous?.account!==row.account?null:row);
        };
        const canonical=new Map();
        for(const row of Object.values(state.$imState().user.userMap))
            if(hasAccount(row))canonical.set(row.account,row);
        for(const [account,row] of resolved)canonical.set(account,row);
        for(const row of canonical.values()){
            remember(aliases,alias(row),row);
            if(isRetryWordId&&typeof row.workId==="string"&&row.workId)
                remember(workIds,row.workId.toLowerCase(),row);
        }
        const currentAliases=state.$imState().user.w3accountMap,result=[];
        for(const id of userIds){
            const account=canonical.has(id)||aliases.get(id)===null?id:currentAliases[id]??id;
            const row=canonical.get(account)||aliases.get(account)||
                (isRetryWordId&&workIds.get(workKey(account)))||userMap[account];
            if(row)result.push(row);
        }
        return result;
    }
}}
'''
    return common[:begin] + consumer.rstrip() + common[finish:]


def install_contact_alias_cache(source):
    """Let the existing user reducer publish only unambiguous work-ID aliases."""
    start, end = 'case"SET_USER_MAP":{', 'case"UPSET_USERINFO":'
    require(source.count(start) == 1 and source.count(end) == 1, "Unexpected IM contact alias reducer")
    begin, finish = source.index(start), source.index(end)
    require(begin < finish, "Unexpected IM contact alias reducer order")
    # Reconcile affected aliases after all canonical records have been merged.
    # The full cache participates, so a later single-row update cannot resurrect
    # a collision between two previously cached accounts. Explicit alias actions
    # and unrelated reducer cases retain their existing authority and behavior.
    replacement = r'''case"SET_USER_MAP":{
    const users=e.userMap,aliases=e.w3accountMap,updates=a.payload,affected=new Set();
    const workAlias=row=>window.isRedblue&&row&&typeof row.account==="string"&&row.account&&
        typeof row.workId==="string"&&row.workId&&!row.account.includes(row.workId)&&
        !row.account.includes("@")?row.account.charAt(0)+row.workId:"";
    if(!isNullOrEmpty(updates))for(const key in updates)
        if(Object.prototype.hasOwnProperty.call(updates,key)){
            const previous=workAlias(users[key]);
            if(previous)affected.add(previous);
            let value=updates[key];
            if(key===window.$uuid)value=(0,i.deepClone)(value);
            if(users[key])Object.assign(users[key],value);else users[key]=value;
            const current=workAlias(users[key]);
            if(current)affected.add(current);
        }
    if(affected.size){
        const owners=new Map();
        for(const key in users)if(Object.prototype.hasOwnProperty.call(users,key)){
            const row=users[key],workId=workAlias(row);
            if(workId&&affected.has(workId))
                owners.set(workId,!owners.has(workId)||owners.get(workId)===row.account?row.account:null);
        }
        for(const workId of affected){
            const owner=owners.get(workId);
            if(owner&&!users[workId]?.account)aliases[workId]=owner;
            else delete aliases[workId];
        }
    }
    break;
}'''
    return source[:begin] + replacement + source[finish:]


def install_renderer_data(app):
    """Keep real Redux snapshots, server cursors, and avatar outcomes distinct."""
    def change(source, before, after):
        require(source.count(before) == 1, f"Unexpected renderer data anchor: {before[:100]}")
        return source.replace(before, after)

    # imStore is a subscribed snapshot: reducers read it while getState() is forbidden.
    # HwUI creates window.store before initIM; loadIM can run much later on Linux.
    init_store = ('t.initImStore=()=>{a.imStore.state=(0,a.$imState)(),'
                  '(0,a.getReduxStore)().subscribe((()=>{a.imStore.state=(0,a.$imState)()}))}')
    bind_store = ('let o,s;t.initImStore=()=>{const t=(0,a.getReduxStore)();'
                  'a.imStore.state=(0,a.$imState)();if(o!==t){s&&s();'
                  's=t.subscribe((()=>{a.imStore.state=(0,a.$imState)()}));o=t}}')
    old_emoji = (
        'c.length){await j.default.getDB().addCustomEmojiList(c),await '
        'j.default.getDB().addUserKeyValue({key:y.CUSTOM_EMOJI_TIMESTAMP,value:s.toString()});'
        'const e=ae({categoryId:k.CUSTOM_EMOJI_TYPE,appendEmojis:c});'
        'Q.default.getApi().syncAllGlobalDispatch({type:"REPLACE_EMOJI_MAP",payload:{'
        'categoryId:k.CUSTOM_EMOJI_TYPE,list:e}})}else Q.default.getApi().syncAllGlobalDispatch('
        '{type:"REPLACE_EMOJI_MAP",payload:{categoryId:k.CUSTOM_EMOJI_TYPE,list:[]}}),'
        'Z.error("syncCustomEmojis error",i);await j.default.getDB().addUserKeyValue('
        '{key:y.CUSTOM_EMOJI_TIMESTAMP,value:s.toString()});'
        'const d=c.length||u.length?ae({categoryId:k.CUSTOM_EMOJI_TYPE,appendEmojis:c,deleteEmojiIds:u}):[];'
    )
    new_emoji = (
        'c.length)await j.default.getDB().addCustomEmojiList(c);'
        'await j.default.getDB().addUserKeyValue({key:y.CUSTOM_EMOJI_TIMESTAMP,value:s.toString()});'
        'const d=0===Number(n)?c:ae({categoryId:k.CUSTOM_EMOJI_TYPE,appendEmojis:c,deleteEmojiIds:u});'
    )
    for directory in ("pedestal/im/static/js", "plugin/im/dist/im/static/js"):
        common_file = app / directory / "common.js"
        common = common_file.read_text(encoding="utf-8")
        require(common.count('t.imStore={state:{}};') == 1, "IM must retain its real subscribed snapshot")
        common = install_contact_lookup(common)
        # A resolved native request is only a receipt, not proof of a copied
        # file. Keep the fs-extra error as the cause and the native receipt for
        # diagnosis; screenshot preparation must not publish a missing target.
        common = change(common,
            's.error(a,"reTry copy"),await i.default.getNativetools().copyFileByStream({src:e,dest:t})',
            's.error(a,"reTry copy");'
            'const n=await i.default.getNativetools().copyFileByStream({src:e,dest:t});'
            'if(!n||"object"!==typeof n||Array.isArray(n)||0!==n.result){'
            'const e=new Error("copyFileByStream failed: "+'
            '(n&&void 0!==n.result?"result="+n.result:"missing or invalid native receipt")+'
            '"; fs-extra copy: "+a.message);e.cause=a;e.nativeResponse=n;throw e}')
        # Clean EOF is explicit and carries no file_stream. Empty/directory-only
        # ZIPs must finish without parsing a nonexistent message, while damaged
        # archive replies still take the existing failure/close path first.
        common = change(common,
            'const{total_num:a,cur_num:n,file_stream:i}=e.param;'
            'L.info(`saveZipData decompress total_num:${a}, cur_num:${n}`)',
            'if(!0===e.param.end_of_archive){P&&(await P,P=null);'
            'V({payload:{progress:100}});'
            'return void(0,o.default)(Z,1e3*k.doneTime,{filePath:t})}'
            'const{total_num:a,cur_num:n,file_stream:i}=e.param;'
            'L.info(`saveZipData decompress total_num:${a}, cur_num:${n}`)')
        common = change(common,
            'catch(e){P=null,await q({filePath:t}),L.error("saveZipData error:",e)}',
            'catch(e){P=null;await q({filePath:t});L.error("saveZipData error:",e);return}')
        common = change(common,
            'return L.error("saveZipData decompress openZipFile zip failed"),void q({filePath:t})',
            'return L.error("saveZipData decompress openZipFile zip failed"),void await q({filePath:t})')
        reducer_file = app / directory / "1511.js"
        reducer_file.write_text(install_contact_alias_cache(reducer_file.read_text(encoding="utf-8")),
                                encoding="utf-8")
        # The suit-ui avatar index is a cache: a first lookup normally misses.
        # Use Node's nonthrowing missing-entry result; keep genuine I/O errors
        # on the existing error path and preserve the contact download queue.
        common = change(common, 's=e=>e&&i().statSync(e)||{}',
                        's=(e,t)=>e?i().statSync(e,t):{}')
        common = change(common, 'try{const{mtimeMs:e=0}=(0,Ti.q5)(t);a=e}',
                        'try{const n=(0,Ti.q5)(t,{throwIfNoEntry:!1});'
                        'if(n)a=n.mtimeMs;else{Oi[e]=1;t=""}}')
        common = change(common, 'd&&await Jt(d);',
                        'd&&"0"!==d?await Jt(d):await(0,$e.initSessionGroup)();')
        common = change(common,
                        'return U.error(`getCustomGroupingConversationsByPage error list: ${n.join(",")}`),',
                        'return n.length&&U.error(`getCustomGroupingConversationsByPage error list: ${n.join(",")}`),')
        common = change(common,
                        'pt.error(`loadRecentSessionGroupChange error list: ${e.join(",")}`),',
                        'e.length&&pt.error(`loadRecentSessionGroupChange error list: ${e.join(",")}`),')
        # No relation body is not an authoritative empty full snapshot. Keep the
        # cached list and cursor until the server supplies an explicit array.
        common = change(common,
            'const{changeRelation:o=[],lastSyncTime:s=n}=i.data||{},l=0===Number(n)?o:J(r,o,"emojiId"),c=[],u=[];',
            'if(null==i.data||!Object.prototype.hasOwnProperty.call(i.data,"changeRelation"))'
            'return void Q.default.getApi().syncAllGlobalDispatch({type:"REPLACE_EMOJI_MAP",payload:{'
            'categoryId:k.CUSTOM_EMOJI_TYPE,list:ae({categoryId:k.CUSTOM_EMOJI_TYPE,appendEmojis:r})}});'
            'if(!Array.isArray(i.data.changeRelation))return Z.error("syncCustomEmojis invalid changeRelation"),'
            'void Q.default.getApi().syncAllGlobalDispatch({type:"REPLACE_EMOJI_MAP",payload:{'
            'categoryId:k.CUSTOM_EMOJI_TYPE,list:ae({categoryId:k.CUSTOM_EMOJI_TYPE,appendEmojis:r})}});'
            'const{changeRelation:o,lastSyncTime:s=n}=i.data,l=0===Number(n)?o:J(r,o,"emojiId"),c=[],u=[];')
        # Guard IM login timeout timer: cancel prior timer and do not arm when
        # IM is already online (vendor native SDK does not re-emit LoginStatusNotify).
        common = change(common,
            'let d;t.tcppingImLoginTiming=()=>{d=(0,r.default)((()=>{s.info("im login timeout 15s"),u()}),15e3)};'
            't.clearPspingImLoginTiming=()=>{d&&clearTimeout(d)}',
            'let d;t.tcppingImLoginTiming=()=>{var e;if(d&&(clearTimeout(d),d=void 0),'
            'null===(e=(0,i.$imState)().global)||void 0===e||!e.isOnline)'
            'd=(0,r.default)((()=>{d=void 0,s.info("im login timeout 15s"),u()}),15e3)};'
            't.clearPspingImLoginTiming=()=>{d&&(clearTimeout(d),d=void 0)}')
        # Serialize loginStateChange (Ve) across async DB init and skip DB/token/UM
        # re-init when login_status !== LoginSuccess so logout never re-opens SQLite
        # or fires stale getCloudDiskToken / umServerReLogin requests.
        common = change(common, 'let Fe=null;', 'let Fe=null,_veSeq=0;')
        common = change(common, 'async function Ve(e){if(!e)return;',
                        'async function Ve(e){if(!e)return;const _seq=++_veSeq;')
        common = change(common, '}if(ke.info(`loginStateChange $imState()',
                        '}ke.info(`loginStateChange $imState()')
        common = change(common,
            ',await he.default.getDB().initSQLitePrivateDB({account:e.uuid,info:"imDBInit"}),'
            'Be(e.middle_ground_token),He(e.middle_ground_onebox_cookie),'
            'window.dispatchEvent(new Event("umServerNotLogin")),(0,A.blueImLogin)(e),t!==e.login_status)',
            ';if(e.login_status===G.AccessStatus.LoginSuccess){'
            'await he.default.getDB().initSQLitePrivateDB({account:e.uuid,info:"imDBInit"});'
            'if(_seq!==_veSeq)return;'
            'Be(e.middle_ground_token);He(e.middle_ground_onebox_cookie)}'
            'window.dispatchEvent(new Event("umServerNotLogin"));(0,A.blueImLogin)(e);if(t!==e.login_status)')
        common_file.write_text(change(common, old_emoji, new_emoji), encoding="utf-8")
        init_file = app / directory / "7326.js"
        init_file.write_text(change(init_file.read_text(encoding="utf-8"), init_store, bind_store), encoding="utf-8")
        entry_file = app / directory / "im.js"
        entry = change(entry_file.read_text(encoding="utf-8"),
                       'initIM:async()=>{const ready=(0,r.default)();',
                       'initIM:async()=>{if(window.require("os").platform()==="linux")(0,s.initImStore)();'
                       'const ready=(0,r.default)();')
        # loadRecentChange now owns both full bootstrap and incremental sync, awaited.
        entry = change(entry,
                       'const{value:I}=await F.default.getDB().queryUserKeyValue({key:W.SESSION_GROUP_SYNC_TIME});'
                       'I||(0,$.initSessionGroup)(),', '')
        entry_file.write_text(entry, encoding="utf-8")

    for relative in ("pedestal/contact/js/contact.js", "plugin/contact/dist/contact/js/contact.js"):
        contact_file = app / relative
        contact = contact_file.read_text(encoding="utf-8")
        # Only the producer can distinguish an intentional skip from a bad response.
        contact = change(contact,
            'return logger.info("searchAvatar-1.2",handleAccountPrint(account),apiEntry,uuid,avatarServerUrl),'
            '_context.abrupt("return");',
            'return logger.info("searchAvatar-1.2",handleAccountPrint(account),apiEntry,uuid,avatarServerUrl),'
            '_context.abrupt("return",{account,avatarRequestSkipped:"no-url"});')
        contact = change(contact,
            'void resolve({accont:handleAccountPrint(account)});var tempPath=',
            'void resolve({account,avatarRequestSkipped:"cached"});var tempPath=')
        contact = change(contact, 'new Promise((function(resolve){var downAvatarTimeout=',
                         'new Promise((function(resolve,reject){var downAvatarTimeout=')
        contact = change(contact,
            'contactAppService.getNodeFs().stat(newestFullNameMain,(function(err,stats){',
            'contactAppService.getNodeFs().stat(newestFullNameMain,(function(err,stats){'
            'if(err&&"ENOENT"!==err.code){clearTimeout(downAvatarTimeout);reject(err);return}')
        contact = change(contact,
            'resultCallback:function(data){return resolve(data)},avatarUrl:avatarServerUrl,',
            'resultCallback:function(data){clearTimeout(downAvatarTimeout);return resolve(data)},'
            'avatarUrl:avatarServerUrl,')
        contact = change(contact,
            'clearTimeout(downAvatarTimeout),fail&&resolve({accont:handleAccountPrint(account)})}))',
            'fail&&(clearTimeout(downAvatarTimeout),resolve({account,param:{ret:result}}))}),'
            'function(error){clearTimeout(downAvatarTimeout);reject(error)})')
        # The old Promise wrapper discarded IPC rejections and did not await file work.
        contact = change(contact,
            'new Promise((function(resolve){(0,_pluginCommunication_plugMethods__WEBPACK_IMPORTED_MODULE_0__.u8)(param)'
            '.then((function(res){logger.debug("conductDownloadAvatar end download account=".concat(param.account,", res="),res),'
            'dealDownloadAsAvatarResult(res),resolve(res||{})}))}))',
            '(0,_pluginCommunication_plugMethods__WEBPACK_IMPORTED_MODULE_0__.u8)(param)'
            '.then(async function(res){logger.debug("conductDownloadAvatar end download account=".concat(param.account,", res="),res);'
            'await dealDownloadAsAvatarResult(res);return res||{}})')
        contact = change(contact,
            'uuid)),resolve()}),35e3);contactAppService.getNodeFs().stat(',
            'uuid)),reject(Object.assign(new Error("Avatar request timed out"),{code:"ETIMEDOUT"}))}),35e3);'
            'contactAppService.getNodeFs().stat(')
        contact = change(contact,
            'new Promise((function(resolve){logger.info("downloadAsAvatar_step3, begin to ",',
            'new Promise((function(resolve,reject){logger.info("downloadAsAvatar_step3, begin to ",')
        contact = change(contact,
            'var timer=setTimeout((function(){return resolve(!0)}),15e3);contactDownAvatar(',
            'var timer=setTimeout((function(){reject(Object.assign(new Error("Avatar download timed out"),'
            '{code:"ETIMEDOUT"}))}),15e3);contactDownAvatar(')
        contact = change(contact,
            'setTimeout((function(){resolve(!0)}),100)}))}))}function dealDownloadAsAvatarResult(',
            'setTimeout((function(){resolve(!0)}),100)}),function(error){clearTimeout(timer);reject(error)})'
            '}))}function dealDownloadAsAvatarResult(')
        contact = change(contact,
            'notAvatarList.push(account))})):inDownloadedAvatarMap.delete(account)',
            'notAvatarList.push(account))}),function(error){inDownloadedAvatarMap.delete(account);'
            'logger.error("conductDownloadAvatar",error)}):inDownloadedAvatarMap.delete(account)')
        start = 'function _dealDownloadAsAvatarResult(){'
        end = 'function avatarDownFailed(data,requestId,currAccount){'
        require(contact.count(start) == 1 and contact.count(end) == 1, "Unexpected avatar response handler")
        begin, finish = contact.index(start), contact.index(end)
        contact = contact[:begin] + '''async function _dealDownloadAsAvatarResult(data){
    if(data&&!data.param&&("no-url"===data.avatarRequestSkipped||"cached"===data.avatarRequestSkipped))return;
    try{
        if(!data||!data.param||0!==data.param.ret||!data.param.rsp_body){
            logger.error("dealDownloadAsAvatarResult,request data is error",data);
            return;
        }
        const body=data.param.rsp_body,headerBody=body.header;
        headerBody.forEach(function(header){header.name=header.name.toLowerCase()});
        const requestId=(headerBody.query({name:"x-request-id"})||{value:""}).value;
        const currAccount=(headerBody.query({name:"id"})||{value:""}).value||data.account;
        // 304/404 responses contain no downloaded file. Never checksum their temp path.
        if(body.rsp_code!==contactConstant.AS_AVATAR_RESP_CODE.SUCCESS){
            avatarDownFailed(data,requestId,currAccount);
            return;
        }
        const selfAccount=window.contactState().myInfo.account;
        const avatarPathTemp=await contactAppService.getTempAvatarPath(selfAccount);
        const avatarFileName=currAccount+"_timestamp_0.png";
        const imgPathTemp=getAvatarRealPath(avatarPathTemp,avatarFileName);
        const tag=headerBody.query({name:"etag"});
        let isImgFull=window.isRedblue;
        if(tag){
            const serverTag=tag.value.replaceAll('"',"");
            const checksum=await getImgCheckSum(imgPathTemp);
            isImgFull=checksum===serverTag;
            logger.debug(handleAccountPrint(currAccount)+" isImgFull "+isImgFull+", checksum is "+checksum+", serverTag="+serverTag);
            if(!isImgFull){
                if(fs.existsSync(imgPathTemp))fs.unlinkSync(imgPathTemp);
                logger.error("dealDownloadAsAvatarResult checksum mismatch",handleAccountPrint(currAccount));
            }
        }
        if(!isImgFull)return null;
        const avatarPathMain=await contactAppService.getAvatarPath(selfAccount);
        await contactAppService.copyFile(imgPathTemp,getAvatarRealPath(avatarPathMain,avatarFileName),!0);
        if(await contactAppService.isFileExist(getAvatarRealPath(avatarPathMain,avatarFileName))){
            updateAvatarMap(_defineProperty({},currAccount,getAvatarRealPath(avatarPathMain,avatarFileName,"?temp="+Date.now())),!0);
            await checkSamePersonAvatarExcept(avatarPathMain,currAccount,avatarFileName);
        }
        return null;
    }catch(error){logger.error("dealDownloadAsAvatarResult",error)}
}''' + contact[finish:]
        # A missing cached file is a cache miss; permission/I/O errors are not.
        start = 'checkLocalAvatarPath=function(){'
        end = 'function getCloudAvatarSrc(userMap,account){'
        require(contact.count(start) == 1 and contact.count(end) == 1, "Unexpected local avatar lookup")
        begin, finish = contact.index(start), contact.index(end)
        contact = contact[:begin] + '''checkLocalAvatarPath=async function(account){
    const state=contactState(),selfAccount=state&&state.login&&state.login.account||"";
    const avatarPathMain=await contactAppService.getAvatarPath(selfAccount);
    const file=avatarPathMain+account+"_timestamp_0.png";
    try{
        const info=await fs.promises.stat(file);
        return info.isFile()?file:"";
    }catch(error){
        if(error.code==="ENOENT")return "";
        throw error;
    }
};''' + contact[finish:]
        contact_file.write_text(contact, encoding="utf-8")


def install_renderer_repairs(app):
    """Repair consumer behavior in the pinned bundles, not their API results."""
    def patch(relative, changes):
        filename = app / relative
        source = filename.read_text(encoding="utf-8")
        for before, after in changes:
            require(source.count(before) == 1, f"Unexpected renderer anchor in {relative}: {before[:100]}")
            source = source.replace(before, after)
        filename.write_text(source, encoding="utf-8")

    for directory in ("pedestal/im/static/js", "plugin/im/dist/im/static/js"):
        patch(f"{directory}/common.js", [
            ('const{rcId:a,rcType:n}=e,r=(0,W.default)(n)?',
             'const{rcId:a,rcType:n}=e;if(n!==0&&n!==1)return{rcId:a,isSyncEmojiReply:!1};'
             'const r=(0,W.default)(n)?'),
            ('const o=(0,R.getBoxRcIdByGroupId)((0,g.$imState)().officialAccount.detailMap[e.serviceNodeId].groupId);'
             '"1"!==a.isVip&&x(o,e.messageId),(0,g.globalDispatch)({type:"DELETE_BOX_MESSAGE_BY_MSGID",payload:{boxRcId:o,msgId:e.messageId}})',
             'const detail=(0,g.$imState)().officialAccount.detailMap[e.serviceNodeId],'
             'o=detail?(0,R.getBoxRcIdByGroupId)(detail.groupId):null;'
             'o&&"1"!==(a?.isVip??detail?.isVip)&&x(o,e.messageId),'
             'o&&(0,g.globalDispatch)({type:"DELETE_BOX_MESSAGE_BY_MSGID",payload:{boxRcId:o,msgId:e.messageId}})'),
            ('const t=(0,g.$imState)().officialAccount.boxRcIdMap[e];let a=0;for(let e=0;e<t.length;e++)'
             'a+=(0,u.default)((0,g.$imState)().session)[t[e]].unReadCount||0;',
             'const t=(0,g.$imState)().officialAccount.boxRcIdMap[e]||[];let a=0;for(let e=0;e<t.length;e++)'
             'a+=(0,u.default)((0,g.$imState)().session)[t[e]]?.unReadCount||0;'),
        ])
        patch(f"{directory}/6337.js", [
            ('if((0,i.isMac)())return void(0,o.openMessageLink)(e);',
             'if("linux"===process.platform||(0,i.isMac)())return void(0,o.openMessageLink)(e);'),
        ])
    patch("plugin/im/dist/im/static/js/MessagePositionCardComp.chunk.js", [
        ('if((0,u.isMac)())return void(0,n.openMessageLink)(e);',
         'if("linux"===process.platform||(0,u.isMac)())return void(0,n.openMessageLink)(e);'),
    ])
    # The preview's non-Mac branch already decodes the on-disk path and builds
    # WeLink's HTML metadata. Linux additionally needs the real clipboard image.
    patch("plugin/previewPicture/dist/js/bundle.js", [
        ('external_electron_namespaceObject.clipboard.write({html:_html}),Pedestal.copyImageToClipBoard(src)',
         '"linux"===process.platform?'
         '(info=external_electron_namespaceObject.nativeImage.createFromPath(src),'
         'info.isEmpty()?(()=>{throw new Error("Cannot decode clipboard image")})():'
         'external_electron_namespaceObject.clipboard.write({html:_html,image:info})):'
         '(external_electron_namespaceObject.clipboard.write({html:_html}),Pedestal.copyImageToClipBoard(src))'),
    ])

    # All copies come from the same suit-ui helper. Match its full expression
    # (including variable relationships), so unrelated platform guards stay put.
    theme = re.compile(
        r'"win32"===process\.platform,([a-zA-Z_$][\w$]*)=([a-zA-Z_$][\w$]*)\?"\.suit-head-win":"\.suit-head-mac",'
        r'([a-zA-Z_$][\w$]*)=document\.querySelector\(\1\),([a-zA-Z_$][\w$]*)=\2\?'
        r'(?:null==\3\?void 0:|null===\3\|\|void 0===\3\?void 0:)\3\.children\[0\]:'
        r'(?:null==\3\?void 0:|null===\3\|\|void 0===\3\?void 0:)\3\.children\[1\],'
        r'([a-zA-Z_$][\w$]*)=\((?:null==\4\?void 0:|null===\4\|\|void 0===\4\?void 0:)\4\.children\[0\]\)'
        r'\?\4\.children\[0\]:\4;([a-zA-Z_$][\w$]*)&&\(\5\.style\.color="#fff"\)')
    count = 0
    for filename in sorted(app.rglob("*.js")):
        if "node_modules" in filename.parts:
            continue
        source = filename.read_text(encoding="utf-8")
        def replace_theme(match):
            text = match[0].replace('"win32"===process.platform', '"darwin"!==process.platform', 1)
            return text.replace(f';{match[6]}&&(', f';{match[6]}&&{match[5]}&&(', 1)
        updated, found = theme.subn(replace_theme, source)
        if found:
            require(found == 1, f"Ambiguous suit-ui theme helper: {filename}")
            filename.write_text(updated, encoding="utf-8")
            count += found
    require(count == 37, f"Expected 37 pinned suit-ui helpers, found {count}")


def install_native_updates(app):
    """Cut over the pinned updater locally; retain original non-Linux behavior."""
    native = 'window.require(window.require("path").join(process.resourcesPath,"app/native/update_renderer"))'
    guards = {
        "pedestal/js/HwUpgrade.js": (
            ("0x10447:(_0x34ccb5,_0x577e95,_0x384bf3)=>{'use strict';",
             f'if("linux"===process.platform){{_0x34ccb5.exports={native}.actions;return;}}'),
            ("0xc48:(_0x399620,_0x410a0b,_0x3c486f)=>{'use strict';",
             f'if("linux"===process.platform){{_0x399620.exports={native}.transport;return;}}'),
            ("function(_0x26f8fd){", f'if("linux"===process.platform)return {native}.unsupportedAsync();'),
            ("function(_0x4f1a98){", f'if("linux"===process.platform)return {native}.unsupportedAsync();'),
            ("function(_0x28f5fe){", f'if("linux"===process.platform)return {native}.backgroundCheck();'),
        ),
        "pedestal/js/HwMiddleGround.js": (
            ("function(_0x3fb68d){", f'if("linux"===process.platform)return {native}.unsupportedAsync();'),
        ),
        "pedestal/js/HwLazyLoad.js": (
            ("function(_0x281f9f){", f'if("linux"===process.platform)return {native}.unsupportedAsync();'),
        ),
    }
    # Anonymous wrappers need more than their opening brace as a unique anchor.
    replacements = {
        "pedestal/js/HwUpgrade.js": (
            ("function(){var _0x32f4f7=_0x52012b,",
             f'function(){{if("linux"===process.platform)return {native}.unsupported();var _0x32f4f7=_0x52012b,'),
            ("function(){var _0x5c9275=_0x52012b,",
             f'function(){{if("linux"===process.platform)return {native}.unsupported();var _0x5c9275=_0x52012b,'),
            ("function(){var _0x55674b=_0x320f6d;return _0x3c9d9b",
             f'function(){{if("linux"===process.platform)return {native}.backgroundCheck();var _0x55674b=_0x320f6d;return _0x3c9d9b'),
        ),
        "pedestal/js/HwMiddleGround.js": (
            ("function(){var _0x20b03e=_0x549e77;return _0x5832c0",
             f'function(){{if("linux"===process.platform)return {native}.unsupportedAsync();var _0x20b03e=_0x549e77;return _0x5832c0'),
        ),
        "pedestal/js/HwLazyLoad.js": (
            ("function(){return _0x2dfbd6['apply']",
             f'function(){{if("linux"===process.platform)return {native}.unsupportedAsync();return _0x2dfbd6[\'apply\']'),
        ),
        "libraries/js/httpWithRsSdk.js": (
            ("downloadUpgradeFile:U,cancelDownloadUpgradeFile:H,",
             f'downloadUpgradeFile:"linux"===process.platform?{native}.unsupportedAsync:U,'
             f'cancelDownloadUpgradeFile:"linux"===process.platform?{native}.unsupportedAsync:H,'),
        ),
    }
    for relative in dict.fromkeys((*guards, *replacements)):
        filename = app / relative
        source = filename.read_text(encoding="utf-8")
        changes = [(anchor, anchor + guard) for anchor, guard in guards.get(relative, ())]
        changes.extend(replacements.get(relative, ()))
        for anchor, replacement in changes:
            require(source.count(anchor) == 1, f"Unexpected pinned native updater anchor in {relative}: {anchor}")
            source = source.replace(anchor, replacement)
        filename.write_text(source, encoding="utf-8")


def install_overrides(args, app):
    source = args.vendor_overrides
    for path in tree_files(source):
        relative = path.relative_to(source)
        require(path.suffix in (".js", ".jsc", ".json", ".css", ".html", ".svg"), f"Non-asset app override: {relative}")
        target = app / relative
        require(target.is_file() and not target.is_symlink(), f"Override has no actual installed target: {relative}")
        target.unlink()  # Only the copy made by this invocation, never an input.
        copy_file(path, target, source)
    # The Linux facade used to initialize auth before the native service could decline the link.
    # Initialization for supported online links is owned by RendererMeetingBridge.execute().
    service_file = app / "plugin/conference/dist/js/hwmService.js"
    service = service_file.read_text(encoding="utf-8")
    service = install_render_notes(service_file.parent.parent, service)
    eager_link_init = ('ne.info("newJoinConfByLink"),await (window.require("os").platform()==="linux"'
                       '?ae.initAuth():this.init());let t=await ae.newJoinConfByLink(e);')
    lazy_link_init = ('ne.info("newJoinConfByLink");if(window.require("os").platform()!=="linux")'
                      'await this.init();let t=await ae.newJoinConfByLink(e);')
    require(service.count(eager_link_init) == 1, "Unexpected conference signed-link facade")
    service = service.replace(eager_link_init, lazy_link_init)
    p2p_facade = 'function({calleeNum:e,isVideo:t,userInfo:n}){ne.info("startCall"'
    p2p_delegate = 'ae.startCall({calleeNum:e,isVideo:t,userInfo:n})'
    require(service.count(p2p_facade) == 1 and service.count(p2p_delegate) == 1,
            "Unexpected conference service mode-3 facade")
    service = service.replace(p2p_facade,
        'function({calleeNum:e,isVideo:t,userInfo:n,callRequestId:requestId}){ne.info("startCall"').replace(
        p2p_delegate, 'ae.startCall({calleeNum:e,isVideo:t,userInfo:n,callRequestId:requestId})')
    private = '"method://private_conference/hwm/startCtdCall":'
    facade = '{key:"startCtdCall",value:async function({caller_number:e,callee_number:t}){'
    delegate = 'await ae.startCtdCall({caller_number:e,callee_number:t})'
    require(all(service.count(key) == 1 for key in (private, facade, delegate)),
            "Unexpected conference service callback facade")
    methods = ("prepareInvitationResolver", "getPendingCall", "cancelPendingCall")
    service = service.replace(private, ''.join(
        f'"method://private_conference/hwm/{name}":e=>g.default.{name}(e),' for name in methods) + private)
    service = service.replace(facade, ''.join(
        f'{{key:"{name}",value:e=>ae.{name}(e)}},' for name in methods) +
        '{key:"exitConf",value:()=>ae.exitConf()},' + '{key:"startCtdCall",value:async function(e){')
    tray = 'null==e||!e.isTray)return;(()=>{p.info("handleXYExeExit Begin");'
    require(service.count(tray) == 1, "Unexpected conference tray exit handler")
    service = service.replace(tray,
        'null==e||!e.isTray)return;if("linux"===process.platform){'
        'const result=await g.default.exitConf();'
        'S.info("[handleTrayExit] Linux cleanup receipt",result);return result}'
        'if("win32"===process.platform)(()=>{p.info("handleXYExeExit Begin");')
    service_file.write_text(service.replace(delegate, 'await ae.startCtdCall(e)'), encoding="utf-8")
    conference_bundle = app / "plugin/conference/dist/js/bundle.js"
    conference_source = install_invitation_handoff(app, conference_bundle.read_text(encoding="utf-8"))
    conference_source = install_dial_receipts(app, conference_source)
    conference_bundle.write_text(conference_source, encoding="utf-8")
    viewruntime_file = app / "pedestal/js/viewruntime.js"
    viewruntime_src = viewruntime_file.read_text(encoding="utf-8")
    old_sec = '"win32"===process.platform?this._tupProtocol=new r.default({options:{welink_security_set_log_path:'
    new_sec = '("win32"===process.platform||"linux"===process.platform)?this._tupProtocol=new r.default({options:{welink_security_set_log_path:'
    require(viewruntime_src.count(old_sec) == 1, "Unexpected viewruntime wk_security platform guard")
    viewruntime_file.write_text(viewruntime_src.replace(old_sec, new_sec), encoding="utf-8")
    feedback_file = app / "plugin/feedback/dist/js/app.js"
    feedback_src = feedback_file.read_text(encoding="utf-8")
    old_fb_rm = 't.next=4,Object(z.a)().promises.rmdir(e,{recursive:!0});case 4:t.next=9;break;case 6:t.prev=6,t.t0=t.catch(0),K.error("deleteFileDir error=",Object(M.n)(e),t.t0);'
    new_fb_rm = 't.next=4,Object(z.a)().promises.rm(e,{recursive:!0,force:!0});case 4:t.next=9;break;case 6:t.prev=6,t.t0=t.catch(0),"ENOENT"!==(null==t.t0?void 0:t.t0.code)&&K.error("deleteFileDir error=",Object(M.n)(e),t.t0);'
    require(feedback_src.count(old_fb_rm) == 1, "Unexpected feedback app.js cleanup anchor")
    feedback_file.write_text(feedback_src.replace(old_fb_rm, new_fb_rm), encoding="utf-8")
    old_tcpping = 'const u=["tcpping"];n&&u.push(`-count ${n}`),u.push(t),u.push(a.toString()),o.exec(u.join(" "),((e,n,i)=>{(0,r.default)((()=>{delete l[c]}),15e3),e?s.error("tcpping exec error:",e):(s.info(`tcpping url:${t}, port:${a} result:`,n),i&&s.error("tcpping stderr:",e))}))'
    new_tcpping = 'if("linux"===process.platform){const p=window.require("net"),k=Math.max(1,Number(n)||3),q=Number(a)||443,h=[];(async()=>{try{for(let x=0;x<k;x++){const g=Date.now();await new Promise((y,z)=>{const w=p.createConnection({host:t,port:q});w.setTimeout(3e3);w.once("connect",()=>{h.push(`${Date.now()-g}ms`);w.destroy();y()});w.once("timeout",()=>{w.destroy();z(new Error("timeout"))});w.once("error",e=>{w.destroy();z(e)})})}s.info(`tcpping url:${t}, port:${a} result:`,h.join(", "))}catch(e){s.error("tcpping exec error:",e)}finally{(0,r.default)((()=>{delete l[c]}),15e3)}})();return}' + old_tcpping
    for rel_common in ("pedestal/im/static/js/common.js", "plugin/im/dist/im/static/js/common.js"):
        common_file = app / rel_common
        common_src = common_file.read_text(encoding="utf-8")
        require(common_src.count(old_tcpping) == 1, f"Unexpected IM tcpping anchor in {rel_common}")
        common_file.write_text(
            common_src.replace(old_tcpping, new_tcpping),
            encoding="utf-8")
    install_renderer_data(app)
    install_renderer_repairs(app)
    install_native_updates(app)
    hook = app / HOOK
    matches = re.findall(r"require\(['\"]([^'\"]*native/ffi)['\"]\)", hook.read_text(encoding="utf-8"))
    require(len(matches) == 1 and (hook.parent / matches[0]).resolve() == (app / "native/ffi").resolve(),
            f"library.js does not resolve app/native/ffi from its actual installed layout: {hook}")


def inventory(image):
    result = {}
    for path in tree_files(image):
        relative = path.relative_to(image).as_posix()
        if path.is_symlink():
            target = path.readlink()
            require(not target.is_absolute() and path.resolve().is_relative_to(image), f"Non-portable output symlink: {relative}")
            result[relative] = {"link": str(target)}
        else:
            result[relative] = {"sha256": digest(path), "mode": stat.S_IMODE(path.stat().st_mode)}
    return result


def manifest_header(assets, identity):
    lines = ["/* Generated once by prepare; never refreshed by finalize or at runtime. */",
             "#ifndef WELINK_NATIVE_INTEGRITY_MANIFEST_H", "#define WELINK_NATIVE_INTEGRITY_MANIFEST_H",
             '#include "pedestal_integrity.h"',
             "static const char pedestal_native_integrity_build[] = " + json.dumps(identity) + ";",
             "static const struct pedestal_integrity_asset pedestal_native_integrity_assets[] = {"]
    for name, sha in sorted(assets.items()):
        lines.append("    {" + json.dumps(name, ensure_ascii=True) + ', "' + sha + '"},')
    lines.extend(["};", "#endif", ""])
    return "\n".join(lines).encode()


def normalize_times(root, epoch):
    for base, directories, files in os.walk(root, topdown=False):
        for name in sorted(files + directories):
            os.utime(Path(base) / name, (epoch, epoch), follow_symlinks=False)
    os.utime(root, (epoch, epoch))


def prepare(args):
    require(shutil.which("readelf") is not None, "readelf is required for static ELF metadata inspection")
    inputs = [args.vendor_app, args.native_integration, args.conference, args.ffi_output, args.electron_out,
              args.native_libs, args.deps_prefix, args.electron_prefix, args.vendor_overrides,
              args.provider_inputs, args.sqlite_source, args.management_input, *args.extra_runtime_prefix]
    for output in (args.output, args.manifest_dir):
        require(not output.exists() and not output.is_symlink(), f"Refusing existing output: {output}")
        require(all(not output.is_relative_to(root) and not root.is_relative_to(output) for root in inputs),
                f"Output must not overlap any input: {output}")
    require(not args.output.is_relative_to(args.manifest_dir) and not args.manifest_dir.is_relative_to(args.output),
            "The build manifest directory must be separate from the production image")
    required = [args.vendor_app / name for name in ("main.jsc", "main.js", "package.json")]
    required += [args.native_integration / name for name in NATIVE_HELPERS]
    required += [args.conference / name for name in CONFERENCE_HELPERS]
    required.append(args.conference.parent / "shared/meeting_link_admission.js")
    required += [args.native_libs / name for name in NATIVE_LIBRARIES]
    required += [args.native_libs / name for name in NATIVE_EXECUTABLES]
    required += [args.electron_out / name for name in ELECTRON_FILES]
    required += [args.vendor_overrides / HOOK, args.ffi_output / "source-lock.json",
                 args.deps_prefix / "packages.lock.json", args.deps_prefix / "sources/json-c-0.19/COPYING",
                 args.sqlite_source / "sqlite3mc_amalgamation.c",
                 args.management_input / "package.json", args.management_input / "package-lock.json",
                 args.provider_inputs / "hrtc-12.eb3d2838.js",
                 args.provider_inputs / "custom-background/integrity.json",
                 args.provider_inputs / "custom-background/LICENSE"]
    required += [Path(__file__).resolve().parent / "electron-runtime/licenses" / name
                 for name in ("sqlite3mc-1.4.6-LICENSE", "sqlite3mc-1.4.6.json")]
    missing = [str(path) for path in required if not path.is_file()]
    require(not missing, "Missing runtime/build inputs:\n  " + "\n  ".join(missing))
    require(args.electron_out.joinpath("version").read_text().strip() == "22.3.26", "Expected actual Electron 22.3.26 runtime assets")
    native_libraries = {}
    for name, exports in NATIVE_LIBRARIES.items():
        source = args.native_libs / name
        info = native_elf(source, exports)
        native_libraries[name] = {"sha256": digest(source), "exports": sorted(info["exports"]),
                                  "requiredExports": list(exports), "needed": info["needed"]}
    for name in NATIVE_EXECUTABLES:
        source = args.native_libs / name
        native_elf(source, ())
        require(os.access(source, os.X_OK), f"Native worker is not executable: {source}")
        headers = subprocess.check_output(["readelf", "--wide", "--program-headers", str(source)],
                                          text=True, env=dict(os.environ, LC_ALL="C"))
        require(re.search(r"^\s*INTERP\s", headers, re.M) is not None,
                f"Native worker has no executable interpreter segment: {source}")
    args.output.mkdir(mode=0o700, parents=False)
    # A failed prepare intentionally leaves an incomplete NEW output for diagnosis.
    # It cannot be reused or blessed by rerunning this command.
    args.manifest_dir.mkdir(mode=0o700, parents=False)
    app = args.output / "resources/app"
    app.mkdir(parents=True)
    excluded = install_vendor(args, app)
    for name in NATIVE_HELPERS:
        copy_file(args.native_integration / name, app / "native" / name)
    for name in CONFERENCE_HELPERS:
        copy_file(args.conference / name, app / "native" / name)
    offline_sdk = args.provider_inputs / "hrtc-12.eb3d2838.js"
    require(digest(offline_sdk) == "ac223517d8cd516c2113181a5035093c9f30680380a61c518d08e79fd6c535f4",
            "Unexpected offline HRTC bundle")
    copy_file(offline_sdk, app / "native/vendor" / offline_sdk.name, args.provider_inputs)
    background = args.provider_inputs / "custom-background"
    manifest = background / "integrity.json"
    require(digest(manifest) == "96ee5943a35ab3888fcf75ac84ab239ada21d9e6705cf4134122aa3dba1f691e",
            "Unexpected custom-background model manifest")
    destination = app / "native/vendor/custom-background"
    for name, expected in json.loads(manifest.read_bytes())["sha256"].items():
        require(digest(background / name) == expected, f"Unexpected custom-background asset: {name}")
        copy_file(background / name, destination / name, background)
    for name in ("integrity.json", "LICENSE"):
        copy_file(background / name, destination / name, background)
    require((app / "plugin/conference/HwmSdk/offlineJoinIp.json").is_file(), "Missing native offline control routes")
    copy_file(args.conference.parent / "shared/meeting_link_admission.js", app / "shared/meeting_link_admission.js")
    addons = install_ffi(args, app)
    install_management(args, app)
    install_overrides(args, app)
    runtime = args.output
    roots = []
    for name in ELECTRON_FILES:
        target = runtime / ("chrome-sandbox" if name == "chrome_sandbox" else name)
        copy_file(args.electron_out / name, target)
        with target.open("rb") as stream:
            if stream.read(4) == b"\x7fELF":
                roots.append((target, "Electron runtime"))
    for optional in ("v8_context_snapshot.bin",):
        if (args.electron_out / optional).is_file():
            copy_file(args.electron_out / optional, runtime / optional)
    locales = sorted((args.electron_out / "locales").glob("*.pak"))
    require(locales, f"Missing Electron locale assets: {args.electron_out / 'locales/*.pak'}")
    for source in locales:
        copy_file(source, runtime / "locales" / source.name)
    for name in NATIVE_LIBRARIES:
        target = app / "native/lib" / name
        copy_file(args.native_libs / name, target)
        roots.append((target, "native SDK"))
    for name in NATIVE_EXECUTABLES:
        target = app / "native/lib" / name
        copy_file(args.native_libs / name, target)
        roots.append((target, "isolated native database worker"))
    roots.extend((path, "genuine N-API addon") for path in addons)
    providers = providers_for(args)
    selections, host, glibc = install_closure(args.output, app, roots, providers, (*DLOPEN_ROOTS, *args.dlopen))
    install_licenses(args, app, providers, selections)
    write_new(app / "native/launch-welink", LAUNCHER.encode(), executable=True)
    (args.output / "launch-welink").symlink_to("resources/app/native/launch-welink")
    metadata = {"format": FORMAT, "build": args.build_id, "platform": "linux", "arch": "ia32",
                "electron": "22.3.26", "node": "16.17.1",
                "ffi": "4.0.3", "ref": "3.0.3", "checkerExclusions": [CHECKER],
                "hostGlibcLibraries": host, "requiredGlibcVersions": glibc,
                "runtimeLibraries": selections, "excludedWindowsBinaries": excluded,
                "dependencyLockSha256": digest(args.deps_prefix / "packages.lock.json")}
    metadata["nativeLibraries"] = native_libraries
    write_new(app / "native/build.json", json_bytes(metadata))
    records = inventory(args.output)
    distribution = {name: item for name, item in records.items() if not name.startswith("resources/app/")}
    write_new(app / "native/distribution-sha256.json", json_bytes({
        "scope": "Files outside resources/app; NOT checked by the app-relative C integrity checker",
        "files": distribution,
    }))
    records["resources/app/native/distribution-sha256.json"] = {
        "sha256": digest(app / "native/distribution-sha256.json"), "mode": 0o644,
    }
    assets = {name.removeprefix("resources/app/"): item["sha256"] for name, item in records.items()
              if name.startswith("resources/app/") and "sha256" in item}
    require(CHECKER not in assets and assets, "Only the separately compiled checker may be excluded from the native manifest")
    manifest_hash = hashlib.sha256(json_bytes(assets)).hexdigest()
    identity = args.build_id + ":sha256:" + manifest_hash
    header = manifest_header(assets, identity)
    write_new(args.manifest_dir / "native_integrity_manifest.h", header)
    state = {"format": FORMAT, "phase": "prepared", "identity": identity, "build": args.build_id,
             "image": str(args.output), "checker": CHECKER, "assets": assets, "files": records,
             "headerSha256": hashlib.sha256(header).hexdigest(), "sourceDateEpoch": args.source_date_epoch}
    write_new(args.manifest_dir / "assembly-state.json", json_bytes(state))
    normalize_times(args.output, args.source_date_epoch)
    normalize_times(args.manifest_dir, args.source_date_epoch)
    print(f"Prepared immutable assets (NOT a complete image): {args.output}")
    print(f"Build the real sqlite_plugin.dll.so with INTEGRITY_INCLUDE={args.manifest_dir}")
    print(f"Integrity build identity: {identity}")
    print("Required host ia32 glibc symbols: " + ", ".join(glibc))


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def phase_file(path, expected, partial=False):
    """Recognize only this phase's exact artifact, or an interrupted prefix."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, "rb") as stream:
        attributes = os.fstat(stream.fileno())
        require(stat.S_ISREG(attributes.st_mode) and attributes.st_uid == os.geteuid(),
                f"Finalization artifact is not an owned regular file: {path}")
        require(attributes.st_size <= len(expected), f"Unrecognized finalization artifact: {path}")
        actual = stream.read(len(expected) + 1)
        require(actual == (expected[:len(actual)] if partial else expected),
                f"Finalization artifact differs from the verified bytes: {path}")
    return attributes


def stage_phase_file(path, data, mode, epoch, previous):
    if previous and previous.st_size != len(data):
        require(previous.st_nlink == 1, f"Refusing to replace a linked partial staging file: {path}")
        path.unlink()
        previous = None
    flags = os.O_RDWR | os.O_NOFOLLOW
    if not previous:
        flags |= os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o600)
    with os.fdopen(descriptor, "r+b") as stream:
        if not previous:
            stream.write(data)
            stream.flush()
        os.fchmod(stream.fileno(), mode)
        os.utime(stream.fileno(), (epoch, epoch))
        os.fsync(stream.fileno())


def finalize_locked(args):
    state_path = args.manifest_dir / "assembly-state.json"
    original_state = state_path.read_bytes()
    state = json.loads(original_state)
    require(state.get("format") == FORMAT and state.get("phase") in ("prepared", "finalized"),
            "Finalize requires this assembler's prepare state")
    require(state.get("image") == str(args.output) and state.get("checker") == CHECKER,
            "Finalize output does not match the prepared image")
    require(digest(args.manifest_dir / "native_integrity_manifest.h") == state["headerSha256"],
            "The compiled-in manifest header changed after prepare; no baseline regeneration is permitted")
    checker_sha = digest(args.checker)
    info = native_elf(args.checker, ("tup_sqlite_init", "tup_sqlite_shutdown", "pedestal_integrity_execute", "pedestal_integrity_dispatch"))
    # The compiler must have embedded THIS baseline, not an older vendor checker
    # or a differently prepared native build. This reads bytes, never dlopens it.
    data = args.checker.read_bytes()
    require(hashlib.sha256(data).hexdigest() == checker_sha, "Checker changed during static inspection; finalization refused")
    require(state["identity"].encode() + b"\0" in data, "Checker does not contain this exact native integrity build identity")
    for path, sha in state["assets"].items():
        require(path.encode() + b"\0" in data and sha.encode() + b"\0" in data,
                f"Checker does not contain the prepared immutable manifest entry: {path}")
    app = args.output / "resources/app"
    target = app / CHECKER
    staging = target.with_name("." + target.name + ".finalize-" + checker_sha)
    staged = phase_file(staging, data, partial=True)
    published = phase_file(target, data)
    if staged:
        require(staged.st_nlink == 1 or
                (published and staged.st_nlink == 2 and os.path.samefile(staging, target)),
                f"Refusing an unrelated hard-linked staging file: {staging}")
    if published:
        require(stat.S_IMODE(published.st_mode) == 0o755 and
                (published.st_nlink == 1 or
                 (staged and published.st_nlink == 2 and os.path.samefile(staging, target))),
                f"Existing checker has unexpected mode or links: {target}")
    if state["phase"] == "finalized":
        require(published and state.get("checkerSha256") == checker_sha,
                "A finalized image cannot be replaced with a different checker")
    # Recovery recognizes only the content-addressed staging path and a fully
    # published matching checker. Every other immutable byte must remain frozen.
    current = inventory(args.output)
    if staged:
        current.pop(staging.relative_to(args.output).as_posix())
    if published:
        current.pop(target.relative_to(args.output).as_posix())
    require(current == state["files"], "Immutable image changed after prepare; finalization refused (no baseline refresh)")
    available = {p.name for p in (app / "native/lib/runtime").iterdir()}
    available.update(p.name for p in args.output.iterdir())
    missing = set(info["needed"]) - available - HOST_GLIBC
    require(not missing, "Checker introduces unassembled runtime dependencies: " + ", ".join(sorted(missing)))
    old_glibc = set(load_json(app / "native/build.json")["requiredGlibcVersions"])
    require(set(info["glibc"]) <= old_glibc, "Checker introduces new host glibc requirements; prepare a new image with the matching real inputs")
    if not published:
        stage_phase_file(staging, data, 0o755, state["sourceDateEpoch"], staged)
        # link(2) publishes complete fsynced bytes atomically and fails if the
        # final name already exists; unlike rename/replace, it never overwrites.
        os.link(staging, target, follow_symlinks=False)
        sync_directory(target.parent)
    if staging.exists():
        staging.unlink()
    os.utime(target.parent, (state["sourceDateEpoch"], state["sourceDateEpoch"]))
    sync_directory(target.parent)
    finalized = dict(state, phase="finalized", checkerSha256=checker_sha)
    final_bytes = json_bytes(finalized)
    temporary = args.manifest_dir / "assembly-state.finalized.json"
    pending = phase_file(temporary, final_bytes, partial=True)
    if pending:
        require(pending.st_nlink == 1, f"Refusing linked pending finalization state: {temporary}")
    require(state_path.read_bytes() == original_state, "Assembly state changed during finalization")
    if state["phase"] != "finalized":
        stage_phase_file(temporary, final_bytes, 0o600, state["sourceDateEpoch"], pending)
        os.replace(temporary, state_path)
        sync_directory(args.manifest_dir)
    elif pending:
        temporary.unlink()
        sync_directory(args.manifest_dir)
    print(f"Finalized real native image: {args.output}")
    print(f"Launch as the desktop user: {args.output / 'launch-welink'}")


def finalize(args):
    # This build-side lock survives interrupted runs. It is never shipped, and
    # serializes recovery so two finalizers cannot remove each other's staging.
    descriptor = os.open(args.manifest_dir / ".finalize.lock",
                         os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        attributes = os.fstat(descriptor)
        require(stat.S_ISREG(attributes.st_mode) and attributes.st_uid == os.geteuid()
                and attributes.st_nlink == 1, "Invalid finalization lock")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        finalize_locked(args)
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="phase", required=True)
    prepare_parser = sub.add_parser("prepare", help="assemble a NEW immutable image and generate its checker header")
    for name in ("vendor-app", "native-integration", "conference", "ffi-output", "electron-out", "native-libs",
                 "deps-prefix", "electron-prefix", "output", "manifest-dir"):
        prepare_parser.add_argument("--" + name, type=Path, required=True)
    prepare_parser.add_argument("--vendor-overrides", type=Path, help="verified prepared override directory")
    prepare_parser.add_argument("--provider-inputs", type=Path, help="verified HRTC and custom-background input directory")
    prepare_parser.add_argument("--sqlite-source", type=Path, help="pinned SQLite3MC source directory for notices")
    prepare_parser.add_argument("--management-input", type=Path, help="locked production management package tree")
    prepare_parser.add_argument("--build-id", required=True, help="deliberate release identity; the exact asset digest is appended")
    prepare_parser.add_argument("--extra-runtime-prefix", type=Path, action="append", default=[], help="additional extracted ia32 runtime packages, including notices; no host library search")
    prepare_parser.add_argument("--notice-map", type=Path, help="JSON object mapping exact DSO SHA256 to a list of real license files (paths relative to this JSON)")
    prepare_parser.add_argument("--common-licenses", type=Path, default=Path("/usr/share/common-licenses"))
    prepare_parser.add_argument("--native-license", type=Path, action="append", default=[])
    prepare_parser.add_argument("--dlopen", action="append", default=[], help="additional genuine runtime-loaded DSO SONAME to include in closure")
    prepare_parser.add_argument("--source-date-epoch", type=int, default=1616074138)
    final_parser = sub.add_parser("finalize", help="install ONLY the checker built against the unchanged prepare baseline")
    for name in ("output", "manifest-dir", "checker"):
        final_parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    try:
        for name, value in vars(args).items():
            if isinstance(value, Path):
                if name in ("output", "manifest_dir"):
                    require(not value.is_symlink(), f"Refusing a symlink as an assembly directory: {value}")
                setattr(args, name, value.absolute().resolve())
            elif isinstance(value, list) and value and isinstance(value[0], Path):
                setattr(args, name, [p.absolute().resolve() for p in value])
        if args.phase == "prepare":
            args.vendor_overrides = (args.vendor_overrides or args.native_integration / "app-overrides").resolve()
            args.provider_inputs = (args.provider_inputs or args.conference / "vendor").resolve()
            args.sqlite_source = (args.sqlite_source or args.native_integration.parent / "vendor/sqlite3mc-1.4.6").resolve()
            args.management_input = (args.management_input or args.conference / "vendor/management").resolve()
            require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,119}", args.build_id), "build-id must be a short explicit printable release identifier")
            require(args.source_date_epoch >= 0, "source-date-epoch must not be negative")
            for name in args.dlopen:
                require(DSO_NAME.fullmatch(name) and "/" not in name, f"Expected a DSO SONAME, not a path: {name}")
            notice_file = args.notice_map
            args.notice_map = {}
            if notice_file:
                for sha, paths in load_json(notice_file).items():
                    require(re.fullmatch(r"[0-9a-f]{64}", sha) and isinstance(paths, list) and paths,
                            "Each notice-map key must be an exact lowercase SHA256 with a nonempty license-path list")
                    args.notice_map[sha] = [(notice_file.parent / p).resolve() for p in paths]
            prepare(args)
        else:
            finalize(args)
    except (AssemblyError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"assemble_app: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
