// Tests on real stories: run every "Export for testing" file in test/data/
// (kept out of git: it holds story content) through the current code and
// check what the memory must always get right. Prints a baseline report.
//   node test/real.test.js            all files
//   node test/real.test.js name.json  one file
'use strict';
const fs = require('fs');
const path = require('path');

// The same pieces of the userscript the unit tests use.
const unit = fs.readFileSync(path.join(__dirname, 'entries.test.js'), 'utf8');
const end = unit.indexOf("')();", unit.indexOf('const lib = new Function(')) + 5;
const lib = new Function('require', '__dirname', unit.slice(0, end).replace(/^'use strict';/, '') + '\nreturn lib;')(require, __dirname);
const src = fs.readFileSync(path.join(__dirname, '..', 'story-manager.user.js'), 'utf8');
const NOT_HOME_RE = eval(src.match(/const NOT_HOME_RE = (\/.*\/i);/)[1]);
const sig = (t) => lib.sigWords(t);
const overlap = (a, b) => { const x = sig(a), y = sig(b); if (!x.size || !y.size) return 0; let n = 0; for (const w of x) if (y.has(w)) n++; return n / Math.min(x.size, y.size); };

function chatOf(ex) {
  return {
    format: ex.format, ignored: ex.ignored || [], entries: [], secretAlias: ex.secretAlias || {}, keptMoments: ex.keptMoments || [],
    commitReg: ex.commitReg || [], commitAlias: ex.commitAlias || {}, commitTier: ex.commitTier || {}, setupCast: ex.setupCast || null, sortings: ex.sortings || {}, manualRecords: ex.manualRecords || [], hiddenRecords: ex.hiddenRecords || [], reconRecords: ex.reconRecords || [],
    relMap: ex.relMap, portraits: ex.portraits || {}, memory: ex.memory || '', pinned: ex.pinnedNote || '',
    chapters: ex.chapters || [], log: ex.log.map((e) => ({ id: e.id, text: e.summary, records: e.records, chapter: e.chapter, folded: e.folded, hc: e.helperChat, hp: e.helperPos })),
  };
}
const section = (t, title) => { const m = String(t).match(new RegExp('## ' + title + '\\n([\\s\\S]*?)(?=\\n## |$)')); return m ? m[1] : ''; };

let failed = 0;
function check(ok, what, detail) {
  if (ok) console.log('  ✓ ' + what);
  else { failed++; console.log('  ✗ ' + what + (detail ? '\n      ' + String(detail).split('\n').slice(0, 8).join('\n      ') : '')); }
}

