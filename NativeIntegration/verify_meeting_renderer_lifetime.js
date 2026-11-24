#!/usr/bin/env electron
'use strict';
// Parent-run only. Use --app /sealed/image/resources/app and that image's Electron.
// All profiles are new/private. No account, ticket, native result, engine-ready
// event, broker registration or notification dispatcher is fabricated. --web-assets
// supplies the pinned original provider tree, served only over local pinned TLS.
// A mounted fixture app may require this script with WELINK_QA_APP and
// WELINK_QA_WEB_ASSETS instead of argv. WELINK_QA_MEETING_EXIT_ONLY=1 (or
// --exit-only) selects only the real packaged tray-exit regressions.
// WELINK_QA_MEETING_RECOVERY_ONLY=1 (or --recovery-only) selects genuine media
// renderer crash/navigation recovery. Only the owned disposable provider window
// is terminated; real request/cleanup results are delayed, never fabricated.
// exit-host-failure injects an invalid Menu argument at the real Electron cleanup
// boundary; the genuine broker captures/returns the resulting API rejection.
// document-close-failure injects that same real Electron rejection at the owned
// window's destroy boundary; the live document must immediately lose authority.
// The recovery selection also checks synthetic observed credentials against an
// actual loopback token endpoint: no real account or production token is used.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { createHash, X509Certificate } = require('crypto');
const { execFileSync } = require('child_process');

