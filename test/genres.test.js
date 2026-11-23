// Six small made-up stories in different genres. Every version of Story
// Manager must handle all of them: the code may not depend on any one genre.
// Each story is a list of replies, each with the keeper's FACTS lines.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const unit = fs.readFileSync(path.join(__dirname, 'entries.test.js'), 'utf8');
const end = unit.indexOf("')();", unit.indexOf('const lib = new Function(')) + 5;
const lib = new Function('require', '__dirname', unit.slice(0, end).replace(/^'use strict';/, '') + '\nreturn lib;')(require, __dirname);

function story(replies, memory = '') {
  return { format: 'facts', ignored: [], entries: [], memory, chapters: [],
    log: replies.map((lines, i) => ({ id: 'r' + (i + 1), text: 'summary ' + (i + 1), records: lib.parseRecords(lines.join('\n')) })) };
}
const entry = (es, n) => es.find((e) => e.name === n) || { text: '', pinText: '' };
const pin = (e) => (e.pinText != null ? e.pinText : e.text);
const story2 = (replies) => { const c = story(replies.map((r) => r.lines)); replies.forEach((r, i) => { if (r.text) c.log[i].text = r.text; }); return c; };
let n = 0, failed = 0;
function test(name, fn) { n++; try { fn(); console.log('  ✓ ' + name); } catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + e.message.split('\n').slice(0, 6).join('\n    ')); } }
// Checks every story must pass.
function common(chat) {
  const es = lib.buildEntries(chat);
  const again = lib.buildEntries(JSON.parse(JSON.stringify(chat)));
  assert.strictEqual(JSON.stringify(es.map((e) => e.text)), JSON.stringify(again.map((e) => e.text)), 'building twice differs');
  // No fact is silently lost: every record's value appears in some full entry or in the secrets.
  const all = es.map((e) => e.text).join('\n') + '\n' + JSON.stringify(lib.buildSecrets(chat));
  const lost = lib.allRecords(chat).filter((r) => r.k !== 'cover' && r.k !== 'type' && r.k !== 'done' && !all.includes(r.v.replace(/^\s*\[[^\]]+\]\s*/, '').slice(0, 25)));
  assert(!lost.length, 'lost: ' + lost.map((r) => r.s + ' | ' + r.k + ' | ' + r.v).join('; '));
  return es;
}

console.log('Genre stories');

test('fantasy: abilities, allegiance, a death, a kingdom\'s fate', () => {
  const chat = story([
    ['- Lena | role | apprentice mage of the Ember Circle', '- Lena | ability | can call fire but not control it', '- Lena | relationship: Tomas | sworn sister-in-arms', '- Lena | minor moment | burned the training dummy to ash'],
    ['- Varn | type | place', '- Varn | status | besieged by the northern host', '- Tomas | secret | [Varn] he deserted his post at the siege', '- Lena | knows | [Varn] Tomas confessed it at the campfire'],
    ['- Captain Orrin | condition | killed holding the gate', '- Varn | status | fallen to the northern host', '- Lena | role | battle mage of the Ember Circle', '- Lena | major moment | swore to retake Varn'],
  ]);
  const es = common(chat);
  assert(/Condition: killed holding the gate/.test(pin(entry(es, 'Captain Orrin'))), 'a death is shown');
  assert(/Status: fallen/.test(pin(entry(es, 'Varn'))) && !/Status: besieged/.test(pin(entry(es, 'Varn'))), 'newest status only');
  assert(/Role: battle mage/.test(pin(entry(es, 'Lena'))) && /apprentice/.test(entry(es, 'Lena').text), 'role change kept as history');
  assert(lib.buildSecrets(chat)[0].knows.some((k) => k.who === 'Lena'));
});

test('military: command, promotion, casualties, captured', () => {
  const chat = story([
    ['- General Hale | role | commander of the Third Army', '- Major Iris Kade | role | staff officer to General Hale', '- Iris | relationship: Hale | his most trusted officer', '- Third Army | type | group'],
    ['- Iris | role | colonel, commanding the river crossing', '- Sergeant Bo | condition | badly wounded at the crossing', '- Hale | goal | take the bridge at Ostrava before the thaw'],
    ['- Hale | done | took the bridge at Ostrava', '- Sergeant Bo | condition | captured by the enemy', '- Third Army | status | holding the east bank'],
  ]);
  const es = common(chat);
  assert(/Condition: captured/.test(pin(entry(es, 'Sergeant Bo'))) && !/Condition: badly wounded/.test(pin(entry(es, 'Sergeant Bo'))));
  assert(!/Goal: take the bridge/.test(pin(entry(es, 'General Hale'))), 'a goal marked done is not open');
});