function run(file) {
  const ex = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('\n' + path.basename(file) + ' (exported by v' + ex.smVersion + ', ' + ex.log.length + ' replies)');
  const chat = chatOf(ex);
  const es = lib.buildEntries(chat);
  const secs = lib.buildSecrets(chat);

  // Deterministic: building twice gives the same memory.
  const again = lib.buildEntries(chatOf(ex));
  check(JSON.stringify(es.map((e) => [e.name, e.text, e.pinText, e.miniText])) === JSON.stringify(again.map((e) => [e.name, e.text, e.pinText, e.miniText])), 'building twice gives the same entries');
  check(JSON.stringify(secs) === JSON.stringify(lib.buildSecrets(chatOf(ex))), 'building twice gives the same secrets');

  // Nothing is lost: every person in the exported memory is still there.
  const names = new Set(es.map((e) => e.name.toLowerCase()));
  // (Names saved with stray quotes or list marks by older versions now join the real person.)
  const lost = (ex.entries || []).filter((e) => !names.has(e.name.replace(/^["“'\s*•-]+|["”'\s]+$/g, '').toLowerCase())).map((e) => e.name);
  check(!lost.length, 'every entry from the export still exists', lost.join(', '));

  // Secrets: the owner knows their own secret; nobody "knows" a secret their note says they do not.
  const ownerNot = secs.filter((x) => x.notKnows.some((p) => (x.owners || []).some((o) => o.toLowerCase() === p.who.toLowerCase())));
  check(!ownerNot.length, 'no one is listed as not knowing their own secret', ownerNot.map((x) => x.name).join(', '));
  const denied = secs.flatMap((x) => x.knows.filter((k) => /\b(does not|doesn't|did not) know\b/i.test(k.how || '')).map((k) => x.name + ': ' + k.who));
  check(!denied.length, 'no "knows" that says it does not know', denied.join('\n'));
  const twins = [];
  for (let i = 0; i < secs.length; i++) for (let j = i + 1; j < secs.length; j++) {
    const a = secs[i], b = secs[j];
    const sameOwner = (a.owners || []).join() && (a.owners || []).join() === (b.owners || []).join();
    if (sameOwner && overlap(a.text, b.text) >= 0.5) twins.push(a.name + ' / ' + b.name);
  }
  check(!twins.length, 'no secret of one person listed twice', twins.join('\n'));

  // Pinned versions: a finished goal is never open; homes are homes; group lines are not relationships.
  const pin = (e) => (e.pinText != null ? e.pinText : e.text);
  const homes = es.flatMap((e) => pin(e).split('\n').filter((l) => /^- Lives \/ based:/.test(l) && NOT_HOME_RE.test(l)).map((l) => e.name + ': ' + l));
  check(!homes.length, 'no scene is shown as a home', homes.join('\n'));
  const groups = es.flatMap((e) => pin(e).split('\n').filter((l) => /^- [^:]*(,|&)[^:]*:/.test(l) && /Where things stand/.test(l)).map((l) => e.name + ': ' + l));
  check(!groups.length, 'no group line among relationships', groups.join('\n'));
  const recs = lib.allRecords(chat);
  const dones = recs.filter((r) => r.k === 'done');
  const stillOpen = [];
  for (const e of es) {
    const open = pin(e).split('\n').filter((l) => /^- (Goal|Promise)( \[[^\]]*\])?( \([^)]*\))?:/.test(l));
    for (const l of open) if (dones.some((d) => d.s.toLowerCase() === e.name.toLowerCase() && overlap(l.replace(/^- \w+: /, ''), d.v) >= 0.6)) stillOpen.push(e.name + ': ' + l);
  }
  // Since v3.42 a goal closes only through its own [name] or a close match, never through a plan; open
  // goals that merely resemble some "done" line are listed for a look, not failed.
  if (stillOpen.length) console.log('  ⚠ open goals that resemble a "done" line (check by hand):\n      ' + stillOpen.join('\n      '));
  // A statement of intent or an unrelated action never completes a goal.
  const cs = lib.commitState(chat);
  const INTENT = /^\s*(plan(s|ned|ning)?|intend(s|ed)?|will|would|wants? to|decided to|agreed to|promised to|is going to|prepar(es|ed|ing) to)\b/i;
  const falseDone = cs.reg.filter((c) => c.state === 'done' && INTENT.test(c.how || '')).map((c) => c.who + ' [' + c.id + ']: ' + c.how);
  check(!falseDone.length, 'no goal is completed by a statement of intent', falseDone.join('\n'));
  // Open Threads vs goals: threads that clearly are a finished goal are left out of the pinned message.
  const threadLines = lib.tidyBullets(section(chat.memory, 'Open Threads').trim()).split('\n').filter((l) => /^\s*[-*•]\s/.test(l));
  const hidden = threadLines.map((l) => [l, cs.closedThread(l)]).filter(([, c]) => c);
  const closedIds = new Set(cs.reg.filter((c) => c.state === 'done' || c.state === 'cancelled').map((c) => c));
  const disagree = threadLines.filter((l) => !cs.closedThread(l) && [...closedIds].some((c) => overlap(c.text, l) >= 0.9) && !cs.reg.some((c) => c.state !== 'done' && c.state !== 'cancelled' && overlap(c.text, l) >= 0.5));
  check(!disagree.length, 'no pinned thread is a goal that is already done or cancelled', disagree.join('\n'));
  if (hidden.length) console.log('  · ' + hidden.length + ' threads left out as finished goals:\n      ' + hidden.map(([l, c]) => l.trim().slice(0, 90) + '  ← [' + c.id + '] ' + c.state).join('\n      '));
  // Sorting never files anything as "where things stand"; every sorted fact keeps its original.
  const sortedRecs = recs.filter((r) => r.sortedBy);
  check(!sortedRecs.some((r) => r.k === 'stands'), 'no sorted fact is in "where things stand"', sortedRecs.filter((r) => r.k === 'stands').slice(0, 5).map((r) => r.s + ': ' + r.v).join('\n'));
  check(sortedRecs.every((r) => r.orig && r.orig.v), 'every sorted fact keeps its original');
  console.log('  · commitments: ' + cs.reg.length + ' (open ' + cs.reg.filter((c) => c.state === 'open').length + ', done ' + cs.reg.filter((c) => c.state === 'done').length + ', cancelled ' + cs.reg.filter((c) => c.state === 'cancelled').length + ', postponed ' + cs.reg.filter((c) => c.state === 'postponed').length + ')');
  const repeatGoals = [], maybeGoals = [];
  for (const e of es) {
    const open = pin(e).split('\n').filter((l) => /^- (Goal|Promise)( \[[^\]]*\])?( \([^)]*\))?:/.test(l)).map((l) => l.replace(/^- \w+( \[[^\]]*\])?( \([^)]*\))?: /, ''));
    for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) { const v = overlap(open[i], open[j]); if (v >= 0.6) (v >= 0.75 ? repeatGoals : maybeGoals).push(e.name + ': ' + open[i] + ' / ' + open[j]); }
  }
  check(!repeatGoals.length, 'no goal or promise listed twice (clear repeats)', repeatGoals.join('\n'));
  // Unclear pairs stay separate on purpose (a wrong merge could erase an obligation); the check-up may merge them.
  if (maybeGoals.length) console.log('  ⚠ ' + maybeGoals.length + ' possible repeats left separate for the check-up:\n      ' + maybeGoals.join('\n      '));

  // Who people are survives in the shorter versions.
  const persona = es.filter((e) => /### Personality/.test(e.text) && !/### Personality|### Who they are now/.test((e.pinText || e.text) + (e.miniText || '')));
  check(!persona.length, 'everyone with a personality keeps it (or a portrait) in the pinned message', persona.map((e) => e.name).join(', '));

  // World: one time; no point twice.
  const world = lib.tidyBullets(section(chat.memory, 'World & Timeline').trim(), true);
  const times = world.split('\n').filter((l) => /^\s*[-*•]\s+\**\s*(time|date|when)\s*\**\s*:/i.test(l));
  check(times.length <= 1, 'the world has at most one time', times.join('\n'));

  // Moments.
  const ms = recs.filter((r) => r.k === 'moment');
  const without = chat.log.filter((e) => !(e.records || []).some((r) => r.k === 'moment')).length;
  // A warning, not a failure: some replies hold nothing worth a moment.
  if (without > chat.log.length * 0.2) console.log('  ⚠ ' + without + ' of ' + chat.log.length + ' replies have no moment (warning)');

  // Fact quality: nothing silently lost; facts that fail their kind's check are kept (full entry), not pinned.
  const q = lib.factQuality(chat);
  const bad = q.filter((x) => x.status === 'no-secret' || x.status === 'unresolved' || x.status === 'unclassified');
  const full = es.map((e) => e.text).join('\n');
  // ("Everyone | knows …" has no entry of its own: it stays in the log, counted here.)
  const everyone = bad.filter((x) => /^(everyone|everybody|all|the group|public)$/i.test(x.r.s.trim()));
  if (everyone.length) console.log('  · ' + everyone.length + ' failed facts about "everyone" are kept in the log only (no entry of their own)');
  const missing = bad.filter((x) => !everyone.includes(x) && !full.includes(String(x.r.v).slice(0, 40)));
  check(!missing.length, 'every fact that fails its check is kept in a full entry', missing.slice(0, 5).map((x) => x.r.s + ' | ' + x.r.k + ' | ' + x.r.v).join('\n'));
  const pinnedAll = es.map((e) => pin(e) + '\n' + (e.miniText || '')).join('\n');
  check(!/### Unsorted/.test(pinnedAll), 'unsorted facts are not in the pinned versions');
  const sm = lib.storyMoments(chat);

  // Baseline report (numbers to compare versions by).
  const threads = section(chat.memory, 'Open Threads').split('\n').filter((l) => /^\s*[-*•]/.test(l));
  const staleWords = /\b(tomorrow|tonight|today|this morning|this evening|later today)\b/i;
  console.log('  report:');
  console.log('    facts ' + recs.length + ' · entries ' + es.length + ' · secrets ' + secs.length);
  console.log('    moments ' + ms.length + ' (major ' + ms.filter((r) => r.tier === 'major' || r.tier === 'turning' || r.imp).length + ', minor ' + ms.filter((r) => r.tier === 'minor').length + ', routine ' + ms.filter((r) => r.tier === 'routine').length + ') · replies without a moment ' + without + ' · story moments shown ' + sm.lines.length);
  console.log('    open threads ' + threads.length + ', of which say "today/tomorrow/tonight" ' + threads.filter((l) => staleWords.test(l)).length);
  console.log('    world lines ' + world.split('\n').filter((l) => /^\s*[-*•]/.test(l)).length + ' (before tidying ' + section(chat.memory, 'World & Timeline').split('\n').filter((l) => /^\s*[-*•]/.test(l)).length + ')');
  console.log('    open goals and promises ' + es.reduce((n, e) => n + pin(e).split('\n').filter((l) => /^- (Goal|Promise)( \[[^\]]*\])?( \([^)]*\))?:/.test(l)).length, 0) + ' · repeated ' + repeatGoals.length);
  console.log('    exported pinned message ' + (ex.pinnedMessage || '').length + ' characters');
  const cnt = (list) => list.reduce((m, x) => (m[x.status] = (m[x.status] || 0) + 1, m), {});
  const ok = (list) => (list.length ? Math.round(100 * list.filter((x) => x.status === 'ok').length / list.length) + '%' : '-');
  const fromLog = q.filter((x) => !x.r.recon && x.r.at !== Infinity);
  console.log('    fact quality: ' + JSON.stringify(cnt(fromLog)) + ' · ok ' + ok(fromLog) + ' (log ' + ex.log.reduce((a, e) => a + e.records.length, 0) + ', check-up ' + (ex.reconRecords || []).length + ', manual ' + (ex.manualRecords || []).length + ')');
  const n = chat.log.length, step = Math.ceil(n / 5);
  const r = [];
  for (let a = 1; a <= n; a += step) { const b = Math.min(n, a + step - 1); r.push(a + '–' + b + ' ' + ok(fromLog.filter((x) => x.r.at >= a && x.r.at <= b))); }
  console.log('    ok by replies: ' + r.join(', '));
  const withPos = fromLog.filter((x) => (chat.log[x.r.at - 1] || {}).hp);
  console.log('    by helper chat position: ' + (withPos.length ? [[1, 5], [6, 15], [16, 30], [31, 1e9]].map(([a, b]) => a + '–' + b + ' ' + ok(withPos.filter((x) => chat.log[x.r.at - 1].hp >= a && chat.log[x.r.at - 1].hp <= b))).join(', ') : 'not recorded in this export'));
}

const dir = path.join(__dirname, 'data');
const args = process.argv.slice(2);
const files = args.length ? args.map((a) => (path.isAbsolute(a) ? a : path.join(dir, a))) : (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)) : []);
if (!files.length) { console.log('No exported stories in test/data/ — nothing to check.'); process.exit(0); }
for (const f of files) run(f);
console.log(failed ? '\n' + failed + ' real-story checks failed.' : '\nAll real-story checks passed.');
process.exit(failed ? 1 : 0);
