#!/usr/bin/env electron
'use strict';
/* Parent-run acceptance on the packaged Electron, in an isolated network namespace.
 * WELINK_TEST_NATIVE: assembled resources/app/native; WELINK_TEST_WEBASSETS: pinned
 * main.3ee85ed7.js/606.616fb575 provider www tree; WELINK_TEST_OUTPUT: existing output dir.
 * Real campus facade, native auth configuration, IPC, Electron window/menu, original
 * provider reducers/sagas, HRTC and WebSocket transports. Inputs are explicitly local
 * synthetic notifications and a loopback RTM peer: no account, conference membership,
 * server grants, microphone/camera capture or real meeting delivery are asserted.
 * Live-room acceptance still requires a consenting authenticated host/participant pair:
 * disable6 during a real authorized recording and check final file/status; reenable6
 * must still require server approval and local confirmation. Toggle9 with an outstanding
 * host request; test1 with a real share invite,5/11 both CIM and RTM peers,8 with a real
 * cloud-record request. Capture menus/receipts and preserve remote recording indicators.
 */
const assert = require('assert').strict;
const fs = require('fs'), os = require('os'), path = require('path'), https = require('https');
const { X509Certificate } = require('crypto');
const electron = require('electron'), { app, BrowserWindow } = electron;
const native = process.env.WELINK_TEST_NATIVE, assets = process.env.WELINK_TEST_WEBASSETS;
const output = process.env.WELINK_TEST_OUTPUT;
if (![native, assets, output].every(value => value && path.isAbsolute(value)))
  throw Error('Set absolute WELINK_TEST_NATIVE, WELINK_TEST_WEBASSETS and WELINK_TEST_OUTPUT');
const WebSocket = require(path.join(native, 'vendor/management/node_modules/ws'));
const { provision } = require('./verify_meeting_management');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-capabilities-'));
app.setPath('userData', path.join(root, 'profile')); app.on('window-all-closed', () => {});
const receipts = { scope: 'Offline local policy and original provider consumer acceptance; no real meeting or server authorization',
  supportedTypes: Array.from({length:14}, (_, type) => type), permissionRequests: 0, changes: [], received: [] };
