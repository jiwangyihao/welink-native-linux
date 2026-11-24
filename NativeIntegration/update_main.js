'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./update_config');
const { failure } = require('./platform_settings');

function revision(tag) {
  if (typeof tag !== 'string' || !/^r45\.(?:0|[1-9][0-9]*)$/.test(tag)) return null;
  const value = Number(tag.slice(4));
  return Number.isSafeInteger(value) ? value : null;
}

function releaseUrl(value, version) {
  // Exact equality also rejects credentials, ports, fragments, queries,
  // percent-encoded paths, alternate hosts and release asset/download URLs.
  if (revision(version) === null || value !== config.releasePage + version) {
    throw failure('EPROTO', 'GitHub returned an invalid native release page URL.');
  }
  return value;
}

function readBuild(appRoot) {
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(path.join(appRoot, 'native', 'build.json'), 'utf8')); }
  catch (_) { throw failure('EBUILD', 'The installed native build identity is missing or unreadable.'); }
  const match = metadata && typeof metadata.build === 'string' && /^hit-native-linux-ia32-(r45\.(?:0|[1-9][0-9]*))$/.exec(metadata.build);
  if (!match || metadata.platform !== 'linux' || metadata.arch !== 'ia32' || revision(match[1]) === null) {
    throw failure('EBUILD', 'The installed native build identity is not a supported r45.N Linux build.');
  }
  return { build: metadata.build, version: match[1] };
}

function header(response, name) {
  const value = response.headers && response.headers[name];
  return Array.isArray(value) ? value.join(', ') : String(value || '');
}

function requestPage(net, session, page, remaining, deadline, signal) {
  return new Promise((resolve, reject) => {
    let request, settled = false, ended = false, size = 0;
    const chunks = [];
    const timer = setTimeout(() => finish(failure('ETIMEDOUT', 'The native update check timed out.')), Math.max(1, deadline - Date.now()));
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', cancel);
      if (error) {
        reject(error);
        if (request) request.abort();
      } else resolve(value);
    }
    function cancel() { finish(failure('ECANCELED', 'The native update check was canceled.')); }
    if (signal && signal.aborted) { cancel(); return; }
    if (signal) signal.addEventListener('abort', cancel, { once: true });
    try {
      // Electron 22 has net.request, not net.fetch. Chromium's network stack
      // retains the owner's session proxy and normal HTTPS certificate checks.
      // Never install certificate exceptions or follow API redirects.
      request = net.request({ method: 'GET', url: config.api + '?per_page=' + config.pageSize + '&page=' + page,
        session, redirect: 'error', credentials: 'omit', useSessionCookies: false });
      request.setHeader('Accept', 'application/vnd.github+json');
      request.setHeader('X-GitHub-Api-Version', '2022-11-28');
      request.setHeader('User-Agent', 'welink-native-linux-update-check');
      request.on('error', error => finish(failure('ENETWORK', 'GitHub HTTPS request failed: ' + error.message)));
      request.on('abort', () => finish(failure('ECANCELED', 'The native update request was aborted.')));
      request.on('redirect', () => finish(failure('EPROTO', 'GitHub redirected the native releases API; the redirect was not followed.')));
      request.on('login', (_info, callback) => {
        callback();
        finish(failure('EPROXYAUTH', 'The configured proxy requires authentication for the native update check.'));
      });
      request.on('response', response => {
        const status = response.statusCode;
        const retry = header(response, 'retry-after');
        if (status === 429 || status === 403 && (header(response, 'x-ratelimit-remaining') === '0' || retry)) {
          finish(failure('ERATELIMIT', 'GitHub has rate-limited update checks.' + (/^[0-9]+$/.test(retry) ? ' Try again after ' + retry + ' seconds.' : ' Try again later.')));
          return;
        }
        if (status !== 200) {
          finish(failure('EHTTP', 'GitHub releases API returned HTTP ' + status + (status === 403 ? ' (access denied or rate-limited).' : '.')));
          return;
        }
        if (!/^application\/(?:json|vnd\.github\+json)(?:\s*;|$)/i.test(header(response, 'content-type'))) {
          finish(failure('EPROTO', 'GitHub returned a non-JSON releases response.'));
          return;
        }
        const length = header(response, 'content-length');
        if (/^[0-9]+$/.test(length) && Number(length) > remaining) {
          finish(failure('E2BIG', 'The native releases response exceeds the size limit.'));
          return;
        }
        response.on('data', chunk => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > remaining) { finish(failure('E2BIG', 'The native releases response exceeds the size limit.')); return; }
          chunks.push(bytes);
        });
        response.on('error', error => finish(failure('ENETWORK', 'GitHub response failed: ' + error.message)));
        response.on('aborted', () => finish(failure('ENETWORK', 'GitHub closed an incomplete releases response.')));
        response.on('close', () => { if (!ended) finish(failure('ENETWORK', 'GitHub closed an incomplete releases response.')); });
        response.on('end', () => {
          ended = true;
          if (settled) return;
          let items;
          try { items = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
          catch (_) { finish(failure('EPROTO', 'GitHub returned malformed releases JSON.')); return; }
          if (!Array.isArray(items) || items.length > config.pageSize) {
            finish(failure('EPROTO', 'GitHub returned an invalid releases list.'));
            return;
          }
          // Pagination is not a retry. Only the fixed repository endpoint is
          // requested; a server-supplied Link URL is never a request target.
          const next = /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"(?:\s*;[^,]*)?(?:,|$)/.test(header(response, 'link'));
          finish(null, { items, next, bytes: size });
        });
      });
      request.end();
    } catch (error) { finish(error); }
  });
}

