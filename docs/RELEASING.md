# Releasing native builds

## Separation of versions

- Upstream desktop input: pinned vendor version and hashes in the override/assembly inputs.
- Native port: `r45.9`, `r45.10`, …; the numeric components, not lexical order, determine which native build is newer.
- Image identity: `hit-native-linux-ia32-r45.11:sha256:…`, produced by the actual immutable asset manifest.

A GitHub release does not imply that the upstream Windows updater can install it.

## Build and verify privately

Follow [BUILD.md](BUILD.md) with trusted local vendor/provider inputs. Keep all inputs, generated overrides and images in ignored/private work directories. Verify the native ABI, affected renderer behavior and real isolated Electron surfaces. Account/production-meeting tests require separate explicit authorization; do not publish their logs.

Assembly order is mandatory: prepare immutable assets, compile the integrity checker against that generated manifest, then finalize. A checker from a different image is invalid. Preserve the previous image for rollback.

## Produce a public update

`BASE` is the exact supported installed image; `IMAGE` is the finalized new image. `OUT` is a new private output directory. Native r45.11 publishes separate deltas from r45.8, r45.9 and r45.10. The latter two are withdrawn from stable selection because of a shared-HTTP-script startup regression. Generate each delta independently and name its required base explicitly; the example below uses r45.8.

```sh
mkdir -p "$OUT"
python3 NativeBuild/package_update.py \
  --base-image "$BASE" --image "$IMAGE" \
  --desktop-installer NativeBuild/install_desktop.py \
  --output "$OUT/install-r45.11-from-r45.8.py"
cp NativeBuild/install_desktop.py "$OUT/install_desktop.py"
(cd "$OUT" && sha256sum install-r45.11-*.py install_desktop.py > SHA256SUMS)
```

The packager uses copy/literal operations rather than embedding complete changed vendor bundles. It checks reconstructed bytes, rejects new upstream files and oversized upstream literals, and preserves the installed base as a required input. Inspect the publication diff and any new literal material; a size limit is not a copyright or secret-scanning guarantee.

Test the generated installer in a new synthetic HOME with a private copy of the supported baseline. Check whole-image verification, restrictive legacy modes, the SUID sandbox link, desktop identity/default preservation and no profile reset. Do not use a logged-in user's home as a disposable fixture.

## Publish

Commit the reviewed source before tagging, so every distributed native change has its corresponding MPL source. GitHub's source archives then refer to the same commit.

```sh
gh release create r45.11 --repo jiwangyihao/welink-native-linux \
  --target "$SOURCE_COMMIT" --draft \
  --title "Native Linux r45.11" --notes-file "$RELEASE_NOTES" \
  "$OUT"/install-r45.11-*.py "$OUT/install_desktop.py" "$OUT/SHA256SUMS"
```

Before publishing the draft, download the uploaded assets into a separate directory and verify their checksums. Release notes must state the exact baseline, dependencies, manual-install commands, license/source link, what was actually tested, and limitations. Then publish the draft as a stable release. Do not upload a complete proprietary image, private profile, original SDK, model, debug dump, or old full-payload installer.

The GUI only checks Releases and opens a validated page after the user's decision. It never executes a downloaded installer, silently downgrades or announces installation success. Publishing a release is therefore distinct from installing it on any client.

## Manual installation

Download both installers and `SHA256SUMS` from the same release, verify them, and inspect the source before execution. Exit the old application normally before switching. Run the versioned installer with `--activate`; it stages and verifies a side-by-side image and updates the desktop integration without starting the application. The native profile remains separate from all images.

The old image remains available. Rollback requires normal exit of the new application and deliberately restoring the previous launcher/integration; never switch binaries underneath an active account session.
