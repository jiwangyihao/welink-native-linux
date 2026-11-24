'use strict';

const { createHmac, randomBytes } = require('crypto');
const { performance } = require('perf_hooks');

const LIFETIME_MS = 60000;
const MAX_ENTRIES = 32;
const INVALID_TEXT = /[\u0000-\u001f\u007f]/;
const INVALID_URL = /[\u0000-\u0020\u007f\\]/;

function invalid() {
  return Object.assign(new Error('A live issuer-attested online invitation is required'), { code: 'ISSUED_SITE_UNAVAILABLE' });
}

function text(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit &&
    value.trim().length > 0 && !INVALID_TEXT.test(value) && value !== 'null' && value !== 'undefined';
}

function https(value, originOnly = false) {
  if (typeof value !== 'string' || value.length > 8192 || INVALID_URL.test(value) ||
      !/^https:\/\/[^/?#]+(?:[/?#]|$)/i.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch (_) { throw invalid(); }
  const authority = value.slice(value.indexOf('//') + 2).split(/[/?#]/, 1)[0];
  if (url.protocol !== 'https:' || !url.hostname || url.hostname.includes('*') || authority.includes('@') ||
      url.username || url.password || value.includes('#') ||
      (originOnly && (url.pathname !== '/' || value.includes('?')))) throw invalid();
  return url;
}

function binding(issuer, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || params.isOfflineJoin !== false ||
      !text(params.random, 16384) || !text(params.idPrefix, 2048) || !text(params.confId, 256)) throw invalid();
  const authority = https(issuer, true).origin;
  const site = https(params.site_url);
  if (site.origin === authority) throw invalid();
  // The full site bytes are bound too: path/query changes cannot reuse a grant.
  return { origin: site.origin, values: [authority, params.site_url, params.random, params.idPrefix, params.confId] };
}

// Main-process only. The broker verifies the exact packaged issuer file before
// issue(), and supplies the current account authority to take(). No URL parser
// or public meeting method issues grants. Nothing secret crosses back to a URL.
class IssuedMeetingSites {
  #webContents;
  #now;
  #secret = randomBytes(32);
  #entries = new Map();
  #documents = new Map();

  constructor({ webContents, now = () => performance.now() }) {
    if (!webContents || typeof webContents.fromFrame !== 'function' || typeof now !== 'function')
      throw new TypeError('Electron webContents and a monotonic clock are required');
    this.#webContents = webContents;
    this.#now = now;
  }

  #live(document) {
    try {
      const { frame, contents } = document;
      // Electron 22 WebFrameMain has no isDestroyed(). fromFrame returns
      // undefined on disposal, and its identity getters throw once disposed.
      return document.live && !contents.isDestroyed() &&
        this.#webContents.fromFrame(frame) === contents && contents.mainFrame === frame &&
        frame.url === document.url && frame.processId === document.processId &&
        frame.routingId === document.routingId && frame.frameTreeNodeId === document.frameTreeNodeId;
    } catch (_) { return false; }
  }

  #detach(document) {
    for (const [event, listener] of document.listeners) document.contents.removeListener(event, listener);
    if (this.#documents.get(document.frame) === document) this.#documents.delete(document.frame);
  }

  #drop(key) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    entry.document.keys.delete(key);
    if (!entry.document.keys.size) this.#detach(entry.document);
  }

  #retire(document) {
    document.live = false;
    for (const key of document.keys) this.#drop(key);
  }

  #prune(now) {
    for (const [key, entry] of this.#entries)
      if (entry.expires <= now || !this.#live(entry.document)) this.#drop(key);
  }

  #watch(frame) {
    let document = this.#documents.get(frame);
    if (document && this.#live(document)) return document;
    if (document) this.#retire(document);
    try {
      const contents = this.#webContents.fromFrame(frame);
      const url = new URL(frame.url);
      if (url.protocol !== 'file:' || url.hostname || !Number.isInteger(frame.processId) ||
          !Number.isInteger(frame.routingId) || !Number.isInteger(frame.frameTreeNodeId)) throw invalid();
      document = { frame, contents, url: frame.url, processId: frame.processId, routingId: frame.routingId,
        frameTreeNodeId: frame.frameTreeNodeId, live: true, keys: new Set(), listeners: [] };
      if (!this.#live(document)) throw invalid();
    } catch (_) { throw invalid(); }
    const retire = () => this.#retire(document);
    document.listeners = [
      ['destroyed', retire],
      ['render-process-gone', retire],
      ['did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) retire(); }],
      // A commit also catches navigation which was already pending at issue().
      ['did-navigate', retire],
      ['render-frame-deleted', (_event, processId, routingId) => {
        if (processId === document.processId && routingId === document.routingId) retire();
      }]
    ];
    for (const [event, listener] of document.listeners) document.contents.on(event, listener);
    this.#documents.set(frame, document);
    return document;
  }

  #digest(value) {
    return createHmac('sha256', this.#secret).update(JSON.stringify(value.values)).digest('hex');
  }

  issue(frame, issuer, params) {
    const value = binding(issuer, params);
    const now = this.#now();
    this.#prune(now);
    const key = this.#digest(value);
    this.#drop(key);
    while (this.#entries.size >= MAX_ENTRIES) this.#drop(this.#entries.keys().next().value);
    const document = this.#watch(frame);
    document.keys.add(key);
    this.#entries.set(key, { document, origin: value.origin, expires: now + LIFETIME_MS });
  }

  take(issuer, params) {
    this.#prune(this.#now());
    let value;
    try { value = binding(issuer, params); } catch (_) { return null; }
    const key = this.#digest(value);
    const entry = this.#entries.get(key);
    if (!entry) return null;
    this.#drop(key);
    return entry.origin;
  }

  clear() {
    for (const key of this.#entries.keys()) this.#drop(key);
    this.#secret.fill(0);
    this.#secret = randomBytes(32);
  }
}

module.exports = { IssuedMeetingSites };
