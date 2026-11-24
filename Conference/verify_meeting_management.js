#!/usr/bin/env node
'use strict';

/* Parent-run isolated verification of the real Conference service/management
 * helpers. Uses genuine ws + HTTPS/CONNECT transports and synthetic loopback
 * service responses; does not replace the helpers or execute any vendor SDK/UI.
 * Usage: node verify_meeting_management.js [--heartbeat]
 * --heartbeat additionally waits for the real native 30-second application PING.
 * Requires openssl; temporary CA/keys and sockets are removed in finally blocks.
 */
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const net = require('net');
const { execFileSync } = require('child_process');
const nativeRoot = process.env.WELINK_TEST_NATIVE || __dirname;
const WebSocket = require(path.join(nativeRoot, 'vendor/management/node_modules/ws'));
const { createManagementTransport } = require(path.join(nativeRoot, 'meeting_native_web_management'));
const { createMeetingServices, normalizeInvitation } = require(path.join(nativeRoot, 'meeting_native_web_services'));

const TOKEN = 'synthetic-native-usg-token';
const USER_AGENT = 'SyntheticWeLink/verification';
const DEVICE = 'synthetic-linux-device';
const CALLER = '999000001';
const CALLEE = '999000002';
const CONFERENCE = '900000001';
const CONTROL_TOKEN = 'synthetic-conference-control-token';
const CHAIR_PASSWORD = 'synthetic-chairman-password';
const expectedBody = {
  ctd: true, size: 0, length: 60, confType: 'FUTURE', subject: '',
  mediaTypes: 'Voice', welcomeVoiceEnable: 0, isAutoRecord: 0,
  recordType: 0, multiStreamFlag: 0, timeZoneID: '56', language: 'zh-CN',
  recordAuxStream: 1,
  attendees: [
    { accountId: '', name: '', role: 1, phone: CALLER, email: '', sms: '', isMute: 0, isAutoInvite: 1, type: 'normal' },
    { accountId: '', name: '', role: 0, phone: CALLEE, email: '', sms: '', isMute: 0, isAutoInvite: 1, type: 'normal' }
  ],
  confConfigInfo: { confExtendProperties: [{ propertyKey: 'supportWatermark', propertyValue: false }] },
  token: TOKEN
};
const ctdParams = { caller_number: CALLER, callee_number: CALLEE };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function observed(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Fixture did not observe ' + label)), 2500);
    })]);
  } finally { clearTimeout(timer); }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}
function provision(directory) {
  const ca = path.join(directory, 'ca.pem');
  const caKey = path.join(directory, 'ca.key');
  const key = path.join(directory, 'server.key');
  const csr = path.join(directory, 'server.csr');
  const cert = path.join(directory, 'server.pem');
  const extensions = path.join(directory, 'server.ext');
  fs.writeFileSync(extensions, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
  const commands = [
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=Isolated meeting management CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', ca],
    ['req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', csr],
    ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '1', '-sha256', '-extfile', extensions, '-out', cert]
  ];
  for (const args of commands) execFileSync('openssl', args, { stdio: 'pipe' });
  const localhostExtensions = path.join(directory, 'localhost-only.ext');
  const localhostOnlyCert = path.join(directory, 'localhost-only.pem');
  fs.writeFileSync(localhostExtensions, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey,
    '-CAcreateserial', '-days', '1', '-sha256', '-extfile', localhostExtensions, '-out', localhostOnlyCert], { stdio: 'pipe' });
  return { ca, key: fs.readFileSync(key), cert: fs.readFileSync(cert), localhostOnlyCert: fs.readFileSync(localhostOnlyCert) };
}

