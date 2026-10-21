// Checks which messages are labelled as recaps for the memory keeper.
//
//   node test/recap.test.js

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'story-manager.user.js'), 'utf8');
const defs = src.match(/ {2}const RECAP_START = .*\n {2}const RECAP_EARLY = .*\n/)[0];
const { RECAP_START, RECAP_EARLY } = new Function(defs + 'return { RECAP_START, RECAP_EARLY };')();
const isRecap = (t) => RECAP_START.test(t) || RECAP_EARLY.test(t.slice(0, 150));

const RECAPS = [
  'Recap: Mira saved Ash.',
  '**Previously:** they fled the city',
  '(OOC: recap of the last chat) Mira and Ash...',
  "Here's a quick recap of what happened: ...",
  '## Story so far\n- Mira met Ash',
  'Last time, we left off at the river',
  'Previously on our story...',
  'Summary of events: Mira was captured',
  'Quick summary of our story: ...',
  'In the last chat, Mira was captured',
];
const NOT_RECAPS = [
  'I recap my day to Ash',
  'Previously unseen, the door opens',
  'She smiles at you.',
  'So far away, the bells ring',
  'Last time I saw you, you were a child, she says',
  'Summary execution awaits the traitor',
];

let failed = 0;
for (const t of RECAPS) if (!isRecap(t)) { failed++; console.log('should be a recap:', JSON.stringify(t)); }
for (const t of NOT_RECAPS) if (isRecap(t)) { failed++; console.log('should not be a recap:', JSON.stringify(t)); }
if (failed) process.exit(1);
console.log('All ' + (RECAPS.length + NOT_RECAPS.length) + ' recap checks passed.');
