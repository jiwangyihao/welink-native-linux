'use strict';

/* Real native conference-management transport, not the in-conference CMS socket.
 * Matched HIT APP: tup_confctrl WssLinkConfMang 0x1007f720; tup_httptrans
 * management wsType=0 handshake 0x10023b5d; CREATECONF response 0x10052330.
 * Origin and identity must be the SAME configuration used by native USG auth.
 * Dependencies are integrity-pinned pure JS under vendor/management; no native
 * addon, vendor SDK emulation, redirects, creation retry, or credential logging.
 * A matching response completes this request; phone connection is not inferred.
 */
const crypto = require('crypto');
const fs = require('fs');
const tls = require('tls');
const WebSocket = require('./vendor/management/node_modules/ws');
const { HttpsProxyAgent } = require('./vendor/management/node_modules/https-proxy-agent');

const MANAGEMENT_PATH = '/v1/usg/wss/websocket';
const SUBPROTOCOL = 'tup_service_protocol';
const MAX_PAYLOAD = 1024 * 1024;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
function header(value, name, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value) || /[\r\n\0]/.test(value))
    throw failure('INVALID_MANAGEMENT_IDENTITY', 'The configured ' + name + ' is invalid');
  return value;
}
function proxyAgent(config, ca) {
  if (!config.proxyUrl) return null;
  let proxy;
  try { proxy = new URL(config.proxyUrl); }
  catch (_) { throw failure('INVALID_MANAGEMENT_PROXY', 'The configured conference proxy URL is invalid'); }
  if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password ||
      proxy.pathname !== '/' || proxy.search || proxy.hash)
    throw failure('INVALID_MANAGEMENT_PROXY', 'A configured HTTP(S) conference proxy authority is required');
  if (config.proxyUsername !== undefined) proxy.username = header(config.proxyUsername, 'proxy username', true);
  if (config.proxyPassword !== undefined) proxy.password = header(config.proxyPassword, 'proxy password', true);
  return new HttpsProxyAgent(proxy, { rejectUnauthorized: true, ...(ca ? { ca } : {}) });
}

