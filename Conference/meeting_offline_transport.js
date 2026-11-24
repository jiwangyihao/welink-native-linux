'use strict';

// HIT APP 7.47.6: tup_confctrl 0x3EC90 (user token), 0x70AC0
// (temporary confToken), 0x81AA0 (type-1 endpoint); tup_httptrans 0x23B9B
// (headers). This is not the type-0 management socket or a browser nonce.
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const tls = require('tls');
const { EventEmitter } = require('events');
const WebSocket = require('./vendor/management/node_modules/ws');
const { HttpsProxyAgent } = require('./vendor/management/node_modules/https-proxy-agent');

const CONTROL_PATH = '/v1/mmc/control/websocket/conn';
const TOKEN_PATH = '/v1/mmc/control/conferences/wss/token/user';
const SUBPROTOCOL = 'tup_service_protocol';
const MAX_PAYLOAD = 1024 * 1024;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value, name, empty = false) {
  if (typeof value !== 'string' || (!empty && !value) || /[\r\n\0]/.test(value))
    throw failure('INVALID_OFFLINE_CONFIG', 'Invalid ' + name);
  return value;
}
function authority(value) {
  let url;
  try { url = new URL(value); } catch (_) {}
  if (!url || url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash)
    throw failure('INVALID_OFFLINE_AUTHORITY', 'A configured HTTPS control authority is required');
  return url;
}
function parseObject(data) {
  let value = data;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') {
    try { value = JSON.parse(value); }
    catch (_) { throw failure('INVALID_OFFLINE_RESPONSE', 'The control response is not JSON'); }
  }
  if (!object(value)) throw failure('INVALID_OFFLINE_RESPONSE', 'The control response is not an object');
  return value;
}
function result(data) {
  const value = parseObject(data);
  const code = value.returnCode === undefined ? value.error_code : value.returnCode;
  if (code === undefined || (typeof code !== 'number' && typeof code !== 'string'))
    throw failure('INVALID_OFFLINE_RESPONSE', 'The control result has no return code');
  if (code !== 0 && code !== '0') {
    const error = failure(code, value.returnDesc || value.error_msg || 'Conference control rejected the operation');
    // Preserve admission/challenge data, but never publish the session credential.
    const { wssToken, token, confToken, password, ...serverResult } = value;
    error.serverResult = serverResult;
    throw error;
  }
  return value;
}
function checkCurrent(isCurrent, signal) {
  if ((signal && signal.aborted) || !isCurrent())
    throw failure('OFFLINE_RETIRED', 'The offline conference owner was retired');
}
async function networkOptions(config, origin, isCurrent, signal) {
  const url = authority(origin);
  const peer = url.hostname.replace(/^\[|\]$/g, '');
  let ca;
  if (config.caBundle) {
    text(config.caBundle, 'CA bundle path');
    ca = await fs.promises.readFile(config.caBundle);
    checkCurrent(isCurrent, signal);
  }
  let agent;
  if (config.proxyUrl) {
    let proxy;
    try { proxy = new URL(config.proxyUrl); } catch (_) {}
    if (!proxy || !['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password ||
        proxy.pathname !== '/' || proxy.search || proxy.hash)
      throw failure('INVALID_OFFLINE_PROXY', 'A configured HTTP(S) proxy authority is required');
    if (config.proxyUsername !== undefined) proxy.username = text(config.proxyUsername, 'proxy username', true);
    if (config.proxyPassword !== undefined) proxy.password = text(config.proxyPassword, 'proxy password', true);
    agent = new HttpsProxyAgent(proxy, { rejectUnauthorized: true, ...(ca ? { ca } : {}) });
  }
  return {
    rejectUnauthorized: true, ...(ca ? { ca } : {}), ...(agent ? { agent } : {}),
    checkServerIdentity: (_host, certificate) => tls.checkServerIdentity(peer, certificate)
  };
}
function identityHeaders(config) {
  return {
    'X-Request-ID': crypto.randomUUID(),
    'User-Agent': text(config.userAgent, 'user agent'),
    'X-Device-Id': text(config.deviceId, 'device ID')
  };
}

async function queryUserToken(origin, input, config, { timeoutMs, isCurrent, signal }) {
  checkCurrent(isCurrent, signal);
  const options = await networkOptions(config, origin, isCurrent, signal);
  const endpoint = new URL(TOKEN_PATH, origin);
  endpoint.searchParams.set('conferenceID', input.confId);
  const body = JSON.stringify({ name: input.nick_name, password: input.password,
    loginAccount: config.loginAccount || '', random: input.random });
  return new Promise((resolve, reject) => {
    let request, timer, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      if (options.agent) options.agent.destroy();
      error ? reject(error) : resolve(value);
    };
    const abort = () => {
      const error = failure('OFFLINE_RETIRED', 'The offline token request was retired');
      finish(error);
      if (request) request.destroy();
    };
    try {
      checkCurrent(isCurrent, signal);
      request = https.request(endpoint, {
        ...options, method: 'POST', headers: {
          ...identityHeaders(config), 'Accept-Language': 'Zh-CN',
          'Content-Type': 'application/json;charset=UTF-8', 'Content-Length': Buffer.byteLength(body)
        }
      }, response => {
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_PAYLOAD) {
            finish(failure('OFFLINE_RESPONSE_TOO_LARGE', 'The token response exceeded its bound'));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on('aborted', () => finish(failure('OFFLINE_RESPONSE_ABORTED', 'The token response was interrupted')));
        response.on('error', error => finish(error));
        response.on('end', () => {
          if (settled) return;
          try {
            checkCurrent(isCurrent, signal);
            // Never follow a redirect, including one to an issuer-named site.
            if (response.statusCode >= 300 && response.statusCode < 400)
              throw failure('OFFLINE_REDIRECT_REJECTED', 'The control token endpoint redirected the request');
            const data = parseObject(Buffer.concat(chunks, size));
            const value = result(data);
            if (response.statusCode < 200 || response.statusCode >= 300)
              throw failure('OFFLINE_HTTP_REJECTED', 'The control token endpoint rejected the request');
            finish(null, value);
          } catch (error) { error.status = response.statusCode; finish(error); }
        });
      });
      request.on('error', error => finish(error));
      timer = setTimeout(() => {
        finish(failure('OFFLINE_TOKEN_TIMEOUT', 'The offline user-token request timed out'));
        request.destroy();
      }, timeoutMs);
      if (signal) signal.addEventListener('abort', abort, { once: true });
      checkCurrent(isCurrent, signal);
      request.end(body);
    } catch (error) { finish(error); if (request) request.destroy(); }
  });
}

