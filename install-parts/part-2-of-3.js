async function postJSON(url, headers, body) {
const gm = gmRequest();
let res;
if (gm) {
res = await new Promise((resolve, reject) => {
gm({
method: 'POST', url, headers, data: JSON.stringify(body), timeout: 180000,
onload: (r) => resolve({ status: r.status, text: r.responseText }),
onerror: () => reject(new Error('Network error contacting ' + new URL(url).hostname)),
ontimeout: () => reject(new Error('Timed out contacting ' + new URL(url).hostname)),
});
});
} else {
const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
res = { status: r.status, text: await r.text() };
}
let json = null;
try { json = JSON.parse(res.text); } catch (e) { /* ignore */ }
if (res.status < 200 || res.status >= 300) {
const msg = (json && json.error && (json.error.message || json.error)) || res.text;
throw new Error('HTTP ' + res.status + ': ' + String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 300));
}
if (!json) throw new Error('The AI service returned something that was not JSON');
return json;
}

async function callLLM(system, user) {
const s = settings;
const model = s.model || DEFAULT_MODELS[s.provider] || '';
if (s.provider !== 'miniapps' && !s.apiKey) throw new Error('No API key set (Story Manager → Settings)');
if (s.provider === 'anthropic') {
const d = await postJSON('https://api.anthropic.com/v1/messages', {
'Content-Type': 'application/json',
'x-api-key': s.apiKey,
'anthropic-version': '2023-06-01',
'anthropic-dangerous-direct-browser-access': 'true',
}, { model, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] });
return (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}
if (s.provider === 'openai') {
const base = (s.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
const d = await postJSON(base + '/chat/completions', {
'Content-Type': 'application/json',
Authorization: 'Bearer ' + s.apiKey,
}, { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
}
if (s.provider === 'gemini') {
const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) +
':generateContent?key=' + encodeURIComponent(s.apiKey);
const d = await postJSON(url, { 'Content-Type': 'application/json' }, {
systemInstruction: { parts: [{ text: system }] },
contents: [{ role: 'user', parts: [{ text: user }] }],
});
const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
return parts.map((p) => p.text || '').join('');
}
return callMiniApps(system + '\n\n' + user);
}

let toolCache = null;
async function callMiniApps(prompt) {
const slug = (settings.miniappsSlug || 'claude-37').trim();
if (!toolCache || toolCache.slug !== slug) {
const tool = await rpc('GET', '/tools/s/' + encodeURIComponent(slug) + '?lang=en');
if (!tool || !tool.id) throw new Error('MiniApps bot "' + slug + '" not found');
toolCache = {
slug,
id: tool.id,
revision: tool.revision || 1,
modelId: tool.modelId || (tool.model && tool.model.id) || tool.defaultModelId || '',
};
}
const res = await rpc('POST', '/chat', {
toolId: toolCache.id,
revision: toolCache.revision,
modelId: toolCache.modelId,
requestId: uuid4(),
elements: [{ type: 'text', text: prompt }],
language: 'en',
});
const cid = res && res.conversationId;
if (!cid) throw new Error('MiniApps did not start a conversation');
helperIds.add(cid);
let prev = null;
for (let i = 0; i < 80; i++) {
await sleep(3000);
const msgs = await fetchMessages(cid, { cache: false });
const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
const reply = msgs.slice(lastUser + 1).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
if (reply && reply === prev) return reply;
prev = reply || null;
}
if (prev) return prev;
throw new Error('MiniApps memory keeper did not answer in time');
}

function systemPrompt() {
return [
'You are the continuity editor for a long-running interactive story / roleplay chat.',
'You maintain a compact STORY MEMORY that is shown to the storyteller AI before every turn, so it never forgets important facts.',
'',
'Rules:',
'- Merge the NEW MESSAGES into the CURRENT MEMORY and output the complete, updated memory.',
'- Keep facts that matter for future continuity: names and identities, appearance, personality, abilities, relationships and how they changed, important past events, promises, secrets, goals, injuries and condition, key items and money, locations, world rules, the timeline (day/time), and the current scene.',
'- Keep facts from the current memory unless the story changed them. When something changes, update it; never leave contradictions.',
'- Never invent anything. Only record what actually happened or was stated.',
'- Write terse bullet points, not prose. No commentary, no warnings, no questions.',
'- Stay under ' + settings.maxChars + ' characters. When space is tight, compress older events into short summaries, but never drop character names, key relationships or unresolved plot threads.',
'- Use these sections (omit empty ones):',
'## Characters', '## Relationships', '## World & Places', '## Items & Status', '## Story So Far', '## Current Scene', '## Open Threads',
'',
'Output only the memory itself.',
].join('\n');
}

function formatMessages(msgs, botName) {
return msgs.map((m) => {
const who = m.role === 'user' ? 'USER' : (botName ? 'STORY AI (' + botName + ')' : 'STORY AI');
let t = m.text;
if (t.length > 8000) t = t.slice(0, 8000) + ' […]';
return who + ': ' + t;
}).join('\n\n');
}

function chunk(msgs, maxChars) {
const out = [];
let cur = [];
let size = 0;
for (const m of msgs) {
const len = Math.min(m.text.length, 8000) + 40;
if (cur.length && size + len > maxChars) { out.push(cur); cur = []; size = 0; }
cur.push(m);
size += len;
}
if (cur.length) out.push(cur);
return out;
}

function cleanOutput(t) {
return String(t || '').replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').replace(MEM_BLOCK_RE, '').trim();
}

async function mergeIntoMemory(chat, msgs) {
const user = 'CURRENT MEMORY:\n<<<\n' + (chat.memory.trim() || '(empty — this is the start)') + '\n>>>\n\n' +
(chat.pinned.trim() ? 'FACTS THE USER PINNED (always true, do not repeat them in the memory):\n<<<\n' + chat.pinned.trim() + '\n>>>\n\n' : '') +
'NEW MESSAGES (oldest first):\n<<<\n' + formatMessages(msgs, chat.title) + '\n>>>\n\n' +
'Write the complete updated STORY MEMORY now.';
const out = cleanOutput(await callLLM(systemPrompt(), user));
if (out.length < 40 || !/#|^\s*[-*•]/m.test(out)) {
throw new Error('Memory keeper gave an unusable answer: "' + out.slice(0, 120) + '"');
}
return out;
}

async function updateMemory(id, msgs, { force = false } = {}) {
const chat = await getChat(id, true);
if (busy[id] || (!chat.enabled && !force)) return;
const todo = unprocessed(chat, msgs);
if (!todo.length) return;
busy[id] = true;
setStatus();
const before = chat.memory;
try {
for (const part of chunk(todo, 14000)) {
chat.memory = await mergeIntoMemory(chat, part);
chat.processedIds = chat.processedIds.concat(part.map((m) => m.id)).slice(-300);
chat.processedCount = msgs.indexOf(part[part.length - 1]) + 1;
chat.lastUpdate = Date.now();
chat.lastError = '';
await saveChat(chat);
renderPanel();
}
if (before !== chat.memory) {
chat.history = [before].concat(chat.history).slice(0, 5);
}
await saveChat(chat);
} catch (e) {
chat.lastError = String(e.message || e);
await saveChat(chat);
toast('Story memory update failed: ' + chat.lastError, true);
} finally {
busy[id] = false;
setStatus();
renderPanel();
}
}


let learned = null;               // { template: 'https://…{id}…' }
const seenMsgs = {};              // chat id -> Map(message id -> message), this page visit only
const apiLog = [];                // recent API calls, for Diagnostics

function mergeMsgs(...lists) {
const map = new Map();
for (const list of lists) for (const m of list) map.set(m.id, m);
const out = [...map.values()];
if (out.length > 1 && out.every((m) => m.t)) out.sort((a, b) => a.t - b.t);
return out;
}

function remember(id, msgs) {
const prev = seenMsgs[id] ? [...seenMsgs[id].values()] : [];
const all = mergeMsgs(prev, msgs);
seenMsgs[id] = new Map(all.map((m) => [m.id, m]));
return all;
}

function shortUrl(url) {
try {
const u = new URL(url, location.href);
const q = [...u.searchParams.keys()].join(',');
return u.pathname.replace(new RegExp(UUID_RE.source, 'gi'), '{id}') + (q ? '?' + q : '');
} catch (e) { return String(url).slice(0, 80); }
}

function describe(data) {
if (data === null || data === undefined) return 'no data';
if (Array.isArray(data)) {
return 'array[' + data.length + ']' + (data[0] && typeof data[0] === 'object' ? ' item keys: ' + Object.keys(data[0]).slice(0, 12).join(',') : '');
}
if (typeof data !== 'object') return typeof data;
const parts = ['keys: ' + Object.keys(data).slice(0, 14).join(',')];
for (const [k, v] of Object.entries(data)) {
if (Array.isArray(v) && v.length) parts.push(k + '[' + v.length + ']' + (v[0] && typeof v[0] === 'object' ? ' {' + Object.keys(v[0]).slice(0, 12).join(',') + '}' : ''));
}
return parts.join(' | ');
}

function logApi(method, url, status, data, note) {
let found = 0;
try { found = extractMessages(data).length; } catch (e) { /* ignore */ }
apiLog.unshift({ method, url: shortUrl(url), status, info: describe(data), found, note: note || '' });
apiLog.length = Math.min(apiLog.length, 25);
}

function convIdFor(url, data, arr) {
const cands = [];
const first = arr && arr[0];
if (first && typeof first === 'object') cands.push(first.conversationId, first.conversation_id, first.conversation && first.conversation.id);
if (data && typeof data === 'object') cands.push(data.conversationId, data.conversation && data.conversation.id);
let decoded = url;
try { decoded = decodeURIComponent(url); } catch (e) { /* ignore */ }
const inUrl = (decoded.match(new RegExp(UUID_RE.source, 'gi')) || []).map((x) => x.toLowerCase());
const ids = cands.filter((c) => typeof c === 'string' && UUID_RE.test(c)).map((c) => c.toLowerCase());
const pick = ids.find((c) => inUrl.includes(c)) || inUrl.find((c) => c === currentId || chats[c]) || ids[0] || (inUrl.length === 1 ? inUrl[0] : null);
return pick && !helperIds.has(pick) ? { id: pick, inUrl: inUrl.includes(pick) } : null;
}

async function fetchLearned(id) {
const u = new URL(learned.template.split('{id}').join(id));
let opts = null;
try { opts = JSON.parse(u.searchParams.get('options') || 'null'); } catch (e) { /* ignore */ }
const paged = opts && typeof opts === 'object' && 'page' in opts;
const plainPaged = !paged && u.searchParams.has('page');
let all = [];
for (let page = 1; page <= 100; page++) {
if (paged) { opts.page = page; u.searchParams.set('options', JSON.stringify(opts)); }
else if (plainPaged) u.searchParams.set('page', String(page));
const data = await rpc('GET', u.href);
const msgs = extractMessages(data);
logApi('GET', u.href, 200, data, 'Story Manager, page ' + page);
const before = all.length;
all = mergeMsgs(all, msgs);
if (!paged && !plainPaged) break;
const per = Number((paged ? opts.itemsPerPage : u.searchParams.get('itemsPerPage')) || 0);
if (!msgs.length || all.length === before || (per && findMessageArray(data).length < per)) break;
}
return all;
}

async function fetchMessages(id, { cache = true } = {}) {
let msgs = [];
let firstErr = null;
try {
const data = await rpc('GET', '/conversations/' + id);
logApi('GET', 'https://api.miniapps.ai/conversations/' + id, 200, data, 'Story Manager');
msgs = extractMessages(data);
if (cache) {
const chat = await getChat(id, true);
const t = titleOf(data);
if (t && !chat.title) { chat.title = t; await saveChat(chat); }
}
} catch (e) { firstErr = e; logApi('GET', '/conversations/' + id, 'error', null, String(e.message || e)); }
if (learned && learned.template) {
try { msgs = mergeMsgs(msgs, await fetchLearned(id)); } catch (e) { firstErr = firstErr || e; logApi('GET', learned.template, 'error', null, String(e.message || e)); }
}
if (!msgs.length && firstErr && !cache) throw firstErr;
return cache ? remember(id, msgs) : msgs;
}

async function syncChat(id, msgs, { final }) {
if (helperIds.has(id)) return;
const chat = await getChat(id, true);
let usable = msgs;
if (!final && usable.length && usable[usable.length - 1].role === 'assistant') usable = usable.slice(0, -1);
chat.knownMessages = msgs.length;
const fresh = unprocessed(chat, usable).filter((m) => m.role === 'assistant').length;
await saveChat(chat);
if (id === currentId) renderPanel();
if (chat.enabled && fresh >= Math.max(1, Number(settings.updateEvery) || 1)) {
await updateMemory(id, usable);
}
}

async function waitForReply(id, userText) {
const token = {};
polls[id] = token;
const want = String(userText || '').trim().slice(0, 60);
let prev = null;
for (let i = 0; i < 75 && polls[id] === token; i++) {
await sleep(4000);
let msgs;
try { msgs = await fetchMessages(id); } catch (e) { continue; }
const last = msgs[msgs.length - 1];
if (!last || last.role !== 'assistant') { prev = null; continue; }
const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
const matches = !want || (lastUser && lastUser.text.includes(want));
if (last.text === prev && (matches || i >= 4)) {
if (polls[id] === token) delete polls[id];
await syncChat(id, msgs, { final: true });
return;
}
prev = last.text;
}
}


function on(type, fn) {
document.addEventListener('smx:' + type, (ev) => {
let d;
try { d = JSON.parse(ev.detail); } catch (e) { return; }
Promise.resolve(fn(d)).catch((e) => console.warn('[Story Manager]', e));
});
}

let lastSent = null;

const ready = (async () => {
settings = Object.assign({}, DEFAULT_SETTINGS, await Store.get('settings', {}));
chatIndex = await Store.get('chatIndex', []);
learned = await Store.get('learned', null);
for (const id of chatIndex) await getChat(id, false);
publishInjectMap();
})();

on('conv', async (d) => {
await ready;
if (helperIds.has(d.id)) return;
let data;
try { data = JSON.parse(d.text); } catch (e) { return; }
setCurrent(d.id);
logApi('GET', 'https://api.miniapps.ai/conversations/' + d.id, 200, data, 'site');
const chat = await getChat(d.id, true);
const t = titleOf(data);
if (t && !chat.title) chat.title = t;
await syncChat(d.id, remember(d.id, extractMessages(data)), { final: false });
});

on('api', async (d) => {
await ready;
let data = null;
try { data = d.text ? JSON.parse(d.text) : null; } catch (e) { /* not JSON */ }
logApi(d.method, d.url, d.status, data, 'site');
if (!data) return;
const arr = findMessageArray(data);
const msgs = extractMessages(data);
if (!msgs.some((m) => m.role === 'user') || !msgs.some((m) => m.role === 'assistant')) return;
const conv = convIdFor(d.url, data, arr);
if (!conv) return;
if (conv.inUrl && d.method === 'GET') {
const decoded = (() => { try { return decodeURIComponent(d.url); } catch (e) { return d.url; } })();
const template = decoded.split(conv.id).join('{id}');
if (!learned || learned.template !== template) {
learned = { template };
await Store.set('learned', learned);
}
}
setCurrent(conv.id);
await syncChat(conv.id, remember(conv.id, msgs), { final: false });
});

on('sent', async (d) => {
await ready;
lastSent = d;
if (!d.conversationId) return;
const chat = await getChat(d.conversationId, true);
chat.sentSinceInject = d.injected ? 1 : chat.sentSinceInject + 1;
await saveChat(chat);
});

on('sendResult', async (d) => {
await ready;
let data;
try { data = JSON.parse(d.text); } catch (e) { return; }
const id = data.conversationId || (data.conversation && data.conversation.id);
if (!id || helperIds.has(id)) return;
setCurrent(id);
const chat = await getChat(id, true);
if (lastSent && !lastSent.conversationId) {
chat.sentSinceInject += 1;
await saveChat(chat);
}
waitForReply(id, lastSent && lastSent.userText.replace(MEM_BLOCK_RE, ''));
});

function setCurrent(id) {
if (!id || id === currentId || helperIds.has(id)) return;
currentId = id;
renderPanel();
setStatus();
}

let lastHref = '';
setInterval(() => {
if (location.href === lastHref) return;
lastHref = location.href;
const m = location.href.match(UUID_RE);
if (m) ready.then(() => setCurrent(m[0].toLowerCase()));
}, 1000);


let root = null;
let ui = {};
let tab = 'memory';

// ===== END OF PART 2 of 3 (v1.1.0) =====
// ===== Tap on the empty line below, then paste PART 3 =====