const replayedTypes = [0, 1, 2, 4, 5, 6, 8, 9, 10, 11];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, reason) {
  const deadline = Date.now() + 8000;
  do { const result = await check(); if (result) return result; await delay(25); } while (Date.now() < deadline);
  throw Error('Timed out: ' + reason);
}
async function run() {
  await app.whenReady();
  const cert = provision(root), fingerprint = new X509Certificate(cert.cert).fingerprint256;
  const server = https.createServer({ key: cert.key, cert: cert.cert }, (request, response) => {
    const pathname = new URL(request.url, 'https://127.0.0.1').pathname;
    if (request.method !== 'GET' || !pathname.startsWith('/webrtc/')) { response.writeHead(503); response.end(); return; }
    const relative = pathname.slice('/webrtc/'.length) || 'index.html';
    const filename = path.resolve(assets, relative);
    if (!filename.startsWith(path.resolve(assets) + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
      response.writeHead(404); response.end(); return;
    }
    const ext = path.extname(filename);
    response.setHeader('Content-Type', ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : ext === '.html' ? 'text/html' : 'application/octet-stream');
    fs.createReadStream(filename).pipe(response);
  });
  const connections = new Set();
  server.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  const sockets = new WebSocket.Server({ server, path: '/capability-test' });
  sockets.on('connection', socket => socket.on('message', data => receipts.received.push(JSON.parse(data.toString()))));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = 'https://127.0.0.1:' + server.address().port;
  const campus = path.join(root, 'campus'), documentPath = path.join(campus, 'plugin/conference/dist/hwmService.html');
  const logs = path.join(root, 'logs');
  fs.mkdirSync(path.dirname(documentPath), { recursive: true }); fs.mkdirSync(logs);
  fs.writeFileSync(documentPath, '<!doctype html><meta charset=utf-8><title>Local capability test owner</title>');
  // Observe production objects without substituting their implementations/results.
  const ownerModule = require(path.join(native, 'meeting_native_web')), Owner = ownerModule.MeetingNativeWeb;
  let owner;
  ownerModule.MeetingNativeWeb = class extends Owner { constructor(options) { super(options); owner = this; } };
  const { installMeetingMain } = require(path.join(native, 'meeting_main'));
  ownerModule.MeetingNativeWeb = Owner;
  const menus = new Map(), originalSetMenu = BrowserWindow.prototype.setMenu;
  BrowserWindow.prototype.setMenu = function (menu) { menus.set(this.id, menu); return originalSetMenu.call(this, menu); };
  const stop = installMeetingMain({ electron, appRoot: campus });
  const serviceWindow = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  const service = code => serviceWindow.webContents.executeJavaScript(code);
  try {
    await serviceWindow.loadFile(documentPath);
    await service(`(() => {
      const data = { compassUrlEnable: true, compassUrl: ${JSON.stringify(origin)}, isUserLogined: false };
      const pedestal = { logRootPath: ${JSON.stringify(logs)}, appdataRootPath: ${JSON.stringify(root)}, callMethod: async name => {
        if (name === 'method://pedestal/getEnvInfo') return { ffiPath: ${JSON.stringify(path.join(native, '../libraries/node_extends/node-ffi/ffi-napi'))} };
        if (name === 'method://pedestal/getProxyInfo') return {};
        if (name === 'method://pedestal/getLogStoragePath') return ${JSON.stringify(logs)};
        throw Error('No account or external service in this acceptance: ' + name);
      }};
      window.nativeCapabilityFrames = [];
      window.notifyJsTupCallback = frame => nativeCapabilityFrames.push(frame);
      window.capabilityService = require(${JSON.stringify(path.join(native, 'meeting_service'))}).createService({ window, Pedestal: pedestal, sdk: {},
        getStore: () => ({ getStore: key => key === undefined ? data : data[key], setStore: (key, value) => { data[key] = value; } }) });
      return true;
    })()`);
    for (const params of [null, [], { type: -1 }, { type: 1.5 }, { type: '7' }, { type: 5, isEnable: 1 }]) {
      const reply = await service('capabilityService.setEnableCapability(' + JSON.stringify(params) + ')');
      assert.equal(reply.param.reason_code, 'INVALID_ARGUMENT'); assert.equal(reply.param.applied, false);
    }
    for (const type of [14, 15, 99]) {
      const reply = await service(`capabilityService.setEnableCapability({type:${type}})`);
      assert.equal(reply.param.reason_code, 'UNKNOWN_NATIVE_CAPABILITY');
    }
    assert.equal(owner, undefined, 'Invalid private capability requests opened a meeting owner');
    const prepared = await service('capabilityService.prepareInvitationResolver()'); assert.equal(prepared.ok, true);
    assert(owner, 'No real IPC owner');
    const session = await owner.initializeSession();
    session.setCertificateVerifyProc((request, done) => done(request.hostname === '127.0.0.1' &&
      new X509Certificate(request.certificate.data).fingerprint256 === fingerprint ? 0 : -3));
    owner.options.requestPermission = async () => { receipts.permissionRequests++; return false; };
    async function configure(type, isEnable) {
      const reply = await service(`capabilityService.setEnableCapability(${JSON.stringify({ type, isEnable })})`);
      assert.equal(reply.result, 0, JSON.stringify(reply));
      assert.equal(reply.param.nativeCommand, 1050); assert.equal(reply.param.enumType, 'HwmSDKCapabilityType');
      assert.equal(reply.param.type, type); assert.equal(reply.param.enabled, isEnable);
      assert.equal(reply.param.serverPermissionGranted, false); assert.equal(reply.param.osPermissionGranted, false);
      assert.equal(reply.param.serverCapabilityAcknowledged, false); receipts.changes.push(reply.param);
      return reply.param;
    }
    const defaults = await service('capabilityService.setEnableCapability()');
    assert.equal(defaults.result, 0, JSON.stringify(defaults));
    assert.equal(defaults.param.type, 0); assert.equal(defaults.param.enabled, true);
    const noRoom = await service('capabilityService.setEnableCapability({type:3,isEnable:false})');
    assert.equal(noRoom.param.reason_code, 'NOT_IN_CONFERENCE'); assert.equal(noRoom.param.applied, false);
    const described = await service(`capabilityService.getErrorMessage({code:'NOT_IN_CONFERENCE'})`);
    assert.equal(described.errMessage, noRoom.param.reason);
    await configure(3, true);
    for (const enabled of [true, false]) {
      const background = await configure(10, enabled);
      assert.equal(background.publicationConfirmed, false);
      const complaint = await configure(12, enabled);
      assert.equal(complaint.state, 'idle'); assert.equal(complaint.serverAccepted, false);
    }
    await configure(6, false);
    const media = code => owner.window.webContents.executeJavaScript(code);
    owner.window.show();
    for (const expression of ['capabilityService.getConfWindowPic()', "capabilityService.run('host.window.capture',{save:true})"]) {
      const denied = await service(expression);
      assert.notEqual(denied.result, 0); assert.equal(denied.param.reason_code, 'NOT_IN_CONFERENCE');
      assert.equal(denied.param.dataUrl, undefined); assert.equal(denied.param.filePath, undefined);
    }
    receipts.wholeWindowCaptureDeniedBeforeMembership = true;
    const exportCall = action => service(`capabilityService.getRenderWindowInfo(${JSON.stringify({interface:'native-x11', action, requestId:'qa-no-room'})})`);
    for (const action of ['inspect', 'start', 'stop']) {
      const reply = await exportCall(action);
      assert.equal(reply.param.requestId, 'qa-no-room');
      assert.deepEqual(reply.param.surfaces, []);
      assert.equal(reply.param.win32Abi, false);
      if (action === 'start') {
        assert.notEqual(reply.result, 0); assert.equal(reply.param.reason_code, 'NOT_IN_CONFERENCE');
      } else {
        assert.equal(reply.result, 0, JSON.stringify(reply)); assert.equal(reply.param.status, 'stopped');
      }
    }
    receipts.nativeExportDeniedBeforeMembership = true;
    await until(() => menus.get(owner.window.id)?.getMenuItemById('record-start'), 'real native meeting menu');
    const menu = () => menus.get(owner.window.id);
    assert.equal(menu().getMenuItemById('record-start').visible, false);
    const disabledRecord = await owner.handle({ protocol: ownerModule.PROTOCOL, id: 'disabled-record', operation: 'recording.start', params: {} });
    assert.equal(disabledRecord.error.code, 'NATIVE_CAPABILITY_DISABLED');
    await configure(6, true); assert.equal(menu().getMenuItemById('record-start').visible, true);
    const noGrant = await owner.callPage('recording.capabilities');
    assert.notEqual(noGrant.permission.state, 'allowed', 'Capability enabling granted recording permission');
    await configure(9, false); assert.equal(menu().getMenuItemById('record-permission').visible, false);
    const requestOff = await owner.handle({ protocol: ownerModule.PROTOCOL, id: 'disabled-request', operation: 'recording.requestPermission', params: {} });
    assert.equal(requestOff.error.code, 'NATIVE_CAPABILITY_DISABLED');
    assert.equal((await owner.callPage('recording.capabilities')).vendor.recordingEnabled, true, 'Type9 disabled independent local recording');
    await configure(9, true); assert.equal(menu().getMenuItemById('record-permission').visible, true);
    assert.equal(menu().getMenuItemById('record-permission').enabled, false, 'No meeting must not become an authorized request UI');
    await media(`(() => {
      let load; webpackChunkweb_rtc.push([['capability-consumer-acceptance'], {}, r => { load = r; }]);
      const application = load(36176), c = load(62467), actions = load(65113), selectors = load(53765);
      window.capabilityFixture = { load, store: application.store, c, actions, selectors,
        run: (handler, message) => application.sagaMiddleware.run(handler, message).toPromise(),
        cms: load(51361).confWsHandler, rtm: load(90620).chatWsHandler, chat: load(36133), chatActions: load(70077) };
      application.store.dispatch(actions.setWaitingRoomInfo({ cimGroupId: 'qa-waiting', waitingRoomIMGroupId: 'qa-waiting' }));
      return true;
    })()`);
    async function modal(type, name) {
      for (const enabled of [false, true, false]) {
        await configure(type, enabled);
        const shown = await media(`(() => { const f = capabilityFixture, value = f.c.MODAL_STATE[${JSON.stringify(name)}];
          f.store.dispatch(f.actions.setModalState(value)); return f.selectors.selectView(f.store.getState()).modalState === value; })()`);
        assert.equal(shown, enabled, name + ' consumer did not follow policy');
      }
    }
    await modal(1, 'HOST_OPEN_SHARE_MODAL'); await modal(8, 'GUEST_REQUEST_RECORD_CONFIRM');
    let serial = 0;
    async function incoming(kind, privateMessage, waiting, expected) {
      const marker = 'capability-fixture-' + ++serial;
      const data = { senderUserUuid: 'qa-peer', senderUserAgent: 'WEBRTC', sender: 'qa-peer', clientMsgId: marker, msgId: marker,
        serverSendTime: Date.now(), textContent: marker, channelId: waiting ? 'qa-waiting' : 'qa-main',
        messageOptions: { isPrivate: kind === 'rtm' ? privateMessage ? '1' : '0' : privateMessage ? 1 : 0,
          senderDeviceType: 'webrtc_pc', KEY_SENDER_NAME: 'Local fixture', privateUser: [] } };
      const found = await media(`(async () => { const f = capabilityFixture, message = ${JSON.stringify(data)};
        if (${JSON.stringify(kind)} === 'cim') {
          const action = ${waiting} ? f.c.CONF_MSG_TYPE.WAITING_ROOM_IM_NOTIFY : f.c.CONF_MSG_TYPE.CONF_IM_NOTIFY;
          await f.run(f.cms[action], { action, confMessages: [message], latestMsgId: ${serial}, msgID: message.msgId });
        } else await f.run(f.rtm[f.chat.ACTION_CHAT.RTM_MESSAGE_NOTIFY], { msgBody: JSON.stringify({rtmMessage:message}) });
        return f.store.getState().chat.chatContent.some(item => item.textContent === message.textContent);
      })()`);
      assert.equal(found, expected, kind + ' private=' + privateMessage + ' waiting=' + waiting);
    }
    for (const kind of ['cim', 'rtm']) {
      await configure(5, false); await incoming(kind, true, false, false); await incoming(kind, false, false, true);
      await configure(5, true); await incoming(kind, true, false, true);
      await configure(11, false); await incoming(kind, false, true, false); await incoming(kind, true, true, false);
      await incoming(kind, false, false, true);
      await configure(11, true); await incoming(kind, false, true, true);
    }
    await media(`(async () => { const socket = new WebSocket(${JSON.stringify(origin.replace('https:', 'wss:') + '/capability-test')});
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      capabilityFixture.socket = socket; capabilityFixture.store.dispatch(capabilityFixture.chatActions.setSocket(socket)); return true;
    })()`);
    async function send(privateMessage, waiting, expected) {
      const before = receipts.received.length;
      const result = await media(`(() => { const f = capabilityFixture;
        try { f.socket.send(JSON.stringify({ msgCode:f.chat.CHAT_MSG.SEND_MSG, msgBody:JSON.stringify({ rtmMessage:{
          textContent:'loopback-only', channelId:${JSON.stringify(waiting ? 'qa-waiting' : 'qa-main')}, messageOptions:{isPrivate:${privateMessage ? 1 : 0}} } }) })); return 'sent'; }
        catch (error) { return error.code; }
      })()`);
      assert.equal(result, expected ? 'sent' : 'NATIVE_CAPABILITY_DISABLED');
      if (expected) await until(() => receipts.received.length === before + 1, 'actual loopback WebSocket delivery');
      else { await delay(80); assert.equal(receipts.received.length, before, 'Blocked chat reached the peer'); }
    }
    await configure(5, false); await send(true, false, false); await send(false, false, true);
    await configure(5, true); await send(true, false, true);
    await configure(11, false); await send(false, true, false); await send(false, false, true);
    await configure(11, true); await send(false, true, true);
    assert.equal(owner.shareAudioEnabled, false, 'Private capability changes modified the separate share-audio gate');
    const sound = await service(`capabilityService.bridge.execute('host.ui.shareAudio.configure',{enabled:true})`);
    assert.equal(sound.scope, 'local-share-audio-ui'); assert.equal(owner.shareAudioEnabled, true);
    for (const enabled of [true, false]) {
      const pnr = await configure(7, enabled);
      assert.equal(pnr.roomAvailable, false); assert.equal(pnr.enrolled, false); assert.equal(pnr.processing, false);
      assert.equal(owner.shareAudioEnabled, true, 'Anonymous PNR changed the separate share-audio control');
    }
    async function hostFeatures() {
      const reply = await owner.handle({ protocol: ownerModule.PROTOCOL, id: 'host-features', operation: 'features.get', params: {} });
      assert.equal(reply.ok, true, JSON.stringify(reply.error));
      return reply.data;
    }
    for (const enabled of [false, true]) {
      await configure(13, enabled);
      const descriptor = (await hostFeatures()).setEnableCapability;
      assert.deepEqual(descriptor.supportedTypes, receipts.supportedTypes);
      const mini = descriptor.types.find(value => value.type === 13);
      assert.equal(mini.supported, true); assert.equal(mini.enabled, enabled);
      assert.equal(mini.configurationAvailable, true); assert.equal(mini.available, false);
      assert.equal(mini.reason, enabled ? 'P2P_MINI_WINDOW_NOT_ELIGIBLE' : 'NATIVE_CAPABILITY_DISABLED');
      assert.equal(mini.scope, 'local-p2p-compact-window'); assert.equal(mini.boundary, null);
      assert.equal(mini.provider, 'linux-native-call-window'); assert.equal(mini.nativeSdkServerSupportVerified, false);
      assert(mini.requirements.includes('current-account-site')); assert(mini.requirements.includes('established-active-p2p-call'));
    }
    receipts.hostMiniWindow = { supported: true, eligibleWithoutCall: false, enabledToggleObserved: true };
    receipts.invitedShareRace = await require('./verify_native_invited_share')({ electron, native, origin, owner, fingerprint });
    for (const type of replayedTypes) await configure(type, false);
    assert.equal(await media(`document.getElementById('welink-capability-policy').hidden`), false);
    fs.writeFileSync(path.join(output, 'native-capabilities.png'), (await owner.window.webContents.capturePage()).toPNG());
    await media(`capabilityFixture.store.dispatch(capabilityFixture.chatActions.setSocket(null));capabilityFixture.socket.close();true`);
    const oldWindow = owner.window.id; owner.window.destroy();
    await configure(6, false);
    assert.notEqual(owner.window.id, oldWindow);
    const restored = await hostFeatures();
    for (const type of replayedTypes) assert.equal(restored.setEnableCapability.types.find(item => item.type === type).enabled, false);
    assert.equal(restored.setEnableCapability.types.find(item => item.type === 3).enabled, true);
    receipts.policyRestoredAfterRecreation = true;
    assert.equal(receipts.permissionRequests, 0); assert.equal(owner.allowedPermissions.size, 0);
  } finally {
    await stop(); if (!serviceWindow.isDestroyed()) serviceWindow.destroy();
    BrowserWindow.prototype.setMenu = originalSetMenu;
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    const closed = new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    for (const socket of connections) socket.destroy();
    await closed;
  }
  receipts.pass = true;
  fs.writeFileSync(path.join(output, 'native-capabilities.json'), JSON.stringify(receipts, null, 2) + '\n');
  console.log('PASS native private capability policies: ' + JSON.stringify(receipts.supportedTypes));
}
const deadline = setTimeout(() => { console.error('Capability acceptance timed out'); app.exit(3); }, 120000);
run().then(() => { clearTimeout(deadline); app.exit(0); }, error => { clearTimeout(deadline); console.error(error.stack); app.exit(1); });
app.once('quit', () => fs.rmSync(root, { recursive: true, force: true }));
