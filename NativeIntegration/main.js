'use strict';

const fs = require('fs');
const path = require('path');
const electron = require('electron');
const { installMeetingMain } = require('./meeting_main');
const { installImAdapterMain } = require('./im_adapter_main');
const { installPlatformMain } = require('./platform_main');
const { installWindowOpacity, createMainIpc } = require('./desktop_main');

let installation;

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.statSync(directory).isDirectory()) throw new Error('The native profile path is not a directory');
  return directory;
}

function install() {
  if (installation) return installation;
  if (process.platform !== 'linux' || process.arch !== 'ia32' || process.type !== 'browser')
    throw new Error('This native HIT APP entry requires the Linux ia32 Electron main process');
  const { app } = electron;
  const appRoot = fs.realpathSync(app.getAppPath());
  const override = process.env.WELINK_NATIVE_PROFILE_DIR;
  if (override && !path.isAbsolute(override)) throw new Error('WELINK_NATIVE_PROFILE_DIR must be absolute');
  // This is a new native profile. No Wine registry, account directory or key
  // store is imported, rewritten, or used as an authentication fallback.
  const profileRoot = privateDirectory(override || path.join(app.getPath('appData'), 'cn.edu.hit.welink.native'));
  const userData = privateDirectory(path.join(profileRoot, 'runtime'));
  const logs = privateDirectory(path.join(profileRoot, 'logs'));
  app.setPath('appData', profileRoot);
  app.setPath('userData', userData);
  app.setAppLogsPath(logs);

  const platform = installPlatformMain({ electron, appRoot, prepareExit: dispose });
  const disposeMeeting = installMeetingMain({ electron, appRoot });
  const imAdapter = installImAdapterMain({ electron, appRoot });
  let cleanup;
  let allowQuit = false;
  let quitPending = false;

  function dispose() {
    if (!cleanup) {
      cleanup = Promise.resolve().then(async () => {
        let revokeFailed = false;
        try { imAdapter.revokeOwner(); }
        catch (_) { revokeFailed = true; }
        let platformRevokeFailed = false;
        try { platform.revokeOwner(); }
        catch (_) { platformRevokeFailed = true; }
        let reports;
        try {
          reports = await disposeMeeting();
        } finally {
          platform.dispose();
        }
        if (revokeFailed) reports.push({ reason: 'im-adapter-revoke', error: { code: 'IM_ADAPTER_CLEANUP_FAILED' } });
        if (platformRevokeFailed) reports.push({ reason: 'platform-revoke', error: { code: 'PLATFORM_CLEANUP_FAILED' } });
        for (const report of reports) {
          if (report.error || !report.reply || !report.reply.ok ||
              (report.reply.data && report.reply.data.localCleanupComplete === false))
            console.warn('Native client cleanup was incomplete; inspect the actual cleanup reports.');
        }
        return reports;
      });
    }
    return cleanup;
  }

  // Confirmed vendor exit already awaits process-prepare-exit while the service
  // renderer still owns native cleanup. A speculative app.quit() can instead be
  // cancelled by the vendor window's close handler. Do not revoke owners or
  // remove IPC brokers until every window has accepted that fallback exit.
  app.on('will-quit', event => {
    if (allowQuit) return;
    event.preventDefault();
    if (quitPending) return;
    quitPending = true;
    dispose().catch(() => {
      console.warn('Native browser cleanup did not return a completion report.');
    }).finally(() => {
      allowQuit = true;
      app.quit();
    });
  });

  installation = Object.freeze({ appRoot, profileRoot, dispose });
  return installation;
}

