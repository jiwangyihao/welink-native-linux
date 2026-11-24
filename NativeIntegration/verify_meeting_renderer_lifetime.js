#!/usr/bin/env electron
'use strict';
// Parent-run only. Use --app /sealed/image/resources/app and that image's Electron.
// All profiles are new/private. No account, ticket, native result, engine-ready
// event, broker registration or notification dispatcher is fabricated. --web-assets
// supplies the pinned original provider tree, served only over local pinned TLS.
// A mounted fixture app may require this script with WELINK_QA_APP and
// WELINK_QA_WEB_ASSETS instead of argv. WELINK_QA_MEETING_EXIT_ONLY=1 (or
// --exit-only) selects only the real packaged tray-exit regressions.
// exit-host-failure injects an invalid Menu argument at the real Electron cleanup
// boundary; the genuine broker captures/returns the resulting API rejection.
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

(async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'ia32', 'Use the sealed ia32 Electron runtime');
  const appRoot = option('--app');
  const assets = option('--web-assets');
  for (const [name, digest] of [
    ['main.6297930e.js', '3da44cce0fa14f9a225fcfbb15c84e2ffe5940f2a2d30f396cdb12ee08ccdf6d'],
    ['404.58f826ce.chunk.js', '4561e476301a2519f991974ca1b25e24d6065f0c4c22c54fe14bc8e9d473d47a']
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
  const provider = https.createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
    const pathname = new URL(request.url, 'https://127.0.0.1').pathname;
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
        if (['ready', 'exit-ready', 'exit-pending-join', 'exit-host-failure'].includes(activeMode) &&
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
  ipcMain.handle(CONTROL, (event, request) => {
    assert.ok(service && event.sender === service.webContents && event.senderFrame === event.sender.mainFrame);
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
  const modes = ['exit-idle', 'exit-cold-join', 'exit-registration', 'exit-ready',
    'exit-pending-join', 'exit-host-failure', 'exit-browser-failure'];
  if (!process.argv.includes('--exit-only') && process.env.WELINK_QA_MEETING_EXIT_ONLY !== '1')
    modes.unshift('cold-unload', 'lifetime', 'ready');
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
        origin: ['ready', 'exit-ready', 'exit-pending-join', 'exit-host-failure'].includes(mode) ? providerOrigin : ORIGIN };
      const result = await bounded(service.webContents.executeJavaScript(
        '(' + rendererProof.toString() + ')(' + JSON.stringify(input) + ')'), mode, 90000);
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
      service = null;
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
          'Only exact cancelled-navigation receipts asserted in the renderer are expected');
        ++expectedOfflineFailures;
      }
    }
    assert.equal(expectedHostFailures, failedHosts.length);
    assert.equal(expectedOfflineFailures, offlineReceipts.length,
      'Only intentionally cancelled provider navigation may have an unconfirmed inventory');
    console.log(JSON.stringify({ passed: true, app: appRoot, syntheticProfile: root,
      blockedNetworkRequests, originalProviderResponses: fixtureResponses, fabricatedReadyEvents: 0,
      expectedOfflineFailures, expectedHostFailures, hostCleanupFaults, cleanup, results }));
  } finally {
    if (held) { held({ cancel: true }); held = null; }
    ipcMain.removeHandler(CONTROL);
    if (service && !service.isDestroyed()) service.destroy();
    await disposeBroker();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => provider.close(resolve));
  }
})().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
