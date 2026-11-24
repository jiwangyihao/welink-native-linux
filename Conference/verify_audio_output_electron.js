#!/usr/bin/env electron
'use strict';

// Genuine Chromium media-sink completion on the sealed ia32 runtime. No account,
// cloud meeting, microphone/camera capture or audible playback is asserted.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { X509Certificate } = require('crypto');
const { app, BrowserWindow, session } = require('electron');
const { provision } = require('./verify_meeting_management');
const native = process.env.WELINK_TEST_NATIVE;
const output = process.env.WELINK_TEST_OUTPUT;
if (!native || !output || !path.isAbsolute(native) || !path.isAbsolute(output))
  throw new Error('Use the sealed-runtime acceptance environment');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-audio-output-'));
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});

(async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'ia32');
  await app.whenReady();
  const certificate = provision(root);
  const fingerprint = new X509Certificate(certificate.cert).fingerprint256;
  const helper = fs.readFileSync(path.join(native, 'meeting_audio_output.js'));
  let window, permissions = 0, blockedNetwork = 0;
  const sockets = new Set();
  const server = https.createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><title>Isolated audio output acceptance</title><h1>Actual media sink API</h1><script src="/audio-output.js"></script>');
    } else if (request.url === '/audio-output.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(helper);
    } else { response.writeHead(404); response.end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = 'https://127.0.0.1:' + server.address().port;
  const isolated = session.fromPartition('audio-output-' + path.basename(root), { cache: false });
  isolated.setCertificateVerifyProc((request, done) => {
    let valid = false;
    try { valid = request.hostname === '127.0.0.1' && new X509Certificate(request.certificate.data).fingerprint256 === fingerprint; } catch (_) {}
    done(valid ? 0 : -3);
  });
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_contents, _permission, done) => { permissions++; done(false); });
  isolated.webRequest.onBeforeRequest((details, done) => {
    const allowed = details.url.startsWith(origin + '/');
    if (!allowed) blockedNetwork++;
    done({ cancel: !allowed });
  });
  try {
    window = new BrowserWindow({ show: true, width: 520, height: 260,
      webPreferences: { session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true } });
    await window.loadURL(origin + '/');
    const result = await window.webContents.executeJavaScript(`(async () => {
      if (!isSecureContext || typeof HTMLMediaElement.prototype.setSinkId !== 'function')
        throw new Error('The real Chromium sink-selection API is unavailable');
      const audio = document.createElement('audio');
      audio.muted = true;
      document.body.append(audio);
      try {
        const selected = await WelinkAudioOutput.apply({ elements: [audio], deviceId: '', ensureCurrent() {} });
        if (!selected.verified || selected.sinkCount !== 1 || audio.sinkId !== '')
          throw new Error('The actual default sink did not complete');
        let failure;
        try { await WelinkAudioOutput.apply({ elements: [audio], deviceId: 'welink-nonexistent-' + crypto.randomUUID(), ensureCurrent() {} }); }
        catch (error) { failure = { code: error.code, details: error.details }; }
        if (!failure || failure.code !== 'AUDIO_OUTPUT_SELECTION_FAILED' || failure.details.causeName !== 'NotFoundError')
          throw new Error('An unavailable real sink was not rejected by Chromium');
        if (audio.sinkId !== '') throw new Error('A rejected route changed the actual selected sink');
        return { defaultSinkCompleted: true, unavailableSinkRejected: true, retainedSink: 'system-default', causeName: failure.details.causeName };
      } finally { audio.remove(); }
    })()`, true);
    assert.equal(permissions, 0, 'Output receipt acceptance must not enable capture or grant permissions');
    assert.equal(blockedNetwork, 0);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, ...result, permissionRequests: permissions,
      scope: 'Actual Chromium output-sink API; no hardware capture, audible output, cloud meeting or HRTC transport claim.' }, null, 2) + '\n', { mode: 0o600 });
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    isolated.webRequest.onBeforeRequest(null);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
})().then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1); });
