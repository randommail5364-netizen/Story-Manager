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
const consts = '  const versionsSeen = {};\n' + src.match(/ {2}const MEM_BLOCK_RE = .*\n/)[0] + src.match(/ {2}const SECTION_ORDER = .*\n/)[0] + src.match(/ {2}const KIND_ORDER = .*\n/)[0] + src.match(/ {2}const REASONING_RE = .*\n/)[0] + src.match(/ {2}const REASONING_WORDS_RE = .*\n/)[0] + src.match(/ {2}const ASIDE_RE = .*\n/)[0] + src.match(/ {2}const GUESS_RE = .*\n/)[0] + src.match(/ {2}const STATE_RE = .*\n/)[0] + src.match(/ {2}const TITLE_RE = .*\n/)[0] + src.match(/ {2}const JUNK_RE = .*\n/)[0] + src.match(/ {2}const unquoted = .*\n/)[0] + src.match(/ {2}const isJunk = .*\n/)[0] + src.match(/ {2}const PLACE_WORDS = .*\n/)[0] + src.match(/ {2}const ITEM_WORDS = .*\n/)[0] + src.match(/ {2}const GROUP_WORDS = .*\n/)[0] + src.match(/ {2}const PERSON_RE = .*\n/)[0] + src.match(/ {2}const SUMMARY_JUNK_RE = .*\n/)[0] + src.match(/ {2}const TEMPLATE_NAME_RE = .*\n/)[0] + src.match(/ {2}const TEMPLATE_ALIAS_RE = .*\n/)[0] + src.match(/ {2}const EMPTY_FACT_RE = .*\n/)[0] + src.match(/ {2}const GENERIC_ALIAS_RE = .*\n/)[0] + src.match(/ {2}const isGeneric = .*\n/)[0] + '  const mentions = (t, k) => String(t).toLowerCase().includes(String(k).toLowerCase());\n  const sectionOf = (t, title) => { const m = String(t).match(new RegExp(\'## \' + title + \'\\\\n([\\\\s\\\\S]*?)(?=\\\\n## |$)\')); return m ? m[1] : \'\'; };\n';
const block = (name) => { const a = src.indexOf('  const ' + name + ' = ['); return src.slice(a, src.indexOf('\n  ];\n', a) + 6); };
const factsConsts = block('RECORD_KINDS') + src.match(/ {2}const SINGLE_KINDS = .*\n/)[0] + src.match(/ {2}const MOMENT_LOOK_RE = .*\n/)[0] + src.match(/ {2}const NOT_ROLE_RE = .*\n/)[0] + src.match(/ {2}const PLACEHOLDER_SUBJECT_RE = .*\n/)[0] + src.match(/ {2}const normValue = .*\n/)[0] + src.match(/ {2}const MOMENTS_RECENT = .*\n/)[0] + src.match(/ {2}const RELATION_FACTS = .*\n/)[0] + src.match(/ {2}const MINOR_PINNED = .*\n/)[0] + src.match(/ {2}const ROUTINE_PINNED = .*\n/)[0] + src.match(/ {2}const POSSESSIONS_PINNED = .*\n/)[0] + src.match(/ {2}const STOP_WORDS = .*\n/)[0] + src.match(/ {2}const BIG_MOMENT_RE = .*\n/)[0] + src.match(/ {2}const GROUP_HINT_RE = .*\n/)[0] + src.match(/ {2}const SECRET_NAME_RE = .*\n/)[0] + src.match(/ {2}const EVERYONE_RE = .*\n/)[0] + src.match(/ {2}const factsMode = .*\n/)[0];
const lib = new Function(factsConsts + consts + ['latestVersions', 'composeMemory', 'entryKeys', 'organize', 'squashRepeats', 'cleanOutput', 'dedupeEntries', 'parseKeeperAnswer', 'applySections', 'cloneEntries', 'findEntry', 'applyUpdates', 'dropReasoning', 'latestState', 'sameButTitle', 'markStale', 'forget', 'logJob', 'reconcile', 'dropJunk', 'structuredOnly', 'splitStates', 'guessKind', 'placeStates', 'cleanChat', 'splitMisplaced', 'cleanSummary', 'dropEmpty', 'greetingOf', 'dedupeSections', 'aliasOfOther', 'isEntryFor', 'recordKind', 'parseRecords', 'allRecords', 'buildEntries', 'splitByLabel', 'buildSecrets', 'secretsText', 'sigWords', 'alike', 'importantMoment', 'relationsOf']
  .map(grab).join('\n') + '\nreturn { latestVersions, composeMemory, organize, squashRepeats, parseKeeperAnswer, applySections, applyUpdates, cloneEntries, dropReasoning, latestState, reconcile, dropJunk, structuredOnly, splitStates, guessKind, cleanChat, cleanSummary, greetingOf, dedupeSections, isEntryFor, parseRecords, allRecords, buildEntries, splitByLabel, buildSecrets, secretsText };')();

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
  const msgs = (ids) => [{ id: 'u0', role: 'user' }].concat(ids.map((id) => ({ id, role: 'assistant' })));
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