class Fixture {
  constructor(certificates) {
    this.certificates = certificates;
    this.mode = 'success';
    this.endMode = 'success';
    this.records = [];
    this.httpRecords = [];
    this.faults = [];
    this.sockets = new Set();
    this.proxySockets = new Set();
    this.connects = 0;
    this.pings = 0;
    this.upgrades = 0;
    this.server = https.createServer({ key: certificates.key, cert: certificates.cert }, (request, response) => this.http(request, response));
    this.server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    this.server.on('tlsClientError', error => this.faults.push(error));
    this.wss = new WebSocket.Server({ noServer: true, handleProtocols: protocols => protocols.has('tup_service_protocol') ? 'tup_service_protocol' : false });
    this.server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head));
    this.wss.on('connection', socket => this.connection(socket));
    this.proxy = http.createServer((request, response) => { response.writeHead(405); response.end(); });
    this.proxy.on('connection', socket => { this.proxySockets.add(socket); socket.once('close', () => this.proxySockets.delete(socket)); });
    this.proxy.on('connect', (request, socket, head) => {
      try {
        assert.equal(request.url, '127.0.0.1:' + this.server.address().port);
        assert.equal(request.headers['proxy-authorization'], 'Basic ' + Buffer.from('synthetic-proxy-user:synthetic-proxy-password').toString('base64'));
        ++this.connects;
        const upstream = net.connect(this.server.address().port, '127.0.0.1');
        this.proxySockets.add(upstream);
        upstream.once('close', () => this.proxySockets.delete(upstream));
        upstream.on('error', error => { this.faults.push(error); socket.destroy(); });
        socket.on('error', error => { this.faults.push(error); upstream.destroy(); });
        upstream.once('connect', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          socket.pipe(upstream); upstream.pipe(socket);
        });
      } catch (error) { this.faults.push(error); socket.destroy(); }
    });
  }
  async start() {
    await listen(this.server);
    await listen(this.proxy);
    this.origin = 'https://127.0.0.1:' + this.server.address().port;
  }
  config(useProxy = false) {
    return { server: '127.0.0.1', port: this.server.address().port, userAgent: USER_AGENT, deviceId: DEVICE,
      caBundle: this.certificates.ca, ...(useProxy ? {
        proxyUrl: 'http://127.0.0.1:' + this.proxy.address().port,
        proxyUsername: 'synthetic-proxy-user', proxyPassword: 'synthetic-proxy-password'
      } : {}) };
  }
  upgrade(request, socket, head) {
    ++this.upgrades;
    try {
      const url = new URL(request.url, this.origin);
      assert.equal(url.pathname, '/v1/usg/wss/websocket');
      assert.equal(url.searchParams.get('agent'), USER_AGENT);
      assert.equal(request.headers['x-auth-token'], TOKEN);
      assert.equal(request.headers['user-agent'], USER_AGENT);
      assert.equal(request.headers['x-device-id'], DEVICE);
      assert.equal(request.headers['x-jwt-authorization'], '');
      assert.equal(request.headers['x-request-unified-link'], '1');
      assert.equal(request.headers['sec-websocket-protocol'], 'tup_service_protocol');
      assert.match(request.headers['x-request-id'], /^[0-9a-f-]{36}$/i);
      if (this.mode === 'handshake-401') {
        const body = JSON.stringify({ error_code: 'USG.synthetic-denial', error_msg: 'Synthetic unauthorized' });
        socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body);
        return;
      }
      if (this.mode === 'held-upgrade') {
        this.upgradeNotice.resolve(socket);
        return;
      }
      this.wss.handleUpgrade(request, socket, head, ws => this.wss.emit('connection', ws, request));
    } catch (error) { this.faults.push(error); socket.destroy(); }
  }
  connection(socket) {
    const mode = this.mode;
    let creation;
    let receivedAt;
    socket.on('error', error => this.faults.push(error));
    const reply = (packet, data) => socket.send(JSON.stringify({ action: 'ConfManagement', type: 'CREATECONF', sequence: packet.sequence,
      data: JSON.stringify(data || { returnCode: 0, data: [{ conferenceID: CONFERENCE, subject: 'Synthetic CTD' }] }) }));
    socket.on('message', (data, binary) => {
      try {
        assert.equal(binary, false);
        const packet = JSON.parse(data.toString('utf8'));
        if (packet.action === 'PING') {
          assert.equal(mode, 'heartbeat');
          assert.deepEqual(packet, { action: 'PING' });
          assert.ok(creation, 'application PING preceded CREATECONF');
          assert.ok(Date.now() - receivedAt >= 29000, 'management heartbeat was sent before the recovered interval');
          ++this.pings;
          socket.send(JSON.stringify({ action: 'PONG' }));
          reply(creation);
          return;
        }
        assert.equal(creation, undefined, 'a CTD request was retransmitted');
        assert.deepEqual(Object.keys(packet).sort(), ['action', 'data', 'sequence', 'type']);
        assert.equal(packet.action, 'ConfManagement');
        assert.equal(packet.type, 'CREATECONF');
        assert.match(packet.sequence, /^[0-9a-f-]{36}$/i);
        assert.equal(typeof packet.data, 'string');
        assert.deepEqual(JSON.parse(packet.data), expectedBody);
        creation = packet; receivedAt = Date.now();
        this.records.push({ mode, packet });
        if (this.creationNotice) {
          const notice = this.creationNotice;
          this.creationNotice = null;
          notice.resolve({ socket, packet, reply: body => reply(packet, body) });
        }
        if (mode === 'held') return;
        if (mode === 'timeout' || mode === 'cancel' || mode === 'heartbeat') return;
        if (mode === 'disconnect') { socket.terminate(); return; }
        if (mode === 'wrong-type') {
          socket.send(JSON.stringify({ action: 'ConfManagement', type: 'OTHER', sequence: packet.sequence, data: '{}' }));
          return;
        }
        if (mode === 'vendor-error') { reply(packet, { returnCode: 712345, returnDesc: 'Synthetic rejected creation' }); return; }
        if (mode === 'unrelated-first') {
          socket.send(JSON.stringify({ action: 'ConfManagement', type: 'CREATECONF', sequence: 'unrelated-sequence',
            data: JSON.stringify({ returnCode: 0, data: [{ conferenceID: 'wrong-conference' }] }) }));
        }
        reply(packet);
      } catch (error) { this.faults.push(error); socket.terminate(); }
    });
  }
  async http(request, response) {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      const url = new URL(request.url, this.origin);
      assert.equal(request.headers['x-auth-token'], TOKEN);
      this.httpRecords.push({ method: request.method, path: url.pathname, body, query: Object.fromEntries(url.searchParams) });
      let reply;
      if (url.pathname === '/v1/usg/acs/ap/userservicedata') {
        assert.equal(request.method, 'GET');
        reply = this.mode === 'pstn-missing' ? { corpCfg: {} } : { corpCfg: { pstnNumber: 'synthetic-pstn-access' } };
      } else if (url.pathname === '/v1/mmc/control/conferences/token') {
        assert.equal(request.method, 'GET');
        assert.equal(url.searchParams.get('conferenceID'), CONFERENCE);
        assert.equal(request.headers['x-password'], CHAIR_PASSWORD);
        assert.equal(request.headers['x-login-type'], '1');
        reply = { data: { token: CONTROL_TOKEN } };
      } else if (url.pathname === '/v1/mmc/control/conferences/participants') {
        assert.equal(request.method, 'POST');
        assert.equal(url.searchParams.get('conferenceID'), CONFERENCE);
        assert.equal(request.headers['x-conference-authorization'], CONTROL_TOKEN);
        assert.deepEqual(body, { attendees: [{ phone: CALLEE, name: 'Synthetic invitee', type: 'normal' }] });
        response.writeHead(200, { 'Content-Length': '0', Connection: 'close' }); response.end(); return;
      } else if (url.pathname === '/v1/mmc/management/conferences') {
        if (request.method === 'DELETE') {
          assert.equal(url.searchParams.get('type'), '1');
          assert.equal(request.headers['x-invoke-from'], 'portal');
          assert.equal(body, undefined);
          reply = this.endMode === 'refused' ? { returnCode: 713001, returnDesc: 'Synthetic end refusal' } :
            { returnCode: 0, data: {} };
        } else {
          assert.equal(request.method, 'GET');
          reply = { data: [], offset: 0, limit: 10, count: 0 };
        }
      } else throw new Error('Unexpected HTTP route in the isolated fixture');
      const encoded = JSON.stringify(reply);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded), Connection: 'close' });
      response.end(encoded);
    } catch (error) { this.faults.push(error); response.writeHead(500); response.end(); }
  }
  request(method, servicePath, { body, query, headers } = {}) {
    const endpoint = new URL(servicePath, this.origin);
    assert.equal(endpoint.origin, this.origin);
    for (const [name, value] of Object.entries(query || {})) endpoint.searchParams.set(name, String(value));
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = https.request(endpoint, { method, ca: fs.readFileSync(this.certificates.ca), rejectUnauthorized: true, agent: false,
        headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/json;charset=UTF-8', ...headers,
          ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }) } }, response => {
        const chunks = [];
        response.on('error', reject);
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: response.statusCode, data: text ? JSON.parse(text) : null, headers: response.headers });
          } catch (error) { reject(error); }
        });
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('Fixture HTTP request timed out')));
      request.end(payload);
    });
  }
  check() { if (this.faults.length) throw this.faults[0]; }
  async stop() {
    for (const client of this.wss.clients) client.terminate();
    for (const socket of this.sockets) socket.destroy();
    for (const socket of this.proxySockets) socket.destroy();
    await Promise.all([close(this.server), close(this.proxy), new Promise(resolve => this.wss.close(resolve))]);
  }
}

