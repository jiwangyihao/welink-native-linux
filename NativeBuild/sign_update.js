#!/usr/bin/env node
'use strict';

// Signing is offline. The private key is supplied by the publisher and is never
// copied into the output directory, source repository or application image.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verifyManifest, revision } = require('../NativeIntegration/update_manifest');
const args = process.argv.slice(2), values = new Map(), installers = [];
for (let index = 0; index < args.length; index += 2) {
  const name = args[index], value = args[index + 1];
  if (!value || !['--version', '--source-commit', '--private-key', '--public-key', '--output', '--integration', '--installer'].includes(name))
    throw new Error('Usage: node NativeBuild/sign_update.js --version r45.N --source-commit COMMIT --private-key PRIVATE_PEM --public-key NativeIntegration/update_public_key.pem --output OUT --integration OUT/install_desktop.py --installer OUT/install-r45.N-from-r45.M.py [--installer ...]');
  if (name === '--installer') installers.push(value);
  else { if (values.has(name)) throw new Error('Duplicate option: ' + name); values.set(name, value); }
}
function required(name) { if (!values.has(name)) throw new Error('Missing ' + name); return values.get(name); }
const version = required('--version');
if (revision(version) === null || !installers.length) throw new Error('A valid native release and at least one generated installer are required');
const sourceCommit = required('--source-commit');
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Supply the exact committed source SHA');
const privateKey = crypto.createPrivateKey(fs.readFileSync(required('--private-key')));
const publicKeyBytes = fs.readFileSync(required('--public-key'));
const publicKey = crypto.createPublicKey(publicKeyBytes);
if (privateKey.asymmetricKeyType !== 'ed25519' || !crypto.createPublicKey(privateKey).equals(publicKey))
  throw new Error('The Ed25519 signing key does not match the application public key');
function asset(filename) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.size <= 0) throw new Error('Not a regular nonempty release asset: ' + filename);
  const bytes = fs.readFileSync(filename);
  return { asset: path.basename(filename), size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
const integration = asset(required('--integration'));
if (integration.asset !== 'install_desktop.py') throw new Error('Integration asset must be install_desktop.py');
const entries = installers.map(filename => {
  const descriptor = asset(filename);
  const fd = fs.openSync(filename, 'r');
  const header = Buffer.alloc(4096);
  let length;
  try { length = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  const match = /^# native-update: (.+)$/m.exec(header.subarray(0, length).toString('utf8'));
  if (!match) throw new Error('Installer lacks generated identity header: ' + filename);
  const identity = JSON.parse(match[1]);
  if (identity.build !== 'hit-native-linux-ia32-' + version || identity.desktopInstallerSha256 !== integration.sha256)
    throw new Error('Generated installer targets another image/integration asset');
  return { base: identity.baseBuild, baseCheckerSha256: identity.baseCheckerSha256, ...descriptor };
}).sort((a, b) => a.base.localeCompare(b.base));
const manifest = { format: 1, version, build: 'hit-native-linux-ia32-' + version, sourceCommit, installers: entries, integration };
const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
const signature = Buffer.from(crypto.sign(null, bytes, privateKey).toString('base64') + '\n');
for (const item of entries) verifyManifest(bytes, signature, publicKeyBytes, { version,
  current: { build: item.base, version: item.base.replace('hit-native-linux-ia32-', '') }, checkerSha256: item.baseCheckerSha256 });
const output = required('--output');
fs.writeFileSync(path.join(output, 'native-update.json'), bytes, { flag: 'wx', mode: 0o644 });
fs.writeFileSync(path.join(output, 'native-update.sig'), signature, { flag: 'wx', mode: 0o644 });
console.log(JSON.stringify({ version, sourceCommit, installers: entries.length, manifest: path.join(output, 'native-update.json'), signature: path.join(output, 'native-update.sig') }));
