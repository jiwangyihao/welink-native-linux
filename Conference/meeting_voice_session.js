'use strict';

const { VoiceHost } = require('./meeting_voice_host');
const { VoiceFilter } = require('./meeting_voice_filter');

function failure(code, message) { return Object.assign(new Error(message), { code }); }

function confirmed(reply) {
  if (reply?.ok === true) return reply;
  const code = typeof reply?.error === 'string' ? reply.error : 'VOICE_OPERATION_UNCONFIRMED';
  throw Object.assign(failure(code, 'The local voice owner did not confirm this operation'), {details: reply});
}

// Owned by one trusted local conference service document. The hosted meeting
// page gets audio blocks, not the account, a profile pathname or the PNR record.
class MeetingVoiceSession {
  constructor({electron, appRoot, contents, frame, getMeeting, onLost, anonymousRoom, isRoomCurrent}) {
    this.frame = frame;
    this.contents = contents;
    this.getMeeting = getMeeting;
    this.anonymousRoom = anonymousRoom || null;
    this.isRoomCurrent = isRoomCurrent;
    this.filter = new VoiceFilter(appRoot);
    this.armed = false;
    this.filterAvailable = false;
    this.released = false;
    this.epoch = 0;
    this.requestRevision = 0;
    this.releasePromise = null;
    this.account = null;
    this.host = new VoiceHost({electron, appRoot, profileDir: electron.app.getPath('userData'),
      getParent: () => electron.BrowserWindow.fromWebContents(contents),
      anonymousRoom, stopUplink: () => this.stop(), onEnrolled: revision => this.apply(revision),
      onRevoke: () => this.disableAnonymous()});
    this.onLost = onLost;
    this.onNavigation = (_event,_url,inPlace,main) => { if (main && !inPlace) onLost(); };
    contents.once('destroyed', onLost);
    contents.on('render-process-gone', onLost);
    contents.on('did-start-navigation', this.onNavigation);
  }

  current() {
    try { return !this.released && !this.contents.isDestroyed() && this.frame === this.contents.mainFrame &&
      (!this.isRoomCurrent || this.isRoomCurrent()); }
    catch (_) { return false; }
  }

  requested() { return this.current() && this.armed && (!!this.anonymousRoom || this.host.hasEnrollment()); }
  allowed() { return this.requested() && this.host.hasEnrollment() && this.filterAvailable; }

  async showAnonymous() {
    if (!this.anonymousRoom || !this.current())
      throw failure('VOICE_ANONYMOUS_ROOM_REQUIRED', 'No current anonymous room owns this enrollment');
    // Opening the explicit protection flow is a privacy request, not consent.
    // Install the fail-closed policy before presenting the recording window.
    const revision = this.armed ? this.requestRevision : ++this.requestRevision;
    this.armed = true;
    if (!this.host.hasEnrollment()) this.filterAvailable = false;
    const meeting = this.getMeeting();
    if (!meeting) throw failure('VOICE_MEDIA_UNAVAILABLE', 'The anonymous microphone owner is absent');
    await meeting.configureVoiceProtection(true, this);
    if (!this.requested() || revision !== this.requestRevision)
      throw failure('VOICE_REQUEST_RETIRED', 'The anonymous protection request was disabled or replaced');
    const receipt = confirmed(await this.host.show(true, revision));
    if (!this.requested() || revision !== this.requestRevision)
      throw failure('VOICE_REQUEST_RETIRED', 'The anonymous protection request was disabled or replaced');
    return receipt;
  }

  async disableAnonymous() {
    if (!this.anonymousRoom) throw failure('VOICE_ANONYMOUS_ROOM_REQUIRED', 'Not an anonymous voice owner');
    ++this.requestRevision;
    this.armed = false;
    return confirmed(await this.host.agree(false));
  }

