'use strict';

// Parent-run only: use the selected sealed Electron, bind only its main.js to
// a bootstrap requiring this file, and pass --app CANONICAL_APP --output FILE.
// Keep the original package.json, app.getAppPath(), document and native modules.
// This is a canonical-document platform host, NOT the vendor bootstrap or a
// signed-in quit test. No IPC event, token, Pedestal object, account, native
// result or ready notification is fabricated. Getter fault cases are reported
// separately from real natural close/quit and Electron's stale-send semantics.
const fs = require('fs');
const path = require('path');
const assert = require('assert').strict;
const { createHash } = require('crypto');
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const CHANNEL = 'welink-native-platform-v1';
const OBSERVE = 'welink-platform-lifecycle-observation';
function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  assert(process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), name + ' requires a value');
  return process.argv[index + 1];
}
const root = fs.realpathSync(option('--app') || process.env.WELINK_QA_PAYLOAD);
const modulePath = fs.realpathSync(option('--module') || path.join(root, 'native/platform_main.js'));
const outputDirectory = process.env.WELINK_QA_OUTPUT || process.env.WELINK_TEST_OUTPUT;
const output = option('--output') || (outputDirectory && path.join(outputDirectory, 'platform-lifecycle.json'));
assert(output && path.isAbsolute(output), 'Supply --output /private/evidence/platform-lifecycle.json');
assert(!fs.existsSync(output), 'Refuse to overwrite a stale verifier result');
const expectedFacadeHash = hash(path.join(root, 'native/platform.js'));
const records = new Map();
const report = {
  schema: 1,
  passed: false,
  scope: 'Real sealed ia32 Electron canonical-pedestal platform host; not full vendor bootstrap or signed-in acceptance',
  sameTickProductRaceReproduced: false,
  boundaryMethod: 'Temporary getter forwarding on a genuinely registered live owner to native getters on a genuinely destroyed Electron donor; no synthetic throw or forged IPC',
  realElectron: { passed: false, owners: [], retiredCallbacks: [], quit: {} },
  apiBoundary: [],
  staleSendObservation: null,
  uncaughtErrors: [],
  rendererErrors: [],
  blockedRequests: { network: 0, vendorScripts: 0 },
  failure: null
};
let api;
let quitting = false;
let complete = false;

function errorInfo(error) {
  return { name: error && error.name || 'Error', message: error && error.message || String(error),
    stack: error && error.stack || String(error) };
}
function hash(filename) {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}
function bounded(promise, label, milliseconds = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert(Date.now() < deadline, label + ' timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function replace(object, key, descriptor) {
  const own = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, Object.assign({ configurable: true, enumerable: own ? own.enumerable : false }, descriptor));
  return () => {
    if (own) Object.defineProperty(object, key, own);
    else assert(Reflect.deleteProperty(object, key), 'Restore ' + key);
  };
}
function nativeFailure(operation, label) {
  try { operation(); }
  catch (error) {
    assert(error instanceof Error, label + ' must throw an actual native Error');
    assert(/disposed|destroyed/i.test(error.message), label + ' must fail due to actual object lifetime');
    return errorInfo(error);
  }
  throw new Error(label + ' did not throw; this runtime cannot supply the required native boundary oracle');
}
function retained(owner, reason) {
  const before = owner.sends;
  let error = null;
  try { Reflect.apply(owner.callback, owner.window, []); }
  catch (caught) { error = errorInfo(caught); }
  const result = { owner: owner.label, reason, sendsBefore: before, sendsAfter: owner.sends, error };
  report.realElectron.retiredCallbacks.push(result);
  assert.equal(error, null, reason + ' must not throw');
  assert.equal(owner.sends, before, reason + ' must not attempt a frame send');
}
function nativeGate(session) {
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (request, callback) => {
    if (/^(?:https?|wss?|ftp):/i.test(request.url)) {
      ++report.blockedRequests.network;
      callback({ cancel: true });
    } else if (request.resourceType === 'script') {
      // Preserve the sealed canonical document, but do not boot account/UI
      // services. This is the same isolation boundary as the existing renderer
      // lifetime verifier, not a claim that the vendor application is running.
      ++report.blockedRequests.vendorScripts;
      callback({ cancel: true });
    } else callback({});
  });
  session.setPermissionRequestHandler((_contents, _permission, done) => done(false));
}
function prepareExitNotExercised() {
  throw new Error('This platform-lifetime verifier does not implement native application exit cleanup');
}
function install() {
  return require(modulePath).installPlatformMain({ electron, appRoot: root, prepareExit: prepareExitNotExercised });
}

