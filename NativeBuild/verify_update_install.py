#!/usr/bin/env python3
"""Regression for restrictive legacy image modes and retained desktop identity.

Run as root in a development environment with gio/xprop/systemd-run installed.
Only fresh synthetic HOME/image directories are written. No application starts.
"""
import importlib.util
import json
import os
from pathlib import Path
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
        print(json.dumps({'passed': True, 'legacyModesNormalizedOnlyInNewImage': True,
                          'suidHardlinkPreserved': True, 'profileUnchanged': True,
                          'desktopIdentityRetained': legacy_id, 'unrelatedDefaultPreserved': True}))


if __name__ == '__main__':
    main()
