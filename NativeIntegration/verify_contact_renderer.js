#!/usr/bin/env electron
'use strict';
// Parent-run only: genuine ia32 renderer, deployed contact loader and native ABI.
// --kmc-seed must be the original SYNTHETIC seed directory, never a user profile.
// Optional --app /new/image/resources/app checks the assembled image and notices too.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert').strict;
const { app, BrowserWindow } = require('electron');

const ACTIVE = [
  'SqliteRecvMsgImport', 'ContactPluginSetLogPath', 'SqliteServiceStartup',
  'GabSqliteQueryAll', 'GabSqliteExec', 'GabSqliteQueryAllWithKey', 'GabSqliteExecWithKey'
];
const LOADERS = ['pedestal/contact/js/contact.js', 'plugin/contact/dist/contact/js/contact.js'];
const LIFECYCLE = ['ContactPluginDispatchCallbacks', 'ContactPluginShutdown'];

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), name + ' requires a path');
  return path.resolve(process.argv[index + 1]);
}

function checkImage(appRoot) {
  const nativeRoot = path.join(appRoot, 'native');
  const metadata = JSON.parse(fs.readFileSync(path.join(nativeRoot, 'build.json'), 'utf8'));
  const name = 'contact_sqlite_plugin.dll.so';
  const contact = metadata.nativeLibraries[name];
  assert.ok(contact, 'Assembly must inventory the actual contact component');
  assert.deepEqual(contact.requiredExports.slice().sort(), [...ACTIVE, ...LIFECYCLE].sort());
  for (const symbol of [...ACTIVE, ...LIFECYCLE]) assert.ok(contact.exports.includes(symbol), symbol);
  assert.ok(!contact.exports.includes('GabReadZipFile'), 'The vendor-disabled ZIP entry point is not a native API');
  const digest = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(nativeRoot, 'lib', name))).digest('hex');
  assert.equal(contact.sha256, digest);
  for (const dependency of contact.needed) {
    if (metadata.hostGlibcLibraries.includes(dependency)) continue;
    assert.ok(metadata.runtimeLibraries[dependency].neededBy.includes('resources/app/native/lib/' + name), dependency);
  }
  for (const notice of ['licenses/json-c/COPYING', 'licenses/sqlite3mc/LICENSE', 'licenses/sqlite3mc/NOTICES',
    'provenance/native-deps.packages.json']) assert.ok(fs.statSync(path.join(nativeRoot, notice)).isFile(), notice);
  const config = fs.readFileSync(path.join(appRoot, 'pedestal/config.json'), 'utf8');
  assert.ok(!config.includes('method://contact/syncGabZipFile'), 'Disabled ZIP registration must not ship on Linux');
}

