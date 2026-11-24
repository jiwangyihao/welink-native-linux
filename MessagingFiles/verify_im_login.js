#!/usr/bin/env electron
'use strict';

// Genuine ia32 IM public ABI and verified loopback TLS. All credentials and
// peer replies below are synthetic; production authentication is tested separately.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');

async function main() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'ia32');
  assert.equal(process.argv.length, 4, 'Usage: electron verify_im_login.js LIBRARY FFI_DIRECTORY');
  const fixtureHost = process.env.WELINK_IM_TEST_HOST || '127.0.0.1';
  assert(['127.0.0.1', '::1'].includes(fixtureHost), 'TLS fixture must bind a loopback address');
  const equivalentAddress = fixtureHost === '::1' ? '0:0:0:0:0:0:0:1' : '0:0:0:0:0:ffff:7f00:1';
  const removedAddress = fixtureHost === '::1' ? '2001:db8::1' : '192.0.2.1';
  process.umask(0o077);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-im-login-'));
  const changes = new EventEmitter();
  const replies = new Map();
  const loginStates = [];
  const sockets = new Set();
  let failure = null;
  let native = null;
  let callback = null;
  let pump = null;
  let server = null;
  let started = false;
  let listening = false;
  let serial = 0;
  let connections = 0;
  let loginPacket = null;
  let peer = null;
  const packets = [];
  const sessionId = 0x123456789abcdef0n;
  const notifications = [];

  function frame(version, type, code, serialNum, body, ext = null, flags = 20) {
    const headerLen = version >= 6 ? 18 : 16;
    const extLen = ext ? ext.length : 0;
    const header = Buffer.alloc(4 + headerLen);
    header.writeUInt32BE(headerLen + extLen + body.length, 0);
    header.writeUInt16BE(version, 4);
    header[6] = type;
    header.writeUInt16BE(code, 7);
    header[9] = flags;
    header.writeUInt16BE(serialNum, 10);
    header.writeBigUInt64BE(sessionId, 12);
    if (version >= 6) header.writeUInt16BE(extLen, 20);
    return ext ? Buffer.concat([header, ext, body]) : Buffer.concat([header, body]);
  }

  function reply(packet, body, ext = null) {
    packet.socket.write(frame(ext ? 6 : 4, 2, packet.code + 1, packet.serial, body, ext));
  }

  function push(code, serialNum, body, ext = null, version = ext ? 6 : 4) {
    peer.write(frame(version, 0x20, code, serialNum, body, ext));
  }

  function loginFields(body) {
    assert.equal(body.subarray(0, 4).toString('hex'), 'ff012801');
    let pos = 3;
    let clientType = null, token = null;
    while (pos < body.length && body.subarray(pos, pos + 3).toString('hex') !== 'ff0129') {
      const id = body[pos++];
      const prefix = body[pos++];
      const width = prefix & 0x0f;
      assert(width >= 1 && width <= 4);
      const len = body.readUIntLE(pos, width);
      pos += width;
      const val = body.subarray(pos, pos + len);
      pos += len;
      if (id === 2) clientType = val.readInt8(0);
      if (id === 5) token = val.toString('utf8');
    }
    assert.notEqual(clientType, null, 'Login packet omitted device type');
    return { clientType, token };
  }
  function loginDeviceType(body) { return loginFields(body).clientType; }

  function fail(error) {
    if (!failure) failure = error;
    changes.emit('change');
  }

  function waitFor(predicate, label) {
    return new Promise((resolve, reject) => {
      let timer;
      function finish(error, value) {
        clearTimeout(timer);
        changes.removeListener('change', check);
        if (error) reject(error); else resolve(value);
      }
      function check() {
        if (failure) return finish(failure);
        try {
          const value = predicate();
          if (value) finish(null, value);
        } catch (error) { finish(error); }
      }
      changes.on('change', check);
      timer = setTimeout(() => finish(new Error(`Timed out: ${label}`)), 10000);
      check();
    });
  }

  async function quiet(milliseconds) {
    await new Promise(resolve => setTimeout(resolve, milliseconds));
    if (failure) throw failure;
  }

  try {
    const trust = path.join(root, 'trust');
    fs.mkdirSync(trust, { mode: 0o700 });
    const ca = path.join(trust, 'fixture-ca.pem');
    const caKey = path.join(root, 'fixture-ca.key');
    const key = path.join(root, 'fixture-server.key');
    const csr = path.join(root, 'fixture-server.csr');
    const certificate = path.join(root, 'fixture-server.pem');
    const extensions = path.join(root, 'fixture-server.ext');
    fs.writeFileSync(extensions, 'basicConstraints=critical,CA:FALSE\n' +
      'keyUsage=critical,digitalSignature,keyEncipherment\n' +
      'extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,IP:::1\n');
    const commands = [
      ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes',
        '-subj', '/CN=Native IM synthetic fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', ca],
      ['req', '-new', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-subj', '/CN=127.0.0.1',
        '-keyout', key, '-out', csr],
      ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-set_serial', '42',
        '-days', '2', '-sha256', '-extfile', extensions, '-out', certificate],
      ['rehash', trust]
    ];
    for (const args of commands) {
      execFileSync('openssl', args, { cwd: root, timeout: 20000, stdio: 'pipe',
        env: { PATH: process.env.PATH, HOME: root, LC_ALL: 'C', OPENSSL_CONF: '/dev/null' } });
    }

    server = tls.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(certificate) }, socket => {
      connections++;
      sockets.add(socket);
      peer = socket;
      let received = Buffer.alloc(0);
      socket.on('error', fail);
      socket.on('close', () => {
        sockets.delete(socket);
        changes.emit('change');
      });
      socket.on('data', chunk => {
        try {
          received = Buffer.concat([received, chunk]);
          assert(received.length <= 65536, 'Unexpectedly large fixture frame');
          while (received.length >= 4) {
            const length = received.readUInt32BE(0);
            assert(length >= 16 && length <= 65532, 'Invalid PacketMobile envelope');
            if (received.length < length + 4) break;
            const packet = {
              socket,
              version: received.readUInt16BE(4),
              type: received[6],
              code: received.readUInt16BE(7),
              flags: received[9],
              serial: received.readUInt16BE(10),
              session: received.readBigUInt64BE(12)
            };
            if (packet.code === 0x1100) {
              const fields = loginFields(received.subarray(20, length + 4));
              packet.clientType = fields.clientType;
              packet.token = fields.token;
            }
            if ((packet.type & 0xf0) === 0x30) {
              const offset = (packet.version >= 6 ? 22 + received.readUInt16BE(20) : 20);
              packet.body = received.subarray(offset, length + 4);
            }
            if (packet.code === 5448 || packet.code === 5474) {
              assert.equal(packet.version, 6, 'Grouping requests must support peer metadata');
              const offset = 22 + received.readUInt16BE(20);
              assert(offset <= length + 4, 'Truncated extension in outgoing grouping request');
              packet.body = received.subarray(offset, length + 4);
            }
            received = received.subarray(length + 4);
            packets.push(packet);
            if (packet.code === 0x1100) loginPacket = packet;
            changes.emit('change');
          }
        } catch (error) { fail(error); }
      });
      changes.emit('change');
    });
    server.on('error', fail);
    server.on('tlsClientError', fail);
    server.listen(0, fixtureHost, () => { listening = true; changes.emit('change'); });
    await waitFor(() => listening, 'loopback TLS listener');

    const ffi = require(path.resolve(process.argv[3]));
    // Bypass the production basename router: it intentionally redirects known
    // SDK names to its own immutable image, not the library argument under test.
    const handle = new ffi.DynamicLibrary(path.resolve(process.argv[2]), ffi.DynamicLibrary.FLAGS.RTLD_NOW);
    native = ffi.Library(handle, {
      SetLog: ['int', ['string']],
      RegistCallBack: ['int', ['pointer']],
      Startup: ['int', []],
      SendMsg: ['int', ['string', 'int']],
      ImDispatchCallbacks: ['int', []],
      Shutdown: ['int', []]
    });
    const logDir = path.join(root, 'logs');
    assert.equal(native.SetLog(logDir), 0);
    const logPath = path.join(logDir, 'native_im.log');
    callback = ffi.Callback('int', ['string', 'int'], (text, module) => {
      try {
        assert.equal(module, 1);
        const message = JSON.parse(text);
        if (message.rsp !== undefined) replies.set(message.sno, message);
        if (message.notify === 188672) loginStates.push(message.param.isImEnable);
        else if (message.notify !== undefined) notifications.push(message);
        changes.emit('change');
      } catch (error) { fail(error); }
      return 0;
    });
    assert.equal(native.RegistCallBack(callback), 0);
    assert.equal(native.Startup(), 0);
    started = true;
    pump = setInterval(() => {
      try { assert(native.ImDispatchCallbacks() >= 0, 'Owner-thread dispatch failed'); }
      catch (error) { fail(error); }
    }, 5);
    const authority = `https://${fixtureHost === '::1' ? '[::1]' : fixtureHost}:${server.address().port}`;
    const configuration = {
      account: 'synthetic-im-user', authToken: 'synthetic-im-token', maaAddr: authority,
      deviceId: 'synthetic-im-device', clientVersion: 'fixture', rsUrl: authority,
      // A stale login hint must not substitute for the socket's actual local IP.
      localIp: removedAddress,
      isVerify: 1, caPath: trust, proxyInfo: {}, loginFlag: 1, minRetryTime: 1, maxRetryTime: 1
    };
    async function update(loginStatus) {
      const sno = ++serial;
      assert.equal(native.SendMsg(JSON.stringify({ cmd: 155648, sno,
        description: 'updateLoginEserverInfo', param: { ...configuration, login_status: loginStatus } }), 1), 0);
      const response = await waitFor(() => replies.get(sno), `configuration status ${loginStatus}`);
      assert.equal(response.rsp, 188417);
      assert.equal(response.result, 0);
    }
    async function ipListChange(addresses, success = true) {
      const sno = ++serial;
      assert.equal(native.SendMsg(JSON.stringify({ cmd: 155904, sno,
        description: 'ipListChange', param: addresses }), 1), 0);
      const response = await waitFor(() => replies.get(sno), 'IP-list acknowledgement');
      assert.equal(response.rsp, 155905, 'IP-list acknowledgement used the request command');
      assert.equal(response.description, 'ipListChange');
      if (success) assert.equal(response.result, 0, response.resultDes);
      else assert.notEqual(response.result, 0, 'Invalid IP list reported success');
    }

    // IP notifications can precede the first account configuration. They must
    // neither configure a null routing context nor manufacture a login attempt.
    await ipListChange([fixtureHost]);
    await ipListChange([]);
    await ipListChange([equivalentAddress]);
    await quiet(50);
    assert.equal(connections, 0, 'IP notification connected before configuration');
    assert.deepEqual(loginStates, [], 'Pre-configuration IP notification emitted login status');

    // A non-empty credential set is not sufficient while the application is
    // still in AccessStatus.InLogin. This catches the former status==1 bug.
    await update(1);
    await waitFor(() => loginStates.includes(0), 'InLogin reports IM disabled');
    assert.equal(connections, 0, 'IM connected before account login succeeded');
    const inLoginStates = loginStates.length;
    await ipListChange([equivalentAddress]);
    await quiet(50);
    assert.equal(connections, 0, 'IP notification connected during AccessStatus.InLogin');
    assert.equal(loginStates.length, inLoginStates, 'IP notification disturbed InLogin state');

    await update(2);
    await waitFor(() => loginPacket, 'LoginSuccess sends the real IM login frame');
    assert.equal(connections, 1);
    assert.equal(loginPacket.version, 4);
    assert.equal(loginPacket.type, 0);
    assert.equal(loginPacket.flags, 0);
    assert.equal(loginPacket.code, 0x1100, 'Expected an IM login request, not HTTP or a heartbeat');
    assert.notEqual(loginPacket.serial, 0);
    assert.equal(loginPacket.session, 0n);
    assert.equal(loginPacket.clientType, 0, 'Normal desktop login claimed the mobile session slot');

    const connectingSocket = peer;
    const connectingStates = loginStates.length;
    await ipListChange([removedAddress, equivalentAddress]);
    assert.equal(connections, 1, 'Unchanged IP restarted a pending login');
    assert.equal(peer, connectingSocket);
    assert(sockets.has(connectingSocket), 'Unchanged IP closed the authenticating TLS socket');
    assert.equal(loginStates.length, connectingStates);

    // Real servers encode lastLoginAddr="" as an untyped empty blob (01 00),
    // not necessarily as the string-tagged form (f1 00). Rejecting it discarded
    // an otherwise successful login response and kept IM offline indefinitely.
    reply(loginPacket, Buffer.from('ff01280101010005010006ff0128ff0129ff0129', 'hex'));
    await waitFor(() => loginStates.includes(1), 'empty binary string login acknowledgement');
    const requestSno = ++serial;
    assert.equal(native.SendMsg(JSON.stringify({ cmd: 0x2110a, sno: requestSno, param: {} }), 1), 0);
    const request = await waitFor(() => packets.find(packet => packet.code === 0x110a),
      'authenticated request reaches the peer');
    assert.equal(request.session, sessionId, 'Authenticated request lost the server session header');
    const pendingStates = loginStates.length;
    await ipListChange([fixtureHost]);
    await ipListChange([removedAddress, equivalentAddress]);
    await ipListChange({}, false);
    await ipListChange([fixtureHost, 'not-an-ip'], false);
    await ipListChange([fixtureHost, 42], false);
    await ipListChange([`${fixtureHost}\u0000ignored`], false);
    assert.equal(connections, 1, 'Unchanged or invalid IP list reconnected');
    assert.equal(peer, request.socket, 'Unchanged IP replaced the TLS socket');
    assert(sockets.has(request.socket), 'Unchanged IP closed the socket with a pending ping');
    assert.equal(replies.has(requestSno), false, 'IP notification failed a pending ping');
    assert.equal(loginStates.length, pendingStates, 'Unchanged IP re-emitted login status');
    const tsBytes = Buffer.alloc(6);
    tsBytes.writeUIntLE(1795182425907, 0, 6);
    const ext = Buffer.concat([
      Buffer.from('ff0128010106', 'hex'), tsBytes,
      Buffer.from('03f108', 'hex'), Buffer.from('trace-v6'),
      Buffer.from('ff0129', 'hex')
    ]);
    reply(request, Buffer.from('ff01280101010402f100ff0129', 'hex'), ext);
    const rejection = await waitFor(() => replies.get(requestSno), 'peer error reaches the caller');
    assert.equal(rejection.result, 4);
    assert.equal(rejection.resultDes, '');
    assert.equal(rejection.serverTime, '1795182425907', 'PacketMobile v6 MsgExt serverTime lost');
    assert.equal(rejection.traceId, 'trace-v6', 'PacketMobile v6 MsgExt traceId lost');

    const groupsSno = ++serial;
    assert.equal(native.SendMsg(JSON.stringify({ cmd: 136520, sno: groupsSno, param: {} }), 1), 0);
    const groups = await waitFor(() => packets.find(p => p.code === 5448), 'group snapshot request');
    reply(groups, Buffer.from('ff01280101010003ff0128ff0129ff0129', 'hex'), ext);
    const snapshot = await waitFor(() => replies.get(groupsSno), 'group snapshot response');
    assert.equal(snapshot.result, 0);
    assert.equal(snapshot.serverTime, '1795182425907');
    const changesSno = ++serial;
    assert.equal(native.SendMsg(JSON.stringify({ cmd: 136546, sno: changesSno,
      param: { queryTimeStamp: snapshot.serverTime } }), 1), 0);
    const delta = await waitFor(() => packets.find(p => p.code === 5474), 'changed groups request');
    assert.deepEqual(delta.body, Buffer.concat([Buffer.from('ff0128010106', 'hex'), tsBytes, Buffer.from('ff0129', 'hex')]));
    const nextTime = Buffer.alloc(6);
    nextTime.writeUIntLE(1795182426000, 0, 6);
    // The envelope clock is not the incremental cursor returned in the body.
    reply(delta, Buffer.concat([Buffer.from('ff012801010100040106', 'hex'), nextTime, Buffer.from('ff0129', 'hex')]), ext);
    const changed = await waitFor(() => replies.get(changesSno), 'changed groups response');
    assert.equal(changed.result, 0);
    assert.equal(changed.syncTime, '1795182426000');

    // Unchanged online update AND authToken-only refresh (hourly OAuth refresh)
    // must preserve the live TLS session without re-emitting LoginStatusNotify.
    const dupStates = loginStates.length;
    await update(2);
    configuration.authToken = 'refreshed-synthetic-im-token';
    await update(2);
    const probeSno = ++serial;
    assert.equal(native.SendMsg(JSON.stringify({ cmd: 0x2110a, sno: probeSno, param: {} }), 1), 0);
    const probeReq = await waitFor(() => packets.filter(p => p.code === 0x110a).length >= 2 &&
      packets.filter(p => p.code === 0x110a).at(-1), 'post-refresh request on preserved session');
    assert.equal(connections, 1, 'unchanged or token-only refresh reconnected unnecessarily');
    assert.equal(probeReq.session, sessionId);
    await ipListChange([equivalentAddress]);
    assert.equal(replies.has(probeSno), false, 'IP notification discarded a post-refresh pending ping');
    assert.equal(peer, probeReq.socket, 'IP notification replaced the refreshed session');
    reply(probeReq, Buffer.from('ff012801010100ff0129', 'hex'));
    const probeReply = await waitFor(() => replies.get(probeSno), 'post-refresh reply');
    assert.equal(probeReply.result, 0);
    assert.equal(loginStates.length, dupStates, 'unchanged/token-refresh online update must not re-emit LoginStatusNotify');

    // Unrecognized post-7.47.6 server push (0x20): must send 0x30 receipt so the
    // server stops redelivering, log structured IM unsupported, and keep session.
    push(0x3ffe, 0x7701, Buffer.from('ff012801f10474657374ff0129', 'hex'), ext, 6);
    const unsupportedAck = await waitFor(() => packets.find(p => p.type === 0x30 && p.code === 0x3ffe && p.serial === 0x7701),
      '0x30 receipt for unrecognized server push');
    assert.equal(unsupportedAck.session, sessionId);
    assert.equal(unsupportedAck.body.length, 0);

    // Server push exercising real ecs_im_nbr.dll wire quirks:
    // 1) ChatNotify (0x1204): 0xf0 string-null sender, untyped string receiver,
    //    invalid UTF-8 + NUL inside imChat.content, unknown field with 0xf0,
    //    trailing second root value (0x00), and MsgExt with 0xf0 traceId.
    const badUtf8 = Buffer.from([0x68, 0x69, 0x00, 0xff, 0x21]);
    const chatBody = Buffer.concat([
      Buffer.from('ff0128', 'hex'),
      Buffer.from('01f0', 'hex'),                          // sender = string-null (0xf0)
      Buffer.from('020103', 'hex'), Buffer.from('bob'),    // receiver = untyped string
      Buffer.from('03f10102', 'hex'),                      // chatType = string-tagged int (2)
      Buffer.from('04ff0128070105', 'hex'), badUtf8,       // imChat.content = untyped non-UTF8+NUL
      Buffer.from('08f0ff0129', 'hex'),                    // imChat.appId = 0xf0
      Buffer.from('63f0', 'hex'),                          // unknown field 0x63 = 0xf0
      Buffer.from('ff0129', 'hex'),
      Buffer.from('00', 'hex')                             // trailing root null value
    ]);
    const extNullTrace = Buffer.concat([
      Buffer.from('ff0128010106', 'hex'), tsBytes,
      Buffer.from('03f0', 'hex'),
      Buffer.from('ff0129', 'hex')
    ]);
    push(0x1204, 0x7702, chatBody, extNullTrace, 6);
    const chatAck = await waitFor(() => packets.find(p => p.type === 0x30 && p.code === 0x1204 && p.serial === 0x7702),
      '0x30 receipt for ChatNotify with NBR quirks');
    assert.equal(chatAck.body.length, 0);
    const chatNotify = await waitFor(() => notifications.find(n => n.notify === 0x28000 + 0x1204),
      'ChatNotify delivered to callback');
    assert.equal(chatNotify.param.sender, '');
    assert.equal(chatNotify.param.receiver, 'bob');
    assert.equal(chatNotify.param.chatType, 2);
    assert.equal(chatNotify.param.imChat.content, 'hi\ufffd\ufffd!');
    assert.equal(chatNotify.param.imChat.appId, '');
    assert.equal(chatNotify.serverTime, '1795182425907');

    // 2) AppNotify (0x2804): empty body_size == 0 must decode without EBADMSG.
    push(0x2804, 0x7703, Buffer.alloc(0), null, 4);
    await waitFor(() => packets.find(p => p.type === 0x30 && p.code === 0x2804 && p.serial === 0x7703),
      '0x30 receipt for empty-body AppNotify');
    const appNotify = await waitFor(() => notifications.find(n => n.notify === 0x28000 + 0x2804),
      'AppNotify delivered');
    assert.equal(typeof appNotify.param, 'object');

    // 3) GroupNotify (0x1338): map (field 5) with non-zero entry tag (0x01) + null value (0xf0)
    //    and duplicate int32 field (field 3, groupNotifyType) with over-width bytes then last-wins.
    const groupNotifyBody = Buffer.concat([
      Buffer.from('ff0128', 'hex'),
      Buffer.from('01010105', 'hex'),                               // groupId = 5
      Buffer.from('0301050900000001', 'hex'),                       // groupNotifyType = over-width 5-byte
      Buffer.from('03010107', 'hex'),                               // duplicate groupNotifyType -> last wins (7)
      Buffer.from('05ff012801ff012801f1016b02f0ff0129ff0129', 'hex'), // updatedGroupOptions map: entry tag 0x01, key='k', val=0xf0
      Buffer.from('ff0129', 'hex')
    ]);
    push(0x1338, 0x7704, groupNotifyBody, null, 4);
    await waitFor(() => packets.find(p => p.type === 0x30 && p.code === 0x1338 && p.serial === 0x7704),
      '0x30 receipt for GroupNotify with map tag & duplicate field');
    const groupNotify = await waitFor(() => notifications.find(n => n.notify === 0x28000 + 0x1338),
      'GroupNotify delivered');
    assert.equal(groupNotify.param.groupId, '5');
    assert.equal(groupNotify.param.groupNotifyType, 7);
    assert.deepEqual(groupNotify.param.updatedGroupOptions, { k: '' });

    // 4) UnReadCountNotify (0x151c): array element with non-zero tag byte (0x01).
    const unreadBody = Buffer.concat([
      Buffer.from('ff0128', 'hex'),
      Buffer.from('01f1027531', 'hex'),                             // userAccount = 'u1'
      Buffer.from('02ff012801ff012801f102743102f102613103010103ff0129ff0129', 'hex'), // elem tag 0x01
      Buffer.from('ff0129', 'hex')
    ]);
    push(0x151c, 0x7706, unreadBody, null, 4);
    await waitFor(() => packets.find(p => p.type === 0x30 && p.code === 0x151c && p.serial === 0x7706),
      '0x30 receipt for UnReadCountNotify with non-zero array tag');
    const unreadNotify = await waitFor(() => notifications.find(n => n.notify === 0x28000 + 0x151c),
      'UnReadCountNotify delivered');
    assert.deepEqual(unreadNotify.param.unReadCounts, [{ tenantId: 't1', tenantAccount: 'a1', unReadCount: 3 }]);

    // 5) Malformed known push: must NOT send 0x30 receipt and must log structured IM decode 74.
    push(0x1204, 0x7705, Buffer.from('ff012801f1', 'hex'), null, 4);
    const pingSno = ++serial;
    assert.equal(native.SendMsg(JSON.stringify({ cmd: 0x2110a, sno: pingSno, param: {} }), 1), 0);
    const pingReq = await waitFor(() => packets.filter(p => p.code === 0x110a).length >= 3 &&
      packets.filter(p => p.code === 0x110a).at(-1), 'session alive after malformed push');
    reply(pingReq, Buffer.from('ff012801010100ff0129', 'hex'));
    await waitFor(() => replies.get(pingSno), 'reply after malformed push');
    assert.equal(packets.some(p => p.type === 0x30 && p.serial === 0x7705), false,
      'Malformed known push must not be ACKed');
    const imLog = fs.readFileSync(logPath, 'utf8');
    assert.match(imLog, /IM unsupported code=0x3ffe type=0x20 ver=6 flags=0x14 ext=\d+ body=13 ack=1/);
    assert.match(imLog, /IM decode 74 code=0x1204 type=0x20 ver=4 flags=0x14 ext=0 body=5/);
    assert.equal((imLog.match(/IM decode /g) || []).length, 1, 'Only the intentionally malformed push may log IM decode');

    // Actual address disappearance uses the configured retry policy. Empty
    // lists suspend attempts, including duplicate events while already offline;
    // returning addresses permit recovery without discarding the backoff.
    for (const scenario of [
      { label: 'removed local IP', addresses: [removedAddress], hold: false },
      { label: 'brief empty IP list', addresses: [], hold: false },
      { label: 'sustained empty IP list', addresses: [], hold: true }
    ]) {
      const previous = loginPacket;
      const previousSocket = peer;
      const previousConnections = connections;
      const states = loginStates.length;
      const beforePackets = packets.length;
      const interruptedSno = ++serial;
      assert.equal(native.SendMsg(JSON.stringify({ cmd: 0x2110a, sno: interruptedSno, param: {} }), 1), 0);
      await waitFor(() => packets.slice(beforePackets).some(p => p.code === 0x110a && p.socket === previousSocket),
        `${scenario.label}: pending ping reaches peer`);
      const eventAt = process.hrtime.bigint();
      await ipListChange(scenario.addresses);
      await waitFor(() => !sockets.has(previousSocket), `${scenario.label}: old TLS socket closes`);
      const interrupted = await waitFor(() => replies.get(interruptedSno), `${scenario.label}: pending call fails`);
      assert.notEqual(interrupted.result, 0, 'Removed local IP left a call pending on the dead socket');
      assert.equal(interrupted.resultDes, 'network configuration changed');
      assert.deepEqual(loginStates.slice(states), [0], `${scenario.label}: offline status`);
      if (!scenario.addresses.length) {
        if (scenario.hold) {
          await ipListChange([]);
          await quiet((configuration.maxRetryTime + 1) * 1000 + 200);
          assert.equal(connections, previousConnections, 'Empty IP list retried without an available network');
          assert.equal(loginPacket, previous, 'Empty IP list started another login');
          assert.deepEqual(loginStates.slice(states), [0], 'Duplicate empty event re-emitted offline status');
        }
        await ipListChange([equivalentAddress]);
      }
      await waitFor(() => loginPacket !== previous, `${scenario.label}: reconnect login`);
      const elapsed = Number(process.hrtime.bigint() - eventAt) / 1e6;
      assert(elapsed >= configuration.minRetryTime * 1000,
        `${scenario.label}: reconnect bypassed configured backoff (${elapsed}ms)`);
      assert.equal(connections, previousConnections + 1, `${scenario.label}: extra TLS connections`);
      assert.equal(loginPacket.token, 'refreshed-synthetic-im-token', 'IP-event reconnect lost refreshed credentials');
      assert.equal(loginPacket.clientType, 0, 'IP-event reconnect changed desktop device type');
      reply(loginPacket, Buffer.from('ff01280101010005010006ff0128ff0129ff0129', 'hex'));
      await waitFor(() => loginStates.slice(states).includes(1), `${scenario.label}: authenticated recovery`);
      assert.deepEqual(loginStates.slice(states), [0, 1], `${scenario.label}: duplicate login status`);
    }

    const deviceCases = [
      { loginFlag: 0, expected: 0 },
      { loginFlag: 2, expected: 0 },
      { loginFlag: 2, clientType: 2, expected: 2 },
      { loginFlag: 1, clientType: 0, expected: 0 }
    ];
    for (const { expected, ...settings } of deviceCases) {
      const previous = loginPacket;
      const states = loginStates.length;
      Object.assign(configuration, settings);
      await update(2);
      await waitFor(() => loginPacket !== previous, 'device identity configuration reconnect');
      assert.equal(loginPacket.clientType, expected, 'Device class must not derive from login intent');
      assert.equal(loginPacket.token, 'refreshed-synthetic-im-token', 'Reconnect must use the refreshed authToken');
      reply(loginPacket, Buffer.from('ff01280101010005010006ff0128ff0129ff0129', 'hex'));
      await waitFor(() => loginStates.slice(states).includes(1), 'identity reconnect authenticated');
    }
    const previous = loginPacket;
    const states = loginStates.length;
    peer.end();
    await waitFor(() => loginPacket !== previous, 'network reconnect sends another login');
    assert.equal(loginPacket.clientType, 0, 'Network reconnect claimed the mobile session slot');
    reply(loginPacket, Buffer.from('ff01280101010005010006ff0128ff0129ff0129', 'hex'));
    await waitFor(() => loginStates.slice(states).includes(1), 'network reconnect authenticated');

    const beforeLogoutStates = loginStates.length;
    const logoutSocket = peer;
    const logoutConnections = connections;
    await update(3);
    await waitFor(() => !sockets.has(logoutSocket), 'InLogout closes the real TLS connection');
    await waitFor(() => loginStates.slice(beforeLogoutStates).includes(0), 'InLogout emits offline status');
    await ipListChange([]);
    await ipListChange([equivalentAddress]);
    await quiet((configuration.maxRetryTime + 1) * 1000 + 200);
    assert.equal(connections, logoutConnections, 'IP notification reconnected after logout');
    assert.equal(sockets.size, 0, 'Logout left a TLS connection open');
    assert.deepEqual(loginStates.slice(beforeLogoutStates), [0], 'Logout must emit LoginStatusNotify(0) exactly once');
    console.log(JSON.stringify({ passed: true, inLoginDoesNotConnect: true,
      loginSuccessStartsVerifiedTls: true, realLoginFrame: '0x1100',
      fixtureHost, preLoginIpEventDoesNotConnect: true, ipListReplyCommand: 155905,
      connectingIpEventPreservesSession: true, unchangedIpPreservesPendingPing: true,
      equivalentIpPreservesSession: true, invalidIpListRejectedWithoutDisconnect: true,
      removedIpReconnectsWithBackoff: true, emptyIpListPausesRetry: true,
      emptyIpListRecoveryUsesBackoff: true, logoutIpEventDoesNotReconnect: true,
      untypedEmptyStringLogin: true, authenticatedSessionHeader: true,
      desktopDeviceType: 0, loginIntentIndependent: true, explicitDeviceTypePreserved: true,
      networkReconnectDeviceType: 0, tokenRefreshPreservesSession: true,
      duplicateOnlineSilent: true, unsupportedPushAcked: true,
      nbrCompatQuirksDecoded: true, malformedPushNotAcked: true,
      groupingSnapshotAndDelta: true, packetMetadataPreserved: true,
      serverErrorPreserved: true, logoutClosesTransportOnce: true }));
  } finally {
    if (started) native.Shutdown();
    if (pump) clearInterval(pump);
    for (const socket of sockets) socket.destroy();
    if (server && listening) await new Promise(resolve => server.close(resolve));
    // Keep the ffi callback alive until shutdown and socket cleanup complete.
    void callback;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
