# Building the native Linux port

This repository contains the native port and build recipes, **not the commercial client**. A clean checkout can acquire the public inputs, compile the real ia32 libraries/workers and FFI addons, and run the source-only smoke checks without an account, vendor files, browser session, or existing cache. Creating a usable application image is a separate, vendor-dependent procedure below.

The release identity is `hit-native-linux-ia32-r45.11`. Do not substitute a stock x64 Electron build: the user-supplied cached bytecode requires the recorded ia32 Electron/V8 configuration. Source availability is not a claim that the obsolete Electron 22 runtime is secure for arbitrary content.

## Host prerequisites

For the self-contained build use an x86_64 Linux host with Python **3.12 or later**, Node.js **20.19.0** (or a compatible Node 20+), npm, Bash, GNU make, CMake 3.16+, pkg-config, GNU binutils, `dpkg-deb`, tar/xz, and a C/C++ host toolchain. On Ubuntu 24.04 the build tools can be installed explicitly:

```sh
sudo apt-get update
sudo apt-get install --yes build-essential cmake pkg-config python3 xz-utils binutils git curl ca-certificates
```

Install Node/npm separately from a trusted distribution. Bootstrap never installs host packages and never executes Debian maintainer scripts or npm lifecycle scripts. It extracts pinned packages into an isolated prefix. Native dependencies use Debian 13/Trixie ia32; the FFI and Electron compiler sysroot is the separately pinned Bullseye ia32 sysroot. These are deliberately not interchangeable.

Compilation on an x86_64 host does not require executing ia32 programs. Running the result requires an ia32 glibc loader with the GLIBC symbol versions printed by `assemble_app.py`; a Debian 13 desktop with `libc6:i386` is the intended native-dependency baseline. The image does not bundle a competing glibc or loader. Display, audio, GPU and desktop-service requirements still apply to application acceptance.

Use a checkout path without whitespace for GNU make's existing source layout. All commands below start at the repository root.

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

The lockfiles are the reviewed trust root. A missing upstream archive or hash mismatch fails the command; it is not replaced with another version. To update dependencies, deliberately update the pins and review the corresponding ABI, licensing and acceptance results. A verified archive cache can be reused, but reuse of an already extracted tree assumes that local tree has not been modified. Use fresh prefixes for independent reproduction. Reproducible acquisition does not promise identical final binary bytes across arbitrary host tooling.

Electron runtime-package cache reuse checks every recorded file hash and symlink against the saved original inventory. A missing root/inventory, changed or added file, deleted file, or changed symlink fails without regenerating trusted metadata. Select a fresh runtime prefix to reacquire damaged inputs; a stamp alone is not evidence that an extracted runtime is intact.

### Explicit locations and existing caches

No developer-specific directory is a default. `bootstrap.py --help` exposes `--cache`, `--deps-prefix`, `--toolchain-prefix`, `--json-prefix`, `--sqlite-source`, `--ffi-archives`, `--runtime-prefix`, `--work` and `--jobs`. The toolchain prefix has the same relative LLVM/sysroot layout as an Electron source checkout, but it does not need a built Electron executable to compile native C or FFI.

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

The SQLite cache must retain the existing `vendor/sqlite3mc-1.4.6` suffix because the public C headers retain that include path. `WELINK_NATIVE_CC=/absolute/path/to/clang` can override the native C compiler; otherwise the explicit Electron/toolchain prefix supplies it, or `clang` is resolved from PATH. FFI intentionally verifies the pinned compiler and sysroot rather than accepting an arbitrary host compiler.

For direct make use the corresponding variables: `DEPS_ROOT`, `ELECTRON_SOURCE`, `NATIVE_CC`, `JSON_PREFIX`, `SQLITE_SOURCE`, `OUTPUT` and `INTEGRITY_INCLUDE`. The `NativeBuild/cc-ia32` wrapper uses `WELINK_NATIVE_DEPS`, `WELINK_ELECTRON_SOURCE` and optional `WELINK_NATIVE_CC` for the existing standalone C verification drivers. Changing compiler/dependency inputs requires a fresh native output directory; do not mix object caches across configurations.

