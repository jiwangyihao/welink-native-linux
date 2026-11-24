#!/usr/bin/env node
'use strict';
// Parent-run against a sealed image through NativeBuild/verify_desktop.py. The
// namespace has no external network, existing HOME/profile, camera, or microphone.
// GIO resolves each URI through its registered scheme handler, without forcing
// a desktop entry. Inspector is used only for the
// separate real window API exercise, never to set login/consent/config state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const root = process.env.WELINK_DESKTOP_QA_ROOT;
assert(root && process.env.WELINK_DESKTOP_QA_ISOLATED === '1', 'Use the private namespace runner');
const image = path.join(root, 'releases/hit-welink-native-r45.8/image');
const alternateImage = path.join(root, 'releases/hit-welink-native-r45.8-routing-fixture/image');
const installer = path.join(root, 'install_desktop.py');
const output = path.join(root, 'evidence');
const results = { urls: [], opacity: [], teardown: [], boundaries: [
  'No external network or existing user state is accessible.',
  'URL delivery proves the genuine renderer handler/consent queue, not authenticated meeting admission.',
  'X11 property readback proves opacity requests; a compositor must honor that EWMH hint to render translucency.',
  'The isolated launcher uses the explicit --direct-launch option, not a live user systemd manager.',
  'Fixture teardown may force an owned namespace process to exit; it does not verify natural application quit.'
] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = new Set();
const processIdentities = new Map();

async function until(probe, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await probe();
    if (result) return result;
    await delay(100);
  }
  throw new Error(label + ' timed out');
}

function environment(home) {
  return { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    WELINK_NATIVE_PROFILE_DIR: path.join(home, '.local/share/hit-welink-native/profile') };
}

function install(home, selectedImage = image) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = environment(home);
  execFileSync('python3', [installer, '--image', selectedImage, '--home', home, '--direct-launch'], {
    env: { ...env, XDG_DATA_HOME: path.join(home, 'inherited-instrumentation-data') }, encoding: 'utf8', timeout: 15000
  });
  assert(!fs.existsSync(path.join(home, 'inherited-instrumentation-data/applications/hit-welink-native.desktop')));
  for (const scheme of ['hwwelink', 'hwwemeeting', 'cloudlink']) {
    const query = execFileSync('gio', ['mime', 'x-scheme-handler/' + scheme], { env: { ...env, LC_ALL: 'C' }, encoding: 'utf8' });
    const defaults = query.split('\n').filter(line => line.startsWith('Default application for ')).map(line => line.slice(line.indexOf(': ') + 2));
    assert.deepEqual(defaults, ['hit-welink-native.desktop'], query);
  }
  const desktop = path.join(home, '.local/share/applications/hit-welink-native.desktop');
  const text = fs.readFileSync(desktop, 'utf8');
  assert.match(text, /^Exec=\/bin\/bash -- .* %u$/m);
  assert.match(text, /^MimeType=x-scheme-handler\/hwwelink;x-scheme-handler\/hwwemeeting;x-scheme-handler\/cloudlink;$/m);
  return { env, desktop, launcher: path.join(home, '.local/bin/hit-welink-native'), profile: env.WELINK_NATIVE_PROFILE_DIR };
}

