#!/usr/bin/env python3
"""Loopback-only integration validation for HttpBridge/http_with_rs.c.

This script does NOT build the SDK or touch a client installation. Run after the
parent builds the ia32 .so, using the actual rebuilt Electron/ffi-napi pair:
  python3 verify_http_with_rs.py --library /absolute/http_with_rs.so \
      --ffi /absolute/linux/ffi-napi --electron /absolute/ia32/electron

It re-execs itself in private user/mount/network namespaces, enables only lo,
mounts a temporary hosts file and CA bundle inside that namespace, and uses real
TLS origin/Compass/CONNECT-proxy servers. No network interface or route to an
external service exists. Namespace creation failure is a failure, not a skip.
No certificates, hosts, system trust, vendor files, or user state are changed
outside the namespace. Python, OpenSSL, mount, unshare and Node's real ffi-napi
are prerequisites. All test credentials are disposable loopback-only strings.
"""
import argparse
import base64
import contextlib
import hashlib
import http.server
import json
import os
from pathlib import Path
import select
import shutil
import socket
import socketserver
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time

NAMES = ["localhost", "rs.com.http-test.invalid", "rs.cn.http-test.invalid",
         "service.com.http-test.invalid", "service.http-test.invalid",
         "pinned.http-test.invalid", "untrusted.http-test.invalid"]