test('mystery: a false belief is never shown as true; who knows the truth', () => {
  const chat = story([
    ['- Mr. Pell | secret | [the will] he forged his brother\'s will', '- Inspector Vane | believes | [the will] the will is genuine', '- Ada | knows | [the will] she saw Pell forge the signature', '- Pell | does not know | [the will]'],
    ['- Vane | learned | the ink on the will is less than a year old', '- Ada | knows | the gardener was in the study at midnight'],
  ]);
  const es = common(chat);
  const vane = entry(es, 'Inspector Vane');
  assert(/Believes \(may not be true\): \[the will\] the will is genuine/.test(pin(vane)), 'belief labelled');
  assert(/Learned: the ink/.test(pin(vane)), 'learned shown');
  const sec = lib.buildSecrets(chat).find((x) => x.name === 'the will');
  assert(sec.knows.some((k) => k.who === 'Ada') && !sec.knows.some((k) => /Vane/.test(k.who)), 'a believer does not "know"');
  // "knows" without a secret: kept as unsorted, not in the pinned version.
  const ada = entry(es, 'Ada');
  assert(/Unsorted[\s\S]*gardener/.test(ada.text) && !/gardener/.test(pin(ada) === ada.text ? '' : pin(ada)), 'unsorted kept, not pinned');
  const q = lib.factQuality(chat);
  assert.strictEqual(q.filter((x) => x.status === 'no-secret').length, 1);
});

test('large-cast romance: secrets with unknown names are unresolved, not invalid', () => {
  const chat = story([
    ['- Mina | secret | [the letter] she still keeps her ex\'s letters', '- Joon | knows | [the letter] Mina told him', '- Joon | knows | [the ring] he saw it in her drawer', '- Mina | relationship: Joon | dating since spring', '- Hana | relationship: Mina | best friend from school'],
    ['- Mina | where things stand: Joon | trusting; they agreed to no more secrets', '- Joon | where things stand: Mina | he kissed her at the station'],
  ]);
  common(chat);
  const q = lib.factQuality(chat);
  assert.strictEqual(q.filter((x) => x.status === 'unresolved').length, 1, 'the unknown [ring] is unresolved');
  assert.strictEqual(q.filter((x) => x.status === 'suspect-state').length, 1, 'a scene filed as a state is flagged');
});

test('time travel: an old role in a flashback does not erase history', () => {
  const chat = story([
    ['- Dr. Eli Marr | role | physicist at the Geneva lab', '- Eli | major moment | stepped into the machine for the first time'],
    ['- Eli | role | lab assistant in 1985 (flashback)', '- Eli | minor moment | met his younger mentor in 1985'],
  ]);
  const es = common(chat);
  // Known limit, not yet handled: a flashback still replaces the current value.
  assert(/physicist/.test(entry(es, 'Dr. Eli Marr').text), 'the earlier role is still stored');
});

test('slice of life: a small cast with no secrets works and nothing is invented', () => {
  const chat = story([
    ['- Sam | likes | rainy mornings and black coffee', '- Sam | relationship: Priya | roommates for two years', '- Priya | personality | blunt but kind', '- Priya | routine moment | burned the toast again'],
    ['- Sam | goal | finish the novel draft by June', '- Priya | promise | will read Sam\'s draft'],
  ]);
  const es = common(chat);
  assert.strictEqual(lib.buildSecrets(chat).length, 0);
  assert(/blunt but kind/.test(pin(entry(es, 'Priya'))));
  assert(lib.factQuality(chat).every((x) => x.status === 'ok'));
});


