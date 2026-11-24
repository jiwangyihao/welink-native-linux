#!/bin/bash
# Build a real Amber PM layered package using the installed upstream converter.
# Requires an installed APM base, sudo authorization, fuse-overlayfs, fakeroot,
# and network access to that base's Debian/Spark dependency repositories.
set -euo pipefail
usage() {
    printf '%s\n' 'Usage: build_apm.sh --deb PATH --output DIRECTORY [--base NAME]' \
        'Default base: amber-pm-bookworm (installed Debian 12 base, glibc 2.36).' \
        'The converter installs libc6-i386 from the DEB dependencies into the app layer.' \
        'No application or user profile is launched/modified by this build.'
}
fail() { printf 'build_apm: %s\n' "$*" >&2; exit 1; }
deb= output= base=amber-pm-bookworm
while (($#)); do
    case "$1" in
        --deb|--output|--base)
            (($# >= 2)) || fail "Missing value for $1"
            case "$1" in --deb) deb=$2 ;; --output) output=$2 ;; --base) base=$2 ;; esac
            shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) fail "Unknown argument: $1" ;;
    esac
done
[[ -n $deb && -n $output ]] || { usage >&2; exit 1; }
[[ $base =~ ^[a-z0-9][a-z0-9+.-]+$ ]] || fail 'Invalid APM base name'
for tool in dpkg-deb dpkg-query dpkg python3 fakeroot fuse-overlayfs sudo; do
    command -v "$tool" >/dev/null || fail "Required build tool not installed: $tool"
done
[[ -x /usr/bin/amber-pm-convert && -x /var/lib/apm/apm/files/ace-run-pkg ]] || fail 'Install Amber PM and its real converter first'
deb=$(realpath -e -- "$deb")
[[ -f $deb ]] || fail 'The native DEB must be a regular file'
native_version=$(dpkg-deb -f "$deb" Version)
[[ $(dpkg-deb -f "$deb" Package) == cn.edu.hit.welink.native &&
   $native_version =~ ^45\.(0|[1-9][0-9]*)-1$ &&
   $(dpkg-deb -f "$deb" Architecture) == amd64 ]] || fail 'Expected a versioned cn.edu.hit.welink.native amd64 package'
