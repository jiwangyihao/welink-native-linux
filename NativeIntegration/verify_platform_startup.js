#!/usr/bin/env node
'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'platform.js'), 'utf8');
function fixture(autostartError) {
  const pending = [], errors = [], events = [];
  const ipc = {
    sendSync(_channel, { operation }) {
      if (operation === 'register') return { ok: true, value: { owner: 'startup-test', paths: {} } };
      if (operation === 'autostart-get') return autostartError ? { ok: false, error: autostartError } : { ok: true, value: false };
      throw new Error('Unexpected operation: ' + operation);
    },
    on() {}
  };
  const window = {
    addEventListener() {},
    dispatchEvent(event) { events.push(event); },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    Pedestal: { remote: {}, callMethod() { return new Promise((resolve, reject) => pending.push({ resolve, reject })); } },
    coreTup: { utilSDK: {} },
    coreAccount: { async getMyInfo() { return {}; } },
    coreUi: { changeAutoStart(value) { return { type: 'autostart', value }; } },
    $dispatch(action) { assert.equal(action.value, false); },
    constant: { UT_EVENT_NAME: { appLaunch: 'launch', lifecycle: 'lifecycle' } },
    langcode: '2052'
  };
  const scope = { window, module: { exports: {} }, process: { platform: 'linux', type: 'renderer' },
    console: { error(...args) { errors.push(args); } },
    require(name) { return name === 'electron' ? { ipcRenderer: ipc } : require(name); } };
  vm.runInNewContext(source, scope, { filename: 'platform.js' });
  const platform = scope.module.exports;
  platform.installRenderer({ registerConsoleEvent() {} });
  return { platform, pending, errors, events };
}
async function main() {
  const state = fixture();
  const started = state.platform.initApp({ calcTimeMap: { startTime: Date.now() } });
  await Promise.race([started, new Promise((_, reject) => setImmediate(() => reject(new Error('Startup waits for unavailable telemetry'))))]);
  assert.equal(await started, 0);
  assert.equal(state.pending.length, 2);
  for (const event of state.pending) event.reject(Object.assign(new Error('Telemetry unavailable'), { code: 'ENETDOWN' }));
  await new Promise(setImmediate);
  assert.deepEqual(state.errors.map(error => error[1]), ['ENETDOWN', 'ENETDOWN']);
  assert.deepEqual(state.events.map(event => event.detail.code), ['ENETDOWN', 'ENETDOWN']);
  const failed = fixture({ code: 'EACCES', message: 'Cannot read autostart state' });
  await assert.rejects(failed.platform.initApp({ calcTimeMap: { startTime: Date.now() } }), { code: 'EACCES' });
  assert.equal(failed.pending.length, 0, 'Required platform initialization still blocks startup on failure');
  console.log('PASS: startup does not await telemetry; telemetry failures remain observable; required initialization failures still reject');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