function fileTree(directory, wanted) {
  let files;
  try { files = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return files.flatMap(entry => entry.isDirectory() ? fileTree(path.join(directory, entry.name), wanted) :
    entry.isFile() && wanted(entry.name) ? [path.join(directory, entry.name)] : []);
}
function rendererLog(profile) {
  return fileTree(profile, name => name === 'CloudLink.log').map(file => fs.readFileSync(file, 'utf8')).join('\n');
}
function processState(pid) {
  try {
    const directory = '/proc/' + pid;
    const stat = fs.readFileSync(directory + '/stat', 'utf8');
    // Fields after comm begin at field 3; Linux starttime is field 22.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { state: fields[0], startTime: fields[19], uid: fs.statSync(directory).uid };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}

function trackProcess(pid) {
  assert(Number.isSafeInteger(pid) && pid > 1, 'Only an explicit fixture process PID may be tracked');
  const current = processState(pid);
  if (!current || current.state === 'Z') return false;
  assert.equal(current.uid, process.getuid(), 'Fixture process must belong to the verifier user');
  const previous = processIdentities.get(pid);
  if (previous !== undefined) assert.equal(current.startTime, previous, 'Fixture PID was unexpectedly reused');
  processIdentities.set(pid, current.startTime);
  children.add(pid);
  return true;
}

function owner(profile) {
  try {
    const lock = fs.readlinkSync(path.join(profile, 'runtime/SingletonLock'));
    const match = /-([1-9][0-9]*)$/.exec(lock);
    if (!match) throw new Error('Unexpected singleton owner: ' + lock);
    const pid = Number(match[1]);
    return trackProcess(pid) ? pid : null;
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}
async function stop(pid) {
  if (!pid) return;
  const identity = processIdentities.get(pid);
  assert(identity !== undefined, 'Refusing to signal an untracked process');
  function retired() {
    const current = processState(pid);
    if (!current || current.state === 'Z' || current.startTime !== identity) return true;
    assert.equal(current.uid, process.getuid(), 'Refusing to signal a process whose owner changed');
    return false;
  }
  function signal(name) {
    // Recheck identity immediately before each signal; never target a reused PID.
    if (retired()) return false;
    try { process.kill(pid, name); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }
  const report = { pid, scope: 'isolated-fixture', forced: false, naturalQuitVerified: false, outcome: 'already-retired' };
  results.teardown.push(report);
  if (signal('SIGTERM')) {
    const deadline = Date.now() + 3000;
    while (!retired() && Date.now() < deadline) await delay(100);
    report.outcome = 'sigterm-exit';
    if (!retired()) {
      report.forced = signal('SIGKILL');
      report.outcome = report.forced ? 'forced-exit' : 'retired-before-force';
      try { await until(retired, 'forced isolated process cleanup', 5000); }
      catch (error) { report.outcome = 'cleanup-failed'; report.error = error.message; throw error; }
    }
  }
  children.delete(pid);
  processIdentities.delete(pid);
}

function launchDesktop(fixture, uri, scheme) {
  // GIO's child inherits stdout/stderr. Use a real log fd, not a pipe whose EOF
  // would depend on the long-lived Electron process exiting.
  // Exercise the actual desktop association, not `gio launch <entry> <URI>`.
  const log = fs.openSync(path.join(output, scheme + '-desktop.log'), 'a');
  try {
    execFileSync('gio', ['open', uri], { env: fixture.env, stdio: ['ignore', log, log], timeout: 10000 });
  } finally { fs.closeSync(log); }
}

async function urlProof(scheme) {
  // Spaces and literal percent exercise both shell and Desktop Entry Exec quoting.
  const home = path.join(root, 'homes', scheme + ' home %');
  fs.mkdirSync(path.join(home, '.config'), { recursive: true, mode: 0o700 });
  const unrelated = '# unrelated desktop configuration\n[Default Applications]\ntext/plain=keep-editor.desktop;\nx-scheme-handler/unrelated=keep-url.desktop;\n';
  fs.writeFileSync(path.join(home, '.config/mimeapps.list'), unrelated);
  const fixture = install(home);
  const defaults = fs.readFileSync(path.join(home, '.config/mimeapps.list'), 'utf8');
  assert(defaults.includes('text/plain=keep-editor.desktop;'));
  assert(defaults.includes('x-scheme-handler/unrelated=keep-url.desktop;'));
  const nonce = scheme + '-' + process.pid;
  const uri = phase => scheme + '://welinksoftclient/desktop-invalid?desktopProbe=' + nonce + '-' + phase + '&escaped=%2B%26%25%23';
  const cold = uri('cold');
  launchDesktop(fixture, cold, scheme);
  const pid = await until(() => owner(fixture.profile), 'cold singleton owner');
  assert.equal(fs.realpathSync('/proc/' + pid + '/exe'), image + '/electron');
  const coldLog = await until(() => {
    const text = rendererLog(fixture.profile);
    return text.includes(cold) && /registerConsoleEvent, handleConsoleEvent/.test(text) && text.includes('firstPrivacySignState') ? text : null;
  }, scheme + ' cold renderer handler');
  assert(coldLog.includes('registerConsoleEvent'));
  // Upgrade the desktop target while the old image owns this exact profile.
  // Both paths bind the same sealed bytes; the first argv in the real vendor
  // console delivery proves which launcher actually handled the warm invocation.
  install(home, alternateImage);
  const warm = uri('warm');
  launchDesktop(fixture, warm, scheme);
  const warmLog = await until(() => {
    const text = rendererLog(fixture.profile);
    return text.includes(warm) && /ipcRenderer console, handleConsoleEvent/.test(text) ? text : null;
  }, scheme + ' warm renderer handler');
  assert.equal(owner(fixture.profile), pid, 'URL must retain the existing profile process');
  const deliveries = warmLog.split('\n').filter(line => line.includes('registerConsoleEvent console') && line.includes(warm));
  assert.equal(deliveries.length, 1, 'The existing handler must receive each warm URL exactly once');
  assert(deliveries[0].includes(image + '/electron,'), 'A running release must handle activations across an update');
  assert(!deliveries[0].includes(alternateImage + '/electron,'));
  assert(deliveries[0].includes(warm + '&isSecondInstance=true'), 'URL bytes must survive %u and the launcher');
  // A real visible WM window exists, so the old wmctrl early-return bug would
  // have swallowed the URL above. No fixture wmctrl executable is supplied.
  const windows = execFileSync('wmctrl', ['-lp'], { encoding: 'utf8' });
  assert(windows.split('\n').some(line => line.trim().split(/\s+/)[2] === String(pid)), 'The warm URI exercise requires a real WM window');
  execFileSync(fixture.launcher, [], { env: fixture.env, stdio: 'ignore', timeout: 10000 });
  await until(() => {
    const active = /window id # (0x[0-9a-f]+)/i.exec(execFileSync('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { encoding: 'utf8' }));
    return active && windows.split('\n').some(line => {
      const fields = line.trim().split(/\s+/);
      return Number(fields[0]) === Number(active[1]) && fields[2] === String(pid);
    });
  }, 'no-argument focus of the running native profile', 5000);
  fs.writeFileSync(path.join(output, scheme + '-renderer.log'), warmLog);
  results.urls.push({ scheme, cold: true, warm: true, singleton: true, crossReleaseRouting: true, uriBytesPreserved: true, focusOnlyActivation: true,
    consentBoundary: 'real first-run consent remains unchanged' });
  await stop(pid);
}

function inspectorList(port) {
  return new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:' + port + '/json/list', response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.setTimeout(1000, () => request.destroy(new Error('Inspector HTTP deadline')));
    request.on('error', reject);
  });
}
async function connect(port) {
  const targets = await until(async () => {
    try { return await inspectorList(port); }
    catch (error) { if (error.code === 'ECONNREFUSED') return null; throw error; }
  }, 'private main-process inspector');
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await once(socket, 'open');
  let serial = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
    } else events.push(message);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Main-process inspector closed'));
    }
    pending.clear();
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    return reply.result.value;
  }
  return { send, evaluate, events, close: () => socket.close() };
}

