#!/usr/bin/env node
'use strict';

// Parent-only genuine surface scenario, on an isolated desktop/profile:
// launch the assembled application with --remote-debugging-port=19249, then
// node verify_native_update_surface.js --port 19249 --expect current --version r45.10
// The verifier invokes the REAL vendor manual-check consumer. Inspect/capture
// the real native dialog, then dismiss it using its Close button. It neither
// supplies a release fixture nor clicks/open-installs anything. Re-run with the
// observed expected status after publication (current for the installed release).
const assert = require('assert').strict;
const http = require('http');
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const port = Number(option('--port'));
const expected = option('--expect');
const version = option('--version');
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Supply an isolated app --port');
assert(['available', 'current', 'no-releases', 'error'].includes(expected), 'Supply --expect available|current|no-releases|error');
assert(/^r45\.[0-9]+$/.test(version || ''), 'Supply the expected installed --version r45.N');
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
      return {platform:process.platform,electron:process.versions.electron,consumer:typeof window.coreUpgrade.checkUpgrade};
    })()`, awaitPromise: true, returnByValue: true });
    assert(!identity.exceptionDetails, JSON.stringify(identity.exceptionDetails));
    assert.equal(identity.result.value.platform, 'linux');
    assert.match(identity.result.value.electron, /^22\./);
    assert.equal(identity.result.value.consumer, 'function');
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
