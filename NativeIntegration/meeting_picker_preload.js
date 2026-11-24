'use strict';

// This sandboxed, isolated preload owns the fixed local UI. No IPC capability is
// exposed to the document, and source names are only ever assigned as text.
const { ipcRenderer } = require('electron');
const argument = process.argv.find(value => /^--welink-native-meeting-picker=[a-f0-9]{32}$/.test(value));
const channel = argument ? 'welink-native-meeting-v1-picker-' + argument.split('=')[1] : null;

window.addEventListener('DOMContentLoaded', () => {
  const select = document.getElementById('sources');
  const status = document.getElementById('status');
  const cancel = document.getElementById('cancel');
  const share = document.getElementById('share');
  let ids = new Set();
  let systemAudio = false;
  let submitting = false;

  const cancelSelection = () => {
    if (!channel) { window.close(); return; }
    ipcRenderer.invoke(channel, { kind: 'cancel' }).catch(() => window.close());
  };
  cancel.addEventListener('click', cancelSelection);
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); cancelSelection(); }
  });
  select.addEventListener('change', () => {
    share.disabled = submitting || select.selectedIndex < 0 || !ids.has(select.value);
  });
  share.addEventListener('click', () => {
    if (submitting || select.selectedIndex < 0 || !ids.has(select.value)) return;
    submitting = true;
    select.disabled = true;
    share.disabled = true;
    ipcRenderer.invoke(channel, { kind: 'select', id: select.value, systemAudio }).catch(() => {
      // Closing a successfully answered picker can tear down the invoke reply.
      // If it is still open, keep cancellation available and report the failure.
      if (window.closed) return;
      submitting = false;
      select.disabled = false;
      share.disabled = select.selectedIndex < 0 || !ids.has(select.value);
      status.textContent = 'The selection could not be submitted. Select a source again or cancel.';
    });
  });

  if (!channel) {
    status.textContent = 'The source picker is not connected. Close this window and try again.';
    return;
  }
  ipcRenderer.invoke(channel, { kind: 'sources' }).then(({ sources, systemAudio: withSound }) => {
    systemAudio = withSound === true;
    if (systemAudio) {
      document.getElementById('scope').textContent = '将共享选定的画面以及默认扬声器播放的全部声音，包括其他应用和会议中其他人的声音。仅共享某个窗口也不会限制声音范围。不会替你开启麦克风。';
      share.textContent = '共享画面和电脑声音';
    }
    if (!Array.isArray(sources) || sources.some(source => !source || typeof source.id !== 'string' ||
        !source.id || typeof source.name !== 'string')) throw new Error('Invalid source list');
    ids = new Set(sources.map(source => source.id));
    const fragment = document.createDocumentFragment();
    for (const source of sources) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.name || source.id;
      if (typeof source.displayId === 'string' && source.displayId)
        option.textContent += ' (display ' + source.displayId + ')';
      fragment.appendChild(option);
    }
    select.replaceChildren(fragment);
    // A native select may otherwise choose its first option on insertion.
    select.selectedIndex = -1;
    select.disabled = sources.length === 0;
    share.disabled = true;
    status.textContent = sources.length ? 'Select one source, then choose Share selected source.' :
      'No shareable screens or windows are available. Choose Cancel to return.';
  }).catch(() => {
    select.disabled = true;
    share.disabled = true;
    status.textContent = 'Available sources could not be loaded. Choose Cancel to return.';
  });
}, { once: true });
