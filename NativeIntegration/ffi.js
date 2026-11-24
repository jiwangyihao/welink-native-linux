'use strict';

// Linux SDK libraries have process-lived workers. Keep both the dlopen handle
// and every callback alive, and execute completion pumps on their FFI owner.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { isMainThread } = require('worker_threads');
// Renderer globals are DOM timers; dispatch needs Node Timeout handles.
const { setInterval, clearInterval, setImmediate } = require('timers');

const SDK = Object.freeze({
  common_utils: { file: 'common_utils.dll.so', callbacks: ['common_utils_init'], start: 'common_utils_init', stop: 'common_utils_shutdown' },
  conference_db: { file: 'conference_db.dll.so', callbacks: ['conference_db_init'], start: 'conference_db_init', stop: 'conference_db_shutdown' },
  http_with_rs: { file: 'http_with_rs.dll.so', callbacks: ['http_json_init'], start: 'http_json_init', stop: 'http_json_shutdown', stopResult: 'int', pump: 'HttpWithRsDispatchCallbacks', onePerTurn: true },
  sqlite_plugin: { file: 'sqlite_plugin.dll.so', callbacks: ['tup_sqlite_init'], start: 'tup_sqlite_init', stop: 'tup_sqlite_shutdown', pump: 'pedestal_integrity_dispatch' },
  // Only the service callback escapes its call. Gab SQL callbacks complete
  // synchronously; pinning every per-call pointer would leak one closure/request.
  contact_sqlite_plugin: { file: 'contact_sqlite_plugin.dll.so', callbacks: ['SqliteServiceStartup'], start: 'SqliteServiceStartup', stop: 'ContactPluginShutdown', pump: 'ContactPluginDispatchCallbacks' },
  wk_login: { file: 'wk_login.dll.so', callbacks: ['welink_login_init'], start: 'welink_login_init', stop: 'welink_login_shutdown', pump: 'welink_login_dispatch' },
  wk_security: { file: 'wk_security.dll.so', callbacks: ['welink_security_init'], start: 'welink_security_init', stop: 'welink_security_shutdown', pump: 'welink_security_dispatch' },
  wk_tup_support: { file: 'wk_tup_support.dll.so', callbacks: ['tup_support_init'], start: 'tup_support_init', stop: 'tup_support_shutdown', pump: 'tup_support_dispatch' },
  tup_im_logic_api: { file: 'tup_im_logic_api.so', callbacks: ['RegistCallBack'], start: 'Startup', stop: 'Shutdown', stopResult: 'int', pump: 'ImDispatchCallbacks' },
  tup_offlinefile_logic_api: { file: 'tup_offlinefile_logic_api.so', callbacks: ['OfflineFileInitService'], start: 'OfflineFileInitService', stop: 'OfflineFileShutdown', pump: 'OfflineFileDispatchCallbacks' },
  tup_nativetools_logic_api: { file: 'tup_nativetools_logic_api.so', callbacks: ['NativeToolsInitService'], start: 'NativeToolsInitService', stop: 'NativeToolsShutdown', pump: 'NativeToolsDispatchCallbacks' },
  tup_sqlite_logic_api: { file: 'tup_sqlite_logic_api.so', callbacks: ['InitSqliteService'], start: 'InitSqliteService', stop: 'SqliteServiceShutdown', pump: 'SqliteServiceDispatchCallbacks' },
  db_import_export_tools: { file: 'db_import_export_tools.so', callbacks: ['CallBack'], start: 'CallBack', stop: 'Shutdown', stopResult: 'int', stopOnCall: false, pump: 'ImportExportDispatchCallbacks' },
  meeting_adapter: { file: 'meeting_adapter.dll.so', callbacks: ['set_c2js_callback'], start: 'set_c2js_callback', startResult: 2, stop: 'meeting_native_auth_reset', pump: 'meeting_native_auth_dispatch', wake: 'meeting_native_auth_set_dispatch_callback' }
});

