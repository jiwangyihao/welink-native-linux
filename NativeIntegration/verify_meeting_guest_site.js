#!/usr/bin/env node
'use strict';
// Pure offline registry checks. Electron's lifecycle surface is synthetic; no
// network, browser, meeting provider or real invitation is used.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const modulePath = process.argv[2] ? path.join(path.resolve(process.argv[2]), 'native/meeting_guest_site.js') :
  path.join(__dirname, '../Conference/meeting_guest_site.js');
const { IssuedMeetingSites } = require(modulePath);
const authority = 'https://issuer.invalid';
const site = 'https://GUEST.invalid:8443/next/conferences?route=A%2FB&zone=1';
const params = { site_url: site, random: 'offline-fixture+ticket%2F==', idPrefix: '站点 + A%=2',
  confId: '1234567890', nick_name: 'isolated test', isOfflineJoin: false };
let now = 0;
const owners = new WeakMap();
const webContents = { fromFrame: frame => frame?.destroyed ? undefined : owners.get(frame) };
const registry = new IssuedMeetingSites({ webContents, now: () => now });
const checks = [];

function document() {
  const frame = { url: 'file:///synthetic/app/plugin/conference/dist/index.html', processId: 7,
    routingId: 11, frameTreeNodeId: 13, destroyed: false };
  const contents = new EventEmitter();
  contents.destroyed = false;
  contents.isDestroyed = () => contents.destroyed;
  contents.mainFrame = frame;
  owners.set(frame, contents);
  return { frame, contents };
}

function rejected(run) {
  assert.throws(run, error => error.code === 'ISSUED_SITE_UNAVAILABLE' && !error.message.includes(params.random));
}

let doc = document();
assert.equal(registry.take(authority, { ...params, trusted: true }), null);
assert.equal(registry.issue(doc.frame, authority, params), undefined);
assert.equal(registry.take(authority, params), 'https://guest.invalid:8443');
assert.equal(registry.take(authority, params), null);
assert.equal(doc.contents.eventNames().length, 0);
checks.push('issuer-bound HTTPS origin is returned once, without exposing a grant or ticket');

registry.issue(doc.frame, authority, params);
for (const changed of [
  { site_url: 'https://guest.invalid:8443/other' },
  { site_url: site + '&extra=1' },
  { site_url: site.replace('GUEST', 'foreign') },
  { random: params.random + 'x' },
  { idPrefix: params.idPrefix + 'x' },
  { confId: params.confId + 'x' },
  { isOfflineJoin: true }, { isOfflineJoin: 0 }, { isOfflineJoin: undefined }
]) assert.equal(registry.take(authority, { ...params, ...changed }), null);
assert.equal(registry.take('https://other-issuer.invalid', params), null);
assert.equal(registry.take('http://issuer.invalid', params), null);
assert.equal(registry.take(authority, params), 'https://guest.invalid:8443');
checks.push('foreign authority and altered full site, ticket, prefix, conference or online mode cannot consume the grant');

for (const issuer of ['http://issuer.invalid', 'https://user:pass@issuer.invalid', 'https://@issuer.invalid',
  'https://issuer.invalid/path', 'https://issuer.invalid/?q=1', 'https://issuer.invalid/#fragment',
  'https:///issuer.invalid', 'https://*.invalid', ' https://issuer.invalid', 'https://issuer.invalid\n'])
  rejected(() => registry.issue(doc.frame, issuer, params));
for (const site_url of [authority, 'http://guest.invalid', 'https://user:pass@guest.invalid', 'https://@guest.invalid',
  'https:///guest.invalid', 'https://guest.invalid/#fragment', 'https://*.invalid', 'https://guest.invalid\\path',
  'https://guest.invalid\n/path', '', null]) rejected(() => registry.issue(doc.frame, authority, { ...params, site_url }));
