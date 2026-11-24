'use strict';

// Runs in the real conference service renderer. Authentication readiness is
// deliberately separate from the genuine WebRTC engine's ready event.
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const nativeFfi = require('./ffi');
const requireOnlineLinkVariant = require('../shared/meeting_link_admission');

const PROTOCOL = 'welink-native-web/1';
const CHANNEL = 'welink-native-meeting-v1';
const TOKEN_REQUEST = CHANNEL + '-token-request';
const TOKEN_REPLY = CHANNEL + '-token-reply';
const CONFIG_REQUEST = CHANNEL + '-config-request';
const CONFIG_REPLY = CHANNEL + '-config-reply';
const EVENT = CHANNEL + '-event';
let libraryPromise;
let libraryContext;
let libraryGeneration = 0;
// auth_reset retires credentials, not C's media instance/sequence. Retain only
// state actually accepted by webState across same-renderer bridge replacements.
let nativeEngineState;
const bridges = new WeakMap();
nativeFfi.onLifecycle('stop', id => { if (id === 'meeting_adapter') ++libraryGeneration; });

function failure(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

async function loadLibrary({ window, Pedestal }) {
  const generation = libraryGeneration;
  const owner = bridges.get(window);
  const ownerGeneration = owner && owner.generation, intent = owner && owner.intent;
  const checkOwner = () => {
    if (libraryContext.unloaded) throw failure('DISPOSED', 'The conference renderer was unloaded');
    if (generation !== libraryGeneration) throw failure('SESSION_CHANGED', 'Native meeting startup was retired');
  };
  if (libraryPromise) {
    if (libraryContext.window !== window) throw failure('OWNER_CHANGED', 'The meeting library belongs to another renderer');
  } else {
    libraryContext = { window, Pedestal, unloaded: false, callback: null };
    if (typeof window.addEventListener === 'function')
      window.addEventListener('beforeunload', () => { libraryContext.unloaded = true; }, { once: true });
    libraryPromise = (async () => {
      if (typeof window.notifyJsTupCallback !== 'function')
        throw failure('CALLBACK_UNAVAILABLE', 'The real conference notification dispatcher is not installed');
      const environment = await Pedestal.callMethod('method://pedestal/getEnvInfo');
      checkOwner();
      if (!environment || typeof environment.ffiPath !== 'string')
        throw failure('FFI_UNAVAILABLE', 'The configured native FFI module is unavailable');
      const ffi = window.require(environment.ffiPath);
      const library = ffi.Library(path.join(__dirname, 'lib', 'meeting_adapter.dll.so'), {
        js2c_sendmsg: ['int', ['string']], set_c2js_callback: ['int', ['pointer']],
        init_config: ['int', ['string']]
      });
      const callback = ffi.Callback('void', ['string'], raw => window.notifyJsTupCallback(JSON.parse(raw)));
      libraryContext.callback = callback;
      window.msgCallback = callback;
      const configured = library.init_config(JSON.stringify({ param: {
        nativelogpath: path.join(Pedestal.logRootPath, 'conference')
      } }));
      if (configured !== 0) throw failure(configured, 'Native meeting log initialization failed');
      return library;
    })();
  }
  const library = await libraryPromise;
  checkOwner();
  // Loading is shared, but set_c2js_callback starts the native service. Check
  // this caller after every load/reload await, before that side effect. A cold
  // join retired by exit must not start native or poison the reusable DLL cache.
  if (owner && owner.disposed) throw failure('DISPOSED', 'The conference renderer bridge was disposed');
  if (owner !== bridges.get(window) || owner && (ownerGeneration !== owner.generation || intent !== owner.intent))
    throw failure('SESSION_CHANGED', 'The native meeting startup request was retired');
  if (!nativeFfi.isStarted('meeting_adapter')) {
    const registered = library.set_c2js_callback(libraryContext.callback);
    if (registered !== 2) throw failure(registered, 'Native meeting callback registration failed');
  }
  // ffi.js pins the callback/library and registers the owner-thread wake.
  return library;
}

function configuredOrigin(environment, settings) {
  const address = settings.compassUrlEnable ? settings.compassUrl :
    String(environment.middleEndAddress || '').includes('uat') ?
      'meeting.clouduat.welink.huawei.com' : 'meeting.huaweicloud.com';
  if (typeof address !== 'string' || !address) throw failure('SERVER_REQUIRED', 'The configured meeting server is missing');
  const url = new URL(address.includes('://') ? address : 'https://' + address);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw failure('INVALID_SERVER', 'The configured meeting server must be an HTTPS authority');
  const rawPort = environment.serverPort;
  const omittedPort = rawPort === undefined || rawPort === null ||
    (typeof rawPort === 'string' && !rawPort.trim());
  const port = url.port ? Number(url.port) : omittedPort ? 443 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('INVALID_SERVER_PORT', 'The configured meeting server port is invalid');
  url.port = String(port);
  return { server: url.hostname, port, origin: url.origin };
}

class RendererMeetingBridge extends EventEmitter {
  constructor({ window, Pedestal, sdk, getStore }) {
    super();
    if (!window || !Pedestal || !sdk || typeof getStore !== 'function') throw new TypeError('Actual conference service dependencies are required');
    this.window = window;
    this.Pedestal = Pedestal;
    this.sdk = sdk;
    this.getStore = getStore;
    this.ipc = window.require('electron').ipcRenderer;
    if (!this.ipc) throw failure('OWNER_REQUIRED', 'The conference bridge must run in its service renderer');
    this.generation = 1;
    this.intent = 0;
    this.setupIntent = this.loginIntent = this.mediaIntent = -1;
    this.sequence = 0;
    this.configHash = null;
    this.managementConfig = null;
    this.origin = null;
    this.registration = null;
    this.registrationPromise = null;
    this.registrationRequest = null;
    this.registrationReceipt = null;
    this.setupPromise = null;
    this.registrationEvents = null;
    this.loginPromise = null;
    this.logoutPromise = null;
    this.tokenPromise = null;
    this.mediaPromise = null;
    this.mediaReady = false;
    this.engineSequence = 0;
    this.engineWaiters = new Set();
    this.nativeRequests = new Set();
    this.account = null;
    this.disposed = false;
    this.nativeStopped = !nativeFfi.isStarted('meeting_adapter');
    this.removeStopListener = nativeFfi.onLifecycle('stop', id => {
      if (id !== 'meeting_adapter') return;
      this.nativeStopped = true;
      this.retirePending(failure('NATIVE_STOPPED', 'The native meeting service stopped'));
      // Native reset preserves auth_config. Retain its receipt so logout after
      // a stop reports the unavailable native cleanup rather than skipping it.
      this.account = null;
    });
    this.removeStartListener = nativeFfi.onLifecycle('start', id => {
      if (id === 'meeting_adapter') this.nativeStopped = false;
    });
    this.tokenListener = (_event, request) => this.answerToken(request);
    this.eventListener = (_event, event) => this.acceptEvent(event);
    this.configListener = (_event, request) => this.answerConfiguration(request);
    this.unloadListener = () => this.dispose();
    // Bind these before registration: the main broker never owns another FFI cache.
    this.ipc.on(TOKEN_REQUEST, this.tokenListener);
    this.ipc.on(EVENT, this.eventListener);
    this.ipc.on(CONFIG_REQUEST, this.configListener);
    if (typeof this.window.addEventListener === 'function')
      this.window.addEventListener('beforeunload', this.unloadListener);
  }

  get store() { return this.getStore(); }

  retirePending(error) {
    ++this.generation;
    ++this.intent;
    this.mediaReady = false;
    this.tokenPromise = null;
    this.registrationPromise = null;
    this.registrationEvents = null;
    for (const cancel of [...this.nativeRequests]) cancel(error);
    for (const waiter of [...this.engineWaiters]) waiter.reject(error);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.nativeStopped = true;
    this.ipc.removeListener(TOKEN_REQUEST, this.tokenListener);
    this.ipc.removeListener(EVENT, this.eventListener);
    this.ipc.removeListener(CONFIG_REQUEST, this.configListener);
    if (typeof this.window.removeEventListener === 'function')
      this.window.removeEventListener('beforeunload', this.unloadListener);
    if (this.removeStopListener) { this.removeStopListener(); this.removeStopListener = null; }
    if (this.removeStartListener) { this.removeStartListener(); this.removeStartListener = null; }
    this.retirePending(failure('DISPOSED', 'The conference renderer bridge was disposed'));
    this.removeAllListeners();
    if (bridges.get(this.window) === this) bridges.delete(this.window);
  }

  requireNative() {
    if (this.disposed) throw failure('DISPOSED', 'The conference renderer bridge was disposed');
    if (this.nativeStopped || !nativeFfi.isStarted('meeting_adapter'))
      throw failure('NATIVE_NOT_STARTED', 'The native meeting service is not running');
  }

  async configuration() {
    if (this.disposed) throw failure('DISPOSED', 'The conference renderer bridge was disposed');
    await loadLibrary({ window: this.window, Pedestal: this.Pedestal });
    const [environment, proxy] = await Promise.all([
      this.Pedestal.callMethod('method://pedestal/getEnvInfo'),
      this.Pedestal.callMethod('method://pedestal/getProxyInfo')
    ]);
    const settings = this.store.getStore();
    const server = configuredOrigin(environment, settings);
    this.requireNative();
    const binding = nativeFfi.meetingBindings();
    const deviceId = binding.deviceId();
    if (typeof deviceId !== 'string' || !deviceId) throw failure('DEVICE_ID_UNAVAILABLE', 'The real Linux device identity is unavailable');
    const userAgent = this.window.navigator.userAgent;
    if (typeof userAgent !== 'string' || !userAgent) throw failure('USER_AGENT_UNAVAILABLE', 'The actual renderer user agent is unavailable');
    const config = { server: server.server, port: server.port, deviceId, userAgent };
    if (proxy && proxy.conferenceProxyEnable !== false && proxy.proxyAddress) {
      const address = String(proxy.proxyAddress);
      const url = new URL(address.includes('://') ? address : 'http://' + address);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
        throw failure('INVALID_PROXY', 'The configured proxy authority is invalid');
      if (proxy.proxyPort !== undefined && proxy.proxyPort !== '') {
        const port = Number(proxy.proxyPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('INVALID_PROXY_PORT', 'The configured proxy port is invalid');
        url.port = String(port);
      }
      config.proxyUrl = url.origin;
      config.proxyUsername = String(proxy.proxyAccount || '');
      config.proxyPassword = String(proxy.proxyPassword || '');
    }
    return { config, origin: server.origin, binding };
  }

  initializeAuth() {
    if (this.disposed) return Promise.reject(failure('DISPOSED', 'The conference renderer bridge was disposed'));
    if (this.logoutPromise) return Promise.reject(failure('LOGOUT_PENDING', 'The native meeting session is being cleaned up'));
    const intent = this.intent;
    if (this.setupPromise && this.setupIntent === intent) return this.setupPromise;
    const pending = (async () => {
      const { config, origin, binding } = await this.configuration();
      if (intent !== this.intent) throw failure('SESSION_CHANGED', 'Authentication configuration was retired');
      const encoded = JSON.stringify(config);
      const fingerprint = crypto.createHash('sha256').update(encoded).digest('hex');
      if (fingerprint === this.configHash) return { result: 0, authConfigured: true };
      if (this.configHash) {
        const report = await this.cleanupSession();
        if (report.result !== 0) throw failure('SESSION_CLEANUP_UNCONFIRMED', 'The prior meeting session did not finish cleanup', report);
      }
      if (intent !== this.intent) throw failure('SESSION_CHANGED', 'Authentication configuration was retired');
      const result = binding.initializeAuth(encoded);
      if (result !== 0) throw failure(result, 'Native meeting authentication configuration failed');
      this.configHash = fingerprint;
      this.managementConfig = Object.freeze(JSON.parse(encoded));
      this.origin = origin;
      return { result: 0, authConfigured: true };
    })();
    this.setupIntent = intent;
    this.setupPromise = pending;
    pending.finally(() => { if (this.setupPromise === pending) this.setupPromise = null; }).catch(() => {});
    return pending;
  }

  requestNative(method, args, notification, { timeout = 45000, cleanupRequest = false } = {}) {
    const generation = this.generation;
    const intent = this.intent;
    return new Promise((resolve, reject) => {
      let done = false, ack, completion;
      const cleanup = () => {
        clearTimeout(timer);
        this.nativeRequests.delete(cancel);
        this.sdk.removeNotify(notification, receive);
      };
      const finish = (error, value) => {
        if (done) return;
        done = true; cleanup();
        if (error) reject(error); else resolve(value);
      };
      const cancel = (error = failure('SESSION_CHANGED', 'The native meeting authentication session changed')) => finish(error);
      const receive = value => {
        if (generation !== this.generation || (!cleanupRequest && intent !== this.intent)) { cancel(); return; }
        completion = value;
        if (ack) finish(null, completion);
      };
      const timer = setTimeout(() => finish(failure('NATIVE_TIMEOUT', 'The native meeting operation did not complete')), timeout);
      this.nativeRequests.add(cancel);
      // The vendor dispatcher supports additive listeners. Retiring one bridge
      // must never erase an application listener or a replacement's waiter.
      this.sdk.setMultiNotifyFunc(notification, receive);
      Promise.resolve().then(() => {
        if (done) return;
        this.requireNative();
        if (generation !== this.generation || (!cleanupRequest && intent !== this.intent))
          throw failure('SESSION_CHANGED', 'The native request was retired before dispatch');
        return this.sdk[method](...args);
      }).then(value => {
        if (done) return;
        if (generation !== this.generation || (!cleanupRequest && intent !== this.intent)) { cancel(); return; }
        if (!value || typeof value.result !== 'number') {
          finish(failure('INVALID_NATIVE_ACK', 'The native meeting acknowledgement is malformed')); return;
        }
        ack = value;
        if (value.result !== 0) finish(null, value);
        else if (completion) finish(null, completion);
      }, error => finish(error));
    });
  }

  async authenticate() {
    if (this.loginPromise && this.loginIntent === this.intent) return this.loginPromise;
    const intent = this.intent;
    const pending = (async () => {
      if (this.logoutPromise) await this.logoutPromise;
      if (intent !== this.intent) throw failure('SESSION_CHANGED', 'The authentication request was retired');
      await this.initializeAuth();
      const [user, token] = await Promise.all([
        this.Pedestal.callMethod('method://pedestal/getUserInfo'),
        this.Pedestal.callMethod('method://pedestal/getToken')
      ]);
      if (intent !== this.intent || this.logoutPromise)
        throw failure('SESSION_CHANGED', 'The authentication request was superseded by logout');
      if (!user || typeof user.account !== 'string' || !user.account ||
          !token || typeof token.crypt_token !== 'string' || !token.crypt_token)
        throw failure('PRIMARY_AUTH_REQUIRED', 'A real workplace account and current ticket are required');
      if (this.account && this.account !== user.account) {
        const report = await this.cleanupSession();
        if (report.result !== 0) throw failure('SESSION_CLEANUP_UNCONFIRMED', 'The prior account session did not finish cleanup', report);
        await this.initializeAuth();
      }
      if (intent !== this.intent || this.logoutPromise)
        throw failure('SESSION_CHANGED', 'The authentication request was retired before dispatch');
      const generation = this.generation;
      const result = await this.requestNative('usgLogin', [{ username: user.account, middleGroundToken: token.crypt_token }], 1032);
      if (intent !== this.intent || generation !== this.generation || this.logoutPromise)
        throw failure('SESSION_CHANGED', 'The authentication result belongs to a retired session');
      // The packaged Linux facade returns here before the vendor's Windows/Mac store update.
      this.store.setStore('isServerDowngrade', result.result === 412100044);
      if (result.result === 0) {
        this.account = user.account;
        const voice = await this.ipc.invoke(CHANNEL, { kind: 'voice', operation: 'bind', account: user.account });
        if (intent !== this.intent || generation !== this.generation || this.logoutPromise)
          throw failure('SESSION_CHANGED', 'The voice binding belongs to a retired account');
        if (!voice?.ok || voice.data?.bound !== true)
          throw failure(voice?.error?.code || 'VOICE_BIND_UNCONFIRMED', 'The local voice account could not be bound');
      }
      this.emit('authentication', result);
      return result;
    })();
    this.loginIntent = intent;
    this.loginPromise = pending;
    pending.finally(() => { if (this.loginPromise === pending) this.loginPromise = null; }).catch(() => {});
    return pending;
  }

  rawToken() {
    if (this.tokenPromise) return this.tokenPromise;
    const generation = this.generation;
    const pending = this.requestNative('getMeetingToken', [], 1001, { cleanupRequest: true }).then(reply => {
      if (generation !== this.generation) throw failure('SESSION_CHANGED', 'The token belongs to a retired session');
      const token = reply && reply.param && reply.param.token;
      if (reply.result !== 0 || typeof token !== 'string' || !token)
        throw failure(reply.result || 'TOKEN_UNAVAILABLE', 'The native meeting token is unavailable');
      if (!this.logoutPromise) this.emit('token', token);
      return token;
    }).catch(error => {
      if (!this.disposed && generation === this.generation) this.emit('token', '');
      throw error;
    });
    this.tokenPromise = pending;
    pending.finally(() => { if (this.tokenPromise === pending) this.tokenPromise = null; }).catch(() => {});
    return pending;
  }

  async legacyToken() {
    await this.initializeAuth();
    if (this.logoutPromise) throw failure('LOGOUT_PENDING', 'The native meeting session is being logged out');
    return { result: 0, token: this.window.btoa(await this.rawToken()) };
  }

  async answerToken(request) {
    if (!request || (typeof request.id !== 'string' && typeof request.id !== 'number')) return;
    const generation = this.generation;
    try {
      const token = await this.rawToken();
      if (!this.disposed && generation === this.generation)
        this.ipc.send(TOKEN_REPLY, { id: request.id, token });
    } catch (error) {
      if (!this.disposed && generation === this.generation)
        this.ipc.send(TOKEN_REPLY, { id: request.id, error: { code: error.code || 'TOKEN_UNAVAILABLE' } });
    }
  }

  async answerConfiguration(request) {
    if (!request || typeof request.id !== 'string') return;
    if (this.disposed || this.logoutPromise || !this.managementConfig || !this.registration) {
      this.ipc.send(CONFIG_REPLY, { id: request.id, error: { code: 'CONFIGURATION_UNAVAILABLE' } });
      return;
    }
    if (['p2p', 'offline', 'complaint'].includes(request.purpose)) {
      const { registration, generation, intent, account } = this;
      try {
        let config;
        if (request.purpose === 'complaint') {
          const user = await this.Pedestal.callMethod('method://pedestal/getUserInfo');
          if (!account || user?.account !== account || this.store.getStore('isUserLogined') !== true)
            throw failure('PRIMARY_AUTH_REQUIRED', 'An authenticated workplace account is required to report a participant');
          config = { account, disabled: Boolean(this.window.isRedblue), language:this.window.navigator.language };
        } else
        if (request.purpose === 'p2p') {
          if (!account) throw failure(412100043, 'The meeting account is not logged in');
          const user = await this.Pedestal.callMethod('method://pedestal/getUserInfo');
          const mine = this.store.getStore('myInfo');
          if (user?.account !== account || !mine || (mine.account && mine.account !== account) || !mine.bind_no)
            throw failure(412100043, 'The logged-in calling identity is unavailable');
          config = { self: { number: String(mine.bind_no), name: mine.name || '', thirdUserId: account } };
        } else {
          const env = await this.Pedestal.callMethod('method://pedestal/getEnvInfo');
          config = { ...this.managementConfig, origin: registration.origin, loginAccount: account || '',
            isServerDowngrade: this.store.getStore('isServerDowngrade') === true };
          if (env?.caCertPath) config.caBundle = env.caCertPath;
          if (this.store.getStore('isUserLogined') !== true && !account) {
            config.watermark = { content: '', color: '#999999' }; // Original anonymous watermark configuration.
          } else {
            const list = await this.Pedestal.callMethod('method://pedestal/getMiddleTenantConfig');
            const get = key => Array.isArray(list) && list.find(row => row.k === key)?.v;
            const enabled = get('meeting_watermark.enabled'), mine = this.store.getStore('myInfo');
            if (enabled === '0') config.watermark = { content: '', color: '#999999' };
            else if (enabled && mine?.name) {
              const name = /^zh/i.test(this.window.navigator.language || '') ? mine.name : mine.foreign_name || mine.name;
              config.watermark = { content: name + (get('tenant_watermark_content') === '0' ? String(mine.mobile || '').slice(-4) : mine.account || ''),
                color: get('tenant_watermark_color') || '#999999' };
            }
          }
        }
        if (this.disposed || this.logoutPromise || this.registration !== registration || this.generation !== generation ||
            this.intent !== intent || this.account !== account) throw failure('SESSION_CHANGED', 'Meeting owner changed');
        this.ipc.send(CONFIG_REPLY, { id: request.id, config });
      } catch (error) { this.ipc.send(CONFIG_REPLY, { id: request.id, error: { code: error.code || 'CONFIGURATION_UNAVAILABLE' } }); }
      return;
    }
    if (request.purpose === 'issuer') {
      const { registration, generation, intent } = this;
      try {
        const call = method => this.Pedestal.callMethod('method://pedestal/' + method);
        const [address, env, app, fuseInfo] = await Promise.all([
          call('getMeetingLoginUrl'), call('getEnvInfo'), call('getAppInfo'), call('getRuseInterfaceData')
        ]);
        if (this.disposed || this.logoutPromise || this.generation !== generation || this.intent !== intent ||
            this.registration !== registration || typeof address !== 'string' || !address)
          throw failure('ISSUER_CHANGED', 'The originating service configuration is no longer current');
        const url = new URL(address.includes('://') ? address : 'https://' + address);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
            url.pathname !== '/' || url.origin !== registration.origin)
          throw failure('ISSUER_CHANGED', 'The configured invitation origin differs from the service owner');
        const { proxyAddress, proxyAccount, proxyPassword, proxyPort, caCertPath } = env;
        this.ipc.send(CONFIG_REPLY, { id: request.id, config: { origin: url.origin,
          envInfo: { proxyAddress, proxyAccount, proxyPassword, proxyPort, caCertPath },
          appInfo: { appVersionName: app.appVersionName, appVersionCode: app.appVersionCode }, fuseInfo } });
      } catch (_) { this.ipc.send(CONFIG_REPLY, { id: request.id, error: { code: 'ISSUER_CONTEXT_UNAVAILABLE' } }); }
      return;
    }
    // This is the exact configuration accepted by auth_init, not a fresh
    // environment read that could disagree with the token-owning C instance.
    this.ipc.send(CONFIG_REPLY, { id: request.id, config: this.managementConfig });
  }

  acceptEvent(envelope) {
    if (this.disposed || !envelope || !envelope.message) return;
    if (!this.registration) {
      if (this.registrationEvents) this.registrationEvents.push(envelope);
      return;
    }
    if (envelope.message.instance !== this.registration.instance) return;
    const message = envelope.message;
    if (envelope.kind === 'engine') this.acceptEngine(message);
    else if (envelope.kind === 'event' && message.protocol === PROTOCOL) this.emit('event', message);
  }

  acceptEngine(message) {
    if (this.disposed || this.nativeStopped || !nativeFfi.isStarted('meeting_adapter') ||
        !this.registration || !message || message.instance !== this.registration.instance ||
        message.protocol !== PROTOCOL || !Number.isSafeInteger(message.sequence) ||
        message.sequence < this.engineSequence) return false;
    const previous = nativeEngineState?.instance === message.instance ? nativeEngineState : null;
    if (previous && message.sequence < previous.sequence) return false;
    const accepted = previous && message.sequence === previous.sequence;
    if (accepted) {
      if (message.event !== previous.event || message.sdkVersion !== previous.sdkVersion) return false;
    } else {
      const result = nativeFfi.meetingBindings().webState(JSON.stringify(message));
      if (result !== 0) {
        for (const waiter of this.engineWaiters) waiter.reject(failure(result, 'The native SDK rejected the real engine state'));
        return false;
      }
      nativeEngineState = { instance: message.instance, sequence: message.sequence,
        event: message.event, sdkVersion: message.sdkVersion };
    }
    this.engineSequence = message.sequence;
    this.mediaReady = message.event === 'engine-ready';
    if (this.mediaReady) for (const waiter of this.engineWaiters) waiter.resolve(message);
    // initialize may return the broker's cached genuine ready packet without an
    // IPC event. Reconcile it, but never repeat a native write or engine callback.
    if (!accepted) this.emit('engine', message);
    return true;
  }

  async voiceCommand(operation, value) {
    const generation = this.generation, intent = this.intent;
    const check = () => {
      if (this.disposed || this.logoutPromise || this.generation !== generation || this.intent !== intent)
        throw failure('SESSION_CHANGED', 'The local voice request belongs to a retired account');
    };
    check();
    // Ask the trusted main owner first. Anonymous callers must never fetch an
    // authenticated account merely to display or revoke their local recorder.
    const scoped = await this.ipc.invoke(CHANNEL, { kind: 'voice', operation: 'scope' });
    check();
    if (!scoped?.ok) throw failure(scoped?.error?.code || 'VOICE_SCOPE_UNAVAILABLE', 'The local voice owner is unavailable');
    const anonymous = scoped.data?.scope === 'anonymous-room-memory';
    if (anonymous && typeof scoped.data.roomId !== 'string')
      throw failure('VOICE_ANONYMOUS_ROOM_REQUIRED', 'No current anonymous room owns enrollment');
    let account = null;
    if (!anonymous && operation !== 'configure') {
      const user = await this.Pedestal.callMethod('method://pedestal/getUserInfo');
      check();
      if (!user || typeof user.account !== 'string' || !user.account || (this.account && user.account !== this.account))
        throw failure('PRIMARY_AUTH_REQUIRED', 'The current workplace account is required for local voice settings');
      account = user.account;
    }
    const reply = await this.ipc.invoke(CHANNEL, { kind: 'voice', operation, account, value,
      ...(anonymous ? { anonymousRoom: scoped.data.roomId } : {}) });
    check();
    if (!reply?.ok) throw failure(reply?.error?.code || 'VOICE_COMMAND_FAILED',
      reply?.error?.message || 'Local voice operation failed', reply?.error?.details);
    return reply.data;
  }

  async configureMediaLog(directory) {
    if (this.disposed) throw failure('DISPOSED', 'The conference renderer bridge was disposed');
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.basename(directory) !== 'HwmSdk' ||
        path.basename(path.dirname(directory)) !== 'conference')
      throw failure('INVALID_LOG_DIRECTORY', 'Expected an absolute conference/HwmSdk directory');
    const reply = await this.ipc.invoke(CHANNEL, { kind: 'sdk-log-configure', directory });
    if (reply?.nativeCommand === 1046 && reply.ok === false)
      throw failure(reply.code || 'SDK_LOG_CONFIGURE_FAILED', 'The meeting SDK log destination was not confirmed',
        { changed: reply.changed === true, retiredClosed: reply.retiredClosed === true });
    if (reply?.nativeCommand !== 1046 || reply.ok !== true || reply.configured !== true ||
        reply.retiredClosed !== true || reply.scope !== 'hrtc-media-log')
      throw failure('SDK_LOG_UNCONFIRMED', 'The meeting log owner did not confirm the destination');
    return reply;
  }

  async registerBroker() {
    const intent = this.intent;
    await this.initializeAuth();
    const generation = this.generation;
    const check = () => {
      this.requireNative();
      if (intent !== this.intent || generation !== this.generation || this.logoutPromise)
        throw failure('SESSION_CHANGED', 'The meeting registration was retired');
    };
    check();
    if (this.registration) return this.registration;
    if (this.registrationPromise) return this.registrationPromise;
    const events = [];
    this.registrationEvents = events;
    const request = (async () => {
      const value = await this.Pedestal.callMethod('method://pedestal/getLogStoragePath', { timeout: 5000 });
      check();
      const root = typeof value === 'string' && value ? value : this.Pedestal.logRootPath;
      return this.ipc.invoke(CHANNEL, { kind: 'register', origin: this.origin,
        sdkLogDirectory: path.join(root, 'conference', 'HwmSdk') });
    })().then(registration => {
      if (!registration || registration.protocol !== PROTOCOL || typeof registration.instance !== 'string')
        throw failure('INVALID_BROKER_REPLY', 'The main meeting broker did not return its real instance');
      // Main may already own a browser when logout retires this request. Keep
      // that genuine receipt for cleanup without activating the retired bridge.
      this.registrationReceipt = registration;
      return registration;
    });
    this.registrationRequest = request;
    request.finally(() => {
      if (this.registrationRequest === request) this.registrationRequest = null;
    }).catch(() => {});
    const pending = request.then(registration => {
      check();
      this.registration = registration;
      this.engineSequence = 0;
      if (this.registrationEvents === events) this.registrationEvents = null;
      for (const event of events) this.acceptEvent(event);
      return registration;
    });
    this.registrationPromise = pending;
    pending.finally(() => {
      if (this.registrationPromise === pending) this.registrationPromise = null;
      if (this.registrationEvents === events) this.registrationEvents = null;
    }).catch(() => {});
    return pending;
  }

  linkOperation(operation, params) {
    if (operation !== 'conference.joinLink') return operation;
    if (params?.isOfflineJoin === true || params?.isOfflineJoin === 1 || this.store.getStore('isServerDowngrade') === true)
      return 'conference.joinOffline';
    requireOnlineLinkVariant(params, false);
    return operation;
  }

  async callRegistered(operation, params = {}, registration = this.registration, onReceipt) {
    if (this.disposed) throw failure('DISPOSED', 'The conference renderer bridge was disposed');
    if (!registration) throw failure('NOT_REGISTERED', 'The conference renderer is not registered with main');
    operation = this.linkOperation(operation, params);
    const id = ++this.sequence;
    const reply = await this.ipc.invoke(CHANNEL, { kind: 'call', message: { protocol: PROTOCOL, id, operation, params } });
    if (!reply || reply.protocol !== PROTOCOL || reply.id !== id)
      throw failure('INVALID_BROKER_REPLY', 'The meeting operation reply does not match its request');
    // Disposal also needs main's hostCleanup, including when its provider failed.
    if (onReceipt) onReceipt(reply);
    if (!reply.ok) throw failure(reply.error && reply.error.code || 'MEETING_OPERATION_FAILED',
      reply.error && reply.error.message || 'The real meeting operation failed', reply.error && reply.error.details);
    return reply.data;
  }

  async execute(operation, params = {}) {
    const intent = this.intent;
    this.linkOperation(operation, params);
    await this.initializeAuth();
    const generation = this.generation;
    if (this.logoutPromise) throw failure('LOGOUT_PENDING', 'The meeting session is being logged out');
    await this.registerBroker();
    if (intent !== this.intent || generation !== this.generation || this.logoutPromise)
      throw failure('SESSION_CHANGED', 'The meeting operation was cancelled before dispatch');
    const result = await this.callRegistered(operation, params);
    if (intent !== this.intent || generation !== this.generation || this.logoutPromise)
      throw failure('SESSION_CHANGED', 'The meeting reply belongs to a retired session');
    return result;
  }

  initializeMedia() {
    if (this.mediaPromise && this.mediaIntent === this.intent) return this.mediaPromise;
    const intent = this.intent;
    const pending = (async () => {
      await this.initializeAuth();
      const generation = this.generation;
      if (this.logoutPromise) throw failure('LOGOUT_PENDING', 'The meeting session is being logged out');
      await this.registerBroker();
      if (intent !== this.intent || generation !== this.generation || this.logoutPromise)
        throw failure('SESSION_CHANGED', 'Media initialization was cancelled before dispatch');
      let waiter;
      const ready = this.mediaReady ? Promise.resolve() : new Promise((resolve, reject) => {
        const timer = setTimeout(() => waiter.reject(failure('ENGINE_TIMEOUT', 'The genuine WebRTC engine did not become ready')), 120000);
        waiter = { resolve: value => { clearTimeout(timer); this.engineWaiters.delete(waiter); resolve(value); },
          reject: error => { clearTimeout(timer); this.engineWaiters.delete(waiter); reject(error); } };
        this.engineWaiters.add(waiter);
      });
      ready.catch(() => {});
      try {
        const initializing = this.callRegistered('initialize').then(capabilities => {
          if (intent !== this.intent || generation !== this.generation || this.logoutPromise)
            throw failure('SESSION_CHANGED', 'Media readiness belongs to a retired session');
          if (!capabilities || capabilities.event !== 'engine-ready' || !this.acceptEngine(capabilities) || !this.mediaReady)
            throw failure('ENGINE_STATE_CHANGED', 'The genuine engine readiness receipt is no longer current');
          return capabilities;
        });
        const [capabilities] = await Promise.all([initializing, ready]);
        if (intent !== this.intent || generation !== this.generation || this.logoutPromise)
          throw failure('SESSION_CHANGED', 'Media readiness belongs to a retired session');
        return capabilities;
      } catch (error) {
        if (waiter) waiter.reject(error);
        throw error;
      }
    })();
    this.mediaIntent = intent;
    this.mediaPromise = pending;
    pending.finally(() => { if (this.mediaPromise === pending) this.mediaPromise = null; }).catch(() => {});
    return pending;
  }

  logout() {
    ++this.intent;
    for (const waiter of [...this.engineWaiters])
      waiter.reject(failure('SESSION_CHANGED', 'Media initialization was superseded by logout'));
    return this.cleanupSession();
  }

  cleanupSession() {
    if (this.disposed) return Promise.reject(failure('DISPOSED', 'The conference renderer bridge was disposed'));
    if (this.logoutPromise) return this.logoutPromise;
    const pending = (async () => {
      let browser = null, browserError = null, native = null, nativeError = null;
      let voiceError = null, hostCleanup = null, hostRequired = false;
      try {
        try {
          const voice = await this.ipc.invoke(CHANNEL, { kind: 'voice', operation: 'release' });
          if (!voice?.ok || voice.data?.released !== true)
            throw failure(voice?.error?.code || 'VOICE_RELEASE_UNCONFIRMED', 'Local voice cleanup was not confirmed');
        } catch (error) { voiceError = error; }
        if (this.registrationRequest) {
          try { await this.registrationRequest; }
          catch (error) { browserError = error; }
        }
        const registration = this.registration || this.registrationReceipt;
        if (registration) {
          hostRequired = true;
          try {
            browser = await this.callRegistered('dispose', {}, registration, reply => {
              hostCleanup = reply.hostCleanup;
            });
          }
          catch (error) { browserError = error; browser = error.details || null; }
        }
        // Browser cleanup protects this credential; only the real native logout
        // may revoke it. A failed browser cleanup must not skip that attempt.
        if (this.configHash) {
          try { native = await this.requestNative('usgLogout', [], 1030, { cleanupRequest: true }); }
          catch (error) { nativeError = error; }
        }
      } finally {
        ++this.generation;
        for (const cancel of [...this.nativeRequests]) cancel();
        for (const waiter of [...this.engineWaiters]) waiter.reject(failure('SESSION_CHANGED', 'The conference session was disposed'));
        if (this.configHash && !this.disposed && !this.nativeStopped && nativeFfi.isStarted('meeting_adapter'))
          nativeFfi.meetingBindings().resetAuth();
        this.configHash = null; this.account = null; this.registration = null;
        this.store.setStore('isServerDowngrade', false);
        this.managementConfig = null;
        this.registrationPromise = null; this.mediaReady = false; this.engineSequence = 0;
        this.registrationRequest = null; this.registrationReceipt = null;
        this.tokenPromise = null;
      }
      const browserComplete = !browserError && (!browser || (browser.localCleanupComplete &&
        browser.serverLogout && browser.serverLogout.status !== 'unconfirmed'));
      const nativeComplete = !nativeError && (!native || native.result === 0);
      const hostComplete = !hostRequired || (hostCleanup?.complete === true &&
        Array.isArray(hostCleanup.errors) && hostCleanup.errors.length === 0);
      const hostErrors = hostComplete ? [] : Array.isArray(hostCleanup?.errors) && hostCleanup.errors.length ?
        hostCleanup.errors : [{ code: 'HOST_CLEANUP_UNCONFIRMED',
          message: 'The registered meeting owner did not confirm host cleanup' }];
      const report = { result: browserComplete && nativeComplete && hostComplete && !voiceError ? 0 : 1,
        browser, native, hostCleanup,
        localCleanupComplete: hostComplete && !voiceError && (browser ? browser.localCleanupComplete === true : !browserError),
        errors: [voiceError, browserError, nativeError].filter(Boolean)
          .map(error => ({ code: error.code || 'LOGOUT_UNCONFIRMED', message: error.message })).concat(hostErrors) };
      this.emit('session-cleared', report);
      return report;
    })();
    this.logoutPromise = pending;
    pending.finally(() => { if (this.logoutPromise === pending) this.logoutPromise = null; }).catch(() => {});
    return pending;
  }
}

module.exports = { loadLibrary, createBridge(options) {
  const bridge = new RendererMeetingBridge(options);
  const previous = bridges.get(options.window);
  if (previous) previous.dispose();
  bridges.set(options.window, bridge);
  return bridge;
}, PROTOCOL };