function createManagementTransport({ origin, getAccessToken, getConfig, timeoutMs = 45000 }) {
  let authority;
  try { authority = new URL(origin); }
  catch (_) { throw failure('INVALID_MANAGEMENT_ORIGIN', 'The authenticated USG HTTPS origin is required'); }
  if (authority.protocol !== 'https:' || authority.username || authority.password ||
      authority.pathname !== '/' || authority.search || authority.hash)
    throw failure('INVALID_MANAGEMENT_ORIGIN', 'The authenticated USG HTTPS origin must be an authority');
  const peerHostname = authority.hostname.startsWith('[') ? authority.hostname.slice(1, -1) : authority.hostname;
  if (typeof getAccessToken !== 'function' || typeof getConfig !== 'function')
    throw failure('MANAGEMENT_PROVIDER_MISSING', 'Real USG token and authentication-configuration providers are required');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw failure('INVALID_MANAGEMENT_TIMEOUT', 'The management request timeout must be positive');
  let disposed = false;
  let generation = 0;
  const active = new Set();

  function current(expected) {
    if (disposed) throw failure('DISPOSED', 'The conference-management transport was disposed');
    if (generation !== expected)
      throw failure('MANAGEMENT_REQUEST_ABORTED', 'The conference-management request was retired');
  }
  // begin is per-attempt control. cancel records user intent after transmission;
  // retire (and the transport-wide cancel below) is account teardown and closes
  // the socket unconditionally. Ordinary request callers keep their Promise API.
  function begin(type, body, { responseTimeoutMs } = {}) {
    if (responseTimeoutMs !== undefined && (!Number.isInteger(responseTimeoutMs) || responseTimeoutMs <= 0))
      throw failure('INVALID_MANAGEMENT_TIMEOUT', 'The management response timeout must be positive');
    const expected = generation;
    let socket, timer, heartbeat, agent, settled = false, transmissionAttempted = false;
    let cancelRequested = false, retired = false, resultConfirmed = false;
    let resolveResult, rejectResult;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const state = () => ({ settled, transmissionAttempted, cancelRequested, retired, resultConfirmed });
    const finish = (error, frame) => {
      if (settled) return;
      settled = true;
      resultConfirmed = !error;
      clearTimeout(timer);
      clearInterval(heartbeat);
      active.delete(operation);
      if (error) {
        error.details = { ...(error.details || {}), transmissionAttempted,
          resultConfirmed: false, operation: 'ConfManagement/CREATECONF' };
      }
      if (socket) {
        if (!error && socket.readyState === WebSocket.OPEN) {
          socket.close(1000);
          const closing = setTimeout(() => socket.terminate(), 1000);
          if (typeof closing.unref === 'function') closing.unref();
          socket.once('close', () => { clearTimeout(closing); if (agent) agent.destroy(); });
        } else {
          socket.terminate();
          if (agent) agent.destroy();
        }
      } else if (agent) agent.destroy();
      error ? rejectResult(error) : resolveResult(frame);
    };
    const operation = Object.freeze({
      result, state,
      cancel() {
        if (!settled) {
          cancelRequested = true;
          if (!transmissionAttempted)
            finish(failure('MANAGEMENT_REQUEST_CANCELLED', 'The call was cancelled before CREATECONF was sent'));
        }
        return state();
      },
      retire() {
        retired = true;
        finish(failure('MANAGEMENT_REQUEST_ABORTED', 'The conference-management request was retired'));
        return state();
      }
    });
    const check = () => {
      current(expected);
      if (settled)
        throw failure('MANAGEMENT_REQUEST_ABORTED', 'The conference-management request is no longer active');
    };
    active.add(operation);
    timer = setTimeout(() => finish(failure('MANAGEMENT_TIMEOUT',
      'No correlated conference-management response arrived; the creation outcome is unconfirmed')), timeoutMs);
    const prepare = async () => {
      check();
      if (type !== 'CREATECONF' || !body || typeof body !== 'object' || Array.isArray(body) ||
          Object.prototype.hasOwnProperty.call(body, 'token'))
        throw failure('INVALID_MANAGEMENT_REQUEST', 'Only the recovered token-free CREATECONF input is accepted');
      const config = await getConfig();
      check();
      if (!config || typeof config !== 'object' || config.server !== authority.hostname ||
          !Number.isInteger(config.port) || config.port !== Number(authority.port || 443))
        throw failure('MANAGEMENT_ORIGIN_MISMATCH', 'Management identity must use the same configured USG authentication host and port');
      const userAgent = header(config.userAgent, 'user agent');
      const deviceId = header(config.deviceId, 'device identity');
      // Native wsType=0 sends an empty JWT header when none was supplied.
      const jwt = config.jwtAuthorization === undefined ? '' : header(config.jwtAuthorization, 'JWT authorization', true);
      let ca;
      if (config.caBundle !== undefined && config.caBundle !== '') {
        if (typeof config.caBundle !== 'string' || config.caBundle.includes('\0'))
          throw failure('INVALID_MANAGEMENT_CA', 'The configured conference CA bundle path is invalid');
        ca = await fs.promises.readFile(config.caBundle);
        check();
      }
      const token = header(await getAccessToken(), 'USG token');
      check();
      const sequence = crypto.randomUUID();
      const endpoint = new URL(MANAGEMENT_PATH, authority);
      endpoint.protocol = 'wss:';
      endpoint.search = '?agent=' + encodeURIComponent(userAgent);
      const message = JSON.stringify({ action: 'ConfManagement', type, sequence,
        data: JSON.stringify({ ...body, token }) });
      agent = proxyAgent(config, ca);
      try {
        check();
        socket = new WebSocket(endpoint, SUBPROTOCOL, {
          followRedirects: false, perMessageDeflate: false, maxPayload: MAX_PAYLOAD,
          handshakeTimeout: timeoutMs, rejectUnauthorized: true,
          ...(ca ? { ca } : {}), ...(agent ? { agent } : {}),
          // CONNECT agents can omit host for IP targets. Validate the configured
          // peer explicitly instead of Node's otherwise-default localhost name.
          checkServerIdentity: (_hostname, certificate) => tls.checkServerIdentity(peerHostname, certificate),
          headers: {
            'X-Auth-Token': token, 'X-Request-ID': crypto.randomUUID(),
            'User-Agent': userAgent, 'X-Device-Id': deviceId,
            'X-JWT-Authorization': jwt, 'x-request-unified-link': '1'
          }
        });
        socket.on('error', error => finish(error));
        socket.on('close', (code) => {
          if (!settled) {
            const error = failure('MANAGEMENT_CONNECTION_CLOSED', 'The management connection closed before a correlated response');
            error.details = { closeCode: code };
            finish(error);
          }
        });
        socket.on('unexpected-response', (request, response) => {
          const chunks = [];
          let size = 0;
          response.on('error', error => finish(error));
          response.on('aborted', () => finish(failure('MANAGEMENT_HANDSHAKE_ABORTED', 'The management handshake response was interrupted')));
          response.on('data', chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > MAX_PAYLOAD) {
              finish(failure('MANAGEMENT_RESPONSE_TOO_LARGE', 'The management handshake response exceeded its bound'));
              response.destroy();
            } else chunks.push(chunk);
          });
          response.on('end', () => {
            if (settled) return;
            const text = Buffer.concat(chunks, size).toString('utf8');
            let data = text || null;
            if (text) { try { data = JSON.parse(text); } catch (_) {} }
            const error = failure(data && data.error_code !== undefined ? data.error_code : 'MANAGEMENT_HANDSHAKE_REJECTED',
              data && data.error_msg || 'The authenticated management WebSocket upgrade was rejected');
            error.status = response.statusCode;
            error.response = { status: response.statusCode, data };
            finish(error);
          });
        });
        socket.on('open', () => {
          if (settled) return;
          try {
            check();
            if (socket.protocol !== SUBPROTOCOL)
              throw failure('MANAGEMENT_SUBPROTOCOL_MISMATCH', 'The server did not negotiate the native management subprotocol');
            transmissionAttempted = true;
            // P2P CREATECONF starts a ten-tick, one-second operation timer
            // after dispatch (tup_confctrl 0x3A454 / 0x7BC39 / 0x7CDC9).
            // Keep authentication/TLS preparation on the existing timeout.
            if (responseTimeoutMs !== undefined) {
              clearTimeout(timer);
              timer = setTimeout(() => finish(failure('MANAGEMENT_TIMEOUT',
                'No correlated conference-management response arrived; the creation outcome is unconfirmed')), responseTimeoutMs);
            }
            socket.send(message, error => { if (error) finish(error); });
            // Native WSClient_GetReqMsg uses 60 * 500 ms and an application
            // PING object, not a WebSocket control ping or a CMS HeartBeat.
            heartbeat = setInterval(() => {
              if (!settled && socket.readyState === WebSocket.OPEN)
                socket.send('{"action":"PING"}', error => { if (error) finish(error); });
            }, 30000);
          } catch (error) { finish(error); }
        });
        socket.on('message', (data, isBinary) => {
          if (settled) return;
          let frame;
          try {
            check();
            if (isBinary) throw failure('INVALID_MANAGEMENT_RESPONSE', 'The management server returned a binary frame');
            try { frame = JSON.parse(data.toString('utf8')); }
            catch (_) { throw failure('INVALID_MANAGEMENT_RESPONSE', 'The management response is not valid JSON'); }
            if (!frame || typeof frame !== 'object' || Array.isArray(frame))
              throw failure('INVALID_MANAGEMENT_RESPONSE', 'The management response is not an object');
            // The service also emits unrelated notifications/heartbeat responses.
            // They are never mistaken for this request's completion.
            if (frame.sequence !== sequence) return;
            if (frame.action !== 'ConfManagement' || frame.type !== type)
              throw failure('MANAGEMENT_CORRELATION_MISMATCH', 'The correlated response has a different management action/type');
            finish(null, frame);
          } catch (error) {
            if (frame) error.response = frame;
            finish(error);
          }
        });
      } catch (error) { finish(error); }
    };
    prepare().catch(error => finish(error));
    return operation;
  }
  async function request(type, body) {
    return begin(type, body).result;
  }
  function cancel() {
    ++generation;
    for (const operation of Array.from(active)) operation.retire();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancel();
  }
  return Object.freeze({ request, begin, cancel, dispose });
}

module.exports = { createManagementTransport };
