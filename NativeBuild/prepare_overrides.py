#!/usr/bin/env python3
"""Recreate private vendor overrides from checked copy/literal patches.

Apply: python3 NativeBuild/prepare_overrides.py --vendor-app APP --output NativeIntegration/app-overrides
Maintain: add --from-overrides PRIVATE_OVERRIDES instead of --output to export a new manifest.
The original vendor files must be supplied lawfully by the builder. No application is executed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
from delta import FORMAT, apply_patch, literal_size, make_patch

ALLOWED = {'.js', '.json', '.html', '.css', '.svg'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def relative_path(name):
    path = Path(name)
    if path.is_absolute() or not path.parts or any(p in ('.', '..') for p in path.parts) or '\\' in name or path.suffix not in ALLOWED:
        raise ValueError('Unsafe or unsupported override path: ' + name)
    return path


def read_inside(root, relative):
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root) or not path.is_file():
        raise ValueError('Override input must be a regular contained file: ' + str(relative))
    return path.read_bytes()


def export(vendor, overrides, manifest):
    files = {}
    for path in sorted(overrides.rglob('*')):
        if path.is_dir():
            if path.is_symlink(): raise ValueError('Directory symlink is not an override')
            continue
        name = path.relative_to(overrides).as_posix()
        relative = relative_path(name)
        base = read_inside(vendor, relative)
        target = read_inside(overrides, relative)
        operations = make_patch(base, target)
        if apply_patch(base, operations, len(target)) != target:
            raise ValueError('Patch reconstruction differs: ' + name)
        literals = literal_size(operations)
        if literals > max(4096, len(target) // 10):
            raise ValueError('Refusing a near-whole vendor file; author a smaller adaptation: ' + name)
        files[name] = {'baseSha256': digest(base), 'targetSha256': digest(target), 'targetSize': len(target),
                       'mode': stat.S_IMODE(path.stat().st_mode), 'literalBytes': literals, 'operations': operations}
    result = {'format': FORMAT, 'modificationsLicense': 'MPL-2.0',
              'upstreamNotice': 'Original filenames and minimal patch context retain upstream rights. No vendor client license or redistribution permission is granted.',
              'files': files}
    with manifest.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, indent=2, ensure_ascii=False)
        stream.write('\n')
    print(json.dumps({'files': len(files), 'literalBytes': sum(f['literalBytes'] for f in files.values()), 'manifest': str(manifest)}))


def prepare(vendor, output, manifest):
    if manifest.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('Override manifest exceeds size limit')
    data = json.loads(manifest.read_text(encoding='utf-8'))
    if data.get('format') != FORMAT or not isinstance(data.get('files'), dict):
        raise ValueError('Invalid override manifest')
    if output.is_symlink(): raise ValueError('Refusing linked output directory')
    if output.exists():
        existing = {p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file() or p.is_symlink()}
        if existing != set(data['files']): raise ValueError('Existing override directory has a different file set')
        for name, entry in data['files'].items():
            if digest(read_inside(output, relative_path(name))) != entry['targetSha256']:
                raise ValueError('Existing override differs: ' + name)
        print('Verified existing private overrides:', output)
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.vendor-overrides-', dir=output.parent))
    try:
        for name, entry in data['files'].items():
            relative = relative_path(name)
            base = read_inside(vendor, relative)
            if digest(base) != entry['baseSha256']:
                raise ValueError('Unsupported vendor bytes: ' + name)
            target = apply_patch(base, entry['operations'], entry['targetSize'])
            if digest(target) != entry['targetSha256']:
                raise ValueError('Reconstructed override failed verification: ' + name)
            file = temporary / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(target)
            os.chmod(file, entry['mode'] & 0o777)
        if output.exists() or output.is_symlink(): raise ValueError('Output appeared during preparation')
        temporary.rename(output)
    finally:
        if temporary.exists(): shutil.rmtree(temporary)
    print('Prepared private vendor overrides:', output)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--vendor-app', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, default=Path(__file__).with_name('vendor-overrides.json'))
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--output', type=Path)
    group.add_argument('--from-overrides', type=Path)
    args = parser.parse_args()
    vendor = args.vendor_app.resolve(strict=True)
    if args.from_overrides:
        export(vendor, args.from_overrides.resolve(strict=True), args.manifest)
    else:
        prepare(vendor, args.output.absolute(), args.manifest)


if __name__ == '__main__':
    main()
