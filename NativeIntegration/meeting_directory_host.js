'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { visibleDirectoryReply } = require('./meeting_directory');
const page = path.join(__dirname, 'meeting_directory.html');
const url = pathToFileURL(page).href;
const stale = () => Object.assign(new Error('The roster lookup is no longer current'), { code: 'DIRECTORY_QUERY_RETIRED' });

// An actual native context-menu click creates at most one outstanding query.
// Only the local app owner gets the contact request. The networked meeting page
// supplies/validates roster identity; it never receives the address book reply.
function createParticipantDirectory({ electron, bridge, isActive, requestOwner, complaints }) {
  let active = null;
  function current(q) {
    return active === q && isActive() && !!bridge.ready && !bridge.retiring && !bridge.loggingOut &&
      bridge.window === q.parent && !q.parent.isDestroyed() && bridge.uiApproved && bridge.watermarkApproved &&
      !bridge.policyPending.size && q.epoch === bridge.policyEpoch && q.ui === bridge.policyIntents.ui &&
      q.mark === bridge.policyIntents.watermark;
  }
  function cancel() {
    const q = active;
    if (!q) return;
    active = null;
    if (q.phase === 'report') complaints?.cancel('COMPLAINT_CONTEXT_CHANGED');
    if (q.timer) clearTimeout(q.timer);
    if (q.menu && !q.parent.isDestroyed()) q.menu.closePopup(q.parent);
    if (q.view && !q.view.isDestroyed()) q.view.destroy();
  }
  async function verify(q) {
    if (!current(q) || !await bridge.callPage('directory.current', { requestId: q.id }) || !current(q)) throw stale();
  }
  function invalidate(id) { if (active && active.id === id) cancel(); }
  async function present(q, result) {
    await verify(q);
    const wc = q.view && !q.view.isDestroyed() && q.view.webContents;
    if (!wc || wc.getURL() !== url) throw stale();
    await wc.executeJavaScript(`(r=>{const el=id=>document.getElementById(id);
      el('status').textContent=r.failed?'企业通讯录查询失败。':r.found?'当前参会者的企业通讯录资料':'企业通讯录中没有匹配的资料。';
      el('details').hidden=!r.found;el('dept').textContent=r.department||'未提供';
      el('numbers').textContent=r.visibility==='hidden'?'不可见':(r.numbers||[]).join('\\n')||'未提供';
    })(${JSON.stringify(result)})`);
    if (!current(q) || q.view.isDestroyed() || !q.view.isVisible()) throw stale();
    return { applied: !result.failed, found: !!result.found, scope: 'local-participant-directory' };
  }
  async function answer(params, failed = false) {
    const q = active;
    if (!q || q.phase !== 'waiting' || params.requestId !== q.id || !current(q)) throw stale();
    q.phase = 'answered'; clearTimeout(q.timer);
    try { return await present(q, failed ? { failed: true } : visibleDirectoryReply(params.reply, q.target.sipNumber)); }
    catch (error) { invalidate(q.id); throw error; }
  }
  async function open(q) {
    await verify(q);
    const view = q.view = new electron.BrowserWindow({ width: 460, height: 340, show: false,
      title: '参会者部门与号码', parent: q.parent, modal: true,
      webPreferences: { partition: 'welink-directory-'+q.id, sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true, devTools: false, webviewTag: false } });
    const wc = view.webContents;view.setMenu(null);
    view.on('closed', () => invalidate(q.id));
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.session.setPermissionCheckHandler(() => false);
    wc.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    wc.session.webRequest.onBeforeRequest((r, cb) => cb({ cancel: r.url !== url }));
    wc.on('will-navigate', e => { e.preventDefault(); invalidate(q.id); });
    wc.on('will-attach-webview', e => e.preventDefault());
    wc.on('render-process-gone', () => invalidate(q.id));
    await view.loadFile(page);
    if (!current(q) || wc.getURL() !== url) throw stale();
    if (bridge.watermarkConfiguration?.content) {
      const factory = fs.readFileSync(path.join(__dirname, 'meeting_native_web_watermark.js'), 'utf8');
      const applied = await wc.executeJavaScript(factory+'\n;(()=>{const mark=window.__welinkCreateNativeWatermark({onViolation:()=>window.close()});mark.configure('+JSON.stringify(bridge.watermarkConfiguration)+');return mark.ensure("meeting-ui").enabled;})()');
      if (!applied) throw stale();
    }
    await wc.executeJavaScript(`document.getElementById('close').addEventListener('click',()=>window.close());window.addEventListener('keydown',e=>{if(e.key==='Escape')window.close();});`);
    await verify(q);
    view.show(); q.phase = 'waiting';
    q.timer = setTimeout(() => { answer({ requestId:q.id }, true).catch(() => invalidate(q.id)); }, 40000);
    q.timer.unref();
    if (!requestOwner({ requestId:q.id, sessionKey:q.target.sessionKey, conferenceID:q.target.conferenceID,
      queryInfoList:[{ userUuid:q.target.userUuid, sipNumber:q.target.sipNumber }] })) throw stale();
  }
  async function context(parent, params) {
    cancel();
    if (!isActive() || parent !== bridge.window || !bridge.ready || !Number.isFinite(params.x) || !Number.isFinite(params.y)) return;
    const q = active = { id:crypto.randomBytes(16).toString('hex'), parent, epoch:bridge.policyEpoch,
      ui:bridge.policyIntents.ui, mark:bridge.policyIntents.watermark, phase:'select' };
    try {
      if (!current(q)) return invalidate(q.id);
      q.target = await bridge.callPage('directory.target', { requestId:q.id, x:params.x, y:params.y });
      if (!q.target || !current(q)) return invalidate(q.id);
      const items = [];
      if (q.target.sipNumber) items.push({ label:'查看部门与备选号码', click:() => {
        q.phase = 'opening'; q.menu = null; open(q).catch(() => invalidate(q.id));
      } });
      if (q.target.reportable && complaints?.status().enabled) items.push({ label:'举报这位参会者的账号…', click:() => {
        q.phase = 'report'; q.menu = null;
        complaints.open({parent, target:q.target, verify:async () => { await verify(q); return true; }})
          .finally(() => invalidate(q.id)).catch(() => {});
      } });
      if (!items.length) return invalidate(q.id);
      const menu = q.menu = electron.Menu.buildFromTemplate(items);
      menu.popup({ window:parent, callback:()=>{ if(q.phase==='select') {q.menu=null;invalidate(q.id);} } });
    } catch (_) { invalidate(q.id); }
  }
  return { context, cancel, invalidate, answer };
}
module.exports = { createParticipantDirectory };
