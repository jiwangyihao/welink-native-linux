# Releasing signed native builds

## Build identity and publication boundary

Native versions are `r45.N`; compare the final component numerically. Every image
has a `hit-native-linux-ia32-r45.N` identity and a manifest-specific integrity
checker. Follow [BUILD.md](BUILD.md) for the clean-input build entry point.
Prepare immutable assets, compile their real checker, then finalize the image.
Keep the previous image intact.

Public releases contain authored source, minimal adaptation deltas, the
generated native installers, and their signed manifest. Do not publish a
commercial image, original SDK, account/profile data, model without applicable
rights, whitebox tables, startup logs, or private recovery directories.

The first updater-enabled image must be installed as an immutable new image,
not injected into a running old image. Older releases which only open the
release page cannot acquire the new updater retroactively. Once the
updater-enabled build is running, subsequent supported releases install through
the native GUI without asking users to run Python assets.

## Publisher key and protocol

`NativeIntegration/update_public_key.pem` is the pinned Ed25519 public key,
included in the immutable application. Keep the corresponding private key
outside the repository, application, build output, and client. The runtime has
no environment/URL/IPC option for replacing its trust key. Synthetic keys in the
deterministic tests are selected only by the test's module loader.

Each release publishes:

- `native-update.json`: exact UTF-8 JSON bytes, format 1.
- `native-update.sig`: base64 Ed25519 signature over those exact bytes.
- `install-r45.N-from-r45.M.py`: one generated installer per exact supported
  baseline, bound to its build ID and `native/lib/sqlite_plugin.dll.so` SHA256.
- `install_desktop.py`: the matching desktop integration implementation.
- For fresh-install package releases: `install.sh`, the standard and APM `.deb`
  assets, `native-packages.json`, and `native-packages.sig` as described below.

The signed manifest includes `version`, `build`, full `sourceCommit`, all
installer names/sizes/SHA256s/base checker hashes, and the integration
name/size/SHA256. Tags, target identity, exact baseline, sizes and names must
match. Duplicate/ambiguous entries, downgrades, unsafe paths and unsigned assets
are rejected. Routine discovery reads the static `releases/latest/download/native-update.json` asset, not the rate-limited REST API. The discovered native tag selects a canonical tag manifest and signature; the two manifest byte streams must match, and the Ed25519 signature is required even when reporting `current`. Executable URLs never come from response data: downloads are constructed from this repository and tag. HTTPS redirects are limited to the explicit GitHub release/tag and release-asset hosts, with bounded count and ordinary TLS.

## Generate and sign a release

`BASE` is the exact supported installed image, `IMAGE` the finalized target,
`OUT` a new private output directory, and `VERSION`/`BASE_VERSION` their `r45.N`
versions. Repeat packaging for each supported baseline; never relabel an
existing image or substitute a checker from another build.

```sh
mkdir -p "$OUT"
cp NativeBuild/install_desktop.py "$OUT/install_desktop.py"
python3 NativeBuild/package_update.py \
  --base-image "$BASE" --image "$IMAGE" \
  --desktop-installer "$OUT/install_desktop.py" \
  --output "$OUT/install-${VERSION}-from-${BASE_VERSION}.py"

# Commit all reviewed source before signing/tagging; use that exact commit.
node NativeBuild/sign_update.js \
  --version "$VERSION" --source-commit "$SOURCE_COMMIT" \
  --private-key "$PRIVATE_SIGNING_KEY" \
  --public-key NativeIntegration/update_public_key.pem \
  --output "$OUT" --integration "$OUT/install_desktop.py" --notes "$RELEASE_NOTES" \
  --installer "$OUT/install-${VERSION}-from-${BASE_VERSION}.py"
# Supply additional --installer arguments for additional supported baselines.
(cd "$OUT" && sha256sum install-*.py install_desktop.py \
  native-update.json native-update.sig > SHA256SUMS)
```

The packager uses copy/literal deltas, validates reconstructed bytes, rejects
new upstream files and oversized upstream literals, and retains a commercial
base as a required local input. Inspect new literal material and publication
scope; a size limit is not a copyright or secret-scanning guarantee.

The signer's identity header comes from the actual generated installer. It
refuses a mismatched target or integration hash and validates every manifest
entry with the same protocol used by the client. Do not modify JSON whitespace
or assets after signing.

