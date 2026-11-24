'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function canonicalProfile(directory) {
  if (!path.isAbsolute(directory)) throw new Error('The native profile must be absolute');
  const suffix = [];
  let existing = path.resolve(directory);
  while (!fs.existsSync(existing)) {
    suffix.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('The native profile has no existing filesystem ancestor');
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

function acquireProfileGate({ profile }) {
  const profileRoot = canonicalProfile(profile);
  const directory = path.join(path.dirname(profileRoot), '.welink-native-profile-gates');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const state = fs.lstatSync(directory);
  if (!state.isDirectory() || state.uid !== process.getuid() || (state.mode & 0o077) || fs.realpathSync(directory) !== directory)
    throw new Error('The native profile gate directory must be private, canonical and user-owned');
  const filename = path.join(directory, crypto.createHash('sha256').update(profileRoot).digest('hex') + '.lock');
  const fd = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o077))
      throw new Error('The native profile gate is not a private owned regular file');
    // flock(1) acquires SH on the inherited open-file description. Its exit
    // does not unlock the descriptor retained by this Electron main process.
    // Do not trust an inherited environment boolean or close this FD during
    // prepareExit/dispose: it protects the profile until actual process exit.
    const result = spawnSync('/usr/bin/flock', ['--shared', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 180000,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' }
    });
    if (result.error || result.status !== 0) throw new Error('Could not acquire the native profile startup gate: ' +
      (result.error ? result.error.message : String(result.stderr || '').trim()));
    const current = fs.lstatSync(filename);
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino || current.nlink !== 1)
      throw new Error('The native profile gate changed while startup was waiting');
    return { profileRoot, fd };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
module.exports = { acquireProfileGate };