async function rendererProof(input) {
  const assert = window.require('assert').strict;
  const fs = window.require('fs');
  const path = window.require('path');
  const threads = window.require('worker_threads');
  const owner = threads.threadId;
  assert.equal(threads.isMainThread, true);
  const ffi = window.require(input.ffi);
  const ref = window.require(input.ref);
  const native = window.require(input.native);
  const timer = window.setInterval(() => {}, 60000);
  assert.equal(typeof timer, 'number', 'Exercise DOM timer globals, not a Node-only test');
  window.clearInterval(timer);
  assert.equal(typeof window.gc, 'function', 'Electron must expose GC for callback lifetime verification');
  const delay = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const events = [];
  const offStart = native.onLifecycle('start', id => { if (id === 'contact_sqlite_plugin') events.push('start'); });
  const offStop = native.onLifecycle('stop', id => { if (id === 'contact_sqlite_plugin') events.push('stop'); });
  const pending = new Map();
  const replies = [];
  let serial = 0;
  let callbacks = 0;
  let wrongThread = false;
  let callbackError = null;
  window.__dirname = input.pedestal;
  window.notifyJsTupDBCallback = text => {
    ++callbacks;
    if (window.require('worker_threads').threadId !== owner) wrongThread = true;
    try {
      const reply = JSON.parse(text);
      replies.push(reply);
      const waiter = pending.get(reply.sno);
      if (waiter) {
        pending.delete(reply.sno);
        window.clearTimeout(waiter.timer);
        waiter.resolve(reply);
      }
    } catch (error) { callbackError = error; }
  };

  // Execute the exact shipped loadLibrary function without starting account/UI
  // services. Only the environment (FFI location/log directory) is fixture data;
  // no FFI method, native response, callback or lifecycle event is substituted.
  const source = fs.readFileSync(input.bundle, 'utf8');
  const marker = 'function loadContactLibrary() {';
  const begin = source.indexOf(marker);
  assert.ok(begin >= 0 && source.indexOf(marker, begin + 1) < 0, 'Expected one migrated native contact loader');
  const end = source.indexOf('\n}', begin);
  assert.ok(end > begin, 'Expected the complete readable loader function');
  const factory = new Function('window', 'process', 'path', 'contactPath', 'logger', 'Pedestal',
    '_commonFile_logic_publicFunc__WEBPACK_IMPORTED_MODULE_0__',
    '"use strict";let tupLib=null;return (' + source.slice(begin, end + 2) + ');');
  const load = factory(window, process, path, 'contact_sqlite_plugin.dll', console,
    { logRootPath: input.logs }, { bz: () => Promise.resolve({ ffiPath: input.ffi }) });
  let lib;
  function rpc(cmd, param) {
    const sno = ++serial;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(sno);
        reject(new Error('Contact callback timeout for cmd ' + cmd));
      }, 10000);
      pending.set(sno, { resolve, reject, timer });
      try { lib.SqliteRecvMsgImport(JSON.stringify({ cmd, sno, param })); }
      catch (error) { pending.delete(sno); window.clearTimeout(timer); reject(error); }
    });
  }
  async function initialize() {
    for (const userAccount of ['public', input.account]) {
      const reply = await rpc(1, {
        dbPath: input.database, userAccount, kmcStorePath: input.kmc,
        kmcStoreBakPath: input.kmc, enableGabLib: true
      });
      assert.equal(reply.rsp, 1);
      assert.equal(reply.result, 0);
      assert.equal(reply.ret, 0);
    }
  }
  function sql(name, text, binding) {
    let calls = 0, reply, failure, returned = false, late = false;
    const callback = ffi.Callback('void', ['string'], value => {
      ++calls;
      if (returned) late = true;
      if (window.require('worker_threads').threadId !== owner) wrongThread = true;
      try { reply = JSON.parse(value); } catch (error) { failure = error; }
    });
    if (binding === undefined) lib[name](text, callback);
    else lib[name](text, callback, JSON.stringify(binding));
    returned = true;
    assert.equal(calls, 1, name + ' must finish its per-call callback before returning');
    assert.equal(late, false);
    if (failure) throw failure;
    return reply;
  }
  const key = 'renderer.fixture';
  const value = 'owner-thread 联系人';
  const query = () => sql('GabSqliteQueryAllWithKey', 'SELECT value FROM ct_config WHERE key=?',
    { 0: key, len: 1, type: 4 });
  try {
    // This is a real invalid native argument, not an injected failure result.
    window.DbMsgCallback = ref.NULL;
    await assert.rejects(Promise.resolve().then(load), /Native contact startup failed \([1-9][0-9]*\)/);
    assert.deepEqual(events, [], 'Failed startup must not start a dispatch timer');
    delete window.DbMsgCallback;
    const loading = load();
    assert.strictEqual(load(), loading, 'Concurrent callers must share startup');
    lib = await loading;
    assert.strictEqual(load(), lib);
    assert.deepEqual(Object.keys(lib).sort(), [...input.active, '_ffi'].sort());
    assert.equal(lib.GabReadZipFile, undefined);
    assert.deepEqual(events, ['start']);

    // The renderer releases its only global pointer; the native runtime must
    // keep the registered callback alive across GC and queued worker responses.
    const registered = new WeakRef(window.DbMsgCallback);
    delete window.DbMsgCallback;
    await delay(0);
    window.gc();
    assert.ok(registered.deref(), 'Global contact callback lost its runtime owner');
    await initialize();
    const write = sql('GabSqliteExecWithKey', 'REPLACE INTO ct_config(key,value) VALUES(?,?)',
      { 0: key, 1: value, len: 2, type: 2 });
    assert.equal(write.code, 0);
    assert.equal(write.count, 1);
    assert.deepEqual(query(), { code: 0, data: [{ value }] });
    const unbound = sql('GabSqliteQueryAll', "SELECT value FROM ct_config WHERE key='renderer.fixture'");
    assert.deepEqual(unbound, { code: 0, data: [{ value }] });
    assert.equal(sql('GabSqliteExec', "UPDATE ct_config SET value=value WHERE key='renderer.fixture'").code, 0);
    const invalid = sql('GabSqliteQueryAll', 'SELECT * FROM missing_contact_renderer_table');
    assert.notEqual(invalid.code, 0);
    assert.equal(typeof invalid.error, 'string');

    // FFI .async must still execute on the service owner, never a libuv worker.
    let perCallCount = 0, perCallReply, perCallFailure;
    let perCall = ffi.Callback('void', ['string'], text => {
      ++perCallCount;
      if (window.require('worker_threads').threadId !== owner) wrongThread = true;
      try { perCallReply = JSON.parse(text); } catch (error) { perCallFailure = error; }
    });
    const completed = new Promise((resolve, reject) => {
      lib.GabSqliteQueryAllWithKey.async('SELECT value FROM ct_config WHERE key=?', perCall,
        JSON.stringify({ 0: key, len: 1, type: 4 }), error => error ? reject(error) : resolve());
    });
    assert.equal(perCallCount, 1, '.async must not move the native callback to a pool thread');
    perCall = null;
    window.gc();
    await completed;
    if (perCallFailure) throw perCallFailure;
    assert.deepEqual(perCallReply, { code: 0, data: [{ value }] });

    const cancelledSno = ++serial;
    lib.SqliteRecvMsgImport(JSON.stringify({ cmd: 15, sno: cancelledSno, param: { _matchinfo: { keytype: 0, match_value: '' } } }));
    const beforeUnload = callbacks;
    window.dispatchEvent(new Event('beforeunload'));
    assert.deepEqual(events, ['start', 'stop'], 'Void shutdown returns null through ffi-napi');
    native.stopAll();
    assert.deepEqual(events, ['start', 'stop'], 'stopAll must be idempotent after void shutdown');
    await delay(100);
    assert.equal(callbacks, beforeUnload, 'Shutdown must not dispatch a cancelled completion');
    assert.ok(!replies.some(reply => reply.sno === cancelledSno));

    const control = native.createLibrary('contact_sqlite_plugin.dll', {
      SqliteServiceStartup: ['int', ['pointer']], ContactPluginShutdown: ['void', []]
    }, {}, ffi);
    const restarted = ffi.Callback('void', ['string'], text => window.notifyJsTupDBCallback(text));
    assert.equal(control.SqliteServiceStartup(restarted), 0);
    await initialize();
    assert.deepEqual(query(), { code: 0, data: [{ value }] }, 'Shutdown/restart must preserve committed contact data');
    control.ContactPluginShutdown();
    assert.deepEqual(events, ['start', 'stop', 'start', 'stop']);
    native.stopAll();
    assert.deepEqual(events, ['start', 'stop', 'start', 'stop']);
    assert.equal(wrongThread, false);
    if (callbackError) throw callbackError;
    return { bundle: input.bundle, callbacks, events, startupRetry: true, synchronousSql: true,
      queuedOwnerCallbacks: true, asyncOwnerCalls: true, shutdownCancellation: true, restartPersistence: true };
  } finally {
    for (const waiter of pending.values()) window.clearTimeout(waiter.timer);
    native.stopAll();
    offStart(); offStop();
    delete window.DbMsgCallback;
  }
}