test('commitments: intent never completes; actions are not completions; progress, postpone, cancel', () => {
  const chat = story([
    ['- Lena | goal | [retake Varn] lead the Ember Circle back to Varn', '- Tomas | promise | [the letter] will deliver the letter to the queen', '- Ada | goal | [tell the others] tell the household about the engagement'],
    ['- Ada | done | [tell the others] planned to tell everyone at dinner', '- Lena | done | cooked supper for the camp', '- Lena | progress | [retake Varn] won the council vote'],
    ['- Tomas | postponed | [the letter] the roads are closed until spring'],
    ['- Ada | done | [tell the others] told everyone at dinner', '- Tomas | cancelled | [the letter] the queen died before he arrived'],
  ]);
  const es = common(chat);
  const q = lib.factQuality(chat);
  assert.strictEqual(q.filter((x) => x.status === 'intent-not-done').length, 1, 'a plan is not done');
  assert.strictEqual(q.filter((x) => x.status === 'unmatched-done').length, 1, 'cooking supper completes nothing');
  assert(/Goal \[retake-varn\] \(progress: won the council vote\)/.test(pin(entry(es, 'Lena'))), pin(entry(es, 'Lena')));
  assert(/Unsorted[\s\S]*cooked supper/.test(entry(es, 'Lena').text), 'the action is kept');
  assert(!/tell the household/.test(pin(entry(es, 'Ada'))) && /done, reply 4/.test(entry(es, 'Ada').text), 'done only when it happened');
  assert(!/deliver the letter/.test(pin(entry(es, 'Tomas'))) && /cancelled, reply 4/.test(entry(es, 'Tomas').text));
  // After reply 2 only: the plan did not close the goal.
  const early = story([chat.log[0].records, chat.log[1].records].map((rs) => rs.map((r) => '- ' + r.s + ' | ' + (r.label || r.k) + ' | ' + r.v)));
  assert(/tell the household/.test(pin(entry(lib.buildEntries(early), 'Ada'))), 'still open after only planning');
});

test('commitments keep their id through a rebuild with other names and wording', () => {
  const first = story([['- Mira | goal | [the lighthouse] repair the old lighthouse before the storms']]);
  lib.buildEntries(first);
  const id = first.commitReg[0].id;
  // A rebuild: the keeper words it differently and names it differently; a check-up correction used the old id.
  const rebuilt = story([['- Mira | goal | [fix lighthouse] repair the old lighthouse lamp before the winter storms']]);
  rebuilt.commitReg = first.commitReg;
  rebuilt.reconRecords = [{ s: 'Mira', k: 'done', t: '', v: '[' + id + '] the lamp was lit again', at: 1 }];
  const es = lib.buildEntries(rebuilt);
  assert.strictEqual(rebuilt.commitReg.length, 1, 'one commitment, not two');
  assert.strictEqual(rebuilt.commitReg[0].id, id, 'same id');
  assert(/done/.test(entry(es, 'Mira').text) && !/lighthouse/.test(pin(entry(es, 'Mira'))), 'the old correction still applies');
});

test('commitments: similar but different ones stay separate; tricky "done" wording', () => {
  const chat = story([
    ['- Mira | promise | [visit Monday] visit her grandmother on Monday', '- Mira | promise | visit her grandmother on Friday', '- Envoy Sel | goal | [the treaty] bring the river clans to a treaty', '- Bram | goal | [supplies] prepare the supplies for the march'],
    ['- Envoy Sel | done | [the treaty] the clans agreed to the treaty at the ford', '- Bram | done | [supplies] finished preparing the supplies and planned to leave at dawn', '- Mira | done | [visit Monday] visited her grandmother on Monday'],
  ]);
  const es = common(chat);
  const cs = lib.commitState(chat);
  assert.strictEqual(cs.reg.filter((c) => c.owner === 'mira').length, 2, 'Monday and Friday are two promises');
  assert(/grandmother on Friday/.test(pin(entry(es, 'Mira'))) && !/on Monday/.test(pin(entry(es, 'Mira'))), 'only Monday is done');
  assert(cs.reg.find((c) => c.id === 'the-treaty').state === 'done', '"agreed to the treaty" completes the goal');
  assert(cs.reg.find((c) => c.id === 'supplies').state === 'done', '"finished preparing" is done, despite a later plan');
  const plan = story([['- Envoy Sel | goal | [the treaty] bring the river clans to a treaty'], ['- Envoy Sel | done | [the treaty] agreed to meet the clans at the ford']]);
  assert.strictEqual(lib.commitState(plan).reg[0].state, 'open', '"agreed to meet" is still a plan');
});

