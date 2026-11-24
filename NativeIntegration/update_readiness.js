'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { processStart } = require('./update_install');
const HTTP_EXPORTS = ['middleGroundAjax', 'middleGroundPost', 'downloadUpgradeFile', 'cancelDownloadUpgradeFile'];

// This expression only observes the actual vendor route, service exports and
// mounted controls. It never sets a route, app state, DOM or readiness boolean.
function inspectPedestal() {
  const route = '/' + String(typeof window.getRoute === 'function' ? window.getRoute() : location.hash.replace(/^#\/?/, '')).replace(/^\//, '').split('?')[0];
  const names = ['middleGroundAjax', 'middleGroundPost', 'downloadUpgradeFile', 'cancelDownloadUpgradeFile'];
  const httpExports = names.filter(name => window.coreRsHttp && typeof window.coreRsHttp[name] === 'function');
  const visible = selector => {
    const element = document.querySelector(selector);
    return !!(element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
  };
  const mounted = route === '/login/Auth2Login/Webview' ? visible('.auth2-login-webview') :
    route === '/login/LoginPage' ? visible('#pc-account') && visible('#password') :
    route === '/login/WPFirstTimeAuthentication/empty' ? visible('.single-list-wrap:not(.verification-code) input.list-input') &&
      visible('.verification-code input.list-input') && visible('button.amu-btn-primary') :
    route === '/main/im' ? visible('#mainView_im:not(.hidden)') : false;
  return { route, mounted, httpExports, exitProvider: !!(window.appService && typeof window.appService.exitApp === 'function') };
}
function inspectMessage() {
  const root = document.querySelector('[data-watermark="im-container"]');
  return !!(root && root.children.length && root.getBoundingClientRect().width > 0 && root.getBoundingClientRect().height > 0);
}
function inspectLogin() {
  return document.readyState === 'complete' && Array.from(document.querySelectorAll('input,button,canvas')).some(element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}
function canonical(contents, appRoot, document) {
  try {
    const url = new URL(contents.getURL());
    return !contents.isDestroyed() && url.protocol === 'file:' && !url.host && fileURLToPath(url) === path.join(appRoot, 'pedestal', document);
  } catch (_) { return false; }
}
function installReadiness({ electron, appRoot, profileRoot, requestExit }) {
  const directory = process.env.WELINK_NATIVE_UPDATE_DIR;
  const token = process.env.WELINK_NATIVE_UPDATE_TOKEN;
  if (!directory && !token) return () => {};
  if (!directory || !path.isAbsolute(directory) || !/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Invalid native update readiness context');
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) || fs.realpathSync(directory) !== directory)
    throw new Error('Unsafe native update readiness directory');
  const request = JSON.parse(fs.readFileSync(path.join(directory, 'request.json'), 'utf8'));
  if (request.token !== token || request.profile !== profileRoot) throw new Error('Native update readiness context belongs to another profile');
  const build = JSON.parse(fs.readFileSync(path.join(appRoot, 'native/build.json'), 'utf8')).build;
  let running = false, disposed = false, sent = false, stable = 0, previous = '', stopping = false;
  function receipt(value) {
    const commandLine = electron.app.commandLine;
    const disabled = ['no-sandbox', 'disable-namespace-sandbox', 'disable-seccomp-filter-sandbox']
      .some(name => commandLine.hasSwitch(name));
    const sandboxBackend = disabled ? 'disabled' : commandLine.hasSwitch('disable-setuid-sandbox') ? 'namespace' : 'default';
    const apmPackage = process.env.WELINK_NATIVE_APM_PACKAGE || null;
    const temporary = path.join(directory, 'readiness-' + process.pid + '.tmp');
    fs.writeFileSync(temporary, JSON.stringify({ ...value, token, build, profile: profileRoot, pid: process.pid,
      startTime: processStart(process.pid), apmPackage, sandboxBackend }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, 'readiness.json'));
    sent = true;
  }
  async function tick() {
    if (disposed || running) return;
    running = true;
    try {
      if (!stopping && fs.existsSync(path.join(directory, 'stop-request.json'))) {
        const command = JSON.parse(fs.readFileSync(path.join(directory, 'stop-request.json'), 'utf8'));
        if (command.token === token) { stopping = true; requestExit(); }
      }
      if (sent || stopping) return;
      const all = electron.webContents.getAllWebContents();
      const pedestal = all.find(contents => canonical(contents, appRoot, 'index.html'));
      if (!pedestal || pedestal.isLoading()) return;
      const evidence = await pedestal.executeJavaScript('(' + inspectPedestal.toString() + ')()', false);
      if (evidence.route.toLowerCase().includes('loadingfailed')) {
        receipt({ status: 'failed', error: 'The application entered /login/LoadingFailed', route: evidence.route });
        return;
      }
      if (!evidence.mounted || !evidence.exitProvider || evidence.httpExports.join(',') !== HTTP_EXPORTS.join(',')) { stable = 0; return; }
      let surface = evidence.route === '/login/LoginPage' || evidence.route === '/login/WPFirstTimeAuthentication/empty';
      for (const contents of all) {
        if (surface || contents === pedestal || contents.isDestroyed() || contents.isLoading()) continue;
        if (evidence.route === '/main/im' && canonical(contents, appRoot, 'viewcontainer.html')) {
          surface = await contents.executeJavaScript('(' + inspectMessage.toString() + ')()', false);
        } else if (evidence.route === '/login/Auth2Login/Webview' && /^https:\/\//.test(contents.getURL())) {
          // The login BrowserView must contain real mounted input/QR controls;
          // merely creating the view or loading the parent shell is insufficient.
          const owner = electron.BrowserWindow.fromWebContents(pedestal);
          if (owner && owner.getBrowserViews().some(view => view.webContents === contents))
            surface = await contents.executeJavaScript('(' + inspectLogin.toString() + ')()', false);
        }
      }
      if (!surface) { stable = 0; return; }
      if (previous !== evidence.route) { previous = evidence.route; stable = Date.now(); }
      if (!stable) stable = Date.now();
      if (Date.now() - stable >= 3000) receipt({ status: 'ready', route: evidence.route, mounted: true, httpExports: evidence.httpExports });
    } catch (error) {
      stable = 0;
      // Navigating/destroyed frames are transient; the supervisor deadline is
      // authoritative and reports a failure if no genuine surface becomes ready.
      console.error('Native update readiness:', error.message);
    } finally { running = false; }
  }
  const timer = setInterval(tick, 500);
  timer.unref();
  return () => { disposed = true; clearInterval(timer); };
}
module.exports = { installReadiness, inspectPedestal, inspectMessage, inspectLogin };
