'use strict';
// Deterministic UNIT verifier of the HRTC binding's ownership rules.
// This instrumented SDK is a fixture, not admission or positive media proof.
// Real packaged signaling/RTP: verify_offline_hrtc.js --help.
// Run: node Conference/verify_offline_media.js
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const media = require('./meeting_offline_media');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function tick() { return new Promise(resolve => setImmediate(resolve)); }
function admission(extra = {}) {
  return { conferenceID: 'conf-17', participantID: 'participant-9', role: '1',
    signatureInfo: { appId: 'signed-app', privateAppId: 'private-app',
      domainUrl: 'rtc.example.test', roomId: 'rtc-room-29', userID: 'rtc-user-51',
      cTime: '1740000000', signature: 'fixture-signature', ...extra } };
}
function fixture({ joinGate, captureGate, captureError, leaveError, appError, staleLeaveState = false } = {}) {
  const clients = [], streams = [], calls = [], events = [];
  const sdk = {
    VERSION: media.SDK_VERSION,
    setAllowKeyLog(value) { assert.equal(value, false); },
    setParameter(name, value) { calls.push(['parameter', name, value]); },
    createClient(config) {
      calls.push(['createClient', config]);
      if (appError && !config.appId) throw appError;
      const client = new EventEmitter();
      client.state = 'DISCONNECTED';
      client.getConnectionState = () => client.state;
      client.join = async (room, options) => {
        calls.push(['join', room, options]);
        if (joinGate) await joinGate.promise;
        client.state = 'CONNECTED';
      };
      client.leave = async () => {
        calls.push(['leave']);
        if (leaveError) throw leaveError;
        if (!staleLeaveState) client.state = 'DISCONNECTED';
      };
      client.publish = async stream => { calls.push(['publish', stream]); };
      client.unpublish = async stream => { calls.push(['unpublish', stream]); };
      client.subscribe = async (stream, options) => { calls.push(['subscribe', stream, options]); };
      client.getLocalAudioStats = async () => new Map([['local', { bytesSent: 320, packetsSent: 4 }]]);
      client.getRemoteAudioStats = async () => new Map([['remote', { bytesReceived: 240, packetsReceived: 3 }]]);
      clients.push(client);
      return client;
    },
    createStream(config) {
      const track = () => ({ enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; } });
      const stream = {
        config, audio: null, video: null, closed: 0,
        async initialize() {
          calls.push(['initialize', stream]);
          if (captureGate) await captureGate.promise;
          if (captureError) throw captureError;
          if (config.audio) stream.audio = track();
          if (config.video) stream.video = track();
          return { getCode: () => 0 };
        },
        hasAudioTrack: () => !!stream.audio,
        hasVideoTrack: () => !!stream.video,
        getAudioTrack: () => stream.audio,
        getVideoTrack: () => stream.video,
        muteAudio() { if (stream.audio) stream.audio.enabled = false; },
        muteVideo() { if (stream.video) stream.video.enabled = false; },
        close() {
          ++stream.closed;
          if (stream.audio) stream.audio.stop();
          if (stream.video) stream.video.stop();
        }
      };
      streams.push(stream);
      return stream;
    }
  };
  const owner = media.create({ sdk, emit: (event, value) => { events.push({ event, value }); } });
  return { owner, calls, events, clients, streams };
}

