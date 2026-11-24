'use strict';

// Isolated counterpart for verify_offline_hrtc.js, not a production server.
// Wire evidence: untouched HRTC module 91012 in hrtc-12.eb3d2838.js (1.10.96):
// zP.doConnect/setJoinRequest/onmessage, DM.handleConfigNotifyBody/joinImpl,
// DM.subscribeAudioSignal/getTrackSubscribeResult, EM.addSsrcRange, and
// ConnectionsManager.modifyPublishOfferSdp/addUserBatch. HRTC negotiates fixed
// SSRC slots over JOIN then changes their direction locally; SUBSCRIBE, not a
// second SDP offer, activates a downlink. This counterpart implements that
// contract using genuine Chromium ICE/DTLS/SRTP peers and synthetic audio.
// CMS is a deliberately isolated fixture. Its private random/signature are
// generated per run and accepted only by this loopback service, never Huawei.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function installPeerRuntime() {
  const rooms = new Map();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function mediaSections(sdp, transform) {
    const parts = sdp.trimEnd().split(/\r?\nm=/);
    return parts[0] + '\r\n' + parts.slice(1).map(part => transform('m=' + part.replace(/\r?\n/g, '\r\n') + '\r\n')).join('');
  }
  function setDirection(section, direction) {
    return section.replace(/^a=(?:sendrecv|sendonly|recvonly|inactive)\r\n/m, 'a=' + direction + '\r\n');
  }
  function clearSources(section) {
    return section.replace(/^a=(?:ssrc[^:]*|msid):[^\r\n]*\r\n/gm, '');
  }
  function requireRange(section, field) {
    const match = section.match(new RegExp('^a=' + field + ':(\\d+)-(\\d+)\\r?$', 'm'));
    if (!match) throw Error('HRTC JOIN omitted ' + field);
    return Number(match[1]);
  }
  async function iceComplete(pc) {
    const deadline = performance.now() + 6000;
    while (pc.iceGatheringState !== 'complete') {
      if (performance.now() > deadline) throw Error('Peer ICE gathering did not complete');
      await sleep(20);
    }
  }
  async function createConnection(offer, audioContext, main) {
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    const state = { pc, analyser: null, source: null, silent: null, playout: null, playoutError: null,
      oscillator: null, destination: null, uplinkSsrc: null, downlinkSsrc: null };
    try {
      pc.ontrack = event => {
        if (event.track.kind !== 'audio') return;
        const stream = new MediaStream([event.track]);
        state.playout = document.createElement('audio');
        state.playout.muted = true;
        state.playout.srcObject = stream;
        document.body.append(state.playout);
        state.playout.play().catch(error => { state.playoutError = error.message; });
        const source = audioContext.createMediaStreamSource(stream);
        state.analyser = audioContext.createAnalyser();
        state.analyser.fftSize = 4096;
        state.analyser.smoothingTimeConstant = 0;
        state.silent = audioContext.createGain();
        state.silent.gain.value = 0;
        source.connect(state.analyser).connect(state.silent).connect(audioContext.destination);
        state.source = source;
      };
      const peerOffer = mediaSections(offer, section => {
        if (!main) return setDirection(clearSources(section), 'inactive');
        if (section.startsWith('m=video ')) {
          state.videoSsrc = requireRange(section, 'recv-ssrc-range');
          return setDirection(clearSources(section), 'recvonly');
        }
        state.uplinkSsrc = requireRange(section, 'send-ssrc-range');
        // Common-audio subscriptions reserve the first three receive slots
        // for top-3 mixing: iM.allocateAudioReceiveSsrc starts at 100003.
        state.downlinkSsrc = requireRange(section, 'recv-ssrc-range') + 3;
        if (!/^a=rtpmap:116 opus\/48000/mi.test(section)) throw Error('Unexpected HRTC audio payload');
        // MMR advertises reusable SSRC slots. Chromium needs their complete
        // receive-side SDP up front, unlike MMR's native RTP demultiplexer.
        return setDirection(clearSources(section), 'sendrecv') +
          'a=ssrc:' + state.uplinkSsrc + ' cname:isolated-uplink\r\n' +
          'a=ssrc:' + state.uplinkSsrc + ' msid:isolated-uplink isolated-uplink-track\r\n' +
          'a=msid:isolated-uplink isolated-uplink-track\r\n';
      });
      await pc.setRemoteDescription({ type: 'offer', sdp: peerOffer });
      for (const transceiver of pc.getTransceivers()) {
        if (!main) { transceiver.direction = 'inactive'; continue; }
        if (transceiver.receiver.track.kind === 'video') {
          // HRTC 1.10.96 derives its common-audio track from an advertised
          // upstream capability. Supply a REAL generated video stream too,
          // rather than advertising a nonexistent camera or faking WATCH.
          const canvas = document.createElement('canvas');
          canvas.width = 320; canvas.height = 180;
          const context = canvas.getContext('2d');
          const stream = canvas.captureStream(0);
          const track = stream.getVideoTracks()[0];
          state.videoStream = stream;
          let frame = 0;
          state.drawVideo = () => {
            context.fillStyle = ++frame % 2 ? '#204080' : '#804020';
            context.fillRect(0, 0, 320, 180);
            context.fillStyle = '#ffffff';
            context.fillRect(frame % 280, 40, 40, 100);
            track.requestFrame();
          };
          await transceiver.sender.replaceTrack(track);
          transceiver.sender.setStreams(stream);
          transceiver.direction = 'sendonly';
          continue;
        }
        const oscillator = audioContext.createOscillator();
        oscillator.frequency.value = 1500;
        const gain = audioContext.createGain();
        gain.gain.value = 0.2;
        const destination = audioContext.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        await transceiver.sender.replaceTrack(destination.stream.getAudioTracks()[0]);
        transceiver.sender.setStreams(destination.stream);
        transceiver.direction = 'sendrecv';
        state.oscillator = oscillator;
        state.destination = destination;
        // No source starts before an authenticated SUBSCRIBE for its SSRC.
      }
      const answer = await pc.createAnswer();
      const allocatedAnswer = mediaSections(answer.sdp, section => {
        if (!main) return section;
        const ssrc = section.startsWith('m=audio ') ? state.downlinkSsrc : state.videoSsrc;
        return section.replace(/^(a=ssrc:)\d+/gm, (_match, prefix) => prefix + ssrc);
      });
      await pc.setLocalDescription({ type: 'answer', sdp: allocatedAnswer });
      await iceComplete(pc);
      // The HRTC offer initially requests no sources. It activates its real
      // transceiver on publish/SUBSCRIBE using the retained transport answer.
      state.answer = mediaSections(pc.localDescription.sdp, section => setDirection(clearSources(section), 'inactive'));
      return state;
    } catch (error) { pc.close(); throw error; }
  }
  function frequency(analyser, sampleRate, hz) {
    if (!analyser) return null;
    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    const at = Math.round(hz * analyser.fftSize / sampleRate);
    const value = Math.max(...bins.slice(at - 1, at + 2));
    return Number.isFinite(value) ? value : -160;
  }
  globalThis.isolatedHrtcPeer = {
    async join(id, body) {
      if (rooms.has(id)) throw Error('Duplicate peer session');
      if (body.port_type !== 2 || body.audio_policy !== 2) throw Error('Only the published reduced-port/common-audio contract is implemented');
      const audioContext = new AudioContext({ sampleRate: 48000 });
      await audioContext.resume();
      const room = { audioContext, main: null, aux: null, subscribed: false };
      rooms.set(id, room);
      try {
        room.main = await createConnection(body.webrtc_sdp, audioContext, true);
        room.aux = await createConnection(body.webrtc_auxsdp, audioContext, false);
        return { webrtc_sdp: room.main.answer, webrtc_auxsdp: room.aux.answer, downlinkSsrc: room.main.downlinkSsrc };
      } catch (error) { await this.leave(id); throw error; }
    },
    subscribe(id, ssrc, enabled) {
      const room = rooms.get(id);
      if (!room || ssrc !== room.main.downlinkSsrc) throw Error('SUBSCRIBE did not match the negotiated receive slot');
      if (enabled && !room.subscribed) { room.main.oscillator.start(); room.subscribed = true; }
      if (!enabled && room.subscribed) { room.main.oscillator.stop(); room.subscribed = false; }
      return true;
    },
    watch(id, streams) {
      const room = rooms.get(id);
      if (!room) throw Error('WATCH has no negotiated room');
      const main = room.main;
      if (streams.length !== 1 || streams[0].ssrc !== main.videoSsrc)
        throw Error('WATCH did not match the negotiated video receive slot');
      if (!main.videoTimer) {
        main.drawVideo();
        main.videoTimer = setInterval(main.drawVideo, 100);
      }
      return streams.map(stream => ({ ...stream, status: 0 }));
    },
    async stats(id, diagnostic = false) {
      const room = rooms.get(id);
      if (!room) return { closed: true };
      const stats = await room.main.pc.getStats();
      const inbound = [...stats.values()].find(entry => entry.type === 'inbound-rtp' && entry.kind === 'audio');
      const outbound = [...stats.values()].find(entry => entry.type === 'outbound-rtp' && entry.kind === 'audio');
      const pairs = [...stats.values()].filter(entry => entry.type === 'candidate-pair' && entry.state === 'succeeded');
      return { connection: room.main.pc.connectionState, auxiliaryConnection: room.aux.pc.connectionState,
        audioContextState: room.audioContext.state, audioContextTime: room.audioContext.currentTime,
        playout: room.main.playout ? {paused:room.main.playout.paused, readyState:room.main.playout.readyState,
          currentTime:room.main.playout.currentTime, error:room.main.playoutError} : null,
        ...(diagnostic ? { rawStats: [...stats.values()],
          localDescription: room.main.pc.localDescription.sdp, remoteDescription: room.main.pc.remoteDescription.sdp,
          receiverTracks: room.main.pc.getReceivers().map(receiver => ({kind:receiver.track.kind,
            readyState:receiver.track.readyState, muted:receiver.track.muted})) } : {}),
        packetsReceived: inbound?.packetsReceived || 0, bytesReceived: inbound?.bytesReceived || 0,
        packetsSent: outbound?.packetsSent || 0, bytesSent: outbound?.bytesSent || 0,
        uplinkSsrc: inbound?.ssrc || null, downlinkSsrc: outbound?.ssrc || null,
        selectedCandidatePairs: pairs.length,
        uplinkToneDb: frequency(room.main.analyser, room.audioContext.sampleRate, 375),
        otherToneDb: frequency(room.main.analyser, room.audioContext.sampleRate, 1500) };
    },
    async leave(id) {
      const room = rooms.get(id);
      if (!room) return { closed: true };
      rooms.delete(id);
      for (const item of [room.main, room.aux]) {
        if (!item) continue;
        item.pc.close();
        clearInterval(item.videoTimer);
        for (const track of item.videoStream?.getTracks() || []) track.stop();
        if (item.oscillator && room.subscribed) item.oscillator.stop();
        if (item.playout) { item.playout.pause(); item.playout.srcObject = null; item.playout.remove(); }
        item.source?.disconnect();
        item.silent?.disconnect();
        item.analyser?.disconnect();
        for (const track of item.destination?.stream.getTracks() || []) track.stop();
      }
      await room.audioContext.close();
      return { closed: true };
    }
  };
  return true;
}

