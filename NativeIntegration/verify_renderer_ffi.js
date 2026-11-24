#!/usr/bin/env electron
'use strict';
// Real renderer, native FFI, Support randomness and encrypted IM SQLite. No SDK replacement.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert').strict;
const { app, BrowserWindow } = require('electron');
let root;
async function rendererProof(input) {
  const assert = window.require('assert').strict;
  const { threadId } = window.require('worker_threads');
  const native = window.require(input.native);
  const ffi = window.require(input.ffi);
  const browserTimer = window.setInterval(() => {}, 60000);
  assert.equal(typeof browserTimer, 'number', 'This must exercise renderer DOM timer globals');
  window.clearInterval(browserTimer);
  const lib = native.createLibrary('tup_sqlite_logic_api', {
    InitSqliteService: ['int', ['string', 'string', 'string', 'pointer']],
    SqliteServiceSendMsg: ['void', ['string']], SqliteServiceShutdown: ['void', []]
  }, {}, ffi);
  const support = native.createLibrary('wk_tup_support', {
    tup_support_init: ['void', ['pointer']], tup_support_send_msg: ['void', ['string']],
    tup_support_shutdown: ['void', []]
  }, {}, ffi);
  const pending = new Map(); let serial = 0, callbacks = 0, wrongThread = false;
  const callback = ffi.Callback('void', ['string'], text => {
    ++callbacks;
    if (window.require('worker_threads').threadId !== threadId) wrongThread = true;
    try {
      const reply = JSON.parse(text), waiter = pending.get(reply.sno);
      if (waiter) { pending.delete(reply.sno); window.clearTimeout(waiter.timer); waiter.resolve(reply); }
    } catch (error) { for (const waiter of pending.values()) waiter.reject(error); }
  });
  window.nativeFfiProofPins = [lib, support, callback];
  function send(cmd, param, dispatch = lib.SqliteServiceSendMsg) {
    const sno = ++serial;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Real SDK callback timeout for cmd ' + cmd)), 10000);
      pending.set(sno, { resolve, reject, timer });
      dispatch(JSON.stringify({ cmd, sno, param }));
    });
  }
  try {
    support.tup_support_init(callback);
    const random = await send(0x40004, { RandLen: 32 }, support.tup_support_send_msg);
    assert.equal(random.result, 0);
    assert.match(random.param.realrandom, /^[0-9a-f]{64}$/);
    assert.equal(lib.InitSqliteService(input.logs, input.app, input.kmc, callback), 0);
    const initialized = await send(1, { _useraccount: 'fixture-user', _dbpath: input.private });
    assert.equal(initialized.result, 0);
    const inserted = await send(25, { _keyvalue: { id: -1, strkey: 'renderer.真实回调', strvalue: 'owner-thread Unicode value' } });
    assert.ok(Number.isSafeInteger(inserted.result) && inserted.result > 0, 'add_userconfig must return the inserted record ID');
    const queried = await send(27, { _matchinfo: { keytype: 1, match_value: 'renderer.真实回调' } });
    assert.equal(queried.result, 1);
    assert.equal(queried.param._userconfiglist[0].id, inserted.result);
    assert.equal(queried.param._userconfiglist[0].strvalue, 'owner-thread Unicode value');
    assert.equal(wrongThread, false);
    return { passed: true, callbacks, ownerThread: true, encryptedCrud: true, supportRandom: true, domOnlyWaiters: true };
  } finally {
    for (const waiter of pending.values()) window.clearTimeout(waiter.timer);
    native.stopAll();
  }
}
(async () => {
  const seedIndex = process.argv.indexOf('--kmc-seed');
  if (seedIndex < 0 || !process.argv[seedIndex + 1]) throw new Error('--kmc-seed must identify the original synthetic seed directory');
  const seed = process.argv[seedIndex + 1];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-renderer-ffi-'));
  for (const name of ['app', 'kmc', 'private', 'logs', 'runtime']) fs.mkdirSync(path.join(root, name));
  for (const name of ['kmcStore.dat', 'kmcStore_bak.dat'])
    fs.copyFileSync(path.join(seed, name), path.join(root, 'kmc', name));
  app.setPath('userData', path.join(root, 'runtime'));
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  try {
    await window.loadURL('data:text/html,<body>Real renderer FFI verification</body>');
    const input = { native: path.join(__dirname, 'ffi.js'), ffi: path.resolve(__dirname, '../NativeBuild/ffi/output/ffi-napi') };
    for (const name of ['app', 'kmc', 'private', 'logs']) input[name] = path.join(root, name);
    const result = await window.webContents.executeJavaScript('(' + rendererProof.toString() + ')(' + JSON.stringify(input) + ')');
    assert.equal(result.passed, true);
    console.log(JSON.stringify({ ...result, root }));
  } finally { if (!window.isDestroyed()) window.destroy(); }
})().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
