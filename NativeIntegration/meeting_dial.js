// A dial request being accepted does not mean that the other party answered.
// Keep the number/window on refusal, cancellation or an indeterminate outcome.
(() => {
  'use strict';
  let pending = null, notice, timer;
  const messages = {
    P2P_PROVIDER_UNAVAILABLE: ['此 Linux 客户端不支持一对一通话，未拨出。', 'One-to-one calling is unavailable on this Linux client. No call was placed.'],
    CTD_PROVIDER_UNAVAILABLE: ['电话回呼服务不可用。', 'The callback service is unavailable.'],
    NO_CALL_PERMISSION: ['当前账号没有通话权限。', 'This account does not have permission to place calls.'],
    NO_CALL_PSTN: ['当前企业未开通电话呼叫。', 'Telephone calling is not enabled for this organization.'],
    NO_CALL_PSTN_PERSON: ['当前账号没有电话呼叫权限。', 'This account does not have permission to call telephone numbers.'],
    CALL_PENDING: ['另一个呼叫请求仍在等待结果。', 'Another call request is still pending.'],
    CALL_RETRY_BLOCKED: ['此前呼叫或结束结果不明，未再次拨出。请先核实通话状态。', 'The previous call or end result is unresolved. No duplicate call was placed. Check the call status.'],
    preparing: ['正在准备呼叫请求。', 'Preparing the call request.'],
    sent: ['呼叫请求已发出，正在等待服务回执。', 'Call request sent; waiting for service confirmation.'],
    cancelling: ['正在提交取消意愿，尚未确认结束通话。', 'Requesting cancellation; ending the call is not yet confirmed.'],
    cancel_requested: ['已记录取消意愿，正在等待原呼叫回执，尚未确认结束通话。', 'Cancellation requested. Waiting for the original call result; ending the call is not yet confirmed.'],
    ending: ['服务已返回通话编号，正在请求结束该通话。', 'The service returned the call ID. Requesting that this call be ended.'],
    cancel_failed: ['未能确认取消意愿，请继续等待原呼叫结果。', 'Cancellation intent was not confirmed. Continue waiting for the original call result.'],
    not_sent: ['呼叫请求未发出。', 'The call request was not sent.'],
    cancelled: ['服务已确认结束该通话。', 'The service confirmed this call was ended.'],
    end_failed: ['通话已创建，但结束未获确认。请核实通话状态，不要重复拨号。', 'The call was created, but ending it was not confirmed. Check its status; do not redial.'],
    refused: ['呼叫请求未获受理。', 'The call request was not accepted.'],
    unknown: ['未收到确定的呼叫结果。请核实通话状态，不要重复拨号。', 'The call outcome is unknown. Check the call status; do not redial.']
  };
  function text(key) {
    const english = window.language?.KEYPAD ? window.language.KEYPAD === 'Keypad' : /^en/i.test(navigator.language);
    return messages[key][english ? 1 : 0];
  }
  function clearNotice() {
    clearTimeout(timer);
    if (notice) { notice.remove(); notice = null; }
  }
  function explain(key) {
    clearNotice();
    const box = document.createElement('div'), content = document.createElement('div'), label = document.createElement('span');
    box.className = 'toast-container'; content.className = 'toast-content'; label.className = 'toast-text';
    box.style.pointerEvents = 'none'; box.setAttribute('role', 'alert');
    label.textContent = text(key);
    content.appendChild(label); box.appendChild(content); document.body.appendChild(box);
    notice = box;
    if (!['unknown', 'end_failed', 'CALL_RETRY_BLOCKED'].includes(key)) timer = setTimeout(clearNotice, 5500);
  }
  function render(attempt, state) {
    if (pending !== attempt || state.callRequestId !== attempt.callRequestId ||
        !['ctd', 'p2p'].includes(state.kind) || typeof state.attemptId !== 'string') return;
    attempt.state = state;
    if (!state.pending) return;
    if (!attempt.view) {
      // Never expose a cancel button for an unavailable provider or another dial.
      if (!state.cancellationAvailable && !state.cancelRequested) return;
      const box = document.createElement('div'), content = document.createElement('div'), label = document.createElement('span');
      const button = document.createElement('button');
      box.className = 'toast-container'; content.className = 'toast-content'; label.className = 'toast-text';
      box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite');
      box.style.pointerEvents = 'none'; content.style.pointerEvents = 'auto';
      button.type = 'button';
      const english = text('sent') === messages.sent[1];
      button.textContent = english ? 'Cancel this call request' : '取消本次呼叫请求';
      button.addEventListener('click', async () => {
        if (pending !== attempt || !attempt.state.cancellationAvailable || attempt.cancelling) return;
        attempt.cancelling = true; button.disabled = true; label.textContent = text('cancelling');
        try {
          attempt.cancelReply = window.Pedestal.callMethod('method://conference/cancelPendingCall',
            { kind: attempt.state.kind, attemptId: attempt.state.attemptId });
          const reply = await attempt.cancelReply;
          if (pending !== attempt) return;
          if (reply?.result === 0 && reply.param?.attemptId === attempt.state.attemptId &&
              reply.param.callRequestId === attempt.callRequestId) render(attempt, reply.param);
          else label.textContent = text('cancel_failed');
        } catch (_) {
          if (pending === attempt) label.textContent = text('cancel_failed');
        } finally {
          attempt.cancelling = false;
          if (pending === attempt) button.disabled = !attempt.state.cancellationAvailable;
        }
      });
      content.appendChild(label); content.appendChild(button); box.appendChild(content); document.body.appendChild(box);
      attempt.view = { box, label, button };
    }
    const key = state.kind === 'p2p' && state.phase === 'creating' ? (state.transmissionAttempted ? 'sent' : 'preparing') :
      ['preparing', 'sent', 'cancel_requested', 'ending'].includes(state.phase) ? state.phase : 'unknown';
    attempt.view.label.textContent = text(key);
    attempt.view.button.disabled = attempt.cancelling || !state.cancellationAvailable;
  }
  async function watch(attempt) {
    try {
      while (pending === attempt) {
        // Only a query started after the create/cancel receipts may settle the dial window.
        const awaitingEnd = attempt.awaitingEnd;
        const reply = await window.Pedestal.callMethod('method://conference/getPendingCall', { callRequestId: attempt.callRequestId });
        const state = reply?.param;
        if (pending !== attempt || reply?.result !== 0 || !state) return;
        if (awaitingEnd && (state.kind !== 'p2p' || state.callRequestId !== attempt.callRequestId ||
            !state.attemptId || (attempt.state?.attemptId && attempt.state.attemptId !== state.attemptId))) return;
        render(attempt, state);
        if (awaitingEnd && (!state.pending || !state.cancelRequested || state.retired || state.phase === 'end_failed')) return state;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } catch (_) {
      // Older/unavailable backends have no cancellation control; never pretend otherwise.
    }
  }
  window.__welinkStartDial = async params => {
    if (pending) return false;
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    const attempt = { callRequestId: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') };
    pending = attempt; clearNotice();
    try {
      const result = window.Pedestal.callMethod('method://conference/startCall', { ...params, callRequestId: attempt.callRequestId });
      const observed = watch(attempt);
      const reply = await result;
      let state = reply?.param?.callState || reply?.param?.details?.callState;
      if (reply?.notify === 63 && reply.result === 0 && (reply.dialAccepted === false || attempt.cancelReply)) {
        if (attempt.cancelReply) await attempt.cancelReply;
        attempt.awaitingEnd = true;
        state = await observed;
      } else if (reply?.result === 0 && reply.dialAccepted === true &&
          (!state || (state.creationConfirmed && !state.cancelRequested && !state.retired))) return true;
      const code = reply?.param?.reason_code;
      if (Object.prototype.hasOwnProperty.call(messages, code)) explain(code);
      else if ((state?.phase === 'cancelled' || (state?.phase === 'ended' && state.cancelRequested)) && state.endConfirmed === true) explain('cancelled');
      else if ((state?.phase === 'not_sent' || state?.phase === 'cancelled_before_send') && state.transmissionAttempted === false) explain('not_sent');
      else if (state?.phase === 'end_failed') explain('end_failed');
      else if (state?.phase === 'refused') explain('refused');
      else if (state || reply?.param?.details?.transmissionAttempted === true) explain('unknown');
      else explain(typeof reply?.result === 'number' && reply.result !== 0 && code !== 'CALL_UNCONFIRMED' ? 'refused' : 'unknown');
    } catch (_) { explain('unknown'); }
    finally {
      if (attempt.view) attempt.view.box.remove();
      if (pending === attempt) pending = null;
    }
    return false;
  };
})();
