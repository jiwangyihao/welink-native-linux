# Building the native Linux port

This repository contains the native port and build recipes, **not the commercial client**. `NativeBuild/full_build.py` obtains the exact pinned inputs from their publishers (or verifies lawfully supplied original archives), compiles the real native libraries/workers and FFI, prepares the application, builds its manifest-specific integrity checker, and finalizes a usable image. No existing client, extracted source cache, account, or developer workspace is a build prerequisite. Building and running proprietary inputs still requires the applicable rights; a successful build is not desktop or account acceptance.

The release identity is `hit-native-linux-ia32-r45.13`. Do not substitute a stock x64 Electron build: the user-supplied cached bytecode requires the recorded ia32 Electron/V8 configuration. Source availability is not a claim that the obsolete Electron 22 runtime is secure for arbitrary content.

## Host prerequisites

For the self-contained build use an x86_64 Linux host with Python **3.12 or later**, Node.js **20.19.0** (or a compatible Node 20+), npm, Bash, GNU make, CMake 3.16+, pkg-config, GNU binutils, `dpkg-deb`, tar/xz, **innoextract 1.9 or later**, and a C/C++ host toolchain. On Ubuntu 24.04 the build tools can be installed explicitly:

```sh
sudo apt-get update
sudo apt-get install --yes build-essential cmake pkg-config python3 xz-utils binutils git curl ca-certificates innoextract
```

Install Node/npm separately from a trusted distribution. Bootstrap never installs host packages and never executes Debian maintainer scripts or npm lifecycle scripts. It extracts pinned packages into an isolated prefix. Native dependencies use Debian 13/Trixie ia32; the FFI and Electron compiler sysroot is the separately pinned Bullseye ia32 sysroot. These are deliberately not interchangeable.

Compilation on an x86_64 host does not require executing ia32 programs. Running the result requires an ia32 glibc loader with the GLIBC symbol versions printed by `assemble_app.py`; a Debian 13 desktop with `libc6:i386` is the intended native-dependency baseline. The image does not bundle a competing glibc or loader. Display, audio, GPU and desktop-service requirements still apply to application acceptance.

In-client updates additionally require system Python 3, OpenSSL (`/usr/bin/openssl`), `systemd-run` with a working user session, and polkit's `pkexec` with a graphical authorization agent when sandbox authorization is needed. On a Debian-family desktop these are normally supplied by `python3`, `openssl`, `systemd`, `polkitd` and `pkexec`. The application can be launched directly, but its updater supervisor uses the user service manager to survive old-app exit. Build acquisition never disables TLS or the Chromium sandbox, runs the Windows installer, or requests root installation of the application.

Use a checkout path without whitespace for GNU make's existing source layout. All commands below start at the repository root.

## Precompiled DEB and APM packages

`Packaging/build_deb.py` builds an amd64 Debian package in the Spark/Deepin
`/opt/apps/cn.edu.hit.welink.native` layout, with standard desktop/icon entries.
It consumes a finalized image and the exact verified `image-inputs` directory;
it does not compile on the end user's machine or require an existing native release.

```sh
python3 Packaging/build_deb.py \
  --image "$BUILD/image" --inputs "$BUILD/image-inputs" \
  --source-commit "$SOURCE_COMMIT" --output "$OUT"
# Run on a build machine with APM and its amber-pm-trixie base installed:
bash Packaging/build_apm.sh \
  --deb "$OUT/cn.edu.hit.welink.native_45.14-1_amd64.deb" --output "$OUT"
```

The public seed contains first-party/open-source binaries and minimal adaptation
recipes. Unchanged proprietary files and provider/model input bytes are references
to hash-pinned lawful upstream inputs, never literal public payloads. New/changed
proprietary executables and near-whole upstream replacement literals are rejected.
Reconstruction must match every sealed image byte, link and executable mode.

