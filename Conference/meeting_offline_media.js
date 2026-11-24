/* Standalone offline media owner; load vendor/hrtc-12.eb3d2838.js first in a
 * fresh, sandboxed renderer. Never load webrtc-main or an account Redux store.
 *
 * Native ABI evidence (original campus Windows distribution, RVAs):
 * hwm_conf 0x17117f sets the engine appId from signatureInfo.privateAppId;
 * JoinRoomAfterDetect 0x2711d7/0x271500 passes signatureInfo.appId in room info.
 * mmr_sdk 0x73c52 copies the optional room appId; 0x1f3cd..0x1f404 selects the
 * nonempty room value, otherwise configured engine appId. Literal "appid" is
 * NOT special here (the browser application, unlike Windows, replaces it).
 * RTC_TRANS_SetUp 0x76dfe..0x76ef9 omits appid= when the effective value is empty.
 * There is no invented app identity or native early-error code for that case.
 * Pinned HRTC createClient rejects an empty appId with its genuine 90000005
 * INVALID_PARAMETER error. That is a browser SDK limitation, not a fabricated
 * Windows error, and is propagated without a guard bypass or credential.
 * mmr_sdk calls mmr_media MEDIA_CreateSession (0xcb9b9 -> 0x10d1e0),
 * MEDIA_OpenStream (0xcda74 -> 0x10df90), and MEDIA_OpenCapture
 * (0x8ac4d -> 0x10de80) for the negotiated media/device session, not app auth.
 * The HRTC join promise corresponds to onJoinRoomSuccessEx (hwm_conf 0x25ff10),
 * NOT token success.
 * The control owner must still report JoinConfNotify and finish subscriptions.
 */
