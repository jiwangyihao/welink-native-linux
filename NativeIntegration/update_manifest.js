'use strict';

const crypto = require('crypto');
const { TextDecoder } = require('util');
const { failure } = require('./platform_settings');
const config = require('./update_config');
const BUILD = /^hit-native-linux-ia32-(r45\.(?:0|[1-9][0-9]*))$/;
const HASH = /^[a-f0-9]{64}$/;
function revision(version) {
  if (typeof version !== 'string' || !/^r45\.(?:0|[1-9][0-9]*)$/.test(version)) return null;
  const n = Number(version.slice(4));
  return Number.isSafeInteger(n) ? n : null;
}
function invalid(message) { throw failure('EPROTO', message); }
function descriptor(item, asset) {
  if (!item || item.asset !== asset || !Number.isSafeInteger(item.size) || item.size <= 0 ||
      item.size > config.maxInstallerBytes || !HASH.test(item.sha256 || '')) invalid('Invalid signed asset descriptor: ' + asset);
}
function verifyManifest(bytes, signature, publicKey, { version, current, checkerSha256 }) {
  const encoded = signature.toString('ascii').trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) throw failure('ESIGNATURE', 'Invalid Ed25519 signature encoding.');
  const key = crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, bytes, key, Buffer.from(encoded, 'base64')))
    throw failure('ESIGNATURE', 'The native release publisher signature is invalid. Nothing was installed.');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (_) { invalid('The signed update manifest is not UTF-8 JSON.'); }
  if (!manifest || manifest.format !== 1 || revision(version) === null || manifest.version !== version ||
      manifest.build !== 'hit-native-linux-ia32-' + version || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit || '') ||
      revision(version) <= revision(current.version)) invalid('The signed update identity is invalid or not newer than this application.');
  if (!Array.isArray(manifest.installers) || !manifest.installers.length || manifest.installers.length > 100)
    invalid('The signed installer list is invalid.');
  const bases = new Set(), assets = new Set();
  for (const item of manifest.installers) {
    const match = item && typeof item.base === 'string' && BUILD.exec(item.base);
    if (!match || revision(match[1]) === null || revision(match[1]) >= revision(version) || !HASH.test(item.baseCheckerSha256 || ''))
      invalid('Invalid native installer baseline.');
    descriptor(item, 'install-' + version + '-from-' + match[1] + '.py');
    if (bases.has(item.base) || assets.has(item.asset)) invalid('Ambiguous signed installer entries.');
    bases.add(item.base); assets.add(item.asset);
  }
  descriptor(manifest.integration, 'install_desktop.py');
  const installer = manifest.installers.find(item => item.base === current.build && item.baseCheckerSha256 === checkerSha256);
  if (!installer) throw failure('EBASE', 'This signed release has no installer for the exact installed image. Keep this version; no files were changed.');
  return { manifest, installer };
}
function assetUrl(version, asset) {
  if (revision(version) === null || !/^[A-Za-z0-9_.-]+$/.test(asset) || asset === '.' || asset === '..') invalid('Unsafe release asset name.');
  return 'https://github.com/' + config.repository + '/releases/download/' + version + '/' + asset;
}
function redirectUrl(value, initial) {
  let url;
  try { url = new URL(value); } catch (_) { invalid('Invalid release asset redirect.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname) ||
      url.hostname === 'github.com' && value !== initial) invalid('The release asset redirected outside the allowed GitHub HTTPS hosts.');
  return url.href;
}
module.exports = { verifyManifest, revision, assetUrl, redirectUrl };