const instances = new Map();
const lifecycle = new EventEmitter();
let unloadInstalled = false;

function identify(filename) {
  if (typeof filename !== 'string') return null;
  let name = path.posix.basename(filename.replace(/\\/g, '/')).toLowerCase();
  name = name.replace(/(?:\.(?:dll|dylib))?\.so$|\.(?:dll|dylib)$/, '');
  if (SDK[name]) return name;
  if (name.startsWith('lib') && SDK[name.slice(3)]) return name.slice(3);
  return null;
}

function failDispatch(state, result) {
  state.failed = true;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  // Do not throw through a C/ffi.Callback stack or log request/token contents.
  setImmediate(() => { throw new Error(`Native ${state.id} callback dispatch failed (${result})`); });
}

function drain(state) {
  state.requested = true;
  if (state.draining || state.failed || !state.started) return;
  state.draining = true;
  try {
    let rounds = 0;
    do {
      state.requested = false;
      const result = state.dispatch();
      if (result < 0) { failDispatch(state, result); return; }
      ++rounds;
    } while (state.requested && !state.descriptor.onePerTurn && rounds < 8 && state.started);
  } finally {
    state.draining = false;
  }
  // A callback may synchronously enqueue another completion/wake. Never lose it
  // merely because the current pump is already inside an application callback.
  if (state.requested && state.started && !state.failed) setImmediate(() => drain(state));
}

function nativeFunction(state, name, result, arguments_) {
  if (!state.privateFunctions.has(name)) {
    state.privateFunctions.set(name, state.runtime.ForeignFunction(state.dl.get(name), result, arguments_));
  }
  return state.privateFunctions.get(name);
}

function startDispatch(state) {
  if (state.descriptor.wake && !state.wake) {
    const wake = state.runtime.Callback('void', [], () => drain(state));
    state.callbacks.add(wake);
    const register = nativeFunction(state, state.descriptor.wake, 'int', ['pointer']);
    const result = register(wake);
    if (result !== 0) throw new Error(`Native ${state.id} owner registration failed (${result})`);
    state.wake = wake;
  }
  state.started = true;
  state.failed = false;
  if (state.dispatch && !state.descriptor.wake && !state.timer) {
    state.timer = setInterval(() => drain(state), 20);
    state.timer.unref();
  }
  lifecycle.emit('start', state.id);
}

function stopDispatch(state) {
  state.started = false;
  state.requested = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  lifecycle.emit('stop', state.id);
}

function ownedCall(state, name, fn, args) {
  if (state.descriptor.callbacks.includes(name)) {
    for (const argument of args) if (Buffer.isBuffer(argument)) state.callbacks.add(argument);
  }
  const result = fn(...args);
  // ffi-napi represents C void as null; void lifecycle calls have no status code.
  if (name === state.descriptor.start &&
      (result === null || result === undefined || result === (state.descriptor.startResult || 0))) startDispatch(state);
  // Import/export Shutdown cancels one job but keeps its registered owner alive.
  if (name === state.descriptor.stop && state.descriptor.stopOnCall !== false &&
      (result === null || result === undefined || result === 0)) stopDispatch(state);
  return result;
}

function ownerFunction(state, name, fn) {
  const call = (...args) => ownedCall(state, name, fn, args);
  // The new SDK does its I/O in native workers. A libuv pool thread must not
  // become the owner of its FFI callback queue, even for an async FFI caller.
  call.async = (...args) => {
    const callback = args.pop();
    if (typeof callback !== 'function') throw new TypeError('FFI async completion callback is required');
    let result;
    try { result = call(...args); }
    catch (error) { setImmediate(() => callback(error)); return; }
    setImmediate(() => callback(null, result));
  };
  return call;
}

