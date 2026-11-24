'use strict';

const { failure } = require('./platform_settings');

async function check(manual) {
  try {
    const result = await require('./platform').checkNativeUpdate(manual);
    if (result.status === 'error') console.error('Native Linux update:', result.error.code, result.error.message);
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
  throw failure('ENOTSUP', 'Native Linux updates are manual. Use Check for updates to review the native release page; in-app package download and installation are not supported.');
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
  startDownload(options = {}) { return check(options.isShowModal !== false); },
  startInstallNewVer: manualCheck,
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
