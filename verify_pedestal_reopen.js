#!/usr/bin/env electron
'use strict';
// Actual native KMC/pedestal APIs in separate processes; synthetic data only.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const [libraryArg, ffiArg, mode = 'create', rootArg] = process.argv.slice(2);
if (!libraryArg || !ffiArg) throw new Error('Usage: verify_pedestal_reopen.js LIBRARY_DIR FFI_PATH');
assert.equal(process.arch, 'ia32');
const libraries = path.resolve(libraryArg), ffiPath = path.resolve(ffiArg);
const ffi = require(ffiPath), flags = ffi.DynamicLibrary.FLAGS;
const root = mode === 'create' ? fs.mkdtempSync(path.join(os.tmpdir(), 'welink-public-reopen-')) : path.resolve(rootArg);
const data = path.join(root, 'data'), kmc = path.join(root, 'kmc');
const plain = 'synthetic-public-' + 'a'.repeat(32), nonce = '0123456789abcdef0123456789abcdef';
const pins = [];
let sequence = 0;
function service(file, prefix) {
  const dl = new ffi.DynamicLibrary(path.join(libraries, file), flags.RTLD_NOW | (flags.RTLD_NODELETE || 0));
  const bind = (name, result, args) => ffi.ForeignFunction(dl.get(name), result, args);
  const init = bind(prefix + '_init', 'void', ['pointer']);
  const send = bind(prefix + '_send_msg', 'void', ['string']);
  const stop = bind(prefix + '_shutdown', 'void', []);
  let reply;
  const callback = ffi.Callback('void', ['string'], text => { reply = JSON.parse(text); });
  pins.push(dl, init, send, stop, callback);
  init(callback);
  return {
    call(cmd, param) {
      const sno = ++sequence;
      reply = null;
      send(JSON.stringify({ cmd, sno, param }));
      assert(reply && reply.sno === sno, 'Expected the actual synchronous native response');
      return reply;
    }, stop
  };
}
global.nativePublicReopenPins = pins;
let common, pedestal;
function configure(directory) {
  assert.equal(pedestal.call(79, { _dbpath: data, _kmcpath: directory }).result, 0);
}
function setKey(metadata, plaintext = plain) {
  return pedestal.call(77, { plainvalue: plaintext, vecvalue: nonce, secvalue: metadata });
}
function openAccount(account) {
  return pedestal.call(1, { _dbpath: '0', _useraccount: account });
}
function hashes() {
  const names = ['kmc/kmcStore.dat', 'kmc/kmcStore_bak.dat', 'data/kmcStore.dat', 'data/kmcStore_bak.dat',
    'data/UserData/config.db', 'data/UserData/fixture-user/config_private.db'];
  return Object.fromEntries(names.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
}
try {
  if (mode === 'create') {
    fs.mkdirSync(data, { mode: 0o700 });
    fs.mkdirSync(kmc, { mode: 0o700 });
  }
  common = service('common_utils.dll.so', 'common_utils');
  pedestal = service('sqlite_plugin.dll.so', 'tup_sqlite');
  if (mode === 'create') {
    const encrypted = common.call(106, { plainText: Buffer.from(plain).toString('base64'), kmcdir: kmc });
    assert.equal(encrypted.result, 0);
    const metadata = encrypted.param.CiperText + '|' + nonce;
    configure(kmc);
    assert.equal(setKey(metadata).result, 1);
    assert.equal(openAccount('public').result, 0);
    assert(pedestal.call(2, { _keyvalue: { id: 0, strkey: 'fixture.public', strvalue: 'persisted public value' } }).result > 0);
    assert.equal(openAccount('fixture-user').result, 0);
    assert(pedestal.call(25, { _keyvalue: { id: 0, strkey: 'fixture.private', strvalue: 'persisted private value' } }).result > 0);
    pedestal.stop(); common.stop();
    assert(!fs.readFileSync(path.join(kmc, 'kmcStore.dat')).equals(fs.readFileSync(path.join(data, 'kmcStore.dat'))), 'Fixture requires distinct actual KMC stores');
    const before = hashes();
    for (const childMode of ['reopen', 'wrong-store', 'missing-store']) {
      const child = spawnSync(process.execPath, [__filename, libraries, ffiPath, childMode, root], {
        encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
      if (child.error) throw child.error;
      assert.equal(child.status, 0, child.stderr || child.stdout);
      assert.deepEqual(hashes(), before, 'Existing key stores and metadata must remain byte-identical');
    }
    console.log(JSON.stringify({ passed: true, distinctPublicKmcPath: true, freshProcessReopen: true,
      publicAndPrivateDataPreserved: true, keyFilesPreserved: true, wrongStoreRejected: true, missingStoreRejected: true }));
  } else {
    const directory = mode === 'reopen' ? kmc : mode === 'wrong-store' ? data : path.join(root, 'missing-kmc');
    configure(directory);
    const metadataReply = pedestal.call(78, {});
    assert.equal(metadataReply.result, 0);
    const metadata = metadataReply.param.secvalue;
    const decrypted = common.call(107, { cipherText: metadata.split('|')[0], kmcdir: kmc });
    assert.equal(decrypted.result, 0); assert.equal(decrypted.param.PlainText, plain);
    const seeded = setKey(metadata, decrypted.param.PlainText);
    if (mode === 'reopen') {
      assert.equal(seeded.result, 1);
      assert.equal(openAccount('public').result, 0);
      const publicReply = pedestal.call(4, { _matchinfo: { keytype: 1, match_value: 'fixture.public' } });
      assert.equal(publicReply.result, 1);
      assert.equal(publicReply.param._sysconfiglist[0].strvalue, 'persisted public value');
      assert.equal(openAccount('fixture-user').result, 0);
      const privateReply = pedestal.call(27, { _matchinfo: { keytype: 1, match_value: 'fixture.private' } });
      assert.equal(privateReply.result, 1);
      assert.equal(privateReply.param._userconfiglist[0].strvalue, 'persisted private value');
    } else {
      assert.equal(seeded.result, 0);
      assert.notEqual(openAccount('public').result, 0);
      if (mode === 'missing-store') assert(!fs.existsSync(directory), 'Missing stores must not be regenerated');
    }
  }
} finally {
  if (pedestal) pedestal.stop();
  if (common) common.stop();
  if (mode === 'create') fs.rmSync(root, { recursive: true, force: true });
}
