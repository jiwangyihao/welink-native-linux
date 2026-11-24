#!/usr/bin/env node
'use strict';

// Parent-run regression: --app points at an assembled private application, not
// checked-in vendor code. Executes the real HwUpgrade consumer, Linux facade,
// renderer IPC and authenticated main provider. Only Electron I/O is a fixture.
// A separate genuine Electron/live-GitHub surface check is still required.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');
const acorn = require(process.env.WELINK_QA_ACORN || 'acorn');
const index = process.argv.indexOf('--app');
assert(index >= 0 && process.argv[index + 1], 'Supply --app ASSEMBLED_APP');
const appRoot = fs.realpathSync(process.argv[index + 1]);
const config = require(path.join(appRoot, 'native/update_config'));
const crypto = require('crypto');
const { publicKey: testPublicKey, privateKey: testPrivateKey } = crypto.generateKeyPairSync('ed25519');
const manifestProtocol = require(path.join(appRoot, 'native/update_manifest'));
let signatureCorrupt = false, manifestChange = value => value, nativeInstalls = 0, normalExits = 0;
function loadMain(name, overrides) {
  const filename = path.join(appRoot, 'native', name);
  const module = { exports: {} }, original = createRequire(filename);
  const wrapper = vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename });
  wrapper(name => Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : original(name), module, module.exports, filename, path.dirname(filename));
  return module.exports;
}
// Synthetic publisher keys exist only in this test's module loader. Production
// modules have no environment, URL, IPC or command-line trust-key override.
const testedUpdater = loadMain('update_main.js', {
  './update_manifest': { ...manifestProtocol, verifyManifest(bytes, signature, _key, context) {
    return manifestProtocol.verifyManifest(bytes, signature, testPublicKey.export({ type: 'spki', format: 'pem' }), context);
  } },
  './update_install': { async installUpdate({ verified }) {
    ++nativeInstalls;
    assert(verified.bytes && verified.signature, 'Native installation must receive the verified manifest, never a renderer URL');
    return { status: 'staged', action: 'restart-required', version: verified.version };
  } }
});
const { installPlatformMain } = loadMain('platform_main.js', { './update_main': testedUpdater });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-native-updater-'));
const plain = value => JSON.parse(JSON.stringify(value));
const requests = [], dialogs = [], opened = [], errors = [], uiLoading = [];
const replies = [], choices = [];
let shellError = false;
let groups = 0;

function response(items, extra = {}) { return { body: JSON.stringify(items), ...extra }; }
const signedManifests = new Map();
function channel(version, extra = {}) {
  const current = JSON.parse(fs.readFileSync(path.join(appRoot, 'native/build.json'), 'utf8')).build;
  const installedVersion = current.replace('hit-native-linux-ia32-', '');
  const baseVersion = Number(version.slice(4)) > Number(installedVersion.slice(4)) ? installedVersion : 'r45.' + (Number(version.slice(4)) - 1);
  const base = 'hit-native-linux-ia32-' + baseVersion;
  const checker = crypto.createHash('sha256').update(fs.readFileSync(path.join(appRoot, 'native/lib/sqlite_plugin.dll.so'))).digest('hex');
  const manifest = manifestChange({ format: 1, version, build: 'hit-native-linux-ia32-' + version, sourceCommit: 'a'.repeat(40),
    name: 'Native ' + version, notes: extra.notes === undefined ? 'Native release notes for ' + version : extra.notes,
    installers: [{ base, baseCheckerSha256: checker, asset: 'install-' + version + '-from-' + baseVersion + '.py', size: 1, sha256: 'b'.repeat(64) }],
    integration: { asset: 'install_desktop.py', size: 1, sha256: 'c'.repeat(64) } });
  const bytes = Buffer.from(JSON.stringify(manifest));
  const signature = crypto.sign(null, bytes, testPrivateKey);
  if (signatureCorrupt) signature[0] ^= 1;
  signedManifests.set(version, { bytes, signature: Buffer.from(signature.toString('base64') + '\n') });
  return { body: bytes, ...extra };
}

