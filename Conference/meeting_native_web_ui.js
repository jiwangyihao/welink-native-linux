/* MAIN-world UI policy for the pinned Huawei WebRTC application; no Node APIs.
 * Source contracts (inspected, never evaluated during recovery):
 * - HIT APP hwmService.js modules 31/422: login customizes invite/guest_invite,
 *   participant_detail and vote; logout retains custom invitations and hidden
 *   vote but disables participant_detail. Module 31 customButtonStatus computes
 *   room eligibility; that account/tenant/booking computation stays in the app.
 * - main.3ee85ed7.js: 12646.setCustomerButton, 13903.BUTTON_POS_TYPES,
 *   4504.openEmitter/OPEN_EVENT_LIST, 53232.clickCustomerButton observer,
 *   17837/97944 hwCloudMeeting.getSupportCustomCapabilities()/inviteUsers().
 * - https://meeting.huaweicloud.com/webrtc/static/js/606.616fb575.chunk.js,
 *   module 38120 consumes {buttonId,desc:{zh,en},eventName,buttonPos};
 *   exactly one position "1" button, any number at position "0" in More.
 *   The control components render vote and generated invite/feedback controls
 *   button classes via module 70781.setUniqueId(LOCATION.CONTROL,name,TYPE.BUTTON).
 *   Te renders .attendees-name-title with id "attendees-name-title-" + pid.
 *   Those selectors cover normal, fullscreen, detached and rerendered PC UI.
 * - Desktop inviteUsers receives a JSON string from module 97944, containing
 *   vmrConfId, confId, selfConfRole and other sensitive fields. Only actual IDs
 *   are used below. Never call registerConfirmInvite's callback here: the main
 *   application's handleConfirmInvite dispatches addAttendees (real invitations).
 *
 * configure is a PATCH, not an SDK cmd/notify request:
 * { isUserLogined?: boolean,
 *   toolBar?: {button?: [{id,showAsAction?:'ifRoom'|'never',isCustomizedClick?:boolean}]},
 *   customButtonStatus?: null | {sessionKey,minutes:'hidden'|'start'|'pause',
 *     listenAndNote:boolean,labels?:{startMinutes:{zh,en},pauseMinutes:{zh,en},
 *       listenAndNote:{zh,en}}} }
 * state()/configure() return a defensive `configuration` snapshot of the last
 * successfully enforced persistent policy. It includes every toolbar setting
 * and customButtonStatus:null, so it can be replayed directly in a new window.
 * Current confirmed customButtonStatus is returned separately, only while its
 * sessionKey is active. It must never be included in new-window replay.
 * The app computes customButtonStatus using the original room/account rules.
 * This adapter additionally requires the actual joined session and host role
 * for minutes. Notes also require app login. No room booking data enters MMC.
 * Primary priority is listenAndNote, then minutes; the other uses More. This is
 * deliberately NOT native buttonPos 2 (the native sharing toolbar is absent).
 * The original two invitation IDs are NOT presumed mutually exclusive: invite
 * retains the real provider entry, guest_invite is a separate real More button.
 * attendee_access_control accepts only never: the native control is absent,
 * and state reports that absence explicitly rather than claiming API support.
 *
 * Parent mappings: ui.configure / ui.cancel / ui.update -> configure(patch);
 * ui.state -> state(); genuine preload inviteUsers(json) -> handleInvite(json).
 * Cancellation is the original logout policy, not disposal: isUserLogined:false,
 * participant_detail.isCustomizedClick:false, customButtonStatus:null; keep
 * invitations customized and vote hidden. App login must explicitly enable
 * participant_detail. The preload synchronous getSupportCustomCapabilities()
 * returns JSON.stringify({inviteThirdUser:true}) when this bridge is installed.
 * Before initial enforcement, await loadModule.e(702): the pinned
 * 702.07faf52f.chunk.js directly defines dependency-free module 70781.
 * All other required helper modules are in main. The provider owns desktop-route
 * loading and rendering; do not render it here.
 * No native config completion, numeric notify or DLL command is manufactured.
 *
 * emit('ui-custom-click', {buttonId,sessionKey,conferenceID,displayConferenceID?,
 *   participant?:{participantID,accountID?}}). App handlers recheck their own
 * current permissions and fetch room/account data; a click is only UI intent.
 */