(async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'ia32', 'Use the genuine ia32 Electron runtime');
  const seed = option('--kmc-seed');
  assert.ok(seed, '--kmc-seed must identify an original synthetic seed directory');
  const imageApp = option('--app');
  if (imageApp) checkImage(imageApp);
  const nativeRoot = imageApp ? path.join(imageApp, 'native') : __dirname;
  const ffiRoot = imageApp ? path.join(imageApp, 'libraries/node_extends/node-ffi') : path.resolve(__dirname, '../NativeBuild/ffi/output');
  const bundleRoot = imageApp || path.join(__dirname, 'app-overrides');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-contact-renderer-'));
  for (const directory of ['runtime', 'fixture', 'fixture/pedestal', 'kmc', 'logs']) fs.mkdirSync(path.join(root, directory));
  fs.symlinkSync(nativeRoot, path.join(root, 'fixture/native'), 'dir');
  for (const name of ['kmcStore.dat', 'kmcStore_bak.dat']) fs.copyFileSync(path.join(seed, name), path.join(root, 'kmc', name));
  app.setPath('userData', path.join(root, 'runtime'));
  app.commandLine.appendSwitch('js-flags', '--expose-gc');
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  const results = [];
  try {
    await window.loadURL('data:text/html,<body>Real contact renderer ABI verification</body>');
    for (const [index, relative] of LOADERS.entries()) {
      const database = path.join(root, 'database-' + index);
      fs.mkdirSync(database);
      const input = {
        active: ACTIVE, bundle: path.join(bundleRoot, relative), native: path.join(nativeRoot, 'ffi.js'),
        ffi: path.join(ffiRoot, 'ffi-napi'), ref: path.join(ffiRoot, 'node_modules/ref-napi'),
        pedestal: path.join(root, 'fixture/pedestal'), logs: path.join(root, 'logs'),
        kmc: path.join(root, 'kmc'), database, account: 'contact-renderer-' + index
      };
      results.push(await window.webContents.executeJavaScript('(' + rendererProof.toString() + ')(' + JSON.stringify(input) + ')'));
    }
    console.log(JSON.stringify({ passed: true, root, assembledImage: imageApp, results }));
  } finally { if (!window.isDestroyed()) window.destroy(); }
})().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