PAYLOAD = bytes(range(256)) * 8192
NODE_DRIVER = r'''
'use strict';
const assert = require('assert');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const {Worker} = require('worker_threads');
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.strictEqual(process.arch, 'ia32', 'use the real ia32 runtime');
assert.strictEqual(process.versions.electron, '22.3.26');
assert.strictEqual(process.versions.node, '16.17.1');
const ffi = require(fixture.ffi);
const library = ffi.Library(fixture.library, {
  http_json_init: ['int', ['pointer']],
  http_json_call_msg: ['int', ['string']],
  http_json_set_log_param: ['int', ['int', 'int', 'string']],
  http_json_shutdown: ['int', []],
  HttpWithRsDispatchCallbacks: ['int', []]
});
const pins = global.__httpRsFixturePins = [library];
let serial = 0, epoch = 0;
const replies = new Map(), terminal = new Map(), progress = [], compass = [];
const seen = [], callbacks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = (promise, text, ms = 15000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(text)), ms);
  Promise.resolve(promise).then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
});
function init() {
  const owner = ++epoch;
  const callback = ffi.Callback('void', ['string'], text => {
    const m = JSON.parse(text);
    seen.push({owner, m});
    if (m.sno !== undefined && replies.has(m.sno)) {
      const waiter = replies.get(m.sno); replies.delete(m.sno); waiter(m);
    } else if ([2, 4, 6, 7].includes(m.notify)) {
      const waiter = terminal.get(m.param.handle);
      assert(waiter, `terminal ${m.notify} overtook its Promise-installed handle ${m.param.handle}`);
      terminal.delete(m.param.handle); waiter(m);
    } else if ([1, 3, 5].includes(m.notify)) {
      assert(terminal.has(m.param.handle), `progress overtook handle ${m.param.handle}`);
      progress.push(m);
    } else if (m.notify === 8) compass.push(m);
  });
  pins.push(callback); callbacks.push(callback);
  assert.strictEqual(library.http_json_init(callback), 0);
  assert.strictEqual(library.http_json_init(callback), 0);
}
function send(cmd, param, extra = {}) {
  const sno = ++serial;
  const description = `loopback-${cmd}-${sno}`;
  const packet = {cmd, sno, description, ...extra};
  if (param !== undefined) packet.param = param;
  const promise = new Promise(resolve => replies.set(sno, resolve));
  assert.strictEqual(library.http_json_call_msg(JSON.stringify(packet)), 0);
  return deadline(promise, `missing rsp ${cmd}/${sno}`).then(r => {
    assert.strictEqual(r.rsp, cmd); assert.strictEqual(r.sno, sno);
    assert.strictEqual(r.description, description);
    assert(!('cmd' in r)); assert(!('notify' in r));
    assert(Number.isInteger(r.result)); assert('param' in r);
    return r;
  });
}
async function start(cmd, param) {
  const ack = await send(cmd, param);
  assert.strictEqual(ack.result, 0, JSON.stringify(ack));
  assert(Number.isSafeInteger(ack.param.handle) && ack.param.handle > 0);
  const result = deadline(new Promise(resolve => terminal.set(ack.param.handle, resolve)), `missing transfer ${ack.param.handle}`);
  return {ack, result};
}
function endpoint(host, route = '/echo', port = fixture.port) { return `https://${host}:${port}${route}`; }
const tls = {caCertPath: fixture.ca, tlsMode: 1};
const simple = (url, type = 3, body = '') => ({url, type, body, header: {'X-Test': 'native'}, tlsParam: tls, proxyInfo: {}});
const download = (url, file) => ({...simple(url), file_path: file, tcp_timeout: 2, req_timeout: 10});
const upload = (url, file, type = 0) => ({url, file_path: file, req_type: type,
  tls_param: tls, header: [{name: 'X-Test', value: 'stream'}],
  file_form_key: 'payload', mult_part: {key: 'metadata', content: '{"real":true}'},
  form_options: [{key: 'tag', content: 'first'}, {key: 'tag', content: 'second'}],
  config_param: {tcp_timeout: 2, req_timeout: 10, proxy_param: {ip: '', port: 0}}});
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function transferred(m, expectedNotify) {
  assert.strictEqual(m.notify, expectedNotify);
  assert(!('sno' in m)); assert(!('result' in m)); assert(!('rsp' in m));
  assert.strictEqual(m.param.ret, 0, JSON.stringify(m));
  assert.strictEqual(m.param.rsp_body.rsp_code, 200, JSON.stringify(m));
}
async function main() {
  assert.strictEqual(library.http_json_set_log_param(2, 1950, path.join(fixture.root, 'logs')), 0);
  assert.notStrictEqual(library.http_json_call_msg('{'), 0);
  init();
  const timer = setInterval(() => library.HttpWithRsDispatchCallbacks(), 2);
  try {
    assert.notStrictEqual(library.http_json_call_msg('{bad'), 0);
    assert.strictEqual((await send(999, {})).result, 3);
    const before = await send(113, undefined, {query: false});
    assert.notStrictEqual(before.result, 0); assert.strictEqual(before.param, null);
    assert.strictEqual(compass.length, 0, 'must not synthesize configuration');
    assert.strictEqual((await send(101, {})).result, 0);

    // All original enum values, real body bytes, duplicate response headers,
    // and non-200 transport success. No response-body JSON parsing in native C.
    for (const [type, name] of [[0, 'POST'], [1, 'DELETE'], [2, 'PUT'], [3, 'GET'], [4, 'HEAD']]) {
      const body = type === 3 || type === 4 ? '' : 'body-\u2603-\u0000-end';
      const r = await send(103, simple(endpoint('service.http-test.invalid'), type, body));
      assert.strictEqual(r.result, 0, JSON.stringify(r)); assert.strictEqual(r.param.resp_code, 200);
      const headers = r.param.out_header;
      assert.strictEqual(r.param.out_header_num, headers.length);
      assert.deepStrictEqual(headers.filter(h => h.header_name.toLowerCase() === 'set-cookie').map(h => h.header_value), ['one=1; Path=/', 'two=2; HttpOnly']);
      if (type !== 4) {
        const echoed = JSON.parse(r.param.recv_body);
        assert.strictEqual(echoed.method, name);
        assert.strictEqual(echoed.body, Buffer.from(body).toString('base64'));
        assert.strictEqual(echoed.traceid, r.param.traceId);
      }
      assert(/^[0-9a-f-]{36}$/.test(r.param.requestId));
    }
    const callerTrace = await send(103, {...simple(endpoint('service.http-test.invalid')),
      header: {TrAcEiD: 'caller-owned-trace'}});
    assert.strictEqual(callerTrace.param.traceId, 'caller-owned-trace');
    assert.strictEqual(JSON.parse(callerTrace.param.recv_body).traceid, 'caller-owned-trace');
    const status = await send(103, simple(endpoint('service.http-test.invalid', '/status/403')));
    assert.strictEqual(status.result, 0); assert.strictEqual(status.param.resp_code, 403);
    assert.strictEqual(status.param.recv_body, '{"denied":true}');
    const redirect = await send(103, simple(endpoint('service.http-test.invalid', '/status/302')));
    assert.strictEqual(redirect.result, 0); assert.strictEqual(redirect.param.resp_code, 302);

    const nested = {req_param: {url: endpoint('service.http-test.invalid'), type: 0, body: 'nested',
      header: {'X-Test': 'nested'}, auth_info: {mode: 0, username: '', password: ''}},
      config_param: {tcp_timeout: 2, req_timeout: 5, tls_param: {ca_cert_path: fixture.ca, tls_mode: 1, vertfy_server_mode: 0}}};
    const direct = await send(109, nested);
    assert.strictEqual(direct.result, 0); assert.strictEqual(JSON.parse(direct.param.recv_body).method, 'POST');
    assert(!('traceId' in direct.param), '109 has no traceId in the matched adapter');
    const asynchronous = await start(110, nested);
    transferred(await asynchronous.result, 7);
    const unsupportedAuth = await send(109, {...nested, req_param: {...nested.req_param, auth_info: {mode: 91}}});
    assert.notStrictEqual(unsupportedAuth.result, 0);

    // Custom -> system CA fallback uses the private namespace's real CA file.
    const fallback = await send(103, {...simple(endpoint('service.http-test.invalid')),
      tlsParam: {caCertPath: fixture.wrongCA, tlsMode: 1}});
    assert.strictEqual(fallback.result, 0, JSON.stringify(fallback));
    assert(fallback.param.usedInstallCaPath, 'report the actual system CA fallback');
    const directFallback = await send(109, {...nested, config_param: {...nested.config_param,
      tls_param: {ca_cert_path: fixture.wrongCA, tls_mode: 1}}});
    assert.strictEqual(directFallback.result, 0);
    assert(directFallback.param.usedInstallCaPath);
    const mismatch = await send(103, simple(endpoint('mismatch.http-test.invalid')));
    assert.strictEqual(mismatch.result, 160, JSON.stringify(mismatch));
    assert(mismatch.param.usedInstallCaPath, 'failed system-CA attempts retain accurate fallback metadata');
    const untrusted = await send(103, simple(endpoint('untrusted.http-test.invalid', '/echo', fixture.untrustedPort)));
    assert.strictEqual(untrusted.result, 160, JSON.stringify(untrusted));
    const legacyDisabled = await send(103, {...simple(endpoint('mismatch.http-test.invalid')),
      tlsParam: {caCertPath: fixture.ca, tlsMode: 0}});
    assert.strictEqual(legacyDisabled.result, 160, 'legacy flags must not disable hostname checks');

    // Authenticated HTTP CONNECT proxy: native libcurl makes the real tunnel.
    const proxy = {proxyAddress: '127.0.0.1', proxyPort: String(fixture.proxyPort),
      proxyAccount: 'loopback-user', proxyPassword: 'loopback-secret'};
    const proxied = await send(103, {...simple(endpoint('service.http-test.invalid')), proxyInfo: proxy});
    assert.strictEqual(proxied.result, 0, JSON.stringify(proxied));
    const proxyDenied = await send(103, {...simple(endpoint('service.http-test.invalid')),
      proxyInfo: {...proxy, proxyPassword: 'wrong-loopback-secret'}});
    assert.notStrictEqual(proxyDenied.result, 0, JSON.stringify(proxyDenied));

    // Real RS .com -> .cn fallback; flattened standby data and bus-owned notify8.
    const rs = {rs_url: `rs.com.http-test.invalid:${fixture.port}`, ca_cert_path: fixture.ca,
      verify_mode: 1, proxy_addr: '', proxy_port: 0, userAccount: 'loopback-account', userTenantId: 'loopback-tenant'};
    assert.strictEqual((await send(102, rs)).result, 0);
    const config = await send(113, undefined, {query: true});
    assert.strictEqual(config.result, 0, JSON.stringify(config));
    assert.strictEqual(config.param.enable, true);
    assert.strictEqual(config.param.standbyDomainConfig.service, 'service.http-test.invalid');
    assert.strictEqual(compass.length, 1);
    assert.strictEqual(compass[0].description, 'HTTP_RS_NOTIFY_UPATDE_COMPASS_CONFIG');
    assert.deepStrictEqual(compass[0].param, config.param);
    assert.deepStrictEqual((await send(113, undefined, {query: false})).param, config.param);
    const standby = await send(103, simple(endpoint('service.com.http-test.invalid', '/standby')));
    assert.strictEqual(standby.result, 0); assert.strictEqual(standby.param.resp_code, 200);
    assert.strictEqual(JSON.parse(standby.param.recv_body).host, `service.http-test.invalid:${fixture.port}`);
    assert.strictEqual(compass.length, 1, 'cache reads must not duplicate notify8');
    await send(103, simple(endpoint('service.http-test.invalid', '/advance-compass')));
    const updated = await send(113, undefined, {query: true});
    assert.strictEqual(updated.result, 0);
    assert.strictEqual(updated.param.lastUpdateTime, config.param.lastUpdateTime + 1);
    assert.strictEqual(compass.length, 2);
    for (const [mode, error] of [['http-error', 122], ['malformed', 108]]) {
      await send(103, simple(endpoint('service.http-test.invalid', '/compass-mode/' + mode)));
      const failedQuery = await send(113, undefined, {query: true});
      assert.strictEqual(failedQuery.result, error, JSON.stringify(failedQuery));
      assert.deepStrictEqual((await send(113, undefined, {query: false})).param, updated.param);
      assert.strictEqual(compass.length, 2, 'a failed forced refresh must not notify or replace the real cache');
    }
    await send(103, simple(endpoint('service.http-test.invalid', '/compass-mode/normal')));

    const source = path.join(fixture.root, 'upload.bin');
    const payload = fs.readFileSync(source);
    for (const cmd of [107, 111, 114]) {
      const request = upload(endpoint('pinned.http-test.invalid', '/upload'), source);
      if (cmd === 114) request.ip_address = '127.0.0.1';
      const operation = await start(cmd, request);
      const done = await operation.result; transferred(done, 6);
      const received = JSON.parse(done.param.rsp_body.rsp_msg);
      assert.strictEqual(received.fileSHA256, digest(payload));
      assert.strictEqual(received.fileName, 'upload.bin');
      assert.deepStrictEqual(received.fields.tag, ['first', 'second']);
      assert.deepStrictEqual(received.fields.metadata, ['{"real":true}']);
    }
    const raw = await start(111, upload(endpoint('service.http-test.invalid', '/upload'), source, 2));
    const rawDone = await raw.result; transferred(rawDone, 6);
    assert.strictEqual(JSON.parse(rawDone.param.rsp_body.rsp_msg).fileSHA256, digest(payload));

    for (const cmd of [104, 112, 115]) {
      const file = path.join(fixture.root, `download-${cmd}.bin`);
      const request = download(endpoint('pinned.http-test.invalid', '/file'), file);
      if (cmd === 115) request.ip_address = '127.0.0.1';
      const operation = await start(cmd, request);
      const done = await operation.result; transferred(done, 2);
      assert.strictEqual(digest(fs.readFileSync(file)), fixture.payloadSHA256);
      if (cmd !== 112) {
        const trace = done.param.rsp_body.header.find(h => h.name.toLowerCase() === 'x-seen-trace');
        assert.strictEqual(trace.value, operation.ack.param.traceId);
      }
    }
    const resumePath = path.join(fixture.root, 'resume.bin');
    const full = fs.readFileSync(path.join(fixture.root, 'download-104.bin'));
    fs.writeFileSync(resumePath, full.subarray(0, 123457));
    const upgradeParams = {version_download_url: endpoint('service.http-test.invalid', '/file'),
      file_path: resumePath, keep_download: true,
      config_param: {tcp_timeout: 2, req_timeout: 10, low_speed_limit: 5, low_speed_time: 2,
        proxy_param: {addr: '', port: 0, username: '', pwd: ''}}};
    const resumed = await start(105, upgradeParams);
    const resumeDone = await resumed.result;
    assert.strictEqual(resumeDone.notify, 4); assert.strictEqual(resumeDone.param.ret, 0);
    assert.strictEqual(resumeDone.param.rsp_body.rsp_code, 206);
    assert.strictEqual(digest(fs.readFileSync(resumePath)), fixture.payloadSHA256);
    // A server ignoring Range starts over safely, not prefix+full concatenation.
    fs.writeFileSync(resumePath, full.subarray(0, 555));
    const ignored = await start(105, {...upgradeParams, version_download_url: endpoint('service.http-test.invalid', '/range-ignored')});
    transferred(await ignored.result, 4);
    assert.strictEqual(digest(fs.readFileSync(resumePath)), fixture.payloadSHA256);
    // A TLS failure preserves existing partial bytes, including through CA retry.
    const preserved = Buffer.from('existing-partial-bytes'); fs.writeFileSync(resumePath, preserved);
    const failed = await start(105, {...upgradeParams, version_download_url: endpoint('mismatch.http-test.invalid', '/file')});
    assert.strictEqual((await failed.result).param.ret, 160);
    const failedProxy = await start(105, {...upgradeParams,
      version_download_url: endpoint('mismatch.http-test.invalid', '/file'),
      config_param: {...upgradeParams.config_param, proxy_param: {addr: '127.0.0.1',
        port: fixture.proxyPort, username: 'loopback-user', pwd: 'loopback-secret'}}});
    assert.strictEqual((await failedProxy.result).param.ret, 160);
    assert.deepStrictEqual(fs.readFileSync(resumePath), preserved,
      'proxy CONNECT 200 must not truncate before origin TLS succeeds');
    assert.deepStrictEqual(fs.readFileSync(resumePath), preserved);
    const badRange = await start(105, {...upgradeParams, version_download_url: endpoint('service.http-test.invalid', '/bad-range')});
    assert.notStrictEqual((await badRange.result).param.ret, 0);
    assert.deepStrictEqual(fs.readFileSync(resumePath), preserved);

    const slow = await start(105, {...upgradeParams, keep_download: false,
      version_download_url: endpoint('service.http-test.invalid', '/slow')});
    assert.strictEqual((await send(105, upgradeParams)).result, 37);
    assert.strictEqual((await send(106, {})).result, 0);
    assert.strictEqual((await slow.result).param.ret, 142);
    assert.strictEqual((await send(106, {})).result, 0);
    const cancelled = await start(104, download(endpoint('service.http-test.invalid', '/slow'), path.join(fixture.root, 'cancel.bin')));
    assert.strictEqual((await send(108, {handle: cancelled.ack.param.handle})).result, 0);
    assert.strictEqual((await cancelled.result).param.ret, 142);
    assert.strictEqual((await send(108, {handle: cancelled.ack.param.handle})).result, 0);
    assert(progress.some(n => [1, 3, 5].includes(n.notify)), 'real byte progress is required');

    // A different native thread may load the library, but cannot pump callbacks.
    const threadResult = await deadline(new Promise((resolve, reject) => {
      const w = new Worker(`const {parentPort,workerData}=require('worker_threads');
        const ffi=require(workerData.ffi); const lib=ffi.Library(workerData.library,{
          HttpWithRsDispatchCallbacks:['int',[]],http_json_shutdown:['int',[]]});
        parentPort.postMessage([lib.HttpWithRsDispatchCallbacks(),lib.http_json_shutdown()]);`,
        {eval: true, workerData: fixture});
      w.once('message', resolve); w.once('error', reject);
      w.once('exit', code => { if (code) reject(new Error('worker exited '+code)); });
    }), 'wrong-thread pump stalled');
    assert.strictEqual(threadResult[0], -1); assert.notStrictEqual(threadResult[1], 0);

    // Shutdown cancels an old epoch, never joins through FFI or crosses init.
    const oldSno = ++serial;
    assert.strictEqual(library.http_json_call_msg(JSON.stringify({cmd: 103, sno: oldSno,
      description: 'old-epoch', param: simple(endpoint('service.http-test.invalid', '/delay'))})), 0);
    await sleep(50);
    const oldOwner = epoch, beforeShutdown = seen.filter(x => x.owner === oldOwner).length;
    const begin = process.hrtime.bigint();
    assert.strictEqual(library.http_json_shutdown(), 0);
    assert(Number(process.hrtime.bigint() - begin) / 1e6 < 100, 'shutdown blocked on worker');
    init();
    const fresh = await send(103, simple(endpoint('service.http-test.invalid')));
    assert.strictEqual(fresh.result, 0);
    await sleep(600);
    assert.strictEqual(seen.filter(x => x.owner === oldOwner).length, beforeShutdown);
    assert(!seen.some(x => x.m.sno === oldSno), 'old completion was published into new init');
    assert.strictEqual(pins.length, callbacks.length + 1);
    assert.strictEqual(terminal.size, 0);
    console.log(JSON.stringify({passed: true, replies: serial, notifications: seen.filter(x => x.m.notify).length,
      callbackEpochs: epoch, progress: progress.length, compass: compass.length}));
  } finally {
    clearInterval(timer); library.http_json_shutdown();
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
'''


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def enable_loopback():
    import fcntl
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        request = struct.pack("16sH14x", b"lo", 0)
        flags = struct.unpack("16sH14x", fcntl.ioctl(sock, 0x8913, request))[1]
        fcntl.ioctl(sock, 0x8914, struct.pack("16sH14x", b"lo", flags | 1))
    interfaces = [name for _, name in socket.if_nameindex()]
    if interfaces != ["lo"]:
        raise RuntimeError(f"refusing non-isolated network namespace: {interfaces}")