function provision(directory) {
  const key = path.join(directory, 'server.key');
  const cert = path.join(directory, 'server.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', key, '-out', cert], { stdio: 'pipe' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}
const assert = require('assert').strict;
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const CHANNEL = 'welink-native-meeting-v1';
const CONTROL = 'welink-meeting-lifetime-proof';
const ORIGIN = 'https://meeting-lifetime.invalid';

function option(name) {
  const index = process.argv.indexOf(name);
  const variable = { '--app': 'WELINK_QA_APP', '--web-assets': 'WELINK_QA_WEB_ASSETS' }[name];
  const value = index >= 0 ? process.argv[index + 1] : process.env[variable];
  assert.ok(value && !value.startsWith('--'), name + ' requires a path');
  return fs.realpathSync(value);
}

function bounded(promise, label, timeout = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), timeout);
  })]).finally(() => clearTimeout(timer));
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function rendererProof(input) {
  const assert = window.require('assert').strict;
  const fs = window.require('fs');
  const path = window.require('path');
  const { ipcRenderer: ipc } = window.require('electron');
  const native = window.require(path.join(input.app, 'native/ffi.js'));
  const renderer = window.require(path.join(input.app, 'native/meeting_renderer.js'));
  const CHANNEL = 'welink-native-meeting-v1';
  const CONTROL = 'welink-meeting-lifetime-proof';
  const EVENT = CHANNEL + '-event';
  const channels = [CHANNEL + '-token-request', EVENT, CHANNEL + '-config-request'];
  const delay = () => new Promise(resolve => window.setTimeout(resolve, 0));
  function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  }
  async function bounded(promise, label, timeout = 10000) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(label + ' timed out')), timeout);
      })]);
    } finally { window.clearTimeout(timer); }
  }
  const rejected = promise => promise.then(() => { throw new Error('Retired operation unexpectedly succeeded'); }, error => error);
  const failures = [];
  window.addEventListener('error', event => failures.push(String(event.error?.stack || event.message)));
  window.addEventListener('unhandledrejection', event => failures.push(String(event.reason?.stack || event.reason)));
  const lifecycle = [];
  native.onLifecycle('start', id => { if (id === 'meeting_adapter') lifecycle.push('start'); });
  native.onLifecycle('stop', id => { if (id === 'meeting_adapter') lifecycle.push('stop'); });
  assert.equal(native.isStarted('meeting_adapter'), false);
  assert.equal(window.require('worker_threads').isMainThread, true);
  const domTimer = window.setTimeout(() => {}, 60000);
  assert.equal(typeof domTimer, 'number');
  window.clearTimeout(domTimer);

  let environmentGate = null, logGate = null;
  let serverPortOverride;
  const settings = { compassUrlEnable: true, compassUrl: input.origin, isUserLogined: false };
  const store = {
    getStore(key) { return key === undefined ? settings : settings[key]; },
    setStore(key, value) { settings[key] = value; }
  };
  const Pedestal = {
    logRootPath: input.logs, appdataRootPath: input.profile,
    async callMethod(method) {
      if (method === 'method://pedestal/getEnvInfo') {
        if (environmentGate) { environmentGate.entered.resolve(); await environmentGate.release.promise; }
        const env = { ffiPath: path.join(input.app, 'libraries/node_extends/node-ffi/ffi-napi') };
        if (serverPortOverride !== undefined) {
          if (serverPortOverride !== '__omit__') env.serverPort = serverPortOverride;
        } else {
          env.serverPort = Number(new URL(input.origin).port) || 443;
        }
        return env;
      }
      if (method === 'method://pedestal/getProxyInfo') return {};
      if (method === 'method://pedestal/getLogStoragePath') {
        if (logGate) { logGate.entered.resolve(); await logGate.release.promise; }
        return input.logs;
      }
      throw new Error('Unexpected pedestal request: ' + method);
    }
  };
  window.__dirname = path.join(input.app, 'plugin/conference/dist');
  // Isolate the shipped module 31 rather than booting the account/UI application.
  // Only its unused app/service imports are omitted. The actual DLL loader,
  // callback list, response correlation and every exercised SDK method are intact.
  const source = fs.readFileSync(path.join(window.__dirname, 'js/hwmService.js'), 'utf8');
  const entry = 'n(n.s=647)';
  assert.equal(source.split(entry).length, 2, 'Expected the shipped webpack entry boundary');
  const coreLogger = { getLogger: () => () => console };
  new Function('window', 'Pedestal', 'coreLogger', 'process',
    source.replace(entry, 'window.__lifetimeWebpack=n'))(window, Pedestal, coreLogger, process);
  const webpack = window.__lifetimeWebpack;
  delete window.__lifetimeWebpack;
  const sdkSource = webpack.m[31].toString();
  const appImports = 'var S=n(70),w=n(49);';
  assert.equal(sdkSource.split(appImports).length, 2, 'Expected the unused application imports');
  const util = fs.readFileSync(path.join(window.__dirname, 'libs/util.js'), 'utf8');
  const snoStart = util.indexOf('const Sno = (function () {');
  const snoEnd = util.indexOf('})();', snoStart);
  assert.ok(snoStart >= 0 && snoEnd > snoStart);
  const Sno = new Function(util.slice(snoStart, snoEnd + 5) + '\nreturn Sno;')();
  const module = { exports: {} };
  const factory = new Function('window', 'Pedestal', 'coreLogger', 'Sno', 'process',
    'return (' + sdkSource.replace(appImports, '') + ');')(window, Pedestal, coreLogger, Sno, process);
  factory(module, module.exports, webpack);
  const sdk = module.exports.a;
  assert.equal(typeof sdk.getMeetingToken, 'function');
  assert.equal(typeof window.notifyJsTupCallback, 'function');
  const options = { window, Pedestal, sdk, getStore: () => store };
  const baseline = channels.map(channel => ipc.listenerCount(channel));
  const conference = input.mode.startsWith('exit-') ?
    window.require(path.join(input.app, 'native/meeting_service.js')).createService(options) : null;
  let bridge = conference ? conference.bridge : renderer.createBridge(options);
  const singleOwner = () => channels.forEach((channel, index) =>
    assert.equal(ipc.listenerCount(channel), baseline[index] + 1, channel + ' must have one bridge owner'));
  singleOwner();
  assert.equal(bridge.nativeStopped, true, 'A new bridge must observe the actual pre-start native state');

  if (input.mode === 'cold-unload') {
    environmentGate = { entered: deferred(), release: deferred() };
    const initializing = rejected(bridge.initializeAuth());
    await environmentGate.entered.promise;
    // Keep this document alive long enough to settle a real delayed environment
    // lookup after its unload handlers; main also performs an actual window close.
    window.dispatchEvent(new Event('beforeunload'));
    environmentGate.release.resolve();
    const error = await bounded(initializing, 'startup retired by unload');
    assert.equal(error.code, 'DISPOSED');
    assert.equal(bridge.disposed, true);
    assert.equal(native.isStarted('meeting_adapter'), false);
    assert.deepEqual(lifecycle, []);
    channels.forEach((channel, index) => assert.equal(ipc.listenerCount(channel), baseline[index]));
    assert.deepEqual(failures, []);
    return { mode: input.mode, delayedStartupRetired: true, lifecycle };
  }

  const registrations = [];
  const observed = [];
  const delivered = [];
  let nextEngine = null;
  const observe = (_event, envelope) => {
    observed.push(envelope);
    if (envelope.kind === 'engine' && nextEngine) { nextEngine.resolve(envelope); nextEngine = null; }
  };
  ipc.on(EVENT, observe);
  baseline[1]++;
  const watch = current => current.on('engine', message => delivered.push({ bridge: current, message }));
  watch(bridge);
  let notifications = 0;
  const applicationListener = reply => { assert.equal(reply.notify, 1001); ++notifications; };
  sdk.setMultiNotifyFunc(1001, applicationListener);
  const notifyBaseline = sdk.getNotifyFunc(1001).length;
  const noMedia = () => {
    assert.equal(bridge.mediaReady, false);
    assert.equal(JSON.parse(native.meetingBindings().capabilities()).mediaReady, false,
      'No genuine engine-ready event has occurred');
  };
  const control = action => ipc.invoke(CONTROL, { action });
  const startHeldMedia = async current => {
    await control('arm');
    const result = rejected(current.initializeMedia());
    await bounded(control('held'), 'real media navigation gate');
    assert.equal(current.engineWaiters.size, 1);
    return { result };
  };
  const finish = async (summary, envelope) => {
    await delay();
    assert.deepEqual(failures, []);
    const retainedListener = bridge.eventListener;
    // Installed last: the actual close must run both production unload handlers.
    window.addEventListener('beforeunload', () => {
      try {
        assert.equal(bridge.disposed, true);
        assert.equal(native.isStarted('meeting_adapter'), false);
        assert.equal(bridge.engineWaiters.size, 0);
        assert.equal(bridge.nativeRequests.size, 0);
        channels.forEach((channel, index) => assert.equal(ipc.listenerCount(channel), baseline[index]));
        assert.doesNotThrow(() => retainedListener({}, envelope));
        assert.deepEqual(failures, []);
        sdk.removeNotify(1001, applicationListener);
        ipc.send(CONTROL + '-unloaded', { actualBeforeUnload: true, lifecycle,
          retainedListenerSafe: true, bridgeListenersRemoved: true });
      } catch (error) { ipc.send(CONTROL + '-unloaded', { error: String(error.stack || error) }); }
    }, { once: true });
    return summary;
  };

  if (conference) {
    // Extract the actual packaged handler/facade without booting the account UI.
    // Everything below it is the real renderer, broker, provider and native DLL.
    // Gates delay delivery only; no acknowledgement or receipt is fabricated.
    const facadeSource = '{key:"exitConf",value:()=>ae.exitConf()}';
    assert.equal(source.split(facadeSource).length, 2, 'Expected the assembled Linux exit facade');
    const facadeExit = new Function('ae', 'return (' + facadeSource + ').value;')(conference);
    const marker = '"broadcast://pedestal/logoutNotice":';
    assert.equal(source.split(marker).length, 2, 'Expected the packaged tray handler');
    const start = source.indexOf(marker) + marker.length;
    const end = source.indexOf('},"broadcast://', start);
    assert.ok(end > start, 'Expected the next packaged broadcast handler');
    const trayExit = new Function('S', 'g', 'process', 'return (' + source.slice(start, end + 1) + ');')(
      console, { default: { exitConf: facadeExit } }, process);
    const calls = [], nativeCalls = [];
    const hostFailure = input.mode === 'exit-host-failure';
    const browserFailure = input.mode === 'exit-browser-failure';
    const originalInvoke = ipc.invoke;
    const originalMethods = new Map();
    for (const method of ['init', 'usgLogout', 'exitConf', 'leaveConf']) {
      const original = sdk[method];
      assert.equal(typeof original, 'function', 'Expected the original SDK method: ' + method);
      originalMethods.set(method, original);
      sdk[method] = function (...args) {
        nativeCalls.push(method);
        return original.apply(this, args);
      };
    }
    const bound = deferred(), deliverRegistration = deferred();
    const mainDisposed = deferred(), deliverDisposal = deferred();
    let delayRegistration = input.mode === 'exit-registration';
    ipc.invoke = function (channel, request) {
      const actual = originalInvoke.apply(this, arguments);
      if (channel !== CHANNEL) return actual;
      calls.push(request.kind === 'call' ? request.message.operation : request.kind + ':' + request.operation);
      if (request.kind === 'register' && delayRegistration) {
        delayRegistration = false;
        return actual.then(receipt => {
          bound.resolve(receipt);
          return deliverRegistration.promise.then(() => receipt);
        });
      }
      if (request.kind === 'call' && request.message.operation === 'dispose') {
        return actual.then(receipt => {
          disposalReceipt = receipt;
          mainDisposed.resolve(receipt);
          return deliverDisposal.promise.then(() => receipt);
        });
      }
      return actual;
    };
    let registering, joining, ownerReceipt, recoveryCleanup, disposalReceipt;
    try {
      await trayExit(null);
      await trayExit({ isTray: false });
      assert.deepEqual(calls, [], 'Non-tray logout must not use the tray exit path');
      assert.deepEqual(nativeCalls, []);
      if (input.mode === 'exit-cold-join') {
        environmentGate = { entered: deferred(), release: deferred() };
        joining = conference.joinConfByID({ joinConfInfo: { conf_id: '1234567890' },
          advanceSet: { isOpenMicDe: false, isOpenCameraDe: false } });
        await bounded(environmentGate.entered.promise, 'cold join paused at first environment lookup');
        assert.equal(native.isStarted('meeting_adapter'), false);
        assert.deepEqual(lifecycle, []);
      } else if (input.mode === 'exit-registration') {
        registering = rejected(bridge.registerBroker());
        ownerReceipt = await bounded(bound.promise, 'tray owner bound before delivery');
        assert.equal(ownerReceipt.protocol, renderer.PROTOCOL);
        assert.equal(bridge.registration, null);
      } else if (input.mode === 'exit-pending-join') {
        await bounded(bridge.initializeMedia(), 'tray genuine provider initialization', 60000);
        assert.equal(bridge.mediaReady, true);
        ownerReceipt = bridge.registration;
        // The real initConf has passed engine/policy setup, but has not sent
        // cmd50 or the join. Exit must invalidate its later continuations too.
        logGate = { entered: deferred(), release: deferred() };
        joining = conference.joinConfByID({ joinConfInfo: { conf_id: '1234567890' },
          advanceSet: { isOpenMicDe: false, isOpenCameraDe: false } });
        await bounded(logGate.entered.promise, 'join paused before native init');
      } else if (browserFailure) {
        await bounded(rejected(bridge.initializeMedia()), 'offline provider initialization failure');
        assert.equal(bridge.mediaReady, false);
        ownerReceipt = bridge.registration;
        assert.ok(ownerReceipt, 'The failed navigation must retain its genuine registered owner');
      } else if (input.mode === 'exit-ready' || hostFailure) {
        assert.equal((await bounded(conference.initConf(), 'tray conference initialization', 60000)).result, 0);
        assert.equal(conference.confHasInit, true);
        assert.equal(bridge.mediaReady, true);
        ownerReceipt = bridge.registration;
      } else assert.equal(input.mode, 'exit-idle');
      if (hostFailure) assert.equal(await control('reject-host-menu-cleanup'), true);
      const before = { generation: bridge.generation, intent: bridge.intent };
      // Start through tray exit itself, and separately exercise account logout
      // already running when logoutNotice reaches the service.
      const initial = input.mode === 'exit-pending-join' || input.mode === 'exit-registration' ?
        conference.usgLogout() : null;
      const tray = trayExit({ isTray: true });
      const exiting = conference.exitConf();
      const loggingOut = conference.usgLogout();
      if (initial) assert.equal(exiting, initial);
      assert.equal(exiting, loggingOut);
      assert.equal(conference.exitConf(), exiting);
      assert.equal(conference.logoutPending, true);
      assert.equal(bridge.intent, before.intent + 1);
      let complete = false;
      exiting.then(() => { complete = true; }, () => { complete = true; });
      if (registering) {
        await delay();
        assert.equal(complete, false, 'Exit must await the genuine late registration');
        assert.ok(!calls.includes('dispose'));
        deliverRegistration.resolve();
        assert.equal((await bounded(registering, 'tray retired registration')).code, 'SESSION_CHANGED');
      }
      if (ownerReceipt) {
        const receipt = await bounded(mainDisposed.promise, 'tray real owner disposal', 60000);
        assert.equal(receipt.ok, !browserFailure, JSON.stringify(receipt.error));
        const browser = receipt.ok ? receipt.data : receipt.error.details;
        assert.equal(browser.disposed, true);
        assert.equal(browser.localCleanupComplete, true);
        assert.equal(browser.serverLogout.status, browserFailure ? 'unconfirmed' : 'not-required');
        assert.equal(receipt.hostCleanup.complete, !hostFailure);
        assert.equal(receipt.hostCleanup.errors.length, hostFailure ? 1 : 0);
        assert.equal(complete, false, 'Tray exit cannot finish before disposal delivery');
        assert.ok(!nativeCalls.includes('usgLogout'), 'Native logout must follow browser disposal');
        assert.equal(conference.exitConf(), exiting, 'An in-flight exit must not retire cleanup again');
        const login = await conference.usgLogin();
        assert.notEqual(login.result, 0);
        assert.equal(login.param.reason_code, 'SESSION_CHANGED', 'Exit must not queue a fresh authentication');
        deliverDisposal.resolve();
      }
      const report = await bounded(exiting, 'tray conference exit', 60000);
      assert.equal(await loggingOut, report);
      assert.equal(await bounded(tray, 'packaged tray handler result'), report);
      assert.equal(settings.nativeMeetingCleanup, report);
      assert.equal(report.localCleanupComplete, !hostFailure);
      assert.equal(bridge.generation, before.generation + 1);
      assert.equal(bridge.intent, before.intent + 1);
      assert.equal(bridge.registration, null);
      assert.equal(bridge.registrationReceipt, null);
      assert.equal(bridge.configHash, null);
      assert.equal(conference.hasUsgLogin, false);
      assert.equal(conference.confHasInit, false);
      assert.equal(conference.logoutPending, false);
      assert.equal(calls.filter(operation => operation === 'dispose').length, ownerReceipt ? 1 : 0);
      assert.ok(!calls.includes('conference.leave'), 'Provider disposal owns the only leave');
      assert.ok(!nativeCalls.includes('leaveConf') && !nativeCalls.includes('exitConf'),
        'Tray exit must not reach unsupported native 1034/1033');
      if (ownerReceipt) {
        assert.equal(report.hostCleanup, disposalReceipt.hostCleanup, 'Tray exit must preserve the exact main host receipt');
        assert.equal(report.hostCleanup.complete, !hostFailure);
        for (const error of report.hostCleanup.errors)
          assert.ok(report.errors.includes(error), 'Host errors must remain visible in the overall result');
        assert.equal(report.browser, disposalReceipt.ok ? disposalReceipt.data : disposalReceipt.error.details,
          'Host cleanup must not replace the independent provider receipt');
        assert.equal(report.browser.disposed, true);
        if (browserFailure) {
          assert.ok(report.browser.errors.length > 0);
          assert.ok(report.errors.some(error => error.code === disposalReceipt.error.code));
        } else assert.deepEqual(report.browser.errors, []);
        assert.ok(report.native && report.native.result !== 0, 'No-token logout must remain a real failure');
        assert.equal(report.result, 1);
        assert.equal(nativeCalls.filter(method => method === 'usgLogout').length, 1);
      } else {
        assert.equal(report.result, 0);
        assert.equal(report.browser, null);
        assert.equal(report.native, null);
        assert.equal(report.hostCleanup, null, 'Idle exit has no registered host to dispose');
        assert.deepEqual(report.errors, []);
        assert.deepEqual(nativeCalls, []);
        assert.deepEqual(lifecycle, [], 'Idle exit must not start native authentication or media');
        assert.equal(native.isStarted('meeting_adapter'), false);
        assert.deepEqual(calls, ['voice:release']);
      }
      if (joining) {
        const callsAtExit = calls.slice();
        if (environmentGate) {
          environmentGate.release.resolve();
          environmentGate = null;
        } else {
          logGate.release.resolve();
          logGate = null;
        }
        const joined = await bounded(joining, 'join continuation retired by tray exit');
        assert.notEqual(joined.result, 0);
        assert.equal(joined.param.reason_code, 'SESSION_CHANGED');
        assert.deepEqual(calls, callsAtExit, 'Retired init/join must not register a new owner');
        assert.deepEqual(nativeCalls, ownerReceipt ? ['usgLogout'] : [], 'Retired init must not reach native cmd50');
        assert.equal(conference.confHasInit, false);
      }
      if (input.mode === 'exit-cold-join') {
        assert.equal(native.isStarted('meeting_adapter'), false, 'Late getEnvInfo must not start native after exit');
        assert.deepEqual(lifecycle, [], 'Retired cold startup must not register its callback');
        assert.equal(bridge.configHash, null);
        const registration = await bounded(bridge.registerBroker(), 'legitimate registration after cold exit');
        assert.equal(registration.protocol, renderer.PROTOCOL);
        assert.equal(bridge.registration, registration);
        assert.equal(native.isStarted('meeting_adapter'), true);
        assert.deepEqual(lifecycle, ['start'], 'Only the new registration may start native');
        assert.equal(bridge.mediaReady, false, 'Registration alone must not initialize media');
        deliverDisposal.resolve();
        recoveryCleanup = await bounded(trayExit({ isTray: true }), 'cleanup of the legitimate replacement owner');
        assert.equal(recoveryCleanup.browser.disposed, true);
        assert.equal(recoveryCleanup.browser.localCleanupComplete, true);
        assert.deepEqual(recoveryCleanup.browser.errors, []);
        assert.equal(recoveryCleanup.hostCleanup, disposalReceipt.hostCleanup);
        assert.equal(recoveryCleanup.hostCleanup.complete, true);
        assert.ok(recoveryCleanup.native && recoveryCleanup.native.result !== 0);
        assert.equal(recoveryCleanup.result, 1, 'The new no-token owner must retain its real logout failure');
      }
      return finish({ mode: input.mode, packagedTrayExit: true, publicConferenceExit: true, calls, nativeCalls,
        idleNativeStartupAvoided: !ownerReceipt, concurrentLogoutShared: true,
        pendingJoinRetired: !!joining, lateRegistrationDisposed: !!registering,
        coldStartupRetired: input.mode === 'exit-cold-join', recoveryCleanup,
        offlineBrowserCleanup: browserFailure ? report.browser : undefined,
        cleanup: report }, observed.find(event => event.kind === 'engine'));
    } finally {
      if (environmentGate) { environmentGate.release.resolve(); environmentGate = null; }
      if (logGate) { logGate.release.resolve(); logGate = null; }
      deliverRegistration.resolve();
      deliverDisposal.resolve();
      ipc.invoke = originalInvoke;
      for (const [method, original] of originalMethods) sdk[method] = original;
    }
  }

  // The PUBLIC entry point must start the real native owner before registration.
  registrations.push(await bridge.registerBroker());
  assert.equal(native.isStarted('meeting_adapter'), true);
  assert.deepEqual(lifecycle, ['start']);
  assert.equal(bridge.nativeStopped, false);
  noMedia();
  const emptyToken = await bridge.requestNative('getMeetingToken', [], 1001);
  assert.equal(emptyToken.notify, 1001);
  assert.ok(!emptyToken.param?.token, 'The synthetic profile must have no meeting credential');
  assert.equal(notifications, 1, 'Normal application notification is preserved exactly once');
  assert.deepEqual(sdk.getNotifyFunc(1001), [applicationListener]);
  const init = await bridge.requestNative('init', [{}], 50);
  assert.notEqual(init.result, 0, 'Native cmd50 must not report readiness without a genuine media engine');

  if (['renderer-loss', 'document-navigation', 'document-close-failure'].includes(input.mode)) {
    const closeFailure = input.mode === 'document-close-failure';
    const genuine = await bounded(bridge.initializeMedia(), 'provider before document loss', 60000);
    assert.equal(genuine.event, 'engine-ready');
    assert.equal(genuine.sdkVersion, '1.10.96');
    const registration = bridge.registration, generation = bridge.generation;
    const state = await bridge.execute('state.get');
    assert.equal(state.ready, true);
    assert.equal(state.joined, false, 'Recovery must not require a meeting');
    assert.ok(!state.roomJoined);
    const originalEnvelope = observed.find(envelope => envelope.kind === 'engine' &&
      envelope.message.instance === genuine.instance && envelope.message.sequence === genuine.sequence);
    assert.ok(originalEnvelope, 'Readiness must originate in a real IPC engine event');
    const unavailable = deferred(), cleaned = deferred();
    const reason = input.mode === 'renderer-loss' ? 'renderer-gone' : 'document-navigation';
    const onEngine = message => {
      if (message.event === 'engine-unavailable' && message.reason === reason) unavailable.resolve(message);
    };
    const onEvent = message => {
      if (message.event === 'media-session-cleanup') cleaned.resolve(message.data);
    };
    bridge.on('engine', onEngine);
    bridge.on('event', onEvent);
    try {
      const originalOwner = await control('arm-media-loss');
      // Hold delivery of a real state.get result. Renderer loss must settle the
      // public request without waiting for the vanished JavaScript context.
      const pending = rejected(bridge.execute('state.get'));
      await bounded(control('media-request-held'), 'genuine media reply held before loss');
      const loss = await bounded(control('lose-media-document'), 'owned media document retirement');
      const lost = await bounded(unavailable.promise, 'real media unavailable event');
      assert.equal(loss.id, originalOwner.id);
      assert.equal(loss.destroyed, !closeFailure);
      assert.equal(loss.serviceAlive, true);
      assert.equal(lost.instance, genuine.instance);
      assert.ok(lost.sequence > genuine.sequence);
      assert.equal((await bounded(pending, 'pending real media request retirement')).code, 'MEDIA_OWNER_CHANGED');
      noMedia();
      assert.notEqual((await bridge.requestNative('init', [{}], 50)).result, 0,
        'The stopped media renderer cannot authorize native readiness');
      const callbacksAtLoss = delivered.length;
      assert.doesNotThrow(() => bridge.eventListener({}, originalEnvelope));
      noMedia();
      assert.equal(delivered.length, callbacksAtLoss, 'A genuine but stale ready packet must remain retired');

      if (closeFailure) {
        const cleanup = await bounded(cleaned.promise, 'refused-close cleanup failure');
        assert.equal(cleanup.localCleanup.window, 'failed');
        assert.equal(cleanup.localCleanupComplete, false);
        assert.deepEqual(cleanup.errors, [loss.closeError], 'Retain the exact real Electron close-boundary rejection');
        const denied = await bounded(control('failed-media-authority'), 'live failed-document IPC rejection', 60000);
        assert.equal(denied.receiveRejected, true);
        const blocked = await bounded(rejected(bridge.initializeMedia()), 'replacement blocked by failed closure');
        assert.equal(blocked.code, 'SESSION_LOGOUT_IN_PROGRESS');
        assert.equal(bridge.engineWaiters.size, 0);
        noMedia();
        const owners = await control('media-owners');
        assert.deepEqual(owners, [{ id: originalOwner.id, freshPartition: false }],
          'A failed close must not authorize a replacement window or partition');
        await control('release-media-request');
        await delay();
        noMedia();
        assert.equal(observed.filter(envelope => envelope.kind === 'engine' &&
          envelope.message.event === 'engine-ready').length, 1);
        assert.ok(!observed.some(envelope => envelope.kind === 'event' &&
          (envelope.message.event === 'left' || (envelope.message.event === 'meeting-lifecycle' &&
            envelope.message.data?.state === 'left'))), 'Refused closure cannot confirm remote leave');
        // Remove only the isolated fault, then confirm actual destruction before
        // disposing this browser owner. Never run the account logout path.
        assert.equal((await control('close-failed-media-document')).destroyed, true);
        await control('release-media-cleanup');
        let disposalReceipt;
        const disposalError = await bounded(rejected(bridge.callRegistered('dispose', {}, registration, receipt => {
          disposalReceipt = receipt;
        })), 'failed-document browser-only disposal');
        assert.equal(disposalError.code, 'BROWSER_CREDENTIALS_UNAVAILABLE');
        const browserCleanup = disposalError.details;
        assert.equal(browserCleanup.disposed, true);
        assert.equal(browserCleanup.localCleanupComplete, true);
        assert.deepEqual(browserCleanup.errors.map(({ stage, code }) => ({ stage, code })), [
          { stage: 'credentials-before-leave', code: 'BROWSER_CREDENTIALS_UNAVAILABLE' },
          { stage: 'browser-credentials', code: 'BROWSER_CREDENTIALS_UNAVAILABLE' }
        ]);
        assert.equal(browserCleanup.serverLogout.status, 'unconfirmed');
        assert.equal(browserCleanup.serverLogout.inventoryConfirmed, false);
        assert.equal(disposalReceipt.hostCleanup.complete, true);
        assert.deepEqual(disposalReceipt.hostCleanup.errors, []);
        return finish({ mode: input.mode, realDocumentLoss: loss, failedDocumentCleanup: cleanup,
          liveDocumentAuthorityRevoked: true, pendingRequestRetired: true, replacementBlocked: true,
          offlineBrowserCleanup: browserCleanup, hostCleanup: disposalReceipt.hostCleanup }, originalEnvelope);
      }

      await bounded(control('media-cleanup-held'), 'actual isolated storage cleanup');
      let recovered = false;
      const recovery = bridge.initializeMedia();
      recovery.then(() => { recovered = true; }, () => { recovered = true; });
      await delay();
      assert.deepEqual(await control('media-owners'), [], 'Explicit recovery must wait for old-owner cleanup');
      assert.equal(recovered, false);
      await control('release-media-cleanup');
      const replacement = await bounded(recovery, 'explicit genuine provider recovery', 60000);
      const cleanup = await bounded(cleaned.promise, 'failed-document cleanup receipt');
      assert.equal(cleanup.localCleanup.window, 'closed');
      assert.equal(cleanup.localCleanupComplete, true);
      assert.deepEqual(cleanup.errors.map(({ stage, code }) => ({ stage, code })), [
        { stage: 'credentials-before-leave', code: 'BROWSER_CREDENTIALS_UNAVAILABLE' },
        { stage: 'browser-credentials', code: 'BROWSER_CREDENTIALS_UNAVAILABLE' }
      ], 'The destroyed document inventory must not become a fabricated logout confirmation');
      assert.deepEqual(cleanup.serverLogout, { status: 'unconfirmed', confirmed: false,
        credentials: 0, revoked: 0, protectedNative: 0, unconfirmed: 0, inventoryConfirmed: false });
      assert.equal(bridge.registration, registration, 'Recovery must preserve the registered account authority');
      assert.equal(bridge.generation, generation);
      assert.equal(replacement.instance, genuine.instance);
      assert.ok(replacement.sequence > lost.sequence);
      assert.equal(replacement.sdkVersion, genuine.sdkVersion);
      assert.equal(replacement.vendorAsset, genuine.vendorAsset);
      assert.equal(bridge.mediaReady, true);
      assert.equal(bridge.engineWaiters.size, 0);
      assert.equal(JSON.parse(native.meetingBindings().capabilities()).mediaReady, true);
      const owners = await control('media-owners');
      assert.equal(owners.length, 1);
      assert.notEqual(owners[0].id, originalOwner.id);
      assert.equal(owners[0].freshPartition, true, 'The failed browser partition must not be reused');
      await control('release-media-request');
      await delay();
      assert.equal(bridge.mediaReady, true, 'The late old-document result cannot retire or replace the new owner');
      const current = await bridge.execute('state.get');
      assert.equal(current.ready, true);
      assert.equal(current.joined, false);
      assert.ok(!current.roomJoined);
      const engines = observed.filter(envelope => envelope.kind === 'engine').map(envelope => envelope.message);
      assert.equal(engines.filter(message => message.event === 'engine-ready').length, 2);
      assert.equal(delivered.filter(item => item.message.event === 'engine-ready').length, 2);
      assert.ok(engines.every((message, index) => !index || message.sequence > engines[index - 1].sequence));
      assert.ok(!observed.some(envelope => envelope.kind === 'event' &&
        (envelope.message.event === 'left' || (envelope.message.event === 'meeting-lifecycle' &&
          envelope.message.data?.state === 'left'))), 'Document loss is not a confirmed remote leave');
      assert.equal((await bridge.requestNative('init', [{}], 50)).result, 0);
      let disposalReceipt;
      const browserCleanup = await bounded(bridge.callRegistered('dispose', {}, registration, receipt => {
        disposalReceipt = receipt;
      }), 'recovered browser-owner disposal');
      assert.equal(browserCleanup.disposed, true);
      assert.equal(browserCleanup.localCleanupComplete, true);
      assert.deepEqual(browserCleanup.errors, []);
      assert.equal(browserCleanup.serverLogout.status, 'not-required');
      assert.equal(disposalReceipt.hostCleanup.complete, true);
      assert.deepEqual(disposalReceipt.hostCleanup.errors, []);
      return finish({ mode: input.mode, realDocumentLoss: loss, failedDocumentCleanup: cleanup,
        initialReady: { instance: genuine.instance, sequence: genuine.sequence, sdkVersion: genuine.sdkVersion },
        recoveredReady: { instance: replacement.instance, sequence: replacement.sequence,
          sdkVersion: replacement.sdkVersion, vendorAsset: replacement.vendorAsset },
        freshMediaPartition: true, pendingRequestRetired: true, staleReadyRejected: true,
        accountAuthorityPreserved: true, explicitRecovery: true, browserCleanup,
        hostCleanup: disposalReceipt.hostCleanup }, originalEnvelope);
    } finally {
      bridge.removeListener('engine', onEngine);
      bridge.removeListener('event', onEvent);
      await control('release-media-cleanup');
      await control('release-media-request');
    }
  }

  if (input.mode === 'ready') {
    // This boots the unchanged pinned provider application, preload and HRTC;
    // only their static bytes are served locally. No readiness field is written.
    const genuine = await bounded(bridge.initializeMedia(), 'genuine provider initialization', 60000);
    assert.equal(genuine.event, 'engine-ready');
    assert.equal(genuine.instance, bridge.registration.instance);
    assert.equal(genuine.sdkVersion, '1.10.96');
    assert.equal(bridge.mediaReady, true);
    assert.equal(JSON.parse(native.meetingBindings().capabilities()).mediaReady, true);
    const engineEvents = () => observed.filter(item => item.kind === 'engine' && item.message.event === 'engine-ready');
    const engineCallbacks = () => delivered.filter(item => item.message.event === 'engine-ready');
    assert.equal(engineEvents().length, 1);
    assert.equal(engineCallbacks().length, 1);
    let initNotifications = 0;
    const initialized = () => { ++initNotifications; };
    sdk.setMultiNotifyFunc(50, initialized);
    assert.equal((await bridge.requestNative('init', [{}], 50)).result, 0);
    assert.equal(initNotifications, 1);

    const readyOwner = bridge;
    bridge = renderer.createBridge(options);
    watch(bridge);
    singleOwner();
    assert.equal(readyOwner.disposed, true);
    assert.equal(bridge.mediaReady, false);
    const replacement = await bounded(bridge.initializeMedia(), 'already-ready bridge replacement');
    assert.equal(replacement.instance, genuine.instance);
    assert.equal(replacement.sequence, genuine.sequence);
    assert.equal(bridge.mediaReady, true);
    assert.equal(bridge.engineWaiters.size, 0);
    assert.equal(engineEvents().length, 1, 'The broker must not be made to re-emit cached readiness');
    assert.equal(engineCallbacks().length, 1, 'Cached readiness must not duplicate engine callbacks');

    native.stopAll();
    assert.equal(bridge.mediaReady, false);
    assert.equal(native.isStarted('meeting_adapter'), false);
    const restarted = await bounded(bridge.initializeMedia(), 'already-ready native restart');
    assert.equal(restarted.instance, genuine.instance);
    assert.equal(restarted.sequence, genuine.sequence);
    assert.equal(bridge.mediaReady, true);
    assert.equal(bridge.engineWaiters.size, 0);
    assert.equal(engineEvents().length, 1);
    assert.equal(engineCallbacks().length, 1);
    assert.deepEqual(lifecycle, ['start', 'stop', 'start']);
    assert.equal((await bridge.requestNative('init', [{}], 50)).result, 0);
    assert.equal(initNotifications, 2, 'Each explicit real cmd50 request completes exactly once');
    sdk.removeNotify(50, initialized);
    assert.equal(JSON.parse(native.meetingBindings().capabilities()).mediaReady, true);
    const receipt = { instance: genuine.instance, sequence: genuine.sequence,
      sdkVersion: genuine.sdkVersion, vendorAsset: genuine.vendorAsset };
    // Close the actual browser while its owner is still alive, preserving its
    // cleanup receipt and native unavailable transition before service unload.
    const logout = await bridge.logout();
    assert.equal(logout.browser.localCleanupComplete, true);
    assert.equal(logout.result, 1, 'An unauthenticated native logout is not remote-logout success');
    return finish({ mode: input.mode, genuineReady: receipt, cachedReadyReplacement: true,
      cachedReadyRestart: true, readyIpcEvents: engineEvents().length,
      readyCallbacks: engineCallbacks().length, nativeInitNotifications: initNotifications },
    engineEvents()[0]);
  }

  // A normal real engine-unavailable event must reach the native owner once.
  let held = await startHeldMedia(bridge);
  await control('release');
  await bounded(held.result, 'cancelled offline media initialization');
  await delay();
  assert.ok(delivered.length > 0);
  assert.ok(delivered.every(item => item.message.event === 'engine-unavailable'));
  assert.equal(new Set(delivered.map(item => item.message.sequence)).size, delivered.length);
  noMedia();

  // Stop while both the real IPC initialize and the native request are pending.
  // Cancellation must settle before main releases its blocked navigation.
  held = await startHeldMedia(bridge);
  const pendingToken = rejected(bridge.requestNative('getMeetingToken', [], 1001));
  const heldListener = bridge.eventListener;
  const beforeStop = delivered.length;
  native.stopAll();
  assert.equal((await bounded(held.result, 'native-stop media cancellation')).code, 'NATIVE_STOPPED');
  assert.equal((await bounded(pendingToken, 'native-stop request cancellation')).code, 'NATIVE_STOPPED');
  assert.equal(bridge.engineWaiters.size, 0);
  assert.equal(bridge.nativeRequests.size, 0);
  assert.equal(sdk.getNotifyFunc(1001).length, notifyBaseline);
  assert.equal(native.isStarted('meeting_adapter'), false);
  const stoppedError = await rejected(bridge.rawToken());
  assert.equal(stoppedError.code, 'NATIVE_NOT_STARTED');
  nextEngine = deferred();
  const lateEngine = nextEngine.promise;
  await control('release');
  const lateEnvelope = await bounded(lateEngine, 'genuine late IPC engine event');
  await delay();
  assert.equal(delivered.length, beforeStop, 'Stopped native owner must not consume engine state');
  assert.doesNotThrow(() => heldListener({}, lateEnvelope), 'A held listener must obey stop state too');
  assert.equal(native.isStarted('meeting_adapter'), false, 'Late work must not restart the native service');
  assert.equal(notifications, 1, 'The cancelled native request must not dispatch');

  // A bridge constructed after the stop must learn that state without an event.
  const stoppedBridge = bridge;
  bridge = renderer.createBridge(options);
  watch(bridge);
  assert.equal(stoppedBridge.disposed, true);
  assert.equal(bridge.nativeStopped, true);
  singleOwner();
  registrations.push(await bridge.registerBroker());
  assert.equal(native.isStarted('meeting_adapter'), true);
  assert.deepEqual(lifecycle, ['start', 'stop', 'start']);
  noMedia();

  // Replace an owner during an actual in-flight initialization. Delay only the
  // fixture log-path lookup so genuine IPC arrives before registration settles.
  held = await startHeldMedia(bridge);
  const old = bridge;
  const oldListener = old.eventListener;
  logGate = { entered: deferred(), release: deferred() };
  bridge = renderer.createBridge(options);
  watch(bridge);
  assert.equal(bridge.nativeStopped, false, 'A replacement must observe the already-running native service');
  assert.equal((await bounded(held.result, 'replacement media cancellation')).code, 'DISPOSED');
  assert.equal(old.engineWaiters.size, 0);
  singleOwner();
  const registration = bridge.registerBroker();
  await logGate.entered.promise;
  nextEngine = deferred();
  const duringRegistration = nextEngine.promise;
  await control('release');
  const queuedEnvelope = await bounded(duringRegistration, 'engine event during registration');
  await delay();
  assert.equal(bridge.registration, null);
  assert.ok(bridge.registrationEvents.length > 0);
  const beforeRegistration = delivered.length;
  logGate.release.resolve();
  logGate = null;
  registrations.push(await registration);
  assert.ok(delivered.length > beforeRegistration, 'Registration must drain genuine held events');
  assert.equal(bridge.registrationEvents, null);
  assert.ok(delivered.slice(beforeRegistration).every(item => item.bridge === bridge));
  assert.equal(new Set(delivered.slice(beforeRegistration).map(item => item.message.sequence)).size,
    delivered.length - beforeRegistration, 'Buffered engine events must be forwarded once');
  const afterRegistration = delivered.length;
  assert.doesNotThrow(() => oldListener({}, queuedEnvelope));
  assert.equal(delivered.length, afterRegistration);
  noMedia();

  // Retire a registration lookup itself, rather than only its engine waiter.
  const previous = bridge;
  const pendingOwner = renderer.createBridge(options);
  logGate = { entered: deferred(), release: deferred() };
  const retiredRegistration = rejected(pendingOwner.registerBroker());
  await logGate.entered.promise;
  bridge = renderer.createBridge(options);
  watch(bridge);
  logGate.release.resolve();
  logGate = null;
  assert.equal((await bounded(retiredRegistration, 'retired registration')).code, 'DISPOSED');
  assert.equal(pendingOwner.registration, null);
  assert.equal(previous.disposed, true);
  registrations.push(await bridge.registerBroker());
  singleOwner();

  // Owned notification removal must not erase a normal app listener or the
  // replacement's callback, including an old cancellation in the same turn.
  const retiringRequest = rejected(bridge.requestNative('getMeetingToken', [], 1001));
  const requestOwner = bridge;
  bridge = renderer.createBridge(options);
  watch(bridge);
  const currentRequest = bridge.requestNative('getMeetingToken', [], 1001);
  assert.equal((await retiringRequest).code, 'DISPOSED');
  const currentReply = await currentRequest;
  assert.equal(currentReply.notify, 1001);
  assert.equal(requestOwner.nativeRequests.size, 0);
  assert.equal(bridge.nativeRequests.size, 0);
  assert.equal(notifications, 2);
  assert.deepEqual(sdk.getNotifyFunc(1001), [applicationListener]);
  registrations.push(await bridge.registerBroker());
  singleOwner();

  // Exercise the real browser/native logout ordering. No-token native logout is
  // an honest failure, not fabricated remote-logout success.
  const report = await bridge.logout();
  assert.equal(report.browser.localCleanupComplete, true);
  assert.equal(report.browser.disposed, true);
  assert.deepEqual(report.browser.errors.map(({ stage, code }) => ({ stage, code })), [
    { stage: 'credentials-before-leave', code: 'BROWSER_CREDENTIALS_UNAVAILABLE' },
    { stage: 'browser-credentials', code: 'BROWSER_CREDENTIALS_UNAVAILABLE' }
  ], 'Only the deliberately cancelled page inventory may remain unconfirmed');
  assert.deepEqual(report.browser.serverLogout, { status: 'unconfirmed', confirmed: false,
    credentials: 0, revoked: 0, protectedNative: 0, unconfirmed: 0, inventoryConfirmed: false });
  assert.ok(report.native && report.native.result !== 0);
  assert.equal(report.result, 1);
  assert.equal(bridge.registration, null);
  assert.equal(bridge.engineWaiters.size, 0);
  assert.equal(bridge.nativeRequests.size, 0);
  assert.deepEqual(sdk.getNotifyFunc(1001), [applicationListener]);

  // Hold only delivery of the actual invoke result: main has already bound its
  // real owner. This ordering is distinct from delaying the pre-IPC log lookup.
  const bound = deferred(), deliverRegistration = deferred();
  const originalInvoke = ipc.invoke;
  let boundReceipt, delayedOnce = false;
  ipc.invoke = function (channel, request) {
    const actual = originalInvoke.apply(this, arguments);
    if (channel !== CHANNEL || request?.kind !== 'register' || delayedOnce) return actual;
    delayedOnce = true;
    return actual.then(receipt => {
      bound.resolve(receipt);
      return deliverRegistration.promise.then(() => receipt);
    });
  };
  try {
    const registering = rejected(bridge.registerBroker());
    boundReceipt = await bounded(bound.promise, 'main binding before registration delivery');
    assert.equal(boundReceipt.protocol, renderer.PROTOCOL);
    assert.equal(bridge.registration, null);
    const loggingOut = bridge.logout();
    let cleanupFinished = false;
    loggingOut.then(() => { cleanupFinished = true; }, () => { cleanupFinished = true; });
    await delay();
    assert.equal(cleanupFinished, false, 'Cleanup must wait for the genuine bound-owner receipt');
    deliverRegistration.resolve();
    assert.equal((await bounded(registering, 'logout-retired bound registration')).code, 'SESSION_CHANGED');
    const cleanup = await bounded(loggingOut, 'disposal of the late bound owner');
    assert.equal(cleanup.browser?.localCleanupComplete, true);
    assert.ok(!cleanup.errors.some(error => error.code === 'SESSION_CHANGED'),
      'Retired activation is not a failed browser disposal');
    assert.equal(bridge.registration, null, 'The retired receipt must never activate the bridge');
    assert.equal(bridge.registrationReceipt, null, 'Confirmed cleanup must release the receipt');
  } finally {
    deliverRegistration.resolve();
    ipc.invoke = originalInvoke;
  }
  // Pedestal resets serverPort to '' on logout. Omitted/blank serverPort must
  // default to 443 rather than throwing INVALID_SERVER_PORT and aborting logout,
  // while genuinely malformed ports must remain rejected.
  for (const blank of ['', '   ', null, '__omit__']) {
    serverPortOverride = blank;
    const cfg = await bridge.configuration();
    assert.equal(cfg.config.port, 443, 'Blank/omitted serverPort must default to 443');
  }
  serverPortOverride = '8443';
  assert.equal((await bridge.configuration()).config.port, 8443);
  for (const bad of ['0', '65536', 'not-a-port', -1]) {
    serverPortOverride = bad;
    const err = await rejected(bridge.configuration());
    assert.equal(err.code, 'INVALID_SERVER_PORT', 'Malformed serverPort must be rejected: ' + String(bad));
  }
  serverPortOverride = undefined;

  registrations.push(await bridge.registerBroker());
  assert.notEqual(bridge.registration.instance, boundReceipt.instance,
    'The owner bound before logout must be disposed, not reused by the next registration');
  noMedia();
  native.stopAll();
  const stoppedLogout = await bridge.logout();
  assert.equal(stoppedLogout.result, 1, 'Native stop must not turn an unavailable logout into success');
  assert.equal(stoppedLogout.browser.localCleanupComplete, true);
  assert.ok(stoppedLogout.errors.some(error => error.code === 'NATIVE_NOT_STARTED'));
  assert.equal(native.isStarted('meeting_adapter'), false);
  return finish({ mode: input.mode, registrations: registrations.length, nativeNotifications: notifications,
    realEngineEvents: observed.filter(item => item.kind === 'engine').length,
    forwardedEngineEvents: delivered.length, noMediaReadinessFabricated: true,
    stopCancellation: true, registrationBuffering: true, replacementCancellation: true,
    applicationCallbacksPreserved: true, logoutResult: report.result,
    stoppedLogoutResult: stoppedLogout.result, afterBindLogoutDisposal: true,
    emptyServerPortDefaultsTo443: true,
    offlineBrowserCleanup: report.browser }, lateEnvelope);
}

