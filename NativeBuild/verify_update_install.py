#!/usr/bin/env python3
"""Regression for native SUID and APM namespace-sandbox update/desktop modes.

Run as root in a development environment with gio/xprop/systemd-run installed.
Only fresh synthetic HOME/image directories are written. No application starts.
"""
import importlib.util
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent


def main():
    if os.geteuid() != 0:
        raise SystemExit('Root is needed for the synthetic SUID-hardlink fixture')
    with tempfile.TemporaryDirectory(prefix='welink-update-modes-') as tmp:
        home = Path(tmp) / 'home with %'
        base = home / '.local/opt/hit-welink-native-r45.7/image'
        target = home / '.local/opt/hit-welink-native-r45.8/image'
        new = Path(tmp) / 'new'
        for image, version in ((base, 'r45.7'), (new, 'r45.8')):
            (image / 'resources/app/native').mkdir(parents=True)
            (image / 'resources/app/native/build.json').write_text(json.dumps({'build': 'hit-native-linux-ia32-' + version}))
            checker = image / 'resources/app/native/lib/sqlite_plugin.dll.so'
            checker.parent.mkdir()
            checker.write_bytes(('synthetic checker identity: ' + version).encode())
            for filename in ('LICENSE', 'electron', 'launch-welink', 'chrome-sandbox'):
                (image / filename).write_text('synthetic installer input: ' + filename)
                (image / filename).chmod(0o644 if filename == 'LICENSE' else 0o755)
            (image / 'chrome-sandbox').chmod(0o4755)
            icon = image / 'resources/app/pedestal/resources/icon/app.png'
            icon.parent.mkdir(parents=True)
            icon.write_bytes(b'synthetic icon metadata fixture')
        (base / 'LICENSE').chmod(0o600)
        (base / 'electron').chmod(0o700)
        profile = home / '.local/share/hit-welink-native/profile'
        profile.mkdir(parents=True)
        (profile / 'sentinel').write_bytes(b'unchanged account fixture')
        installer = Path(tmp) / 'install.py'
        subprocess.run([sys.executable, str(ROOT / 'package_update.py'), '--base-image', str(base), '--image', str(new),
                        '--output', str(installer), '--desktop-installer', str(ROOT / 'install_desktop.py')], check=True)
        subprocess.run([sys.executable, str(installer)], env=dict(os.environ, HOME=str(home)), check=True)
        assert stat.S_IMODE((base / 'LICENSE').stat().st_mode) == 0o600
        assert stat.S_IMODE((base / 'electron').stat().st_mode) == 0o700
        assert stat.S_IMODE((target / 'LICENSE').stat().st_mode) == 0o644
        assert stat.S_IMODE((target / 'electron').stat().st_mode) == 0o755
        assert (target / 'chrome-sandbox').samefile(base / 'chrome-sandbox')
        assert stat.S_IMODE((target / 'chrome-sandbox').stat().st_mode) == 0o4755
        assert (profile / 'sentinel').read_bytes() == b'unchanged account fixture'

        apm_root = home / '.local/opt/hit-welink-native-apm'
        apm_base = apm_root / base.parent.name / 'image'
        apm_target = apm_root / target.parent.name / 'image'
        shutil.copytree(base, apm_base)
        (apm_base / 'chrome-sandbox').chmod(0o755)
        apm_environment = dict(os.environ, HOME=str(home), WELINK_NATIVE_APM_PACKAGE='cn.edu.hit.welink.native.apm',
                               APM_PKG_NAME='cn.edu.hit.welink.native.apm', IS_ACE_ENV='1')
        command = [sys.executable, str(installer), '--base-image', str(apm_base), '--install-root', str(apm_root)]
        missing_backend = subprocess.run(command, env=apm_environment, capture_output=True)
        assert missing_backend.returncode != 0 and b'explicit --namespace-sandbox' in missing_backend.stderr
        assert not apm_target.exists()
        wrong_context = subprocess.run([*command, '--namespace-sandbox'], env=dict(apm_environment, APM_PKG_NAME='other.package'), capture_output=True)
        assert wrong_context.returncode != 0 and b'matching Amber PM' in wrong_context.stderr
        subprocess.run([*command, '--namespace-sandbox'], env=apm_environment, check=True)
        sandbox = apm_target / 'chrome-sandbox'
        assert sandbox.read_bytes() == (target / 'chrome-sandbox').read_bytes()
        assert not sandbox.samefile(apm_base / 'chrome-sandbox')
        assert sandbox.stat().st_uid == os.getuid() and stat.S_IMODE(sandbox.stat().st_mode) == 0o755
        sandbox.chmod(0o4755)
        wrong_mode = subprocess.run([*command, '--namespace-sandbox'], env=apm_environment, capture_output=True)
        assert wrong_mode.returncode != 0 and b'owner/mode differs' in wrong_mode.stderr
        sandbox.chmod(0o755)
        assert stat.S_IMODE((target / 'chrome-sandbox').stat().st_mode) == 0o4755

        spec = importlib.util.spec_from_file_location('desktop', ROOT / 'install_desktop.py')
        desktop = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(desktop)
        legacy_id = 'cn.edu.hit.welink.native.desktop'
        entry = home / '.local/share/applications' / legacy_id
        entry.parent.mkdir(parents=True)
        launcher = home / '.local/bin/hit-welink-native'
        entry.write_text('[Desktop Entry]\nType=Application\nName=WeLink (HIT Native)\nStartupWMClass=HIT APP\nTryExec=' + str(launcher) + '\nExec=' + str(launcher) + '\n')
        config = home / '.config'
        config.mkdir()
        (config / 'mimeapps.list').write_text('[Default Applications]\ntext/plain=keep-editor.desktop;\n')
        _, installed = desktop.install(target, home)
        assert installed == entry
        assert not (entry.parent / desktop.DESKTOP_ID).exists()
        assert 'text/plain=keep-editor.desktop;' in (config / 'mimeapps.list').read_text()
        environment = dict(os.environ, HOME=str(home), XDG_DATA_HOME=str(home / '.local/share'), XDG_CONFIG_HOME=str(config), LC_ALL='C')
        for scheme in desktop.SCHEMES:
            result = subprocess.check_output(['gio', 'mime', 'x-scheme-handler/' + scheme], env=environment, text=True)
            assert 'Default application for “x-scheme-handler/' + scheme + '”: ' + legacy_id in result or result.splitlines()[0].endswith(': ' + legacy_id)
        native_launcher = launcher.read_bytes()
        native_entry = entry.read_bytes()
        defaults = (config / 'mimeapps.list').read_bytes()
        apm_profile = home / '.local/share/hit-welink-native-apm/profile'
        apm_launcher, apm_entry = desktop.install(apm_target, home, apm_package=desktop.APM_PACKAGE)
        assert apm_launcher == home / '.local/bin/hit-welink-native-apm'
        assert apm_entry.name == 'cn.edu.hit.welink.native.apm.desktop'
        assert launcher.read_bytes() == native_launcher and entry.read_bytes() == native_entry
        assert (config / 'mimeapps.list').read_bytes() == defaults
        generated = apm_launcher.read_text()
        assert 'export WELINK_NATIVE_APM_PACKAGE=cn.edu.hit.welink.native.apm' in generated
        assert 'systemd-run' not in generated
        assert "'/usr/bin/apm', 'run', 'cn.edu.hit.welink.native.apm'" in generated
        assert 'exec "$image/launch-welink" "$@"' in generated
        assert str(apm_profile) in generated
        try:
            desktop.install(apm_target, home, profile=profile, apm_package=desktop.APM_PACKAGE)
        except ValueError as error:
            assert 'must not share' in str(error)
        else:
            raise AssertionError('APM accepted the native host profile')
        autostart_id = desktop.APM_PACKAGE + '-' + hashlib.sha256(os.fsencode(apm_profile)).hexdigest()[:16]
        autostart = config / 'autostart' / (autostart_id + '.desktop')
        autostart.parent.mkdir()
        autostart.write_text('[Desktop Entry]\nType=Application\nExec=/bin/bash -- ' +
            desktop.exec_argument(str(apm_launcher)) + '\nTryExec=' + desktop.desktop_value(str(apm_launcher)) +
            '\nX-WeLink-Native-Owner=' + autostart_id +
            '\nX-WeLink-Native-Profile=' + desktop.desktop_value(str(apm_profile)) +
            '\nX-WeLink-Native-APM-Package=' + desktop.APM_PACKAGE + '\nHidden=true\n')
        plan = desktop.install(apm_target, home, previous_image=apm_base, autostart_file=autostart,
                               apm_package=desktop.APM_PACKAGE, plan_only=True)
        assert [item['path'] for item in plan] == [str(apm_launcher), str(apm_entry), str(autostart)]
        assert base64.b64decode(plan[-1]['data']) == autostart.read_bytes()
        print(json.dumps({'passed': True, 'legacyModesNormalizedOnlyInNewImage': True,
                          'suidHardlinkPreserved': True, 'namespaceSandboxBytesAndModeVerified': True,
                          'apmContextRequired': True, 'apmDesktopAndProfileIsolated': True,
                          'apmAutostartPreserved': True, 'profileUnchanged': True,
                          'desktopIdentityRetained': legacy_id, 'unrelatedDefaultPreserved': True}))


if __name__ == '__main__':
    main()
