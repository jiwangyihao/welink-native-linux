#!/usr/bin/env python3
"""Isolated installer/namespace contract tests; no network or package installation."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipIf(os.getuid() == 0 or not Path.home().resolve().is_relative_to('/home'),
                 'Run installation-mode regressions as a desktop user beneath /home')
class InstallerVisibility(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='.welink-install-test.', dir=Path.home())
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / 'home'
        self.home.mkdir(mode=0o700)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.fixtures = self.root / 'fixtures'
        self.fixtures.mkdir()
        key = self.root / 'test-key.pem'
        public = self.root / 'test-public.pem'
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(key)], check=True, capture_output=True)
        subprocess.run(['openssl', 'pkey', '-in', str(key), '-pubout', '-out', str(public)], check=True, capture_output=True)
        self.script = self.root / 'install.sh'
        source = (ROOT / 'install.sh').read_text()
        source = source.replace((ROOT / 'NativeIntegration/update_public_key.pem').read_text().strip(), public.read_text().strip())
        self.script.write_text(source)
        packages = []
        for kind in ('deb', 'apm'):
            name = ('cn.edu.hit.welink.native_45.123-1_amd64.deb' if kind == 'deb' else
                    'cn.edu.hit.welink.native.apm_45.123-1-apm_amd64.deb')
            data = ('opaque namespace consumer input: ' + kind).encode()
            (self.fixtures / name).write_bytes(data)
            packages.append({'kind': kind, 'architecture': 'amd64', 'asset': name,
                             'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        manifest = self.fixtures / 'native-packages.json'
        manifest.write_text(json.dumps({'format': 1, 'version': 'r45.123', 'sourceCommit': 'a' * 40, 'packages': packages}))
        signature = self.root / 'signature.bin'
        subprocess.run(['openssl', 'pkeyutl', '-sign', '-rawin', '-inkey', str(key), '-in', str(manifest), '-out', str(signature)], check=True, capture_output=True)
        (self.fixtures / 'native-packages.sig').write_bytes(base64.b64encode(signature.read_bytes()) + b'\n')
        self.executable('curl', """#!/usr/bin/python3 -I
import os,pathlib,shutil,sys
args=sys.argv[1:];target=pathlib.Path(args[args.index('--output')+1])
shutil.copyfile(pathlib.Path(os.environ['FIXTURES'])/args[-1].rsplit('/',1)[-1],target)
with open(os.environ['DOWNLOAD_LOG'],'a') as stream:stream.write(str(target.parent)+'\\n')
""")
        self.executable('apm', '#!/bin/sh\nexit 97\n')
        self.executable('sudo', """#!/usr/bin/python3 -I
import json,os,pathlib,stat,sys
args=sys.argv[1:]
if args[:3]!=['--','apm','install'] or len(args)!=4:sys.exit(98)
package=pathlib.Path(args[3]);home=pathlib.Path(os.environ['HOME'])
package.read_bytes()
pathlib.Path(os.environ['MANAGER_LOG']).write_text(json.dumps({'path':str(package)}))
if not package.is_relative_to(home) or not package.is_relative_to('/home'):sys.exit(100)
if stat.S_IMODE(package.parent.stat().st_mode)!=0o700:sys.exit(101)
sys.exit(int(os.environ.get('MANAGER_STATUS','0')))
""")
        self.manager_log = self.root / 'manager.json'
        self.download_log = self.root / 'downloads'
        self.env = {'HOME': str(self.home), 'PATH': str(self.bin) + ':/usr/bin:/bin', 'LANG': 'C.UTF-8',
                    'FIXTURES': str(self.fixtures), 'MANAGER_LOG': str(self.manager_log),
                    'DOWNLOAD_LOG': str(self.download_log)}

    def executable(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def run_installer(self, **environment):
        return subprocess.run(['bash', str(self.script), '--apm', '--version', 'r45.123'],
                              env=dict(self.env, **environment), capture_output=True, text=True, timeout=20)

    def assert_download_cleanup(self):
        for name in self.download_log.read_text().splitlines():
            self.assertFalse(Path(name).exists(), 'Verified download staging must be cleaned')

    def test_package_is_visible_and_private_then_cleaned(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        package = Path(json.loads(self.manager_log.read_text())['path'])
        self.assertFalse(package.parent.exists(), 'Visible package staging must be removed after installation')
        self.assert_download_cleanup()

    def test_manager_failure_is_preserved_and_both_stages_are_cleaned(self):
        result = self.run_installer(MANAGER_STATUS='42')
        self.assertEqual(result.returncode, 42, result.stdout + result.stderr)
        package = Path(json.loads(self.manager_log.read_text())['path'])
        self.assertFalse(package.parent.exists())
        self.assert_download_cleanup()

    def test_writable_home_never_reaches_privileged_consumer(self):
        self.home.chmod(0o777)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.manager_log.exists())
        self.assert_download_cleanup()


if __name__ == '__main__':
    unittest.main()