base_root=/var/lib/apm/apm/files/ace-env/var/lib/apm/$base/files/ace-env
[[ -d $base_root && -f $base_root/var/lib/dpkg/status ]] || fail "Install the complete APM base with: apm install $base"
glibc=$(dpkg-query --admindir="$base_root/var/lib/dpkg" -W -f='${Version}' libc6:amd64)
dpkg --compare-versions "$glibc" ge 2.34 || fail "The selected base glibc $glibc is older than 2.34"
mkdir -p -- "$output"
output=$(realpath -e -- "$output")
package=cn.edu.hit.welink.native.apm
version=${native_version}-apm
basename=${package}_${version}_amd64.deb
[[ ! -e $output/$basename && ! -L $output/$basename ]] || fail 'Refusing to overwrite an existing APM release'
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
work=$(mktemp -d "$output/.welink-apm.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/input" "$work/converted" "$work/final"
dpkg-deb --raw-extract "$deb" "$work/input"
/usr/bin/python3 -I - "$work/input" "$here/apm_launch.sh" <<'PY'
from pathlib import Path
import re
import shutil
import sys

root, launcher = map(Path, sys.argv[1:])
package = 'cn.edu.hit.welink.native.apm'
app = root / 'opt/apps/cn.edu.hit.welink.native'
files = app / 'files'
for name in ('package_install.py', 'seed.py', 'chrome-sandbox', 'tools/install_desktop.py'):
    if not (files / name).is_file() or (files / name).is_symlink():
        raise SystemExit('Missing regular bootstrap component: ' + name)
control = (root / 'DEBIAN/control').read_text()
if not re.search(r'\blibc6-i386\s*\(\s*>=\s*2\.34\s*\)', control):
    raise SystemExit('The DEB must declare libc6-i386 (>= 2.34) so the converter installs the ia32 loader')
shutil.copyfile(launcher, files / 'bin/launch')
(files / 'bin/launch').chmod(0o755)
(files / 'bin/setup').write_text('#!/bin/bash\nset -euo pipefail\nexec /opt/apps/cn.edu.hit.welink.native/files/bin/launch --no-launch "$@"\n')
(files / 'bin/setup').chmod(0o755)
# The converter reads extracted desktop files with ordinary host tools. Resolve
# the DEB's absolute entry/icon symlinks into staged regular files first: never
# let its sed/grep follow a path into a different installed host package.
old_desktop = app / 'entries/applications/cn.edu.hit.welink.native.desktop'
if old_desktop.is_symlink() or not old_desktop.is_file():
    raise SystemExit('Missing canonical Spark desktop entry')
text = old_desktop.read_text()
replacements = {
    'Name': 'WeLink (HIT Native / APM)',
    'Name[zh_CN]': '哈工大 WeLink（原生 APM 版）',
    'Exec': '/opt/apps/cn.edu.hit.welink.native/files/bin/launch %u',
    'TryExec': '/opt/apps/cn.edu.hit.welink.native/files/bin/launch',
    'Icon': package,
}
for key in replacements:
    if sum(line.startswith(key + '=') for line in text.splitlines()) != 1:
        raise SystemExit('Unexpected desktop entry field: ' + key)
text = '\n'.join(key + '=' + replacements[key] if (key := line.partition('=')[0]) in replacements else line
                 for line in text.splitlines()) + '\n'
old_desktop.unlink()
(app / 'entries/applications' / (package + '.desktop')).write_text(text)
public_entry = root / 'usr/share/applications/cn.edu.hit.welink.native.desktop'
public_entry.unlink()
(public_entry.parent / (package + '.desktop')).write_text(text)
old_icon = app / 'entries/icons/hicolor/scalable/apps/cn.edu.hit.welink.native.svg'
icon = old_icon.read_bytes()
old_icon.unlink()
(old_icon.parent / (package + '.svg')).write_bytes(icon)
public_icon = root / 'usr/share/icons/hicolor/scalable/apps/cn.edu.hit.welink.native.svg'
public_icon.unlink()
(public_icon.parent / (package + '.svg')).write_bytes(icon)
for old, new in (('welink-native', 'welink-native-apm'), ('welink-native-setup', 'welink-native-apm-setup')):
    link = root / 'usr/bin' / old
    target = link.readlink()
    link.unlink()
    link.with_name(new).symlink_to(target)
PY
dpkg-deb --root-owner-group -Znone --build "$work/input" "$work/prepared.deb"
printf 'Converting with %s (glibc %s); dependency resolution may require network and sudo.\n' "$base" "$glibc"
(
    cd -- "$work/converted"
    /usr/bin/amber-pm-convert --base "$base" --pkgname "$package" --version "$version" "$work/prepared.deb"
)
converted=$work/converted/$basename
[[ -f $converted ]] || fail 'The converter did not produce the expected APM artifact'
[[ $(dpkg-deb -f "$converted" Package) == "$package" &&
   $(dpkg-deb -f "$converted" Version) == "$version" &&
   $(dpkg-deb -f "$converted" Architecture) == amd64 ]] || fail 'Converter output metadata differs from the APM contract'
dpkg-deb --raw-extract "$converted" "$work/final"
/usr/bin/python3 -I - "$work/final" "$work/input" "$base_root" "$base" <<'PY'
import hashlib
from pathlib import Path, PurePosixPath
import shutil
import sys

root, original, base_root = map(Path, sys.argv[1:4])
base = sys.argv[4]
package = 'cn.edu.hit.welink.native.apm'
layer = root / 'var/lib/apm' / package
core = layer / 'files/core'
app_path = Path('opt/apps/cn.edu.hit.welink.native/files')
if not core.is_dir() or (layer / 'info').read_text().splitlines() != [base]:
    raise SystemExit('Converter output lacks the actual selected APM layer/dependency metadata')
if base not in (layer / 'info_debug').read_text().splitlines():
    raise SystemExit('APM recursive dependency metadata is missing')
control_path = root / 'DEBIAN/control'
control = control_path.read_text()
depends = next((line[9:] for line in control.splitlines() if line.startswith('Depends: ')), '')
if base not in [dependency.strip().split()[0] for dependency in depends.split(',')]:
    raise SystemExit('The converted package does not depend on its installed base')
entry = layer / 'entries/applications' / (package + '.desktop')
lines = entry.read_text().splitlines()
if ('Exec=apm run ' + package + ' /opt/apps/cn.edu.hit.welink.native/files/bin/launch %u' not in lines or
        'X-APM-APPID=' + package not in lines or 'Icon=' + package not in lines):
    raise SystemExit('The real converter did not create the expected APM desktop dispatch')
if list((layer / 'entries/applications').glob('cn.edu.hit.welink.native.desktop')):
    raise SystemExit('The APM package must not export the host native desktop identity')
# Check payload bytes against the prepared source, and restore its file modes:
# upstream converter blanket-chmods everything to 0755. APM chrome-sandbox is
# deliberately non-setuid; Chromium uses its nested namespace/seccomp backend.
for source in (original / app_path).rglob('*'):
    if source.is_dir():
        continue
    target = core / app_path / source.relative_to(original / app_path)
    if source.is_symlink():
        if not target.is_symlink() or target.readlink() != source.readlink():
            raise SystemExit('Converted bootstrap symlink differs: ' + str(target))
    else:
        if target.is_symlink() or not target.is_file() or hashlib.sha256(target.read_bytes()).digest() != hashlib.sha256(source.read_bytes()).digest():
            raise SystemExit('Converted bootstrap bytes differ: ' + str(target))
        target.chmod(0o755 if source.name == 'chrome-sandbox' else source.stat().st_mode & 0o777)
# Resolve links against the actual layered root, not the build host's /lib.
def resolve_layer(filename):
    pending = list(PurePosixPath(filename).parts[1:])
    resolved = []
    links = 0
    while pending:
        part = pending.pop(0)
        if part in ('', '.'):
            continue
        if part == '..':
            if resolved:
                resolved.pop()
            continue
        relative = Path(*resolved, part)
        candidates = [directory / relative for directory in (core, base_root)]
        found = next((candidate for candidate in candidates if candidate.exists() or candidate.is_symlink()), None)
        if found is None:
            return None
        if found.is_symlink():
            links += 1
            if links > 40:
                raise SystemExit('Cyclic loader link in APM layers')
            destination = found.readlink()
            if destination.is_absolute():
                resolved = []
            pending = list(destination.parts[1:] if destination.is_absolute() else destination.parts) + pending
        else:
            resolved.append(part)
    return found
loader = resolve_layer('/lib/ld-linux.so.2')
if loader is None or not loader.is_file() or loader.read_bytes()[:5] != b'\x7fELF\x01':
    raise SystemExit('The converted layers do not supply the real ELF32 /lib/ld-linux.so.2 loader')
for private in ('home', 'root'):
    if (core / private).exists() and any((core / private).iterdir()):
        raise SystemExit('Refusing to package user/private content under ' + private)
# Converter's generic postrm recursively deletes /home/*/.apm/<package>.
# Distribution removal must retain profiles and caches; APM owns entry cleanup.
(root / 'DEBIAN/postrm').unlink(missing_ok=True)
work = layer / 'files/work'
if work.exists():
    shutil.rmtree(work)
work.mkdir(mode=0o755)
size = sum(path.stat().st_size for path in root.rglob('*') if path.is_file() and not path.is_symlink())
control_path.write_text('\n'.join('Installed-Size: ' + str((size + 1023) // 1024) if line.startswith('Installed-Size: ') else line
                                  for line in control.splitlines()) + '\n')
(root / 'DEBIAN/md5sums').write_text(''.join(hashlib.md5(path.read_bytes()).hexdigest() + '  ' + path.relative_to(root).as_posix() + '\n'
    for path in sorted(root.rglob('*')) if path.is_file() and not path.is_symlink() and path.relative_to(root).parts[0] != 'DEBIAN'))
PY
dpkg-deb --root-owner-group --uniform-compression -Zxz -z6 --build "$work/final" "$work/final.deb"
[[ $(dpkg-deb -f "$work/final.deb" Package) == "$package" &&
   $(dpkg-deb -f "$work/final.deb" Version) == "$version" &&
   $(dpkg-deb -f "$work/final.deb" Architecture) == amd64 ]] || fail 'Final APM metadata validation failed'
# A same-filesystem link publishes atomically without replacing another release.
ln -- "$work/final.deb" "$output/$basename"
sha256sum -- "$output/$basename"
printf 'APM artifact: %s\n' "$output/$basename"
