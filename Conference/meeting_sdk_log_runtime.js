'use strict';

/* Load meeting_sdk_log_catalog.js first, then this script, in the pinned page.
 * Install on HRTC provider initialization, BEFORE the application's first media
 * use. The only discovery call is createStream({audio:true,video:false}); its
 * uninitialized LocalStream creates JS bookkeeping, not tracks/devices/network.
 * Do not initialize or close that probe: neither is needed to release resources.
 *
 * HRTC 1.10.96's default/client loggers share tE.prototype.log. Intercept that
 * method, not console, the adapter or its log buffer. Preserve the receiver,
 * arguments, return, exceptions, console threshold and SDK buffer behavior.
 * All log invocations are eligible regardless of the existing console threshold;
 * no SDK log level, telemetry setting or other SDK configuration is changed.
 * Only catalogue IDs leave this page. Unknown messages/dynamic tags are ignored.
 * Bootstrap discovery messages and earlier SDK logs are NOT replayed.
 *
 * writeBatch({catalog:1,batch:N,events:[id,...]}) must resolve to
 * {ok:true,catalog:1,batch:N,accepted:events.length} AFTER confirmed host output.
 * It receives at most 64 IDs. At most 1024 IDs are retained, including in-flight
 * output. Writes are serialized. Failure/overflow latches a static error; no
 * automatic retry can duplicate a partly written batch. flush() and dispose()
 * reject that error, never claim successful flushing. The host also receives
 * its own failed write receipt. Reinstall only after handling a failure.
 *
 * flush(): Promise<{ok:true,catalog:1,accepted:N}> is a barrier for every eligible
 * call made before flush was invoked; N is the cumulative confirmed call count
 * through that barrier, NOT an account/session/stream identifier. dispose()
 * restores the original descriptor synchronously, then returns that same flush
 * promise. Await flush before changing host destinations; await dispose at normal
 * teardown before closing the host sink. Neither operation calls SDK methods.
 */
