'use strict';
// Parent-run only. Loads the genuine ia32 ELF through the real ffi-napi addon;
// never starts the application, uses Wine, or substitutes an SDK response.
// ELECTRON_RUN_AS_NODE=1 <electron-ia32> Support/verify_support.js \
//   <wk_tup_support.dll.so> <NativeBuild/ffi/output/ffi-napi>
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setTimeout: delay } = require('timers/promises');
const { performance } = require('perf_hooks');
const { threadId } = require('worker_threads');

const libraryPath = path.resolve(process.argv[2] || '');
const ffiPath = path.resolve(process.argv[3] || path.join(__dirname, '../NativeBuild/ffi/output/ffi-napi'));
const vectors = require('./analysis/standard-vectors.json');
assert(process.argv[2], 'Pass the built genuine support library');
assert.strictEqual(process.arch, 'ia32', 'Run under the actual ia32 Electron/Node runtime');
const elf = fs.readFileSync(libraryPath).subarray(0, 20);
assert(elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])));
assert.strictEqual(elf[4], 1, 'Library must be ELF32, not a PE/Wine wrapper');
const ffi = require(ffiPath);
const abi = {
  tup_support_set_log_path: ['void', ['string', 'int', 'int', 'int']],
  tup_support_init: ['void', ['pointer']],
  tup_support_send_msg: ['void', ['string']],
  tup_support_shutdown: ['void', []],
  tup_support_dispatch: ['int', []]
};
const dl = new ffi.DynamicLibrary(libraryPath, ffi.DynamicLibrary.FLAGS.RTLD_NOW);
const lib = {};
for (const [name, [result, args]] of Object.entries(abi))
  lib[name] = ffi.ForeignFunction(dl.get(name), result, args);
// Never dlclose a process-lived worker or release any callback while it is live.
const pinned = [dl, lib];
let insidePump = false;
let callbackFailure;
let generation = 0;
let nextSno = 1;
let hook;
const replies = new Map();
const seen = [];
const callback = ffi.Callback('void', ['string'], text => {
  try {
    assert(insidePump, 'FFI callback escaped the owner dispatch pump');
    assert.strictEqual(threadId, 0);
    const value = JSON.parse(text);
    assert(!replies.has(value.sno), `Duplicate response ${value.sno}`);
    seen.push({ value, generation });
    replies.set(value.sno, value);
    assert.strictEqual(lib.tup_support_dispatch(), 0, 'Recursive pump must not invoke callbacks');
    if (hook) hook(value);
  } catch (error) { callbackFailure = error; }
});
pinned.push(callback);
function init() { ++generation; lib.tup_support_init(callback); }
function send(cmd, param, description = 'verifier request description must not be echoed') {
  const sno = nextSno++;
  lib.tup_support_send_msg(JSON.stringify({ cmd, sno, description, param }));
  return sno;
}
function pump() {
  insidePump = true;
  let count;
  try { count = lib.tup_support_dispatch(); }
  finally { insidePump = false; }
  if (callbackFailure) throw callbackFailure;
  assert(count >= 0, `Dispatch failed: ${count}`);
  return count;
}
async function receive(sno) {
  const deadline = performance.now() + 30000;
  while (!replies.has(sno)) {
    pump();
    if (performance.now() > deadline) throw new Error(`No native reply for sno=${sno}`);
    await delay(2);
  }
  return replies.get(sno);
}
async function call(cmd, param, result = 0) {
  const sno = send(cmd, param);
  const value = await receive(sno);
  assert.strictEqual(value.rsp, cmd);
  if (result !== null) assert.strictEqual(value.result, result, JSON.stringify({ rsp: value.rsp, result: value.result }));
  if (value.result) assert(!Object.hasOwn(value, 'param'), 'Errors must not fabricate empty output');
  return value;
}
async function fail(cmd, param) {
  const value = await call(cmd, param, null);
  assert.notStrictEqual(value.result, 0);
  return value;
}

