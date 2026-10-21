// ---------------------------------------------------------------------------
// Talking to the MiniApps API through the page hook
// ---------------------------------------------------------------------------

function rpc(method, path, body) {
return new Promise((resolve, reject) => {
const id = Math.random().toString(36).slice(2);
const evName = 'smx:rpc:' + id;
const timer = setTimeout(() => { document.removeEventListener(evName, onRes); reject(new Error('MiniApps request timed out')); }, 60000);
function onRes(ev) {
clearTimeout(timer);
document.removeEventListener(evName, onRes);
let d;
try { d = JSON.parse(ev.detail); } catch (e) { reject(new Error('Bad response')); return; }
let json = null;
try { json = d.text ? JSON.parse(d.text) : {}; } catch (e) { /* not JSON */ }
if (!d.ok) {
const msg = (json && json.message) || d.text || 'request failed';
reject(new Error('MiniApps HTTP ' + d.status + ': ' + String(msg).slice(0, 200)));
return;
}
resolve(json);
}
document.addEventListener(evName, onRes);
document.dispatchEvent(new CustomEvent('smx:rpc', { detail: JSON.stringify({ id, method, path, body }) }));
});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uuid4() {
if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
const r = Math.random() * 16 | 0;
return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
});
}

// ---------------------------------------------------------------------------
// Memory-keeper AI
// ---------------------------------------------------------------------------

function gmRequest() {
if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') return GM.xmlHttpRequest;
if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
return null;
}

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

// Uses one of the site's own chatbots as the memory keeper (costs MiniApps credits).
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
const msgs = extractMessages(await rpc('GET', '/conversations/' + cid));
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

// Fold every not-yet-processed message of a chat into its memory.
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

async function fetchMessages(id) {
const data = await rpc('GET', '/conversations/' + id);
const chat = await getChat(id, true);
const t = titleOf(data);
if (t && !chat.title) { chat.title = t; await saveChat(chat); }
return extractMessages(data);
}

// Called whenever we see (part of) a chat's history.
async function syncChat(id, msgs, { final }) {
if (helperIds.has(id)) return;
const chat = await getChat(id, true);
// While the AI may still be typing, ignore its last message for now.
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

// After a message is sent, wait for the AI to finish its reply, then sync.
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

// ---------------------------------------------------------------------------
// Events from the page hook
// ---------------------------------------------------------------------------

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
for (const id of chatIndex) await getChat(id, false);
publishInjectMap();
})();

on('conv', async (d) => {
await ready;
if (helperIds.has(d.id)) return;
let data;
try { data = JSON.parse(d.text); } catch (e) { return; }
setCurrent(d.id);
const chat = await getChat(d.id, true);
const t = titleOf(data);
if (t && !chat.title) chat.title = t;
await syncChat(d.id, extractMessages(data), { final: false });
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
// First message of a brand new chat.
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

// Single-page app: also pick the chat id up from the address bar.
let lastHref = '';
setInterval(() => {
if (location.href === lastHref) return;
lastHref = location.href;
const m = location.href.match(UUID_RE);
if (m) ready.then(() => setCurrent(m[0].toLowerCase()));
}, 1000);

// ===== END OF PART 2 of 3 (v1.0.2) =====
// ===== Tap on the empty line below, then paste PART 3 =====
