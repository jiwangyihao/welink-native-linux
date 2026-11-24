#!/usr/bin/env python3
"""Private, detached native-update transaction supervisor (never run as root)."""
import base64
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time


DESKTOP_IDS = ('cn.edu.hit.welink.native.desktop', 'hit-welink-native.desktop')
BUILD = re.compile(r'hit-native-linux-ia32-(r45\.(0|[1-9][0-9]*))\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
SESSION_ENVIRONMENT = ('HOME', 'PATH', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR',
                       'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME',
                       'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS')
UNSAFE_ENVIRONMENT = ('ELECTRON_RUN_AS_NODE', 'WELINK_NATIVE_PROFILE_GATE_FD', 'NODE_OPTIONS', 'NODE_PATH',
                      'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'LD_PRELOAD', 'LD_AUDIT',
                      'LD_LIBRARY_PATH', 'OPENSSL_CONF', 'OPENSSL_MODULES', 'PYTHONPATH', 'PYTHONHOME',
                      'PYTHONSTARTUP', 'PYTHONINSPECT')


def atomic(path, value):
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def private(path):
    if path.resolve() != path or not path.is_dir() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise RuntimeError('Update transaction directory must be canonical, private and user-owned')


def file_bytes(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > maximum:
            raise RuntimeError('Unsafe update transaction file: ' + path.name)
        with os.fdopen(os.dup(fd), 'rb') as stream:
            return stream.read(maximum + 1)
    finally:
        os.close(fd)


def sealed_bytes(data):
    fd = os.memfd_create('welink-signed-update', os.MFD_ALLOW_SEALING)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        fcntl.fcntl(fd, fcntl.F_ADD_SEALS, fcntl.F_SEAL_WRITE | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SEAL)
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except BaseException:
        os.close(fd)
        raise


def sealed_asset(work, descriptor):
    data = file_bytes(work / descriptor['asset'], descriptor['size'])
    if len(data) != descriptor['size'] or hashlib.sha256(data).hexdigest() != descriptor['sha256']:
        raise RuntimeError('Signed release asset bytes changed before execution')
    return sealed_bytes(data)


def open_profile_gate(profile):
    if not profile.is_absolute() or profile.resolve() != profile:
        raise RuntimeError('Profile startup gate requires a canonical absolute profile')
    # This directory is outside the profile and independent of HOME/XDG, so
    # backup/rename and alternate launcher environments cannot split the lock.
    directory = profile.parent / '.welink-native-profile-gates'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    private(directory)
    filename = directory / (hashlib.sha256(os.fsencode(profile)).hexdigest() + '.lock')
    fd = os.open(filename, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
        os.close(fd)
        raise RuntimeError('The native profile startup gate is not a private owned regular file')
    return fd


def launcher_profile_gate(arguments):
    mode = arguments[0]
    profile = Path(arguments[1])
    inherited = None
    if mode == '--check-profile-gate':
        if len(arguments) != 3 or not arguments[2].isdecimal() or int(arguments[2]) < 3:
            raise RuntimeError('Invalid inherited profile gate descriptor')
        inherited = int(arguments[2])
        # Inspect BEFORE opening anything: a forged closed FD number must not
        # accidentally identify the new descriptor opened below in this child.
        actual = os.fstat(inherited)
    fd = open_profile_gate(profile)
    try:
        if inherited is not None:
            expected = os.fstat(fd)
            if (expected.st_dev, expected.st_ino) != (actual.st_dev, actual.st_ino):
                raise RuntimeError('Inherited profile gate belongs to another file')
            # Even a correctly identified but previously unlocked inherited FD
            # must acquire a REAL lock. An environment flag is never authority.
            fcntl.flock(inherited, fcntl.LOCK_SH)
            return
        launcher = installed_image() / 'resources/app/native/launch-welink'
        if mode != '--launch-profile-gate' or len(arguments) < 3 or Path(arguments[2]).resolve() != launcher:
            raise RuntimeError('Profile gate may launch only its installed immutable launcher')
        fcntl.flock(fd, fcntl.LOCK_SH)
        os.set_inheritable(fd, True)
        environment = dict(os.environ, WELINK_NATIVE_PROFILE_GATE_FD=str(fd))
        os.execve('/usr/bin/bash', ['/usr/bin/bash', str(launcher), *arguments[3:]], environment)
    finally:
        os.close(fd)


def installed_image():
    supervisor = Path(__file__).resolve(strict=True)
    image = supervisor.parents[3]
    if supervisor != image / 'resources/app/native/update_supervisor.py':
        raise RuntimeError('Native update supervisor must run from its installed image')
    return image


def signed_manifest(work):
    base = installed_image()
    data = file_bytes(work / 'native-update.json', 256 * 1024)
    signature = file_bytes(work / 'native-update.sig', 512).strip()
    if not re.fullmatch(rb'[A-Za-z0-9+/]{86}==', signature):
        raise RuntimeError('Invalid Ed25519 signature encoding')
    key = base / 'resources/app/native/update_public_key.pem'
    # Resolve the trust root from this running supervisor, never from request
    # data, a downloaded asset, a command argument or the environment.
    fds = [sealed_bytes(data), sealed_bytes(base64.b64decode(signature, validate=True)), sealed_bytes(key.read_bytes())]
    try:
        subprocess.run(['/usr/bin/openssl', 'pkeyutl', '-verify', '-pubin', '-rawin',
                        '-inkey', '/proc/self/fd/' + str(fds[2]), '-in', '/proc/self/fd/' + str(fds[0]),
                        '-sigfile', '/proc/self/fd/' + str(fds[1])], pass_fds=fds, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    finally:
        for fd in fds:
            os.close(fd)
    manifest = json.loads(data.decode('utf-8'))
    current = json.loads((base / 'resources/app/native/build.json').read_text())['build']
    current_match = BUILD.fullmatch(current)
    target_match = BUILD.fullmatch(manifest.get('build', ''))
    if manifest.get('format') != 1 or not current_match or not target_match or int(target_match[2]) <= int(current_match[2]) or manifest.get('version') != target_match[1] or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('sourceCommit', '')):
        raise RuntimeError('Invalid signed native release identity or downgrade')
    entries = manifest.get('installers')
    if not isinstance(entries, list) or not 1 <= len(entries) <= 100:
        raise RuntimeError('Invalid signed installer list')
    bases, assets = set(), set()
    for item in entries:
        match = BUILD.fullmatch(item.get('base', ''))
        if not match or int(match[2]) >= int(target_match[2]) or not HASH.fullmatch(item.get('baseCheckerSha256', '')):
            raise RuntimeError('Invalid signed baseline')
        if item.get('asset') != 'install-' + target_match[1] + '-from-' + match[1] + '.py' or item['base'] in bases or item['asset'] in assets:
            raise RuntimeError('Unsafe or ambiguous signed installer')
        bases.add(item['base']); assets.add(item['asset'])
    integration = manifest.get('integration', {})
    if integration.get('asset') != 'install_desktop.py':
        raise RuntimeError('Invalid signed desktop integration')
    for item in entries + [integration]:
        if type(item.get('size')) is not int or not 0 < item['size'] <= 512 * 1024 * 1024 or not HASH.fullmatch(item.get('sha256', '')):
            raise RuntimeError('Invalid signed asset size/hash')
    checker = hashlib.sha256((base / 'resources/app/native/lib/sqlite_plugin.dll.so').read_bytes()).hexdigest()
    selected = [item for item in entries if item['base'] == current and item['baseCheckerSha256'] == checker]
    if len(selected) != 1:
        raise RuntimeError('No exact baseline in signed update')
    return manifest, selected[0]


def process_identity(pid):
    try:
        process = Path('/proc') / str(pid)
        if process.stat().st_uid != os.getuid():
            return None
        text = (process / 'stat').read_text()
        tail = text[text.rfind(')') + 2:].split()
        if tail[0] == 'Z':
            return None
        return tail[19]
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None


def profile_processes(profile):
    marker = os.fsencode('WELINK_NATIVE_PROFILE_DIR=' + str(profile))
    found = []
    # A caller may use the default profile without an environment override.
    try:
        host, _, pid = (profile / 'runtime/SingletonLock').readlink().name.rpartition('-')
        if host == os.uname().nodename and pid.isdecimal() and process_identity(int(pid)):
            executable = (Path('/proc') / pid / 'exe').readlink()
            if executable.name == 'electron':
                found.append(int(pid))
    except (FileNotFoundError, OSError):
        pass
    for process in Path('/proc').iterdir():
        if not process.name.isdecimal() or int(process.name) == os.getpid():
            continue
        try:
            if process.stat().st_uid == os.getuid() and marker in (process / 'environ').read_bytes().split(b'\0'):
                executable = (process / 'exe').readlink()
                if (executable.name == 'electron' or '/image/' in str(executable) or '/resources/app/native/' in str(executable)) and process_identity(int(process.name)):
                    found.append(int(process.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    return found


def snapshot(path):
    if not path.exists() and not path.is_symlink():
        return None
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        raise RuntimeError('Refusing unrelated integration file: ' + str(path))
    data = path.read_bytes()
    return {'data': base64.b64encode(data).decode(), 'mode': stat.S_IMODE(info.st_mode), 'sha256': hashlib.sha256(data).hexdigest()}


def restore_file(path, before, installed):
    # Compare-and-restore: another updater or the user owns subsequent edits.
    if snapshot(path) != installed:
        raise RuntimeError('Integration changed outside this update; refusing to overwrite: ' + str(path))
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        if before is None:
            path.unlink(missing_ok=True)
            os.fsync(directory)
            return
        fd, name = tempfile.mkstemp(prefix='.native-rollback-' + path.name + '.', dir=path.parent)
        temporary = Path(name)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(base64.b64decode(before['data']))
                stream.flush()
                # Creation is subject to the supervisor's 077 umask. Restore
                # the journaled mode explicitly, before committing the inode.
                os.fchmod(stream.fileno(), before['mode'])
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            os.fsync(directory)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            else:
                os.fsync(directory)
    finally:
        os.close(directory)


def readiness(value, token, build, image, profile):
    if not isinstance(value, dict) or value.get('token') != token or value.get('build') != build or value.get('profile') != str(profile):
        raise RuntimeError('Readiness receipt belongs to another update/profile')
    pid = value.get('pid')
    if type(pid) is not int or process_identity(pid) != value.get('startTime'):
        raise RuntimeError('Readiness process exited or was replaced')
    if (Path('/proc') / str(pid) / 'exe').readlink() != image / 'electron':
        raise RuntimeError('Readiness receipt is not from the installed image')
    if value.get('status') == 'failed':
        raise RuntimeError('New application startup failed: ' + str(value.get('error', 'unknown startup failure')))
    route = value.get('route', '')
    if value.get('status') != 'ready' or route not in ('/login/Auth2Login/Webview', '/login/LoginPage', '/main/im') or value.get('mounted') is not True or value.get('httpExports') != ['middleGroundAjax', 'middleGroundPost', 'downloadUpgradeFile', 'cancelDownloadUpgradeFile']:
        raise RuntimeError('The new application has not reached a working login/message route')
    return pid


class Transaction:
    def __init__(self, work, recovering=False):
        self.work = work
        private(work)
        self.request = json.loads(file_bytes(work / 'request.json', 65536))
        self.base = installed_image()
        if self.request.get('baseImage') != str(self.base):
            raise RuntimeError('Update transaction baseline differs from the supervisor installed image')
        self.profile = Path(self.request['profile'])
        self.home = Path.home().resolve()
        if self.base.resolve() != self.base or self.profile.resolve() != self.profile or (not self.profile.is_dir() and not recovering) or (self.profile.exists() and self.profile.stat().st_uid != os.getuid()):
            raise RuntimeError('Noncanonical base or explicit native profile')
        self.manifest, self.installer = signed_manifest(work)
        self.target = self.base.parent.parent / ('hit-welink-native-' + self.manifest['version']) / 'image'
        self.unit = 'welink-native-new-' + work.name + '.service'
        self.systemd = self.request['systemd'] is True
        self.child = None
        self.journal = {'phase': 'staging', 'profile': str(self.profile), 'base': str(self.base), 'target': str(self.target), 'files': []}
        self.backup = None
        self.lock = os.open(work.parent / ('profile-' + hashlib.sha256(os.fsencode(self.profile)).hexdigest() + '.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    @contextmanager
    def profile_mutation(self):
        fd = open_profile_gate(self.profile)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError('A native application owns the profile startup gate; refusing profile mutation') from error
            # Retain the process check for older binaries which lack this
            # protocol. Their direct/manual launches cannot be made cooperative
            # retroactively and must not run during update/recovery.
            if profile_processes(self.profile):
                raise RuntimeError('A live native process still owns the profile; refusing profile mutation')
            yield
        finally:
            os.close(fd)

    def status(self, phase, **extra):
        now = time.time()
        if phase == getattr(self, '_last_phase', None) and extra.get('completed') != extra.get('total') and now - getattr(self, '_last_status', 0) < .1:
            return
        self._last_phase, self._last_status = phase, now
        atomic(self.work / 'status.json', dict(phase=phase, **extra))

    def save(self, phase):
        self.journal['phase'] = phase
        atomic(self.work / 'journal.json', self.journal)

    def canceled(self):
        if (self.work / 'cancel').exists():
            raise InterruptedError('Native update canceled; the old application remains installed')

    def run_installer(self):
        fd = sealed_asset(self.work, self.installer)
        command = ['/usr/bin/python3', '-I', '/proc/self/fd/' + str(fd), '--base-image', str(self.base), '--install-root', str(self.base.parent.parent), '--progress-json']
        stderr = (self.work / 'installer-error.log').open('wb')
        child = subprocess.Popen(command, pass_fds=[fd], stdout=subprocess.PIPE, stderr=stderr, start_new_session=True)
        os.close(fd)
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        buffer = b''
        staged = False
        deadline = time.monotonic() + 1800
        try:
            while child.poll() is None or selector.get_map():
                self.canceled()
                if time.monotonic() > deadline:
                    raise RuntimeError('Native installer staging timed out')
                for key, _ in selector.select(.1):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj); continue
                    buffer += chunk
                    while b'\n' in buffer:
                        line, buffer = buffer.split(b'\n', 1)
                        value = json.loads(line)
                        if value.get('phase') == 'staged':
                            if value.get('image') != str(self.target) or value.get('build') != self.manifest['build']:
                                raise RuntimeError('Installer staged the wrong image')
                            staged = True
                        else:
                            self.status(**value)
                    if len(buffer) > 65536:
                        raise RuntimeError('Oversized installer progress record')
            if child.wait() != 0 or not staged:
                stderr.flush()
                detail = (self.work / 'installer-error.log').read_text(errors='replace')[-4000:]
                raise RuntimeError('Native installer failed: ' + detail)
        finally:
            selector.close(); stderr.close()
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    raise RuntimeError('Installer authorization is still running; no activation was performed')

    def wait_old_exit(self):
        self.status('staged', image=str(self.target), build=self.manifest['build'])
        deadline = time.monotonic() + 600
        while not (self.work / 'activate').exists():
            self.canceled()
            if process_identity(self.request['oldPid']) != self.request['oldStartTime']:
                raise InterruptedError('Old application exited before update approval')
            if time.monotonic() > deadline:
                raise InterruptedError('Restart approval timed out')
            time.sleep(.1)
        self.status('waiting-exit')
        deadline = time.monotonic() + 90
        while process_identity(self.request['oldPid']) == self.request['oldStartTime'] or profile_processes(self.profile):
            self.canceled()
            if time.monotonic() > deadline:
                raise InterruptedError('The application did not exit normally. Update was not activated.')
            time.sleep(.1)

    def backup_and_activate(self):
        with self.profile_mutation():
            self._backup_and_activate_locked()

    def _backup_and_activate_locked(self):
        if profile_processes(self.profile):
            raise RuntimeError('Another instance owns this profile')
        self.save('backing-up')
        self.status('backing-up')
        backup_root = Path(tempfile.mkdtemp(prefix='.welink-update-' + self.work.name + '-', dir=self.profile.parent))
        self.backup = backup_root / 'profile'
        self.journal['backup'] = str(self.backup)
        self.save('backing-up')
        def ignore(directory, names):
            return [name for name in names if Path(directory) == self.profile / 'runtime' and name in ('SingletonLock', 'SingletonSocket', 'SingletonCookie')]
        shutil.copytree(self.profile, self.backup, symlinks=True, ignore=ignore)
        # Commit the private backup before permitting new code to change schema.
        for directory, _, names in os.walk(self.backup, topdown=False, followlinks=False):
            for name in names:
                filename = Path(directory) / name
                if filename.is_symlink():
                    continue
                fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        if profile_processes(self.profile):
            raise RuntimeError('A new instance started during profile backup; activation was not performed')
        self.journal['profileStat'] = [self.profile.stat().st_dev, self.profile.stat().st_ino]
        self.journal['backupStat'] = [self.backup.stat().st_dev, self.backup.stat().st_ino]
        desktop_id = self.request['desktopId']
        if desktop_id not in DESKTOP_IDS:
            raise RuntimeError('Unsupported installed desktop identity')
        paths = [self.home / '.local/bin/hit-welink-native', self.home / '.local/share/applications' / desktop_id]
        if self.request.get('autostartFile'):
            paths.append(Path(self.request['autostartFile']))
        self.journal['files'] = [{'path': str(path), 'before': snapshot(path), 'installed': None} for path in paths]
        self.save('prepared')
        fd = sealed_asset(self.work, self.manifest['integration'])
        try:
            command = ['/usr/bin/python3', '-I', '/proc/self/fd/' + str(fd), '--image', str(self.target), '--profile', str(self.profile), '--preserve-defaults', '--desktop-id', desktop_id]
            if not self.systemd:
                command.append('--direct-launch')
            if self.request.get('autostartFile'):
                command.extend(['--previous-image', str(self.base), '--autostart-file', self.request['autostartFile']])
            planned = json.loads(subprocess.check_output([*command, '--plan'], pass_fds=[fd]))
            if [item.get('path') for item in planned] != [str(path) for path in paths]:
                raise RuntimeError('Signed integration plan has unexpected destinations')
            for item, expected in zip(self.journal['files'], planned):
                data = base64.b64decode(expected['data'], validate=True)
                if hashlib.sha256(data).hexdigest() != expected['sha256']:
                    raise RuntimeError('Invalid integration plan hash')
                item['installed'] = {key: expected[key] for key in ('data', 'mode', 'sha256')}
                if snapshot(Path(item['path'])) != item['before']:
                    raise RuntimeError('Integration changed during activation planning')
            self.save('activating')
            subprocess.run(command, pass_fds=[fd], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        finally:
            os.close(fd)
        for item in self.journal['files']:
            if snapshot(Path(item['path'])) != item['installed']:
                raise RuntimeError('Desktop activation differs from the signed integration plan')
        self.save('activated')

    def launch(self, image, receipt=False):
        environment = dict(os.environ, HOME=str(self.home), PATH='/usr/bin:/bin', WELINK_NATIVE_PROFILE_DIR=str(self.profile))
        for name in list(environment):
            if name.startswith(('WELINK_NATIVE_UPDATE_', 'NODE_', 'LD_', 'OPENSSL_', 'PYTHON')) or name in ('ELECTRON_RUN_AS_NODE', 'WELINK_NATIVE_PROFILE_GATE_FD'):
                environment.pop(name)
        if receipt:
            environment.update(WELINK_NATIVE_UPDATE_DIR=str(self.work), WELINK_NATIVE_UPDATE_TOKEN=self.request['token'])
        command = [str(image / 'launch-welink')]
        log = (self.work / ('new-startup.log' if receipt else 'rollback-startup.log')).open('ab')
        try:
            if self.systemd:
                unit = self.unit if receipt else self.unit.replace('new-', 'rollback-')
                unset = set(UNSAFE_ENVIRONMENT)
                unset.update(name for name in os.environ if name.startswith(('NODE_', 'LD_', 'OPENSSL_', 'PYTHON')))
                if not receipt:
                    unset.update(('WELINK_NATIVE_UPDATE_DIR', 'WELINK_NATIVE_UPDATE_TOKEN'))
                command = ['systemd-run', '--user', '--quiet', '--collect', '--unit=' + unit,
                           '--property=Type=exec', '--property=SendSIGKILL=no', '--property=TimeoutStopSec=15',
                           '--working-directory=' + str(self.home),
                           *['--setenv=' + name + '=' + environment.get(name, '') for name in SESSION_ENVIRONMENT],
                           *['--setenv=' + name + '=' + environment[name] for name in ('WELINK_NATIVE_PROFILE_DIR', 'WELINK_NATIVE_UPDATE_DIR', 'WELINK_NATIVE_UPDATE_TOKEN') if name in environment],
                           '--property=UnsetEnvironment=' + ' '.join(sorted(unset)),
                           '--', *command]
                subprocess.run(command, env=environment, stdout=log, stderr=log, check=True)
            else:
                child = subprocess.Popen(command, env=environment, stdout=log, stderr=log, start_new_session=True)
                if receipt:
                    self.child = child
        finally:
            log.close()

    def wait_readiness(self):
        self.status('starting')
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            receipt = self.work / 'readiness.json'
            if receipt.exists():
                value = json.loads(file_bytes(receipt, 16384))
                readiness(value, self.request['token'], self.manifest['build'], self.target, self.profile)
                return
            if self.child and self.child.poll() is not None:
                raise RuntimeError('The new application exited before becoming ready')
            time.sleep(.2)
        raise RuntimeError('The new application did not reach a working login/message route within 120 seconds')

    def stop_new(self):
        # Ask the application's real renderer exit provider first. Never kill the
        # old app; only this transaction's failed new launch may be terminated.
        atomic(self.work / 'stop-request.json', {'token': self.request['token']})
        deadline = time.monotonic() + 15
        while profile_processes(self.profile) and time.monotonic() < deadline:
            time.sleep(.2)
        if profile_processes(self.profile):
            if self.systemd:
                subprocess.run(['systemctl', '--user', 'stop', self.unit], timeout=20, check=False)
            elif self.child and self.child.poll() is None:
                os.killpg(self.child.pid, signal.SIGTERM)
                try:
                    self.child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    pass
        if profile_processes(self.profile):
            raise RuntimeError('A live application still owns the profile. Backup retained; refusing unsafe rollback.')

    def rollback(self):
        self.stop_new()
        with self.profile_mutation():
            self._restore_profile_and_integration_locked()
        self.launch(self.base)

    def _restore_profile_and_integration_locked(self):
        for item in self.journal['files']:
            current = snapshot(Path(item['path']))
            if current != item['before'] and current != item['installed']:
                raise RuntimeError('Desktop integration changed outside the update; rollback requires review')
        failed = self.backup.parent / 'failed-profile'
        # The inode journal makes both rename crash windows recoverable without
        # overwriting an unrelated profile. Backups share the profile filesystem.
        if self.profile.exists() and self.backup.exists():
            if [self.profile.stat().st_dev, self.profile.stat().st_ino] != self.journal['profileStat'] or failed.exists():
                raise RuntimeError('Profile was replaced by another owner; backup retained without overwriting it')
            self.save('rolling-back')
            self.profile.rename(failed)
        if not self.profile.exists() and self.backup.exists() and failed.is_dir():
            self.backup.rename(self.profile)
            self.journal['restoredStat'] = [self.profile.stat().st_dev, self.profile.stat().st_ino]
            self.save('restoring-integration')
        elif not self.backup.exists():
            expected = self.journal.get('restoredStat') or self.journal.get('backupStat')
            if not self.profile.is_dir() or [self.profile.stat().st_dev, self.profile.stat().st_ino] != expected:
                raise RuntimeError('The restored profile identity differs; recovery stopped')
        else:
            raise RuntimeError('Incomplete profile recovery state; backup retained')
        for item in reversed(self.journal['files']):
            if snapshot(Path(item['path'])) != item['before']:
                restore_file(Path(item['path']), item['before'], item['installed'])
        self.save('rolled-back')

    def recover(self):
        journal = json.loads(file_bytes(self.work / 'journal.json', 1024 * 1024))
        if journal.get('profile') != str(self.profile) or journal.get('base') != str(self.base) or journal.get('target') != str(self.target):
            raise RuntimeError('Recovery journal does not match the signed transaction')
        if journal.get('phase') in ('complete', 'rolled-back'):
            raise RuntimeError('This transaction is already complete; refusing to restore a stale profile backup')
        self.journal = journal
        if profile_processes(self.profile):
            raise RuntimeError('Exit the application normally before recovering this transaction')
        if journal.get('profileStat') and journal.get('backup'):
            self.backup = Path(journal['backup'])
            private(self.backup.parent)
            if self.backup.parent.parent != self.profile.parent:
                raise RuntimeError('Recovery backup is outside the profile filesystem transaction')
            self.rollback()
        else:
            # Only an incomplete backup/staging exists; no new code touched the
            # profile. Keep it intact and restore no files.
            self.save('rolled-back')
            self.launch(self.base)
        self.status('recovered', build=json.loads((self.base / 'resources/app/native/build.json').read_text())['build'])

    def run(self):
        self.save('staging')
        activated = False
        try:
            self.run_installer()
            self.wait_old_exit()
            activated = True
            # Reverify the staged inventory after approval and immediately before
            # activation, using the same sealed, signature-verified installer.
            self.run_installer()
            self.backup_and_activate()
            self.save('starting')
            self.launch(self.target, receipt=True)
            self.wait_readiness()
            self.save('complete')
            self.status('complete', build=self.manifest['build'])
            # Backup remains private for deliberate rollback, never published.
        except BaseException as error:
            detail = str(error)
            if activated and self.journal.get('profileStat'):
                try:
                    self.rollback()
                    detail += '\nThe previous integration and profile were restored; launch of the old version was requested.'
                except BaseException as recovery:
                    detail += '\nRollback stopped safely: ' + str(recovery) + '\nPrivate recovery data: ' + str(self.work)
            elif activated and not profile_processes(self.profile):
                self.launch(self.base)
                detail += '\nLaunch of the old application was requested; activation never began.'
            self.status('canceled' if isinstance(error, InterruptedError) and not activated else 'failed', error=detail)
            # A normal desktop notification, not a manufactured app receipt.
            if shutil.which('notify-send'):
                subprocess.run(['notify-send', '--urgency=critical', 'WeLink native update failed', detail], check=False)
            raise


def main():
    if len(sys.argv) >= 3 and sys.argv[1] in ('--launch-profile-gate', '--check-profile-gate'):
        launcher_profile_gate(sys.argv[1:])
        return
    if os.geteuid() == 0:
        raise RuntimeError('Native update supervision must run as the desktop user')
    os.umask(0o077)
    os.environ['PATH'] = '/usr/bin:/bin'
    for name in list(os.environ):
        if name in UNSAFE_ENVIRONMENT or name.startswith(('NODE_', 'LD_', 'OPENSSL_', 'PYTHON')):
            os.environ.pop(name, None)
    def interrupted(_signal, _frame):
        raise InterruptedError('Native update supervisor was interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    work = Path(sys.argv[1]).absolute()
    transaction = None
    try:
        recovering = len(sys.argv) == 3 and sys.argv[2] == '--recover'
        transaction = Transaction(work, recovering=recovering)
        transaction.recover() if recovering else transaction.run()
    except BaseException as error:
        if transaction is None and work.is_dir():
            private(work)
            atomic(work / 'status.json', {'phase': 'failed', 'error': str(error)})
        raise


if __name__ == '__main__':
    main()