async function verifyPendingCalls(fixture, makeTransport) {
  const makeServices = transport => createMeetingServices({
    request: fixture.request.bind(fixture), requestManagementAttempt: transport.begin
  });
  const ends = () => fixture.httpRecords.filter(record => record.method === 'DELETE');
  const startHeld = async (services, callRequestId) => {
    fixture.mode = 'held';
    const notice = fixture.creationNotice = deferred();
    const pending = services.execute('call.ctd.start', { ...ctdParams, callRequestId });
    pending.catch(() => {});
    const creation = await observed(notice.promise, 'CREATECONF');
    const state = await services.execute('call.ctd.state', { callRequestId });
    assert.equal(state.phase, 'sent');
    assert.equal(state.cancellationAvailable, true);
    assert.equal(state.callRequestId, callRequestId);
    return { pending, creation, state };
  };

  // TLS and the real upgrade request reach loopback, but CREATECONF is not sent.
  const preTransport = makeTransport();
  const pre = makeServices(preTransport);
  assert.equal(pre.capabilities['call.ctd.cancel'], true);
  fixture.mode = 'held-upgrade';
  fixture.upgradeNotice = deferred();
  let before = fixture.records.length;
  const beforeUpgrade = fixture.upgrades;
  const prePending = pre.execute('call.ctd.start', { ...ctdParams, callRequestId: 'pre-send' });
  await observed(fixture.upgradeNotice.promise, 'held TLS upgrade');
  const preState = await pre.execute('call.ctd.state', { callRequestId: 'pre-send' });
  assert.equal(preState.phase, 'preparing');
  await pre.execute('call.ctd.cancel', { attemptId: preState.attemptId });
  const notSent = await prePending;
  assert.equal(notSent.callState.phase, 'not_sent');
  assert.equal(notSent.callState.transmissionAttempted, false);
  assert.equal(notSent.callState.endAttempted, false);
  assert.equal(notSent.callState.retryBlocked, false);
  assert.equal(notSent.conferenceID, undefined);
  assert.equal(fixture.upgrades - beforeUpgrade, 1);
  assert.equal(fixture.records.length, before);
  assert.equal(ends().length, 0);

  // Cancelling during asynchronous credential lookup settles without waiting
  // for that provider, and its eventual result cannot open an old connection.
  const enteredToken = deferred(), token = deferred();
  const tokenTransport = makeTransport({ getAccessToken: () => { enteredToken.resolve(); return token.promise; } });
  const tokenServices = makeServices(tokenTransport);
  const tokenPending = tokenServices.execute('call.ctd.start', { ...ctdParams, callRequestId: 'held-token' });
  await observed(enteredToken.promise, 'credential lookup');
  const tokenState = await tokenServices.execute('call.ctd.state');
  await tokenServices.execute('call.ctd.cancel', { attemptId: tokenState.attemptId });
  assert.equal((await tokenPending).callState.phase, 'not_sent');
  token.resolve(TOKEN);
  await delay(10);
  assert.equal(fixture.records.length, before);
  assert.equal(fixture.upgrades - beforeUpgrade, 1);

  // Post-send intent leaves the original correlated future and socket alive.
  const delayed = makeServices(makeTransport());
  const call = await startHeld(delayed, 'delayed-exact-id');
  assert.equal((await delayed.execute('call.ctd.state', { callRequestId: 'another-window' })).phase, 'idle');
  await assert.rejects(delayed.execute('call.ctd.start', { ...ctdParams, callRequestId: 'another-window' }),
    error => error.code === 'CALL_PENDING' && error.details?.callState === undefined);
  await assert.rejects(delayed.execute('call.ctd.cancel', { attemptId: 'another-attempt' }),
    error => error.code === 'CALL_ATTEMPT_MISMATCH');
  const intent = await delayed.execute('call.ctd.cancel', { attemptId: call.state.attemptId });
  assert.equal(intent.phase, 'cancel_requested');
  assert.equal(intent.endConfirmed, false);
  await delayed.execute('call.ctd.cancel', { attemptId: call.state.attemptId });
  call.creation.socket.send(JSON.stringify({ action: 'ConfManagement', type: 'CREATECONF', sequence: 'wrong-sequence',
    data: JSON.stringify({ returnCode: 0, data: [{ conferenceID: 'must-not-be-ended' }] }) }));
  await delay(30);
  assert.equal(call.creation.socket.readyState, WebSocket.OPEN);
  assert.equal((await delayed.execute('call.ctd.state')).phase, 'cancel_requested');
  assert.equal(ends().length, 0, 'an unrelated frame triggered an end');
  assert.equal((await delayed.execute('conference.list')).data.count, 0, 'pending cancellation blocked an unrelated conference operation');
  const exactID = '900000099';
  call.creation.reply({ returnCode: 0, data: [{ conferenceID: exactID, subject: 'Synthetic delayed CTD' }] });
  const cancelled = await call.pending;
  assert.equal(cancelled.conferenceID, exactID);
  assert.equal(cancelled.callState.phase, 'cancelled');
  assert.equal(cancelled.callState.creationConfirmed, true);
  assert.equal(cancelled.callState.endConfirmed, true);
  assert.equal(cancelled.callState.retryBlocked, false);
  assert.equal(cancelled.cancellation.status, 200);
  assert.deepEqual(ends().map(record => record.query), [{ conferenceID: exactID, type: '1' }]);
  await delayed.execute('call.ctd.cancel', { attemptId: call.state.attemptId });
  assert.equal(ends().length, 1, 'duplicate cancellation dispatched a second end');
  assert.equal(fixture.records.length - before, 1, 'pending call guard allowed a second creation');

  // A correlated refusal is known non-creation, not a cancelled conference.
  const refusal = makeServices(makeTransport());
  const refused = await startHeld(refusal, 'late-refusal');
  await refusal.execute('call.ctd.cancel', { attemptId: refused.state.attemptId });
  refused.creation.reply({ returnCode: 712345, returnDesc: 'Synthetic late creation refusal' });
  await assert.rejects(refused.pending, error => error.code === 712345 &&
    error.details.callState.phase === 'refused' && error.details.callState.endAttempted === false &&
    error.details.callState.retryBlocked === false && error.details.creationRefused === true);
  assert.equal(ends().length, 1);
  fixture.mode = 'success';
  assert.equal((await refusal.execute('call.ctd.start', ctdParams)).callState.phase, 'created');

  // A real failed end keeps the exact ID, but never labels the conference ended.
  const endFailure = makeServices(makeTransport());
  const failed = await startHeld(endFailure, 'end-refusal');
  await endFailure.execute('call.ctd.cancel', { attemptId: failed.state.attemptId });
  fixture.endMode = 'refused';
  failed.creation.reply();
  await assert.rejects(failed.pending, error => error.code === 713001 &&
    error.details.callState.phase === 'end_failed' && error.details.callState.creationConfirmed === true &&
    error.details.callState.conferenceID === CONFERENCE && error.details.callState.endConfirmed === false);
  assert.equal(ends().length, 2);
  await endFailure.execute('call.ctd.cancel', { attemptId: failed.state.attemptId });
  await assert.rejects(endFailure.execute('call.ctd.start', ctdParams), error => error.code === 'CALL_RETRY_BLOCKED');
  assert.equal(ends().length, 2, 'failed end was retried');
  fixture.endMode = 'success';

  // Disconnection after send is indeterminate; no guessed ID, end or redial.
  const disconnected = makeServices(makeTransport());
  const lost = await startHeld(disconnected, 'disconnect-after-cancel');
  await disconnected.execute('call.ctd.cancel', { attemptId: lost.state.attemptId });
  before = fixture.records.length;
  lost.creation.socket.terminate();
  await assert.rejects(lost.pending, error => error.code === 'MANAGEMENT_CONNECTION_CLOSED' &&
    error.details.callState.phase === 'unknown' && error.details.callState.retryBlocked === true &&
    error.details.callState.endAttempted === false && error.details.callState.conferenceID === undefined);
  await assert.rejects(disconnected.execute('call.ctd.start', ctdParams), error => error.code === 'CALL_RETRY_BLOCKED');
  assert.equal(fixture.records.length, before);
  assert.equal(ends().length, 2);
  assert.equal((await disconnected.execute('conference.list')).data.count, 0);

  const timedOut = makeServices(makeTransport({ timeoutMs: 150 }));
  const timed = await startHeld(timedOut, 'timeout-after-cancel');
  await timedOut.execute('call.ctd.cancel', { attemptId: timed.state.attemptId });
  await assert.rejects(timed.pending, error => error.code === 'MANAGEMENT_TIMEOUT' &&
    error.details.callState.phase === 'unknown' && error.details.callState.endAttempted === false);
  await assert.rejects(timedOut.execute('call.ctd.start', ctdParams), error => error.code === 'CALL_RETRY_BLOCKED');
  assert.equal(ends().length, 2);

  // The exact reply may already be in flight at logout. Account retirement
  // invalidates that continuation before it can issue an end with new identity.
  const hardTransport = makeTransport();
  const hard = makeServices(hardTransport);
  const retired = await startHeld(hard, 'account-retirement');
  await hard.execute('call.ctd.cancel', { attemptId: retired.state.attemptId });
  retired.creation.reply();
  hard.retireCalls();
  hardTransport.cancel();
  const retiredState = await hard.execute('call.ctd.state');
  assert.equal(retiredState.phase, 'idle');
  assert.equal(retiredState.attemptId, null);
  assert.equal(retiredState.conferenceID, undefined);
  assert.equal((await hard.execute('call.ctd.state', { callRequestId: 'account-retirement' })).phase, 'idle');
  await assert.rejects(hard.execute('call.ctd.cancel', { attemptId: retired.state.attemptId }),
    error => error.code === 'CALL_ATTEMPT_MISMATCH');
  await assert.rejects(retired.pending, error => error.details.callState.retired === true &&
    error.details.callState.phase === 'unknown' && error.details.callState.endAttempted === false);
  await delay(30);
  assert.equal(ends().length, 2, 'retired continuation issued an end');
  assert.equal((await hard.execute('call.ctd.state')).phase, 'idle', 'retired completion restored public call state');
  fixture.mode = 'success';
  const newAccount = await hard.execute('call.ctd.start', { ...ctdParams, callRequestId: 'next-account' });
  assert.equal(newAccount.callState.phase, 'created');
  assert.notEqual(newAccount.callState.attemptId, retired.state.attemptId);
  await assert.rejects(hard.execute('call.ctd.cancel', { attemptId: retired.state.attemptId }),
    error => error.code === 'CALL_ATTEMPT_MISMATCH');
  // A completed attempt must not expose its real conference ID to the next account.
  hard.retireCalls();
  const completedRetiredState = await hard.execute('call.ctd.state');
  assert.equal(completedRetiredState.phase, 'idle');
  assert.equal(completedRetiredState.attemptId, null);
  assert.equal(completedRetiredState.conferenceID, undefined);
  await assert.rejects(hard.execute('call.ctd.cancel', { attemptId: newAccount.callState.attemptId }),
    error => error.code === 'CALL_ATTEMPT_MISMATCH');

  // Correlation alone is not a legitimate ID; malformed success stays unknown.
  const malformed = makeServices(makeTransport());
  const missingID = await startHeld(malformed, 'missing-conference-id');
  await malformed.execute('call.ctd.cancel', { attemptId: missingID.state.attemptId });
  missingID.creation.reply({ returnCode: 0, data: [{ subject: 'No conference ID' }] });
  await assert.rejects(missingID.pending, error => error.code === 'INVALID_SERVICE_RESPONSE' &&
    error.details.callState.phase === 'unknown' && error.details.callState.endAttempted === false &&
    error.details.callState.creationConfirmed === false && error.details.callState.conferenceID === undefined);
  await assert.rejects(malformed.execute('call.ctd.start', ctdParams), error => error.code === 'CALL_RETRY_BLOCKED');
  assert.equal(ends().length, 2, 'a malformed creation result supplied an invented end ID');

  const disposeTransport = makeTransport();
  const disposing = makeServices(disposeTransport);
  const disposed = await startHeld(disposing, 'dispose-after-send');
  await disposing.execute('call.ctd.cancel', { attemptId: disposed.state.attemptId });
  disposing.retireCalls();
  disposeTransport.dispose();
  await assert.rejects(disposed.pending, error => error.details.callState.retired === true &&
    error.details.callState.endAttempted === false);
  await assert.rejects(disposeTransport.request('CREATECONF', { ctd: true }), error => error.code === 'DISPOSED');
  assert.equal(ends().length, 2);
  fixture.check();
  console.log('PASS real pending CTD cancellation: pre-send, exact late ID, refusal, failed end, disconnect, timeout, retirement, no duplicate retry');
}

