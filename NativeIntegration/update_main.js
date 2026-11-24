'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./update_config');
const crypto = require('crypto');
const { TextDecoder } = require('util');
const { verifyManifest, assetUrl, revision } = require('./update_manifest');
const { download } = require('./update_download');
const { installUpdate } = require('./update_install');
const { failure } = require('./platform_settings');


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


function createNativeUpdater({ electron, appRoot }) {
  let verified = null;
  async function check({ session, signal }) {
    verified = null;
    const current = readBuild(appRoot);
    const deadline = Date.now() + config.timeoutMs;
    const fetchMetadata = (url, limit) => {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) throw failure('ETIMEDOUT', 'The native update check timed out.');
      return download({ net: electron.net, session, signal, url, limit, timeoutMs });
    };
    // Ordinary checks use static release assets, not the rate-limited REST API.
    // The untrusted discovery body supplies only a constrained native tag;
    // canonical tag bytes and their publisher signature remain mandatory.
    const discovery = await fetchMetadata(config.channelManifest, config.maxManifestBytes);
    let version;
    try { version = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(discovery)).version; }
    catch (_) { throw failure('EPROTO', 'The native update channel returned invalid JSON.'); }
    if (revision(version) === null) throw failure('EPROTO', 'The native update channel returned an invalid native tag.');
    const bytes = await fetchMetadata(assetUrl(version, 'native-update.json'), config.maxManifestBytes);
    if (!bytes.equals(discovery)) throw failure('EPROTO', 'The native update channel and canonical release manifest differ.');
    const signature = await fetchMetadata(assetUrl(version, 'native-update.sig'), 512);
    const key = fs.readFileSync(path.join(appRoot, 'native/update_public_key.pem'));
    const checkerSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(appRoot, 'native/lib/sqlite_plugin.dll.so'))).digest('hex');
    const checked = verifyManifest(bytes, signature, key, { version, current, checkerSha256, allowCurrent: true });
    const latest = { version, url: releaseUrl(config.releasePage + version, version),
      name: checked.manifest.name || 'Native Linux ' + version, notes: checked.manifest.notes || '' };
    const status = revision(version) > revision(current.version) ? 'available' : 'current';
    if (status === 'available') verified = { bytes, signature, version, current };
    return { current, latest, status, signed: true };
  }

  async function present({ check: performCheck, window, assertActive, locale, session, registerCancel }) {
    const zh = locale === '2052' || /^zh(?:-|$)/i.test(locale || '');
    const title = zh ? 'WeLink 原生 Linux 更新' : 'WeLink native Linux updates';
    let result;
    try {
      result = await performCheck();
      assertActive();
      const latest = result.latest;
      const current = (zh ? '当前原生版本：' : 'Installed native version: ') + result.current.version + '\n' + result.current.build;
      const policy = zh ? '仅安装发布者 Ed25519 签名且与当前镜像完全匹配的原生增量包。下载和验证期间保留当前应用；随后正常退出，备份当前配置并重启。失败时安全恢复旧版本。不运行 Windows 安装程序。' :
        'Only publisher-signed native updates matching this exact image can be installed. Download and verification keep this app running; then it exits normally, preserves this profile and desktop defaults, and restarts. Failed startup restores the previous version. Windows installers are never run.';
      const notes = latest && (latest.notes || (zh ? '此版本没有发布说明。' : 'This release has no release notes.'));
      const preview = notes && notes.slice(0, 500).split('\n').slice(0, 8).join('\n');
      const detail = current + '\n\n' + policy + (latest ? '\n\n' + (zh ? '已发布原生版本：' : 'Published native version: ') + latest.version + '\n' + latest.name + '\n\n' +
        preview + (preview.length < notes.length ? (zh ? '\n（完整说明请查看发布页面。）' : '\n(See the release page for the complete notes.)') : '') : '');
      const message = result.status === 'available' ? (zh ? '发现新的原生 Linux 版本' : 'A native Linux update is available') :
        (zh ? '没有比当前版本更新的原生稳定版' : 'No newer native stable release is available');
      const answer = await electron.dialog.showMessageBox(window, { type: 'info', title, message, detail,
        buttons: latest ? [zh ? '关闭' : 'Close', zh ? '打开发布页面' : 'Open release page',
          ...(result.status === 'available' && result.signed ? [zh ? '下载、更新并重启' : 'Download, update and restart'] : [])] : [zh ? '关闭' : 'Close'],
        defaultId: 0, cancelId: 0, noLink: true });
      assertActive();
      if (answer.response === 2 && result.status === 'available' && result.signed) {
        if (!verified || verified.version !== latest.version) throw failure('ESTALE', 'The signed update check changed. Check again before installing.');
        return { ...result, ...await installUpdate({ electron, appRoot, window, session, verified, assertActive, registerCancel }) };
      }
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
        message: zh ? '原生更新未完成' : 'The native update did not complete',
        detail: (current ? current.version + '\n' + current.build + '\n\n' : '') + (error.code || 'EIO') + ': ' + error.message,
        buttons: [zh ? '关闭' : 'Close'], defaultId: 0, cancelId: 0, noLink: true });
      assertActive();
      return { status: 'error', current, error: { code: error.code || 'EIO', message: error.message } };
    }
  }
  return Object.freeze({ check, present });
}

module.exports = { createNativeUpdater };
