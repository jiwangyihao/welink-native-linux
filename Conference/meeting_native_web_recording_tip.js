// The switch belongs to the local meeting UI, not to MMC's recording authorization.
// Never operate a provider dialog, change its acknowledgement store, or report a recording state here.
(() => {
  'use strict';
  if (window.__welinkCreateRecordingTip) return;
  window.__welinkCreateRecordingTip = function createRecordingTip() {
    let enabled = true, disposed = false, sessionKey = null, recording = false;
    let pending = null, notice = null, acknowledged = false;
    const cancelled = () => Object.assign(new Error('Recording confirmation was cancelled'), { code: 'RECORDING_CANCELLED' });
    function removeNotice() { if (notice) notice.remove(); notice = null; }
    function closeStart(accepted) { if (pending) pending.finish(accepted); }
    function panel(title, message, start, onDecision) {
      const box = document.createElement('section');
      box.setAttribute('data-welink-record-tip', start ? 'start' : 'notice');
      box.setAttribute('role', start ? 'alertdialog' : 'status'); box.setAttribute('aria-label', title);
      // Ordinary document content: never enter the top layer above a mandatory watermark or provider dialog.
      Object.assign(box.style, { position:'fixed', left:'1rem', bottom:'1rem', zIndex:'1000',
        maxWidth:'min(26rem, calc(100vw - 2rem))', padding:'1rem', boxSizing:'border-box',
        background:'Canvas', color:'CanvasText', border:'1px solid GrayText', borderRadius:'.4rem' });
      const heading = document.createElement('strong'); heading.textContent = title;
      const text = document.createElement('p'); text.textContent = message;
      box.append(heading, text);
      const button = (label, answer) => {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
        b.addEventListener('click', e => { if (e.isTrusted) onDecision(answer); }); box.append(b); return b;
      };
      let cancel;
      if (start) { cancel = button('取消', false); button('继续选择保存位置', true); }
      else button('我知道了', true);
      document.body.append(box);
      if (start) {
        cancel.focus({ preventScroll: true });
        box.addEventListener('keydown', e => { if (e.isTrusted && e.key === 'Escape') { e.preventDefault(); onDecision(false); } });
      }
      return box;
    }
    function configure(value) {
      if (disposed || typeof value !== 'boolean') throw new TypeError('An explicit recording confirmation setting is required');
      if (enabled !== value) { enabled = value; closeStart(false); removeNotice(); }
      return { configured:true, enabled, scope:'local-recording-confirmation', grantsRecording:false };
    }
    function observe(key, isRecording, providerConfirm) {
      if (disposed) return;
      if (key !== sessionKey) { closeStart(false); removeNotice(); acknowledged = false; sessionKey = key; recording = false; }
      if (!key || !isRecording) { recording = false; acknowledged = false; removeNotice(); return; }
      recording = true;
      // The original cloud/local consent flow always wins; do not cover or dismiss it.
      if (providerConfirm) { acknowledged = true; removeNotice(); return; }
      if (!enabled || pending || acknowledged || notice || document.hidden) return;
      notice = panel('会议正在录制', '云端或本地录制已开始。你可以通过会议控制离开会议。', false, () => { acknowledged = true; removeNotice(); });
    }
    function confirmStart(key, signal) {
      if (disposed || !key || key !== sessionKey || !signal || signal.aborted) return Promise.reject(cancelled());
      if (!enabled) return Promise.resolve();
      if (pending) return Promise.reject(cancelled());
      removeNotice();
      return new Promise((resolve, reject) => {
        const before = document.activeElement; let box;
        const abort = () => finish(false);
        function finish(ok) {
          if (!pending || pending.finish !== finish) return;
          pending = null; signal.removeEventListener('abort', abort); if (box) box.remove();
          if (before && before.isConnected && document.activeElement === document.body) before.focus({preventScroll:true});
          if (ok && !disposed && enabled && !signal.aborted && key === sessionKey) resolve(); else reject(cancelled());
        }
        pending = { finish }; signal.addEventListener('abort', abort, {once:true});
        try { box = panel('开始本地录制？', '将把当前会议中已有的音视频保存到你选择的文件。请先告知参会者并取得必要同意。', true, finish); }
        catch (error) { pending = null; signal.removeEventListener('abort', abort); reject(error); }
      });
    }
    function dispose() { disposed = true; closeStart(false); removeNotice(); }
    return Object.freeze({ configure, confirmStart, observe, dispose, get enabled() { return enabled; } });
  };
})();