// Transport fixture follows the Electron 22 ClientRequest/IncomingMessage
// event contract, including abort, errors, body streaming and redirects.
const net = { request(options) {
  const asset = /\/releases\/download\/(r45\.[0-9]+)\/native-update\.(json|sig)$/.exec(options.url);
  const signed = asset && signedManifests.get(asset[1]);
  const plan = asset ? signed && { body: asset[2] === 'json' ? signed.bytes : signed.signature } : replies.shift();
  assert(plan, 'Unexpected network request or automatic retry');
  const request = new EventEmitter();
  request.options = options;
  request.headers = {};
  request.setHeader = (name, value) => { request.headers[name] = value; };
  request.abort = () => { request.aborted = true; request.emit('abort'); };
  const deliver = () => {
    if (request.aborted || plan.hang) return;
    if (plan.error) { request.emit('error', new Error(plan.error)); return; }
    const stream = new EventEmitter();
    stream.statusCode = plan.status || 200;
    stream.headers = { 'content-type': ['application/json; charset=utf-8'], ...plan.headers };
    request.emit('response', stream);
    if (request.aborted) return;
    for (const chunk of plan.chunks || [Buffer.from(plan.body)]) {
      stream.emit('data', chunk);
      if (request.aborted) return;
    }
    if (plan.incomplete) stream.emit('close');
    else { stream.emit('end'); stream.emit('close'); }
  };
  request.followRedirect = () => queueMicrotask(deliver);
  request.end = () => queueMicrotask(() => plan.redirect ? request.emit('redirect', 302, 'GET', plan.redirect) : deliver());
  requests.push(request);
  return request;
} };

const handlers = new Map();
const ipcMain = new EventEmitter();
ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
ipcMain.removeHandler = channel => handlers.delete(channel);
const frame = { url: pathToFileURL(path.join(appRoot, 'pedestal/index.html')).href, parent: null, send() {} };
const contents = new EventEmitter();
contents.mainFrame = frame;
contents.isDestroyed = () => false;
contents.session = { fixture: 'owner session with proxy policy' };
const win = new EventEmitter();
win.isDestroyed = () => false;
for (const directory of ['profile', 'user', 'logs']) fs.mkdirSync(path.join(temp, directory));
const appPaths = { appData: path.join(temp, 'profile'), userData: path.join(temp, 'user'),
  logs: path.join(temp, 'logs'), exe: process.execPath, home: temp };
const electron = { net, ipcMain,
  app: { getAppPath: () => appRoot, getPath: key => appPaths[key], getName: () => 'Updater regression' },
  BrowserWindow: { fromWebContents: value => value === contents ? win : null },
  globalShortcut: { unregister() {} },
  dialog: { async showMessageBox(owner, options) {
    assert.equal(owner, win);
    dialogs.push(options);
    return { response: choices.length ? choices.shift() : 0 };
  } },
  shell: { async openExternal(url) { if (shellError) throw new Error('browser refused'); opened.push(url); } }
};
const provider = installPlatformMain({ electron, appRoot, prepareExit: async () => { throw new Error('Updater must not quit the application'); } });
const event = () => ({ sender: contents, senderFrame: frame });
const ipcRenderer = new EventEmitter();
ipcRenderer.sendSync = (channel, message) => {
  const call = event();
  ipcMain.emit(channel, call, message);
  return call.returnValue;
};
ipcRenderer.invoke = (channel, message) => handlers.get(channel)(event(), message);
const listeners = new Map();
const window = { langcode: '1033', navigator: { language: 'en' },
  addEventListener(name, listener) { listeners.set(name, listener); },
  dispatchEvent(value) { errors.push(value); },
  CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  coreUi: { loadingfunc: value => uiLoading.push(value) } };
window.appService = { async exitApp() { ++normalExits; } };
function loadNative(name, overrides) {
  const filename = path.join(appRoot, 'native', name);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const fn = vm.runInNewContext('(function(require,module,exports,__filename,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n})', {
    window, process: { platform: 'linux', type: 'renderer', env: {} }, Buffer, console: { error: (...args) => errors.push(args), info() {} }
  }, { filename, timeout: 10000 });
  fn(name => Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : realRequire(name), module, module.exports, filename, path.dirname(filename));
  return module.exports;
}
const platform = loadNative('platform.js', { electron: { ipcRenderer } });
const native = loadNative('update_renderer.js', { './platform': platform });
const pageRequire = createRequire(path.join(appRoot, 'pedestal/index.html'));
window.require = name => pageRequire.resolve(name) === path.join(appRoot, 'native/update_renderer.js') ? native : pageRequire(name);
window.window = window;
window.global = window;
window.process = { platform: 'linux', resourcesPath: path.dirname(appRoot) };
window.Pedestal = { appRootPath: path.join(temp, 'profile-appdata'), logRootPath: path.join(temp, 'logs'), viewID: 'pedestal' };
window.console = { error: (...args) => errors.push(args) };
window.coreLogger = { getLogger: () => () => ({ info() {}, error() {}, debug() {} }) };
window.coreCommon = {
  ModuleCache: class ModuleCache { constructor() { throw new Error('Linux must not initialize the Windows upgrade model'); } },
  registeModuleListener(name, listener) { listeners.set('module:' + name, listener); }
};
const consumerContext = vm.createContext(window);
vm.runInContext('Object.type = { isFunction: value => typeof value === "function" };', consumerContext);
vm.runInContext(fs.readFileSync(path.join(appRoot, 'pedestal/js/HwUpgrade.js'), 'utf8'), consumerContext, { timeout: 10000 });
assert.equal(typeof window.coreUpgrade.checkUpgrade, 'function', 'The real vendor consumer must initialize');
vm.runInContext(fs.readFileSync(path.join(appRoot, 'libraries/js/httpWithRsSdk.js'), 'utf8'), consumerContext, { timeout: 10000 });