function candidate(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.tag_name !== 'string') {
    throw failure('EPROTO', 'GitHub returned a malformed release or release tag.');
  }
  if (item.draft === true || item.prerelease === true || revision(item.tag_name) === null) return null;
  if (item.draft !== false || item.prerelease !== false ||
      item.body !== null && typeof item.body !== 'string' || item.name !== null && typeof item.name !== 'string') {
    throw failure('EPROTO', 'GitHub returned malformed native release metadata.');
  }
  return { version: item.tag_name, url: releaseUrl(item.html_url, item.tag_name), name: item.name || item.tag_name, notes: item.body || '' };
}

function createNativeUpdater({ electron, appRoot }) {
  async function check({ session, signal }) {
    const current = readBuild(appRoot);
    const deadline = Date.now() + config.timeoutMs;
    let latest = null, remaining = config.maxBytes;
    for (let page = 1; page <= config.maxPages; page++) {
      if (Date.now() >= deadline) throw failure('ETIMEDOUT', 'The native update check timed out.');
      const response = await requestPage(electron.net, session, page, remaining, deadline, signal);
      remaining -= response.bytes;
      for (const item of response.items) {
        const release = candidate(item);
        if (release && (!latest || revision(release.version) > revision(latest.version))) latest = release;
      }
      if (!response.next) return { current, latest, status: latest ?
        (revision(latest.version) > revision(current.version) ? 'available' : 'current') : 'no-releases' };
    }
    throw failure('E2BIG', 'The native releases list exceeds the page limit; its latest version could not be determined.');
  }

  async function present({ check: performCheck, window, assertActive, locale }) {
    const zh = locale === '2052' || /^zh(?:-|$)/i.test(locale || '');
    const title = zh ? 'WeLink 原生 Linux 更新' : 'WeLink native Linux updates';
    let result;
    try {
      result = await performCheck();
      assertActive();
      const latest = result.latest;
      const current = (zh ? '当前原生版本：' : 'Installed native version: ') + result.current.version + '\n' + result.current.build;
      const policy = zh ? '原生 Linux 版本仅支持手动更新。应用不会下载或运行 Windows 安装程序，也不会自动替换安装。请在发布页面阅读说明、校验 SHA256SUMS 后自行安装原生增量包。' :
        'Native Linux updates are installed manually. This app does not download or run Windows installers or replace your installation. Read the release instructions and verify SHA256SUMS before installing a native-only delta package yourself.';
      const notes = latest && (latest.notes || (zh ? '此版本没有发布说明。' : 'This release has no release notes.'));
      const detail = current + '\n\n' + policy + (latest ? '\n\n' + (zh ? '已发布原生版本：' : 'Published native version: ') + latest.version + '\n' + latest.name + '\n\n' +
        notes.slice(0, 12000) + (notes.length > 12000 ? (zh ? '\n（完整说明请查看发布页面。）' : '\n(See the release page for the complete notes.)') : '') : '');
      const message = result.status === 'available' ? (zh ? '发现新的原生 Linux 版本' : 'A native Linux update is available') :
        result.status === 'current' ? (zh ? '没有比当前版本更新的原生稳定版' : 'No newer native stable release is available') :
        (zh ? '此项目尚无已发布的原生稳定版' : 'No native stable releases have been published');
      const answer = await electron.dialog.showMessageBox(window, { type: 'info', title, message, detail,
        buttons: latest ? [zh ? '关闭' : 'Close', zh ? '打开发布页面' : 'Open release page'] : [zh ? '关闭' : 'Close'],
        defaultId: 0, cancelId: 0, noLink: true });
      assertActive();
      if (latest && answer.response === 1) {
        await electron.shell.openExternal(releaseUrl(latest.url, latest.version), { activate: true });
        assertActive();
        return { ...result, action: 'release-page-opened' };
      }
      return { ...result, action: 'dismissed' };
    } catch (error) {
      assertActive();
      let current = result && result.current;
      if (!current) { try { current = readBuild(appRoot); } catch (_) { /* Report the identity error below, never invent a version. */ } }
      await electron.dialog.showMessageBox(window, { type: 'error', title,
        message: zh ? '原生更新检查或发布页面打开失败' : 'The native update check or release-page action failed',
        detail: (current ? current.version + '\n' + current.build + '\n\n' : '') + (error.code || 'EIO') + ': ' + error.message,
        buttons: [zh ? '关闭' : 'Close'], defaultId: 0, cancelId: 0, noLink: true });
      assertActive();
      return { status: 'error', current, error: { code: error.code || 'EIO', message: error.message } };
    }
  }
  return Object.freeze({ check, present });
}

module.exports = { createNativeUpdater };
