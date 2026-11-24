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
# native-update: __IDENTITY__
import argparse,base64,fcntl,hashlib,json,os,shutil,signal,stat,subprocess,tempfile,zlib
from pathlib import Path
DATA = __DATA__
metadata=json.loads(zlib.decompress(base64.b85decode(DATA)))
sha=lambda data:hashlib.sha256(data).hexdigest()

__APPLY_PATCH__

# Authorization is ONLY a hardlink of an already root-owned immutable SUID
# sandbox. Both source and destination are held open by the unprivileged
# installer. No user-selected pathname is opened for a privileged write.
SANDBOX_HELPER = r"""
import hashlib,os,stat,sys
pid,source,destination=map(int,sys.argv[1:4])
uid=int(os.environ.get('PKEXEC_UID',os.environ.get('SUDO_UID','-1')))
if os.geteuid()!=0 or uid<=0 or os.stat('/proc/'+str(pid)).st_uid!=uid:
    raise RuntimeError('Invalid sandbox authorization owner')
s=os.open('/proc/%d/fd/%d'%(pid,source),os.O_RDONLY)
d=os.open('/proc/%d/fd/%d'%(pid,destination),os.O_RDONLY|os.O_DIRECTORY)
info=os.fstat(s); target=os.fstat(d)
if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o4755:
    raise RuntimeError('Source is not an existing protected sandbox')
if target.st_uid!=uid or stat.S_IMODE(target.st_mode)&0o077:
    raise RuntimeError('Destination is not a private user staging directory')
h=hashlib.sha256()
while True:
    b=os.read(s,1024*1024)
    if not b: break
    h.update(b)
if h.hexdigest()!=sys.argv[4]: raise RuntimeError('Sandbox bytes changed')
os.link('/proc/self/fd/'+str(s),'chrome-sandbox',dst_dir_fd=d,follow_symlinks=True)
os.fsync(d)
"""

def emit(args,phase,completed,total,**extra):
    if args.progress_json:
        print(json.dumps(dict(phase=phase,completed=completed,total=total,**extra)),flush=True)