const sources = new Map();
function visit(node, callback) {
  if (!node || typeof node.type !== 'string') return;
  callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => visit(child, callback));
    else if (value && typeof value === 'object') visit(value, callback);
  }
}
function expression(relative, predicate) {
  if (!sources.has(relative)) {
    const text = fs.readFileSync(path.join(appRoot, relative), 'utf8');
    sources.set(relative, { text, tree: acorn.parse(text, { ecmaVersion: 'latest' }) });
  }
  const { text, tree } = sources.get(relative), found = [];
  visit(tree, node => { if (predicate(node, text.slice(node.start, node.end))) found.push(node); });
  assert.equal(found.length, 1, 'Unique consumer function: ' + relative);
  return text.slice(found[0].start, found[0].end);
}
function evaluate(text, additions = {}) {
  return vm.runInNewContext('(' + text + ')', { window, Pedestal: window.Pedestal, process: window.process, ...additions }, { timeout: 10000 });
}
async function manual(plan, expected, expectedRequests = expected === 'available' || expected === 'current' ? 3 : 1) {
  const before = requests.length;
  replies.push(plan);
  const result = await window.coreUpgrade.checkUpgrade({ entry: 'aboutPage', isUserClick: true });
  assert(result, 'Vendor consumer must return the native receipt');
  assert.equal(result.status, expected);
  assert.equal(requests.length, before + expectedRequests, 'Only metadata/signature requests are allowed during a check');
  assert.equal(replies.length, 0);
  return result;
}

