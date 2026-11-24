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
const { installPlatformMain } = require(path.join(appRoot, 'native/platform_main'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-native-updater-'));
const plain = value => JSON.parse(JSON.stringify(value));
const requests = [], dialogs = [], opened = [], errors = [], uiLoading = [];
const replies = [], choices = [];
let shellError = false;
let groups = 0;

function response(items, extra = {}) { return { body: JSON.stringify(items), ...extra }; }
function release(version, extra = {}) {
  return { tag_name: version, html_url: config.releasePage + version, draft: false, prerelease: false,
    name: 'Native ' + version, body: 'Native release notes for ' + version, ...extra };
}

// Transport fixture follows the Electron 22 ClientRequest/IncomingMessage
// event contract, including abort, errors, body streaming and redirects.
const net = { request(options) {
  const plan = replies.shift();
  assert(plan, 'Unexpected network request or automatic retry');
  const request = new EventEmitter();
  request.options = options;
  request.headers = {};
  request.setHeader = (name, value) => { request.headers[name] = value; };
  request.abort = () => { request.aborted = true; request.emit('abort'); };
  request.end = () => queueMicrotask(() => {
    if (request.aborted || plan.hang) return;
    if (plan.error) { request.emit('error', new Error(plan.error)); return; }
    if (plan.redirect) { request.emit('redirect', 302, 'GET', plan.redirect, {}); return; }
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
  });
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
window.require = name => name === path.join(appRoot, 'native/update_renderer') ? native : require(name);
window.window = window;
window.global = window;
window.process = { platform: 'linux', resourcesPath: path.dirname(appRoot) };
window.Pedestal = { appRootPath: path.join(temp, 'profile-appdata') };
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
async function manual(plan, expected) {
  const before = requests.length;
  replies.push(plan);
  const result = await window.coreUpgrade.checkUpgrade({ entry: 'aboutPage', isUserClick: true });
  assert(result, 'Vendor consumer must return the native receipt');
  assert.equal(result.status, expected);
  assert.equal(requests.length, before + 1, 'One check must not retry');
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
  const numericOlder = 'r45.' + (boundary - 1), numericNewer = 'r45.' + boundary;
  choices.push(1);
  const available = await manual(response([
    release(currentVersion), release(numericNewer), release('r45.999', { draft: true }),
    release('r45.998', { prerelease: true }), release('not-a-version'), release('r46.1'),
    release(numericOlder, { assets: [{ browser_download_url: 'https://example.invalid/WindowsPackage.exe' }] })
  ]), 'available');
  assert.equal(available.latest.version, numericNewer, 'Native versions must compare numerically across digit boundaries');
  assert.equal(available.action, 'release-page-opened');
  assert.deepEqual(opened, [config.releasePage + numericNewer]);
  assert(dialogs.at(-1).detail.includes(currentVersion));
  assert(dialogs.at(-1).detail.includes('Native release notes for ' + numericNewer));
  assert.match(dialogs.at(-1).detail, /installed manually/);
  assert(!('assets' in available.latest), 'Asset URLs must not enter the native update protocol');
  ++groups;

  for (const body of ['Preview heading\n' + 'wrapped content '.repeat(600) + '\nEnd of full notes',
    'Preview heading\n' + 'short line\n'.repeat(900) + 'End of full notes']) {
    const result = await manual(response([release(nextVersion, { body })]), 'available');
    assert(dialogs.at(-1).detail.includes('Preview heading'));
    assert(!dialogs.at(-1).detail.includes('End of full notes'), 'Long notes must not push native dialog controls off screen');
    assert.equal(result.latest.notes, body, 'The receipt retains the full release notes');
  }
  ++groups;

  await manual(response([release(currentVersion), release('r45.8')]), 'current');
  assert.match(dialogs.at(-1).message, /No newer native stable release/);
  await manual(response([]), 'no-releases');
  assert.match(dialogs.at(-1).message, /No native stable releases have been published/);
  assert.deepEqual(dialogs.at(-1).buttons, ['Close']);
  await manual(response([release('r45.10-beta'), release('r45.999', { prerelease: true })]), 'no-releases');
  ++groups;

  for (const [plan, code] of [
    [response([{}]), 'EPROTO'],
    [response([release('r45.9'), release(4510)]), 'EPROTO'],
    [{ error: 'net::ERR_CERT_AUTHORITY_INVALID' }, 'ENETWORK'],
    [{ body: '{broken' }, 'EPROTO'],
    [response({ tag_name: 'r45.10' }), 'EPROTO'],
    [response([release('r45.10', { body: 123 })]), 'EPROTO'],
    [response([release('r45.10', { draft: undefined })]), 'EPROTO'],
    [response([release('r45.10', { html_url: 'https://github.com/evil/repo/releases/tag/r45.10' })]), 'EPROTO'],
    [response([release('r45.10', { html_url: config.releasePage + 'r45.10?download=WindowsPackage.exe' })]), 'EPROTO'],
    [response([], { status: 429, headers: { 'retry-after': ['60'] } }), 'ERATELIMIT'],
    [response([], { status: 403, headers: { 'x-ratelimit-remaining': ['0'] } }), 'ERATELIMIT'],
    [response([], { status: 404 }), 'EHTTP'],
    [{ redirect: 'https://example.invalid/WindowsPackage.exe' }, 'EPROTO'],
    [response([], { headers: { 'content-type': ['text/html'] } }), 'EPROTO'],
    [response([], { headers: { 'content-length': [String(config.maxBytes + 1)] } }), 'E2BIG'],
    [{ chunks: [Buffer.alloc(config.maxBytes), Buffer.from('x')] }, 'E2BIG'],
    [response([], { incomplete: true }), 'ENETWORK']
  ]) {
    const before = opened.length;
    const result = await manual(plan, 'error');
    assert.equal(result.error.code, code);
    assert.equal(dialogs.at(-1).type, 'error');
    assert.equal(opened.length, before, 'Failed checks cannot open a browser');
  }
  ++groups;

  replies.push(response([release('r45.10')], { headers: { link: ['<' + config.api + '?page=2>; rel="next"'] } }), response([release('r45.101')]));
  const paged = await window.coreUpgrade.checkUpgrade({ isUserClick: true });
  assert.equal(paged.latest.version, 'r45.101');
  assert(requests.at(-1).options.url.endsWith('&page=2'));
  const beforePages = requests.length;
  for (let page = 0; page < config.maxPages; page++) replies.push(response([], { headers: { link: ['<' + config.api + '?page=999>; rel="next"'] } }));
  const tooMany = await window.coreUpgrade.checkUpgrade({ isUserClick: true });
  assert.equal(tooMany.error.code, 'E2BIG');
  assert.equal(requests.length - beforePages, config.maxPages);
  ++groups;

  const beforeSilent = { dialogs: dialogs.length, opened: opened.length };
  for (const check of [() => window.coreUpgrade.checkUpgrade({ entry: 'startup' }),
    () => window.coreUpgrade.checkUpdateBeforeLogin(), () => native.actions.showPcUpdateModel(),
    () => native.actions.startDownload({ isShowModal: false }), () => native.transport.upgradeByHttp()]) {
    replies.push(response([release(nextVersion)]));
    assert.equal((await check()).status, 'available');
  }
  assert.equal(dialogs.length, beforeSilent.dialogs, 'Automatic checks must not display upgrade UI');
  assert.equal(opened.length, beforeSilent.opened, 'Automatic checks must not open browsers');
  const beforeConcurrent = { requests: requests.length, dialogs: dialogs.length };
  replies.push(response([release(nextVersion)]));
  const concurrent = await Promise.all([window.coreUpgrade.checkUpgrade({ isUserClick: true }), window.coreUpgrade.checkUpgrade({ isUserClick: true })]);
  assert(concurrent.every(item => item.status === 'available'));
  assert.equal(requests.length, beforeConcurrent.requests + 1);
  assert.equal(dialogs.length, beforeConcurrent.dialogs + 1);
  ++groups;

  for (const fn of [native.actions.clickConfirmUpdate, native.actions.startInstallNewVer, native.actions.startDownload]) {
    replies.push(response([release(nextVersion)]));
    assert.equal((await fn()).status, 'available');
  }
  for (const fn of [native.actions.cancelDownload, native.actions.dealDownloadFailed, native.actions.dealInstallFailed,
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
    const fn = evaluate(value, { require: name => { assert.equal(name, '../../native/update_renderer'); return native; } });
    await assert.rejects(fn({ versionDownloadUrl: 'https://example.invalid/WindowsPackage.exe' }), { code: 'ENOTSUP' });
    for (const platformName of ['win32', 'darwin']) {
      const original = () => 'original-' + name;
      assert.equal(evaluate(value, { process: { platform: platformName }, U: original, H: original })(), 'original-' + name);
    }
  }
  ++groups;

  choices.push(1);
  shellError = true;
  const openFailure = await manual(response([release(nextVersion)]), 'error');
  shellError = false;
  assert.match(openFailure.error.message, /browser refused/);
  assert.equal(openFailure.action, undefined, 'Browser launch failure cannot claim success');
  const denied = await handlers.get('welink-native-platform-v1')(event(), { owner: 'forged', operation: 'update-check', args: { manual: true, locale: 'en' } });
  assert.equal(denied.error.code, 'EACCES');
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
    assert.match(request.options.url, /^https:\/\/api\.github\.com\/repos\/jiwangyihao\/welink-native-linux\/releases\?per_page=100&page=[1-9][0-9]*$/);
    assert.equal(request.options.session, contents.session);
    assert.equal(request.options.redirect, 'error');
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
