#!/usr/bin/env python3
"""Observe genuine native updater UI/processes; never manufacture app readiness.

Requires Python 3.12+ and websockets==15.0.1 (test dependency only).
The operator clicks the real native controls. No account actions are performed.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.parse
import urllib.request

import websockets
from websockets.exceptions import ConnectionClosed

IDENTITY = r'''(async () => {
  const deadline = Date.now() + 20000;
  while (!window.coreUpgrade || typeof window.coreUpgrade.checkUpgrade !== "function") {
    if (Date.now() >= deadline) throw new Error("The real upgrade consumer did not initialize");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const httpDownload = await window.coreRsHttp.downloadUpgradeFile({versionDownloadUrl:"https://example.invalid/WindowsPackage.exe"}).then(
    () => { throw new Error("The real shared HTTP SDK attempted a Windows update"); },
    error => { if (error.code !== "ENOTSUP") throw error; return error.code; });
  return {platform:process.platform,electron:process.versions.electron,consumer:typeof window.coreUpgrade.checkUpgrade,httpDownload,route:location.hash};
})()'''
CHECK = 'window.coreUpgrade.checkUpgrade({entry:"native-signed-update-gui-acceptance",isUserClick:true})'
ROUTES = ('/main/im', '/login/Auth2Login/Webview', '/login/LoginPage', '/login/WPFirstTimeAuthentication/empty')


def json_file(path):
    return json.loads(path.read_text())


def integration_hashes(home):
    names = ('.local/bin/hit-welink-native', '.local/share/applications/cn.edu.hit.welink.native.desktop',
             '.local/share/applications/hit-welink-native.desktop', '.config/mimeapps.list',
             '.local/share/applications/mimeapps.list')
    result = []
    for name in names:
        try:
            result.append(hashlib.sha256((home / name).read_bytes()).hexdigest())
        except FileNotFoundError:
            result.append(None)
    return result


def directory_names(directory):
    try:
        return {p.name for p in directory.iterdir()}
    except FileNotFoundError:
        return set()


def profile_pid(profile):
    try:
        value = (profile / 'runtime/SingletonLock').readlink().name
        pid = int(value.rsplit('-', 1)[1])
        return pid if pid > 0 else None
    except (OSError, ValueError):
        return None


class CDP:
    def __init__(self, socket):
        self.socket, self.next, self.pending = socket, 0, {}
        self.reader = asyncio.create_task(self.receive())

    async def receive(self):
        try:
            async for raw in self.socket:
                message = json.loads(raw)
                future = self.pending.pop(message.get('id'), None)
                if future is not None and not future.done():
                    if 'error' in message:
                        future.set_exception(RuntimeError(json.dumps(message['error'])))
                    else:
                        future.set_result(message['result'])
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError('DevTools connection closed'))
            self.pending.clear()

    async def evaluate(self, expression, timeout=30):
        self.next += 1
        request_id = self.next
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        await self.socket.send(json.dumps({'id': request_id, 'method': 'Runtime.evaluate',
            'params': {'expression': expression, 'awaitPromise': True, 'returnByValue': True}}))
        try:
            result = await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(request_id, None)
        if result.get('exceptionDetails'):
            raise RuntimeError(json.dumps(result['exceptionDetails']))
        return result['result'].get('value')

    async def close(self):
        await self.socket.close()
        try:
            await self.reader
        except ConnectionClosed:
            pass


async def observe(args, before, baseline, old_pid, invoked):
    deadline = asyncio.get_running_loop().time() + 35 * 60
    directory = None
    rollback_deadline = None
    while asyncio.get_running_loop().time() < deadline:
        if directory is None:
            for name in directory_names(args.updates_dir) - before:
                if not name.startswith('transaction-'):
                    continue
                candidate = args.updates_dir / name
                try:
                    request = json_file(candidate / 'request.json')
                    manifest = json_file(candidate / 'native-update.json')
                except (FileNotFoundError, json.JSONDecodeError):
                    continue
                if request['profile'] == str(args.profile) and manifest['version'] == args.target:
                    if directory is not None:
                        raise AssertionError('More than one matching transaction appeared')
                    directory = candidate
            if directory is None and args.action == 'cancel' and invoked.done():
                result = await invoked
                assert result and result.get('error', {}).get('code') == 'ECANCELED', result
                assert integration_hashes(args.home) == baseline
                assert old_pid and Path('/proc', str(old_pid)).exists()
                return {'phase': 'canceled-before-staging', 'oldPid': old_pid}
        if directory is not None:
            try:
                status = json_file(directory / 'status.json')
            except FileNotFoundError:
                status = None
            if status and status['phase'] in ('complete', 'failed', 'canceled'):
                request = json_file(directory / 'request.json')
                if args.action == 'cancel':
                    assert status['phase'] == 'canceled', status
                    assert integration_hashes(args.home) == baseline
                    assert Path('/proc', str(request['oldPid'])).exists()
                    assert not (directory / 'readiness.json').exists()
                    return {'phase': 'canceled', 'oldPid': request['oldPid']}
                if args.action == 'rollback':
                    assert status['phase'] == 'failed', status
                    journal = json_file(directory / 'journal.json')
                    assert journal['phase'] == 'rolled-back', journal['phase']
                    assert integration_hashes(args.home) == baseline
                    assert not Path('/proc', str(request['oldPid'])).exists()
                    pid = profile_pid(args.profile)
                    try:
                        executable = Path('/proc', str(pid), 'exe').readlink() if pid else None
                    except OSError:
                        executable = None
                    if executable == Path(request['baseImage']) / 'electron':
                        return {'phase': 'rolled-back', 'pid': pid, 'baseImage': request['baseImage']}
                    rollback_deadline = rollback_deadline or asyncio.get_running_loop().time() + 30
                    if asyncio.get_running_loop().time() >= rollback_deadline:
                        raise RuntimeError('Integration/profile restored, but the old executable did not reopen')
                else:
                    assert status['phase'] == 'complete', status
                    receipt = json_file(directory / 'readiness.json')
                    assert receipt['token'] == request['token'] and receipt['status'] == 'ready'
                    assert receipt['profile'] == str(args.profile)
                    assert receipt['build'] == 'hit-native-linux-ia32-' + args.target
                    assert receipt['route'] in ROUTES and receipt['mounted'] is True
                    executable = Path('/proc', str(receipt['pid']), 'exe').readlink()
                    expected = Path(request['baseImage']).parent.parent / ('hit-welink-native-' + args.target) / 'image/electron'
                    assert executable == expected
                    assert json_file(executable.parent / 'resources/app/native/build.json')['build'] == receipt['build']
                    assert not Path('/proc', str(request['oldPid'])).exists()
                    return {'phase': 'complete', 'pid': receipt['pid'], 'build': receipt['build'], 'route': receipt['route']}
        await asyncio.sleep(.2)
    raise TimeoutError('The genuine update transaction did not finish before the scenario deadline')


async def main(args):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f'http://127.0.0.1:{args.port}/json/list', timeout=10) as response:
        data = response.read(1024 * 1024 + 1)
    assert len(data) <= 1024 * 1024
    targets = [item for item in json.loads(data) if item.get('type') == 'page' and
               re.search(r'^file:.*?/pedestal/index\.html(?:[?#]|$)', item.get('url', ''))]
    assert len(targets) == 1, 'Expected one canonical isolated pedestal renderer'
    target = targets[0]
    endpoint = urllib.parse.urlsplit(target['webSocketDebuggerUrl'])
    assert endpoint.scheme == 'ws' and endpoint.hostname in ('127.0.0.1', 'localhost', '::1')
    async with websockets.connect(target['webSocketDebuggerUrl'], open_timeout=10, max_size=2*1024*1024, proxy=None) as socket:
        cdp = CDP(socket)
        try:
            identity = await cdp.evaluate(IDENTITY)
            assert identity['platform'] == 'linux' and identity['electron'].startswith('22.')
            assert identity['consumer'] == 'function' and identity['httpDownload'] == 'ENOTSUP'
            if args.action == 'check':
                print('Inspect the real native dialog, then choose Close.', flush=True)
                result = await cdp.evaluate(CHECK, 180)
                assert result['status'] == args.expect, result
                assert result['current'] == {'build': 'hit-native-linux-ia32-' + args.version, 'version': args.version}
                if args.expect == 'error':
                    assert result.get('error', {}).get('code')
                else:
                    assert result['action'] == 'dismissed'
                print(json.dumps({'status': 'passed', 'action': 'check', 'result': result,
                    'boundary': 'Actual Electron consumer, HTTPS check and native dialog; no account actions.'}, ensure_ascii=False))
                return
            before = directory_names(args.updates_dir)
            baseline = integration_hashes(args.home)
            old_pid = profile_pid(args.profile)
            print('Choose Download, update and restart in the REAL native dialog. ' +
                  ('Then cancel in the REAL progress window.' if args.action == 'cancel' else
                   'Observe the actual transaction; no readiness is fabricated.'), flush=True)
            async def invoke():
                try:
                    return await cdp.evaluate(CHECK, 35*60)
                except ConnectionError:
                    if args.action in ('install', 'rollback'):
                        return None
                    raise
            invoked = asyncio.create_task(invoke())
            try:
                outcome = await observe(args, before, baseline, old_pid, invoked)
                result = await invoked
                if result:
                    if args.action == 'cancel':
                        assert result.get('error', {}).get('code') == 'ECANCELED', result
                    else:
                        assert result['action'] == 'restart-required', result
                print(json.dumps({'status': 'passed', 'action': args.action, 'transaction': outcome,
                    'boundary': 'Actual controls, signed download, supervisor and process/filesystem outcome; no account actions.'}, ensure_ascii=False))
            finally:
                if not invoked.done():
                    invoked.cancel()
                    await asyncio.gather(invoked, return_exceptions=True)
        finally:
            await cdp.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--expect', choices=('available','current','no-releases','error'), required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--action', choices=('check','cancel','install','rollback'), default='check')
    parser.add_argument('--target')
    parser.add_argument('--profile', type=Path)
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--updates-dir', type=Path)
    arguments = parser.parse_args()
    arguments.home = arguments.home.resolve()
    arguments.updates_dir = arguments.updates_dir or arguments.home/'.local/state/welink-native-updates'
    if not 0 < arguments.port < 65536 or not re.fullmatch(r'r45\.[0-9]+', arguments.version):
        parser.error('Supply a loopback port and expected native version')
    if arguments.action != 'check' and (arguments.expect != 'available' or not re.fullmatch(r'r45\.[0-9]+', arguments.target or '') or
            arguments.profile is None or not arguments.profile.is_absolute() or arguments.profile.resolve() != arguments.profile):
        parser.error('Install/cancel/rollback requires available target and exact canonical profile')
    asyncio.run(main(arguments))
