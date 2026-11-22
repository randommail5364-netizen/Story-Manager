// Story Manager must work for any story: its code (outside comments) may not
// mention the names of any one story. Uses the character names in the real
// exports in test/data/ when there are any, plus a fixed list.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'story-manager.user.js'), 'utf8')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/ .*$/, '')).join('\n');
const names = new Set(['Jacek', 'Karina', 'Winter', 'Miyeon', 'Shuhua', 'Yujin', 'Wonyoung', 'Chaewon', 'Giselle', 'Ningning', 'Leeseo', 'Ahyeon', 'Irene', 'Tiffany', 'Minsoo', 'aespa', 'BABYMONSTER', 'Inkigayo']);
const dir = path.join(__dirname, 'data');
if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  try { for (const e of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).entries || []) if ((e.kind || 'character') === 'character' && /^[A-Z][a-z]{3,}$/.test(e.name)) names.add(e.name); } catch (e) { /* not an export */ }
}
const found = [...names].filter((n) => new RegExp('\\b' + n + '\\b').test(src));
if (found.length) { console.log('✗ story names in the code: ' + found.join(', ')); process.exit(1); }
console.log('✓ no story names in the code (' + names.size + ' names checked)');
