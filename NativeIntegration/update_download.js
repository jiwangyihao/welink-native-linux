'use strict';

const fs = require('fs');
const crypto = require('crypto');
const config = require('./update_config');
const { redirectUrl } = require('./update_manifest');
const { failure } = require('./platform_settings');

// No business headers, cookies, credential callbacks or certificate exceptions.
// The file sink is exclusive and bounded; executable bytes never enter renderer IPC.
function download({ net, session, url, signal, filename, size, sha256, limit, progress = () => {} }) {
  return new Promise((resolve, reject) => {
    let request, fd, created = false, settled = false, ended = false, count = 0, redirects = 0;
    const chunks = [], hash = crypto.createHash('sha256');
    const maximum = size || limit;
    const timer = setTimeout(() => finish(failure('ETIMEDOUT', 'The GitHub release asset download timed out.')),
      filename ? config.downloadTimeoutMs : config.timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', cancel);
      if (fd !== undefined) { try { if (!error) fs.fsyncSync(fd); fs.closeSync(fd); } catch (err) { error = error || err; } fd = undefined; }
      if (error) {
        if (request) request.abort();
        if (created) { try { fs.unlinkSync(filename); } catch (_) {} }
        reject(error);
      } else resolve(filename || Buffer.concat(chunks, count));
    }
    function cancel() { finish(failure('ECANCELED', 'Native update canceled. The running image and profile were not changed.')); }
    try {
      if (!Number.isSafeInteger(maximum) || maximum <= 0) throw failure('EINVAL', 'Missing download size limit.');
      if (signal && signal.aborted) { cancel(); return; }
      if (signal) signal.addEventListener('abort', cancel, { once: true });
      if (filename) { fd = fs.openSync(filename, 'wx', 0o600); created = true; }
      request = net.request({ method: 'GET', url, session, redirect: 'manual', credentials: 'omit', useSessionCookies: false });
      request.setHeader('Accept', 'application/octet-stream');
      request.setHeader('User-Agent', 'welink-native-linux-signed-update');
      request.on('redirect', (_code, method, next) => {
        try {
          if (++redirects > config.maxRedirects || method !== 'GET') throw failure('EPROTO', 'Too many release asset redirects.');
          redirectUrl(next, url); request.followRedirect();
        } catch (error) { finish(error); }
      });
      request.on('login', (_info, callback) => { callback(); finish(failure('EPROXYAUTH', 'The update proxy requires authentication.')); });
      request.on('error', error => finish(failure('ENETWORK', error.message)));
      request.on('abort', () => finish(failure('ECANCELED', 'The update download was aborted.')));
      request.on('response', response => {
        if (response.statusCode !== 200) { finish(failure('EHTTP', 'Release asset returned HTTP ' + response.statusCode)); return; }
        const length = Number(response.headers && response.headers['content-length']);
        if (length > maximum || size && length && length !== size) { finish(failure('ESIZE', 'Release asset length differs from the signed manifest.')); return; }
        response.on('data', chunk => {
          if (settled) return;
          try {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            count += bytes.length;
            if (count > maximum) throw failure('ESIZE', 'Release asset exceeds its signed size limit.');
            hash.update(bytes);
            if (fd !== undefined) { let offset = 0; while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset); }
            else chunks.push(bytes);
            progress(count, size || null);
          } catch (error) { finish(error); }
        });
        response.on('aborted', () => finish(failure('ENETWORK', 'Incomplete release asset response.')));
        response.on('error', error => finish(failure('ENETWORK', error.message)));
        response.on('close', () => { if (!ended) finish(failure('ENETWORK', 'Release asset connection closed early.')); });
        response.on('end', () => {
          ended = true;
          if (settled) return;
          if (size && count !== size || sha256 && hash.digest('hex') !== sha256) finish(failure('EHASH', 'Release asset failed signed size/SHA256 verification.'));
          else finish();
        });
      });
      request.end();
    } catch (error) { finish(error); }
  });
}
module.exports = { download };