test('commitments: the check-up can merge two goals of one person, never of two people', () => {
  const chat = story([['- Mira | promise | [keep quiet] will keep the plan between her and Tomas for now', '- Mira | promise | [no council] will keep the talk about the heir from the council', '- Tomas | promise | [no council two] will keep the talk about the heir from the council']]);
  lib.buildEntries(chat);
  const ids = chat.commitReg.map((c) => c.id);
  chat.commitAlias = { [ids[1]]: ids[0], [ids[2]]: ids[0] };
  const cs = lib.commitState(chat);
  assert.strictEqual(cs.reg.filter((c) => c.owner === 'mira').length, 1, 'merged for Mira');
  assert.strictEqual(cs.reg.filter((c) => c.owner === 'tomas').length, 1, 'Tomas keeps his own: ' + JSON.stringify(chat.commitReg));
});

test('goal steps: scheduled, promised again or partly done never completes (five real failures, neutral wording)', () => {
  const chat = story([
    ['- Ren | goal | [follow-up] meet Ilsa for the follow-up study', '- Ren | promise | [the ride] give Cora a real ride on the bike next week',
     '- Ren | promise | [the draft] bring Ada the essay draft', '- Ren | goal | [the essay] finish the essay on memory', '- Ren | goal | [the lecture] attend the lecture in twenty minutes'],
    ['- Ilsa | done | [follow-up] scheduled a follow-up study for Thursday afternoon; Ren confirmed',
     '- Ren | done | [the ride] promised Cora the ride next week; she reminded him and he confirmed',
     '- Ren | done | [the draft] agreed to bring the draft on Monday',
     '- Ren | done | [the essay] wrote three pages on Saturday',
     '- Ren | done | resolved the lighting rig crisis with a new preset'],
  ]);
  const cs = lib.commitState(chat);
  for (const id of ['follow-up', 'the-ride', 'the-draft', 'the-essay', 'the-lecture']) assert.strictEqual((cs.reg.find((c) => c.id === id) || {}).state, 'open', id + ' must stay open: ' + JSON.stringify(cs.reg.find((c) => c.id === id)));
  assert(/progress: wrote three pages/.test(pin(entry(lib.buildEntries(chat), 'Ren'))), 'a part is progress');
  // And the real completions still complete.
  const later = story(chat.log.map((e) => e.records.map((r) => '- ' + r.s + ' | ' + (r.label || r.k) + ' | ' + r.v)).concat([['- Ren | done | [the essay] finished the essay and handed it in', '- Ren | done | [the ride] took Cora on the ride along the coast']]));
  const cs2 = lib.commitState(later);
  assert.strictEqual(cs2.reg.find((c) => c.id === 'the-essay').state, 'done');
  assert.strictEqual(cs2.reg.find((c) => c.id === 'the-ride').state, 'done');
});

test('goal steps depend on the goal: agreeing completes a goal to reach agreement; writing three pages completes "write three pages"', () => {
  const chat = story([
    ['- Envoy Sel | goal | [peace] secure the clans\' agreement to a peace treaty', '- Pia | goal | [pages] write three pages tonight', '- Pia | goal | [the hall] book the great hall for the feast'],
    ['- Envoy Sel | done | [peace] agreed the peace treaty with the clans at the ford', '- Pia | done | [pages] wrote three pages', '- Pia | done | [the hall] booked the great hall'],
  ]);
  const cs = lib.commitState(chat);
  for (const id of ['peace', 'pages', 'the-hall']) assert.strictEqual(cs.reg.find((c) => c.id === id).state, 'done', id);
});

test('wants are not goals: shown as motivations, never as open commitments', () => {
  const chat = story([['- Mina | want | to understand the shape of his gravity', '- Kael | want | to become king one day', '- Kael | goal | [the crown] win the council\'s vote for the crown']]);
  const es = common(chat);
  assert(/Motivations & Desires[\s\S]*become king/.test(pin(entry(es, 'Kael'))) && /Goal \[the-crown\]/.test(pin(entry(es, 'Kael'))));
  assert(!/Goal/.test(pin(entry(es, 'Mina'))) && lib.commitState(chat).reg.length === 1);
});