The ordinary package uses the existing protected SUID sandbox, installed by dpkg;
one bounded privileged helper copies only that trusted sandbox to a private user
staging directory. Neither the full installer nor the application runs as root.
APM selects Chromium's nested user-namespace backend for windows that request
renderer sandboxing. The launcher does not append a global `--no-sandbox` flag
or retry with sandboxing disabled when namespace creation fails. Legacy vendor
Node-integrated renderers remain unsandboxed; this work does not claim complete
Chromium isolation of the client. Verify each relevant window's actual preferences,
process identity and kernel sandbox state rather than inferring them from startup flags.
APM has its own launcher, profile and release directory and must remain inside the
container for warm activation, URLs, autostart and update/restart.

First user launch asks for upstream-use authorization and can acquire the fixed
inputs itself. For lawful offline inputs, run `welink-native-setup` with
`--accept-vendor-terms --vendor-installer FILE --hrtc-bundle FILE
--background-archive FILE --background-license FILE`; `--no-launch` prepares and
activates without opening WeLink. Do not run either entry as root. Package removal
retains user images, profiles and backups rather than walking or deleting homes.

The package manages public bootstrap components; in-client signed updates manage
the user's application images. Existing running sessions are not terminated by
package installation or activation. A currently running application must exit
normally before the package bootstrap can switch its per-user desktop entry.

## One-command complete image build

