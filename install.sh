#!/bin/bash
# Fresh package installation is separate from the native baseline-delta updater.
set -euo pipefail

usage() {
    cat <<'USAGE'
Usage: bash install.sh [--apm] [--version r45.N] [--verify-only]
       bash install.sh --help

Install the signed Linux amd64 package from jiwangyihao/welink-native-linux.
The default is the normal DEB at r45.18; --apm selects the separate APM package.
Only canonical r45.N releases are accepted (no leading zeroes in N).

  --apm           Use sudo apm install instead of sudo apt-get install.
  --version TAG   Select an explicit release, for example r45.18.
  --verify-only   Download and authenticate the selected package, print its
                  SHA256 and size, then remove downloads without installing.
  --help          Show this help.

Requirements: Linux, Debian amd64, Bash, curl, python3, and OpenSSL 3 or newer
with Ed25519 pkeyutl -rawin support. Installation also requires sudo and the
selected package manager. Nothing is installed to satisfy prerequisites.
Run installation as your desktop user, never with sudo/root; only the package
manager is elevated. Root may use --help or --verify-only, not installation.
Downloads use a private directory under trusted /tmp; TMPDIR is ignored.
No application is launched and no user profile is downloaded or changed here.
USAGE
}

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

version=r45.18
version_set=0
kind=deb
verify_only=0
while (( $# )); do
    case "$1" in
        --help) usage; exit 0 ;;
        --apm) kind=apm; shift ;;
        --verify-only) verify_only=1; shift ;;
        --version)
            if (( $# < 2 || version_set )); then
                printf 'Error: --version requires one value and may appear only once.\n' >&2
                exit 2
            fi
            version=$2
            version_set=1
            shift 2
            ;;
        *) printf 'Error: Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
done
if [[ ! $version =~ ^r45\.(0|[1-9][0-9]{0,15})$ ]]; then
    fail 'Version must be a canonical r45.N release, for example r45.18.'
fi
revision=${version#r45.}
if (( 10#$revision > 9007199254740991 )); then
    fail 'Release revision exceeds the supported exact-integer range.'
fi
if (( EUID == 0 && ! verify_only )); then
    fail 'Run as your desktop user without sudo. Only --verify-only is allowed as root.'
fi

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        printf 'Error: Required command not found: %s. Nothing was installed.\n' "$1" >&2
        exit 127
    fi
}
for program in curl python3 openssl dpkg uname mktemp rm cat; do
    require_command "$program"
done
system=$(uname -s)
[[ $system == Linux ]] || fail 'Only Linux systems are supported.'
architecture=$(dpkg --print-architecture)
[[ $architecture == amd64 ]] || fail 'Only Debian amd64 systems are supported.'
manager=apt-get
if [[ $kind == apm ]]; then manager=apm; fi
if (( ! verify_only )); then
    require_command sudo
    require_command "$manager"
fi

umask 077
work_dir=''
cleanup() {
    local status=$?
    trap - EXIT
    if [[ -n $work_dir ]]; then
        if ! rm -rf -- "$work_dir"; then
            printf 'Error: Could not remove temporary directory: %s\n' "$work_dir" >&2
            if (( status == 0 )); then status=1; fi
        fi
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# The package manager later reopens the verified file by pathname. A private
# child alone is insufficient if another user can rename entries in its parent.
# Ignore TMPDIR and require a root-owned, non-symlink system temporary directory.
python3 -I - <<'PY'
import os
import stat
import sys

for directory in ("/", "/tmp"):
    info = os.lstat(directory)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
        sys.exit("Error: Temporary storage requires a root-owned, non-symlink directory: " + directory)
    if info.st_mode & 0o022 and (directory == "/" or not info.st_mode & stat.S_ISVTX):
        sys.exit("Error: Unsafe writable parent of temporary storage: " + directory)
PY
work_dir=$(mktemp -d -- /tmp/welink-native-install.XXXXXXXXXX)

base_url="https://github.com/jiwangyihao/welink-native-linux/releases/download/$version"
download() {
    printf 'Downloading %s from release %s...\n' "$1" "$version"
    # Ignore curlrc, forbid non-TLS initial/redirect URLs, and never use manifest URLs.
    curl --disable --fail --silent --show-error --location \
        --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 5 \
        --max-filesize "$3" --output "$2" "$base_url/$1"
}
download native-packages.json "$work_dir/native-packages.json" 65536
download native-packages.sig "$work_dir/native-packages.sig" 89
cat > "$work_dir/trusted-public-key.pem" <<'PUBLIC_KEY'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA9h/lwDPg2F8O9Us+A5JwlKw3d4eOUo5XmghfNRZpc70=
-----END PUBLIC KEY-----
PUBLIC_KEY

# Decode only the signature here. No descriptor is consumed before verification.
python3 -I - "$work_dir/native-packages.json" "$work_dir/native-packages.sig" \
    > "$work_dir/native-packages.sig.bin" <<'PY'
import base64
import pathlib
import re
import sys

manifest, signature = map(pathlib.Path, sys.argv[1:])
if not 0 < manifest.stat().st_size <= 65536:
    sys.exit("Error: Package manifest must be nonempty and at most 65536 bytes.")
if signature.stat().st_size != 89:
    sys.exit("Error: Invalid Ed25519 signature length.")
encoded = signature.read_bytes()
if re.fullmatch(rb"[A-Za-z0-9+/]{86}==\n", encoded) is None:
    sys.exit("Error: Invalid Ed25519 signature encoding.")
signature_bytes = base64.b64decode(encoded[:-1], validate=True)
if len(signature_bytes) != 64 or base64.b64encode(signature_bytes) + b"\n" != encoded:
    sys.exit("Error: Noncanonical Ed25519 signature encoding.")
sys.stdout.buffer.write(signature_bytes)
PY
if openssl pkeyutl -verify -pubin -inkey "$work_dir/trusted-public-key.pem" \
    -rawin -in "$work_dir/native-packages.json" \
    -sigfile "$work_dir/native-packages.sig.bin" >/dev/null; then
    :
else
    status=$?
    printf 'Error: Publisher signature verification failed; nothing was installed. OpenSSL with Ed25519/-rawin support (3 or newer) is required.\n' >&2
    exit "$status"
fi

python3 -I - "$work_dir/native-packages.json" "$version" "$kind" \
    > "$work_dir/selected-package" <<'PY'
import json
import pathlib
import re
import sys


def fail(message):
    sys.exit("Error: " + message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError("Non-JSON numeric constant")


filename, version, selected_kind = sys.argv[1:]
try:
    manifest = json.loads(pathlib.Path(filename).read_bytes().decode("utf-8"),
                          object_pairs_hook=unique_object, parse_constant=reject_constant)
except (UnicodeError, ValueError):
    fail("The signed package manifest is not unambiguous UTF-8 JSON.")
if type(manifest) is not dict or set(manifest) != {"format", "version", "sourceCommit", "packages"}:
    fail("Unexpected signed package manifest fields.")
if type(manifest["format"]) is not int or manifest["format"] != 1 or manifest["version"] != version:
    fail("The signed package manifest format or release does not match.")
if type(manifest["sourceCommit"]) is not str or re.fullmatch(r"[a-f0-9]{40}", manifest["sourceCommit"]) is None:
    fail("Invalid signed source commit.")
if type(manifest["packages"]) is not list or len(manifest["packages"]) != 2:
    fail("The signed manifest must contain exactly one DEB and one APM package.")
debian_version = version[1:] + "-1"
expected_assets = {
    "deb": "cn.edu.hit.welink.native_" + debian_version + "_amd64.deb",
    "apm": "cn.edu.hit.welink.native.apm_" + debian_version + "-apm_amd64.deb",
}
packages = {}
for item in manifest["packages"]:
    if type(item) is not dict or set(item) != {"kind", "architecture", "asset", "size", "sha256"}:
        fail("Unexpected signed package descriptor fields.")
    kind = item["kind"]
    if type(kind) is not str or kind not in expected_assets or kind in packages:
        fail("Invalid or duplicate signed package kind.")
    if item["architecture"] != "amd64" or item["asset"] != expected_assets[kind]:
        fail("Signed package architecture or canonical asset name does not match.")
    if type(item["size"]) is not int or not 0 < item["size"] <= 9007199254740991:
        fail("Invalid signed package size.")
    if type(item["sha256"]) is not str or re.fullmatch(r"[a-f0-9]{64}", item["sha256"]) is None:
        fail("Invalid signed package SHA256.")
    packages[kind] = item
for field in ("asset", "size", "sha256"):
    print(packages[selected_kind][field])
PY
mapfile -t descriptor < "$work_dir/selected-package"
asset=${descriptor[0]}
size=${descriptor[1]}
sha256=${descriptor[2]}
package_path="$work_dir/$asset"
download "$asset" "$package_path" "$size"
python3 -I - "$package_path" "$size" "$sha256" <<'PY'
import hashlib
import pathlib
import sys

filename, expected_size, expected_hash = sys.argv[1:]
package = pathlib.Path(filename)
if package.stat().st_size != int(expected_size):
    sys.exit("Error: Downloaded package size does not match the signed manifest; nothing was installed.")
hash_value = hashlib.sha256()
with package.open("rb") as stream:
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        hash_value.update(block)
if hash_value.hexdigest() != expected_hash:
    sys.exit("Error: Downloaded package SHA256 does not match the signed manifest; nothing was installed.")
PY
printf 'Authenticated %s (%s bytes, SHA256 %s).\n' "$asset" "$size" "$sha256"
if (( verify_only )); then
    printf 'Verification complete; no package manager was invoked. Temporary downloads will be removed.\n'
    exit 0
fi
printf 'Installing the authenticated package with sudo %s install...\n' "$manager"
sudo -- "$manager" install "$package_path"
printf 'Package manager completed successfully. Launch WeLink from your desktop as your normal user.\n'
