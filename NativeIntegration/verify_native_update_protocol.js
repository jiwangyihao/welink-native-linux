#!/usr/bin/env node
'use strict';
// Parent-run deterministic protocol tests. No application account or network I/O.
const assert = require('assert').strict;
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { verifyManifest, assetUrl, redirectUrl } = require('./update_manifest');
const { download } = require('./update_download');
const { inspectPedestal } = require('./update_readiness');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const context = { version: 'r45.12', current: { build: 'hit-native-linux-ia32-r45.11', version: 'r45.11' }, checkerSha256: 'a'.repeat(64) };
function manifest() {
  return { format: 1, version: 'r45.12', build: 'hit-native-linux-ia32-r45.12', sourceCommit: 'f'.repeat(40),
    installers: [{ base: context.current.build, baseCheckerSha256: context.checkerSha256, asset: 'install-r45.12-from-r45.11.py', size: 3, sha256: 'b'.repeat(64) }],
    integration: { asset: 'install_desktop.py', size: 3, sha256: 'c'.repeat(64) } };
}
function signed(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return { bytes, signature: Buffer.from(crypto.sign(null, bytes, privateKey).toString('base64')) };
}
function verify(value, options = context) {
  const signedValue = signed(value);
  return verifyManifest(signedValue.bytes, signedValue.signature, pem, options);
}
function network(plan) {
  const request = new EventEmitter();
  let response;
  request.setHeader = () => {};
  request.abort = () => { request.aborted = true; request.emit('abort'); };
  request.followRedirect = () => { ++request.followed; deliver(); };
  request.followed = 0;
  function deliver() {
    response = new EventEmitter(); response.statusCode = 200; response.headers = {};
    request.emit('response', response);
    for (const chunk of plan.chunks || [Buffer.from('abc')]) {
      if (request.aborted) return;
      response.emit('data', chunk);
      if (plan.onData) plan.onData();
    }
    if (plan.close) response.emit('close');
    else { response.emit('end'); response.emit('close'); }
  }
  request.end = () => queueMicrotask(() => plan.redirect ? request.emit('redirect', 302, 'GET', plan.redirect) : deliver());
  return { request: options => { request.options = options; return request; }, inspect: request };
}
async function main() {
  assert.equal(verify(manifest()).installer.asset, 'install-r45.12-from-r45.11.py');
  const original = signed(manifest());
  assert.throws(() => verifyManifest(Buffer.concat([original.bytes, Buffer.from('\n')]), original.signature, pem, context), { code: 'ESIGNATURE' });
  const wrongKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => verifyManifest(original.bytes, original.signature, wrongKey, context), { code: 'ESIGNATURE' });
  assert.throws(() => verifyManifest(original.bytes, Buffer.from('not-base64'), pem, context), { code: 'ESIGNATURE' });
  assert.throws(() => verify(Buffer.from([0xff, 0xfe])), { code: 'EPROTO' });
  for (const change of [
    value => { value.version = 'r45.11'; }, value => { value.build = 'hit-native-linux-ia32-r45.13'; },
    value => { value.installers.push(value.installers[0]); }, value => { value.installers[0].asset = '../evil.py'; },
    value => { value.integration.asset = 'evil.py'; }, value => { value.installers[0].size = 0; },
    value => { value.installers[0].size = 1.5; }, value => { value.installers[0].size = Number.MAX_SAFE_INTEGER; },
    value => { value.installers[0].sha256 = '0'; }, value => { value.sourceCommit = '../commit'; }
  ]) { const value = manifest(); change(value); assert.throws(() => verify(value), { code: 'EPROTO' }); }
  assert.throws(() => verify(manifest(), { ...context, checkerSha256: '0'.repeat(64) }), { code: 'EBASE' });
  assert.throws(() => verify(manifest(), { ...context, current: { build: 'hit-native-linux-ia32-r45.12', version: 'r45.12' } }), { code: 'EPROTO' });
  assert.equal(verify(manifest(), { ...context, allowCurrent: true, current: { build: 'hit-native-linux-ia32-r45.12', version: 'r45.12' } }).installer, null);
  const initial = assetUrl(context.version, 'native-update.json');
  for (const value of ['http://github.com/test', 'https://evil.example/test', 'https://github.com/other/repo',
    'https://user:password@release-assets.githubusercontent.com/file', 'https://release-assets.githubusercontent.com:443/file#fragment'])
    assert.throws(() => redirectUrl(value, initial), { code: 'EPROTO' });
  assert.equal(redirectUrl('https://release-assets.githubusercontent.com/file?token=opaque', initial), 'https://release-assets.githubusercontent.com/file?token=opaque');
  const channelUrl = require('./update_config').channelManifest;
  assert.equal(redirectUrl(assetUrl(context.version, 'native-update.json'), channelUrl), assetUrl(context.version, 'native-update.json'));
  assert.throws(() => redirectUrl(assetUrl(context.version, 'install_desktop.py'), channelUrl), { code: 'EPROTO' });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-signed-download-'));
  const filename = path.join(temporary, 'installer.py');
  const options = { url: assetUrl(context.version, 'install-r45.12-from-r45.11.py'), filename, size: 3,
    sha256: crypto.createHash('sha256').update('abc').digest('hex'), session: {} };
  try {
    const values = [], good = network({ chunks: [Buffer.from('a'), Buffer.from('bc')] });
    await download({ ...options, net: good, progress: (done, total) => values.push([done, total]) });
    assert.deepEqual(values, [[1, 3], [3, 3]]);
    assert.equal(fs.readFileSync(filename, 'utf8'), 'abc');
    await assert.rejects(download({ ...options, net: network({}) }), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(filename, 'utf8'), 'abc', 'Exclusive-open failure cannot unlink an existing file');
    fs.unlinkSync(filename);
    for (const [plan, code] of [[{ chunks: [Buffer.from('abd')] }, 'EHASH'], [{ chunks: [Buffer.from('a')] }, 'EHASH'],
      [{ chunks: [Buffer.from('abcd')] }, 'ESIZE'], [{ close: true }, 'ENETWORK'], [{ redirect: 'https://evil.example/install.py' }, 'EPROTO']]) {
      await assert.rejects(download({ ...options, net: network(plan) }), { code });
      assert.equal(fs.existsSync(filename), false, 'Failed downloads cannot remain executable candidates');
    }
    const controller = new AbortController();
    const canceled = network({ chunks: [Buffer.from('a'), Buffer.from('bc')], onData: () => controller.abort() });
    await assert.rejects(download({ ...options, net: canceled, signal: controller.signal }), { code: 'ECANCELED' });
    assert.equal(fs.existsSync(filename), false);
    assert.equal(canceled.inspect.options.credentials, 'omit');
    assert.equal(canceled.inspect.options.useSessionCookies, false);
    const allowed = network({ redirect: 'https://release-assets.githubusercontent.com/file' });
    await download({ ...options, net: allowed });
    assert.equal(allowed.inspect.followed, 1);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  const exports = Object.fromEntries(['middleGroundAjax', 'middleGroundPost', 'downloadUpgradeFile', 'cancelDownloadUpgradeFile'].map(name => [name, () => {}]));
  const scope = { window: { getRoute: () => 'login/LoadingFailed', coreRsHttp: exports, appService: { exitApp() {} } },
    document: { querySelector: () => ({ getBoundingClientRect: () => ({ width: 10, height: 10 }) }) }, location: { hash: '#/login/LoadingFailed' } };
  const probe = () => vm.runInNewContext('(' + inspectPedestal.toString() + ')()', scope);
  assert.equal(probe().mounted, false, 'A complete shell at LoadingFailed cannot count as readiness');
  scope.window.getRoute = () => 'main/im';
  assert.equal(probe().mounted, true);
  scope.window.getRoute = () => 'login/WPFirstTimeAuthentication/empty';
  const controls = new Set(['.single-list-wrap:not(.verification-code) input.list-input', '.verification-code input.list-input', 'button.amu-btn-primary']);
  scope.document.querySelector = selector => controls.has(selector) ? { getBoundingClientRect: () => ({ width: 10, height: 10 }) } : null;
  assert.equal(probe().mounted, true, 'The observed first-time verification form is a working login surface');
  controls.delete('.verification-code input.list-input');
  assert.equal(probe().mounted, false, 'A partial first-time verification shell cannot count as readiness');
  delete scope.window.coreRsHttp.middleGroundPost;
  assert.equal(probe().httpExports.length, 3, 'Missing whole-SDK exports must remain observable');
  console.log(JSON.stringify({ status: 'passed', boundary: 'Deterministic signed manifest/download/readiness predicates; no GUI or live-network evidence.' }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
