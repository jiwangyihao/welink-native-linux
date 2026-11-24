#!/usr/bin/env electron
'use strict';

// Real Electron/main helper and real rendered watermark adapter. Only delivery
// of the policy reply is delayed to expose the cancellation race deterministically.
// No auth SDK, meeting, recording, microphone or camera is started.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { MeetingNativeWeb } = require('./meeting_native_web');
const { app, BrowserWindow } = electron;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-dialog-cancel-'));
app.setPath('userData', root);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function bounded(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Policy boundary was not reached')), 10000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function main() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const bridges = [];
  try {
    await window.loadURL('data:text/html,<html><body>Isolated policy cancellation fixture</body></html>');
    const source = fs.readFileSync(path.join(__dirname, 'meeting_native_web_watermark.js'), 'utf8');
    await window.webContents.executeJavaScript(source + '\nwindow.proofWatermark=window.__welinkCreateNativeWatermark({onViolation:error=>{throw error;}});window.proofWatermark.configure({content:"",color:"#999999"});');
    for (const kind of ['recording', 'screen']) {
      let chooserCalls = 0;
      const bridge = new MeetingNativeWeb({ electron, origin: 'https://127.0.0.1',
        getAccessToken: async () => { throw new Error('Cancellation proof must not request credentials'); },
        chooseRecordingFile: async () => { ++chooserCalls; throw new Error('Cancelled recording chooser was opened'); },
        selectDesktopSource: async () => { ++chooserCalls; throw new Error('Cancelled source chooser was opened'); }
      });
      bridges.push(bridge);
      bridge.window = window;
      bridge.watermarkApproved = true;
      bridge.watermarkConfiguration = { content: '', color: '#999999' };
      const entered = deferred(), release = deferred(), delivered = deferred();
      bridge.callPage = async operation => {
        assert.equal(operation, 'watermark.ensure');
        entered.resolve();
        await release.promise;
        const actual = await window.webContents.executeJavaScript('window.proofWatermark.ensure("native-ui")');
        delivered.resolve();
        return actual;
      };
      let pending;
      if (kind === 'recording') {
        const request = { requestId: 'synthetic-output', controller: new AbortController(), cancelled: false,
          authorized: true, window, entry: null };
        bridge.recordingStart = request;
        pending = bridge.chooseRecordingDestination(request, 'video/webm', '.webm');
      } else pending = bridge.captureSources(['screen']);
      const rejected = assert.rejects(pending, error => error.code === (kind === 'recording' ? 'RECORDING_CANCELLED' : 'CAPTURE_CANCELLED'));
      await bounded(entered.promise);
      await assert.rejects(bridge.execute(kind === 'recording' ? 'recording.stop' : 'screen.stop'),
        error => error.code === 'ENGINE_NOT_READY');
      await rejected;
      release.resolve();
      await bounded(delivered.promise);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(chooserCalls, 0, 'retired operation opened a chooser after its policy reply');
      assert.equal(bridge.nativeUiCount, 0, 'retired operation claimed an active native dialog');
      bridge.recordingStart = null;
      bridge.window = null;
      await bridge.execute('dispose');
      console.log('PASS delayed real watermark reply -> ' + kind + ' cancellation: no chooser and no native UI lease');
    }
  } finally {
    for (const bridge of bridges) {
      bridge.recordingStart = null;
      bridge.window = null;
      if (!bridge.disposed) await bridge.execute('dispose');
    }
    if (!window.isDestroyed()) window.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