function start() {
  const { appRoot } = install();
  const mainFile = path.join(appRoot, 'main.jsc');
  const iconDirectory = path.join(appRoot, 'pedestal/resources/icon');
  const windowsIcon = path.join(iconDirectory, 'app.ico');
  const linuxIcon = path.join(iconDirectory, 'app.png');
  // The vendor main bundle chooses ICO for every non-macOS host. Select the
  // real Linux resource for that bundle without changing Node's shared path API.
  const mainPaths = Object.freeze({
    ...path,
    join(...parts) {
      const result = path.join(...parts);
      return result === windowsIcon ? linuxIcon : result;
    }
  });
  let activeResizeWindow = null;
  const resizeTimers = new WeakMap();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  global.setTimeout = function(callback, delay, ...args) {
    const win = activeResizeWindow;
    if (!win) return originalSetTimeout.call(this, callback, delay, ...args);
    let set = resizeTimers.get(win);
    if (!set) {
      set = new Set();
      resizeTimers.set(win, set);
      win.once('closed', () => {
        for (const handle of set) originalClearTimeout(handle);
        set.clear();
      });
    }
    const handle = originalSetTimeout.call(this, (...cbArgs) => {
      set.delete(handle);
      if (!win.isDestroyed()) callback(...cbArgs);
    }, delay, ...args);
    set.add(handle);
    return handle;
  };
  global.clearTimeout = function(handle) {
    if (activeResizeWindow) {
      const set = resizeTimers.get(activeResizeWindow);
      if (set) set.delete(handle);
    }
    return originalClearTimeout.call(this, handle);
  };
  function guardMainBrowserWindow(win) {
    const wrappedListeners = new WeakMap();
    for (const method of ['on', 'addListener']) {
      const orig = win[method].bind(win);
      win[method] = (event, listener) => {
        if (event === 'resize' && typeof listener === 'function') {
          let wrapped = wrappedListeners.get(listener);
          if (!wrapped) {
            wrapped = function(...args) {
              const previous = activeResizeWindow;
              activeResizeWindow = win;
              try { return listener.apply(this, args); }
              finally { activeResizeWindow = previous; }
            };
            wrappedListeners.set(listener, wrapped);
          }
          return orig(event, wrapped);
        }
        return orig(event, listener);
      };
    }
    for (const method of ['off', 'removeListener']) {
      const orig = win[method].bind(win);
      win[method] = (event, listener) => {
        if (event === 'resize' && typeof listener === 'function' && wrappedListeners.has(listener)) {
          return orig(event, wrappedListeners.get(listener));
        }
        return orig(event, listener);
      };
    }
    return installWindowOpacity(win, electron.app);
  }
  function summarizeFrameCreated(details) {
    if (!details || typeof details !== 'object' || !details.frame || typeof details.frame !== 'object') return details;
    const f = details.frame;
    return {
      frame: {
        frameTreeNodeId: f.frameTreeNodeId,
        routingId: f.routingId,
        processId: f.processId,
        url: typeof f.url === 'string' ? f.url.split('?')[0] : '',
        name: typeof f.name === 'string' ? f.name : ''
      }
    };
  }
  function guardMainBrowserView(view) {
    const wc = view && view.webContents;
    if (!wc) return view;
    const origOn = wc.on.bind(wc);
    wc.on = (event, listener) => {
      if (event === 'frame-created' && typeof listener === 'function') {
        return origOn(event, (ev, details) => listener.call(wc, ev, summarizeFrameCreated(details)));
      }
      return origOn(event, listener);
    };
    return view;
  }
  const MainBrowserWindow = new Proxy(electron.BrowserWindow, {
    construct(Target, args) { return guardMainBrowserWindow(Reflect.construct(Target, args, Target)); }
  });
  const MainBrowserView = new Proxy(electron.BrowserView, {
    construct(Target, args) { return guardMainBrowserView(Reflect.construct(Target, args, Target)); }
  });
  const mainIpc = createMainIpc({ electron, appRoot, startupArgs: process.argv });
  // The vendor's wildcard import copies Electron's accessor descriptors. A
  // Proxy.get override is lost when those original getters are copied. Keep a
  // module-local namespace with adapted own descriptors; unrelated exports
  // retain their original lazy getters without changing the shared Electron API.
  const mainElectron = Object.create(Object.getPrototypeOf(electron), {
    ...Object.getOwnPropertyDescriptors(electron),
    BrowserWindow: { enumerable: true, value: MainBrowserWindow },
    BrowserView: { enumerable: true, value: MainBrowserView },
    ipcMain: { enumerable: true, value: mainIpc }
  });
  const Module = require('module');
  // Bytenode's require delegates to its own fileModule.require. Keep adapters
  // there, including lazy imports, instead of replacing Node's shared _load.
  let vendorMain = Module._cache[mainFile];
  if (!vendorMain) {
    vendorMain = new Module(mainFile, module);
    vendorMain.filename = mainFile;
    vendorMain.paths = Module._nodeModulePaths(appRoot);
    vendorMain.require = function(request) {
      if (request === 'path') return mainPaths;
      if (request === 'electron') return mainElectron;
      return Module.prototype.require.call(this, request);
    };
    Module._cache[mainFile] = vendorMain;
    try {
      vendorMain.load(mainFile);
    } catch (error) {
      delete Module._cache[mainFile];
      throw error;
    }
  }
  // The vendor bootstrap appends these process-wide switches before app.ready.
  // In particular, no-sandbox prevents the sandboxed SSO view from using the
  // shared-memory broker. Let Electron apply each renderer's own preferences.
  for (const flag of ['no-sandbox', 'disable-gpu-sandbox', 'ignore-certificate-errors']) {
    electron.app.commandLine.removeSwitch(flag);
  }
  return vendorMain.exports;
}

module.exports = { start };
