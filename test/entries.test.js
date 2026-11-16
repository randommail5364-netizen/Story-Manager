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
const consts = '  const versionsSeen = {};\n' + src.match(/ {2}const MEM_BLOCK_RE = .*\n/)[0] + src.match(/ {2}const SECTION_ORDER = .*\n/)[0] + src.match(/ {2}const KIND_ORDER = .*\n/)[0] + src.match(/ {2}const REASONING_RE = .*\n/)[0] + src.match(/ {2}const REASONING_WORDS_RE = .*\n/)[0] + src.match(/ {2}const ASIDE_RE = .*\n/)[0] + src.match(/ {2}const GUESS_RE = .*\n/)[0] + src.match(/ {2}const STATE_RE = .*\n/)[0] + src.match(/ {2}const TITLE_RE = .*\n/)[0] + src.match(/ {2}const JUNK_RE = .*\n/)[0] + src.match(/ {2}const unquoted = .*\n/)[0] + src.match(/ {2}const isJunk = .*\n/)[0] + src.match(/ {2}const PLACE_WORDS = .*\n/)[0] + src.match(/ {2}const ITEM_WORDS = .*\n/)[0] + src.match(/ {2}const GROUP_WORDS = .*\n/)[0] + src.match(/ {2}const PERSON_RE = .*\n/)[0] + src.match(/ {2}const factKey = .*\n/)[0] + '  const mentions = (t, k) => String(t).toLowerCase().includes(String(k).toLowerCase());\n  const sectionOf = (t, title) => { const m = String(t).match(new RegExp(\'## \' + title + \'\\\\n([\\\\s\\\\S]*?)(?=\\\\n## |$)\')); return m ? m[1] : \'\'; };\n';
const lib = new Function(consts + ['latestVersions', 'composeMemory', 'entryKeys', 'organize', 'squashRepeats', 'cleanOutput', 'dedupeEntries', 'parseKeeperAnswer', 'applySections', 'cloneEntries', 'findEntry', 'applyUpdates', 'dropReasoning', 'latestState', 'sameButTitle', 'markStale', 'logJob', 'reconcile', 'dropJunk', 'structuredOnly', 'splitStates', 'guessKind', 'placeStates', 'cleanChat', 'recoverFacts']
  .map(grab).join('\n') + '\nreturn { latestVersions, composeMemory, organize, squashRepeats, parseKeeperAnswer, applySections, applyUpdates, cloneEntries, dropReasoning, latestState, reconcile, dropJunk, structuredOnly, splitStates, guessKind, cleanChat, recoverFacts };')();

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
    { id: 'b', text: 'They slept.', nofacts: 'none' },
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

test('regenerated versions of a message: only the newest is kept', () => {
  const m = (id, index, version, t) => ({ id, index, version, t, role: 'assistant', text: id });
  const out = lib.latestVersions([m('u1', 0, 0, 1), m('a1', 1, 0, 2), m('a1b', 1, 1, 3), m('a1c', 1, 2, 4), m('u2', 2, 0, 5), m('x', null, 0, 6)]);
  assert.deepStrictEqual(out.map((x) => x.id), ['u1', 'a1c', 'u2', 'x']);
});

test('messages that only share a number (it can start again) are all kept', () => {
  const m = (id, index, version, t, role) => ({ id, index, version, t, role, text: id });
  const out = lib.latestVersions([m('u1', 0, 0, 1, 'user'), m('a1', 1, 0, 2, 'assistant'), m('u2', 0, 0, 3, 'user'), m('a2', 1, 0, 4, 'assistant'), m('a2b', 1, 1, 5, 'assistant')]);
  assert.deepStrictEqual(out.map((x) => x.id), ['u1', 'a1', 'u2', 'a2b']);
});

test('the bot\'s own thinking is kept out of entries', () => {
  const t = 'Looking at the example in the initial knowledge base: they updated Karina\'s condition with an "add" and changed it from "trembling" to "sore". But they didn\'t rewrite the entire entry.\nThey used "add" for the new condition.\nSo I think we can do:\n- Whereabouts: Winter\'s bedroom\n- Mood: I think she is calm (Winter said so)';
  assert.strictEqual(lib.dropReasoning(t), '- Whereabouts: Winter\'s bedroom\n- Mood: I think she is calm (Winter said so)');
  const r = lib.applyUpdates([{ name: 'Winter', kind: 'character', aliases: [], text: '- Age 24' }], [{ name: 'Winter', aliases: [], add: true, text: t }], []);
  assert.strictEqual(r.entries[0].text, '- Age 24\n- Whereabouts: Winter\'s bedroom\n- Mood: I think she is calm (Winter said so)');
});