test('a step never belongs to a goal that only appears later in the story', () => {
  const chat = story([['- Ren | goal | [the lecture] attend the lecture'], []]);
  lib.buildEntries(chat);
  // Rebuilt: the keeper reused the old name for an unrelated earlier action.
  const re = story([['- Ren | done | [the lecture] fixed the lighting rig before the concert'], ['- Ren | goal | [the lecture] attend the lecture']]);
  re.commitReg = chat.commitReg;
  const cs = lib.commitState(re);
  assert.strictEqual(cs.reg[0].state, 'open');
});

test('a rebuild turns an old speculative "goal" into a want: no duplicate, nothing lost, no open goal left', () => {
  const before = story([['- Mina | goal | [gravity] understand the shape of his gravity', '- Mina | goal | [the archive] take him to the archive on Thursday']]);
  lib.buildEntries(before);
  const rebuilt = story([['- Mina | want | to understand the shape of his gravity', '- Mina | goal | [the archive] take him to the archive on Thursday']]);
  rebuilt.commitReg = before.commitReg;
  const es = common(rebuilt);
  const mina = entry(es, 'Mina');
  assert(/Motivations & Desires[\s\S]*shape of his gravity/.test(pin(mina)), 'kept as a want');
  assert(!/Goal \[gravity\]/.test(mina.text), 'no longer a goal');
  assert.strictEqual((mina.text.match(/shape of his gravity/g) || []).length, 1, 'once');
  assert.strictEqual(lib.commitState(rebuilt).reg.length, 1, 'only the real goal is active');
  assert(rebuilt.commitReg.some((c) => c.id === 'gravity'), 'its id stays on record (history), unused');
});

test('Open Threads: of two similar goals, the finished one may be left out, the active one never', () => {
  const chat = story([
    ['- Ren | promise | [ride monday] give Cora a ride to the harbour on Monday', '- Ren | promise | [ride friday] give Cora a ride to the harbour on Friday'],
    ['- Ren | done | [ride monday] gave Cora the ride to the harbour on Monday'],
  ]);
  const cs = lib.commitState(chat);
  assert.strictEqual(cs.closedThread('- Ren will give Cora a ride to the harbour on Friday'), null, 'the active thread stays');
  assert.strictEqual(cs.closedThread('- Ren gives Cora a ride to the harbour'), null, 'unclear: stays');
  const only = story([['- Ren | promise | [the bell] repair the chapel bell before the festival'], ['- Ren | done | [the bell] repaired the chapel bell']]);
  assert(lib.commitState(only).closedThread('- Ren must repair the chapel bell before the festival'), 'a clearly finished one is left out');
});

test('sorting answers are judged the same way in any genre', () => {
  const fact = (s, k, v, status) => ({ r: { s, k, v, at: 2, id: 'm2#0' }, status });
  const ctx = { secretKeys: new Set(['ledger']), goals: [{ id: 'the-ford', owner: 'kade', text: 'take the ford before dawn', at: 1, state: 'open' }] };
  const src = 'Inspector Vane found the torn ledger page in the study. Major Kade\'s company crossed the river and took the ford before dawn.';
  const J = lib.judgeSorting;
  assert.strictEqual(J(fact('Vane', 'knows', 'found the torn ledger page', 'no-secret'), { kind: 'moment minor', value: 'found the torn ledger page in the study' }, src, ctx).decision, 'sorted');
  assert.strictEqual(J(fact('Vane', 'knows', 'found the torn ledger page', 'no-secret'), { kind: 'moment minor', value: 'found the torn ledger page with Sergeant Holt' }, src, ctx).decision, 'unsure', 'a new name');
  assert.strictEqual(J(fact('Vane', 'knows', 'found the torn ledger page', 'no-secret'), { kind: 'knows', value: '[the will] found it' }, src, ctx).decision, 'unsure', 'a secret that does not exist');
  assert.strictEqual(J(fact('Kade', 'done', 'took the ford', 'unmatched-done'), { kind: 'done', value: '[the-ford] took the ford before dawn', quote: 'took the ford before dawn' }, src, ctx).decision, 'sorted');
  assert.strictEqual(J(fact('Kade', 'done', 'took the ford', 'unmatched-done'), { kind: 'done', value: '[the-ford] took the ford before dawn', quote: 'stormed the castle at noon' }, src, ctx).decision, 'failed', 'a quote not in the summary');
  assert.strictEqual(J(fact('Kade', 'stands', 'crossed the river', 'suspect-state'), { kind: 'keep', value: '' }, src, ctx).decision, 'unsure', '"keep" is not proof');
  // Never into "where things stand", even with a quote.
  assert.strictEqual(J(fact('Kade', 'knows', 'crossed the river with his company', 'no-secret'), { kind: 'stands: Vane', value: "Kade's company crossed the river", quote: 'company crossed the river' }, src, ctx).decision, 'unsure');
  // "not" judged against the original fact, not other sentences of the summary.
  const src2 = 'Rosa did not sleep. Ilse asked Bram how he handles all the attention.';
  assert.strictEqual(J(fact('Ilse', 'knows', 'asked Bram how he handles the attention', 'no-secret'), { kind: 'moment minor', value: 'Ilse asked Bram how he handles all the attention', quote: 'Rosa did not sleep' }, src2, ctx).decision, 'sorted');
  // Reversed outcomes, with no "not" in either.
  const src3 = 'The envoy refused the terms. The sergeant was wounded at the gate.';
  assert.strictEqual(J(fact('Envoy', 'knows', 'the envoy refused the terms', 'no-secret'), { kind: 'moment major', value: 'the envoy accepted the terms' }, src3, ctx).decision, 'unsure');
  assert.strictEqual(J(fact('Sergeant', 'knows', 'the sergeant was wounded at the gate', 'no-secret'), { kind: 'moment major', value: 'the sergeant was killed at the gate' }, src3, ctx).decision, 'unsure');
});

