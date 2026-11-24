#!/usr/bin/env node
'use strict';

// Offline-only CONTROL integration verifier. The production HTTPS, proxy, TLS,
// WebSocket, correlation and lifecycle code runs unchanged against loopback.
// Media is an explicit fixture, NOT HRTC admission or positive media proof.
// verify_offline_hrtc.js exercises the packaged Electron/HRTC signaling/RTP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const WebSocket = require('./vendor/management/node_modules/ws');
const { createOfflineControl, resolveRoutes } = require('./meeting_offline_control');
const { openControlSession } = require('./meeting_offline_transport');

function defer() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Inbox {
  constructor() { this.items = []; this.waiters = []; }
  push(value) {
    const index = this.waiters.findIndex(waiter => waiter.match(value));
    if (index < 0) this.items.push(value);
    else {
      const waiter = this.waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  }
  take(match) {
    const index = this.items.findIndex(match);
    if (index >= 0) return Promise.resolve(this.items.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(value => value !== waiter);
        reject(Error('The loopback fixture did not observe the expected operation'));
      }, 5000);
      this.waiters.push(waiter);
    });
  }
}
const confId = '1234567890';
const invitation = Object.freeze({ confId, random: 'issued+%2B&not-a-browser-nonce', idPrefix: 'site-A%2F',
  site_url: 'https://untrusted-invitation.invalid/conferences?issuer=other', nick_name: 'Offline local QA',
  isOfflineJoin: true, isMicOn: true, isCameraOn: true });
const temporary = Object.freeze({ returnCode: 0, confMode: 'MMR', password: 'issued-password',
  wssToken: 'native-temporary-control-token', tmpUserID: 'tmp-user', orgID: 'tmp-org',
  tmpAccountID: 'tmp-account', tmpName: 'tmp-name', spID: 'tmp-sp', tmpLoginAccount: 'tmp-login', opsAddress: '' });