async function verify() {
  const context = { confID: 'conf-17', displayName: 'Offline participant',
    serviceTp: { rtcInfo: { appId: 'must-not-be-borrowed' }, siteInfoList: [
      { accessStrategy: { service_access_node: { rtcUri: 'session-rtc.example.test' } } }
    ] } };
  assert.equal(media.parameters(admission(), context).config.appId, 'signed-app');
  for (const appId of [undefined, '']) {
    const params = media.parameters(admission({ appId }), context);
    assert.equal(params.config.appId, 'private-app');
    assert.equal(params.appIdSource, 'signatureInfo.privateAppId');
  }
  assert.equal(media.parameters(admission({ appId: 'appid' }), context).config.appId, 'appid',
    'Windows does not use the browser application special case');
  assert.equal(media.parameters(admission({ appId: ' ' }), context).config.appId, ' ',
    'Native selection uses strlen, not whitespace trimming');
  const empty = media.parameters(admission({ appId: '', privateAppId: '' }), context);
  assert.equal(empty.config.appId, '', 'No fabricated application identity');
  assert.equal(empty.appIdSource, 'native-empty');
  const routed = media.parameters(admission({ domainUrl: '' }), context);
  assert.equal(routed.config.domain, 'session-rtc.example.test');
  assert.equal(routed.routeSource, 'session-serviceTp');
  assert.equal(media.parameters(admission({ domainUrl: 'wss://edge.example.test:8443' }), context).config.port, 8443);
  assert.deepEqual(media.parameters(admission({ domainUrl: 'edge.example.test:8443' }), context).config,
    {appId:'signed-app', domain:'edge.example.test', port:8443});
  assert.equal(media.parameters(admission({ domainUrl: 'edge.example.test:8443', port:'9443' }), context).config.port, 9443);
  for (const port of [0, 442, 65536, 8443.5, 'not-a-port']) {
    assert.throws(() => media.parameters(admission({port}), context), {code:'OFFLINE_MEDIA_ROUTE_UNSUPPORTED'});
  }
  for (const domainUrl of ['edge.example.test/path', 'wss://user:secret@edge.example.test', 'edge.example.test?route=other']) {
    assert.throws(() => media.parameters(admission({domainUrl}), context), {code:'OFFLINE_MEDIA_ROUTE_UNSUPPORTED'});
  }
  assert.throws(() => media.parameters(admission({ domainUrl: 'http://edge.example.test' }), context),
    { code: 'OFFLINE_MEDIA_ROUTE_UNSUPPORTED' });
  assert.throws(() => media.parameters({ wssToken: 'not-a-media-admission' }, context),
    { code: 'OFFLINE_MEDIA_GRANT_INCOMPLETE' });
  assert.throws(() => media.parameters({ ...admission(), role: 'unexpected' }, context),
    { code: 'OFFLINE_MEDIA_ROLE_UNSUPPORTED' });
  assert.throws(() => media.parameters({ ...admission(), returnCode: 17 }), { code: 17 });

  // A control grant or pending SDK promise must never be reported as joined.
  const gate = deferred();
  const initial = fixture({ joinGate: gate });
  const pending = initial.owner.join(admission(), context);
  await tick();
  assert.equal(initial.owner.snapshot().roomJoined, false);
  assert.equal(initial.streams.length, 0, 'Admission alone must not activate devices');
  gate.resolve();
  const receipt = await pending;
  assert.equal(receipt.roomJoined, true);
  assert.equal(receipt.connection, 'CONNECTED');
  assert.equal(receipt.roomId, 'rtc-room-29');
  assert.equal(receipt.userId, 'rtc-user-51');
  assert.equal(receipt.participantID, 'participant-9');
  assert.equal(receipt.microphone, false);
  assert.equal(receipt.camera, false);
  assert.deepEqual((await initial.owner.stats()).audio,
    {bytesSent:320, packetsSent:4, bytesReceived:240, packetsReceived:3});
  assert.deepEqual(initial.calls.find(call => call[0] === 'join').slice(1), [
    'rtc-room-29', { userId: 'rtc-user-51', userName: 'Offline participant', role: 0,
      ctime: '1740000000', signature: 'fixture-signature' }
  ]);
  await assert.rejects(initial.owner.join(admission(), context), { code: 'OFFLINE_MEDIA_BUSY' });

  // Actual publication, privacy-off, moderator locks and explicit unlock.
  const enabled = await initial.owner.setMicrophone(true);
  assert.equal(enabled.microphone, true);
  assert.equal(enabled.audioPublished, true);
  const firstTrack = initial.streams[0].audio;
  const muted = initial.owner.setMicrophone(false, { locked: true });
  assert.equal(firstTrack.readyState, 'ended', 'Stop physical capture before awaiting signaling');
  assert.equal(initial.owner.snapshot().microphone, false);
  assert.equal((await muted).audioPublished, false);
  await assert.rejects(initial.owner.setMicrophone(true), { code: 'OFFLINE_DEVICE_LOCKED' });
  await initial.owner.setMicrophone(false, { locked: false });
  assert.equal(initial.streams.length, 1, 'Unlock must not open a microphone');
  await initial.owner.setCamera(true);
  assert.equal(initial.owner.snapshot().camera, true);
  assert.equal(initial.owner.snapshot().microphone, false);
  await initial.owner.setCamera(false);
  assert.equal(initial.streams[1].video.readyState, 'ended');

  // The SDK emits connection events before it updates getConnectionState().
  initial.clients[0].emit('connection-state-changed', { curState: 'RECONNECTING', prevState: 'CONNECTED' });
  assert.equal(initial.owner.snapshot().connection, 'RECONNECTING');
  assert.equal(initial.owner.snapshot().roomJoined, true);
  initial.clients[0].state = 'RECONNECTING';
  initial.clients[0].emit('connection-state-changed', { curState: 'CONNECTED', prevState: 'RECONNECTING' });
  assert.equal(initial.owner.snapshot().connection, 'CONNECTED');
  initial.clients[0].state = 'CONNECTED';
  const left = await initial.owner.leave('user');
  assert.equal(left.state, 'left');
  assert.equal(left.connection, 'DISCONNECTED');
  assert.equal(initial.calls.filter(call => call[0] === 'leave').length, 1);
  initial.clients[0].emit('stream-added', { stream: { getUserId: () => 'retired', getType: () => 'main' } });
  assert.equal(initial.calls.filter(call => call[0] === 'subscribe').length, 0);
  await assert.rejects(initial.owner.stats(), {code:'OFFLINE_MEDIA_NOT_JOINED'});
  await initial.owner.dispose();

  // Off stops capture synchronously; a newer on revision must recreate ended
  // tracks even when the off revision never reaches the device queue.
  const toggled = fixture();
  await toggled.owner.join(admission(), context);
  await toggled.owner.setDevices({ microphone: true, camera: true });
  for (const [method, field, trackField] of [
    ['setMicrophone', 'microphone', 'audio'], ['setCamera', 'camera', 'video']
  ]) {
    const previous = toggled.streams[toggled.streams.length - 1];
    const count = toggled.streams.length;
    const off = toggled.owner[method](false);
    assert.equal(previous[trackField].readyState, 'ended');
    const on = toggled.owner[method](true);
    await off;
    const restored = await on;
    assert.equal(restored[field], true);
    assert.equal(toggled.streams.length, count + 1);
    const replacement = toggled.streams[toggled.streams.length - 1];
    assert.equal(replacement[trackField].readyState, 'live');
    assert.equal(replacement[trackField].enabled, true);
    assert.equal(previous.audio.readyState, 'ended');
    assert.equal(previous.video.readyState, 'ended');
    assert.equal((await toggled.owner[method](true))[field], true);
    assert.equal(toggled.streams.length, count + 1, 'A live track needs no redundant rebuild');
  }
  await toggled.owner.dispose();

  // SDK rejection is exposed verbatim, including the empty-effective-app case.
  const appError = Object.assign(new Error('fixture SDK appId validation'), { code: 90123456 });
  const invalid = fixture({ appError });
  await assert.rejects(invalid.owner.join(admission({ appId: '', privateAppId: '' }), context), error => error === appError);
  assert.equal(invalid.calls.find(call => call[0] === 'createClient')[1].appId, '');
  assert(invalid.events.some(event => event.event === 'offline-media-failure' && event.value.code === 90123456));
  assert.equal(invalid.calls.some(call => call[0] === 'join'), false);
  await invalid.owner.dispose();

  const denied = fixture({ captureError: Object.assign(new Error('Permission denied'), { code: 'NotAllowedError' }) });
  const deniedReceipt = await denied.owner.join(admission(), { ...context, isMicOn: true, isCameraOn: true });
  assert.equal(deniedReceipt.roomJoined, true);
  assert.equal(deniedReceipt.microphone, false);
  assert.equal(deniedReceipt.camera, false);
  assert.equal(deniedReceipt.error.code, 'NotAllowedError');
  assert.equal(denied.calls.some(call => call[0] === 'publish'), false);
  await denied.owner.dispose();

  // Leave during a pending join waits for the genuine operation, then closes it.
  const lateGate = deferred();
  const late = fixture({ joinGate: lateGate });
  const lateJoin = late.owner.join(admission(), context);
  const joinRejected = assert.rejects(lateJoin, { code: 'OFFLINE_MEDIA_RETIRED' });
  const retirement = late.owner.leave('cancelled');
  lateGate.resolve();
  await joinRejected;
  assert.equal((await retirement).state, 'left');
  assert.equal(late.calls.filter(call => call[0] === 'leave').length, 1);
  assert(!late.events.some(event => event.value.state === 'room-joined'));
  await late.owner.dispose();

  // A permission prompt resolving after cancellation must not leak new tracks.
  const captureGate = deferred();
  const capturing = fixture({ captureGate });
  await capturing.owner.join(admission(), context);
  const capture = capturing.owner.setMicrophone(true);
  const captureRejected = assert.rejects(capture, { code: 'OFFLINE_MEDIA_RETIRED' });
  await tick();
  const captureLeave = capturing.owner.leave('cancelled');
  captureGate.resolve();
  await captureRejected;
  await captureLeave;
  assert.equal(capturing.streams[0].audio.readyState, 'ended');
  assert(!capturing.calls.some(call => call[0] === 'publish'));
  await capturing.owner.dispose();

  const failures = [];
  const lost = fixture();
  await lost.owner.join(admission(), { ...context, onFailure: error => failures.push(error) });
  lost.clients[0].emit('connection-state-changed', { curState: 'DISCONNECTED' });
  lost.clients[0].state = 'DISCONNECTED';
  await tick();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'OFFLINE_RTC_DISCONNECTED');
  assert.equal(lost.owner.snapshot().roomJoined, false);
  await lost.owner.dispose();

  // The pinned real SDK closes its socket/PCs after BYE but does not update its
  // connection-state getter. Only a successful leave promise may retire that
  // stale CONNECTED state; the rejected-leave case below must still fail.
  const sticky = fixture({ staleLeaveState: true });
  await sticky.owner.join(admission(), context);
  const confirmed = await sticky.owner.leave();
  assert.equal(confirmed.state, 'left');
  assert.equal(confirmed.leaveConfirmed, true);
  assert.equal(confirmed.sdkConnection, 'CONNECTED');
  assert.equal(confirmed.connection, 'DISCONNECTED');
  await sticky.owner.dispose();

  const failedLeave = fixture({ leaveError: Object.assign(new Error('Leave was rejected'), { code: 'LEAVE_REJECTED' }) });
  await failedLeave.owner.join(admission(), context);
  const failedReceipt = await failedLeave.owner.leave();
  assert.equal(failedReceipt.state, 'retirement-failed');
  assert.equal(failedReceipt.errors[0].code, 'LEAVE_REJECTED');
  assert.equal(failedReceipt.connection, 'CONNECTED');
  await assert.rejects(failedLeave.owner.join(admission(), context), { code: 'OFFLINE_MEDIA_DISPOSED' });
  await failedLeave.owner.dispose();
  console.log('Offline media identity, admission, devices, reconnect and retirement contracts verified');
}
verify().catch(error => { console.error(error); process.exitCode = 1; });
