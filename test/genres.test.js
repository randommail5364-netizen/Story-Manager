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

console.log(failed ? failed + ' of ' + n + ' genre checks failed.' : 'All ' + n + ' genre checks passed.');
process.exit(failed ? 1 : 0);
