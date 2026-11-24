'use strict';

// One outbound CREATECONF attempt, independently of incoming/current conferences.
// beginCreate must return the real management transport's {result,state,cancel,
// retire} handle. decodeCreate must accept only its correlated service response;
// a proven server refusal is marked details.creationRefused by that decoder.
// endConference uses the existing authenticated conference.cancel type=1 route.
// Retirement never requests an end and must precede account credential changes.
const crypto = require('crypto');

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function createPendingCallController({ kind, beginCreate, decodeCreate, endConference }) {
  if (typeof kind !== 'string' || !kind || [beginCreate, decodeCreate, endConference].some(fn => typeof fn !== 'function'))
    throw new TypeError('A call kind and real create/decode/end providers are required');
  let current = null;
  let generation = 0;
  const blocked = new Set();

  function state(attempt = current) {
    if (!attempt) return { kind, phase: 'idle', attemptId: null, pending: false, cancellationAvailable: false,
      cancelRequested: false, transmissionAttempted: false, creationConfirmed: false, endAttempted: false,
      endConfirmed: false, retryBlocked: false, retired: false };
    const sent = !!attempt.handle?.state().transmissionAttempted;
    return { kind, attemptId: attempt.id, callRequestId: attempt.callRequestId,
      phase: attempt.phase === 'pending' ? (attempt.cancelRequested ? 'cancel_requested' : sent ? 'sent' : 'preparing') : attempt.phase,
      pending: !attempt.settled && !attempt.retired,
      cancellationAvailable: !!attempt.handle && !attempt.settled && !attempt.retired && !attempt.cancelRequested,
      cancelRequested: attempt.cancelRequested, transmissionAttempted: sent,
      creationConfirmed: !!attempt.created, endAttempted: attempt.endAttempted, endConfirmed: attempt.endConfirmed,
      retryBlocked: attempt.retryBlocked, retired: attempt.retired,
      ...(attempt.created ? { conferenceID: attempt.created.conferenceID } : {}) };
  }

  function errorState(error, attempt) {
    if (!(error instanceof Error)) error = failure('CALL_UNCONFIRMED', 'The call operation did not return a service result');
    error.details = { ...(error.details || {}), callState: state(attempt) };
    return error;
  }

  function blockRetry(attempt) {
    attempt.retryBlocked = true;
    if (attempt.generation === generation) blocked.add(attempt.retryKey);
  }

  function requireLive(attempt) {
    if (attempt.retired || attempt.generation !== generation)
      throw failure('CALL_RETIRED', 'The call attempt belongs to a retired account session');
  }

  async function complete(attempt, body) {
    try {
      attempt.handle = beginCreate(body);
      const frame = await attempt.handle.result;
      requireLive(attempt);
      const created = decodeCreate(frame);
      if (!created || typeof created.conferenceID !== 'string' || !created.conferenceID)
        throw failure('INVALID_SERVICE_RESPONSE', 'CREATECONF did not return an exact conference ID');
      attempt.created = created;
      if (attempt.cancelRequested) {
        // No await between the account check and the one permitted end dispatch.
        // The authenticated HTTP owner must also retire its in-flight requests.
        requireLive(attempt);
        attempt.phase = 'ending';
        attempt.endAttempted = true;
        const cancellation = await endConference(created.conferenceID);
        requireLive(attempt);
        attempt.endConfirmed = true;
        attempt.phase = 'cancelled';
        attempt.settled = true;
        return { ...created, cancellation, callState: state(attempt) };
      }
      attempt.phase = 'created';
      attempt.settled = true;
      return { ...created, callState: state(attempt) };
    } catch (error) {
      const sent = !!attempt.handle?.state().transmissionAttempted;
      if (attempt.retired) {
        attempt.phase = sent ? 'unknown' : 'retired';
        if (sent) blockRetry(attempt);
      } else if (!attempt.created && error?.details?.creationRefused === true) {
        attempt.phase = 'refused';
      } else if (attempt.created) {
        attempt.phase = 'end_failed';
        blockRetry(attempt);
      } else if (sent) {
        attempt.phase = 'unknown';
        blockRetry(attempt);
      } else {
        attempt.phase = 'not_sent';
      }
      attempt.settled = true;
      if (!attempt.retired && !sent && attempt.cancelRequested && error?.code === 'MANAGEMENT_REQUEST_CANCELLED')
        return { callState: state(attempt) };
      throw errorState(error, attempt);
    }
  }

  function start(body, { retryKey, callRequestId } = {}) {
    if (typeof retryKey !== 'string' || !retryKey)
      return Promise.reject(failure('INVALID_ARGUMENT', 'An outbound call retry identity is required'));
    if (current && !current.settled && !current.retired)
      return Promise.reject(failure('CALL_PENDING', 'Another outbound call request is still pending'));
    if (blocked.has(retryKey))
      return Promise.reject(failure('CALL_RETRY_BLOCKED',
        'The previous call outcome is unresolved; this account session will not place the same call again'));
    const attempt = { id: crypto.randomUUID(), callRequestId, retryKey, generation, handle: null, phase: 'pending',
      settled: false, retired: false, cancelRequested: false, created: null, endAttempted: false,
      endConfirmed: false, retryBlocked: false };
    current = attempt;
    return complete(attempt, body);
  }

  function cancel(attemptId) {
    if (!current || typeof attemptId !== 'string' || current.id !== attemptId)
      throw failure('CALL_ATTEMPT_MISMATCH', 'Cancellation must identify the current outbound call attempt');
    if (!current.settled && !current.retired && !current.cancelRequested) {
      current.cancelRequested = true;
      current.handle.cancel();
    }
    // Acknowledges intent only. The original start result carries end evidence.
    return state();
  }

  function getState(callRequestId) {
    return state(callRequestId !== undefined && current?.callRequestId !== callRequestId ? null : current);
  }

  function retire() {
    const retiring = current;
    current = null;
    ++generation;
    blocked.clear();
    if (retiring) {
      retiring.retired = true;
      if (!retiring.settled) {
        retiring.phase = retiring.handle?.state().transmissionAttempted ? 'unknown' : 'retired';
        retiring.handle?.retire();
      }
    }
    return state();
  }

  return Object.freeze({ start, cancel, getState, retire });
}

module.exports = { createPendingCallController };
