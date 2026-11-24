#!/usr/bin/env node
'use strict';

// Synthetic UID translation over real descriptors/files. Actual Chromium/APM
// namespace and seccomp acceptance remains a separate real-client check.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const filename = path.join(__dirname, 'meeting_sdk_log.js');
const source = fs.readFileSync(filename, 'utf8');
const actualRequire = createRequire(filename);
const catalogue = require('./meeting_sdk_log_catalog');
const actualUid = process.geteuid();
let passed = 0;

function scenario(change, allowed) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-sdk-namespace-'));
  const hostRoot = path.join(temporary, 'host-root');
  const home = path.join(hostRoot, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(hostRoot, 0o755);
  const directory = path.join(home, 'conference/HwmSdk');
  const info = fs.statSync(hostRoot, { bigint: true });
  const fact = { path: hostRoot, dev: String(info.dev), ino: String(info.ino),
    mode: Number(info.mode & 0o7777n), ctimeNs: String(info.ctimeNs) };
  const state = { facts: [fact], uidMap: '1000 1000 1\n', enabled: true, writable: false, symlink: false };
  if (change) change(state, fact);
  if (state.writable) {
    fs.chmodSync(hostRoot, 0o777);
    const current = fs.statSync(hostRoot, { bigint: true });
    fact.mode = 0o777;
    fact.ctimeNs = String(current.ctimeNs);
  }
  const outside = path.join(temporary, 'outside');
  if (state.symlink) {
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(home, 'conference'));
  }
  function translated(stat, actualPath) {
    const bigint = typeof stat.uid === 'bigint';
    let uid = Number(stat.uid);
    if (actualPath === hostRoot) uid = 65534;
    else if (uid === actualUid && actualPath !== '/' && actualPath !== os.tmpdir()) uid = 1000;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: bigint ? BigInt(uid) : uid });
  }
  const files = Object.assign({}, fs, {
    fstatSync(fd, options) { return translated(fs.fstatSync(fd, options), fs.readlinkSync(`/proc/self/fd/${fd}`)); },
    lstatSync(value, options) {
      const stat = fs.lstatSync(value, options);
      return translated(stat, fs.realpathSync(value));
    },
    readFileSync(value, options) {
      if (value === '/proc/self/uid_map') return state.uidMap;
      if (value === '/proc/sys/kernel/overflowuid') return '65534\n';
      return fs.readFileSync(value, options);
    }
  });
  const environment = { HOME: home, IS_ACE_ENV: '1', APM_PKG_NAME: 'cn.edu.hit.welink.native.apm',
    WELINK_NATIVE_APM_PACKAGE: state.enabled ? 'cn.edu.hit.welink.native.apm' : '',
    WELINK_NATIVE_APM_SUPERVISOR_PID: String(process.pid),
    WELINK_NATIVE_APM_HOST_ROOT_DIRS: JSON.stringify(state.facts) };
  const module = { exports: {} };
  const context = { module, exports: module.exports, Buffer, console,
    process: { platform: 'linux', geteuid: () => 1000, env: environment },
    require: name => name === 'fs' ? files : actualRequire(name) };
  vm.runInNewContext(source, context, { filename });
  const log = new module.exports.SdkMediaLog();
  try {
    const configured = log.configure(directory);
    assert.strictEqual(configured.ok, allowed, JSON.stringify(configured));
    if (allowed) {
      const receipt = log.write({ catalog: catalogue.version, batch: 1, events: [1] });
      assert.strictEqual(receipt.ok, true, JSON.stringify(receipt));
      assert.strictEqual(receipt.accepted, 1);
      assert(fs.readFileSync(path.join(directory, 'hrtc.log'), 'utf8').includes('[event:1]'));
      assert.strictEqual(fs.statSync(path.join(directory, 'hrtc.log')).mode & 0o7777, 0o600);
    } else {
      assert(!fs.existsSync(path.join(directory, 'hrtc.log')));
      assert(!fs.existsSync(path.join(outside, 'HwmSdk/hrtc.log')));
    }
    passed += 1;
  } finally {
    log.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

scenario(null, true);
scenario(state => { state.facts = []; }, false);
scenario((_state, fact) => { fact.ino = String(BigInt(fact.ino) + 1n); }, false);
scenario((_state, fact) => { fact.ctimeNs = String(BigInt(fact.ctimeNs) + 1n); }, false);
scenario((_state, fact) => { fact.path = '/unrelated'; }, false);
scenario(state => { state.enabled = false; }, false);
scenario(state => { state.uidMap = '0 0 4294967295\n'; }, false);
scenario(state => { state.writable = true; }, false);
scenario(state => { state.symlink = true; }, false);
console.log(JSON.stringify({ passed, boundary: 'Real logger operations under synthetic UID mapping; no live APM/browser claim.' }));
