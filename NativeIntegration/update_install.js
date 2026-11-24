'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { download } = require('./update_download');
const { verifyManifest, assetUrl } = require('./update_manifest');
const { failure } = require('./platform_settings');
const run = promisify(execFile);

function processStart(pid) {
  const text = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  return text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
}
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) || fs.realpathSync(directory) !== directory)
    throw failure('EACCES', 'The native update directory must be private, canonical and user-owned.');
}
function desktopId(home, baseImage, profile, apmPackage) {
  const directory = path.join(home, '.local/share/applications');
  const launcher = path.join(home, '.local/bin/' + (apmPackage ? 'hit-welink-native-apm' : 'hit-welink-native'));
  const info = fs.lstatSync(launcher);
  const quote = value => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\"'\"'") + "'";
  if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1)
    throw failure('EINTEGRATION', 'The installed launcher is not an owned regular file.');
  const lines = fs.readFileSync(launcher, 'utf8').split('\n');
  if (!lines.includes('export WELINK_NATIVE_PROFILE_DIR=' + quote(profile)) || !lines.includes('image=' + quote(baseImage)))
    throw failure('EINTEGRATION', 'The desktop launcher belongs to another image/profile or was customized. It will not be overwritten.');
  if (apmPackage && !lines.includes('export WELINK_NATIVE_APM_PACKAGE=' + quote(apmPackage)))
    throw failure('EINTEGRATION', 'The installed launcher does not retain the APM context.');
  for (const id of (apmPackage ? [apmPackage + '.desktop'] : ['cn.edu.hit.welink.native.desktop', 'hit-welink-native.desktop'])) {
    const filename = path.join(directory, id);
    try {
      const info = fs.lstatSync(filename);
      if (!info.isFile() || info.uid !== process.getuid()) continue;
      const text = fs.readFileSync(filename, 'utf8');
      if (text.includes('StartupWMClass=HIT APP') && text.includes('TryExec=' + launcher.replace(/\\/g, '\\\\'))) return id;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw failure('EINTEGRATION', 'No owned native desktop integration was found. The running app was not changed.');
}
function progressWindow(electron, parent, cancel) {
  const channel = 'welink-native-update-progress';
  const win = new electron.BrowserWindow({ width: 560, height: 280, resizable: false, minimizable: false,
    parent, title: 'WeLink native Linux update', show: false,
    webPreferences: { preload: path.join(__dirname, 'update_progress_preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  let latest = { phase: 'downloading', completed: 0, total: 0 }, finishing = false;
  const send = () => { if (!win.isDestroyed()) win.webContents.send(channel, latest); };
  const onCancel = event => { if (event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame) cancel(); };
  electron.ipcMain.on(channel + '-cancel', onCancel);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.once('did-finish-load', () => { send(); win.show(); });
  win.on('close', event => { if (!finishing) { event.preventDefault(); cancel(); } });
  win.on('closed', () => electron.ipcMain.removeListener(channel + '-cancel', onCancel));
  const loaded = win.loadFile(path.join(__dirname, 'update_progress.html'));
  return { loaded, update(value) { latest = value; send(); }, close() { finishing = true; if (!win.isDestroyed()) win.close(); } };
}

async function installUpdate({ electron, appRoot, window, session, verified, assertActive, registerCancel }) {
  const home = fs.realpathSync(electron.app.getPath('home') || os.homedir());
  const profile = fs.realpathSync(electron.app.getPath('appData'));
  const baseImage = fs.realpathSync(path.join(appRoot, '../..'));
  const apmPackage = process.env.WELINK_NATIVE_APM_PACKAGE || null;
  if (apmPackage && (apmPackage !== 'cn.edu.hit.welink.native.apm' ||
      process.env.IS_ACE_ENV !== '1' || process.env.APM_PKG_NAME !== apmPackage ||
      !process.env.WELINK_NATIVE_APM_SUPERVISOR_PID))
    throw failure('EINTEGRATION', 'APM updates require the package lifetime supervisor inside Amber PM.');
  if (path.join(baseImage, 'resources/app') !== appRoot || fs.realpathSync(electron.app.getPath('exe')) !== path.join(baseImage, 'electron'))
    throw failure('EBUILD', 'The running executable is outside the installed native image.');
  const key = fs.readFileSync(path.join(appRoot, 'native/update_public_key.pem'));
  const checkerSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(appRoot, 'native/lib/sqlite_plugin.dll.so'))).digest('hex');
  const selected = verifyManifest(verified.bytes, verified.signature, key, { version: verified.version, current: verified.current, checkerSha256 });
  const stateRoot = path.join(home, '.local/state/' + (apmPackage ? 'welink-native-apm-updates' : 'welink-native-updates'));
  privateDirectory(stateRoot);
  const work = fs.mkdtempSync(path.join(stateRoot, 'transaction-'));
  const controller = new AbortController();
  let armed = false, supervisor = false, completed = false;
  const cancel = () => {
    if (armed) return;
    controller.abort();
    fs.writeFileSync(path.join(work, 'cancel'), '', { flag: 'wx', mode: 0o600 });
  };
  const safeCancel = () => { try { cancel(); } catch (error) { if (error.code !== 'EEXIST') throw error; } };
  const unregister = registerCancel(safeCancel);
  const progress = progressWindow(electron, window, safeCancel);
  try {
    await progress.loaded;
    fs.writeFileSync(path.join(work, 'native-update.json'), verified.bytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(work, 'native-update.sig'), verified.signature, { flag: 'wx', mode: 0o600 });
    for (const item of [selected.installer, selected.manifest.integration]) {
      await download({ net: electron.net, session, url: assetUrl(verified.version, item.asset), signal: controller.signal,
        filename: path.join(work, item.asset), size: item.size, sha256: item.sha256,
        progress: (completed, total) => progress.update({ phase: 'downloading', asset: item.asset, completed, total }) });
    }
    assertActive();
    // Fail before app exit if a required supervisor dependency is missing.
    fs.accessSync('/usr/bin/python3', fs.constants.X_OK);
    fs.accessSync('/usr/bin/openssl', fs.constants.X_OK);
    let systemd = !apmPackage;
    if (systemd) {
      try { await run('/usr/bin/systemctl', ['--user', 'show-environment'], { timeout: 10000, maxBuffer: 1024 * 1024 }); }
      catch (_) {
        if (process.env.INVOCATION_ID) throw failure('ESUPERVISOR', 'A separate systemd user service is required to survive this application service exiting.');
        systemd = false;
      }
    }
    const request = { baseImage, profile, oldPid: process.pid, oldStartTime: processStart(process.pid),
      autostartFile: (() => {
        const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
        if (!path.isAbsolute(configHome)) throw failure('EINVAL', 'XDG_CONFIG_HOME must be absolute.');
        const filename = path.join(configHome, 'autostart', (apmPackage || 'cn.edu.hit.welink.native') + '-' +
          crypto.createHash('sha256').update(profile).digest('hex').slice(0, 16) + '.desktop');
        return fs.existsSync(filename) ? filename : null;
      })(),
      desktopId: desktopId(home, baseImage, profile, apmPackage), apmPackage, systemd, token: crypto.randomBytes(32).toString('hex') };
    fs.writeFileSync(path.join(work, 'request.json'), JSON.stringify(request), { flag: 'wx', mode: 0o600 });
    const command = ['/usr/bin/python3', '-I', path.join(appRoot, 'native/update_supervisor.py'), work];
    const environment = { ...process.env, HOME: home, PATH: '/usr/bin:/bin' };
    for (const name of Object.keys(environment)) {
      if (name === 'WELINK_NATIVE_PROFILE_DIR' || name === 'WELINK_NATIVE_PROFILE_GATE_FD' || name === 'ELECTRON_RUN_AS_NODE' ||
          /^(NODE_|LD_|OPENSSL_|PYTHON|WELINK_NATIVE_UPDATE_)/.test(name)) delete environment[name];
    }
    if (controller.signal.aborted) throw failure('ECANCELED', 'Native update canceled before staging.');
    // A launch timeout can mean the service started but its acknowledgement was
    // lost. Preserve the work directory and cancel marker once launch is attempted.
    supervisor = true;
    if (systemd) {
      const variables = ['HOME', 'PATH', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
        'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS'];
      const unset = new Set(['ELECTRON_RUN_AS_NODE', 'WELINK_NATIVE_PROFILE_DIR', 'WELINK_NATIVE_PROFILE_GATE_FD',
        'WELINK_NATIVE_UPDATE_DIR', 'WELINK_NATIVE_UPDATE_TOKEN', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
        'NODE_TLS_REJECT_UNAUTHORIZED', 'LD_PRELOAD', 'LD_AUDIT', 'LD_LIBRARY_PATH', 'OPENSSL_CONF', 'OPENSSL_MODULES',
        'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONINSPECT',
        ...Object.keys(process.env).filter(name => /^(NODE_|LD_|OPENSSL_|PYTHON)/.test(name))]);
      await run('/usr/bin/systemd-run', ['--user', '--quiet', '--collect', '--unit=welink-native-update-' + path.basename(work),
        '--property=Type=exec', '--property=SendSIGKILL=no', '--working-directory=' + home,
        ...variables.map(name => '--setenv=' + name + '=' + (environment[name] || '')),
        '--property=UnsetEnvironment=' + [...unset].sort().join(' '),
        '--', ...command],
      { env: environment, timeout: 15000 });
    } else {
      const log = fs.openSync(path.join(work, 'supervisor.log'), 'ax', 0o600);
      try {
        const child = spawn(command[0], command.slice(1), { detached: true, stdio: ['ignore', log, log], env: environment });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
      } finally { fs.closeSync(log); }
    }
    const deadline = Date.now() + 31 * 60 * 1000;
    while (Date.now() < deadline) {
      let status;
      try { status = JSON.parse(fs.readFileSync(path.join(work, 'status.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (status) {
        progress.update(status);
        if (status.phase === 'failed' || status.phase === 'canceled')
          throw failure(status.phase === 'canceled' ? 'ECANCELED' : 'EINSTALL', status.error);
        if (status.phase === 'staged') {
          if (controller.signal.aborted) throw failure('ECANCELED', 'Native update canceled before restart.');
          assertActive();
          armed = true;
          fs.writeFileSync(path.join(work, 'activate'), '', { flag: 'wx', mode: 0o600 });
          completed = true;
          return { status: 'staged', action: 'restart-required', version: verified.version, recoveryDirectory: work };
        }
      }
      // Cancellation after a child started waits for its actual cleanup receipt.
      if (!supervisor && controller.signal.aborted) throw failure('ECANCELED', 'Native update canceled.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw failure('ETIMEDOUT', 'Native update supervisor did not finish staging; no restart was requested.');
  } finally {
    unregister();
    progress.close();
    if (!completed) {
      safeCancel();
      // Keep transaction evidence when a supervisor owns it; never race its cleanup.
      if (!supervisor) fs.rmSync(work, { recursive: true, force: true });
    }
  }
}
module.exports = { installUpdate, processStart };
