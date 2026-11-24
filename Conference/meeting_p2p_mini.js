'use strict';

// Compact the existing protected media window. No clone, screenshot, new room,
// device permission or media track is involved. All coordinates are native DIPs.
const fail = (code, message) => Object.assign(new Error(message), { code });
const delay = () => new Promise(done => setTimeout(done, 25));
const closeEnough = (a, b) => Math.abs(a - b) <= 2;

class P2pMiniWindow {
  constructor(bridge) {
    this.bridge = bridge;
    this.enabled = true;
    this.saved = null;
    this.changing = false;
  }

  eligible() {
    const b = this.bridge, w = b.window, media = b.lastMediaState, call = b.p2p?.state();
    return !!(this.enabled && b.ready && !b.disposed && !b.retiring && !b.loggingOut && !b.offline?.active &&
      b.mediaOrigin === b.origin && b.watermarkApproved && b.uiApproved && !b.policyPending.size &&
      w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && !w.isFullScreen() &&
      media?.joined && call?.pending && !call.cancelRequested && call.peerEstablished &&
      String(media.conferenceId) === call.conferenceID && call.attemptId);
  }

  restore() {
    const s = this.saved;
    if (!s) return;
    this.saved = null;
    const w = s.window;
    if (w.isDestroyed()) return;
    w.setAlwaysOnTop(s.top);
    w.setBounds(s.normal);
    // maximize() may show a hidden window. Never undo policy/lifecycle hiding.
    if (s.maximized && w.isVisible() && !w.isMinimized()) w.maximize();
  }

  reconcile() {
    const s = this.saved;
    if (s && (!this.eligible() || this.bridge.window !== s.window || this.bridge.p2p.state().attemptId !== s.attemptId)) this.restore();
  }

  async configure(enabled) {
    if (typeof enabled !== 'boolean') throw fail('INVALID_ARGUMENT', 'Expected a boolean compact-call setting');
    this.enabled = enabled;
    const s = this.saved;
    if (!enabled && s) { this.restore(); await this.confirmRestore(s); }
    return { configured: true, type: 13, capability: 'HWM_SDK_CAPABILITY_SUPPORT_P2P_MINI_WINDOW', enabled,
      scope: 'local-p2p-compact-window', active: !!this.saved, serverPermissionGranted: false, osPermissionGranted: false };
  }

  async confirmRestore(s) {
    const w = s.window;
    for (let i = 0; i < 80; i++) {
      if (w.isDestroyed() || !w.isVisible() || w.isMinimized()) return;
      const b = w.getBounds();
      if (w.isAlwaysOnTop() === s.top && (s.maximized ? w.isMaximized() :
          closeEnough(b.width, s.normal.width) && closeEnough(b.height, s.normal.height))) return;
      await delay();
    }
    throw fail('WINDOW_RESTORE_UNCONFIRMED', 'The desktop did not restore the original call window');
  }

  async toggle(attemptId) {
    const b = this.bridge, w = b.window;
    if (!this.eligible() || b.p2p.state().attemptId !== attemptId)
      throw fail('P2P_MINI_UNAVAILABLE', 'A visible, connected one-to-one call is required; exit fullscreen first');
    if (this.changing) throw fail('WINDOW_CHANGE_PENDING', 'The call window is already changing size');
    this.changing = true;
    try {
      if (this.saved) {
        const s = this.saved; this.restore(); await this.confirmRestore(s);
        return { compact: false, attemptId, bounds: w.isDestroyed() ? null : w.getBounds() };
      }
      const normal = w.getNormalBounds(), maximized = w.isMaximized();
      const s = { window: w, attemptId, normal, maximized, top: w.isAlwaysOnTop() };
      const area = b.electron.screen.getDisplayMatching(w.getBounds()).workArea;
      const width = Math.min(480, area.width), height = Math.min(320, area.height);
      const target = { width, height, x: area.x + Math.max(0, area.width - width - 16), y: area.y + Math.max(0, area.height - height - 16) };
      this.saved = s;
      const check = () => {
        if (this.saved !== s || !this.eligible() || b.window !== w || b.p2p.state().attemptId !== attemptId)
          throw fail('CONFERENCE_CHANGED', 'The call changed before its compact window was ready');
      };
      try {
        if (maximized) {
          w.unmaximize();
          for (let i = 0; i < 80 && w.isMaximized(); i++) { check(); await delay(); }
          if (w.isMaximized()) throw fail('WINDOW_RESIZE_UNCONFIRMED', 'The desktop kept the call maximized');
        }
        check(); w.setBounds(target); w.setAlwaysOnTop(true);
        for (let i = 0; i < 80; i++) {
          check(); const bounds = w.getBounds();
          if (closeEnough(bounds.width,width) && closeEnough(bounds.height,height) && w.isAlwaysOnTop())
            return { compact: true, attemptId, bounds, alwaysOnTop: true };
          await delay();
        }
        throw fail('WINDOW_RESIZE_UNCONFIRMED', 'The desktop did not apply compact call dimensions and floating state');
      } catch (err) { if (this.saved === s) this.restore(); throw err; }
    } finally { this.changing = false; }
  }
}
module.exports = { P2pMiniWindow };