// This executes in the real, canonical pedestal main frame. The production
// facade registers through its real ipcRenderer.sendSync route and validates
// the provider response. Observation IPC does not grant production authority.
function registerRenderer(input) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const { ipcRenderer } = require('electron');
  const observe = (kind, value) => ipcRenderer.send(input.observe, { kind, value });
  window.addEventListener('error', event => observe('error', { message: event.message }));
  window.addEventListener('unhandledrejection', event => observe('error', {
    message: String(event.reason && (event.reason.stack || event.reason.message) || event.reason)
  }));
  ipcRenderer.on(input.channel, (_event, message) => {
    if (message && message.type === 'window-event') observe('window', { name: message.name });
  });
  for (const name of ['winShow', 'winHide']) window.addEventListener(name, () => observe('dom', { name }));
  const filename = path.join(input.root, 'native/platform.js');
  const platform = require(filename);
  const capabilities = platform.getCapabilities();
  return { url: location.href, capabilities, facade: require.resolve(filename),
    facadeSha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') };
}
async function owner(label) {
  const window = new BrowserWindow({ show: false, width: 480, height: 320,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false,
      partition: 'platform-lifetime-' + label } });
  const contents = window.webContents;
  const state = { label, window, contents, frame: null, callback: null, sends: 0, received: [], dom: [] };
  records.set(contents, state);
  contents.on('render-process-gone', (_event, details) => {
    report.rendererErrors.push({ owner: label, kind: 'render-process-gone', details });
  });
  await bounded(window.loadFile(path.join(root, 'pedestal/index.html')), label + ' canonical load');
  state.frame = contents.mainFrame;
  assert.equal(state.frame.parent, null);
  const previous = new Set(window.listeners('show'));
  const registered = await bounded(contents.executeJavaScript('(' + registerRenderer.toString() + ')(' +
    JSON.stringify({ root, observe: OBSERVE, channel: CHANNEL }) + ')'), label + ' real registration');
  assert.equal(registered.facade, path.join(root, 'native/platform.js'));
  assert.equal(registered.facadeSha256, expectedFacadeHash);
  assert.equal(new URL(registered.url).protocol, 'file:');
  const added = window.listeners('show').filter(listener => !previous.has(listener));
  assert.equal(added.length, 1, 'Capture exactly the production registration window listener');
  state.callback = added[0];
  const actualSend = state.frame.send;
  replace(state.frame, 'send', { writable: true, value: function (...args) {
    ++state.sends;
    return Reflect.apply(actualSend, this, args);
  } });
  report.realElectron.owners.push({ label, registered, webContentsId: contents.id,
    nativeWindowId: window.id, mainFrameRoutingId: state.frame.routingId });
  return state;
}
async function normalEvents(state) {
  const shows = state.received.filter(event => event.name === 'show').length;
  const hides = state.received.filter(event => event.name === 'hide').length;
  const domShows = state.dom.filter(event => event.name === 'winShow').length;
  const domHides = state.dom.filter(event => event.name === 'winHide').length;
  const sends = state.sends;
  state.window.show();
  await until(() => state.received.filter(event => event.name === 'show').length > shows &&
    state.dom.filter(event => event.name === 'winShow').length > domShows, state.label + ' normal show delivery');
  state.window.hide();
  await until(() => state.received.filter(event => event.name === 'hide').length > hides &&
    state.dom.filter(event => event.name === 'winHide').length > domHides, state.label + ' normal hide delivery');
  assert(state.sends > sends, 'Live owner receives real production sends');
  const item = report.realElectron.owners.find(item => item.label === state.label);
  item.normalEvents = { nativeSends: state.sends - sends,
    windowShow: state.received.filter(event => event.name === 'show').length - shows,
    windowHide: state.received.filter(event => event.name === 'hide').length - hides,
    domShow: state.dom.filter(event => event.name === 'winShow').length - domShows,
    domHide: state.dom.filter(event => event.name === 'winHide').length - domHides };
}
async function close(state, destroy = false) {
  const closed = new Promise(resolve => state.window.once('closed', resolve));
  const destroyed = new Promise(resolve => state.contents.once('destroyed', resolve));
  if (destroy) state.window.destroy(); else state.window.close();
  await bounded(Promise.all([closed, destroyed]), state.label + ' window and contents closed');
  await until(() => state.contents.isDestroyed(), state.label + ' native wrapper released');
  assert(state.contents.isDestroyed(), 'Actual WebContents must be destroyed');
}
async function boundary(name, donor, inject) {
  const state = await owner('boundary-' + name);
  await normalEvents(state);
  const before = state.sends;
  const received = state.received.filter(event => event.name === 'show').length;
  const result = { name, passed: false, nativeOracle: donor.errors[name],
    callbackError: null, boundaryCalls: 0, frameSendCalls: 0 };
  report.apiBoundary.push(result);
  try {
    const restore = inject(state, () => ++result.boundaryCalls);
    try {
      try { Reflect.apply(state.callback, state.window, []); }
      catch (error) { result.callbackError = errorInfo(error); }
      result.frameSendCalls = state.sends - before;
    } finally { restore(); }
    // Fault forwarding is confined to the synchronous callback. This fence
    // only drains observation IPC; no genuine window event runs under a fault.
    await bounded(state.contents.executeJavaScript('require("electron").ipcRenderer.sendSync(' +
      JSON.stringify(OBSERVE) + ', {kind:"fence"})'), name + ' renderer observation fence');
    result.receivedAfterFault = state.received.filter(event => event.name === 'show').length - received;
    result.passed = result.boundaryCalls > 0 && result.callbackError === null &&
      result.receivedAfterFault === 0 && result.frameSendCalls === 0;
  } finally {
    await close(state, true);
  }
}

