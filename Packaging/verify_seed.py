#!/usr/bin/env python3
"""Consumer-visible recipe integrity and redistribution boundary regressions."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import shlex
import stat
import sys
import tempfile
import time
import unittest
import subprocess

import seed
import build_deb


class SeedTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.image = self.root / "sealed"
        self.inputs = self.root / "inputs"
        self.inputs.mkdir()
        shutil.copyfile(seed.TOOLS / "image-inputs.lock.json", self.inputs / "image-inputs.lock.json")
        self.vendor = b"function original(){return 'lawfully supplied fixture';}\n" * 250
        self.target = self.vendor + b"// native integration\n"
        self.put(self.inputs / "vendor-app/pedestal/code.js", self.vendor)
        self.put(self.image / "resources/app/pedestal/code.js", self.target)
        self.put(self.inputs / "providers/provider.js", b"private provider fixture")
        self.put(self.image / "resources/app/native/vendor/provider.js", b"private provider fixture")
        self.put(self.image / "resources/app/native/build.json", json.dumps({"build": "hit-native-linux-ia32-r45.14"}).encode())
        self.put(self.image / "resources/app/native/launch-welink", b"#!/bin/sh\nexit 0\n", 0o755)
        self.put(self.image / "resources/app/native/lib/fixture.so", b"first-party fixture bytes")
        self.put(self.image / "resources/app/native/vendor/management/node_modules/agent-base/LICENSE", b"MIT license fixture")
        self.put(self.image / "chrome-sandbox", b"sandbox fixture", 0o755)
        (self.image / "launch-welink").symlink_to("resources/app/native/launch-welink")
        self.output = self.root / "package"

    def put(self, path, content, mode=0o644):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        path.chmod(mode)

    def package(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return seed.create(self.image, self.inputs, self.output, "a" * 40)

    def materialize(self, manifest):
        destination = self.root / "installed"
        def sandbox(source, directory, expected):
            shutil.copyfile(source, directory / "chrome-sandbox")
            (directory / "chrome-sandbox").chmod(0o755)
        seed.materialize(self.output, self.inputs, destination, manifest, sandbox,
                         lambda _: None, namespace_sandbox=True)
        return destination

    def test_private_inputs_reconstruct_exact_usable_files(self):
        self.package()
        installed = self.materialize(seed.load(self.output))
        self.assertEqual((installed / "resources/app/pedestal/code.js").read_bytes(), self.target)
        self.assertEqual((installed / "resources/app/native/vendor/provider.js").read_bytes(), b"private provider fixture")
        self.assertEqual((installed / "resources/app/native/lib/fixture.so").read_bytes(), b"first-party fixture bytes")
        self.assertEqual((installed / "resources/app/native/vendor/management/node_modules/agent-base/LICENSE").read_bytes(), b"MIT license fixture")
        self.assertTrue(os.access(installed / "launch-welink", os.X_OK))
        self.assertEqual((installed / "launch-welink").readlink(), Path("resources/app/native/launch-welink"))

    def test_changed_private_base_is_not_accepted(self):
        manifest = self.package()
        (self.inputs / "vendor-app/pedestal/code.js").write_bytes(self.vendor + b"unexpected")
        with self.assertRaisesRegex(ValueError, "Input bytes differ"):
            self.materialize(manifest)

    def test_changed_shipped_native_payload_is_not_accepted(self):
        manifest = self.package()
        (self.output / "payload/resources/app/native/lib/fixture.so").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "Input bytes differ"):
            self.materialize(manifest)

    def test_complete_vendor_replacement_cannot_be_published(self):
        (self.image / "resources/app/pedestal/code.js").write_bytes(b"wholly unrelated proprietary bytes\n" * 500)
        with self.assertRaisesRegex(ValueError, "Too much upstream literal data"):
            self.package()

    def test_changed_proprietary_bytecode_cannot_be_published(self):
        self.put(self.inputs / "vendor-app/main.jsc", b"original bytecode")
        self.put(self.image / "resources/app/main.jsc", b"different bytecode")
        with self.assertRaisesRegex(ValueError, "Changed proprietary executable"):
            self.package()

    def test_manifest_cannot_escape_installation(self):
        manifest = self.package()
        manifest["files"]["../outside"] = manifest["files"].pop("resources/app/native/lib/fixture.so")
        (self.output / "seed.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "Unsafe image-relative path"):
            seed.load(self.output)
        self.assertFalse((self.root / "outside").exists())

    def test_symlink_cannot_escape_installation(self):
        manifest = self.package()
        manifest["files"]["launch-welink"] = {"link": "../outside"}
        (self.output / "seed.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "symlink escapes"):
            seed.load(self.output)

    def test_changed_installed_execution_mode_is_rejected(self):
        manifest = self.package()
        installed = self.materialize(manifest)
        (installed / "resources/app/native/launch-welink").chmod(0o644)
        with self.assertRaisesRegex(ValueError, "permissions differ"):
            seed.verify(installed, manifest, namespace_sandbox=True)


    def test_symlinked_public_commands_preserve_first_run_consent(self):
        self.package()
        sources = Path(__file__).resolve().parent
        for name in ("seed.py", "package_install.py", "sandbox_helper.py"):
            shutil.copyfile(sources / name, self.output / name)
        tools = self.output / "tools"
        tools.mkdir()
        for name in ("acquire.py", "acquire_image_inputs.py", "delta.py", "install_desktop.py",
                     "image-inputs.lock.json", "custom-background.integrity.json"):
            shutil.copyfile(seed.TOOLS / name, tools / name)
        self.put(self.output / "bin/launch", build_deb.LAUNCH.encode(), 0o755)
        self.put(self.output / "bin/setup", build_deb.SETUP.encode(), 0o755)
        aliases = self.root / "command aliases"
        aliases.mkdir()
        for name in ("launch", "setup"):
            (aliases / name).symlink_to(self.output / "bin" / name)
        home = self.root / "desktop user home"
        home.mkdir(mode=0o700)
        environment = {"HOME": str(home), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
        for name in ("launch", "setup"):
            result = subprocess.run([str(aliases / name)], env=environment,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("sudo" if os.geteuid() == 0 else "--accept-vendor-terms", result.stderr)
            self.assertFalse((home / ".local/share/hit-welink-native/profile").exists())
            self.assertFalse((home / ".cache/hit-welink-native/archives").exists())
        help_result = subprocess.run([str(aliases / "setup"), "--help"], env=environment,
                                     capture_output=True, text=True, timeout=10)
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn("--vendor-installer", help_result.stdout)
        self.assertIn("--no-launch", help_result.stdout)


class PackageActivationTests(unittest.TestCase):
    """Real installer/settings transactions in disposable homes, without Electron.

    The launch probe is a copied Python executable that reports its own executable,
    selected build and profile. Requires node, gio, xprop and systemd-run on PATH.
    """

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="welink-package-activation-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "desktop home"
        self.home.mkdir(mode=0o700)
        self.package = self.root / "package"
        self.package.mkdir()
        sources = Path(__file__).resolve().parent
        self.integration = sources.parent / "NativeIntegration"
        for name in ("seed.py", "package_install.py"):
            shutil.copyfile(sources / name, self.package / name)
        tools = self.package / "tools"
        tools.mkdir()
        for name in ("acquire.py", "acquire_image_inputs.py", "delta.py", "install_desktop.py",
                     "image-inputs.lock.json", "custom-background.integrity.json"):
            shutil.copyfile(seed.TOOLS / name, tools / name)
        self.environment = {"HOME": str(self.home), "PATH": os.environ.get("PATH", os.defpath),
                            "LANG": "C.UTF-8", "XDG_CONFIG_HOME": str(self.root / "desktop config"),
                            "XDG_DATA_HOME": str(self.home / ".local/share")}

    def put(self, path, content, mode=0o600):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        path.chmod(mode)

    def snapshot(self, path):
        return path.read_bytes(), stat.S_IMODE(path.stat().st_mode)

    def settings(self, image, operation="get"):
        result = subprocess.run(["node", "-e", r'''
const [source, home, profile, appRoot, operation] = process.argv.slice(1);
const settings = require(source).createAutostart({
  app: { getPath: name => {
    if (name !== 'home') throw new Error('Unexpected application path: ' + name);
    return home;
  }, getName: () => 'WeLink activation fixture' },
  profileRoot: profile, appRoot, execPath: require('path').join(appRoot, 'native/launch-welink')
});
if (operation !== 'get') settings.set(operation === 'enable');
console.log(JSON.stringify({ filename: settings.filename, enabled: settings.get() }));
''', str(self.integration / "platform_settings.js"), str(self.home), str(self.profile),
            str(image / "resources/app"), operation], env=self.environment, text=True,
            capture_output=True, check=True, timeout=15)
        return json.loads(result.stdout)

    def prepare(self, disabled=None, apm=False, absent=False, default_config=False):
        self.apm = "cn.edu.hit.welink.native.apm" if apm else ""
        name = "hit-welink-native-apm" if apm else "hit-welink-native"
        if apm:
            self.environment.update(WELINK_NATIVE_APM_PACKAGE=self.apm, APM_PKG_NAME=self.apm, IS_ACE_ENV="1")
        if default_config:
            del self.environment["XDG_CONFIG_HOME"]
        self.config = Path(self.environment.get("XDG_CONFIG_HOME", self.home / ".config"))
        self.install = self.home / (".local/opt/hit-welink-native-apm" if apm else ".local/opt")
        self.profile = self.home / ".local/share" / name / "profile"
        self.profile.mkdir(parents=True, mode=0o700)
        self.put(self.profile / ".welink-native-profile", b"welink-native-profile-v1\n")
        self.put(self.profile / "sentinel", b"existing profile state\n")
        self.launcher = self.home / ".local/bin" / name
        self.desktop = self.home / ".local/share/applications" / ((self.apm or name) + ".desktop")
        self.base = self.install / "hit-welink-native-r45.1/image"
        self.target = self.install / "hit-welink-native-r45.2/image"
        for image, version in ((self.base, "r45.1"), (self.target, "r45.2")):
            native = image / "resources/app/native"
            native.mkdir(parents=True)
            shutil.copyfile(self.integration / "update_supervisor.py", native / "update_supervisor.py")
            shutil.copyfile(Path(sys.executable).resolve(), image / "electron")
            (image / "electron").chmod(0o755)
            self.put(native / "build.json", json.dumps({"build": "hit-native-linux-ia32-" + version}).encode())
            self.put(native / "activation_probe.py", b'''import json, os, sys
from pathlib import Path
receipt = Path(os.environ["PACKAGE_ACTIVATION_RECEIPT"])
temporary = receipt.with_suffix(".tmp")
temporary.write_text(json.dumps({
    "executable": os.readlink("/proc/self/exe"),
    "build": json.loads(Path(__file__).with_name("build.json").read_text())["build"],
    "profile": os.environ.get("WELINK_NATIVE_PROFILE_DIR"),
    "arguments": sys.argv[1:]
}))
temporary.replace(receipt)
''')
            self.put(native / "launch-welink", ("#!/bin/sh\nset -eu\nexec " +
                shlex.quote(str(image / "electron")) + " -I " + shlex.quote(str(native / "activation_probe.py")) +
                ' "$@"\n').encode(), 0o755)
            (image / "launch-welink").symlink_to("resources/app/native/launch-welink")
            self.put(image / "resources/app/pedestal/resources/icon/app.png", base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII="))
        command = [sys.executable, "-I", str(self.package / "tools/install_desktop.py"),
                   "--image", str(self.base), "--home", str(self.home), "--profile", str(self.profile),
                   "--preserve-defaults"]
        if apm:
            command += ["--apm-package", self.apm]
        subprocess.run(command, env=self.environment, capture_output=True, text=True, check=True, timeout=15)
        setting = self.settings(self.base, "get" if absent else "enable")
        self.autostart = Path(setting["filename"])
        if disabled == "hidden":
            self.settings(self.base, "disable")
        if not absent:
            extra = b"# Retain desktop preferences\nX-GNOME-Autostart-Delay=13\n"
            if disabled == "gnome":
                extra += b"X-GNOME-Autostart-enabled=false\n"
            self.put(self.autostart, self.autostart.read_bytes() + extra, 0o640)
        inactive = self.home / ".config" if not default_config else self.root / "inactive config"
        retained = {
            self.config / "mimeapps.list": b"[Default Applications]\nx-scheme-handler/hwwelink=other-app.desktop;\n",
            inactive / "mimeapps.list": b"[Default Applications]\ntext/plain=editor.desktop;\n",
            self.config / "autostart/other-app.desktop": b"[Desktop Entry]\nType=Application\nExec=/bin/false\n",
            inactive / "autostart" / self.autostart.name: self.autostart.read_bytes() if not absent else b"unrelated entry\n",
        }
        for path, content in retained.items():
            self.put(path, content)
        self.retained = {path: self.snapshot(path) for path in (*retained, self.profile / "sentinel",
                                                              self.profile / ".welink-native-profile")}
        paths = [self.launcher, self.desktop] + ([] if absent else [self.autostart])
        self.before = {path: self.snapshot(path) for path in paths}

    def activate(self, succeeds=True):
        result = subprocess.run([sys.executable, "-I", "-c", '''import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import package_install
home, profile, launcher, image, install = map(Path, sys.argv[2:7])
previous = package_install.installed_image(launcher, install)
package_install.activate(home, profile, launcher, image, sys.argv[7], previous)
if package_install.installed_image(launcher, install)[0] != image:
    raise RuntimeError("Package activation did not select the requested image")
''', str(self.package), str(self.home), str(self.profile), str(self.launcher), str(self.target),
            str(self.install), self.apm], env=self.environment, capture_output=True, text=True, timeout=30)
        if succeeds:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def assert_retained(self):
        for path, before in self.retained.items():
            self.assertEqual(self.snapshot(path), before, str(path))

    def assert_backup(self):
        backups = list((self.profile.parent / "package-backups").glob("before-*/integration.json"))
        self.assertEqual(len(backups), 1)
        journal = json.loads(backups[0].read_text())
        self.assertEqual(set(journal), {str(path) for path in self.before})
        for path, (data, mode) in self.before.items():
            self.assertEqual(base64.b64decode(journal[str(path)]["data"]), data)
            self.assertEqual(journal[str(path)]["mode"], mode)
        self.assertEqual((backups[0].parent / "profile/sentinel").read_bytes(), (self.profile / "sentinel").read_bytes())

    def assert_launches(self, image):
        # A visible copy exercises the retained command even when the owned entry
        # is disabled; the user's actual entry and preference remain untouched.
        entry = self.root / "launch probe.desktop"
        self.put(entry, b"\n".join(line for line in self.autostart.read_bytes().splitlines()
                                  if line not in (b"Hidden=true", b"X-GNOME-Autostart-enabled=false")) + b"\n")
        receipt = self.root / "launch-receipt.json"
        receipt.unlink(missing_ok=True)
        subprocess.run(["gio", "launch", str(entry)], env=dict(self.environment, PACKAGE_ACTIVATION_RECEIPT=str(receipt)),
                       capture_output=True, text=True, check=True, timeout=15)
        deadline = time.monotonic() + 5
        while not receipt.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(receipt.is_file(), "The desktop entry did not launch the image probe")
        self.assertEqual(json.loads(receipt.read_text()), {
            "executable": str(image / "electron"),
            "build": json.loads((image / "resources/app/native/build.json").read_text())["build"],
            "profile": str(self.profile), "arguments": [str(image / "resources/app")],
        })

    def assert_migrated(self, enabled):
        self.assertEqual(self.settings(self.target)["enabled"], enabled)
        old, mode = self.before[self.autostart]
        current = self.autostart.read_bytes()
        preferences = lambda data: [line for line in data.splitlines() if not line.startswith((b"Exec=", b"TryExec="))]
        self.assertEqual(preferences(current), preferences(old))
        self.assertEqual(stat.S_IMODE(self.autostart.stat().st_mode), mode)
        self.assert_retained()
        self.assert_backup()
        self.assert_launches(self.target)

    def test_enabled_autostart_launches_new_package_from_actual_xdg_config(self):
        self.prepare()
        self.assertTrue(self.settings(self.base)["enabled"])
        self.assert_launches(self.base)
        self.activate()
        self.assert_migrated(True)

    def test_hidden_autostart_migrates_without_enabling(self):
        self.prepare(disabled="hidden")
        self.activate()
        self.assert_migrated(False)

    def test_gnome_disabled_autostart_migrates_in_default_config(self):
        self.prepare(disabled="gnome", default_config=True)
        self.activate()
        self.assert_migrated(False)

    def test_absent_autostart_is_not_created(self):
        self.prepare(absent=True)
        self.activate()
        self.assertFalse(self.autostart.exists())
        self.assertFalse(self.settings(self.target)["enabled"])
        self.assert_retained()
        self.assert_backup()

    def test_unrelated_entry_at_owned_filename_is_not_overwritten(self):
        self.prepare()
        self.put(self.autostart, b"[Desktop Entry]\nType=Application\nExec=/bin/false\n")
        self.before[self.autostart] = self.snapshot(self.autostart)
        self.activate(succeeds=False)
        for path, before in self.before.items():
            self.assertEqual(self.snapshot(path), before)
        self.assert_retained()

    def test_apm_autostart_retains_stable_launcher(self):
        self.prepare(apm=True)
        self.activate()
        self.assertTrue(self.settings(self.target)["enabled"])
        self.assertEqual(self.snapshot(self.autostart), self.before[self.autostart])
        self.assert_retained()
        self.assert_backup()

    def fail_after_integration(self, external_edit=False):
        # Fault injection happens only after the real installer has completed its
        # writes. Planning and activation still use the production implementation.
        installer = self.package / "tools/install_desktop.py"
        real_installer = installer.with_name("real_install_desktop.py")
        installer.rename(real_installer)
        edit = ""
        if external_edit:
            edit = (f"    entry = Path({str(self.autostart)!r})\n"
                    "    entry.write_bytes(entry.read_bytes() + b'# Subsequent user edit\\n')\n"
                    f"    Path({str(self.root / 'external-edit.desktop')!r}).write_bytes(entry.read_bytes())\n")
        self.put(installer, ("import runpy, sys\nfrom pathlib import Path\n" +
            f"runpy.run_path({str(real_installer)!r}, run_name='__main__')\n" +
            "if '--plan' not in sys.argv:\n" + edit +
            "    raise RuntimeError('Injected failure after real integration writes')\n").encode())

    def test_failed_activation_restores_owned_autostart_and_launcher(self):
        self.prepare()
        self.fail_after_integration()
        result = self.activate(succeeds=False)
        self.assertIn("Injected failure after real integration writes", result.stderr)
        for path, before in self.before.items():
            self.assertEqual(self.snapshot(path), before)
        self.assert_retained()
        self.assert_backup()
        self.assert_launches(self.base)

    def test_failed_activation_does_not_overwrite_subsequent_autostart_edit(self):
        self.prepare()
        self.fail_after_integration(external_edit=True)
        result = self.activate(succeeds=False)
        self.assertIn("Injected failure after real integration writes", result.stderr)
        self.assertEqual(self.autostart.read_bytes(), (self.root / "external-edit.desktop").read_bytes())
        for path in (self.launcher, self.desktop):
            self.assertEqual(self.snapshot(path), self.before[path])
        self.assert_retained()
        self.assert_backup()


if __name__ == "__main__":
    unittest.main()
