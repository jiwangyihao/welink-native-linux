'use strict';

// The pinned meeting security panel (606.616fb575) marks “Forbid screenshots”
// active when forbiddenScreenShots === FORBID_SCREEN_SHOOTS.DISABLED (1).
// Support flags describe UI availability; they are not grants to take pictures.
(function(root) {
  function decision(value) {
    if (value === 0 || value === '0') return 'allowed';
    if (value === 1 || value === '1') return 'forbidden';
    return 'unknown';
  }
  function requireAllowed(value) {
    if (value === 'allowed') return;
    const denied = value === 'forbidden';
    throw Object.assign(new Error(denied ? '此会议禁止截图' : '尚未收到此会议允许截图的策略'),
      { code: denied ? 'SCREENSHOT_FORBIDDEN' : 'SCREENSHOT_POLICY_UNKNOWN' });
  }
  const api = Object.freeze({decision, requireAllowed});
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) Object.defineProperty(root, '__welinkSnapshotPolicy', {value:api, configurable:true});
})(typeof window === 'undefined' ? null : window);