An old FFI archive cache may lack the separately acquired legal notices. Populate it with `bootstrap.py --component ffi --ffi-archives DIR` before building, or use the default freshly acquired cache. No old cache is required by any command.

## Build the bytecode-compatible Electron runtime

This step is much larger than the native build. It acquires upstream Electron/Chromium sources through `gclient`; the source repository does **not** contain a Chromium checkout or any prebuilt runtime. Plan for upstream Electron's Linux build dependencies and substantial disk/memory requirements. Follow the [Electron Linux build prerequisites](https://www.electronjs.org/docs/latest/development/build-instructions-linux) for the host; old Chromium 108 can require compatible versions of those host tools. These commands do not use an installed vendor client or account.

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

This section is **not run by public CI**. It needs:

1. The exact lawfully obtained vendor `resources/app` baseline. `prepare_overrides.py` verifies its hashes; a different version is not silently accepted. Supply no real profile, log, keystore or account data.
2. The custom Electron runtime above, the native public-input build, and FFI output.
3. Private/provider assets at their existing local paths: `Conference/vendor/hrtc-12.eb3d2838.js` (SHA-256 `ac223517d8cd516c2113181a5035093c9f30680380a61c518d08e79fd6c535f4`), and `Conference/vendor/custom-background/` with its authentic `LICENSE`, model files and `integrity.json` (manifest SHA-256 `96ee5943a35ab3888fcf75ac84ab239ada21d9e6705cf4134122aa3dba1f691e`). The assembler checks each model-file hash. Obtain these only with appropriate rights; this repository neither redistributes them nor substitutes dummy models/providers. Their original notices must remain available.
4. Fresh output and manifest directories. Keep all proprietary inputs and generated images local and ignored.

For assembly, the default repository-local SQLite source is required for notice extraction, even if an external source cache was used to compile. `bootstrap.py --component sources` supplies it without any commercial inputs. Set your vendor/runtime locations explicitly:

```sh
ROOT=$PWD
VENDOR_APP=/absolute/path/to/trusted/resources/app
ELECTRON_OUT=/absolute/path/to/custom-electron/src/out/ia32
IMAGE="$ROOT/.work/image-r45.11"
MANIFEST="$ROOT/.work/integrity-r45.11"

python3 NativeBuild/prepare_overrides.py \
  --vendor-app "$VENDOR_APP" --output NativeIntegration/app-overrides
python3 NativeBuild/bootstrap.py --component runtime

# First, build all non-checker implementations against the selected dependencies.
./build.sh .work/native-libs native-only

# Then prepare the complete immutable baseline and its real generated checker header.
python3 NativeBuild/assemble_app.py prepare \
  --vendor-app "$VENDOR_APP" \
  --native-integration "$ROOT/NativeIntegration" --conference "$ROOT/Conference" \
  --ffi-output "$ROOT/.work/ffi-output" --electron-out "$ELECTRON_OUT" \
  --native-libs "$ROOT/.work/native-libs" --deps-prefix "$WELINK_NATIVE_DEPS" \
  --electron-prefix "$ROOT/.inputs/electron-runtime/root" \
  --output "$IMAGE" --manifest-dir "$MANIFEST" \
  --build-id hit-native-linux-ia32-r45.11 --native-license "$ROOT/LICENSE"

# Compile only the checker against exactly that baseline, then finalize it.
WELINK_NATIVE_INTEGRITY_INCLUDE="$MANIFEST" \
  ./build.sh .work/native-libs sqlite_plugin.dll.so
python3 NativeBuild/assemble_app.py finalize \
  --output "$IMAGE" --manifest-dir "$MANIFEST" \
  --checker "$ROOT/.work/native-libs/sqlite_plugin.dll.so"
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
