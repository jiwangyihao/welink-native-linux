'use strict';
// Temporary static inspection only: never executes the vendor application.
const fs = require('fs');
const acorn = require(process.env.WELINK_QA_ACORN || 'acorn');
const source = fs.readFileSync(process.argv[2], 'utf8');
const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
const listOnly = process.argv.includes('--list');
const stringsOnly = process.argv.includes('--strings');
const names = new Set(process.argv.slice(3).filter(value => !value.startsWith('--')));
const modules = [];
const found = [];
function callable(node) { return node && /^(FunctionExpression|ArrowFunctionExpression)$/.test(node.type); }
function literal(node) { return node && node.type === 'Literal' ? node.value : undefined; }
function each(node, parent, enter) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  enter(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc') continue;
    if (Array.isArray(value)) for (const item of value) each(item, node, enter);
    else if (value && typeof value === 'object') each(value, node, enter);
  }
}
if (stringsOnly) {
  const matches = new Map();
  each(tree, null, node => {
    if (node.type === 'Literal' && typeof node.value === 'string' &&
        /device|serial|user.?agent|getenvinfo|http_json|getSN|getUuid|uuid|HttpWithRs/i.test(node.value))
      matches.set(node.value, node.start);
  });
  console.log(JSON.stringify([...matches].map(([value, start]) => ({ value, start })), null, 2));
  process.exit(0);
}
each(tree, null, node => {
  if (node.type === 'ArrayExpression' && node.elements.length > 10 &&
      node.elements.filter(callable).length >= 5) {
    node.elements.forEach((fn, index) => { if (callable(fn)) modules.push({ index, start: fn.start, end: fn.end }); });
  }
  if (node.type === 'ObjectExpression') {
    for (const property of node.properties) {
      const key = property.key && (property.key.name || literal(property.key));
      if (callable(property.value) && /^\d+$/.test(String(key)))
        modules.push({ index: Number(key), start: property.value.start, end: property.value.end });
    }
  }
});
function add(name, fn, receiver) {
  if (!callable(fn) || (names.size && !names.has(name))) return;
  const module = modules.filter(item => item.start <= fn.start && item.end >= fn.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
  found.push({ name, module: module ? module.index : null, receiver, start: fn.start, end: fn.end });
}
each(tree, null, (node, parent) => {
  if (node.type === 'CallExpression' && node.arguments.length >= 3 && typeof literal(node.arguments[1]) === 'string')
    add(literal(node.arguments[1]), node.arguments[2], source.slice(node.arguments[0].start, node.arguments[0].end));
  if (node.type === 'ObjectExpression') {
    const key = node.properties.find(item => item.type === 'Property' && (item.key.name === 'key' || literal(item.key) === 'key'));
    const value = node.properties.find(item => item.type === 'Property' && (item.key.name === 'value' || literal(item.key) === 'value'));
    if (key && value && typeof literal(key.value) === 'string') add(literal(key.value), value.value, 'prototype');
  }
  if ((node.type === 'Property' || node.type === 'MethodDefinition') && callable(node.value))
    add(node.computed ? literal(node.key) : (node.key.name || literal(node.key)), node.value, 'object');
  if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression')
    add(node.left.computed ? literal(node.left.property) : node.left.property.name, node.right,
      source.slice(node.left.object.start, node.left.object.end));
});
const unique = [...new Map(found.map(item => [item.start, item])).values()].sort((a, b) => a.start - b.start);
console.log(JSON.stringify({ modules: modules.length, methods: unique.map(({ name, module, receiver, start, end }) => ({ name, module, receiver, start, end })) }, null, 2));
if (!listOnly) {
  for (const item of unique) {
    console.log(`\nMETHOD ${item.name} module=${item.module} receiver=${item.receiver} range=${item.start}-${item.end}`);
    const text = source.slice(item.start, item.end);
    for (let offset = 0; offset < text.length; offset += 150) console.log(text.slice(offset, offset + 150));
  }
}