test('scheduled events are upcoming, not past moments; they close when they happen', () => {
  const chat = story([
    ['- Mira | scheduled | [recording] recording session on Friday afternoon'],
    ['- Mira | done | [recording] recorded the new song with Tomas in studio B'],
    ['- Ilse | scheduled | [council] council meeting on Thursday at noon'],
  ]);
  const es = common(chat);
  assert(/Upcoming \[council\]/.test(pin(entry(es, 'Ilse'))), 'an upcoming event is shown as upcoming');
  assert(!/recording session/.test(pin(entry(es, 'Mira'))) && /done, reply 2/.test(entry(es, 'Mira').text), 'once it happened it leaves the pinned message');
  assert(!lib.allRecords(chat).some((r) => r.k === 'moment'), 'never turned into a moment');
});

test('recaps: repeated facts are not counted again, new ones are', () => {
  const chat = story2([
    { lines: ['- Lena | relationship: Tomas | sworn sister-in-arms since the siege of Varn', '- Lena | major moment | swore to retake Varn'] },
    { text: 'Recap of earlier events: Lena and Tomas swore their oath at Varn.', lines: ['- Lena | relationship: Tomas | sworn sister-in-arms since the siege of Varn', '- Lena | major moment | swore to retake Varn before winter', '- Lena | appearance | a burn scar across her left hand'] },
  ]);
  const recs = lib.allRecords(chat);
  assert.strictEqual(recs.filter((r) => r.k === 'relationship').length, 1);
  assert.strictEqual(recs.filter((r) => r.k === 'moment').length, 1);
  assert(recs.some((r) => r.k === 'appearance' && r.fromRecap), 'a new fact from a recap counts');
});

test('a scene filed as "where things stand" stays out of the pinned version; a real state stays in', () => {
  const chat = story([
    ['- Leeseo | where things stand: Jacek | close and trusting since the festival'],
    ['- Leeseo | where things stand: Jacek | she has no schedule tomorrow and stays with him tonight'],
  ]);
  const e = entry(lib.buildEntries(chat), 'Leeseo');
  assert(/close and trusting/.test(pin(e)) && !/no schedule/.test(pin(e)), pin(e));
  assert(/no schedule/.test(e.text), 'kept in the full entry');
});

test('a secret everyone knows becomes one short line; one told to a group stays a secret with the group as knower', () => {
  const chat = story([
    ['- Ren | secret | [the debt] he owes the guild a fortune', '- Everyone | knows | [the debt] it was read out in the square',
     '- Ren | secret | [the letter] he kept the queen\'s letter', '- The council | knows | [the letter] he showed it to the council'],
  ]);
  const t = lib.secretsText(chat);
  assert(/No longer secret \(everyone knows\): \[the debt\]/.test(t) && !/owes the guild a fortune/.test(t), t);
  assert(/\[the letter\][\s\S]*Knows: [^\n]*The council/.test(t), t);
});

