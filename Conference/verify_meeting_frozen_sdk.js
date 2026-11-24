#!/usr/bin/env electron
'use strict';

// Opt-in provider integration test. Pass the packaged resources/app/native directory.
// Runs without login or media permissions. Use the same sandboxed Electron as the release.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { app } = electron;
const native = process.env.WELINK_TEST_NATIVE;
if (!native || !path.isAbsolute(native)) throw new Error('Set WELINK_TEST_NATIVE to the packaged native directory');
const { MeetingNativeWeb, PROTOCOL } = require(path.join(native, 'meeting_native_web.js'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-frozen-sdk-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});

// Reproduce the provider's ordinary dispatch of its original HRTC export before
// installing the Linux adapter. Immer freezes this exact object in the pinned release.
const publishOriginal = `(async () => {
  let load;
  window.webpackChunkweb_rtc.push([['wl-check-frozen-sdk'], {}, r => { load = r; }]);
  await load.e(12);
  const sdk = load(91012), store = load(36176).store, actions = load(65113), selectors = load(53765);
  store.dispatch(actions.setHrtc(sdk));
  const original = sdk.createStream;
  if (Object.getOwnPropertyDescriptor(sdk, 'createStream').writable !== false)
    throw new Error('Provider did not expose the read-only SDK seen in production');
  window.inspectFrozenStream = (mode) => {
    if (mode === 'republish') store.dispatch(actions.setHrtc(sdk));
    const binding = selectors.selectRtc(store.getState()).HRTC;
    if (mode === 'restored') return binding === sdk && sdk.createStream === original;
    if (binding === sdk || sdk.createStream !== original) return false;
    let denied = false;
    try { binding.createStream({screen:true}); } catch (e) { denied = e.code === 'APP_SCREEN_SHARE_DENIED'; }
    if (!denied) return false;
    const stream = binding.createStream({audio:true, video:false});
    try { return typeof stream.initialize === 'function' && !stream.getAudioTrack() && !stream.getVideoTrack(); }
    finally { stream.close(); }
  };
})()`;

async function main() {
  await app.whenReady();
  let devicePrompts = 0;
  const bridge = new MeetingNativeWeb({ electron, origin:'https://meeting.huaweicloud.com',
    requestPermission: async () => { ++devicePrompts; return false; } });
  // Await the fixture precondition before any application code initializes the adapter.
  bridge.runtimeSource = '(async()=>{ await ' + publishOriginal + ';\n' + bridge.runtimeSource + '\n})()';
  const report = await bridge.handle({protocol:PROTOCOL, id:'init', operation:'initialize', params:{}});
  assert.equal(report.ok, true, report.error && report.error.message);
  assert.equal(report.data.event, 'engine-ready');
  assert.equal(report.data.sdkVersion, '1.10.96');
  const inspect = phase => bridge.window.webContents.executeJavaScript('window.inspectFrozenStream('+JSON.stringify(phase)+')');
  assert.equal(await inspect('installed'), true, 'Normal stream creation or the screen permission gate failed');
  assert.equal(await inspect('republish'), true, 'A late HRTC import displaced the guarded binding');
  assert.equal((await bridge.callPage('dispose')).disposed, true);
  assert.equal(await inspect('restored'), true, 'Disposal did not return the untouched original module');
  assert.equal(devicePrompts, 0);
  console.log('PASS: engine-ready with genuinely frozen HRTC 1.10.96; stream creation, denied capture, rebinding and restoration verified');
}
const limit=setTimeout(()=>{ console.error('Timed out waiting for the actual public SDK');app.exit(2); },95000);
main().then(()=>{clearTimeout(limit);app.exit(0);},err=>{clearTimeout(limit);console.error(err.message);app.exit(1);});
app.once('quit', () => fs.rmSync(profile,{recursive:true,force:true}));
