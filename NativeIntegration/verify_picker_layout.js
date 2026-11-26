#!/usr/bin/env electron
'use strict';

// Real sandboxed picker UI with a native window whose initial viewport is too
// small. Only synthetic source identifiers are offered; no capture is started.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const electron = require('electron');
const { app, BrowserWindow } = electron;
const native = process.env.WELINK_TEST_NATIVE;
assert(native && path.isAbsolute(native), 'Supply the staged native module directory');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-picker-layout-'));
app.setPath('userData', path.join(root, 'profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.on('window-all-closed', () => {});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function bounded(promise, label, milliseconds = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function waitVisible(window) {
  return window.webContents.executeJavaScript(`new Promise(resolve => {
    const deadline = performance.now() + 7000;
    const check = () => {
      const state = window.__welinkPickerWatermark?.state();
      if (getComputedStyle(document.body).visibility === 'visible' && state?.ready && state.enabled) {
        const canvas = [...document.querySelectorAll('canvas')].find(c => c.width > 0 && c.height > 0);
        const pixels = canvas?.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        resolve({ ready: true, painted: !!pixels && pixels.some((v, i) => i % 4 === 3 && v > 0),
          selected: document.querySelector('#sources input:checked')?.value ?? null, width: innerWidth, height: innerHeight });
      } else if (performance.now() >= deadline) resolve({ ready: false });
      else requestAnimationFrame(check);
    };
    check();
  })`);
}
function click(contents, rectangle) {
  assert(rectangle.width > 0 && rectangle.height > 0, 'Control must have actual rendered bounds');
  const x = Math.round(rectangle.x + rectangle.width / 2), y = Math.round(rectangle.y + rectangle.height / 2);
  contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}
async function runCase(showPicker, parent, mode) {
  console.log('PICKER_CASE ' + mode);
  const controller = new AbortController();
  const shown = deferred();
  let window, staged, initial, unprotected = false;
  function DeferredLayoutWindow(options) {
    window = new BrowserWindow({ ...options, width: 1, height: 1, minWidth: 0, minHeight: 0 });
    window.webContents.on('console-message', (_event, _level, message) => {
      if (message === 'QA_SOURCE_UI_UNPROTECTED') unprotected = true;
    });
    const load = window.loadFile.bind(window);
    window.loadFile = async (...args) => {
      await load(...args);
      initial = await window.webContents.executeJavaScript(`(() => {
        const inspect = () => {
          const state = window.__welinkPickerWatermark?.state();
          if (getComputedStyle(document.body).visibility === 'visible' && !(state?.ready && state.enabled))
            console.error('QA_SOURCE_UI_UNPROTECTED');
        };
        new MutationObserver(inspect).observe(document.documentElement, { attributes: true, subtree: true });
        inspect();
        return { width: innerWidth, height: innerHeight, hidden: getComputedStyle(document.body).visibility === 'hidden' };
      })()`);
      assert(initial.width < 200 || initial.height < 120, 'Fixture must have a real not-yet-usable viewport');
      assert.equal(initial.hidden, true, 'Source names must be hidden before layout and protection');
    };
    window.once('show', () => {
      staged = window.webContents.executeJavaScript('getComputedStyle(document.body).visibility').then(visibility => {
        assert.equal(visibility, 'hidden', 'Mapping the window must not reveal unprotected source names');
        if (mode === 'cancel-layout') controller.abort();
        else if (mode !== 'layout-timeout') window.setContentSize(640, 500);
      });
      shown.resolve();
    });
    return window;
  }
  const facade = Object.create(Object.getPrototypeOf(electron), {
    ...Object.getOwnPropertyDescriptors(electron), BrowserWindow: { enumerable: true, value: DeferredLayoutWindow }
  });
  const chosenId = 'window:synthetic-layout:0';
  const pending = showPicker({ electron: facade, parent,
    sources: [{ id: chosenId, name: '合成共享来源 / Synthetic source', displayId: '' }],
    scope: { signal: controller.signal, release() {} },
    watermark: { content: '合成水印测试', color: mode === 'invalid-policy' ? '#ffffff' : '#cccccc' } });
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  try {
    await bounded(Promise.race([shown.promise, outcome.then(result => {
      throw result.error || new Error('Picker retired before the protected layout stage');
    })]), 'Picker did not enter the blank layout stage');
    await bounded(staged, 'Native layout transition did not complete');
    let rendered = null;
    if (mode === 'select') {
      rendered = await bounded(waitVisible(window), 'Protected source UI never became usable');
      assert.equal(rendered.ready, true);
      assert.equal(rendered.painted, true, 'A real watermark must be painted before source selection');
      assert.equal(rendered.selected, null, 'No source may be selected automatically');
      fs.writeFileSync(path.join(process.env.WELINK_QA_OUTPUT, 'picker.png'),
        (await window.webContents.capturePage()).toPNG(), { mode: 0o600 });
      const optionRect = await window.webContents.executeJavaScript(`(() => {
        const r = document.querySelector('#sources input[type="radio"]').getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`);
      click(window.webContents, optionRect);
      const readyButton = await bounded(window.webContents.executeJavaScript(`new Promise(resolve => {
        const deadline = performance.now() + 3000;
        const check = () => {
          const e = document.querySelector('#share'), r = e.getBoundingClientRect();
          if (!e.disabled || performance.now() >= deadline)
            resolve({ disabled: e.disabled, x: r.x, y: r.y, width: r.width, height: r.height });
          else requestAnimationFrame(check);
        }; check();
      })`), 'Source selection did not reach the share control');
      assert.equal(readyButton.disabled, false, 'Actual selection must enable the share control');
      click(window.webContents, readyButton);
    }
    const result = await bounded(outcome, 'Picker did not settle after selection, cancellation or failure');
    if (mode === 'select') {
      if (result.error) throw result.error;
      assert.equal(result.value, chosenId, 'Return only the actually selected source');
    } else if (mode === 'layout-timeout') {
      assert.equal(result.error?.code, 'PICKER_LAYOUT_UNAVAILABLE');
    } else {
      assert(result.error || result.value === null, 'Cancellation or invalid protection must not authorize a source');
    }
    assert.equal(unprotected, false, 'Source content was exposed before watermark enforcement');
    assert.equal(window.isDestroyed(), true, 'The picker window must retire when its request settles');
    return { mode, initial, rendered, sourceAuthorized: mode === 'select', unprotectedContentObserved: unprotected };
  } finally {
    controller.abort();
    if (window && !window.isDestroyed()) window.destroy();
  }
}
(async () => {
  console.log('PICKER_START awaiting Electron readiness');
  await bounded(app.whenReady(), 'Electron did not become ready');
  console.log('PICKER_START loading staged picker module');
  // Execute the unchanged staged module; expose its private factory only in this
  // isolated verifier module, not in the production exports or installed file.
  const filename = path.join(native, 'meeting_main.js');
  const implementation = new Module(filename, module);
  implementation.filename = filename;
  implementation.paths = Module._nodeModulePaths(native);
  implementation._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.__pickerVerifier = showSourcePicker;\n', filename);
  const parent = new BrowserWindow({ width: 500, height: 350, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const cases = [];
  try {
    console.log('PICKER_START loading synthetic parent');
    await bounded(parent.loadURL('data:text/html,<html><body>Synthetic picker parent only</body></html>'),
      'Synthetic parent document did not load');
    parent.show();
    for (const mode of ['select', 'cancel-layout', 'layout-timeout', 'invalid-policy'])
      cases.push(await runCase(implementation.exports.__pickerVerifier, parent, mode));
  } finally {
    if (!parent.isDestroyed()) parent.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
  const report = { ok: true, cases, scope: 'Isolated real sandboxed source picker and rendered watermark; no account, devices or meeting' };
  fs.writeFileSync(path.join(process.env.WELINK_QA_OUTPUT, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
  app.exit(0);
})().catch(error => { console.error(error.stack || error); app.exit(1); });
