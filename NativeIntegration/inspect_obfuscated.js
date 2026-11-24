'use strict';
// Read-only analysis: execute only the vendor's string-table setup, never its app.
const fs = require('fs');
const vm = require('vm');
const acorn = require(process.env.WELINK_QA_ACORN || 'acorn');
const source = fs.readFileSync(process.argv[2], 'utf8');
const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
const wanted = new RegExp(process.argv[3] || 'getDeviceInfo|getAllDeviceInfo|getEnvInfo|http_json_|HttpWithRs|userAgent', 'i');
const declarations = tree.body.filter(node => node.type === 'FunctionDeclaration');
const decoder = declarations.find(node => /_0x/.test(node.id.name) && source.slice(node.start, node.end).includes('-0x'));
if (!decoder) throw new Error('Simple string decoder not found');
const calls = [];
function each(node, ancestors, visit) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  visit(node, ancestors);
  const next = ancestors.concat(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc') continue;
    if (Array.isArray(value)) for (const item of value) each(item, next, visit);
    else if (value && typeof value === 'object') each(value, next, visit);
  }
}
let rotation = null;
each(tree, [], (node, ancestors) => {
  if (!rotation && node.type === 'CallExpression' && node.callee.type === 'FunctionExpression' &&
      node.arguments.length === 2 && node.arguments[0].type === 'Identifier' &&
      declarations.some(item => item.id.name === node.arguments[0].name) && node.arguments[1].type === 'Literal')
    rotation = node;
});
if (!rotation) throw new Error('String-table rotation not found');
const context = vm.createContext(Object.create(null));
const setup = declarations.map(node => source.slice(node.start, node.end)).join('\n') + '\n(' + source.slice(rotation.start, rotation.end) + ');';
vm.runInContext(setup, context, { timeout: 1000 });
const aliases = new Set([decoder.id.name]);
let changed;
do {
  changed = false;
  each(tree, [], node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init &&
        node.init.type === 'Identifier' && aliases.has(node.init.name) && !aliases.has(node.id.name)) {
      aliases.add(node.id.name); changed = true;
    }
  });
} while (changed);
each(tree, [], (node, ancestors) => {
  if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || !aliases.has(node.callee.name) ||
      !node.arguments.length || node.arguments[0].type !== 'Literal' || typeof node.arguments[0].value !== 'number') return;
  const value = context[decoder.id.name](node.arguments[0].value);
  if (typeof value !== 'string') return;
  calls.push({ start: node.start, end: node.end, value, ancestors });
});
const replacements = calls.slice().sort((a, b) => b.start - a.start);
function decoded(start, end) {
  let result = source.slice(start, end);
  for (const item of replacements) if (item.start >= start && item.end <= end)
    result = result.slice(0, item.start - start) + JSON.stringify(item.value) + result.slice(item.end - start);
  return result;
}
const selected = new Map();
for (const item of calls) {
  if (!wanted.test(item.value)) continue;
  const scope = item.ancestors.slice().reverse().find(node => /FunctionExpression|ArrowFunctionExpression|FunctionDeclaration/.test(node.type));
  const start = scope ? scope.start : Math.max(0, item.start - 200);
  const end = scope ? scope.end : Math.min(source.length, item.end + 200);
  const key = `${start}:${end}`;
  if (!selected.has(key)) selected.set(key, { start, end, labels: new Set() });
  selected.get(key).labels.add(item.value);
}
console.log(JSON.stringify({ decoder: decoder.id.name, aliases: aliases.size, decodedCalls: calls.length, scopes: selected.size }));
for (const item of selected.values()) {
  console.log(`\nSCOPE ${item.start}-${item.end} labels=${[...item.labels].join(',')}`);
  const text = decoded(item.start, item.end);
  for (let offset = 0; offset < text.length; offset += 150) console.log(text.slice(offset, offset + 150));
}
