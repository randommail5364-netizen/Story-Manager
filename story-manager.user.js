// ==UserScript==
// @name         MiniApps Story Manager
// @namespace    https://github.com/randommail5364-netizen/Story-Manager
// @version      1.1.1
// @description  Keeps an automatic "story memory" for every MiniApps.ai chat and quietly feeds it back to the AI so it never forgets important facts.
// @downloadURL  https://raw.githubusercontent.com/randommail5364-netizen/Story-Manager/claude/brave-mayer-u1eutx/story-manager.user.js
// @updateURL    https://raw.githubusercontent.com/randommail5364-netizen/Story-Manager/claude/brave-mayer-u1eutx/story-manager.user.js
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

  // If anything stops the script from starting, say where instead of failing silently.
  let stage = 'starting';
  let uiStarted = false;
  setTimeout(() => {
    if (!uiStarted) alert('Story Manager did not finish starting (stuck at: ' + stage + '). Please send this message to Claude.');
  }, 15000);

  const MEM_START = '[[STORY-MEMORY]]';
  const MEM_END = '[[/STORY-MEMORY]]';
  const MEM_BLOCK_RE = /\[\[STORY-MEMORY\]\][\s\S]*?\[\[\/STORY-MEMORY\]\]\s*/g;
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  // ---------------------------------------------------------------------------
  // Page hook — runs in the website's own JavaScript world so it can see and
  // adjust the site's network requests. Talks to the rest of the script only
  // through DOM events / attributes, so it works in every userscript manager.
  // ---------------------------------------------------------------------------

  function pageHook(win) {
    if (win.__smxHooked) return;
    win.__smxHooked = true;
    const doc = win.document;
    if (doc.documentElement) doc.documentElement.setAttribute('data-smx-hook', '1');

    // When this runs inside Firefox's userscript sandbox instead of the page,
    // functions and objects handed to the page must be exported / cloned.
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

    // Attach the story memory to an outgoing chat message.
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
      // Everything else is reported too, so the script can learn which
      // request really carries a chat's messages.
      else if (info.kind === 'other') emit('api', { method: info.method, url: info.url, status, text: text && text.length < 3000000 ? text : '' });
    }

    // --- fetch ---
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

    // --- XMLHttpRequest (axios etc.) ---
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

    // --- RPC: lets the script call the MiniApps API with the user's session ---
    doc.addEventListener('smx:rpc', function (ev) {
      let req;
      try { req = JSON.parse(ev.detail); } catch (e) { return; }
      const headers = Object.assign({ Accept: 'application/json, text/plain, */*' }, state.headers);
      const opts = { method: req.method || 'GET', headers, credentials: 'include' };
      if (req.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(req.body);
      }
      // POSTs need a CSRF token; get one the way the site does if we have not seen it yet.
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
    // Inline scripts can be blocked by a Content-Security-Policy; fall back to
    // patching the page directly through unsafeWindow.
    if (!document.documentElement || document.documentElement.getAttribute('data-smx-hook') !== '1') {
      try { pageHook(W); } catch (e) { console.warn('[Story Manager] could not hook the page', e); }
    }
  }

  stage = 'hooking the page';
  try { installPageHook(); } catch (e) { console.warn('[Story Manager] could not hook the page', e); }
  stage = 'loading storage';

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  let hasGM = typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function';
  let hasGMLegacy = typeof GM_getValue === 'function';

  // Some userscript managers never answer storage calls; fall back to the
  // browser's own storage instead of hanging.
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

  // ---------------------------------------------------------------------------
  // Memory injection
  // ---------------------------------------------------------------------------

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
    // At document-start the <html> element may not exist yet.
    if (document.documentElement) document.documentElement.setAttribute('data-smx-inject', JSON.stringify(map));
    else setTimeout(publishInjectMap, 50);
  }

  // ---------------------------------------------------------------------------
  // Conversation parsing
  // ---------------------------------------------------------------------------

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

  // Messages that come after the last one we already folded into memory.
  function unprocessed(chat, msgs) {
    const done = new Set(chat.processedIds);
    let last = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (done.has(msgs[i].id)) { last = i; break; }
    }
    if (last === -1 && chat.processedCount > 0) last = Math.min(chat.processedCount, msgs.length) - 1;
    return msgs.slice(last + 1);
  }

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

  // ---------------------------------------------------------------------------
  // Finding a chat's messages. MiniApps has no public API, so besides the
  // documented GET /conversations/{id} the script learns which request the
  // site itself uses to load messages, and reads the chat the same way.
  // ---------------------------------------------------------------------------

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

  // Which chat does a message list belong to?
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

  // Ask the learned endpoint for every page of a chat's messages.
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
    // Only trust lists that clearly are a chat: both sides talking, tied to a chat id.
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

  // ---------------------------------------------------------------------------
  // User interface
  // ---------------------------------------------------------------------------

  let root = null;
  let ui = {};
  let tab = 'memory';

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
    // Keep the button on screen even if the site rebuilds its page.
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

  // Re-render only when forced or when the user is not typing in the panel.
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