process.on('uncaughtException', error => {
  report.uncaughtErrors.push(errorInfo(error));
  report.failure = report.failure || 'An uncaught main-process exception occurred';
  app.exit(1);
});
process.on('unhandledRejection', error => {
  report.uncaughtErrors.push(errorInfo(error));
  report.failure = report.failure || 'An unhandled main-process rejection occurred';
  app.exit(1);
});
app.on('window-all-closed', () => {});
app.on('session-created', nativeGate);
ipcMain.on(OBSERVE, (event, message) => {
  const state = records.get(event.sender);
  // Read-only evidence channel: unlike the production channel, it grants no
  // operation or authority. Do not dereference a native frame during teardown.
  assert(state, 'Only an observed WebContents may report evidence');
  if (message.kind === 'fence') { event.returnValue = true; return; }
  if (message.kind === 'window') state.received.push(message.value);
  else if (message.kind === 'dom') state.dom.push(message.value);
  else if (message.kind === 'error') report.rendererErrors.push({ owner: state.label, ...message.value });
  else throw new Error('Unknown observation');
});
app.on('quit', (_event, exitCode) => {
  report.exitCode = exitCode;
  report.realElectron.quit.quitObserved = true;
  report.realElectron.quit.remainingWindows = BrowserWindow.getAllWindows().length;
  report.loadedModules = Object.keys(require.cache).filter(filename => path.isAbsolute(filename));
  report.realElectron.passed = complete && report.realElectron.ownerLifecyclePassed === true &&
    report.uncaughtErrors.length === 0 && report.rendererErrors.length === 0 &&
    report.realElectron.quit.beforeQuitWindows === 3 && report.realElectron.quit.willQuitObserved === true &&
    report.realElectron.quit.remainingWindows === 0 && report.realElectron.quit.windows.every(window => window.closed);
  report.passed = complete && report.realElectron.passed && report.apiBoundary.length === 2 &&
    report.apiBoundary.every(item => item.passed) && !report.failure && report.uncaughtErrors.length === 0 &&
    report.rendererErrors.length === 0 && report.realElectron.quit.beforeQuitWindows >= 3 &&
    report.realElectron.quit.willQuitObserved === true && report.realElectron.quit.remainingWindows === 0 &&
    exitCode === 0 && report.loadedModules.includes(modulePath);
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
});
const watchdog = setTimeout(() => {
  report.failure = 'Whole-verifier deadline exceeded';
  app.exit(2);
}, 90000);

