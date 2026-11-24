#!/usr/bin/env python3
"""Package a sealed native image as a validated side-by-side update."""
import argparse
import base64
import hashlib
import json
import inspect
from pathlib import Path
import stat
import zlib
from delta import apply_patch, literal_size, make_patch


def inventory(root):
    result = {}
    for file in sorted(root.rglob('*')):
        name = file.relative_to(root).as_posix()
        if file.is_symlink():
            result[name] = {'link': file.readlink().as_posix()}
        elif file.is_file():
            result[name] = {'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
                            'mode': stat.S_IMODE(file.stat().st_mode)}
    return result


INSTALLER = r'''#!/usr/bin/env python3
# Generated from verified image bytes. Never edits the running release/profile.
# Source: https://github.com/jiwangyihao/welink-native-linux
# This Source Code Form is subject to MPL-2.0: https://mozilla.org/MPL/2.0/
# Patch context retains its upstream rights; the commercial base is not bundled.
import argparse,base64,hashlib,json,os,shutil,stat,subprocess,tempfile,zlib
from pathlib import Path
DATA = __DATA__
metadata=json.loads(zlib.decompress(base64.b85decode(DATA)))
sha=lambda data:hashlib.sha256(data).hexdigest()

__APPLY_PATCH__

def verify(root):
    actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() or p.is_symlink()}
    if actual != set(metadata['inventory']): raise RuntimeError('Image file set differs from sealed inventory')
    for name,item in metadata['inventory'].items():
        p=root/name
        if 'link' in item:
            if not p.is_symlink() or p.readlink().as_posix()!=item['link']: raise RuntimeError('Wrong symlink: '+name)
        else:
            if p.is_symlink() or not p.is_file() or sha(p.read_bytes())!=item['sha256']: raise RuntimeError('Wrong image bytes: '+name)
            mode=stat.S_IMODE(p.stat().st_mode)
            if name=='chrome-sandbox':
                if p.stat().st_uid!=0 or mode!=0o4755: raise RuntimeError('Sandbox must be root-owned 4755')
            elif mode!=item['mode']: raise RuntimeError('Wrong file mode: '+name)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--activate',action='store_true',help='Install desktop/protocol integration after verifying the image; does not start WeLink')
    args=parser.parse_args()
    os.umask(0o077)
    home=Path.home().resolve(); root=home/'.local/opt'; old=root/metadata['base']/'image'; dest=root/metadata['release']
    if not root.is_dir() or root.resolve()!=root or root.stat().st_uid!=os.getuid(): raise RuntimeError('Installation root must be a user-owned real directory')
    if dest.is_symlink(): raise RuntimeError('Refusing linked destination')
    if not dest.exists():
        if old.resolve()!=old or not old.is_dir(): raise RuntimeError('Required baseline is unavailable: '+str(old))
        sandbox=old/'chrome-sandbox'; info=sandbox.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o4755 or sha(sandbox.read_bytes())!=metadata['inventory']['chrome-sandbox']['sha256']:
            raise RuntimeError('Baseline sandbox is not trusted')
        patch={}
        for name,item in metadata['patches'].items():
            p=old/name
            if p.is_symlink() or p.resolve()!=p: raise RuntimeError('Patch input traverses a symlink: '+name)
            before=p.read_bytes() if p.is_file() else b''
            if (sha(before) if p.exists() else None)!=item['base']: raise RuntimeError('Baseline file changed: '+name)
            data=apply_patch(before,item['operations'],item['size'])
            if sha(data)!=metadata['inventory'][name]['sha256']: raise RuntimeError('Invalid reconstructed file: '+name)
            patch[name]=data
        stage=Path(tempfile.mkdtemp(prefix='.'+metadata['release']+'-',dir=root)); image=stage/'image'; image.mkdir()
        try:
            subprocess.run(['cp','-a','--reflink=auto','--no-preserve=ownership','--',*[str(p) for p in old.iterdir() if p!=sandbox],str(image)],check=True)
            try: os.link(sandbox,image/'chrome-sandbox')
            except PermissionError:
                subprocess.run(['sudo','-n','/usr/bin/ln','-P','-T','--',str(sandbox),str(image/'chrome-sandbox')],check=True)
            for name in metadata['removed']:
                p=image/name
                if p.parent.resolve()!=p.parent: raise RuntimeError('Removal traverses a symlink: '+name)
                p.unlink()
            for name,data in patch.items():
                p=image/name
                if p.resolve()!=p: raise RuntimeError('Patch output traverses a symlink: '+name)
                p.parent.mkdir(parents=True,exist_ok=True)
                temporary=p.with_name('.native-update-'+p.name)
                with temporary.open('xb') as f:
                    f.write(data); os.fchmod(f.fileno(),metadata['inventory'][name]['mode']); f.flush(); os.fsync(f.fileno())
                os.replace(temporary,p)
            for name,item in metadata['inventory'].items():
                if 'link' in item:
                    p=image/name
                    if p.parent.resolve()!=p.parent: raise RuntimeError('Link parent traverses a symlink: '+name)
                    if p.is_symlink() and p.readlink().as_posix()==item['link']: continue
                    if p.exists() or p.is_symlink(): p.unlink()
                    p.parent.mkdir(parents=True,exist_ok=True); p.symlink_to(item['link'])
                elif name!='chrome-sandbox':
                    # Earlier client-side copies used umask 077. Normalize only
                    # this new private image, never the baseline or SUID hardlink.
                    p=image/name
                    if p.resolve()!=p or not p.is_file(): raise RuntimeError('Invalid mode-normalization target: '+name)
                    os.chmod(p,item['mode'],follow_symlinks=False)
            verify(image)
            # GNU mv -T -n refuses a destination created concurrently.
            subprocess.run(['mv','-T','--no-clobber','--',str(stage),str(dest)],check=True)
            if stage.exists(): raise RuntimeError('Destination appeared concurrently')
        finally:
            if stage.is_dir(): shutil.rmtree(stage)
    verify(dest/'image')
    print('VERIFIED_IMAGE',metadata['release'],len(metadata['inventory']))
    if args.activate:
        integration=Path(__file__).with_name('install_desktop.py')
        if not integration.is_file() or sha(integration.read_bytes())!=metadata['desktopInstallerSha256']:
            raise RuntimeError('Desktop installer missing or changed')
        subprocess.run([os.sys.executable,str(integration),'--image',str(dest/'image')],check=True)
        print('DESKTOP_ACTIVATED',metadata['release'])

if __name__=='__main__': main()
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-image', type=Path, required=True)
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--desktop-installer', type=Path, required=True)
    args = parser.parse_args()
    old, new = inventory(args.base_image), inventory(args.image)
    baseline = json.loads((args.base_image/'resources/app/native/build.json').read_text())['build']
    build = json.loads((args.image/'resources/app/native/build.json').read_text())['build']
    def release_name(value):
        prefix = 'hit-native-linux-ia32-'
        if not value.startswith(prefix): raise ValueError('Unexpected build identity')
        result = 'hit-welink-native-' + value[len(prefix):]
        if '/' in result or '\\' in result: raise ValueError('Invalid release name')
        return result
    patches = {}
    for name, item in new.items():
        if 'link' in item or old.get(name) == item: continue
        data = (args.image/name).read_bytes()
        previous = (args.base_image/name).read_bytes() if name in old else b''
        first_party = (name.startswith('resources/app/native/') and
                       not name.startswith(('resources/app/native/vendor/', 'resources/app/native/lib/runtime/',
                                            'resources/app/native/lib/pixbuf-loaders/')))
        first_party = first_party or name.startswith('resources/app/shared/')
        if name not in old and not first_party:
            raise ValueError('Public updates cannot introduce vendor files: ' + name)
        if not first_party and Path(name).suffix.lower() in ('.jsc', '.exe', '.dll', '.node'):
            raise ValueError('Supply changed commercial executables locally, never in a public update: ' + name)
        operations = make_patch(previous, data)
        if apply_patch(previous, operations, len(data)) != data:
            raise ValueError('Delta failed reconstruction: ' + name)
        if not first_party and literal_size(operations) > max(4096, len(data) // 10):
            raise ValueError('Public update contains too much upstream literal data: ' + name)
        patches[name] = {'base': old.get(name, {}).get('sha256'), 'size': len(data), 'operations': operations}
    metadata = {'base': release_name(baseline), 'release': release_name(build), 'inventory': new,
                'patches': patches, 'removed': sorted(set(old) - set(new)),
                'desktopInstallerSha256': hashlib.sha256(args.desktop_installer.read_bytes()).hexdigest()}
    encoded = base64.b85encode(zlib.compress(json.dumps(metadata, separators=(',', ':')).encode(), 9)).decode()
    with args.output.open('x') as output:
        output.write(INSTALLER.replace('__APPLY_PATCH__', inspect.getsource(apply_patch)).replace('__DATA__', repr(encoded)))
    args.output.chmod(0o755)
    print(json.dumps({'installer': str(args.output), 'patches': len(patches), 'imageEntries': len(new),
                      'bytes': args.output.stat().st_size, 'release': metadata['release']}))


if __name__ == '__main__':
    main()
