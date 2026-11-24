'use strict';

/* Narrow preload for the actual Huawei Linux WebRTC application. No Node API,
 * arbitrary IPC channel or native-adapter callback is exposed to the page. */
const { contextBridge, ipcRenderer } = require('electron');
const argument = process.argv.find(value => value.startsWith('--welink-meeting-channel='));
if (!argument) throw new Error('Missing private meeting IPC channel');
const channel = argument.substring('--welink-meeting-channel='.length);
const callbacks = new Map();
const registrationWaiters = new Map();
let uiInviteHandler = null;
let incomingRevision = 0;
let incomingOwner = null;
let captureRequestOwner = null;

function retireIncoming() {
  ++incomingRevision;
  incomingOwner?.retire();
}

function register(name, callback) {
  if (typeof callback !== 'function') throw new TypeError('Meeting callback must be a function');
  callbacks.set(name, callback);
  const waiters = registrationWaiters.get(name);
  if (waiters) {
    registrationWaiters.delete(name);
    for (const resolve of waiters) resolve(true);
  }
}

function registerObject(name, value) {
  register(name, value && value.callback);
}

function notify(name, data) {
  return ipcRenderer.invoke(channel, { operation: 'vendor-event', name, data });
}

// Huawei keeps the conference ID in its pending-invite store. Never send a late
// decision to a replacement invitation, even if the old window has just closed.
async function incomingInvite(invite) {
  if (!invite || ![0, 1].includes(invite.optType)) return;
  retireIncoming();
  const revision = incomingRevision;
  const callback = callbacks.get('incoming-result');
  const conference = invite.optType === 0 && incomingOwner?.current();
  if (invite.optType === 0 && (!callback || !conference)) return;
  const decision = await ipcRenderer.invoke(channel, { operation: 'incoming-invite',
    optType: invite.optType, conferenceID: conference || undefined, p2p: invite.p2p === true || invite.p2p === 1,
    subject: typeof invite.subject === 'string' ? invite.subject.slice(0, 256) : '', mediaType: invite.mediaType });
  if (invite.optType !== 0 || revision !== incomingRevision || callbacks.get('incoming-result') !== callback ||
      !incomingOwner || incomingOwner.current() !== conference) return;
  if (decision === 'accept') incomingOwner.accept(conference);
  else if (decision === 'decline') {
    if (typeof incomingOwner.decline === 'function') incomingOwner.decline(conference);
    else callback({ optType: 2 });
  }
}

contextBridge.exposeInMainWorld('hwCloudMeeting', {
  // This is the vendor's Linux-shell protocol identifier, not a Windows OS claim.
  platform: 'uospc',
  userAgent: navigator.userAgent + ' HuaweiMeeting',
  // Verified module 17837/97944 native custom-invitation bridge.
  getSupportCustomCapabilities: () => JSON.stringify({ inviteThirdUser: true }),
  inviteUsers: providerJson => {
    if (!uiInviteHandler) throw new Error('The native UI invitation policy is not initialized');
    return uiInviteHandler(providerJson);
  },
  onLogin: value => { retireIncoming(); return notify('login', value); },
  onLogout: () => { retireIncoming(); return notify('logout'); },
  onTokenChanged: value => { if (!value?.token) retireIncoming(); return notify('token-changed', value); },
  onUserInfoChanged: value => notify('user-info', value),
  onJoinConf: value => notify('joined', value),
  onLeaveConf: value => notify('left', value),
  onJoinConfResult: value => notify('join-result', value),
  onLeaveConfResult: value => notify('leave-result', value),
  onReturnPreMeeting: value => notify('return-pre-meeting', value),
  onInviteToJoin: value => incomingInvite(value).catch(() => {}),
  registerInviteToJoinResult: value => { retireIncoming(); registerObject('incoming-result', value); },
  getCaptureSourceInfo: types => ipcRenderer.invoke(channel, {
    operation: 'capture-sources', types, invitationRequestId: captureRequestOwner
  }),
  openHomePage: () => ipcRenderer.invoke(channel, { operation: 'home' }),
  openInnerUrl: url => ipcRenderer.invoke(channel, { operation: 'open-url', url }),
  registerJoinConfByNonce: value => registerObject('join-by-nonce', value),
  registerJoinConfById: callback => register('join-by-id', callback),
  registerLinkJoinConf: value => registerObject('join-by-link', value),
  registerForceLeaveConf: value => registerObject('force-leave', value),
  registerLogout: value => registerObject('logout', value),
  removeLogout: () => callbacks.delete('logout'),
  registerOnLogout: callback => register('on-logout', callback),
  removeOnLogout: () => callbacks.delete('on-logout'),
  registerPrivacySigned: value => registerObject('privacy-signed', value),
  removePrivacySigned: () => callbacks.delete('privacy-signed'),
  registerWindowStateChanged: value => registerObject('window-state', value),
  removeWindowStateChanged: () => callbacks.delete('window-state')
});

