#!/usr/bin/env electron
'use strict';
// Real ia32 SDK plus an independent ZIP reader; all files are synthetic.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: verify_native_zip.js LIBRARY FFI_PATH');
assert.equal(process.arch, 'ia32');
const ffi = require(path.resolve(process.argv[3]));
const flags = ffi.DynamicLibrary.FLAGS;
const dl = new ffi.DynamicLibrary(path.resolve(process.argv[2]), flags.RTLD_NOW | (flags.RTLD_NODELETE || 0));
const bind = (name, result, args) => ffi.ForeignFunction(dl.get(name), result, args);
const init = bind('NativeToolsInitService', 'int', ['string', 'pointer']);
const send = bind('NativeToolsSendMsg', 'void', ['string']);
const dispatch = bind('NativeToolsDispatchCallbacks', 'int', []);
const shutdown = bind('NativeToolsShutdown', 'void', []);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-native-zip-'));
const pending = new Map();
let serial = 0, pump;
const callback = ffi.Callback('void', ['string'], text => {
  try {
    const reply = JSON.parse(text), waiter = pending.get(reply.sno);
    if (waiter) {
      pending.delete(reply.sno);
      clearTimeout(waiter.timer);
      waiter.resolve(reply);
    }
  } catch (error) {
    for (const waiter of pending.values()) waiter.reject(error);
  }
});
global.nativeZipProofPins = [dl, callback, init, send, dispatch, shutdown];
function request(cmd, param) {
  const sno = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native ZIP callback timed out')), 15000);
    pending.set(sno, { resolve, reject, timer });
    send(JSON.stringify({ cmd, sno, param }));
  });
}
(async () => {
  try {
    assert.equal(init(root, callback), 0);
    pump = setInterval(() => {
      const status = dispatch();
      if (status < 0) for (const waiter of pending.values()) waiter.reject(new Error('Native dispatch failed: ' + status));
    }, 5);
    const input = path.join(root, 'input');
    fs.mkdirSync(input, { mode: 0o700 });
    fs.mkdirSync(path.join(input, '子目录'), { mode: 0o700 });
    const contents = {
      '文档甲.txt': '中文内容\nembedded\u0000byte\n',
      '子目录/文档乙.txt': '{"value":17,"text":"第二个文件"}\n',
      'plain.txt': 'plain ASCII content\n'
    };
    for (const [name, content] of Object.entries(contents))
      fs.writeFileSync(path.join(input, name), content, { mode: 0o600 });
    const archive = path.join(root, '中文归档.zip');
    assert.equal((await request(17, { dir_path: input, zip_file_name: archive })).result, 0);
    const check = spawnSync('python3', ['-c', `
import json,sys,zipfile
expected=json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert set(archive.namelist()) == set(expected) | {'子目录/'}
    for entry in archive.infolist():
        if not entry.filename.isascii():
            assert entry.flag_bits & 0x800, (entry.filename, entry.flag_bits)
    for name,content in expected.items():
        assert archive.read(name) == content.encode('utf-8'), name
    assert archive.testzip() is None
print('PASS independent ZIP reader: Unicode names, nested directory, content and CRC')
`, archive, JSON.stringify(contents)], { encoding: 'utf8', timeout: 15000 });
    if (check.error) throw check.error;
    assert.equal(check.status, 0, check.stderr || check.stdout);
    console.log(check.stdout.trim());
    console.log(JSON.stringify({ passed: true, unicodeFileNames: true, unicodeDirectory: true, utf8Metadata: true, independentReader: true }));
  } finally {
    if (pump) clearInterval(pump);
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