Release names and notes are included in the signed manifest. Publish the verified stable native release as GitHub's latest release; keep runtime-dependency releases marked `--latest=false`. A missing, inconsistent or invalid signed channel is an error, never a claim that the installed application is current.

## Fresh-install package assets

Build the finalized-image recipes and standard DEB using `Packaging/build_deb.py`
as documented in BUILD.md. Convert that exact DEB with `Packaging/build_apm.sh`
on an APM-equipped builder. An APM package is a real base/layer package, not the
same Debian file renamed. Test both bootstrap paths in isolated user profiles;
never use production credentials or report mere archive extraction as GUI proof.

```sh
node NativeBuild/sign_packages.js \
  --version "$VERSION" --source-commit "$SOURCE_COMMIT" \
  --deb "$OUT/cn.edu.hit.welink.native_${VERSION#r}-1_amd64.deb" \
  --apm "$OUT/cn.edu.hit.welink.native.apm_${VERSION#r}-1-apm_amd64.deb" \
  --private-key "$PRIVATE_SIGNING_KEY" \
  --public-key NativeIntegration/update_public_key.pem --output "$OUT"
cp install.sh "$OUT/install.sh"
(cd "$OUT" && sha256sum install.sh *.deb native-packages.json native-packages.sig >> SHA256SUMS)
```

This separate format-1 manifest binds the native version, exact public source
commit, and exactly one `deb` and `apm` descriptor (amd64, canonical filename,
size and SHA256). It uses the same Ed25519 publisher authority, but does not add
fields to or replace the baseline-specific `native-update.json` protocol.
The signer verifies actual `dpkg-deb` control metadata before signing.

Upload these additional assets to the same native release. Round-trip verify both
packages and run `bash install.sh --verify-only` and `bash install.sh --apm
--verify-only` against the public URLs before claiming the copy/paste entry is
available. Full installation must also exercise the actual package manager,
first-launch consent/acquisition, sealed-image validation and real desktop.
APM additionally requires actual nested namespace/seccomp sandbox evidence and
in-container lifecycle/URI handling. Never pass `--no-sandbox` to make a smoke pass.

State the package model in release notes: system-managed public bootstrap and
precompiled components, user-managed signed application images, explicit lawful
upstream input acquisition, and retained user data on package removal. Do not
describe these as offline commercial repacks or as store-approved submissions.

## Publish

```sh
gh release create "$VERSION" --repo jiwangyihao/welink-native-linux \
  --target "$SOURCE_COMMIT" --draft \
  --title "Native Linux $VERSION" --notes-file "$RELEASE_NOTES" \
  "$OUT"/install-*.py "$OUT/install_desktop.py" \
  "$OUT/native-update.json" "$OUT/native-update.sig" "$OUT/SHA256SUMS"
```

Download the uploaded assets into a separate directory, verify their signature,
sizes and SHA256s, then publish as stable. Drafts and prereleases are excluded
from stable selection. Release notes state exact baselines, source/license
links, actual acceptance evidence and limitations. `SHA256SUMS` is convenient
transport evidence, not a substitute for the publisher signature.

## Native GUI lifecycle

Automatic checks remain silent and fetch metadata/signatures only. The About
page's real **Check for updates** consumer offers **Download, update and
restart** only after publisher and exact-baseline verification. All old Windows
download/install/cancel APIs still reject with `ENOTSUP`; they are not aliases
for native installation.

The dedicated native progress window reports actual downloaded bytes,
reconstructed files and verified files. Canceling download/staging leaves the
current app, profile, launcher and MIME defaults unchanged. No running image is
modified. The generated installer stages a private side-by-side image and
verifies the complete inventory; the detached supervisor independently verifies
the publisher signature and executes only rehashed, sealed-memfd installer
bytes.

The supervisor runs as the desktop user in a separate systemd user service,
surviving the old application's service exit. Non-systemd/direct sessions use a
detached process; a systemd-owned app never silently falls back to an inherited
service lifetime. Required desktop dependencies include Python 3, OpenSSL with
Ed25519 support, util-linux `flock`, systemd's user session, and normal desktop
integration tools. Supervisor, new-version and rollback services receive explicit
HOME/display/session/XDG settings rather than silently using the user manager's
environment. Node, dynamic-loader, OpenSSL and Python injection variables are
removed, including from the service environment.