test('short entries in play go in whole; long ones share what is left', () => {
  const plan = { prefix: '', suffix: '', head: '', budget: 20000, log: [], extra: [],
    core: [{ name: 'A', text: 'a'.repeat(500) }, { name: 'B', text: 'b'.repeat(800) }, { name: 'Big', text: Array(40).fill('- ' + 'x'.repeat(498)).join('\n') }] };
  const out = lib.composeMemory(plan, '').text;
  assert(out.includes('a'.repeat(500)) && out.includes('b'.repeat(800)));
  const big = out.slice(out.indexOf('### Big'));
  assert(big.length > 12000 && big.length < 15500 && big.includes('[…]'), 'long entry gets the rest: ' + big.length);
});

test('a summary without a FACTS line is marked missing, "FACTS: none" is marked none', () => {
  const p = lib.parseKeeperAnswer('=== LOG ===\n[R1] Jacek kissed Karina.\n[R2] They slept.\nFACTS: none', replies);
  assert.deepStrictEqual(p.entries.map((e) => e.nofacts), ['missing', 'none']);
});

test('the keeper\'s notes from the real pinned message are removed', () => {
  const t = [
    '- Current State: Last seen at the boardroom meeting, exiting with a swagger. (But note the timeline: the board meeting is after the rooftop reconciliation. We\'ll leave as last known.)',
    'But note: we don\'t have her appearance, personality, etc. So we only include the headings we have information for.',
    'We have already processed the new events in the previous update (Request 4666b241) and updated the STORY and entries accordingly.',
    'So we output only the new entry for Ms. Choi.',
    '- Head of PR at the agency.',
  ].join('\n');
  assert.strictEqual(lib.dropReasoning(t), '- Current State: Last seen at the boardroom meeting, exiting with a swagger.\n- Head of PR at the agency.');
  assert.strictEqual(lib.dropReasoning('- Current State: In the rooftop pool with Ningning. Wearing swimwear (assumed).'), '- Current State: In the rooftop pool with Ningning.');
});

test('only the newest Current State line is kept', () => {
  const r = lib.applyUpdates([{ name: 'Jacek', kind: 'character', aliases: [], text: '- Age 29\n- Current State: In the pool.\n- Loves coffee' }],
    [{ name: 'Jacek', aliases: [], add: true, text: '- Current State: At the garage, fixing the car.\n- Bought a new watch' }], []);
  assert.strictEqual(r.entries[0].text, '- Age 29\n- Loves coffee\n- Current State: At the garage, fixing the car.\n- Bought a new watch');
});

test('"Choi" and "Ms. Choi" become one entry, "Mr. Kim" and "Ms. Kim" stay apart', () => {
  const chat = { entries: [
    { name: 'Choi', kind: 'character', aliases: [], text: '- Manager' },
    { name: 'Ms. Choi', kind: 'character', aliases: [], text: '- Manager\n- Wears glasses' },
    { name: 'Mr. Kim', kind: 'character', aliases: [], text: '- Driver' },
    { name: 'Ms. Kim', kind: 'character', aliases: [], text: '- Stylist' },
  ], ignored: [], log: [], chapters: [], memory: '' };
  lib.organize(chat);
  assert.deepStrictEqual(chat.entries.map((e) => e.name).sort(), ['Choi', 'Mr. Kim', 'Ms. Kim']);
  const choi = chat.entries.find((e) => e.name === 'Choi');
  assert(choi.aliases.includes('Ms. Choi') && /Wears glasses/.test(choi.text));
});

test('comparing with the whole chat removes vanished replies, but not when the read looks incomplete', () => {
  const mk = () => ({ log: Array.from({ length: 30 }, (_, i) => ({ id: 'r' + i, text: 'S' + i, folded: true })), chapters: [], processedIds: [], jobs: [] });
  const msgs = (ids) => ids.map((id) => ({ id, role: 'assistant' }));
  const a = mk();
  assert.strictEqual(lib.reconcile(a, msgs(a.log.map((e) => e.id).filter((x) => x !== 'r5' && x !== 'r9'))), 2);
  assert(!a.log.some((e) => e.id === 'r5') && a.stale.length === 2 && a.knownReplies === 28);
  const b = mk();
  assert.strictEqual(lib.reconcile(b, msgs(b.log.slice(0, 10).map((e) => e.id))), -1);
  assert.strictEqual(b.log.length, 30);
  const c = Object.assign(mk(), { continuedFrom: 'old' });
  assert.strictEqual(lib.reconcile(c, msgs(c.log.slice(20).map((e) => e.id))), 0);
  assert.strictEqual(c.log.filter((e) => e.inherited).length, 20);
});