test('a block headed by another character\'s name goes to that character', () => {
  const entries = [{ name: 'Giselle', kind: 'character', aliases: [], text: '- Bold.' }, { name: 'Ningning', kind: 'character', aliases: ['Ning'], text: '- Youngest.' }];
  const r = lib.applyUpdates(entries, [{ name: 'Giselle', aliases: [], add: true, text: '- Bit her lip.\n**Ningning**\n- Packed neon swimwear and an inflatable unicorn horn.' }], []);
  assert.strictEqual(r.entries[0].text, '- Bold.\n- Bit her lip.');
  assert.strictEqual(r.entries[1].text, '- Youngest.\n- Packed neon swimwear and an inflatable unicorn horn.');
});

// Real answers from the user's bot comparison (er-8 and smut-fic-writer).
test('regression: working-out inside a summary is removed; a summary that is mostly working-out is not used', () => {
  const smut = 'Summary: Need around 5000 chars. We can write detailed summary of the AI\'s reasoning plus story. Must be past-tense prose. Let\'s outline: ' +
    'Jacek joined the members in a Seoul penthouse suite after their encore concert. Karina asked for a shoulder massage, and he fingered her to orgasm on the velvet sofa. ' +
    'Winter was bent over an armchair while Giselle watched.';
  const c = lib.cleanSummary(smut);
  assert.strictEqual(c.text, 'Jacek joined the members in a Seoul penthouse suite after their encore concert. Karina asked for a shoulder massage, and he fingered her to orgasm on the velvet sofa. Winter was bent over an armchair while Giselle watched.');
  assert(!c.bad);
  const er8 = '.. STORY AI: ... (a line) USER: ... (the request) Then [R2] with a long story. And [R3] with another story part. Therefore, the story replies are [R2] and [R3]. [R1] is the setup. But the instruction says "each [R...]" in the messages.';
  assert(lib.cleanSummary(er8).bad, 'er-8\'s R1 is all working-out');
  const greet = 'The STORY AI greeted the user in a Southern drawl, saying "Evenin\', darlin\'." FACTS: none. But summary target about 1200 chars impossible. Maybe include that the assistant adopted a persona.';
  assert.strictEqual(lib.cleanSummary(greet).text, 'The STORY AI greeted the user in a Southern drawl, saying "Evenin\', darlin\'."');
  // Quoted dialogue that sounds like planning stays.
  assert(!lib.cleanSummary('Karina said "We need to rest" and lay down beside Jacek on the bed.').bad);
});

test('regression: an entry copied from the template is thrown away; "None stated" and empty headings go', () => {
  const p = lib.parseKeeperAnswer('=== ENTRY: Name | kind | aliases: other names, nicknames, titles ===\nFor characters, kind: character.\n=== ENTRY: Karina | character | aliases: Karina-unnie ===\n### Basics\n- Karina is a member of aespa.\n### Abilities & Skills\n- None stated.\n### Likes, Dislikes & Boundaries\n- None stated.\n### Key Moments\n- Asked for a shoulder massage.', []);
  assert.deepStrictEqual(p.updates.map((u) => u.name), ['Karina']);
  assert.strictEqual(p.updates[0].text, '### Basics\n- Karina is a member of aespa.\n### Key Moments\n- Asked for a shoulder massage.');
});

test('the bot\'s greeting (an AI message before the user\'s first one) is found', () => {
  assert.strictEqual(lib.greetingOf([{ id: 'g', role: 'assistant' }, { id: 'u', role: 'user' }, { id: 'r', role: 'assistant' }]), 'g');
  assert.strictEqual(lib.greetingOf([{ id: 'u', role: 'user' }, { id: 'r', role: 'assistant' }]), null);
});

test('regression: a repeated story section (er-8\'s planning) and "none" lines are dropped', () => {
  const m = '## Current Scene\n- Seoul penthouse suite, late night.\n\n## Open Threads\n(None)\n\n## World & Timeline\n- Turning points:\n  - Post-concert: Jacek began relationships with all members\n\n## Open Threads\nThere are no unresolved plans.\n\n## World & Timeline\n   ### Basics\n The Silk Scarf entry will have:';
  assert.strictEqual(lib.dedupeSections(m), '## Current Scene\n- Seoul penthouse suite, late night.\n\n## World & Timeline\n- Turning points:\n  - Post-concert: Jacek began relationships with all members');
});