for (const changed of [{ random: '' }, { random: 1 }, { random: 'ticket\rhidden' },
  { random: 'a'.repeat(16385) }, { idPrefix: '' }, { idPrefix: ' ' }, { idPrefix: 'null' },
  { idPrefix: 'undefined' }, { idPrefix: 1 }, { idPrefix: 'x\n' }, { idPrefix: 'x'.repeat(2049) },
  { confId: '' }, { confId: null }, { confId: 'x'.repeat(257) }, { isOfflineJoin: true },
  { isOfflineJoin: 'false' }, { isOfflineJoin: undefined }])
  rejected(() => registry.issue(doc.frame, authority, { ...params, ...changed }));
for (const value of [null, [], true, 'trusted']) rejected(() => registry.issue(doc.frame, authority, value));
assert.equal(registry.take(authority, { ...params, trusted: true, issuedSite: 'https://guest.invalid:8443' }), null);
checks.push('malformed, credential-bearing, wildcard, same-origin and offline issue requests fail closed');

for (const retire of [
  ({ frame }) => { frame.destroyed = true; },
  ({ contents }) => { contents.destroyed = true; },
  ({ contents }) => { contents.mainFrame = {}; },
  ({ frame }) => { owners.delete(frame); },
  ({ frame }) => { frame.url = 'file:///synthetic/app/other.html'; },
  ({ frame }) => { frame.processId++; },
  ({ frame }) => { frame.routingId++; },
  ({ frame }) => { frame.frameTreeNodeId++; },
  ({ contents }) => { contents.emit('destroyed'); },
  ({ contents }) => { contents.emit('render-process-gone'); },
  ({ frame, contents }) => { contents.emit('did-start-navigation', {}, frame.url, false, true); },
  ({ frame, contents }) => { contents.emit('did-navigate', {}, frame.url, 200, 'OK'); },
  ({ frame, contents }) => { contents.emit('render-frame-deleted', {}, frame.processId, frame.routingId); }
]) {
  doc = document(); registry.issue(doc.frame, authority, params); retire(doc);
  assert.equal(registry.take(authority, params), null);
  assert.equal(doc.contents.eventNames().length, 0);
}
checks.push('destruction, process loss, same-URL navigation, document identity and ownership are rechecked');

doc = document();
registry.issue(doc.frame, authority, params);
doc.contents.emit('did-start-navigation', {}, 'file:///child.html', false, false);
doc.contents.emit('render-frame-deleted', {}, 999, 999);
assert.equal(registry.take(authority, params), 'https://guest.invalid:8443');
checks.push('unrelated subframe lifecycle does not revoke the issuing main document');

for (const change of [({ frame }) => { frame.destroyed = true; },
  ({ frame }) => { frame.url = 'https://guest.invalid/'; },
  ({ contents }) => { contents.mainFrame = {}; }]) {
  doc = document(); change(doc); rejected(() => registry.issue(doc.frame, authority, params));
  assert.equal(doc.contents.eventNames().length, 0);
}
rejected(() => registry.issue(null, authority, params));
checks.push('a dead, foreign or replaced issuing document cannot issue');

doc = document(); now = 0;
registry.issue(doc.frame, authority, params);
now = 60000;
assert.equal(registry.take(authority, params), null);
assert.equal(doc.contents.eventNames().length, 0);
registry.issue(doc.frame, authority, params);
registry.clear();
assert.equal(registry.take(authority, params), null);
assert.equal(doc.contents.eventNames().length, 0);
checks.push('one-minute expiry and owner retirement clear both grants and lifecycle listeners');

for (let i = 0; i < 33; i++) registry.issue(doc.frame, authority, { ...params, random: params.random + i });
assert.equal(registry.take(authority, { ...params, random: params.random + 0 }), null);
for (let i = 1; i < 33; i++)
  assert.equal(registry.take(authority, { ...params, random: params.random + i }), 'https://guest.invalid:8443');
assert.equal(doc.contents.eventNames().length, 0);
registry.issue(doc.frame, authority, params);
registry.issue(doc.frame, authority, params);
assert.equal(registry.take(authority, params), 'https://guest.invalid:8443');
assert.equal(registry.take(authority, params), null);
assert.equal(doc.contents.eventNames().length, 0);
checks.push('bounded registry evicts oldest entries and duplicate attestation never multiplies a grant');
registry.clear();
console.log(JSON.stringify({ checks, liveMeetings: 0, networkRequests: 0 }));