async function run() {
  const installed = JSON.parse(fs.readFileSync(path.join(appRoot, 'native/build.json'), 'utf8'));
  const match = /^hit-native-linux-ia32-(r45\.([0-9]+))$/.exec(installed.build);
  assert(match, 'Supply a real native r45 image');
  const currentVersion = match[1], revision = Number(match[2]);
  const nextVersion = 'r45.' + (revision + 1);
  const boundary = 10 ** String(revision).length;
  const numericNewer = 'r45.' + boundary;
  choices.push(1);
  const available = await manual(channel(numericNewer), 'available');
  assert.equal(available.latest.version, numericNewer, 'Native versions must compare numerically across digit boundaries');
  assert.equal(available.action, 'release-page-opened');
  assert.deepEqual(opened, [config.releasePage + numericNewer]);
  assert(dialogs.at(-1).detail.includes(currentVersion));
  assert(dialogs.at(-1).detail.includes('Native release notes for ' + numericNewer));
  assert.equal(available.signed, true);
  assert(!('assets' in available.latest), 'Executable URLs must not enter renderer update metadata');
  ++groups;

  for (const body of ['Preview heading\n' + 'wrapped content '.repeat(600) + '\nEnd of full notes',
    'Preview heading\n' + 'short line\n'.repeat(900) + 'End of full notes']) {
    const result = await manual(channel(nextVersion, { notes: body }), 'available');
    assert(dialogs.at(-1).detail.includes('Preview heading'));
    assert(!dialogs.at(-1).detail.includes('End of full notes'), 'Long notes must not push native dialog controls off screen');
    assert.equal(result.latest.notes, body, 'The receipt retains the full release notes');
  }
  ++groups;

  const current = await manual(channel(currentVersion), 'current');
  assert.equal(current.signed, true, 'Current status still requires publisher verification');
  const older = await manual(channel('r45.' + (revision - 1)), 'current');
  assert.equal(older.latest.version, 'r45.' + (revision - 1));
  assert.equal(nativeInstalls, 0, 'An old signed release cannot cause a downgrade');
  ++groups;

  for (const [plan, code] of [
    [response({}), 'EPROTO'],
    [response({ version: 4510 }), 'EPROTO'],
    [{ error: 'net::ERR_CERT_AUTHORITY_INVALID' }, 'ENETWORK'],
    [{ body: '{broken' }, 'EPROTO'],
    [response({ version: 'r46.1' }), 'EPROTO'],
    [response({ version: 'r45.10-beta' }), 'EPROTO'],
    [response({}, { status: 429 }), 'EHTTP'],
    [response({}, { status: 403 }), 'EHTTP'],
    [response({}, { status: 404 }), 'EHTTP'],
    [{ redirect: 'https://example.invalid/WindowsPackage.exe' }, 'EPROTO'],
    [{ body: '<html>not a manifest</html>' }, 'EPROTO'],
    [response({}, { headers: { 'content-length': [String(config.maxManifestBytes + 1)] } }), 'ESIZE'],
    [{ chunks: [Buffer.alloc(config.maxManifestBytes), Buffer.from('x')] }, 'ESIZE'],
    [response({}, { incomplete: true }), 'ENETWORK']
  ]) {
    const before = opened.length;
    const result = await manual(plan, 'error');
    assert.equal(result.error.code, code);
    assert.equal(dialogs.at(-1).type, 'error');
    assert.equal(opened.length, before, 'Failed checks cannot open a browser');
  }
  ++groups;

  const mismatched = channel(nextVersion);
  signedManifests.get(nextVersion).bytes = Buffer.from('{}');
  const mismatch = await manual(mismatched, 'error', 2);
  assert.equal(mismatch.error.code, 'EPROTO', 'Discovery must match the canonical tag bytes');
  const redirected = channel(nextVersion, { redirect: manifestProtocol.assetUrl(nextVersion, 'native-update.json') });
  await manual(redirected, 'available');
  ++groups;

  const beforeSilent = { dialogs: dialogs.length, opened: opened.length };
  for (const check of [() => window.coreUpgrade.checkUpgrade({ entry: 'startup' }),
    () => window.coreUpgrade.checkUpdateBeforeLogin(), () => native.actions.showPcUpdateModel(),
    () => native.transport.upgradeByHttp()]) {
    replies.push(channel(nextVersion));
    assert.equal((await check()).status, 'available');
  }
  assert.equal(dialogs.length, beforeSilent.dialogs, 'Automatic checks must not display upgrade UI');
  assert.equal(opened.length, beforeSilent.opened, 'Automatic checks must not open browsers');
  const beforeConcurrent = { requests: requests.length, dialogs: dialogs.length };
  replies.push(channel(nextVersion));
  const concurrent = await Promise.all([window.coreUpgrade.checkUpgrade({ isUserClick: true }), window.coreUpgrade.checkUpgrade({ isUserClick: true })]);
  assert(concurrent.every(item => item.status === 'available'));
  assert.equal(requests.length, beforeConcurrent.requests + 3);
  assert.equal(dialogs.length, beforeConcurrent.dialogs + 1);
  ++groups;

  for (const fn of [native.actions.clickConfirmUpdate]) {
    replies.push(channel(nextVersion));
    assert.equal((await fn()).status, 'available');
  }
  for (const fn of [native.actions.startDownload, native.actions.startInstallNewVer,
    native.actions.cancelDownload, native.actions.dealDownloadFailed, native.actions.dealInstallFailed,
    native.transport.downloadFromHttp]) await assert.rejects(fn(), { code: 'ENOTSUP' });
  assert.throws(() => native.transport.getDownloadSuccessVersionCode(), { code: 'ENOTSUP' });
  ++groups;

  const guarded = [
    ['pedestal/js/HwUpgrade.js', '_0x26f8fd'], ['pedestal/js/HwUpgrade.js', '_0x4f1a98'],
    ['pedestal/js/HwMiddleGround.js', '_0x3fb68d'], ['pedestal/js/HwLazyLoad.js', '_0x281f9f']
  ];
  for (const [file, parameter] of guarded) {
    const text = expression(file, node => node.type === 'FunctionExpression' && node.params.length === 1 && node.params[0].name === parameter);
    await assert.rejects(evaluate(text)({ versionDownloadUrl: 'https://example.invalid/WindowsPackage.exe', filePath: '/tmp/WindowsPackage.exe' }), { code: 'ENOTSUP' });
  }
  for (const prefix of ['function(){var _0x32f4f7', 'function(){var _0x5c9275']) {
    const marker = prefix.slice('function(){'.length);
    const text = expression('pedestal/js/HwUpgrade.js', (node, text) => node.type === 'FunctionExpression' && text.startsWith('function(){') && text.includes(marker) && text.length < 4000);
    assert.throws(() => evaluate(text)(), { code: 'ENOTSUP' });
  }
  for (const [file, marker] of [['pedestal/js/HwMiddleGround.js', 'var _0x20b03e=_0x549e77;return _0x5832c0'], ['pedestal/js/HwLazyLoad.js', "return _0x2dfbd6['apply']"]]) {
    const text = expression(file, (node, text) => node.type === 'FunctionExpression' && node.params.length === 0 && text.includes(marker) && text.length < 1000);
    await assert.rejects(evaluate(text)(), { code: 'ENOTSUP' });
  }
  for (const name of ['downloadUpgradeFile', 'cancelDownloadUpgradeFile']) {
    const property = expression('libraries/js/httpWithRsSdk.js', node => node.type === 'Property' && node.key.name === name && node.value.type === 'ConditionalExpression');
    const value = property.slice(property.indexOf(':') + 1);
    await assert.rejects(window.coreRsHttp[name]({ versionDownloadUrl: 'https://example.invalid/WindowsPackage.exe' }), { code: 'ENOTSUP' });
    for (const platformName of ['win32', 'darwin']) {
      const original = () => 'original-' + name;
      assert.equal(evaluate(value, { process: { platform: platformName }, U: original, H: original })(), 'original-' + name);
    }
  }
  ++groups;

  choices.push(1);
  shellError = true;
  const openFailure = await manual(channel(nextVersion), 'error', 3);
  shellError = false;
  assert.match(openFailure.error.message, /browser refused/);
  assert.equal(openFailure.action, undefined, 'Browser launch failure cannot claim success');
  const denied = await handlers.get('welink-native-platform-v1')(event(), { owner: 'forged', operation: 'update-check', args: { manual: true, locale: 'en' } });
  assert.equal(denied.error.code, 'EACCES');
  ++groups;
  const beforeInstall = nativeInstalls;
  for (const change of [
    value => ({ ...value, build: 'hit-native-linux-ia32-r45.0' }),
    value => ({ ...value, installers: [...value.installers, value.installers[0]] }),
    value => ({ ...value, installers: [{ ...value.installers[0], baseCheckerSha256: '0'.repeat(64) }] }),
    value => ({ ...value, integration: { ...value.integration, asset: '../install_desktop.py' } }),
    value => ({ ...value, notes: 123 })
  ]) {
    manifestChange = change;
    replies.push(channel(nextVersion));
    const failed = await window.coreUpgrade.checkUpgrade({ isUserClick: true });
    assert.equal(failed.status, 'error');
    assert(['EPROTO', 'EBASE'].includes(failed.error.code));
  }
  manifestChange = value => value;
  signatureCorrupt = true;
  replies.push(channel(nextVersion));
  assert.equal((await window.coreUpgrade.checkUpgrade({ isUserClick: true })).error.code, 'ESIGNATURE');
  signatureCorrupt = false;
  assert.equal(nativeInstalls, beforeInstall, 'Failed signatures/compatibility cannot reach native execution');
  assert.equal(normalExits, 0, 'Checking never exits the application');
  choices.push(2);
  replies.push(channel(nextVersion));
  const staged = await window.coreUpgrade.checkUpgrade({ isUserClick: true });
  assert.equal(staged.status, 'staged', 'Staging is not installation success');
  assert.equal(staged.action, 'restart-required');
  assert.equal(nativeInstalls, beforeInstall + 1);
  assert.equal(normalExits, 1, 'The dedicated native action requests the real renderer exit provider');
  ++groups;

  const timeout = await manual({ hang: true }, 'error');
  assert.equal(timeout.error.code, 'ETIMEDOUT');
  assert(requests.at(-1).aborted);
  replies.push({ hang: true });
  const canceled = window.coreUpgrade.checkUpgrade({ entry: 'startup' });
  contents.emit('did-start-navigation', {}, 'about:blank', false, true);
  assert.equal((await canceled).error.code, 'ECANCELED');
  assert(requests.at(-1).aborted);
  ++groups;

  for (const request of requests) {
    assert(request.options.url === config.channelManifest ||
      /^https:\/\/github\.com\/jiwangyihao\/welink-native-linux\/releases\/download\/r45\.[0-9]+\/native-update\.(json|sig)$/.test(request.options.url));
    assert.equal(request.options.session, contents.session);
    assert.equal(request.options.redirect, 'manual');
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.useSessionCookies, false);
  }
  assert(uiLoading.length > 0 && uiLoading.every(value => value === false));
  assert.equal(replies.length, 0);
  console.log(JSON.stringify({ status: 'passed', groups, requests: requests.length,
    boundary: 'Real assembled consumers and native IPC; deterministic Electron I/O fixtures, not live network or desktop evidence.' }));
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  provider.dispose();
  fs.rmSync(temp, { recursive: true, force: true });
});
