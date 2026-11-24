'use strict';

const path = require('path');

const RESPONSE_TAG = 'welink-invitation-resolution-v1';
const AUTH_PATH = '/v1/mmc/management/conferences/authConf';
const INVALID_TEXT = /[\u0000-\u001f\u007f]/;
const INVALID_URL = /[\u0000-\u0020\u007f\\]/;
const ERROR_MESSAGES = Object.freeze({
  INVALID_MEETING_INVITATION: 'The meeting invitation is invalid',
  ISSUER_CONTEXT_UNAVAILABLE: 'The originating meeting request context is unavailable',
  ISSUER_REQUEST_UNAVAILABLE: 'The meeting issuer request could not complete',
  ISSUER_REQUEST_TIMEOUT: 'The meeting issuer request timed out',
  ISSUER_REDIRECT_UNAVAILABLE: 'The meeting issuer redirected the protected request',
  ISSUER_CHANGED: 'The originating meeting context is no longer current',
  ISSUED_SITE_UNAVAILABLE: 'The meeting issuer grant is unavailable'
});

function failure(code) {
  return Object.assign(new Error(ERROR_MESSAGES[code]), { code });
}

function issuerError(error) {
  const code = Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : 'ISSUER_REQUEST_UNAVAILABLE';
  return { code, message: ERROR_MESSAGES[code] };
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, limit, empty = false) {
  return typeof value === 'string' && value.length <= limit && !INVALID_TEXT.test(value) &&
    (empty || (value.trim().length > 0 && value !== 'null' && value !== 'undefined'));
}

