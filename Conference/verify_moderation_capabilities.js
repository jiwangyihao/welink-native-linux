#!/usr/bin/env electron
'use strict';
/* Parent-run acceptance in an isolated network namespace and disposable Xvfb.
 * --conference-dir=<assembled native> --web-assets=<pinned provider www>
 * --allow-synthetic-media --output=<json>
 * Uses unchanged production OfflineConference, native GTK consent dialogs,
 * authenticated loopback CMS, actual HRTC and generated Chromium media devices.
 * Web consumer phase loads the original Redux/sagas and supplies explicit local
 * membership fixtures; it does NOT claim an enterprise login or WebRTC admission.
 * No physical camera/microphone, real account, production server or complaint.
 * Needs xdotool, openssl and the same private-network setup as verify_offline_hrtc.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), https = require('node:https');
const crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
const electron = require('electron'), { createPeer } = require('./verify_offline_hrtc_peer');
const args = process.argv.slice(1), option = name => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
assert(electron.app, 'Use the packaged Electron runtime, not ELECTRON_RUN_AS_NODE');
assert(args.includes('--allow-synthetic-media'), 'Explicit consent to generated media is required');
const native = path.resolve(option('conference-dir') || process.env.WELINK_TEST_NATIVE || '');
const assets = option('web-assets') || process.env.WELINK_TEST_WEBASSETS;
assert(assets && path.isAbsolute(assets), 'The pinned provider www --web-assets is required');
assert(fs.existsSync(path.join(native, 'meeting_moderation_capabilities_web.js')), 'Use the assembled feature modules');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-moderation-'));
const output = option('output') || path.join(root, 'result.json');
electron.app.setPath('userData', path.join(root, 'profile'));
electron.app.commandLine.appendSwitch('use-fake-device-for-media-stream');
electron.app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
electron.app.commandLine.appendSwitch('disable-background-networking');
electron.app.commandLine.appendSwitch('disable-component-update');
electron.app.on('window-all-closed', () => {});
const receipts = { scope: 'Isolated provider/CMS/HRTC acceptance, not live enterprise acceptance', stages: [], permissions: [], changes: [] };
let peer, owner, fatal, assetOrigin, assetServer, wsServer, webWindow;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (fatal) throw fatal; const value = await check(); if (value) return value; await sleep(40); }
  throw Error('Timed out: ' + label);
}
function protect(session) {
  session.webRequest.onBeforeRequest((details, callback) => {
    let allowed = /^(file:|blob:|data:)/.test(details.url);
    try { const url = new URL(details.url); allowed ||= [peer?.origin, assetOrigin].some(origin => origin &&
      url.hostname === '127.0.0.1' && url.port === new URL(origin).port && ['https:', 'wss:'].includes(url.protocol)); } catch (_) {}
    callback({ cancel: !allowed });
  });
}
electron.app.on('session-created', protect);
electron.app.on('certificate-error', (event, _contents, url, _error, certificate, done) => {
  let accepted = false;
  try { const target = new URL(url); accepted = target.hostname === '127.0.0.1' &&
    [peer?.origin, assetOrigin].some(origin => origin && new URL(origin).port === target.port) &&
    new crypto.X509Certificate(certificate.data).fingerprint256 === peer?.fingerprint; } catch (_) {}
  if (accepted) event.preventDefault(); done(accepted);
});
async function nativeDialog(accepted) {
  const id = await until(() => {
    try { return execFileSync('xdotool', ['search', '--onlyvisible', '--name', 'WeLink 会议设备同意'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).at(-1); }
    catch (_) { return null; }
  }, 'genuine native device-consent dialog');
  // Native keyboard interaction, not a replacement showMessageBox result.
  execFileSync('xdotool', ['windowactivate', '--sync', id]);
  execFileSync('xdotool', ['key', '--clearmodifiers', ...(accepted ? ['Right', 'Return'] : ['Escape'])]);
}
async function captureMenuConsent(accepted) {
  const operation = owner.configureCapability(3, false);
  const settled = operation.then(value => ({ value }), error => ({ error }));
  await nativeDialog(accepted);
  const result = await settled;
  if (accepted) { if (result.error) throw result.error; assert.equal(result.value.enabled, false); }
  else assert.equal(result.error?.code, 'MICROPHONE_CONSENT_REQUIRED');
  return result.value;
}
const target = 'isolated-moderation-peer';
const invitation = (type, data) => peer.moderation.notify(type, { participantID: owner.getState().participantID,
  inviterParticipantID: target, ...data });
async function offlineAcceptance() {
  const { OfflineConference } = require(path.join(native, 'meeting_offline_session'));
  owner = new OfflineConference({ electron, getConfig: () => peer.config,
    permission: value => { receipts.permissions.push(value); return value === 'media'; },
    notify: event => { if (event.type === 'state') receipts.stages.push(event.state); } });
  for (const type of [0, 2, 4]) receipts.changes.push(await owner.configureCapability(type, false));
  await assert.rejects(owner.configureCapability(3, false), error => error.code === 'OFFLINE_NOT_JOINED');
  let joined = false;
  const joining = owner.join(peer.params, peer.config.watermark, () => true);
  joining.then(() => { joined = true; }, () => {});
  await until(() => owner.getState().state === 'waiting', 'real waiting-room admission');
  assert.equal(joined, false); assert.equal(owner.state().roomJoined === true, false);
  assert.deepEqual(peer.moderation.advertisement.split(','), ['10']);
  const admittedBefore = peer.transcript.filter(frame => frame.operation === 'JOIN_RTC_CONF').length;
  peer.allowWaiting(owner.getState().participantID);
  const result = await joining;
  assert.equal(result.joined, true); assert.equal(owner.state().connection, 'CONNECTED');
  assert(peer.transcript.filter(frame => frame.operation === 'JOIN_RTC_CONF').length > admittedBefore,
    'Waiting-room release must obtain a new genuine grant');
  await until(() => owner.moderationState().participants.some(value => value.participantID === target), 'CMS membership notification');
  assert.equal(owner.moderationState().serverCapabilityAcknowledged, false);
  peer.moderation.role('0', '1');
  await until(() => owner.moderationState().role.cohost, 'server-assigned cohost');
  assert.equal(owner.moderationState().role.canModerate, false, 'Disabled local support must not erase the server role or enable its controls');
  await assert.rejects(owner.moderationControl({ operation: 'microphone', participantID: target, enabled: false }),
    error => error.code === 'HOST_PERMISSION_REQUIRED');
  await owner.configureCapability(0, true);
  const cohostControl = await owner.moderationControl({ operation: 'microphone', participantID: target, enabled: false });
  assert.equal(cohostControl.serverOperationAcknowledged, true);
  assert.equal(cohostControl.membershipChanged, false);
  peer.moderation.role('1');
  await until(() => owner.moderationState().role.host, 'server host role update');
  await owner.moderationControl({ operation: 'cohost', participantID: target, enabled: true });
  await until(() => owner.moderationState().participants.find(value => value.participantID === target)?.role.cohost, 'server cohost echo');
  peer.moderation.refuse(11072008);
  await assert.rejects(owner.moderationControl({ operation: 'cohost', participantID: target, enabled: false }),
    error => error.code === 11072008 || error.code === '11072008');
  assert.equal(owner.moderationState().participants.find(value => value.participantID === target).role.cohost, true,
    'A refusal must not mutate server membership locally');
  peer.moderation.refuse(null);
  await owner.moderationControl({ operation: 'cohost', participantID: target, enabled: false });
  await until(() => !owner.moderationState().participants.find(value => value.participantID === target)?.role.cohost, 'server cohost removal');
  peer.moderation.peerCapabilities('1,4');
  await until(() => owner.active.control.moderationState().participants.length === 2, 'current peer list');
  await sleep(100);
  await assert.rejects(owner.moderationControl({ operation: 'microphone', participantID: target, enabled: true }),
    error => error.code === 'PEER_CONSENT_UNAVAILABLE');
  peer.moderation.peerCapabilities('1,4,10,11,12');
  peer.moderation.role('0');
  await until(() => !owner.moderationState().role.canModerate, 'role revocation');
  const beforeCamera = peer.transcript.length;
  invitation('VIDEO', { status: 1 });
  await until(() => peer.transcript.slice(beforeCamera).some(frame => frame.operation === 'ANSWER_VIDEO' && frame.data.answer === 2), 'disabled camera refusal');
  assert.equal(owner.state().camera, false); assert.equal(owner.active.view.moderationPrompt, null);
  await owner.configureCapability(4, true);
  invitation('VIDEO', { status: 1 });
  await nativeDialog(true);
  await until(() => owner.state().camera && peer.transcript.some(frame => frame.operation === 'ANSWER_VIDEO' && frame.data.answer === 3), 'consented real camera publication');
  await owner.configureCapability(4, false);
  invitation('VIDEO', { status: 0 });
  await until(() => !owner.state().camera && !owner.state().videoPublished, 'forced camera close despite disabled support');
  invitation('MUTE', { isMute: 0 });
  await nativeDialog(false);
  await until(() => peer.transcript.some(frame => frame.operation === 'ANSWER_MUTE' && frame.data.answer === 1), 'genuine microphone refusal');
  assert.equal(owner.state().microphone, false);
  await captureMenuConsent(false);
  assert.equal(owner.moderationState().microphoneConsent, false);
  receipts.changes.push(await captureMenuConsent(true));
  await until(() => !peer.moderation.advertisement.split(',').includes('10'), 'consented reminder-suppression advertisement');
  invitation('MUTE', { isMute: 0 });
  await until(() => owner.state().microphone, 'consented real microphone publication');
  assert.equal(owner.active.view.moderationPrompt, null, 'Per-room opt-in should suppress only the repeated invitation dialog');
  await until(async () => (await owner.active.view.stats()).audio.bytesSent > 0, 'real outgoing RTP after consent');
  await owner.microphoneConsent({ allow: false });
  await owner.setDevice('microphone', false);
  await until(() => peer.moderation.advertisement.split(',').includes('10'), 'revocation restores safe wire reminder support');
  const refusalStart = peer.transcript.length;
  invitation('MUTE', { isMute: 0 });
  await nativeDialog(false);
  await until(() => peer.transcript.slice(refusalStart).some(frame => frame.operation === 'ANSWER_MUTE' && frame.data.answer === 1), 'current refusal after consent revocation');
  assert.equal(owner.state().microphone, false);
  receipts.changes.push(await captureMenuConsent(true));
  // A real local device selection, not a manufactured devicechange event.
  const devices = await owner.active.view.request('devices');
  const microphone = devices.find(value => value.kind === 'audioinput' && value.deviceId);
  assert(microphone, 'No generated microphone device');
  await owner.selectDevice({ kind: 'audioinput', deviceId: microphone.deviceId });
  assert.equal(owner.moderationState().microphoneConsent, false);
  await owner.configureCapability(2, false);
  await owner.setDevice('microphone', true);
  await owner.setDevice('camera', true);
  await until(() => owner.state().microphone && owner.state().camera &&
    owner.state().audioPublished && owner.state().videoPublished, 'generated devices are on before waiting-room removal');
  peer.moveToWaiting(owner.getState().participantID);
  await until(() => owner.getState().state === 'waiting' && !owner.state().roomJoined, 'forced wait must release the actual HRTC room');
  assert.equal(owner.moderationState().microphoneConsent, false);
  const beforeReadmission = peer.transcript.length;
  invitation('MUTE', { isMute: 1 });
  invitation('VIDEO', { status: 0 });
  peer.allowWaiting(owner.getState().participantID);
  await until(() => owner.getState().state === 'joined' && owner.state().roomJoined, 'fresh CMS release and HRTC grant');
  assert.equal(owner.moderationState().microphoneConsent, false);
  const readmission = peer.transcript.slice(beforeReadmission).find(frame => frame.operation === 'JOIN_RTC_CONF');
  assert(readmission, 'Waiting-room release did not obtain a fresh admission');
  assert.equal(readmission.data.mikeState, 1, 'Waiting-room forced close must advertise microphone off on readmission');
  assert.equal(readmission.data.cameraState, 0, 'Waiting-room forced close must advertise camera off on readmission');
  assert.equal(owner.state().microphone, false);
  assert.equal(owner.state().camera, false);
  assert.equal(owner.state().audioPublished, false, 'Readmission must not publish a microphone closed while waiting');
  assert.equal(owner.state().videoPublished, false, 'Readmission must not publish a camera closed while waiting');
  await owner.retire();
  assert.equal(owner.active, null); assert.equal(owner.moderationState().microphoneConsent, false);
  receipts.offline = { genuineCmsAndHrtc: true, nativeConsentDialogs: true, refusalAndRevocation: true,
    forcedCloseAndWaitingApplied: true, roleChangesFromServerOnly: true, transcript: peer.transcript };
}
async function webAcceptance() {
  const WebSocket = require(path.join(native, 'vendor/management/node_modules/ws'));
  const packets = [], token = crypto.randomBytes(24).toString('hex');
  assetServer = https.createServer({ key: fs.readFileSync(path.join(root, 'loopback.key')),
    cert: fs.readFileSync(peer.certPath) }, (request, response) => {
    const pathname = new URL(request.url, 'https://127.0.0.1').pathname;
    const file = path.resolve(assets, pathname.slice('/webrtc/'.length) || 'index.html');
    if (request.method !== 'GET' || !pathname.startsWith('/webrtc/') || !file.startsWith(path.resolve(assets) + path.sep) ||
        !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    fs.createReadStream(file).pipe(response);
  });
  wsServer = new WebSocket.Server({ noServer: true });
  let remote;
  assetServer.on('upgrade', (request, socket, head) => {
    if (request.url !== '/moderation?token=' + token) { socket.destroy(); return; }
    wsServer.handleUpgrade(request, socket, head, peerSocket => wsServer.emit('connection', peerSocket));
  });
  wsServer.on('connection', socket => { remote = socket; socket.on('message', bytes => {
    const packet = JSON.parse(bytes); packets.push(packet);
    if (packet.action === 'ConfControl') socket.send(JSON.stringify({ action: packet.action, type: packet.type,
      sequence: packet.sequence, data: JSON.stringify({ returnCode: packet.type === 'CO_HOST' ? 11072008 : 0 }) }));
  }); });
  await new Promise(resolve => assetServer.listen(0, '127.0.0.1', resolve));
  assetOrigin = 'https://127.0.0.1:' + assetServer.address().port;
  webWindow = new electron.BrowserWindow({ show: true, width: 1000, height: 750,
    webPreferences: { partition: 'moderation-original-provider', sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let permissionCount = 0;
  webWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, done) => { permissionCount++; done(false); });
  webWindow.webContents.session.setPermissionCheckHandler(() => false);
  const evaluate = code => webWindow.webContents.executeJavaScript(code);
  await webWindow.loadURL(assetOrigin + '/webrtc/#/login');
  for (const name of ['meeting_moderation_capabilities.js', 'meeting_moderation_capabilities_web.js'])
    await evaluate(fs.readFileSync(path.join(native, name), 'utf8') + '\n;true');
  await evaluate(`(async () => {
    let load; webpackChunkweb_rtc.push([['local-moderation-acceptance'], {}, value => { load = value; }]);
    await load.e(12);
    const application = load(36176), store = application.store, c = load(62467), actions = load(65113), selectors = load(53765);
    const socket = new WebSocket(${JSON.stringify(assetOrigin.replace('https:', 'wss:') + '/moderation?token=' + token)});
    await new Promise((yes, no) => { socket.onopen = yes; socket.onerror = no; });
    const run = (fn, ...args) => application.sagaMiddleware.run(fn, ...args).toPromise();
    const vendor = { store, sagaMiddleware: application.sagaMiddleware, constants: c, actions, selectors,
      view: load(491), common: load(58909), uuid: load(40904).uuid, getWebsocket: () => socket };
    // Explicit synthetic membership fixtures for the original consumers. No RTC
    // admission, OS permission or server capability acknowledgment is asserted.
    store.dispatch(actions.setConfInitData({ conferenceID: 'local-provider-fixture', participantID: 'self' }));
    store.dispatch(actions.setOwn({ ...selectors.selectOwn(store.getState()), id: 'self', role: c.GUEST }));
    store.dispatch(actions.setParticipants({ self: { pid: 'self', pinfoMap: { NAME: 'Local fixture', ROLE: c.GUEST,
      MUTE: c.MUTE_STATE.MUTE, CAMERASTATE: c.CAMERA_STATE.OFF, IS_COHOST: '0', CLIENT_CAPABILITIES: '1,4,10,11,12' } } }));
    const test = window.moderationTest = { store, c, actions, selectors, run, socket, vendor, opened: 0, errors: [] };
    const guard = test.guard = __welinkCreateModerationCapabilities({ vendor, loadModule: load,
      getSession: () => ({ joined: !!selectors.selectConfInitData(store.getState()).participantID, sessionKey: 'local-consumer-fixture' }),
      async setMedia(kind, enabled) {
        test.opened += enabled ? 1 : 0;
        if (kind === 'microphone') await run(vendor.view.onMuteMicrophoneImpl, { payload: { isMute: enabled ? c.MUTE_STATE.UN_MUTE : c.MUTE_STATE.MUTE } });
        else await run(vendor.view.onSetVideoMuteImpl, { payload: { cameraState: enabled ? c.CAMERA_STATE.ON : c.CAMERA_STATE.OFF } });
        const media = selectors.selectRtc(store.getState()), track = kind === 'microphone' ? media.localStream?.getAudioTrack() : media.localStream?.getVideoTrack();
        if (enabled && (!track || track.readyState !== 'live' || !track.enabled)) throw Object.assign(Error('No provider capture grant'), { code: 'MEDIA_NOT_OPENED' });
      }, onViolation: error => test.errors.push(error.code) });
    const original = load(51361).confWsHandler[c.CONF_MSG_TYPE.LOCAL_CONTROL];
    socket.addEventListener('message', event => {
      const packet = JSON.parse(event.data);
      if (packet.action === c.CONF_MSG_TYPE.LOCAL_CONTROL) run(function* () {
        const selected = yield* guard.incoming(packet); if (selected) yield* original(selected);
      }).catch(error => test.errors.push(error.code));
    });
    test.send = packet => socket.send(JSON.stringify(guard.outgoing(packet)));
    test.configure = (type, enabled) => guard.configure(type, enabled);
    test.answer = (kind, accepted) => store.dispatch(kind === 'microphone' ? load(2500).answerInviteMicrophone({
      answer: accepted ? c.INVITE_MICROPHONE_ANSWER.AGREE : c.INVITE_MICROPHONE_ANSWER.DIS_AGREE, needAnswerCms: true }) :
      load(2500).answerInviteCamera(accepted ? c.INVITE_CAMERA_ANSWER.AGREE : c.INVITE_CAMERA_ANSWER.DIS_AGREE));
    test.savedDispatch = store.dispatch;
    return true;
  })()`);
  const notify = (type, data) => remote.send(JSON.stringify({ action: 'LocalControl', type, sequence: crypto.randomUUID(),
    data: JSON.stringify({ conferenceID: 'local-provider-fixture', participantID: 'self', inviterParticipantID: 'local-host', ...data }) }));
  for (const type of [0, 2, 4]) await evaluate(`moderationTest.configure(${type},false)`);
  await evaluate(`moderationTest.send({action:'Subscribe',sequence:'local-advertisement',data:JSON.stringify({conferenceID:'local-provider-fixture',clientCapabilities:'1,2,4,7,10,11,12,17,18,19'})});true`);
  await until(() => packets.some(value => value.sequence === 'local-advertisement'), 'real local web CMS advertisement');
  assert.equal(JSON.parse(packets.find(value => value.sequence === 'local-advertisement').data).clientCapabilities, '2,7,10,17,18,19');
  assert.equal(await evaluate('moderationTest.guard.state().serverCapabilityAcknowledged'), false);
  notify('VIDEO', { status: 1 });
  await until(() => evaluate('moderationTest.guard.state().pendingInvitations.length===0'), 'disabled camera invitation consumed');
  assert.equal(await evaluate('moderationTest.opened'), 0);
  notify('MUTE', { isMute: 0 });
  await until(() => evaluate('moderationTest.guard.state().pendingInvitations.includes("microphone")'), 'original microphone modal route');
  assert.equal(await evaluate('moderationTest.selectors.selectView(moderationTest.store.getState()).modalState'),
    await evaluate('moderationTest.c.MODAL_STATE.HOST_OPEN_MICROPHONE_MODAL'));
  assert.equal(await evaluate('moderationTest.opened'), 0, 'A host request must not open a device without consent');
  await evaluate('moderationTest.answer("microphone",false);true');
  // Showing a BrowserWindow does not acknowledge keyboard focus under the
  // private window manager. Activate the real window before driving its DOM
  // dialog; do not synthesize clicks or invoke the consent handlers in script.
  execFileSync('xdotool', ['windowactivate', '--sync', String(webWindow.getNativeWindowHandle().readUInt32LE(0))]);
  webWindow.webContents.focus();
  await until(() => evaluate('document.hasFocus()'), 'focused original-provider web window');
  const key = value => execFileSync('xdotool', ['key', '--clearmodifiers', value]);
  const optIn = async label => {
    await evaluate('window.consentResult=null;moderationTest.configure(3,false).then(value=>consentResult={value},error=>consentResult={code:error.code});true');
    await until(() => evaluate('!!document.getElementById("welink-moderation-consent")?.open'), label);
    assert.equal(await evaluate('document.activeElement===document.querySelector("#welink-moderation-consent button")'), true,
      'The genuine scoped opt-in dialog must focus Do not allow by default');
  };
  await optIn('real scoped microphone opt-in dialog');
  key('Return');
  await until(() => evaluate('consentResult?.code'), 'real default-deny opt-in rejection');
  assert.equal(await evaluate('consentResult.code'), 'MICROPHONE_CONSENT_REQUIRED');
  assert.equal(await evaluate('moderationTest.guard.state().microphoneConsent'), false);
  await optIn('genuine consent cancellation dialog');
  key('Escape');
  await until(() => evaluate('consentResult?.code'), 'real opt-in cancellation');
  assert.equal(await evaluate('consentResult.code'), 'MICROPHONE_CONSENT_REQUIRED');
  assert.equal(await evaluate('moderationTest.guard.state().microphoneConsent'), false);
  await optIn('genuine consent acceptance dialog');
  key('Tab');
  await until(() => evaluate('document.activeElement===document.querySelectorAll("#welink-moderation-consent button")[1]'),
    'keyboard-selected explicit consent');
  key('Return');
  await until(() => evaluate('consentResult?.value'), 'trusted local opt-in');
  assert.equal(await evaluate('moderationTest.guard.state().microphoneConsent'), true);
  await evaluate('moderationTest.guard.requestConsent({allow:false})');
  assert.equal(await evaluate('moderationTest.guard.state().microphoneReminder'), true);
  notify('VIDEO', { status: 0 });
  notify('MUTE', { isMute: 1 });
  await sleep(100);
  assert.equal(await evaluate('moderationTest.opened'), 0);
  assert.equal(permissionCount, 0, 'Denied requests unexpectedly reached OS media permission');
  await evaluate('moderationTest.guard.dispose();moderationTest.socket.close();true');
  receipts.web = { originalModules: [51361, 86989, 491, 2500, 62467, 58909], localCmsAdvertisement: true,
    genuineScopedDialog: true, keyboardDefaultDenyAndCancel: true, noImplicitDeviceOpen: true, rtcAdmissionAsserted: false, packets: packets.length };
  webWindow.destroy(); webWindow = null;
}
(async () => {
  try {
    await electron.app.whenReady(); protect(electron.session.defaultSession);
    peer = await createPeer({ electron, conferenceDir: native, directory: root, moderation: true, onFailure: error => { fatal ||= error; } });
    await offlineAcceptance();
    await webAcceptance();
    if (fatal) throw fatal;
    receipts.ok = true; fs.writeFileSync(output, JSON.stringify(receipts, null, 2) + '\n');
  } catch (error) {
    receipts.ok = false; receipts.error = { code: error.code, message: error.message, stack: error.stack };
    fs.writeFileSync(output, JSON.stringify(receipts, null, 2) + '\n'); console.error(error); process.exitCode = 1;
  } finally {
    await owner?.retire().catch(() => {});
    if (webWindow && !webWindow.isDestroyed()) webWindow.destroy();
    if (wsServer) { for (const socket of wsServer.clients) socket.terminate(); wsServer.close(); }
    if (assetServer) await new Promise(resolve => assetServer.close(resolve));
    await peer?.close().catch(() => {});
    electron.app.exit(process.exitCode || 0);
  }
})();
