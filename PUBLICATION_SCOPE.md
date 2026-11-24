# Publication scope and third-party notices

## First-party source license

The native interoperability implementation, Linux integration, build/acquisition tools and authored verification code in this repository are offered under MPL 2.0, subject to the scope of rights the contributors can grant. The notice in the root README and LICENSE applies to those files. No rights in Huawei/WeLink/HIT names, marks, proprietary implementations, services or accounts are granted.

This is an interoperability reimplementation, not a claim of clean-room certification, official support, or permission to redistribute the upstream application. Developers remain responsible for the terms governing the original software they obtain and the services they use.

## Inputs deliberately not published

- Original commercial application bundles, `main.jsc`, SDK DLLs, proprietary vendor runtimes, logos and other commercial resources.
- Decompiled reference C files, Ghidra databases and raw disassembly/research dumps.
- User profiles, databases, cookies, credentials, meeting tickets, captured traffic, logs, recordings and screenshots.
- Private acquisition caches, proprietary archives, compiled work directories and reconstructed vendor overrides. Separately published, lawfully redistributable open-source runtime dependencies are described below; they are not the commercial client.

The build obtains applicable original inputs through pinned acquisition scripts or documented lawful local-input methods. They remain private inputs. Their absence is an explicit prerequisite error, not an excuse for successful placeholder providers. Native source code is not replaced by prebuilt vendor libraries.

## Minimal vendor adaptation recipes

`NativeBuild/vendor-overrides.json` contains pinned base/target hashes and copy/literal operations. Unchanged upstream ranges are references to the builder's own base files; whole minified frontend bundles are not stored in Git. Small original context needed to apply adaptations retains upstream rights. MPL covers our modifications, not the original client or an implied license to its surrounding material.

The source manifest is recreated privately with `NativeBuild/prepare_overrides.py`. Both this tool and the public update packager verify the exact base and reconstructed target. A different vendor version is not silently accepted. Public update generation rejects newly introduced upstream files and near-whole upstream literal payloads.

Interface names, schema fields, command IDs, format constants, known-answer fixtures and file hashes are compatibility information. Their presence does not sublicense the implementation or files they describe. Synthetic verification fixtures are not production user records.

## Open-source dependencies

Electron/Chromium/V8/Node, libffi, ffi-napi, ref-napi, json-c, SQLite3MC, GLib, OpenSSL and the other pinned build/runtime dependencies retain their own licenses and copyright notices. They are not relicensed wholesale under MPL. Acquisition manifests identify source versions and hashes. See `NativeBuild/ffi/source-lock.json`, the dependency locks and the build documentation for inputs.

The existing image assembler copies real license/notice texts for included open-source components and emits provenance and runtime dependency inventories. Static-library notices must accompany distributed native binaries. Patches against upstream open-source runtime code retain that project's terms for original context; the patch/provenance directory documents the applicable upstream licenses.

The optional custom Electron runtime archive is an open-source build dependency with its original license/notice files, exact archive hash, source pins and corresponding port patches. It contains no commercial client, user profile or provider/model input. Using this archive is distinct from rebuilding Chromium from source; both paths must be documented honestly.

Commercial meeting-provider assets and models are not made open-source merely because an adapter can load them. The corresponding first-party adapter/source is public; builders must obtain permissible original inputs separately where required.

## Public release assets

Application updates are checked native deltas for specified installed native baselines, plus their corresponding source and integration installer. They are not standalone repacks of the commercial client. GitHub's tag source archives contain the public source tree only. SHA256SUMS detects transfer/corruption errors; it is not a separate signing authority. Built-in installation additionally requires the exact release manifest's Ed25519 signature under the public key shipped in the trusted current image, compatible baseline selection and asset hashes before execution.

After the user's installation choice, the GUI may download and execute the matching verified native installer as the desktop user. It must stage beside the old image, wait for normal exit, preserve the actual profile and desktop defaults, and require real new-version readiness before committing the update. Rollback backups stay private and never become release assets. Necessary system authorization is limited to the verified sandbox operation; the whole installer is not run as root. Signatures authenticate the configured publisher, not the quality or inherent safety of its code. The private signing key is not included in the repository, images or client.

## Explicit source/data exceptions

- The FFI `libraries/node_extends/node-ffi/ffi-napi/lib/library.js` override retains MIT-licensed upstream implementation. Its original copyright and permission text is included in [LICENSES/ffi-napi-MIT.txt](LICENSES/ffi-napi-MIT.txt); MPL covers our new modifications, not removal of that MIT notice.
- `LoginSecurity/pedestal_integrity_vendor.h` is deliberately absent and ignored: it is bulk whitebox/manifest data extracted from a commercial DLL. Original-SDK comparison experiments may use a privately obtained/generated copy; native image builds use the independently generated native manifest instead.
- The voice frontend tables are analytic windows/filter-bank/FFT constants, not trained model weights. Separately supplied model files remain private.
- Authored ABI probes and Ghidra generator scripts are included; the decompiled output, key dumps and databases they can produce are not.
