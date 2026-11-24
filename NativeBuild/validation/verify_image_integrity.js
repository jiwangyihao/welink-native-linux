'use strict';
// Run with the selected sealed ia32 Electron in ELECTRON_RUN_AS_NODE mode.
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
assert.equal(process.arch, 'ia32');
const root = fs.realpathSync(process.argv[2]);
const ffi = require(path.join(root, 'libraries/node_extends/node-ffi/ffi-napi'));
const api = ffi.Library(path.join(root, 'native/lib/sqlite_plugin.dll.so'), {
  tup_sqlite_init: ['void', ['pointer']],
  tup_sqlite_send_msg: ['void', ['string']],
  pedestal_integrity_dispatch: ['int', []],
  tup_sqlite_shutdown: ['void', []]
});
let reply, error;
const callback = ffi.Callback('int', ['string'], text => {
  try { reply = JSON.parse(text); } catch (cause) { error = cause; }
  return 0;
});
api.tup_sqlite_init(callback);
api.tup_sqlite_send_msg(JSON.stringify({ cmd: 80, sno: 458, param: {} }));
const deadline = Date.now() + 30000;
const pump = setInterval(() => {
  try {
    assert(api.pedestal_integrity_dispatch() >= 0);
    if (error) throw error;
    if (!reply) { assert(Date.now() < deadline, 'Integrity callback timed out'); return; }
    assert.equal(reply.sno, 458);
    assert.equal(reply.rsp, 80);
    assert.equal(reply.result, 0, JSON.stringify(reply));
    console.log(JSON.stringify({ passed: true, build: JSON.parse(fs.readFileSync(path.join(root, 'native/build.json'))).build, reply }));
    clearInterval(pump); api.tup_sqlite_shutdown();
    void callback;
  } catch (cause) {
    clearInterval(pump); api.tup_sqlite_shutdown();
    console.error(cause.stack); process.exitCode = 1;
  }
}, 5);
