#!/usr/bin/env python3
"""Consumer-visible recipe integrity and redistribution boundary regressions."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

import seed


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


if __name__ == "__main__":
    unittest.main()
