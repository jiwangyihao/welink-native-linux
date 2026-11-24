'use strict';

const { MeetingVoiceSession } = require('./meeting_voice_session');
const { randomBytes } = require('crypto');
const fail = (code, message) => Object.assign(new Error(message), { code });
const CAPABILITY = 'HWM_SDK_CAPABILITY_SUPPORT_ANONYMOUS_USE_PNR';
const SCOPE = 'anonymous-room-memory';

// One local participant, one admission, one document. The room key is an opaque
// main-process object. No conference/account identifier becomes a storage key.
class AnonymousVoiceRooms {
  constructor({ electron, appRoot, onError }) {
    Object.assign(this, { electron, appRoot, onError });
    this.enabled = false;
    this.room = null;
    this.retiring = null;
    this.retirementError = null;
    this.revision = 0;
  }

  session(owner) {
    const room = this.room;
    return room && !room.retired && room.owner === owner && room.session.current() ? room.session : null;
  }

  state() {
    const room = this.room;
    const session = room && this.session(room.owner);
    const media = session ? room.getState() : null;
    const requested = !!session?.requested();
    const processing = requested && session.allowed() && media?.processing === true;
    return { capability: CAPABILITY, scope: SCOPE, enabled: this.enabled, roomAvailable: !!session,
      requested, enrolled: !!session?.host.hasEnrollment(), armed: requested && session.allowed() && media?.armed !== false,
      processing, protected: processing, persisted: false,
      state: !session ? 'no-room' : !this.enabled ? 'disabled' : !requested ? 'available' :
        !session.allowed() || media?.state === 'blocked' ? 'blocked' : processing ? 'protected' : 'armed',
      reason: requested && !session.allowed() ? 'VOICE_ENROLLMENT_OR_FILTER_REQUIRED' : media?.reason || null,
      serverPermissionGranted: false, osPermissionGranted: false };
  }

  async configure(enabled) {
    if (typeof enabled !== 'boolean') throw fail('INVALID_ARGUMENT', 'Anonymous voice capability requires a boolean');
    if (this.retirementError) throw this.retirementError;
    const revision = ++this.revision;
    this.enabled = enabled;
    if (!enabled && this.room && !this.room.retired) await this.room.session.disableAnonymous();
    if (this.room && !this.room.retired && this.room.onPolicy) await this.room.onPolicy(this.state());
    if (revision !== this.revision) throw fail('VOICE_CONFIGURATION_SUPERSEDED', 'The anonymous voice policy changed');
    return { ...this.state(), configured: true, type: 7, applied: true };
  }

  async attach({ owner, window, configure, getState, isCurrent, onPolicy }) {
    if (this.room) await this.retire(this.room.owner);
    if (this.retiring) await this.retiring;
    if (this.retirementError) throw this.retirementError;
    if (!isCurrent() || window.isDestroyed()) throw fail('VOICE_SESSION_CHANGED', 'The anonymous room is retired');
    const room = { owner, id: randomBytes(16).toString('hex'), getState, onPolicy, retired: false, session: null };
    this.room = room;
    const contents = window.webContents;
    room.session = new MeetingVoiceSession({ electron: this.electron, appRoot: this.appRoot,
      contents, frame: contents.mainFrame, anonymousRoom: room,
      isRoomCurrent: () => this.room === room && !room.retired && isCurrent(),
      getMeeting: () => window.isDestroyed() || contents.isDestroyed() ? null : {
        voiceRequested: room.session.armed,
        configureVoiceProtection: enabled => configure(enabled, room.session)
      },
      onLost: () => { this.retire(owner).catch(error => this.onError?.(error)); }
    });
    return room.session;
  }

  async show() {
    if (!this.enabled) throw fail('NATIVE_CAPABILITY_DISABLED', 'Anonymous voice enrollment is disabled by this application');
    const room = this.room, session = room && this.session(room.owner);
    if (!session) throw fail('VOICE_ANONYMOUS_ROOM_REQUIRED', 'Join an anonymous room before enrolling; no account voiceprint is reused');
    const receipt = await session.showAnonymous();
    return { ...receipt, ...this.state(), recordingStarted: false };
  }

  async disable() {
    const room = this.room, session = room && this.session(room.owner);
    if (!session) throw fail('VOICE_ANONYMOUS_ROOM_REQUIRED', 'No current anonymous room owns a voiceprint');
    const receipt = await session.disableAnonymous();
    return { ...receipt, ...this.state() };
  }

  retire(owner) {
    const room = this.room;
    if (!room || room.owner !== owner) return this.retiring ||
      (this.retirementError ? Promise.reject(this.retirementError) : Promise.resolve({ released: true }));
    if (room.retired) return this.retiring || room.session.release();
    room.retired = true;
    const pending = room.session.release().catch(error => {
      this.retirementError = error;
      throw error;
    }).finally(() => {
      if (this.room === room) this.room = null;
      if (this.retiring === pending) this.retiring = null;
    });
    this.retiring = pending;
    return pending;
  }
}

module.exports = { AnonymousVoiceRooms };
