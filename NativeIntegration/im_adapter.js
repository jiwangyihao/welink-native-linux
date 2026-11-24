'use strict';

const { isMainThread } = require('worker_threads');
const { createForwarder, adapterError } = require('./im_adapter_forward');
const { createFileMigration } = require('./im_adapter_files');
const CHANNEL = 'welink-native-im-adapter-v1';
const installations = new WeakMap();
const descriptions = [null, 'MsgForwardOneByOne', 'MsgCombineAndForward',
  'CheckIsExceedSendingLimit', 'migrationFileStartup', 'migrationFileShutdown', 'OpenSaveFileDialog'];

// Install before CImManager.LoadLibrary calls Startup. ffi.js owns the pinned
// WelinkRegisterAdapterHandler callbacks; no DLL is unloaded at session stop.
function installImAdapter({ ffiRuntime, Pedestal, appRoot }) {
  if (process.platform !== 'linux') return null;
  if (!isMainThread) throw new Error('The IM adapter must run on the FFI owner thread');
  if (installations.has(ffiRuntime)) return installations.get(ffiRuntime);
  if (!Pedestal || !appRoot || typeof ffiRuntime.onLifecycle !== 'function') {
    throw new TypeError('IM adapter requires the service renderer and native runtime');
  }
  const { ipcRenderer } = require('electron');
  const sessions = new Map();
  const retired = new Set();
  const pinnedBindings = [];
  let binding = null;
  let owner = null;
  let registration = null;
  let webpack = null;

  function modules() {
    if (webpack) return webpack;
    const chunks = globalThis.window && window.webpackJsonpIMWindow;
    if (!chunks || chunks.push === Array.prototype.push) throw adapterError('IM service modules are not loaded');
    chunks.push([['welink-native-im-adapter-v1'], {}, runtime => { webpack = runtime; }]);
    if (!webpack) throw adapterError('IM service webpack runtime is unavailable');
    return webpack;
  }
  function account() {
    const registry = globalThis.window && window.instance;
    const store = registry && registry.getInstanceNoError('imStore');
    return store && store.getState().account.uuid || '';
  }
  function current(context) {
    return !context.signal.aborted && !context.session.stopped &&
      (!context.account || account() === context.account);
  }
  function check(context) {
    if (!current(context)) {
      context.controller.abort();
      throw adapterError('IM adapter activity cancelled', -1, 'ECANCELED');
    }
  }
  function waitFor(context, promise) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => finish(reject, adapterError('IM adapter activity cancelled', -1, 'ECANCELED'));
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener('abort', abort);
        callback(value);
      }
      Promise.resolve(promise).then(value => {
        try { check(context); finish(resolve, value); }
        catch (error) { finish(reject, error); }
      }, error => finish(reject, error));
      if (context.signal.aborted) abort();
      else context.signal.addEventListener('abort', abort, { once: true });
    });
  }
  function envelope(context, result, param, description) {
    return { rsp: context.request.cmd, sno: context.request.sno, result,
      description: typeof context.request.description === 'string' ? context.request.description : description,
      param };
  }
  function complete(context, result, param, description = descriptions[context.operation]) {
    if (context.completed || !current(context)) return false;
    const text = JSON.stringify(envelope(context, result, param, description));
    const status = context.session.binding.complete(context.id, context.epoch, text);
    context.completed = true;
    if (status !== 0 && status !== 125) console.error('Native IM adapter completion rejected:', status);
    return status === 0;
  }
  function notify(context, message) {
    if (!current(context)) return;
    const status = context.session.binding.notify(context.epoch, JSON.stringify(message));
    if (status !== 0 && status !== 125) console.error('Native IM adapter notification rejected:', status);
  }
  function cancel(id, epoch) {
    try {
      const session = sessions.get(epoch);
      if (!id) retired.add(epoch);
      if (!session) return 0;
      if (!id) session.stopped = true;
      for (const context of session.activities.values()) {
        if (!id || context.id === id) context.controller.abort();
      }
      if (owner) ipcRenderer.send(CHANNEL, { operation: 'cancel', owner, id, epoch });
      if (!id) sessions.delete(epoch);
      return 0;
    } catch (error) {
      console.error('Native IM adapter cancellation failed:', error.message);
      return 5;
    }
  }
  async function registerOwner(context) {
    if (!registration) {
      registration = ipcRenderer.invoke(CHANNEL, { operation: 'register' }).then(value => {
        if (!value || typeof value.owner !== 'string') throw adapterError('IM main-process owner registration failed');
        owner = value.owner;
        return owner;
      });
      registration.catch(() => { registration = null; });
    }
    const value = await registration;
    check(context);
    return value;
  }
  async function saveDialog(context) {
    const param = context.request.param;
    if (!param || typeof param !== 'object' || Array.isArray(param)) throw adapterError('param is not correct!');
    if (typeof param.fileName !== 'string' || !param.fileName) throw adapterError('fileName is empty!');
    const ownerToken = await registerOwner(context);
    check(context);
    const result = await ipcRenderer.invoke(CHANNEL, { operation: 'save-dialog', owner: ownerToken,
      id: context.id, epoch: context.epoch, param: { fileName: param.fileName,
        fileType: param.fileType, suffix: param.suffix } });
    check(context);
    if (!result || result.error) throw adapterError(result && result.error || 'Save dialog failed');
    // OpenSaveFileDialog puts its payload under param before the common reply
    // builder wraps it again. Preserve this intentional double-param envelope.
    complete(context, 0, { param: { filePath: result.filePath, isExceed: result.isExceed } });
  }
  const forwarding = createForwarder({ modules, check, complete, notify, ffiRuntime });
  const migration = createFileMigration({ modules, check, complete, notify });
  async function run(context) {
    try {
      check(context);
      switch (context.operation) {
        case 1: case 2: await forwarding.forward(context); break;
        case 3: await forwarding.rateLimit(context); break;
        case 4: await migration.start(context); break;
        case 5: await migration.stop(context); break;
        case 6: await saveDialog(context); break;
      }
    } catch (error) {
      if (current(context)) complete(context, Number.isInteger(error.result) ? error.result : -1,
        { reason: error.message || 'IM adapter operation failed' });
    } finally {
      context.session.activities.delete(context.id);
    }
  }
  function request(json, id, epoch) {
    try {
      if (!binding || retired.has(epoch) || !id) return 125;
      const parsed = JSON.parse(json);
      if (!parsed || !Number.isInteger(parsed.cmd) || !Number.isInteger(parsed.sno)) return 22;
      const operation = parsed.cmd & 0xffff;
      // The original command table has entries 1..6. Zero, 7, and unknown
      // commands have no handler; never manufacture a successful mutation.
      if (operation < 1 || operation > 6) return 38;
      let session = sessions.get(epoch);
      if (!session) {
        session = { binding, stopped: false, activities: new Map() };
        sessions.set(epoch, session);
      }
      if (session.stopped || session.activities.has(id)) return 16;
      const controller = new AbortController();
      const context = { id, epoch, operation, request: parsed, session, controller,
        signal: controller.signal, account: account(), completed: false };
      context.wait = promise => waitFor(context, promise);
      session.activities.set(id, context);
      // Do not re-enter native completion from inside its request callback.
      setImmediate(() => { void run(context); });
      return 0;
    } catch (error) {
      console.error('Native IM adapter request rejected:', error.message);
      return 22;
    }
  }
  ffiRuntime.onLifecycle('start', name => {
    if (name !== 'tup_im_logic_api') return;
    binding = ffiRuntime.imAdapterBindings(request, cancel);
    pinnedBindings.push(binding);
  });
  ffiRuntime.onLifecycle('stop', name => {
    if (name !== 'tup_im_logic_api') return;
    for (const epoch of sessions.keys()) cancel(0, epoch);
    binding = null;
  });
  const api = Object.freeze({ cancelAll() {
    for (const epoch of sessions.keys()) cancel(0, epoch);
  } });
  installations.set(ffiRuntime, api);
  if (globalThis.window) window.addEventListener('beforeunload', api.cancelAll);
  return api;
}

module.exports = { installImAdapter };
