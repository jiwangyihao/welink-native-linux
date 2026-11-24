'use strict';

const crypto = require('crypto');
const path = require('path');
let pending = null;
const failure = (code, message) => Object.assign(new Error(message), { code });
const identity = context => ({ conferenceId: String(context?.conferenceId || ''), noteId: String(context?.noteId || '') });
const same = (left, right) => left.conferenceId === right.conferenceId && left.noteId === right.noteId;

// Called again by the ORIGINAL me callback immediately after its async upload,
// before editor/AI-wrap lookup or insertion. This closes note changes during I/O.
function current(receipt, context) {
  return !!pending && pending.reply === receipt && pending.state === 'inserting' &&
    same(pending.context, identity(context)) && receipt.param?.requestId === pending.id;
}

// Keep the original cmd/notify1039 broadcast, but do not trust a broadcast's file
// path as upload authority. Only the matching direct service-method result may
// authorize an insertion. Broadcasts from old windows/rooms are harmless.
function receive(receipt) {
  if (!pending || receipt?.param?.requestId !== pending.id) return { ignored: true };
  pending.broadcastObserved = true;
  return { observed: true, requestId: pending.id };
}

async function request({ Pedestal, getContext, insert, notify }) {
  const report = error => {
    const code = error?.code || 'RENDER_NOTE_FAILED';
    if (typeof notify === 'function') notify({ code, message: String(error?.message || error) });
    return { result: 1, param: { status: 'failed', filePath: '', reason_code: code, reason: String(error?.message || error) } };
  };
  if (pending) return report(failure('RENDER_CAPTURE_BUSY', 'A conference picture is already being saved or attached'));
  const context = identity(getContext());
  if (!context.conferenceId || !context.noteId)
    return report(failure('NOTE_NOT_READY', 'Open a note in the active conference before inserting a picture'));
  const entry = { id: crypto.randomBytes(16).toString('hex'), context, state: 'requesting', reply: null, broadcastObserved: false };
  pending = entry;
  try {
    const receipt = await Pedestal.callMethod('method://private_conference/hwm/getRenderWindowInfoList', {
      isSavePic: true, requestId: entry.id, conferenceId: context.conferenceId
    });
    if (pending !== entry || !same(context, identity(getContext())))
      throw failure('NOTE_CONTEXT_CHANGED', 'The note or conference changed before the picture could be attached');
    const data = receipt?.param;
    if (!data || data.requestId !== entry.id)
      throw failure('INVALID_RENDER_RECEIPT', 'The conference did not return the matching picture request');
    if (receipt.result !== 0)
      throw failure(data.reason_code || 'RENDER_CAPTURE_FAILED', data.reason || 'The conference picture could not be captured');
    if (data.status === 'canceled' && data.save?.canceled === true && data.filePath === '') return receipt;
    if (data.status !== 'saved' || data.conferenceId !== context.conferenceId || !data.sessionKey ||
        data.nativeHandleSupported !== false || data.captureScope !== 'rendered-conference-media-only' ||
        typeof data.filePath !== 'string' || !path.isAbsolute(data.filePath) || path.extname(data.filePath).toLowerCase() !== '.png' ||
        data.save?.filePath !== data.filePath || data.save?.canceled !== false || data.save?.consent !== 'native-save-dialog' ||
        !Number.isInteger(data.save?.bytesWritten) || data.save.bytesWritten <= 0)
      throw failure('INVALID_RENDER_RECEIPT', 'No user-approved saved conference PNG is available to attach');
    entry.reply = receipt;
    entry.state = 'inserting';
    await insert(receipt);
    if (!current(receipt, getContext())) throw failure('NOTE_CONTEXT_CHANGED', 'The note changed while its picture was uploading');
    return { ...receipt, noteInsertion: { completed: true, noteId: context.noteId,
      broadcastObserved: entry.broadcastObserved } };
  } catch (error) { return report(error); }
  finally { if (pending === entry) pending = null; }
}

module.exports = { request, receive, current };