def certificate(root, prefix, issuer=None):
    key, cert, request = [root / f"{prefix}.{suffix}" for suffix in ("key", "pem", "csr")]
    if issuer is None:
        run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
            "-subj", f"/CN=Loopback HttpBridge {prefix}", "-keyout", str(key), "-out", str(cert),
            "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    else:
        ext = root / f"{prefix}.cnf"
        ext.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
                       "extendedKeyUsage=serverAuth\nsubjectAltName=" + ",".join("DNS:" + name for name in NAMES) + "\n")
        run("openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256",
            "-subj", "/CN=Loopback HttpBridge Origin", "-keyout", str(key), "-out", str(request))
        run("openssl", "x509", "-req", "-in", str(request), "-CA", str(issuer[1]), "-CAkey", str(issuer[0]),
            "-CAcreateserial", "-days", "2", "-sha256", "-extfile", str(ext), "-out", str(cert))
    os.chmod(key, 0o600)
    return key, cert


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.stamp = 100
        self.requests = []
        self.proxy_auth = []
        self.sni = []
        self.rs_bodies = []
        self.compass_mode = "normal"

    def record(self, name, value):
        with self.lock:
            getattr(self, name).append(value)


class Origin(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def respond(self, status, body, headers=(), slow=False):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", "application/json")
        self.send_header("Set-Cookie", "one=1; Path=/")
        self.send_header("Set-Cookie", "two=2; HttpOnly")
        self.send_header("X-Seen-Trace", self.headers.get("traceid", ""))
        self.send_header("Connection", "close")
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            for at in range(0, len(body), 16384):
                self.wfile.write(body[at:at + 16384])
                self.wfile.flush()
                if slow:
                    time.sleep(0.02)
        self.close_connection = True

    def handle_request(self):
        state = self.server.state
        host = self.headers.get("Host", "")
        count = int(self.headers.get("Content-Length", "0"))
        if count < 0 or count > 128 * 1024 * 1024:
            raise ValueError("fixture body length is invalid")
        body = self.rfile.read(count)
        state.record("requests", (self.command, host, self.path, len(body)))
        assert len(self.headers.get_all("traceid", [])) == 1, "duplicate/missing traceid"
        if self.path == "/compass/api/v1/hosts":
            data = json.loads(body)
            assert self.command == "POST"
            assert data == {"appId": "6489640385", "userTenantId": "loopback-tenant", "userAccount": "loopback-account"}, data
            assert "Authorization" not in self.headers
            state.record("rs_bodies", data)
            with state.lock:
                mode = state.compass_mode
            if mode == "http-error":
                self.respond(503, b'{"unavailable":true}')
                return
            if mode == "malformed":
                self.respond(200, b'not a Compass JSON object')
                return
            if host.startswith("rs.com."):
                self.respond(503, b'{"retry":"cn"}')
                return
            assert host.startswith("rs.cn.")
            with state.lock:
                stamp = state.stamp
            response = {"enable": 1, "lastUpdateTime": stamp, "ttl": 3600,
                        "httpDns": [{"domain": "service.com.http-test.invalid", "ipV4s": ["127.0.0.2"], "ttl": 3600}],
                        "standbyDomainConfig": {"nested": {"service": "service.http-test.invalid"}}}
            self.respond(200, json.dumps(response).encode())
            return
        if self.path == "/advance-compass":
            with state.lock:
                state.stamp += 1
        if self.path.startswith("/compass-mode/"):
            with state.lock:
                state.compass_mode = self.path.rsplit("/", 1)[1]
        if self.path == "/standby" and self.server.server_address[0] == "127.0.0.2":
            self.respond(503, b'{"retry":"standby"}')
            return
        if self.path == "/status/403":
            self.respond(403, b'{"denied":true}')
            return
        if self.path == "/status/302":
            self.respond(302, b'{"redirect":true}', [("Location", "/must-not-follow")])
            return
        if self.path == "/must-not-follow":
            raise AssertionError("native bus followed a redirect")
        if self.path == "/delay":
            time.sleep(0.4)
        if self.path in ("/file", "/slow", "/range-ignored", "/bad-range"):
            result, status, headers = PAYLOAD, 200, []
            offset = 0
            if self.headers.get("Range") and self.path != "/range-ignored":
                text = self.headers["Range"]
                assert text.startswith("bytes=") and text.endswith("-"), text
                offset = int(text[6:-1])
                assert 0 <= offset < len(PAYLOAD)
                status, result = 206, PAYLOAD[offset:]
                headers = [("Content-Range", f"bytes {offset + (1 if self.path == '/bad-range' else 0)}-{len(PAYLOAD)-1}/{len(PAYLOAD)}")]
            self.respond(status, result, headers, self.path == "/slow")
            return
        if self.path == "/upload":
            if self.command == "PUT":
                response = {"fileSHA256": hashlib.sha256(body).hexdigest()}
            else:
                from email.parser import BytesParser
                from email.policy import default
                parsed = BytesParser(policy=default).parsebytes(
                    b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
                response = {"fields": {}}
                for part in parsed.iter_parts():
                    name = part.get_param("name", header="content-disposition")
                    filename = part.get_filename()
                    content = part.get_payload(decode=True)
                    if filename is not None:
                        assert name == "payload"
                        response["fileSHA256"] = hashlib.sha256(content).hexdigest()
                        response["fileName"] = filename
                    else:
                        response["fields"].setdefault(name, []).append(content.decode())
            self.respond(200, json.dumps(response).encode())
            return
        self.respond(200, json.dumps({"method": self.command, "host": host,
                                     "body": base64.b64encode(body).decode(),
                                     "traceid": self.headers.get("traceid", "")}).encode())

    def dispatch(self):
        try:
            self.handle_request()
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            # Cancellation and failed TLS handshakes are asserted in the client.
            self.close_connection = True

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = dispatch


class QuietHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Proxy(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(10)
        line = self.rfile.readline(16385)
        if not line:
            return
        method, authority, _ = line.decode("ascii").strip().split(" ", 2)
        assert method == "CONNECT"
        host, port = authority.rsplit(":", 1)
        assert host in NAMES + ["mismatch.http-test.invalid"] and int(port) in self.server.ports, authority
        headers = {}
        while True:
            line = self.rfile.readline(16385)
            if line in (b"\r\n", b"\n", b""):
                break
            name, value = line.decode("ascii").split(":", 1)
            headers[name.lower()] = value.strip()
        auth = headers.get("proxy-authorization", "")
        self.server.state.record("proxy_auth", auth)
        expected = "Basic " + base64.b64encode(b"loopback-user:loopback-secret").decode()
        if auth != expected:
            self.wfile.write(b'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="loopback"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            self.wfile.flush()
            return
        address = "127.0.0.2" if host.startswith("service.com.") else "127.0.0.1"
        with socket.create_connection((address, int(port)), timeout=5) as upstream:
            self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            self.wfile.flush()
            peers = [self.connection, upstream]
            while True:
                ready, _, _ = select.select(peers, [], [], 10)
                if not ready:
                    return
                for current in ready:
                    data = current.recv(65536)
                    if not data:
                        return
                    (upstream if current is self.connection else self.connection).sendall(data)


class QuietProxy(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, address):
        error = sys.exc_info()[1]
        if not isinstance(error, (BrokenPipeError, ConnectionResetError, TimeoutError)):
            super().handle_error(request, address)


@contextlib.contextmanager
def serve(server):
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def origin(address, port, key, cert, state):
    server = QuietHTTPServer((address, port), Origin)
    server.state = state
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.load_cert_chain(cert, key)
    tls.set_servername_callback(lambda connection, name, context: state.record("sni", name))
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--library", required=True, type=Path)
    parser.add_argument("--ffi", required=True, type=Path)
    parser.add_argument("--electron", type=Path, required=True,
                        help="explicit rebuilt Electron 22.3.26 ia32 executable paired with --ffi")
    parser.add_argument("--system-ca-path", type=Path, default=Path("/etc/ssl/certs/ca-certificates.crt"))
    parser.add_argument("--inside-private-namespace", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    for name in ("library", "ffi", "electron"):
        value = getattr(args, name).resolve(strict=True)
        setattr(args, name, value)
    if not args.inside_private_namespace:
        if not shutil.which("unshare"):
            raise RuntimeError("unshare is required; refusing to run without network isolation")
        command = ["unshare", "--user", "--map-root-user", "--mount", "--net", "--fork",
                   sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], "--inside-private-namespace"]
        os.execvp(command[0], command)
    enable_loopback()
    run("mount", "--make-rprivate", "/")
    state = State()
    with tempfile.TemporaryDirectory(prefix="http-rs-loopback-") as temp, contextlib.ExitStack() as stack:
        root = Path(temp)
        ca = certificate(root, "ca")
        wrong = certificate(root, "wrong-ca")
        trusted = certificate(root, "origin", ca)
        untrusted = certificate(root, "untrusted", wrong)
        hosts = root / "hosts"
        hosts.write_text("127.0.0.1 " + " ".join(n for n in NAMES if not n.startswith("service.com.")) +
                         " mismatch.http-test.invalid\n127.0.0.2 service.com.http-test.invalid\n")
        run("mount", "--bind", str(hosts), "/etc/hosts")
        if not args.system_ca_path.exists():
            raise RuntimeError(f"default libcurl CA file does not exist: {args.system_ca_path}")
        run("mount", "--bind", str(ca[1]), str(args.system_ca_path))
        first = stack.enter_context(serve(origin("127.0.0.1", 0, *trusted, state)))
        port = first.server_port
        stack.enter_context(serve(origin("127.0.0.2", port, *trusted, state)))
        untrusted_server = stack.enter_context(serve(origin("127.0.0.1", 0, *untrusted, state)))
        proxy = QuietProxy(("127.0.0.1", 0), Proxy)
        proxy.state = state
        proxy.ports = {port, untrusted_server.server_port}
        stack.enter_context(serve(proxy))
        (root / "upload.bin").write_bytes(bytes(range(256)) * 32768)
        fixture = {"root": temp, "library": str(args.library), "ffi": str(args.ffi),
                   "ca": str(ca[1]), "wrongCA": str(wrong[1]), "port": port,
                   "proxyPort": proxy.server_address[1], "untrustedPort": untrusted_server.server_port,
                   "payloadSHA256": hashlib.sha256(PAYLOAD).hexdigest()}
        (root / "fixture.json").write_text(json.dumps(fixture))
        (root / "driver.js").write_text(NODE_DRIVER)
        environment = dict(os.environ)
        for key in list(environment):
            if key.lower() in ("http_proxy", "https_proxy", "all_proxy", "no_proxy", "ssl_cert_file", "ssl_cert_dir"):
                environment.pop(key)
        environment["ELECTRON_RUN_AS_NODE"] = "1"
        result = subprocess.run([str(args.electron), str(root / "driver.js"), str(root / "fixture.json")],
                                env=environment, text=True, capture_output=True, timeout=150)
        print(result.stdout, end="")
        if result.stderr:
            print(result.stderr, file=sys.stderr, end="")
        if result.returncode:
            raise RuntimeError(f"native Electron/ffi harness exited {result.returncode}")
        with state.lock:
            assert any(r[1].startswith("rs.com.") for r in state.requests), state.requests
            assert any(r[1].startswith("rs.cn.") for r in state.requests), state.requests
            assert any(r[1].startswith("service.com.") and r[2] == "/standby" for r in state.requests)
            assert any(r[1].startswith("service.http-") and r[2] == "/standby" for r in state.requests)
            assert "pinned.http-test.invalid" in state.sni, state.sni
            assert state.rs_bodies
            assert any(a == "Basic " + base64.b64encode(b"loopback-user:loopback-secret").decode() for a in state.proxy_auth)
            assert any(a == "Basic " + base64.b64encode(b"loopback-user:wrong-loopback-secret").decode() for a in state.proxy_auth)
        log = (root / "logs" / "http_with_rs.log").read_text()
        assert log and "cmd=" in log
        for secret in ("loopback-secret", "wrong-loopback-secret", "loopback-account", "loopback-tenant"):
            assert secret not in log, f"native logging leaked {secret}"
        print("Loopback HTTPS, RS, standby, CONNECT proxy, streams and epoch assertions passed.")


if __name__ == "__main__":
    main()
