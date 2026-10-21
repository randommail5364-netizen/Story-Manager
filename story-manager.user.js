// ==UserScript==
// @name         MiniApps Story Manager
// @namespace    https://github.com/randommail5364-netizen/Story-Manager
// @version      2.3.0
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

    // Counters shown in Diagnostics, to see whether the hook sees anything and
    // how late it started (API requests the page had already made by then).
    let earlier = 0;
    try {
      earlier = win.performance.getEntriesByType('resource')
        .filter((e) => /^https:\/\/([a-z0-9-]+\.)*miniapps\.ai\//i.test(e.name) && /api\./i.test(e.name)).length;
    } catch (e) { /* ignore */ }
    const stats = { mode: sandboxed ? 'sandbox' : 'page', startedWhile: doc.readyState, apiCallsBeforeStart: earlier, fetch: 0, xhr: 0, wsIn: 0, wsOut: 0 };
    function bump(k) { stats[k]++; }
    doc.addEventListener('smx:ping', function () { emit('stats', stats); });

    // The memory to attach, per chat; sent by the script whenever it changes.
    let injectMap = null;
    doc.addEventListener('smx:inject', function (ev) {
      try { injectMap = JSON.parse(ev.detail); } catch (e) { /* ignore */ }
    });

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
      return injectInto(body) ? JSON.stringify(body) : bodyStr;
    }

    // Returns true when the memory was added to `body` (modified in place).
    function injectInto(body) {
      const convId = body.conversationId || null;
      let injected = false;
      let included = [];
      let size = 0;
      let userText = '';
      const textEl = Array.isArray(body.elements)
        ? body.elements.find((e) => e && e.type === 'text' && typeof e.text === 'string')
        : null;
      userText = textEl ? textEl.text : (typeof body.text === 'string' ? body.text : '');
      if (convId) {
        let map = injectMap || {};
        if (!injectMap) {
          try { map = JSON.parse(doc.documentElement.getAttribute('data-smx-inject') || '{}'); } catch (e) { /* ignore */ }
        }
        const plan = map[convId];
        if (plan) {
          const made = compose(plan, userText);
          included = made.names;
          size = made.text.length;
          if (textEl) { textEl.text = made.text + '\n\n' + textEl.text; injected = true; }
          else if (typeof body.text === 'string') { body.text = made.text + '\n\n' + body.text; injected = true; }
        }
      }
      emit('sent', { conversationId: convId, injected, userText, included, size });
      return injected;
    }

    function mentionsKey(text, key) {
      const k = String(key || '').trim();
      if (k.length < 2) return false;
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^\\p{L}\\p{N}])' + esc + '($|[^\\p{L}\\p{N}])', 'iu').test(text);
    }

    // Build the attached notes: the story, entries in play, entries this
    // message mentions (while they fit), then the newest reply summaries.
    function compose(plan, userText) {
      if (typeof plan === 'string') return { text: plan, names: [] };
      const names = [];
      const blocks = [];
      let size = plan.head.length;
      const add = (e, force) => {
        const t = '### ' + e.name + (e.kind ? ' (' + e.kind + ')' : '') + '\n' + e.text;
        if (!force && size + t.length > plan.budget) return;
        blocks.push(t);
        names.push(e.name);
        size += t.length + 2;
      };
      plan.core.forEach((e) => add(e, true));
      plan.extra.filter((e) => e.keys.some((k) => mentionsKey(userText, k))).forEach((e) => add(e, false));
      const logs = [];
      for (let i = plan.log.length - 1; i >= 0; i--) {
        const t = '- ' + plan.log[i];
        if (size + t.length > plan.budget) break;
        logs.unshift(t);
        size += t.length + 1;
      }
      const parts = [];
      if (plan.head) parts.push(plan.head);
      if (blocks.length) parts.push('## Characters and details in play\n' + blocks.join('\n\n'));
      if (logs.length) parts.push('## Recent events in detail (oldest first)\n' + logs.join('\n'));
      if (logs.length) names.push(logs.length + ' reply summaries');
      return { text: plan.prefix + parts.join('\n\n') + plan.suffix, names };
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
        bump('fetch');
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
      bump('xhr');
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

    // --- WebSocket (Socket.IO): the site may load and send chats over it ---
    // Socket.IO frames look like 42["event",{...}] (or 43<id>[...] for replies).
    function sioParse(data) {
      if (typeof data !== 'string') return null;
      const m = data.match(/^(4([23])(?:\/[^,]*,)?(\d*))(\[[\s\S]*\])$/);
      if (!m) return null;
      try {
        const arr = JSON.parse(m[4]);
        if (!Array.isArray(arr)) return null;
        return m[2] === '2'
          ? { prefix: m[1], event: String(arr[0]), args: arr.slice(1), ack: m[3] }
          : { prefix: m[1], event: 'reply', args: arr, ack: m[3] };
      } catch (e) { return null; }
    }

    function reportWs(dir, p) {
      let text = '';
      try { text = JSON.stringify(p.args); } catch (e) { /* ignore */ }
      emit('ws', { dir, event: p.event, ack: p.ack, text: text.length < 3000000 ? text : '' });
    }

    const onWsMessage = function (ev) {
      try {
        bump('wsIn');
        const p = sioParse(ev.data);
        if (p) reportWs('in', p);
      } catch (e) { /* ignore */ }
    };

    if (win.WebSocket && win.WebSocket.prototype) {
      const WP = win.WebSocket.prototype;
      const oWsSend = WP.send;
      WP.send = expFn(function (data) {
        try {
          bump('wsOut');
          // Start listening to this socket the first time it sends anything.
          if (!this.__smxListening) {
            this.__smxListening = true;
            this.addEventListener('message', sandboxed ? expFn(onWsMessage, win) : onWsMessage);
          }
          const p = sioParse(data);
          if (p) {
            const obj = p.args[0];
            // A chat message sent over the socket: attach the memory here too.
            if (obj && typeof obj === 'object' && Array.isArray(obj.elements) && (obj.conversationId || obj.toolId)) {
              if (injectInto(obj)) data = p.prefix + JSON.stringify([p.event].concat(p.args));
            }
            reportWs('out', p);
          }
        } catch (e) { /* ignore */ }
        return oWsSend.call(this, data);
      }, WP);
    }

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
    if (W.__smxHooked) return;
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
    helperRotate: 0,  // start a new helper chat every N requests (0 = always the same one)
    updateEvery: 3,   // AI replies between memory updates
    injectEvery: 1,   // attach memory to every Nth message (0 = never)
    maxChars: 8000,   // target size of the main memory
    logAttach: 15,    // detailed reply summaries attached to each message
    injectBudget: 16000, // most characters attached to one message
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
  const progress = {};          // id -> { done, total } requests of the running update
  const polls = {};             // id -> poll token
  const helperIds = new Set();  // conversations created by the memory keeper itself

  function newChat(id) {
    return {
      id,
      title: '',
      enabled: settings.autoEnable,
      memory: '',       // the story entry: big picture, current scene, open threads
      entries: [],      // [{ name, kind, aliases, text, always, updated }]: characters, places, …
      ignored: [],      // lower-case names of entries the user deleted; never recreated
      log: [],          // [{ id, text }]: a detailed summary of each AI reply
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

  // Does `text` mention `key` as a whole word (any language, any case)?
  function mentions(text, key) {
    const k = String(key || '').trim();
    if (k.length < 2) return false;
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^\\p{L}\\p{N}])' + esc + '($|[^\\p{L}\\p{N}])', 'iu').test(text);
  }

  function entryKeys(e) {
    return [e.name].concat(e.aliases || []);
  }

  function sectionOf(text, title) {
    const m = String(text || '').match(new RegExp('^##\\s*' + title + '[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))', 'im'));
    return m ? m[1] : '';
  }

  // Entries that are part of what is happening now: marked "always", named in
  // the current scene, or mentioned in the latest messages.
  function entriesInPlay(chat) {
    const recent = [sectionOf(chat.memory, 'Current Scene')];
    if (seenMsgs[chat.id]) recent.push(...[...seenMsgs[chat.id].values()].slice(-3).map((m) => m.text));
    recent.push(...chat.log.slice(-2).map((e) => e.text));
    const text = recent.join('\n');
    return chat.entries.filter((e) => e.always || entryKeys(e).some((k) => mentions(text, k)));
  }

  // What may be attached to the next message in a chat. The page hook picks
  // from it when the message is sent, adding entries the message mentions.
  function buildPlan(chat) {
    const head = [];
    if (chat.pinned.trim()) head.push('## Must remember\n' + chat.pinned.trim());
    if (chat.memory.trim()) head.push('## The story\n' + chat.memory.trim());
    const inPlay = new Set(entriesInPlay(chat));
    const pack = (e) => ({ name: e.name, kind: e.kind || '', keys: entryKeys(e), text: e.text });
    const plan = {
      prefix: MEM_START + '\n(Background notes for story continuity. Use them silently; do not quote, mention or reply to them.)\n\n',
      suffix: '\n' + MEM_END,
      head: head.join('\n\n'),
      core: chat.entries.filter((e) => inPlay.has(e)).map(pack),
      extra: chat.entries.filter((e) => !inPlay.has(e)).map(pack),
      log: chat.log.slice(-Math.max(0, Number(settings.logAttach) || 0)).map((e) => e.text),
      budget: Math.max(2000, Number(settings.injectBudget) || 16000),
    };
    return plan.head || plan.core.length || plan.extra.length || plan.log.length ? plan : null;
  }

  function publishInjectMap() {
    const map = {};
    const every = Number(settings.injectEvery) || 0;
    if (every > 0) {
      for (const id of Object.keys(chats)) {
        const c = chats[id];
        if (!c.enabled) continue;
        if (c.sentSinceInject > 0 && c.sentSinceInject < every) continue;
        const plan = buildPlan(c);
        if (plan) map[id] = plan;
      }
    }
    // Sent as an event (the site may rewrite <html> attributes), plus an
    // attribute as a fallback. At document-start <html> may not exist yet.
    document.dispatchEvent(new CustomEvent('smx:inject', { detail: JSON.stringify(map) }));
    if (document.documentElement) document.documentElement.setAttribute('data-smx-inject', JSON.stringify(map));
    else setTimeout(publishInjectMap, 50);
  }

  // ---------------------------------------------------------------------------
  // Conversation parsing
  // ---------------------------------------------------------------------------

  const ROLE_KEYS = ['origin', 'role', 'sender', 'author', 'from', 'senderType', 'isBot', 'isUser', 'fromUser', 'byUser'];
  const TEXT_KEYS = ['elements', 'text', 'content', 'message', 'body', 'markdown'];
  const ROLE_WORD = /^(user|human|assistant|bot|ai|model|character|system)$/i;

  function looksLikeMessage(o) {
    return !!o && typeof o === 'object' && !Array.isArray(o) &&
      (ROLE_KEYS.some((k) => k in o) || (typeof o.type === 'string' && ROLE_WORD.test(o.type))) &&
      TEXT_KEYS.some((k) => k in o);
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
    for (const k of ['text', 'content', 'message', 'body', 'markdown']) {
      const v = m[k];
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return v.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n');
    }
    return '';
  }

  function roleOf(m) {
    if (m.isUser === true || m.fromUser === true || m.byUser === true) return 'user';
    if (m.isBot === true || m.isUser === false || m.fromUser === false) return 'assistant';
    const typeRole = typeof m.type === 'string' && ROLE_WORD.test(m.type) ? m.type : '';
    const r = String(m.origin || m.role || m.sender || m.author || m.from || m.senderType || typeRole || '').toLowerCase();
    if (/system/.test(r)) return 'system';
    if (/user|human/.test(r)) return 'user';
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
      }, { model, max_tokens: 8192, system, messages: [{ role: 'user', content: user }] });
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
  // All requests go to one helper chat with the bot (remembered across visits),
  // so they don't each add a chat to the user's MiniApps history.
  let helperChat = null;  // { slug, id, uses }
  const lastActivity = {}; // chat id -> when the live connection last showed activity in it

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
    // A tag finds this request's answer among the earlier ones in the chat.
    const tag = 'Request ' + uuid4().slice(0, 8);
    const body = {
      toolId: toolCache.id,
      revision: toolCache.revision,
      modelId: toolCache.modelId,
      requestId: uuid4(),
      elements: [{ type: 'text', text: tag + '. This is a new, separate task: ignore all earlier messages in this chat.\n\n' + prompt }],
      language: 'en',
    };
    const rotate = Number(settings.helperRotate) || 0;
    let reuse = !!(helperChat && helperChat.slug === slug && !(rotate && helperChat.uses >= rotate));
    if (reuse) body.conversationId = helperChat.id;
    // Answers that arrive over the live connection after this point are new.
    const known = new Set(reuse && seenMsgs[helperChat.id] ? seenMsgs[helperChat.id].keys() : []);
    let res;
    try {
      res = await rpc('POST', '/chat', body);
    } catch (e) {
      if (!reuse) throw e;
      // The helper chat is gone (e.g. deleted); start a new one.
      delete body.conversationId;
      reuse = false;
      res = await rpc('POST', '/chat', body);
    }
    const cid = res && res.conversationId;
    if (!cid) throw new Error('MiniApps did not start a conversation');
    helperIds.add(cid);
    helperChat = reuse && cid === helperChat.id ? Object.assign({}, helperChat, { uses: helperChat.uses + 1 }) : { slug, id: cid, uses: 1 };
    await Store.set('helperChat', helperChat);
    // Long answers can take many minutes to write. Wait while the bot is
    // still typing (live connection activity), up to 20 minutes; give up
    // after 3 minutes without any sign of it.
    const started = Date.now();
    let prev = null;
    while (Date.now() - started < 20 * 60000) {
      await sleep(4000);
      let msgs = [];
      try { msgs = await fetchMessages(cid, { cache: false, mode: 'latest' }); } catch (e) { /* the live connection may still deliver it */ }
      if (seenMsgs[cid]) msgs = mergeMsgs(msgs, [...seenMsgs[cid].values()]);
      let at = -1;
      msgs.forEach((m, j) => { if (m.role === 'user' && m.text.includes(tag)) at = j; });
      let reply;
      if (at >= 0) {
        const after = msgs.slice(at + 1);
        const next = after.findIndex((m) => m.role === 'user');
        reply = (next < 0 ? after : after.slice(0, next)).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
      } else {
        // The request itself is not readable; use answers pushed over the live connection since sending.
        reply = (seenMsgs[cid] ? [...seenMsgs[cid].values()] : []).filter((m) => m.role === 'assistant' && !known.has(m.id)).map((m) => m.text).join('\n');
      }
      if (reply && reply === prev) return reply;
      prev = reply || null;
      const idle = Date.now() - Math.max(started, lastActivity[cid] || 0);
      if (!reply && idle > 3 * 60000) break;
    }
    if (prev) return prev;
    throw new Error('The MiniApps bot did not answer (no activity for 3 minutes). Try again, or use a different memory keeper in Settings.');
  }

  function systemPrompt() {
    return [
      'You are the continuity editor for a long-running interactive story / roleplay chat.',
      'You keep a knowledge base up to date so the storyteller AI never forgets anything. It has three parts:',
      '1. The STORY: the big picture.',
      '2. ENTRIES: one entry per character, and per important place, item, group or piece of lore.',
      '3. The LOG: one detailed entry per story reply.',
      'Only the parts that matter at the moment are shown to the storyteller, so every fact must sit in the right entry.',
      '',
      'STORY rules:',
      '- Sections: ## Story So Far (the main events and turning points, in order), ## Current Scene (where and when it is, who is present, what is happening right now), ## Open Threads (unresolved plans, promises, mysteries), ## World & Timeline (world rules, the date and time, how much time has passed). Omit empty sections.',
      '- Up to ' + settings.maxChars + ' characters. Details about a character, place or item belong in its entry, not here.',
      '- Always output the complete STORY.',
      '',
      'ENTRY rules:',
      '- EVERY named character gets an entry, including the user\'s character and side characters, even if they only appear briefly. List them all in CAST.',
      '- Places, groups and lore get an entry when the story keeps coming back to them. Items get an entry only when they are important to the plot over several scenes (e.g. a weapon, a gift, an heirloom, a key); never for props, clothing or objects used within a scene.',
      '- A character entry covers: who they are; appearance, clothing and distinguishing features; personality, mannerisms and how they talk; abilities; likes, dislikes and boundaries; backstory; their relationship with each other character and the moments that shaped it; feelings; current condition, injuries and whereabouts; what they carry or own; goals, promises and secrets; nicknames and running jokes. Be detailed and specific, with bullet points.',
      '- Header format: === ENTRY: Name | kind | aliases: other names, nicknames, titles === where kind is character, place, item, group or lore. Aliases are every other way the story refers to it (used to find the entry when it is mentioned).',
      '- Output ONLY entries that are new or changed by the new messages, each one complete (all old facts plus the new ones). Do not output unchanged entries. Use the exact existing name for an existing entry.',
      '- Never remove a fact unless the story changed it; then update it. When something changes, update every entry it affects (e.g. both sides of a relationship).',
      '- Never invent anything. Only record what actually happened or was stated.',
      '',
      'LOG rules:',
      '- Story replies in the new messages are numbered [R1], [R2], … Write exactly one log entry for EACH of them.',
      '- Each entry is past-tense prose describing what happened in that reply and what the user did just before it: actions, important dialogue (short quotes are fine), decisions, revelations, emotions, changes in relationships, injuries, items, where and when it happened. Use names, be concrete; no vague phrases like "they talked".',
      '- Each [R…] label says how long its entry should be (longer replies get longer entries). Reach that length with real details from the reply, never padding. Cover the whole reply, including its end.',
      '',
      'Recaps:',
      '- Some messages are RECAPS: summaries of earlier events, often written to continue the story in a new chat. They are marked [RECAP], but also recognise unmarked ones (e.g. "Previously…", "So far…", "Last time…", or a long summary of past events at the start of a chat).',
      '- A recap describes the PAST, not something happening now. Put its events into Story So Far in the right order, before the events that come after the recap in the chat, and its facts into the right entries. Only change Current Scene if the recap clearly ends by describing where things stand now.',
      '- A recap often repeats what is already known, and recaps can contain older recaps. Merge them: record each event once, and use the recap to fill gaps and correct details.',
      '- If a recap written by the USER disagrees with what is known, trust the recap. If one written by the STORY AI disagrees, keep what is known unless the recap is clearly more detailed and accurate.',
      '- Anything that happens in the chat after a recap always overrides the recap.',
      '- A story reply that is a recap gets a log entry starting with "Recap of earlier events:".',
      '',
      'If the CURRENT STORY still holds character, place or item details (from an older format), move them into entries.',
      'No commentary, no warnings, no questions. Answer in exactly this format and nothing else:',
      '=== STORY ===',
      '(the complete story)',
      '=== CAST ===',
      '(every named character in the CURRENT STORY, CURRENT ENTRIES and NEW MESSAGES, comma-separated)',
      '=== ENTRY: Name | kind | aliases: … ===',
      '(complete entry; repeat for each new or changed entry)',
      '=== LOG ===',
      '[R1] (entry for R1)',
      '[R2] (entry for R2)',
    ].join('\n');
  }

  // Messages that summarise earlier events, e.g. "Recap: …", "Previously, …",
  // "Story so far: …", "Last time …", "Quick recap of what happened".
  const RECAP_START = /^[\s*_#>()[\]~-]*(ooc\W*)?(recap\b|previously\s*(on\b|[:,.…—–-])|summary\s*[:—–-]|(the )?story so far\b|so far\s*[:—–-]|last time\s*(on\b|[:,…—–-])|catch(ing)?[ -]?up\s*[:—–-]|what happened (so far|before|previously)\b|in the (last|previous) (chapter|session|part|chat)\b)/i;
  const RECAP_EARLY = /\b(recap\s*(of\b|:)|summary of (the )?(story|events|previous|what happened|our))/i;

  function isRecap(text) {
    return RECAP_START.test(text) || RECAP_EARLY.test(text.slice(0, 150));
  }

  // Messages are passed on whole; this cap only guards against absurd sizes.
  function textLimit() {
    return 60000;
  }

  // How long a reply's log entry should be: at least 300 characters, about
  // 15% of the reply, at most 1,500.
  function entryTarget(m) {
    return Math.max(300, Math.min(1500, Math.round(m.text.length * 0.15 / 50) * 50));
  }

  // Story replies are numbered [R1], [R2], … so the log entries can be matched.
  function formatMessages(msgs, botName) {
    let n = 0;
    return msgs.map((m) => {
      const who = m.role === 'user' ? 'USER' : (botName ? 'STORY AI (' + botName + ')' : 'STORY AI');
      let t = m.text;
      if (t.length > textLimit(m)) t = t.slice(0, textLimit(m)) + ' […]';
      const num = m.role === 'assistant' ? '[R' + (++n) + ', entry about ' + entryTarget(m) + ' characters] ' : '';
      return num + (isRecap(m.text) ? '[RECAP] ' : '') + who + ': ' + t;
    }).join('\n\n');
  }

  // How much chat text goes to the memory keeper in one request.
  const CHUNK_CHARS = 20000;

  // At most this many story replies per request, so the answer (memory plus
  // one log entry per reply) stays a manageable length.
  const REPLIES_PER_CHUNK = 6;

  function chunk(msgs, maxChars) {
    const out = [];
    let cur = [];
    let size = 0;
    let replies = 0;
    for (const m of msgs) {
      const len = Math.min(m.text.length, textLimit(m)) + 40;
      const full = size + len > maxChars || (m.role === 'assistant' && replies >= REPLIES_PER_CHUNK);
      if (cur.length && full) { out.push(cur); cur = []; size = 0; replies = 0; }
      cur.push(m);
      size += len;
      if (m.role === 'assistant') replies++;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  function cleanOutput(t) {
    return String(t || '').replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').replace(MEM_BLOCK_RE, '').trim();
  }

  function formatEntries(entries) {
    if (!entries.length) return '(none yet)';
    return entries.map((e) => '=== ENTRY: ' + e.name + ' | ' + (e.kind || 'character') +
      (e.aliases && e.aliases.length ? ' | aliases: ' + e.aliases.join(', ') : '') + ' ===\n' + e.text).join('\n\n');
  }

  function knowledgeSize(story, entries) {
    return story.length + entries.reduce((n, e) => n + e.text.length, 0);
  }

  async function mergeIntoMemory(chat, msgs) {
    const user = 'CURRENT STORY:\n<<<\n' + (chat.memory.trim() || '(empty — this is the start)') + '\n>>>\n\n' +
      'CURRENT ENTRIES:\n<<<\n' + formatEntries(chat.entries) + '\n>>>\n\n' +
      (chat.pinned.trim() ? 'FACTS THE USER PINNED (always true, do not repeat them):\n<<<\n' + chat.pinned.trim() + '\n>>>\n\n' : '') +
      (chat.ignored.length ? 'NEVER write entries for (the user removed them): ' + chat.ignored.join(', ') + '\n\n' : '') +
      'NEW MESSAGES (oldest first):\n<<<\n' + formatMessages(msgs, chat.title) + '\n>>>\n\n' +
      'Write the complete STORY, the CAST, every new or changed ENTRY, and one LOG entry for each [R…] reply now.';
    const replies = msgs.filter((m) => m.role === 'assistant');
    const before = knowledgeSize(chat.memory.trim(), chat.entries);
    let parsed = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const extra = attempt === 1 ? '' : '\n\nIMPORTANT: your previous answer left out much of what is already known. Keep EVERY fact; only add and update.';
      const out = cleanOutput(await callLLM(systemPrompt(), user + extra));
      parsed = parseKeeperAnswer(out, replies);
      if (parsed.memory.length < 40 && !parsed.updates.length) {
        throw new Error('Memory keeper gave an unusable answer: "' + out.slice(0, 120) + '"');
      }
      // Much less knowledge than before means facts were dropped (or the answer was cut off).
      const story = parsed.memory.trim() || chat.memory.trim(); // a missing story section keeps the old one
      const after = knowledgeSize(story, applyUpdates(cloneEntries(chat.entries), parsed.updates, chat.ignored).entries);
      if (!(before > 1500 && after < before * 0.6)) break;
      if (attempt === 2) {
        parsed.memory = chat.memory;
        parsed.updates = [];
        toast('The memory keeper tried to drop facts, so the story and entries were kept as they were; only the reply log was updated.', true);
      }
    }
    if (!parsed.memory.trim()) parsed.memory = chat.memory;
    // Characters in the cast without an entry are asked for explicitly.
    for (let round = 0; round < 2; round++) {
      const known = applyUpdates(cloneEntries(chat.entries), parsed.updates, chat.ignored).entries;
      const skip = new Set(chat.ignored.map((n) => n.toLowerCase()));
      const missing = [...new Set(parsed.cast)].filter((n) => !findEntry(known, n) && !skip.has(n.toLowerCase()));
      if (!missing.length) break;
      const count = parsed.updates.length;
      for (let i = 0; i < missing.length; i += 4) {
        parsed.updates = parsed.updates.concat(await entriesFor(chat, msgs, parsed.memory, missing.slice(i, i + 4)));
      }
      if (parsed.updates.length === count) break;
    }
    // Replies whose log entry is missing (skipped, or the answer was cut off)
    // are asked for again, a few at a time.
    for (let round = 0; round < 3; round++) {
      const have = new Set(parsed.entries.map((e) => e.id));
      const missing = replies.filter((r) => !have.has(r.id));
      if (!missing.length) break;
      const count = parsed.entries.length;
      for (let i = 0; i < missing.length; i += 3) {
        parsed.entries = parsed.entries.concat(await logEntriesFor(chat, msgs, missing.slice(i, i + 3)));
      }
      // A keeper that won't write log entries at all is not asked forever.
      if (parsed.entries.length === count) break;
    }
    const order = new Map(replies.map((r, i) => [r.id, i]));
    parsed.entries = dedupeEntries(parsed.entries).sort((a, b) => order.get(a.id) - order.get(b.id));
    return parsed;
  }

  function cloneEntries(entries) {
    return entries.map((e) => Object.assign({}, e, { aliases: (e.aliases || []).slice() }));
  }

  function findEntry(entries, name) {
    const n = String(name).trim().toLowerCase();
    return entries.find((e) => e.name.toLowerCase() === n || (e.aliases || []).some((a) => a.toLowerCase() === n));
  }

  // Apply the keeper's new or changed entries. A rewrite that is much shorter
  // than a long existing entry probably lost details, so it is not applied.
  function applyUpdates(entries, updates, ignored) {
    const refused = [];
    const skip = new Set((ignored || []).map((n) => n.toLowerCase()));
    for (const u of updates) {
      // Entries the user deleted stay deleted.
      if ([u.name].concat(u.aliases).some((n) => skip.has(n.toLowerCase()))) continue;
      const e = findEntry(entries, u.name) || u.aliases.map((a) => findEntry(entries, a)).find(Boolean);
      if (!e) {
        entries.push({ name: u.name, kind: u.kind || 'character', aliases: u.aliases, text: u.text, always: false, updated: Date.now() });
        continue;
      }
      if (e.text.length > 800 && u.text.length < e.text.length * 0.5) {
        refused.push(e.name);
      } else {
        e.text = u.text;
        e.updated = Date.now();
      }
      if (u.kind) e.kind = u.kind;
      const names = new Set([e.name.toLowerCase()].concat(e.aliases.map((a) => a.toLowerCase())));
      for (const a of u.aliases.concat(u.name)) {
        if (!names.has(a.toLowerCase())) { e.aliases.push(a); names.add(a.toLowerCase()); }
      }
    }
    return { entries, refused };
  }

  // Ask only for entries about some characters the keeper left out.
  async function entriesFor(chat, msgs, story, names) {
    const user = 'STORY:\n<<<\n' + (story.trim() || chat.memory.trim() || '(empty)') + '\n>>>\n\n' +
      'EXISTING ENTRIES (for context):\n<<<\n' + formatEntries(chat.entries) + '\n>>>\n\n' +
      'MESSAGES:\n<<<\n' + formatMessages(msgs, chat.title) + '\n>>>\n\n' +
      'ENTRIES ONLY: write a complete character entry for each of these characters, who have none yet: ' + names.join(', ') +
      '. Use everything the story, entries and messages say about them. Use the "=== ENTRY: Name | character | aliases: … ===" format. Nothing else.';
    const out = cleanOutput(await callLLM(systemPrompt(), user));
    return parseKeeperAnswer(out, []).updates;
  }

  // Ask only for log entries of some replies (with the user message before each).
  async function logEntriesFor(chat, msgs, replies) {
    const parts = [];
    for (const r of replies) {
      const i = msgs.indexOf(r);
      const prevUser = msgs.slice(0, i).reverse().find((m) => m.role === 'user');
      parts.push(prevUser && !parts.includes(prevUser) ? prevUser : null, r);
    }
    const list = parts.filter(Boolean);
    const user = 'STORY MEMORY (for context only, do not rewrite it):\n<<<\n' + (chat.memory.trim() || '(empty)') + '\n>>>\n\n' +
      'MESSAGES:\n<<<\n' + formatMessages(list, chat.title) + '\n>>>\n\n' +
      'LOG ENTRIES ONLY: write one log entry for each [R…] reply, in the format "[R1] entry". Nothing else.';
    const out = cleanOutput(await callLLM(systemPrompt(), user));
    const logOnly = /^\W*=+\s*LOG\s*=+/im.test(out) ? out : '=== LOG ===\n' + out;
    return parseKeeperAnswer(logOnly, list.filter((m) => m.role === 'assistant')).entries;
  }

  // Split the keeper's answer into the story, new or changed entries, and
  // log entries matched to the replies they describe:
  //   === STORY === … === ENTRY: Name | kind | aliases: … === … === LOG === [R1] …
  function parseKeeperAnswer(out, replies) {
    const HEADER = /^[^\S\n]*=+[^\S\n]*(STORY|(?:STORY[^\S\n]+)?MEMORY|LOG|CAST|ENTRY[^\S\n]*:[^\n=]*?)[^\S\n]*=+[^\S\n]*$/gim;
    const marks = [];
    let m;
    while ((m = HEADER.exec(out))) marks.push({ at: m.index, end: m.index + m[0].length, head: m[1].trim() });
    let memory = '';
    const updates = [];
    const entries = [];
    let cast = [];
    // Text before any header counts as the story (older answers had no headers).
    if (!marks.length || marks[0].at > 0) memory = out.slice(0, marks.length ? marks[0].at : out.length);
    marks.forEach((mk, i) => {
      const body = out.slice(mk.end, i + 1 < marks.length ? marks[i + 1].at : out.length).trim();
      if (/^(STORY|(STORY\s+)?MEMORY)$/i.test(mk.head)) {
        memory = body;
      } else if (/^CAST$/i.test(mk.head)) {
        cast = body.split(/[,\n;]/).map((n) => n.replace(/^[\s*•-]+|[\s.]+$/g, '').replace(/\s*\(.*\)$/, '').trim())
          .filter((n) => n && n.length < 60 && !/^(you|user|the user|narrator|\{\{user\}\}|none)$/i.test(n));
      } else if (/^LOG$/i.test(mk.head)) {
        const re = /\[R(\d+)[^\]\n]*\]\s*([\s\S]*?)(?=\n\s*\[R\d+[^\]\n]*\]|$)/g;
        let r;
        while ((r = re.exec(body))) {
          const reply = replies[Number(r[1]) - 1];
          const text = r[2].replace(/\s+/g, ' ').trim();
          if (reply && text) entries.push({ id: reply.id, text });
        }
      } else {
        const fields = mk.head.replace(/^ENTRY\s*:\s*/i, '').split('|').map((x) => x.trim());
        const name = fields[0];
        let kind = '';
        let aliases = [];
        for (const f of fields.slice(1)) {
          if (/^aliases?\s*:/i.test(f)) aliases = f.replace(/^aliases?\s*:/i, '').split(',').map((a) => a.trim()).filter((a) => a && a.toLowerCase() !== name.toLowerCase());
          else if (f) kind = f.toLowerCase();
        }
        if (name && body) updates.push({ name, kind, aliases, text: body });
      }
    });
    return { memory: cleanOutput(memory), updates, entries: dedupeEntries(entries), cast };
  }

  // One entry per reply; if the keeper wrote two, keep the longer one.
  function dedupeEntries(entries) {
    const best = new Map();
    for (const e of entries) if (!best.has(e.id) || e.text.length > best.get(e.id).text.length) best.set(e.id, e);
    return entries.filter((e) => best.get(e.id) === e);
  }

  // Story order: entries for older messages (not in this list) first, as they
  // were; then the rest in the order their replies appear in the chat.
  function sortLog(log, msgs) {
    const pos = new Map(msgs.map((m, i) => [m.id, i]));
    const older = log.filter((e) => !pos.has(e.id));
    const known = log.filter((e) => pos.has(e.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
    return older.concat(known);
  }

  // For "Undo last change": the story and all entries as they were.
  function snapshot(chat) {
    return { memory: chat.memory, entries: cloneEntries(chat.entries) };
  }

  function restore(chat, snap) {
    if (typeof snap === 'string') { chat.memory = snap; return; } // older versions kept only the text
    chat.memory = snap.memory;
    chat.entries = cloneEntries(snap.entries || []);
  }

  // Fold every not-yet-processed message of a chat into its memory.
  async function updateMemory(id, msgs, { force = false } = {}) {
    const chat = await getChat(id, true);
    if (busy[id] || (!chat.enabled && !force)) return;
    const todo = unprocessed(chat, msgs);
    if (!todo.length) return;
    busy[id] = true;
    setStatus();
    const before = snapshot(chat);
    const parts = chunk(todo, CHUNK_CHARS);
    progress[id] = { done: 0, total: parts.length };
    renderPanel();
    try {
      for (const part of parts) {
        const result = await mergeIntoMemory(chat, part);
        chat.memory = result.memory;
        const applied = applyUpdates(chat.entries, result.updates, chat.ignored);
        if (applied.refused.length) toast('Kept the fuller version of: ' + applied.refused.join(', '));
        // One entry per reply; a regenerated or re-read reply replaces its old entry.
        const ids = new Set(result.entries.map((e) => e.id));
        chat.log = sortLog(chat.log.filter((e) => !ids.has(e.id)).concat(result.entries), msgs);
        chat.processedIds = chat.processedIds.concat(part.map((m) => m.id)).slice(-300);
        chat.processedCount = msgs.indexOf(part[part.length - 1]) + 1;
        chat.lastUpdate = Date.now();
        chat.lastError = '';
        progress[id].done++;
        await saveChat(chat);
        renderPanel();
      }
      if (JSON.stringify(before) !== JSON.stringify(snapshot(chat))) {
        chat.history = [before].concat(chat.history).slice(0, 5);
      }
      await saveChat(chat);
    } catch (e) {
      chat.lastError = String(e.message || e);
      await saveChat(chat);
      toast('Story memory update failed: ' + chat.lastError, true);
    } finally {
      busy[id] = false;
      delete progress[id];
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
  const siteLog = new Map();        // the site's own requests, for Diagnostics
  const ownLog = new Map();         // Story Manager's requests, for Diagnostics
  const sockLog = new Map();        // Socket.IO events, for Diagnostics

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

  function addTo(map, key, entry, max) {
    const prev = map.get(key);
    map.delete(key);
    map.set(key, Object.assign(entry, { count: prev ? prev.count + 1 : 1 }));
    while (map.size > max) map.delete(map.keys().next().value);
  }

  function logApi(method, url, status, data, note) {
    let found = 0;
    try { found = extractMessages(data).length; } catch (e) { /* ignore */ }
    const entry = { method, url: shortUrl(url), status, info: describe(data), found, note: note || '' };
    if (note === 'site') {
      addTo(siteLog, method + ' ' + entry.url + ' ' + status + ' ' + entry.info, entry, 40);
    } else {
      addTo(ownLog, method + ' ' + entry.url + ' ' + status + ' ' + entry.note + ' ' + entry.info, entry, 20);
    }
  }

  function logSocket(dir, event, args) {
    let found = 0;
    try { found = extractMessages(args).length; } catch (e) { /* ignore */ }
    let info = describe(args && args.length === 1 ? args[0] : args);
    const pl = args && args[0] && args[0].payload;
    if (pl && typeof pl === 'object') info += ' | payload: ' + describe(pl);
    addTo(sockLog, dir + ' ' + event + ' ' + info, { dir, event, info, found }, 30);
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
    return pick ? { id: pick, inUrl: inUrl.includes(pick) } : null;
  }

  // Ask the learned endpoint for every page of a chat's messages.
  // Query parameters that point at a position in the chat (a "cursor").
  // A saved cursor is only valid once, so they are never kept in the address.
  const CURSOR_PARAM = /before|after|cursor/i;

  function cleanTemplate(t) {
    const i = t.indexOf('?');
    if (i < 0) return t;
    const q = new URLSearchParams(t.slice(i + 1));
    for (const k of [...q.keys()]) if (CURSOR_PARAM.test(k)) q.delete(k);
    const qs = q.toString().replace(/%7Bid%7D/gi, '{id}');
    return t.slice(0, i) + (qs ? '?' + qs : '');
  }

  // Read a chat through the learned address, newest page first.
  //   mode 'latest': only the newest page
  //   mode 'full':   every page, back to the start of the chat
  //   stopAt:        stop paging once a page holds one of these message ids
  async function fetchLearned(id, { mode = 'latest', stopAt = null } = {}) {
    const u = new URL(cleanTemplate(learned.template).split('{id}').join(id));
    let opts = null;
    try { opts = JSON.parse(u.searchParams.get('options') || 'null'); } catch (e) { /* ignore */ }
    const paged = opts && typeof opts === 'object' && 'page' in opts;
    const plainPaged = !paged && u.searchParams.has('page');
    // Ask for bigger pages; fall back to the site's own size if refused.
    const siteLimit = u.searchParams.get('limit');
    if (siteLimit && Number(siteLimit) < 50) u.searchParams.set('limit', '50');
    let all = [];
    for (let page = 1; page <= 200; page++) {
      if (paged) { opts.page = page; u.searchParams.set('options', JSON.stringify(opts)); }
      else if (plainPaged) u.searchParams.set('page', String(page));
      let data;
      try {
        data = await rpc('GET', u.href);
      } catch (e) {
        if (page === 1 && siteLimit && u.searchParams.get('limit') !== siteLimit) {
          u.searchParams.set('limit', siteLimit);
          page--;
          continue;
        }
        throw e;
      }
      const msgs = extractMessages(data);
      logApi('GET', u.href, 200, data, 'Story Manager, page ' + page);
      const before = all.length;
      all = mergeMsgs(all, msgs);
      if (mode === 'latest' || !msgs.length || all.length === before) break;
      if (stopAt && msgs.some((m) => stopAt.has(m.id))) break;
      if (paged || plainPaged) {
        const per = Number((paged ? opts.itemsPerPage : u.searchParams.get('itemsPerPage')) || 0);
        if (per && findMessageArray(data).length < per) break;
        continue;
      }
      // Cursor paging: follow the "next…" value the server hands back, e.g.
      // { hasMore, nextBeforeMessageId } -> ?beforeMessageId=…
      const nextKey = data && typeof data === 'object' && !Array.isArray(data)
        ? Object.keys(data).find((k) => /^next./i.test(k) && data[k] && typeof data[k] !== 'object')
        : null;
      if (!nextKey || data.hasMore === false) break;
      const name = nextKey.replace(/^next/i, '');
      u.searchParams.set(name.charAt(0).toLowerCase() + name.slice(1), String(data[nextKey]));
    }
    return all;
  }

  // Every address the page has requested from MiniApps, from the browser's own
  // list. This works even when the hook started too late to see the requests.
  function apiResourceUrls() {
    const out = [];
    try {
      for (const e of performance.getEntriesByType('resource')) {
        if (/^https:\/\/([a-z0-9-]+\.)*miniapps\.ai\//i.test(e.name) &&
          !/\.(js|mjs|css|png|jpe?g|webp|avif|svg|gif|woff2?|ttf|ico|mp3|mp4|webm|json)(\?|$)/i.test(e.name)) {
          out.push({ url: e.name, type: e.initiatorType });
        }
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function decodeUrl(url) {
    try { return decodeURIComponent(url); } catch (e) { return url; }
  }

  // Try the requests the page made about this chat until one returns messages,
  // then remember that address for next time.
  async function discoverMessages(id, readOpts) {
    const idRe = new RegExp(id, 'i');
    const seen = new Set();
    const cands = [];
    for (const r of apiResourceUrls().reverse()) {
      const dec = decodeUrl(r.url);
      if (!idRe.test(dec)) continue;
      let path = '';
      try { path = new URL(r.url).pathname; } catch (e) { continue; }
      if (/\/conversations\/[0-9a-f-]{36}\/?$/i.test(path) || /\/chat\/?$/.test(path)) continue;
      const key = shortUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      cands.push(r.url);
    }
    for (const url of cands.slice(0, 8)) {
      let data;
      try { data = await rpc('GET', url); } catch (e) { logApi('GET', url, 'error', null, 'probe: ' + String(e.message || e).slice(0, 60)); continue; }
      const msgs = extractMessages(data);
      logApi('GET', url, 200, data, 'probe');
      if (msgs.length) {
        learned = { template: cleanTemplate(decodeUrl(url).replace(new RegExp(id, 'gi'), '{id}')) };
        await Store.set('learned', learned);
        try { return mergeMsgs(msgs, await fetchLearned(id, readOpts)); } catch (e) { return msgs; }
      }
    }
    return [];
  }

  // mode 'latest': newest messages only (cheap, for checking on replies)
  // mode 'since':  everything after what is already in the memory
  // mode 'full':   the whole chat
  async function fetchMessages(id, { cache = true, mode = 'since' } = {}) {
    const chat = cache ? await getChat(id, true) : null;
    let readOpts = { mode: mode === 'latest' ? 'latest' : 'full', stopAt: null };
    if (mode === 'since' && chat && chat.processedIds.length) readOpts.stopAt = new Set(chat.processedIds);
    let msgs = [];
    let firstErr = null;
    // The documented address; on the current site it only has the chat's
    // settings (and title), so skip it once a better address is known.
    if (!learned || (chat && !chat.title)) {
      try {
        const data = await rpc('GET', '/conversations/' + id);
        logApi('GET', 'https://api.miniapps.ai/conversations/' + id, 200, data, 'Story Manager');
        msgs = extractMessages(data);
        const t = titleOf(data);
        if (chat && t && !chat.title) { chat.title = t; await saveChat(chat); }
      } catch (e) { firstErr = e; logApi('GET', 'https://api.miniapps.ai/conversations/' + id, 'error', null, String(e.message || e)); }
    }
    if (learned && learned.template) {
      try {
        msgs = mergeMsgs(msgs, await fetchLearned(id, readOpts));
      } catch (e) {
        firstErr = firstErr || e;
        logApi('GET', cleanTemplate(learned.template).split('{id}').join(id), 'error', null, String(e.message || e));
      }
    }
    if (!msgs.length && cache && !(seenMsgs[id] && seenMsgs[id].size)) {
      try { msgs = await discoverMessages(id, readOpts); } catch (e) { logApi('GET', 'discovery', 'error', null, String(e.message || e)); }
    }
    if (!msgs.length && firstErr && !cache) throw firstErr;
    return cache ? remember(id, msgs) : msgs;
  }

  const FIRST_RUN_MESSAGES = 40;

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
    if (!chat.enabled || busy[id] || fresh < Math.max(1, Number(settings.updateEvery) || 1)) return;
    // The site only loads the newest messages; fetch anything in between.
    if (learned && chat.processedIds.length) {
      try {
        const all = await fetchMessages(id, { mode: 'since' });
        usable = final || !all.length || all[all.length - 1].role !== 'assistant' ? all : all.slice(0, -1);
      } catch (e) { /* use what we have */ }
    }
    // A chat seen for the first time starts from its recent messages; the
    // whole history is read only when asked (Rebuild), as it can be long.
    if (!chat.processedIds.length && !chat.memory.trim() && usable.length > FIRST_RUN_MESSAGES) {
      usable = usable.slice(-FIRST_RUN_MESSAGES);
      toast('Story memory started from the latest messages. Tap 📖 → Rebuild to read the whole chat.');
    }
    await updateMemory(id, usable);
  }

  // After a message is sent, wait for the AI to finish its reply, then sync.
  async function waitForReply(id, userText) {
    const token = {};
    polls[id] = token;
    const want = String(userText || '').trim().slice(0, 60);
    let prev = null;
    let empty = 0;
    for (let i = 0; i < 75 && polls[id] === token; i++) {
      await sleep(4000);
      let msgs;
      try { msgs = await fetchMessages(id, { mode: 'latest' }); } catch (e) { continue; }
      // Nothing readable this way (the socket listener covers that case).
      if (!msgs.length && ++empty >= 3) break;
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
    // Memories used to be much shorter; move the old default up.
    if (settings.maxChars === 3000 || settings.maxChars === 5000) settings.maxChars = DEFAULT_SETTINGS.maxChars;
    chatIndex = await Store.get('chatIndex', []);
    learned = await Store.get('learned', null);
    helperChat = await Store.get('helperChat', null);
    if (helperChat) helperIds.add(helperChat.id);
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
    if (!conv || helperIds.has(conv.id)) return;
    if (conv.inUrl && d.method === 'GET') {
      const decoded = (() => { try { return decodeURIComponent(d.url); } catch (e) { return d.url; } })();
      const template = cleanTemplate(decoded.split(conv.id).join('{id}'));
      if (!learned || learned.template !== template) {
        learned = { template };
        await Store.set('learned', learned);
      }
    }
    setCurrent(conv.id);
    await syncChat(conv.id, remember(conv.id, msgs), { final: false });
  });

  // Messages that arrive over the live connection (history or new replies).
  on('ws', async (d) => {
    await ready;
    let args = null;
    try { args = d.text ? JSON.parse(d.text) : null; } catch (e) { /* ignore */ }
    logSocket(d.dir, d.event, args);
    if (d.dir !== 'in' || !args) return;
    const first = args[0] && typeof args[0] === 'object' ? args[0] : null;
    const chatOf = first && (first.cId || first.conversationId);
    if (chatOf) lastActivity[String(chatOf).toLowerCase()] = Date.now();
    let msgs = extractMessages(args);
    let conv = null;
    // Events like { cId, requestId, payload: { …message… } } carry a whole message.
    if (!msgs.length && chatOf && first.payload && typeof first.payload === 'object' && !Array.isArray(first.payload)) {
      const pm = first.payload;
      const text = textOf(pm).replace(MEM_BLOCK_RE, '').trim();
      const role = roleOf(pm);
      if (text && role !== 'system') {
        msgs = [{ id: String(pm.id || first.tmpId || first.requestId || ('h-' + hashText(text))), role, text, t: Date.parse(pm.createdAt || '') || Date.now() }];
        conv = { id: String(chatOf).toLowerCase() };
      }
    }
    if (!msgs.length) return;
    conv = conv || convIdFor('', args && args.length === 1 ? args[0] : args, findMessageArray(args)) || (currentId ? { id: currentId } : null);
    if (!conv) return;
    // Replies of the MiniApps-bot memory keeper are only collected for it.
    if (helperIds.has(conv.id)) { remember(conv.id, msgs); return; }
    setCurrent(conv.id);
    // A single finished AI message means the reply is complete.
    const final = msgs.length === 1 && msgs[0].role === 'assistant';
    await syncChat(conv.id, remember(conv.id, msgs), { final });
  });

  const sentStats = { sent: 0, withMemory: 0 };
  const lastSentInfo = {};      // chat id -> what the last message carried

  on('sent', async (d) => {
    sentStats.sent++;
    if (d.injected) sentStats.withMemory++;
    if (d.conversationId && d.injected) {
      lastSentInfo[d.conversationId] = 'story' + (d.included && d.included.length ? ', ' + d.included.join(', ') : '') +
        ' (' + Number(d.size || 0).toLocaleString() + ' characters)';
    }
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
    textarea.log { min-height: 200px; }
    textarea.entry { min-height: 180px; }
    details.entrybox { background: #0e0e13; border: 1px solid #33334a; border-radius: 8px; padding: 8px 10px; margin: 6px 0; }
    details.entrybox summary { cursor: pointer; font-weight: 600; }
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

    const editors = chat.entries.map((e) => entryEditor(chat, e));

    const save = async (quiet) => {
      const snap = snapshot(chat);
      chat.pinned = pinned.value;
      chat.memory = mem.value;
      for (const ed of editors) ed.apply();
      for (const e of chat.entries.filter((x) => x.deleted)) {
        for (const n of entryKeys(e)) if (!chat.ignored.includes(n.toLowerCase())) chat.ignored.push(n.toLowerCase());
      }
      chat.entries = chat.entries.filter((e) => !e.deleted && (e.name.trim() || e.text.trim()));
      if (JSON.stringify(snap) !== JSON.stringify(snapshot(chat))) chat.history = [snap].concat(chat.history).slice(0, 5);
      await saveChat(chat);
      if (quiet !== true) toast('Saved');
      renderPanel(true);
    };

    const addEntry = async () => {
      await save(true);
      chat.entries.push({ name: 'New entry', kind: 'character', aliases: [], text: '', always: false, updated: Date.now(), open: true });
      await saveChat(chat);
      renderPanel(true);
    };

    const runNow = async (rebuild) => {
      if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
      try {
        await save(true);
        toast(rebuild ? 'Reading the whole chat…' : 'Checking for new messages…');
        const msgs = await fetchMessages(chat.id, { mode: rebuild ? 'full' : 'since' });
        chat.knownMessages = Math.max(chat.knownMessages || 0, msgs.length);
        if (!msgs.length) {
          toast('Could not find any messages in this chat yet. Scroll through the chat, then try again — or open Diagnostics and send it to Claude.', true);
          return;
        }
        if (rebuild) {
          const parts = chunk(msgs, CHUNK_CHARS).length;
          const cost = settings.provider === 'miniapps'
            ? ' Each one uses MiniApps credits.'
            : '';
          if (!confirm('Rebuild the memory from all ' + msgs.length + ' messages? This takes about ' + parts +
            ' memory-keeper request' + (parts === 1 ? '' : 's') + '.' + cost +
            ' (Pinned facts and entries marked "Always send" are kept.)')) return;
          // Let an automatic update that started meanwhile finish first.
          for (let i = 0; busy[chat.id] && i < 600; i++) await sleep(500);
          const old = { snap: snapshot(chat), log: chat.log.slice(), ids: chat.processedIds.slice(), count: chat.processedCount };
          chat.history = [old.snap].concat(chat.history).slice(0, 5);
          chat.memory = '';
          chat.entries = chat.entries.filter((e) => e.always);
          chat.log = [];
          chat.processedIds = [];
          chat.processedCount = 0;
          await saveChat(chat);
          renderPanel(true);
          await updateMemory(chat.id, msgs, { force: true });
          if (chat.lastError && !chat.processedIds.length) {
            // Nothing was rebuilt: put the previous memory back.
            restore(chat, old.snap);
            chat.log = old.log;
            chat.processedIds = old.ids;
            chat.processedCount = old.count;
            chat.history.shift();
            await saveChat(chat);
            toast('Rebuild failed, so the previous memory was kept: ' + chat.lastError, true);
          } else if (chat.lastError) {
            toast('Rebuild stopped partway: ' + chat.lastError + ' Tap "Update now" to continue from where it stopped.', true);
          } else {
            toast('Memory rebuilt');
          }
          renderPanel(true);
          return;
        } else if (!unprocessed(chat, msgs).length) {
          toast('Memory is already up to date (' + msgs.length + ' messages checked)');
          return;
        }
        await updateMemory(chat.id, msgs, { force: true });
        if (!chat.lastError) toast('Memory updated');
      } catch (e) {
        toast(String(e.message || e), true);
      }
      renderPanel(true);
    };

    const undo = async () => {
      if (!chat.history.length) return;
      restore(chat, chat.history.shift());
      await saveChat(chat);
      toast('Restored the previous version');
      renderPanel(true);
    };

    const total = chat.knownMessages || 0;
    const inPlay = entriesInPlay(chat).map((e) => e.name);
    return el('div', {},
      el('div', { class: 'status' },
        el('div', {}, el('b', {}, chat.title || 'Chat'), ' · ', chat.id.slice(0, 8)),
        el('div', {}, 'Messages read: ', el('b', {}, String(chat.processedCount)), total ? ' of ' + total : '',
          ' · Last update: ', el('b', {}, ago(chat.lastUpdate))),
        lastSentInfo[chat.id] ? el('div', {}, 'Last message carried: ' + lastSentInfo[chat.id]) : null,
        isBusy ? el('div', {}, '⏳ Updating memory…' + (progress[chat.id] && progress[chat.id].total > 1
          ? ' (request ' + Math.min(progress[chat.id].done + 1, progress[chat.id].total) + ' of ' + progress[chat.id].total + ')' : '')) : null,
        chat.lastError ? el('div', { class: 'error' }, '⚠ ' + chat.lastError) : null),
      el('div', { class: 'row' }, enabled, el('label', { for: 'smx-en' }, 'Auto-manage this chat')),
      el('label', {}, '📌 Pinned facts (never changed automatically, always sent)'),
      pinned,
      el('label', {}, '📖 The story (big picture, current scene, open threads; always sent)'),
      mem,
      el('div', { class: 'hint' }, mem.value.length + ' characters.'),
      el('label', {}, '👥 Entries (' + chat.entries.length + ')'),
      el('div', { class: 'hint' }, inPlay.length
        ? 'In play right now (sent with every message): ' + inPlay.join(', ') + '. Others are sent when your message mentions them.'
        : 'Characters, places and items get their own entries as the story goes on. Each is sent when it is in the current scene or your message mentions it.'),
      editors.map((ed) => ed.node),
      el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: addEntry }, '+ Add entry')),
      chat.ignored.length ? el('div', { class: 'hint' }, 'Deleted, not created again: ' + chat.ignored.join(', ') + ' ',
        el('button', { class: 'btn', onclick: async () => { chat.ignored = []; await saveChat(chat); renderPanel(true); } }, 'Allow again')) : null,
      logView(chat),
      el('div', { class: 'btns' },
        el('button', { class: 'btn primary', onclick: save }, 'Save'),
        el('button', { class: 'btn', disabled: isBusy, onclick: () => runNow(false) }, 'Update now'),
        el('button', { class: 'btn', disabled: isBusy, onclick: () => runNow(true) }, 'Rebuild from whole chat'),
        el('button', { class: 'btn', disabled: !chat.history.length, onclick: undo }, 'Undo last change')),
      diagnosticsBox());
  }

  // One collapsible entry in the panel. apply() copies the edits into it.
  function entryEditor(chat, e) {
    const name = el('input', { value: e.name });
    const kind = el('select', {}, ...['character', 'place', 'item', 'group', 'lore'].map((k) => el('option', { value: k }, k)));
    kind.value = e.kind || 'character';
    const aliases = el('input', { value: (e.aliases || []).join(', '), placeholder: 'Other names, nicknames, titles' });
    const text = el('textarea', { class: 'entry' });
    text.value = e.text;
    const always = el('input', { type: 'checkbox' });
    always.checked = !!e.always;
    const del = el('button', { class: 'btn', onclick: () => {
      if (!confirm('Delete the entry "' + e.name + '"? It will not be created again. (Save to confirm.)')) return;
      e.deleted = true;
      node.style.opacity = '0.4';
    } }, 'Delete');
    const node = el('details', { class: 'entrybox', open: e.open || undefined },
      el('summary', {}, (e.always ? '★ ' : '') + e.name + ' · ' + (e.kind || 'character') + ' · ' + e.text.length + ' chars'),
      el('label', {}, 'Name'), name,
      el('label', {}, 'Kind'), kind,
      el('label', {}, 'Also known as (comma-separated)'), aliases,
      el('label', {}, 'Details'), text,
      el('div', { class: 'row' }, always, el('label', {}, 'Always send (and keep on Rebuild)')),
      el('div', { class: 'btns' }, del));
    return {
      node,
      apply() {
        e.name = name.value.trim() || e.name;
        e.kind = kind.value;
        e.aliases = aliases.value.split(',').map((a) => a.trim()).filter(Boolean);
        if (text.value !== e.text) { e.text = text.value; e.updated = Date.now(); }
        e.always = always.checked;
        delete e.open;
      },
    };
  }

  let hookStats = null;
  on('stats', (d) => { hookStats = d; });

  // The reply-by-reply log, newest first; read-only (Rebuild redoes it).
  function logView(chat) {
    const box = el('textarea', { readonly: true, class: 'log' });
    box.value = chat.log.length
      ? chat.log.slice().reverse().map((e, i) => '#' + (chat.log.length - i) + '  ' + e.text).join('\n\n')
      : 'Each AI reply gets a detailed summary here as the story goes on.';
    const attached = Math.min(chat.log.length, Math.max(0, Number(settings.logAttach) || 0));
    return el('div', {},
      el('label', {}, '📜 Reply-by-reply log (' + chat.log.length + ' entries, newest first)'),
      box,
      el('div', { class: 'hint' }, 'The latest ' + attached + ' of these are attached to your messages in full.'));
  }

  function diagnosticsText() {
    document.dispatchEvent(new CustomEvent('smx:ping'));
    const version = typeof GM_info !== 'undefined' && GM_info && GM_info.script ? GM_info.script.version : '?';
    const chat = currentId && chats[currentId];
    const lines = [
      'Story Manager v' + version,
      'Page: ' + shortUrl(location.href),
      'Current chat: ' + (currentId ? currentId.slice(0, 8) : 'none') +
        (chat ? ' · messages seen: ' + (seenMsgs[currentId] ? seenMsgs[currentId].size : 0) + ' · read into memory: ' + chat.processedCount : ''),
      'Learned message address: ' + (learned ? shortUrl(learned.template.split('{id}').join('00000000-0000-0000-0000-000000000000')) : 'none yet'),
      'Memory keeper: ' + settings.provider,
      'Messages sent on this page: ' + sentStats.sent + ' · with memory attached: ' + sentStats.withMemory +
        (currentId && lastSentInfo[currentId] ? ' · last carried: ' + lastSentInfo[currentId] : ''),
      'Hook: ' + (hookStats ? JSON.stringify(hookStats) : 'not running'),
      '',
      'Site requests to MiniApps (newest first, no message text):',
    ];
    const fmt = (a) => a.method + ' ' + a.url + ' → ' + a.status + (a.count > 1 ? ' ×' + a.count : '') +
      (a.note && a.note !== 'site' ? ' [' + a.note + ']' : '') + ' · messages: ' + a.found + ' · ' + a.info;
    const site = [...siteLog.values()].reverse();
    if (!site.length) lines.push('(none seen)');
    for (const a of site) lines.push(fmt(a));
    lines.push('', 'Live connection events (newest first):');
    const sock = [...sockLog.values()].reverse();
    if (!sock.length) lines.push('(none seen)');
    for (const w of sock) lines.push(w.dir + ' ' + w.event + (w.count > 1 ? ' ×' + w.count : '') + ' · messages: ' + w.found + ' · ' + w.info);
    lines.push('', 'Story Manager\'s own requests:');
    for (const a of [...ownLog.values()].reverse()) lines.push(fmt(a));
    lines.push('', 'All MiniApps addresses the browser requested on this page:');
    const counts = new Map();
    for (const r of apiResourceUrls()) {
      const k = r.type + ' ' + shortUrl(r.url) + (currentId && new RegExp(currentId, 'i').test(decodeUrl(r.url)) ? '  ← this chat' : '');
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    if (!counts.size) lines.push('(none listed)');
    for (const [k, n] of [...counts].slice(-40)) lines.push(k + (n > 1 ? ' ×' + n : ''));
    return lines.join('\n');
  }

  function diagnosticsBox() {
    const box = el('textarea', { readonly: true, class: 'diag' });
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
    f.helperRotate = el('input', { type: 'number', min: '0', value: String(s.helperRotate) });
    f.updateEvery = el('input', { type: 'number', min: '1', value: String(s.updateEvery) });
    f.injectEvery = el('input', { type: 'number', min: '0', value: String(s.injectEvery) });
    f.maxChars = el('input', { type: 'number', min: '500', step: '250', value: String(s.maxChars) });
    f.logAttach = el('input', { type: 'number', min: '0', value: String(s.logAttach) });
    f.injectBudget = el('input', { type: 'number', min: '2000', step: '1000', value: String(s.injectBudget) });
    f.autoEnable = el('input', { type: 'checkbox', id: 'smx-auto' });
    f.autoEnable.checked = s.autoEnable;
    f.buttonSide = el('select', {}, el('option', { value: 'right' }, 'Right'), el('option', { value: 'left' }, 'Left'));
    f.buttonSide.value = s.buttonSide;

    const keyBox = el('div', {}, el('label', {}, 'API key'), f.apiKey, el('label', {}, 'Model'), f.model);
    const baseBox = el('div', {}, el('label', {}, 'Base URL'), f.baseUrl,
      el('div', { class: 'hint' }, 'OpenRouter: https://openrouter.ai/api/v1 · OpenAI: https://api.openai.com/v1 · Groq: https://api.groq.com/openai/v1'));
    const slugBox = el('div', {}, el('label', {}, 'MiniApps bot used as memory keeper (slug from its URL)'), f.miniappsSlug,
      el('div', { class: 'hint' }, 'Memory updates are sent to this bot in one helper chat in your MiniApps history (uses MiniApps credits).'),
      el('label', {}, 'Start a fresh helper chat every … requests (0 = always the same chat)'), f.helperRotate,
      el('div', { class: 'hint' }, 'The helper chat grows with every update. If updates get slow or start failing, set this to e.g. 20.'));
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
      helperRotate: Math.max(0, parseInt(f.helperRotate.value, 10) || 0),
      updateEvery: Math.max(1, parseInt(f.updateEvery.value, 10) || 1),
      injectEvery: Math.max(0, parseInt(f.injectEvery.value, 10) || 0),
      maxChars: Math.max(500, parseInt(f.maxChars.value, 10) || DEFAULT_SETTINGS.maxChars),
      logAttach: Math.max(0, parseInt(f.logAttach.value, 10) || 0),
      injectBudget: Math.max(2000, parseInt(f.injectBudget.value, 10) || DEFAULT_SETTINGS.injectBudget),
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
      el('label', {}, 'Story entry size (characters)'), f.maxChars,
      el('label', {}, 'Most characters attached to one message'), f.injectBudget,
      el('div', { class: 'hint' }, 'The story and entries in play are always attached; entries your message mentions and the newest reply summaries fill the rest of this space.'),
      el('label', {}, 'Detailed reply summaries attached to each message'), f.logAttach,
      el('div', { class: 'hint' }, 'Every AI reply gets a 300–500 character summary. The newest ones are attached to your messages in full; 15 is about 6,000 characters. More helps the AI remember detail, but makes every message longer.'),
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
