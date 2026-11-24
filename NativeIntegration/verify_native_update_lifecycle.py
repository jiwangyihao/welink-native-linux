#!/usr/bin/env python3
"""Parent-run deterministic filesystem/process recovery regressions; no account data."""
import ast
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_update_supervisor', Path(__file__).with_name('update_supervisor.py'))
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='welink-update-lifecycle-')
        self.root = Path(self.temporary.name)
        self.work = self.root / 'transaction'
        self.work.mkdir(mode=0o700)
        self.profile = self.root / 'profile'
        self.profile.mkdir(mode=0o700)
        (self.profile / 'database').write_text('old-schema-and-user-data')
        backup_root = self.root / '.profile-backup'
        backup_root.mkdir(mode=0o700)
        self.backup = backup_root / 'profile'
        shutil.copytree(self.profile, self.backup)
        self.base = self.root / 'old/image'
        self.base.mkdir(parents=True)
        launch = self.base / 'launch-welink'
        launch.write_text('#!/bin/sh\nprintf reopened > ' + str(self.root / 'old-launched') + '\n')
        launch.chmod(0o755)
        build = self.base / 'resources/app/native'
        build.mkdir(parents=True)
        (build / 'build.json').write_text(json.dumps({'build': 'hit-native-linux-ia32-r45.11'}))
        self.target = self.root / 'new/image'
        self.target.mkdir(parents=True)
        self.integration = self.root / 'launcher'
        self.integration.write_text('old-launcher')
        before = supervisor.snapshot(self.integration)
        self.integration.write_text('new-launcher')
        installed = supervisor.snapshot(self.integration)
        (self.profile / 'database').write_text('new-schema-mutated')
        # These are private synthetic trees. The production methods, process
        # checks, journal, renames and compare-and-restore logic are unchanged.
        self.tx = supervisor.Transaction.__new__(supervisor.Transaction)
        self.tx.work, self.tx.profile, self.tx.backup = self.work, self.profile, self.backup
        self.tx.base, self.tx.target, self.tx.home = self.base, self.target, self.root
        self.tx.systemd, self.tx.child, self.tx.unit = False, None, 'isolated-regression.service'
        self.tx.apm_package = None
        self.tx.request = {'token': 'a' * 64, 'oldPid': 99999999, 'oldStartTime': '0'}
        self.tx.manifest = {'build': 'hit-native-linux-ia32-r45.12'}
        self.tx.journal = {'phase': 'starting', 'profile': str(self.profile), 'base': str(self.base), 'target': str(self.target),
                           'profileStat': [self.profile.stat().st_dev, self.profile.stat().st_ino],
                           'backupStat': [self.backup.stat().st_dev, self.backup.stat().st_ino], 'backup': str(self.backup),
                           'files': [{'path': str(self.integration), 'before': before, 'installed': installed}]}
        self.tx.save('starting')
        self.spawned = []
        original_popen = subprocess.Popen
        def tracked_popen(*args, **kwargs):
            child = original_popen(*args, **kwargs)
            self.spawned.append((child, kwargs.get('start_new_session', False)))
            return child
        self.spawn_patch = patch.object(subprocess, 'Popen', tracked_popen)
        self.spawn_patch.start()
        self.addCleanup(self.spawn_patch.stop)

    def tearDown(self):
        for child, own_session in self.spawned:
            if child.poll() is None:
                if own_session:
                    os.killpg(child.pid, 15)
                else:
                    child.terminate()
            child.wait(timeout=5)
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream:
                    stream.close()
        self.temporary.cleanup()

    def assert_restored(self):
        self.assertEqual((self.profile / 'database').read_text(), 'old-schema-and-user-data')
        self.assertEqual(self.integration.read_text(), 'old-launcher')
        self.assertEqual((self.backup.parent / 'failed-profile/database').read_text(), 'new-schema-mutated')
        deadline = time.monotonic() + 3
        while not (self.root / 'old-launched').exists() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual((self.root / 'old-launched').read_text(), 'reopened')

    def wait_file(self, filename, child):
        deadline = time.monotonic() + 5
        while not filename.exists():
            if child.poll() is not None:
                self.fail('Startup contender exited before its receipt: ' + child.stderr.read().decode(errors='replace'))
            if time.monotonic() >= deadline:
                self.fail('Timed out waiting for actual startup contender: ' + str(filename))
            time.sleep(.01)

    def start_profile_process(self, executable, marked=False):
        # A copied multicall coreutils binary dispatches by argv[0] and is not
        # a portable sleeper when renamed to electron/worker. Use the running
        # Python executable and a real pipe handshake before process inspection.
        shutil.copyfile(sys.executable, executable)
        executable.chmod(0o755)
        environment = dict(os.environ)
        if marked:
            environment['WELINK_NATIVE_PROFILE_DIR'] = str(self.profile)
        child = subprocess.Popen([str(executable), '-I', '-c',
            'import sys; print("fixture-started", flush=True); sys.stdin.read(1)'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, env=environment)
        self.assertEqual(child.stdout.readline(), b'fixture-started\n')
        return child

    def start_node_contender(self, label):
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Node is required for the real JavaScript startup-gate regression')
        helper = Path(__file__).with_name('update_profile_gate.js').resolve()
        attempted, entered = self.root / (label + '-attempted'), self.root / (label + '-entered.json')
        script = (
            "const fs=require('fs');\n"
            "fs.writeFileSync(" + json.dumps(str(attempted)) + ",'attempting');\n"
            "const gate=require(" + json.dumps(str(helper)) + ").acquireProfileGate({profile:" + json.dumps(str(self.profile)) + "});\n"
            "fs.writeFileSync(" + json.dumps(str(entered)) + ",JSON.stringify({inode:fs.statSync(gate.profileRoot,{bigint:true}).ino.toString(),"
            "data:fs.readFileSync(gate.profileRoot+'/database','utf8'),fdOpen:fs.fstatSync(gate.fd).isFile()}));\n"
            "process.stdin.resume();\n"
        )
        child = subprocess.Popen([node, '-e', script], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE, start_new_session=True,
                                 env=dict(os.environ, WELINK_NATIVE_PROFILE_DIR=str(self.profile)))
        self.wait_file(attempted, child)
        return child, entered

    def test_contender_after_final_process_scan_blocks_rollback(self):
        original_stop = self.tx.stop_new
        child = None
        entered = None
        def stop_then_start_contender():
            nonlocal child, entered
            original_stop()  # The real final process scan has already passed.
            child, entered = self.start_node_contender('between-scan-and-rename')
            self.wait_file(entered, child)
        inode = self.profile.stat().st_ino
        with patch.object(self.tx, 'stop_new', side_effect=stop_then_start_contender):
            with self.assertRaisesRegex(RuntimeError, 'profile startup gate'):
                self.tx.rollback()
        self.assertIsNone(child.poll(), 'An admitted normal launch must not be terminated by rollback')
        receipt = json.loads(entered.read_text())
        self.assertTrue(receipt['fdOpen'])
        self.assertEqual(receipt['inode'], str(inode))
        self.assertEqual(self.profile.stat().st_ino, inode, 'A live profile directory was moved')
        self.assertEqual((self.profile / 'database').read_text(), 'new-schema-mutated')
        self.assertEqual(self.integration.read_text(), 'new-launcher')
        self.assertTrue(self.backup.exists())

    def test_shared_startup_gate_lasts_until_actual_contender_exit(self):
        child, entered = self.start_node_contender('lifetime')
        self.wait_file(entered, child)  # flock(1) already returned to Node.
        with self.assertRaisesRegex(RuntimeError, 'profile startup gate'):
            with self.tx.profile_mutation():
                self.fail('An updater entered a live application profile')
        os.killpg(child.pid, 15)
        child.wait(timeout=5)
        with self.tx.profile_mutation():
            self.assertTrue(self.profile.is_dir())

    def test_backup_copy_holds_exclusive_gate_and_releases_on_failure(self):
        original_copy = shutil.copytree
        class StopAfterCopy(Exception):
            pass
        def copy_under_gate(source, destination, **kwargs):
            probe = supervisor.open_profile_gate(self.profile)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)
            finally:
                os.close(probe)
            original_copy(source, destination, **kwargs)
            raise StopAfterCopy()
        with patch.object(supervisor.shutil, 'copytree', side_effect=copy_under_gate):
            with self.assertRaises(StopAfterCopy):
                self.tx.backup_and_activate()
        probe = supervisor.open_profile_gate(self.profile)
        try:
            fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)
        finally:
            os.close(probe)
        self.assertEqual((self.profile / 'database').read_text(), 'new-schema-mutated')

    def test_forged_closed_inherited_descriptor_cannot_be_reused(self):
        closed = os.open('/dev/null', os.O_RDONLY)
        os.close(closed)
        with self.assertRaises(OSError):
            supervisor.launcher_profile_gate(['--check-profile-gate', str(self.profile), str(closed)])
        self.assertEqual((self.profile / 'database').read_text(), 'new-schema-mutated')

    def test_real_launcher_gates_before_any_profile_write_and_through_exec(self):
        # Execute the actual generated launcher text against an isolated fixture
        # image. Only the terminal Electron/Gdk executables are fixture programs;
        # the launcher, Python gate and inherited-FD protocol are the real code.
        source = Path(__file__).resolve().parents[1] / 'NativeBuild/assemble_app.py'
        tree = ast.parse(source.read_text())
        launcher_text = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                             and any(isinstance(target, ast.Name) and target.id == 'LAUNCHER' for target in node.targets))
        native = self.base / 'resources/app/native'
        (native / 'lib/pixbuf-loaders').mkdir(parents=True)
        (native / 'lib/sqlite_plugin.dll.so').write_bytes(b'fixture checker')
        (native / 'libexec').mkdir()
        query = native / 'libexec/gdk-pixbuf-query-loaders'
        query.write_text('#!/bin/sh\nprintf "fixture registry\\n"\n')
        query.chmod(0o755)
        shutil.copyfile(Path(supervisor.__file__), native / 'update_supervisor.py')
        launcher = native / 'launch-welink'
        launcher.write_text(launcher_text)
        launcher.chmod(0o755)
        entered = self.root / 'launcher-entered'
        terminal = self.base / 'electron'
        terminal.write_text('#!/bin/sh\nprintf entered > ' + str(entered) + '\nexec /bin/sleep 30\n')
        terminal.chmod(0o755)
        profile = self.root / 'never-created-before-gate'
        exclusive = supervisor.open_profile_gate(profile)
        fcntl.flock(exclusive, fcntl.LOCK_EX)
        environment = dict(os.environ, HOME=str(self.root / 'different-home'), WELINK_NATIVE_PROFILE_DIR=str(profile))
        environment.pop('WELINK_NATIVE_PROFILE_GATE_FD', None)
        child = subprocess.Popen(['/usr/bin/bash', str(launcher)], env=environment, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
        try:
            deadline = time.monotonic() + 5
            while b'--launch-profile-gate' not in (Path('/proc') / str(child.pid) / 'cmdline').read_bytes():
                if child.poll() is not None or time.monotonic() >= deadline:
                    self.fail('The real launcher did not reach its pre-write gate')
                time.sleep(.01)
            self.assertFalse(profile.exists(), 'Launcher wrote profile data before acquiring its gate')
            self.assertFalse(entered.exists())
        finally:
            os.close(exclusive)
        self.wait_file(entered, child)
        self.assertEqual((profile / '.welink-native-profile').read_text(), 'welink-native-profile-v1\n')
        self.assertEqual((profile / 'gdk-pixbuf-loaders.cache').read_text(), 'fixture registry\n')
        probe = supervisor.open_profile_gate(profile)
        try:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(probe)
        os.killpg(child.pid, 15)
        child.wait(timeout=5)
        probe = supervisor.open_profile_gate(profile)
        try:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(probe)

    def test_new_and_rollback_services_receive_explicit_session_environment(self):
        scene = {
            'HOME': str(self.root), 'PATH': '/custom/session/bin', 'DISPLAY': ':123',
            'WAYLAND_DISPLAY': 'wayland-session', 'XAUTHORITY': str(self.root / 'auth'),
            'XDG_RUNTIME_DIR': str(self.root / 'runtime'), 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=' + str(self.root / 'bus'),
            'LANG': 'zh_CN.UTF-8', 'LC_ALL': 'C.UTF-8', 'XDG_CONFIG_HOME': str(self.root / 'config'),
            'XDG_DATA_HOME': str(self.root / 'data'), 'XDG_CACHE_HOME': str(self.root / 'cache'),
            'XDG_STATE_HOME': str(self.root / 'state'), 'XDG_CONFIG_DIRS': '/session/config:/etc/xdg',
            'XDG_DATA_DIRS': '/session/data:/usr/share', 'NODE_OPTIONS': '--require=/untrusted',
            'LD_PRELOAD': '/untrusted.so', 'OPENSSL_CONF': '/untrusted.cnf', 'PYTHONPATH': '/untrusted',
            'WELINK_NATIVE_PROFILE_GATE_FD': '999', 'WELINK_NATIVE_UPDATE_DIR': '/stale',
            'WELINK_NATIVE_UPDATE_TOKEN': 'stale'
        }
        self.tx.systemd = True
        for receipt in (True, False):
            with self.subTest(receipt=receipt), patch.dict(os.environ, scene, clear=True), patch.object(supervisor.subprocess, 'run') as started:
                self.tx.launch(self.target if receipt else self.base, receipt=receipt)
                arguments = started.call_args.args[0]
                for name in supervisor.SESSION_ENVIRONMENT:
                    expected = '/usr/bin:/bin' if name == 'PATH' else scene[name]
                    self.assertIn('--setenv=' + name + '=' + expected, arguments)
                self.assertIn('--setenv=WELINK_NATIVE_PROFILE_DIR=' + str(self.profile), arguments)
                unset = next(value.split('=', 2)[2].split() for value in arguments if value.startswith('--property=UnsetEnvironment='))
                for name in supervisor.UNSAFE_ENVIRONMENT:
                    self.assertIn(name, unset)
                    self.assertNotIn(name, started.call_args.kwargs['env'])
                if receipt:
                    self.assertIn('--setenv=WELINK_NATIVE_UPDATE_DIR=' + str(self.work), arguments)
                    self.assertIn('--setenv=WELINK_NATIVE_UPDATE_TOKEN=' + self.tx.request['token'], arguments)
                else:
                    self.assertIn('WELINK_NATIVE_UPDATE_DIR', unset)
                    self.assertIn('WELINK_NATIVE_UPDATE_TOKEN', unset)

    def test_foreign_trust_root_rejected_before_install_or_recovery(self):
        # A genuinely valid transaction under an attacker's DIFFERENT key,
        # not malformed metadata. Run the real supervisor from a separate
        # installed-image layout; its own public key must remain authoritative.
        trusted_native = self.base / 'resources/app/native'
        installed_script = trusted_native / 'update_supervisor.py'
        shutil.copyfile(Path(supervisor.__file__), installed_script)
        foreign_image = self.root / 'foreign/image'
        foreign_native = foreign_image / 'resources/app/native'
        (foreign_native / 'lib').mkdir(parents=True)
        (foreign_native / 'build.json').write_text(json.dumps({'build': 'hit-native-linux-ia32-r45.11'}))
        checker = b'foreign baseline checker'
        (foreign_native / 'lib/sqlite_plugin.dll.so').write_bytes(checker)
        keys = []
        for label, native in (('trusted', trusted_native), ('foreign', foreign_native)):
            private_key = self.root / (label + '-private.pem')
            public_key = native / 'update_public_key.pem'
            subprocess.run(['/usr/bin/openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(private_key)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            subprocess.run(['/usr/bin/openssl', 'pkey', '-in', str(private_key), '-pubout', '-out', str(public_key)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            keys.append((private_key, public_key))
        self.assertNotEqual(keys[0][1].read_bytes(), keys[1][1].read_bytes())
        marker = self.root / 'foreign-code-executed'
        foreign_target = foreign_image.parent.parent / 'hit-welink-native-r45.12/image'
        payload = ('from pathlib import Path\nimport json\n'
                   'Path(' + repr(str(marker)) + ').write_text("foreign installer ran")\n'
                   'print(json.dumps(' + repr({'phase': 'staged', 'image': str(foreign_target),
                                               'build': 'hit-native-linux-ia32-r45.12'}) + '), flush=True)\n').encode()
        asset_name = 'install-r45.12-from-r45.11.py'
        (self.work / asset_name).write_bytes(payload)
        (self.work / 'install_desktop.py').write_bytes(payload)
        launcher = foreign_image / 'launch-welink'
        launcher.write_text('#!/bin/sh\nprintf foreign-launch > ' + str(marker) + '\n')
        launcher.chmod(0o755)
        descriptor = {'asset': asset_name, 'size': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}
        manifest = {
            'format': 1, 'version': 'r45.12', 'build': 'hit-native-linux-ia32-r45.12', 'sourceCommit': 'a' * 40,
            'installers': [dict(descriptor, base='hit-native-linux-ia32-r45.11',
                                baseCheckerSha256=hashlib.sha256(checker).hexdigest())],
            'integration': dict(descriptor, asset='install_desktop.py')
        }
        manifest_file = self.work / 'native-update.json'
        manifest_file.write_text(json.dumps(manifest))
        signature_file = self.work / 'signature.bin'
        subprocess.run(['/usr/bin/openssl', 'pkeyutl', '-sign', '-rawin', '-inkey', str(keys[1][0]),
                        '-in', str(manifest_file), '-out', str(signature_file)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        (self.work / 'native-update.sig').write_bytes(base64.b64encode(signature_file.read_bytes()) + b'\n')
        subprocess.run(['/usr/bin/openssl', 'pkeyutl', '-verify', '-rawin', '-pubin', '-inkey', str(keys[1][1]),
                        '-in', str(manifest_file), '-sigfile', str(signature_file)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        request = dict(self.tx.request, baseImage=str(foreign_image), profile=str(self.profile),
                       systemd=False, desktopId='hit-welink-native.desktop')
        supervisor.atomic(self.work / 'request.json', request)
        supervisor.atomic(self.work / 'journal.json', {
            'phase': 'staging', 'profile': str(self.profile), 'base': str(foreign_image),
            'target': str(foreign_target), 'files': []
        })
        installed_spec = importlib.util.spec_from_file_location('installed_supervisor_regression', installed_script)
        installed = importlib.util.module_from_spec(installed_spec)
        installed_spec.loader.exec_module(installed)
        self.assertEqual(installed.installed_image(), self.base)
        # The verifier itself also derives its key from __file__; no caller can
        # pass the foreign image into the final signature-verification boundary.
        with self.assertRaises(subprocess.CalledProcessError):
            installed.signed_manifest(self.work)
        journal_before = (self.work / 'journal.json').read_bytes()
        profile_before = (self.profile / 'database').read_bytes()
        integration_before = self.integration.read_bytes()
        for recovering in (False, True):
            with self.subTest(recovering=recovering):
                with self.assertRaisesRegex(RuntimeError, 'baseline differs from the supervisor installed image'):
                    transaction = installed.Transaction(self.work, recovering=recovering)
                    transaction.recover() if recovering else transaction.run()
                self.assertFalse(marker.exists(), 'Foreign installer/launcher code must never execute')
                self.assertEqual((self.work / 'journal.json').read_bytes(), journal_before)
                self.assertEqual((self.profile / 'database').read_bytes(), profile_before)
                self.assertEqual(self.integration.read_bytes(), integration_before)

    def test_failed_start_restores_profile_before_relaunch(self):
        self.tx.rollback()
        self.assert_restored()
        self.assertEqual(json.loads((self.work / 'journal.json').read_text())['phase'], 'rolled-back')

    def test_other_integration_edit_is_never_overwritten(self):
        self.integration.write_text('later-user-edit')
        with self.assertRaisesRegex(RuntimeError, 'outside the update'):
            self.tx.rollback()
        self.assertEqual(self.integration.read_text(), 'later-user-edit')
        self.assertEqual((self.profile / 'database').read_text(), 'new-schema-mutated')
        self.assertTrue(self.backup.is_dir())

    def test_different_profile_inode_is_never_restored_over(self):
        self.profile.rename(self.root / 'somebody-elses-profile')
        self.profile.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'another owner'):
            self.tx.rollback()
        self.assertTrue(self.backup.is_dir())
        self.assertEqual(self.integration.read_text(), 'new-launcher')

    def interrupt_and_recover_integration_replace(self, window):
        desktop = self.root / 'desktop-entry'
        entries = []
        for filename, before_text, installed_text, mode in (
                (self.integration, 'old-launcher', 'new-launcher', 0o755),
                (desktop, 'old-desktop-entry', 'new-desktop-entry', 0o644)):
            filename.write_text(before_text)
            filename.chmod(mode)
            before = supervisor.snapshot(filename)
            filename.write_text(installed_text)
            filename.chmod(mode)
            entries.append({'path': str(filename), 'before': before, 'installed': supervisor.snapshot(filename)})
        self.tx.journal['files'] = entries
        self.tx.save('starting')
        state = {name: str(getattr(self.tx, name)) for name in ('work', 'profile', 'backup', 'base', 'target', 'home')}
        state.update(request=self.tx.request, manifest=self.tx.manifest, integration=str(self.integration))
        # The real rollback first restores the profile, then restores the two
        # integration files in reverse order. Abrupt process exit deliberately
        # bypasses finally cleanup at the launcher's os.replace boundary.
        program = r"""
import importlib.util,json,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('crash_supervisor',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
state=json.loads(sys.argv[2])
transaction=module.Transaction.__new__(module.Transaction)
for name in ('work','profile','backup','base','target','home'):
    setattr(transaction,name,Path(state[name]))
transaction.request=state['request']
transaction.manifest=state['manifest']
transaction.systemd=False
transaction.child=None
transaction.unit='isolated-rollback-crash.service'
transaction.journal=json.loads((transaction.work/'journal.json').read_text())
replace=os.replace
def interrupted_replace(source,destination):
    if Path(destination)==Path(state['integration']):
        if sys.argv[3]=='before':
            os._exit(91)
        replace(source,destination)
        os._exit(92)
    return replace(source,destination)
module.os.replace=interrupted_replace
os.umask(0o077)
transaction.rollback()
raise RuntimeError('The requested rollback interruption was not reached')
"""
        result = subprocess.run([sys.executable, '-I', '-c', program, str(Path(supervisor.__file__).resolve()),
                                 json.dumps(state), window], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(result.returncode, 91 if window == 'before' else 92, result.stderr.decode(errors='replace'))
        self.assertEqual((self.profile / 'database').read_text(), 'old-schema-and-user-data')
        self.assertEqual(supervisor.snapshot(desktop), entries[1]['before'],
                         '0644 must survive the child supervisor umask before a later interruption')
        if window == 'before':
            self.assertEqual(supervisor.snapshot(self.integration), entries[0]['installed'])
            self.assertTrue(list(self.integration.parent.glob('.native-rollback-' + self.integration.name + '*')),
                            'The abrupt pre-replace exit must leave an actual temporary file')
        else:
            self.assertEqual(supervisor.snapshot(self.integration), entries[0]['before'],
                             '0755 must match the complete journal snapshot immediately after replacement')
        previous_umask = os.umask(0o077)
        try:
            self.tx.recover()
        finally:
            os.umask(previous_umask)
        self.assert_restored()
        for entry in entries:
            self.assertEqual(supervisor.snapshot(Path(entry['path'])), entry['before'],
                             'Recovery must restore complete bytes, hash and mode under umask 077')
        self.assertEqual(json.loads((self.work / 'journal.json').read_text())['phase'], 'rolled-back')

    def test_recovery_replays_interruption_before_replace_under_private_umask(self):
        self.interrupt_and_recover_integration_replace('before')

    def test_recovery_replays_interruption_after_replace_under_private_umask(self):
        self.interrupt_and_recover_integration_replace('after')

    def test_removed_integration_entry_syncs_parent_directory(self):
        created = self.root / 'transaction-created-entry'
        created.write_text('installed by this transaction')
        installed = supervisor.snapshot(created)
        synchronized = []
        fsync = os.fsync
        def record_fsync(fd):
            synchronized.append(stat.S_ISDIR(os.fstat(fd).st_mode))
            return fsync(fd)
        with patch.object(supervisor.os, 'fsync', side_effect=record_fsync):
            supervisor.restore_file(created, None, installed)
        self.assertIsNone(supervisor.snapshot(created))
        self.assertIn(True, synchronized, 'Removing an updater-owned entry must fsync its parent directory')

    def test_recover_after_first_profile_rename(self):
        self.profile.rename(self.backup.parent / 'failed-profile')
        self.tx.save('rolling-back')
        self.tx.recover()
        self.assert_restored()

    def test_recover_after_second_profile_rename_before_journal(self):
        self.profile.rename(self.backup.parent / 'failed-profile')
        self.backup.rename(self.profile)
        self.tx.save('rolling-back')
        self.tx.recover()
        self.assert_restored()

    def test_recover_partial_integration_activation(self):
        # One planned file was never replaced; recovery restores only writes
        # matching this transaction, rather than overwriting unchanged files.
        self.integration.write_text('old-launcher')
        self.tx.save('activating')
        self.tx.recover()
        self.assert_restored()

    def test_completed_backup_cannot_erase_later_user_data(self):
        self.tx.save('complete')
        with self.assertRaisesRegex(RuntimeError, 'already complete'):
            self.tx.recover()
        self.assertEqual((self.profile / 'database').read_text(), 'new-schema-mutated')

    def test_cancel_before_exit_changes_no_profile_or_launcher(self):
        (self.work / 'cancel').touch()
        with self.assertRaises(InterruptedError):
            self.tx.wait_old_exit()
        self.assertEqual(self.integration.read_text(), 'new-launcher')
        self.assertEqual((self.profile / 'database').read_text(), 'new-schema-mutated')

    def test_no_approval_never_exits_old_process(self):
        self.tx.request.update(oldPid=os.getpid(), oldStartTime=supervisor.process_identity(os.getpid()))
        with patch.object(supervisor.time, 'monotonic', side_effect=[0, 601]):
            with self.assertRaisesRegex(InterruptedError, 'approval timed out'):
                self.tx.wait_old_exit()
        self.assertEqual(supervisor.process_identity(os.getpid()), self.tx.request['oldStartTime'])
        self.assertEqual(self.integration.read_text(), 'new-launcher')

    def test_sealed_executable_cannot_change_after_verification(self):
        data = b'print("only verified bytes")\n'
        asset = self.work / 'installer.py'
        asset.write_bytes(data)
        descriptor = {'asset': asset.name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        fd = supervisor.sealed_asset(self.work, descriptor)
        try:
            asset.write_bytes(b'changed source')
            self.assertEqual(os.read(fd, len(data)), data)
            with self.assertRaises(PermissionError):
                os.write(fd, b'x')
        finally:
            os.close(fd)
        with self.assertRaisesRegex(RuntimeError, 'changed before execution'):
            supervisor.sealed_asset(self.work, descriptor)

    def test_real_pid_alone_is_not_readiness(self):
        executable = self.target / 'electron'
        child = self.start_profile_process(executable)
        try:
            receipt = {'token': self.tx.request['token'], 'build': 'hit-native-linux-ia32-r45.12', 'profile': str(self.profile),
                       'pid': child.pid, 'startTime': supervisor.process_identity(child.pid), 'status': 'ready', 'route': '/login/LoadingFailed',
                       'mounted': True, 'httpExports': ['middleGroundAjax', 'middleGroundPost', 'downloadUpgradeFile', 'cancelDownloadUpgradeFile']}
            check = lambda value: supervisor.readiness(value, self.tx.request['token'], receipt['build'], self.target, self.profile)
            with self.assertRaisesRegex(RuntimeError, 'working login/message'):
                check(receipt)
            receipt['route'] = '/main/im'
            with self.assertRaisesRegex(RuntimeError, 'working login/message'):
                check(dict(receipt, httpExports=[]))
            with self.assertRaisesRegex(RuntimeError, 'another update/profile'):
                check(dict(receipt, token='wrong'))
            with self.assertRaisesRegex(RuntimeError, 'startup failed'):
                check(dict(receipt, status='failed', error='missing shared HTTP exports'))
            self.assertEqual(check(receipt), child.pid)
            self.assertEqual(check(dict(receipt, route='/login/WPFirstTimeAuthentication/empty')), child.pid)
            child.terminate(); child.wait()
            with self.assertRaisesRegex(RuntimeError, 'exited or was replaced'):
                check(receipt)
        finally:
            if child.poll() is None:
                child.terminate(); child.wait()

    def test_native_worker_remains_visible_outside_literal_image_directory(self):
        executable = self.root / 'custom-container/resources/app/native/libexec/worker'
        executable.parent.mkdir(parents=True)
        child = self.start_profile_process(executable, marked=True)
        try:
            self.assertIn(child.pid, supervisor.profile_processes(self.profile))
        finally:
            child.terminate()
            child.wait()

    def test_active_foreign_profile_process_blocks_rollback(self):
        executable = self.target / 'electron'
        child = self.start_profile_process(executable, marked=True)
        try:
            self.assertIn(child.pid, supervisor.profile_processes(self.profile))
            with patch.object(supervisor.time, 'monotonic', side_effect=[0, 16]):
                with self.assertRaisesRegex(RuntimeError, 'live application'):
                    self.tx.rollback()
            self.assertIsNone(child.poll(), 'Rollback must not terminate an unrelated instance')
            self.assertEqual((self.profile / 'database').read_text(), 'new-schema-mutated')
        finally:
            child.terminate(); child.wait()


if __name__ == '__main__':
    unittest.main()
