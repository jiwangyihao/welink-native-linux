'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function desktopValue(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw failure('EINVAL', 'Invalid desktop entry value');
  return value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t');
}

function execArgument(value) {
  // Desktop Entry Exec is not a shell command. Escape its quoting layer first,
  // then the desktop-file string layer; literal percent must not become a field code.
  return desktopValue('"' + value.replace(/([\\"`$])/g, '\\$1').replace(/%/g, '%%') + '"');
}

function createAutostart({ app, appRoot, profileRoot, execPath }) {
  const apmPackage = process.env.WELINK_NATIVE_APM_PACKAGE || null;
  if (apmPackage && (apmPackage !== 'cn.edu.hit.welink.native.apm' ||
      process.env.IS_ACE_ENV !== '1' || process.env.APM_PKG_NAME !== apmPackage))
    throw failure('EINVAL', 'The APM autostart context is not an active Amber PM application.');
  const configHome = process.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config');
  if (!path.isAbsolute(configHome)) throw failure('EINVAL', 'XDG_CONFIG_HOME must be absolute');
  const id = (apmPackage || 'cn.edu.hit.welink.native') + '-' + crypto.createHash('sha256').update(profileRoot).digest('hex').slice(0, 16);
  const directory = path.join(configHome, 'autostart');
  const filename = path.join(directory, id + '.desktop');
  const marker = 'X-WeLink-Native-Owner=' + id;
  const launcher = apmPackage ? path.join(app.getPath('home'), '.local/bin/hit-welink-native-apm') : execPath;
  const command = apmPackage ? '/bin/bash -- ' + execArgument(launcher) :
    'env ' + execArgument('WELINK_NATIVE_PROFILE_DIR=' + profileRoot) + ' ' +
    execArgument(execPath) + ' ' + execArgument(appRoot);
  const content = '[Desktop Entry]\nType=Application\nVersion=1.0\nName=' + desktopValue(app.getName()) +
    '\nExec=' + command + '\nTryExec=' + desktopValue(launcher) +
    '\nTerminal=false\nStartupNotify=true\n' + marker +
    (apmPackage ? '\nX-WeLink-Native-APM-Package=' + apmPackage : '') +
    '\nX-WeLink-Native-Profile=' + desktopValue(profileRoot) + '\n';

  function openOwned(flags) {
    let fd;
    try { fd = fs.openSync(filename, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 ||
          (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
        throw failure('EACCES', 'Autostart entry is not a regular file owned by this user');
      }
      const text = fs.readFileSync(fd, 'utf8');
      if (!text.split(/\r?\n/).includes(marker)) {
        throw failure('EEXIST', 'An unrelated desktop entry occupies the native autostart path');
      }
      return { fd, stat, text };
    } catch (error) { fs.closeSync(fd); throw error; }
  }

  function get() {
    const entry = openOwned(fs.constants.O_RDONLY);
    if (!entry) return false;
    try {
      const values = Object.create(null);
      let section = '';
      for (const line of entry.text.split(/\r?\n/)) {
        if (line.startsWith('[')) section = line;
        else if (section === '[Desktop Entry]' && line.includes('=')) {
          values[line.slice(0, line.indexOf('='))] = line.slice(line.indexOf('=') + 1);
        }
      }
      if (values.Hidden === 'true' || values['X-GNOME-Autostart-enabled'] === 'false') return false;
      const expectedExec = content.split('\n').find(line => line.startsWith('Exec=')).slice(5);
      return values.Type === 'Application' && values.Exec === expectedExec &&
        values['X-WeLink-Native-Profile'] === desktopValue(profileRoot);
    } finally { fs.closeSync(entry.fd); }
  }

  function set(enabled) {
    if (typeof enabled !== 'boolean') throw failure('EINVAL', 'Autostart state must be boolean');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let entry = openOwned(fs.constants.O_RDWR);
    if (!entry) {
      if (!enabled) return false;
      const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      entry = { fd };
    }
    try {
      // Do not unlink/replace a pathname after checking it: write only the owned
      // inode already opened with O_NOFOLLOW. Disabled entries remain explicitly hidden.
      const bytes = Buffer.from(content + (enabled ? '' : 'Hidden=true\n'));
      let offset = 0;
      while (offset < bytes.length) offset += fs.writeSync(entry.fd, bytes, offset, bytes.length - offset, offset);
      fs.ftruncateSync(entry.fd, bytes.length);
      fs.fsyncSync(entry.fd);
    } finally { fs.closeSync(entry.fd); }
    const actual = get();
    if (actual !== enabled) throw failure('EIO', 'Native autostart state was not persisted');
    return actual;
  }

  return Object.freeze({ get, set, filename });
}

module.exports = { createAutostart, failure };