async function closedBrowserRevocationProof(appRoot, origin, fixture) {
  const { MeetingNativeWeb } = require(path.join(appRoot, 'native/meeting_native_web'));
  let nativeTokenReads = 0;
  const bridge = new MeetingNativeWeb({ electron, appRoot, origin,
    getAccessToken: async () => { ++nativeTokenReads; throw new Error('Browser cleanup must not request a native credential'); } });
  const tokens = Object.fromEntries(['confirmed', 'denied', 'native', 'unobserved'].map(name =>
    [name, 'synthetic-' + name + '-' + bridge.instance]));
  for (const [name, token] of Object.entries(tokens))
    fixture.tokens.set(token, { name, status: name === 'denied' ? 401 : 200 });
  let window, destroy, executeJavaScript, closeError;
  let closeAttempts = 0;
  const engineEvents = [], cleanupEvents = [];
  bridge.on('engine', message => engineEvents.push(message));
  bridge.on('event', message => { if (message.event === 'media-session-cleanup') cleanupEvents.push(message.data); });
  try {
    const ready = await bounded(bridge.execute('initialize'), 'genuine credential-cleanup provider initialization', 60000);
    assert.equal(ready.event, 'engine-ready');
    assert.equal(ready.sdkVersion, '1.10.96');
    const state = await bridge.execute('state.get');
    assert.equal(state.ready, true);
    assert.equal(state.joined, false);
    assert.ok(!state.roomJoined);
    window = bridge.window;
    destroy = window.destroy;
    executeJavaScript = window.webContents.executeJavaScript;
    const failedOwner = bridge.mediaOwner, failedPartition = bridge.partition;
    // Main's known-credential inventory is synthetic. The provider store and
    // readiness are untouched; no login, token event, grant or meeting is faked.
    for (const name of ['confirmed', 'denied', 'native']) bridge.browserTokens.add(tokens[name]);
    bridge.protectedNativeTokens.add(tokens.native);
    fixture.isClosed = () => window.isDestroyed();
    fixture.active = true;
    const setMenu = window.setMenu;
    window.destroy = function () {
      ++closeAttempts;
      try { setMenu.call(this, {}); }
      catch (error) {
        closeError = { code: error.code === undefined ? 'SESSION_LOGOUT_FAILED' : String(error.code),
          message: String(error.message || 'The browser session operation failed') };
        throw error;
      }
      throw new Error('Electron unexpectedly accepted an invalid Menu at the close boundary');
    };
    const lost = deferred();
    const onLost = message => {
      if (message.event === 'engine-unavailable' && message.reason === 'document-navigation') {
        bridge.removeListener('engine', onLost);
        lost.resolve(message);
      }
    };
    bridge.on('engine', onLost);
    const navigation = window.loadURL(origin + '/webrtc/?quarantined-credential-proof=1#/login');
    navigation.catch(() => {});
    await bounded(lost.promise, 'real credential-owner document loss');
    await bounded(bridge.serial, 'failed-close receipt settlement');
    await bounded(navigation, 'live quarantined replacement document', 60000);
    assert.equal(window.isDestroyed(), false);
    assert.equal(failedOwner.retired, true);
    assert.equal(bridge.ready, null);
    assert.deepEqual(cleanupEvents[0].errors, [{ stage: 'window-retirement', ...closeError }]);
    assert.equal(cleanupEvents[0].localCleanupComplete, false);
    await assert.rejects(bridge.revokeBrowserCredential(tokens.confirmed), error => error.code === 'MEDIA_OWNER_CHANGED');
    await assert.rejects(bridge.revokeBrowserCredential(tokens.native), error => error.code === 'NATIVE_TOKEN_OWNED');
    await assert.rejects(bridge.revokeBrowserCredential(tokens.unobserved), error => error.code === 'BROWSER_TOKEN_UNOWNED');

    let failedDocumentCalls = 0;
    window.webContents.executeJavaScript = function (...args) {
      ++failedDocumentCalls;
      return executeJavaScript.apply(this, args);
    };
    const rejected = promise => promise.then(() => { throw new Error('Unconfirmed cleanup unexpectedly succeeded'); }, error => error);
    const attemptsBeforeCleanup = closeAttempts;
    const liveError = await bounded(rejected(bridge.execute('session.logout')), 'still-live browser cleanup refusal');
    const liveCleanup = liveError.details;
    assert.equal(closeAttempts, attemptsBeforeCleanup + 1, 'One cleanup must not retry a refused destruction');
    assert.equal(liveCleanup.localCleanup.window, 'failed');
    assert.equal(liveCleanup.localCleanupComplete, false);
    assert.ok(liveCleanup.errors.some(error => error.stage === 'window-cleanup' &&
      error.code === closeError.code && error.message === closeError.message));
    assert.equal(liveCleanup.errors.filter(error => error.stage === 'browser-token-delete' &&
      error.code === 'MEDIA_OWNER_CHANGED').length, 2);
    assert.deepEqual(liveCleanup.serverLogout, { status: 'unconfirmed', confirmed: false,
      credentials: 3, revoked: 0, protectedNative: 1, unconfirmed: 2, inventoryConfirmed: false });
    assert.equal(failedDocumentCalls, 0, 'Cleanup must not read fresh credentials from the quarantined document');
    assert.deepEqual(fixture.requests, [], 'A still-live failed window cannot authorize any token DELETE');
    assert.equal(bridge.mediaOwner, failedOwner);
    assert.deepEqual([...bridge.browserTokens], [tokens.confirmed, tokens.denied, tokens.native],
      'Unclosed cleanup must retain its known credentials for later explicit disposal');

    window.webContents.executeJavaScript = executeJavaScript;
    window.destroy = destroy;
    assert.equal(window.isDestroyed(), false, 'The test must not close the quarantined window ahead of production disposal');
    const closedError = await bounded(rejected(bridge.execute('dispose')), 'production disposal closes before token revocation', 60000);
    assert.equal(window.isDestroyed(), true);
    const closedCleanup = closedError.details;
    assert.equal(closedCleanup.disposed, true);
    assert.equal(closedCleanup.localCleanup.window, 'closed');
    assert.equal(closedCleanup.localCleanupComplete, true);
    for (const key of ['revocationStorage', 'revocationCache', 'revocationAuthCache', 'revocationConnections'])
      assert.equal(closedCleanup.localCleanup[key], 'cleared');
    assert.deepEqual(closedCleanup.serverLogout, { status: 'unconfirmed', confirmed: false,
      credentials: 3, revoked: 1, protectedNative: 1, unconfirmed: 1, inventoryConfirmed: false });
    const tokenFailures = closedCleanup.errors.filter(error => error.stage === 'browser-token-delete');
    assert.equal(tokenFailures.length, 1);
    assert.equal(tokenFailures[0].code, '401');
    assert.equal(tokenFailures[0].status, 401, 'A genuine HTTP 401 must remain unconfirmed, not become logout success');
    assert.deepEqual(fixture.requests, ['confirmed', 'denied'].map(name => ({ credential: name,
      method: 'DELETE', path: '/v1/usg/acs/token', query: [['timeout', 'false']],
      status: name === 'denied' ? 401 : 200, physicallyClosed: true, accessTokenHeader: false, cookie: false })));
    assert.equal(nativeTokenReads, 0);
    assert.notEqual(bridge.mediaOwner, failedOwner);
    assert.notEqual(bridge.partition, failedPartition);
    assert.equal(bridge.mediaOrigin, origin);
    assert.equal(failedOwner.retired, true);
    await assert.rejects(bridge.revokeBrowserCredential(tokens.confirmed), error => error.code === 'MEDIA_OWNER_CHANGED');
    assert.equal(fixture.requests.length, 2, 'Neither a native token nor a stale owner may issue an extra DELETE');
    assert.equal(engineEvents.filter(message => message.event === 'engine-ready').length, 1);
    return { mode: 'closed-browser-revocation', genuineReady: { instance: ready.instance,
      sequence: ready.sequence, sdkVersion: ready.sdkVersion }, liveCleanup, closedCleanup,
      requests: fixture.requests, nativeTokenReads, failedDocumentCredentialReads: failedDocumentCalls,
      nativeTokenProtected: true, staleOwnerRejected: true, productionDisposalConfirmedClosure: true };
  } finally {
    try {
      if (window && !window.isDestroyed()) {
        window.webContents.executeJavaScript = executeJavaScript;
        window.destroy = destroy;
      }
      if (!bridge.disposed) await bounded(bridge.execute('dispose'), 'credential-proof final browser disposal', 60000);
    } finally { fixture.active = false; fixture.isClosed = () => false; }
  }
}

