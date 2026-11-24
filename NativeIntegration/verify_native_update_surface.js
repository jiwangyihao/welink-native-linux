#!/usr/bin/env node
'use strict';

// Parent-only genuine surface scenario, on an isolated desktop/profile:
// launch the assembled application with --remote-debugging-port=19249, then
// node verify_native_update_surface.js --port 19249 --expect current --version r45.11
// The verifier invokes the REAL vendor manual-check consumer. Inspect/capture
// the real native dialog, then dismiss it using its Close button. It neither
// supplies a release fixture nor clicks/open-installs anything. Re-run with the
// observed expected status after publication (current for the installed release).
const assert = require('assert').strict;
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const port = Number(option('--port'));
const expected = option('--expect');
const version = option('--version');
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Supply an isolated app --port');
assert(['available', 'current', 'no-releases', 'error'].includes(expected), 'Supply --expect available|current|no-releases|error');
assert(/^r45\.[0-9]+$/.test(version || ''), 'Supply the expected installed --version r45.N');
const action = option('--action') || 'check';
assert(['check', 'install', 'cancel'].includes(action), 'Supply --action check|install|cancel');
const profile = option('--profile');
const targetVersion = option('--target');
const updatesDirectory = option('--updates-dir') || path.join(os.homedir(), '.local/state/welink-native-updates');
if (action !== 'check') {
  assert(expected === 'available' && /^r45\.[0-9]+$/.test(targetVersion || ''), 'Install/cancel needs --expect available --target r45.N');
  assert(profile && path.isAbsolute(profile) && fs.realpathSync(profile) === profile, 'Supply the exact current canonical --profile');
}
function directoryNames() { try { return new Set(fs.readdirSync(updatesDirectory)); } catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; } }
function integrationHashes() {
  const home = os.homedir();
  const files = ['.local/bin/hit-welink-native', '.local/share/applications/cn.edu.hit.welink.native.desktop',
    '.local/share/applications/hit-welink-native.desktop', '.config/mimeapps.list', '.local/share/applications/mimeapps.list'];
  return files.map(name => { try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(home, name))).digest('hex'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; } });
}
async function observeTransaction(before, baselineHashes) {
  const deadline = Date.now() + 35 * 60 * 1000;
  let directory;
  while (Date.now() < deadline) {
    if (!directory) {
      const candidates = [...directoryNames()].filter(name => !before.has(name) && name.startsWith('transaction-')).map(name => path.join(updatesDirectory, name));
      for (const candidate of candidates) {
        try {
          const request = JSON.parse(fs.readFileSync(path.join(candidate, 'request.json'), 'utf8'));
          const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'native-update.json'), 'utf8'));
          if (request.profile === profile && manifest.version === targetVersion) {
            assert(!directory, 'More than one matching transaction appeared'); directory = candidate;
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    if (directory) {
      let status;
      try { status = JSON.parse(fs.readFileSync(path.join(directory, 'status.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (status && ['complete', 'failed', 'canceled'].includes(status.phase)) {
        const request = JSON.parse(fs.readFileSync(path.join(directory, 'request.json'), 'utf8'));
        if (action === 'cancel') {
          assert.equal(status.phase, 'canceled', status.error);
          assert.deepEqual(integrationHashes(), baselineHashes, 'Canceled update changed integration/defaults');
          assert.equal(fs.existsSync('/proc/' + request.oldPid), true, 'Cancellation must leave the old app running');
          assert.equal(fs.existsSync(path.join(directory, 'readiness.json')), false);
          return { phase: status.phase, oldPid: request.oldPid };
        }
        assert.equal(status.phase, 'complete', status.error);
        const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'readiness.json'), 'utf8'));
        assert.equal(receipt.token, request.token);
        assert.equal(receipt.status, 'ready');
        assert.equal(receipt.profile, profile);
        assert.equal(receipt.build, 'hit-native-linux-ia32-' + targetVersion);
        assert(['/main/im', '/login/Auth2Login/Webview', '/login/LoginPage'].includes(receipt.route));
        const executable = fs.readlinkSync('/proc/' + receipt.pid + '/exe');
        assert.equal(executable, path.join(path.dirname(path.dirname(request.baseImage)), 'hit-welink-native-' + targetVersion, 'image/electron'));
        assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(executable), 'resources/app/native/build.json'), 'utf8')).build, receipt.build);
        assert.equal(fs.existsSync('/proc/' + request.oldPid), false, 'Old application must have really exited');
        return { phase: status.phase, pid: receipt.pid, build: receipt.build, route: receipt.route, mounted: receipt.mounted };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('The genuine update transaction did not complete before the scenario deadline');
}
assert.equal(typeof WebSocket, 'function', 'Use Node 22+ for the inspection transport');