function grant(participantID = 'participant-1', waiting = false) {
  return { returnCode: 0, conferenceID: confId, participantID, confMode: 'MMR', role: '0',
    enterWaitingRoom: waiting, enableCollaborate: '0', signatureInfo: {
      roomId: 'admitted-room', userID: 'admitted-media-user', cTime: 1234, signature: 'fixture-signature',
      // Deliberately no appId/domain: only the media binding may fill those from
      // the scoped native configuration, never the controller/invitation.
      extendPayload: 'opaque-media-extension'
    } };
}
function mediaBoundary({ gate, invalid = false } = {}) {
  const inbox = new Inbox(), calls = [], device = { microphone: false, camera: false };
  let joinedContext;
  const media = {
    async join(value, context) {
      calls.push({ op: 'join', grant: value, context });
      inbox.push({ op: 'join', grant: value, context });
      joinedContext = context;
      if (gate) await gate.promise;
      if (!context.isCurrent() || context.signal.aborted) throw Object.assign(Error('Media owner retired'), { code: 'OFFLINE_RETIRED' });
      return { roomJoined: !invalid, connection: 'CONNECTED', roomId: value.signatureInfo.roomId,
        userId: value.signatureInfo.userID, participantID: context.participantID,
        conferenceID: context.confID, source: 'fixture-media-boundary', ...device, audioPublished: false };
    },
    async leave() { calls.push({ op: 'leave' }); inbox.push({ op: 'leave' }); return { left: true }; },
    async setMicrophone(enabled) { device.microphone = enabled; calls.push({ op: 'microphone', enabled }); return { ...device }; },
    async setCamera(enabled) { device.camera = enabled; calls.push({ op: 'camera', enabled }); return { ...device }; }
  };
  return { media, calls, inbox, fail: error => joinedContext.onFailure(error) };
}
async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
async function fixture(dir) {
  function certificate(name, san) {
    const cert = path.join(dir, name + '.crt'), key = path.join(dir, name + '.key');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=' + name, '-addext', 'subjectAltName=' + san, '-keyout', key, '-out', cert], { stdio: 'ignore' });
    return { cert, key };
  }
  const trusted = certificate('offline-cms.invalid', 'DNS:offline-cms.invalid');
  const wrong = certificate('unrelated-root.invalid', 'DNS:unrelated-root.invalid');
  const f = { tokenRequests: [], frames: [], upgrades: [], proxyRequests: [], inbox: new Inbox(), sockets: new Set(),
    handler: null, tokenHandler: null, allowedTokens: new Set([temporary.wssToken, 'existing-type-1-token']) };
  f.reply = (record, data, overrides = {}) => record.socket.send(JSON.stringify({
    action: record.frame.action, ...(record.frame.type ? { type: record.frame.type } : {}),
    sequence: record.frame.sequence, data: JSON.stringify(data), ...overrides
  }));
  f.notification = (socket, type, data, action = 'LocalControl') => socket.send(JSON.stringify({ action, type,
    sequence: 'native-notification-' + Math.random(), data: JSON.stringify(data) }));
  f.defaultReply = record => {
    if (record.frame.type === 'JOIN_RTC_CONF') f.reply(record, grant());
    else if (record.frame.type === 'QueryConfInfoForJoin') f.reply(record, { returnCode: 0, confMode: 'MMR', password: temporary.password });
    else f.reply(record, { returnCode: 0 });
  };
  const server = https.createServer({ cert: fs.readFileSync(trusted.cert), key: fs.readFileSync(trusted.key) }, (request, response) => {
    let body = '';
    request.on('data', bytes => { body += bytes; });
    request.on('end', () => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/mmc/control/conferences/wss/token/user?conferenceID=' + confId);
      for (const header of ['authorization', 'x-auth-token', 'x-access-token', 'cookie', 'x-jwt-authorization'])
        assert.equal(request.headers[header], undefined, header + ' leaked into anonymous token verification');
      const record = { request, response, body: JSON.parse(body) };
      f.tokenRequests.push(record); f.inbox.push({ kind: 'token', record });
      if (f.tokenHandler) f.tokenHandler(record);
      else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(temporary)); }
    });
  });
  server.on('tlsClientError', () => {});
  const wss = new WebSocket.Server({ noServer: true, handleProtocols: protocols => protocols.has('tup_service_protocol') ? 'tup_service_protocol' : false });
  server.on('upgrade', (request, socket, head) => {
    assert.equal(request.url, '/v1/mmc/control/websocket/conn');
    assert.equal(request.headers['x-connection-type'], '1');
    assert.equal(request.headers['x-auth-token'], undefined);
    assert.equal(request.headers['user-agent'], 'OfflineLocalVerifier/1');
    assert.equal(request.headers['x-device-id'], 'offline-local-device');
    assert(f.allowedTokens.has(request.headers.authorization));
    f.upgrades.push(request.headers);
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  wss.on('connection', socket => {
    f.sockets.add(socket); socket.on('close', () => f.sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes);
      if (frame.action === 'PING') { socket.send('{"action":"PONG"}'); return; }
      const record = { socket, frame, data: JSON.parse(frame.data) };
      f.frames.push(record); f.inbox.push({ kind: 'frame', record });
      if (f.handler) f.handler(record); else f.defaultReply(record);
    });
  });
  const port = await listen(server);
  const proxy = http.createServer();
  const tunnels = new Set();
  proxy.on('connect', (request, client, head) => {
    assert.equal(request.headers['proxy-authorization'], 'Basic ' + Buffer.from('local-user:local-password').toString('base64'));
    const expected = new Set(['offline-cms.invalid:' + port, 'wrong-host.invalid:' + port]);
    assert(expected.has(request.url), 'The invitation attempted to become an authority: ' + request.url);
    f.proxyRequests.push(request.url);
    const upstream = net.connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    tunnels.add(client); tunnels.add(upstream);
    const close = () => { client.destroy(); upstream.destroy(); tunnels.delete(client); tunnels.delete(upstream); };
    client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
  });
  const proxyPort = await listen(proxy);
  const origin = 'https://offline-cms.invalid:' + port;
  const packaged = path.join(dir, 'offlineJoinIp.json');
  fs.writeFileSync(packaged, JSON.stringify({ Domains: { httpProxyUri: new URL(origin).host },
    DomainsIntl: { httpProxyUri: 'intl-config-only.invalid' } }));
  f.config = { origin: 'https://configured-login.invalid', userAgent: 'OfflineLocalVerifier/1', deviceId: 'offline-local-device',
    userAgentExt: 'native-offline', offlineJoinConfigPath: packaged, caBundle: trusted.cert,
    proxyUrl: 'http://127.0.0.1:' + proxyPort, proxyUsername: 'local-user', proxyPassword: 'local-password', loginAccount: '' };
  f.origin = origin; f.wrongCA = wrong.cert;
  f.close = async () => {
    for (const socket of f.sockets) socket.terminate();
    for (const tunnel of tunnels) tunnel.destroy();
    wss.close();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
  };
  return f;
}
function frame(f, type) { return f.inbox.take(item => item.kind === 'frame' && item.record.frame.type === type).then(item => item.record); }
function makeOwner(f, extra = {}) {
  const boundary = extra.boundary || mediaBoundary();
  const events = new Inbox(), seen = [];
  const owner = createOfflineControl({ getConfig: () => extra.config || f.config, media: boundary.media,
    notify: value => { seen.push(value); events.push(value); }, timeoutMs: extra.timeoutMs || 2000,
    ...(extra.getSession ? { getSession: extra.getSession } : {}) });
  return { owner, boundary, events, seen };
}
const ctx = () => ({ isCurrent: () => true, isServerDowngrade: false });
async function failedJoin(h, input = invitation, context = ctx()) {
  let rejected;
  try { await h.owner.join(input, context); }
  catch (error) { rejected = error; }
  finally { await h.owner.dispose(); }
  assert(rejected, 'Unexpected membership');
  return rejected;
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-offline-control-'));
  let f;
  try {
    // Native region selection is configured-login based, and package routing
    // is independent of the invitation's site, port and path.
    const packageConfig = { Domains: { httpProxyUri: 'domestic.invalid' }, DomainsIntl: { httpProxyUri: 'international.invalid:9443' } };
    assert.equal((await resolveRoutes({ server: 'configured.intl.example', offlineJoinConfig: packageConfig })).routes[0].origin,
      'https://international.invalid:9443');
    assert.equal((await resolveRoutes({ server: 'configured.example', offlineJoinConfig: packageConfig })).routes[0].origin,
      'https://domestic.invalid');
    const serviceTp = { rtcInfo: { appId: 'scoped-app' }, siteInfoList: [
      { priority: 2, accessStrategy: { service_access_node: { httpProxyUri: 'second.invalid' } } },
      { priority: 1, accessStrategy: { nearbyMediaNodeName: 'native-nearby', service_access_node:
        { httpProxyUri: 'first.invalid:8444;unused.invalid', backHttpProxyUri: 'backup.invalid', regionProxyAddrs: 'regional.invalid' } } }
    ] };
    assert.deepEqual((await resolveRoutes({ serviceTp })).routes.map(route => route.origin),
      ['https://first.invalid:8444', 'https://backup.invalid', 'https://regional.invalid:8443', 'https://second.invalid']);
    await assert.rejects(resolveRoutes({ serviceTp: { siteInfoList: [{ priority: 1, accessStrategy:
      { service_access_node: { httpProxyUri: 'http://plaintext.invalid' } } }] } }), { code: 'INVALID_OFFLINE_AUTHORITY' });
    f = await fixture(dir);

    // Fresh-token waiting admission: every completion boundary is withheld in
    // turn. Neither a socket nor a grant nor a resolved media promise is enough.
    const gate = defer(), boundary = mediaBoundary({ gate });
    const nativeTemplate = { serviceTp: { rtcInfo: { appId: 'fixture-native-app' }, siteInfoList: [{
      priority: 1, accessStrategy: { nearbyMediaNodeName: 'fixture-nearby',
        service_access_node: { httpProxyUri: new URL(f.origin).host } }
    }] } };
    const h = makeOwner(f, { boundary, config: { ...f.config, offlineJoinTemplate: nativeTemplate } });
    let joinCount = 0, heldReport, heldSubscription;
    f.handler = record => {
      if (record.frame.type === 'JOIN_RTC_CONF') {
        ++joinCount;
        f.reply(record, grant(joinCount === 1 ? 'waiting-participant' : 'joined-participant', joinCount === 1));
      } else if (record.frame.type === 'JoinConfNotify') heldReport = record;
      else if (record.frame.action === 'Subscribe' && record.data.subscribeType.includes('ParticipantsNotify')) heldSubscription = record;
      else f.defaultReply(record);
    };
    let completed = false;
    const joining = h.owner.join(invitation, ctx()).then(value => { completed = true; return value; });
    await h.events.take(value => value.type === 'state' && value.state === 'waiting');
    assert.equal(completed, false); assert.equal(boundary.calls.filter(call => call.op === 'join').length, 0);
    assert.deepEqual(f.tokenRequests[0].body, { name: invitation.nick_name, password: '', loginAccount: '', random: invitation.random });
    assert.equal(f.upgrades[0]['x-jwt-authorization'], '');
    assert.equal(f.upgrades[0].authorization, temporary.wssToken);
    const firstJoin = f.frames.find(record => record.frame.type === 'JOIN_RTC_CONF');
    assert.equal(firstJoin.data.conferenceID, confId); assert.equal(firstJoin.data.pwd, temporary.password);
    for (const key of ['random', 'site_url', 'idPrefix', 'token', 'nonce']) assert.equal(firstJoin.data[key], undefined);
    await assert.rejects(h.owner.join(invitation, ctx()), { code: 'OFFLINE_BUSY' });
    const socket = firstJoin.socket;
    f.notification(socket, 'ALLOWWAITINGPARTICIPANT', { participantID: 'someone-else' });
    await h.events.take(value => value.type === 'control' && value.frame.type === 'ALLOWWAITINGPARTICIPANT');
    assert.equal(joinCount, 1);
    f.notification(socket, 'ALLOWWAITINGPARTICIPANT', { participantID: 'waiting-participant' });
    const mediaJoin = await boundary.inbox.take(value => value.op === 'join');
    assert.equal(joinCount, 2); assert.equal(completed, false); assert.equal(heldReport, undefined);
    assert.deepEqual(mediaJoin.grant.signatureInfo, grant().signatureInfo);
    assert.equal(mediaJoin.context.identity.tmpUserID, temporary.tmpUserID);
    assert.equal(mediaJoin.context.identity.wssToken, undefined);
    assert.deepEqual(mediaJoin.context.offlineJoinTemplate, nativeTemplate);
    assert.deepEqual(mediaJoin.context.serviceTp, nativeTemplate.serviceTp);
    assert.equal(mediaJoin.context.route.nearbyMediaNodeName, 'fixture-nearby');
    assert.equal(mediaJoin.context.participantID, 'joined-participant');
    gate.resolve();
    const report = await frame(f, 'JoinConfNotify');
    assert.equal(completed, false);
    assert.deepEqual(report.data, { conferenceID: confId, participantID: 'joined-participant', mute: 1,
      cameraState: 0, video: 1, audioState: 0, enableCollaborate: 0 });
    // A successful response for a different sequence is not our completion.
    socket.send(JSON.stringify({ action: 'LocalNotify', type: 'JoinConfNotify', sequence: 'unrelated', data: '{"returnCode":0}' }));
    assert.equal(completed, false);
    f.reply(heldReport, { returnCode: 0 });
    await f.inbox.take(item => item.kind === 'frame' && item.record.frame.action === 'Subscribe' &&
      item.record.data.subscribeType.includes('ParticipantsNotify'));
    assert.equal(completed, false);
    assert.equal(heldSubscription.data.confToken, temporary.wssToken);
    assert.equal(heldSubscription.data.connectionType, 1);
    f.reply(heldSubscription, { returnCode: 0 });
    const receipt = await joining;
    assert.equal(receipt.joined, true); assert.equal(receipt.participantID, 'joined-participant');
    assert(socket.readyState === WebSocket.OPEN, 'Control socket must persist after admission');
    f.handler = record => f.defaultReply(record);
    f.notification(socket, 'VIDEO', { participantID: 'joined-participant', inviterParticipantID: 'chair', status: 1 });
    await h.events.take(value => value.type === 'media-invitation' && value.kind === 'camera');
    assert.equal(boundary.calls.some(call => call.op === 'camera' && call.enabled), false);
    await h.owner.answerMediaInvitation('camera', true);
    const answer = f.frames.find(record => record.frame.type === 'ANSWER_VIDEO');
    assert.equal(answer.data.answer, 3); assert.equal(answer.data.confToken, temporary.wssToken);
    const devices = f.frames.find(record => record.frame.type === 'ParticipantInfoNotify');
    assert.deepEqual(devices.data.pinfoMap, { MUTE: '1', CAMERA_STATE: '1' });
    f.notification(socket, 'VIDEO', { participantID: 'joined-participant', status: 0 });
    await f.inbox.take(item => item.kind === 'frame' && item.record.frame.type === 'ParticipantInfoNotify' &&
      item.record.data.pinfoMap.CAMERA_STATE === '0');
    f.notification(socket, '', [{ pid: 'joined-participant', pinfoMap: { STATE: '1' } }], 'ParticipantsNotify');
    await h.events.take(value => value.type === 'control' && value.frame.action === 'ParticipantsNotify');
    assert.equal(h.owner.getState().state, 'joined');
    f.notification(socket, 'HANGUP', { participantID: 'different-participant', reason: 7 });
    await h.events.take(value => value.type === 'control' && value.frame.type === 'HANGUP');
    assert.equal(h.owner.getState().state, 'joined');
    f.notification(socket, 'MOVETOWAITINGROOM', { participantID: 'joined-participant' });
    await h.events.take(value => value.type === 'state' && value.state === 'waiting');
    assert.equal(boundary.calls.filter(call => call.op === 'join').length, 1);
    f.notification(socket, 'REJOIN_CONF', { conferenceID: confId, signatureInfo: grant().signatureInfo });
    await h.events.take(value => value.type === 'control' && value.frame.type === 'REJOIN_CONF');
    assert.equal(boundary.calls.filter(call => call.op === 'join').length, 1, 'Media rejoin cannot release a waiting participant');
    f.notification(socket, 'ALLOWWAITINGPARTICIPANT', { participantID: 'joined-participant' });
    await h.events.take(value => value.type === 'state' && value.state === 'joined' && value.participantID === 'participant-1');
    assert.equal(boundary.calls.filter(call => call.op === 'join').length, 2);
    await h.owner.leave();
    assert.equal(h.owner.getState().state, 'idle');
    assert(boundary.calls.some(call => call.op === 'leave'));
    await h.owner.dispose();

    // Audience pre-admission is a separate native state: conference opening
    // causes a fresh JOIN_RTC_CONF rather than reusing a previously withheld grant.
    const audience = makeOwner(f);
    let audienceJoins = 0;
    f.handler = record => {
      if (record.frame.type === 'JOIN_RTC_CONF') {
        ++audienceJoins;
        f.reply(record, { ...grant(), role: '2', allowAudience: audienceJoins > 1 });
      } else f.defaultReply(record);
    };
    const audienceResult = audience.owner.join(invitation, ctx());
    await audience.events.take(value => value.type === 'state' && value.waitingReason === 'audience');
    assert.equal(audience.boundary.calls.some(call => call.op === 'join'), false);
    const audienceSocket = f.frames.filter(record => record.frame.type === 'JOIN_RTC_CONF').at(-1).socket;
    f.notification(audienceSocket, '', { conferenceID: confId, conferenceState: 'Created', allowAudience: true }, 'ConferenceStatesNotify');
    await audienceResult;
    assert.equal(audienceJoins, 2);
    await audience.owner.leave(); await audience.owner.dispose();
    f.handler = null;

    // Established control is leased, not reconstructed with browser credentials.
    const beforeTokens = f.tokenRequests.length;
    const established = await openControlSession({ origin: f.origin, config: f.config, authorization: 'existing-type-1-token',
      jwtAuthorization: 'existing-native-jwt', timeoutMs: 2000, isCurrent: () => true });
    let released = 0;
    const reuse = makeOwner(f, { getSession: () => ({ session: established, identity: { tmpUserID: 'existing-user' }, release: () => { ++released; } }) });
    await reuse.owner.join({ ...invitation, isOfflineJoin: false }, { ...ctx(), isServerDowngrade: true });
    assert.equal(f.tokenRequests.length, beforeTokens);
    const query = f.frames.find(record => record.frame.type === 'QueryConfInfoForJoin');
    assert.deepEqual(query.data, { conferenceID: confId, password: '', random: invitation.random });
    await reuse.owner.leave(); assert.equal(released, 1); assert.equal(established.closed, false);
    established.close(); await reuse.owner.dispose();

    // A leased socket survives its borrower. Cancellation must therefore hold
    // the correlated JOIN result, leave its exact late participant, and wait
    // for that leave receipt before releasing the lease. Unknown outcomes
    // retire the socket rather than returning a reusable admitted session.
    for (const outcome of ['confirmed', 'unknown-join', 'unknown-leave']) {
      const leased = await openControlSession({ origin: f.origin, config: f.config,
        authorization: 'existing-type-1-token', timeoutMs: 1000, isCurrent: () => true });
      const lateParticipant = 'late-leased-' + outcome;
      const nickName = 'cancelled-lease-' + outcome;
      let leaseReleases = 0, departureFinished = false;
      const cancelling = makeOwner(f, { getSession: () => ({
        session: leased,
        release: () => {
          assert.equal(leased.closed, outcome !== 'confirmed', 'An uncertain lease must be retired before release');
          ++leaseReleases;
        }
      }) });
      f.handler = record => {
        if (record.frame.type === 'JOIN_RTC_CONF' || record.frame.type === 'LeaveConfNotify') return;
        f.defaultReply(record);
      };
      const pendingMembership = cancelling.owner.join({ ...invitation, nick_name: nickName }, ctx());
      const cancelledMembership = assert.rejects(pendingMembership, { code: 'OFFLINE_JOIN_CANCELLED' });
      const pendingGrant = (await f.inbox.take(item => item.kind === 'frame' &&
        item.record.frame.type === 'JOIN_RTC_CONF' && item.record.data.nickName === nickName)).record;
      const departure = cancelling.owner.leave().then(value => {
        departureFinished = true; return { value };
      }, error => {
        departureFinished = true; return { error };
      });
      await cancelledMembership;
      await cancelling.boundary.inbox.take(value => value.op === 'leave');
      assert.equal(departureFinished, false);
      assert.equal(leaseReleases, 0);
      assert.equal(leased.closed, false);
      assert.equal(cancelling.boundary.calls.some(call => call.op === 'join'), false);
      if (outcome !== 'unknown-join') {
        f.reply(pendingGrant, grant(lateParticipant));
        const exactLeave = (await f.inbox.take(item => item.kind === 'frame' &&
          item.record.frame.type === 'LeaveConfNotify' && item.record.data.participantID === lateParticipant)).record;
        assert.deepEqual(exactLeave.data, { conferenceID: confId, participantID: lateParticipant });
        assert.equal(departureFinished, false);
        assert.equal(leaseReleases, 0);
        assert.equal(cancelling.boundary.calls.some(call => call.op === 'join'), false);
        if (outcome === 'confirmed') {
          const unrelated = defer();
          leased.once('notification', unrelated.resolve);
          f.reply(exactLeave, { returnCode: 0 }, { sequence: 'unrelated-cancelled-leave' });
          await unrelated.promise;
          assert.equal(departureFinished, false);
          assert.equal(leaseReleases, 0);
          f.reply(exactLeave, { returnCode: 0 });
        }
      }
      const departureResult = await departure;
      if (outcome === 'confirmed') {
        assert.equal(departureResult.error, undefined);
        assert.deepEqual(departureResult.value, { left: true, conferenceID: confId, participantID: lateParticipant });
      } else {
        assert.equal(departureResult.value, undefined);
        assert.equal(departureResult.error.code, outcome === 'unknown-join' ?
          'OFFLINE_ADMISSION_UNCONFIRMED' : 'OFFLINE_CONTROL_TIMEOUT');
        assert.equal(cancelling.seen.some(value => value.state === 'left'), false);
      }
      assert.equal(leaseReleases, 1);
      assert.equal(cancelling.boundary.calls.some(call => call.op === 'join'), false);
      await cancelling.owner.dispose();
      leased.close();
    }
    f.handler = null;

    // Native business rejections do not become online authentication, endpoint
    // retries, or successful membership. Certificate failures fail closed.
    f.tokenHandler = record => record.response.end(JSON.stringify({ returnCode: 11070009, returnDesc: 'fixture password rejection' }));
    let failed = makeOwner(f);
    assert.equal((await failedJoin(failed)).code, 11070009);
    assert.equal(failed.boundary.calls.some(call => call.op === 'join'), false);
    f.tokenHandler = record => record.response.end(JSON.stringify({ ...temporary, confMode: 'COMMON' }));
    assert.equal((await failedJoin(makeOwner(f))).code, 414100070);
    f.tokenHandler = record => { record.response.writeHead(302, { Location: invitation.site_url }); record.response.end(); };
    const beforeRedirect = f.tokenRequests.length;
    assert.equal((await failedJoin(makeOwner(f))).code, 'OFFLINE_REDIRECT_REJECTED');
    assert.equal(f.tokenRequests.length, beforeRedirect + 1);
    f.tokenHandler = null;
    const beforeCA = f.tokenRequests.length;
    const caError = await failedJoin(makeOwner(f, { config: { ...f.config, caBundle: f.wrongCA } }));
    assert(caError.code); assert.notEqual(caError.code, 'OFFLINE_MEDIA_UNCONFIRMED');
    assert.equal(f.tokenRequests.length, beforeCA);
    const wrongHost = { ...f.config, offlineJoinConfigPath: undefined,
      offlineJoinConfig: { Domains: { httpProxyUri: 'wrong-host.invalid:' + new URL(f.origin).port } } };
    const hostError = await failedJoin(makeOwner(f, { config: wrongHost }));
    assert.equal(hostError.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
    const beforeOnline = f.tokenRequests.length;
    assert.equal((await failedJoin(makeOwner(f), { ...invitation, isOfflineJoin: false })).code, 'OFFLINE_VARIANT_REQUIRED');
    assert.equal(f.tokenRequests.length, beforeOnline);

    // Correlation, grant identity, real media receipt, report and subscription
    // errors each retire the owned participant; no synthetic joined event.
    for (const mode of ['wrong-operation', 'wrong-conference', 'media-rejected', 'report-rejected', 'subscribe-rejected']) {
      const rejected = makeOwner(f, { boundary: mediaBoundary({ invalid: mode === 'media-rejected' }) });
      f.handler = record => {
        if (record.frame.type === 'JOIN_RTC_CONF' && mode === 'wrong-operation')
          f.reply(record, grant(), { type: 'QueryConfInfoForJoin' });
        else if (record.frame.type === 'JOIN_RTC_CONF' && mode === 'wrong-conference')
          f.reply(record, { ...grant(), conferenceID: 'another-conference' });
        else if (record.frame.type === 'JoinConfNotify' && mode === 'report-rejected')
          f.reply(record, { returnCode: 11072008, returnDesc: 'fixture participant missing' });
        else if (record.frame.action === 'Subscribe' && mode === 'subscribe-rejected')
          f.reply(record, { returnCode: 11076027, returnDesc: 'fixture subscription rejected' });
        else f.defaultReply(record);
      };
      const error = await failedJoin(rejected);
      assert(error.code, mode); assert.equal(rejected.seen.some(value => value.state === 'joined'), false, mode);
    }
    f.handler = null;

    // Logout while the token is outstanding cannot install temporary identity.
    const retired = makeOwner(f), abort = new AbortController();
    f.tokenHandler = () => {};
    const retirement = retired.owner.join(invitation, { ...ctx(), signal: abort.signal });
    const retirementError = assert.rejects(retirement, { code: 'OFFLINE_RETIRED' });
    const pendingToken = await f.inbox.take(item => item.kind === 'token' && !item.record.response.writableEnded);
    abort.abort(); await retirementError; await retired.owner.dispose();
    pendingToken.record.response.end(JSON.stringify(temporary));
    assert.equal(retired.boundary.calls.some(call => call.op === 'join'), false);
    f.tokenHandler = null;

    // Required JOIN response timeout and post-join control loss dispose media.
    f.handler = record => { if (record.frame.type !== 'JOIN_RTC_CONF') f.defaultReply(record); };
    assert.equal((await failedJoin(makeOwner(f, { timeoutMs: 1000 }))).code, 'OFFLINE_CONTROL_TIMEOUT');
    f.handler = null;
    const lost = makeOwner(f);
    await lost.owner.join(invitation, ctx());
    lost.boundary.fail(Object.assign(Error('fixture media transport lost'), { code: 'RTC_TRANSPORT_LOST' }));
    await lost.events.take(value => value.type === 'state' && value.state === 'failed');
    await lost.owner.dispose();
    assert(lost.boundary.calls.some(call => call.op === 'leave'));
    assert(f.proxyRequests.every(value => !value.includes('untrusted-invitation.invalid')));
    console.log('PASS native offline control: route/config isolation, verified TLS/proxy, token and established-session branches, waiting-room rejoin, exact grants, media/report/subscription boundaries, device consent, correlation, disposal');
  } finally {
    if (f) await f.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
