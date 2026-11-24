'use strict';

// Fixed local UI in an isolated sandbox. Device identities and labels are text,
// never HTML, and the document receives no general-purpose IPC capability.
const { ipcRenderer } = require('electron');
const argument = process.argv.find(value => /^--welink-native-meeting-picker=[a-f0-9]{32}$/.test(value));
const channel = argument ? 'welink-native-meeting-v1-picker-' + argument.split('=')[1] : null;

window.addEventListener('DOMContentLoaded', () => {
  const kinds = ['audioinput', 'audiooutput', 'videoinput'];
  const controls = new Map(kinds.map(kind => [kind, {
    select: document.getElementById(kind),
    apply: document.getElementById('apply-' + kind),
    reason: document.getElementById('reason-' + kind)
  }]));
  const status = document.getElementById('status');
  const connection = document.getElementById('connection');
  const refresh = document.getElementById('refresh');
  const close = document.getElementById('close');
  let current = null;
  let busy = false;
  let closing = false;

  function updateControls() {
    refresh.disabled = !channel || busy || closing;
    for (const kind of kinds) {
      const row = controls.get(kind);
      const choices = current && current.devices.some(device => device.kind === kind && device.deviceId);
      const allowed = current && current.policy[kind].selectable === true;
      row.select.disabled = busy || closing || !choices || !allowed;
      row.apply.disabled = row.select.disabled || !row.select.value ||
        row.select.value === current.state.selectedDevices[kind];
    }
  }

  function render(data) {
    if (!data || !Array.isArray(data.devices) || !data.state || !data.state.selectedDevices ||
        !data.policy || kinds.some(kind => !data.policy[kind])) throw new Error('The device state reply is invalid');
    current = data;
    connection.textContent = data.state.joined ?
      'Connected meeting — selections affect the current session. Settings does not enable a microphone or camera.' :
      'Not in a connected meeting — only vendor device preferences can be saved; no device is activated.';
    if (typeof data.state.connection === 'string') connection.textContent += ' RTC state: ' + data.state.connection + '.';
    for (const kind of kinds) {
      const row = controls.get(kind);
      const fragment = document.createDocumentFragment();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select a device';
      placeholder.disabled = true;
      placeholder.selected = true;
      fragment.appendChild(placeholder);
      for (const device of data.devices.filter(item => item.kind === kind)) {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || device.deviceId || 'Device identity is not exposed by the browser';
        option.disabled = !device.deviceId;
        fragment.appendChild(option);
      }
      row.select.replaceChildren(fragment);
      row.select.selectedIndex = 0;
      const selected = data.state.selectedDevices[kind];
      if (selected && data.devices.some(device => device.kind === kind && device.deviceId === selected))
        row.select.value = selected;
      row.reason.textContent = data.policy[kind].reason;
      if (!data.devices.some(device => device.kind === kind && device.deviceId))
        row.reason.textContent += ' No selectable device identity is currently exposed. Refresh after changing permissions in the meeting controls.';
    }
    updateControls();
  }

  async function run(message) {
    if (!channel || busy || closing) return;
    busy = true;
    updateControls();
    status.textContent = message.kind === 'select' ? 'Applying and verifying the genuine device selection…' : 'Reading actual available devices…';
    try {
      const reply = await ipcRenderer.invoke(channel, message);
      if (!reply || reply.ok !== true) {
        const error = reply && reply.error;
        throw new Error(error ? String(error.code) + ': ' + error.message : 'The device operation returned no valid result');
      }
      render(reply.data);
      status.textContent = reply.data.selectionVerified === true ?
        (reply.data.selection.active ? 'The connected-session device selection was retained and verified.' :
          reply.data.effect === 'connected-preference-only' ?
            'The meeting output preference was saved. No receiving audio player was active to verify routing.' :
            'The pre-meeting preference was retained and verified. No device was activated.') :
        'Showing actual enumerated devices and retained preferences. Choose a device explicitly to change it.';
    } catch (error) {
      current = null;
      connection.textContent = 'The current device and meeting state is unavailable. Refresh to obtain a new observation.';
      status.textContent = String(error.message || error) + ' Refresh before making another selection.';
    } finally {
      busy = false;
      updateControls();
    }
  }

  function requestClose() {
    if (closing) return;
    closing = true;
    updateControls();
    close.disabled = true;
    status.textContent = 'Finishing any pending device operation before closing. Confirmed changes are not undone.';
    if (!channel) { window.close(); return; }
    ipcRenderer.invoke(channel, { kind: 'close' }).catch(() => window.close());
  }

  for (const kind of kinds) {
    const row = controls.get(kind);
    row.select.addEventListener('change', updateControls);
    row.apply.addEventListener('click', () => {
      if (!row.apply.disabled) run({ kind: 'select', deviceKind: kind, deviceId: row.select.value });
    });
  }
  refresh.addEventListener('click', () => run({ kind: 'load' }));
  close.addEventListener('click', requestClose);
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); requestClose(); }
  });
  if (!channel) {
    status.textContent = 'Device settings is not connected. Close this window and reopen it from the application.';
    updateControls();
    return;
  }
  run({ kind: 'load' });
}, { once: true });
