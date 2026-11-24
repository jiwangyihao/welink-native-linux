'use strict';

// Local assets only. No caller-supplied path, URL, account credential or camera
// permission enters this module. The dialog-selected image is the sole user file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const LIMIT = 5 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 8 * 1024 * 1024;
const ASSETS = Object.freeze([
  'selfie_segmentation.js', 'selfie_segmentation.binarypb',
  'selfie_segmentation_landscape.tflite', 'selfie_segmentation.tflite',
  'selfie_segmentation_solution_simd_wasm_bin.js',
  'selfie_segmentation_solution_wasm_bin.js',
  'selfie_segmentation_solution_simd_wasm_bin.wasm',
  'selfie_segmentation_solution_wasm_bin.wasm',
  'selfie_segmentation_solution_simd_wasm_bin.data'
]);
function fault(code, message) { return Object.assign(new Error(message), { code }); }
function imageHeader(bytes) {
  let width, height, mime;
  if (bytes.length < 24 || bytes.length > LIMIT) throw fault('BACKGROUND_IMAGE_SIZE', 'Choose a PNG or JPEG no larger than 5 MiB');
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(8) === 13) {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); mime = 'image/png';
    // Animation is not a single bounded background and can carry hidden frames.
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) throw fault('BACKGROUND_IMAGE_INVALID', 'Truncated PNG');
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL')
        throw fault('BACKGROUND_IMAGE_FORMAT', 'Animated PNG backgrounds are not supported');
      offset += length + 12;
    }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    mime = 'image/jpeg';
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) ++offset;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || length > bytes.length - offset) break;
      if ([192, 193, 194].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!mime || !width || !height) throw fault('BACKGROUND_IMAGE_FORMAT', 'The selected file must decode as a static PNG or JPEG');
  if (width < 64 || height < 64 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS)
    throw fault('BACKGROUND_IMAGE_BOUNDS', 'Background dimensions must be 64–4096 pixels per side and at most 8 megapixels');
  return { mime, width, height };
}

async function loadAssets() {
  const root = path.join(__dirname, 'vendor', 'custom-background');
  const manifest = JSON.parse(await fs.promises.readFile(path.join(root, 'integrity.json'), 'utf8'));
  const assets = {};
  for (const name of ASSETS) {
    const data = await fs.promises.readFile(path.join(root, name));
    if (crypto.createHash('sha256').update(data).digest('hex') !== manifest.sha256[name])
      throw fault('BACKGROUND_ASSET_INTEGRITY', 'The packaged segmentation assets do not match their sealed manifest');
    assets[name] = data.toString('base64');
  }
  return { version: '0.1.1675465747', license: 'Apache-2.0', assets };
}

async function chooseBackground(bridge) {
  if (!bridge.nativeCapabilityEnabled(10)) throw fault('NATIVE_CAPABILITY_DISABLED', 'Custom background import is disabled');
  if (!bridge.ready || !bridge.window || bridge.window.isDestroyed() || bridge.offline?.active)
    throw fault('BACKGROUND_PROVIDER_UNAVAILABLE', 'A connected, policy-authorized web meeting is required');
  const owner = bridge.mediaOwner, window = bridge.window;
  const before = await bridge.callPage('background.state');
  if (!before.ui.importAvailable) throw fault(before.reason || 'BACKGROUND_POLICY_LOCKED', before.prerequisite);
  const choice = await bridge.runUnprotectedDialog(() => bridge.electron.dialog.showOpenDialog(window, {
    title: 'Import a local custom background (this meeting only)', properties: ['openFile'],
    filters: [{ name: 'Static background image (5 MiB maximum)', extensions: ['png', 'jpg', 'jpeg'] }]
  }));
  bridge.requireMediaOwner(owner, window);
  if (choice.canceled || choice.filePaths?.length !== 1) return { cancelled: true, imported: false, activeFrames: false };
  const after = await bridge.callPage('background.state');
  if (!bridge.nativeCapabilityEnabled(10) || after.sessionKey !== before.sessionKey ||
      after.revision !== before.revision || !after.ui.importAvailable)
    throw fault('BACKGROUND_OWNER_CHANGED', 'The meeting or background policy changed while choosing the file');
  let file;
  try {
    file = await fs.promises.open(choice.filePaths[0], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 24 || stat.size > LIMIT)
      throw fault('BACKGROUND_IMAGE_SIZE', 'Select a regular PNG or JPEG file no larger than 5 MiB');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw fault('BACKGROUND_IMAGE_CHANGED', 'The selected image changed while being read');
      offset += bytesRead;
    }
    const final = await file.stat();
    if (final.size !== stat.size || final.mtimeMs !== stat.mtimeMs)
      throw fault('BACKGROUND_IMAGE_CHANGED', 'The selected image changed while being read');
    const info = imageHeader(bytes);
    bridge.requireMediaOwner(owner, window);
    if (!bridge.nativeCapabilityEnabled(10)) throw fault('NATIVE_CAPABILITY_DISABLED', 'Custom background import was revoked');
    return await bridge.callPage('background.import', { sessionKey: before.sessionKey, revision: before.revision,
      importId: crypto.randomBytes(16).toString('hex'), ...info, base64: bytes.toString('base64') });
  } catch (error) {
    // Never return the selected pathname or OS error message to the web page.
    if (error.code?.startsWith('BACKGROUND_') || error.code === 'NATIVE_CAPABILITY_DISABLED') throw error;
    throw fault('BACKGROUND_IMAGE_READ_FAILED', 'The selected image could not be read or decoded');
  } finally { if (file) await file.close(); }
}

module.exports = { ASSETS, LIMIT, MAX_DIMENSION, MAX_PIXELS, imageHeader, loadAssets, chooseBackground };