(() => {
  'use strict';
  if (window.__welinkCreateNativeUiCustomization) return;

  const PREFIX = 'welink-native-ui-';
  const EVENT_PREFIX = 'welink.native.ui.';
  const PROFILE = '.attendees-name-title[id^="attendees-name-title-"]';
  const VOTE = '[id="control-banner-vote"]';
  const CUSTOM = '[id^="control-bar-extend-btn-' + PREFIX + '"]';
  const DEFAULT_LABELS = Object.freeze({
    startMinutes: Object.freeze({ zh: '自动纪要', en: 'Automatic minutes' }),
    pauseMinutes: Object.freeze({ zh: '暂停纪要', en: 'Pause minutes' }),
    listenAndNote: Object.freeze({ zh: '边听边记', en: 'Listen and take notes' })
  });
  const UNAVAILABLE = Object.freeze({
    attendee_access_control: 'No WebRTC toolbar control for native call-in restrictions. Meeting lock, waiting room and participant permissions are not equivalents.',
    moveall_to_waitingroom: 'No verified native move-all toolbar customization binding. Existing provider participant actions retain their own permissions.',
    call_other_number: 'No verified native PSTN toolbar customization binding.',
    shareMinutes: 'The WebRTC custom-button API has no native sharing-toolbar position 2.',
    shareListenAndNote: 'The WebRTC custom-button API has no native sharing-toolbar position 2.'
  });
  const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const identity = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const error = (code, message, details) => Object.assign(new Error(message), { code, details });
  function keys(value, allowed, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw error('INVALID_UI_CONFIG', path + ' must be an object');
    for (const key of Object.keys(value)) if (!allowed.includes(key))
      throw error('UI_CONFIG_UNSUPPORTED', path + '.' + key + ' is not a supported UI policy field', { field: path + '.' + key });
  }
  function boolean(value, path) {
    if (typeof value !== 'boolean') throw error('INVALID_UI_CONFIG', path + ' must be a boolean');
    return value;
  }
  function labels(value) {
    keys(value, Object.keys(DEFAULT_LABELS), 'customButtonStatus.labels');
    const result = { ...DEFAULT_LABELS };
    for (const [key, label] of Object.entries(value)) {
      keys(label, ['zh', 'en'], 'customButtonStatus.labels.' + key);
      for (const lang of ['zh', 'en']) if (typeof label[lang] !== 'string' || !label[lang].trim() || label[lang].length > 128)
        throw error('INVALID_UI_CONFIG', 'Each custom-button label requires nonempty zh/en text of at most 128 characters');
      result[key] = { zh: label.zh, en: label.en };
    }
    return result;
  }

  window.__welinkCreateNativeUiCustomization = function ({ vendor, loadModule, getSession, emit, onViolation }) {
    if (!vendor || typeof loadModule !== 'function' || typeof getSession !== 'function' || typeof emit !== 'function')
      throw error('UI_ABI_UNAVAILABLE', 'Genuine provider, module loader, session and semantic event bindings are required');
    function requireFunction(object, name) {
      if (typeof object?.[name] !== 'function') throw error('UI_ABI_MISMATCH', 'Missing genuine UI binding: ' + name);
    }
    for (const name of ['getState', 'dispatch', 'subscribe']) requireFunction(vendor.store, name);
    for (const name of ['selectOwn', 'selectConfInitData', 'selectParticipants', 'selectAudiences',
      'selectCustomerButton', 'selectEnableInviteThirdUser', 'getLoginAnthenticated',
      'getIsSupportGuestInviteParticipants', 'getVoteModalState', 'getFeedbackModalState'])
      requireFunction(vendor.selectors, name);
    for (const name of ['setCustomCapabilities', 'inviteUsers']) requireFunction(vendor.actions, name);
    const openActions = loadModule(12646);
    const openEvents = loadModule(4504);
    const openConstants = loadModule(13903);
    const voteActions = loadModule(1407);
    const feedbackActions = loadModule(53026);
    const platform = loadModule(52514);
    const mobile = loadModule(76046);
    const common = loadModule(58909);
    requireFunction(openActions, 'setCustomerButton');
    requireFunction(openActions, 'clickCustomerButton');
    requireFunction(openEvents.openEmitter, 'on');
    requireFunction(openEvents.openEmitter, 'removeListener');
    requireFunction(voteActions, 'setVoteModalVisible');
    requireFunction(feedbackActions, 'closeFeedbackModal');
    requireFunction(platform, 'isElectron');
    requireFunction(mobile, 'isMobile');
    requireFunction(common, 'getConfDisplayId');
    if (openConstants.BUTTON_POS_TYPES?.CONTROL_BAR !== '1' || openConstants.BUTTON_POS_TYPES?.MORE_EXTEND !== '0' ||
        openEvents.OPEN_EVENT_LIST?.CUSTOMER_OPERATE_RESULT !== 'customer_operate_result' ||
        vendor.constants.CONTROL_MENU_IDS?.VOTE !== 'vote' || !vendor.constants.SUPPORT_GUEST_INVITE_PARTICIPANTS)
      throw error('UI_ABI_MISMATCH', 'The inspected UI constants are not available');
    if (typeof MutationObserver !== 'function' || typeof window.CSS?.escape !== 'function')
      throw error('UI_ENFORCEMENT_UNAVAILABLE', 'Mutation observation and CSS selector escaping are required');

    let policy = {
      isUserLogined: false,
      buttons: {
        invite: { showAsAction: 'ifRoom', isCustomizedClick: true },
        guest_invite: { showAsAction: 'ifRoom', isCustomizedClick: true },
        participant_detail: { isCustomizedClick: false },
        vote: { showAsAction: 'never' },
        feedback: { showAsAction: 'ifRoom' },
        attendee_access_control: { showAsAction: 'never' }
      },
      room: null
    };
    let revision = 0, configured = false, disposed = false, applying = false, scheduled = false;
    let confirmedPolicy = null, confirmedRevision = 0;
    let selectors = null, lastError = null, lastViolation = '', pendingInvite = null, pendingCustom = null;
    let activeButtons = [], lastProfileParticipants, lastProfileAudiences, profilesDirty = true;
    const decorations = new Map();
    let directoryLease = null, directoryHit = null;
    const style = document.createElement('style');
    style.id = PREFIX + 'policy';

    function facts() {
      const state = vendor.store.getState();
      return { state, session: getSession() || {}, own: vendor.selectors.selectOwn(state) || {},
        info: vendor.selectors.selectConfInitData(state) || {},
        participants: vendor.selectors.selectParticipants(state) || {},
        audiences: vendor.selectors.selectAudiences(state) || {} };
    }
    function active(f) {
      return f.session.joined === true && !!f.session.sessionKey && !!identity(f.info.conferenceID) && !!identity(f.info.participantID);
    }
    function isOwned(button) {
      return typeof button?.buttonId === 'string' && button.buttonId.startsWith(PREFIX);
    }
    function invitation(f, id = 'invite') {
      let reason = null;
      if (!configured || disposed) reason = disposed ? 'DISPOSED' : 'UI_NOT_CONFIGURED';
      else if (!active(f)) reason = 'CONFERENCE_NOT_ACTIVE';
      else if (!policy.isUserLogined || !vendor.selectors.getLoginAnthenticated(f.state)) reason = 'LOGIN_REQUIRED';
      else if (f.own.role !== vendor.constants.HOST && f.own.role !== vendor.constants.GUEST) reason = 'ROLE_NOT_ALLOWED';
      else if (f.own.role === vendor.constants.GUEST && vendor.selectors.getIsSupportGuestInviteParticipants(f.state) !==
          vendor.constants.SUPPORT_GUEST_INVITE_PARTICIPANTS.SUPPORT) reason = 'SERVER_GUEST_INVITATION_NOT_GRANTED';
      else if (policy.buttons[id].showAsAction === 'never') reason = 'LOCAL_UI_RESTRICTION';
      else if (!platform.isElectron() || typeof window.hwCloudMeeting?.inviteUsers !== 'function' ||
          typeof window.hwCloudMeeting?.getSupportCustomCapabilities !== 'function') reason = 'UI_INVITE_BRIDGE_UNAVAILABLE';
      return { buttonId: id, visible: !reason, reason };
    }
    function context(f) {
      const result = { sessionKey: f.session.sessionKey, conferenceID: identity(f.info.conferenceID) };
      const display = identity(f.info.displayConferenceID);
      if (display) result.displayConferenceID = display;
      return result;
    }
    function report(failure) {
      lastError = { code: failure.code || 'UI_ENFORCEMENT_FAILED', message: failure.message };
      const signature = lastError.code + ':' + lastError.message;
      if (signature !== lastViolation) {
        lastViolation = signature;
        if (typeof onViolation === 'function') {
          try { Promise.resolve(onViolation(failure)).catch(() => {}); } catch (_) { /* The original failure remains observable in state(). */ }
        }
      }
    }
    function publish(buttonId, f, participant) {
      const payload = { buttonId, ...context(f) };
      if (participant) payload.participant = participant;
      try { Promise.resolve(emit('ui-custom-click', payload)).catch(report); } catch (failure) { report(failure); }
      return payload;
    }
    function participant(f, id) {
      for (const list of [f.participants, f.audiences]) {
        const direct = list[id];
        if (direct && identity(direct.pid) === id) return direct;
        for (const member of Object.values(list)) if (identity(member?.pid) === id) return member;
      }
      return null;
    }
    function profileEnabled(f) {
      return configured && !disposed && active(f) && policy.isUserLogined && policy.buttons.participant_detail.isCustomizedClick;
    }
    function directoryMember(f, id) {
      if (!configured || disposed || !active(f) || !policy.isUserLogined || !vendor.selectors.getLoginAnthenticated(f.state)) return null;
      const member = participant(f, id), info = member?.pinfoMap;
      if (!info || (info.ANONYMOUS != null && ![0, '0', false, 'false', ''].includes(info.ANONYMOUS))) return null;
      const valid = s => typeof s === 'string' && s.length > 0 && s.length <= 512 && !/[\u0000-\u001f\u007f]/.test(s);
      // Provider participant mapping W(): TEL -> phone; ACCOUNT_ID -> userUUID.
      if (!valid(info.ACCOUNT_ID)) return null;
      const sipNumber = profileEnabled(f) && valid(info.TEL) ? info.TEL : '';
      const reportable = id !== identity(f.info.participantID);
      if (!sipNumber && !reportable) return null;
      return { ...context(f), participantID: id, userUuid: info.ACCOUNT_ID, sipNumber, reportable,
        displayName: valid(info.NAME) ? info.NAME : '', subject: valid(f.info.subject) ? f.info.subject : '' };
    }
    function sameDirectoryMember(a, b) {
      return !!a && !!b && a.sessionKey === b.sessionKey && a.conferenceID === b.conferenceID &&
        a.participantID === b.participantID && a.userUuid === b.userUuid && a.sipNumber === b.sipNumber &&
        a.reportable === b.reportable && a.displayName === b.displayName && a.subject === b.subject;
    }
    function directoryContext(event) {
      directoryHit = null;
      if (!event.isTrusted) return;
      const node = event.target?.closest?.(PROFILE);
      if (!node || disabled(node)) return;
      const person = directoryMember(facts(), node.id.slice('attendees-name-title-'.length));
      if (person) directoryHit = { person, at: performance.now() };
    }
    function directoryTarget({ requestId }) {
      const hit = directoryHit; directoryHit = null;
      if (!hit || performance.now() - hit.at > 5000 || !/^[a-f0-9]{32}$/.test(requestId)) return null;
      if (!sameDirectoryMember(hit.person, directoryMember(facts(), hit.person.participantID))) return null;
      directoryLease = { requestId, person: hit.person }; return hit.person;
    }
    function directoryCurrent({ requestId }) {
      const lease = directoryLease;
      return !!lease && lease.requestId === requestId && sameDirectoryMember(lease.person,
        directoryMember(facts(), lease.person.participantID));
    }
    function reconcileDirectory() {
      if (!directoryLease || directoryCurrent(directoryLease)) return;
      const { requestId } = directoryLease; directoryLease = null;
      Promise.resolve(emit('directory-invalidated', { requestId })).catch(report);
    }
    function bindSelectors() {
      if (selectors) return true;
      // This module belongs to the genuine lazy UI; do not fetch or execute a
      // guessed module while the application is still on its premeeting page.
      if (loadModule.m && !has(loadModule.m, 70781)) return false;
      let ids;
      try { ids = loadModule(70781); } catch (_) { return false; }
      requireFunction(ids, 'setUniqueId');
      if (!ids.LOCATION?.CONTROL || !ids.TYPE?.BUTTON) throw error('UI_ABI_MISMATCH', 'Provider UI identity constants are absent');
      const selector = name => {
        const id = ids.setUniqueId(ids.LOCATION.CONTROL, name, ids.TYPE.BUTTON);
        if (typeof id !== 'string' || !id || /\s/.test(id)) throw error('UI_ABI_MISMATCH', 'Invalid genuine UI button identity');
        return '.hw-meeting-control-item.' + CSS.escape(id);
      };
      selectors = { invite: selector('invite'), feedback: selector('feedback') };
      return true;
    }
    function decorate(node) {
      if (!decorations.has(node)) decorations.set(node, { role: node.getAttribute('role'), tabIndex: node.getAttribute('tabindex') });
      if (node.getAttribute('role') !== 'button') node.setAttribute('role', 'button');
      if (node.getAttribute('tabindex') !== '0') node.setAttribute('tabindex', '0');
    }
    function restore(node, saved) {
      if (node.getAttribute('role') === 'button') saved.role === null ? node.removeAttribute('role') : node.setAttribute('role', saved.role);
      if (node.getAttribute('tabindex') === '0') saved.tabIndex === null ? node.removeAttribute('tabindex') : node.setAttribute('tabindex', saved.tabIndex);
      decorations.delete(node);
    }
    function reconcileDecorations(f) {
      const wanted = new Set();
      if (profileEnabled(f)) for (const node of document.querySelectorAll(PROFILE)) {
        const id = node.id.slice('attendees-name-title-'.length);
        if (participant(f, id)) { wanted.add(node); decorate(node); }
      }
      if (selectors && invitation(f).visible) for (const node of document.querySelectorAll(selectors.invite)) {
        wanted.add(node); decorate(node);
      }
      const buttons = desiredButtons(f);
      for (const node of document.querySelectorAll(CUSTOM)) {
        if (buttons.some(button => node.id === 'control-bar-extend-btn-' + button.buttonId)) {
          wanted.add(node); decorate(node);
        }
      }
      for (const [node, saved] of decorations) if (!wanted.has(node) || !node.isConnected) restore(node, saved);
    }
    function desiredButtons(f) {
      if (!configured || disposed || !active(f)) return [];
      const room = policy.room, result = [];
      const add = (id, label, position) => result.push({ buttonId: PREFIX + id, desc: label,
        eventName: EVENT_PREFIX + revision + '.' + f.session.sessionKey + '.' + id, buttonPos: position });
      if (room && room.sessionKey === f.session.sessionKey) {
        if (room.listenAndNote && policy.isUserLogined) add('listenAndNote', room.labels.listenAndNote, '1');
        if (room.minutes !== 'hidden' && f.own.role === vendor.constants.HOST)
          add('minutes', room.minutes === 'start' ? room.labels.startMinutes : room.labels.pauseMinutes, result.length ? '0' : '1');
      }
      if (invitation(f, 'guest_invite').visible) add('guest_invite', { zh: '邀请嘉宾', en: 'Invite guests' }, '0');
      return result;
    }
    function reconcileButtons(f) {
      const current = vendor.selectors.selectCustomerButton(f.state);
      if (!Array.isArray(current)) throw error('UI_ABI_MISMATCH', 'Provider custom-button state is not an array');
      const desired = desiredButtons(f), other = current.filter(button => !isOwned(button));
      if (desired.some(button => button.buttonPos === '1') && other.some(button => button.buttonPos === '1'))
        throw error('UI_CUSTOM_BUTTON_SLOT_OCCUPIED', 'The provider has only one primary custom slot; another integration already owns it');
      const next = [...other, ...desired];
      activeButtons = desired;
      if (JSON.stringify(current) !== JSON.stringify(next)) vendor.store.dispatch(openActions.setCustomerButton(next));
    }
    function apply() {
      if (disposed) throw error('DISPOSED', 'UI customization has been disposed');
      if (applying) return;
      applying = true;
      try {
        const f = facts();
        reconcileDirectory();
        if (mobile.isMobile()) throw error('UI_PLATFORM_UNAVAILABLE', 'This policy is pinned to the native desktop WebRTC UI, not the mobile UI');
        if (policy.room && (!active(f) || policy.room.sessionKey !== f.session.sessionKey)) policy = { ...policy, room: null };
        const bound = bindSelectors();
        const invite = invitation(f);
        const rules = [];
        if (policy.buttons.vote.showAsAction === 'never') rules.push(VOTE + '{display:none!important}');
        if (bound && !invite.visible) rules.push(selectors.invite + '{display:none!important}');
        if (bound && policy.buttons.feedback.showAsAction === 'never') rules.push(selectors.feedback + '{display:none!important}');
        if (profileEnabled(f)) rules.push(PROFILE + '[role="button"]{cursor:pointer}');
        const css = rules.join('\n');
        if (style.textContent !== css) style.textContent = css;
        if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
        if (!style.sheet) throw error('UI_STYLESHEET_BLOCKED', 'The page did not accept the local UI restriction stylesheet');
        if (style.sheet.disabled) style.sheet.disabled = false;
        if (active(f) && !bound) throw error('UI_COMPONENTS_UNAVAILABLE', 'The actual conference UI identity module is not loaded');
        if (vendor.selectors.selectEnableInviteThirdUser(f.state) !== invite.visible)
          vendor.store.dispatch(vendor.actions.setCustomCapabilities({ inviteThirdUser: invite.visible }));
        if (policy.buttons.vote.showAsAction === 'never' && vendor.selectors.getVoteModalState(f.state))
          vendor.store.dispatch(voteActions.setVoteModalVisible(false));
        if (policy.buttons.feedback.showAsAction === 'never' && vendor.selectors.getFeedbackModalState(f.state))
          vendor.store.dispatch(feedbackActions.closeFeedbackModal());
        reconcileButtons(f);
        if (profilesDirty || lastProfileParticipants !== f.participants || lastProfileAudiences !== f.audiences) {
          profilesDirty = false;
          lastProfileParticipants = f.participants;
          lastProfileAudiences = f.audiences;
          reconcileDecorations(f);
        }
        lastError = null;
        lastViolation = '';
        if (configured) {
          confirmedPolicy = policy;
          confirmedRevision = revision;
        }
      } finally { applying = false; }
    }
    function schedule() {
      if (!configured || disposed || applying || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (configured && !disposed) try { apply(); } catch (failure) { report(failure); }
      });
    }
    function parse(patch) {
      keys(patch, ['isUserLogined', 'toolBar', 'customButtonStatus'], 'config');
      const next = { ...policy, buttons: Object.fromEntries(Object.entries(policy.buttons).map(([id, item]) => [id, { ...item }])) };
      if (has(patch, 'isUserLogined')) next.isUserLogined = boolean(patch.isUserLogined, 'isUserLogined');
      if (has(patch, 'toolBar')) {
        if (patch.toolBar && has(patch.toolBar, 'customButton'))
          throw error('UI_CUSTOM_BUTTON_LAYOUT_UNAVAILABLE', 'Native customButton/buttonPos configuration is not the WebRTC API. Supply precomputed customButtonStatus; native sharing-toolbar buttons are unavailable.', { unavailable: { shareMinutes: UNAVAILABLE.shareMinutes, shareListenAndNote: UNAVAILABLE.shareListenAndNote } });
        keys(patch.toolBar, ['button'], 'toolBar');
        if (has(patch.toolBar, 'button')) {
          if (!Array.isArray(patch.toolBar.button)) throw error('INVALID_UI_CONFIG', 'toolBar.button must be an array');
          const seen = new Set();
          for (const button of patch.toolBar.button) {
            keys(button, ['id', 'showAsAction', 'isCustomizedClick'], 'toolBar.button');
            if (!has(next.buttons, button.id)) throw error('UI_CONTROL_UNAVAILABLE', UNAVAILABLE[button.id] || 'No verified WebRTC UI binding for this control', { buttonId: button.id });
            if (seen.has(button.id)) throw error('INVALID_UI_CONFIG', 'A toolbar button may appear only once');
            seen.add(button.id);
            const target = next.buttons[button.id];
            if (has(button, 'showAsAction')) {
              if (!has(target, 'showAsAction')) throw error('UI_CONFIG_UNSUPPORTED', 'This control has no mapped visibility setting', { buttonId: button.id });
              if (!['ifRoom', 'never'].includes(button.showAsAction)) throw error('INVALID_UI_CONFIG', 'showAsAction must be ifRoom or never');
              target.showAsAction = button.showAsAction;
              if (button.id === 'attendee_access_control' && button.showAsAction !== 'never')
                throw error('UI_CONTROL_UNAVAILABLE', UNAVAILABLE.attendee_access_control, { buttonId: button.id, supportedRestriction: 'never', enforcement: 'provider-surface-absent' });
            }
            if (has(button, 'isCustomizedClick')) {
              if (!has(target, 'isCustomizedClick')) throw error('UI_CONFIG_UNSUPPORTED', 'This control has no mapped custom-click setting', { buttonId: button.id });
              target.isCustomizedClick = boolean(button.isCustomizedClick, 'isCustomizedClick');
              if (button.id !== 'participant_detail' && !target.isCustomizedClick)
                throw error('UI_DEFAULT_INVITATION_UNAVAILABLE', 'This native bridge supports host-handled invitation UI, not the provider contact picker');
            }
          }
        }
      }
      if (has(patch, 'customButtonStatus')) {
        const room = patch.customButtonStatus;
        next.room = null;
        if (room !== null) {
          keys(room, ['sessionKey', 'minutes', 'listenAndNote', 'labels'], 'customButtonStatus');
          if (typeof room.sessionKey !== 'string' || !room.sessionKey || !['hidden', 'start', 'pause'].includes(room.minutes))
            throw error('INVALID_UI_CONFIG', 'customButtonStatus requires a sessionKey and minutes hidden/start/pause');
          const f = facts();
          if (!active(f) || room.sessionKey !== f.session.sessionKey) throw error('CONFERENCE_CHANGED', 'Room UI state belongs to a different or inactive conference');
          next.room = { sessionKey: room.sessionKey, minutes: room.minutes,
            listenAndNote: boolean(room.listenAndNote, 'customButtonStatus.listenAndNote'),
            labels: has(room, 'labels') ? labels(room.labels) : DEFAULT_LABELS };
        }
      }
      if (!next.isUserLogined) next.buttons.participant_detail.isCustomizedClick = false;
      return next;
    }
    function configure(patch) {
      if (disposed) throw error('DISPOSED', 'UI customization has been disposed');
      if (applying) throw error('UI_POLICY_BUSY', 'A provider UI policy update is already being enforced');
      const next = parse(patch); // Unsupported fields never produce partial success.
      const previous = { policy, configured, revision };
      policy = next;
      configured = true;
      ++revision;
      pendingInvite = null;
      pendingCustom = null;
      profilesDirty = true;
      try { apply(); }
      catch (failure) {
        // Restore the live policy, not just its serialized snapshot. Otherwise
        // a rejected visibility patch can change capture gates and be committed
        // later by the mutation/store observer.
        policy = previous.policy;
        configured = previous.configured;
        revision = previous.revision;
        profilesDirty = true;
        try { apply(); }
        catch (restoreFailure) {
          const rollbackFailure = error('UI_POLICY_ROLLBACK_FAILED',
            'The previous UI restrictions could not be restored after a rejected update',
            { updateCode: failure.code || 'UI_ENFORCEMENT_FAILED',
              restoreCode: restoreFailure.code || 'UI_ENFORCEMENT_FAILED' });
          report(rollbackFailure);
          throw rollbackFailure;
        }
        report(failure);
        throw failure;
      }
      return state();
    }
    function confirmedConfiguration(f) {
      if (!confirmedPolicy) return { configuration: null, configurationRevision: 0, customButtonStatus: null };
      const room = confirmedPolicy.room;
      const currentRoom = !disposed && room && active(f) && room.sessionKey === f.session.sessionKey;
      return {
        configuration: {
          isUserLogined: confirmedPolicy.isUserLogined,
          toolBar: { button: Object.entries(confirmedPolicy.buttons).map(([id, button]) => ({ id, ...button })) },
          customButtonStatus: null
        },
        configurationRevision: confirmedRevision,
        customButtonStatus: currentRoom ? {
          sessionKey: room.sessionKey, minutes: room.minutes, listenAndNote: room.listenAndNote,
          labels: Object.fromEntries(Object.entries(room.labels).map(([name, label]) => [name, { ...label }]))
        } : null
      };
    }
    function state() {
      const f = facts();
      return { ...confirmedConfiguration(f), configured, ready: configured && !disposed && !!selectors && !lastError, disposed, revision,
        sessionKey: active(f) ? f.session.sessionKey : null,
        pending: !configured ? 'UI_NOT_CONFIGURED' : !disposed && !selectors ? 'PROVIDER_UI_NOT_LOADED' : null,
        isUserLogined: policy.isUserLogined,
        effective: { invite: invitation(f), guestInvite: invitation(f, 'guest_invite'), participantDetail: profileEnabled(f),
          voteHidden: configured && !disposed && policy.buttons.vote.showAsAction === 'never',
          feedbackHidden: configured && !disposed && policy.buttons.feedback.showAsAction === 'never',
          attendeeAccessControl: { visible: false, requested: policy.buttons.attendee_access_control.showAsAction,
            enforcement: 'provider-surface-absent', supportsEnabling: false },
          customButtons: activeButtons.map(button => ({ id: button.buttonId.slice(PREFIX.length), position: button.buttonPos === '1' ? 'primary' : 'more' })) },
        capabilities: { desktop: true, invitation: 'hwCloudMeeting.inviteUsers', guestInvitation: 'provider-custom-more-button',
          participantDetail: 'provider-participant-name', vote: 'provider-ui-local-hide', feedback: 'provider-ui-local-hide',
          customButtonStatus: 'provider-primary-and-more', attendeeAccessControl: false,
          serverPermissionOverrides: false, unavailable: { ...UNAVAILABLE } },
        lastError: lastError ? { ...lastError } : null };
    }
    function ensure() {
      if (!configured) throw error('UI_NOT_CONFIGURED', 'Configure the app UI policy before enforcing it');
      profilesDirty = true;
      try { apply(); } catch (failure) { report(failure); throw failure; }
      return state();
    }
    function stop(event) { event.preventDefault(); event.stopImmediatePropagation(); }
    function disabled(node) {
      return !!node.closest('[disabled],[aria-disabled="true"],[inert],.disabled');
    }
    function capture(event) {
      if (!configured || disposed) return;
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      if (!target) return;
      const isKey = event.type === 'keydown';
      if (isKey && (event.repeat || event.key !== 'Enter' && event.key !== ' ')) return;
      const f = facts();
      const vote = target.closest(VOTE), feedback = selectors && target.closest(selectors.feedback);
      if (vote && policy.buttons.vote.showAsAction === 'never' || feedback && policy.buttons.feedback.showAsAction === 'never') return stop(event);
      const invite = selectors && target.closest(selectors.invite);
      if (invite) {
        if (!invitation(f).visible || disabled(invite) || !event.isTrusted) return stop(event);
        if (event.type !== 'click' && !isKey) return;
        pendingInvite = { ...context(f), role: f.own.role, at: Date.now() };
        if (isKey) { stop(event); vendor.store.dispatch(vendor.actions.inviteUsers()); }
        return; // Genuine React click -> genuine saga -> preload inviteUsers(json).
      }
      const custom = target.closest(CUSTOM);
      if (custom) {
        const button = desiredButtons(f).find(button => custom.id === 'control-bar-extend-btn-' + button.buttonId);
        if (!button || disabled(custom) || !event.isTrusted) return stop(event);
        if (event.type !== 'click' && !isKey) return;
        pendingCustom = { eventName: button.eventName, sessionKey: f.session.sessionKey, at: Date.now() };
        if (isKey) { stop(event); vendor.store.dispatch(openActions.clickCustomerButton({ eventName: button.eventName })); }
        return;
      }
      const name = target.closest(PROFILE);
      if (!name || !profileEnabled(f) || event.type !== 'click' && !isKey) return;
      const member = participant(f, name.id.slice('attendees-name-title-'.length));
      if (!member) return;
      stop(event);
      if (disabled(name) || !event.isTrusted) return;
      const person = { participantID: identity(member.pid) };
      const account = identity(member.pinfoMap?.ACCOUNT_ID);
      if (account) person.accountID = account;
      publish('participant_detail', f, person);
    }
    function handleInvite(value) {
      if (disposed) throw error('DISPOSED', 'UI customization has been disposed');
      let supplied;
      try { supplied = typeof value === 'string' ? JSON.parse(value) : value; }
      catch (_) { throw error('UI_PROVIDER_PAYLOAD_INVALID', 'Provider inviteUsers payload is not JSON'); }
      const f = facts(), pending = pendingInvite;
      pendingInvite = null;
      if (!pending || !active(f) || pending.sessionKey !== f.session.sessionKey || Date.now() - pending.at > 5000)
        throw error('UI_CLICK_REQUIRED', 'No current trusted invitation-button activation belongs to this provider callback');
      const invite = invitation(f);
      if (!invite.visible) throw error(invite.reason, 'The current invitation control is not allowed');
      if (!supplied || typeof supplied !== 'object' || pending.role !== f.own.role || supplied.selfConfRole !== f.own.role ||
          identity(supplied.vmrConfId) !== identity(f.info.conferenceID) ||
          identity(supplied.confId) !== identity(f.info.displayConferenceID) || pending.conferenceID !== identity(f.info.conferenceID))
        throw error('CONFERENCE_CHANGED', 'Provider invitation identifiers no longer match the actual conference');
      return publish(invite.buttonId, f);
    }
    function customerClick(event) {
      const name = event?.data?.eventName;
      if (!configured || disposed || typeof name !== 'string' || !name.startsWith(EVENT_PREFIX)) return;
      const f = facts(), pending = pendingCustom;
      pendingCustom = null;
      const button = desiredButtons(f).find(button => button.eventName === name);
      if (!pending || pending.eventName !== name || pending.sessionKey !== f.session.sessionKey || Date.now() - pending.at > 5000 ||
          event.retCode !== '0' || !active(f) || !button ||
          identity(event.data?.content?.confID) !== identity(common.getConfDisplayId(f.info.displayConferenceID, f.info.conferenceID))) return;
      publish(button.buttonId.slice(PREFIX.length), f);
    }
    const observer = new MutationObserver(() => { profilesDirty = true; schedule(); });
    const unsubscribe = vendor.store.subscribe(() => { reconcileDirectory(); profilesDirty = true; schedule(); });
    document.addEventListener('contextmenu', directoryContext, true);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['id', 'class', 'role', 'tabindex', 'disabled', 'aria-disabled'] });
    for (const name of ['click', 'keydown', 'mousedown', 'touchstart']) document.addEventListener(name, capture, { capture: true, passive: false });
    openEvents.openEmitter.on(openEvents.OPEN_EVENT_LIST.CUSTOMER_OPERATE_RESULT, customerClick);
    function dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      document.removeEventListener('contextmenu', directoryContext, true);
      directoryLease = directoryHit = null;
      unsubscribe();
      pendingInvite = null;
      pendingCustom = null;
      openEvents.openEmitter.removeListener(openEvents.OPEN_EVENT_LIST.CUSTOMER_OPERATE_RESULT, customerClick);
      for (const name of ['click', 'keydown', 'mousedown', 'touchstart']) document.removeEventListener(name, capture, true);
      for (const [node, saved] of decorations) restore(node, saved);
      style.remove();
      const current = vendor.selectors.selectCustomerButton(vendor.store.getState());
      if (Array.isArray(current) && current.some(isOwned)) vendor.store.dispatch(openActions.setCustomerButton(current.filter(button => !isOwned(button))));
      vendor.store.dispatch(vendor.actions.setCustomCapabilities({ inviteThirdUser: false }));
      activeButtons = [];
    }
    return Object.freeze({ configure, state, ensure, dispose, handleInvite, directoryTarget, directoryCurrent });
  };
})();