def sandbox_link(source,destination,expected,args):
    s=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
    d=os.open(destination,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        info=os.fstat(s)
        with os.fdopen(os.dup(s),'rb') as stream: digest=sha(stream.read())
        if info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o4755 or digest!=expected:
            raise RuntimeError('Baseline sandbox is not trusted')
        try:
            os.link('/proc/self/fd/'+str(s),'chrome-sandbox',dst_dir_fd=d,follow_symlinks=True)
            return
        except PermissionError:
            pass
        command=['/usr/bin/python3','-I','-c',SANDBOX_HELPER,str(os.getpid()),str(s),str(d),expected]
        # sudo -n cannot prompt or block; pkexec invokes the desktop's normal
        # authorization agent. Never run this installer, cp or chmod as root.
        if shutil.which('sudo'):
            result=subprocess.run(['sudo','-n','--',*command],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if result.returncode==0: return
        if not shutil.which('pkexec'):
            raise RuntimeError('A graphical polkit authorization agent and pkexec are required to reuse the protected sandbox')
        emit(args,'authorization',0,1)
        subprocess.run(['pkexec',*command],check=True)
    finally:
        os.close(s); os.close(d)

def verify(root,args):
    actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() or p.is_symlink()}
    if actual != set(metadata['inventory']): raise RuntimeError('Image file set differs from sealed inventory')
    total=len(metadata['inventory'])
    for index,(name,item) in enumerate(metadata['inventory'].items(),1):
        p=root/name
        if 'link' in item:
            if not p.is_symlink() or p.readlink().as_posix()!=item['link']: raise RuntimeError('Wrong symlink: '+name)
        else:
            if p.is_symlink() or not p.is_file() or sha(p.read_bytes())!=item['sha256']: raise RuntimeError('Wrong image bytes: '+name)
            mode=stat.S_IMODE(p.stat().st_mode)
            if name=='chrome-sandbox':
                if p.stat().st_uid!=0 or mode!=0o4755: raise RuntimeError('Sandbox must be root-owned 4755')
            elif mode!=item['mode']: raise RuntimeError('Wrong file mode: '+name)
        emit(args,'verifying',index,total)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--activate',action='store_true',help='Activate verified image without starting WeLink; exit the old app first')
    parser.add_argument('--base-image',type=Path,help='Explicit exact installed baseline')
    parser.add_argument('--install-root',type=Path,help='Private side-by-side release root')
    parser.add_argument('--profile',type=Path,help='Explicit existing native profile')
    parser.add_argument('--preserve-defaults',action='store_true',help='Do not change any desktop/MIME defaults')
    parser.add_argument('--desktop-id',choices=['hit-welink-native.desktop','cn.edu.hit.welink.native.desktop'])
    parser.add_argument('--progress-json',action='store_true',help='Emit real per-file JSON progress')
    args=parser.parse_args()
    os.umask(0o077)
    def interrupted(_signal,_frame): raise InterruptedError('Installation canceled')
    signal.signal(signal.SIGTERM,interrupted)
    home=Path.home().resolve(); root=(args.install_root or home/'.local/opt').absolute()
    old=(args.base_image or root/metadata['base']/'image').absolute(); dest=root/metadata['release']
    if not root.is_dir() or root.resolve()!=root or root.stat().st_uid!=os.getuid():
        raise RuntimeError('Installation root must be a user-owned real directory')
    if old.resolve()!=old or not old.is_dir(): raise RuntimeError('Required baseline is unavailable: '+str(old))
    if json.loads((old/'resources/app/native/build.json').read_text())['build']!=metadata['baseBuild']:
        raise RuntimeError('Baseline build differs from generated installer')
    if sha((old/'resources/app/native/lib/sqlite_plugin.dll.so').read_bytes())!=metadata['baseCheckerSha256']:
        raise RuntimeError('Baseline checker differs from generated installer')
    lock=os.open(root/'.native-image-install.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    if dest.is_symlink(): raise RuntimeError('Refusing linked destination')
    if not dest.exists():
        stage=Path(tempfile.mkdtemp(prefix='.'+metadata['release']+'-',dir=root)); image=stage/'image'; image.mkdir(mode=0o700)
        try:
            total=len(metadata['inventory'])
            for index,(name,item) in enumerate(metadata['inventory'].items(),1):
                target=image/name
                target.parent.mkdir(parents=True,exist_ok=True)
                if target.parent.resolve()!=target.parent: raise RuntimeError('Output traverses a symlink: '+name)
                if name=='chrome-sandbox':
                    sandbox_link(old/name,image,item['sha256'],args)
                elif 'link' in item:
                    target.symlink_to(item['link'])
                else:
                    source=old/name
                    if source.resolve()!=source or source.is_symlink(): raise RuntimeError('Baseline traverses a symlink: '+name)
                    patch=metadata['patches'].get(name)
                    if patch:
                        before=source.read_bytes() if source.is_file() else b''
                        if (sha(before) if source.exists() else None)!=patch['base']: raise RuntimeError('Baseline file changed: '+name)
                        data=apply_patch(before,patch['operations'],patch['size'])
                        if sha(data)!=item['sha256']: raise RuntimeError('Invalid reconstructed file: '+name)
                        target.write_bytes(data)
                    else:
                        shutil.copyfile(source,target)
                    os.chmod(target,item['mode'],follow_symlinks=False)
                emit(args,'staging',index,total)
            verify(image,args)
            subprocess.run(['mv','-T','--no-clobber','--',str(stage),str(dest)],check=True)
            if stage.exists(): raise RuntimeError('Destination appeared concurrently')
        finally:
            if stage.is_dir(): shutil.rmtree(stage)
    verify(dest/'image',args)
    emit(args,'staged',len(metadata['inventory']),len(metadata['inventory']),image=str(dest/'image'),build=metadata['build'])
    if not args.progress_json: print('VERIFIED_IMAGE',metadata['release'],len(metadata['inventory']))
    if args.activate:
        if not args.profile: raise RuntimeError('--activate requires an explicit --profile')
        integration=Path(__file__).with_name('install_desktop.py')
        if not integration.is_file() or sha(integration.read_bytes())!=metadata['desktopInstallerSha256']:
            raise RuntimeError('Desktop installer missing or changed')
        command=[os.sys.executable,str(integration),'--image',str(dest/'image'),'--profile',str(args.profile)]
        if args.preserve_defaults: command.append('--preserve-defaults')
        if args.desktop_id: command.extend(['--desktop-id',args.desktop_id])
        subprocess.run(command,check=True)
        if not args.progress_json: print('DESKTOP_ACTIVATED',metadata['release'])

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
                'baseBuild': baseline, 'build': build,
                'baseCheckerSha256': old['resources/app/native/lib/sqlite_plugin.dll.so']['sha256'],
                'desktopInstallerSha256': hashlib.sha256(args.desktop_installer.read_bytes()).hexdigest()}
    encoded = base64.b85encode(zlib.compress(json.dumps(metadata, separators=(',', ':')).encode(), 9)).decode()
    with args.output.open('x') as output:
        identity = {key: metadata[key] for key in ('baseBuild', 'build', 'baseCheckerSha256', 'desktopInstallerSha256')}
        output.write(INSTALLER.replace('__APPLY_PATCH__', inspect.getsource(apply_patch))
                     .replace('__IDENTITY__', json.dumps(identity, separators=(',', ':'))).replace('__DATA__', repr(encoded)))
    args.output.chmod(0o755)
    print(json.dumps({'installer': str(args.output), 'patches': len(patches), 'imageEntries': len(new),
                      'bytes': args.output.stat().st_size, 'release': metadata['release']}))


if __name__ == '__main__':
    main()