class ControlSession extends EventEmitter {
  constructor(origin, config, authorization, { timeoutMs, isCurrent, signal, jwtAuthorization = '' }) {
    super();
    this.origin = authority(origin).origin;
    this.connectionType = 1;
    this.config = config;
    this.authorization = text(authorization, 'control authorization');
    this.jwtAuthorization = text(jwtAuthorization, 'JWT authorization', true);
    this.timeoutMs = timeoutMs;
    this.isCurrent = isCurrent;
    this.signal = signal;
    this.pending = new Map();
    this.socket = null;
    this.closed = false;
    this.abort = () => this.close(failure('OFFLINE_RETIRED', 'The control session was retired'));
  }
  async open() {
    checkCurrent(this.isCurrent, this.signal);
    this.network = await networkOptions(this.config, this.origin, this.isCurrent, this.signal);
    try {
      checkCurrent(this.isCurrent, this.signal);
      const endpoint = new URL(CONTROL_PATH, this.origin);
      endpoint.protocol = 'wss:';
      const socket = this.socket = new WebSocket(endpoint, SUBPROTOCOL, {
        ...this.network, followRedirects: false, perMessageDeflate: false,
        maxPayload: MAX_PAYLOAD, handshakeTimeout: this.timeoutMs,
        headers: { ...identityHeaders(this.config), Authorization: this.authorization,
          'X-Connection-Type': '1', 'X-JWT-Authorization': this.jwtAuthorization,
          'User-Agent-Ext': text(this.config.userAgentExt || '', 'extended user agent', true) }
      });
      await new Promise((resolve, reject) => {
        this.rejectOpen = reject;
        socket.on('error', error => this.close(error));
        socket.on('close', code => this.close(Object.assign(
          failure('OFFLINE_CONTROL_CLOSED', 'The persistent conference-control connection closed'), { closeCode: code })));
        socket.on('unexpected-response', (_request, response) => {
          response.resume();
          this.close(Object.assign(failure('OFFLINE_UPGRADE_REJECTED', 'The control WebSocket upgrade was rejected'),
            { status: response.statusCode }));
        });
        socket.on('message', (data, isBinary) => this.receive(data, isBinary));
        socket.once('open', () => {
          try {
            checkCurrent(this.isCurrent, this.signal);
            if (socket.protocol !== SUBPROTOCOL)
              throw failure('OFFLINE_SUBPROTOCOL_MISMATCH', 'The control server did not negotiate the native subprotocol');
            this.rejectOpen = null;
            // Native WSClient_GetReqMsg: 60 * 500ms, application PING.
            this.heartbeat = setInterval(() => {
              try { this.send({ action: 'PING' }); } catch (error) { this.close(error); }
            }, 30000);
            resolve();
          } catch (error) { this.close(error); }
        });
        if (this.signal) this.signal.addEventListener('abort', this.abort, { once: true });
        checkCurrent(this.isCurrent, this.signal);
      });
      return this;
    } catch (error) { this.close(error); throw error; }
  }
  send(frame) {
    checkCurrent(this.isCurrent, this.signal);
    if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN)
      throw failure('OFFLINE_CONTROL_CLOSED', 'The control connection is not open');
    this.socket.send(JSON.stringify(frame), error => { if (error) this.close(error); });
  }
  request(action, type, data) {
    const sequence = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sequence);
        reject(failure('OFFLINE_CONTROL_TIMEOUT', 'No correlated ' + (type || action) + ' result arrived'));
      }, this.timeoutMs);
      this.pending.set(sequence, { action, type, resolve, reject, timer });
      try { this.send({ action, ...(type ? { type } : {}), sequence, data: JSON.stringify(data) }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(sequence);
        reject(error);
      }
    });
  }
  subscribe(conferenceID, subscribeType, clientCapabilities, cancel = false) {
    // Unlike the online browser's Basic(accessToken), native temporary control
    // uses the exact token installed by StartConfctrlWebSocket (0x70CCB).
    return this.request(cancel ? 'CancelSubscribe' : 'Subscribe', undefined, {
      conferenceID, subscribeType, connectionType: 1, confToken: this.authorization, clientCapabilities
    });
  }
  receive(bytes, isBinary) {
    if (this.closed) return;
    try {
      checkCurrent(this.isCurrent, this.signal);
      if (isBinary) throw failure('INVALID_OFFLINE_RESPONSE', 'The control server sent a binary frame');
      const frame = parseObject(bytes);
      const pending = this.pending.get(frame.sequence);
      if (pending) {
        if (frame.action !== pending.action || (frame.type || undefined) !== pending.type)
          throw failure('OFFLINE_CORRELATION_MISMATCH', 'A correlated control response changed operation');
        this.pending.delete(frame.sequence);
        clearTimeout(pending.timer);
        try { pending.resolve(result(frame.data)); } catch (error) { pending.reject(error); }
      } else if (typeof frame.action === 'string' &&
          (frame.action === 'LocalControl' || frame.action.endsWith('Notify'))) {
        this.emit('notification', frame);
      }
    } catch (error) { this.close(error); }
  }
  close(error = failure('OFFLINE_CONTROL_CLOSED', 'The control session was closed')) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    if (this.signal) this.signal.removeEventListener('abort', this.abort);
    if (this.rejectOpen) { this.rejectOpen(error); this.rejectOpen = null; }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (this.socket) this.socket.terminate();
    if (this.network && this.network.agent) this.network.agent.destroy();
    this.socket = null;
    this.network = null;
    this.authorization = '';
    this.jwtAuthorization = '';
    this.config = null;
    this.emit('closed', error);
  }
}

// A main-owned established type-1 session can be leased to the control owner.
// Credentials are never accepted from join input or a renderer frame.
async function openControlSession({ origin, config, authorization, jwtAuthorization = '',
  timeoutMs = 45000, isCurrent, signal }) {
  if (typeof isCurrent !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw failure('INVALID_OFFLINE_CONFIG', 'A current session owner and positive timeout are required');
  return new ControlSession(origin, config, authorization,
    { timeoutMs, isCurrent, signal, jwtAuthorization }).open();
}

module.exports = { queryUserToken, openControlSession, ControlSession, authority,
  failure, object, text, result, parseObject, checkCurrent };
