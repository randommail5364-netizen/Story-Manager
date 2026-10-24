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
const consts = src.match(/ {2}const MEM_BLOCK_RE = .*\n/)[0] + src.match(/ {2}const SECTION_ORDER = .*\n/)[0] + src.match(/ {2}const KIND_ORDER = .*\n/)[0];
const lib = new Function(consts + ['composeMemory', 'entryKeys', 'organize', 'squashRepeats', 'cleanOutput', 'dedupeEntries', 'parseKeeperAnswer', 'applySections', 'cloneEntries', 'findEntry', 'applyUpdates']
  .map(grab).join('\n') + '\nreturn { composeMemory, organize, squashRepeats, parseKeeperAnswer, applySections, applyUpdates, cloneEntries };')();

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

test('only changed story sections are applied; added lines are not doubled', () => {
  const mem = '## Story So Far\n- A happened.\n- B happened.\n\n## Current Scene\n- At the hotel.\n\n## World & Timeline\n- Seoul.';
  const p = lib.parseKeeperAnswer('=== SECTION: Story So Far | add ===\n- B happened.\n- C happened.\n**=== SECTION: Current Scene ===**\n## Current Scene\n- In the car.\n=== SECTION: Open Threads ===\n- The secret.\n=== LOG ===\n[R1] x', replies);
  assert.strictEqual(p.memory, '');
  assert.strictEqual(lib.applySections(mem, p.sections),
    '## Story So Far\n- A happened.\n- B happened.\n- C happened.\n\n## Current Scene\n- In the car.\n\n## Open Threads\n- The secret.\n\n## World & Timeline\n- Seoul.');
});

test('looping text is squashed, normal text is not', () => {
  const loop = '- Jacek kissed her.\n' + 'She moaned his name again and again. '.repeat(500) + '\n- Winter laughed at the joke he made earlier.\n- Winter laughed at the joke he made earlier.';
  assert.strictEqual(lib.squashRepeats(loop), '- Jacek kissed her.\nShe moaned his name again and again. \n- Winter laughed at the joke he made earlier.');
  const normal = Array.from({ length: 50 }, (_, i) => '- Fact ' + i + ': Karina wore a ' + ['red', 'blue', 'black'][i % 3] + ' dress on day ' + i + '.').join('\n') +
    '\nHe said "no, no, no" and then left. She waited. She waited. Then the door opened slowly and Giselle walked in with the keys.';
  assert.strictEqual(lib.squashRepeats(normal), normal);
});

test('summaries keep their FACTS line separately', () => {
  const p = lib.parseKeeperAnswer('=== LOG ===\n[R1] Jacek kissed Karina on the balcony.\nFACTS: Karina calls him "Jace" | Winter knows their secret\n[R2] They slept.\nFACTS: none', replies);
  assert.deepStrictEqual(p.entries, [
    { id: 'a', text: 'Jacek kissed Karina on the balcony.', facts: 'Karina calls him "Jace" | Winter knows their secret' },
    { id: 'b', text: 'They slept.' },
  ]);
  const bullets = lib.parseKeeperAnswer('=== LOG ===\n**R1:** Something happened.\n**Facts:**\n- Giselle hurt her ankle\n- The party is on Friday', replies);
  assert.strictEqual(bullets.entries[0].facts, 'Giselle hurt her ankle | The party is on Friday');
  assert.strictEqual(bullets.entries[0].text, 'Something happened.');
});