function targets() {
  return new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:' + port + '/json/list', response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('DevTools target listing failed: ' + response.statusCode)); return; }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', text => { body += text; if (body.length > 1024 * 1024) request.destroy(new Error('Oversized target list')); });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
      response.on('error', reject);
    });
    request.setTimeout(10000, () => request.destroy(new Error('DevTools target listing timed out')));
    request.on('error', reject);
  });
}

async function main() {
  const found = (await targets()).filter(target => target.type === 'page' && /^file:/.test(target.url) && /\/pedestal\/index\.html(?:[?#]|$)/.test(target.url));
  assert.equal(found.length, 1, 'Expected one canonical pedestal renderer in the isolated application');
  const target = found[0];
  const wsUrl = new URL(target.webSocketDebuggerUrl);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(wsUrl.hostname), 'Only a loopback DevTools socket is allowed');
  const socket = new WebSocket(wsUrl);
  let next = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('DevTools connection closed')); }
    pending.clear();
  });
  function send(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out; dismiss the real native update dialog')); }, timeout);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DevTools connection timed out')), 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DevTools connection failed')); }, { once: true });
    });
    // The debugging port opens before the vendor finishes registering its modules.
    const identity = await send('Runtime.evaluate', { expression: `(async () => {
      const deadline = Date.now() + 20000;
      while (!window.coreUpgrade || typeof window.coreUpgrade.checkUpgrade !== "function") {
        if (Date.now() >= deadline) throw new Error("The real upgrade consumer did not initialize");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const httpDownload = await window.coreRsHttp.downloadUpgradeFile({versionDownloadUrl:"https://example.invalid/WindowsPackage.exe"}).then(
        () => { throw new Error("The real shared HTTP SDK attempted a Windows update"); },
        error => { if (error.code !== "ENOTSUP") throw error; return error.code; });
      return {platform:process.platform,electron:process.versions.electron,consumer:typeof window.coreUpgrade.checkUpgrade,httpDownload,route:location.hash};
    })()`, awaitPromise: true, returnByValue: true });
    assert(!identity.exceptionDetails, JSON.stringify(identity.exceptionDetails));
    assert.equal(identity.result.value.platform, 'linux');
    assert.match(identity.result.value.electron, /^22\./);
    assert.equal(identity.result.value.consumer, 'function');
    assert.equal(identity.result.value.httpDownload, 'ENOTSUP');
    if (action !== 'check') {
      const before = directoryNames(), baselineHashes = integrationHashes();
      console.log('Choose Download, update and restart in the REAL native dialog.' +
        (action === 'cancel' ? ' Then choose Cancel update in the REAL progress window during staging.' : ' Observe download/staging/authorization; allow the normal exit flow.'));
      const invoked = send('Runtime.evaluate', {
        expression: 'window.coreUpgrade.checkUpgrade({entry:"native-signed-update-gui-acceptance",isUserClick:true})',
        awaitPromise: true, returnByValue: true
      }, 35 * 60 * 1000).catch(error => {
        if (action === 'install' && /DevTools connection closed/.test(error.message)) return null;
        throw error;
      });
      const [transaction, consumer] = await Promise.all([observeTransaction(before, baselineHashes), invoked]);
      if (consumer) {
        assert(!consumer.exceptionDetails, JSON.stringify(consumer.exceptionDetails));
        if (action === 'install') assert.equal(consumer.result.value.action, 'restart-required');
        else assert.equal(consumer.result.value.error.code, 'ECANCELED');
      }
      console.log(JSON.stringify({ status: 'passed', action, transaction,
        boundary: 'Real vendor consumer, native controls, signed GitHub download, real supervisor and actual new process/route; no account actions.' }));
      return;
    }
    console.log('Invoking the live native update check. Inspect/capture the real dialog, then choose Close.');
    const evaluated = await send('Runtime.evaluate', {
      expression: 'window.coreUpgrade.checkUpgrade({entry:"native-release-surface-verification",isUserClick:true})', awaitPromise: true, returnByValue: true
    }, 180000);
    assert(!evaluated.exceptionDetails, JSON.stringify(evaluated.exceptionDetails));
    const result = evaluated.result.value;
    assert(result, 'The real consumer did not return an update receipt');
    assert.equal(result.status, expected);
    assert.equal(result.current.build, 'hit-native-linux-ia32-' + version);
    assert.equal(result.current.version, version);
    if (expected === 'error') assert(result.error && result.error.code, 'Error outcome must remain explicit');
    else assert.equal(result.action, 'dismissed', 'Choose Close; this verification does not authorize browser launch or installation');
    if (result.latest) assert.equal(result.latest.url, 'https://github.com/jiwangyihao/welink-native-linux/releases/tag/' + result.latest.version);
    console.log(JSON.stringify({ status: 'passed', target: target.url, electron: identity.result.value.electron,
      result, boundary: 'Genuine running Electron consumer, GitHub request and native dialog; no account/message/meeting actions.' }));
  } finally { socket.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