contextBridge.exposeInMainWorld('__welinkMeetingHost', {
  writeSdkLog: batch => ipcRenderer.invoke(channel, { operation: 'sdk-log-write', batch }),
  invalidateRenderSurfaces: data => ipcRenderer.invoke(channel, { operation:'render-surfaces-invalidate', data }),
  voiceOpen: () => ipcRenderer.invoke(channel, { operation: 'voice-open' }),
  voiceProcess: (id, pcm) => ipcRenderer.invoke(channel, { operation: 'voice-process', id, pcm }),
  voiceClose: id => ipcRenderer.invoke(channel, { operation: 'voice-close', id }),
  customBackgroundAssets: () => ipcRenderer.invoke(channel, { operation: 'custom-background-assets' }),
  setIncomingInviteOwner(owner) {
    if (owner !== null && (!owner || ['current', 'accept', 'retire'].some(key => typeof owner[key] !== 'function')))
      throw new TypeError('Expected an invitation owner');
    retireIncoming();
    incomingOwner = owner;
  },
  setUiInviteHandler(callback) {
    if (callback !== null && typeof callback !== 'function')
      throw new TypeError('The UI invitation handler must be a function or null');
    uiInviteHandler = callback;
  },
  recordingOpen({ requestId, mimeType, extension }) {
    return ipcRenderer.invoke(channel, { operation: 'recording-open', requestId, mimeType, extension });
  },
  recordingWrite({ handleId, sequence, chunk }) {
    return ipcRenderer.invoke(channel, { operation: 'recording-write', handleId, sequence, chunk });
  },
  recordingClose({ handleId }) {
    return ipcRenderer.invoke(channel, { operation: 'recording-close', handleId });
  },
  recordingAbort({ requestId, handleId }) {
    return ipcRenderer.invoke(channel, { operation: 'recording-abort', requestId, handleId });
  },
  recordingPermissionPrompt(data) {
    return ipcRenderer.invoke(channel, { operation: 'recording-permission-prompt', data });
  },
  captureEnvironment() {
    return ipcRenderer.invoke(channel, { operation: 'capture-environment' });
  },
  setCaptureRequestOwner(requestId) {
    if (requestId !== null && (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId)))
      throw new TypeError('Expected an invitation capture attempt ID');
    captureRequestOwner = requestId;
  },
  cancelCaptureRequest: requestId => ipcRenderer.invoke(channel, { operation: 'capture-source-cancel', requestId }),
  whenRegistered(name) {
    if (callbacks.has(name)) return Promise.resolve(true);
    return new Promise(resolve => {
      const waiters = registrationWaiters.get(name) || [];
      waiters.push(resolve);
      registrationWaiters.set(name, waiters);
    });
  },
  invokeRegistered(name, data) {
    const callback = callbacks.get(name);
    if (!callback) throw new Error('Vendor callback is not registered: ' + name);
    return callback(data);
  },
  emit(event, data) {
    if (!['media-state', 'devices-changed', 'recording-state', 'ui-custom-click',
      'directory-invalidated', 'p2p-control',
      'policy-violation', 'meeting-lifecycle'].includes(event))
      throw new Error('Unsupported native meeting event');
    return ipcRenderer.invoke(channel, { operation: 'runtime-event', event, data });
  }
});