Sandbox authorization is narrow: first try an ordinary hardlink to the
verified, already root-owned mode-4755 sandbox. If needed, try noninteractive
sudo, then `pkexec` with the desktop's graphical polkit authorization agent.
Only a fixed helper linking the existing verified sandbox is elevated. Source
and destination-directory FDs stay open in the unprivileged installer, and the
privileged operation is FD-anchored. The installer itself never runs as root.
There is no `--no-sandbox`, TLS exception, arbitrary root copy, or root chmod.
Staging must be on the installation filesystem for hardlink reuse; different
sandbox bytes require a separately provisioned runtime, not an unsafe fallback.

After staging, the app calls its existing `appService.exitApp` path. The
supervisor observes the actual old PID/start time and profile processes exiting;
an exit refusal/timeout leaves activation undone. It revalidates the staged
image, privately backs up the explicit current native profile, preserves the
exact desktop identity and all MIME defaults, and migrates only a profile-owned
autostart entry without changing its enabled/disabled state. Customized or
different-profile launchers are not overwritten.

Profile mutation is protected by a shared startup gate, not merely a process
scan. Its stable path is
`PROFILE_PARENT/.welink-native-profile-gates/SHA256_CANONICAL_PROFILE.lock`,
where the hash is over the UTF-8 canonical absolute profile path. The private
directory is mode 0700 and its owned, single-link regular lock file is mode 0600.
It is outside the profile and is neither moved during rollback nor selected by
HOME/XDG settings.

The launcher acquires SH before creating the profile, marker or pixbuf cache;
its inherited descriptor is validated and actually locked, never accepted from
an environment boolean. `main.js` independently acquires lifetime SH before
profile initialization, covering direct Electron startup, and exports the
canonical profile for native workers. Import/export workers retain their own
validated SH descriptor through actual process exit, including COMMITTING and
cleanup; requesting cancellation does not release ownership. The supervisor
requires EX throughout backup/activation and restoration, releases it before
launching an app, and retains process/inode/ownership checks as additional
defenses. A contender admitted after a process scan prevents mutation; a
contender arriving during mutation cannot enter the profile until it finishes.

Older, retained binaries which predate this gate cannot be made cooperative
retroactively. Do not directly run those binaries during update or recovery.
Existing process checks can reject detected legacy instances but do not provide
race-free admission for their future manual launches. Genuine GUI acceptance
therefore requires a gate-aware baseline and target, including their native
workers; do not describe an ungated legacy image as having the same protection.


New startup success requires a receipt from the immutable new application:
the real login or message route, mounted visible UI, the whole shared-HTTP
exports, and real login guest controls or mounted IM content must be stable for
three seconds. A PID, window, `did-finish-load`, or `coreUpgrade` object alone is
not readiness. `/login/LoadingFailed` is an explicit failure. The supervisor
checks the receipt's token, build, profile, live process identity and executable.

On failed startup, the supervisor asks the new app to exit normally, and may
terminate only its own failed launch if necessary. It never SIGKILLs the user's
old app. It refuses restoration while any profile instance is live. Planned
activation writes are journaled before application; rollback compares current
bytes against that transaction, restores the pre-launch profile before reopening
the old version, and never overwrites an unrelated later integration edit.
Stopping safely is reported as an error, never as installation success.

## Parent-run acceptance

Implementation agents do not run these checks. After all assembly changes land:

```sh
node NativeIntegration/verify_native_update_protocol.js
python3 NativeIntegration/verify_native_update_lifecycle.py
node NativeIntegration/verify_native_update.js --app "$IMAGE/resources/app"
```

The last command executes the real assembled `HwUpgrade` consumer and the entire
`libraries/js/httpWithRsSdk.js` **as a page script**, using the pedestal's require
context. Retain the assembler's absolute
`process.resourcesPath + '/app/native/update_renderer'` resolution; a relative
`../../native/...` import resolves from the page and breaks real startup.
Deterministic I/O fixtures are not GUI/real-install evidence.