// Original, synthetic KMC 3 fixtures already checked against the vendor DLL.
// Read the literal data only: do not import/run verify_kmc.py or any SDK.
const fixtureSource = fs.readFileSync(path.join(__dirname, '../verify_kmc.py'), 'utf8');
function fixture(name, grouped) {
  const expression = grouped
    ? new RegExp(`^${name} = (?:base64\\.b64decode)?\\(([\\s\\S]*?)\\n\\)`, 'm')
    : new RegExp(`^${name} = ("[^"]*")`, 'm');
  const match = expression.exec(fixtureSource);
  assert(match, `Missing original synthetic fixture ${name}`);
  return [...match[1].matchAll(/"([^"]*)"/g)].map(item => item[1]).join('');
}
const store = Buffer.from(fixture('STORE', true), 'base64');
const originalCipher = fixture('CIPHER', true);
const atLimit = fixture('CIPHER_AT_DECRYPT_LIMIT', false);
const pastLimit = fixture('CIPHER_PAST_DECRYPT_LIMIT', false);
assert.strictEqual(store.length, 512);
const materialC = Buffer.from('b2a10c73527376a160622e0852082ea960bc2e73520b0cbcee0a2e08529c76a9', 'hex');
function cbcDecrypt(key, iv, input) {
  const cipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(input), cipher.final()]);
}
function cbcEncrypt(key, iv, input) {
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(input), cipher.final()]);
}
function masterKey(data) {
  const material = Buffer.alloc(32);
  for (let i = 0; i < 32; ++i) material[i] = data[0x38 + i] ^ data[0x58 + i] ^ materialC[i];
  const rmk = crypto.pbkdf2Sync(material, data.subarray(0x98, 0xb8), data.readUInt32BE(0x34), 64, 'sha256');
  const record = data.subarray(256);
  const master = cbcDecrypt(rmk.subarray(0, 32), record.subarray(0x48, 0x58), record.subarray(0x60, 0x90));
  assert.strictEqual(master.length, 32);
  const authenticated = Buffer.concat([record.subarray(0, 0x1c), record.subarray(0x5c, 0x60), master]);
  assert(crypto.createHmac('sha256', rmk.subarray(32)).update(authenticated).digest().equals(record.subarray(0xe0, 0x100)));
  material.fill(0); rmk.fill(0); authenticated.fill(0);
  return master;
}
function independentKmcDecrypt(data, encoded) {
  const ciphertext = Buffer.from(encoded, 'hex');
  assert.strictEqual(ciphertext.readUInt32BE(0), 2);
  assert.strictEqual(ciphertext.readUInt32BE(4), 0);
  assert.strictEqual(ciphertext.readUInt32BE(8), 0);
  assert.strictEqual(ciphertext.readUInt32BE(16), 7);
  assert.strictEqual(ciphertext.readUInt32BE(60), ciphertext.length - 64);
  const master = masterKey(data);
  assert(crypto.createHash('sha256').update(master).digest().subarray(0, 8).equals(ciphertext.subarray(20, 28)));
  const working = crypto.pbkdf2Sync(master, ciphertext.subarray(28, 36), 1, 32, 'sha256');
  const plain = cbcDecrypt(working, ciphertext.subarray(36, 52), ciphertext.subarray(64));
  master.fill(0); working.fill(0);
  return plain;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-support-verify-'));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function paths(name) {
  return {
    LogFile: path.join(work, name, 'logs', 'kmc.log'),
    KeyStoreFile: path.join(work, name, 'primary', 'custom-primary.keys'),
    KeyStoreFileBak: path.join(work, name, 'backup', 'custom-backup.keys')
  };
}
function install(p, data = store) {
  for (const file of [p.KeyStoreFile, p.KeyStoreFileBak]) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, data, { mode: 0o600 });
  }
}
function assertStoreUntouched(p, expected = store) {
  for (const file of [p.KeyStoreFile, p.KeyStoreFileBak]) assert.strictEqual(hash(fs.readFileSync(file)), hash(expected));
}
async function run() {
  const ignored = send(0x40004, { RandLen: 16 });
  init();
  lib.tup_support_set_log_path(work, 2, 1024, 2);
  const noPump = send(0x40004, { RandLen: 16 });
  await delay(40);
  assert.strictEqual(seen.length, 0, 'No callback is allowed before dispatch');
  const random = await receive(noPump);
  assert.strictEqual(random.result, 0);
  assert.match(random.param.realrandom, /^[0-9a-f]{32}$/);
  assert(!replies.has(ignored), 'Messages before init are not replayed');
  const otherThread = await new Promise((resolve, reject) => {
    lib.tup_support_dispatch.async((error, value) => error ? reject(error) : resolve(value));
  });
  assert.strictEqual(otherThread, -os.constants.errno.EPERM, 'Non-owner pump must not enter FFI callbacks');
  const random2 = await call(0x40004, { RandLen: 16 });
  assert.notStrictEqual(random2.param.realrandom, random.param.realrandom);
  for (const size of [1, 32, 257]) {
    const value = await call(0x40004, { RandLen: size });
    assert.match(value.param.realrandom, new RegExp(`^[0-9a-f]{${size * 2}}$`));
  }
  await call(0x40004, { RandLen: 0 }, 1);
  await fail(0x40004, { RandLen: -1 });
  await call(0x400ff, {}, -os.constants.errno.ENOSYS);

  const salt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const iv = Buffer.from('f0e0d0c0b0a090807060504030201000', 'hex');
  const legacy = Buffer.from('2a234379131d0b545e6f4b68472e57155216322c107c2872572825173817214b', 'hex');
  for (const [command, password, description] of [
    [0x40001, legacy, 'tup_support_crypt_Pkcs5Derivekey'],
    [0x40009, iv, 'tup_commonlib_crypt_pkcs5_derive_key_ex']
  ]) {
    for (const size of [1, 32, 64]) {
      const value = await call(command, { salt: salt.toString('hex'), saltLen: 999, iv: iv.toString('hex'), dklen: size });
      assert.strictEqual(value.description, description);
      assert.deepStrictEqual(value.param, {
        derivedkey: size === 32 ? vectors.pbkdf2_sha256[command === 0x40001 ? 0 : 1].derived
          : crypto.pbkdf2Sync(password, salt, 2048, size, 'sha256').toString('hex'),
        keyLen: 32, IVLen: 16
      });
    }
  }
  await fail(0x40001, { salt: 'gg', dklen: 32 });
  await fail(0x40009, { salt: salt.toString('hex'), dklen: 32 });
  await fail(0x40001, { salt: salt.toString('hex'), dklen: 0 });
  await call(0x40001, { salt: salt.toString('hex'), dklen: 65536 }, 0x7301002c);

  const zeroVector = vectors.aes256_cbc_pkcs7;
  const zeroEncrypted = await call(0x40002, {
    Key: zeroVector.key, IV: zeroVector.iv, PlainText: zeroVector.plaintext
  });
  assert.deepStrictEqual(zeroEncrypted.param, {
    CipherText: zeroVector.ciphertext, CipherLen: zeroVector.ciphertext.length
  });
  const key = Buffer.from('603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4', 'hex');
  for (const plain of ['', 'deterministic support vector', 'quote" and backslash\\', 'line\nreturn\rtab\t', '中文😀', 'a'.repeat(495)]) {
    const wire = JSON.stringify(plain).slice(1, -1);
    const encrypted = await call(0x40002, { Key: key.toString('hex'), IV: iv.toString('hex'), PlainText: wire });
    const expected = cbcEncrypt(key, iv, Buffer.from(wire)).toString('hex');
    assert.deepStrictEqual(encrypted.param, { CipherText: expected, CipherLen: expected.length });
    const decrypted = await call(0x40003, { Key: key.toString('hex'), IV: iv.toString('hex'), cipher: expected });
    assert.deepStrictEqual(decrypted.param, { PlainText: plain, PlainLen: Buffer.byteLength(wire) });
  }
  const atEncryptLimit = await call(0x40002, { Key: key.toString('hex'), IV: iv.toString('hex'), PlainText: 'a'.repeat(511) });
  assert.strictEqual(atEncryptLimit.param.CipherText.length, 1024);
  // The original decrypt wrapper has a 1024-byte C-string input buffer.
  await call(0x40003, { Key: key.toString('hex'), IV: iv.toString('hex'), cipher: atEncryptLimit.param.CipherText }, 1);
  await call(0x40002, { Key: key.toString('hex'), IV: iv.toString('hex'), PlainText: 'a'.repeat(512) }, 1);
  await call(0x40002, { Key: '00', IV: iv.toString('hex'), PlainText: 'x' }, 0x7301002c);
  await call(0x40002, { Key: key.toString('hex'), IV: '00', PlainText: 'x' }, 0x7301002b);
  await fail(0x40003, { Key: key.toString('hex'), IV: iv.toString('hex'), cipher: '00'.repeat(16) });
  // Malformed decrypted JSON must be an error, never an envelope injection.
  const injection = '"},"result":0,"sno":999,"param":{"PlainText":"';
  await fail(0x40003, { Key: key.toString('hex'), IV: iv.toString('hex'), cipher: cbcEncrypt(key, iv, Buffer.from(injection)).toString('hex') });

  await call(0x40007, { PlainText: Buffer.from('before start').toString('base64') }, 0x10e);
  const original = paths('original');
  install(original);
  const started = await call(0x40005, original);
  assert.strictEqual(started.description, 'kmc_service_start');
  assert(!Object.hasOwn(started, 'param'));
  assertStoreUntouched(original);
  const decrypted = await call(0x40008, { CiperText: originalCipher });
  assert.deepStrictEqual(decrypted.param, { PlainText: 'KMC native compatibility' });
  for (const input of [Buffer.from('support synthetic KMC'), Buffer.from('escaped\\nline'), Buffer.from([65, 0, 66]), Buffer.alloc(189, 65)]) {
    const encrypted = await call(0x40007, { PlainText: input.toString('base64') });
    assert.strictEqual(encrypted.param.CiperLen, encrypted.param.CiperText.length);
    assert(independentKmcDecrypt(store, encrypted.param.CiperText).equals(input));
    const roundTrip = await call(0x40008, { CiperText: encrypted.param.CiperText });
    const terminated = input.subarray(0, input.includes(0) ? input.indexOf(0) : input.length).toString();
    assert.strictEqual(roundTrip.param.PlainText, JSON.parse(`"${terminated}"`));
  }
  await call(0x40007, { PlainText: Buffer.alloc(190, 65).toString('base64') }, 1);
  const urlBytes = Buffer.from([0xfb, 0xff, 0xef, 0xfa, 0xff]);
  const urlText = urlBytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const urlEncrypted = await call(0x40007, { PlainText: urlText.slice(0, 2) + '\r\n' + urlText.slice(2) });
  assert(independentKmcDecrypt(store, urlEncrypted.param.CiperText).equals(urlBytes));
  const limitReply = await call(0x40008, { CiperText: atLimit });
  assert.strictEqual(limitReply.param.PlainText, independentKmcDecrypt(store, atLimit).toString());
  await fail(0x40008, { CiperText: pastLimit });
  const unsupported = '00000001' + originalCipher.slice(8);
  await call(0x40008, { CiperText: unsupported }, -os.constants.errno.ENOTSUP);
  await fail(0x40008, { CiperText: 'not hex' });
  assertStoreUntouched(original);

  // A valid backup recovers a corrupt primary without rewriting either file.
  const corrupt = Buffer.from(store);
  corrupt[0x38] ^= 1;
  fs.writeFileSync(original.KeyStoreFile, corrupt);
  await call(0x40006, null);
  await call(0x40005, original);
  await call(0x40008, { CiperText: originalCipher });
  assert.strictEqual(hash(fs.readFileSync(original.KeyStoreFile)), hash(corrupt));
  assert.strictEqual(hash(fs.readFileSync(original.KeyStoreFileBak)), hash(store));
  fs.writeFileSync(original.KeyStoreFileBak, corrupt);
  await fail(0x40005, original);
  await call(0x40007, { PlainText: Buffer.from('after failed start').toString('base64') }, 0x10e);
  assertStoreUntouched(original, corrupt);

  const fresh = paths('fresh');
  await call(0x40005, fresh);
  const freshData = fs.readFileSync(fresh.KeyStoreFile);
  assert.strictEqual(freshData.length, 512);
  assertStoreUntouched(fresh, freshData);
  assert.notStrictEqual(fs.statSync(fresh.KeyStoreFile).ino, fs.statSync(fresh.KeyStoreFileBak).ino);
  for (const file of [fresh.KeyStoreFile, fresh.KeyStoreFileBak]) assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  masterKey(freshData).fill(0); // authenticates original-format store, not just its magic
  const native = await call(0x40007, { PlainText: Buffer.from('fresh synthetic').toString('base64') });
  assert.strictEqual(independentKmcDecrypt(freshData, native.param.CiperText).toString(), 'fresh synthetic');
  await fail(0x40008, { CiperText: originalCipher }); // wrong store must not become empty success
  await call(0x40006, null);
  await call(0x40008, { CiperText: native.param.CiperText }, 0x10e);
  await call(0x40005, fresh);
  assert.strictEqual((await call(0x40008, { CiperText: native.param.CiperText })).param.PlainText, 'fresh synthetic');
  assertStoreUntouched(fresh, freshData);

  // Epoch cancellation: no stale callbacks into a new JS callback generation.
  const stale = [];
  for (let i = 0; i < 32; ++i) stale.push(send(0x40009, { salt: salt.toString('hex'), iv: iv.toString('hex'), dklen: 256 }));
  const stoppedAt = performance.now();
  lib.tup_support_shutdown();
  assert(performance.now() - stoppedAt < 250, 'Shutdown joined the native worker');
  init();
  await call(0x40008, { CiperText: native.param.CiperText }, 0x10e);
  for (const sno of stale) assert(!replies.has(sno));
  const generationBefore = generation;
  let reinitializedSno;
  hook = () => {
    hook = undefined;
    lib.tup_support_shutdown();
    init();
    reinitializedSno = send(0x40004, { RandLen: 16 });
  };
  await call(0x40004, { RandLen: 16 });
  assert.strictEqual(generation, generationBefore + 1);
  await receive(reinitializedSno);
  await call(0x40006, null);
  lib.tup_support_shutdown();
  assert.strictEqual(lib.tup_support_dispatch(), 0);
  assertStoreUntouched(fresh, freshData);

  for (const file of [path.join(work, 'wk_tup_support.log'), fresh.LogFile, original.LogFile]) {
    const log = fs.readFileSync(file, 'utf8');
    assert(!log.includes('synthetic') && !log.includes(key.toString('hex')) && !log.includes(originalCipher));
    assert(log.split('\n').filter(Boolean).every(line => /^support cmd=\d+ result=-?\d+$/.test(line)));
  }
  console.log(JSON.stringify({ support_ffi: true, owner_thread: true, commands: 9,
    pbkdf2_sha256_2048: true, aes256_cbc_pkcs7: true, original_kmc_fixture: true,
    explicit_store_paths: true, backup_recovery: true, epoch_cancellation: true,
    checks: seen.length }));
}
run().then(() => { fs.rmSync(work, { recursive: true, force: true }); }, error => {
  lib.tup_support_shutdown();
  console.error(error.stack);
  console.error(`Synthetic verification artifacts retained at ${work}`);
  process.exitCode = 1;
});
