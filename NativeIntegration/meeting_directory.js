'use strict';

// cmd1045's result is local to the meeting client. Never send address-book
// records or unmasked numbers to the hosted WebRTC renderer.
const PHONE_FIELDS = ['other_phone2', 'other_phone', 'ip_phone', 'short_phone', 'office_phone', 'home_phone', 'mobile'];
const fail = (code, message) => Object.assign(new Error(message), { code });
const plain = value => typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value);

function nativeDirectoryReply(query, contacts) {
  if (!Array.isArray(contacts)) throw fail('DIRECTORY_LOOKUP_FAILED', 'The contact provider did not return a list');
  const matches = contacts.filter(c => c && c.account === query.userUuid);
  if (matches.length > 1) throw fail('DIRECTORY_IDENTITY_AMBIGUOUS', 'The contact provider returned conflicting identities');
  if (!matches.length) return { infoCount: 0, corpDepartmentInfoList: [] };
  const c = matches[0];
  const numbers = [...new Set(PHONE_FIELDS.map(k => c[k]).filter(n => plain(n) && n && n !== query.sipNumber))];
  return { infoCount: 1, corpDepartmentInfoList: [{ sipNumber: query.sipNumber,
    departmentInfo: plain(c.display_dept) ? c.display_dept : '', hideType: c.isHidden,
    userNumberCount: numbers.length, numbersValue: numbers }] };
}

function visibleDirectoryReply(reply, sipNumber) {
  if (!reply || !Array.isArray(reply.corpDepartmentInfoList) || reply.infoCount !== reply.corpDepartmentInfoList.length ||
      (reply.infoCount !== 0 && reply.infoCount !== 1)) throw fail('INVALID_DIRECTORY_RESULT', 'Invalid directory reply count');
  if (!reply.infoCount) return { found: false };
  const r = reply.corpDepartmentInfoList[0];
  if (!r || r.sipNumber !== sipNumber || !plain(r.departmentInfo) || !Array.isArray(r.numbersValue) ||
      r.numbersValue.length !== r.userNumberCount || r.userNumberCount > PHONE_FIELDS.length ||
      r.numbersValue.some(n => !plain(n))) throw fail('INVALID_DIRECTORY_RESULT', 'Directory result does not match the requested participant');
  // Packaged contact UI: 1 = public, 2 = hidden, 3 = mask digits 4–7.
  // Do not expose nonstandard extensions, short numbers or unknown policy values.
  const visibility = [1, '1'].includes(r.hideType) ? 'visible' : [3, '3'].includes(r.hideType) ? 'masked' : 'hidden';
  const numbers = visibility === 'hidden' ? [] : [...new Set(r.numbersValue.filter(n => n && n !== sipNumber).map(n =>
    visibility === 'visible' ? n : /^\d{11}$/.test(n) ? n.slice(0, 3) + '****' + n.slice(7) : '••••'))];
  return { found: true, department: r.departmentInfo, visibility, numbers };
}

module.exports = { nativeDirectoryReply, visibleDirectoryReply };
