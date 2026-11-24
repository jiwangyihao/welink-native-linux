'use strict';

// Sandboxed, isolated world only. No bridge or IPC function is exposed to the
// document. CSP forbids document scripts and every invitation value is text.
const { ipcRenderer } = require('electron');
const argument = process.argv.find(value => /^--welink-incoming-invite=[a-f0-9]{32}$/.test(value));
const nonce = argument ? argument.split('=')[1] : null;

if (nonce && window.top === window && window.location.protocol === 'file:' &&
    window.location.pathname.endsWith('/meeting_incoming_invite.html') &&
    !window.location.search && window.location.hash === '#' + nonce) {
  const channel = 'welink-native-meeting-incoming-invite-' + nonce;
  window.addEventListener('DOMContentLoaded', () => {
    const heading = document.getElementById('heading');
    const subject = document.getElementById('subject');
    const media = document.getElementById('media');
    const disclosure = document.getElementById('disclosure');
    const status = document.getElementById('status');
    const accept = document.getElementById('accept');
    const decline = document.getElementById('decline');
    let ready = false, answered = false;

    const decide = (event, kind) => {
      if (!event.isTrusted || !ready || answered) return;
      answered = true;
      accept.disabled = true;
      decline.disabled = true;
      status.textContent = '正在提交选择…';
      ipcRenderer.send(channel, { kind });
    };
    const acceptClick = event => decide(event, 'accept');
    const declineClick = event => decide(event, 'decline');
    const escape = event => {
      if (!event.isTrusted || event.key !== 'Escape' || event.repeat) return;
      event.preventDefault();
      decide(event, 'decline');
    };
    accept.addEventListener('click', acceptClick);
    decline.addEventListener('click', declineClick);
    window.addEventListener('keydown', escape);

    const receive = (_event, data) => {
      if (ready || answered) return;
      if (!data || typeof data.subject !== 'string' || typeof data.p2p !== 'boolean' ||
          typeof data.mediaType !== 'string') {
        ipcRenderer.send(channel, { kind: 'cancel' });
        return;
      }
      heading.textContent = data.p2p ? '来电邀请' : '会议邀请';
      document.title = heading.textContent;
      subject.textContent = data.subject || '邀请方未提供主题';
      media.textContent = data.mediaType ? '邀请方标注的媒体类型：' + data.mediaType : '';
      media.hidden = !data.mediaType;
      disclosure.textContent = data.p2p ?
        '点击“接受”将向会议服务发送接受此来电邀请的真实请求，并非预览或演示。当前尚未接通。' :
        '点击“接受”将向会议服务发送接受邀请并申请加入会议的真实请求，并非预览或演示。当前尚未加入会议。';
      status.textContent = '请选择接受或拒绝。关闭此窗口也将拒绝当前邀请。';
      ready = true;
      decline.disabled = false;
      accept.disabled = false;
      // DOM focus only, never window.focus(). Enter defaults to refusal, not
      // acceptance; the window itself is shown inactive by its native owner.
      decline.focus({ preventScroll: true });
      ipcRenderer.send(channel, { kind: 'ready' });
    };
    ipcRenderer.once(channel, receive);
    window.addEventListener('unload', () => {
      ipcRenderer.removeListener(channel, receive);
      accept.removeEventListener('click', acceptClick);
      decline.removeEventListener('click', declineClick);
      window.removeEventListener('keydown', escape);
    }, { once: true });
  }, { once: true });
}
