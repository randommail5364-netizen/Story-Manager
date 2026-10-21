// ==UserScript==
// @name         MiniApps Story Manager
// @namespace    https://github.com/randommail5364-netizen/Story-Manager
// @version      1.1.0
// @description  Keeps an automatic "story memory" for every MiniApps.ai chat and quietly feeds it back to the AI so it never forgets important facts.
// @match        https://miniapps.ai/*
// @match        https://*.miniapps.ai/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @connect      api.anthropic.com
// @connect      api.openai.com
// @connect      openrouter.ai
// @connect      generativelanguage.googleapis.com
// @connect      *
// ==/UserScript==

/*
* How it works
* ------------
* 1. A small hook runs inside the MiniApps page and watches the same API calls
*    the website makes (endpoints documented by the MiniappsAI-API project:
*    POST /chat, GET /conversations/{id}, GET /tools/s/{slug}).
* 2. Whenever a chat's history is loaded or the AI finishes a reply, new
*    messages are handed to a "memory keeper" AI, which merges them into a
*    compact, per-chat STORY MEMORY (characters, relationships, plot, ...).
* 3. Every time you send a message, the memory is silently attached to it, so
*    the storyteller AI always has the important facts in front of it, even
*    after old messages have fallen out of its context window.
*/

(function () {
'use strict';

let stage = 'starting';
let uiStarted = false;
setTimeout(() => {
if (!uiStarted) alert('Story Manager did not finish starting (stuck at: ' + stage + '). Please send this message to Claude.');
}, 15000);

const MEM_START = '[[STORY-MEMORY]]';
const MEM_END = '[[/STORY-MEMORY]]';
const MEM_BLOCK_RE = /\[\[STORY-MEMORY\]\][\s\S]*?\[\[\/STORY-MEMORY\]\]\s*/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;


function pageHook(win) {
if (win.__smxHooked) return;
win.__smxHooked = true;
const doc = win.document;
if (doc.documentElement) doc.documentElement.setAttribute('data-smx-hook', '1');

const sandboxed = typeof exportFunction === 'function' && typeof cloneInto === 'function';
const expFn = (fn, target) => (sandboxed ? exportFunction(fn, target) : fn);
const toPage = (obj) => (sandboxed ? cloneInto(obj, win) : obj);

const origFetch = win.fetch.bind(win);
const state = { headers: {}, apiBase: 'https://api.miniapps.ai' };

function emit(type, data) {
doc.dispatchEvent(new win.CustomEvent('smx:' + type, toPage({ detail: JSON.stringify(data) })));
}

function classify(method, url) {
let u;
try { u = new win.URL(String(url), win.location.href); } catch (e) { return null; }
if (!/(^|\.)miniapps\.ai$/i.test(u.hostname)) return null;
const path = u.pathname.replace(/\/+$/, '');
let m;
if (method === 'POST' && (m = path.match(/^(.*)\/chat$/))) {
state.apiBase = u.origin + m[1];
return { kind: 'send' };
}
if (method === 'GET' && (m = path.match(/^(.*)\/conversations\/([0-9a-f-]{36})$/i))) {
state.apiBase = u.origin + m[1];
return { kind: 'conv', id: m[2] };
}
return { kind: 'other', method, url: u.href };
}

function captureHeader(name, value) {
const k = String(name).toLowerCase();
if (k === 'x-csrf-token' || k === 'authorization') state.headers[k] = String(value);
}

function captureHeaders(h) {
if (!h) return;
try {
if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => captureHeader(k, v));
else if (Array.isArray(h)) h.forEach((p) => captureHeader(p[0], p[1]));
else Object.keys(h).forEach((k) => captureHeader(k, h[k]));
} catch (e) { /* ignore */ }
}

function rewriteSend(bodyStr) {
let body;
try { body = JSON.parse(bodyStr); } catch (e) { return bodyStr; }
if (!body || typeof body !== 'object') return bodyStr;
const convId = body.conversationId || null;
let injected = false;
let userText = '';
const textEl = Array.isArray(body.elements)
? body.elements.find((e) => e && e.type === 'text' && typeof e.text === 'string')
: null;
userText = textEl ? textEl.text : (typeof body.text === 'string' ? body.text : '');
if (convId) {
let map = {};
try { map = JSON.parse(doc.documentElement.getAttribute('data-smx-inject') || '{}'); } catch (e) { /* ignore */ }
const block = map[convId];
if (block) {
if (textEl) { textEl.text = block + '\n\n' + textEl.text; injected = true; }
else if (typeof body.text === 'string') { body.text = block + '\n\n' + body.text; injected = true; }
}
}
emit('sent', { conversationId: convId, injected, userText });
return injected ? JSON.stringify(body) : bodyStr;
}

function report(info, text, status) {
if (info.kind === 'send') emit('sendResult', { text });
else if (info.kind === 'conv') emit('conv', { id: info.id, text });
else if (info.kind === 'other') emit('api', { method: info.method, url: info.url, status, text: text && text.length < 3000000 ? text : '' });
}

win.fetch = expFn(function (input, init) {
let info = null;
try {
const url = typeof input === 'string' ? input : (input && input.url) || String(input);
const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
info = classify(method, url);
if (info) {
if (input && typeof input === 'object' && input.headers) captureHeaders(input.headers);
if (init) captureHeaders(init.headers);
if (info.kind === 'send' && init && typeof init.body === 'string') {
init = toPage(Object.assign({}, init, { body: rewriteSend(init.body) }));
}
}
} catch (e) { info = null; }
const p = origFetch(input, init);
if (info && (info.kind === 'send' || info.kind === 'conv')) {
p.then((r) => (r.ok ? r.clone().text() : null))
.then((t) => { if (t) report(info, t); })
.catch(() => {});
} else if (info && info.kind === 'other') {
p.then((r) => (r.ok ? r.clone().text() : '').then((t) => report(info, t, r.status)))
.catch(() => {});
}
return p;
}, win);

const XP = win.XMLHttpRequest.prototype;
const oOpen = XP.open;
const oSend = XP.send;
const oSet = XP.setRequestHeader;
XP.open = expFn(function (method, url) {
try { this.__smx = classify(String(method).toUpperCase(), url); } catch (e) { this.__smx = null; }
return oOpen.apply(this, arguments);
}, XP);
XP.setRequestHeader = expFn(function (k, v) {
if (this.__smx) captureHeader(k, v);
return oSet.apply(this, arguments);
}, XP);
XP.send = expFn(function (body) {
const info = this.__smx;
if (info) {
try {
if (info.kind === 'send' && typeof body === 'string') body = rewriteSend(body);
const xhr = this;
xhr.addEventListener('load', function () {
try {
const ok = xhr.status >= 200 && xhr.status < 300;
if (!ok && info.kind !== 'other') return;
let t = '';
if (ok && (!xhr.responseType || xhr.responseType === 'text')) t = xhr.responseText;
else if (ok && xhr.responseType === 'json') t = JSON.stringify(xhr.response);
if (t || info.kind === 'other') report(info, t, xhr.status);
} catch (e) { /* ignore */ }
});
} catch (e) { /* ignore */ }
}
return oSend.call(this, body);
}, XP);

doc.addEventListener('smx:rpc', function (ev) {
let req;
try { req = JSON.parse(ev.detail); } catch (e) { return; }
const headers = Object.assign({ Accept: 'application/json, text/plain, */*' }, state.headers);
const opts = { method: req.method || 'GET', headers, credentials: 'include' };
if (req.body !== undefined) {
headers['Content-Type'] = 'application/json';
opts.body = JSON.stringify(req.body);
}
const csrf = opts.method === 'GET' || state.headers['x-csrf-token']
? Promise.resolve()
: origFetch(state.apiBase + '/auth/csrf', toPage({ credentials: 'include' }))
.then((r) => r.json())
.then((d) => { if (d && d.csrfToken) headers['x-csrf-token'] = state.headers['x-csrf-token'] = d.csrfToken; })
.catch(() => {});
const target = /^https:\/\/([a-z0-9-]+\.)*miniapps\.ai\//i.test(req.path) ? req.path : state.apiBase + req.path;
csrf.then(() => origFetch(target, toPage(opts)))
.then((r) => r.text().then((text) => emit('rpc:' + req.id, { ok: r.ok, status: r.status, text })))
.catch((e) => emit('rpc:' + req.id, { ok: false, status: 0, text: String(e) }));
});
}

function installPageHook() {
const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
if (W === window) { pageHook(window); return; }
try {
const s = document.createElement('script');
s.textContent = '(' + pageHook.toString() + ')(window);';
(document.head || document.documentElement).appendChild(s);
s.remove();
} catch (e) { /* ignore */ }
if (!document.documentElement || document.documentElement.getAttribute('data-smx-hook') !== '1') {
try { pageHook(W); } catch (e) { console.warn('[Story Manager] could not hook the page', e); }
}
}

stage = 'hooking the page';
try { installPageHook(); } catch (e) { console.warn('[Story Manager] could not hook the page', e); }
stage = 'loading storage';


let hasGM = typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function';
let hasGMLegacy = typeof GM_getValue === 'function';

function withTimeout(promise, ms) {
return Promise.race([promise, new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

const Store = {
async get(key, def) {
try {
let raw;
try {
if (hasGM) raw = await withTimeout(GM.getValue(key), 3000);
else if (hasGMLegacy) raw = GM_getValue(key);
else raw = localStorage.getItem('smx:' + key);
} catch (e) {
if (!hasGM && !hasGMLegacy) throw e;
console.warn('[Story Manager] userscript storage failed, using browser storage', e);
hasGM = hasGMLegacy = false;
raw = localStorage.getItem('smx:' + key);
}
if (raw === undefined || raw === null) return def;
return typeof raw === 'string' ? JSON.parse(raw) : raw;
} catch (e) { return def; }
},
async set(key, value) {
const raw = JSON.stringify(value);
try {
if (hasGM) await withTimeout(GM.setValue(key, raw), 3000);
else if (hasGMLegacy) GM_setValue(key, raw);
else localStorage.setItem('smx:' + key, raw);
} catch (e) { console.warn('[Story Manager] could not save', e); }
},
};

const DEFAULT_SETTINGS = {
provider: 'miniapps', // miniapps | gemini | anthropic | openai
apiKey: '',
model: '',
baseUrl: 'https://openrouter.ai/api/v1',
miniappsSlug: 'claude-37',
updateEvery: 3,   // AI replies between memory updates
injectEvery: 1,   // attach memory to every Nth message (0 = never)
maxChars: 3000,   // target size of the memory
autoEnable: true, // manage new chats automatically
buttonSide: 'right',
};

const DEFAULT_MODELS = {
gemini: 'gemini-2.5-flash',
anthropic: 'claude-haiku-5-5',
openai: 'openai/gpt-4o-mini',
};

let settings = Object.assign({}, DEFAULT_SETTINGS);
let chatIndex = [];           // ids of every chat we have state for
const chats = {};             // id -> chat state (cache)
let currentId = null;
const busy = {};              // id -> true while a memory update runs
const polls = {};             // id -> poll token
const helperIds = new Set();  // conversations created by the memory keeper itself

function newChat(id) {
return {
id,
title: '',
enabled: settings.autoEnable,
memory: '',
pinned: '',
processedIds: [],
processedCount: 0,
sentSinceInject: 0,
lastUpdate: 0,
lastError: '',
history: [],
knownMessages: 0,
};
}

async function getChat(id, create) {
if (chats[id]) return chats[id];
const saved = await Store.get('chat:' + id, null);
if (saved) {
chats[id] = Object.assign(newChat(id), saved);
return chats[id];
}
if (!create) return null;
chats[id] = newChat(id);
if (!chatIndex.includes(id)) {
chatIndex.push(id);
await Store.set('chatIndex', chatIndex);
}
await saveChat(chats[id]);
return chats[id];
}

async function saveChat(chat) {
await Store.set('chat:' + chat.id, chat);
publishInjectMap();
}


function buildBlock(chat) {
const parts = [];
if (chat.pinned.trim()) parts.push('## Must remember\n' + chat.pinned.trim());
if (chat.memory.trim()) parts.push(chat.memory.trim());
if (!parts.length) return '';
return MEM_START + '\n(Background notes for story continuity. Use them silently; do not quote, mention or reply to them.)\n\n' +
parts.join('\n\n') + '\n' + MEM_END;
}

function publishInjectMap() {
const map = {};
const every = Number(settings.injectEvery) || 0;
if (every > 0) {
for (const id of Object.keys(chats)) {
const c = chats[id];
if (!c.enabled) continue;
if (c.sentSinceInject > 0 && c.sentSinceInject < every) continue;
const block = buildBlock(c);
if (block) map[id] = block;
}
}
if (document.documentElement) document.documentElement.setAttribute('data-smx-inject', JSON.stringify(map));
else setTimeout(publishInjectMap, 50);
}


function looksLikeMessage(o) {
return o && typeof o === 'object' && !Array.isArray(o) &&
('origin' in o || 'role' in o || 'sender' in o || 'author' in o) &&
('elements' in o || 'text' in o || 'content' in o || 'message' in o);
}

function findMessageArray(data) {
if (!data || typeof data !== 'object') return [];
for (const k of ['messages', 'chatMessages', 'items']) {
if (Array.isArray(data[k]) && data[k].some(looksLikeMessage)) return data[k];
}
if (Array.isArray(data) && data.some(looksLikeMessage)) return data;
const queue = [[data, 0]];
while (queue.length) {
const [node, depth] = queue.shift();
if (depth > 4 || !node || typeof node !== 'object') continue;
for (const v of Object.values(node)) {
if (Array.isArray(v) && v.some(looksLikeMessage)) return v;
if (v && typeof v === 'object') queue.push([v, depth + 1]);
}
}
return [];
}

function textOf(m) {
if (Array.isArray(m.elements)) {
const t = m.elements.filter((e) => e && typeof e.text === 'string').map((e) => e.text).join('\n');
if (t) return t;
}
for (const k of ['text', 'content', 'message']) {
const v = m[k];
if (typeof v === 'string') return v;
if (Array.isArray(v)) return v.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n');
}
return '';
}

function roleOf(m) {
const r = String(m.origin || m.role || m.sender || m.author || '').toLowerCase();
if (/system/.test(r)) return 'system';
if (/user|human/.test(r) || m.isUser === true) return 'user';
return 'assistant';
}

function hashText(t) {
let h = 5381;
for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
return (h >>> 0).toString(36);
}

function extractMessages(data) {
const arr = findMessageArray(data);
const out = arr.filter(looksLikeMessage).map((m) => ({
id: String(m.id || m._id || m.chatMessageId || m.uuid || ('h-' + roleOf(m) + '-' + hashText(textOf(m)))),
role: roleOf(m),
text: textOf(m).replace(MEM_BLOCK_RE, '').trim(),
t: Date.parse(m.createdAt || m.created_at || '') || 0,
})).filter((m) => m.role !== 'system' && m.text);
if (out.length > 1 && out.every((m) => m.t)) out.sort((a, b) => a.t - b.t);
return out;
}

function titleOf(data) {
if (!data || typeof data !== 'object') return '';
const c = data.conversation || data;
return String(c.title || (c.tool && c.tool.title) || (data.tool && data.tool.title) || '').slice(0, 80);
}

function unprocessed(chat, msgs) {
const done = new Set(chat.processedIds);
let last = -1;
for (let i = msgs.length - 1; i >= 0; i--) {
if (done.has(msgs[i].id)) { last = i; break; }
}
if (last === -1 && chat.processedCount > 0) last = Math.min(chat.processedCount, msgs.length) - 1;
return msgs.slice(last + 1);
}


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


function gmRequest() {
if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') return GM.xmlHttpRequest;
if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
return null;
}

// ===== END OF PART 1 of 3 (v1.1.0) =====
// ===== Tap on the empty line below, then paste PART 2 =====