async function opacityProof() {
  const home = path.join(root, 'homes/opacity');
  const fixture = install(home);
  const log = fs.openSync(path.join(output, 'opacity-electron.log'), 'w');
  const child = spawn(fixture.launcher, ['--inspect=127.0.0.1:19279', '--disable-gpu',
    'hwwelink://welinksoftclient/desktop-invalid?desktopProbe=opacity'], { env: fixture.env, stdio: ['ignore', log, log] });
  trackProcess(child.pid);
  child.once('exit', () => children.delete(child.pid));
  const inspector = await connect(19279);
  const E = "process.mainModule.require('electron')";
  try {
    await inspector.send('Runtime.enable');
    const main = await until(async () => {
      const windows = await inspector.evaluate(E + '.BrowserWindow.getAllWindows().map(w=>({id:w.id,url:w.webContents.getURL()}))');
      return windows.find(win => win.url.includes('/pedestal/index.html'));
    }, 'real pedestal window');
    const render = expression => inspector.evaluate(E + '.BrowserWindow.fromId(' + main.id + ').webContents.executeJavaScript(' + JSON.stringify(expression) + ')');
    await until(async () => render("!!(window.Pedestal && Pedestal.remote && window.appService)"), 'real renderer platform surface');
    const startup = await render('Pedestal.remote.getGlobal("sharedObject")');
    assert(Array.isArray(startup && startup.prop1), 'The real getGlobal bridge must return startup argv');
    assert.equal(startup.prop1[startup.prop1.length - 1], 'hwwelink://welinksoftclient/desktop-invalid?desktopProbe=opacity');
    await render('Pedestal.startView("ui://im/messageBox", {})');
    const messageBox = await until(async () => {
      const windows = await inspector.evaluate(E + ".BrowserWindow.getAllWindows().map(w=>({id:w.id,viewID:w.viewdef&&w.viewdef.viewID}))");
      return windows.find(win => win.viewID === 'messageBox');
    }, 'actual messageBox BrowserWindow');
    const messageRender = expression => inspector.evaluate(E + '.BrowserWindow.fromId(' + messageBox.id + ').webContents.executeJavaScript(' + JSON.stringify(expression) + ')');
    await until(async () => messageRender('!!(window.Pedestal && Pedestal.remote)'), 'messageBox renderer');
    for (const route of ['current', 'fromId']) {
      for (const value of [0, 0.375, 1]) {
        const expression = route === 'current' ? 'Pedestal.remote.getCurrentWindow().setOpacity(' + value + ')' :
          'Pedestal.remote.BrowserWindow.fromId(' + messageBox.id + ').setOpacity(' + value + ')';
        await messageRender(expression);
        const xid = await inspector.evaluate(E + '.BrowserWindow.fromId(' + messageBox.id + ').getNativeWindowHandle().readUInt32LE(0)');
        const property = execFileSync('xprop', ['-id', '0x' + xid.toString(16), '_NET_WM_WINDOW_OPACITY'], { encoding: 'utf8', timeout: 3000 });
        const match = /\(CARDINAL\) = ([0-9]+)/.exec(property);
        assert(match, property);
        assert.equal(Number(match[1]), Math.round(value * 0xffffffff), 'Read the actual server property independently');
        const actual = await inspector.evaluate(E + '.BrowserWindow.fromId(' + messageBox.id + ').getOpacity()');
        assert(Math.abs(actual - value) <= 1 / 0xffffffff);
        results.opacity.push({ route, value, serverAlpha: Number(match[1]) });
      }
    }
    assert.equal(await messageRender('Pedestal.remote.getCurrentWindow().setOpacity("bad").then(()=>false,()=>true)'), true);
    await inspector.evaluate(E + '.BrowserWindow.fromId(' + messageBox.id + ').destroy()');
    assert.equal(await render('Pedestal.remote.BrowserWindow.fromId(' + messageBox.id + ').setOpacity(1).then(()=>false,()=>true)'), true);
    const traces = fileTree(fixture.profile, name => name.endsWith('.log')).map(file => fs.readFileSync(file, 'utf8')).join('\n');
    assert(!/WindowsOSAPI|AddWindowStyle|MODULE_NOT_FOUND/.test(traces), 'The real Linux operation must not reach a Windows addon');
  } finally {
    inspector.close();
    // This is fixture teardown, not a natural application-exit assertion.
    try { await stop(child.pid); } finally { fs.closeSync(log); }
  }
}