function createLibrary(filename, definitions, library, runtime) {
  if (process.platform !== 'linux') return null;
  const id = identify(filename);
  if (!id) return null;
  if (!isMainThread) throw new Error('Native SDKs must be loaded on the service owner thread');
  if (process.arch !== 'ia32') throw new Error('This native SDK build requires the ia32 runtime');
  const descriptor = SDK[id];
  let state = instances.get(id);
  if (!state) {
    const target = fs.realpathSync(path.join(__dirname, 'lib', descriptor.file));
    const flags = runtime.DynamicLibrary.FLAGS;
    const dl = new runtime.DynamicLibrary(target, flags.RTLD_NOW | (flags.RTLD_NODELETE || 0));
    state = { id, descriptor, dl, runtime, callbacks: new Set(), privateFunctions: new Map(),
      started: false, failed: false, draining: false, requested: false, timer: null, wake: null, dispatch: null };
    if (descriptor.pump) state.dispatch = nativeFunction(state, descriptor.pump, 'int', []);
    instances.set(id, state);
  }
  const result = library || {};
  for (const name of Object.keys(definitions || {})) {
    const [returnType, argumentTypes, options = {}] = definitions[name];
    if (options.varargs) throw new Error(`Native SDK ${id}.${name} is not a variadic API`);
    const fn = runtime.ForeignFunction(state.dl.get(name), returnType, argumentTypes, options.abi);
    const owned = ownerFunction(state, name, fn);
    result[name] = options.async ? owned.async : owned;
  }
  if (!unloadInstalled && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('beforeunload', stopAll);
    unloadInstalled = true;
  }
  return result;
}

function requireState(id) {
  const state = instances.get(id);
  if (!state || !state.started) throw new Error(`Native ${id} service has not started`);
  return state;
}

function meetingBindings() {
  const state = requireState('meeting_adapter');
  return Object.freeze({
    deviceId: nativeFunction(state, 'meeting_native_device_id', 'string', []),
    initializeAuth: nativeFunction(state, 'meeting_native_auth_init', 'int', ['string']),
    resetAuth: nativeFunction(state, 'meeting_native_auth_reset', 'void', []),
    capabilities: nativeFunction(state, 'meeting_native_auth_capabilities', 'string', []),
    webState: nativeFunction(state, 'meeting_native_web_state', 'int', ['string'])
  });
}

function imAdapterBindings(request, cancel) {
  const state = requireState('tup_im_logic_api');
  const onRequest = state.runtime.Callback('int', ['string', 'uint32', 'uint32'], request);
  const onCancel = state.runtime.Callback('int', ['uint32', 'uint32'], cancel);
  state.callbacks.add(onRequest);
  state.callbacks.add(onCancel);
  const register = nativeFunction(state, 'WelinkRegisterAdapterHandler', 'int', ['pointer', 'pointer']);
  const result = register(onRequest, onCancel);
  if (result !== 0) throw new Error(`Native IM adapter registration failed (${result})`);
  return Object.freeze({
    complete: nativeFunction(state, 'WelinkCompleteAdapterRequest', 'int', ['uint32', 'uint32', 'string']),
    notify: nativeFunction(state, 'WelinkNotifyAdapter', 'int', ['uint32', 'string']),
    cancel: nativeFunction(state, 'WelinkCancelAdapterRequest', 'int', ['uint32', 'uint32'])
  });
}

function stopAll() {
  for (const state of instances.values()) {
    if (!state.started) continue;
    const stop = nativeFunction(state, state.descriptor.stop, state.descriptor.stopResult || 'void', []);
    const result = stop();
    if (result === null || result === undefined || result === 0) stopDispatch(state);
  }
  // Handles and callbacks deliberately remain pinned. Shutdown is neither a
  // native-worker join nor confirmation of remote logout.
}

module.exports = { createLibrary, meetingBindings, imAdapterBindings, stopAll,
  isStarted(id) { return instances.get(id)?.started === true; },
  onLifecycle(event, listener) { lifecycle.on(event, listener); return () => lifecycle.removeListener(event, listener); } };
