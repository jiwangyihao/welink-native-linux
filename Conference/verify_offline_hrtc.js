#!/usr/bin/env electron
'use strict';

// Standalone positive integration: real packaged OfflineConference -> isolated
// CMS -> real packaged sandboxed renderer -> unchanged HRTC 1.10.96 -> local
// WSS/ICE/DTLS/SRTP counterpart. No SDK injection, fake roomJoined, external
// service, enterprise credentials, physical capture, or shared desktop.
//
// Run in an isolated network/mount namespace and Xvfb, NOT ELECTRON_RUN_AS_NODE.
// Dependencies: image Electron, packaged Conference modules/vendor (including
// management/node_modules/ws), openssl, and a disposable profile. No npm install.
// A script-loading Electron launcher accepts:
//   <electron> Conference/verify_offline_hrtc.js \
//     --conference-dir=<image's packaged Conference module directory> \
//     --allow-synthetic-media --output=/tmp/offline-hrtc-result.json
// A packaged executable instead runs resources/app/package.json's main entry:
// bind-mount a disposable testapp there, copy this file as main.js with its peer
// companion, and pass only the flags. A script pathname in argv is insufficient.
// Give the isolated namespace a private veth pair (192.0.2.1/24, 192.0.2.2/24)
// with NO external interface/default route. Test-only Chromium flags:
// --disable-features=WebRtcHideLocalIpsWithMdns --allow-loopback-in-peer-connection
// Keep the sandbox enabled. Do not use an unpaced ALSA-null sink for tone proof.
// --allow-synthetic-media consents to the generated 375 Hz WAV, peer's 1500 Hz
// track and canvas test pattern. Physical camera/microphone capture is not used.
// The report is isolated-protocol acceptance, NOT live enterprise acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const electron = require('electron');
const { createPeer } = require('./verify_offline_hrtc_peer');
const PINNED_HRTC = 'ac223517d8cd516c2113181a5035093c9f30680380a61c518d08e79fd6c535f4';
const args = process.argv.slice(1);
const option = name => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
if (args.includes('--help')) {
  console.log('Run with packaged Electron in an isolated Xvfb/audio session: verify_offline_hrtc.js --conference-dir=<packaged Conference directory> --allow-synthetic-media [--output=<result.json>]');
  if (electron.app) electron.app.exit(0); else process.exit(0);
}
assert(electron.app, 'Use the packaged Electron runtime, without ELECTRON_RUN_AS_NODE');
assert(args.includes('--allow-synthetic-media'), 'Synthetic media requires explicit --allow-synthetic-media consent');
assert(option('conference-dir'), 'The real packaged --conference-dir is required; no source-tree fallback');
const conferenceDir = path.resolve(option('conference-dir'));
const outputPath = option('output') && path.resolve(option('output'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-isolated-hrtc-'));
const wavPath = path.join(directory, 'synthetic-375hz.wav');
function writeTone() {
  const rate = 48000, count = rate * 8, bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; ++i) bytes.writeInt16LE(Math.round(7000 * Math.sin(2 * Math.PI * 375 * i / rate)), 44 + i * 2);
  fs.writeFileSync(wavPath, bytes, { mode: 0o600 });
}
writeTone();
electron.app.setPath('userData', path.join(directory, 'profile'));
electron.app.commandLine.appendSwitch('use-fake-device-for-media-stream');
electron.app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wavPath);
electron.app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
electron.app.commandLine.appendSwitch('disable-background-networking');
electron.app.commandLine.appendSwitch('disable-component-update');
// Do not use --use-fake-ui-for-media-stream: the production permission handler
// must still ask this explicitly consenting owner before the synthetic capture.
const states = [], permissions = [], blockedNetwork = [], consoleErrors = [], phases = [];
let peer, owner, fatal, phase = 'startup';
const stage = name => { phase = name; phases.push(name); console.log('OFFLINE_HRTC_STAGE ' + name); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (fatal) throw fatal;
    const value = await predicate();
    if (value) return value;
    await sleep(40);
  }
  throw Error('Timed out waiting for ' + description + '; phase=' + phase + '; states=' + JSON.stringify(states.slice(-6)));
}
function protectSession(session) {
  session.webRequest.onBeforeRequest((details, callback) => {
    let allowed = /^(file:|data:|blob:)/.test(details.url);
    try {
      const url = new URL(details.url);
      if (peer && ['https:', 'wss:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.port === new URL(peer.origin).port) allowed = true;
    } catch (_) {}
    if (!allowed) blockedNetwork.push({ method: details.method, type: details.resourceType, url: details.url.split('?')[0] });
    callback({ cancel: !allowed });
  });
}
electron.app.on('session-created', protectSession);
electron.app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, level, message) => {
    if (level >= 2) consoleErrors.push(String(message).slice(0, 1200));
  });
});
electron.app.on('certificate-error', (event, _contents, url, _error, certificate, callback) => {
  let accepted = false;
  try {
    const parsed = new URL(url);
    accepted = !!peer && ['https:', 'wss:'].includes(parsed.protocol) && parsed.hostname === '127.0.0.1' &&
      parsed.port === new URL(peer.origin).port && new crypto.X509Certificate(certificate.data).fingerprint256 === peer.fingerprint;
  } catch (_) {}
  if (accepted) event.preventDefault();
  callback(accepted);
});
electron.app.on('window-all-closed', event => event?.preventDefault());