(function installSdkLogRuntime(root) {
  if (Object.prototype.hasOwnProperty.call(root, '__welinkInstallSdkLog')) return;
  const catalogue = root.__welinkSdkLogCatalog;
  if (!catalogue || catalogue.version !== 1 || catalogue.sdkVersion !== '1.10.96')
    throw new Error('SDK_LOG_CATALOG_UNAVAILABLE');

  const installations = new WeakMap();
  const installedSdks = new WeakMap();
  const levels = new Map();
  for (const event of catalogue.events) {
    let tags = levels.get(event.severity);
    if (!tags) levels.set(event.severity, tags = new Map());
    for (const tag of event.tags) {
      let matchers = tags.get(tag);
      if (!matchers) tags.set(tag, matchers = { exact: new Map(), prefixes: [], maxExact: 0 });
      if (event.match === 'exact') {
        matchers.exact.set(event.text, event.id);
        matchers.maxExact = Math.max(matchers.maxExact, event.text.length);
      } else matchers.prefixes.push(event);
    }
  }
  for (const tags of levels.values()) {
    for (const matchers of tags.values())
      matchers.prefixes.sort((left, right) => right.text.length - left.text.length);
  }

  function classify(level, tag, message) {
    if (typeof level !== 'string' || typeof tag !== 'string' || typeof message !== 'string') return 0;
    const tags = levels.get(level);
    const matchers = tags && tags.get(tag);
    if (!matchers) return 0;
    const exact = message.length <= matchers.maxExact && matchers.exact.get(message);
    if (exact) return exact;
    for (const entry of matchers.prefixes) {
      if (message.startsWith(entry.text)) return entry.id;
    }
    return 0;
  }

  function failure(code, accepted, pending) {
    const error = new Error(code);
    error.code = code;
    error.accepted = accepted;
    error.pending = pending;
    return error;
  }

  function install(sdk, writeBatch) {
    if (!sdk || sdk.VERSION !== catalogue.sdkVersion || typeof sdk.createStream !== 'function')
      throw failure('SDK_LOG_UNSUPPORTED_PROVIDER', 0, 0);
    if (typeof writeBatch !== 'function') throw failure('SDK_LOG_INVALID_WRITER', 0, 0);
    const prior = installedSdks.get(sdk);
    if (prior) {
      if (prior.writer !== writeBatch) throw failure('SDK_LOG_ALREADY_INSTALLED', 0, 0);
      return prior.controller;
    }

    let prototype;
    let descriptor;
    try {
      const probe = sdk.createStream({ audio: true, video: false });
      const logger = probe && probe.log_;
      prototype = logger && Object.getPrototypeOf(logger);
      descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'log');
      if (!prototype || !descriptor || typeof descriptor.value !== 'function' ||
          descriptor.value.length !== 4 || Object.prototype.hasOwnProperty.call(logger, 'log') ||
          prototype.constructor.name !== 'tE' ||
          !['error', 'warn', 'info', 'debug'].every(name =>
            typeof Object.getOwnPropertyDescriptor(prototype, name)?.value === 'function'))
        throw new Error('Unsupported logger');
    } catch (_) {
      throw failure('SDK_LOG_ATTACH_FAILED', 0, 0);
    }

    const existing = installations.get(prototype);
    if (existing) {
      if (existing.writer !== writeBatch) throw failure('SDK_LOG_ALREADY_INSTALLED', 0, 0);
      return existing.controller;
    }

    const original = descriptor.value;
    const queue = [];
    let received = 0;
    let confirmed = 0;
    let nextBatch = 1;
    let timer = null;
    let inFlight = null;
    let failed = null;
    let capturing = true;
    let disposal = null;

    function latch(code) {
      if (!failed) failed = failure(code, confirmed, queue.length);
      if (timer !== null) { clearTimeout(timer); timer = null; }
      return failed;
    }

    function arm() {
      if (!failed && timer === null && !inFlight && queue.length) {
        timer = setTimeout(() => { timer = null; pump(); }, catalogue.flushDelayMs);
      }
    }

    function pump() {
      if (inFlight) return inFlight;
      if (failed || !queue.length) return null;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (!Number.isSafeInteger(nextBatch)) {
        latch('SDK_LOG_SEQUENCE_EXHAUSTED');
        return null;
      }
      const batch = Object.freeze({ catalog: catalogue.version, batch: nextBatch++,
        events: Object.freeze(queue.slice(0, catalogue.batchLimit)) });
      inFlight = Promise.resolve().then(() => writeBatch(batch)).then(receipt => {
        if (!receipt || receipt.ok !== true || receipt.catalog !== catalogue.version ||
            receipt.batch !== batch.batch || receipt.accepted !== batch.events.length)
          throw new Error('Unconfirmed output');
        queue.splice(0, batch.events.length);
        confirmed += batch.events.length;
      }).catch(() => {
        throw latch('SDK_LOG_WRITE_FAILED');
      }).finally(() => {
        inFlight = null;
        if (queue.length >= catalogue.batchLimit && !failed) pump();
        else arm();
      });
      // Timer-initiated writes have no caller to await them. Retain the failure
      // for flush/dispose instead of producing an unhandled promise rejection.
      inFlight.catch(() => {});
      return inFlight;
    }

    function capture(level, tag, message) {
      if (!capturing || failed) return;
      const id = classify(level, tag, message);
      if (!id) return;
      if (queue.length >= catalogue.queueLimit) { latch('SDK_LOG_QUEUE_OVERFLOW'); return; }
      if (!Number.isSafeInteger(received + 1)) { latch('SDK_LOG_SEQUENCE_EXHAUSTED'); return; }
      queue.push(id);
      ++received;
      if (queue.length >= catalogue.batchLimit) pump();
      else arm();
    }

    function log(level, tag, message, extra) {
      // Observation is deliberately non-throwing; the original implementation
      // runs exactly once even if capture fails, and its exceptions still escape.
      try { capture(level, tag, message); } catch (_) { latch('SDK_LOG_CAPTURE_FAILED'); }
      return Reflect.apply(original, this, arguments);
    }

    async function flush() {
      const target = received;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      while (confirmed < target) {
        // Even a latched overflow must wait for the already-issued host write
        // before a teardown may release its FD. Never start another on failure.
        const writing = inFlight || (!failed && pump());
        if (writing) await writing;
        if (failed) throw failed;
        if (!writing) throw latch('SDK_LOG_WRITE_FAILED');
      }
      if (failed) {
        if (inFlight) await inFlight;
        throw failed;
      }
      return { ok: true, catalog: catalogue.version, accepted: target };
    }

    function dispose() {
      if (disposal) return disposal;
      capturing = false;
      let restored = false;
      try {
        if (Object.getOwnPropertyDescriptor(prototype, 'log')?.value === log) {
          Object.defineProperty(prototype, 'log', descriptor);
          restored = true;
        }
      } catch (_) { /* Report below without overwriting somebody else's hook. */ }
      installations.delete(prototype);
      installedSdks.delete(sdk);
      disposal = flush().then(receipt => {
        if (!restored) throw failure('SDK_LOG_RESTORE_FAILED', confirmed, queue.length);
        return receipt;
      });
      return disposal;
    }

    const controller = Object.freeze({ flush, dispose });
    try {
      Object.defineProperty(prototype, 'log', { ...descriptor, value: log });
    } catch (_) {
      throw failure('SDK_LOG_ATTACH_FAILED', 0, 0);
    }
    const installation = { writer: writeBatch, controller };
    installations.set(prototype, installation);
    installedSdks.set(sdk, installation);
    return controller;
  }

  Object.defineProperty(root, '__welinkInstallSdkLog', { value: install });
})(window);
