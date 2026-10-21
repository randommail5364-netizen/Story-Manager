// Checks how the memory keeper's answers are split up and applied to entries.
//
//   node test/entries.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'story-manager.user.js'), 'utf8');

// Pull single functions / constants out of the userscript by name.
function grab(name) {
  const start = src.indexOf('  function ' + name + '(');
  assert(start >= 0, 'missing ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
const consts = src.match(/ {2}const MEM_BLOCK_RE = .*\n/)[0];
const lib = new Function(consts + ['cleanOutput', 'dedupeEntries', 'parseKeeperAnswer', 'cloneEntries', 'findEntry', 'applyUpdates']
  .map(grab).join('\n') + '\nreturn { parseKeeperAnswer, applyUpdates, cloneEntries };')();

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }

const replies = [{ id: 'a' }, { id: 'b' }];
const answer = [
  '=== STORY ===',
  '## Current Scene',
  '- Mira and Ash by the river.',
  '=== ENTRY: Mira | character | aliases: Miri, the healer ===',
  '- A healer.',
  '=== ENTRY:Old Mill|place|aliases: the mill ===',
  '- Abandoned.',
  '=== LOG ===',
  '[R1] First reply.',
  '[R2, entry about 300 characters] Second reply.',
].join('\n');

test('answer split into story, entries and log', () => {
  const p = lib.parseKeeperAnswer(answer, replies);
  assert.strictEqual(p.memory, '## Current Scene\n- Mira and Ash by the river.');
  assert.deepStrictEqual(p.updates.map((u) => [u.name, u.kind, u.aliases.join('/'), u.text]),
    [['Mira', 'character', 'Miri/the healer', '- A healer.'], ['Old Mill', 'place', 'the mill', '- Abandoned.']]);
  assert.deepStrictEqual(p.entries.map((e) => [e.id, e.text]), [['a', 'First reply.'], ['b', 'Second reply.']]);
});

test('older answers without headers still give a story', () => {
  const p = lib.parseKeeperAnswer('## Characters\n- Mira', replies);
  assert.strictEqual(p.memory, '## Characters\n- Mira');
  assert.strictEqual(p.updates.length, 0);
});

const long = '- ' + 'Mira has many well documented traits. '.repeat(30);
const base = () => [
  { name: 'Mira', kind: 'character', aliases: ['Miri'], text: long, always: false },
  { name: 'Ash', kind: 'character', aliases: [], text: '- A dragon.', always: true },
];

test('only changed entries are touched; untouched ones stay as they were', () => {
  const { entries } = lib.applyUpdates(base(), [{ name: 'Ash', kind: 'character', aliases: ['the dragon'], text: '- A dragon with a hurt wing.' }]);
  assert.strictEqual(entries[0].text, long);
  assert.strictEqual(entries[1].text, '- A dragon with a hurt wing.');
  assert.deepStrictEqual(entries[1].aliases, ['the dragon']);
  assert.strictEqual(entries[1].always, true);
});

test('an update under a nickname goes to the existing entry', () => {
  const { entries } = lib.applyUpdates(base(), [{ name: 'Miri', kind: '', aliases: [], text: long + '\n- Now afraid of fire.' }]);
  assert.strictEqual(entries.length, 2);
  assert.ok(entries[0].text.endsWith('afraid of fire.'));
  assert.strictEqual(entries[0].name, 'Mira');
});

test('a much shorter rewrite of a long entry is refused', () => {
  const { entries, refused } = lib.applyUpdates(base(), [{ name: 'Mira', kind: 'character', aliases: ['Mira the Healer'], text: '- A healer.' }]);
  assert.deepStrictEqual(refused, ['Mira']);
  assert.strictEqual(entries[0].text, long);
  assert.ok(entries[0].aliases.includes('Mira the Healer'));
});

test('new names become new entries', () => {
  const { entries } = lib.applyUpdates(base(), [{ name: 'Old Mill', kind: 'place', aliases: ['the mill'], text: '- Abandoned.' }]);
  assert.deepStrictEqual(entries.map((e) => e.name), ['Mira', 'Ash', 'Old Mill']);
  assert.strictEqual(entries[2].kind, 'place');
});

test('cloning entries does not share alias lists', () => {
  const a = base();
  const b = lib.cloneEntries(a);
  b[0].aliases.push('x');
  assert.deepStrictEqual(a[0].aliases, ['Miri']);
});

test('the cast list is read, without generic names', () => {
  const p = lib.parseKeeperAnswer('=== STORY ===\n- x\n=== CAST ===\nKarina, Winter (Kim Minjeong), - Giselle\nNingning, You, Narrator\n=== LOG ===\n', replies);
  assert.deepStrictEqual(p.cast, ['Karina', 'Winter', 'Giselle', 'Ningning']);
});

test('entries the user deleted are not created again', () => {
  const { entries } = lib.applyUpdates(base(), [
    { name: 'Silk Scarf', kind: 'item', aliases: [], text: '- A scarf.' },
    { name: 'The Scarf', kind: 'item', aliases: ['silk scarf'], text: '- A scarf.' },
    { name: 'Winter', kind: 'character', aliases: [], text: '- Singer.' },
  ], ['silk scarf']);
  assert.deepStrictEqual(entries.map((e) => e.name), ['Mira', 'Ash', 'Winter']);
});

test('log labels without brackets or in markdown are understood', () => {
  const four = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const p = lib.parseKeeperAnswer('**=== LOG ===**\nR1 At a private rooftop pool, Ningning posed.\n**R2:** Second.\n- [R3, entry about 300 characters] Third.\nR4. Fourth, mentioning R2D2 inside.', four);
  assert.deepStrictEqual(p.entries.map((e) => [e.id, e.text]),
    [['a', 'At a private rooftop pool, Ningning posed.'], ['b', 'Second.'], ['c', 'Third.'], ['d', 'Fourth, mentioning R2D2 inside.']]);
});

test('"aliases: none" adds no alias', () => {
  const p = lib.parseKeeperAnswer('=== ENTRY: Romantic Date Setting | place | aliases: none ===\n- Private.', replies);
  assert.deepStrictEqual(p.updates[0].aliases, []);
});

console.log('All ' + passed + ' entry checks passed.');
