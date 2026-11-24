'use strict';

const { createOfflineControl } = require('./meeting_offline_control');
const { OfflineMeetingWindow } = require('./meeting_offline_window');
const { createPolicy } = require('./meeting_moderation_capabilities');
const fail = (code, message) => Object.assign(new Error(message), {code});

// Owns both halves of one cmd102. A lease is not a membership: publish joined
// only after HRTC, JoinConfNotify and the CMS subscription have all completed.
class OfflineConference {
  constructor({electron, parentWindow, getConfig, getSession, permission, askDevice, notify, anonymousVoice, onRenderSurfaces}) {
    Object.assign(this, {electron, parentWindow, getConfig, getSession, permission, askDevice, notify, anonymousVoice, onRenderSurfaces});
    this.active = null;
    this.moderationPolicy = createPolicy();
  }
  get window() { return this.active?.view?.window || null; }
  getState() { return this.active?.control?.getState() || {state:this.active ? 'connecting' : 'idle'}; }
  async join(params, policy, isCurrent) {
    if (this.active) throw fail('OFFLINE_BUSY','An offline meeting is already active');
    const a = this.active = {closed:false, closing:null, control:null, view:null, mediaState:null, receipt:null};
    const current = () => this.active === a && !a.closed && isCurrent();
    const check = () => { if (!current()) throw fail('OFFLINE_RETIRED','The offline session is no longer current'); };
    const lost = error => {
      if (this.active !== a || a.closing) return;
      this.notify({type:'state',state:'failed',conferenceID:params.confId,error:{code:error.code, message:error.message}});
      this.close(a, true).catch(() => {});
    };
    try {
      const config = await this.getConfig(); check();
      const watermark = policy || config.watermark;
      if (!watermark || typeof watermark.content !== 'string') throw fail('MEETING_POLICY_NOT_CONFIGURED','Offline watermark policy is unavailable');
      if (!params.isOfflineJoin && config.isServerDowngrade !== true) throw fail('OFFLINE_VARIANT_REQUIRED','No current native downgrade or offline invitation');
      const view = a.view = new OfflineMeetingWindow({electron:this.electron,parentWindow:this.parentWindow,
        requestPermission:this.permission, onLeave:() => this.close(a,false).catch(lost), onFailure:lost,
        onModeration: (operation, data) => this.moderationOperation(operation, data),
        onRenderSurfaces: async action => {
          check();
          if (typeof this.onRenderSurfaces !== 'function') throw fail('RENDER_HOST_UNAVAILABLE', 'Native render host is not bound');
          const receipt = await this.onRenderSurfaces(action); check(); return receipt;
        },
        voice: this.anonymousVoice ? {
          session: () => this.anonymousVoice.session(a), show: () => this.anonymousVoice.show(),
          disable: () => this.anonymousVoice.disable(), state: () => this.anonymousVoice.state()
        } : null,
        onEvent:(event,data) => {
          if (!current()) return;
          if (event === 'offline-media-state') a.mediaState = data;
          if (event === 'moderation-device-change') {
            a.control?.deviceChanged();
            if (a.control) a.view?.updateModeration(a.control.moderationState());
          }
          if (event === 'voice-state') a.mediaState = { ...a.mediaState, voiceProtection: data };
          if (event === 'local-devices' && a.control?.getState().state === 'joined')
            a.control.reportLocalDevices(data).catch(lost);
        }});
      const control = a.control = createOfflineControl({getConfig:() => config, getSession:this.getSession, media:view,
        moderationPolicy: this.moderationPolicy,
        notify:event => {
          if (!current() || event.type === 'control') return; // Do not publish raw control frames or grants to the campus app.
          if (event.type === 'state' && view.live()) view.phase(event.state).catch(lost);
          if (event.type === 'state' || event.type === 'moderation-state')
            view.updateModeration(control.moderationState());
          if (event.type === 'media-invitation') {
            const {kind, invitationId}=event;
            let answered = false;
            Promise.resolve(view.askMediaInvitation(kind)).then(accepted => {
              answered = true;
              if (current()) return control.answerMediaInvitation(kind, accepted === true, invitationId);
            }).catch(async error => {
              // A busy/unavailable dialog is a refusal, never an unanswered
              // invitation that could later inherit another dialog's consent.
              if (current() && !answered) await control.answerMediaInvitation(kind, false, invitationId).catch(() => {});
              if (current()) this.notify({ type: 'moderation-error', code: error.code, message: error.message });
            });
          }
          this.notify(event);
          if (event.type === 'state' && event.state === 'failed' && !a.closing)
            queueMicrotask(() => { if (this.active === a) this.close(a,false).catch(() => {}); });
        }});
      await view.open(watermark,config); check();
      if (this.anonymousVoice) {
        await this.anonymousVoice.attach({ owner: a, window: view.window, isCurrent: current,
          getState: () => a.mediaState?.voiceProtection,
          configure: (enabled, voice) => view.request('voice.configure', { enabled, unavailable: enabled && !voice.allowed() }),
          onPolicy: state => view.request('voice.capability', state) });
        check();
        await view.request('voice.capability', this.anonymousVoice.state());
        check();
      }
      const result = await control.join({confId:params.confId,random:params.random,idPrefix:params.idPrefix,
        nick_name:params.nick_name,site_url:params.site_url,password:params.password,isOfflineJoin:params.isOfflineJoin===true || params.isOfflineJoin===1,
        isMicOn:params.isopen_mic===true,isCameraOn:params.isopen_cam===true},
        {isCurrent:current,isServerDowngrade:config.isServerDowngrade===true});
      check(); a.receipt=result;return result;
    } catch (error) {
      if (this.active === a) await this.close(a,false).catch(() => {});
      throw error;
    }
  }
  state() {
    const a=this.active, s=this.getState();
    return { ...a?.mediaState, joined:s.state==='joined' && a?.mediaState?.roomJoined===true && a.mediaState.connection==='CONNECTED',
      phase:s.state, conferenceId:s.conferenceID, participantId:s.participantID, source:'native-offline-control'};
  }
  setDevice(kind, enabled) {
    if (!this.active?.control || typeof enabled !== 'boolean') return Promise.reject(fail('OFFLINE_NOT_JOINED','No active offline participant'));
    return kind==='microphone' ? this.active.control.setMicrophone(enabled) : this.active.control.setCamera(enabled);
  }
  async selectDevice(params = {}) {
    const a = this.active, field = { audioinput: 'microphoneId', videoinput: 'cameraId', audiooutput: 'speakerId' }[params.kind];
    if (!a?.control || !field || typeof params.deviceId !== 'string')
      throw fail('INVALID_ARGUMENT', 'A current room and supported device selection are required');
    if (params.kind !== 'audiooutput') a.control.deviceChanged();
    const devices = await a.view.request('devices');
    if (!devices.some(device => device.kind === params.kind && device.deviceId === params.deviceId))
      throw fail('DEVICE_NOT_FOUND', 'The selected device is not in the real media enumeration');
    if (this.active !== a || a.closed || a.closing) throw fail('MODERATION_SESSION_RETIRED', 'The device owner changed');
    const receipt = await a.view.request('select', { [field]: params.deviceId });
    if (this.active !== a || a.closed || a.closing) throw fail('MODERATION_SESSION_RETIRED', 'The device owner changed');
    await a.control.reportLocalDevices(receipt);
    a.view.updateModeration(a.control.moderationState());
    return receipt;
  }
  moderationState() {
    return this.active?.control?.moderationState() || { ...this.moderationPolicy.state(), participants: [] };
  }
  async microphoneConsent(params = {}) {
    const a = this.active, control = a?.control;
    if (!control || a.closed || a.closing) throw fail('OFFLINE_NOT_JOINED', 'A current room is required for microphone consent');
    if (params.allow === false) {
      const result = await control.revokeMicrophoneConsent(); a.view.updateModeration(result); return result;
    }
    const before = control.moderationState();
    if (!before.scope) throw fail('OFFLINE_NOT_JOINED', 'A current admitted room is required for microphone consent');
    const accepted = await a.view.askMicrophoneConsent();
    if (this.active !== a || a.closed || a.closing || control.moderationState().scope !== before.scope ||
        control.moderationState().revision !== before.revision)
      throw fail('MODERATION_SESSION_RETIRED', 'The local consent dialog belongs to a retired room/device');
    if (!accepted) throw fail('MICROPHONE_CONSENT_REQUIRED', 'Microphone reminder suppression was declined locally');
    const result = control.grantMicrophoneConsent(before.scope); a.view.updateModeration(result); return result;
  }
  async configureCapability(type, enabled) {
    if (type === 3 && !enabled && !this.moderationPolicy.state().microphoneConsent) await this.microphoneConsent();
    if (this.active?.control) return this.active.control.configureCapability(type, enabled);
    this.moderationPolicy.configure(type, enabled);
    return { configured: true, type, enabled, advertisedOn: 'next-real-join',
      serverCapabilityAcknowledged: false, serverPermissionGranted: false, osPermissionGranted: false };
  }
  moderationControl(params) {
    if (!this.active?.control) return Promise.reject(fail('OFFLINE_NOT_JOINED', 'No current native control membership'));
    return this.active.control.moderationControl(params);
  }
  moderationOperation(operation, params = {}) {
    if (operation === 'state') return Promise.resolve(this.moderationState());
    if (operation === 'microphoneConsent') return params.allow === false ? this.microphoneConsent(params) : this.configureCapability(3, false);
    if (operation === 'control') return this.moderationControl(params);
    return Promise.reject(fail('INVALID_ARGUMENT', 'Unknown moderation operation'));
  }
  async close(a, retire) {
    if (!a) return {left:true};
    if (a.closing) return a.closing;
    // Schedule after assigning the promise: leave() can synchronously notify 'leaving'.
    a.closing = Promise.resolve().then(async () => {
      try {
        if (retire) {a.closed=true; return await a.control?.dispose();}
        return a.control ? await a.control.leave() : {left:true};
      } finally {
        try { if (this.anonymousVoice) await this.anonymousVoice.retire(a); }
        finally { a.closed=true; a.view?.close(); if (this.active===a) this.active=null; }
      }
    });
    return a.closing;
  }
  leave() { return this.close(this.active,false); }
  retire() { return this.close(this.active,true); }
}
module.exports = { OfflineConference };