Read the [HIT application distribution page](https://app.hit.edu.cn/) and the applicable Huawei/provider terms first. `--accept-vendor-terms` is your explicit confirmation of authorization to obtain and use those inputs, **not** a license grant or a redistribution permission.

From a new checkout, after installing the host prerequisites:

```sh
python3 NativeBuild/full_build.py \
  --work "$PWD/.work/full-build" \
  --cache "$PWD/.inputs/full-build-archives" \
  --build-id hit-native-linux-ia32-r45.13 \
  --accept-vendor-terms --jobs 2
```

Choose the build ID deliberately for the source/release being built. The default `--runtime-mode binary` uses the project's [published custom Electron dependency](https://github.com/jiwangyihao/welink-native-linux/releases/tag/runtime-electron-22.3.26-ia32-v1), verified against `NativeBuild/electron-runtime/runtime-binary.lock.json`. It does **not** claim to compile Chromium. It does compile this checkout's native implementations and genuine FFI addons. The dependency archive contains the open-source runtime and notices, not the commercial client, provider bundle, models, or account data.

The command performs all of these required steps:

1. Hash/size-verify the complete original HIT installer; use `innoextract` to obtain a fresh `app/resources/app` without executing Windows code.
2. Acquire the exact HRTC chunk, MediaPipe archive, and original MediaPipe license; verify every required model/WASM/JavaScript asset against the existing manifest.
3. Acquire the custom runtime archive and verify its source-lock/build-arguments identities; extract it freshly and normalize the distribution's `chrome-sandbox` filename to the assembler's `chrome_sandbox` input. Setuid bits are not imported from archives.
4. Bootstrap pinned compiler/sysroots, native dependencies, JSON-C and SQLite3MC, FFI source archives/notices, runtime packages, and a fresh locked meeting-management npm tree. No npm lifecycle scripts or package maintainer scripts are run.
5. Compile every non-checker native target and both real FFI addons; reconstruct private overrides from the exact original vendor files.
6. Run `assemble_app.py prepare`, compile `sqlite_plugin.dll.so` against **that prepared image's generated manifest**, then run `assemble_app.py finalize`. A placeholder checker or manually invented manifest is never used.

Success prints the image at `.work/full-build/image` and build-side input provenance at `.work/full-build/build-inputs.json`. The workspace also retains the real checker header and immutable preparation records under `integrity/`. No application is started; no profile, desktop launcher, MIME default, or running client is changed.

`--work` must **not exist**, including after a failed build. Use a different workspace for each attempt; partial outputs remain diagnostic failures, never reusable trusted inputs. The separate cache contains original archives, each reverified before use; it may be shared between builds. All extracted inputs, generated overrides, objects and npm installations are fresh and workspace-local. Existing repository `vendor/`, `Conference/vendor` provider files, `.inputs` extracted trees, `NativeIntegration/app-overrides`, and old images are not selected by the full builder.

To compile the custom Electron/Chromium runtime from source as well:

```sh
python3 NativeBuild/full_build.py \
  --work "$PWD/.work/full-source-build" \
  --cache "$PWD/.inputs/full-build-archives" \
  --build-id hit-native-linux-ia32-r45.13 \
  --runtime-mode source --accept-vendor-terms --jobs 2
```

Source-runtime mode clones the pinned depot_tools revision into the new workspace, runs the existing source-preparation/patch recipe, acquires the pinned ia32 toolchain, and builds `electron:electron_dist_zip` with GN/autoninja before assembling the image. It does not accept an existing Chromium checkout or a prebuilt runtime override. Install the additional [Electron Linux source-build prerequisites](https://www.electronjs.org/docs/latest/development/build-instructions-linux) before selecting it; Chromium 108 needs compatible host tools and substantial disk/memory. See the source-runtime details below.

### Exact acquisition provenance and authorized local inputs

`NativeBuild/image-inputs.lock.json` pins these actual publisher artifacts. Neither a moving “latest” version nor a different generic WeLink installer is accepted:

| Input | Authoritative discovery and exact bytes |
| --- | --- |
| HIT APP Windows **7.47.6.95** | The Windows button on [app.hit.edu.cn](https://app.hit.edu.cn/) links [this exact Huawei CDN installer](https://cdn02.welink.huaweicloud.com/appstore/file/web/free/down/042c58f954f04f60aa7cc242e2a1e33a/HIT%20APP_Win_custom_202412060307_3848_7_47_6_95.exe). 301,766,336 bytes; SHA-256 `5e90fc8822af697a50617daab233a42aedc98787c9564f9dbe05b782072f9c10`. The website's visible version label can differ from its actual link; the installer and embedded package version are the pin. |
| HRTC **1.10.96** | Huawei's [meeting asset manifest](https://meeting.huaweicloud.com/webrtc/asset-manifest.json) lists `static/js/12.eb3d2838.chunk.js`, acquired [unchanged from the provider](https://meeting.huaweicloud.com/webrtc/static/js/12.eb3d2838.chunk.js) and locally named `hrtc-12.eb3d2838.js`. 597,966 bytes; SHA-256 `ac223517d8cd516c2113181a5035093c9f30680380a61c518d08e79fd6c535f4`. |
| MediaPipe Selfie Segmentation **0.1.1675465747** | The [official npm version metadata](https://registry.npmjs.org/@mediapipe/selfie_segmentation/0.1.1675465747) identifies the [exact archive](https://registry.npmjs.org/@mediapipe/selfie_segmentation/-/selfie_segmentation-0.1.1675465747.tgz) and SHA-512 integrity string. 4,049,373 bytes; SHA-256 `7767b33eaa68990ee06c28bbb89f39a13a47ebb07ff0f1fd4947d9e817bb9bf9`. Both hashes are checked. |
| Original MediaPipe license | The package declares Apache-2.0 but omits the license file. Acquire the [upstream v0.10.0 LICENSE](https://raw.githubusercontent.com/google-ai-edge/mediapipe/v0.10.0/LICENSE), 12,331 bytes, SHA-256 `8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8`. Preserve it with the unmodified assets. |

The recorded custom-background integrity manifest is metadata, not redistributed model data. Its SHA-256 remains `96ee5943a35ab3888fcf75ac84ab239ada21d9e6705cf4134122aa3dba1f691e`; acquisition copies it byte-for-byte and checks its nine asset hashes. No background model is fetched at application runtime.

The publisher URLs above served the pinned bytes during acquisition research without authentication. That does not imply permission for every use or permanent availability. If an organization/upstream later requires authentication, visit the legitimate publisher page in your own browser and use its normal authorized download flow, or request the **exact pinned version** from the organization's administrator. Never supply credentials to an alternate mirror, bypass access controls, accept an HTML login response as an installer, or replace the lock with an arbitrary new hash.

The full builder supports these hash-checked local originals instead of those downloads:

```sh
python3 NativeBuild/full_build.py \
  --work "$PWD/.work/full-local-inputs" --cache "$PWD/.inputs/full-build-archives" \
  --build-id hit-native-linux-ia32-r45.13 --accept-vendor-terms \
  --vendor-installer /absolute/path/to/original-HIT-installer.exe \
  --hrtc-bundle /absolute/path/to/12.eb3d2838.chunk.js \
  --background-archive /absolute/path/to/selfie_segmentation-0.1.1675465747.tgz \
  --background-license /absolute/path/to/mediapipe-LICENSE \
  --runtime-archive /absolute/path/to/custom-electron-dist.zip
```

Each local flag is optional and only replaces acquisition of that exact artifact. Files are copied into the archive cache and reverified; arbitrary already-extracted vendor/runtime directories are not accepted. The runtime archive must match the project's binary lock, not a stock Electron download. Public compiler/dependency/npm inputs are still acquired normally. If the pinned original is no longer lawfully available, the build fails honestly; there is no dummy provider, empty model replacement, “skip verification”, or silently upgraded baseline.

For acquisition without compilation, use `python3 NativeBuild/acquire_image_inputs.py --output NEW_DIRECTORY --cache ARCHIVE_CACHE --accept-vendor-terms` with the same vendor/provider local-file options. It produces `vendor-app/`, `providers/` and the input lock copy, without executing the installer or starting the application.


## Clean source-only smoke

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:smoke
```

This checks first-party Python/JavaScript/shell syntax, JSON and acquisition lock consistency, and the existing offline issued-meeting-site registry test. It does **not** execute the commercial application, Electron, media SDKs or accounts, nor certify bytecode compatibility, login, meetings or the seal-specific integrity checker. Acorn is a locked local npm dependency; renderer verification scripts no longer reach into a developer's Electron tree.

The `source-smoke` CI job runs exactly this scope. The separate `native-build` job compiles the actual implementations and both FFI addons, then checks their ELF32/i386 headers without executing them. Neither job uploads releases, receives publication credentials, or represents a skipped vendor-dependent test as passing.

## Acquire and compile the public inputs

```sh
python3 NativeBuild/bootstrap.py \
  --component toolchain --component deps --component sources \
  --component ffi --component npm --component json-c

export WELINK_NATIVE_DEPS="$PWD/.inputs/native-deps"
export WELINK_ELECTRON_SOURCE="$PWD/.inputs/electron-toolchain"
export WELINK_JSON_PREFIX="$PWD/NativeBuild/json-c"
export WELINK_SQLITE_SOURCE="$PWD/vendor/sqlite3mc-1.4.6"

./build.sh .work/native-libs native-only
NativeBuild/build_ffi.sh \
  --build-dir .work/ffi --output .work/ffi-output \
  --electron-source "$WELINK_ELECTRON_SOURCE"
```

`native-only` builds all 16 non-checker libraries/workers. It does not create a fake integrity manifest. The remaining `sqlite_plugin.dll.so` target must be compiled after image preparation, as described below. FFI build output must be a new directory; it preserves the paired upstream ffi-napi 4.0.3/ref-napi 3.0.3 JavaScript and native code, real Linux ABI, and notices. It never loads a downloaded foreign prebuild or aliases unavailable proprietary FFI extensions.

The native checker is compiled with `PEDESTAL_NATIVE_INTEGRITY` and includes only the generated `native_integrity_manifest.h`; it does not require the vendor-derived whitebox tables. Legacy vendor-mode integrity/oracle experiments require a privately extracted `LoginSecurity/pedestal_integrity_vendor.h` from the exact lawfully obtained original binary. That optional input is ignored, is not distributed, and must not be supplied as a substitute for the native generated manifest or made a public-CI prerequisite.

`bootstrap.py` with no `--component` acquires all of the above plus the locked Electron runtime Debian packages. To acquire only those later:

```sh
python3 NativeBuild/bootstrap.py --component runtime
```

All downloads are HTTPS and verified before extraction:

* `NativeBuild/sources.lock.json`: JSON-C 0.19, SQLite3MC 1.4.6 / SQLite 3.39.1, Chromium's pinned LLVM compiler archive, and the Electron Bullseye ia32 sysroot (SHA-256).
* `NativeBuild/dependencies.lock.json`: exact Debian ia32 development/runtime package versions, URLs and SHA-256. Acquisition never re-resolves a moving APT package set.
* `NativeBuild/ffi/package-lock.json` plus `source-lock.json`: npm source archives (SHA-512), Electron 22.3.26 headers and legal notices (SHA-256), compiler identity, and ABI/compatibility boundaries. The source assembler excludes foreign `.node` prebuilds.
* Root `package-lock.json` and `Conference/vendor/management/package-lock.json`: Acorn and the existing pure-JavaScript meeting-management dependency tree. `npm ci --ignore-scripts --omit=optional` preserves the required `Conference/vendor/management/node_modules` layout.
* `NativeBuild/electron-runtime/packages.lock.json`: the original Debian snapshot runtime selection, including the supplementary D-Bus, accessibility, audio, keyring and keyboard libraries formerly held in a separate cache. `libgnome-keyring0` uses Debian Snapshot's immutable content address; every package is also SHA-256 checked. Package legal notices remain with the extracted inputs.

The lockfiles are the reviewed trust root. A missing upstream archive or hash mismatch fails the command; it is not replaced with another version. To update dependencies, deliberately update the pins and review the corresponding ABI, licensing and acceptance results. The full builder reuses only reverified original archives, never extracted trees. The lower-level bootstrap compares reused compiler, sysroot and source trees against fresh extraction of the pinned archive (including files, symlinks and executable bits), rather than trusting a stamp. Native dependency reuse requires the original recorded file inventory; legacy stamp-only or manually prepared prefixes must be replaced with fresh ones. Reproducible acquisition does not promise identical final binary bytes across arbitrary host tooling.

Electron runtime-package cache reuse checks every recorded file hash and symlink against the saved original inventory. A missing root/inventory, changed or added file, deleted file, or changed symlink fails without regenerating trusted metadata. Select a fresh runtime prefix to reacquire damaged inputs; a stamp alone is not evidence that an extracted runtime is intact.

### Explicit locations and existing caches

No developer-specific directory is a default. `bootstrap.py --help` exposes `--cache`, `--deps-prefix`, `--deps-archives`, `--toolchain-prefix`, `--json-prefix`, `--sqlite-source`, `--ffi-archives`, `--runtime-prefix`, `--runtime-archives`, `--work` and `--jobs`. The toolchain prefix has the same relative LLVM/sysroot layout as an Electron source checkout, but it does not need a built Electron executable to compile native C or FFI.

To use already prepared inputs instead of acquiring/building them again:

```sh
export WELINK_NATIVE_DEPS=/absolute/path/to/native-deps
export WELINK_ELECTRON_SOURCE=/absolute/path/to/electron/src
export WELINK_JSON_PREFIX=/absolute/path/to/json-c-prefix
export WELINK_SQLITE_SOURCE=/absolute/path/to/source-cache/vendor/sqlite3mc-1.4.6
./build.sh .work/native-libs native-only

NativeBuild/build_ffi.sh \
  --build-dir .work/ffi --output .work/ffi-output \
  --electron-source "$WELINK_ELECTRON_SOURCE" \
  --archives /absolute/path/to/verified-ffi-archives
```

`WELINK_SQLITE_SOURCE` selects both the SQLite3MC C source and its header include directory; a stale repository-local source tree must not shadow that explicit input. `WELINK_NATIVE_CC=/absolute/path/to/clang` can override the native C compiler; otherwise the explicit Electron/toolchain prefix supplies it, or `clang` is resolved from PATH. FFI intentionally verifies the pinned compiler and sysroot rather than accepting an arbitrary host compiler.

For direct make use the corresponding variables: `DEPS_ROOT`, `ELECTRON_SOURCE`, `NATIVE_CC`, `JSON_PREFIX`, `SQLITE_SOURCE`, `OUTPUT` and `INTEGRITY_INCLUDE`. The `NativeBuild/cc-ia32` wrapper uses `WELINK_NATIVE_DEPS`, `WELINK_ELECTRON_SOURCE` and optional `WELINK_NATIVE_CC` for the existing standalone C verification drivers. Changing compiler/dependency inputs requires a fresh native output directory; do not mix object caches across configurations.

An old FFI archive cache may lack the separately acquired legal notices. Populate it with `bootstrap.py --component ffi --ffi-archives DIR` before building, or use the default freshly acquired cache. No old cache is required by any command.

## Build the bytecode-compatible Electron runtime

This step is much larger than the native build and is what `full_build.py --runtime-mode source` orchestrates. It acquires upstream Electron/Chromium sources through `gclient`; the source repository does **not** contain a Chromium checkout or a prebuilt runtime. The separately published and hash-pinned binary dependency used by the default full build is an explicit alternative, not a claim to compile upstream Chromium. Follow the [Electron Linux build prerequisites](https://www.electronjs.org/docs/latest/development/build-instructions-linux) for the host; old Chromium 108 can require compatible versions of those host tools. These commands do not use an installed vendor client or account.

`NativeBuild/electron-runtime/source-lock.json` pins Electron **22.3.26**, Chromium **108.0.5359.215**, Node **16.17.1**, V8's upstream commit and the depot_tools revision. Electron's own hooks apply its checked-in upstream patch stack. The recipe verifies the exact resulting Git **tree** hashes, not machine-dependent patch-commit metadata, before applying our three small patches. The tracked `args.gn` is the actual ia32 build configuration (`use_v8_context_snapshot=false`). Upstream licenses govern the upstream sources and patch context; MPL-2.0 does not replace them.

```sh
mkdir -p .inputs .work
ROOT=$PWD
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git .inputs/depot_tools
git -C .inputs/depot_tools checkout --detach 7a339079d178fbc9c6f6230082843d6e00b2551f
python3 NativeBuild/electron-runtime/prepare_source.py \
  --checkout "$ROOT/.work/electron" --depot-tools "$ROOT/.inputs/depot_tools"

# gclient's host hooks may not acquire the ia32 sysroot; fetch the exact pin.
python3 NativeBuild/bootstrap.py --component toolchain \
  --toolchain-prefix "$ROOT/.work/electron/src"
export DEPOT_TOOLS_UPDATE=0
export PATH="$ROOT/.inputs/depot_tools:$PATH"
export SOURCE_DATE_EPOCH=1616074138
cd "$ROOT/.work/electron/src"
gn gen out/ia32
autoninja -C out/ia32 electron:electron_dist_zip
cd "$ROOT"
```

The source preparer requires a **new empty** checkout and never edits an existing source tree. The build must produce the runtime assets and legal notices enumerated by `assemble_app.py`; a partial build is not a usable runtime. Use `--electron-out "$ROOT/.work/electron/src/out/ia32"` when assembling.

The port patches enable Linux x86/libatomic linkage, select the correct non-context V8 snapshot, and preserve the existing **opt-in** `V8_ACCEPT_FOREIGN_FLAG_HASH` compatibility exception. A V8 flag hash is not a source signature or authenticity check. The exception does not prove arbitrary cached data is safe or compatible. Do not enable it for arbitrary downloaded code or untrusted bytecode. Only the exact trusted, lawfully supplied baseline accepted by the vendor-override recipe may be assembled; all ordinary asset hashes, manifest generation, and prepare/build/finalize integrity checks remain required. Source-only CI does not exercise that exception or certify the runtime against vendor bytecode.

## Vendor-dependent image preparation and acceptance

This section is **not run by public CI**. Prefer the full entry point above; the following shows the underlying phases for maintainers. It requires the public native/FFI inputs already built, the exact custom runtime (binary or source), and fresh paths. Acquire the proprietary/provider originals rather than pointing at an arbitrary installed application:

```sh
ROOT=$PWD
python3 NativeBuild/acquire_image_inputs.py \
  --output "$ROOT/.work/manual-inputs" --cache "$ROOT/.inputs/image-archives" \
  --accept-vendor-terms
VENDOR_APP="$ROOT/.work/manual-inputs/vendor-app"
PROVIDERS="$ROOT/.work/manual-inputs/providers"
ELECTRON_OUT=/absolute/path/to/verified-custom-runtime
IMAGE="$ROOT/.work/manual-image"
MANIFEST="$ROOT/.work/manual-integrity"
OVERRIDES="$ROOT/.work/manual-overrides"

python3 NativeBuild/prepare_overrides.py \
  --vendor-app "$VENDOR_APP" --output "$OVERRIDES"
python3 NativeBuild/bootstrap.py --component runtime --component npm

# Build the real non-checker implementations first; use the public-input
# environment and fresh FFI output described above.
./build.sh .work/manual-native-libs native-only

python3 NativeBuild/assemble_app.py prepare \
  --vendor-app "$VENDOR_APP" --vendor-overrides "$OVERRIDES" \
  --provider-inputs "$PROVIDERS" \
  --native-integration "$ROOT/NativeIntegration" --conference "$ROOT/Conference" \
  --management-input "$ROOT/Conference/vendor/management" \
  --sqlite-source "$WELINK_SQLITE_SOURCE" \
  --ffi-output "$ROOT/.work/ffi-output" --electron-out "$ELECTRON_OUT" \
  --native-libs "$ROOT/.work/manual-native-libs" --deps-prefix "$WELINK_NATIVE_DEPS" \
  --electron-prefix "$ROOT/.inputs/electron-runtime/root" \
  --output "$IMAGE" --manifest-dir "$MANIFEST" \
  --build-id hit-native-linux-ia32-r45.13 --native-license "$ROOT/LICENSE"

WELINK_NATIVE_INTEGRITY_INCLUDE="$MANIFEST" \
  ./build.sh .work/manual-native-libs sqlite_plugin.dll.so
python3 NativeBuild/assemble_app.py finalize \
  --output "$IMAGE" --manifest-dir "$MANIFEST" \
  --checker "$ROOT/.work/manual-native-libs/sqlite_plugin.dll.so"
```

Do not alter the prepared image between these phases or hand-generate a substitute header. If preparation fails it leaves a diagnostic partial output; choose fresh output/manifest paths rather than blessing or reusing it. Additional lawful runtime inputs can be passed through `--extra-runtime-prefix`, with real notices or an exact-hash `--notice-map` when required. They are not discovered from the developer's host library paths.

After finalization, acceptance is still separate. Relevant existing drivers include:

```sh
node NativeIntegration/verify_renderer_data.js --app "$IMAGE/resources/app"
node NativeIntegration/verify_renderer_repairs.js --app "$IMAGE/resources/app"
python3 NativeBuild/verify_desktop.py --image "$IMAGE" --output "$ROOT/.work/desktop-acceptance"
```

The renderer/static drivers require the exact assembled vendor files; the desktop driver starts the real application and needs an isolated graphical test session. Do not run it in a user's active profile or treat successful source compilation as its result. The storage oracle generator has explicit `--vendor-root`, `--wine-runtime`, `--cc`, `--bwrap` and `--output-dir` inputs and requires lawfully obtained original Windows DLLs; it is not a normal Linux build prerequisite. Its sandbox-internal `/tmp/work` and `/opt/wine` paths are not workstation cache defaults. No account, message, meeting, provider or live-network acceptance is implied by any build command above.

The separate first-convolution numerical oracle requires `--sdk-root /absolute/path/to/pinned/HwmSdk`; its original DLL/model inputs are private and are hash-checked before use. The HTTP bridge's isolated loopback verifier requires an explicit `--electron /absolute/path/to/custom/ia32/electron` alongside `--library` and `--ffi`. Neither verifier falls back to a workstation-specific vendor/runtime directory.
