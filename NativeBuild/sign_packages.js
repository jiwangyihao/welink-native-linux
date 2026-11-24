#!/usr/bin/env node
'use strict';

// Full fresh-install packages have their own signed manifest. The native updater
// continues to consume native-update.json and its baseline-specific deltas.
// Signing is offline; the supplied private key is never copied into any output.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const usage = 'Usage: node NativeBuild/sign_packages.js --version r45.N --source-commit COMMIT --deb PATH --apm PATH --private-key PRIVATE_PEM --public-key NativeIntegration/update_public_key.pem --output OUT';
const allowed = ['--version', '--source-commit', '--deb', '--apm', '--private-key', '--public-key', '--output'];
const args = process.argv.slice(2), values = new Map();
for (let index = 0; index < args.length; index += 2) {
  const name = args[index], value = args[index + 1];
  if (!value || !allowed.includes(name)) throw new Error(usage);
  if (values.has(name)) throw new Error('Duplicate option: ' + name);
  values.set(name, value);
}
function required(name) {
  if (!values.has(name)) throw new Error('Missing ' + name + '\n' + usage);
  return values.get(name);
}
for (const name of allowed) required(name);
const version = required('--version');
const releaseRevision = Number(version.slice(4));
if (!Number.isSafeInteger(releaseRevision) || releaseRevision < 0 || version !== 'r45.' + releaseRevision)
  throw new Error('Supply a canonical r45.N native release with an exact integer revision');
const sourceCommit = required('--source-commit');
if (sourceCommit.length !== 40 || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Supply the exact committed source SHA');
const privateKey = crypto.createPrivateKey(fs.readFileSync(required('--private-key')));
const publicKey = crypto.createPublicKey(fs.readFileSync(required('--public-key')));
if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519' ||
    !crypto.createPublicKey(privateKey).equals(publicKey))
  throw new Error('The Ed25519 signing key does not match the supplied public key');
const output = path.resolve(required('--output'));
if (!fs.statSync(output).isDirectory()) throw new Error('Output must be an existing directory');

const buffer = Buffer.allocUnsafe(1024 * 1024);
function packageAsset(input, kind) {
  const filename = path.resolve(input);
  const packageName = 'cn.edu.hit.welink.native' + (kind === 'apm' ? '.apm' : '');
  const packageVersion = version.slice(1) + '-1' + (kind === 'apm' ? '-apm' : '');
  const asset = packageName + '_' + packageVersion + '_amd64.deb';
  if (path.basename(filename) !== asset) throw new Error('Package asset must be named ' + asset);
  const before = fs.lstatSync(filename);
  if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0)
    throw new Error('Not a regular nonempty package asset: ' + filename);
  // Read actual Debian control metadata, without unpacking or executing scripts.
  const metadata = execFileSync('dpkg-deb', [
    '--show', '--showformat=${Package}\\n${Version}\\n${Architecture}\\n', filename
  ], { encoding: 'utf8', maxBuffer: 65536 });
  if (metadata !== packageName + '\n' + packageVersion + '\namd64\n')
    throw new Error('Package control metadata does not match the release name/version/amd64 architecture: ' + filename);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const fd = fs.openSync(filename, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile())
      throw new Error('Package changed while preparing its descriptor: ' + filename);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
      size += count;
      hash.update(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(fd); }
  const after = fs.lstatSync(filename);
  if (size !== before.size || after.size !== before.size || after.dev !== before.dev ||
      after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
    throw new Error('Package changed while hashing: ' + filename);
  return { kind, architecture: 'amd64', asset, size, sha256: hash.digest('hex') };
}

// Stable field and package order, no timestamps or host paths: identical inputs
// produce byte-identical UTF-8 JSON and standard Ed25519 Base64+newline signatures.
const packages = [packageAsset(required('--deb'), 'deb'), packageAsset(required('--apm'), 'apm')];
const manifest = { format: 1, version, sourceCommit, packages };
const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
const detached = crypto.sign(null, bytes, privateKey);
if (detached.length !== 64 || !crypto.verify(null, bytes, publicKey, detached))
  throw new Error('The generated Ed25519 package signature failed verification');
const signature = Buffer.from(detached.toString('base64') + '\n');
const manifestPath = path.join(output, 'native-packages.json');
const signaturePath = path.join(output, 'native-packages.sig');
fs.writeFileSync(manifestPath, bytes, { flag: 'wx', mode: 0o644 });
fs.writeFileSync(signaturePath, signature, { flag: 'wx', mode: 0o644 });
console.log(JSON.stringify({ version, sourceCommit, packages: packages.length, manifest: manifestPath, signature: signaturePath }));
