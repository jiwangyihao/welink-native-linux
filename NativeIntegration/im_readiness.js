'use strict';

// Promise-level admission gate for the service renderer. BuildAndSend and SendMsg
// remain synchronous; a queued operation is invoked once, only after tupConfig.init
// has checked the real LoadLibrary/Startup result. Admitted work is never replayed.
function createImReadiness({ window, makePromise }) {
  let initialization = null;
  let stopped = null;
  let boundRuntime = null;
  const pending = new Set();

  function cancellation(reason) {
    const error = new Error(`IM readiness cancelled: ${reason}`);
    error.code = 'ECANCELED';
    return error;
  }

  function account() {
    if (!window.store) return '';
    const store = window.instance.getInstanceNoError('imStore');
    const state = store && store.getState();
    return state && state.account && state.account.uuid || '';
  }

  function check() {
    if (stopped) throw stopped;
  }

  function cancelPending(error) {
    for (const cancel of pending) cancel(error);
  }

  function stop(reason = 'native IM shutdown') {
    if (!stopped) stopped = cancellation(reason);
    if (initialization && initialization.status === 'pending') initialization.reject(stopped);
    cancelPending(stopped);
  }

  function initialize(start) {
    if (stopped) return Promise.reject(stopped);
    if (initialization) return initialization;
    const ready = initialization = makePromise();
    Promise.resolve().then(() => {
      check();
      return start(check);
    }).then(value => {
      if (ready.status === 'pending') ready.resolve(value);
    }, error => {
      if (ready.status === 'pending') ready.reject(error);
    });
    return ready;
  }

  function request(init, send) {
    return new Promise((resolve, reject) => {
      let queued = true;
      let unsubscribe = null;
      function leaveQueue() {
        queued = false;
        pending.delete(cancel);
        if (unsubscribe) unsubscribe();
      }
      function cancel(error) {
        if (!queued) return;
        leaveQueue();
        reject(error);
      }
      pending.add(cancel);
      try {
        check();
        const ownerAccount = account();
        const checkAccount = () => {
          if (ownerAccount && account() !== ownerAccount) {
            throw cancellation('account changed');
          }
        };
        if (window.store && typeof window.store.subscribe === 'function') {
          unsubscribe = window.store.subscribe(() => {
            try { checkAccount(); }
            catch (error) { cancel(error); }
          });
        }
        Promise.resolve(init()).then(() => {
          if (!queued) return;
          try {
            check();
            checkAccount();
            // Detach before admission. The existing callback/native cancellation
            // contract owns a request once send() has actually run.
            leaveQueue();
            resolve(send());
          } catch (error) {
            if (queued) leaveQueue();
            reject(error);
          }
        }, cancel);
      } catch (error) {
        cancel(error);
      }
    });
  }

  function bindRuntime(runtime) {
    check();
    if (boundRuntime === runtime) return;
    runtime.onLifecycle('stop', name => {
      if (name === 'tup_im_logic_api') stop();
    });
    boundRuntime = runtime;
  }

  window.addEventListener('beforeunload', () => stop('renderer unloaded'));
  window.addEventListener('logoutNotice', () => cancelPending(cancellation('account logged out')));
  window.addEventListener('switchCompany', () => cancelPending(cancellation('account switched')));
  return { initialize, request, bindRuntime, stop };
}

module.exports = { createImReadiness };