function https(value, originOnly = false) {
  if (typeof value !== 'string' || value.length > 8192 || INVALID_URL.test(value) ||
      !/^https:\/\/[^/?#]+(?:[/?#]|$)/i.test(value)) throw failure('INVALID_MEETING_INVITATION');
  let url;
  try { url = new URL(value); } catch (_) { throw failure('INVALID_MEETING_INVITATION'); }
  const authority = value.slice(value.indexOf('//') + 2).split(/[/?#]/, 1)[0];
  if (url.protocol !== 'https:' || !url.hostname || url.hostname.includes('*') || authority.includes('@') ||
      url.username || url.password || value.includes('#') ||
      (originOnly && (url.pathname !== '/' || value.includes('?')))) throw failure('INVALID_MEETING_INVITATION');
  return url;
}

function invitation(input) {
  if (!object(input) || input.kind !== 'resolve-invitation' ||
      Object.keys(input).some(key => !['kind', 'confId', 'password', 'expectedPrefix', 'joinType'].includes(key)) ||
      !text(input.confId, 256) || !text(input.password, 16384, true) ||
      (input.expectedPrefix != null && input.expectedPrefix !== '' && !text(input.expectedPrefix, 2048)) ||
      (input.joinType != null && !['', 'online', 'offline'].includes(input.joinType)))
    throw failure('INVALID_MEETING_INVITATION');
  // Copy before awaiting anything. A caller cannot change the ID/password mapping
  // while the native request, account context or grant is being resolved.
  return { confId: input.confId, password: input.password,
    expectedPrefix: input.expectedPrefix, joinType: input.joinType };
}

function requestContext(context, originatingView) {
  if (!object(context) || !object(context.envInfo) || !object(context.appInfo) ||
      !object(originatingView) || !text(originatingView.userAgent, 4096) || !text(originatingView.viewId, 256) ||
      !text(context.appInfo.appVersionName, 256) ||
      !['string', 'number'].includes(typeof context.appInfo.appVersionCode) ||
      !text(String(context.appInfo.appVersionCode), 256)) throw failure('ISSUER_CONTEXT_UNAVAILABLE');
  const env = context.envInfo;
  for (const key of ['proxyAccount', 'proxyAddress', 'proxyPassword', 'caCertPath']) {
    if (env[key] != null && !text(env[key], 8192, true)) throw failure('ISSUER_CONTEXT_UNAVAILABLE');
  }
  const port = env.proxyPort == null || env.proxyPort === '' ? 0 : Number(env.proxyPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (env.proxyAddress && !port))
    throw failure('ISSUER_CONTEXT_UNAVAILABLE');
  const tlsParam = { ca_cert_path: env.caCertPath || '', tls_mode: 1, vertfy_server_mode: 0 };
  const proxyParam = env.proxyAddress ? { ip: env.proxyAddress, port,
    auth_info: { username: env.proxyAccount || '', password: env.proxyPassword || '' } } :
    { ip: '', port: 0, auth_info: { username: '', password: '' } };
  // This is the original httpWithRsSdk.js UA expression. Its non-win32 branch
  // says "Mac" even in the shipped Linux adaptation; do not invent a new agent.
  // Main derives caller identity from the verified invitation frame/manifest and
  // its webContents. The service's own view ID/UA must not replace the caller:
  // doing so would bypass a module fuse applying to the conference invitation UI.
  const userAgent = originatingView.userAgent + ' WeLink/' + (process.platform === 'win32' ? 'Windows' : 'Mac') + '/' +
    context.appInfo.appVersionName + '.' + context.appInfo.appVersionCode + '/' + originatingView.viewId;
  const fuse = context.fuseInfo;
  if (fuse != null && (!object(fuse) || ['module', 'request'].some(key =>
    fuse[key] != null && (!object(fuse[key]) || !Array.isArray(fuse[key].blackList) ||
      fuse[key].blackList.some(value => typeof value !== 'string'))))) throw failure('ISSUER_CONTEXT_UNAVAILABLE');
  return { userAgent, viewId: originatingView.viewId, tlsParam, proxyParam, fuse };
}

function facadeReply(reply) {
  if (!object(reply) || !Number.isInteger(reply.result)) throw failure('ISSUER_REQUEST_UNAVAILABLE');
  if (reply.result !== 0) throw failure('ISSUER_REQUEST_UNAVAILABLE');
  const param = reply.param;
  if (!object(param) || !Number.isInteger(param.resp_code) ||
      (param.recv_body != null && typeof param.recv_body !== 'string'))
    throw failure('ISSUER_REQUEST_UNAVAILABLE');
  if (param.resp_code >= 300 && param.resp_code < 400) throw failure('ISSUER_REDIRECT_UNAVAILABLE');
  let body = {};
  try { body = JSON.parse(param.recv_body); } catch (_) { /* The original wrapper uses an empty body. */ }
  if (!object(body)) body = {};
  // httpWithRsSdk.js C/F: business status belongs to the service. In particular,
  // HTTP 200 with a nonzero code/errorCode is NOT an issuer success.
  let code = param.resp_code === 200 ? body.code || body.errorCode || 0 : -1;
  if (isNaN(code)) code = 0;
  const result = [0, 200, 302].includes(parseInt(code));
  const message = result ? '' : code === -1 ? 'Network connection error. Check the network settings.' :
    body.message || body.errorMessage || 'Network connection error. Check the network settings.';
  return { code, result, message, recv_body: body, resp_code: param.resp_code,
    out_header: Array.isArray(param.out_header) ? param.out_header : [],
    requestId: typeof param.requestId === 'string' ? param.requestId : '',
    traceId: typeof param.traceId === 'string' ? param.traceId : '' };
}

// Main-process only. The input is the entire scoped IPC request, not a supplied
// response or endpoint. Main supplies service context separately from the
// verified invitation caller's originatingView. isCurrent binds both lifetimes.
// There is exactly one native authConf operation.
async function resolveInvitation(origin, input, { transport, context, originatingView, isCurrent } = {}) {
  const invite = invitation(input), issuer = https(origin, true).origin;
  if (!transport || typeof transport.request !== 'function' || typeof isCurrent !== 'function')
    throw failure('ISSUER_CONTEXT_UNAVAILABLE');
  if (!isCurrent()) throw failure('ISSUER_CHANGED');
  const settings = requestContext(context, originatingView);
  let requestURL;
  try { requestURL = issuer + AUTH_PATH + '?conferenceID=' + encodeURIComponent(invite.confId); }
  catch (_) { throw failure('INVALID_MEETING_INVITATION'); }
  const blocked = settings.fuse?.module?.blackList.includes(settings.viewId) ||
    settings.fuse?.request?.blackList.some(prefix => requestURL.startsWith(prefix));
  if (blocked) return { issuer, requestURL, grantParams: null,
    response: { code: -1001, result: false, message: '当前发送的请求被熔断', recv_body: {}, resp_code: -1001, out_header: [] } };
  let nativeReply;
  try {
    nativeReply = await transport.request({ url: requestURL, body: '{}',
      header: { 'User-Agent': settings.userAgent, 'X-Password': invite.password } }, settings);
  } catch (error) {
    if (!isCurrent()) throw failure('ISSUER_CHANGED');
    throw failure(issuerError(error).code);
  }
  if (!isCurrent()) throw failure('ISSUER_CHANGED');
  const response = facadeReply(nativeReply);
  const resolved = { issuer, requestURL, response, grantParams: null };
  if (!response.result) return resolved;
  const body = response.recv_body;
  if (!text(body.siteUrl, 8192) || !text(body.random, 16384) ||
      (body.idPrefix != null && body.idPrefix !== '' && !text(body.idPrefix, 2048)) ||
      (invite.expectedPrefix && invite.expectedPrefix !== body.idPrefix)) throw failure('INVALID_MEETING_INVITATION');
  const site = https(body.siteUrl);
  if (body.idPrefix && invite.joinType !== 'offline' && site.origin !== issuer) {
    resolved.grantParams = { site_url: body.siteUrl, random: body.random, idPrefix: body.idPrefix,
      confId: invite.confId, isOfflineJoin: false };
  }
  return resolved;
}

// The shipped ffi-napi Library hook pins the callback/library and pumps on the
// owning event-loop thread. Renderer HTTP libraries live in different processes;
// this is one dedicated main-process owner, not a second renderer request.
function createNativeIssuerTransport({ appRoot }) {
  if (process.type === 'renderer') throw failure('ISSUER_CONTEXT_UNAVAILABLE');
  let native, callback, sequence = 0, closed = false;
  const pending = new Map();
  function settle(sno, error, reply) {
    const request = pending.get(sno);
    if (!request) return;
    pending.delete(sno);
    clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve(reply);
  }
  function load() {
    if (native) return;
    const ffi = require(path.join(appRoot, 'libraries/node_extends/node-ffi/ffi-napi'));
    const library = ffi.Library(path.join(appRoot, 'native/lib/http_with_rs.dll.so'), {
      http_json_init: ['int', ['pointer']], http_json_call_msg: ['int', ['string']],
      http_json_shutdown: ['int', []]
    });
    callback = ffi.Callback('void', ['string'], value => {
      let reply;
      try { reply = JSON.parse(value); } catch (_) { return; }
      if (reply?.rsp === 109 && Number.isSafeInteger(reply.sno)) settle(reply.sno, null, reply);
    });
    if (library.http_json_init(callback) !== 0) throw failure('ISSUER_CONTEXT_UNAVAILABLE');
    native = library;
  }
  return Object.freeze({
    request(request, settings) {
      if (closed) return Promise.reject(failure('ISSUER_CONTEXT_UNAVAILABLE'));
      try { load(); } catch (_) { return Promise.reject(failure('ISSUER_CONTEXT_UNAVAILABLE')); }
      return new Promise((resolve, reject) => {
        const sno = ++sequence;
        const timer = setTimeout(() => settle(sno, failure('ISSUER_REQUEST_TIMEOUT')), 35000);
        pending.set(sno, { resolve, reject, timer });
        // cmd103's RS standby-host substitution is unsuitable for a fixed-origin
        // credential request. The existing direct native command uses exactly the
        // same verified TLS/proxy stack but cannot leave the chosen authority.
        // HttpBridge sets FOLLOWLOCATION=0 and performs no application retries.
        const message = { cmd: 109, sno, description: 'HttpSynSend', param: {
          req_param: { url: request.url, type: 3, body: request.body, header: request.header,
            auth_info: { mode: 0, username: '', password: '' } },
          config_param: { tls_param: settings.tlsParam, proxy_param: settings.proxyParam,
            tcp_timeout: 10, req_timeout: 30 }
        } };
        try {
          if (native.http_json_call_msg(JSON.stringify(message)) !== 0)
            settle(sno, failure('ISSUER_REQUEST_UNAVAILABLE'));
        } catch (_) { settle(sno, failure('ISSUER_REQUEST_UNAVAILABLE')); }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const sno of pending.keys()) settle(sno, failure('ISSUER_CHANGED'));
      if (native && native.http_json_shutdown() !== 0) throw failure('ISSUER_REQUEST_UNAVAILABLE');
    }
  });
}

module.exports = { RESPONSE_TAG, resolveInvitation, createNativeIssuerTransport, issuerError };
