/* Private cmd1050 moderation policy, shared by authenticated WebRTC and native
 * offline control. Windows 100.10.5 tup_confctrl.dll: uportal_SetClientCapabilities
 * RVA 0x6D990 stores cohost/waiting/mic/camera-open/camera-close at +0,+12,+16,+20,+32;
 * RVA 0x269D0 appends "1", ",4", ",10", ",11", ",12" respectively. The last
 * four also match WebRTC main.6297930e module 62467 CLIENT_CAPABILITIES.
 * These are membership advertisements, not permissions or server receipts.
 */
(function (root) {
  'use strict';
  const types = Object.freeze([0, 2, 3, 4]);
  const wireIds = Object.freeze({ 0: Object.freeze(['1']), 2: Object.freeze(['4']),
    3: Object.freeze(['10']), 4: Object.freeze(['11', '12']) });
  const flag = value => value === true || value === 1 || value === '1';
  const error = (code, message) => Object.assign(new Error(message), { code });
  function createPolicy() {
    const enabled = new Map(types.map(type => [type, true]));
    let scope = '', consent = false, revision = 0;
    function revoke() { consent = false; ++revision; }
    function bind(key) {
      key = typeof key === 'string' ? key : '';
      if (key !== scope) { scope = key; revoke(); return true; }
      return false;
    }
    function configure(type, value) {
      if (!types.includes(type) || typeof value !== 'boolean') throw error('INVALID_ARGUMENT', 'Invalid moderation capability');
      if (type === 3 && !value && (!scope || !consent))
        throw error('MICROPHONE_CONSENT_REQUIRED', 'Disabling microphone reminders requires local consent for this room and device');
      if (enabled.get(type) !== value) ++revision;
      enabled.set(type, value);
      if (type === 3 && value) revoke();
    }
    function grant(key) {
      if (!scope || key !== scope) throw error('MODERATION_SESSION_RETIRED', 'The consent dialog no longer belongs to this room/device');
      consent = true; ++revision;
    }
    function allowed(type) { return enabled.get(type) !== false; }
    function microphoneAutomatic() { return !allowed(3) && !!scope && consent; }
    function advertise(list) {
      if (typeof list !== 'string') throw error('CAPABILITY_ABI_MISMATCH', 'Missing genuine clientCapabilities membership string');
      const ids = new Set(list.split(',').filter(Boolean));
      for (const type of types) for (const id of wireIds[type]) {
        // Expired opt-in restores reminder support even if the application still
        // prefers suppression. Never let omission of bit10 become implicit consent.
        if (type === 3 ? !microphoneAutomatic() : allowed(type)) ids.add(id); else ids.delete(id);
      }
      return [...ids].join(',');
    }
    function state() {
      return { types: Object.fromEntries(enabled), scope, microphoneConsent: !!scope && consent,
        microphoneReminder: !microphoneAutomatic(), revision, wireIds,
        serverCapabilityAcknowledged: false, serverPermissionGranted: false, osPermissionGranted: false };
    }
    return Object.freeze({ bind, revoke, grant, configure, allowed, microphoneAutomatic, advertise, state });
  }
  function supports(participant, id) {
    const p = participant?.pinfoMap || participant || {};
    const list = typeof p.CLIENT_CAPABILITIES_V2 === 'string' ? p.CLIENT_CAPABILITIES_V2 : p.CLIENT_CAPABILITIES;
    return typeof list === 'string' && list.split(',').includes(id);
  }
  function role(participant, ownRole, enabled = true) {
    const p = participant?.pinfoMap || participant || {};
    const host = String(p.ROLE ?? ownRole) === '1';
    const cohost = flag(p.IS_COHOST);
    return { kind: host ? 'host' : cohost ? 'cohost' : String(p.ROLE ?? ownRole) === '2' ? 'audience' : 'participant',
      host, cohost, canModerate: host || cohost && enabled, source: 'server-membership' };
  }
  // No local action writes IS_COHOST/ROLE. The caller must retain the genuine
  // membership notifications and recheck this predicate at the transport boundary.
  function authorize({ operation, target, self, ownRole, basic, enabled, enabledValue, participantID, ownID }) {
    const actor = role(self, ownRole, enabled(0));
    if (!self || !actor.canModerate) throw error('HOST_PERMISSION_REQUIRED', 'Current server host/cohost membership is required');
    if (!target) throw error('MODERATION_PARTICIPANT_MISSING', 'The participant is not in the current server membership');
    const peer = role(target);
    if (String(participantID) === String(ownID)) throw error('MODERATION_SELF_TARGET', 'Use the local media controls for yourself');
    if (operation === 'cohost') {
      if (!actor.host || peer.host || !flag(basic.supportCohost))
        throw error('COHOST_PERMISSION_REQUIRED', 'Only the server host in a cohost-enabled conference can change cohost membership');
      if (enabledValue && !supports(target, '1')) throw error('PEER_CAPABILITY_UNAVAILABLE', 'This participant has not advertised cohost support');
    } else if (operation === 'waiting') {
      if (!flag(basic.supportWaitingRoom) || !supports(target, '4') || peer.host)
        throw error('PEER_CAPABILITY_UNAVAILABLE', 'The server/participant does not support moving this participant to the waiting room');
    } else if (operation === 'microphone') {
      if (enabledValue && !supports(target, '10'))
        throw error('PEER_CONSENT_UNAVAILABLE', 'The peer has not advertised an invitation-to-open microphone consumer');
    } else if (operation === 'camera') {
      if (!supports(target, enabledValue ? '11' : '12'))
        throw error('PEER_CAPABILITY_UNAVAILABLE', 'The peer has not advertised this camera control consumer');
    } else throw error('INVALID_ARGUMENT', 'Unknown moderation control');
    return actor;
  }
  const api = Object.freeze({ types, wireIds, createPolicy, supports, role, authorize, flag, error });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__welinkModerationCapabilities = api;
})(typeof window === 'object' ? window : null);