async function main() {
  const arguments_ = process.argv.slice(2);
  assert.ok(arguments_.every(argument => argument === '--heartbeat'), 'Only --heartbeat is accepted');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-management-verify-'));
  fs.chmodSync(directory, 0o700);
  let fixture;
  const transports = new Set();
  try {
    const certificates = provision(directory);
    fixture = new Fixture(certificates);
    await fixture.start();
    const makeTransport = (options = {}) => {
      const transport = createManagementTransport({ origin: fixture.origin, getConfig: async () => fixture.config(false),
        getAccessToken: async () => TOKEN, timeoutMs: 2000, ...options });
      transports.add(transport);
      return transport;
    };
    const transport = makeTransport();
    const services = createMeetingServices({ request: fixture.request.bind(fixture), requestManagement: transport.request });
    const unavailable = createMeetingServices({ request: fixture.request.bind(fixture) });
    assert.equal(unavailable.capabilities['call.ctd.start'], false);
    assert.equal(unavailable.capabilities['call.ctd.state'], false);
    assert.equal(unavailable.capabilities['call.ctd.cancel'], false);
    await assert.rejects(unavailable.execute('call.ctd.state'), error => error.code === 'CTD_PROVIDER_UNAVAILABLE');
    await assert.rejects(unavailable.execute('call.ctd.start', ctdParams), error => error.code === 'CTD_PROVIDER_UNAVAILABLE');
    assert.equal(fixture.records.length, 0);

    for (const mode of ['success', 'unrelated-first']) {
      fixture.mode = mode;
      const before = fixture.records.length;
      const result = await services.execute('call.ctd.start', ctdParams);
      assert.equal(result.transport, 'websocket');
      assert.equal(result.conferenceID, CONFERENCE);
      assert.equal(typeof result.response.data, 'string');
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'status'), false, 'WebSocket result manufactured an HTTP status');
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'connected'), false, 'creation acceptance claimed phone connection');
      assert.equal(fixture.records.length - before, 1);
      fixture.check();
    }
    fixture.mode = 'success';
    const proxied = makeTransport({ getConfig: async () => fixture.config(true) });
    const proxiedServices = createMeetingServices({ request: fixture.request.bind(fixture), requestManagement: proxied.request });
    assert.equal((await proxiedServices.execute('call.ctd.start', ctdParams)).conferenceID, CONFERENCE);
    assert.equal(fixture.connects, 1, 'configured authenticated proxy was bypassed');
    fixture.check();

    // This trusted leaf matches localhost, but not the configured IP target.
    // The proxy must not accidentally use localhost for certificate identity.
    const wrongPeer = new Fixture({ ...certificates, cert: certificates.localhostOnlyCert });
    let wrongTransport;
    try {
      await wrongPeer.start();
      wrongTransport = createManagementTransport({ origin: wrongPeer.origin,
        getConfig: async () => wrongPeer.config(true), getAccessToken: async () => TOKEN, timeoutMs: 2000 });
      await assert.rejects(wrongTransport.request('CREATECONF', { ctd: true }), error =>
        error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' && error.details.transmissionAttempted === false);
      assert.equal(wrongPeer.connects, 1, 'negative identity case did not use the real proxy');
      assert.equal(wrongPeer.upgrades, 0, 'credentials crossed TLS with the wrong peer identity');
      assert.equal(wrongPeer.records.length, 0, 'wrong peer received a conference creation');
    } finally {
      if (wrongTransport) wrongTransport.dispose();
      await wrongPeer.stop();
    }

    fixture.mode = 'vendor-error';
    await assert.rejects(services.execute('call.ctd.start', ctdParams), error =>
      error.code === 712345 && error.response.type === 'CREATECONF' && typeof error.response.data === 'string');
    fixture.mode = 'wrong-type';
    await assert.rejects(services.execute('call.ctd.start', ctdParams), error =>
      error.code === 'MANAGEMENT_CORRELATION_MISMATCH' && error.details.resultConfirmed === false);
    fixture.mode = 'disconnect';
    let before = fixture.records.length;
    await assert.rejects(services.execute('call.ctd.start', ctdParams), error =>
      error.code === 'MANAGEMENT_CONNECTION_CLOSED' && error.details.transmissionAttempted === true && error.details.resultConfirmed === false);
    assert.equal(fixture.records.length - before, 1, 'disconnected creation was retried');

    fixture.mode = 'timeout';
    const short = makeTransport({ timeoutMs: 150 });
    const shortServices = createMeetingServices({ request: fixture.request.bind(fixture), requestManagement: short.request });
    before = fixture.records.length;
    await assert.rejects(shortServices.execute('call.ctd.start', ctdParams), error =>
      error.code === 'MANAGEMENT_TIMEOUT' && error.details.transmissionAttempted === true && error.details.resultConfirmed === false);
    assert.equal(fixture.records.length - before, 1, 'timed-out creation was retried');

    fixture.mode = 'handshake-401';
    before = fixture.records.length;
    await assert.rejects(services.execute('call.ctd.start', ctdParams), error =>
      error.status === 401 && error.code === 'USG.synthetic-denial' && error.response.data.error_msg === 'Synthetic unauthorized');
    assert.equal(fixture.records.length, before, 'rejected handshake sent CREATECONF');

    fixture.mode = 'cancel';
    const cancelled = makeTransport();
    const cancelledServices = createMeetingServices({ request: fixture.request.bind(fixture), requestManagement: cancelled.request });
    before = fixture.records.length;
    const pending = cancelledServices.execute('call.ctd.start', ctdParams);
    pending.catch(() => {});
    const deadline = Date.now() + 2000;
    while (fixture.records.length === before && Date.now() < deadline) await delay(5);
    assert.equal(fixture.records.length - before, 1, 'cancel precondition did not reach the real socket');
    cancelled.cancel();
    await assert.rejects(pending, error => error.code === 'MANAGEMENT_REQUEST_ABORTED' && error.details.transmissionAttempted === true);
    assert.equal(fixture.records.length - before, 1);

    let releaseToken;
    const heldToken = new Promise(resolve => { releaseToken = resolve; });
    const retired = makeTransport({ getAccessToken: () => heldToken });
    const retiredServices = createMeetingServices({ request: fixture.request.bind(fixture), requestManagement: retired.request });
    before = fixture.records.length;
    const retiredRequest = retiredServices.execute('call.ctd.start', ctdParams);
    retiredRequest.catch(() => {});
    retired.cancel(); releaseToken(TOKEN);
    await assert.rejects(retiredRequest, error => error.code === 'MANAGEMENT_REQUEST_ABORTED');
    assert.equal(fixture.records.length, before, 'retired auth snapshot opened a connection');
    const mismatched = makeTransport({ getConfig: async () => ({ ...fixture.config(), server: 'not-the-auth-origin.invalid' }) });
    await assert.rejects(mismatched.request('CREATECONF', { ctd: true }), error => error.code === 'MANAGEMENT_ORIGIN_MISMATCH');
    assert.equal(fixture.records.length, before);
    fixture.check();

    fixture.mode = 'success';
    const pstn = await services.execute('conference.pstnNumbers');
    assert.deepEqual(pstn.native, { pstnNumber: 'synthetic-pstn-access' });
    fixture.mode = 'pstn-missing';
    await assert.rejects(services.execute('conference.pstnNumbers'), error => error.code === 'PSTN_NUMBER_UNAVAILABLE');
    fixture.mode = 'success';
    const invitation = await services.execute('conference.inviteByToken', { conferenceID: CONFERENCE,
      chairmanPwd: CHAIR_PASSWORD, attendees: [{ phone: CALLEE, name: 'Synthetic invitee', type: 'normal' }] });
    assert.equal(invitation.status, 200);
    assert.equal(invitation.data, null, 'empty invitation acknowledgement was invented into a payload');
    assert.equal(fixture.httpRecords.filter(record => record.path === '/v1/mmc/control/conferences/participants').length, 1);
    const native = normalizeInvitation({ num_of_attendee: 1, attendee_info: [{ number: CALLEE, name: 'Synthetic invitee', type: 0 }] });
    assert.equal(native.attendees[0].phone, CALLEE);
    assert.equal(native.attendees[0].type, 'normal');
    assert.equal(native.attendees[0].isAutoInvite, 1);
    fixture.check();
    await verifyPendingCalls(fixture, makeTransport);
    console.log('PASS real loopback WSS/HTTPS, CTD contract/correlation, proxy, explicit errors, no retry, cancellation, PSTN and invitation');

    if (arguments_.includes('--heartbeat')) {
      fixture.mode = 'heartbeat';
      const heartbeat = makeTransport({ timeoutMs: 35000 });
      const heartbeatServices = createMeetingServices({ request: fixture.request.bind(fixture), requestManagement: heartbeat.request });
      assert.equal((await heartbeatServices.execute('call.ctd.start', ctdParams)).conferenceID, CONFERENCE);
      assert.equal(fixture.pings, 1);
      fixture.check();
      console.log('PASS native 30000ms management application PING');
    }
  } finally {
    for (const transport of transports) transport.dispose();
    if (fixture) await fixture.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
module.exports = { Fixture, provision, deferred, observed, ctdParams, TOKEN, CONFERENCE };
