#!/bin/bash
# Amber PM entry point. Keep the overlay mounted until the app AND any detached
# updater/restarted descendants exit. Never hand the app to host systemd.
set -euo pipefail
if [[ ${IS_ACE_ENV:-} != 1 || ${APM_PKG_NAME:-} != cn.edu.hit.welink.native.apm ]]; then
    printf '%s\n' 'Run this launcher through: apm run cn.edu.hit.welink.native.apm /opt/apps/cn.edu.hit.welink.native/files/bin/launch' >&2
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
        payload = json.dumps(sys.argv[1:]).encode() + b'\n'
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
                    connection.connect(str(filename))
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
server.bind(str(filename))
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

command = ['/usr/bin/python3', '-I', '/opt/apps/cn.edu.hit.welink.native/files/package_install.py', *sys.argv[1:]]
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