// Read-only observation of the actual SDK-created remote media element. It
// neither replaces a browser API nor touches HRTC/client/room/application state.
async function measureRemoteTone() {
  const deadline = performance.now() + 12000;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let media;
  while (performance.now() < deadline) {
    media = [...document.querySelectorAll('.offline-media-remote audio, .offline-media-remote video')]
      .find(element => element.srcObject?.getAudioTracks().some(track => track.readyState === 'live'));
    if (media) break;
    await sleep(40);
  }
  if (!media) throw Error('The packaged HRTC renderer did not attach a live remote audio track');
  const context = new AudioContext({ sampleRate: 48000 });
  await context.resume();
  const source = context.createMediaStreamSource(media.srcObject), analyser = context.createAnalyser();
  const silent = context.createGain(); silent.gain.value = 0;
  analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0;
  source.connect(analyser).connect(silent).connect(context.destination);
  const bins = new Float32Array(analyser.frequencyBinCount);
  let consecutive = 0, last;
  try {
    while (performance.now() < deadline) {
      await sleep(60); analyser.getFloatFrequencyData(bins);
      const band = hz => {
        const at = Math.round(hz * analyser.fftSize / context.sampleRate);
        const value = Math.max(...bins.slice(at - 1, at + 2));
        return Number.isFinite(value) ? value : -160;
      };
      last = { signalDb: band(1500), otherDb: band(375), expectedHz: 1500,
        liveAudioTracks: media.srcObject.getAudioTracks().filter(track => track.readyState === 'live').length };
      consecutive = last.signalDb > -65 && last.signalDb > last.otherDb + 16 ? consecutive + 1 : 0;
      if (consecutive === 3) return last;
    }
    throw Error('No decoded peer tone in packaged media: ' + JSON.stringify(last));
  } finally { source.disconnect(); analyser.disconnect(); silent.disconnect(); await context.close(); }
}

