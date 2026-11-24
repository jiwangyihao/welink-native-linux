#!/bin/bash
# Amber PM entry point. Keep the overlay mounted until the app AND any detached
# updater/restarted descendants exit. Never hand the app to host systemd.
set -euo pipefail
umask 077
if [[ ${IS_ACE_ENV:-} != 1 ]]; then
    # Keep installed APM layers read-only; upstream `apm run` incorrectly uses
    # root-owned package directories as writable upper/work layers.
    exec /usr/bin/python3 -I - "${BASH_SOURCE[0]}" "$@" <<'APM_HOST'
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time

package = 'cn.edu.hit.welink.native.apm'
if os.getuid() == 0:
    raise SystemExit('Launch WeLink APM as the desktop user, not root')
script = Path(sys.argv[1]).resolve(strict=True)
package_root = script.parent.parent
if script.name != 'launch' or script.parent.name != 'files' or package_root.name != package:
    raise SystemExit('The APM host launcher must come from the installed package')
for item in (script, package_root, package_root / 'files/core'):
    info = item.stat()
    if info.st_uid != 0 or info.st_mode & 0o022:
        raise SystemExit('Installed APM executable layers must remain root-owned and non-writable')
home = Path.home().absolute()
if home.resolve() != home or home.stat().st_uid != os.getuid():
    raise SystemExit('HOME must be canonical and owned by the desktop user')
# Bubblewrap leaves host root unmapped. Capture only actual root-owned HOME
# ancestors while still on the host; never treat every overflow UID as root.
# Walk held directory descriptors so a symlink cannot substitute an ancestor.
host_root_directories = []
directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
directory = os.open('/', directory_flags)
walked = Path('/')
try:
    for component in ('', *home.parts[1:]):
        if component:
            child = os.open(component, directory_flags, dir_fd=directory)
            os.close(directory)
            directory = child
            walked /= component
        info = os.fstat(directory)
        mode = stat.S_IMODE(info.st_mode)
        if (not stat.S_ISDIR(info.st_mode) or info.st_nlink < 1 or info.st_uid not in (0, os.getuid()) or
                (mode & 0o022 and not (info.st_uid == 0 and mode & 0o1000))):
            raise SystemExit('Untrusted writable or foreign-owned HOME ancestor: ' + str(walked))
        if info.st_uid == 0:
            host_root_directories.append({'path': str(walked), 'dev': str(info.st_dev),
                                          'ino': str(info.st_ino), 'mode': mode, 'ctimeNs': str(info.st_ctime_ns)})
finally:
    os.close(directory)
# ace-run builds bind arguments as shell text. Reject unsupported HOME syntax
# instead of allowing it to split or reinterpret the mount paths.
if not re.fullmatch(r'[A-Za-z0-9_./@%+=-]+', str(home)):
    raise SystemExit('The installed APM runtime does not safely support this HOME pathname')
state = home / '.local/state/welink-native-apm'
state.mkdir(parents=True, mode=0o700, exist_ok=True)
info = state.stat()
if state.resolve() != state or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
    raise SystemExit('The APM launch state directory must be canonical, user-owned and mode 0700')
payload = json.dumps(sys.argv[2:]).encode() + b'\n'
if len(payload) > 65536:
    raise SystemExit('APM activation arguments are too large')

def activate():
    filename = state / 'launch.sock'
    try:
        info = filename.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError('Refusing an unrelated APM activation socket')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(10)
            # sun_path is bounded even when the private HOME is a valid long path.
            socket_directory = os.open(state, directory_flags)
            try:
                connection.connect(f'/proc/self/fd/{socket_directory}/launch.sock')
            finally:
                os.close(socket_directory)
            _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != os.getuid():
                raise RuntimeError('The APM activation server belongs to another user')
            connection.sendall(payload)
            data = b''
            while b'\n' not in data and len(data) <= 4096:
                chunk = connection.recv(4096)
                if not chunk:
                    raise RuntimeError('The APM activation server closed without acknowledging the request')
                data += chunk
            if len(data) > 4096:
                raise RuntimeError('Invalid APM activation reply')
            reply = json.loads(data)
            if not isinstance(reply, dict) or reply.get('ok') is not True:
                raise RuntimeError(reply.get('error', 'APM activation failed') if isinstance(reply, dict) else 'Invalid APM activation reply')
            return True
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.ECONNREFUSED):
            raise
        return False

if activate():
    raise SystemExit(0)