(async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'ia32');
  assert.equal(root, fs.realpathSync(app.getAppPath()), 'Do not override or impersonate the running application root');
  assert.equal(modulePath, path.join(root, 'native/platform_main.js'), 'Select the canonical sealed platform module');
  const executable = option('--runtime') || process.env.WELINK_QA_EXECUTABLE || path.resolve(root, '../../electron');
  assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(executable));
  const distribution = JSON.parse(fs.readFileSync(path.join(root, 'native/distribution-sha256.json'), 'utf8'));
  const executableHash = hash(process.execPath);
  assert.equal(executableHash, distribution.files.electron.sha256, 'Use this image\'s sealed runtime');
  const moduleDigest = option('--module-sha256');
  if (moduleDigest) assert.equal(hash(modulePath), moduleDigest, 'Selected module SHA-256 differs');
  for (const flag of ['no-sandbox', 'disable-web-security', 'ignore-certificate-errors']) {
    assert(!app.commandLine.hasSwitch(flag), 'Forbidden trust-weakening switch: ' + flag);
  }
  report.binding = { executable: process.execPath, executableSha256: executableHash,
    platformModule: modulePath, platformSha256: hash(modulePath),
    platformSettingsSha256: hash(path.join(root, 'native/platform_settings.js')),
    appRoot: root, electron: process.versions.electron, chrome: process.versions.chrome,
    arch: process.arch, processSandboxDisabled: app.commandLine.hasSwitch('no-sandbox') };
  const profile = fs.mkdtempSync(path.join(process.env.HOME, 'platform-lifetime-'));
  fs.chmodSync(profile, 0o700);
  for (const name of ['profile', 'runtime', 'logs']) fs.mkdirSync(path.join(profile, name), { mode: 0o700 });
  app.setPath('appData', path.join(profile, 'profile'));
  app.setPath('userData', path.join(profile, 'runtime'));
  app.setAppLogsPath(path.join(profile, 'logs'));
  report.binding.privateProfile = profile;
  await app.whenReady();
  nativeGate(electron.session.defaultSession);
  api = install();

  const first = await owner('first');
  await normalEvents(first);
  first.contents.once('destroyed', () => retained(first, 'real destroyed listener after production retirement'));
  // Closing the real canonical renderer runs its production facade unload and
  // ownership-release path; the retained callback is not a manufactured IPC.
  await close(first);
  retained(first, 'late callback after actual close');
  // A separate never-registered donor keeps deliberate stale API probes out
  // of the retired production owner's send counters and lifecycle evidence.
  const donorWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await bounded(donorWindow.loadFile(path.join(root, 'pedestal/browserWindowPool.html')), 'native fault donor load');
  const donor = { contents: donorWindow.webContents, frame: donorWindow.webContents.mainFrame, errors: {} };
  const donorClosed = new Promise(resolve => donorWindow.once('closed', resolve));
  const donorDestroyed = new Promise(resolve => donor.contents.once('destroyed', resolve));
  donorWindow.destroy();
  await bounded(Promise.all([donorClosed, donorDestroyed]), 'native fault donor retirement');
  await until(() => donor.contents.isDestroyed(), 'native fault donor wrapper released');
  assert(donor.contents.isDestroyed());
  donor.errors.mainFrame = nativeFailure(() => donor.contents.mainFrame, 'destroyed WebContents.mainFrame');
  donor.errors.parent = nativeFailure(() => donor.frame.parent, 'disposed WebFrameMain.parent');
  // Electron 22's public send() catches _send lifetime failures and logs them.
  // Characterize that real API separately; do not invent a throwing public send
  // or demand that production code duplicate Electron's catch.
  const nativeSendError = nativeFailure(() => donor.frame._send(false, CHANNEL, []), 'disposed WebFrameMain._send');
  let publicSendError = null;
  const diagnostics = [];
  const originalError = console.error;
  console.error = (...args) => {
    diagnostics.push(args.map(value => value instanceof Error ? errorInfo(value) : String(value)));
    Reflect.apply(originalError, console, args);
  };
  console.log('QA_INTENTIONAL_STALE_SEND_BEGIN');
  try { donor.frame.send(CHANNEL, { type: 'window-event', name: 'show' }); }
  catch (error) { publicSendError = errorInfo(error); }
  finally {
    console.error = originalError;
    console.log('QA_INTENTIONAL_STALE_SEND_END');
  }
  report.staleSendObservation = { nativeSendError, publicSendError, diagnostics,
    productionCallbackUsed: false, interpretation: 'Direct API probe only; intentionally sends to a disposed donor, not a retired-owner production callback' };
  assert.equal(publicSendError, null, 'The selected Electron public send must retain its real error semantics');
  assert(diagnostics.length > 0, 'Observe Electron reporting its actual stale native send failure');

  const replacement = await owner('replacement');
  await normalEvents(replacement);
  retained(first, 'old callback with a new owner active');
  api.dispose();
  retained(replacement, 'disposed provider while its window is still live');
  // destroy intentionally does not dispatch the renderer unload callback into
  // a disposed IPC handler. It still retires genuine BrowserWindow/WebContents.
  await close(replacement, true);
  const previousApi = api;
  api = install();
  assert.notEqual(api, previousApi, 'A disposed installation must be replaceable');
  const reopened = await owner('reinstalled');
  await normalEvents(reopened);
  retained(replacement, 'disposed owner after a fresh installation');
  await close(reopened);
  report.realElectron.ownerLifecyclePassed = true;

  await boundary('mainFrame', donor, (state, invoked) => replace(state.contents, 'mainFrame', { get() {
    invoked();
    return donor.contents.mainFrame;
  } }));
  await boundary('parent', donor, (state, invoked) => replace(state.frame, 'parent', { get() {
    invoked();
    return donor.frame.parent;
  } }));

  const finalOwner = await owner('multiwindow-quit');
  await normalEvents(finalOwner);
  const peers = [];
  for (let index = 0; index < 2; ++index) {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await bounded(window.loadFile(path.join(root, 'pedestal/browserWindowPool.html')), 'secondary real window');
    peers.push(window);
  }
  assert.equal(BrowserWindow.getAllWindows().length, 3);
  const closing = [finalOwner.window, ...peers];
  report.realElectron.quit.windows = closing.map(window => ({ windowId: window.id, contentsId: window.webContents.id,
    url: window.webContents.getURL(), closed: false }));
  closing.forEach((window, index) => window.once('closed', () => { report.realElectron.quit.windows[index].closed = true; }));
  finalOwner.contents.once('destroyed', () => retained(finalOwner, 'production callback during actual app.quit teardown'));
  app.once('before-quit', () => {
    quitting = true;
    report.realElectron.quit.beforeQuitWindows = BrowserWindow.getAllWindows().length;
  });
  app.once('will-quit', () => {
    assert(quitting, 'The actual app.quit path must run');
    assert(report.realElectron.quit.windows.every(window => window.closed), 'Every real window must accept quit');
    api.dispose();
    retained(finalOwner, 'callback after final provider disposal');
    report.realElectron.quit.willQuitObserved = true;
    complete = true;
    clearTimeout(watchdog);
    // A negative-control run still closes every real window via app.quit().
    // Only after will-quit do we select a nonzero regression exit status.
    if (report.apiBoundary.some(item => !item.passed) || report.rendererErrors.length ||
        report.uncaughtErrors.length || report.failure) app.exit(1);
  });
  app.quit();
})().catch(error => {
  report.failure = errorInfo(error);
  clearTimeout(watchdog);
  app.exit(1);
});