Exercise the actual generated installer in an isolated per-user HOME/profile,
not a logged-in user's home. Verify stage-only behavior, modes, protected
sandbox reuse, denied/canceled graphical authorization, complete inventory
checks, explicit profile/default preservation, and rollback from a failed
new-version startup. The lifecycle tests include sealed bytes, foreign trust
roots, changed integration/profile ownership, partial activation, both
profile-rename crash windows, old-exit refusal, canceled staging, invalid/dead
readiness receipts, a real contender inserted after the final process scan,
actual launcher pre-write gating, inherited-FD forgery rejection, gate retention
through exec/exit, and explicit new/rollback service environment forwarding.
Also run the built-worker `ImportExport/verify_profile_gate.c` acceptance for
actual worker spawn/exec, cancellation versus exit and commit-lifetime ownership.

For genuine release-to-release GUI acceptance, use two actual immutable
updater-enabled builds and a signed compatible stable release. Start the old
application normally with its explicit isolated profile and
`--remote-debugging-port=19249`. The read-only observer uses Python 3.12+ and the pinned dependency in `NativeIntegration/update-qa-requirements.txt` (install it in a test virtual environment); it
invokes the real manual-check consumer; a person or desktop automation must
operate the real native controls. It never inserts UI, patches routes, changes
app state, supplies a fake release, or manufactures readiness.

```sh
# First cancel in the actual progress window during staging, then close the
# real cancellation/error dialog. Old PID and integration/defaults must remain.
python3 NativeIntegration/verify_native_update_surface.py \
  --port 19249 --expect available --version "$BASE_VERSION" \
  --action cancel --target "$VERSION" --profile "$PROFILE"

# Then choose Download, update and restart and allow the normal exit flow.
python3 NativeIntegration/verify_native_update_surface.py \
  --port 19249 --expect available --version "$BASE_VERSION" \
  --action install --target "$VERSION" --profile "$PROFILE"
```

For a deliberately failed launch in an isolated fixture, `--action rollback`
requires restored integration and an actual reopened old executable. `--home`
points at the isolated HOME without changing Python module lookup.

Capture actual download/staging/authorization UI. Verify the new executable and
build identity, old PID exit, preserved profile/defaults, native readiness
receipt and a usable real login/message route. No account login, message or
meeting action is needed. Only report actual observed outcomes. Finally repeat
the normal About check on the installed version and confirm `current`.

## Manual installation and private recovery

Manual recovery remains supported, but is not the GUI update path. Verify
`native-update.sig` against the trusted image/repository public key before
executing any downloaded asset:

```sh
base64 --decode native-update.sig > native-update.sig.bin
openssl pkeyutl -verify -pubin \
  -inkey "$BASE/resources/app/native/update_public_key.pem" \
  -rawin -in native-update.json -sigfile native-update.sig.bin
```

Check the signed target/build, exact baseline checker and selected installer
name/size/SHA256, plus the integration size/SHA256. Inspect the matching source.
Exit the application normally before activation. The generated installer's
default stages/verifies only; manual activation requires an explicit profile:

```sh
python3 "install-${VERSION}-from-${BASE_VERSION}.py" \
  --base-image "$BASE" --profile "$PROFILE" \
  --preserve-defaults --desktop-id cn.edu.hit.welink.native.desktop --activate
```

The installer never starts the app. `install_desktop.py` also supports explicit
`--previous-image`/`--autostart-file` migration and `--plan` for exact, no-write
activation planning.

Private transaction journals/status/logs are under
`~/.local/state/welink-native-updates/transaction-*`. Profile backups and the
failed-start profile live in a private `.welink-update-*` sibling of the
explicit profile, on its filesystem. Keep those directories private; never
upload them as acceptance logs. Successful updates retain a backup for
deliberate recovery rather than deleting user data.

If the supervisor was externally interrupted during activation, first exit all
instances using that profile. Use the old immutable application's helper:

```sh
python3 "$BASE/resources/app/native/update_supervisor.py" \
  "$PRIVATE_TRANSACTION_DIRECTORY" --recover
```

Recovery revalidates the signature, obtains the update lock, checks the journal
and live profile ownership, and restores only this incomplete transaction.
Completed transactions are rejected: an old backup must not erase later user
data. If another live process, replaced profile or later integration edit
prevents safe restoration, retain the private backup and resolve that ownership
conflict first; do not force-delete a profile or switch binaries beneath it.