(async () => {
  const selection = fs.existsSync(path.join(root, 'selection')) ? fs.readFileSync(path.join(root, 'selection'), 'utf8').trim() : 'all';
  assert(['all', 'urls', 'opacity'].includes(selection));
  results.selection = selection;
  if (selection !== 'opacity') for (const scheme of ['hwwelink', 'hwwemeeting', 'cloudlink']) await urlProof(scheme);
  if (selection !== 'urls') await opacityProof();
  results.ok = true;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results));
})().catch(error => {
  results.ok = false;
  results.error = error.stack;
  try {
    const processes = [...children].map(pid => {
      try {
        return { pid, executable: fs.readlinkSync('/proc/' + pid + '/exe'),
          argv: fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean) };
      } catch (captureError) { return { pid, captureError: String(captureError.code || captureError) }; }
    });
    fs.writeFileSync(path.join(output, 'failure-processes.json'), JSON.stringify(processes, null, 2) + '\n');
  } catch (captureError) { results.diagnosticsError = captureError.stack; }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2) + '\n');
  console.error(error.stack);
  process.exitCode = 1;
}).finally(async () => {
  const remaining = [...children];
  for (const pid of remaining) {
    try { await stop(pid); }
    catch (error) {
      results.ok = false;
      (results.teardownErrors || (results.teardownErrors = [])).push({ pid, error: error.stack });
      console.error(error.stack);
      process.exitCode = 1;
    }
  }
  if (remaining.length) fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2) + '\n');
});
