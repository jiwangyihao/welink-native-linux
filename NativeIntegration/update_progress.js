'use strict';
const titles = { downloading: 'Downloading signed native update', staging: 'Reconstructing side-by-side image', verifying: 'Verifying installed image', authorization: 'Authorize protected sandbox reuse', staged: 'Verified. Requesting normal restart', 'waiting-exit': 'Waiting for the application to exit normally', 'backing-up': 'Preserving the current profile', starting: 'Waiting for working login/message UI', canceled: 'Update canceled', failed: 'Update failed' };
window.nativeUpdate.observe(value => {
  document.getElementById('phase').textContent = titles[value.phase] || value.phase;
  const bar = document.getElementById('progress');
  if (value.total > 0) { bar.max = value.total; bar.value = value.completed; } else bar.removeAttribute('value');
  document.getElementById('detail').textContent = value.error || (value.phase === 'authorization' ? 'Use the desktop authorization dialog. Only the verified existing sandbox is linked; the installer never runs as root.' : ((value.asset || '') + (value.total > 0 ? ' ' + value.completed.toLocaleString() + ' / ' + value.total.toLocaleString() : '')));
});
document.getElementById('cancel').addEventListener('click', () => {
  document.getElementById('cancel').disabled = true;
  document.getElementById('detail').textContent = 'Canceling; waiting for the installer to stop safely…';
  window.nativeUpdate.cancel();
});
