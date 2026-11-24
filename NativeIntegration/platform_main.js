'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { fileURLToPath } = require('url');
const { randomBytes } = require('crypto');
const { createAutostart, failure } = require('./platform_settings');
const { createNativeUpdater } = require('./update_main');
const CHANNEL = 'welink-native-platform-v1';
const installations = new WeakMap();

// Only the canonical pedestal service main frame owns this provider. Window
// identifiers, profile roots and arbitrary method names are never IPC authority.
function installPlatformMain({ electron, appRoot, prepareExit }) {
  if (process.platform !== 'linux') throw failure('ENOTSUP', 'The native platform provider requires Linux');
  if (typeof prepareExit !== 'function') throw failure('EINVAL', 'The real native exit cleanup provider is required');
  const { app, ipcMain, BrowserWindow, shell, globalShortcut, nativeTheme } = electron;
  if (installations.has(ipcMain)) return installations.get(ipcMain);
  const root = fs.realpathSync(appRoot);
  if (root !== fs.realpathSync(app.getAppPath())) throw failure('EACCES', 'Platform app root differs from the running application');
  const trustedPath = path.join(root, 'pedestal', 'index.html');
  if (fs.realpathSync(trustedPath) !== trustedPath) throw failure('EACCES', 'Platform owner document must be canonical');
  const profileRoot = fs.realpathSync(app.getPath('appData'));
  const kmc = path.join(profileRoot, 'kmc');
  fs.mkdirSync(kmc, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(kmc) !== kmc || !fs.statSync(kmc).isDirectory()) {
    throw failure('EACCES', 'The native credential directory must be a canonical directory');
  }
  const paths = Object.freeze({ appRoot: root, profileRoot,
    userData: fs.realpathSync(app.getPath('userData')), logs: fs.realpathSync(app.getPath('logs')),
    execPath: fs.realpathSync(app.getPath('exe')), launcherPath: path.join(root, 'native', 'launch-welink'),
    certificate: path.join(root, 'certificate'),
    kmc: kmc + path.sep, installVerify: path.join(root, 'install-verify') });
  const autostart = createAutostart({ app, appRoot: root, profileRoot, execPath: paths.launcherPath });
  const updater = createNativeUpdater({ electron, appRoot: root });
  let owner = null;
  let disposed = false;

  function launcher() {
    const executable = fs.realpathSync(paths.launcherPath);
    if (executable !== paths.launcherPath || !fs.statSync(executable).isFile())
      throw failure('EACCES', 'The native launcher must be the canonical application-owned file');
    fs.accessSync(executable, fs.constants.X_OK);
    return executable;
  }

  function trusted(contents, frame) {
    try {
      // Electron 22 can dispose the RenderFrameHost before WebContents emits
      // destroyed. Both mainFrame and WebFrameMain accessors are fallible here.
      if (!contents || contents.isDestroyed() || !frame || frame !== contents.mainFrame || frame.parent) return false;
      const url = new URL(frame.url);
      const filename = fileURLToPath(url);
      return url.protocol === 'file:' && !url.host && filename === trustedPath &&
        fs.realpathSync(filename) === trustedPath;
    } catch (_) { return false; }
  }
  function active(registered) {
    if (disposed || owner !== registered) return false;
    if (trusted(registered.contents, registered.frame)) return true;
    revokeOwner();
    return false;
  }
  function assertActive(registered) {
    if (!active(registered)) throw failure('ECANCELED', 'The platform owner was revoked');
  }
  function send(registered, message) {
    if (active(registered)) registered.frame.send(CHANNEL, Object.assign({ owner: registered.token }, message));
  }
  function currentWindow(registered) {
    assertActive(registered);
    const win = BrowserWindow.fromWebContents(registered.contents);
    if (!win || win.isDestroyed() || win !== registered.window) throw failure('ENOENT', 'The platform owner window is unavailable');
    return win;
  }
  function revokeOwner() {
    if (!owner) return;
    const old = owner;
    owner = null;
    for (const accelerator of old.shortcuts.keys()) globalShortcut.unregister(accelerator);
    old.shortcuts.clear();
    if (old.ignoreShortcuts && !old.contents.isDestroyed()) old.contents.setIgnoreMenuShortcuts(false);
    for (const cancel of old.jobs) cancel();
    old.jobs.clear();
    for (const [emitter, name, listener] of old.listeners) emitter.removeListener(name, listener);
    old.listeners.length = 0;
  }
  function listen(registered, emitter, name, listener) {
    emitter.on(name, listener);
    registered.listeners.push([emitter, name, listener]);
  }
  function register(event) {
    const contents = event.sender, frame = event.senderFrame;
    if (disposed || !trusted(contents, frame)) throw failure('EACCES', 'Untrusted platform main frame');
    if (owner) {
      if (owner.contents === contents && owner.frame === frame) return { owner: owner.token, paths };
      if (active(owner)) throw failure('EBUSY', 'The native platform already has an owner');
    }
    const win = BrowserWindow.fromWebContents(contents);
    if (!win || win.isDestroyed()) throw failure('ENOENT', 'A platform owner window is required');
    const registered = { contents, frame, window: win,
      token: randomBytes(32).toString('hex'), shortcuts: new Map(), jobs: new Set(), listeners: [], ignoreShortcuts: false };
    owner = registered;
    const revoke = () => { if (owner === registered) revokeOwner(); };
    listen(registered, event.sender, 'destroyed', revoke);
    listen(registered, event.sender, 'render-process-gone', revoke);
    listen(registered, event.sender, 'did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) revoke();
    });
    for (const name of ['restore', 'minimize', 'focus', 'blur', 'show', 'hide',
      'enter-full-screen', 'leave-full-screen', 'enter-html-full-screen', 'leave-html-full-screen']) {
      listen(registered, win, name, () => {
        if (name === 'focus' && active(registered)) win.flashFrame(false);
        send(registered, { type: 'window-event', name });
      });
    }
    listen(registered, event.sender, 'before-input-event', (inputEvent, input) => {
      if (registered.ignoreShortcuts && input.code === 'F11') inputEvent.preventDefault();
    });
    return { owner: registered.token, paths };
  }
  function authenticate(event, message) {
    if (!owner || !message || message.owner !== owner.token || event.sender !== owner.contents ||
        event.senderFrame !== owner.frame || !active(owner)) {
      throw failure('EACCES', 'Unregistered platform owner');
    }
    return owner;
  }
  function number(value, minimum, maximum) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw failure('EINVAL', 'Invalid window geometry');
    return value;
  }
  function string(value, maximum = 8192) {
    if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0')) {
      throw failure('EINVAL', 'Invalid platform string');
    }
    return value;
  }
  function localPath(value) {
    string(value);
    if (!path.isAbsolute(value)) throw failure('EINVAL', 'A native absolute filesystem path is required');
    return value;
  }
  function externalUrl(value) {
    const url = new URL(string(value));
    // Browser links and mail compose are the observed external actions. File,
    // script, executable and arbitrary registered-handler schemes are not URLs
    // this application may dispatch without a separately mediated provider.
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) {
      throw failure('ENOTSUP', 'This external URL scheme is not supported by the Linux platform');
    }
    return url.href;
  }
  function theme() {
    if (!nativeTheme || typeof nativeTheme.shouldUseDarkColors !== 'boolean') throw failure('ENOTSUP', 'System theme is unavailable');
    // The recovered consumer compares Windows theme resource identifiers only.
    // Linux reports its actual theme, not a fictitious Windows theme identity.
    return 'linux-' + (nativeTheme.shouldUseHighContrastColors ? 'high-contrast-' : '') +
      (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  }
  function capabilities() {
    return { platform: 'linux', nativeProfile: true, shellOpenPath: typeof shell.openPath === 'function',
      globalShortcuts: !!globalShortcut && typeof globalShortcut.register === 'function',
      globalShortcutNote: 'Registration can fail when reserved by another application or unsupported by the compositor.',
      autostart: 'xdg-native-application-only', systemTheme: !!nativeTheme,
      securityScopedBookmarks: false, windowsRegistry: false, windowsAuthenticode: false,
      systemPolicyOverride: false, automaticMediaCapture: false, defaultApplicationChanges: false };
  }
  function syncOperation(event, message) {
    if (message && message.operation === 'register') return register(event);
    const registered = authenticate(event, message);
    const args = message.args || {};
    switch (message.operation) {
      case 'paths': return paths;
      case 'capabilities': return capabilities();
      case 'theme': return theme();
      case 'autostart-get': return autostart.get();
      case 'window-minimize': currentWindow(registered).minimize(); return;
      case 'window-disable-shortcuts':
        registered.ignoreShortcuts = true;
        registered.contents.setIgnoreMenuShortcuts(true);
        return;
      case 'language':
        string(args.code, 16);
        app.setName(string(args.appName, 256));
        currentWindow(registered).setTitle(args.appName);
        return;
      case 'release': revokeOwner(); return;
      default: throw failure('ENOSYS', 'Unsupported synchronous platform operation');
    }
  }
  function crashFile(name) {
    string(name, 255);
    if (path.basename(name) !== name || name === '.' || name === '..') throw failure('EINVAL', 'Invalid crash report name');
    const directory = path.join(paths.logs, 'newCrash', 'reports');
    if (fs.realpathSync(directory) !== directory) throw failure('EACCES', 'Crash directory is not canonical');
    return path.join(directory, name);
  }
  async function crashEntries() {
    const directory = path.join(paths.logs, 'newCrash', 'reports');
    try {
      if (await fs.promises.realpath(directory) !== directory) throw failure('EACCES', 'Crash directory is not canonical');
      const names = await fs.promises.readdir(directory);
      const entries = [];
      for (const name of names) {
        const filename = crashFile(name), stat = await fs.promises.lstat(filename);
        if (stat.isFile() && !stat.isSymbolicLink()) entries.push({ name, filename, mtime: stat.mtimeMs });
      }
      return entries.sort((a, b) => b.mtime - a.mtime);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  function tcpProbe(registered, host) {
    return new Promise(resolve => {
      const started = Date.now();
      const socket = net.connect({ host, port: 443 });
      let done = false;
      const cancel = () => finish('ECANCELED');
      function finish(error) {
        if (done) return;
        done = true;
        registered.jobs.delete(cancel);
        socket.destroy();
        resolve({ host, port: 443, connected: !error, elapsedMs: Date.now() - started, error: error || null });
      }
      registered.jobs.add(cancel);
      socket.setTimeout(5000, () => finish('ETIMEDOUT'));
      socket.once('connect', () => finish());
      socket.once('error', error => finish(error.code || 'EIO'));
    });
  }
  function checkNativeUpdate(registered, args) {
    if (typeof args.manual !== 'boolean' || typeof args.locale !== 'string' || args.locale.length > 32) {
      throw failure('EINVAL', 'Invalid native update request');
    }
    function check() {
      assertActive(registered);
      if (!registered.updateCheck) {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        registered.jobs.add(cancel);
        const pending = updater.check({ session: registered.contents.session, signal: controller.signal });
        registered.updateCheck = pending.finally(() => {
          registered.jobs.delete(cancel);
          registered.updateCheck = null;
        });
      }
      return registered.updateCheck;
    }
    if (!args.manual) return check();
    if (!registered.updateDialog) {
      registered.updateDialog = updater.present({ check, window: currentWindow(registered),
        assertActive: () => assertActive(registered), locale: args.locale }).finally(() => {
        registered.updateDialog = null;
      });
    }
    return registered.updateDialog;
  }
  async function operation(event, message) {
    const registered = authenticate(event, message);
    const args = message.args || {};
    let result;
    switch (message.operation) {
      case 'update-check': result = await checkNativeUpdate(registered, args); break;
      case 'autostart-set':
        if (args.exePath !== paths.execPath) throw failure('EACCES', 'Autostart can only target this native executable');
        if (args.enabled === true) launcher();
        result = autostart.set(args.enabled);
        break;
      case 'open-url': await shell.openExternal(externalUrl(args.url), { activate: args.activate !== false }); break;
      case 'open-path': {
        const filename = localPath(args.path);
        await fs.promises.access(filename, fs.constants.F_OK);
        assertActive(registered);
        const error = await shell.openPath(filename);
        if (error) throw failure('EIO', error);
        break;
      }
      case 'show-item': {
        const filename = localPath(args.path);
        await fs.promises.access(filename, fs.constants.F_OK);
        assertActive(registered);
        // Electron supplies no completion status for showItemInFolder. Do not
        // turn dispatch into a fabricated boolean indicating successful opening.
        shell.showItemInFolder(filename);
        break;
      }
      case 'window-show': {
        const win = currentWindow(registered);
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        break;
      }
      case 'window-hide': currentWindow(registered).hide(); break;
      case 'window-size': {
        const win = currentWindow(registered);
        const width = number(args.width, 1, 32768), height = number(args.height, 1, 32768);
        if (!args.isRestore && win.isMaximized()) win.restore();
        win.setSize(width, height);
        break;
      }
      case 'window-minimum':
        currentWindow(registered).setMinimumSize(number(args.width, 1, 32768), number(args.height, 1, 32768));
        break;
      case 'window-resize': {
        const win = currentWindow(registered);
        const width = number(args.width, 1, 32768), height = number(args.height, 1, 32768);
        const positioned = args.x !== undefined || args.y !== undefined;
        if (positioned) { number(args.x, -32768, 32768); number(args.y, -32768, 32768); }
        const opacity = win.getOpacity();
        try {
          if (args.isOpacity) win.setOpacity(0);
          if (!args.isRestore && win.isMaximized()) win.restore();
          win.setSize(width, height);
          if (positioned) win.setPosition(args.x, args.y); else win.center();
        } finally { if (args.isOpacity && !win.isDestroyed()) win.setOpacity(opacity); }
        break;
      }
      case 'shortcut-register': {
        const accelerator = string(args.accelerator, 256), id = string(args.id, 128);
        if (registered.shortcuts.has(accelerator) || globalShortcut.isRegistered(accelerator)) return false;
        result = globalShortcut.register(accelerator, () => send(registered, { type: 'shortcut', id }));
        if (result) registered.shortcuts.set(accelerator, id);
        break;
      }
      case 'shortcut-is-registered':
        result = globalShortcut.isRegistered(string(args.accelerator, 256));
        break;
      case 'shortcut-unregister': {
        const accelerator = string(args.accelerator, 256);
        if (registered.shortcuts.has(accelerator)) {
          globalShortcut.unregister(accelerator);
          registered.shortcuts.delete(accelerator);
        }
        break;
      }
      case 'shortcut-unregister-all':
        for (const accelerator of registered.shortcuts.keys()) globalShortcut.unregister(accelerator);
        registered.shortcuts.clear();
        break;
      case 'window-proxy': {
        const proxy = args.proxy || {};
        const rules = typeof proxy.proxyRules === 'string' ? proxy.proxyRules : '';
        if (rules.length > 8192 || /[\r\n\0]/.test(rules)) throw failure('EINVAL', 'Invalid proxy rules');
        const bypass = typeof proxy.proxyBypassRules === 'string' ? proxy.proxyBypassRules : '';
        if (bypass.length > 8192 || /[\r\n\0]/.test(bypass)) throw failure('EINVAL', 'Invalid proxy bypass rules');
        const session = registered.contents.session;
        await session.setProxy(rules ? { mode: 'fixed_servers', proxyRules: rules, proxyBypassRules: bypass } : { mode: 'system' });
        assertActive(registered);
        await session.closeAllConnections();
        break;
      }
      case 'crash-mtime': result = (await fs.promises.lstat(crashFile(args.name))).mtimeMs; break;
      case 'crash-prune': {
        const entries = await crashEntries();
        result = entries.length > 10;
        for (const entry of entries.slice(10)) {
          assertActive(registered);
          await fs.promises.unlink(entry.filename);
        }
        break;
      }
      case 'diagnostics-network':
        result = await Promise.all(['api.welink.huaweicloud.com', 'im.welink.huaweicloud.com',
          'space.welink.huaweicloud.com', 'meeting.huaweicloud.com'].map(host => tcpProbe(registered, host)));
        break;
      case 'process-relaunch':
        app.relaunch({ execPath: launcher(), args: [root] });
        break;
      case 'process-prepare-exit':
        // Cleanup deliberately revokes this owner; return its actual report
        // rather than applying the ordinary post-operation liveness check.
        return await prepareExit();
      case 'security-scoped-resource':
        throw failure('ENOTSUP', 'macOS security-scoped bookmarks do not grant Linux filesystem permissions');
      default: throw failure('ENOSYS', 'Unsupported platform operation');
    }
    assertActive(registered);
    return result;
  }
  function errorReply(error) {
    return { ok: false, error: { code: error.code || 'EIO', message: error.message || String(error) } };
  }
  const onSync = (event, message) => {
    try { event.returnValue = { ok: true, value: syncOperation(event, message) }; }
    catch (error) { event.returnValue = errorReply(error); }
  };
  ipcMain.on(CHANNEL, onSync);
  ipcMain.handle(CHANNEL, async (event, message) => {
    try { return { ok: true, value: await operation(event, message) }; }
    catch (error) { return errorReply(error); }
  });
  const onTheme = () => { if (owner) send(owner, { type: 'theme', value: theme() }); };
  if (nativeTheme) nativeTheme.on('updated', onTheme);
  function dispose() {
    if (disposed) return;
    revokeOwner();
    disposed = true;
    ipcMain.removeListener(CHANNEL, onSync);
    ipcMain.removeHandler(CHANNEL);
    if (nativeTheme) nativeTheme.removeListener('updated', onTheme);
    installations.delete(ipcMain);
  }
  const api = Object.freeze({ dispose, revokeOwner });
  installations.set(ipcMain, api);
  return api;
}

module.exports = { installPlatformMain };
