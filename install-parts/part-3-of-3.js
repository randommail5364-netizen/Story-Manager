const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.fab { position: fixed; bottom: 92px; z-index: 2147483646; width: 46px; height: 46px; border-radius: 50%;
border: none; background: #5b4bdb; color: #fff; font-size: 22px; box-shadow: 0 4px 14px rgba(0,0,0,.35);
display: flex; align-items: center; justify-content: center; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.fab.right { right: 12px; } .fab.left { left: 12px; }
.fab .dot { position: absolute; top: 2px; right: 2px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #fff; display: none; }
.fab.busy .dot { display: block; background: #f5b400; animation: pulse 1s infinite; }
.fab.err .dot { display: block; background: #e5484d; }
.fab.off { background: #777; }
@keyframes pulse { 50% { opacity: .3; } }
.panel { position: fixed; z-index: 2147483647; inset: 10px; max-width: 560px; margin: 0 auto; background: #16161d; color: #ececf1;
border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.6); display: none; flex-direction: column; overflow: hidden; font-size: 14px; }
.panel.open { display: flex; }
header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: #20202b; }
header h1 { flex: 1; font-size: 16px; margin: 0; font-weight: 600; }
.x { background: none; border: none; color: #ccc; font-size: 24px; line-height: 1; padding: 0 4px; }
nav { display: flex; background: #20202b; }
nav button { flex: 1; background: none; border: none; color: #aaa; padding: 10px; font-size: 14px; border-bottom: 2px solid transparent; }
nav button.on { color: #fff; border-bottom-color: #7c6cff; }
.body { flex: 1; overflow-y: auto; padding: 14px; -webkit-overflow-scrolling: touch; }
label { display: block; margin: 12px 0 4px; color: #b9b9c6; font-size: 13px; }
.row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.row label { margin: 0; flex: 1; color: #ececf1; font-size: 14px; }
textarea, input, select { width: 100%; background: #0e0e13; color: #ececf1; border: 1px solid #33334a; border-radius: 8px;
padding: 8px 10px; font-size: 14px; }
textarea { min-height: 90px; resize: vertical; font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; line-height: 1.4; }
textarea.mem { min-height: 260px; }
input[type=checkbox] { width: 22px; height: 22px; flex: none; }
.btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.btn { background: #2c2c3c; color: #fff; border: none; border-radius: 8px; padding: 9px 12px; font-size: 14px; }
.btn.primary { background: #5b4bdb; }
.btn:disabled { opacity: .5; }
.status { background: #0e0e13; border-radius: 8px; padding: 8px 10px; color: #b9b9c6; font-size: 12.5px; line-height: 1.5; }
.status b { color: #ececf1; }
.error { color: #ff8a8d; }
.hint { color: #8a8a99; font-size: 12px; margin-top: 4px; line-height: 1.4; }
.toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 150px; z-index: 2147483647; background: #2c2c3c; color: #fff;
padding: 10px 14px; border-radius: 10px; max-width: 90vw; font-size: 13px; box-shadow: 0 4px 14px rgba(0,0,0,.4); }
.toast.bad { background: #6b1f22; }
.empty { color: #8a8a99; text-align: center; padding: 30px 10px; line-height: 1.5; }
`;

function el(tag, attrs, ...kids) {
const e = document.createElement(tag);
for (const [k, v] of Object.entries(attrs || {})) {
if (k === 'class') e.className = v;
else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
}
for (const kid of kids.flat()) if (kid !== null && kid !== undefined) e.append(kid);
return e;
}

function buildUI() {
if (root) return;
const host = el('div', { id: 'story-manager-root' });
document.documentElement.appendChild(host);
setInterval(() => { if (!host.isConnected) document.documentElement.appendChild(host); }, 2000);
root = host.attachShadow({ mode: 'open' });
root.append(el('style', {}, CSS));
ui.fab = el('button', { class: 'fab ' + settings.buttonSide, title: 'Story Manager', onclick: () => togglePanel() }, '📖', el('span', { class: 'dot' }));
ui.body = el('div', { class: 'body' });
ui.tabs = {
memory: el('button', { onclick: () => { tab = 'memory'; renderPanel(true); } }, 'Memory'),
settings: el('button', { onclick: () => { tab = 'settings'; renderPanel(true); } }, 'Settings'),
};
ui.panel = el('div', { class: 'panel' },
el('header', {}, el('h1', {}, '📖 Story Manager'), el('button', { class: 'x', onclick: () => togglePanel(false) }, '×')),
el('nav', {}, ui.tabs.memory, ui.tabs.settings),
ui.body);
root.append(ui.fab, ui.panel);
setStatus();
}

function togglePanel(open) {
const want = open === undefined ? !ui.panel.classList.contains('open') : open;
ui.panel.classList.toggle('open', want);
if (want) renderPanel(true);
}

function toast(msg, bad) {
if (!root) { console.log('[Story Manager]', msg); return; }
const t = el('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
root.append(t);
setTimeout(() => t.remove(), bad ? 6000 : 3000);
}

function setStatus() {
if (!ui.fab) return;
const chat = currentId && chats[currentId];
ui.fab.classList.toggle('busy', !!(currentId && busy[currentId]));
ui.fab.classList.toggle('err', !!(chat && chat.lastError && !busy[currentId]));
ui.fab.classList.toggle('off', !!(chat && !chat.enabled));
}

function ago(ts) {
if (!ts) return 'never';
const s = Math.round((Date.now() - ts) / 1000);
if (s < 60) return 'just now';
if (s < 3600) return Math.round(s / 60) + ' min ago';
if (s < 86400) return Math.round(s / 3600) + ' h ago';
return new Date(ts).toLocaleDateString();
}

function renderPanel(force) {
if (!ui.panel || !ui.panel.classList.contains('open')) return;
const active = root.activeElement;
if (!force && active && /TEXTAREA|INPUT|SELECT/.test(active.tagName)) return;
ui.tabs.memory.classList.toggle('on', tab === 'memory');
ui.tabs.settings.classList.toggle('on', tab === 'settings');
ui.body.replaceChildren(tab === 'memory' ? memoryView() : settingsView());
}

function memoryView() {
const chat = currentId && chats[currentId];
if (!chat) {
return el('div', {},
el('div', { class: 'empty' }, 'Open a chat (or send a message) and its story memory will appear here.'),
diagnosticsBox());
}
const isBusy = !!busy[chat.id];
const pinned = el('textarea', { placeholder: 'e.g. My character is Mira, 24, a healer who is afraid of water.' });
pinned.value = chat.pinned;
const mem = el('textarea', { class: 'mem', placeholder: 'Empty so far. It fills in automatically as the story goes on.' });
mem.value = chat.memory;
const enabled = el('input', { type: 'checkbox', id: 'smx-en' });
enabled.checked = chat.enabled;
enabled.addEventListener('change', async () => {
chat.enabled = enabled.checked;
await saveChat(chat);
setStatus();
toast(chat.enabled ? 'Auto-managing this chat' : 'Paused for this chat');
});

const save = async () => {
chat.pinned = pinned.value;
if (mem.value !== chat.memory) {
chat.history = [chat.memory].concat(chat.history).slice(0, 5);
chat.memory = mem.value;
}
await saveChat(chat);
toast('Saved');
renderPanel(true);
};

const runNow = async (rebuild) => {
try {
await save();
if (rebuild) {
if (!confirm('Re-read the whole chat and rebuild the memory from scratch? (Pinned facts are kept.)')) return;
chat.history = [chat.memory].concat(chat.history).slice(0, 5);
chat.memory = '';
chat.processedIds = [];
chat.processedCount = 0;
await saveChat(chat);
}
toast(rebuild ? 'Reading the whole chat…' : 'Updating memory…');
renderPanel(true);
const msgs = await fetchMessages(chat.id);
chat.knownMessages = msgs.length;
if (!msgs.length) {
toast('Could not find any messages in this chat yet. Scroll through the chat, then try again — or open Diagnostics and send it to Claude.', true);
return;
}
if (!unprocessed(chat, msgs).length) { toast('Memory is already up to date (' + msgs.length + ' messages read)'); return; }
await updateMemory(chat.id, msgs, { force: true });
if (!chat.lastError) toast('Memory updated');
} catch (e) {
toast(String(e.message || e), true);
}
renderPanel(true);
};

const undo = async () => {
if (!chat.history.length) return;
chat.memory = chat.history.shift();
await saveChat(chat);
toast('Restored the previous memory');
renderPanel(true);
};

const total = chat.knownMessages || 0;
return el('div', {},
el('div', { class: 'status' },
el('div', {}, el('b', {}, chat.title || 'Chat'), ' · ', chat.id.slice(0, 8)),
el('div', {}, 'Messages read: ', el('b', {}, String(chat.processedCount)), total ? ' of ' + total : '',
' · Last update: ', el('b', {}, ago(chat.lastUpdate))),
isBusy ? el('div', {}, '⏳ Updating memory…') : null,
chat.lastError ? el('div', { class: 'error' }, '⚠ ' + chat.lastError) : null),
el('div', { class: 'row' }, enabled, el('label', { for: 'smx-en' }, 'Auto-manage this chat')),
el('label', {}, '📌 Pinned facts (never changed automatically)'),
pinned,
el('label', {}, '🧠 Story memory (updated automatically — you can edit it)'),
mem,
el('div', { class: 'hint' }, mem.value.length + ' characters. Attached to your messages so the AI keeps track of the story.'),
el('div', { class: 'btns' },
el('button', { class: 'btn primary', onclick: save }, 'Save'),
el('button', { class: 'btn', disabled: isBusy, onclick: () => runNow(false) }, 'Update now'),
el('button', { class: 'btn', disabled: isBusy, onclick: () => runNow(true) }, 'Rebuild from whole chat'),
el('button', { class: 'btn', disabled: !chat.history.length, onclick: undo }, 'Undo last change')),
diagnosticsBox());
}

function diagnosticsText() {
const version = typeof GM_info !== 'undefined' && GM_info && GM_info.script ? GM_info.script.version : '?';
const chat = currentId && chats[currentId];
const lines = [
'Story Manager v' + version,
'Page: ' + shortUrl(location.href),
'Current chat: ' + (currentId ? currentId.slice(0, 8) : 'none') +
(chat ? ' · messages seen: ' + (seenMsgs[currentId] ? seenMsgs[currentId].size : 0) + ' · read into memory: ' + chat.processedCount : ''),
'Learned message address: ' + (learned ? shortUrl(learned.template.split('{id}').join('00000000-0000-0000-0000-000000000000')) : 'none yet'),
'Memory keeper: ' + settings.provider,
'',
'Recent MiniApps requests (newest first, no message text):',
];
for (const a of apiLog) {
lines.push(a.method + ' ' + a.url + ' → ' + a.status + (a.note ? ' [' + a.note + ']' : '') + ' · messages: ' + a.found + ' · ' + a.info);
}
return lines.join('\n');
}

function diagnosticsBox() {
const box = el('textarea', { readonly: true });
box.style.display = 'none';
box.style.minHeight = '220px';
const show = () => {
box.value = diagnosticsText();
box.style.display = '';
};
const copy = async () => {
show();
box.select();
try { await navigator.clipboard.writeText(box.value); toast('Diagnostics copied — paste them to Claude'); } catch (e) { toast('Select the text in the box and copy it'); }
};
return el('div', {},
el('div', { class: 'btns' },
el('button', { class: 'btn', onclick: show }, 'Diagnostics'),
el('button', { class: 'btn', onclick: copy }, 'Copy diagnostics')),
box);
}

function settingsView() {
const s = settings;
const f = {};
const providerSel = el('select', {},
el('option', { value: 'miniapps' }, 'MiniApps bot (no key, uses your MiniApps credits)'),
el('option', { value: 'gemini' }, 'Google Gemini (free key available)'),
el('option', { value: 'anthropic' }, 'Anthropic Claude'),
el('option', { value: 'openai' }, 'OpenAI-compatible (OpenAI, OpenRouter, Groq…)'));
providerSel.value = s.provider;
f.provider = providerSel;
f.apiKey = el('input', { type: 'password', value: s.apiKey, placeholder: 'Paste your API key', autocomplete: 'off' });
f.model = el('input', { value: s.model, placeholder: 'default: ' + (DEFAULT_MODELS[s.provider] || '') });
f.baseUrl = el('input', { value: s.baseUrl, placeholder: 'https://openrouter.ai/api/v1' });
f.miniappsSlug = el('input', { value: s.miniappsSlug, placeholder: 'claude-37' });
f.updateEvery = el('input', { type: 'number', min: '1', value: String(s.updateEvery) });
f.injectEvery = el('input', { type: 'number', min: '0', value: String(s.injectEvery) });
f.maxChars = el('input', { type: 'number', min: '500', step: '250', value: String(s.maxChars) });
f.autoEnable = el('input', { type: 'checkbox', id: 'smx-auto' });
f.autoEnable.checked = s.autoEnable;
f.buttonSide = el('select', {}, el('option', { value: 'right' }, 'Right'), el('option', { value: 'left' }, 'Left'));
f.buttonSide.value = s.buttonSide;

const keyBox = el('div', {}, el('label', {}, 'API key'), f.apiKey, el('label', {}, 'Model'), f.model);
const baseBox = el('div', {}, el('label', {}, 'Base URL'), f.baseUrl,
el('div', { class: 'hint' }, 'OpenRouter: https://openrouter.ai/api/v1 · OpenAI: https://api.openai.com/v1 · Groq: https://api.groq.com/openai/v1'));
const slugBox = el('div', {}, el('label', {}, 'MiniApps bot used as memory keeper (slug from its URL)'), f.miniappsSlug,
el('div', { class: 'hint' }, 'Each memory update sends one message to this bot and creates a small extra chat in your MiniApps history.'));
const showProvider = () => {
const p = providerSel.value;
keyBox.style.display = p === 'miniapps' ? 'none' : '';
baseBox.style.display = p === 'openai' ? '' : 'none';
slugBox.style.display = p === 'miniapps' ? '' : 'none';
f.model.placeholder = 'default: ' + (DEFAULT_MODELS[p] || '');
};
providerSel.addEventListener('change', showProvider);
showProvider();

const collect = () => ({
provider: f.provider.value,
apiKey: f.apiKey.value.trim(),
model: f.model.value.trim(),
baseUrl: f.baseUrl.value.trim(),
miniappsSlug: f.miniappsSlug.value.trim() || 'claude-37',
updateEvery: Math.max(1, parseInt(f.updateEvery.value, 10) || 1),
injectEvery: Math.max(0, parseInt(f.injectEvery.value, 10) || 0),
maxChars: Math.max(500, parseInt(f.maxChars.value, 10) || 3000),
autoEnable: f.autoEnable.checked,
buttonSide: f.buttonSide.value,
});

const save = async () => {
settings = Object.assign({}, DEFAULT_SETTINGS, collect());
toolCache = null;
await Store.set('settings', settings);
ui.fab.className = 'fab ' + settings.buttonSide;
setStatus();
publishInjectMap();
toast('Settings saved');
};

const test = async () => {
await save();
toast('Testing…');
try {
const out = await callLLM('Reply with exactly: OK', 'Say OK.');
toast('Connection works ✓ (' + String(out).trim().slice(0, 40) + ')');
} catch (e) {
toast('Test failed: ' + (e.message || e), true);
}
};

const backup = el('textarea', { placeholder: 'Backup data appears here / paste a backup to import' });
const exportAll = async () => {
const data = { version: 1, settings: Object.assign({}, settings, { apiKey: '' }), chats: {} };
for (const id of chatIndex) data.chats[id] = await getChat(id, false);
backup.value = JSON.stringify(data);
backup.select();
try { await navigator.clipboard.writeText(backup.value); toast('Backup copied to clipboard'); } catch (e) { toast('Backup ready — copy it from the box'); }
};
const importAll = async () => {
let data;
try { data = JSON.parse(backup.value); } catch (e) { toast('That is not a valid backup', true); return; }
if (!data || !data.chats) { toast('That is not a valid backup', true); return; }
for (const [id, c] of Object.entries(data.chats)) {
if (!c) continue;
chats[id] = Object.assign(newChat(id), c, { id });
if (!chatIndex.includes(id)) chatIndex.push(id);
await Store.set('chat:' + id, chats[id]);
}
await Store.set('chatIndex', chatIndex);
publishInjectMap();
toast('Imported ' + Object.keys(data.chats).length + ' chats');
renderPanel(true);
};

return el('div', {},
el('label', {}, 'Memory keeper AI'), providerSel,
keyBox, baseBox, slugBox,
el('label', {}, 'Update the memory every … AI replies'), f.updateEvery,
el('label', {}, 'Attach the memory to every … messages you send (0 = never)'), f.injectEvery,
el('label', {}, 'Maximum memory size (characters)'), f.maxChars,
el('div', { class: 'row' }, f.autoEnable, el('label', { for: 'smx-auto' }, 'Automatically manage new chats')),
el('label', {}, 'Button position'), f.buttonSide,
el('div', { class: 'btns' },
el('button', { class: 'btn primary', onclick: save }, 'Save settings'),
el('button', { class: 'btn', onclick: test }, 'Test connection')),
el('label', {}, 'Backup / move to another device (API key is not included)'), backup,
el('div', { class: 'btns' },
el('button', { class: 'btn', onclick: exportAll }, 'Export'),
el('button', { class: 'btn', onclick: importAll }, 'Import')));
}

let startCalled = false;
function startUI() {
if (startCalled) return;
startCalled = true;
stage = 'waiting for saved data';
ready
.catch((e) => console.warn('[Story Manager] could not load saved data', e))
.then(() => {
stage = 'building the button';
try {
buildUI();
uiStarted = true;
} catch (e) {
uiStarted = true;
alert('Story Manager could not start: ' + (e && e.message ? e.message : e));
return;
}
let shown = false;
try { shown = sessionStorage.getItem('smx:hello') === '1'; sessionStorage.setItem('smx:hello', '1'); } catch (e) { /* ignore */ }
if (!shown) toast('📖 Story Manager is running');
const m = location.href.match(UUID_RE);
if (m) setCurrent(m[0].toLowerCase());
});
}

try {
if (typeof GM_registerMenuCommand === 'function') {
GM_registerMenuCommand('📖 Open Story Manager', () => { buildUI(); togglePanel(true); });
}
} catch (e) { /* ignore */ }

stage = 'waiting for the page to load';
if (document.readyState === 'loading') {
document.addEventListener('DOMContentLoaded', startUI);
window.addEventListener('load', startUI);
} else {
startUI();
}
})();