(async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'ia32', 'Use the sealed ia32 Electron runtime');
  const appRoot = option('--app');
  const assets = option('--web-assets');
  for (const [name, digest] of [
    ['main.3ee85ed7.js', 'bdd1fbedaf5e4b51e7c7b27ee3c5ea1de5b82178a3ac7331431784127c858f8a'],
    ['606.616fb575.chunk.js', '13b2cfc34416cb8aeb240b57f8d4498efa5916a9022bb30bf58dce80b854fa83']
  ]) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(assets, 'static/js', name))).digest('hex'), digest, name);
  assert.ok(fs.readFileSync(path.join(assets, 'static/js/12.eb3d2838.chunk.js')).equals(
    fs.readFileSync(path.join(appRoot, 'native/vendor/hrtc-12.eb3d2838.js'))), 'The HRTC bytes must match the sealed image');
  const executable = process.env.WELINK_QA_EXECUTABLE || path.resolve(appRoot, '../../electron');
  assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(executable));
  const distribution = JSON.parse(fs.readFileSync(path.join(appRoot, 'native/distribution-sha256.json'), 'utf8'));
  const executableHash = createHash('sha256');
  for await (const chunk of fs.createReadStream(process.execPath)) executableHash.update(chunk);
  assert.equal(executableHash.digest('hex'), distribution.files.electron.sha256,
    'The verifier must execute with the selected sealed image');
  assert.ok(fs.statSync(path.join(appRoot, 'native/build.json')).isFile());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-meeting-lifetime-'));
  fs.chmodSync(root, 0o700);
  for (const directory of ['runtime', 'logs', 'profile']) fs.mkdirSync(path.join(root, directory), { mode: 0o700 });
  app.setPath('userData', path.join(root, 'runtime'));
  app.setPath('appData', path.join(root, 'profile'));
  app.setAppLogsPath(path.join(root, 'logs'));
  app.on('window-all-closed', () => {});
  const certificate = provision(root);
  const fingerprint = new X509Certificate(certificate.cert).fingerprint256;
  let fixtureResponses = 0;
  const sockets = new Set();
  const revocationFixture = { active: false, tokens: new Map(), requests: [], isClosed: () => false };
  const provider = https.createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
    const url = new URL(request.url, 'https://127.0.0.1');
    const pathname = url.pathname;
    if (revocationFixture.active && request.method === 'DELETE' && pathname === '/v1/usg/acs/token') {
      const credential = revocationFixture.tokens.get(request.headers['x-auth-token']);
      const status = credential ? credential.status : 403;
      revocationFixture.requests.push({ credential: credential?.name || 'unknown', method: request.method,
        path: pathname, query: [...url.searchParams], status, physicallyClosed: revocationFixture.isClosed(),
        accessTokenHeader: request.headers['x-access-token'] !== undefined, cookie: request.headers.cookie !== undefined });
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(status === 200 ? { returnCode: 0 } :
        { error_code: String(status), error_msg: 'Synthetic loopback token rejection' }));
      return;
    }
    if (request.method !== 'GET' || !pathname.startsWith('/webrtc/')) {
      response.writeHead(503); response.end(); return;
    }
    const filename = path.resolve(assets, pathname.slice('/webrtc/'.length) || 'index.html');
    if (!filename.startsWith(assets + path.sep) || !fs.existsSync(filename) ||
        !fs.statSync(filename).isFile() || !fs.realpathSync(filename).startsWith(assets + path.sep)) {
      response.writeHead(404); response.end(); return;
    }
    ++fixtureResponses;
    const extension = path.extname(filename);
    response.setHeader('Content-Type', extension === '.js' ? 'application/javascript' :
      extension === '.css' ? 'text/css' : extension === '.html' ? 'text/html' : 'application/octet-stream');
    fs.createReadStream(filename).pipe(response);
  });
  provider.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const providerOrigin = 'https://127.0.0.1:' + provider.address().port;
  let activeMode;
  const hostCleanupFaults = [];
  let service = null, armed = false, held = null, heldResolve = null, heldPromise = null;
  let mediaFault = null;
  const releaseMediaFault = () => {
    if (!mediaFault) return;
    mediaFault.request.release.resolve();
    mediaFault.cleanup.release.resolve();
    mediaFault.contents.executeJavaScript = mediaFault.executeJavaScript;
    mediaFault.session.clearStorageData = mediaFault.clearStorageData;
    mediaFault.window.destroy = mediaFault.destroy;
    mediaFault = null;
  };
  let blockedNetworkRequests = 0;
  const gateSession = session => {
    session.setCertificateVerifyProc((request, done) => {
      let pinned = false;
      try { pinned = request.hostname === '127.0.0.1' &&
        new X509Certificate(request.certificate.data).fingerprint256 === fingerprint; } catch (_) {}
      done(pinned ? 0 : -3);
    });
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (request, callback) => {
      if (/^https?:|^wss?:/.test(request.url)) {
        const url = new URL(request.url);
        if (['ready', 'renderer-loss', 'document-navigation', 'document-close-failure', 'closed-browser-revocation', 'exit-ready', 'exit-pending-join', 'exit-host-failure'].includes(activeMode) &&
            url.origin === providerOrigin) { callback({}); return; }
        ++blockedNetworkRequests;
        if (armed && url.origin === ORIGIN && request.resourceType === 'mainFrame') {
          armed = false;
          held = callback;
          heldResolve();
        } else callback({ cancel: true });
        return;
      }
      // Load the real trusted service file, but not its account/UI bootstrap.
      callback({ cancel: request.resourceType === 'script' });
    });
  };
  app.on('session-created', gateSession);
  await app.whenReady();
  gateSession(electron.session.defaultSession);
  const disposeBroker = require(path.join(appRoot, 'native/meeting_main.js')).installMeetingMain({ electron, appRoot });
  ipcMain.handle(CONTROL, async (event, request) => {
    assert.ok(service && event.sender === service.webContents && event.senderFrame === event.sender.mainFrame);
    if (['arm-media-loss', 'media-request-held', 'media-cleanup-held', 'lose-media-document',
      'media-owners', 'release-media-request', 'release-media-cleanup', 'failed-media-authority',
      'close-failed-media-document'].includes(request.action)) {
      assert.ok(['renderer-loss', 'document-navigation', 'document-close-failure'].includes(activeMode));
      const windows = () => BrowserWindow.getAllWindows().filter(window => window !== service &&
        window.getParentWindow() === service && window.webContents.getURL().startsWith(providerOrigin + '/'));
      if (request.action === 'arm-media-loss') {
        assert.equal(mediaFault, null);
        const owners = windows();
        assert.equal(owners.length, 1, 'The loss must target only this service owner’s genuine provider');
        const window = owners[0], contents = window.webContents, session = contents.session;
        const pid = contents.getOSProcessId();
        assert.ok(pid > 0);
        assert.ok(BrowserWindow.getAllWindows().every(other => other === window ||
          other.webContents.getOSProcessId() !== pid), 'Never terminate a renderer shared with another window');
        mediaFault = { window, contents, session, id: contents.id, pid,
          request: { entered: deferred(), release: deferred() },
          cleanup: { entered: deferred(), release: deferred() },
          executeJavaScript: contents.executeJavaScript, clearStorageData: session.clearStorageData, destroy: window.destroy };
        const fault = mediaFault;
        if (activeMode === 'document-close-failure') {
          const environment = await contents.executeJavaScript('window.__welinkMeetingHost.captureEnvironment()');
          assert.equal(environment.platform, 'linux', 'The genuine current document must initially have IPC authority');
        }
        contents.executeJavaScript = function (...args) {
          contents.executeJavaScript = fault.executeJavaScript;
          return fault.executeJavaScript.apply(this, args).then(value => {
            fault.request.entered.resolve();
            return fault.request.release.promise.then(() => value);
          });
        };
        session.clearStorageData = function (...args) {
          session.clearStorageData = fault.clearStorageData;
          return fault.clearStorageData.apply(this, args).then(value => {
            fault.cleanup.entered.resolve();
            return fault.cleanup.release.promise.then(() => value);
          });
        };
        if (activeMode === 'document-close-failure') {
          const setMenu = window.setMenu;
          window.destroy = function () {
            // The real Electron API throws; no close, receipt or readiness state
            // is forged. Keep the fault armed until the test explicitly removes it.
            try { setMenu.call(this, {}); }
            catch (error) {
              fault.closeError = { stage: 'window-retirement',
                code: error.code === undefined ? 'SESSION_LOGOUT_FAILED' : String(error.code),
                message: String(error.message || 'The browser session operation failed') };
              throw error;
            }
            throw new Error('Electron unexpectedly accepted an invalid Menu at the close boundary');
          };
        }
        return { id: contents.id, pid };
      }
      if (request.action === 'release-media-request') { mediaFault?.request.release.resolve(); return true; }
      if (request.action === 'release-media-cleanup') { mediaFault?.cleanup.release.resolve(); return true; }
      assert.ok(mediaFault);
      if (request.action === 'media-request-held') return bounded(mediaFault.request.entered.promise, 'actual provider request');
      if (request.action === 'media-cleanup-held') return bounded(mediaFault.cleanup.entered.promise, 'actual browser storage cleanup');
      if (request.action === 'media-owners') return windows().map(window => ({ id: window.webContents.id,
        freshPartition: window.webContents.session !== mediaFault.session }));
      if (request.action === 'failed-media-authority') {
        assert.equal(activeMode, 'document-close-failure');
        assert.equal(mediaFault.window.isDestroyed(), false);
        await bounded(mediaFault.navigation, 'actual live replacement document', 60000);
        const reply = await mediaFault.contents.executeJavaScript(
          'window.__welinkMeetingHost.captureEnvironment().then(() => ({rejected:false}), ' +
          'error => ({rejected:true,message:String(error.message)}))');
        assert.equal(reply.rejected, true, 'The still-live failed window must not retain private IPC authority');
        assert.match(reply.message, /Rejected a foreign or retired meeting bridge sender/);
        return { receiveRejected: true };
      }
      if (request.action === 'close-failed-media-document') {
        assert.equal(activeMode, 'document-close-failure');
        assert.equal(mediaFault.window.isDestroyed(), false);
        const closed = new Promise(resolve => mediaFault.window.once('closed', resolve));
        mediaFault.window.destroy = mediaFault.destroy;
        mediaFault.window.destroy();
        await bounded(closed, 'actual previously refused window closure');
        return { destroyed: mediaFault.window.isDestroyed() };
      }
      const { window, contents, id, pid } = mediaFault;
      assert.equal(window.isDestroyed(), false);
      assert.equal(window.getParentWindow(), service);
      const closed = new Promise(resolve => window.once('closed', resolve));
      let evidence;
      if (activeMode === 'renderer-loss') {
        const gone = new Promise(resolve => contents.once('render-process-gone', (_event, details) => resolve(details.reason)));
        contents.forcefullyCrashRenderer();
        evidence = { reason: await bounded(gone, 'actual provider renderer termination') };
        assert.ok(['crashed', 'killed'].includes(evidence.reason));
      } else {
        const navigated = new Promise(resolve => contents.once('did-start-navigation', (_event, _url, inPage, isMainFrame) =>
          resolve({ inPage, isMainFrame })));
        mediaFault.navigation = window.loadURL(providerOrigin + '/webrtc/?lifetime-document-replacement=1#/login');
        mediaFault.navigation.catch(() => {});
        evidence = await bounded(navigated, 'actual provider main-document navigation');
        assert.equal(evidence.isMainFrame, true);
        assert.equal(evidence.inPage, false);
      }
      if (activeMode === 'document-close-failure') {
        assert.ok(mediaFault.closeError, 'The destroy boundary must have thrown the real injected Electron error');
        assert.equal(window.isDestroyed(), false, 'A rejected close must remain honestly unconfirmed');
        return { id, pid, ...evidence, destroyed: false, closeError: mediaFault.closeError,
          serviceAlive: !service.isDestroyed() && !service.webContents.isCrashed() };
      }
      await bounded(closed, 'failed provider window closure');
      return { id, pid, ...evidence, destroyed: window.isDestroyed(),
        serviceAlive: !service.isDestroyed() && !service.webContents.isCrashed() };
    }
    if (request.action === 'reject-host-menu-cleanup') {
      assert.equal(activeMode, 'exit-host-failure');
      const candidates = BrowserWindow.getAllWindows().filter(window => window !== service &&
        window.webContents.getURL().startsWith(providerOrigin + '/'));
      assert.equal(candidates.length, 1, 'The fault must target only the real isolated provider window');
      const window = candidates[0], setMenu = window.setMenu;
      window.setMenu = function (menu) {
        if (menu !== null) return setMenu.call(this, menu);
        this.setMenu = setMenu;
        // Fault injection at the host API boundary, not a manufactured IPC
        // receipt: Electron itself rejects this non-Menu argument and the
        // production menu owner records the error during closeOwner().
        try { setMenu.call(this, {}); }
        catch (error) {
          hostCleanupFaults.push({ mode: activeMode, error: {
            code: error.code === undefined ? 'HOST_OPERATION_FAILED' : error.code,
            message: String(error.message || error) } });
          throw error;
        }
        throw new Error('Electron unexpectedly accepted an invalid Menu');
      };
      return true;
    }
    if (request.action === 'arm') {
      assert.equal(held, null);
      assert.equal(armed, false);
      armed = true;
      heldPromise = new Promise(resolve => { heldResolve = resolve; });
      return true;
    }
    if (request.action === 'held') return bounded(heldPromise, 'real media request');
    if (request.action === 'release') {
      assert.equal(typeof held, 'function');
      const callback = held;
      held = null;
      callback({ cancel: true });
      return true;
    }
    throw new Error('Unknown verifier control request');
  });
  const results = [];
  const recoveryModes = ['renderer-loss', 'document-navigation', 'document-close-failure'];
  const recoveryOnly = process.argv.includes('--recovery-only') || process.env.WELINK_QA_MEETING_RECOVERY_ONLY === '1';
  const modes = recoveryOnly ? recoveryModes : ['exit-idle', 'exit-cold-join', 'exit-registration', 'exit-ready',
    'exit-pending-join', 'exit-host-failure', 'exit-browser-failure'];
  if (!recoveryOnly && !process.argv.includes('--exit-only') && process.env.WELINK_QA_MEETING_EXIT_ONLY !== '1')
    modes.unshift('cold-unload', 'lifetime', 'ready', ...recoveryModes);
  try {
    for (const mode of modes) {
      activeMode = mode;
      service = new BrowserWindow({ show: false, webPreferences: {
        nodeIntegration: true, contextIsolation: false, sandbox: false,
        partition: 'welink-meeting-lifetime-' + mode + '-' + path.basename(root)
      } });
      const crashes = [];
      service.webContents.on('render-process-gone', (_event, details) => crashes.push(details.reason));
      await service.loadFile(path.join(appRoot, 'plugin/conference/dist/hwmService.html'));
      const input = { app: appRoot, profile: path.join(root, 'profile'), logs: path.join(root, 'logs'), mode,
        origin: ['ready', ...recoveryModes, 'exit-ready', 'exit-pending-join', 'exit-host-failure'].includes(mode) ? providerOrigin : ORIGIN };
      const result = await bounded(service.webContents.executeJavaScript(
        '(' + rendererProof.toString() + ')(' + JSON.stringify(input) + ')'), mode, recoveryModes.includes(mode) ? 150000 : 90000);
      if (mode !== 'cold-unload') {
        const contents = service.webContents;
        const unload = new Promise((resolve, reject) => {
          ipcMain.once(CONTROL + '-unloaded', (event, report) => {
            if (event.sender !== contents) reject(new Error('Foreign unload report'));
            else if (report.error) reject(new Error(report.error));
            else resolve(report);
          });
        });
        service.close();
        result.unload = await bounded(unload, 'actual renderer beforeunload');
      } else service.close();
      assert.deepEqual(crashes, []);
      results.push(result);
      releaseMediaFault();
      service = null;
    }
    if (modes.includes('document-close-failure')) {
      activeMode = 'closed-browser-revocation';
      results.push(await closedBrowserRevocationProof(appRoot, providerOrigin, revocationFixture));
    }
    const cleanup = await bounded(disposeBroker(), 'real main broker cleanup');
    const offlineReceipts = results.map(result => result.offlineBrowserCleanup).filter(Boolean);
    const failedHosts = results.filter(result => result.mode === 'exit-host-failure');
    assert.equal(hostCleanupFaults.length, failedHosts.length, 'Every armed host fault must reach actual cleanup');
    for (const fault of hostCleanupFaults) {
      const result = failedHosts.find(item => item.mode === fault.mode);
      assert.deepEqual(result.cleanup.hostCleanup.errors, [fault.error], 'Tray exit must return the real Electron failure');
      assert.equal(result.cleanup.localCleanupComplete, false);
      assert.notEqual(result.cleanup.result, 0);
    }
    let expectedOfflineFailures = 0, expectedHostFailures = 0;
    assert.ok(cleanup.length > 0, 'The real broker must retain its disposal receipts');
    for (const item of cleanup) {
      assert.ok(!item.error && item.reply, 'Every broker retirement must return a real receipt');
      const { reply } = item;
      if (reply.hostCleanup?.complete === false) {
        assert.ok(failedHosts.some(result => JSON.stringify(result.cleanup.hostCleanup) === JSON.stringify(reply.hostCleanup)),
          'Only the exact injected host cleanup rejection is expected');
        ++expectedHostFailures;
      } else {
        assert.equal(reply.hostCleanup?.complete, true, 'Host cleanup must be confirmed');
        assert.deepEqual(reply.hostCleanup.errors, []);
      }
      const receipt = reply.ok ? reply.data : reply.error?.details;
      assert.equal(receipt?.disposed, true, 'The broker owner must be retired even after an offline inventory failure');
      assert.equal(receipt.localCleanupComplete, true);
      if (reply.ok) {
        assert.deepEqual(receipt.errors, []);
        assert.equal(receipt.serverLogout.inventoryConfirmed, true);
        assert.equal(receipt.serverLogout.status, 'not-required',
          'Fresh synthetic empty owners must not claim a remote logout');
      } else {
        assert.equal(item.reason, 'requested-dispose');
        assert.equal(reply.error.code, 'BROWSER_CREDENTIALS_UNAVAILABLE');
        assert.ok(offlineReceipts.some(expected => JSON.stringify(receipt) === JSON.stringify(expected)),
          'Only exact absent-document receipts asserted in the renderer are expected');
        ++expectedOfflineFailures;
      }
    }
    assert.equal(expectedHostFailures, failedHosts.length);
    assert.equal(expectedOfflineFailures, offlineReceipts.length,
      'Only intentionally retired documents may have an unconfirmed inventory');
    const report = { passed: true, app: appRoot, syntheticProfile: root,
      blockedNetworkRequests, originalProviderResponses: fixtureResponses, fabricatedReadyEvents: 0,
      expectedOfflineFailures, expectedHostFailures, hostCleanupFaults, cleanup, results };
    if (process.env.WELINK_TEST_OUTPUT)
      fs.writeFileSync(path.join(process.env.WELINK_TEST_OUTPUT, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(report));
  } finally {
    if (held) { held({ cancel: true }); held = null; }
    releaseMediaFault();
    ipcMain.removeHandler(CONTROL);
    if (service && !service.isDestroyed()) service.destroy();
    await disposeBroker();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => provider.close(resolve));
  }
})().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