test('a check-up closing a goal must quote its reply, and the quote must involve the people the goal is about', () => {
  const chat = story([
    ['- Ilse | promise | [tell about Bram] she will tell Ren if she talks to Bram'],
    [], [],
  ]);
  chat.log[1].text = 'Ilse confessed in the group chat that she beat Ada at cards and asked Ren not to tell.';
  chat.log[2].text = 'Ilse told Ren she had talked to Bram at the market and that it meant nothing.';
  lib.buildEntries(chat);
  const P = (line) => lib.closureProblem(chat, lib.parseRecords(line)[0], line);
  assert(/no quote/.test(P('- Ilse | done | [tell about Bram] she told him (reply 3)')));
  assert(/not in that reply/.test(P('- Ilse | done | [tell about Bram] she told him (reply 3) quote: "she confessed everything to Ren at dawn"')));
  assert(/Bram/.test(P('- Ilse | done | [tell about Bram] she confessed (reply 2) quote: "beat Ada at cards and asked Ren not to tell"')), 'wrong evidence: no Bram');
  assert.strictEqual(P('- Ilse | done | [tell about Bram] she told Ren (reply 3) quote: "told Ren she had talked to Bram at the market"'), '');
});

test('a place in a goal is not a person the evidence must name; goals set up together close together', () => {
  const chat = story([
    ['- Ilse | goal | [lantern trip] take Ren to the Harrow Market lanterns at dusk', '- Ren | goal | [lanterns with Ilse] go see the Harrow Market lanterns with Ilse at dusk'],
    [],
    ['- Ilse | done | [lantern trip] they saw the lanterns together'],
  ]);
  chat.log[1].text = 'Ilse and Ren walked under the lanterns at dusk.';
  lib.buildEntries(chat);
  const line = '- Ilse | done | [lantern trip] they saw the lanterns (reply 2) quote: "walked under the lanterns at dusk"';
  assert.strictEqual(lib.closureProblem(chat, lib.parseRecords(line)[0], line), '');
  const reg = lib.commitState(chat).reg;
  assert(reg.every((x) => x.state === 'done'), JSON.stringify(reg.map((x) => [x.id, x.state])));
});

test('Open Threads from the records: a thread about a finished goal is gone, an open goal shows where it stands, other lines are kept as not checked', () => {
  const chat = story([
    ['- Ilse | goal | [lantern trip] take Ren to see the harbour lanterns at dusk', '- Ren | major goal | [find the forger] find who forged the guild seal'],
    ['- Ren | progress | [find the forger] questioned the ink seller'],
    ['- Ilse | done | [lantern trip] they saw the harbour lanterns together'],
  ]);
  lib.buildEntries(chat);
  const out = lib.commitState(chat).openThreads('- Ilse still means to take Ren to the harbour lanterns at dusk.\n- A grey cat keeps following Ren through the docks.');
  assert(!/lantern/.test(out), out);
  assert(/find who forged the guild seal \[find-the-forger\] \(so far: questioned the ink seller\)/.test(out), out);
  assert(/grey cat .*\(not checked\)/.test(out), out);
});

test('the cast from the first message decides who is a character, even when the facts look like a place', () => {
  const chat = story([['- Harbour | type | place', '- Harbour | appearance | weathered hands and a grey coat'], ['- Harbour | minor moment | sold Ren a map']]);
  assert.strictEqual(entry(lib.buildEntries(chat), 'Harbour').kind, 'place');
  chat.setupCast = { text: 'x', cast: [{ name: 'Harbour', main: true }, { name: 'Ren', main: false }] };
  chat.entries = [];
  assert.strictEqual(entry(lib.buildEntries(chat), 'Harbour').kind, 'character');
});

test('profiles: the same trait in other words counts once in the pinned version (newest wording); the full entry keeps all', () => {
  const chat = story([
    ['- Ren | personality | fiercely loyal to his friends, even when it costs him'],
    ['- Ren | personality | blunt and impatient'],
    ['- Ren | personality | loyal to his friends above everything, whatever it costs him'],
  ]);
  const e = entry(lib.buildEntries(chat), 'Ren');
  assert.strictEqual((pin(e).match(/loyal/g) || []).length, 1, pin(e));
  assert(/above everything/.test(pin(e)) && /blunt/.test(pin(e)));
  assert.strictEqual((e.text.match(/loyal/g) || []).length, 2);
});

