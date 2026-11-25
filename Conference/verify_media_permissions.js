#!/usr/bin/env node
'use strict';

// Production permission-handler regression coverage with in-memory Electron
// boundaries. This is not a device, conference-server or live-dialog acceptance.
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const native = process.env.WELINK_TEST_NATIVE;
if (!native || !path.isAbsolute(native)) throw new Error('Set WELINK_TEST_NATIVE to the staged native runtime');
const { MeetingNativeWeb } = require(path.join(native, 'meeting_native_web'));
const origin = 'https://meeting.invalid';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
  const prompts = [];
  const replies = [];
  const session = {
    setPermissionCheckHandler(handler) { this.check = handler; },
    setPermissionRequestHandler(handler) { this.request = handler; }
  };
  class Contents extends EventEmitter {
    constructor() { super(); this.id = 1; this.url = ''; }
    getURL() { return this.url; }
    setWindowOpenHandler() {}
    async executeJavaScript() {}
  }
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new Contents(); this.destroyed = false; }
    isDestroyed() { return this.destroyed; }
    async loadURL(url) { this.webContents.url = url; }
    destroy() { this.destroyed = true; }
  }
  const electron = { BrowserWindow: Window, ipcMain: { handle() {}, removeHandler() {} } };
  const owner = new MeetingNativeWeb({ electron, origin,
    requestPermission(request) {
      prompts.push(request);
      return new Promise(resolve => replies.push(resolve));
    }
  });
  owner.initializeSession = async () => { owner.session = session; };
  owner.runMediaRequest = async (_window, operation) => operation();
  owner.voiceSession = () => null;
  owner.callPage = async () => ({ ready: true, sdkVersion: 'isolated-permission-test', capabilities: {} });
  await owner.initializeWindow();
  const contents = owner.window.webContents;
  const details = { isMainFrame: true, requestingUrl: origin + '/webrtc/', securityOrigin: origin, mediaTypes: ['audio'] };
  const request = (permission = 'media', changes = {}, sender = contents) =>
    new Promise(resolve => session.request(sender, permission, resolve, { ...details, ...changes }));
  return { owner, session, contents, request, prompts, replies };
}

async function main() {
  const accepted = await fixture();
  const audio = accepted.request();
  const video = accepted.request('media', { mediaTypes: ['video'] });
  await tick();
  assert.equal(accepted.prompts.length, 1, 'Concurrent microphone/camera requests must share one full-scope consent dialog');
  accepted.replies.shift()(true);
  assert.deepEqual(await Promise.all([audio, video]), [true, true]);
  assert.equal(await accepted.request(), true);
  assert.equal(accepted.prompts.length, 1, 'A granted session permission must not prompt again');
  assert.equal(accepted.session.check(accepted.contents, 'media', origin), true);

  assert.equal(await accepted.request('media', { isMainFrame: false }), false);
  assert.equal(await accepted.request('media', { requestingUrl: 'https://other.invalid/' }), false);
  assert.equal(await accepted.request('media', { securityOrigin: 'https://other.invalid' }), false);
  assert.equal(await accepted.request('media', {}, { getURL: () => accepted.contents.getURL() }), false);
  assert.equal(accepted.prompts.length, 1, 'Cached consent must not escape its document, origin or frame');

  const screen = accepted.request('media', { mediaTypes: [] });
  const speaker = accepted.request('speaker-selection');
  await tick();
  assert.deepEqual(accepted.prompts.slice(1).map(value => value.permission), ['display-capture', 'speaker-selection']);
  assert.equal(accepted.replies.length, 2, 'Different permission scopes must retain separate decisions');
  accepted.replies.shift()(false);
  accepted.replies.shift()(false);
  assert.deepEqual(await Promise.all([screen, speaker]), [false, false]);
  assert.equal(accepted.owner.allowedPermissions.has('display-capture'), false);
  assert.equal(accepted.owner.allowedPermissions.has('speaker-selection'), false);

  const denied = await fixture();
  const deniedAudio = denied.request();
  const deniedVideo = denied.request('media', { mediaTypes: ['video'] });
  await tick();
  assert.equal(denied.prompts.length, 1);
  denied.replies.shift()(false);
  assert.deepEqual(await Promise.all([deniedAudio, deniedVideo]), [false, false]);
  assert.equal(denied.owner.allowedPermissions.has('media'), false);
  const retry = denied.request();
  await tick();
  assert.equal(denied.prompts.length, 2, 'An explicit later request must remain possible after denial');
  denied.replies.shift()(true);
  assert.equal(await retry, true);

  const retired = await fixture();
  const lateAudio = retired.request();
  const lateVideo = retired.request('media', { mediaTypes: ['video'] });
  await tick();
  retired.owner.mediaOwner.retired = true;
  retired.replies.shift()(true);
  assert.deepEqual(await Promise.all([lateAudio, lateVideo]), [false, false]);
  assert.equal(retired.owner.allowedPermissions.has('media'), false, 'Late approval must not grant a retired owner');

  const failed = await fixture();
  failed.owner.options.requestPermission = () => { throw new Error('Native dialog unavailable'); };
  assert.equal(await failed.request(), false, 'A synchronous native-dialog failure must settle the request as denied');
  failed.owner.options.requestPermission = async () => true;
  assert.equal(await failed.request(), true, 'A failed prompt must not leave a permanently pending permission request');
  console.log('Permission policy regression passed: shared consent, cached grant, denial retry, scope isolation and retired-owner rejection.');
}
const deadline = setTimeout(() => {
  console.error('Permission policy regression timed out with an unresolved request');
  process.exit(1);
}, 10000);
main().then(() => clearTimeout(deadline), error => {
  clearTimeout(deadline);
  console.error(error.stack || error);
  process.exitCode = 1;
});