// From the user's 10-reply bot comparison: Yujin's and Giselle's entries
// were merged into Karina's because all were called "unnie".
test('regression: people who share a term of address ("unnie") are never merged', () => {
  const p = lib.parseKeeperAnswer([
    '=== CAST ===', 'Jacek, Karina, Giselle, Yujin',
    '=== ENTRY: Karina | character | aliases: unnie, Karina-unnie ===', '- Leader of aespa.',
    '=== ENTRY: Giselle | character | aliases: unnie, Giselle-unnie ===', '- Hourglass figure.',
    '=== ENTRY: Yujin | character | aliases: unnie, Yujin-unnie ===', '- Full name: Ahn Yujin', '- Role: Leader of IVE',
  ].join('\n'), []);
  const r = lib.applyUpdates([], p.updates, []);
  assert.deepStrictEqual(r.entries.map((e) => e.name), ['Karina', 'Giselle', 'Yujin']);
  assert.strictEqual(r.entries[0].text, '- Leader of aespa.');
  // Later updates find each by name, never by "unnie".
  lib.applyUpdates(r.entries, [{ name: 'Yujin', aliases: ['unnie'], add: true, text: '- Walked in on them in Hongdae.' }], []);
  assert(!/Hongdae/.test(r.entries[0].text) && /Hongdae/.test(r.entries[2].text));
  // An update for someone new, called only "unnie" by others, gets its own entry.
  lib.applyUpdates(r.entries, [{ name: 'Wonyoung', aliases: ['unnie'], kind: 'character', text: '- Member of IVE.' }], []);
  assert(r.entries.some((e) => e.name === 'Wonyoung') && !/IVE\./.test(r.entries[0].text.replace('Leader of aespa.', '')));
});

test('regression: another character\'s name is never added as a nickname', () => {
  const entries = [{ name: 'Karina', kind: 'character', aliases: [], text: '- Leader.' }, { name: 'Giselle', kind: 'character', aliases: [], text: '- Rapper.' }, { name: 'Yujin', kind: 'character', aliases: [], text: '- IVE.' }];
  lib.applyUpdates(entries, [{ name: 'Karina', aliases: ['unnie', 'Giselle', 'Yujin-unnie', 'Jimin'], add: true, text: '- Tall.' }], []);
  assert.deepStrictEqual(entries[0].aliases, ['unnie', 'Jimin']);
  const chat = { memory: '', entries: [{ name: 'Karina', kind: 'character', aliases: ['unnie', 'Giselle', 'Yujin-unnie', 'Jimin'], text: '- Leader.' }, { name: 'Giselle', kind: 'character', aliases: [], text: '- Rapper.' }, { name: 'Yujin', kind: 'character', aliases: [], text: '- IVE.' }], ignored: [], log: [], chapters: [] };
  lib.organize(chat);
  assert.deepStrictEqual(chat.entries.find((e) => e.name === 'Karina').aliases, ['unnie', 'Jimin']);
});

// From the user's rebuilt memory: consolidating Karina took the keeper's
// entry for Yujin (both "unnie") as hers.
test('regression: consolidation only takes the entry with the right name', () => {
  const karina = { name: 'Karina', kind: 'character', aliases: ['unnie', 'Karina-unnie', 'Yu Jimin'], text: '- Leader of aespa.' };
  assert(!lib.isEntryFor(karina, { name: 'Yujin', aliases: ['unnie', 'Yujin-unnie'] }));
  assert(!lib.isEntryFor(karina, { name: 'unnie', aliases: [] }));
  assert(lib.isEntryFor(karina, { name: 'Karina', aliases: [] }));
  assert(lib.isEntryFor(karina, { name: 'Yu Jimin', aliases: [] }));
  assert(lib.isEntryFor({ name: 'Choi', aliases: [] }, { name: 'Ms. Choi', aliases: [] }));
});

test('regression: a label with nothing known ("Age: Not stated") is dropped', () => {
  const p = lib.parseKeeperAnswer('=== ENTRY: Wonyoung | character ===\n### Basics\n- Full name: Wonyoung\n- Age: Not stated\nAge: Unknown\n- Role: Member of IVE', []);
  assert.strictEqual(p.updates[0].text, '### Basics\n- Full name: Wonyoung\n- Role: Member of IVE');
});

