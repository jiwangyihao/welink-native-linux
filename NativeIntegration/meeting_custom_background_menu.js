'use strict';

// Extension of the actual per-window Meeting menu, not a cosmetic page overlay.
const operations = Object.freeze({
  'background-choose': 'background.choose',
  'background-apply': 'background.apply',
  'background-clear': 'background.clear'
});
function isAction(action) { return Object.hasOwn(operations, action); }
function allowed(action, state, bridge) {
  const bg = state?.customBackground;
  if (!bg || !state.joined) return false;
  if (action === 'background-clear') return bg.ui.clearAvailable === true;
  if (!bridge.nativeCapabilityEnabled(10)) return false;
  return action === 'background-choose' ? bg.ui.importAvailable === true :
    action === 'background-apply' && bg.ui.applyAvailable === true;
}
function command(action) { return { operation: operations[action], params: {} }; }
function template(entry) {
  return [{ type: 'separator' },
    { id: 'background-status', label: 'Custom background: no local image', enabled: false },
    { id: 'background-prerequisite', label: 'PNG/JPEG, up to 5 MiB; normal camera permission required', enabled: false },
    entry('background-choose', '导入本地背景图片… / Import local background…'),
    entry('background-apply', '应用到已开启的摄像头 / Apply to open camera'),
    entry('background-clear', '移除背景并恢复摄像头 / Remove and restore camera')];
}
function update(menu, state, bridge, busy) {
  const bg = state?.customBackground;
  const visible = bridge.nativeCapabilityEnabled(10) || !!bg?.imported || !!bg?.publicationConfirmed;
  const status = menu.getMenuItemById('background-status');
  status.visible = visible;
  status.label = 'Custom background: ' + (bg?.activeFrames ? 'outgoing segmented frames confirmed' :
    bg?.reason ? bg.reason : bg?.imported ? 'imported only — Apply to open camera' : 'no local image') +
    ' (this meeting only)';
  const prerequisite = menu.getMenuItemById('background-prerequisite');
  prerequisite.visible = visible;
  prerequisite.label = bg?.prerequisite || (bg?.imported && !bg.ui.applyAvailable && !bg.activeFrames ?
    'Open the camera with the normal provider controls, then choose Apply' :
    'PNG/JPEG, 64–4096 pixels per side, at most 8 megapixels / 5 MiB');
  for (const action of Object.keys(operations)) {
    const item = menu.getMenuItemById(action);
    item.visible = visible;
    item.enabled = !busy && allowed(action, state, bridge);
  }
}
module.exports = { isAction, allowed, command, template, update };