// Real lines from the user's pinned memory messages (keeper working-out that
// got into entries). These must never come back.
test('regression: the keeper\'s working-out from real memories is dropped, real facts are kept', () => {
  const entry = [
    '### Basics',
    '- Head of PR at SM.',
    'She delivered the official statement.',
    'F9: Jacek\'s full name is Jacek Kowalski | Park Ji-won is SM\'s PR head',
    'Jacek\'s full name, billionaire status, SM ownership: in Jacek\'s entry.',
    'Park Ji-won: already has an entry and her role is stated.',
    'Ducati: mentioned in Giselle\'s entry (she polished the keys) but not in Jacek\'s. We can add to Jacek\'s entry.',
    'Holiday: already in the timeline? The duration (1 month) is not specified in the timeline. We should add it to the timeline?',
    'F24: None -> skip.',
    'Implementation:',
    'However, the response has a token limit. We must be concise.',
    '### Key Moments',
    '- Called Winter "our deepest water." and asked "Trouble already?"',
    'Similarly, for others.',
    'For brevity, we\'ll omit headings with nothing known.',
    '- Packed hiking boots for Costa Rica.',
  ].join('\n');
  assert.strictEqual(lib.structuredOnly(entry), '### Basics\n- Head of PR at SM.\nShe delivered the official statement.\n### Key Moments\n- Called Winter "our deepest water." and asked "Trouble already?"\n- Packed hiking boots for Costa Rica.');
  // Open Threads may ask questions; they stay.
  assert.strictEqual(lib.dropJunk('## Open Threads\n- Will Karina forgive him?'), '## Open Threads\n- Will Karina forgive him?');
});