(function (scope, factory) {
  'use strict';
  const api = factory(scope);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.WelinkOfflineMedia = api;
})(typeof globalThis === 'object' ? globalThis : window, function (scope) {
  'use strict';
  const SDK_VERSION = '1.10.96';
  let packagedSdk;
  let viewSequence = 0;

  function failure(code, message) {
    return Object.assign(new Error(message), { code });
  }
  function errorInfo(error) {
    return {
      code: error && (error.code !== undefined ? error.code :
        typeof error.getCode === 'function' ? error.getCode() : undefined) || 'OFFLINE_MEDIA_ERROR',
      message: String(error && (error.message ||
        typeof error.getMsg === 'function' && error.getMsg()) || error)
    };
  }
  function string(value) { return typeof value === 'string' ? value : ''; }
  function requiredId(value, name) {
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0)
      throw failure('OFFLINE_MEDIA_GRANT_INCOMPLETE', 'Missing admitted ' + name);
    return String(value);
  }
  function loadPackagedSdk() {
    if (packagedSdk) return packagedSdk;
    const chunks = scope.webpackChunkweb_rtc;
    const chunk = Array.isArray(chunks) && chunks.find(entry => entry[1] &&
      typeof entry[1][91012] === 'function');
    if (!chunk) throw failure('OFFLINE_HRTC_NOT_LOADED', 'Load the pinned HRTC chunk in this renderer first');
    const mod = { exports: {} };
    // Module 91012 is the self-contained SDK UMD factory. No application
    // webpack runtime, sagas, account services or global store are involved.
    chunk[1][91012](mod, mod.exports, { g: scope });
    const sdk = mod.exports;
    if (!sdk || sdk.VERSION !== SDK_VERSION || typeof sdk.createClient !== 'function' ||
        typeof sdk.createStream !== 'function')
      throw failure('OFFLINE_HRTC_ABI_CHANGED', 'The packaged HRTC API does not match the pinned offline binding');
    packagedSdk = sdk;
    return sdk;
  }
  function sessionRoute(context) {
    const template = context.offlineJoinTemplate || {};
    const service = context.serviceTp || template.serviceTp || {};
    const sites = Array.isArray(service.siteInfoList) ? service.siteInfoList :
      service.siteInfo1 ? [service.siteInfo1] : [];
    for (const site of sites) {
      const node = site && site.accessStrategy && site.accessStrategy.service_access_node;
      if (node && string(node.rtcUri)) return node.rtcUri;
    }
    return '';
  }
  function parameters(grant, context = {}) {
    if (!grant || !grant.signatureInfo || typeof grant.signatureInfo !== 'object')
      throw failure('OFFLINE_MEDIA_GRANT_INCOMPLETE', 'JOIN_RTC_CONF did not supply signatureInfo');
    if (grant.returnCode !== undefined && Number(grant.returnCode) !== 0)
      throw Object.assign(failure(grant.returnCode, grant.returnDesc || 'RTC admission rejected'), { phase: 'admission' });
    const sig = grant.signatureInfo;
    const participantID = requiredId(grant.participantID || context.participantID, 'participantID');
    const conferenceID = requiredId(grant.conferenceID || context.confID, 'conferenceID');
    const roomId = requiredId(sig.roomId, 'roomId');
    const userId = requiredId(sig.userID, 'RTC userID');
    const role = String(grant.role);
    if (!['0', '1', '2'].includes(role))
      throw failure('OFFLINE_MEDIA_ROLE_UNSUPPORTED', 'The admitted conference role is not supported by HRTC');
    // Native MMR uses strlen, not trim(), and does not special-case "appid".
    // Never borrow serviceTp.rtcInfo.appId from an online/login owner.
    const appId = string(sig.appId) || string(sig.privateAppId);
    const domain = string(sig.domainUrl) || sessionRoute(context);
    if (!domain) throw failure('OFFLINE_MEDIA_ROUTE_MISSING', 'The admitted session has no RTC route');
    let route;
    try { route = new URL(/^[a-z]+:\/\//i.test(domain) ? domain : 'wss://' + domain); }
    catch (_) { throw failure('OFFLINE_MEDIA_ROUTE_UNSUPPORTED', 'The admitted RTC authority is invalid'); }
    if (!['wss:', 'https:'].includes(route.protocol) || route.username || route.password ||
        (route.pathname && route.pathname !== '/') || route.search || route.hash || /[\s\\]/.test(domain))
      throw failure('OFFLINE_MEDIA_ROUTE_UNSUPPORTED', 'HRTC requires a secure RTC host, not a control URL');
    const config = { appId, domain: route.hostname };
    if (sig.mmrID !== undefined) config.mmrID = sig.mmrID;
    const port = sig.port !== undefined && sig.port !== '' ? Number(sig.port) : route.port ? Number(route.port) : undefined;
    // The pinned SDK silently replaces an invalid port with its default. Never
    // turn an explicit admitted authority into a different endpoint that way.
    if (port !== undefined) {
      if (!Number.isInteger(port) || port < 443 || port > 65535)
        throw failure('OFFLINE_MEDIA_ROUTE_UNSUPPORTED', 'The admitted RTC port is not supported by HRTC');
      config.port = port;
    }
    if (sig.extendPayload !== undefined && sig.extendPayload !== '') config.extendPayload = sig.extendPayload;
    const join = { userId, userName: string(context.displayName), role: role === '2' ? 2 : 0,
      ctime: sig.cTime, signature: sig.signature };
    const identity = context.identity || {};
    if (identity.orgID) join.corpId = identity.orgID;
    return { config, join, roomId, userId, participantID, conferenceID, role,
      direct: !!sig.localMedia,
      appIdSource: string(sig.appId) ? 'signatureInfo.appId' :
        string(sig.privateAppId) ? 'signatureInfo.privateAppId' : 'native-empty',
      routeSource: string(sig.domainUrl) ? 'signatureInfo.domainUrl' : 'session-serviceTp' };
  }

  function create(options = {}) {
    const sdk = options.sdk || loadPackagedSdk();
    let active = null;
    let last = { state: 'idle', roomJoined: false, connection: 'DISCONNECTED', source: 'offline-hrtc' };
    let disposed = false;
    let sequence = 0;
    const root = options.root || null;
    const viewId = 'welink-offline-' + (++viewSequence);
    let ui;
    const voiceMedia = options.voiceHost ? scope.__welinkInstallVoiceMedia({
      host: options.voiceHost, getLocalStream: () => active?.voiceStream || active?.local, getClient: () => active?.client
    }) : null;
    let voiceUnavailable = false;

    function current(session) {
      return active === session && !session.retired && !disposed &&
        !(session.context.signal && session.context.signal.aborted) &&
        (!session.context.isCurrent || session.context.isCurrent());
    }
    function ensureCurrent(session) {
      if (!current(session)) throw failure('OFFLINE_MEDIA_RETIRED', 'The offline media session has been retired');
    }
    function snapshot() {
      const session = active;
      if (!session) return { ...last };
      let connection = 'DISCONNECTED';
      if (session.client) connection = session.client.getConnectionState();
      if (session.connection) connection = session.connection;
      const audio = session.local && session.local.getAudioTrack();
      const video = session.local && session.local.getVideoTrack();
      return { state: session.state, roomJoined: session.roomJoined && !session.retired,
        connection, source: 'offline-hrtc', sequence: session.sequence,
        conferenceID: session.params.conferenceID, participantID: session.params.participantID,
        roomId: session.params.roomId, userId: session.params.userId, role: session.params.role,
        microphone: !!(session.devices.microphone && audio && audio.readyState === 'live' && audio.enabled),
        camera: !!(session.devices.camera && video && video.readyState === 'live' && video.enabled),
        audioPublished: !!(session.local && audio && audio.readyState === 'live'),
        videoPublished: !!(session.local && video && video.readyState === 'live'),
        microphoneId: session.devices.microphoneId, cameraId: session.devices.cameraId,
        speakerId: session.devices.speakerId, microphoneLocked: session.locks.microphone,
        cameraLocked: session.locks.camera, remoteStreams: session.remote.size,
        voiceProtection: voiceMedia ? voiceMedia.state() : null,
        error: session.error || null };
    }
    function emit(event, data) {
      if (typeof options.emit === 'function') {
        try { Promise.resolve(options.emit(event, data)).catch(() => {}); } catch (_) {}
      }
    }
    function pulse(session, state) {
      voiceMedia?.pulse();
      if (state) session.state = state;
      last = snapshot();
      emit('offline-media-state', last);
      if (ui) {
        ui.status.textContent = last.error ? last.error.message :
          'Media: ' + last.state + ' · ' + last.connection;
        const connected = last.roomJoined && last.connection === 'CONNECTED';
        ui.microphone.textContent = last.microphone ? 'Mute microphone' : 'Enable microphone';
        ui.camera.textContent = last.camera ? 'Turn camera off' : 'Turn camera on';
        ui.microphone.disabled = !connected || last.microphoneLocked;
        ui.camera.disabled = !connected || last.cameraLocked;
      }
    }
    function report(session, error, phase, fatal = false) {
      const data = { ...errorInfo(error), phase, fatal, sequence: session.sequence,
        conferenceID: session.params.conferenceID, participantID: session.params.participantID };
      session.error = data;
      emit('offline-media-failure', data);
      pulse(session);
      return data;
    }
    function listen(session, source, event, handler) {
      source.on(event, handler);
      session.listeners.push(() => source.off(event, handler));
    }
    function closeStream(stream) {
      if (stream) stream.close();
    }
    function stopCapture(session) {
      for (const stream of session.captures) {
        try { closeStream(stream); } catch (error) { report(session, error, 'capture-close'); }
      }
      session.devices.microphone = false;
      session.devices.camera = false;
    }
    async function shutdown(session, reason) {
      if (session.closing) return session.closing;
      session.retired = true;
      stopCapture(session);
      pulse(session, 'leaving');
      session.closing = (async () => {
        if (session.context.signal && session.abort)
          session.context.signal.removeEventListener('abort', session.abort);
        for (const remove of session.listeners.splice(0)) remove();
        const errors = [];
        if (voiceMedia) {
          try { await voiceMedia.configure(voiceMedia.state().enabled, true); }
          catch (error) { errors.push(errorInfo(error)); }
        }
        // join can still be dispatching before HRTC will accept leave(). Its
        // genuine SDK operation must settle before retirement can be reported.
        if (session.sdkJoin) await session.sdkJoin.catch(() => {});
        await session.deviceQueue.catch(() => {});
        stopCapture(session);
        for (const entry of session.remote.values()) {
          try { closeStream(entry.stream); } catch (error) { errors.push(errorInfo(error)); }
          if (entry.element) entry.element.remove();
        }
        session.remote.clear();
        let leaveConfirmed = false;
        if (session.client && session.client.getConnectionState() !== 'DISCONNECTED') {
          try { await session.client.leave(); leaveConfirmed = true; }
          catch (error) { errors.push(errorInfo(error)); }
        }
        session.roomJoined = false;
        const sdkConnection = session.client ? session.client.getConnectionState() : 'DISCONNECTED';
        // Pinned HRTC DM.leaveImpl resolves only after correlated BYE and
        // cleanup(): socket close, peer-connection destruction and stream reset.
        // cleanup deliberately suppresses onclose and leaves getConnectionState
        // cached as CONNECTED. Its successful leave promise is the terminal
        // receipt; that stale getter must not turn a real leave into failure.
        const connection = leaveConfirmed ? 'DISCONNECTED' : sdkConnection;
        session.connection = connection;
        if (connection !== 'DISCONNECTED')
          errors.push({ code: 'OFFLINE_RETIREMENT_INCOMPLETE', message: 'HRTC did not disconnect; destroy this scoped renderer' });
        const receipt = { ...snapshot(), state: errors.length ? 'retirement-failed' : 'left',
          roomJoined: false, connection, sdkConnection, leaveConfirmed, reason, retired: true, errors };
        if (active === session) {
          last = receipt;
          if (errors.length) disposed = true;
          active = null;
          if (ui) ui.local.replaceChildren();
          emit('offline-media-state', receipt);
          if (ui) {
            ui.status.textContent = errors.length ? 'Media retirement failed; close this window' : 'Media disconnected';
            ui.microphone.disabled = true;
            ui.camera.disabled = true;
          }
        }
        return receipt;
      })();
      return session.closing;
    }
    function terminal(session, error, phase) {
      if (!current(session) || session.failing) return;
      session.failing = true;
      report(session, error, phase, true);
      const notified = session.context.onFailure;
      // Retire immediately even when the host's control socket has disappeared.
      shutdown(session, phase).then(() => {
        if (typeof notified === 'function') {
          try { Promise.resolve(notified(error)).catch(() => {}); } catch (_) {}
        }
      });
    }
    function remoteKey(stream) { return String(stream.getUserId()) + ':' + stream.getType(); }
    function streamEntry(session, stream) {
      const key = remoteKey(stream);
      let entry = session.remote.get(key);
      if (!entry) {
        let element;
        if (ui) {
          const card = ui.document.createElement('section');
          const label = ui.document.createElement('div');
          label.className = 'offline-media-label';
          label.textContent = String(stream.getUserId()) + (stream.getType() === 'auxiliary' ? ' · screen' : '');
          element = ui.document.createElement('div');
          element.className = 'offline-media-player';
          element.id = viewId + '-remote-' + (++session.viewSequence);
          card.append(element, label);
          ui.remote.append(card);
          entry = { stream, element: card, playerId: element.id, playing: false, pending: Promise.resolve() };
        } else entry = { stream, playing: false, pending: Promise.resolve() };
        session.remote.set(key, entry);
      } else entry.stream = stream;
      return entry;
    }
    async function applySpeaker(entry, deviceId) {
      if (!entry.element) {
        if (deviceId) throw failure('OFFLINE_AUDIO_OUTPUT_UNAVAILABLE', 'No renderer audio output is attached');
        return;
      }
      // HRTC 1.10.96's setAudioOutput discards the native setSinkId promise.
      // Await the actual HTML media sinks instead of reporting that wrapper as
      // successful while a real output selection may have been rejected.
      for (const element of entry.element.querySelectorAll('audio,video')) {
        if (typeof element.setSinkId !== 'function') {
          if (deviceId) throw failure('OFFLINE_AUDIO_OUTPUT_UNAVAILABLE', 'This renderer cannot select an audio output');
        } else await element.setSinkId(deviceId);
      }
    }
    async function playRemote(session, entry) {
      ensureCurrent(session);
      if (!entry.playerId || session.remote.get(remoteKey(entry.stream)) !== entry) return;
      await entry.stream.play(entry.playerId, { objectFit: 'contain', muted: false });
      ensureCurrent(session);
      if (session.remote.get(remoteKey(entry.stream)) !== entry) return;
      if (session.devices.speakerId) await applySpeaker(entry, session.devices.speakerId);
      entry.playing = true;
      pulse(session);
      emit('offline-media-streams', { sequence: session.sequence, remoteStreams: session.remote.size });
    }
    function subscribe(session, event) {
      if (!current(session) || !event || !event.stream) return;
      const entry = streamEntry(session, event.stream);
      entry.pending = entry.pending.catch(() => {}).then(async () => {
        if (session.sdkJoin) await session.sdkJoin;
        ensureCurrent(session);
        if (session.remote.get(remoteKey(entry.stream)) !== entry) return;
        await session.client.subscribe(entry.stream, { audio: true, video: true });
      }).catch(error => { if (current(session)) report(session, error, 'receive'); });
    }
    function bindClient(session) {
      const client = session.client;
      listen(session, client, 'connection-state-changed', event => {
        if (!current(session)) return;
        const connection = event && event.curState || client.getConnectionState();
        // HRTC emits this event before updating getConnectionState().
        session.connection = connection;
        if (connection === 'DISCONNECTED') {
          terminal(session, failure('OFFLINE_RTC_DISCONNECTED', 'The admitted media connection disconnected'), 'connection');
        } else if (session.roomJoined) {
          pulse(session, connection === 'CONNECTED' ? 'reconnected' : 'reconnecting');
        } else pulse(session);
      });
      listen(session, client, 'client-banned', event => terminal(session,
        failure('OFFLINE_RTC_BANNED', 'The media server removed this participant' +
          (event && event.reason ? ': ' + String(event.reason) : '')), 'server-removal'));
      listen(session, client, 'signature-expired', () => terminal(session,
        failure('OFFLINE_RTC_SIGNATURE_EXPIRED', 'The media admission signature expired'), 'signature'));
      listen(session, client, 'error', error => {
        if (current(session)) report(session, error, 'sdk');
      });
      listen(session, client, 'stream-added', event => subscribe(session, event));
      listen(session, client, 'stream-updated', event => subscribe(session, event));
      listen(session, client, 'stream-subscribed', event => {
        if (!current(session) || !event || !event.stream) return;
        const entry = session.remote.get(remoteKey(event.stream));
        if (!entry) return;
        entry.stream = event.stream;
        entry.pending = entry.pending.catch(() => {}).then(() => playRemote(session, entry))
          .catch(error => { if (current(session)) report(session, error, 'playback'); });
      });
      listen(session, client, 'stream-removed', event => {
        if (!current(session) || !event || !event.stream) return;
        const key = remoteKey(event.stream);
        const entry = session.remote.get(key);
        if (!entry) return;
        session.remote.delete(key);
        try { closeStream(entry.stream); } catch (error) { report(session, error, 'receive-close'); }
        if (entry.element) entry.element.remove();
        pulse(session);
      });
    }
    function deviceRequest(request = {}) {
      const session = active;
      if (!session || !session.roomJoined || !current(session))
        return Promise.reject(failure('OFFLINE_MEDIA_NOT_JOINED', 'No admitted offline media room'));
      for (const [key, value] of Object.entries(request)) {
        const boolean = key === 'microphone' || key === 'camera';
        if (boolean ? typeof value !== 'boolean' :
            !['microphoneId', 'cameraId', 'speakerId'].includes(key) || typeof value !== 'string')
          return Promise.reject(new TypeError('Invalid offline device setting: ' + key));
        if (boolean && value && session.locks[key])
          return Promise.reject(failure('OFFLINE_DEVICE_LOCKED', 'The conference does not permit enabling this device'));
      }
      // Disable tracks synchronously, including while an earlier device request
      // is awaiting the browser permission prompt or a signaling response.
      for (const stream of session.captures) {
        if (request.microphone === false) {
          stream.muteAudio();
          const track = stream.getAudioTrack();
          if (track) track.stop();
        }
        if (request.camera === false) {
          stream.muteVideo();
          const track = stream.getVideoTrack();
          if (track) track.stop();
        }
      }
      pulse(session);
      Object.assign(session.desired, request);
      const revision = ++session.deviceRevision;
      const work = session.deviceQueue.catch(() => {}).then(async () => {
        ensureCurrent(session);
        if (revision !== session.deviceRevision) return snapshot();
        const desired = { ...session.desired };
        if (desired.microphone && session.locks.microphone || desired.camera && session.locks.camera)
          throw failure('OFFLINE_DEVICE_LOCKED', 'The conference does not permit enabling this device');
        // An off request stops tracks immediately even if its queued revision
        // is superseded by on. Cached device flags alone cannot prove liveness.
        const audio = session.local && session.local.getAudioTrack();
        const video = session.local && session.local.getVideoTrack();
        const changed = ['microphone', 'camera', 'microphoneId', 'cameraId'].some(key =>
          desired[key] !== session.devices[key]) ||
          !!(desired.microphone || desired.camera) !== !!session.local ||
          (desired.microphone && (!audio || audio.readyState !== 'live' || !audio.enabled)) ||
          (desired.camera && (!video || video.readyState !== 'live' || !video.enabled));
        if (changed) {
          const old = session.local;
          session.local = null;
          if (old) {
            try { await session.client.unpublish(old); }
            finally { closeStream(old); session.captures.delete(old); }
          }
          session.devices.microphone = false;
          session.devices.camera = false;
          ensureCurrent(session);
          if (revision !== session.deviceRevision) return snapshot();
          if (desired.microphone || desired.camera) {
            const stream = sdk.createStream({ userId: session.params.userId,
              audio: desired.microphone, video: desired.camera,
              microphoneId: desired.microphoneId || undefined, cameraId: desired.cameraId || undefined });
            // Select and guard before initialize, not after publish: the SDK may
            // expose its first captured samples during either operation.
            session.voiceStream = stream; // guard ownership, not a publication receipt
            if (voiceMedia) voiceMedia.guardStream(stream);
            session.captures.add(stream);
            let published = false;
            try {
              const initialized = await stream.initialize();
              ensureCurrent(session);
              if (revision !== session.deviceRevision) { closeStream(stream); session.captures.delete(stream); return snapshot(); }
              if (initialized && typeof initialized.getCode === 'function' && initialized.getCode() !== 0)
                throw initialized;
              if (desired.microphone && !stream.hasAudioTrack() || desired.camera && !stream.hasVideoTrack())
                throw failure('OFFLINE_DEVICE_CAPTURE_INCOMPLETE', 'HRTC did not acquire every requested device');
              await session.client.publish(stream);
              published = true;
              ensureCurrent(session);
              if (revision !== session.deviceRevision) {
                try { await session.client.unpublish(stream); } finally { closeStream(stream); session.captures.delete(stream); }
                return snapshot();
              }
              session.local = stream;
              if (ui && desired.camera) await stream.play(ui.local.id, { muted: true, mirror: true, objectFit: 'contain' });
              Object.assign(session.devices, { ...desired, speakerId: session.devices.speakerId });
            } catch (error) {
              closeStream(stream);
              if (published && current(session)) {
                try { await session.client.unpublish(stream); }
                catch (cleanupError) { report(session, cleanupError, 'publish-retirement'); }
              }
              session.captures.delete(stream);
              if (session.local === stream) session.local = null;
              throw error;
            } finally {
              if (session.voiceStream === stream) session.voiceStream = null;
            }
          } else Object.assign(session.devices, { ...desired, speakerId: session.devices.speakerId });
        }
        ensureCurrent(session);
        if (desired.speakerId !== session.devices.speakerId || desired.speakerId) {
          for (const entry of session.remote.values()) await applySpeaker(entry, desired.speakerId);
          session.devices.speakerId = desired.speakerId;
        }
        session.error = null;
        pulse(session);
        return snapshot();
      });
      session.deviceQueue = work;
      return work.catch(error => {
        if (current(session)) report(session, error, 'devices');
        throw error;
      });
    }
    function setDevice(kind, enabled, policy = {}) {
      if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('Device state must be boolean'));
      const session = active;
      if (!session) return Promise.reject(failure('OFFLINE_MEDIA_NOT_JOINED', 'No admitted offline media room'));
      if (typeof policy.locked === 'boolean') session.locks[kind] = policy.locked;
      return deviceRequest({ [kind]: enabled });
    }
    async function setRole(role) {
      role = String(role);
      if (!['0', '1', '2'].includes(role)) throw failure('OFFLINE_MEDIA_ROLE_UNSUPPORTED', 'Unknown server role');
      const session = active;
      if (!session || !session.roomJoined) throw failure('OFFLINE_MEDIA_NOT_JOINED', 'No current media room for server role update');
      ensureCurrent(session);
      const previous = session.params.role;
      if (role === '2') {
        session.locks.microphone = session.locks.camera = true;
        await deviceRequest({ microphone: false, camera: false });
        ensureCurrent(session);
      }
      if ((previous === '2') !== (role === '2')) {
        await session.client.switchRole(role === '2' ? 2 : 0);
        ensureCurrent(session);
      }
      session.params.role = role;
      session.locks.microphone = session.locks.camera = role === '2';
      pulse(session);
      return snapshot();
    }
    async function enumerateDevices() {
      if (!scope.navigator || !scope.navigator.mediaDevices)
        throw failure('OFFLINE_DEVICE_API_UNAVAILABLE', 'Media devices are unavailable in this renderer');
      const devices = await scope.navigator.mediaDevices.enumerateDevices();
      const result = devices.map(device => ({ deviceId: device.deviceId, label: device.label, kind: device.kind }));
      emit('offline-media-devices', { devices: result });
      if (ui) for (const [kind, select] of Object.entries(ui.selects)) {
        const selected = select.value;
        select.replaceChildren();
        const system = ui.document.createElement('option');
        system.value = '';
        system.textContent = 'System default';
        select.append(system);
        for (const device of result.filter(item => item.kind === kind)) {
          const option = ui.document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || kind;
          select.append(option);
        }
        select.value = selected;
      }
      return result;
    }
    async function join(grant, context = {}) {
      if (disposed) throw failure('OFFLINE_MEDIA_DISPOSED', 'The media owner is disposed');
      if (active) throw failure('OFFLINE_MEDIA_BUSY', 'Retire the previous media room before joining another');
      const params = parameters(grant, context);
      const session = { params, context, sequence: ++sequence, viewSequence: 0, state: 'joining',
        roomJoined: false, retired: false, client: null, sdkJoin: null,
        listeners: [], captures: new Set(), remote: new Map(), local: null, voiceStream: null,
        deviceQueue: Promise.resolve(), deviceRevision: 0,
        devices: { microphone: false, camera: false, microphoneId: '', cameraId: '', speakerId: '' },
        locks: { microphone: params.join.role === 2, camera: params.join.role === 2 } };
      session.desired = { ...session.devices };
      active = session;
      try {
        ensureCurrent(session);
        pulse(session);
        // These SDK settings are local to this fresh renderer, not an account.
        sdk.setAllowKeyLog(false);
        sdk.setParameter('accessStrategy', params.direct ? 'direct' : 'dispatch');
        session.client = sdk.createClient(params.config);
        if (voiceMedia) {
          const publish = session.client.publish;
          session.client.publish = function (stream, ...args) {
            voiceMedia.beforePublish(this, stream);
            return publish.call(this, stream, ...args);
          };
          if (voiceMedia.state().enabled) await voiceMedia.configure(true, voiceUnavailable);
        }
        bindClient(session);
        session.abort = () => { shutdown(session, 'cancelled'); };
        if (context.signal) context.signal.addEventListener('abort', session.abort, { once: true });
        ensureCurrent(session);
        session.sdkJoin = Promise.resolve(session.client.join(params.roomId, params.join));
        await session.sdkJoin;
        session.roomJoined = true;
        ensureCurrent(session);
        if (session.client.getConnectionState() !== 'CONNECTED')
          throw failure('OFFLINE_MEDIA_NOT_CONNECTED', 'HRTC admission completed without a connected media session');
        session.connection = 'CONNECTED';
        pulse(session, 'room-joined');
        if (params.join.role !== 2 && (context.isMicOn === true || context.isCameraOn === true)) {
          try { await deviceRequest({ microphone: context.isMicOn === true, camera: context.isCameraOn === true }); }
          catch (_) { /* Reported above; admission does not imply device permission. */ }
        }
        ensureCurrent(session);
        if (session.client.getConnectionState() !== 'CONNECTED')
          throw failure('OFFLINE_MEDIA_NOT_CONNECTED', 'Media connectivity was lost while preparing the requested devices');
        return { ...snapshot(), appIdSource: params.appIdSource, routeSource: params.routeSource };
      } catch (error) {
        report(session, error, 'join', true);
        await shutdown(session, 'join-failed');
        throw error;
      }
    }
    async function configureVoice(enabled, unavailable) {
      if (!voiceMedia) throw failure('VOICE_MEDIA_UNAVAILABLE', 'The offline microphone guard was not installed');
      voiceUnavailable = unavailable === true;
      const result = await voiceMedia.configure(enabled, unavailable);
      if (active) pulse(active);
      return result;
    }
    async function leave(reason = 'leave') {
      return active ? shutdown(active, reason) : { ...last, alreadyRetired: true };
    }
    async function stats() {
      const session = active;
      if (!session || !session.roomJoined || !current(session))
        throw failure('OFFLINE_MEDIA_NOT_JOINED', 'No admitted offline media room');
      const [sent, received] = await Promise.all([
        session.client.getLocalAudioStats(), session.client.getRemoteAudioStats()
      ]);
      ensureCurrent(session);
      // These are the SDK's genuine RTCRtpSender/Receiver counters, not device
      // flags or a WebSocket connection. Do not expose device IDs or SDP.
      const audio = { bytesSent: 0, packetsSent: 0, bytesReceived: 0, packetsReceived: 0 };
      for (const values of sent.values()) {
        audio.bytesSent += Number(values.bytesSent) || 0;
        audio.packetsSent += Number(values.packetsSent) || 0;
      }
      for (const values of received.values()) {
        audio.bytesReceived += Number(values.bytesReceived) || 0;
        audio.packetsReceived += Number(values.packetsReceived) || 0;
      }
      return { sequence: session.sequence, roomJoined: session.roomJoined, audio };
    }
    async function dispose() {
      const receipt = await leave('dispose');
      disposed = true;
      if (scope.navigator && scope.navigator.mediaDevices)
        scope.navigator.mediaDevices.removeEventListener('devicechange', devicesChanged);
      if (root) root.replaceChildren();
      return receipt;
    }
    function devicesChanged() {
      enumerateDevices().catch(error => { if (active) report(active, error, 'device-enumeration'); });
    }
    function userAction(action) {
      Promise.resolve().then(action).then(state => {
        if (typeof options.onLocalDevicesChanged === 'function') return options.onLocalDevicesChanged(state);
      }).catch(error => {
        if (ui) ui.status.textContent = errorInfo(error).message;
      });
    }
    if (root) {
      if (typeof options.onLeaveRequested !== 'function')
        throw new TypeError('The media UI needs the control owner onLeaveRequested callback');
      const doc = root.ownerDocument;
      root.classList.add('welink-offline-media');
      root.replaceChildren();
      const status = doc.createElement('p');
      status.setAttribute('role', 'status');
      status.textContent = 'Waiting for conference admission';
      const local = doc.createElement('div');
      local.id = viewId + '-local';
      local.className = 'offline-media-player offline-media-local';
      const remote = doc.createElement('div');
      remote.className = 'offline-media-remote';
      const controls = doc.createElement('div');
      controls.className = 'offline-media-controls';
      const microphone = doc.createElement('button');
      microphone.textContent = 'Enable microphone';
      microphone.disabled = true;
      microphone.addEventListener('click', () => userAction(() => setDevice('microphone', !snapshot().microphone)));
      const camera = doc.createElement('button');
      camera.textContent = 'Turn camera on';
      camera.disabled = true;
      camera.addEventListener('click', () => userAction(() => setDevice('camera', !snapshot().camera)));
      const leaveButton = doc.createElement('button');
      leaveButton.textContent = 'Leave conference';
      leaveButton.addEventListener('click', () => {
        Promise.resolve().then(options.onLeaveRequested).catch(error => { status.textContent = errorInfo(error).message; });
      });
      const selects = {};
      for (const [kind, field, label] of [['audioinput', 'microphoneId', 'Microphone'],
        ['videoinput', 'cameraId', 'Camera'], ['audiooutput', 'speakerId', 'Speaker']]) {
        const wrapper = doc.createElement('label');
        wrapper.textContent = label;
        const select = doc.createElement('select');
        select.addEventListener('change', () => userAction(() => deviceRequest({ [field]: select.value })));
        wrapper.append(select);
        selects[kind] = select;
        controls.append(wrapper);
      }
      controls.append(microphone, camera, leaveButton);
      root.append(status, local, remote, controls);
      ui = { document: doc, local, remote, status, microphone, camera, selects };
    }
    if (scope.navigator && scope.navigator.mediaDevices)
      scope.navigator.mediaDevices.addEventListener('devicechange', devicesChanged);
    if (ui) devicesChanged();
    return Object.freeze({ join, leave, dispose, snapshot, stats, enumerateDevices, setDevices: deviceRequest, configureVoice, setRole,
      voiceState: () => voiceMedia ? voiceMedia.state() : null,
      setMicrophone: (enabled, policy) => setDevice('microphone', enabled, policy),
      setCamera: (enabled, policy) => setDevice('camera', enabled, policy) });
  }
  return Object.freeze({ create, parameters, loadPackagedSdk, SDK_VERSION });
});
