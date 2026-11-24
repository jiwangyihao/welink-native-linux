#!/usr/bin/env electron
'use strict';

/* Parent-run queue regression, in a NEW real Electron main process:
 *   <electron-binary> verify_meeting_main_queue.js
 * No BrowserWindow, FFI, microphone, camera or real meeting is opened. The
 * loopback listener is a tripwire: correct cancellation must not reach it at
 * all, and must not even invoke the supplied identity/token providers.
 * This does not replace/mock Electron, MeetingNativeWeb or its service modules.
 * The management transport/verifier owned by Main are deliberately untouched.
 */
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { MeetingNativeWeb } = require('./meeting_native_web');

let app;
async function main() {
  assert.ok(process.versions.electron, 'Run this regression with a real Electron main process');
  const electron = require('electron');
  assert.ok(electron.app && electron.ipcMain && typeof electron.ipcMain.handle === 'function',
    'Electron main APIs are required; renderer/RUN_AS_NODE substitutes are not accepted');
  app = electron.app;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-main-queue-'));
  fs.chmodSync(directory, 0o700);
  app.setPath('userData', directory);
  let connections = 0;
  const tripwire = net.createServer(socket => { ++connections; socket.destroy(); });
  const bridges = [];
  try {
    await app.whenReady();
    await new Promise((resolve, reject) => {
      tripwire.once('error', reject);
      tripwire.listen(0, '127.0.0.1', () => { tripwire.removeListener('error', reject); resolve(); });
    });
    const port = tripwire.address().port;
    for (const operation of ['dispose', 'session.logout']) {
      let configReads = 0, tokenReads = 0;
      const bridge = new MeetingNativeWeb({ electron, origin: 'https://127.0.0.1:' + port,
        getManagementConfig: async () => {
          ++configReads;
          return { server: '127.0.0.1', port, userAgent: 'SyntheticQueueVerification/1', deviceId: 'synthetic-linux-device' };
        },
        getAccessToken: async () => { ++tokenReads; return 'synthetic-token-must-not-be-requested'; }
      });
      bridges.push(bridge);
      const before = connections;
      // Deliberately no await between admission and retirement: this is the
      // original same-tick gap before service dispatch captured its generation.
      const creation = bridge.execute('call.ctd.start', { caller_number: '999000001', callee_number: '999000002' });
      const retirement = bridge.execute(operation);
      const [created, retired] = await Promise.allSettled([creation, retirement]);
      assert.equal(created.status, 'rejected', 'a retired queued CTD command completed instead of being cancelled');
      assert.equal(created.reason.code, 'MANAGEMENT_REQUEST_ABORTED',
        'queue cancellation did not reject before entering the provider');
      assert.equal(retired.status, 'fulfilled', 'owner retirement failed');
      assert.equal(retired.value.localCleanupComplete, true);
      if (operation === 'dispose') assert.equal(retired.value.disposed, true);
      assert.equal(configReads, 0, 'retired queued CTD consulted authentication configuration');
      assert.equal(tokenReads, 0, 'retired queued CTD requested a credential');
      assert.equal(connections, before, 'retired queued CTD attempted a network connection');
      assert.equal(electron.BrowserWindow.getAllWindows().length, 0, 'queue cancellation opened a media window');
      if (!bridge.disposed) await bridge.execute('dispose');
      console.log('PASS same-tick CTD -> ' + operation + ': no provider calls, no connection, no CREATECONF');
    }
  } finally {
    for (const bridge of bridges) {
      if (!bridge.disposed) await bridge.execute('dispose');
    }
    if (tripwire.listening) await new Promise(resolve => tripwire.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().then(() => { if (app) app.exit(0); }, error => {
  console.error(error && error.stack || error);
  if (app) app.exit(1);
  else process.exitCode = 1;
});
