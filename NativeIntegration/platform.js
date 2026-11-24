'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { failure } = require('./platform_settings');
const CHANNEL = 'welink-native-platform-v1';
let connection;
let ipc;
let installed = false;
let consoleEvents;
let consoleEventsInstalled = false;
let nextShortcut = 0;
const shortcuts = new Map();
const shortcutIds = new Map();
let catalog;
let languageInitialization;
let languageInitializationCode;
let exitPreparation;

function renderer() {
  if (process.platform !== 'linux' || process.type !== 'renderer' || typeof window === 'undefined') {
    throw failure('ENOTSUP', 'This module requires the native Linux application renderer');
  }
  return window;
}
function unpack(reply) {
  if (!reply || reply.ok !== true) {
    throw failure(reply && reply.error && reply.error.code || 'EIO',
      reply && reply.error && reply.error.message || 'The native platform provider did not reply');
  }
  return reply.value;
}
function connect() {
  if (connection) return connection;
  const win = renderer();
  ipc = require('electron').ipcRenderer;
  connection = unpack(ipc.sendSync(CHANNEL, { operation: 'register' }));
  if (!connection || typeof connection.owner !== 'string' || !connection.paths) {
    connection = null;
    throw failure('EPROTO', 'Invalid platform registration');
  }
  ipc.on(CHANNEL, onMessage);
  win.addEventListener('unload', release, { once: true });
  return connection;
}
function sync(operation, args = {}) {
  const registered = connect();
  return unpack(ipc.sendSync(CHANNEL, { owner: registered.owner, operation, args }));
}
async function request(operation, args = {}) {
  const registered = connect();
  const result = unpack(await ipc.invoke(CHANNEL, { owner: registered.owner, operation, args }));
  if (connection !== registered) throw failure('ECANCELED', 'The platform renderer was released');
  return result;
}
function report(error) {
  const win = renderer();
  console.error('Native Linux platform:', error.code || 'EIO', error.message);
  win.dispatchEvent(new win.CustomEvent('native-platform-error', { detail: { code: error.code || 'EIO', message: error.message } }));
}
function dispatch(name) {
  const win = renderer();
  win.dispatchEvent(new win.Event(name));
}
function onMessage(_event, message) {
  if (!connection || !message || message.owner !== connection.owner) return;
  if (message.type === 'shortcut') {
    const callback = shortcutIds.get(message.id);
    if (callback) {
      try { Promise.resolve(callback()).catch(report); }
      catch (error) { report(error); }
    }
  } else if (message.type === 'native-update-exit') {
    Promise.resolve(renderer().appService.exitApp({ entry: 'native-update-startup-rollback' })).catch(report);
  } else if (message.type === 'theme') {
    dispatch('systemThemeChange');
  } else if (message.type === 'window-event') {
    const win = renderer();
    const events = { focus: 'winFocus', blur: 'winBlur', show: 'winShow', hide: 'winHide' };
    if (events[message.name]) dispatch(events[message.name]);
    if (message.name === 'restore' && typeof win.setLoginPagePosition === 'function') {
      win.setLoginPagePosition('restore', false, true);
    }
  }
}
function release() {
  if (!connection) return;
  const registered = connection;
  connection = null;
  ipc.removeListener(CHANNEL, onMessage);
  shortcuts.clear();
  shortcutIds.clear();
  // Synchronous ownership release cannot leave this renderer's shortcuts behind
  // after teardown. Navigation/crash also revokes them in the main process.
  unpack(ipc.sendSync(CHANNEL, { owner: registered.owner, operation: 'release' }));
}
function nativePaths() { return connect().paths; }
function languageCatalog() {
  if (!catalog) catalog = require(path.join(nativePaths().appRoot, 'pedestal', 'resources', 'language', 'i18n.js'));
  return catalog;
}
function getExistLangs() {
  const all = languageCatalog().getExistLangs();
  const available = {};
  const directory = path.join(nativePaths().appRoot, 'pedestal', 'resources', 'language');
  for (const [name, code] of Object.entries(all)) {
    try {
      if (/^\d+$/.test(String(code)) && fs.statSync(path.join(directory, String(code))).isDirectory()) available[name] = code;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return available;
}
function isLanguage(code) { return Object.values(getExistLangs()).some(value => String(value) === String(code)); }
async function applyLanguage(code, persist) {
  const win = renderer();
  const language = languageCatalog().getLanguage(code);
  if (!language || !Object.keys(language).length) throw failure('ENOENT', 'The requested language catalogue is unavailable');
  if (persist) win.localStorage.setItem('language', code);
  win.langcode = code;
  win.language = language;
  const config = win.CLIENTCONFIG || {};
  const names = [config.NEW_APP_CHINEASE_NAME, config.NEW_APP_NAME, 'WeLink'];
  if (names.includes(win.document.title)) {
    const appName = typeof win.getShowAppName === 'function' ? win.getShowAppName() :
      (code === '2052' ? config.NEW_APP_CHINEASE_NAME : config.NEW_APP_NAME) || 'WeLink';
    sync('language', { code, appName });
    win.document.title = appName;
  }
  if (win.coreTup && win.coreTup.loginSDK) {
    await win.coreTup.loginSDK.loginChangeLanguage({ language: code === '1033' ? 'en' : 'zh' });
  }
  if (persist && win.coreAccount && typeof win.coreAccount.getMyInfo === 'function') {
    (await win.coreAccount.getMyInfo()).languageCode = code;
  }
}
function initLanguage() {
  const win = renderer();
  const stored = win.localStorage.getItem('language');
  const configured = win.CLIENTCONFIG && win.CLIENTCONFIG.DEFAULT_LANGUAGE;
  const code = isLanguage(stored) ? String(stored) : isLanguage(configured) ? String(configured) :
    /^zh(?:-|$)/i.test(win.navigator.language) ? '2052' : '1033';
  if (!languageInitialization || languageInitializationCode !== code) {
    languageInitializationCode = code;
    languageInitialization = applyLanguage(code, false).catch(error => { languageInitialization = null; throw error; });
  }
  return languageInitialization;
}
function setLanguage(code) {
  // The recovered public API returns undefined for an unknown language and a
  // Promise resolving to 'OK' after changing a valid catalogue.
  if (code === undefined || code === null || !isLanguage(code)) return undefined;
  return applyLanguage(String(code), true).then(() => 'OK');
}

const globalShortcuts = Object.freeze({
  async register(accelerator, callback) {
    if (typeof callback !== 'function') throw failure('EINVAL', 'A shortcut callback is required');
    const id = String(++nextShortcut);
    shortcutIds.set(id, callback);
    try {
      const registered = await request('shortcut-register', { accelerator, id });
      if (registered) shortcuts.set(accelerator, id); else shortcutIds.delete(id);
      return registered;
    } catch (error) { shortcutIds.delete(id); throw error; }
  },
  isRegistered(accelerator) { return request('shortcut-is-registered', { accelerator }); },
  async unregister(accelerator) {
    await request('shortcut-unregister', { accelerator });
    shortcutIds.delete(shortcuts.get(accelerator));
    shortcuts.delete(accelerator);
  },
  async unregisterAll() {
    await request('shortcut-unregister-all');
    shortcuts.clear();
    shortcutIds.clear();
  }
});

const sdkMethods = Object.freeze({
  async setAutoStart(isAutoStart, exePath) {
    const actual = await request('autostart-set', { enabled: isAutoStart, exePath });
    return { result: 0, param: { isAutoStart: actual } };
  },
  async getAutoStart(exePath) {
    if (exePath !== nativePaths().execPath) throw failure('EACCES', 'Autostart can only query this native application');
    return { result: 0, param: { isAutoStart: sync('autostart-get') } };
  },
  async openUrlByBrowser(url, activate = true) {
    await request('open-url', { url, activate });
    return { result: 0, param: {} };
  }
});
function installSdkMethods() {
  const win = renderer();
  if (!win.coreTup || !win.coreTup.utilSDK) throw failure('ENODEV', 'The application utility SDK has not been initialized');
  Object.assign(win.coreTup.utilSDK, sdkMethods);
}
async function initAutoStartState() {
  const win = renderer();
  const actual = sync('autostart-get');
  await win.$dispatch(win.coreUi.changeAutoStart(actual));
}
async function initApp({ calcTimeMap }) {
  installRenderer();
  installSdkMethods();
  if (!consoleEvents) throw failure('ENODEV', 'The original application console-event provider was not installed');
  if (!consoleEventsInstalled) { consoleEvents(); consoleEventsInstalled = true; }
  const win = renderer();
  (await win.coreAccount.getMyInfo()).languageCode = win.langcode;
  await initAutoStartState();
  const now = Date.now();
  const events = win.constant.UT_EVENT_NAME;
  const time = new Date(now);
  const stop = [time.getHours(), time.getMinutes(), time.getSeconds()].map(value => String(value).padStart(2, '0')).join(':') + '.' + String(time.getMilliseconds()).padStart(3, '0');
  await win.Pedestal.callMethod('method://hwaUt/addHwaUtData', {
    eventId: win.isRedblue ? events.appLaunch_red : events.appLaunch,
    eventDesc: '启动应用', newUtDataRedblue: win.isRedblue,
    args: { use_time: now - calcTimeMap.startTime, start_time: calcTimeMap.startLoadModule, stop_time: stop,
      start_load_module: calcTimeMap.startLoadModule, start_load_common: calcTimeMap.startLoadCommon,
      start_load_appservice: calcTimeMap.startLoadAppService, start_load_account: calcTimeMap.startLoadAccount,
      start_load_ui: calcTimeMap.startLoadUi }
  });
  await win.Pedestal.callMethod('method://hwaUt/addHwaUtData', {
    eventId: events.lifecycle, args: { errorMessage: '', isCrash: 0, isLauncher: 1 }
  });
  return 0;
}
async function resolveIpConfigInfo() {
  const win = renderer();
  return Object.entries(os.networkInterfaces()).map(([name, addresses]) =>
    name + '\n' + addresses.map(address => '  ' + address.family + ': ' +
      (typeof win.handleIp === 'function' ? win.handleIp(address.address) : address.address) +
      ' netmask=' + address.netmask + (address.internal ? ' loopback' : '')).join('\n')).join('\n');
}
function startAccessingSecurityScopedResource() { return request('security-scoped-resource'); }

// Exact exports of HwAppService module 77457 (node/path helpers).
const node = Object.freeze({
  getNetworkInterfaces() { return os.networkInterfaces(); },
  getKmcPath() { return nativePaths().kmc; },
  getExecPath() { return path.dirname(nativePaths().execPath); },
  getCaCertPath() { return nativePaths().certificate; },
  getExecFullPath() { return nativePaths().execPath; },
  getLauncherPath() { throw failure('ENOTSUP', 'The Windows version-switching launcher is not available on native Linux'); },
  async debugInfoPrint(account) {
    const win = renderer();
    const cpus = os.cpus();
    const info = 'cpu:' + (cpus.length ? cpus[0].model + ' ' + cpus.length + 'core' : '') +
      '\nmemory:' + (os.totalmem() / 1073741824).toFixed(1) + 'G\nOS:' + os.platform() + ' ' + os.release() +
      '\nresloution:' + win.screen.width * win.devicePixelRatio + '*' + win.screen.height * win.devicePixelRatio +
      '\ndpi:' + win.devicePixelRatio + '\nversion:' + (typeof win.getAppShowVersion === 'function' ? win.getAppShowVersion() : (win.CLIENTCONFIG && win.CLIENTCONFIG.ACS_SOFTWAREVERSION_VALUE ? String(win.CLIENTCONFIG.ACS_SOFTWAREVERSION_VALUE) : '')) +
      '\ndisplayAccount:' + account.displayAccount + '\nshowAccount:' + account.showAccount +
      '\naccount:' + account.account + '\nosBit:' + os.arch() + '\n';
    const filename = path.join(nativePaths().logs, 'debugInfo_' + crypto.createHash('md5').update(info).digest('hex') + '.log');
    try { await fs.promises.writeFile(filename, new Date().toISOString() + '\n' + info, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
});

// Exact exports of HwAppService module 85126. Linux uses the owning window,
// never renderer-supplied BrowserWindow IDs or the legacy remote method bridge.
const windows = Object.freeze({
  async showWindow() { await request('window-show'); },
  async hideWindow() { await request('window-hide'); dispatch('onMainFrameHide'); },
  minimize() { sync('window-minimize'); dispatch('systemThemeChange'); },
  setSize(width, height, isRestore = false) { return request('window-size', { width, height, isRestore }); },
  async setMinSize() {
    const win = renderer();
    const zoom = Number(win.localStorage.getItem('zoomFactor') || 1);
    const view = win.coreDb && await win.coreDb.queryLoginSetting({ key: 'sessionGroupViewType' });
    const sidebar = win.coreDb && await win.coreDb.queryLoginSetting({ key: 'sessionGroupSideBarType' });
    const width = view && view.value === 'sideBar' && sidebar && sidebar.value === 'iconText' ? 1180 : 964;
    await request('window-minimum', { width: Math.ceil(width * zoom), height: Math.ceil(640 * zoom) });
  },
  async resizeMainWindow({ w, h, x, y, isOpacity = false, isRestore = false }) {
    await windows.setMinSize();
    await request('window-resize', { width: w, height: h, x, y, isOpacity, isRestore });
  },
  async resizeLoginWindow() {
    await request('window-minimum', { width: 1060, height: 704 });
    await request('window-resize', { width: 1060, height: 704, isRestore: false });
    const win = renderer();
    if (typeof win.setLoginPagePosition === 'function') win.setLoginPagePosition('resizeLoginWindow');
  }
});

const shell = Object.freeze({
  async openUrl(url) {
    try { await request('open-url', { url }); return true; }
    catch (error) { report(error); return false; }
  },
  async openFileOrFolder(filename) {
    try { await request('open-path', { path: filename }); }
    catch (error) {
      // A failed opener is not success just because the file manager can reveal
      // the item. Preserve the fallback UI but return false for the failed open.
      try { await request('show-item', { path: filename }); } catch (revealError) { report(revealError); }
      report(error);
      return false;
    }
  }
});

const electronMethods = Object.freeze({
  initElectronMethod() { installRenderer(); },
  async showMainWindow({ isShow }) { if (isShow) await windows.showWindow(); else await windows.hideWindow(); },
  async updateMainWinProxy() {
    const win = renderer();
    const proxy = await (await win.coreAccount.getProxyUtil()).getRealUseProxy({ info: 'updateMainWinProxy' });
    const address = proxy.proxyAddress || '';
    const port = proxy.proxyPort;
    if (address && (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535 || /[\s;@/]/.test(address))) {
      throw failure('EINVAL', 'Invalid application proxy');
    }
    const rules = address && port ? (address.includes(':') && !address.startsWith('[') ? '[' + address + ']' : address) + ':' + port : '';
    // Empty rules select the desktop's system proxy, rather than reading a
    // Windows registry value or disabling the desktop policy with a fake value.
    await request('window-proxy', { proxy: { proxyRules: rules, proxyBypassRules: process.env.no_proxy || process.env.NO_PROXY || '' } });
  }
});

const util = Object.freeze({
  async getSystemTheme(callback) {
    const value = sync('theme');
    if (callback !== undefined && typeof callback !== 'function') throw failure('EINVAL', 'Invalid theme callback');
    if (callback) callback(value);
    return value;
  },
  getUpgradeCertVerifyFilePath() { return nativePaths().installVerify; },
  async getLoginFailedPspingAddressResult() {
    const results = await request('diagnostics-network');
    // These are direct TCP connect timings, not authenticated service health or
    // measurements through a configured proxy. Failed endpoints remain failures.
    console.info('Native direct TCP diagnostic:', results);
    return results;
  },
  checkAndDeleteCrashFile() { return request('crash-prune'); },
  getFileModifyTime(name) { return request('crash-mtime', { name }); },
  async getSortList(names) {
    const dated = await Promise.all(names.map(async name => ({ name, time: await request('crash-mtime', { name }) })));
    dated.sort((a, b) => b.time - a.time);
    names.splice(0, names.length, ...dated.map(item => item.name));
    return names;
  }
});

function disableBrowserWindowShortcuts() { sync('window-disable-shortcuts'); }
function installRenderer(options = {}) {
  const win = renderer();
  if (options.registerConsoleEvent !== undefined) {
    if (typeof options.registerConsoleEvent !== 'function') throw failure('EINVAL', 'Invalid console-event provider');
    consoleEvents = options.registerConsoleEvent;
  }
  connect();
  if (!win.Pedestal || !win.Pedestal.remote) throw failure('ENODEV', 'Pedestal remote surface is not initialized');
  // Replace only the recovered shortcut surface, preserving the vendor's other
  // object identities and all unrelated native providers.
  win.Pedestal.remote.globalShortcut = globalShortcuts;
  if (!installed) {
    Object.assign(win, { electron: require('electron'), fs, fsPromise: fs.promises, path,
      spawn: require('child_process').spawn });
    installed = true;
  }
  return platform;
}

// Enumerable keys match the recovered Darwin/Win32 platform context exactly.
// Vendor integration (HwAppService.js): context module 47959 / 0xbb57,
// function _0x4d76cc, must resolve './linux/platform' to this namespace, not
// to Darwin module 17047. Its Linux branch calls installRenderer with the
// original registerConsoleEvent from webpack module 56837 / 0xde05.
// Replace shared modules 77457, 85126, 38380, 23933 with moduleOverrides[id].
// AppServiceImpl (21266) disableBrowserWindowShortcuts delegates to the helper
// below. The original method otherwise invokes the unowned remote bridge.
// installSdkMethods patches only the recovered utility methods after HwTup
// construction; initApp does this too. Failed settings reject, because the
// vendor updateAutoStart consumer changes its UI even for a nonzero result.
const platform = { initApp, initLanguage, setLanguage, getExistLangs, initAutoStartState,
  resolveIpConfigInfo, startAccessingSecurityScopedResource, util };
Object.defineProperties(platform, {
  __esModule: { value: true },
  installRenderer: { value: installRenderer },
  installSdkMethods: { value: installSdkMethods },
  disableBrowserWindowShortcuts: { value: disableBrowserWindowShortcuts },
  sdkMethods: { value: sdkMethods },
  globalShortcuts: { value: globalShortcuts },
  getCapabilities: { value: () => sync('capabilities') },
  checkNativeUpdate: { value: (manual = false) => request('update-check', {
    manual, locale: String(renderer().langcode || renderer().navigator.language || 'en').slice(0, 32)
  }) },
  prepareExit: { value: () => exitPreparation || (exitPreparation = request('process-prepare-exit')) },
  relaunch: { value: async () => {
    await request('process-relaunch');
    return renderer().appService.exitApp({ entry: 'native-platform-relaunch' });
  } },
  quit: { value: () => renderer().appService.exitApp({ entry: 'native-platform-quit' }) },
  moduleOverrides: { value: Object.freeze({ 77457: node, 85126: windows, 38380: shell, 23933: electronMethods }) }
});
module.exports = Object.freeze(platform);