test('goal levels: a routine goal untouched for 10 replies is probably over; major stays; mentioning it again brings it back', () => {
  const quiet = Array.from({ length: 12 }, () => ['- Ren | minor moment | trained in the yard']);
  const chat = story([[
    '- Ren | major goal | [the crown] win the council\'s vote for the crown',
    '- Ren | routine goal | [the punch] fetch a cup of punch from the kitchen',
    '- Ren | routine promise | [the letter] will deliver the letter to Ilse',
  ]].concat(quiet));
  const es = lib.buildEntries(chat);
  const p = pin(entry(es, 'Ren'));
  assert(/the-crown/.test(p), 'major stays');
  assert(!/the-punch/.test(p) && /probably over/.test(entry(es, 'Ren').text), 'routine goal is probably over, kept in the full entry');
  assert(/the-letter/.test(p), 'a promise is never routine');
  // Mentioned again: back in the pinned message.
  chat.log.push({ id: 'r99', text: 'Ren finally went to fetch the punch from the kitchen.', records: [] });
  assert(/the-punch/.test(pin(entry(lib.buildEntries(chat), 'Ren'))));
});

test('a minor goal is not "probably over" while what it belongs to is still ahead; standing agreements never are', () => {
  const quiet = Array.from({ length: 55 }, () => ['- Ren | minor moment | trained in the yard']);
  const chat = story([[
    '- Ren | major goal | [the wedding] marry Ilse at the midsummer wedding',
    '- Ada | minor goal | [the flowers] gather wild roses for the midsummer wedding',
    '- Bram | minor goal | [the boat] repair the old fishing boat',
    '- Cora | minor goal | [cloud signal] say "grey sky" when she needs quiet support',
  ]].concat(quiet));
  lib.buildEntries(chat);
  chat.commitTier = { 'cloud-signal': 'arrangement' };
  const cs = lib.commitState(chat);
  const get = (id) => cs.reg.find((c) => c.id === id);
  assert(!get('the-flowers').stale, 'part of the wedding still ahead');
  assert(get('the-boat').stale, 'unrelated and quiet: probably over');
  assert(!get('cloud-signal').stale, 'an arrangement is never over');
  const e = lib.buildEntries(chat).find((x) => x.name === 'Cora');
  assert(/Standing agreement: say "grey sky"/.test(e.pinText || e.text) && !/Goal \[cloud-signal\]/.test(e.pinText || ''));
});

test('knowing is not undone; a group-chat disclosure is that group, not everyone; a trip is not a home; "not a goal" leaves the goals', () => {
  const chat = story([
    ['- Ilse | secret | [the debt] she owes the guild', '- Ren | knows | [the debt] Tomas explained it to him'],
    ['- Ren | does not know | [the debt]', '- Everyone | knows | [the debt] she posted it in the group chat'],
    ['- Ren | location | away in the capital for the trade meetings', '- Ren | location | the mill house by the river', '- Bram | minor goal | [the joke] marry a goat, he joked'],
  ]);
  chat.commitTier = { 'the-joke': 'none' };
  const sec = lib.buildSecrets(chat).find((x) => x.name === 'the debt');
  assert(sec.knows.some((k) => k.who === 'Ren'), 'Ren still knows');
  assert(!sec.everyone && sec.knows.some((k) => /group chat/i.test(k.who)), 'the group chat knows, not everyone');
  const es = lib.buildEntries(chat);
  const ren = es.find((e) => e.name === 'Ren');
  assert(/Lives \/ based: the mill house/.test(ren.pinText || ren.text) && !/capital/.test(ren.pinText || ren.text));
  const bram = es.find((e) => e.name === 'Bram');
  assert(!/Goal \[the-joke\]/.test(bram.pinText || '') && /Not a goal/.test(bram.text));
});

console.log(failed ? failed + ' of ' + n + ' genre checks failed.' : 'All ' + n + ' genre checks passed.');
process.exit(failed ? 1 : 0);
