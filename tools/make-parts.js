// Splits story-manager.user.js into 3 pieces small enough to copy and paste on
// a phone (mobile clipboards cut off long pastes at about 20,000 characters).
//
//   node tools/make-parts.js
//
// Run it again after every change to the script.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'install-parts');
const PARTS = 3;
const LIMIT = 17000;

const src = fs.readFileSync(path.join(ROOT, 'story-manager.user.js'), 'utf8');
const lines = src.split('\n');
const version = (src.match(/@version\s+(\S+)/) || [])[1] || '?';

// Only cut right before a section header, so a cut never lands inside a
// function or a multi-line string.
const HEADER = /^  \/\/ -{20,}$/;
const cutCandidates = [];
for (let i = 1; i < lines.length - 1; i++) {
  if (HEADER.test(lines[i]) && /^  \/\/ \S/.test(lines[i + 1]) && !HEADER.test(lines[i - 1])) cutCandidates.push(i);
}

const offsets = [0];
for (const l of lines) offsets.push(offsets[offsets.length - 1] + l.length + 1);

const cuts = [];
for (let p = 1; p < PARTS; p++) {
  const target = (src.length * p) / PARTS;
  let best = null;
  for (const c of cutCandidates) {
    if (cuts.length && c <= cuts[cuts.length - 1]) continue;
    if (best === null || Math.abs(offsets[c] - target) < Math.abs(offsets[best] - target)) best = c;
  }
  cuts.push(best);
}

const bounds = [0, ...cuts, lines.length];
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);
for (let p = 0; p < PARTS; p++) {
  // Indentation is dropped to keep each part well under the paste limit; the
  // only multi-line string is CSS, where leading spaces do not matter.
  let body = lines.slice(bounds[p], bounds[p + 1]).map((l) => l.replace(/^ +/, '')).join('\n');
  if (p < PARTS - 1) {
    body += '\n// ===== END OF PART ' + (p + 1) + ' of ' + PARTS + ' (v' + version + ') =====' +
      '\n// ===== Tap on the empty line below, then paste PART ' + (p + 2) + ' =====\n';
  }
  if (body.length > LIMIT) throw new Error('Part ' + (p + 1) + ' is ' + body.length + ' characters; add more parts');
  const file = path.join(OUT, 'part-' + (p + 1) + '-of-' + PARTS + '.js');
  fs.writeFileSync(file, body);
  console.log(path.relative(ROOT, file), body.length, 'characters,', bounds[p + 1] - bounds[p], 'lines');
}