async function createPeer({ electron, conferenceDir, directory, onFailure, moderation = false }) {
  const WebSocket = require(path.join(conferenceDir, 'vendor/management/node_modules/ws'));
  const certPath = path.join(directory, 'loopback.crt'), keyPath = path.join(directory, 'loopback.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
  const cert = fs.readFileSync(certPath), key = fs.readFileSync(keyPath);
  const fingerprint = new crypto.X509Certificate(cert).fingerprint256;
  const secret = crypto.randomBytes(32), random = crypto.randomBytes(24).toString('hex');
  const token = crypto.randomBytes(24).toString('hex'), password = crypto.randomBytes(16).toString('hex');
  const confId = '1234567890', roomId = 'isolated-hrtc-room', userId = 'isolated-hrtc-client', appId = 'isolated-hrtc-app';
  const remoteId = 'isolated-tone-peer';
  const window = new electron.BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
    nodeIntegration: false, backgroundThrottling: false, partition: 'isolated-hrtc-peer-' + random } });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  await window.loadURL('data:text/html,<meta charset="utf-8"><title>Isolated HRTC service counterpart</title>');
  await window.webContents.executeJavaScript('(' + installPeerRuntime.toString() + ')()');
  const invoke = (method, ...args) => window.webContents.executeJavaScript(
    'isolatedHrtcPeer[' + JSON.stringify(method) + '](...' + JSON.stringify(args) + ')');
  const transcript = [], sockets = new Set(), rtcSessions = new Map(), grants = new Map();
  let origin, currentCms, currentRtc, participant = 0, admitted = false, waiting = true, admissionGate = false;
  let heldJoin, heldNotify, holdNotify = false, leaveGate = false, heldLeave;
  let moderationRole = '0', moderationCohost = '0', clientCapabilities = '', moderationRefusal = null;
  const moderationMembers = new Map([['isolated-moderation-peer', { pid: 'isolated-moderation-peer', mode: 0,
    pinfoMap: { NAME: 'Local consenting peer', ROLE: '0', IS_COHOST: '0', CLIENT_CAPABILITIES: '1,4,10,11,12' } }]]);
  function membership(socket = currentCms) {
    if (!moderation || !socket || socket.readyState !== WebSocket.OPEN) return;
    const self = { pid: 'isolated-participant-' + participant, mode: 0, pinfoMap: {
      NAME: 'Synthetic offline participant', ROLE: moderationRole, IS_COHOST: moderationCohost, CLIENT_CAPABILITIES: clientCapabilities } };
    socket.send(JSON.stringify({ action: 'ConfBasicInfoNotify', conferenceID: confId,
      data: { supportCohost: 1, supportWaitingRoom: 1 } }));
    socket.send(JSON.stringify({ action: 'ParticipantsNotify', conferenceID: confId, msgMode: 0,
      data: [self, ...moderationMembers.values()] }));
  }
  const fail = error => { onFailure(error); };
  const trace = (channel, operation, extra = {}) => transcript.push({ channel, operation, at: Date.now(), ...extra });
  const cmsReply = (socket, frame, data) => socket.send(JSON.stringify({ action: frame.action, type: frame.type,
    sequence: frame.sequence, data: JSON.stringify(data) }));
  const rtcReply = (socket, frame, body = {}) => socket.send(JSON.stringify({ type: 'RESPONSE', requestid: frame.requestid,
    roomid: frame.roomid, userid: frame.userid, sessionid: frame.sessionid, result: 200, body }));
  function issueGrant() {
    const participantID = 'isolated-participant-' + (++participant);
    const cTime = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac('sha256', secret).update([appId, roomId, userId, cTime, participantID].join('\n')).digest('hex');
    const grant = { returnCode: 0, conferenceID: confId, participantID, confMode: 'MMR', role: moderation ? moderationRole : '0',
      enterWaitingRoom: waiting, enableCollaborate: '0', signatureInfo: {
        appId, roomId, userID: userId, cTime, signature, domainUrl: '127.0.0.1', port: Number(new URL(origin).port), localMedia: true } };
    grants.set(signature, { grant, consumed: false });
    admitted = !waiting;
    return grant;
  }
  const server = https.createServer({ cert, key }, (request, response) => {
    let body = '';
    request.on('data', bytes => { body += bytes; if (body.length > 16384) request.destroy(); });
    request.on('end', () => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/mmc/control/conferences/wss/token/user?conferenceID=' + confId);
        const data = JSON.parse(body);
        trace('cms', 'token');
        if (data.random !== random) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ returnCode: 414100006, returnDesc: 'Isolated invitation refused' }));
          return;
        }
        for (const header of ['authorization', 'cookie', 'x-auth-token', 'x-jwt-authorization']) assert.equal(request.headers[header], undefined);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ returnCode: 0, confMode: 'MMR', password, wssToken: token,
          tmpUserID: 'isolated-temporary-user', orgID: 'isolated-organization' }));
      } catch (error) { response.writeHead(400); response.end(); fail(error); }
    });
  });
  const cms = new WebSocket.Server({ noServer: true, handleProtocols: protocols => protocols.has('tup_service_protocol') ? 'tup_service_protocol' : false });
  const rtc = new WebSocket.Server({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url, origin);
      if (url.pathname === '/v1/mmc/control/websocket/conn') {
        assert.equal(request.headers.authorization, token);
        assert.equal(request.headers['x-connection-type'], '1');
        return cms.handleUpgrade(request, socket, head, ws => cms.emit('connection', ws));
      }
      assert.equal(url.pathname, '/v1/rtc/' + roomId);
      assert.equal(url.searchParams.get('appid'), appId);
      assert.equal(url.searchParams.get('userid'), userId);
      const issued = grants.get(url.searchParams.get('signature'));
      if (!issued || issued.consumed || issued.grant.enterWaitingRoom || !admitted ||
          url.searchParams.get('ctime') !== String(issued.grant.signatureInfo.cTime)) {
        trace('rtc', 'unauthorized');
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      issued.consumed = true;
      trace('rtc', 'upgrade', { participantID: issued.grant.participantID });
      rtc.handleUpgrade(request, socket, head, ws => rtc.emit('connection', ws, issued.grant));
    } catch (error) { socket.destroy(); fail(error); }
  });
  cms.on('connection', socket => {
    currentCms = socket;
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); if (currentCms === socket) currentCms = null; });
    socket.on('error', fail);
    socket.on('message', bytes => {
      try {
        const frame = JSON.parse(bytes);
        if (frame.action === 'PING') { socket.send('{"action":"PONG"}'); return; }
        const data = JSON.parse(frame.data);
        trace('cms', frame.type || frame.action, moderation ? { data: { ...data, confToken: data.confToken ? '[local-peer-token]' : undefined } } : {});
        assert.equal(data.conferenceID, confId);
        if (frame.type === 'JOIN_RTC_CONF') {
          assert.equal(data.pwd, password);
          if (moderation) clientCapabilities = data.clientCapabilities;
          const respond = () => cmsReply(socket, frame, issueGrant());
          if (admissionGate) heldJoin = respond; else respond();
        } else if (frame.type === 'JoinConfNotify') {
          assert(currentRtc?.joined, 'CMS membership reported before genuine HRTC JOIN completed');
          const respond = () => cmsReply(socket, frame, { returnCode: 0 });
          if (holdNotify) heldNotify = respond; else respond();
        } else if (frame.type === 'LeaveConfNotify') {
          const respond = () => { cmsReply(socket, frame, { returnCode: 0 }); trace('cms', 'leave-confirmed'); };
          if (leaveGate) heldLeave = respond; else respond();
        } else if (['Subscribe', 'CancelSubscribe'].includes(frame.action)) {
          assert.equal(data.confToken, token);
          assert.equal(data.connectionType, 1);
          cmsReply(socket, frame, { returnCode: 0 });
          if (moderation) { clientCapabilities = data.clientCapabilities; membership(socket); }
        } else if (moderation && ['ANSWER_MUTE', 'ANSWER_VIDEO'].includes(frame.type)) {
          assert.equal(data.confToken, token);
          assert.equal(data.participantID, 'isolated-participant-' + participant);
          assert((frame.type === 'ANSWER_MUTE' ? [0, 1] : [2, 3]).includes(data.answer));
          cmsReply(socket, frame, { returnCode: 0 });
        } else if (moderation && ['CO_HOST', 'MOVETOWAITINGROOM', 'MUTE', 'VIDEO'].includes(frame.type)) {
          assert.equal(data.confToken, token);
          const target = moderationMembers.get(data.participantID);
          if (moderationRefusal !== null || !target || moderationRole !== '1' && moderationCohost !== '1' ||
              frame.type === 'CO_HOST' && moderationRole !== '1') {
            cmsReply(socket, frame, { returnCode: moderationRefusal ?? 11072008, returnDesc: 'Isolated CMS moderation refusal' });
          } else {
            if (frame.type === 'CO_HOST') { assert([0, 1].includes(data.isCohost)); target.pinfoMap.IS_COHOST = String(data.isCohost); }
            if (frame.type === 'MOVETOWAITINGROOM') moderationMembers.delete(data.participantID);
            cmsReply(socket, frame, { returnCode: 0 }); membership(socket);
          }
        } else if (['ConfHeartBeat', 'ParticipantInfoNotify'].includes(frame.type)) cmsReply(socket, frame, { returnCode: 0 });
        else throw Error('Unimplemented CMS fixture operation: ' + frame.action + '/' + frame.type);
      } catch (error) { fail(error); }
    });
  });
  rtc.on('connection', (socket, grant) => {
    const id = crypto.randomBytes(12).toString('hex');
    const session = { id, socket, grant, joined: false, closed: false, downlinkSsrc: null, chain: Promise.resolve(), replies: new Map() };
    rtcSessions.set(id, session); currentRtc = session; sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      session.chain.then(() => invoke('leave', id)).catch(fail);
    });
    socket.on('error', fail);
    setImmediate(() => socket.send(JSON.stringify({ type: 'NOTIFY', requestid: id + '-config', roomid: roomId, userid: userId,
      body: { action: 'config_notify', params: { sessionid: id, nonce: crypto.randomBytes(16).toString('hex'),
        timeout: 60, webport_type: '2', enable_collection: false, client_addr: '127.0.0.1' } } })));
    socket.on('message', bytes => {
      session.chain = session.chain.then(async () => {
        const frame = JSON.parse(bytes);
        trace('rtc', frame.type);
        if (frame.type === 'RESPONSE') return;
        assert.equal(frame.sessionid, id);
        assert.equal(frame.roomid, roomId);
        assert.equal(frame.userid, userId);
        if (session.replies.has(frame.requestid)) { rtcReply(socket, frame, session.replies.get(frame.requestid)); return; }
        let body = {};
        if (frame.type === 'JOIN') {
          assert.equal(session.joined, false);
          const answer = await invoke('join', id, frame.body);
          session.downlinkSsrc = answer.downlinkSsrc;
          body = { webrtc_sdp: answer.webrtc_sdp, webrtc_auxsdp: answer.webrtc_auxsdp,
            room_uuid: 'isolated-room-uuid', userno: '1', upstreams: frame.body.upstreams };
          session.joined = true;
        } else if (frame.type === 'SUBSCRIBE') {
          assert(session.joined);
          const streams = frame.body.streams;
          for (const stream of streams) {
            assert.equal(stream.userid, remoteId); assert.equal(stream.media, 1);
            assert([1, 2].includes(stream.action));
            await invoke('subscribe', id, stream.ssrc, stream.action === 1);
          }
          body = { streams: streams.map(stream => ({ ...stream, status: '0' })) };
        } else if (frame.type === 'WATCH') {
          assert(session.joined);
          for (const stream of frame.body.streams) {
            assert.equal(stream.userid, remoteId);
            assert.equal(stream.streamid, 'isolated-pattern-video');
          }
          body = { streams: await invoke('watch', id, frame.body.streams) };
        } else if (frame.type === 'APPSET') {
          // Audio unpublication also clears the published video capability
          // list. This is a correlated configuration update, not an RTP ACK.
          assert.equal(frame.body.action, 'upstreams');
          assert.equal(frame.body.params.length, 1);
          assert(Array.isArray(frame.body.params[0].upstreams));
          session.upstreams = frame.body.params[0].upstreams.map((stream, index) => ({
            ...stream, streamid: stream.streamid || 'isolated-client-upstream-' + index
          }));
          body = { params: [{ upstreams: session.upstreams }] };
        } else if (frame.type === 'BYE') {
          await invoke('leave', id);
          session.closed = true; session.joined = false;
        } else if (!['MEDIA_STATUS', 'UPDATE'].includes(frame.type)) {
          throw Error('Unimplemented HRTC wire operation: ' + frame.type);
        }
        session.replies.set(frame.requestid, body);
        rtcReply(socket, frame, body);
      }).catch(fail);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'https://127.0.0.1:' + server.address().port;
  const notification = (type, data) => {
    assert(currentCms && currentCms.readyState === WebSocket.OPEN, 'No current CMS socket');
    currentCms.send(JSON.stringify({ action: 'LocalControl', type, sequence: crypto.randomUUID(), data: JSON.stringify({ conferenceID: confId, ...data }) }));
  };
  return {
    origin, fingerprint, transcript, certPath, window,
    config: { origin, userAgent: 'IsolatedPackagedHrtc/1', deviceId: 'synthetic-verifier', caBundle: certPath,
      offlineJoinConfig: { Domains: { httpProxyUri: new URL(origin).host } }, watermark: { content: 'ISOLATED SYNTHETIC TEST', color: '#999999' } },
    params: { confId, random, nick_name: 'Synthetic offline participant', idPrefix: 'isolated-site',
      site_url: 'https://invitation-must-not-be-used.invalid/conferences', isOfflineJoin: true, isopen_mic: false, isopen_cam: false },
    get currentSession() { return currentRtc; },
    get pending() { return { join: !!heldJoin, notify: !!heldNotify, leave: !!heldLeave }; },
    holdAdmission(value) { admissionGate = value; },
    holdJoinNotify(value) { holdNotify = value; },
    holdLeave(value) { leaveGate = value; },
    releaseAdmission() { const respond = heldJoin; heldJoin = null; assert(respond); respond(); },
    releaseJoinNotify() { const respond = heldNotify; heldNotify = null; assert(respond); respond(); },
    releaseLeave() { const respond = heldLeave; heldLeave = null; assert(respond); respond(); },
    allowWaiting(participantID) { waiting = false; notification('ALLOWWAITINGPARTICIPANT', { participantID }); },
    moveToWaiting(participantID) { waiting = true; admitted = false; notification('MOVETOWAITINGROOM', { participantID }); },
    moderation: moderation ? {
      notify: notification,
      membership,
      role(role, cohost = '0') { assert(['0', '1', '2'].includes(role)); moderationRole = role; moderationCohost = cohost; membership(); },
      refuse(code) { moderationRefusal = code; },
      peerCapabilities(value) { moderationMembers.get('isolated-moderation-peer').pinfoMap.CLIENT_CAPABILITIES = value; membership(); },
      get advertisement() { return clientCapabilities; }
    } : null,
    announceAudio() {
      assert(currentRtc?.joined);
      currentRtc.socket.send(JSON.stringify({ type: 'NOTIFY', requestid: crypto.randomUUID(), roomid: roomId, userid: userId,
        body: { action: 'user_status_notify', notifytype: 'all', params: [{ userid: remoteId,
          nickname: 'Synthetic 1500 Hz tone and generated pattern', status: 'joined',
          upstreams: [{ streamid: 'isolated-pattern-video', width: 320, height: 180 }] }], auxs: [], wbs: [] } }));
    },
    stats(diagnostic = false) { assert(currentRtc); return invoke('stats', currentRtc.id, diagnostic); },
    async close() {
      for (const socket of sockets) socket.terminate();
      for (const session of rtcSessions.values()) {
        await session.chain.catch(() => {});
        if (!window.isDestroyed()) await invoke('leave', session.id).catch(() => {});
      }
      cms.close(); rtc.close();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      if (!window.isDestroyed()) window.destroy();
    }
  };
}
module.exports = { createPeer };
