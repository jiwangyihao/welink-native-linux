'use strict';
// Temporary static integration planner. Never executes the vendor application.
const fs = require('fs');
const acorn = require(process.env.WELINK_QA_ACORN || 'acorn');
const source = fs.readFileSync(process.argv[2], 'utf8');
const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === 'start' || key === 'end') continue;
    if (Array.isArray(child)) child.forEach(item => walk(item, visit));
    else if (child && typeof child === 'object') walk(child, visit);
  }
}
const modules = [];
walk(tree, node => {
  if (node.type !== 'ArrayExpression' || !node.elements[70]) return;
  const candidate = node.elements[70];
  if (candidate.type === 'FunctionExpression' && source.slice(candidate.start, candidate.end).includes('createService')) modules.push(candidate);
});
if (modules.length !== 1) throw new Error(`Expected one conference module 70, got ${modules.length}`);
const nativeTree = acorn.parse(fs.readFileSync(process.argv[3], 'utf8'), { ecmaVersion: 'latest' });
const nativeMethods = new Set();
walk(nativeTree, node => { if (node.type === 'MethodDefinition') nativeMethods.add(node.key.name); });
const linux = 'window.require("os").platform()==="linux"';
const special = new Set(['initConf', 'usgLogin', 'usgLogout', 'getUsgToken']);
const methods = [], ops = [], missing = [];
walk(modules[0], node => {
  if (node.type !== 'ObjectExpression') return;
  const key = node.properties.find(p => p.key && p.key.name === 'key');
  const value = node.properties.find(p => p.key && p.key.name === 'value');
  if (!key || !value || value.value.type !== 'FunctionExpression' || !value.value.async) return;
  const name = key.value.value, fn = value.value, body = fn.body;
  if (typeof name !== 'string') return;
  const calls = new Set(), changes = [];
  walk(body, child => {
    if (child.type !== 'CallExpression' || child.callee.type !== 'MemberExpression') return;
    const object = child.callee.object, property = child.callee.property;
    const member = child.callee.computed ? property.value : property.name;
    if (object.type === 'Identifier' && object.name === 'ae') calls.add(member);
    if (object.type === 'ThisExpression' && member === 'initConf')
      changes.push({ start: child.start - body.start, end: child.end - body.start,
        text: `(${linux}?ae.initAuth():${source.slice(child.start, child.end)})` });
  });
  for (const method of calls) if (!nativeMethods.has(method)) missing.push({ facade: name, native: method });
  const old = source.slice(body.start, body.end);
  let out = old;
  if (special.has(name)) out = `{if(${linux})return ae.${name}(...arguments);${old.slice(1)}`;
  else for (const change of changes.sort((a, b) => b.start - a.start))
    out = out.slice(0, change.start) + change.text + out.slice(change.end);
  if (out !== old) ops.push({ pat: old, out });
  methods.push({ name, calls: [...calls], changed: out !== old });
});
for (const name of special) if (methods.filter(method => method.name === name).length !== 1)
  throw new Error(`Missing or ambiguous facade method ${name}`);
console.log(JSON.stringify({ methods, missing, ops }));