async function run() {
  const artifacts = {};
  for (const file of ['meeting_offline_session.js', 'meeting_offline_control.js', 'meeting_offline_transport.js',
    'meeting_offline_window.js', 'meeting_offline_preload.js', 'meeting_offline_view.js', 'meeting_offline_media.js',
    'meeting_offline.html', 'vendor/hrtc-12.eb3d2838.js']) {
    artifacts[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(conferenceDir, file))).digest('hex');
  }
  assert.equal(artifacts['vendor/hrtc-12.eb3d2838.js'], PINNED_HRTC, 'The packaged HRTC vendor bytes changed');
  const { OfflineConference } = require(path.join(conferenceDir, 'meeting_offline_session'));
  await electron.app.whenReady();
  protectSession(electron.session.defaultSession);
  peer = await createPeer({ electron, conferenceDir, directory, onFailure: error => { fatal ||= error; } });
  owner = new OfflineConference({ electron, parentWindow: undefined, getConfig: () => peer.config,
    permission: permission => { permissions.push(permission); return permission === 'media'; },
    askDevice: () => false,
    notify: event => {
      if (event.type === 'state') states.push({ state: event.state, participantID: event.participantID, error: event.error?.code });
    } });
  const isCurrent = () => true;
  stage('unauthorized-invitation');
  await assert.rejects(owner.join({ ...peer.params, random: 'not-issued-by-this-isolated-peer' }, peer.config.watermark, isCurrent),
    error => error.code === 414100006);
  assert.equal(peer.transcript.some(frame => frame.channel === 'rtc'), false, 'A refused invitation reached HRTC');
  assert.equal(permissions.length, 0, 'Rejected admission opened capture');

  stage('waiting-without-media');
  let joined = false;
  const joining = owner.join(peer.params, peer.config.watermark, isCurrent);
  joining.then(() => { joined = true; }, () => {});
  await until(() => owner.getState().state === 'waiting', 'CMS waiting room');
  assert.notEqual(owner.state().roomJoined, true);
  assert.equal(joined, false);
  assert.equal(peer.transcript.some(frame => frame.channel === 'rtc'), false, 'Waiting room opened media before release');
  assert.equal(permissions.length, 0);

  stage('admission-and-correlated-membership');
  peer.holdJoinNotify(true);
  peer.allowWaiting(owner.getState().participantID);
  await until(() => peer.pending.notify, 'real HRTC JOIN followed by JoinConfNotify', 25000);
  assert.equal(owner.state().roomJoined, true, 'HRTC join did not confirm its room');
  assert.equal(owner.state().joined, false, 'CMS membership was published before JoinConfNotify response');
  assert.equal(joined, false);
  peer.releaseJoinNotify(); peer.holdJoinNotify(false);
  const receipt = await joining;
  assert.equal(receipt.joined, true);
  assert.equal(receipt.media.source, 'offline-hrtc');
  assert.equal(owner.state().joined, true);
  assert.equal(receipt.media.microphone, false);
  assert.equal(receipt.media.camera, false);
  assert.equal(permissions.length, 0);
  const productionView = owner.active.view;
  assert(productionView.live());
  assert(productionView.window.webContents.getURL().endsWith('/meeting_offline.html'));
  const preferences = productionView.window.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);

  stage('actual-uplink-rtp-and-decoded-tone');
  const published = await owner.setDevice('microphone', true);
  assert.equal(published.microphone, true); assert.equal(published.audioPublished, true); assert.equal(published.camera, false);
  assert(permissions.includes('media'), 'The production permission gate was not consulted');
  let uplinkWins = 0;
  const uplink = await until(async () => {
    const stats = await peer.stats();
    uplinkWins = stats.connection === 'connected' && stats.packetsReceived > 5 && stats.bytesReceived > 0 &&
      stats.uplinkToneDb > -65 && stats.uplinkToneDb > stats.otherToneDb + 16 ? uplinkWins + 1 : 0;
    return uplinkWins >= 3 && stats;
  }, 'decoded 375 Hz audio arriving from the real HRTC publisher');
  assert.equal(uplink.uplinkSsrc, 200000);
  assert(uplink.selectedCandidatePairs > 0);

  stage('actual-downlink-subscription-and-decoded-tone');
  peer.announceAudio();
  const downlink = await productionView.window.webContents.executeJavaScript('(' + measureRemoteTone.toString() + ')()');
  const sdkStats = await until(async () => {
    const value = await productionView.stats();
    return value.audio.bytesSent > 0 && value.audio.packetsSent > 0 && value.audio.bytesReceived > 0 && value.audio.packetsReceived > 0 && value;
  }, 'SDK RTCRtpSender and RTCRtpReceiver counters');
  const peerStats = await peer.stats();
  assert.equal(peerStats.downlinkSsrc, 100003);
  assert(peerStats.packetsSent > 0 && peerStats.bytesSent > 0);
  assert(owner.state().remoteStreams > 0, 'The host did not receive subscribed-stream state');

  stage('device-off-and-waiting-room-retirement');
  const muted = await owner.setDevice('microphone', false);
  assert.equal(muted.microphone, false); assert.equal(muted.audioPublished, false);
  const oldSession = peer.currentSession;
  peer.moveToWaiting(owner.getState().participantID);
  await until(() => owner.getState().state === 'waiting', 'move-to-waiting disposal');
  assert.equal(owner.state().joined, false); assert.equal(owner.state().roomJoined, false);
  assert.equal(oldSession.closed, true, 'Waiting-room transition did not send HRTC BYE');
  await until(() => oldSession.socket.readyState === 3, 'actual SDK signaling socket closure');
  assert.deepEqual(await peer.stats(), { closed: true });
  peer.allowWaiting(owner.getState().participantID);
  await until(() => owner.getState().state === 'joined', 'fresh admission after waiting release', 25000);
  assert.equal(owner.state().joined, true);
  assert.notEqual(peer.currentSession.id, oldSession.id);
  assert.equal(owner.state().microphone, false, 'Waiting-room reentry reopened a muted device');

  stage('leave-awaits-control-and-media-retirement');
  peer.holdLeave(true);
  let leaveSettled = false;
  const leaving = owner.leave();
  leaving.then(() => { leaveSettled = true; }, () => {});
  await until(() => peer.pending.leave && peer.currentSession.closed, 'HRTC BYE and held CMS leave');
  assert.equal(leaveSettled, false, 'Leave resolved before correlated CMS confirmation');
  assert.equal(owner.state().joined, false);
  peer.releaseLeave(); peer.holdLeave(false);
  assert.equal((await leaving).left, true);
  assert.equal(owner.window, null);

  stage('cancel-during-admission-does-not-leak-membership');
  peer.holdAdmission(true);
  const rtcCount = peer.transcript.filter(frame => frame.channel === 'rtc' && frame.operation === 'upgrade').length;
  const late = owner.join(peer.params, peer.config.watermark, isCurrent);
  const lateRejected = assert.rejects(late, error => error.code === 'OFFLINE_JOIN_CANCELLED' || error.code === 'OFFLINE_RETIRED');
  await until(() => peer.pending.join, 'held correlated CMS admission');
  const cancelled = owner.leave();
  peer.releaseAdmission(); peer.holdAdmission(false);
  await lateRejected;
  assert.equal((await cancelled).left, true);
  assert.equal(peer.transcript.filter(frame => frame.channel === 'rtc' && frame.operation === 'upgrade').length, rtcCount);
  assert.equal(owner.window, null);
  if (fatal) throw fatal;
  return { result: 'passed', scope: 'isolated packaged HRTC/CMS protocol and actual bidirectional audio; not live enterprise acceptance',
    sdk: '1.10.96', electron: process.versions.electron, chromium: process.versions.chrome, conferenceDir,
    artifacts, phases, permissions, states, uplink, downlink, sdkStats, peerStats, transcript: peer.transcript,
    blockedExternalRequests: blockedNetwork, consoleErrors };
}
let finished = false;
async function finish(error, report) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (error) report = { result: 'failed', phase, code: error.code, message: error.message, stack: error.stack,
    phases, states, transcript: peer?.transcript, blockedExternalRequests: blockedNetwork, consoleErrors };
  try {
    if (error && peer?.currentSession) {
      report.peerDiagnostics = await peer.stats(true).catch(value => ({ error: value.message }));
      if (owner?.active?.view?.live())
        report.sdkDiagnostics = await owner.active.view.stats().catch(value => ({ error: value.message }));
    }
    if (owner) await Promise.race([owner.retire().catch(() => {}), sleep(2000)]);
    if (peer) await Promise.race([peer.close(), sleep(3000)]);
    if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console[error ? 'error' : 'log']('OFFLINE_HRTC_RESULT ' + JSON.stringify(report));
  } catch (cleanupError) { console.error(cleanupError.stack); error ||= cleanupError; }
  finally { fs.rmSync(directory, { recursive: true, force: true }); electron.app.exit(error ? 1 : 0); }
}
const watchdog = setTimeout(() => finish(Error('Isolated verifier watchdog expired in ' + phase)), 120000);
run().then(report => finish(null, report), error => finish(fatal || error));
