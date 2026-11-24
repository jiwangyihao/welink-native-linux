#!/usr/bin/env electron
'use strict';

// Staged integration, never run against a user profile/device/service. Use an
// isolated network namespace (private veth 192.0.2.1/24 + 192.0.2.2/24, no default
// route), Xvfb and a paced virtual audio sink, as verify_offline_hrtc.js requires.
// A packaged executable needs this file as a disposable testapp's main.js and
// verify_offline_hrtc_peer.js beside it; passing a script in argv may not load it.
//
// Generate low-risk speech locally, for example with espeak:
//   espeak -s 135 -w synthetic.wav 'This is a generated voice for an isolated test.
//     I will read naturally for this private synthetic meeting and then stop.'
// Run the staged packaged Electron (sandbox ON; no fake permission UI):
//   --app-root=<staged app resources> --allow-synthetic-media \
//   --synthetic-speech-wav=<synthetic.wav> --output=<result.json>
//   --disable-features=WebRtcHideLocalIpsWithMdns --allow-loopback-in-peer-connection
// The production scriptless recorder receives real Chromium input events in
// the isolated window, never injected IPC/PCM, a prewritten print, or a test
// consent bypass. The worker and all three shipped PNR models are genuine.
// Source quality/Windows parity and this scenario's decoded RTP are separate
// claims. This verifier does not assert perfect speaker isolation or live-campus
// acceptance, and logs aggregate energy/state only, never PCM or embeddings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const electron = require('electron');
const { createPeer } = require('./verify_offline_hrtc_peer');
const { verifyGuestVoiceAuthority } = require('./verify_guest_voice_authority');
const args = process.argv.slice(1);
const option = name => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
assert(electron.app, 'Use packaged Electron, without ELECTRON_RUN_AS_NODE');
assert(args.includes('--allow-synthetic-media'), 'Explicit consent to isolated synthetic capture is required');
assert(option('app-root') && option('synthetic-speech-wav'), 'A staged app and explicitly generated speech WAV are required');
const appRoot = fs.realpathSync(option('app-root'));
const conferenceDir = path.join(appRoot, 'native');
const speechPath = fs.realpathSync(option('synthetic-speech-wav'));
const speech = fs.readFileSync(speechPath);
assert.equal(speech.toString('ascii', 0, 4), 'RIFF');
assert.equal(speech.toString('ascii', 8, 12), 'WAVE');
const fixtureHash = crypto.createHash('sha256').update(speech).digest('hex');
speech.fill(0);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-guest-voice-'));
const profile = path.join(directory, 'profile');
fs.mkdirSync(profile, { mode: 0o700 });
electron.app.setPath('userData', profile);
electron.app.commandLine.appendSwitch('use-fake-device-for-media-stream');
electron.app.commandLine.appendSwitch('use-file-for-fake-audio-capture', speechPath);
electron.app.commandLine.appendSwitch('disable-background-networking');
electron.app.commandLine.appendSwitch('disable-component-update');
assert(!electron.app.commandLine.hasSwitch('use-fake-ui-for-media-stream'), 'Do not bypass the production permission gate');
const phases = [], permissions = [], blockedNetwork = [];
let peer, conference, voices, fatal, phase = 'startup', finished = false;
let lastReceiver = null;
const nativeOutput = { samples:0, energy:0, peak:0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stage = name => { phase = name; phases.push(name); console.log('GUEST_VOICE_STAGE ' + name); };
async function until(predicate, description, milliseconds = 20000) {
  const end = Date.now() + milliseconds;
  do {
    if (fatal) throw fatal;
    const value = await predicate();
    if (value) return value;
    await sleep(50);
  } while (Date.now() < end);
  throw Error('Timed out: ' + description + '; phase=' + phase);
}
function protectSession(session) {
  session.webRequest.onBeforeRequest((request, callback) => {
    let allowed = /^(file:|data:|blob:)/.test(request.url);
    try {
      const url = new URL(request.url);
      if (peer && ['https:', 'wss:'].includes(url.protocol) && url.origin === peer.origin) allowed = true;
      if (peer && url.protocol === 'wss:' && url.hostname === '127.0.0.1' && url.port === new URL(peer.origin).port) allowed = true;
    } catch (_) {}
    if (!allowed) blockedNetwork.push(request.url.split('?')[0]);
    callback({ cancel: !allowed });
  });
}
electron.app.on('session-created', protectSession);
electron.app.on('window-all-closed', () => {});
electron.app.on('certificate-error', (event, _contents, url, _error, certificate, callback) => {
  let allowed = false;
  try {
    const parsed = new URL(url);
    allowed = !!peer && ['https:', 'wss:'].includes(parsed.protocol) && parsed.hostname === '127.0.0.1' &&
      parsed.port === new URL(peer.origin).port && new crypto.X509Certificate(certificate.data).fingerprint256 === peer.fingerprint;
  } catch (_) {}
  if (allowed) event.preventDefault();
  callback(allowed);
});
async function click(window, selector) {
  window.show(); window.focus();
  const point = await window.webContents.executeJavaScript(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e || e.disabled || e.hidden) throw Error('Control unavailable');
    e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
}
function recorder() {
  return electron.BrowserWindow.getAllWindows().find(window => !window.isDestroyed() &&
    window.webContents.getURL().includes('/meeting_voice_recorder.html#'));
}
const recorderState = window => window.webContents.executeJavaScript(`({
  state: document.body.dataset.voiceState, recordDisabled: document.getElementById('voice-record').disabled,
  duration: document.getElementById('voice-duration').textContent,
  anonymous: !document.getElementById('voice-anonymous-statement').hidden,
  text: document.getElementById('voice-status').textContent
})`);
async function mediaState() {
  const view = conference.active.view;
  const state = await view.request('voice.state');
  conference.active.mediaState = { ...conference.active.mediaState, voiceProtection: state };
  return state;
}
async function readDecodedReceiverPcm() {
  const element = Array.from(document.querySelectorAll('audio')).find(audio =>
    audio.srcObject?.getAudioTracks().some(track => track.readyState === 'live'));
  if (!element) return { frames:0, energy:0, peak:0 };
  const track = element.srcObject.getAudioTracks()[0];
  let tap = window.guestVoiceReceiverTap;
  if (!tap || tap.track !== track) {
    if (tap) { tap.node.onaudioprocess = null; tap.node.disconnect(); tap.source.disconnect(); await tap.context.close(); }
    const context = new AudioContext({ sampleRate:16000 });
    await context.resume();
    // This observer belongs only to the isolated data: receiver fixture, where
    // AudioWorklet is not exposed. It reads decoded inbound PCM and emits zero;
    // it is not a production uplink fallback, capture device or codec substitute.
    const node = context.createScriptProcessor(2048, 1, 1);
    const source = context.createMediaStreamSource(element.srcObject);
    tap = window.guestVoiceReceiverTap = { track, context, source, node, stats:{frames:0,energy:0,peak:0} };
    node.onaudioprocess = event => {
      event.outputBuffer.getChannelData(0).fill(0);
      const data = event.inputBuffer.getChannelData(0);
      for (const value of data) { tap.stats.energy += value * value; tap.stats.peak = Math.max(tap.stats.peak, Math.abs(value)); }
      tap.stats.frames += data.length;
    };
    source.connect(node).connect(context.destination);
  }
  return { ...tap.stats, context:tap.context.state };
}

async function receiverEnergy() {
  const stats = await peer.stats(true);
  const inbound = stats.rawStats?.find(entry => entry.type === 'inbound-rtp' && entry.kind === 'audio');
  if (stats.packetsReceived > 0) {
    assert(inbound && Number.isFinite(inbound.totalAudioEnergy) && Number.isFinite(inbound.totalSamplesDuration),
      'The receiver must expose actual decoded PCM energy; missing statistics are not silence');
  }
  const decoded = await peer.window.webContents.executeJavaScript('(' + readDecodedReceiverPcm.toString() + ')()');
  return lastReceiver = { energy:decoded.energy, duration:decoded.frames / 16000, decodedFrames:decoded.frames, peak:decoded.peak,
    rtpEnergy:Number(inbound?.totalAudioEnergy) || 0, packets:stats.packetsReceived, bytes:stats.bytesReceived,
    connected:stats.connection === 'connected', audioContext:stats.audioContextState,
    audioTime:stats.audioContextTime, playout:stats.playout };
}
async function requireSilent(description) {
  await sleep(700); // drain already processed network/browser buffers
  const before = await receiverEnergy();
  await sleep(1000);
  const after = await receiverEnergy();
  assert(after.decodedFrames > before.decodedFrames, description + ': no decoded PCM observation');
  assert(after.energy - before.energy < 1e-7, description + ': decoded unprocessed speech leaked');
  return { before, after };
}
async function run() {
  const artifacts = {};
  for (const file of ['meeting_voice_anonymous.js','meeting_voice_host.js','meeting_voice_session.js','meeting_voice_filter.js',
    'meeting_voice_media.js','meeting_voice_recorder.html','meeting_voice_recorder_preload.js',
    'meeting_native_web.js','meeting_native_web_runtime.js','meeting_main.js','meeting_renderer.js','meeting_menu.js',
    'meeting_offline_session.js','meeting_offline_media.js','meeting_offline_preload.js','meeting_offline_window.js',
    'meeting_offline_view.js','meeting_offline.html','vendor/hrtc-12.eb3d2838.js','lib/welink-voice-worker'])
    artifacts[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(conferenceDir, file))).digest('hex');
  for (const [name, file] of [['verify_guest_voice.js', __filename],
    ['verify_guest_voice_authority.js', path.join(__dirname, 'verify_guest_voice_authority.js')],
    ['verify_offline_hrtc_peer.js', path.join(__dirname, 'verify_offline_hrtc_peer.js')]])
    artifacts['verifier/' + name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const { AnonymousVoiceRooms } = require(path.join(conferenceDir, 'meeting_voice_anonymous'));
  const { OfflineConference } = require(path.join(conferenceDir, 'meeting_offline_session'));
  await electron.app.whenReady();
  protectSession(electron.session.defaultSession);
  stage('primary-and-admitted-guest-owner-isolation');
  const authority = await verifyGuestVoiceAuthority({ electron, appRoot });
  voices = new AnonymousVoiceRooms({ electron, appRoot, onError: error => { fatal ||= error; } });
  stage('capability-without-room-is-not-consent');
  const configuration = await voices.configure(true);
  assert.deepEqual([configuration.configured, configuration.type, configuration.enabled, configuration.applied], [true, 7, true, true]);
  assert.equal(configuration.state, 'no-room');
  assert.equal(configuration.armed, false); assert.equal(configuration.processing, false);
  assert.equal(configuration.serverPermissionGranted, false); assert.equal(configuration.osPermissionGranted, false);
  await assert.rejects(voices.show(), error => error.code === 'VOICE_ANONYMOUS_ROOM_REQUIRED');
  peer = await createPeer({ electron, conferenceDir, directory, onFailure: error => { fatal ||= error; } });
  // Activate only the isolated receiver document; never remove the recorder's
  // autoplay/user-input gate or set a global no-user-gesture-required switch.
  peer.window.show(); peer.window.focus();
  peer.window.webContents.sendInputEvent({ type:'mouseDown', button:'left', x:10, y:10, clickCount:1 });
  peer.window.webContents.sendInputEvent({ type:'mouseUp', button:'left', x:10, y:10, clickCount:1 });
  let downgrade = false;
  conference = new OfflineConference({ electron, anonymousVoice: voices,
    getConfig: () => ({ ...peer.config, isServerDowngrade: downgrade }),
    permission: permission => { permissions.push(permission); return permission === 'media'; },
    askDevice: () => false, notify: () => {} });
  stage('anonymous-offline-room-without-capture');
  const joining = conference.join(peer.params, peer.config.watermark, () => true);
  await until(() => conference.getState().state === 'waiting', 'actual local CMS waiting room');
  peer.allowWaiting(conference.getState().participantID);
  assert.equal((await joining).joined, true);
  const firstRoom = voices.room;
  assert.equal(firstRoom.session.account, null);
  assert.equal(firstRoom.session.host.hasEnrollment(), false);
  assert.equal(permissions.length, 0);
  assert.equal((await firstRoom.session.host.bind('never-a-guest-account')).error, 'VOICE_ANONYMOUS_ACCOUNT_FORBIDDEN');
  assert.equal((await firstRoom.session.host.agree(true)).error, 'VOICE_LOCAL_CONSENT_REQUIRED');

  stage('real-ui-enrollment-without-forged-consent');
  await click(conference.window, '#voice-enroll');
  const local = await until(recorder, 'production scriptless recorder');
  const initial = await until(async () => { const state = await recorderState(local); return state.state === 'ready' && state; }, 'recorder readiness');
  assert(initial.anonymous && initial.recordDisabled && /^0\.0/.test(initial.duration));
  const prefs = local.webContents.getLastWebPreferences();
  assert(prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration);
  // Programmatic DOM clicks are not consent or permission.
  await local.webContents.executeJavaScript("document.getElementById('voice-agree').click(); document.getElementById('voice-record').click()");
  await sleep(150);
  assert.equal((await recorderState(local)).recordDisabled, true);
  assert.equal(firstRoom.session.host.hasEnrollment(), false);
  await assert.rejects(conference.setDevice('microphone', true));
  assert.equal((await mediaState()).protected, false);
  const beforeEnrollment = await requireSilent('requested protection before enrollment');
  await click(local, '#voice-agree');
  await until(async () => !(await recorderState(local)).recordDisabled, 'explicit local consent');
  await click(local, '#voice-record');
  await until(async () => (await recorderState(local)).state === 'recording', 'genuine renderer fake-device permission');
  const enrolled = await until(async () => {
    const state = await recorderState(local);
    if (state.state === 'error') throw Error(state.text);
    return state.state === 'enrolled' && state;
  }, 'genuine native PNR enrollment', 140000);
  assert(firstRoom.session.host.hasEnrollment());
  assert.equal(firstRoom.session.account, null);
  assert(!fs.existsSync(path.join(profile, 'native-voice-enrollment')), 'Anonymous biometrics reached persistent account storage');
  const recordMemory = firstRoom.session.host._record; // observation of synthetic fixture memory only
  assert.equal(recordMemory.length, 2384);
  assert(recordMemory.some(byte => byte !== 0));
  assert.equal((await mediaState()).processing, false, 'Enrollment alone claimed microphone processing');
  await click(local, '#voice-cancel');
  await until(() => !recorder(), 'recorder close and capture release');

  stage('genuine-pnr-pcm-through-published-hrtc-and-decoded-receiver');
  await click(conference.window, '.offline-media-controls button');
  await until(async () => (await mediaState()).processing, 'actual processed worklet output', 30000);
  assert(firstRoom.session.filter.active?.ready);
  firstRoom.session.filter.active.child.stdout.on('data', bytes => {
    for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
      const value = bytes.readFloatLE(offset);
      assert(Number.isFinite(value));
      ++nativeOutput.samples; nativeOutput.energy += value * value;
      nativeOutput.peak = Math.max(nativeOutput.peak, Math.abs(value));
    }
  });
  const filteredBefore = await receiverEnergy();
  const filteredAfter = await until(async () => {
    const state = await receiverEnergy();
    return state.connected && state.packets > filteredBefore.packets + 25 &&
      state.decodedFrames > filteredBefore.decodedFrames + 8000 && state.energy > filteredBefore.energy + 0.1 &&
      nativeOutput.samples >= 16000 && nativeOutput.energy > 0.1 && state;
  }, 'nonzero decoded PNR speech at the independent RTP receiver');
  assert(firstRoom.session.filter.active?.ready);
  const oldHandle = firstRoom.session.filter.active.id;

  stage('native-worker-loss-never-falls-back-to-raw');
  firstRoom.session.filter.active.child.kill('SIGKILL');
  await until(async () => (await mediaState()).state === 'blocked', 'visible fail-closed worker loss');
  assert.equal((await mediaState()).protected, false);
  const afterFailure = await requireSilent('native worker failure');
  await assert.rejects(firstRoom.session.process(oldHandle, new Float32Array(640)));

  stage('disable-revokes-and-deletes-before-explicit-unmute');
  await click(conference.window, '#voice-disable');
  await until(() => !firstRoom.session.requested() && !firstRoom.session.host.hasEnrollment(), 'local disable and deletion');
  assert(recordMemory.every(byte => byte === 0));
  const disabled = await until(async () => { const state = await mediaState(); return state.enabled === false && state.stopped && state; }, 'acknowledged media stop');
  await until(async () => conference.window.webContents.executeJavaScript(
    "document.getElementById('voice-state').textContent.startsWith('匿名声纹 / Anonymous voice: available')"),
    'successful user-visible disable acknowledgement');
  assert.equal(disabled.processing, false);
  const afterDisable = await requireSilent('disable without explicit unmute');
  assert.equal(firstRoom.session.filter.active, null);
  assert(!fs.existsSync(path.join(profile, 'native-voice-enrollment')));

  stage('room-retirement-and-downgrade-reentry-cannot-reuse-print');
  await conference.leave();
  assert.equal(voices.state().roomAvailable, false);
  assert.equal(firstRoom.session.current(), false);
  assert.equal(firstRoom.session.host.recordForFilter(), null);
  downgrade = true;
  const next = await conference.join({ ...peer.params, isOfflineJoin: false }, peer.config.watermark, () => true);
  assert.equal(next.joined, true);
  const secondRoom = voices.room;
  assert.notEqual(secondRoom.id, firstRoom.id);
  assert.equal(secondRoom.session.host.hasEnrollment(), false);
  assert.equal(secondRoom.session.requested(), false);
  assert.equal(voices.session(firstRoom.owner), null);
  await voices.configure(false);
  await assert.rejects(voices.show(), error => error.code === 'NATIVE_CAPABILITY_DISABLED');
  await voices.configure(true);
  await click(conference.window, '#voice-enroll');
  const nextRecorder = await until(recorder, 'fresh room statement');
  await until(async () => (await recorderState(nextRecorder)).state === 'ready', 'fresh statement initialization');
  assert.equal((await recorderState(nextRecorder)).recordDisabled, true, 'Consent survived room replacement');
  await click(nextRecorder, '#voice-agree');
  await until(async () => !(await recorderState(nextRecorder)).recordDisabled, 'second-room local consent');
  await click(nextRecorder, '#voice-record');
  await until(async () => (await recorderState(nextRecorder)).state === 'recording', 'pending synthetic capture');
  stage('revocation-during-capture');
  await click(nextRecorder, '#voice-revoke');
  await until(() => !recorder() && !secondRoom.session.requested(), 'capture revocation and recorder destruction');
  assert.equal(secondRoom.session.host.hasEnrollment(), false);
  assert.equal(secondRoom.session.host._workers.size, 0);
  await conference.leave();
  assert.equal(voices.room, null);
  assert(!fs.existsSync(path.join(profile, 'native-voice-enrollment')));
  return { result:'passed', scope:'isolated synthetic anonymous-room enrollment, real PNR, guarded HRTC and decoded RTP; not live enterprise or separation-quality parity',
    fixtureHash, artifacts, phases, permissions, authority, configuration, enrolled: enrolled.state, beforeEnrollment,
    filteredBefore, filteredAfter, nativeOutput, afterFailure, afterDisable, blockedExternalRequests: blockedNetwork,
    persistentBiometrics:false, realDevices:false, realAccounts:false };
}
async function finish(error, report) {
  if (finished) return; finished = true; clearTimeout(watchdog);
  if (error) {
    report = { result:'failed', phase, code:error.code, message:error.message, stack:error.stack, phases, nativeOutput, lastReceiver };
    if (conference?.active?.view?.live()) {
      report.voice = await conference.active.view.request('voice.state').catch(error => ({ error:error.message }));
      report.media = conference.state();
    }
  }
  try {
    if (conference) await Promise.race([conference.retire(), sleep(3000)]);
    if (peer) await peer.close();
  } catch (cleanup) { error ||= cleanup; report.cleanupError = cleanup.message; report.result = 'failed'; }
  try {
    if (option('output')) fs.writeFileSync(path.resolve(option('output')), JSON.stringify(report, null, 2) + '\n', { mode:0o600 });
    console[error ? 'error' : 'log']('GUEST_VOICE_RESULT ' + JSON.stringify(report));
  } finally { fs.rmSync(directory, { recursive:true, force:true }); electron.app.exit(error ? 1 : 0); }
}
const watchdog = setTimeout(() => finish(Error('Guest voice verifier timed out')), 240000);
run().then(report => finish(null, report), error => finish(fatal || error));