lock = os.open(state / 'mount.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
info = os.fstat(lock)
if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
    raise SystemExit('Invalid APM mount lock')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    for _ in range(100):
        if activate():
            raise SystemExit(0)
        time.sleep(0.1)
    raise SystemExit('The APM package is still starting or shutting down')
if activate():
    raise SystemExit(0)

layers = []
seen = set()
def layer(name):
    if not re.fullmatch(r'[a-z0-9][a-z0-9+.-]+', name):
        raise RuntimeError('Invalid declared APM base name')
    if name in seen:
        return
    seen.add(name)
    directory = package_root if name == package else package_root.parent / name
    if not directory.is_dir():
        raise RuntimeError('Install the declared APM base first: ' + name)
    content = directory / 'files/ace-env'
    if not content.is_dir():
        content = directory / 'files/core'
    if not content.is_dir() or content.stat().st_uid != 0 or content.stat().st_mode & 0o022:
        raise RuntimeError('The declared APM layer must be an installed, protected directory: ' + name)
    layers.append(str(content.resolve()))
    info = directory / 'info'
    if info.is_file():
        for base in info.read_text().splitlines():
            if base.strip():
                layer(base.strip())

layer(package)
runtime = Path('/var/lib/apm/apm/files/ace-run')
if len(layers) < 2 or not runtime.is_file():
    raise SystemExit('The APM runtime and declared base layers must be installed')
workspace = Path(tempfile.mkdtemp(prefix='mount-', dir=state))
merged = workspace / 'root'
for name in ('upper', 'work', 'root'):
    (workspace / name).mkdir(mode=0o700)
arguments = workspace / 'arguments.json'
with arguments.open('xb') as stream:
    os.fchmod(stream.fileno(), 0o600)
    stream.write(payload)
environment = dict(os.environ, APM_PKG_NAME=package, chrootEnvPath=str(merged),
                   WELINK_NATIVE_APM_ARGUMENTS_FILE=str(arguments),
                   WELINK_NATIVE_APM_HOST_ROOT_DIRS=json.dumps(host_root_directories, separators=(',', ':')))
environment.pop('APM_USE_SANDBOX', None)
try:
    options = 'lowerdir=' + ':'.join(layers) + ',upperdir=' + str(workspace / 'upper') + ',workdir=' + str(workspace / 'work')
    subprocess.run(['/usr/bin/fuse-overlayfs', '-o', options, str(merged)], check=True)
    if not os.path.ismount(merged):
        raise RuntimeError('The private APM overlay was not mounted')
    # User arguments cross ace-run's shell interpolation in a private JSON
    # file; the executable command is always this fixed package entry point.
    # ACE supplies the package filesystem, but does not request PID isolation.
    # Keep its loader inside explicit user/PID namespaces with a matching procfs.
    result = subprocess.run(['/usr/bin/bwrap', '--unshare-user', '--unshare-pid',
                             '--dev-bind', '/', '/', '--proc', '/proc', '--',
                             str(runtime), '/opt/apps/cn.edu.hit.welink.native/files/bin/launch'], env=environment)
finally:
    if os.path.ismount(merged):
        subprocess.run(['/usr/bin/fusermount3', '-u', str(merged)], check=True)
    shutil.rmtree(workspace)
    os.close(lock)
raise SystemExit(result.returncode)
APM_HOST
fi
if [[ ${APM_PKG_NAME:-} != cn.edu.hit.welink.native.apm ]]; then
    printf '%s\n' 'The WeLink APM launcher cannot run inside a different APM package.' >&2
    exit 1
fi
export WELINK_NATIVE_APM_PACKAGE=cn.edu.hit.welink.native.apm
unset INVOCATION_ID SYSTEMD_EXEC_PID
exec /usr/bin/python3 -I - "$@" <<'PY'
import ctypes
import errno
import fcntl
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import stat
import struct
import sys
import time
arguments = sys.argv[1:]
arguments_file = os.environ.pop('WELINK_NATIVE_APM_ARGUMENTS_FILE', None)
if arguments_file:
    fd = os.open(arguments_file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536:
            raise SystemExit('Invalid private APM launch arguments')
        arguments = json.load(stream)
    if not isinstance(arguments, list) or any(not isinstance(arg, str) or '\0' in arg for arg in arguments):
        raise SystemExit('Invalid APM launch arguments')

if os.getuid() == 0:
    raise SystemExit('Launch WeLink APM as the desktop user, not root')
state = Path.home().resolve() / '.local/state/welink-native-apm'
state.mkdir(parents=True, mode=0o700, exist_ok=True)
info = state.stat()
if state.resolve() != state or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
    raise SystemExit('The APM launch state directory must be canonical, user-owned and mode 0700')
lock = os.open(state / 'server.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
info = os.fstat(lock)
if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
    raise SystemExit('Invalid APM lifetime lock')
filename = state / 'launch.sock'
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    # Deliver a warm activation inside the original package namespace now.
    # Then retain this `apm run` until the original lifetime ends: returning
    # early would make upstream APM unmount the shared overlay. Never bootstrap
    # again after the user closes that application.
    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, signal.SIG_IGN)
    result = 0
    try:
        payload = json.dumps(arguments).encode() + b'\n'
        if len(payload) > 65536:
            raise ValueError('APM activation arguments are too large')
        deadline = time.monotonic() + 10
        while True:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(10)
                try:
                    info = filename.lstat()
                    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                        raise ValueError('Refusing an unrelated APM activation socket')
                    socket_directory = os.open(state, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
                    try:
                        connection.connect(f'/proc/self/fd/{socket_directory}/launch.sock')
                    finally:
                        os.close(socket_directory)
                except OSError as error:
                    if error.errno not in (errno.ENOENT, errno.ECONNREFUSED) or time.monotonic() >= deadline:
                        raise
                    time.sleep(0.1)
                    continue
                _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid != os.getuid():
                    raise ValueError('The APM activation server belongs to another user')
                # Do not retry after sending: an uncertain acknowledgement
                # must never duplicate a URI delivery.
                connection.sendall(payload)
                data = b''
                while b'\n' not in data and len(data) <= 4096:
                    chunk = connection.recv(4096)
                    if not chunk:
                        raise ValueError('The APM activation server closed without acknowledging the request')
                    data += chunk
                if len(data) > 4096:
                    raise ValueError('Invalid APM activation reply')
                reply = json.loads(data)
                if not isinstance(reply, dict) or reply.get('ok') is not True:
                    raise ValueError(reply.get('error', 'APM activation failed') if isinstance(reply, dict) else 'Invalid APM activation reply')
                break
    except (OSError, ValueError) as error:
        print('WeLink APM activation failed: ' + str(error), file=sys.stderr, flush=True)
        result = 1
    finally:
        fcntl.flock(lock, fcntl.LOCK_SH)
        os.close(lock)
    raise SystemExit(result)
if filename.exists() or filename.is_symlink():
    info = filename.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
        raise SystemExit('Refusing an unrelated APM activation socket')
    filename.unlink()
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
    raise OSError(ctypes.get_errno(), 'Cannot supervise the Amber PM application lifetime')
os.environ['WELINK_NATIVE_APM_SUPERVISOR_PID'] = str(os.getpid())
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
socket_directory = os.open(state, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
try:
    server.bind(f'/proc/self/fd/{socket_directory}/launch.sock')
finally:
    os.close(socket_directory)
os.chmod(filename, 0o600)
socket_inode = filename.stat().st_ino
server.listen(8)
selector = selectors.DefaultSelector()
selector.register(server, selectors.EVENT_READ)
launcher = Path.home().resolve() / '.local/bin/hit-welink-native-apm'

def forward_signal(number, _frame):
    children = Path('/proc/self/task') / str(os.getpid()) / 'children'
    for child in children.read_text().split():
        try:
            os.kill(int(child), number)
        except ProcessLookupError:
            pass

for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(number, forward_signal)

command = ['/usr/bin/python3', '-I', '/opt/apps/cn.edu.hit.welink.native/files/package_install.py', *arguments]
initial = os.posix_spawn(command[0], command, os.environ)
exit_code = 0
try:
    while True:
        try:
            while True:
                pid, status = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
                if pid == initial:
                    result = os.waitstatus_to_exitcode(status)
                    exit_code = result if result >= 0 else 128 - result
        except ChildProcessError:
            break
        for key, _ in selector.select(0.1):
            connection, _ = key.fileobj.accept()
            with connection:
                connection.settimeout(2)
                try:
                    _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if uid != os.getuid():
                        raise ValueError('Activation must come from the same desktop user')
                    data = b''
                    while b'\n' not in data and len(data) <= 65536:
                        chunk = connection.recv(4096)
                        if not chunk:
                            raise ValueError('Incomplete activation request')
                        data += chunk
                    if len(data) > 65536 or not data.endswith(b'\n'):
                        raise ValueError('Oversized activation request')
                    arguments = json.loads(data)
                    if not isinstance(arguments, list) or any(not isinstance(arg, str) or '\0' in arg for arg in arguments):
                        raise ValueError('Activation arguments must be strings')
                    info = launcher.lstat()
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                        raise ValueError('The per-user APM launcher is not installed yet')
                    command = ['/bin/bash', '--', str(launcher), *arguments]
                    os.posix_spawn(command[0], command, os.environ)
                    reply = {'ok': True}
                except (OSError, ValueError) as error:
                    reply = {'error': str(error)}
                try:
                    connection.sendall(json.dumps(reply).encode() + b'\n')
                except OSError:
                    pass
finally:
    selector.close()
    server.close()
    if filename.exists() and filename.lstat().st_ino == socket_inode:
        filename.unlink()
    os.close(lock)
sys.exit(exit_code)
PY