  async apply(requestRevision = this.requestRevision) {
    if (this.anonymousRoom && (!this.requested() || requestRevision !== this.requestRevision))
      throw failure('VOICE_REQUEST_RETIRED', 'Enrollment cannot enable a retired anonymous protection request');
    if (!this.current() || !this.host.hasEnrollment()) throw failure('VOICE_ENROLLMENT_REQUIRED','No current, consented local voiceprint');
    const epoch = ++this.epoch;
    this.filterAvailable = false;
    if (!this.anonymousRoom) this.armed = true; // Anonymous activation never creates a new request.
    const meeting = this.getMeeting();
    try {
      let data = { enabled:true, armed:false, processing:false, protected:false, state:'blocked', reason:'PNR_FILTER_CONTROLS_UNAVAILABLE' };
      if (meeting) data = await meeting.configureVoiceProtection(true, this);
      const capability = await this.host.capabilities();
      if (!this.requested() || epoch !== this.epoch || requestRevision !== this.requestRevision)
        throw failure('VOICE_SESSION_CHANGED','The voice profile or protection request was retired');
      if (capability.filter) {
        this.filterAvailable = true;
        const currentMeeting = this.getMeeting();
        data = currentMeeting ? await currentMeeting.configureVoiceProtection(true, this) : { enabled:true, armed:true, processing:false, protected:false };
        if (!this.allowed() || epoch !== this.epoch || requestRevision !== this.requestRevision)
          throw failure('VOICE_SESSION_CHANGED','The voice profile or protection request was retired');
      }
      return data;
    } catch (err) {
      if (epoch === this.epoch) { this.filterAvailable = false; await this.filter.stop(); }
      throw err;
    }
  }

  async stop() {
    const previouslyArmed = this.armed;
    // Enrollment suspends filtering without releasing the requested privacy
    // gate. Only explicit disable/revoke or owner retirement permits raw Unmute.
    const hold = !!this.anonymousRoom && this.armed && this.current();
    this.armed = hold; this.filterAvailable = false; ++this.epoch;
    const closed = this.filter.stop();
    const meeting = this.getMeeting();
    const page = meeting && (this.anonymousRoom || hold || previouslyArmed || meeting.voiceRequested) ? meeting.configureVoiceProtection(hold, this) : null;
    const [worker, media] = await Promise.allSettled([closed, page]);
    if (worker.status !== 'fulfilled' || !worker.value?.stopped || media.status !== 'fulfilled' ||
        (page && media.value?.stopped !== true))
      throw failure('VOICE_STOP_UNCONFIRMED','Local voice processing did not confirm shutdown');
    return {stopped:true};
  }

  async bind(account) {
    if (!this.current()) throw failure('VOICE_SESSION_CHANGED','The voice service document is retired');
    if (account !== null && (typeof account !== 'string' || !account || account.length > 1024))
      throw failure('VOICE_ACCOUNT_REQUIRED','A valid current workplace account is required');
    this.account = account;
    const result = await this.host.bind(account);
    if (!this.current() || this.account !== account) throw failure('VOICE_SESSION_CHANGED','The account changed during binding');
    try { confirmed(result); }
    catch (error) { this.account = null; throw error; }
  }

  async command(operation, account, value) {
    if (!this.current()) throw failure('VOICE_SESSION_CHANGED','The local voice service document is retired');
    if (operation === 'configure') return confirmed(await this.host.configure(value));
    if (this.anonymousRoom) throw failure('VOICE_ANONYMOUS_ACCOUNT_FORBIDDEN', 'Anonymous enrollment cannot use account commands');
    if (operation !== 'bind' && account === null) throw failure('VOICE_ACCOUNT_REQUIRED','No current workplace account');
    if (this.account !== account) await this.bind(account);
    if (operation === 'bind') {
      if (account && !this.armed && this.host.hasEnrollment()) await this.apply();
      return {bound:account !== null};
    }
    if (operation === 'agree') {
      const data = confirmed(await this.host.agree(value));
      if (value && !this.armed && this.host.hasEnrollment()) await this.apply();
      return data;
    }
    if (operation === 'show') return confirmed(await this.host.show(value));
    throw failure('INVALID_VOICE_OPERATION','Unknown local voice operation');
  }

  open() {
    if (!this.allowed()) throw failure('VOICE_NOT_AUTHORIZED','Local voice processing is not enabled');
    return this.filter.open(this.host.recordForFilter());
  }

  process(id, pcm) {
    if (!this.allowed()) throw failure('VOICE_NOT_AUTHORIZED','Local voice processing is not enabled');
    return this.filter.process(id, pcm);
  }

  release() {
    if (this.releasePromise) return this.releasePromise;
    ++this.requestRevision;
    this.released = true;
    this.account = null;
    this.contents.removeListener('destroyed', this.onLost);
    this.contents.removeListener('render-process-gone', this.onLost);
    this.contents.removeListener('did-start-navigation', this.onNavigation);
    this.releasePromise = this.host.release().then(confirmed);
    return this.releasePromise;
  }
}
module.exports = { MeetingVoiceSession };