test('organize merges twins, cleans aliases, drops deleted entries and sorts by kind', () => {
  const chat = {
    ignored: ['scarf'],
    chapters: [{ title: 'One', text: 'x', ids: ['a'] }],
    entries: [
      { name: 'Seoul Penthouse', kind: 'place', aliases: [], text: '- On the 40th floor.' },
      { name: 'Karina', kind: 'character', aliases: ['Yu Jimin', 'babe', 'Karina'], text: '- Leader of aespa.\n- Loves Jacek.' },
      { name: 'Winter', kind: 'character', aliases: ['babe'], text: '- Main vocalist.' },
      { name: 'Scarf', kind: 'item', aliases: [], text: '- Red.' },
      { name: 'Yu Jimin', kind: 'character', aliases: [], text: '- Leader of aespa.\n- Born in 2000.' },
    ],
    log: [{ id: 'a', text: 'short', folded: true, chapter: 0 }, { id: 'a', text: 'a longer summary', folded: true, chapter: 0 }, { id: 'b', text: 'b', chapter: 5 }],
  };
  const fixes = lib.organize(chat);
  assert.deepStrictEqual(chat.entries.map((e) => e.name), ['Karina', 'Winter', 'Seoul Penthouse']);
  assert.strictEqual(chat.entries[0].text, '- Leader of aespa.\n- Born in 2000.\n- Loves Jacek.', 'no fact lost');
  assert.deepStrictEqual(chat.entries[0].aliases, ['Yu Jimin', 'babe']);
  assert.deepStrictEqual(chat.entries[1].aliases, ['babe'], 'a shared nickname does not merge two characters');
  assert.deepStrictEqual(chat.log, [{ id: 'a', text: 'a longer summary', folded: true, chapter: 0 }, { id: 'b', text: 'b', folded: false }]);
  assert(fixes.some((f) => /merged Yu Jimin into Karina/.test(f)) && fixes.some((f) => /deleted entry Scarf/.test(f)));
  assert.deepStrictEqual(lib.organize(chat), [], 'nothing left to fix the second time');
});

test('"add" entry updates append only the new facts', () => {
  const entries = [{ name: 'Jacek', kind: 'character', aliases: ['Jace'], text: '- Stylist for aespa.\n- Dating Karina.', always: false }];
  const p = lib.parseKeeperAnswer('=== ENTRY: Jacek | add | aliases: Mr. Shadow ===\n- Dating Karina.\n- Owns a villa in Costa Rica.\n=== ENTRY: Sloth Sanctuary | add ===\n- Near Puerto Viejo.', replies);
  assert.deepStrictEqual(p.updates.map((u) => [u.name, !!u.add]), [['Jacek', true], ['Sloth Sanctuary', true]]);
  lib.applyUpdates(entries, p.updates, []);
  assert.strictEqual(entries[0].text, '- Stylist for aespa.\n- Dating Karina.\n- Owns a villa in Costa Rica.');
  assert.strictEqual(entries[0].kind, 'character');
  assert.deepStrictEqual(entries[0].aliases, ['Jace', 'Mr. Shadow']);
  assert.strictEqual(entries[1].name, 'Sloth Sanctuary');
  const big = [{ name: 'Karina', kind: 'character', aliases: [], text: '- fact\n'.repeat(200) }];
  const r = lib.applyUpdates(big, [{ name: 'Karina', kind: '', aliases: [], text: '- one new fact', add: true }], []);
  assert(r.refused.length === 0 && big[0].text.endsWith('- one new fact'), 'a short "add" is never refused as a shrink');
});

test('long entries in play are shortened so the attached memory keeps to its size, keeping the newest facts', () => {
  const big = (name) => ({ name, kind: 'character', keys: [name], text: Array.from({ length: 400 }, (_, i) => '- ' + name + ' fact ' + i + '.').join('\n') });
  const plan = { prefix: '[[STORY-MEMORY]]\n', suffix: '\n[[/STORY-MEMORY]]', head: '## The story now\n' + 'x'.repeat(3000),
    core: [big('Jacek'), big('Karina'), big('Winter')], extra: [], log: ['A summary.'], budget: 16000 };
  const out = lib.composeMemory(plan, 'Hello').text;
  assert(out.length < 16000, 'attached memory is ' + out.length + ' characters');
  for (const n of ['Jacek', 'Karina', 'Winter']) {
    assert(out.includes('- ' + n + ' fact 0.') && out.includes('- ' + n + ' fact 399.'), n + ': start and newest facts kept');
  }
  assert(/\[…\]/.test(out));
  const small = Object.assign({}, plan, { core: [{ name: 'Ash', kind: 'character', keys: ['Ash'], text: '- A dragon.' }] });
  assert(lib.composeMemory(small, '').text.includes('### Ash (character)\n- A dragon.'), 'short entries are sent whole');
});

console.log('All ' + passed + ' entry checks passed.');
