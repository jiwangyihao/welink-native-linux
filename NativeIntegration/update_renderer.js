'use strict';

const { failure } = require('./platform_settings');

async function check(manual) {
  try {
    const result = await require('./platform').checkNativeUpdate(manual);
    if (result.status === 'error') console.error('Native Linux update:', result.error.code, result.error.message);
    if (result.action === 'restart-required') {
      // This is the vendor's real cleanup/exit flow, never app.exit/SIGKILL.
      await window.appService.exitApp({ entry: 'native-signed-update-restart' });
    }
    return result;
  } catch (error) {
    // Existing vendor event handlers do not await every check. Return an explicit
    // failure receipt instead of producing an unhandled rejection or fake latest.
    console.error('Native Linux update:', error.code || 'EIO', error.message);
    window.dispatchEvent(new window.CustomEvent('native-platform-error', {
      detail: { code: error.code || 'EIO', message: error.message }
    }));
    return { status: 'error', error: { code: error.code || 'EIO', message: error.message } };
  } finally {
    if (manual && window.coreUi && typeof window.coreUi.loadingfunc === 'function') window.coreUi.loadingfunc(false);
  }
}

function unsupported() {
  throw failure('ENOTSUP', 'Windows download and installation APIs are unavailable on Linux. Use the separately signed native update action in Check for updates.');
}
async function unsupportedAsync() { return unsupported(); }
function backgroundCheck() { return check(false); }
function manualCheck() { return check(true); }

// HwUpgrade's module-local Linux branch uses these actual operations instead of
// initializing its Windows download callbacks, installer state and progress UI.
const actions = {
  checkUpgrade(options = {}) { return check(options.isUserClick === true); },
  showPcUpdateModel: backgroundCheck,
  clickConfirmUpdate: manualCheck,
  startDownload: unsupportedAsync,
  startInstallNewVer: unsupportedAsync,
  cancelDownload: unsupportedAsync,
  dealDownloadFailed: unsupportedAsync,
  dealInstallFailed: unsupportedAsync,
  async hideProgressBarModal() {
    const modal = window.$getState && window.$getState().common.modalContent;
    if (!modal || modal.key !== 'progressbar') throw failure('ENOENT', 'No legacy update progress dialog is open.');
    await window.coreUi.hideModal({ entry: 'native-update-dismiss-legacy-progress' });
    return { status: 'dismissed' };
  }
};
Object.defineProperty(actions, '__esModule', { value: true });
const transport = {
  upgradeByHttp: backgroundCheck,
  downloadFromHttp: unsupportedAsync,
  getDownloadSuccessVersionCode: unsupported
};
Object.defineProperty(transport, '__esModule', { value: true });

module.exports = Object.freeze({ actions: Object.freeze(actions), transport: Object.freeze(transport),
  backgroundCheck, manualCheck, unsupported, unsupportedAsync });
