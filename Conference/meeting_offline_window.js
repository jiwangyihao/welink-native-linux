'use strict';

const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const PAGE = path.join(__dirname, 'meeting_offline.html');
const URL_OF_PAGE = pathToFileURL(PAGE).href;
const fail = (code, message) => Object.assign(new Error(message), { code });

// One private partition and one unprivileged, locally packaged document per
// offline conference. Neither the USG login nor the CMS wssToken crosses here.
class OfflineMeetingWindow {
  constructor({ electron, parentWindow, requestPermission, onLeave, onEvent, onFailure, voice, onModeration, onRenderSurfaces }) {
    this.electron = electron;
    this.parentWindow = parentWindow;
    this.requestPermission = requestPermission;
    this.onLeave = onLeave;
    this.onEvent = onEvent;
    this.onFailure = onFailure;
    this.voice = voice;
    this.onModeration = onModeration;
    this.onRenderSurfaces = onRenderSurfaces;
    this.moderationPrompt = null;
    this.pending = new Map();
    this.allowed = new Set();
    this.window = null;
    this.sequence = 0;
    this.closed = false;
    this.key = crypto.randomBytes(16).toString('hex');
    this.channel = 'welink-offline-' + this.key;
    this.receive = (e,m) => this.handle(e,m);
  }
  live() {
    return !this.closed && !!this.window && !this.window.isDestroyed() &&
      !this.window.webContents.isDestroyed() && this.window.webContents.getURL() === URL_OF_PAGE;
  }
  handle(event, m) {
    if (!this.live() || event.sender !== this.window.webContents || !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== URL_OF_PAGE || !m) return;
    if (m.event) {
      if (m.event === 'ready') { this.ready?.(); return; }
      if (m.event === 'leave') { this.onLeave(); return; }
      if (m.event === 'policy-error') {
        this.window.hide(); this.onFailure(fail('WATERMARK_ENFORCEMENT_LOST','The local meeting policy was lost')); return;
      }
      if (m.event === 'offline-media-failure' && m.data?.fatal) {
        this.onFailure(fail(m.data.code || 'OFFLINE_MEDIA_LOST', String(m.data.message || 'Offline media failed'))); return;
      }
      if (['local-devices','offline-media-state','offline-media-devices','offline-media-streams','moderation-device-change'].includes(m.event))
        this.onEvent(m.event, m.data);
      return;
    }
    const op = this.pending.get(m.id);
    if (!op) return;
    this.pending.delete(m.id); clearTimeout(op.timer);
    const result = m.ok === true && m.data;
    if (result?.ok === true) op.resolve(result.value);
    else op.reject(fail(result?.code ?? m.code ?? 'OFFLINE_MEDIA_ERROR', String(result?.message || m.message || 'Offline media operation failed')));
  }
  async handleVoice(event, message) {
    if (!this.live() || event.sender !== this.window.webContents || event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame?.url !== URL_OF_PAGE || !this.voice)
      throw fail('VOICE_NOT_AUTHORIZED', 'No current anonymous offline voice owner');
    const voice = this.voice.session();
    switch (message?.operation) {
      case 'state': {
        const media = await this.request('voice.state');
        this.onEvent('voice-state', media);
        return this.voice.state();
      }
      case 'show': return this.voice.show();
      case 'disable': return this.voice.disable();
      case 'close':
        if (typeof message.id !== 'string') throw fail('INVALID_ARGUMENT', 'Missing local audio handle');
        return voice ? voice.filter.close(message.id) : { closed: true };
      case 'open':
      case 'process':
        if (!voice?.allowed()) throw fail('VOICE_NOT_AUTHORIZED', 'Anonymous enrollment is not active');
        return message.operation === 'open' ? voice.open() : voice.process(message.id, message.pcm);
      default: throw fail('INVALID_VOICE_OPERATION', 'Unknown offline voice operation');
    }
  }
  async open(policy, config) {
    if (this.closed || this.window) throw fail('OFFLINE_WINDOW_RETIRED','The media document cannot be reused');
    const { BrowserWindow, ipcMain, session } = this.electron;
    const partition = this.channel, isolated = session.fromPartition(partition);
    if (config.proxyUrl) await isolated.setProxy({proxyRules:config.proxyUrl});
    if (this.closed) throw fail('OFFLINE_WINDOW_RETIRED','The offline request was retired before display');
    const win = this.window = new BrowserWindow({ width:1000,height:700,show:false,parent:this.parentWindow,
      title:'WeLink 会议', webPreferences:{session:isolated,preload:path.join(__dirname,'meeting_offline_preload.js'),
        additionalArguments:['--welink-offline='+this.key],sandbox:true,contextIsolation:true,nodeIntegration:false,
        webSecurity:true,webviewTag:false,allowRunningInsecureContent:false,backgroundThrottling:false,devTools:false} });
    this.session = isolated;
    const contents = win.webContents;
    win.setMenu(null); contents.setWindowOpenHandler(() => ({action:'deny'}));
    contents.on('will-navigate', e=>e.preventDefault());
    contents.on('will-redirect', e=>e.preventDefault());
    contents.on('will-attach-webview', e=>e.preventDefault());
    const proxy = config.proxyUrl && new URL(config.proxyUrl);
    contents.on('login',(e,_details,auth,reply)=>{
      e.preventDefault();
      if (this.live() && proxy && auth.isProxy && auth.host === proxy.hostname &&
          Number(auth.port) === Number(proxy.port || (proxy.protocol==='https:'?443:80)))
        reply(config.proxyUsername || '',config.proxyPassword || '');
      else reply();
    });
    isolated.setPermissionCheckHandler((wc,perm) => this.live() && wc===contents && this.allowed.has(perm));
    isolated.setPermissionRequestHandler((wc,perm,done,details) => {
      if (!this.live() || wc !== contents || details.isMainFrame !== true ||
          (details.requestingUrl && details.requestingUrl !== URL_OF_PAGE) ||
          !['media','speaker-selection'].includes(perm) ||
          (perm==='media' && Array.isArray(details.mediaTypes) && !details.mediaTypes.length)) return done(false);
      Promise.resolve(this.requestPermission?.(perm)).then(value=>{
        const yes=value===true && this.live(); if (yes) this.allowed.add(perm); done(yes);
      },()=>done(false));
    });
    isolated.on('will-download',e=>e.preventDefault());
    ipcMain.on(this.channel,this.receive);
    ipcMain.handle(this.channel + '-voice', (event, message) => this.handleVoice(event, message));
    ipcMain.handle(this.channel + '-surfaces', (event, message) => {
      if (!this.live() || event.sender !== contents || event.senderFrame !== contents.mainFrame ||
          event.senderFrame.url !== URL_OF_PAGE) throw fail('UNTRUSTED_SENDER', 'Foreign native surface owner');
      return this.renderSurfaceOwner?.invalidate(contents, message) || {retired:true};
    });
    ipcMain.handle(this.channel + '-surface-control', (event, action) => {
      if (!this.live() || event.sender !== contents || event.senderFrame !== contents.mainFrame ||
          event.senderFrame.url !== URL_OF_PAGE || !['start','inspect','stop'].includes(action))
        throw fail('UNTRUSTED_SENDER', 'Foreign native surface control');
      if (typeof this.onRenderSurfaces !== 'function') throw fail('RENDER_HOST_UNAVAILABLE', 'No native render host');
      return this.onRenderSurfaces(action);
    });
    win.on('close',e=>{ if (!this.closed) { e.preventDefault(); this.onLeave(); } });
    contents.once('render-process-gone',()=>{ if (!this.closed) this.onFailure(fail('OFFLINE_RENDERER_GONE','Offline media process exited')); });
    const ready = new Promise((yes,no)=>{this.ready=yes;this.rejectReady=no;});
    const timeout = setTimeout(()=>this.rejectReady?.(fail('OFFLINE_WINDOW_TIMEOUT','The local media page did not initialize')),15000);
    try { await Promise.all([win.loadFile(PAGE),ready]); await this.watermark(policy); }
    finally { clearTimeout(timeout); this.ready=null; this.rejectReady=null; }
  }
  request(operation,params) {
    if (!this.live()) return Promise.reject(fail('OFFLINE_WINDOW_RETIRED','No current offline media document'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(fail('OFFLINE_MEDIA_TIMEOUT','Offline media operation timed out'));},45000);
      this.pending.set(id,{resolve,reject,timer});
      try { this.window.webContents.send(this.channel,{id,operation,params}); }
      catch (error) {this.pending.delete(id);clearTimeout(timer);reject(error);}
    });
  }
  show() {
    if (!this.live() || !this.policyReady) throw fail('OFFLINE_WINDOW_UNAVAILABLE','The protected media surface is not ready');
    if (this.window.isMinimized()) this.window.restore(); this.window.show();
    return {visible:this.window.isVisible()};
  }
  async watermark(policy) {
    this.policyReady=false;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
    const revision=this.policyRevision=(this.policyRevision || 0)+1;
    const receipt=await this.request('watermark',policy);
    if (revision!==this.policyRevision || receipt?.ready!==true) throw fail('POLICY_REQUEST_RETIRED','Offline watermark not confirmed');
    this.policyReady=true; this.show(); return receipt;
  }
  join(grant,ctx) {
    if (!ctx.isCurrent() || ctx.signal?.aborted) return Promise.reject(fail('OFFLINE_RETIRED','Media admission is no longer current'));
    const {confID,participantID,displayName,isMicOn,isCameraOn,serviceTp,offlineJoinTemplate}=ctx;
    return this.request('join',{grant,context:{confID,participantID,displayName,isMicOn,isCameraOn,serviceTp,offlineJoinTemplate,
      identity:{orgID:ctx.identity?.orgID}}});
  }
  async leave() {
    await this.renderSurfaceOwner?.stop('RENDER_ROOM_LEAVING');
    if (!this.live()) return {roomJoined:false,connection:'DISCONNECTED'};
    const receipt=await this.request('leave');
    if (receipt?.state==='retirement-failed' || receipt?.roomJoined!==false || receipt?.connection!=='DISCONNECTED')
      throw fail('OFFLINE_MEDIA_LEAVE_FAILED','The media runtime could not retire the room');
    return receipt;
  }
  stats() { return this.request('stats'); }
  setMicrophone(enabled,policy) { return this.request('microphone',{enabled,policy}); }
  setCamera(enabled,policy) { return this.request('camera',{enabled,policy}); }
  setRole(role) { return this.request('role', { role }); }
  phase(state) {
    if (state !== 'joined') this.renderSurfaceOwner?.stop('RENDER_ROOM_NOT_JOINED').catch(() => {});
    return this.request('phase',state);
  }
  async askModeration(message, detail) {
    if (!this.live()) throw fail('OFFLINE_WINDOW_RETIRED', 'The local consent window was retired');
    if (this.moderationPrompt) throw fail('CONSENT_DIALOG_PENDING', 'A local moderation consent dialog is already open');
    const window = this.window, prompt = {};
    this.moderationPrompt = prompt;
    try {
      const answer = await this.electron.dialog.showMessageBox(window, { type: 'question', title: 'WeLink 会议设备同意',
        message, detail, buttons: ['拒绝 / Decline', '允许 / Allow'], defaultId: 0, cancelId: 0, noLink: true });
      return answer.response === 1 && this.live() && this.window === window && this.moderationPrompt === prompt;
    } finally { if (this.moderationPrompt === prompt) this.moderationPrompt = null; }
  }
  askMediaInvitation(kind) {
    const label = kind === 'microphone' ? '麦克风 / microphone' : '摄像头 / camera';
    return this.askModeration('主持人请求开启 / Host requests to open: ' + label,
      '仅允许此次请求。系统媒体许可仍然必需。\nAllow only this request. System media permission is still required.');
  }
  askMicrophoneConsent() {
    return this.askModeration('允许本次会议的麦克风重开请求，不再逐次提醒？',
      'For this meeting and current microphone only, allow the host to request reopening your microphone without another reminder. ' +
      'System permission is still required. Leaving, changing account/device or selecting Revoke in the menu cancels consent.');
  }
  updateModeration(state) {
    if (!this.live() || !this.onModeration) return;
    const run = (operation, params) => Promise.resolve(this.onModeration(operation, params)).catch(error => {
      if (this.live()) this.electron.dialog.showMessageBox(this.window, { type: 'warning', title: 'WeLink 会议管理',
        message: String(error.message || 'Moderation request failed'), buttons: ['OK'] }).catch(() => {});
    });
    const targets = (state.participants || []).map(member => ({ label: member.name || member.participantID,
      submenu: [['cohost', true, '设为联席主持人 / Make cohost'], ['cohost', false, '撤销联席主持人 / Remove cohost'],
        ['waiting', true, '移至等候室 / Move to waiting room'], ['microphone', true, '邀请开启麦克风 / Invite microphone'],
        ['microphone', false, '静音 / Mute'], ['camera', true, '邀请开启摄像头 / Invite camera'],
        ['camera', false, '关闭摄像头 / Close camera']].map(([operation, enabled, label]) => ({
          label, enabled: !!state.scope && !!state.role?.canModerate,
          click: () => run('control', { operation, enabled, participantID: member.participantID }) })) }));
    this.window.setMenu(this.electron.Menu.buildFromTemplate([{ label: '会议管理 / Moderation', submenu: [
      { label: '服务器角色 / Server role: ' + (state.role?.kind || 'unknown'), enabled: false },
      { id: 'moderation-microphone-consent', label: state.microphoneConsent ? '撤销麦克风同意 / Revoke microphone consent' :
        '允许本次会议麦克风重开 / Allow microphone requests for this room', enabled: !!state.scope,
        click: () => run('microphoneConsent', { allow: !state.microphoneConsent }) },
      { type: 'separator' }, ...targets
    ] }]));
  }
  close() {
    if (this.closed) return;
    this.closed=true; this.policyReady=false;
    this.renderSurfaceOwner?.stop('RENDER_ROOM_CLOSED').catch(() => {});
    this.moderationPrompt = null;
    const error=fail('OFFLINE_WINDOW_RETIRED','The scoped media document closed');
    this.rejectReady?.(error);
    for (const p of this.pending.values()) {clearTimeout(p.timer);p.reject(error);}
    this.pending.clear();this.allowed.clear();
    this.electron.ipcMain.removeListener(this.channel,this.receive);
    this.electron.ipcMain.removeHandler(this.channel + '-voice');
    this.electron.ipcMain.removeHandler(this.channel + '-surfaces');
    this.electron.ipcMain.removeHandler(this.channel + '-surface-control');
    if (this.session) {this.session.setPermissionCheckHandler(null);this.session.setPermissionRequestHandler(null);}
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window=null;
    if (this.session) {this.session.closeAllConnections().catch(()=>{});this.session.clearStorageData().catch(()=>{});}
  }
}
module.exports = { OfflineMeetingWindow };