// The facts format (docs/REDESIGN.md).
test('facts format: records are read from a summary\'s FACTS', () => {
  const p = lib.parseKeeperAnswer('=== LOG ===\n[R1] Karina comforted Winter.\nFACTS:\n- Karina | relationship: Winter | comforted her after the fight\n- Park Ji-won | Role | COO of SM\n- unnie | personality | kind\n- Winter | where things stand: Karina | close again', [{ id: 'a' }]);
  assert.deepStrictEqual(p.entries[0].records.map((r) => [r.s, r.k, r.t, r.v]), [['Karina', 'relationship', 'Winter', 'comforted her after the fight'], ['Park Ji-won', 'role', '', 'COO of SM'], ['Winter', 'stands', 'Karina', 'close again']]);
  assert(/Karina — relationship: Winter: comforted her/.test(p.entries[0].facts));
});

test('facts format: characters are built from the records — newest wins, history kept, nobody mixed up', () => {
  const rec = (s, k, v) => { const m = k.match(/^([^:]+)(?::\s*(.+))?$/); return { s, k: m[1], t: m[2] || '', v, label: m[1] }; };
  const chat = { ignored: [], entries: [], log: [
    { id: 'r1', text: 'x', records: [rec('Park Ji-won', 'role', 'PR head at SM'), rec('Karina', 'appearance', 'tall and athletic'), rec('Karina', 'nickname', 'unnie, Yu Jimin'), rec('Yujin', 'nickname', 'unnie'), rec('Yujin', 'role', 'leader of IVE')] },
    { id: 'r2', text: 'x', records: [rec('Park Ji-won', 'role', 'CFO of SM'), rec('Karina', 'relationship: Winter', 'kissed her in the rain'), rec('Mango plushie', 'status', 'ordered for the villa'), rec('Mango plushie', 'type', 'item')] },
    { id: 'r3', text: 'x', records: [rec('Park Ji-won', 'role', 'COO of SM'), rec('Karina', 'stands: Winter', 'close again; promised to stop teasing'), rec('Mango plushie', 'status', 'delivered to the penthouse'), rec('Ms. Choi', 'role', 'PR head'), rec('Choi', 'personality', 'strict')] },
  ] };
  const es = lib.buildEntries(chat);
  const get = (n) => es.find((e) => e.name === n);
  assert(/- Role: COO of SM \(before: PR head at SM, until reply 2; CFO of SM, until reply 3\)/.test(get('Park Ji-won').text), get('Park Ji-won').text);
  assert(/- Status: delivered to the penthouse \(before: ordered for the villa/.test(get('Mango plushie').text) && get('Mango plushie').kind === 'item');
  assert(/- Winter: kissed her in the rain\. Where things stand: close again/.test(get('Karina').text));
  assert(get('Yujin') && /leader of IVE/.test(get('Yujin').text) && !/IVE/.test(get('Karina').text), 'Yujin is not merged into Karina through "unnie"');
  assert.deepStrictEqual(get('Karina').aliases, ['Yu Jimin']);
  assert(!es.some((e) => e.name === 'Choi') && /strict/.test((get('Ms. Choi') || {}).text || ''), 'Ms. Choi and Choi are one person');
  // A redone reply takes its facts along; facts the user removed stay removed.
  chat.log = chat.log.filter((e) => e.id !== 'r3');
  chat.hiddenRecords = ['r1#1'];
  const es2 = lib.buildEntries(chat);
  assert(/- Role: CFO of SM \(before: PR head at SM/.test(es2.find((e) => e.name === 'Park Ji-won').text));
  assert(!/tall and athletic/.test(es2.find((e) => e.name === 'Karina').text));
});

test('facts format: an answer is split by its [R…] labels', () => {
  const parts = lib.splitByLabel('[R1]\n- Karina | role | leader\n**[R2]**\nnone\n[R3]:\n- Winter | age | 23');
  assert.deepStrictEqual(Object.keys(parts), ['1', '2', '3']);
  assert.strictEqual(lib.parseRecords(parts[3])[0].v, '23');
});

test('facts format: records written the way real bots vary them are understood; old-style facts are not misread', () => {
  const recs = lib.parseRecords([
    '- Karina | relationship with Winter | comforted her after the fight',
    '- **Karina** | Where things stand with Winter | close again',
    '* Winter (aespa) | Key Moments | cried in the rain',
    'Park Ji-won | Role (current) | COO of SM',
    'Mira is a healer | Ash is a dragon | Karina leads aespa',
    '- They | appearance | tired',
    '- Jacek | some very long made up kind name | x',
  ].join('\n'));
  assert.deepStrictEqual(recs.map((r) => [r.s, r.k, r.t, r.v]), [
    ['Karina', 'relationship', 'Winter', 'comforted her after the fight'],
    ['Karina', 'stands', 'Winter', 'close again'],
    ['Winter', 'moment', '', 'cried in the rain'],
    ['Park Ji-won', 'role', '', 'COO of SM'],
  ]);
});

// From the user's first rebuild in the facts format (Uncensored-Smut-Writer).
test('regression (first facts rebuild): joint subjects, places filed as characters, moment states', () => {
  const recs = lib.parseRecords([
    '- Tiffany and Irene | relationship: Jacek | agreed to share him',
    '- Tiffany | age | 37',
    '- Tiffany | personality | bubbly, affectionate',
    '- Tiffany | status | remained bound throughout',
    '- Irene | role | lecturer in Humanities',
    '- Seoul University | place | prestigious university in Seoul',
    '- Lecture Hall B | place | steeply raked modern auditorium',
    '- Lighting rig | status | reset to Preset Two',
    '- Setting | place | Irene\'s university office',
    '- Thursday | key moment | faculty meeting for Tiffany and Irene',
    '- Daehyun | role | sound technician',
  ].join('\n'));
  const chat = { ignored: [], entries: [], log: [{ id: 'r1', text: 'x', records: recs }] };
  const es = lib.buildEntries(chat);
  const get = (n) => es.find((e) => e.name === n) || {};
  assert(!es.some((e) => /and/.test(e.name)), 'no "Tiffany and Irene" entry: ' + es.map((e) => e.name));
  assert(/- Jacek: agreed to share him/.test(get('Tiffany').text) && /- Jacek: agreed to share him/.test(get('Irene').text), 'a joint fact goes to each of them');
  assert(/Age: 37/.test(get('Tiffany').text) && !/remained bound/.test(get('Tiffany').text), 'a person\'s moment "status" is left out');
  assert.strictEqual(get('Seoul University').kind, 'place');
  assert.strictEqual(get('Lecture Hall B').kind, 'place');
  assert.strictEqual(get('Lighting rig').kind, 'item');
  assert(/Status: reset to Preset Two/.test(get('Lighting rig').text), 'a thing keeps its status');
  assert(!es.some((e) => e.name === 'Setting'), '"Setting" is not an entry of its own');
  assert.strictEqual(get('Thursday').kind, 'lore');
  assert.strictEqual(get('Daehyun').kind, 'character');
  assert.strictEqual(get('Tiffany').kind, 'character');
});

// From the user's second rebuild in the facts format (lines as the keeper wrote them).
test('regression (second facts rebuild): moment looks, activities as roles, empty and placeholder entries', () => {
  const recs = lib.parseRecords([
    '- Tiffany | appearance | cream sweater dress, heeled boots, dark hair, bright smile, smells of vanilla and peonies',
    '- Tiffany | appearance | wearing lacy champagne-colored bra and matching panties after her dress was removed',
    '- Tiffany | appearance | breasts exposed, nipples peaked; wearing torn lace panties',
    '- Tiffany | appearance | wearing cream sweater dress with back zipper undone; angry red marks on wrists and arms',
    '- Tiffany | role | lecturer in Performing Arts at Seoul University',
    '- Tiffany | role | has an afternoon class to teach',
    '- Tiffany | personality | bubbly, outgoing, affectionate',
    '- Setting | type | place',
    '- Archival Annex | type | place',
    '- Story | key moment | everyone went to the party',
  ].join('\n'));
  const es = lib.buildEntries({ ignored: [], entries: [], log: [{ id: 'r1', text: 'x', records: recs }] });
  const t = (es.find((e) => e.name === 'Tiffany') || {}).text || '';
  assert(/dark hair, bright smile/.test(t) && !/lacy champagne|breasts exposed|zipper undone/.test(t), 'lasting looks kept, passing ones left out: ' + t);
  assert(/- Role: lecturer in Performing Arts at Seoul University$/m.test(t) && !/afternoon class/.test(t), 'an activity is not a role');
  assert.deepStrictEqual(es.map((e) => e.name), ['Tiffany'], 'no empty or placeholder entries');
});

test('facts format: built entries are already tidy (no nickname for the tidy-up to clean at every save)', () => {
  const rec = (s, k, v) => ({ s, k, t: '', v, label: k });
  const chat = { ignored: [], entries: [], chapters: [], memory: '', log: [{ id: 'r1', text: 'x', records: [rec('Mina', 'nickname', 'Mimi, Jacek\'s anchor, Jacek'), rec('Mina', 'role', 'graduate student'), rec('Jacek', 'role', 'student')] }] };
  chat.entries = lib.buildEntries(chat);
  assert.deepStrictEqual(chat.entries.find((e) => e.name === 'Mina').aliases, ['Mimi']);
  assert(/Role: student/.test((chat.entries.find((e) => e.name === 'Jacek') || {}).text || '') && !/Role: student$/m.test(chat.entries.find((e) => e.name === 'Mina').text),
    'Jacek\'s facts stay with Jacek, even though Mina\'s nicknames mention him');
  assert.deepStrictEqual(lib.organize(chat).filter((f) => /aliases/.test(f)), []);
});

test('who knows what: each secret is put together across replies; the newest record per person wins', () => {
  const R = (n, lines) => ({ id: 'r' + n, text: 'x', records: lib.parseRecords(lines.join('\n')) });
  const chat = { ignored: [], entries: [], log: [
    R(1, ['- Jacek | secret | [SM ownership] owns SM Entertainment through Luxembourg shell companies', '- Giselle | does not know | [SM ownership]', '- Public | cover story | [SM ownership] Jacek is a "trusted associate"', '- Jacek | role | stylist']),
    R(2, ['- Winter | knows | [SM ownership] Jacek told her on the terrace', '- Karina and Ningning | knows | [SM ownership] overheard the phone call']),
    R(3, ['- Giselle | knows | [SM ownership] found the contracts', '- Tiffany | secret | [the office] what happened in Irene\'s office', '- Irene | knows | [the office] she was there', '- Mina | does not know | [the office]']),
  ] };
  const sec = lib.buildSecrets(chat);
  const sm = sec.find((x) => x.name === 'SM ownership');
  assert.deepStrictEqual(sm.knows.map((p) => p.who).sort(), ['Giselle', 'Jacek', 'Karina', 'Ningning', 'Winter']);
  assert.deepStrictEqual(sm.notKnows, [], 'Giselle found out in reply 3 (newest wins)');
  assert.strictEqual(sm.cover, 'Jacek is a "trusted associate"');
  const office = sec.find((x) => x.name === 'the office');
  assert.deepStrictEqual(office.knows.map((p) => p.who), ['Tiffany', 'Irene']);
  assert.deepStrictEqual(office.notKnows.map((p) => p.who), ['Mina']);
  const text = lib.secretsText(chat);
  assert(/- \[SM ownership\] owns SM Entertainment[^\n]*\n  Knows: Jacek, Giselle \(found the contracts, reply 3\)|Knows: .*Winter \(Jacek told her on the terrace, reply 2\)/.test(text), text);
  assert(/\[the office\][^\n]*\n  Knows: Tiffany, Irene \(she was there, reply 3\) · Does NOT know: Mina/.test(text), text);
  // Each person's entry lists what they know and do not know; knowledge records are not facts of their own.
  const es = lib.buildEntries(chat);
  const t = (n) => (es.find((e) => e.name === n) || {}).text || '';
  assert(/- Knows: \[SM ownership\]/.test(t('Winter')) && /- Does NOT know: \[the office\]/.test(t('Mina')));
  assert.strictEqual(es.find((e) => e.name === 'Mina').kind, 'character', 'someone who only knows (or does not know) a secret is still a person');
  assert(!es.some((e) => /^(public|everyone)$/i.test(e.name)) && !/cover story|trusted associate/.test(t('Jacek')));
  // When it comes out, everyone knows and nobody is listed as not knowing.
  chat.log.push(R(4, ['- Everyone | knows | [the office] the photos leaked']));
  const office2 = lib.buildSecrets(chat).find((x) => x.name === 'the office');
  assert(office2.everyone && !office2.notKnows.length);
});

test('pinned message: important key moments and the newest 15; the rest stays stored', () => {
  const R = (n, lines) => ({ id: 'r' + n, text: 'x', records: lib.parseRecords(lines.join('\n')) });
  const log = [];
  for (let i = 1; i <= 40; i++) log.push(R(i, ['- Jacek | key moment | routine scene number ' + i + ' at the studio']));
  log[2] = R(3, ['- Jacek | major moment | took Giselle out on their first proper date']);
  log[4] = R(5, ['- Jacek | key moment | made a sweeping confession of love to all four']);
  log[6] = R(7, ['- Jacek | key moment | moved the penthouse furniture around', '- Jacek | promise | will take Winter to Kyoto']);
  log[8] = R(9, ['- Jacek | key moment | dominated the IVE pair at the Inkigayo loading bay']);
  const chat = { ignored: [], entries: [], keptMoments: ['r11#0'], memory: '## World & Timeline\nTurning points:\n- Reply 9: the IVE pair dominated at the Inkigayo loading bay; IVE joins the household', log };
  const e = lib.buildEntries(chat).find((x) => x.name === 'Jacek');
  assert.strictEqual((e.text.match(/^- \(reply/gm) || []).length, 40, 'every moment is stored');
  const pin = e.pinText;
  assert(pin && /older minor and routine moments are left out/.test(pin), pin);
  // The keeper marks levels here (a major moment): those are trusted, no guessing.
  for (const n of [3, 11]) assert(pin.includes('(reply ' + n + ')'), 'kept reply ' + n);
  assert(!pin.includes('(reply 5)') && !pin.includes('(reply 13)') && pin.includes('(reply 26)') && pin.includes('(reply 40)'), 'older minor ones out, newest 15 in');
  // A story from before the levels (nothing marked): the guesses decide.
  log[2] = R(3, ['- Jacek | key moment | took Giselle out on their first proper date']);
  const old = lib.buildEntries(Object.assign({}, chat, { log, entries: [] })).find((x) => x.name === 'Jacek').pinText;
  for (const n of [5, 7, 9, 11]) assert(old.includes('(reply ' + n + ')'), 'kept reply ' + n + ' (guessed)');
});

test('moments in four levels: turning points and major ones all; minor the newest 15; routine the newest 5', () => {
  const R = (n, lines) => ({ id: 'r' + n, text: 'x', records: lib.parseRecords(lines.join('\n')) });
  const log = [];
  for (let i = 1; i <= 60; i++) {
    const kind = i % 20 === 0 ? 'turning point' : i % 10 === 0 ? 'major moment' : i % 2 ? 'routine moment' : 'minor moment';
    log.push(R(i, ['- Mira | ' + kind + ' | event ' + i + ' happened ' + 'abcdefghij'.split('').slice(0, i % 10 + 1).join(' x')]));
  }
  const e = lib.buildEntries({ ignored: [], entries: [], log }).find((x) => x.name === 'Mira');
  const lines = e.pinText.split('\n').filter((l) => /^- \(reply/.test(l));
  const at = (l) => Number(l.match(/reply (\d+)/)[1]);
  assert.strictEqual(lines.filter((l) => at(l) % 20 === 0).length, 3, 'all turning points');
  assert(lines.filter((l) => at(l) % 20 === 0).every((l) => /Turning point:/.test(l)));
  assert.strictEqual(lines.filter((l) => at(l) % 10 === 0 && at(l) % 20).length, 3, 'all major moments');
  assert.strictEqual(lines.filter((l) => at(l) % 2 && at(l) % 10).length, 5, 'routine: newest 5');
  assert.strictEqual(lines.filter((l) => !(at(l) % 2) && at(l) % 10).length, 15, 'minor: newest 15');
  assert.strictEqual((e.text.match(/^- \(reply/gm) || []).length, 60, 'all stored');
});

test('secrets: a label alone is left out; whose secret it is is said', () => {
  const R = (n, lines) => ({ id: 'r' + n, text: 'x', records: lib.parseRecords(lines.join('\n')) });
  const chat = { ignored: [], entries: [], log: [R(1, ['- Karina | secret | [car play]', '- Winter | does not know | [car play]', '- Karina | secret | [wants to be Jimin] sometimes wants to stop being Karina'])] };
  const text = lib.secretsText(chat);
  assert(!/car play/.test(text), text);
  assert(/\[wants to be Jimin\] Karina’s secret: sometimes wants/.test(text), text);
  const es = lib.buildEntries(chat);
  assert(!/car play/.test(es.find((x) => x.name === 'Winter') ? es.find((x) => x.name === 'Winter').text : ''));
});

test('duplicates: a title before a name is the same person; near-identical possessions merge; groups', () => {
  const R = (n, lines) => ({ id: 'r' + n, text: 'x', records: lib.parseRecords(lines.join('\n')) });
  const chat = { ignored: [], entries: [], log: [R(1, [
    '- Park Ji-won | role | CFO of SM', '- CFO Park Ji-won | status | silenced and intimidated in the boardroom',
    '- Giselle | possession | Obsidian cuff bracelet engraved \'Mine\'', '- Giselle | possession | Obsidian bracelet engraved \'Mine\' worn prominently', '- Giselle | possession | Black lace bikini',
    '- CEO Lee | status | threatened with regulatory destruction', '- Dispatch | status | the tabloid was silenced by Jacek', '- IVE | status | two members tamed'])] };
  const es = lib.buildEntries(chat);
  assert(!es.some((x) => x.name === 'CFO Park Ji-won'), es.map((x) => x.name).join(', '));
  const g = es.find((x) => x.name === 'Giselle').text;
  assert.strictEqual((g.match(/bracelet/g) || []).length, 1, g);
  assert(/bikini/.test(g));
  const kind = (n) => (es.find((x) => x.name === n) || {}).kind;
  assert.strictEqual(kind('CEO Lee'), 'character');
  assert.strictEqual(kind('Dispatch'), 'group');
  assert.strictEqual(kind('IVE'), 'group');
});

test('pinned version: relationships in one line, no "before" histories; minor characters in a few lines', () => {
  const R = (n, lines) => ({ id: 'r' + n, text: 'x', records: lib.parseRecords(lines.join('\n')) });
  const log = [];
  for (let i = 1; i <= 8; i++) log.push(R(i, ['- Jacek | relationship: Winter | ' + ['kissed', 'dated', 'argued', 'reconciled', 'travelled', 'cooked', 'painted', 'danced'][i - 1] + ' together scene number ' + i, '- Jacek | where things stand: Winter | state ' + i, '- Jacek | role | job ' + i]));
  log.push(R(9, ['- Irene | role | leader of Red Velvet', '- Irene | relationship: Jacek | dating for four years', '- Irene | where things stand: Jacek | trusting partners', '- Irene | appearance | tall', '- Irene | key moment | washed his hair one evening']));
  const e = lib.buildEntries({ ignored: [], entries: [], log }).find((x) => x.name === 'Jacek');
  assert(/\(before:/.test(e.text) && !/\(before:/.test(e.pinText), e.pinText);
  const line = e.pinText.split('\n').find((l) => l.startsWith('- Winter:'));
  assert.strictEqual((line.match(/scene number/g) || []).length, 3, line);
  assert(/Where things stand: state 8$/.test(line) && /Role: job 8$/m.test(e.pinText));
  const irene = lib.buildEntries({ ignored: [], entries: [], log }).find((x) => x.name === 'Irene');
  assert(/Role: leader of Red Velvet/.test(irene.miniText) && /- Jacek: trusting partners/.test(irene.miniText) && !/tall|washed/.test(irene.miniText), irene.miniText);
});

test('secrets: the same secret under different names becomes one', () => {
  const R = (n, lines) => ({ id: 'r' + n, text: 'x', records: lib.parseRecords(lines.join('\n')) });
  const chat = { ignored: [], entries: [], log: [R(1, [
    '- Giselle | secret | [giselle-ningning-fantasy] Masturbated to fantasies of being with Ningning while Jacek watched and directed',
    '- Ningning | secret | [ningning-giselle-fantasy] Masturbated to fantasies of being with Giselle while Jacek watched and directed',
    '- Ningning and Giselle | secret | [shared fantasies] Admitted masturbating to fantasies of being with Giselle while Jacek watched and directed',
    '- Leeseo | secret | [crush] has a crush on a backup dancer named Minsoo'])] };
  const sec = lib.buildSecrets(chat);
  assert.strictEqual(sec.length, 2, sec.map((x) => x.name).join(', '));
  assert.deepStrictEqual(sec[0].owners.sort(), ['Giselle', 'Ningning']);
});

test('relationships in the pinned message come from the list written at the end of a rebuild', () => {
  const R = (n, lines) => ({ id: 'r' + n, text: 'x', records: lib.parseRecords(lines.join('\n')) });
  const log = [R(1, ['- Jacek | relationship: Winter | bound her wrists with a red scarf', '- Jacek | where things stand: Winter | cuddled in the master suite', '- Winter | personality | quiet'])];
  const chat = { ignored: [], entries: [], log, relMap: { at: 1, list: [{ a: 'Jacek', b: 'Winter', status: 'dating', now: 'close and trusting' }, { a: 'Karina', b: 'Winter', status: 'bandmates', now: '' }] } };
  const es = lib.buildEntries(chat);
  const j = es.find((x) => x.name === 'Jacek'), w = es.find((x) => x.name === 'Winter');
  assert(/- Winter: dating — close and trusting/.test(j.pinText) && !/red scarf/.test(j.pinText) && /red scarf/.test(j.text), j.pinText);
  assert(/- Jacek: dating — close and trusting/.test(w.pinText) && /- Karina: bandmates/.test(w.pinText), w.pinText);
});

console.log('All ' + passed + ' entry checks passed.');
