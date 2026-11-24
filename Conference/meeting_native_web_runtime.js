/* Runs in the isolated Huawei WebRTC page's MAIN world, without Node access.
 * This adapter is deliberately pinned to the inspected vendor application ABI.
 * A changed bundle fails closed; it must not silently dispatch guessed actions.
 * All media work is performed by Huawei's real HRTC SDK and conference sagas.
 */
(() => {
  'use strict';
  if (window.__welinkNativeMeeting) return;
  const ABI_ASSET = '/webrtc/static/js/main.3ee85ed7.js';
  const SDK_VERSION = '1.10.96';
  const MODULE = Object.freeze({ store: 36176, selectors: 53765, constants: 62467,
    actions: 65113, view: 491, sharing: 55375, rtc: 69062, sdk: 91012,
    effects: 14573, socket: 38746, utils: 40904, locale: 45264, join: 76323, invitation: 2500, common: 58909 });
  const host = window.__welinkMeetingHost;
  let vendor, sdk, initialized = false, disposed = false, unsubscribe;
  let disposeInviteOwner;
  let p2pWatch = null;
  const finishedP2pInvites = new Set();
  let sdkLog;
  let voiceMedia;
  let voiceScope = 'local-account';
  let customBackground, customBackgroundPolicy;
  let previousSnapshot = '';
  let sequence = 0;
  let queue = Promise.resolve();
  const waiters = new Set();
  const observedClients = new Map();
  const published = new WeakSet();
  const completedLeaves = new WeakSet();
  const failures = [];
  let capture, captureEnvironment, vendorDisplayMedia, nativeDisplayMedia, displayMediaHook;
  let captureSdk, pendingScreen, lastCaptureError = null;
  let invitedShareGuard;
  let screenCancellationEpoch = 0;
  let recording, recordingControl, pendingRecordingStart, pendingRecordingPermission;
  let recordingTip;
  let nativeCapabilities, moderation;
  let recordingCancellationEpoch = 0, lastRecordingError = null;
  let captureSession = 0, captureClient = null, captureJoined = false;
  const managedAux = new Map();
  const stoppingAux = new Map();
  const unpublishingAux = new Map();
  const publishingAux = new Map();
  const captureListeners = new Set();
  const recordingListeners = new Set();
  let pendingAnonymousJoin = null;
  let watermark, uiPolicy, policyFailure = null, lastPolicyError = null;
  let pendingJoinCompletion = null, lifecycle = null;
  let appSharePermission = false, appShareGrantSession = null, appShareConfigured = false;
  const sessionInstance = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join('');
  const unknownTenantRelation = Object.freeze({ known: false, isOtherCorpConf: null,
    reason: 'NO_VERIFIED_WEB_TENANT_RELATION_FIELD' });

  function policyState() {
    const ui = uiPolicy ? uiPolicy.state() : { configured: false };
    const { configuration, ...publicUi } = ui;
    return { watermark: watermark ? watermark.state() : { state: 'unconfigured', configured: false },
      ui: publicUi, failure: policyFailure };
  }
  function policyViolation(source, error) {
    if (disposed || lastPolicyError === error) return;
    lastPolicyError = error;
    policyFailure = { source, code: error.code || 'POLICY_ENFORCEMENT_LOST',
      message: String(error.message || error), ...(error.details === undefined ? {} : { details: error.details }) };
    if (pendingJoinCompletion) pendingJoinCompletion.cancel(error);
    ++screenCancellationEpoch;
    ++recordingCancellationEpoch;
    if (pendingScreen) pendingScreen.cancel();
    if (pendingRecordingPermission) pendingRecordingPermission.abort();
    if (recording && ['preparing', 'starting', 'recording', 'stopping'].includes(recording.state().state))
      recording.stop().catch(() => {});
    host.emit('policy-violation', policyFailure).catch(() => {});
    pulse();
  }
  function ensurePolicies() {
    if (!watermark || !uiPolicy) fail('POLICY_PROVIDER_UNAVAILABLE', 'The meeting policy providers are not initialized');
    const visual = watermark.ensure('meeting-ui');
    const controls = uiPolicy.ensure();
    if (nativeCapabilities) nativeCapabilities.ensure();
    policyFailure = null;
    lastPolicyError = null;
    return { ready: true, watermark: visual, ui: controls };
  }
  function configurePolicy(operation, params) {
    try {
      const result = operation === 'watermark.set' ? watermark.configure(params) : uiPolicy.configure(params);
      if (operation === 'watermark.set') watermark.ensure('meeting-ui');
      else uiPolicy.ensure();
      // A successful individual setting does not claim that the other policy
      // has been configured. Display/join always call ensurePolicies again.
      pulse();
      return result;
    } catch (error) {
      policyViolation(operation === 'watermark.set' ? 'watermark' : 'ui', error);
      throw error;
    }
  }
  function conferenceInfo(current) {
    const info = vendor.selectors.selectConfInitData(current) || {};
    const basic = vendor.selectors.selectConfBasicInfo(current) || {};
    const result = { source: 'vendor-conf-init-and-basic-info',
      conferenceID: info.conferenceID || '',
      displayConferenceID: vendor.common.getConfDisplayId(info.displayConferenceID, info.conferenceID) || '' };
    // Preserve actual provider fields only. Do not synthesize passwords, URIs,
    // timestamp units, scheduler identity, or cross-tenant permission truth.
    for (const key of ['subject', 'guestJoinUri', 'scheduserName', 'startTime', 'endTime',
      'mediaTypes', 'conferenceType', 'vmrID', 'vmrConferenceID']) {
      if (Object.prototype.hasOwnProperty.call(basic, key)) result[key] = basic[key];
    }
    return result;
  }
  function matchesConference(current, identifier) {
    return String(current.conferenceId) === identifier || String(current.displayConferenceId) === identifier;
  }
  function lifecycleInfo(current) {
    return { sessionKey: current.sessionKey, conferenceId: current.conferenceId,
      displayConferenceId: current.displayConferenceId, conferenceInfo: current.conferenceInfo,
      tenantRelation: current.tenantRelation, participantId: current.participantId,
      role: current.role, selfName: current.selfName,
      connection: current.connection, source: 'hrtc-and-mmr-room-state' };
  }
  function publishLifecycle(current) {
    const client = rtc().rtcClient;
    if (current.joined) {
      const same = lifecycle && lifecycle.conferenceId === current.conferenceId &&
        lifecycle.participantId === current.participantId;
      const event = !same ? 'joined' : !lifecycle.connected ? 'reconnected' : null;
      lifecycle = { ...lifecycleInfo(current), client, connected: true };
      if (event) host.emit('meeting-lifecycle', { state: event, ...lifecycleInfo(current) }).catch(() => {});
    } else if (lifecycle) {
      // A transient RTC reconnect is not a conference leave. Only real SDK
      // leave completion, or disconnected RTC plus cleared MMR membership,
      // retires the active meeting identity.
      if (completedLeaves.has(lifecycle.client) ||
          current.connection === 'DISCONNECTED' && current.roomJoined === false) {
        const previous = lifecycle;
        lifecycle = null;
        host.emit('meeting-lifecycle', { state: 'left', sessionKey: previous.sessionKey,
          conferenceId: previous.conferenceId, participantId: previous.participantId,
          connection: current.connection, source: 'hrtc-and-mmr-room-state' }).catch(() => {});
      } else lifecycle.connected = false;
    }
  }

  function sharingContext(forStart = false) {
    const current = state();
    const media = vendor.selectors.selectRtc(current);
    const own = vendor.selectors.selectOwn(current) || {};
    const policy = vendor.selectors.selectConfDynamicInfo(current) || {};
    const info = vendor.selectors.selectConfInitData(current) || {};
    const mmr = vendor.selectors.selectMmrWs(current) || {};
    const client = media.rtcClient;
    const joined = !!(client && mmr.isJoinRoom && info.participantID &&
      client.getConnectionState() === 'CONNECTED');
    if (joined && (!captureJoined || captureClient !== client)) ++captureSession;
    captureJoined = joined;
    captureClient = client;
    const sessionKey = joined ? 'rtc-' + sessionInstance + '-' + captureSession : null;
    if (appSharePermission && (!joined || appShareGrantSession !== sessionKey)) {
      appSharePermission = false;
      appShareGrantSession = null;
      appShareConfigured = false;
    }
    const constants = vendor.constants;
    let sharingPermission = 'unknown', reason = 'NOT_IN_CONFERENCE';
    if (joined) {
      reason = 'SHARING_PERMISSION_UNKNOWN';
      if (own.role === constants.AUDIENCE) {
        sharingPermission = 'denied';
        reason = 'AUDIENCE_CANNOT_SHARE';
      } else if (own.role === constants.HOST || own.role === constants.GUEST) {
        const multiShare = policy.multiShareType === constants.MULTI_SHARE_TYPES.ALLOW_MULTI_SHARE;
        // The vendor's onShareLockedChanged deliberately leaves an existing
        // collaborative share to server control. Do not invent a revocation.
        const continuingCollaborativeShare = !forStart && media.localAuxStream &&
          published.has(media.localAuxStream) &&
          vendor.selectors.selectEnableCollaborate(current) === constants.ENABLE_COLLABORATE_STATE.ENABLE;
        if (policy.lockSharing === constants.SHARE_LOCKED_STATE.LOCKED &&
            own.role !== constants.HOST && !multiShare && !continuingCollaborativeShare) {
          sharingPermission = 'denied';
          reason = 'SHARING_LOCKED';
        } else if (media.isSharingRemoteAuxStream && !multiShare) {
          // Match startAuxStreamImpl(forceShare:false). freeShare changes the
          // vendor's conflict reason; it is not a guessed local override.
          sharingPermission = 'denied';
          reason = policy.freeShare === constants.FREE_SHARE_TYPE.HOST ?
            'HOST_CONTROLLED_SHARE_ACTIVE' : 'REMOTE_SHARE_ACTIVE';
        } else if (own.role === constants.HOST ||
            policy.lockSharing === constants.SHARE_LOCKED_STATE.UNLOCKED || multiShare || continuingCollaborativeShare) {
          sharingPermission = 'allowed';
          reason = null;
        }
      }
    }
    if (!appSharePermission || appShareGrantSession !== sessionKey) {
      sharingPermission = 'denied';
      reason = appShareConfigured ? 'APP_SCREEN_SHARE_DENIED' : 'APP_SCREEN_SHARE_NOT_CONFIGURED';
    }
    return { sessionKey, joined, sharingPermission, reason, appSharePermission, appShareConfigured,
      appShareGrantSession, localStream: media.localStream, role: own.role,
      lockSharing: policy.lockSharing, freeShare: policy.freeShare, multiShareType: policy.multiShareType };
  }

  function captureFailure(error, stream) {
    lastCaptureError = { code: error.code || 'CAPTURE_OPERATION_FAILED', message: String(error.message || error) };
    recordFailure('capture', stream, error);
  }

  function stopManagedAux(aux) {
    if (stoppingAux.has(aux)) return stoppingAux.get(aux);
    const request = managedAux.get(aux);
    if (!request) return Promise.reject(Object.assign(new Error('Unknown managed screen stream'),
      { code: 'CAPTURE_NOT_OWNED' }));
    request.cancelled = true;
    const completion = waitState(() => !publishingAux.has(aux) && !unpublishingAux.has(aux) &&
      !published.has(aux) && !live(aux.getVideoTrack()),
      'Stopping the genuine screen capture', { methods: ['unpublish'], auxiliary: true });
    const stopping = Promise.resolve().then(async () => {
      try {
        request.abort.abort();
        if (request.capture) capture.stop(request.capture);
        const publishing = publishingAux.get(aux);
        if (publishing) {
          // A rejected publish still needs capture cleanup. Its original promise
          // remains rejected and the start caller retains that real SDK error.
          try { await publishing; }
          catch (error) { request.error = request.error || error; }
        }
        const existing = unpublishingAux.get(aux);
        const media = rtc();
        if (existing) await existing;
        else if (media.localAuxStream === aux && snapshot().joined) {
          // A vendor UI stop may already have closed the tracks and be awaiting
          // its CMS/SDK unpublish. Observe that operation instead of duplicating it.
          if (media.isSharingLocalAuxStream !== false || live(aux.getVideoTrack()) || !published.has(aux))
            await run(vendor.sharing.stopAuxStreamImpl);
        } else {
          await aux.close();
          if (published.has(aux)) await request.client.unpublish(aux);
        }
        pulse();
        await completion;
        if (request.cleanupError) throw request.cleanupError;
        return snapshot();
      } catch (error) {
        completion.cancel(error);
        throw error;
      } finally {
        if (!publishingAux.has(aux) && !unpublishingAux.has(aux) &&
            !published.has(aux) && !live(aux.getVideoTrack())) managedAux.delete(aux);
      }
    });
    // A real SDK promise may outlive the wait-state deadline. Return its
    // timeout as a failure, but keep teardown attached to the genuine promise
    // so a late publication is still unpublished rather than abandoned.
    const result = Promise.race([stopping, completion.then(() => stopping)]);
    stoppingAux.set(aux, result);
    stopping.then(() => {
      stoppingAux.delete(aux);
      pulse();
    }, error => {
      stoppingAux.delete(aux);
      captureFailure(error, aux);
    });
    return result;
  }

  function onCaptureStopped(event) {
    const found = event.auxStream && managedAux.has(event.auxStream) ? event.auxStream :
      Array.from(managedAux.keys()).find(aux => managedAux.get(aux).capture === event.stream);
    if (!found) return;
    if (event.cleanupError) managedAux.get(found).cleanupError = event.cleanupError;
    stopManagedAux(found);
  }

  function assertManagedPublish(stream) {
    invitedShareGuard?.assertPublish(stream);
    const request = managedAux.get(stream);
    if (!request) return;
    if (request.cancelled) fail('CAPTURE_CANCELLED', 'The screen capture was cancelled before publication');
    const context = sharingContext(!published.has(stream));
    if (context.sharingPermission !== 'allowed')
      fail(context.reason, 'Current vendor sharing policy does not permit publication');
    if (request.audio && (!request.capture || capture.inspect(request.capture).sdkAudioBound !== true))
      fail('SCREEN_AUDIO_NOT_BOUND', 'The genuine captured audio is not bound to HRTC');
  }

  async function initializeCapture() {
    requireFunction(host, 'captureEnvironment');
    requireFunction(window, '__welinkCreateNativeWebCapture');
    requireFunction(navigator.mediaDevices, 'getDisplayMedia');
    captureEnvironment = await host.captureEnvironment();
    if (!captureEnvironment || typeof captureEnvironment.nativeDisplayMediaConfigured !== 'boolean' ||
        !['system', 'web-contents', 'unavailable', 'unknown'].includes(captureEnvironment.displayAudio))
      fail('INVALID_CAPTURE_ENVIRONMENT', 'The main process did not describe its actual capture route');
    const media = navigator.mediaDevices;
    vendorDisplayMedia = media.getDisplayMedia;
    const prototype = Object.getPrototypeOf(media);
    nativeDisplayMedia = prototype && typeof prototype.getDisplayMedia === 'function' ?
      prototype.getDisplayMedia : null;
    // The pinned vendor app replaces the instance method with a video-only
    // Linux shim. Preserve it separately; it is NOT native system-audio support.
    capture = window.__welinkCreateNativeWebCapture({
      mediaDevices: media,
      captureDisplay(constraints) {
        if (pendingScreen && pendingScreen.audio && !pendingScreen.audioInputId)
          return nativeDisplayMedia.call(media, constraints);
        return vendorDisplayMedia.call(media, constraints);
      },
      getState: sharingContext,
      subscribe(listener) {
        captureListeners.add(listener);
        return () => captureListeners.delete(listener);
      },
      onCaptureStopped
    });
    displayMediaHook = function (constraints) {
      const permission = sharingContext();
      if (!permission.appSharePermission || !permission.joined)
        return Promise.reject(Object.assign(new Error('The application has not granted screen capture'), { code: 'APP_SCREEN_SHARE_DENIED' }));
      ensurePolicies();
      const request = pendingScreen;
      if (!request || !request.initializing) {
        if (!invitedShareGuard) return vendorDisplayMedia.call(this, constraints);
        return invitedShareGuard.capture(requestId => {
          host.setCaptureRequestOwner(requestId);
          try { return vendorDisplayMedia.call(this, constraints); }
          finally { host.setCaptureRequestOwner(null); }
        });
      }
      return capture.getDisplayMedia(constraints, {
        audioSource: request.audioInputId ? 'audio-input' : 'display',
        deviceId: request.audioInputId, signal: request.abort.signal
      }).then(stream => {
        request.capture = stream;
        return stream;
      });
    };
    media.getDisplayMedia = displayMediaHook;
    function createStream(config) {
      if (config && config.screen) {
        const permission = sharingContext();
        if (!permission.appSharePermission || !permission.joined)
          fail('APP_SCREEN_SHARE_DENIED', 'The application has not granted capture for this session');
        ensurePolicies();
      }
      const request = config && config.screen && pendingScreen;
      if (!request) {
        const stream = sdk.createStream.apply(sdk, arguments);
        if (config?.screen) return invitedShareGuard ? invitedShareGuard.guardStream(stream, rtc().rtcClient) : stream;
        if (moderation) moderation.guardStream(stream);
        customBackground?.guardStream(stream);
        return voiceMedia ? voiceMedia.guardStream(stream) : stream;
      }
      if (request.aux) fail('SCREEN_CAPTURE_IN_PROGRESS', 'A screen stream is already being initialized');
      const stream = sdk.createStream(request.audio ? { ...config, screenAudio: true } : config);
      request.aux = stream;
      managedAux.set(stream, request);
      const originalInitialize = stream.initialize;
      requireFunction(stream, 'initialize');
      requireFunction(stream, 'close');
      stream.initialize = function (...args) {
        stream.initialize = originalInitialize;
        request.initializing = true;
        let result;
        try { result = originalInitialize.apply(this, args); }
        catch (error) { result = Promise.reject(error); }
        return Promise.resolve(result).then(value => {
          if (request.cancelled) fail('CAPTURE_CANCELLED', 'Screen initialization was cancelled');
          if (request.audio) capture.bindScreenAudio(stream);
          return value; // Preserve the genuine SDK initialization result.
        }).catch(async error => {
          request.error = error;
          captureFailure(error, stream);
          if (managedAux.has(stream)) {
            try { await stopManagedAux(stream); }
            catch (cleanupError) { request.cleanupError = cleanupError; }
          }
          throw error;
        }).finally(() => { request.initializing = false; });
      };
      return stream;
    }
    // Vendor sagas select rtc.HRTC for stream creation. Shadow only the factory
    // on that binding; the SDK module can be frozen by the vendor store.
    captureSdk = Object.create(sdk, { createStream: { value: createStream, enumerable: true } });
    vendor.store.dispatch(vendor.actions.setHrtc(captureSdk));
  }

  function screenAudioCapabilities() {
    const context = sharingContext(true);
    const browser = capture.browserCapabilities();
    const mainTrack = context.localStream && context.localStream.getAudioTrack();
    return {
      browser: { nativeDisplayMedia: !!nativeDisplayMedia, exactAudioInputCapture: browser.exactAudioInputCapture,
        audioInputEnumeration: browser.audioInputEnumeration },
      displayCapture: { source: captureEnvironment.displayAudio === 'system' ? 'default-output-monitor' : 'vendor-video-only',
        nativeDisplayMediaConfigured: captureEnvironment.nativeDisplayMediaConfigured,
        nativeAudioScope: captureEnvironment.displayAudio },
      selectedAudioInput: { selectionRequired: true, sourceClassification: 'user-selected-audio-input',
        systemOutputRouting: 'must-be-explicitly-configured-and-selected' },
      vendor: { screenAudioBinding: 'available-in-pinned-hrtc', requiresExistingMainAudioTrack: true },
      permission: { state: context.sharingPermission, reason: context.reason, role: context.role,
        lockSharing: context.lockSharing, freeShare: context.freeShare, multiShareType: context.multiShareType },
      device: { mainAudioTrack: mainTrack ? mainTrack.readyState : 'absent' }
    };
  }

  function recordingCapabilities() {
    const current = recordingSnapshot();
    const capability = recording.capabilities();
    return { browser: capability.browser, permission: capability.permission,
      vendor: recordingControl.capabilities(),
      media: { audioSources: current.audioStreams.length, videoSources: current.videoLayout.length },
      recording: recording.state() };
  }

  function recordingSnapshot() {
    const current = state();
    const media = vendor.selectors.selectRtc(current);
    const info = vendor.selectors.selectConfInitData(current) || {};
    const own = vendor.selectors.selectOwn(current) || {};
    const session = sharingContext();
    const remote = Object.values(media.remoteStreams || {});
    const sources = remote.slice();
    if (media.remoteAuxStream) sources.push(media.remoteAuxStream);
    for (const local of [media.localStream, media.localAuxStream])
      if (local && published.has(local)) sources.push(local);
    const audioStreams = sources.filter(stream => typeof stream.getAudioTrack === 'function' &&
      stream.getAudioTrack()?.readyState === 'live');
    const topN = media.rtcClient && media.rtcClient.audioStreams4TopN;
    if (topN) {
      requireFunction(topN, 'getAudioStreams');
      for (const incoming of topN.getAudioStreams())
        if (incoming.audioMediaStream instanceof MediaStream &&
            incoming.audioMediaStream.getAudioTracks().some(track => track.readyState === 'live'))
          audioStreams.push(incoming.audioMediaStream);
    }
    const videoStreams = [];
    const seen = new Set();
    for (const stream of sources) {
      if (typeof stream.getVideoTrack !== 'function') continue;
      const track = stream.getVideoTrack();
      if (!live(track) || seen.has(track) ||
          typeof stream.isVideoMuted === 'function' && stream.isVideoMuted()) continue;
      seen.add(track);
      videoStreams.push(stream);
    }
    // Record the actual shared content when present; otherwise compose the
    // currently received/published camera tracks. No avatars or synthetic input.
    const shared = videoStreams.find(stream => stream === media.remoteAuxStream) ||
      videoStreams.find(stream => stream === media.localAuxStream);
    const selected = shared ? [shared] : videoStreams;
    const columns = Math.ceil(Math.sqrt(selected.length || 1));
    const rows = Math.ceil(selected.length / columns) || 1;
    return { sessionKey: session.sessionKey, joined: session.joined,
      conferenceId: info.conferenceID, participantId: own.id, actor: ownParticipant(current),
      basicInfo: vendor.selectors.selectConfBasicInfo(current), audioStreams,
      videoLayout: selected.map((stream, index) => ({ stream, x: index % columns / columns,
        y: Math.floor(index / columns) / rows, width: 1 / columns, height: 1 / rows })) };
  }
  let renderWindows, renderSurface;
  function renderOperation(operation, params = {}) {
    if (!renderWindows) {
      if (typeof window.__welinkCreateRenderWindows !== 'function')
        fail('RENDER_PROVIDER_UNAVAILABLE', 'The scoped render provider is not installed');
      renderWindows = window.__welinkCreateRenderWindows({ watermark,
        ensurePolicy: needsImage => {
          const policy = ensurePolicies();
          if (needsImage) {
            const dynamic = vendor.selectors.selectConfDynamicInfo(state());
            window.__welinkSnapshotPolicy.requireAllowed(window.__welinkSnapshotPolicy.decision(dynamic?.forbiddenScreenShots));
          }
          return policy;
        },
        getState: () => {
          const session = sharingContext(), media = rtc();
          const info = vendor.selectors.selectConfInitData(state()) || {};
          const streams = Object.values(media.remoteStreams || {});
          if (media.remoteAuxStream) streams.push(media.remoteAuxStream);
          for (const stream of [media.localStream, media.localAuxStream])
            if (stream && published.has(stream)) streams.push(stream);
          const sources = streams.filter(stream => typeof stream.getVideoTrack === 'function' &&
            !(typeof stream.isVideoMuted === 'function' && stream.isVideoMuted())).map(stream => ({
              track: stream.getVideoTrack(),
              kind: stream === media.remoteAuxStream || stream === media.localAuxStream ? 'shared-content' : 'camera'
            }));
          return { joined: session.joined, sessionKey: session.sessionKey, conferenceId: info.conferenceID,
            localSharing: !!(media.localAuxStream && published.has(media.localAuxStream) && live(media.localAuxStream.getVideoTrack())),
            source: 'online-hrtc-render-media', sources };
        } });
    }
    if (operation.startsWith('render.surface.')) {
      if (operation === 'render.surface.inspect') return renderWindows.surfaceEntries(params).receipt;
      if (!renderSurface) {
        if (typeof window.__welinkCreateRenderSurface !== 'function')
          fail('RENDER_SURFACE_UNAVAILABLE', 'The native per-track surface source is not installed');
        renderSurface = window.__welinkCreateRenderSurface({
          collect: expected => renderWindows.surfaceEntries(expected), watermark,
          invalidate: data => host.invalidateRenderSurfaces(data)
        });
      }
      if (operation === 'render.surface.open') return renderSurface.open(params);
      if (operation === 'render.surface.close') return renderSurface.close(params);
      return renderSurface.frame(params);
    }
    return operation === 'render.capture' ? renderWindows.capture(params) : renderWindows.inspect(params);
  }
  function renderCapability() {
    const supported = typeof window.__welinkCreateRenderWindows === 'function' && typeof watermark?.paintSnapshot === 'function';
    let reason = supported ? null : 'RENDER_PROVIDER_UNAVAILABLE', targets = 0;
    if (supported) {
      try { const state = renderOperation('render.inspect'); reason = state.reason; targets = state.targets.length; }
      catch (error) { reason = error.code || 'RENDER_UNAVAILABLE'; }
    }
    return { supported, available: supported && !reason, reason, targets,
      scope: 'rendered-conference-media-only', operation: 'host.render.windows',
      nativeHandleSupported: false, win32Abi: false, platform: 'linux',
      pictureConsumer: 'listenAndNote-filePath', saveConsent: 'native-save-dialog',
      detail: 'Linux media targets and optional watermarked PNG for the original note consumer; not UISDK HWND enumeration.' };
  }


  function recordingSink() {
    function abortHandle(handle) {
      if (!handle.abortPromise)
        handle.abortPromise = host.recordingAbort({ requestId: handle.requestId, handleId: handle.handleId });
      return handle.abortPromise;
    }
    function detach(handle) {
      if (handle.signal) handle.signal.removeEventListener('abort', handle.onAbort);
    }
    return {
      async open({ mimeType, extension, signal }) {
        const request = pendingRecordingStart;
        if (!request || request.epoch !== recordingCancellationEpoch || signal.aborted)
          fail('RECORDING_CANCELLED', 'The trusted recording start was cancelled');
        const handle = { requestId: request.requestId, handleId: undefined, bytes: 0, sequence: 0,
          mimeType, extension, signal, onAbort: null, abortPromise: null, closed: false };
        handle.onAbort = () => {
          abortHandle(handle).catch(error => {
            request.abortError = error;
            recordFailure('recording-file-abort', null, error);
          });
        };
        signal.addEventListener('abort', handle.onAbort, { once: true });
        try {
          const opened = await host.recordingOpen({ requestId: handle.requestId, mimeType, extension });
          const id = opened && opened.handleId;
          if (typeof id !== 'string' || !id) fail('INVALID_RECORDING_HANDLE', 'The host did not return a real file handle');
          handle.handleId = id;
          if (signal.aborted) {
            await abortHandle(handle);
            fail('RECORDING_CANCELLED', 'The selected recording output was cancelled');
          }
          return handle;
        } catch (error) {
          detach(handle);
          if (handle.handleId) {
            try { await abortHandle(handle); }
            catch (cleanupError) {
              error.details = { ...error.details, cleanup: {
                code: cleanupError.code || 'RECORDING_ABORT_FAILED', message: String(cleanupError.message || cleanupError) } };
            }
          }
          throw error;
        }
      },
      async write(handle, chunk, { sequence: chunkSequence }) {
        if (handle.closed || handle.abortPromise) fail('RECORDING_OUTPUT_CLOSED', 'The recording output is no longer writable');
        if (chunkSequence !== handle.sequence) fail('RECORDING_CHUNK_ORDER', 'Encoded recording chunks are out of order');
        const result = await host.recordingWrite({ handleId: handle.handleId, sequence: chunkSequence, chunk });
        if (!result || result.handleId !== handle.handleId || result.sequence !== chunkSequence ||
            result.bytesWritten !== chunk.byteLength)
          fail('RECORDING_WRITE_UNCONFIRMED', 'The host did not confirm the complete ordered chunk write');
        handle.bytes += result.bytesWritten;
        ++handle.sequence;
        return result.bytesWritten;
      },
      async close(handle) {
        if (handle.closed || handle.abortPromise) fail('RECORDING_OUTPUT_CLOSED', 'The recording output was already closed or aborted');
        const receipt = await host.recordingClose({ handleId: handle.handleId });
        if (!receipt || receipt.handleId !== handle.handleId || receipt.bytesWritten !== handle.bytes ||
            receipt.mimeType !== handle.mimeType || receipt.extension !== handle.extension)
          fail('RECORDING_CLOSE_UNCONFIRMED', 'The host did not confirm the actual recording file close');
        handle.closed = true;
        detach(handle);
        return receipt;
      },
      async abort(handle) {
        detach(handle);
        if (handle.closed) fail('RECORDING_OUTPUT_COMMITTED', 'The recording output was already committed');
        await abortHandle(handle);
      }
    };
  }

  function syncRecordingTip() {
    const current = state(), room = sharingContext();
    const dynamic = vendor.selectors.selectConfDynamicInfo(current) || {};
    const view = vendor.selectors.selectView(current) || {};
    const modes = vendor.constants.MODAL_STATE;
    const required = [modes.KONW_RECORD_CONFIRM, modes.START_RECORD_CONFIRM, modes.REQUEST_RECORD_CONFIRM,
      modes.GUEST_REQUEST_RECORD_CONFIRM].filter(value => value !== undefined);
    const confirming = required.includes(view.modalState) || (Array.isArray(view.waitModalStates) &&
      view.waitModalStates.some(value => required.includes(value)));
    const active = vendor.constants.RECORDING_STATUS.RECORDING;
    recordingTip.observe(room.joined ? room.sessionKey : null,
      dynamic.recordState === active || dynamic.clientRecState === active, confirming);
  }

  function initializeRecording() {
    requireFunction(window, '__welinkCreateRecordingTip');
    requireFunction(vendor.selectors, 'selectView');
    if (!vendor.constants.MODAL_STATE || vendor.constants.RECORDING_STATUS?.RECORDING === undefined)
      fail('VENDOR_ABI_MISMATCH', 'Recording notice states are unavailable');
    recordingTip = window.__welinkCreateRecordingTip();
    requireFunction(window, '__welinkCreateNativeRecordingControl');
    requireFunction(window, '__welinkCreateNativeWebRecording');
    for (const name of ['recordingOpen', 'recordingWrite', 'recordingClose', 'recordingAbort', 'recordingPermissionPrompt'])
      requireFunction(host, name);
    recordingControl = window.__welinkCreateNativeRecordingControl({
      vendor,
      getSession() {
        const session = sharingContext();
        return { sessionKey: session.sessionKey, joined: session.joined };
      },
      emit: (event, data) => host.emit('recording-state', { event, data }),
      promptPermission: request => host.recordingPermissionPrompt(request)
    });
    for (const name of ['authorization', 'reportStatus', 'requestPermission', 'answerPermission', 'grant', 'capabilities', 'dispose', 'setRecordingAvailable'])
      requireFunction(recordingControl, name);
    recording = window.__welinkCreateNativeWebRecording({
      watermark,
      getState: recordingSnapshot,
      confirmStart: (sessionKey, signal) => { syncRecordingTip(); return recordingTip.confirmStart(sessionKey, signal); },
      subscribe(listener) {
        recordingListeners.add(listener);
        return () => recordingListeners.delete(listener);
      },
      authorization: snapshot => recordingControl.authorization(snapshot),
      reportStatus: message => recordingControl.reportStatus(message),
      sink: recordingSink(),
      onState(data) {
        pulse();
        host.emit('recording-state', data).catch(error => recordFailure('recording-event', null, error));
      },
      onError(error) {
        lastRecordingError = { code: error.code || 'RECORDING_FAILED', message: String(error.message || error),
          ...(error.details === undefined ? {} : { details: error.details }) };
        pulse();
        host.emit('recording-state', { state: 'failed', error: lastRecordingError,
          receipt: error.details && error.details.receipt }).catch(failure => recordFailure('recording-event', null, failure));
      }
    });
    const browser = recording.capabilities().browser;
    recordingControl.setRecordingAvailable(Boolean(browser.mediaRecorder &&
      (browser.audioMixing && browser.audioMimeTypes.length ||
       browser.canvasCapture && browser.videoMimeTypes.length)));
  }

  async function startRecording(params, epoch) {
    if (epoch !== recordingCancellationEpoch) fail('RECORDING_CANCELLED', 'The queued recording start was cancelled');
    if (!params || typeof params.requestId !== 'string' || !params.requestId)
      fail('RECORDING_REQUEST_REQUIRED', 'A main-process-authorized recording request is required');
    const request = { requestId: params.requestId, epoch, abortError: null };
    pendingRecordingStart = request;
    lastRecordingError = null;
    try { return await recording.start(params); }
    finally { if (pendingRecordingStart === request) pendingRecordingStart = null; }
  }

  async function requestRecordingPermission(params) {
    const controller = new AbortController();
    pendingRecordingPermission = controller;
    try { return await recordingControl.requestPermission({ signal: controller.signal, timeoutMs: params.timeoutMs }); }
    finally { if (pendingRecordingPermission === controller) pendingRecordingPermission = null; }
  }

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
  function requireFunction(object, name) {
    if (!object || typeof object[name] !== 'function')
      fail('VENDOR_ABI_MISMATCH', 'Vendor API is unavailable: ' + name);
  }
  function withTimeout(promise, timeout, operation) {
    let timer;
    return Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(operation + ' did not complete');
        error.code = 'TIMEOUT';
        reject(error);
      }, timeout);
    })]).finally(() => clearTimeout(timer));
  }
  function state() { return vendor.store.getState(); }
  function sessionCredentials() {
    // Private main-process cleanup read, never part of snapshots or events.
    // Media disposal does not invalidate the still-live vendor login store.
    if (!vendor || !vendor.store || !vendor.selectors)
      fail('NOT_INITIALIZED', 'The genuine vendor login store is not bound');
    requireFunction(vendor.store, 'getState');
    for (const name of ['selectLoginInfo', 'getElectronLoginInfo', 'selectClearToken'])
      requireFunction(vendor.selectors, name);
    const current = state();
    const tokens = [
      vendor.selectors.selectLoginInfo(current)?.accessToken,
      vendor.selectors.getElectronLoginInfo(current)?.accessToken,
      vendor.selectors.selectClearToken(current)?.userPortalToken
    ];
    return { accessTokens: Array.from(new Set(tokens.filter(token => typeof token === 'string' && token.length > 0))) };
  }
  function ownParticipant(current = state()) {
    const own = vendor.selectors.selectOwn(current);
    if (!own || own.id === null || own.id === undefined) return null;
    const participants = own.role === vendor.constants.AUDIENCE ?
      vendor.selectors.selectAudiences(current) : vendor.selectors.selectParticipants(current);
    return participants && participants[own.id] || null;
  }
  function rtc() { return vendor.selectors.selectRtc(state()); }
  function anonymousJoinStep(current = state()) {
    if (typeof vendor.selectors.selectJoin !== 'function') return 'unavailable';
    const step = vendor.selectors.selectJoin(current)?.joinStep;
    for (const [name, key] of [['password', 'INPUT_PASSWORD'], ['phone', 'INPUT_PHONE_NUMBER'],
      ['slider', 'VERIFY_SLIDING'], ['sms', 'VERIFY_SMS_CODE'], ['name', 'VERIFY_NAME'], ['joining', 'JOIN_CONF']])
      if (step === vendor.constants[key]) return name;
    return 'initializing';
  }
  function noiseState(media = rtc()) {
    const stream = media.localStream;
    const track = stream && typeof stream.getAudioTrack === 'function' ? stream.getAudioTrack() : null;
    const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
    return { state: typeof settings.noiseSuppression === 'boolean' ? settings.noiseSuppression : null,
      track: track ? track.readyState : 'absent', scope: 'existing-main-audio-track' };
  }
  function live(track) { return !!track && track.readyState === 'live' && track.enabled; }
  function snapshot() {
    if (!initialized) return { ready: false, joined: false };
    const current = state();
    const media = vendor.selectors.selectRtc(current);
    const info = vendor.selectors.selectConfInitData(current) || {};
    const mmr = vendor.selectors.selectMmrWs(current) || {};
    const client = media.rtcClient;
    const local = media.localStream;
    const aux = media.localAuxStream;
    const connection = client && typeof client.getConnectionState === 'function'
      ? client.getConnectionState() : 'DISCONNECTED';
    const selection = vendor.selectors.selectDevices(current) || {};
    const request = aux && managedAux.get(aux);
    const session = sharingContext();
    const own = vendor.selectors.selectOwn(current) || {};
    const self = ownParticipant(current);
    const cohost = [true, 1, '1'].includes(self?.pinfoMap?.IS_COHOST);
    const role = { kind: own.role === vendor.constants.HOST ? 'host' : cohost ? 'cohost' :
      own.role === vendor.constants.AUDIENCE ? 'audience' :
      own.role === vendor.constants.GUEST ? 'participant' : 'unknown',
      providerValue: own.role === undefined ? null : own.role, cohost };
    const captured = request && request.capture ? capture.inspect(request.capture) : null;
    return {
      ready: true,
      joined: !!(client && mmr.isJoinRoom && info.participantID && connection === 'CONNECTED'),
      connection,
      roomJoined: !!mmr.isJoinRoom,
      sessionKey: session.sessionKey,
      role,
      policies: policyState(),
      conferenceId: info.conferenceID || '',
      displayConferenceId: vendor.common.getConfDisplayId(info.displayConferenceID, info.conferenceID) || '',
      conferenceInfo: conferenceInfo(current),
      tenantRelation: unknownTenantRelation,
      screenPermission: { allowed: appSharePermission, configured: appShareConfigured,
        sessionKey: appShareGrantSession, providerAndApp: session.sharingPermission, reason: session.reason },
      participantId: info.participantID || '',
      selfName: ownParticipant(current)?.pinfoMap?.NAME || '',
      language: typeof vendor.selectors.selectLang === 'function' ? vendor.selectors.selectLang(current) : null,
      noiseReduction: noiseState(media),
      voiceProtection: voiceMedia ? { ...voiceMedia.state(), scope: voiceScope } : null,
      anonymousJoin: pendingAnonymousJoin ? { pending: true, method: pendingAnonymousJoin.method, step: anonymousJoinStep(current) } : null,
      audioEnabled: !!(local && !local.isAudioMuted() && live(local.getAudioTrack())),
      videoEnabled: !!(local && !local.isVideoMuted() && live(local.getVideoTrack())),
      screenSharing: !!(aux && published.has(aux) && live(aux.getVideoTrack())),
      screenAudioEnabled: !!(aux && published.has(aux) && live(aux.getVideoTrack()) && captured &&
        captured.sdkAudioBound === true && captured.audio.readyState === 'live' && captured.audio.enabled),
      screenAudioSource: captured ? captured.source : null,
      captureError: lastCaptureError,
      recording: recording.state(),
      recordingError: lastRecordingError,
      customBackground: customBackground ? customBackground.state() : null,
      selectedDevices: { audioinput: selection.audioInput || '',
        audiooutput: selection.audioOutput || '', videoinput: selection.videoInput || '' }
    };
  }
  function invitationID(value) {
    return typeof value === 'string' && value ? value : Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }

  function sendP2p(watch, fields) {
    const send = () => disposed ? false : host.emit('p2p-control', {
      ...fields, attemptId: watch.attemptId, conferenceID: watch.conferenceID
    });
    const task = watch.queue.then(send);
    watch.queue = task.catch(() => false);
    return task;
  }
  function clearP2pWatch() {
    const watch = p2pWatch;
    if (!watch) return;
    p2pWatch = null;
    watch.release?.();
    if (watch.incoming) finishedP2pInvites.add(watch.conferenceID);
    watch.finish?.();
  }
  function watchP2p(attemptId, conferenceID, incoming = false) {
    clearP2pWatch();
    return p2pWatch = { attemptId, conferenceID, incoming, queue: Promise.resolve(),
      socket: vendor.getWebsocket(), participants: new Map(), release: null };
  }
  function p2pObservation(frame) {
    const watch = p2pWatch;
    if (!watch || disposed) return;
    const s = state(), info = vendor.selectors.selectConfInitData(s), own = vendor.selectors.selectOwn(s);
    const body = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data;
    const explicit = frame.conferenceID ?? body?.conferenceID;
    const socket = vendor.getWebsocket();
    // A frame without an ID belongs only to the current provider room and its
    // pinned socket. Never inherit the previous room's participants/identity.
    if (explicit == null) {
      if (!socket || socket !== watch.socket || String(info?.conferenceID) !== watch.conferenceID) return;
    } else if (String(explicit) !== watch.conferenceID) return;
    if (socket && socket !== watch.socket) {
      watch.release?.();
      watch.socket = socket;
      watch.participants.clear();
    }
    const send = fields => sendP2p(watch, fields).catch(() => {});
    const types = vendor.constants.CONF_MSG_TYPE;
    if (frame.action === types.PARTICIPANT_NOTIFY && Array.isArray(body)) {
      const report = (pid, value) => {
        if (value.STATE == null) return;
        send({ type: 'participant', participantId: pid, state: String(value.STATE),
          isSelf: String(info?.conferenceID) === watch.conferenceID && pid === String(own?.id),
          number: value.TEL, thirdUserId: value.THIRDACCOUNT, nickname: value.NAME });
      };
      const previous = watch.participants;
      if (frame.msgMode === vendor.constants.PARTICIPANTS_NOTIFY_MSG_MODE.ALL) {
        watch.participants = new Map();
        const present = new Set(body.filter(row => row?.pid != null).map(row => String(row.pid)));
        for (const [pid, value] of previous) if (!present.has(pid)) report(pid, {...value, STATE:'3'});
      }
      for (const row of body) {
        if (row?.pid == null) continue;
        const pid = String(row.pid);
        if (row.mode === vendor.constants.PARTICIPANT_NOTIFY_MODE.REMOVE) {
          const value = previous.get(pid);
          if (value) report(pid, {...value, STATE:'3'});
          watch.participants.delete(pid);
          continue;
        }
        if (!row.pinfoMap) continue;
        const value = {...watch.participants.get(pid), ...row.pinfoMap};
        watch.participants.set(pid, value);
        report(pid, value);
      }
    } else if (frame.action === types.INVITERESULT_NOTIFY && Array.isArray(body)) {
      for (const item of body) if (item && typeof item.callNumber === 'string' && Number.isInteger(item.resultCode))
        send({type:'invite-result', callNumber:item.callNumber, resultCode:item.resultCode});
    } else if (frame.action === types.LOCAL_CONTROL && frame.type === vendor.constants.LOCAL_NOTIFY_TYPE.HANGUP &&
        body?.participantID != null) {
      send({type:'exit', participantId:String(body.participantID), confEndReason:body.confEndReason,
        resultCode:body.resultCode, resultMsg:body.resultMsg, reason:body.reason});
    }
  }

  function observeInviteDecline(watch) {
    const socket = vendor.getWebsocket();
    if (!socket || socket.readyState !== WebSocket.OPEN) fail('CMS_TRANSPORT_OFFLINE', 'No invitation control connection');
    watch.release?.();
    const original = socket.send, sequences = new Set();
    const action = vendor.constants.CONF_MSG_TYPE.CONF_CONTROL, type = vendor.constants.CONF_CONTROL_TYPE.INVITE_TO_JOIN;
    function send(data) {
      try {
        const frame = JSON.parse(data), body = JSON.parse(frame.data);
        if (frame.action === action && frame.type === type && typeof frame.sequence === 'string' &&
            String(body.conferenceID) === watch.conferenceID && body.optType === 2) sequences.add(frame.sequence);
      } catch (_) { /* The provider owns serialization errors. */ }
      return original.call(this, data);
    }
    const receive = event => {
      let frame, body;
      try { frame = JSON.parse(event.data); body = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data; }
      catch (_) { return; }
      if (frame.action !== action || frame.type !== type || !sequences.has(frame.sequence) ||
          !Number.isInteger(body?.returnCode) ||
          body.conferenceID != null && String(body.conferenceID) !== watch.conferenceID) return;
      sequences.delete(frame.sequence);
      const resultCode = body.returnCode > 0 && body.returnCode < 100000000 ? body.returnCode + 100000000 : body.returnCode;
      sendP2p(watch, { type:'decline-result', resultCode,
        resultMsg:typeof body.returnDesc === 'string' ? body.returnDesc : '' }).catch(() => {});
      release();
    };
    const release = () => {
      if (socket.send === send) socket.send = original;
      socket.removeEventListener('message', receive);
      socket.removeEventListener('close', release);
      if (watch.release === release) watch.release = null;
    };
    socket.send = send;
    socket.addEventListener('message', receive);
    socket.addEventListener('close', release);
    watch.release = release;
  }

  function bindInviteOwner(load) {
    if (disposeInviteOwner) return;
    const routes = load(51361).confWsHandler, original = load(86989).onLocalControl;
    const resultAction = load(74110).handleInviteToJoinResult, joinAction = vendor.join.electronJoinByInvite;
    // The pinned provider exports its watchers, not its workers. Use the same
    // workers registered for these two actions; never supply login data or RTC state.
    function worker(module, type) {
      const workers = load(module).default.flatMap(watch => {
        const effect = watch().next().value;
        const args = effect?.type === 'FORK' && effect.payload?.args;
        return args?.[0] === type && args.length === 2 && typeof args[1] === 'function' ? [args[1]] : [];
      });
      if (workers.length !== 1) fail('VENDOR_ABI_MISMATCH', 'No unique worker for the invitation action');
      return workers[0];
    }
    const joinType = joinAction().type, admit = worker(21205, joinType);
    const answer = worker(97944, resultAction().type);
    const inviteState = load(86658);
    requireFunction(inviteState, 'setIsInviteJoining');
    requireFunction(vendor.selectors, 'selectIsInviteJoining');
    let acceptance;
    const current = () => {
      const s = state();
      return !disposed && vendor.selectors.selectIsJoiningConf(s) ? invitationID(vendor.selectors.selectInviteToJoinInfo(s)?.conferenceID) : null;
    };
    function retire() {
      const old = acceptance;
      acceptance = null;
      if (!old) return;
      old.task?.cancel();
      // The pending-list row can disappear before the authentication request settles.
      // Dropping a pending answer does not leave or terminate a joined conference.
      if (vendor.selectors.selectIsInviteJoining(state()))
        vendor.store.dispatch(inviteState.setIsInviteJoining(false));
    }
    function accept(id) {
      if (!id || current() !== id || acceptance) return;
      if (p2pWatch?.incoming && p2pWatch.conferenceID === id)
        sendP2p(p2pWatch, {type:'decision', decision:'accept'}).catch(() => {});
      const owned = { id, task: null };
      acceptance = owned;
      // The stock answer worker waits before authentication. Its single PUT
      // normally starts an unrelated root task which outlives withdrawal. Run
      // that same admission worker as an attached fork of this invitation.
      const originalAnswer = answer(resultAction({ optType: 0 }));
      function bind(step) {
        const effect = step.value;
        if (!step.done && effect?.type === 'PUT' && effect.payload?.action?.type === joinType) {
          if (acceptance !== owned || current() !== id) return originalAnswer.return();
          return { done: false, value: vendor.effects.fork(admit, effect.payload.action) };
        }
        return step;
      }
      try {
        owned.task = vendor.sagaMiddleware.run(() => ({
          next: value => bind(originalAnswer.next(value)), throw: error => bind(originalAnswer.throw(error)),
          return: value => bind(originalAnswer.return(value))
        }));
        if (acceptance !== owned) owned.task.cancel();
        owned.task.toPromise().catch(() => { if (acceptance === owned) retire(); });
      } catch (error) { if (acceptance === owned) retire(); throw error; }
    }
    function decline(id) {
      if (!id || current() !== id || acceptance) return;
      const watch = p2pWatch?.incoming && p2pWatch.conferenceID === id ? p2pWatch : null;
      if (watch) {
        observeInviteDecline(watch);
        sendP2p(watch, {type:'decision', decision:'decline'}).catch(() => {});
      }
      // Execute the pinned provider's real decline worker, including its
      // ConfControl request and pending-invitation cleanup, exactly once.
      vendor.sagaMiddleware.run(answer, resultAction({optType:2})).toPromise().catch(() => {});
    }
    const action = vendor.constants.CONF_MSG_TYPE.LOCAL_CONTROL;
    const type = vendor.constants.LOCAL_NOTIFY_TYPE.INVITE_TO_JOIN;
    const finish = vendor.constants.INVITE_TO_JOIN_OPT_TYPE.FINISH_INVITE;
    if (typeof original !== 'function' || routes[action] !== original || typeof type !== 'string' || finish !== 1)
      fail('VENDOR_ABI_MISMATCH', 'Unverified incoming invitation route');
    // Downstream the provider drops conferenceID and unconditionally clears its
    // pending invite. Filter here; the outer CMS acknowledgement still runs.
    function* receive(message) {
      if (message.type === type) {
        let invitation;
        try { invitation = JSON.parse(message.data); } catch (_) { return yield* original(message); }
        const id = invitationID(invitation?.conferenceID);
        if (invitation?.optType === finish) {
          if (!id) return;
          if (p2pWatch?.incoming && p2pWatch.conferenceID === id) {
            p2pWatch.withdrawn = true;
            yield vendor.effects.call(sendP2p, p2pWatch, {type:'withdrawn'});
          }
          const pendingID = invitationID(vendor.selectors.selectInviteToJoinInfo(state())?.conferenceID);
          if (acceptance?.id === id) retire();
          if (pendingID !== id) return;
        } else if (invitation?.optType === 0 && (invitation.p2p === 1 || invitation.p2p === true) && id) {
          if (finishedP2pInvites.has(id) || p2pWatch?.conferenceID === id) return;
          if (p2pWatch || current() || snapshot().joined)
            return yield vendor.effects.call(vendor.common.sendInviteToJoinToCms, {
              conferenceID:id, optType:vendor.constants.INVITE_TO_JOIN_OPT_TYPE.AUTO_REJECT,
              autoDeclineType:vendor.constants.AUTO_DECLINE_TYPE.INVITING
            });
          const media = invitation.mediaType;
          const mediaType = media === 'Voice' || media === 0 ? 0 :
            media === 'Video' || media === 'Voice,Video' || media === 'Voice,Video,Data' || media === 1 ? 1 : null;
          if (mediaType !== null) {
            const watch = watchP2p(crypto.randomUUID(), id, true);
            watch.finish = () => {
              if (acceptance?.id === id) retire();
              if (current() === id) vendor.store.dispatch(inviteState.cleanInviteInfo());
            };
            let accepted = false;
            try { accepted = yield vendor.effects.call(sendP2p, watch, {type:'incoming', p2p:true, mediaType}); }
            catch (_) { /* Native identity unavailable; retain ordinary invitation UI. */ }
            if (watch.withdrawn) return;
            if (accepted !== true && p2pWatch === watch) {
              p2pWatch = null; // The host has no authenticated call-record owner.
            }
          }
        }
      }
      return yield* original(message);
    }
    const types = vendor.constants.CONF_MSG_TYPE;
    const observers = [types.LOCAL_CONTROL, types.PARTICIPANT_NOTIFY, types.INVITERESULT_NOTIFY].map(key => {
      const handler = key === action ? receive : routes[key];
      if (typeof handler !== 'function') fail('VENDOR_ABI_MISMATCH', 'Missing CMS notification handler');
      const wrapper = message => {
        if (p2pWatch) {
          try { p2pObservation(message); } catch (_) { /* The original handler owns malformed notifications. */ }
        }
        return handler(message);
      };
      return {key, handler:key === action ? original : handler, wrapper};
    });
    for (const entry of observers) routes[entry.key] = entry.wrapper;
    host.setIncomingInviteOwner({ current, accept, decline, retire });
    disposeInviteOwner = () => {
      host.setIncomingInviteOwner(null);
      retire();
      clearP2pWatch();
      finishedP2pInvites.clear();
      for (const entry of observers) if (routes[entry.key] === entry.wrapper) routes[entry.key] = entry.handler;
      disposeInviteOwner = null;
    };
  }

  function customBackgroundContext() {
    const current = state(), media = rtc(), c = vendor.constants, room = sharingContext();
    const own = vendor.selectors.selectOwn(current) || {};
    const rules = vendor.selectors.selectConfDynamicInfo(current) || {};
    const stream = media.localStream, track = stream?.getVideoTrack();
    const cameraIntent = ownParticipant(current)?.pinfoMap?.CAMERASTATE === c.CAMERA_STATE.ON &&
      !!stream && !stream.isVideoMuted();
    return { sessionKey: room.sessionKey, joined: room.joined,
      provider: customBackgroundPolicy ? customBackgroundPolicy.state() :
        { allowed: false, reason: 'BACKGROUND_PROVIDER_POLICY_UNKNOWN' },
      cameraAllowed: (own.role === c.HOST || own.role === c.GUEST) &&
        (own.role === c.HOST || rules.allowOpenCamera !== c.ALLOW_OPEN_CAMERA.NOT_ALLOWED),
      cameraIntent, cameraOpen: cameraIntent && live(track) && track.enabled && !track.muted };
  }

  function pulse() {
    if (disposed || !initialized) return;
    renderSurface?.pulse();
    voiceMedia?.pulse();
    customBackground?.pulse();
    if (rtc().HRTC === sdk) {
      // A late vendor dynamic import can publish the original SDK again.
      vendor.store.dispatch(vendor.actions.setHrtc(captureSdk));
      return;
    }
    observeClient(rtc().rtcClient);
    for (const listener of captureListeners) listener();
    for (const listener of recordingListeners) listener();
    syncRecordingTip();
    const current = snapshot();
    publishLifecycle(current);
    const encoded = JSON.stringify(current);
    if (encoded !== previousSnapshot) {
      previousSnapshot = encoded;
      host.emit('media-state', current).catch(() => {});
    }
    for (const check of Array.from(waiters)) check();
  }
  function observeClient(client) {
    if (!client || observedClients.has(client)) return;
    const originals = {};
    for (const name of ['join', 'leave', 'publish', 'unpublish']) {
      requireFunction(client, name);
      const original = client[name];
      originals[name] = original;
      /* Observe the actual SDK promise. Do not replace its result, suppress its
       * rejection, or infer publication from an optimistic Redux flag. */
      client[name] = function (...args) {
        let operation;
        try {
          if (name === 'publish') {
            voiceMedia?.beforePublish(this, args[0]);
            assertManagedPublish(args[0]);
          }
          operation = original.apply(this, args);
        } catch (error) { recordFailure(name, args[0], error); throw error; }
        const observed = Promise.resolve(operation).then(result => {
          if (name === 'publish' && args[0]) published.add(args[0]);
          if (name === 'unpublish' && args[0]) published.delete(args[0]);
          if (name === 'join') {
            completedLeaves.delete(client);
            captureJoined = false;
          }
          if (name === 'leave') {
            completedLeaves.add(client);
            for (const [aux, request] of managedAux) if (request.client === client) published.delete(aux);
          }
          pulse();
          return result;
        }, error => { recordFailure(name, args[0], error); throw error; });
        if (name === 'publish' && args[0]) invitedShareGuard?.observePublish(args[0], observed);
        const pending = name === 'publish' ? publishingAux : name === 'unpublish' ? unpublishingAux : null;
        if (pending && args[0] && managedAux.has(args[0])) {
          pending.set(args[0], observed);
          const clear = () => {
            if (pending.get(args[0]) === observed) pending.delete(args[0]);
            pulse();
          };
          observed.then(clear, clear);
        }
        return observed;
      };
    }
    observedClients.set(client, originals);
    requireFunction(client, 'on');
    requireFunction(client, 'off');
    client.on('connection-state-changed', pulse);
  }
  function recordFailure(method, stream, error) {
    failures.push({ sequence: ++sequence, method,
      auxiliary: !!(stream && typeof stream.isAuxiliary === 'function' && stream.isAuxiliary()), error });
    if (failures.length > 32) failures.shift();
    pulse();
  }
  function waitState(predicate, operation, options = {}) {
    const baseline = sequence;
    let cancel;
    const completion = new Promise((resolve, reject) => {
      let timer;
      function finish(error, value) {
        clearTimeout(timer);
        waiters.delete(check);
        error ? reject(error) : resolve(value);
      }
      cancel = error => finish(error);
      function check() {
        try {
          if (disposed) return finish(Object.assign(new Error('Media runtime was disposed'), { code: 'DISPOSED' }));
          const failed = failures.find(item => item.sequence > baseline &&
            (options.methods || []).includes(item.method) &&
            (options.auxiliary === undefined || options.auxiliary === item.auxiliary));
          if (failed) return finish(failed.error);
          const current = snapshot();
          if (predicate(current)) finish(null, current);
        } catch (error) { finish(error); }
      }
      timer = setTimeout(() => finish(Object.assign(new Error(operation + ' did not complete'),
        { code: 'TIMEOUT' })), options.timeout || 45000);
      waiters.add(check);
      check();
    });
    completion.cancel = cancel;
    // The vendor saga can still be awaiting a permission prompt when the
    // deadline expires. Observe rejection now, without changing its result.
    completion.catch(() => {});
    return completion;
  }
  function run(generator, ...args) {
    return vendor.sagaMiddleware.run(generator, ...args).toPromise();
  }
  function requireJoined() {
    if (!snapshot().joined) fail('NOT_IN_CONFERENCE', 'The real RTC room is not connected');
  }
  async function initialize(options = {}) {
    if (disposed) fail('DISPOSED', 'Media runtime was disposed');
    if (initialized) return capabilities();
    if (!host) fail('HOST_UNAVAILABLE', 'The native meeting preload is absent');
    if (!Array.from(document.scripts).some(script => {
      try { const url = new URL(script.src); return url.origin === location.origin && url.pathname === ABI_ASSET; }
      catch { return false; }
    })) fail('VENDOR_ABI_MISMATCH', 'Unverified Huawei WebRTC application build');
    const chunks = window.webpackChunkweb_rtc;
    if (!chunks || typeof chunks.push !== 'function') fail('VENDOR_ABI_MISMATCH', 'Vendor module loader is absent');
    let load;
    chunks.push([['welink-native-media-bridge-v1'], {}, runtime => { load = runtime; }]);
    if (typeof load !== 'function' || typeof load.e !== 'function')
      fail('VENDOR_ABI_MISMATCH', 'Cannot access the verified vendor module loader');
    const application = load(MODULE.store);
    vendor = { store: application.store, sagaMiddleware: application.sagaMiddleware,
      history: application.history, selectors: load(MODULE.selectors), constants: load(MODULE.constants),
      actions: load(MODULE.actions), view: load(MODULE.view), sharing: load(MODULE.sharing), rtc: load(MODULE.rtc),
      effects: load(MODULE.effects), getWebsocket: load(MODULE.socket).getWebsocket, uuid: load(MODULE.utils).uuid,
      locale: load(MODULE.locale), join: load(MODULE.join), invitation: load(MODULE.invitation), common: load(MODULE.common) };
    vendor.messages = load(44439).default; // Pinned provider's own CMS/MMC locale service.
    for (const name of ['getState', 'subscribe', 'dispatch']) requireFunction(vendor.store, name);
    requireFunction(vendor.sagaMiddleware, 'run');
    requireFunction(vendor.common, 'getConfDisplayId');
    for (const name of ['selectRtc', 'selectMmrWs', 'selectConfInitData', 'selectOwn',
      'selectDevices', 'selectConfBasicInfo', 'selectEnableCollaborate',
      'selectConfDynamicInfo', 'selectConf', 'selectParticipants',
      'selectAudiences', 'selectLoginInfo', 'getElectronLoginInfo',
      'selectClearToken']) requireFunction(vendor.selectors, name);
    for (const name of ['onMuteMicrophoneImpl', 'onSetVideoMuteImpl', 'switchDevice', 'setAudioOutPut'])
      requireFunction(vendor.view, name);
    for (const name of ['onStartAuxStreamImpl', 'stopAuxStreamImpl']) requireFunction(vendor.sharing, name);
    requireFunction(vendor.actions, 'leaveConfBySelf');
    requireFunction(vendor.actions, 'onEndConf');
    await withTimeout(Promise.all([load.e(12), load.e(702)]), 30000, 'Loading the verified media and UI bindings');
    sdk = load(MODULE.sdk);
    for (const name of ['checkSystemRequirements', 'getDevices', 'createClient', 'createStream', 'isScreenShareSupported']) requireFunction(sdk, name);
    if (sdk.VERSION !== SDK_VERSION)
      fail('VENDOR_ABI_MISMATCH', 'The verified Huawei media engine must be HRTC ' + SDK_VERSION);
    requireFunction(window.WelinkAudioOutput, 'apply');
    if (options.sdkLog && !sdkLog) sdkLog = window.__welinkInstallSdkLog(sdk, host.writeSdkLog);
    requireFunction(vendor.selectors, 'selectInviteToJoinInfo');
    requireFunction(vendor.selectors, 'selectIsJoiningConf');
    bindInviteOwner(load);
    if (await sdk.checkSystemRequirements() !== true)
      fail('UNSUPPORTED_MEDIA_RUNTIME', 'The real Huawei media-engine system check failed');
    requireFunction(vendor.actions, 'setHrtc');
    await withTimeout(host.whenRegistered('join-by-nonce'), 30000, 'Binding the vendor conference join callback');
    requireFunction(window, '__welinkCreateNativeWatermark');
    requireFunction(window, '__welinkCreateNativeUiCustomization');
    requireFunction(host, 'setUiInviteHandler');
    watermark = window.__welinkCreateNativeWatermark({
      onViolation: error => policyViolation('watermark', error)
    });
    uiPolicy = window.__welinkCreateNativeUiCustomization({
      vendor, loadModule: load, getSession: () => sharingContext(),
      emit: (event, data) => host.emit(event, data),
      onViolation: error => policyViolation('ui', error)
    });
    host.setUiInviteHandler(data => uiPolicy.handleInvite(data));
    watermark.subscribe(() => pulse());
    requireFunction(window, '__welinkObserveCustomBackgroundPolicy');
    requireFunction(window, '__welinkInstallCustomBackground');
    customBackgroundPolicy = window.__welinkObserveCustomBackgroundPolicy({ vendor, loadModule: load,
      changed: () => { customBackground?.pulse(); pulse(); } });
    customBackground = window.__welinkInstallCustomBackground({ host,
      getContext: customBackgroundContext, getLocalStream: () => rtc().localStream,
      getClient: () => rtc().rtcClient, changed: () => pulse() });
    if (options.voiceHost) {
      voiceScope = options.voiceScope === 'anonymous-room-memory' ? 'anonymous-room-memory' : 'local-account';
      requireFunction(window, '__welinkInstallVoiceMedia');
      voiceMedia = window.__welinkInstallVoiceMedia({ host,
        getLocalStream: () => rtc().localStream, getClient: () => rtc().rtcClient });
      if (options.voiceEnabled === true) await voiceMedia.configure(true, options.voiceUnavailable);
    }
    await initializeCapture();
    initializeRecording();
    requireFunction(window, '__welinkCreateModerationCapabilities');
    moderation = window.__welinkCreateModerationCapabilities({
      vendor, loadModule: load, getSession: () => sharingContext(),
      setMedia: (kind, enabled) => setMedia(kind === 'microphone' ? 'audio' : 'video', enabled, true),
      onViolation: error => policyViolation('moderation', error)
    });
    requireFunction(window, '__welinkCreateInvitedShareGuard');
    requireFunction(host, 'setCaptureRequestOwner');
    requireFunction(host, 'cancelCaptureRequest');
    invitedShareGuard = window.__welinkCreateInvitedShareGuard({
      vendor, actions: load(2500), isEnabled: () => !nativeCapabilities || nativeCapabilities.allowed(1),
      cancelPicker: requestId => host.cancelCaptureRequest(requestId),
      async stopStream(stream, client) {
        if (rtc().localAuxStream === stream && rtc().rtcClient === client && snapshot().joined)
          await run(vendor.sharing.stopAuxStreamImpl);
        else await stream.close();
        if (published.has(stream) && client) await client.unpublish(stream);
      }
    });
    requireFunction(window, '__welinkCreateNativeCapabilities');
    nativeCapabilities = window.__welinkCreateNativeCapabilities({
      vendor, loadModule: load, invitedShareGuard, moderation, onViolation: error => policyViolation('native-capability', error),
      async configureRecording(type, enabled) {
        recordingControl.configureCapability(type, enabled);
        if (!enabled) {
          if (pendingRecordingPermission) pendingRecordingPermission.abort();
          if (type === 6) {
            ++recordingCancellationEpoch;
            if (['preparing', 'starting', 'recording', 'stopping'].includes(recording.state().state))
              await recording.stop();
          }
        }
        pulse();
      }
    });
    initialized = true;
    unsubscribe = vendor.store.subscribe(pulse);
    if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', deviceChanged);
    pulse();
    return capabilities();
  }
  function capabilities() {
    return { ready: initialized && !disposed, sdkVersion: sdk.VERSION, vendorAsset: ABI_ASSET,
      capabilities: { devices: true, join: true, leave: true, audio: true, video: true,
        deviceSelection: true, endConference: true, screenShare: sdk.isScreenShareSupported() === true,
        screenAudio: screenAudioCapabilities(), createConference: false, localRecording: recordingCapabilities(),
        features: features() } };
  }
  async function devices() {
    const list = await sdk.getDevices();
    return list.map(device => ({ kind: device.kind, deviceId: device.deviceId,
      groupId: device.groupId, label: device.label }));
  }
  function deviceChanged() {
    devices().then(list => host.emit('devices-changed', list)).catch(error =>
      host.emit('devices-changed', { error: { code: error.code || 'DEVICE_ENUMERATION_FAILED' } }));
  }
  function renamePermission() {
    const current = state();
    const own = vendor.selectors.selectOwn(current) || {};
    const policy = vendor.selectors.selectConfDynamicInfo(current) || {};
    if (!snapshot().joined) return { state: 'unavailable', reason: 'NOT_IN_CONFERENCE' };
    if (!ownParticipant(current)) return { state: 'unknown', reason: 'PARTICIPANT_STATE_MISSING' };
    const rule = vendor.constants.ALLOW_RENAME;
    if (own.role === vendor.constants.HOST || rule && policy.allowRename === rule.ALLOW && rule.ALLOW !== undefined)
      return { state: 'allowed', reason: null };
    return rule && policy.allowRename === rule.NOT_ALLOW && rule.NOT_ALLOW !== undefined ?
      { state: 'denied', reason: 'HOST_RENAME_DENIED' } :
      { state: 'unknown', reason: 'RENAME_PERMISSION_UNKNOWN' };
  }
  function noiseCapabilities() {
    const media = rtc();
    const stream = media.localStream;
    const track = stream && typeof stream.getAudioTrack === 'function' ? stream.getAudioTrack() : null;
    const browserSupported = navigator.mediaDevices &&
      typeof navigator.mediaDevices.getSupportedConstraints === 'function' &&
      navigator.mediaDevices.getSupportedConstraints().noiseSuppression === true;
    const trackSupported = !!(track && ['applyConstraints', 'getConstraints', 'getSettings']
      .every(name => typeof track[name] === 'function'));
    const reason = !browserSupported ? 'BROWSER_NOISE_SUPPRESSION_UNAVAILABLE' :
      !snapshot().joined ? 'NOT_IN_CONFERENCE' : !track || track.readyState !== 'live' ?
      'MAIN_AUDIO_TRACK_MISSING' : !trackSupported ? 'TRACK_CONSTRAINT_API_UNAVAILABLE' :
      noiseState(media).state === null ? 'NOISE_SUPPRESSION_STATE_UNOBSERVABLE' : null;
    return { supported: !!browserSupported, available: reason === null, reason,
      provider: 'hrtc-track/browser-noise-suppression', automaticCapture: false,
      nativeFeature10Equivalent: false, ...noiseState(media) };
  }
  function features() {
    const permission = renamePermission();
    const controlBinding = typeof vendor.getWebsocket === 'function' && typeof vendor.uuid === 'function' &&
      typeof vendor.constants.CONF_MSG_TYPE?.CONF_CONTROL === 'string';
    const socket = controlBinding ? vendor.getWebsocket() : null;
    const token = vendor.selectors.selectLoginInfo(state())?.accessToken;
    const controlReason = !controlBinding ? 'CMS_CONTROL_BINDING_UNAVAILABLE' :
      !snapshot().joined ? 'NOT_IN_CONFERENCE' : typeof token !== 'string' || !token ? 'AUTH_REQUIRED' :
      !socket || socket.readyState !== WebSocket.OPEN ? 'CMS_TRANSPORT_OFFLINE' :
      typeof socket.addEventListener !== 'function' || typeof socket.removeEventListener !== 'function' ?
      'CMS_RESPONSE_OBSERVER_UNAVAILABLE' : null;
    const renameBinding = controlBinding && typeof vendor.constants.CONF_CONTROL_TYPE?.RENAME === 'string' &&
      vendor.constants.ALLOW_RENAME?.ALLOW !== undefined && vendor.constants.ALLOW_RENAME?.NOT_ALLOW !== undefined;
    const renameReason = !renameBinding ? 'RENAME_BINDING_UNAVAILABLE' : controlReason || permission.reason;
    const invitationBinding = controlBinding && typeof vendor.constants.LOCAL_NOTIFY_TYPE?.INVITE === 'string' &&
      typeof vendor.invitation?.addAttendees === 'function';
    const anonymousBinding = typeof host.whenRegistered === 'function' && typeof host.invokeRegistered === 'function' &&
      typeof vendor.join?.joinFail === 'function' && typeof vendor.selectors.selectJoin === 'function' &&
      typeof vendor.effects.take === 'function' && typeof vendor.history?.listen === 'function';
    const localeBinding = typeof vendor.locale?.switchLocale === 'function' &&
      typeof vendor.selectors.selectLang === 'function';
    const authenticated = sessionCredentials().accessTokens.length !== 0;
    const anonymousReason = !anonymousBinding ? 'ANONYMOUS_JOIN_BINDING_UNAVAILABLE' :
      snapshot().joined ? 'ALREADY_IN_CONFERENCE' : pendingAnonymousJoin ? 'ANONYMOUS_JOIN_IN_PROGRESS' :
      authenticated ? 'ANONYMOUS_SESSION_REQUIRED' : vendor.history?.location?.pathname !== '/j' ?
      'ANONYMOUS_JOIN_UI_REQUIRED' : null;
    return {
      'participant.rename': { supported: renameBinding, available: renameReason === null,
        reason: renameReason, permission,
        scope: 'own-in-meeting-display-name', completion: 'cms-response-and-participant-name' },
      'conference.invite': { supported: invitationBinding, available: invitationBinding && controlReason === null,
        reason: invitationBinding ? controlReason : 'INVITATION_BINDING_UNAVAILABLE',
        authorization: 'server-evaluated', completion: 'cms-acceptance-not-participant-join',
        guestInvitationConfigured: typeof vendor.selectors.getIsSupportGuestInviteParticipants === 'function' ?
          vendor.selectors.getIsSupportGuestInviteParticipants(state()) : null },
      'conference.joinAnonymous': { supported: anonymousBinding, available: anonymousReason === null,
        reason: anonymousReason, provider: 'vendor-join-by-id', requiresAnonymousSession: true,
        challengeHandling: 'interactive-vendor-ui', automaticVerificationSms: false,
        pending: !!pendingAnonymousJoin, step: pendingAnonymousJoin ? anonymousJoinStep() : null },
      'conference.joinLink': { supported: anonymousBinding, available: anonymousReason === null,
        reason: anonymousReason, provider: 'vendor-signed-random', requiresAnonymousSession: true,
        scope: 'configured-origin-online-link', offlineJoin: false, nativeIdPrefix: false,
        absentIdPrefix: ['omitted', 'null', 'empty-string'],
        unsupportedSemantics: {
          isOfflineJoin: 'native-offline-or-server-downgrade-flow',
          idPrefix: 'conference-site-prefix'
        },
        challengeHandling: 'interactive-vendor-ui', automaticVerificationSms: false,
        automaticExternalLaunch: false, completion: 'conference-state-and-own-participant' },
      'screen.setPermission': { supported: true, allowed: appSharePermission, configured: appShareConfigured,
        scope: 'app-local-screen-capture-override', sessionKey: appShareGrantSession,
        grantsServerPermission: false, grantsOsPermission: false },
      'language.set': { supported: localeBinding, available: localeBinding,
        reason: localeBinding ? null : 'LOCALE_BINDING_UNAVAILABLE', languages: ['zh-CN', 'en-US'],
        language: localeBinding ? vendor.selectors.selectLang(state()) : null },
      'audio.noise.set': noiseCapabilities(),
      'watermark.set': { supported: !!watermark, state: watermark ? watermark.state() : null },
      'ui.configure': { supported: !!uiPolicy, state: uiPolicy ? policyState().ui : null },
      'setRecordTipState': { supported: !!recordingTip, enabled: recordingTip.enabled,
        scope: 'local-recording-confirmation', grantsRecording: false, providerConsentAndIndicatorsUnchanged: true },
      'callOtherNumBtnConfigUISdk': { supported: false, available: false, reason: 'NATIVE_PSTN_DIALER_UI_UNAVAILABLE',
        detail: 'The native alternate-number call UI has no mapped web control. PSTN-number retrieval and conference invitation are separate real operations.' },
      'setCorpDepartMentInfo': { supported: !!uiPolicy, scope: 'local-participant-directory',
        trigger: 'native-roster-context-menu', hostOperation: 'host.directory.answer', remotePageGetsContacts: false },
      'setLogPath': { supported: !!sdkLog, available: !!sdkLog, scope: 'hrtc-media-log', adapterLogChanged: false },
      'getErrorMessage': { supported: typeof vendor.messages?.get === 'function', scope: 'active-meeting-provider',
        nativeRuntimeCatalogue: false, requiresInitializedEngine: true },
      'agreeVoiceprintStatement': { supported: !!voiceMedia,
        scope: voiceScope === 'anonymous-room-memory' ? 'local-room-statement' : 'local-account-consent',
        trustedRecorderConsent: voiceScope === 'anonymous-room-memory', automaticCapture: false },
      'showVoiceprintRecordWindow': { supported: !!voiceMedia, scope: 'local-recorder-window', automaticCapture: false },
      'configVoiceprintRecordWindow': { supported: !!voiceMedia, scope: 'local-reading-prompts', automaticCapture: false },
      'setEnableCapability': nativeCapabilities ? nativeCapabilities.state() :
        { supported: false, available: false, reason: 'CAPABILITY_PROVIDER_NOT_INITIALIZED' },
      'customVirtualBackground': customBackground ? customBackground.state() : { supported: false },
      'getRenderWindowInfo': renderCapability()
    };
  }
  async function requestConferenceControl(type, fields, confirm, dispatch) {
    requireJoined();
    requireFunction(vendor, 'getWebsocket');
    requireFunction(vendor, 'uuid');
    if (typeof type !== 'string') fail('VENDOR_ABI_MISMATCH', 'The verified CMS control type is absent');
    const info = vendor.selectors.selectConfInitData(state());
    const token = vendor.selectors.selectLoginInfo(state())?.accessToken;
    if (typeof token !== 'string' || !token) fail('AUTH_REQUIRED', 'The genuine conference-control token is absent');
    const session = sharingContext().sessionKey;
    const socket = vendor.getWebsocket();
    if (!socket || socket.readyState !== WebSocket.OPEN)
      fail('CMS_TRANSPORT_OFFLINE', 'The genuine conference-control connection is not open');
    for (const name of ['addEventListener', 'removeEventListener', 'send']) requireFunction(socket, name);
    const message = { action: vendor.constants.CONF_MSG_TYPE.CONF_CONTROL, type, sequence: vendor.uuid(),
      data: JSON.stringify({ conferenceID: info.conferenceID, confToken: 'Basic ' + btoa(token), ...fields }) };
    let responseBody = null;
    const completion = waitState(() => {
      if (sharingContext().sessionKey !== session || !snapshot().joined)
        fail('CONFERENCE_CHANGED', 'The conference-control session is no longer active');
      if (vendor.getWebsocket() !== socket || socket.readyState !== WebSocket.OPEN)
        fail('CMS_TRANSPORT_OFFLINE', 'The conference-control connection changed');
      return responseBody !== null && (!confirm || confirm());
    }, 'Confirming the genuine CMS ' + type + ' operation');
    const received = event => {
      if (typeof event.data !== 'string') return;
      let response;
      try { response = JSON.parse(event.data); } catch { return; }
      if (!response || response.sequence !== message.sequence || response.type !== type ||
          response.action !== message.action) return;
      try {
        const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        if (!data || !Object.prototype.hasOwnProperty.call(data, 'returnCode'))
          fail('INVALID_CONTROL_RESPONSE', 'The matching CMS response has no returnCode');
        if (data.returnCode !== 0 && data.returnCode !== '0')
          throw Object.assign(new Error(data.returnDesc || 'The server rejected the CMS ' + type + ' operation'),
            { code: data.returnCode, details: { response: data } });
        responseBody = data;
        pulse();
      } catch (error) { completion.cancel(error); }
    };
    const closed = () => completion.cancel(Object.assign(new Error('The conference-control connection closed'),
      { code: 'CMS_TRANSPORT_CLOSED' }));
    try {
      socket.addEventListener('message', received);
      socket.addEventListener('close', closed);
      if (dispatch) dispatch(message.sequence);
      else socket.send(JSON.stringify(message));
      await completion;
      return { sequence: message.sequence, conferenceId: String(info.conferenceID), response: responseBody };
    } catch (error) { completion.cancel(error); throw error; }
    finally {
      socket.removeEventListener('message', received);
      socket.removeEventListener('close', closed);
    }
  }
  async function renameSelf(params) {
    requireJoined();
    if (!params || typeof params.showName !== 'string' || !params.showName.trim())
      fail('INVALID_ARGUMENT', 'showName must be a nonempty in-meeting display name');
    const permission = renamePermission();
    if (permission.state !== 'allowed') fail(permission.reason, 'Current conference policy does not permit self renaming');
    const info = vendor.selectors.selectConfInitData(state());
    // Exact fields from module 491 sendRenameSelf. This is not Windows
    // show_name transport or generic account-profile editing.
    await requestConferenceControl(vendor.constants.CONF_CONTROL_TYPE?.RENAME,
      { participantID: info.participantID, newName: params.showName },
      () => ownParticipant()?.pinfoMap?.NAME === params.showName);
    return { confirmed: true, participantId: String(info.participantID), showName: params.showName,
      source: 'cms-response-and-participant-state' };
  }
  async function inviteParticipants(params) {
    requireJoined();
    if (!params || !Array.isArray(params.attendees) || !params.attendees.length ||
        params.attendees.some(attendee => !attendee || typeof attendee !== 'object' || Array.isArray(attendee)))
      fail('INVALID_ARGUMENT', 'attendees must contain genuine vendor attendee objects');
    requireFunction(vendor.invitation, 'addAttendees');
    // Module 2500 -> 51339 uses traceId as the CMS INVITE sequence. Fields
    // arrive normalized by main; the vendor sends attendees without inventing
    // native DLL DTOs, endpoints or role grants.
    const result = await requestConferenceControl(vendor.constants.LOCAL_NOTIFY_TYPE?.INVITE,
      { attendees: params.attendees }, null, traceId => vendor.store.dispatch(vendor.invitation.addAttendees({
        attendees: params.attendees, traceId, totalCount: params.attendees.length, inviteCount: params.attendees.length
      })));
    // INVITE returnCode only acknowledges the request. Per-invitee results
    // arrive separately in INVITERESULT_NOTIFY; no joined/partial result is inferred.
    return { accepted: true, confirmation: 'cms-response-only', ...result };
  }
  async function setLanguage(params) {
    if (!params || params.langCode !== 0 && params.langCode !== 1)
      fail('INVALID_ARGUMENT', 'langCode must be 0 (zh-CN) or 1 (en-US)');
    requireFunction(vendor.locale, 'switchLocale');
    requireFunction(vendor.selectors, 'selectLang');
    const language = params.langCode === 0 ? 'zh-CN' : 'en-US';
    const completion = waitState(() => vendor.locale.locale === language &&
      vendor.selectors.selectLang(state()) === language, 'Applying the genuine vendor locale');
    try {
      // Module 45264 emits change_language; the application loads intl, dayjs
      // and Ant Design locales before dispatching setLang. Never fake that state.
      // Keep this window's original lang query: main persists only confirmed
      // language for future windows, without re-entering the vendor URL loader.
      vendor.locale.switchLocale(language);
      await completion;
      return { confirmed: true, language, langCode: params.langCode, source: 'vendor-locale-state' };
    } catch (error) { completion.cancel(error); throw error; }
  }
  async function setNoiseReduction(params) {
    if (!params || typeof params.state !== 'boolean') fail('INVALID_ARGUMENT', 'state must be boolean');
    const capability = noiseCapabilities();
    if (!capability.available) fail(capability.reason, 'Noise suppression requires an existing, observable HRTC main audio track');
    const media = rtc();
    const session = sharingContext().sessionKey;
    const stream = media.localStream;
    const track = stream.getAudioTrack();
    // HRTC 1.10.96 getAudioTrack returns the real MediaStreamTrack. Its capture
    // defaults enable browser noiseSuppression; there is no Windows feature:10
    // or AI-noise API here. Change only that existing track, never initialize,
    // replace, unmute or capture a microphone/camera to implement a preference.
    // Keep the operation queue attached to the real, non-cancellable browser
    // promise; a deadline must not let a late change overtake the next request.
    await track.applyConstraints({ ...track.getConstraints(), noiseSuppression: { exact: params.state } });
    if (disposed || sharingContext().sessionKey !== session || !snapshot().joined ||
        rtc().rtcClient !== media.rtcClient || rtc().localStream !== stream ||
        stream.getAudioTrack() !== track || track.readyState !== 'live')
      fail('AUDIO_TRACK_CHANGED', 'The conference audio track changed before noise suppression completed');
    if (track.getSettings().noiseSuppression !== params.state)
      fail('NOISE_SUPPRESSION_UNCONFIRMED', 'The real audio track did not report the requested noise-suppression state');
    pulse();
    return { confirmed: true, state: params.state, source: 'hrtc-track-settings',
      scope: 'existing-main-audio-track', nativeFeature10Equivalent: false };
  }
  async function joinAnonymous(params, signedLink = false) {
    ensurePolicies();
    if (snapshot().joined) fail('ALREADY_IN_CONFERENCE', 'Leave the current meeting before an anonymous join');
    if (!params || params.isopen_mic !== undefined && typeof params.isopen_mic !== 'boolean' ||
        params.isopen_cam !== undefined && typeof params.isopen_cam !== 'boolean')
      fail('INVALID_ARGUMENT', 'Anonymous media choices must be explicit booleans');
    if (signedLink) {
      if (typeof params.random !== 'string' || !params.random ||
          params.nick_name !== undefined && typeof params.nick_name !== 'string' ||
          params.confId !== undefined && typeof params.confId !== 'string')
        fail('INVALID_ARGUMENT', 'Signed-link entry requires random and optional nick_name/confId strings');
      window.__welinkRequireOnlineLinkVariant(params, false, location.origin);
    } else if (typeof params.conf_id !== 'string' || !params.conf_id.trim() ||
        typeof params.nick_name !== 'string' || !params.nick_name.trim() ||
        params.conf_pwd !== undefined && typeof params.conf_pwd !== 'string')
      fail('INVALID_ARGUMENT', 'Anonymous join requires conf_id, nick_name and optional conf_pwd');
    if (signedLink) requireFunction(vendor.selectors, 'selectClientInfo');
    const callback = signedLink ? 'join-by-link' : 'join-by-id';
    if (sessionCredentials().accessTokens.length)
      fail('ANONYMOUS_SESSION_REQUIRED', 'Log out the real browser-derived session before an anonymous join; never substitute a native token or nonce');
    if (vendor.history?.location?.pathname !== '/j')
      fail('ANONYMOUS_JOIN_UI_REQUIRED', 'Open a clean anonymous vendor /j page so its real challenge UI remains available');
    requireFunction(vendor.join, 'joinFail');
    requireFunction(vendor.effects, 'take');
    requireFunction(vendor.history, 'listen');
    requireFunction(vendor.selectors, 'selectJoin');
    await withTimeout(host.whenRegistered(callback), 30000, 'Binding the genuine anonymous conference callback');
    ensurePolicies();
    // Recheck after callback registration: another vendor UI flow may have
    // authenticated or joined while the callback was being mounted.
    if (sessionCredentials().accessTokens.length) fail('ANONYMOUS_SESSION_REQUIRED', 'The browser session authenticated before anonymous joining');
    if (snapshot().joined) fail('ALREADY_IN_CONFERENCE', 'A conference became active before anonymous joining');
    if (vendor.history?.location?.pathname !== '/j')
      fail('ANONYMOUS_JOIN_UI_REQUIRED', 'The anonymous challenge page changed before joining');
    // Windows cmd102 uses the issuer's resolved confId, not idPrefix + the
    // invitation's ID. The WebRTC join itself uses this same clientInfo field.
    const previousInfo = signedLink && vendor.selectors.selectClientInfo(state())?.confInfo;
    pendingAnonymousJoin = { method: signedLink ? 'signed-random' : 'id' };
    const completion = waitState(current => {
      if (!current.joined || !ownParticipant()) return false;
      if (!signedLink) return matchesConference(current, params.conf_id);
      const info = vendor.selectors.selectClientInfo(state())?.confInfo;
      if (!info || info === previousInfo || !info.confID) return false;
      if (!matchesConference(current, String(info.confID)))
        fail('CONFERENCE_ID_MISMATCH', 'The connected meeting differs from the signed invitation resolution');
      return true;
    }, 'Joining the genuine anonymous conference', { timeout: 120000, methods: ['join', 'anonymous-join'] });
    pendingJoinCompletion = completion;
    let task, unlisten;
    try {
      task = vendor.sagaMiddleware.run(function* () {
        const action = yield vendor.effects.take(vendor.join.joinFail().type);
        const failure = action.payload || {};
        recordFailure('anonymous-join', null, Object.assign(new Error(failure.content || 'The vendor rejected anonymous joining'),
          { code: failure.code === undefined ? 'ANONYMOUS_JOIN_FAILED' : failure.code }));
      });
      task.toPromise().catch(error => recordFailure('anonymous-join', null, error));
      unlisten = vendor.history.listen(({ location: route }) => {
        if (route.pathname !== '/errors' && route.pathname !== vendor.constants.NAVIGATOR_FORCE_REJOIN) return;
        // The vendor joinFail listener navigates before the same dispatch reaches
        // our saga. The route is a fallback, not a more authoritative result.
        const reason = new URLSearchParams(route.search).get('key') || 'ANONYMOUS_JOIN_FAILED';
        queueMicrotask(() => completion.cancel(Object.assign(new Error('The vendor anonymous join flow reached an error page'),
          { code: reason })));
      });
      pulse();
      if (signedLink) {
        if (params.nick_name) {
          requireFunction(vendor.join, 'setNickName');
          requireFunction(vendor.selectors, 'getNickName');
          vendor.store.dispatch(vendor.join.setNickName(params.nick_name));
          if (vendor.selectors.getNickName(state()) !== params.nick_name)
            fail('LINK_NAME_NOT_APPLIED', 'The provider did not retain the requested initial nickname');
        }
        // The vendor moves the raw query value into /joinNow/:random. Its
        // router runs decodeURI(path) and then decodeURIComponent(param).
        // Encode for both layers so a literal %2B in an issued ticket stays %2B.
        await host.invokeRegistered(callback, { random: encodeURI(encodeURIComponent(params.random)) });
      } else {
        await host.invokeRegistered(callback, {
          confId: params.conf_id, password: params.conf_pwd || '', name: params.nick_name
        });
      }
      await completion;
      ensurePolicies();
      // Vendor DEFAULT_LOCAL_CONTROL starts every role muted/camera-off.
      // Only explicit opt-in enables real devices, through the same permission
      // and SDK-state checks as ordinary audio/video operations.
      if (params.isopen_mic === true) await setMedia('audio', true);
      if (params.isopen_cam === true) await setMedia('video', true);
    } catch (error) { completion.cancel(error); throw error; }
    finally {
      if (task && task.isRunning()) task.cancel();
      if (unlisten) unlisten();
      pendingAnonymousJoin = null;
      if (pendingJoinCompletion === completion) pendingJoinCompletion = null;
      pulse();
    }
    return snapshot();
  }
  async function join(params) {
    ensurePolicies();
    if (snapshot().joined) fail('ALREADY_IN_CONFERENCE', 'Leave the current meeting before joining another');
    if (!params || typeof params.nonce !== 'string' || !params.nonce ||
        typeof params.confId !== 'string' || !params.confId)
      fail('INVALID_JOIN_REQUEST', 'A genuine USG handoff nonce and conference ID are required');
    const completion = waitState(current => current.joined && matchesConference(current, params.confId),
      'Joining the conference', { timeout: 120000, methods: ['join'] });
    pendingJoinCompletion = completion;
    // This vendor callback expects raw nonce/ID/password fields. Its query
    // parser does not decode them; only the name is explicitly URI-decoded.
    try {
      await host.invokeRegistered('join-by-nonce', {
        nonce: params.nonce, confId: params.confId,
        enterCode: params.password || '', name: encodeURIComponent(params.name || ''),
        openMic: params.openMic === true, openCamera: params.openCamera === true
      });
      const result = await completion;
      ensurePolicies();
      return result;
    } catch (error) { completion.cancel(error); throw error; }
    finally { if (pendingJoinCompletion === completion) pendingJoinCompletion = null; }
  }
  async function leave(endConference = false) {
    requireJoined();
    if (moderation) moderation.revoke();
    if (endConference && vendor.selectors.selectOwn(state()).role !== vendor.constants.HOST)
      fail('HOST_DENIED', 'Only the real conference host can end the meeting');
    if (['preparing', 'starting', 'recording', 'stopping'].includes(recording.state().state))
      await recording.stop();
    const old = rtc();
    const client = old.rtcClient;
    const tracks = [old.localStream, old.localAuxStream].filter(Boolean)
      .flatMap(stream => [stream.getAudioTrack(), stream.getVideoTrack()]).filter(Boolean);
    let serverEnded = false;
    const completion = waitState(current => {
      if (endConference && vendor.selectors.selectConf(state()).modalTips.stopConfReason ===
          vendor.constants.STOP_CONF_REASON.CONF_IS_STOP) serverEnded = true;
      // HRTC 1.10.96 can retain CONNECTED on the retired client. Its fulfilled
      // leave and the provider's current RTC/MMR state are independent receipts.
      return completedLeaves.has(client) && !current.joined && !current.roomJoined &&
        current.connection === 'DISCONNECTED' && tracks.every(track => track.readyState === 'ended') &&
        (!endConference || serverEnded);
    }, endConference ? 'Ending the conference' : 'Leaving the conference',
    { methods: ['leave'], timeout: 45000 });
    vendor.store.dispatch(endConference ? vendor.actions.onEndConf() : vendor.actions.leaveConfBySelf());
    return completion;
  }
  async function setMedia(kind, enabled, consentedCmsInvitation = false) {
    requireJoined();
    if (typeof enabled !== 'boolean') fail('INVALID_ARGUMENT', 'enabled must be boolean');
    const constants = vendor.constants;
    const own = vendor.selectors.selectOwn(state());
    const policy = vendor.selectors.selectConfDynamicInfo(state());
    if (kind === 'audio') {
      // Provider 86989 -> 491.onMuteByCMS distinguishes a host invitation from
      // forbidden self-unmute. Only the private, consent-checked CMS consumer
      // above can supply this flag; public audio/video calls cannot.
      if (enabled && !consentedCmsInvitation && own.role !== constants.HOST && policy.canUnmute === constants.CAN_UNMUTE.NOT_ALLOWED)
        fail('HOST_DENIED', 'The host has disabled participant unmuting');
      const target = enabled ? constants.MUTE_STATE.UN_MUTE : constants.MUTE_STATE.MUTE;
      await run(vendor.view.onMuteMicrophoneImpl, { payload: { isMute: target } });
      if (ownParticipant()?.pinfoMap?.MUTE !== target || snapshot().audioEnabled !== enabled)
        fail('AUDIO_OPERATION_FAILED', 'The real microphone operation did not reach the requested state');
    } else {
      if (enabled && !consentedCmsInvitation && own.role !== constants.HOST && policy.allowOpenCamera === constants.ALLOW_OPEN_CAMERA.NOT_ALLOWED)
        fail('HOST_DENIED', 'The host has disabled participant cameras');
      const target = enabled ? constants.CAMERA_STATE.ON : constants.CAMERA_STATE.OFF;
      await run(vendor.view.onSetVideoMuteImpl, { payload: { cameraState: target } });
      if (ownParticipant()?.pinfoMap?.CAMERASTATE !== target || snapshot().videoEnabled !== enabled)
        fail('VIDEO_OPERATION_FAILED', 'The real camera operation did not reach the requested state');
    }
    pulse();
    return snapshot();
  }
  function speakerOutputs(media) {
    const outputs = new Set();
    const streams = new Set(Object.values(media.remoteStreams || {}));
    if (media.remoteAuxStream) streams.add(media.remoteAuxStream);
    for (const stream of streams) {
      requireFunction(stream, 'getAudioHRTCTrack');
      const track = stream.getAudioHRTCTrack();
      // Pinned HRTC 1.10.96 uses this real player element; its wrapper drops
      // the setSinkId promise and advances a cache before routing completes.
      if (track?.player_?.playerElement_) outputs.add(track.player_.playerElement_);
    }
    const topN = media.rtcClient.audioStreams4TopN;
    requireFunction(topN, 'getAudioStreams');
    const incoming = topN.getAudioStreams();
    if (!Array.isArray(incoming)) fail('VENDOR_ABI_MISMATCH', 'The HRTC top-N audio players are unavailable');
    for (const stream of incoming) if (stream.audiotag) outputs.add(stream.audiotag);
    return Array.from(outputs);
  }
  async function selectDevice(params) {
    if (moderation && ['audioinput', 'videoinput'].includes(params?.kind)) moderation.deviceChanged();
    const list = await devices();
    if (!params || !list.some(device => device.kind === params.kind && device.deviceId === params.deviceId))
      fail('DEVICE_NOT_FOUND', 'The requested device is not in the real device enumeration');
    const actions = vendor.actions;
    const before = snapshot();
    if (!before.joined) {
      const setter = { audioinput: 'setMicroPhoneDevice', audiooutput: 'setSpeakerDevice', videoinput: 'setVideoInputDevice' }[params.kind];
      if (!setter) fail('INVALID_DEVICE_KIND', 'Unsupported media device kind');
      requireFunction(actions, setter);
      vendor.store.dispatch(actions[setter](params.deviceId));
      return { selection: snapshot().selectedDevices, active: false };
    }
    const media = rtc(), client = media.rtcClient;
    const ensureCurrent = () => {
      const current = snapshot();
      if (rtc().rtcClient !== client || !current.joined || current.sessionKey !== before.sessionKey)
        fail('CONFERENCE_CHANGED', 'The device operation no longer belongs to the current media session');
    };
    let routing;
    if (params.kind === 'audiooutput') {
      const outputs = speakerOutputs(media);
      routing = await window.WelinkAudioOutput.apply({ elements: outputs, deviceId: params.deviceId, ensureCurrent });
      // Commit the provider preference/cache only after actual media sinks
      // completed. The SDK may repeat the now-idempotent setSinkId call.
      await run(vendor.view.setAudioOutPut, params.deviceId);
      requireFunction(client, 'setAudioOutput4TopThree');
      await client.setAudioOutput4TopThree(params.deviceId);
      ensureCurrent();
      const currentOutputs = speakerOutputs(rtc());
      if (currentOutputs.length !== outputs.length || currentOutputs.some(element => !outputs.includes(element) || element.sinkId !== params.deviceId))
        fail('AUDIO_OUTPUT_CHANGED', 'Receiving audio players changed during selection; refresh before applying again');
    } else {
      const deviceType = params.kind === 'audioinput' ? vendor.constants.MEDIA_TYPE.AUDIO : vendor.constants.MEDIA_TYPE.VIDEO;
      await run(vendor.view.switchDevice, { payload: { deviceType, device: params.deviceId } });
    }
    ensureCurrent();
    if (snapshot().selectedDevices[params.kind] !== params.deviceId)
      fail('DEVICE_SELECTION_FAILED', 'The actual SDK did not retain the selected device');
    return { selection: snapshot().selectedDevices, active: routing ? routing.verified : true,
      ...(routing ? { routing } : {}) };
  }
  function screenPermission() {
    const current = sharingContext();
    return { allowed: current.appSharePermission, configured: current.appShareConfigured,
      sessionKey: current.sessionKey, grantSessionKey: current.appShareGrantSession, joined: current.joined,
      providerAndApp: current.sharingPermission, reason: current.reason,
      scope: 'app-local-screen-capture-override', grantsServerPermission: false, grantsOsPermission: false };
  }
  async function setSharePermission(params) {
    if (!params || typeof params.allowed !== 'boolean') fail('INVALID_ARGUMENT', 'allowed must be boolean');
    const aux = rtc().localAuxStream;
    const session = sharingContext();
    if (params.sessionKey !== undefined && (typeof params.sessionKey !== 'string' ||
        !params.sessionKey || params.sessionKey !== session.sessionKey))
      fail('CONFERENCE_CHANGED', 'The screen permission belongs to another meeting session');
    if (params.allowed && (!session.joined || params.sessionKey !== session.sessionKey))
      fail('CONFERENCE_REQUIRED', 'A screen grant requires the current joined sessionKey');
    appSharePermission = params.allowed;
    appShareConfigured = true;
    appShareGrantSession = params.allowed ? session.sessionKey : null;
    pulse();
    if (!params.allowed) {
      const stopping = aux && stoppingAux.get(aux);
      if (stopping) await stopping;
      else if (aux && managedAux.has(aux)) await stopManagedAux(aux);
      else if (snapshot().joined) await share(false);
      else if (aux) await run(vendor.sharing.stopAuxStreamImpl);
      const video = aux && typeof aux.getVideoTrack === 'function' ? aux.getVideoTrack() : null;
      const audio = aux && typeof aux.getAudioTrack === 'function' ? aux.getAudioTrack() : null;
      const main = rtc().localStream;
      const borrowedAudio = main && typeof main.getAudioTrack === 'function' && main.getAudioTrack() === audio;
      if (snapshot().screenSharing || video?.readyState === 'live' || audio?.readyState === 'live' && !borrowedAudio)
        fail('SCREEN_REVOCATION_UNCONFIRMED', 'The real screen capture did not stop after permission was revoked');
    }
    return { ...screenPermission(), sharing: snapshot().screenSharing };
  }
  async function share(enabled, params = {}, startEpoch = screenCancellationEpoch) {
    if (enabled) ensurePolicies();
    requireJoined();
    const previousAux = rtc().localAuxStream;
    if (!enabled) {
      if (previousAux && managedAux.has(previousAux)) return stopManagedAux(previousAux);
      if (!previousAux && !snapshot().screenSharing) return snapshot();
      const completion = waitState(current => !current.screenSharing &&
        (!previousAux || !published.has(previousAux)), 'Unpublishing the screen stream',
      { methods: ['unpublish'], auxiliary: true });
      try {
        await run(vendor.sharing.stopAuxStreamImpl);
        await completion;
        return snapshot();
      } catch (error) { completion.cancel(error); throw error; }
    }
    if (params.audio !== undefined && typeof params.audio !== 'boolean')
      fail('INVALID_ARGUMENT', 'Screen audio must be explicitly enabled or disabled');
    const audio = params.audio === true;
    if (params.audioInputId !== undefined &&
        (!audio || typeof params.audioInputId !== 'string' || !params.audioInputId ||
         params.audioInputId === 'default' || params.audioInputId === 'communications'))
      fail('INVALID_AUDIO_SOURCE', 'Audio input sharing requires audio:true and an explicitly selected concrete device');
    if (snapshot().screenSharing) {
      const previous = managedAux.get(previousAux);
      if (previous && previous.audio === audio && previous.audioInputId === params.audioInputId &&
          (params.sourceId === undefined || params.sourceId === previous.sourceId)) return snapshot();
      if (!previous && !audio && params.sourceId === undefined) return snapshot();
      fail('SCREEN_SHARE_ALREADY_ACTIVE', 'Stop the current screen share before changing its source or audio');
    }
    if (pendingScreen || invitedShareGuard?.capturePending()) fail('SCREEN_CAPTURE_IN_PROGRESS', 'A display capture request is already pending');
    const context = sharingContext(true);
    if (context.sharingPermission !== 'allowed')
      fail(context.reason, 'Current vendor role and sharing policy do not permit screen sharing');
    if (audio) {
      const track = context.localStream && context.localStream.getAudioTrack();
      if (!track || track.readyState !== 'live')
        fail('MAIN_AUDIO_TRACK_MISSING', 'The genuine HRTC mixer requires an existing main audio track; no microphone will be opened automatically');
      if (params.audioInputId) {
        const inputs = await capture.listAudioInputs();
        if (!inputs.some(input => input.deviceId === params.audioInputId))
          fail('AUDIO_DEVICE_NOT_FOUND', 'The explicitly selected audio input is not currently enumerated');
      } else if (!nativeDisplayMedia || !captureEnvironment.nativeDisplayMediaConfigured ||
          captureEnvironment.displayAudio !== 'system') {
        throw Object.assign(new Error('This session has no default-output monitor route; no microphone fallback was used'),
          { code: 'SYSTEM_AUDIO_ROUTE_UNAVAILABLE', details: screenAudioCapabilities() });
      }
    }
    if (startEpoch !== screenCancellationEpoch)
      fail('CAPTURE_CANCELLED', 'Screen sharing was cancelled before capture began');
    const request = { audio, audioInputId: params.audioInputId, sourceId: params.sourceId,
      client: rtc().rtcClient, aux: null, capture: null, initializing: false, cancelled: false,
      abort: new AbortController(), error: null, cleanupError: null };
    lastCaptureError = null;
    const completion = waitState(current => {
      if (request.error) throw request.error;
      return current.screenSharing && rtc().localAuxStream === request.aux &&
        (!audio || current.screenAudioEnabled);
    }, 'Publishing the genuine screen stream', { methods: ['publish'], auxiliary: true });
    let task;
    request.cancel = () => {
      request.cancelled = true;
      request.error = request.error || Object.assign(new Error('Screen capture was cancelled by a Stop request'),
        { code: 'CAPTURE_CANCELLED' });
      completion.cancel(request.error);
      request.abort.abort();
      if (task && task.isRunning()) task.cancel();
    };
    pendingScreen = request;
    try {
      task = vendor.sagaMiddleware.run(vendor.sharing.onStartAuxStreamImpl,
        { payload: { forceShare: false, needSendInviteOpenShareToCms: false } });
      const saga = task.toPromise();
      // A wait-state failure also cancels an outstanding capture prompt's result.
      // Success still waits for the genuine saga and its SDK promise outcomes.
      await Promise.race([saga, completion]);
      await saga;
      if (request.error) throw request.error;
      if (!request.aux || rtc().localAuxStream !== request.aux || !live(request.aux.getVideoTrack()))
        fail('SCREEN_CAPTURE_FAILED', 'The genuine SDK did not retain the requested screen capture');
      await completion;
      return snapshot();
    } catch (error) {
      completion.cancel(error);
      request.cancelled = true;
      request.abort.abort();
      if (task && task.isRunning()) task.cancel();
      if (request.aux && managedAux.has(request.aux)) {
        try { await stopManagedAux(request.aux); }
        catch (cleanupError) {
          request.cleanupError = cleanupError;
          error.details = { ...error.details, cleanup: {
            code: cleanupError.code || 'SCREEN_CLEANUP_FAILED', message: String(cleanupError.message || cleanupError) } };
        }
      }
      throw error;
    } finally {
      if (pendingScreen === request) pendingScreen = null;
    }
  }
  async function perform(operation, params, startEpoch, recordEpoch) {
    if (operation === 'initialize') return initialize(params);
    if (operation === 'session.credentials') return sessionCredentials();
    if (!initialized || disposed) fail('NOT_INITIALIZED', 'The genuine media runtime is not ready');
    switch (operation) {
      case 'sdkLog.flush': if (sdkLog) await sdkLog.flush(); return { flushed: !!sdkLog };
      case 'capability.configure': return nativeCapabilities.configure(params);
      case 'background.configure': return customBackground.configure(params.enabled);
      case 'background.state': return customBackground.state();
      case 'background.import': return customBackground.importImage(params);
      case 'background.apply': ensurePolicies(); return customBackground.apply();
      case 'background.clear': return customBackground.clear();
      case 'moderation.state': return moderation.state();
      case 'moderation.microphoneConsent': return moderation.requestConsent(params);
      case 'moderation.control': return moderation.control(params);
      case 'voice.configure':
        if (!voiceMedia) fail('VOICE_MEDIA_UNAVAILABLE', 'No local microphone processor was installed');
        return voiceMedia.configure(params.enabled, params.unavailable);
      case 'watermark.set':
      case 'ui.configure': return configurePolicy(operation, params);
      case 'watermark.state': return watermark.state();
      case 'watermark.ensure': return watermark.ensure(params.scope);
      case 'ui.state': return uiPolicy.state();
      case 'directory.target': return uiPolicy.directoryTarget(params);
      case 'directory.current': return uiPolicy.directoryCurrent(params);
      case 'policies.ensure': return ensurePolicies();
      case 'render.inspect':
      case 'render.surface.inspect':
      case 'render.surface.open':
      case 'render.surface.frame':
      case 'render.surface.close':
      case 'render.capture': return renderOperation(operation, params);
      case 'devices.list': return devices();
      case 'device.select': return selectDevice(params);
      case 'call.p2p.watch':
        if (typeof params.attemptId !== 'string' || !params.attemptId || typeof params.conferenceID !== 'string' || !params.conferenceID)
          fail('INVALID_ARGUMENT', 'The originating call attempt and conference must be present');
        watchP2p(params.attemptId, params.conferenceID);
        return {watching:true};
      case 'call.p2p.unwatch':
        if (p2pWatch?.attemptId === params.attemptId) clearP2pWatch();
        return {watching:!!p2pWatch};
      case 'conference.join': return join(params);
      case 'conference.joinAnonymous': return joinAnonymous(params);
      case 'conference.joinLink': return joinAnonymous(params, true);
      case 'conference.invite': return inviteParticipants(params);
      case 'participant.rename': return renameSelf(params);
      case 'language.set': return setLanguage(params);
      case 'audio.noise.set': return setNoiseReduction(params);
      case 'features.get': return features();
      case 'error.describe': {
        const code = params.code;
        if (!Number.isInteger(code) || code < -2147483648 || code > 2147483647 || typeof vendor.messages?.get !== 'function') return null;
        const entries = [];
        for (const ns of ['CMS', 'MMC']) {
          const key = ns + '.' + code, text = vendor.messages.get(key);
          // Do not print templates requiring vendor UI interpolation, HTML or fallback keys.
          if (typeof text === 'string' && text.trim() && text !== key && !/[<>{}]/.test(text)) entries.push(text);
        }
        if (!entries.length || entries.some(t => t !== entries[0])) return null;
        return { errMessage: entries[0], source: 'active-meeting-provider', language: vendor.locale.locale, nativeRuntimeCatalogue: false };
      }
      case 'conference.leave': return leave();
      case 'conference.end': return leave(true);
      case 'audio.setEnabled': return setMedia('audio', params.enabled);
      case 'video.setEnabled': return setMedia('video', params.enabled);
      case 'screen.start': return share(true, params, startEpoch);
      case 'screen.stop': return share(false);
      case 'screen.setPermission': return setSharePermission(params);
      case 'screen.permission': return screenPermission();
      case 'screen.audioInputs': return { inputs: await capture.listAudioInputs(), capabilities: screenAudioCapabilities() };
      case 'recording.capabilities': return recordingCapabilities();
      case 'recordTip.configure': {
        const result = recordingTip.configure(params.enabled); syncRecordingTip(); return result;
      }
      case 'recording.start': return startRecording(params, recordEpoch);
      case 'recording.stop': return recording.stop();
      case 'recording.requestPermission': return requestRecordingPermission(params);
      case 'recording.answerPermission': return recordingControl.answerPermission({ requestId: params.requestId, allow: params.allow });
      case 'recording.grant': return recordingControl.grant({ participantId: params.participantId, allowed: params.allowed });
      case 'state.get': return snapshot();
      case 'dispose': {
        if (snapshot().joined) fail('CONFERENCE_ACTIVE', 'Leave the real conference before disposing its runtime');
        nativeCapabilities.dispose();
        await invitedShareGuard.dispose();
        moderation.dispose();
        if (voiceMedia) await voiceMedia.dispose();
        if (customBackground) await customBackground.dispose();
        customBackgroundPolicy?.dispose();
        recordingTip.dispose();
        await recording.dispose();
        await recordingControl.dispose();
        for (const aux of Array.from(managedAux.keys())) await stopManagedAux(aux);
        capture.dispose();
        host.setUiInviteHandler(null);
        uiPolicy.dispose();
        watermark.dispose();
        if (navigator.mediaDevices.getDisplayMedia === displayMediaHook)
          navigator.mediaDevices.getDisplayMedia = vendorDisplayMedia;
        if (disposeInviteOwner) disposeInviteOwner();
        if (sdkLog) { await sdkLog.dispose(); sdkLog = null; }
        disposed = true;
        if (unsubscribe) unsubscribe();
        if (rtc().HRTC === captureSdk) vendor.store.dispatch(vendor.actions.setHrtc(sdk));
        navigator.mediaDevices && navigator.mediaDevices.removeEventListener('devicechange', deviceChanged);
        for (const [client, originals] of observedClients) {
          client.off('connection-state-changed', pulse);
          for (const [name, original] of Object.entries(originals)) client[name] = original;
        }
        for (const check of Array.from(waiters)) check();
        observedClients.clear();
        return { disposed: true };
      }
      default: fail('UNSUPPORTED_OPERATION', 'The vendor media bridge does not implement ' + operation);
    }
  }
  function rpcResult(result) {
    return Promise.resolve(result).then(data => ({ ok: true, data }), error => ({
      ok: false, error: {
        code: error && error.code !== undefined ? error.code : 'MEDIA_OPERATION_FAILED',
        message: String(error && error.message || error),
        ...(error && error.details !== undefined ? { details: error.details } : {})
      }
    }));
  }
  const api = Object.freeze({ invoke(operation, params = {}) {
    if (operation.startsWith('render.surface.'))
      return rpcResult(Promise.resolve().then(() => perform(operation, params)));
    if (['background.state', 'background.configure', 'background.clear'].includes(operation))
      return rpcResult(Promise.resolve().then(() => perform(operation, params)));
    if (['state.get', 'features.get', 'watermark.state', 'watermark.ensure', 'ui.state',
      'call.p2p.watch', 'call.p2p.unwatch', 'policies.ensure', 'screen.permission', 'recordTip.configure', 'capability.configure', 'voice.configure', 'session.credentials'].includes(operation))
      return rpcResult(Promise.resolve().then(() => perform(operation, params)));
    if (operation === 'screen.setPermission' && params?.allowed === true) {
      const result = Promise.resolve().then(() => perform(operation, params));
      queue = Promise.allSettled([queue, result]).then(() => {});
      return rpcResult(result);
    }
    if (operation === 'watermark.set' || operation === 'ui.configure') {
      // Privacy/tenant changes must not wait behind a join/challenge dialog.
      const result = Promise.resolve().then(() => perform(operation, params));
      queue = Promise.allSettled([queue, result]).then(() => {});
      return rpcResult(result);
    }
    const startEpoch = screenCancellationEpoch;
    const recordEpoch = recordingCancellationEpoch;
    let stoppingRecording;
    if (operation === 'recording.stop') {
      ++recordingCancellationEpoch;
      if (pendingRecordingPermission) pendingRecordingPermission.abort();
      if (recording) {
        // Interrupt an open file/permission prompt or encoder immediately.
        // Completion below still awaits real chunks, sink close/abort and status.
        try { stoppingRecording = recording.stop(); }
        catch (error) { stoppingRecording = Promise.reject(error); }
        stoppingRecording.catch(() => {});
      }
    }
    let cancelledStart;
    const revokePermission = operation === 'screen.setPermission' && params && params.allowed === false && initialized &&
      (params.sessionKey === undefined || params.sessionKey === sharingContext().sessionKey);
    if (operation === 'screen.stop' || revokePermission) {
      if (revokePermission) {
        appSharePermission = false;
        appShareGrantSession = null;
        appShareConfigured = true;
        pulse();
      }
      ++screenCancellationEpoch;
      cancelledStart = pendingScreen;
      // Cancellation must reach the active start before waiting on its queue.
      // The queued Stop below still waits for genuine SDK teardown and errors.
      if (cancelledStart) cancelledStart.cancel();
    }
    const result = queue.then(() => {
      if (operation === 'screen.start' && startEpoch !== screenCancellationEpoch)
        fail('CAPTURE_CANCELLED', 'The queued screen start was cancelled');
      if (cancelledStart && cancelledStart.cleanupError) throw cancelledStart.cleanupError;
      if (operation === 'recording.start' && recordEpoch !== recordingCancellationEpoch)
        fail('RECORDING_CANCELLED', 'The queued recording start was cancelled');
      if (stoppingRecording) return stoppingRecording;
      return perform(operation, params, startEpoch, recordEpoch);
    });
    queue = result.catch(() => {});
    // Preserve the real SDK's error code through Electron's context boundary.
    return rpcResult(result);
  } });
  Object.defineProperty(window, '__welinkNativeMeeting', { value: api });
})();