test('one "now": Current State goes from entries to the Current Scene', () => {
  const sp = lib.splitStates('### Basics\n- Manager\n### Current State\n- Loading bay alcove.\n### Key Moments\n- Bought SM\nCurrent State: In the van.');
  assert.strictEqual(sp.text, '### Basics\n- Manager\n### Key Moments\n- Bought SM');
  assert.deepStrictEqual(sp.states, ['Loading bay alcove.', 'In the van.']);
  const p = lib.parseKeeperAnswer('=== ENTRY: Jacek | add ===\n- Key Moments: Fixed the car.\n- Current State: In the garage.', []);
  assert.strictEqual(p.updates[0].text, '- Key Moments: Fixed the car.');
  assert.deepStrictEqual(p.updates[0].states, ['In the garage.']);
  const chat = { memory: '## Current Scene\n- Winter\'s bedroom, dawn.', entries: [{ name: 'Jacek', kind: 'character', aliases: [], text: '- Manager\n### Current State\n- In the van.' }], chapters: [], log: [] };
  lib.cleanChat(chat);
  assert.strictEqual(chat.entries[0].text, '- Manager');
  assert(/## Current Scene[\s\S]*- Jacek: last known — In the van\./.test(chat.memory));
  lib.cleanChat(chat);
  assert.strictEqual((chat.memory.match(/Jacek/g) || []).length, 1, 'cleaning twice changes nothing');
});

test('objects and places are not filed as characters', () => {
  assert.strictEqual(lib.guessKind('"Mango" Sloth Plushie'), 'item');
  assert.strictEqual(lib.guessKind('Green Jungle Hammock'), 'item');
  assert.strictEqual(lib.guessKind('Chanel Métiers d\'Art Jacket'), 'item');
  assert.strictEqual(lib.guessKind('Villa Casa de la Sombra Verde'), 'place');
  assert.strictEqual(lib.guessKind('Karina', ['Karina']), 'character');
  const p = lib.parseKeeperAnswer('=== CAST ===\nJinho\n=== ENTRY: Jinho | add ===\n- Driver.\n=== ENTRY: Green Jungle Hammock | add ===\n- Strung between palms.', []);
  const r = lib.applyUpdates([], p.updates, []);
  assert.deepStrictEqual(r.entries.map((e) => e.kind), ['character', 'item']);
  const chat = { memory: '', entries: [{ name: 'Green Jungle Hammock', kind: 'character', aliases: [], text: '- Strung between palms.' }], chapters: [], log: [] };
  lib.cleanChat(chat);
  assert.strictEqual(chat.entries[0].kind, 'item');
});

// Real entry layout that v3.14 damaged: later facts were added below an old
// "Current State" heading, and the cleaning removed them all.
test('regression: facts added below an old Current State heading are kept', () => {
  const winter = [
    '### Basics', 'Full name: Kim Minjeong. Role: aespa member.',
    '### Key Moments', 'Spanked by Jacek in the penthouse.',
    '### Current State', 'Loading bay alcove, stroking Yujin\'s hair.',
    'Key Moments:', 'Took Winter on a date to a bookstore and the Han River.',
    'Appearance: Platinum anklet ("My Quiet").',
    'Goals, Promises & Secrets: Secured Jacek\'s commitment to exclusive "stillness" moments.',
    'Personality & Voice: Packing style is sentimental (Han River snow globe).',
  ].join('\n');
  const sp = lib.splitStates(winter);
  assert.deepStrictEqual(sp.states, ['Loading bay alcove, stroking Yujin\'s hair.']);
  assert(/bookstore/.test(sp.text) && /Platinum anklet/.test(sp.text) && /stillness/.test(sp.text) && /snow globe/.test(sp.text));
  const chat = { memory: '## Current Scene\n- Winter in her bedroom.', entries: [{ name: 'Winter', kind: 'character', aliases: [], text: winter }], chapters: [], log: [] };
  lib.cleanChat(chat);
  assert(/bookstore/.test(chat.entries[0].text) && /stillness/.test(chat.entries[0].text) && !/Loading bay/.test(chat.entries[0].text));
});

test('regression: Park Ji-won is a person, and her entry\'s working-out goes', () => {
  assert.notStrictEqual(lib.guessKind('Park Ji-won'), 'place');
  assert.strictEqual(lib.guessKind('Central Park'), 'place');
  const park = ['She delivered the official statement.', '"Ours" creed: in the group dynamic, recorded in entries.', 'In villa entry.', 'In the key moments of the members.',
    'Ningning: chaotic', 'Winter: sentimental', 'Park Ji-won\'s entry: add the official narrative.', 'Karina\'s entry: add phone shutdown during takeoff and packing style.',
    'Personality & Voice: Add bullet for packing style.', 'We update:', '- Head of PR at SM.'].join('\n');
  const chat = { memory: '', entries: [{ name: 'Park Ji-won', kind: 'place', aliases: [], text: park }], chapters: [], log: [] };
  lib.cleanChat(chat);
  assert.strictEqual(chat.entries[0].kind, 'character');
  // Real facts in the wrong entry are not deleted (they are moved by consolidation).
  assert.strictEqual(chat.entries[0].text, 'She delivered the official statement.\nNingning: chaotic\nWinter: sentimental\n- Head of PR at SM.');
});

test('recovering lost facts from an earlier version adds back only what is missing', () => {
  const oldWinter = ['### Basics', 'Full name: Kim Minjeong. Role: aespa member.', '### Current State', 'Loading bay alcove.', 'Key Moments:',
    'Took Winter on a date to a bookstore and the Han River.', 'Appearance: Platinum anklet ("My Quiet").', 'We can add this to her entry.',
    'Goals, Promises & Secrets: Secured Jacek\'s commitment to exclusive "stillness" moments.'].join('\n');
  const old = { entries: [{ name: 'Winter', kind: 'character', aliases: [], text: oldWinter }, { name: 'Gone Person', kind: 'character', aliases: [], text: '- Was a driver for the group.' }, { name: 'Deleted', kind: 'item', aliases: [], text: '- A thing the user deleted on purpose.' }] };
  const chat = { ignored: ['deleted'], entries: [{ name: 'Winter', kind: 'character', aliases: [], text: '### Basics\nFull name: Kim Minjeong. Role: aespa member.\n### Appearance\n- Platinum anklet ("My Quiet").' }] };
  const report = lib.recoverFacts(chat, old);
  const w = chat.entries[0].text;
  assert(/### Recovered facts\nTook Winter on a date to a bookstore and the Han River\.\nGoals, Promises & Secrets: Secured/.test(w), w);
  assert(!/Loading bay|We can add/.test(w) && (w.match(/Platinum anklet/g) || []).length === 1 && (w.match(/Kim Minjeong/g) || []).length === 1);
  assert.deepStrictEqual(report.map((r) => [r.name, r.count, !!r.added]), [['Winter', 2, false], ['Gone Person', 1, true]]);
  assert(!chat.entries.some((e) => e.name === 'Deleted'));
  assert.strictEqual(lib.recoverFacts(chat, old).length, 0, 'recovering twice adds nothing more');
});

console.log('All ' + passed + ' entry checks passed.');
