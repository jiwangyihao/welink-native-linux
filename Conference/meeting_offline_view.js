'use strict';
(() => {
  const host = window.offlineHost;
  const watermark = window.__welinkCreateNativeWatermark({onViolation:error => host.event('policy-error', {code:error.code})});
  const media = window.WelinkOfflineMedia.create({root:document.getElementById('media'), voiceHost: host,
    emit:(event, data) => host.event(event, data), onLeaveRequested:() => host.leave(),
    onLocalDevicesChanged:receipt => host.event('local-devices', receipt)});
  // Enumeration is not a device switch; revoke only on an actual topology
  // change (local selection is separately scoped by the reported device IDs).
  const moderationDevicesChanged = () => host.event('moderation-device-change', {});
  navigator.mediaDevices?.addEventListener('devicechange', moderationDevicesChanged);
  window.addEventListener('unload', () => navigator.mediaDevices?.removeEventListener('devicechange', moderationDevicesChanged), { once: true });
  const enroll = document.getElementById('voice-enroll'), disable = document.getElementById('voice-disable');
  const voiceStatus = document.getElementById('voice-state');
  let voicePending = false, voiceCapability = null, voiceError = null;
  function showVoiceState(state) {
    voiceCapability = state;
    const mediaState = media.voiceState();
    voiceStatus.textContent = voiceError || ('匿名声纹 / Anonymous voice: ' +
      (state.requested ? mediaState?.state || state.state : state.state) +
      (state.reason ? ' (' + state.reason + ')' : ''));
    enroll.disabled = voicePending || !state.enabled || !state.roomAvailable;
    disable.disabled = voicePending || !state.roomAvailable || !(state.requested || state.enrolled);
  }
  async function voiceAction(event, action) {
    if (!event.isTrusted || voicePending) return;
    voicePending = true; voiceError = null;
    if (voiceCapability) showVoiceState(voiceCapability);
    try { await action(); showVoiceState(await host.voiceState()); }
    catch (error) { voiceError = String(error?.message || 'Anonymous voice operation failed'); voiceStatus.textContent = voiceError; }
    finally { voicePending = false; if (voiceCapability) showVoiceState(voiceCapability); }
  }
  enroll.addEventListener('click', event => voiceAction(event, () => host.voiceShow()));
  disable.addEventListener('click', event => voiceAction(event, () => host.voiceDisable()));
  const voicePulse = setInterval(() => {
    if (!voicePending && voiceCapability?.roomAvailable)
      host.voiceState().then(showVoiceState, () => {});
  }, 500);
  window.addEventListener('unload', () => clearInterval(voicePulse), { once: true });
  let renderPhase = 'connecting';
  const renderInstance = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-');
  const renderWindows = window.__welinkCreateRenderWindows({
    root: document.getElementById('media'), watermark,
    ensurePolicy: () => ({ ready: watermark.ensure('meeting-ui').ready }),
    getState: () => {
      const state = media.snapshot();
      const sources = [];
      // These elements belong only to the packaged HRTC view for this room.
      // Detached players, local device previews and audio-only streams are not targets.
      for (const video of document.querySelectorAll('#media .offline-media-player video')) {
        if (video.closest('.offline-media-local') && !state.camera) continue;
        if (video.srcObject instanceof MediaStream)
          for (const track of video.srcObject.getVideoTracks()) sources.push({ track, kind: 'conference-video' });
      }
      return { joined: renderPhase === 'joined' && state.roomJoined && state.connection === 'CONNECTED',
        sessionKey: 'offline-' + renderInstance + '-' + state.sequence, conferenceId: state.conferenceID,
        localSharing: false, // This scoped offline view has no local screen-publication operation.
        source: 'offline-hrtc-render-media', sources };
    }
  });
  const renderSurface = window.__welinkCreateRenderSurface({
    collect: expected => renderWindows.surfaceEntries(expected), watermark,
    invalidate: data => host.invalidateRenderSurfaces(data)
  });
  const renderStart = document.getElementById('render-surface-start');
  const renderStatus = document.getElementById('render-surface-status');
  let renderPending = false;
  function showRenderSurfaces(receipt) {
    renderStatus.textContent = JSON.stringify(receipt, null, 2);
    renderStart.disabled = renderPending || renderPhase !== 'joined';
  }
  for (const action of ['start','inspect','stop']) {
    document.getElementById('render-surface-' + action).addEventListener('click', async event => {
      if (!event.isTrusted || renderPending) return;
      renderPending = true; renderStart.disabled = true;
      try { showRenderSurfaces(await host.renderSurfaceControl(action)); }
      catch (error) { renderStatus.textContent = String(error?.message || 'Native render access failed'); }
      finally { renderPending = false; renderStart.disabled = renderPhase !== 'joined'; }
    });
  }
  const labels = {connecting:'正在连接会议…', waiting:'正在等候主持人准入', joining:'正在加入媒体房间…',
    joined:'已加入会议', leaving:'正在退出会议…', left:'已退出会议', failed:'入会或连接失败'};
  document.getElementById('cancel').addEventListener('click', event => { if (event.isTrusted) host.leave(); });
  host.bind(async (operation, params) => {
    // Return the numeric SDK error across contextIsolation; throwing it through
    // the context bridge would drop its custom properties in Electron 22.
    try {
      let value;
      switch (operation) {
        case 'watermark': watermark.configure(params); value = watermark.ensure('meeting-ui'); break;
        case 'voice.capability': showVoiceState(params); value = { applied: true }; break;
        case 'voice.configure': value = await media.configureVoice(params.enabled, params.unavailable); break;
        case 'voice.state': value = media.voiceState(); break;
        case 'role': value = await media.setRole(params.role); break;
        case 'phase':
          renderPhase = params; renderSurface.pulse(); renderStart.disabled = renderPending || params !== 'joined';
          document.getElementById('progress').textContent = labels[params] || ''; value = true; break;
        case 'join': watermark.ensure('meeting-ui'); value = await media.join(params.grant, params.context); break;
        case 'leave': value = await media.leave(); break;
        case 'stats': value = await media.stats(); break;
        case 'devices': value = await media.enumerateDevices(); break;
        case 'select': value = await media.setDevices(params); break;
        case 'microphone': value = await media.setMicrophone(params.enabled, params.policy); break;
        case 'camera': value = await media.setCamera(params.enabled, params.policy); break;
        case 'render.inspect': value = renderWindows.inspect(params); break;
        case 'render.capture': value = renderWindows.capture(params); break;
        case 'render.surface.inspect': value = renderWindows.surfaceEntries(params).receipt; break;
        case 'render.surface.open': value = renderSurface.open(params); break;
        case 'render.surface.frame': value = renderSurface.frame(params); break;
        case 'render.surface.close': value = renderSurface.close(params); break;
        case 'render.surface.status': showRenderSurfaces(params); value = true; break;
        default: throw Error('Unknown offline media operation');
      }
      return {ok:true, value};
    } catch (e) { return {ok:false, code:e?.code ?? e?.getCode?.(), message:String(e?.message || e?.getMsg?.() || 'Media operation failed')}; }
  });
})();
