// ==UserScript==
// @name         MiniApps Story Manager
// @namespace    https://github.com/randommail5364-netizen/Story-Manager
// @version      3.2.0
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
    helperRotate: 30, // start a new helper chat every N requests (0 = always the same one)
    updateEvery: 3,   // AI replies between summary requests
    foldEvery: 9,     // AI replies between story & character updates
    chapterSize: 15,  // AI replies per chapter
    parallel: 1,      // summary requests that may run at the same time
    injectEvery: 1,   // attach memory to every Nth message (0 = never)
    detail: 'detailed', // how long summaries and entries are: standard | detailed | maximum
    logAttach: 15,    // detailed reply summaries attached to each message
    injectBudget: 24000, // most characters attached to one message
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
  const stopRequested = {};     // id -> true when the user tapped Stop
  let activeChatId = null;      // chat whose memory is being updated right now
  const AUTO_MAX_REQUESTS = 2;  // bigger catch-ups only run when the user asks

  function stopError() {
    const e = new Error('Stopped');
    e.stopped = true;
    return e;
  }

  function checkStop() {
    if (activeChatId && stopRequested[activeChatId]) throw stopError();
  }
  const polls = {};             // id -> poll token
  const helperIds = new Set();  // conversations created by the memory keeper itself

  function newChat(id) {
    return {
      id,
      title: '',
      enabled: settings.autoEnable,
      version: 3,
      memory: '',       // the story now: current scene, open threads, world & timeline
      entries: [],      // [{ name, kind, aliases, text, always, updated }]: characters, places, …
      ignored: [],      // lower-case names of entries the user deleted; never recreated
      // [{ id, text, facts, folded, chapter }]: a detailed summary of each AI
      // reply; folded = its facts are in the story and entries; chapter = the
      // index of the chapter it belongs to
      log: [],
      chapters: [],     // [{ title, text, ids }]: the story's history, chapter by chapter
      jobs: [],         // what the memory keeper did, newest first (Activity)
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
      const chat = chats[id] = Object.assign(newChat(id), { version: 0 }, saved);
      if (chat.version < 3) await migrate(chat);
      if (tidy(chat).length) await saveChat(chat);
      // Older versions could save a looping answer; clean it up once.
      if ((chat.repaired || 0) < 1) {
        const before = JSON.stringify([chat.memory, chat.entries, chat.log]).length;
        const changed = repairChat(chat);
        chat.repaired = 1;
        await saveChat(chat);
        if (changed) toast('Removed ' + Math.round((before - JSON.stringify([chat.memory, chat.entries, chat.log]).length) / 1000) + 'k characters of repeated text from this chat\'s memory.');
      }
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

  // Version 3 keeps the history in chapters instead of a "Story So Far"
  // section: the old section becomes the first chapter, and everything
  // already in the memory counts as folded into it.
  async function migrate(chat) {
    const history = sectionOf(chat.memory, 'Story So Far').trim();
    chat.chapters = chat.chapters || [];
    if (history) {
      chat.chapters.push({ title: 'The story until now', text: history, ids: chat.log.map((e) => e.id) });
      chat.memory = removeSection(chat.memory, 'Story So Far');
    }
    for (const e of chat.log) {
      e.folded = true;
      if (history) e.chapter = 0;
    }
    chat.version = 3;
    await saveChat(chat);
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
  // The history for the storyteller: the newest chapters in full, older ones
  // by title only once they no longer fit.
  function chaptersText(chat, budget) {
    const lines = [];
    let size = 0;
    for (let i = chat.chapters.length - 1; i >= 0; i--) {
      const c = chat.chapters[i];
      const full = 'Chapter ' + (i + 1) + ': ' + c.title + '\n' + c.text;
      const short = 'Chapter ' + (i + 1) + ': ' + c.title;
      const t = size + full.length <= budget ? full : short;
      lines.unshift(t);
      size += t.length + 2;
    }
    return lines.join('\n\n');
  }

  function buildPlan(chat) {
    const head = [];
    const budget = Math.max(2000, Number(settings.injectBudget) || DEFAULT_SETTINGS.injectBudget);
    if (chat.pinned.trim()) head.push('## Must remember\n' + chat.pinned.trim());
    if (chat.chapters.length) head.push('## The story so far, chapter by chapter\n' + chaptersText(chat, Math.round(budget * 0.3)));
    if (chat.memory.trim()) head.push('## The story now\n' + chat.memory.trim());
    const inPlay = new Set(entriesInPlay(chat));
    const pack = (e) => ({ name: e.name, kind: e.kind || '', keys: entryKeys(e), text: e.text });
    const plan = {
      prefix: MEM_START + '\n(Background notes for story continuity. Use them silently; do not quote, mention or reply to them.)\n\n',
      suffix: '\n' + MEM_END,
      head: head.join('\n\n'),
      core: chat.entries.filter((e) => inPlay.has(e)).map(pack),
      extra: chat.entries.filter((e) => !inPlay.has(e)).map(pack),
      // Everything since the last chapter (or at least the newest logAttach),
      // newest first as far as the space allows.
      log: chat.log.slice(-Math.max(Math.max(0, Number(settings.logAttach) || 0), chat.log.filter((e) => e.chapter == null).length))
        .map((e) => e.text),
      budget,
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
      index: typeof m.index === 'number' ? m.index : null,
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

  // slot: which helper chat to use when several requests run at once.
  async function callLLM(system, user, slot = 0) {
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
    return callMiniApps(system + '\n\n' + user, slot);
  }

  // Uses one of the site's own chatbots as the memory keeper (costs MiniApps credits).
  let toolCache = null;
  // Requests go to a helper chat with the bot (remembered across visits), so
  // they don't each add a chat to the user's MiniApps history. Requests that
  // run at the same time each get their own helper chat (slot).
  const helperChats = [];  // slot -> { slug, id, uses }
  const helperKey = (slot) => (slot ? 'helperChat' + slot : 'helperChat');
  const lastActivity = {}; // chat id -> when the live connection last showed activity in it
  let helperWait = null;   // what the last wait for the bot saw, for Diagnostics
  const chatErrors = {};   // chat id -> { error, code, at }: the site's "ce" (chat error) events
  let lastChatError = null;

  const helperStream = {};  // chat id -> { requestId, text, at }: a reply as it is being written

  // If the bot fails (reports an error, never answers, or rambles on), try
  // again in a fresh helper chat, up to 3 tries in all.
  async function callMiniApps(prompt, slot = 0) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await callMiniAppsOnce(prompt, slot);
      } catch (e) {
        if (!e.botError || attempt >= 3) throw e;
        toast(e.message + ' Trying again in a fresh helper chat…', true);
        helperChats[slot] = null;
        await Store.set(helperKey(slot), null);
        for (let i = 0; i < 15; i++) { await sleep(1000); checkStop(); }
      }
    }
  }

  // Where a reply starts repeating the same passage over and over (at
  // least 2,000 characters of repeats at the end), or -1.
  function loopStart(t) {
    const L = 200;
    if (t.length < 2500) return -1;
    const idx = t.lastIndexOf(t.slice(-L), t.length - L - 1);
    if (idx < 0) return -1;
    const p = t.length - L - idx; // length of the repeated passage
    const n = Math.max(2000, 3 * p);
    if (p > 3000 || t.length < n + p || t.slice(-n) !== t.slice(-n - p, -p)) return -1;
    let at = t.length - n - p;
    while (at > 0 && t[at - 1] === t[at - 1 + p]) at--;
    return at;
  }

  async function callMiniAppsOnce(prompt, slot) {
    const helperChat = helperChats[slot];
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
    // Messages already in the helper chat are not the answer. (The request
    // itself may not be readable: MiniApps can store long messages as files.)
    const before = new Set();
    if (reuse) {
      try { (await fetchMessages(helperChat.id, { cache: false, mode: 'latest' })).forEach((m) => before.add(m.id)); } catch (e) { /* see below */ }
      if (seenMsgs[helperChat.id]) for (const k of seenMsgs[helperChat.id].keys()) before.add(k);
    }
    let res;
    try {
      res = await rpc('POST', '/chat', body);
    } catch (e) {
      if (!reuse) throw e;
      // The helper chat is gone (e.g. deleted); start a new one.
      delete body.conversationId;
      reuse = false;
      before.clear();
      res = await rpc('POST', '/chat', body);
    }
    const cid = res && res.conversationId;
    if (!cid) throw new Error('MiniApps did not start a conversation');
    helperIds.add(cid);
    helperChats[slot] = reuse && cid === helperChat.id ? Object.assign({}, helperChat, { uses: helperChat.uses + 1 }) : { slug, id: cid, uses: 1 };
    await Store.set(helperKey(slot), helperChats[slot]);
    // The send reply lists the messages it added (our request, maybe a
    // greeting); the answer comes after our request's position.
    let requestIndex = -1;
    for (const m of (res && Array.isArray(res.addedMessages) ? res.addedMessages : [])) {
      if (!m || typeof m !== 'object') continue;
      if (m.id) before.add(String(m.id));
      if (typeof m.index === 'number' && roleOf(m) === 'user') requestIndex = Math.max(requestIndex, m.index);
    }
    if (res && res.chatMessageId) before.add(String(res.chatMessageId));
    // Long answers can take many minutes to write. Wait while the bot is
    // still typing (live connection activity), up to 20 minutes; give up
    // after 3 minutes without any sign of it.
    const started = Date.now();
    let prev = null;
    for (;;) {
      await sleep(2000);
      if (activeChatId && stopRequested[activeChatId]) {
        // Ask MiniApps to stop writing the answer (endpoint from MiniappsAI-API).
        rpc('POST', '/chat/abort', { conversationId: cid, requestId: body.requestId }).catch(() => {});
        throw stopError();
      }
      // A reply that loops or never ends: stop it and use what is usable.
      const st = helperStream[cid];
      const streamed = st && st.at >= started ? st.text : '';
      const loopAt = loopStart(streamed);
      if (activeChatId && progress[activeChatId]) {
        const w = progress[activeChatId].writing = progress[activeChatId].writing || [];
        w[slot] = streamed.length;
        renderPanel();
      }
      const tooLong = Date.now() - started > 30 * 60000;
      if (loopAt >= 0 || tooLong) {
        rpc('POST', '/chat/abort', { conversationId: cid, requestId: body.requestId }).catch(() => {});
        let part = loopAt >= 0 ? streamed.slice(0, loopAt) : streamed;
        // The last section was cut off mid-way: leave it out rather than save half of it.
        const heads = [...part.matchAll(/^[^\S\n]*[*#_]*[^\S\n]*(?:=+[^\S\n]*(?:STORY|LOG|ENTRY|SECTION|CAST|CHAPTER)|\[?R\d+\b)/gim)];
        if (heads.length > 1) part = part.slice(0, heads[heads.length - 1].index);
        if (/===\s*(STORY|LOG|ENTRY|SECTION|CAST|CHAPTER)|^\W*\[?R\d+\b/im.test(part)) return part;
        const err = new Error(loopAt >= 0 ? 'The MiniApps bot got stuck repeating itself.' : 'The MiniApps bot was still writing after 30 minutes.');
        err.botError = true;
        throw err;
      }
      const ce = chatErrors[cid];
      if (ce && ce.at >= started) {
        const err = new Error('The MiniApps bot reported an error' + (ce.error ? ': ' + ce.error : '') + (ce.code ? ' (' + ce.code + ')' : '') + '.');
        // A fresh chat doesn't help when the request itself is too long.
        err.botError = !TOO_LONG_RE.test(ce.error || '');
        throw err;
      }
      let msgs = [];
      let readOk = true;
      try { msgs = await fetchMessages(cid, { cache: false, mode: 'latest' }); } catch (e) { readOk = false; }
      // Whole messages pushed over the live connection count too.
      if (seenMsgs[cid]) msgs = mergeMsgs(msgs, [...seenMsgs[cid].values()]);
      let at = -1;
      msgs.forEach((m, j) => { if (m.role === 'user' && m.text.includes(tag)) at = j; });
      let answers;
      if (at >= 0) {
        const after = msgs.slice(at + 1);
        const next = after.findIndex((m) => m.role === 'user');
        answers = (next < 0 ? after : after.slice(0, next)).filter((m) => m.role === 'assistant');
      } else {
        answers = msgs.filter((m) => m.role === 'assistant' && !before.has(m.id) &&
          (requestIndex < 0 || typeof m.index !== 'number' || m.index > requestIndex));
      }
      // Keep only the newest answer if several new ones turned up.
      const newest = answers.length ? answers[answers.length - 1] : null;
      const reply = newest ? newest.text : '';
      // MiniApps pushes a reply over the live connection only once it is finished.
      const pushed = !!(newest && seenMsgs[cid] && seenMsgs[cid].has(newest.id));
      helperWait = {
        started,
        roles: msgs.map((m) => (m.role === 'user' ? 'u' : 'a')).join(''),
        requestFound: at >= 0,
        newAnswers: answers.length,
        readOk,
        answerChars: (reply || '').length,
        lastActivity: lastActivity[cid] || 0,
      };
      // Done when the answer stopped changing and the bot stopped typing.
      const quiet = Date.now() - (lastActivity[cid] || 0) > 6000;
      if (reply && (pushed || (reply === prev && quiet))) { helperWait.done = true; return reply; }
      prev = reply || null;
      const idle = Date.now() - Math.max(started, lastActivity[cid] || 0);
      if (!reply && idle > 3 * 60000) break;
    }
    if (prev) return prev;
    const err = new Error('The MiniApps bot did not answer (no activity for 3 minutes).');
    err.botError = true;
    throw err;
  }

  // The memory keeper has three jobs, each with its own instructions:
  //   SUMMARISE: one detailed summary (plus lasting facts) per AI reply
  //   UPDATE:    fold new summaries into the story sections and the entries
  //   CHAPTER:   roll a run of summaries into a short chapter summary
  const RECAP_RULES = [
    'Recaps:',
    '- Some messages are RECAPS: summaries of earlier events, often written to continue the story in a new chat. They are marked [RECAP], but also recognise unmarked ones (e.g. "Previously…", "So far…", "Last time…", or a long summary of past events at the start of a chat).',
    '- A recap describes the PAST, not something happening now. A recap often repeats what is already known, and recaps can contain older recaps: record each event once and use the recap to fill gaps and correct details.',
    '- If a recap written by the USER disagrees with what is known, trust the recap. If one written by the STORY AI disagrees, keep what is known unless the recap is clearly more detailed and accurate. Anything that happens after a recap overrides it.',
  ];

  function summarySystem() {
    return [
      'You are the continuity editor for a long-running interactive story / roleplay chat.',
      'Your job now: write a detailed summary of EACH story reply in the messages, so the storyteller AI can remember exactly what happened.',
      '',
      'Rules:',
      '- Story replies are numbered [R1], [R2], … Write exactly one summary for EACH of them, starting a new line with its label.',
      '- Each summary is past-tense prose describing what happened in that reply and what the user did just before it, step by step in order: actions, important dialogue (short quotes are fine), decisions, revelations, emotions and reactions, changes in relationships, injuries, clothing and items, where and when it happened. Use names, be concrete; no vague phrases like "they talked" or "things got intense".',
      '- Each [R…] label says how long its summary should be (longer replies get longer summaries). Reach that length with real details from the reply, never padding. Cover the whole reply, including its end.',
      '- After each summary, on its own line, write FACTS: followed by the lasting facts this reply revealed or changed, separated by " | ": names and nicknames, relationships and feelings, confessions, promises, secrets (and who knows them), injuries and condition, possessions, appearance changes, places, rules of the world, dates and times. Write FACTS: none if there are none.',
      '- A reply that is a recap gets a summary starting with "Recap of earlier events:".',
      '- Never invent anything. Use the names in KNOWN NAMES for people and places that already have them.',
      '',
    ].concat(RECAP_RULES, [
      '',
      'No commentary, no warnings, no questions. Answer in exactly this format and nothing else:',
      '[R1] (summary)',
      'FACTS: (facts)',
      '[R2] (summary)',
      'FACTS: (facts)',
    ]).join('\n');
  }

  function updateSystem() {
    return [
      'You are the continuity editor for a long-running interactive story / roleplay chat.',
      'You keep a knowledge base up to date so the storyteller AI never forgets anything. Your job now: fold NEW EVENTS (summaries of the latest story replies, with their lasting FACTS) into it.',
      'The knowledge base has STORY sections (the situation now) and ENTRIES (one per character, and per important place, item, group or piece of lore). The history of events is kept separately, in chapters; do not write it here.',
      '',
      'STORY rules:',
      '- Sections: ## Current Scene (where and when it is, who is present, what is happening right now), ## Open Threads (unresolved plans, promises, mysteries, things that must be followed up), ## World & Timeline (world rules, the date and time, how much time has passed, important background).',
      '- Output only the sections that change, each as === SECTION: Name === followed by its complete new text, keeping every fact that is still true. Leave out sections that did not change. If a section is empty, write it in full.',
      '- Details about a character, place or item belong in its entry, not here.',
      '',
      'ENTRY rules:',
      '- EVERY named character gets an entry, including the user\'s character and side characters, even if they only appear briefly. List them all in CAST.',
      '- Places, groups and lore get an entry when the story keeps coming back to them. Items get an entry only when they are important to the plot over several scenes (e.g. a weapon, a gift, an heirloom, a key); never for props, clothing or objects used within a scene.',
      '- A character entry covers: who they are; appearance, clothing and distinguishing features; personality, mannerisms and how they talk; abilities; likes, dislikes and boundaries; backstory; their relationship with each other character and the moments that shaped it; feelings; current condition, injuries and whereabouts; what they carry or own; goals, promises and secrets (and who knows them); nicknames and running jokes. Be detailed and specific, with bullet points.',
      '- Length: main characters ' + detail().mainChar + ' characters each, growing as the story reveals more; side characters and places as long as their facts need. Record specifics, not general impressions.',
      '- Every FACT in the new events must end up in the right entry or story section.',
      '- Header format: === ENTRY: Name | kind | aliases: other names, nicknames, titles === where kind is character, place, item, group or lore. Aliases are every other way the story refers to it.',
      '- Output ONLY entries that are new or changed by the new events. Do not output unchanged entries, or entries listed by name only. Use the exact existing name for an existing entry.',
      '- For an EXISTING entry, do NOT rewrite it: write === ENTRY: Name | add === followed by ONLY the new bullet points (new facts, new developments). Never repeat what the entry already says. New nicknames go in the header: === ENTRY: Name | add | aliases: new nickname ===.',
      '- Only when something the entry says is no longer true (e.g. a relationship, condition or whereabouts changed), write the entry complete instead, with the normal header and every fact that is still true.',
      '- A NEW entry is written complete with the normal header.',
      '- Never remove a fact unless the story changed it; then update it. When something changes, update every entry it affects (e.g. both sides of a relationship).',
      '- Never invent anything. Only record what actually happened or was stated.',
      '',
    ].concat(RECAP_RULES, [
      '',
      'If the STORY still holds character, place or item details (from an older format), move them into entries.',
      'No commentary, no warnings, no questions. Answer in exactly this format and nothing else:',
      '=== SECTION: Current Scene ===',
      '(complete section; repeat for each changed section)',
      '=== CAST ===',
      '(every named character in the STORY, ENTRIES and NEW EVENTS, comma-separated)',
      '=== ENTRY: Name | add ===',
      '(only the new bullet points for an existing entry)',
      '=== ENTRY: Name | kind | aliases: … ===',
      '(a new entry, or one whose old facts changed, complete; repeat for each)',
    ]).join('\n');
  }

  function chapterSystem() {
    return [
      'You are the continuity editor for a long-running interactive story / roleplay chat.',
      'Your job now: turn the EVENTS (summaries of consecutive story replies) into one chapter of the story\'s history.',
      '- Give the chapter a short title (3 to 8 words) naming what it is about.',
      '- Then write 600 to 1,500 characters of past-tense prose covering, in order, every important event and turning point, who was involved, what changed between the characters, and how the chapter ends. Use names. Skip small talk; keep anything that will matter later.',
      '- Never invent anything.',
      'No commentary. Answer in exactly this format and nothing else:',
      '=== CHAPTER: Title ===',
      '(chapter summary)',
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

  // How long a reply's log entry should be: a share of the reply's length,
  // within limits that depend on the detail setting.
  function entryTarget(m) {
    const d = detail();
    return Math.max(d.logMin, Math.min(d.logMax, Math.round(m.text.length * d.logShare / 50) * 50));
  }

  // Story replies are numbered [R1], [R2], … so the log entries can be matched.
  function formatMessages(msgs, botName) {
    let n = 0;
    return msgs.map((m) => {
      const who = m.role === 'user' ? 'USER' : (botName ? 'STORY AI (' + botName + ')' : 'STORY AI');
      let t = m.text;
      if (t.length > textLimit(m)) t = t.slice(0, textLimit(m)) + ' […]';
      const num = m.role === 'assistant' ? '[R' + (++n) + ', summary about ' + entryTarget(m) + ' characters] ' : '';
      return num + (isRecap(m.text) ? '[RECAP] ' : '') + who + ': ' + t;
    }).join('\n\n');
  }

  // Longer summaries mean longer answers, so fewer replies fit in one request.
  const DETAIL = {
    standard: { label: 'Standard', logMin: 300, logShare: 0.15, logMax: 1500, perChunk: 8, mainChar: '800–1,500' },
    detailed: { label: 'Detailed', logMin: 700, logShare: 0.3, logMax: 3000, perChunk: 5, mainChar: '1,500–3,000' },
    maximum: { label: 'Maximum', logMin: 1200, logShare: 0.5, logMax: 5000, perChunk: 3, mainChar: '3,000–5,000' },
  };
  function detail() {
    return DETAIL[settings.detail] || DETAIL.detailed;
  }

  // How much chat text goes to the memory keeper in one summary request. At
  // most detail().perChunk story replies go in one, so the answer (one
  // summary per reply) stays a manageable length.
  const CHUNK_CHARS = 40000;

  function chunk(msgs, maxChars) {
    const out = [];
    let cur = [];
    let size = 0;
    let replies = 0;
    for (const m of msgs) {
      const len = Math.min(m.text.length, textLimit(m)) + 40;
      const full = size + len > maxChars || (m.role === 'assistant' && replies >= detail().perChunk);
      if (cur.length && full) { out.push(cur); cur = []; size = 0; replies = 0; }
      cur.push(m);
      size += len;
      if (m.role === 'assistant') replies++;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  // Removes text the keeper repeated over and over (a bot stuck in a loop):
  // a passage repeated back to back, and lines or sentences that already
  // appeared earlier in the same text. Normal text is left as it is.
  function squashRepeats(t) {
    t = String(t || '');
    if (t.length < 300) return t;
    if (t.length < 300000) t = t.replace(/([^\n]{8,300}?)(?:\s*\1){2,}/g, '$1');
    const lines = new Set();
    const sentences = new Set();
    const keep = (set, x, min) => {
      const k = x.trim().toLowerCase();
      if (k.length < min) return true;
      if (set.has(k)) return false;
      set.add(k);
      return true;
    };
    return t.split('\n')
      .filter((line) => keep(lines, line, 15))
      .map((line) => (line.length < 200 ? line : line.split(/(?<=[.!?…])\s+/).filter((x) => keep(sentences, x, 25)).join(' ')))
      .join('\n').replace(/\n{3,}/g, '\n\n');
  }

  // Cleans repeated text out of a chat's saved memory. Returns true if anything changed.
  function repairChat(chat) {
    let changed = false;
    const fix = (t) => { const c = squashRepeats(t); if (c !== t) changed = true; return c; };
    chat.memory = fix(chat.memory);
    for (const e of chat.entries) e.text = fix(e.text);
    for (const e of chat.log) e.text = fix(e.text);
    return changed;
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

  // Errors that mean the request was too long for the bot.
  const TOO_LONG_RE = /context (length|window)|maximum context|too many tokens|reduce the length|prompt is too long|input is too long/i;

  // When the entries are very long (or the bot said the request is too
  // long), only the entries the new events involve are sent in full.
  function entriesForRequest(chat, text, compact) {
    const all = formatEntries(chat.entries);
    if (!compact && all.length <= 40000) return all;
    const about = sectionOf(chat.memory, 'Current Scene') + '\n' + text;
    const shown = chat.entries.filter((e) => e.always || entryKeys(e).some((k) => mentions(about, k)));
    const others = chat.entries.filter((e) => !shown.includes(e)).map((e) => e.name);
    return formatEntries(shown) + (others.length
      ? '\n\nOTHER ENTRIES (not involved in the new events; listed by name only; do not output them): ' + others.join(', ')
      : '');
  }

  // Each story reply with the user message just before it, for asking about
  // only some replies.
  function withPrompts(msgs, replies) {
    const parts = [];
    for (const r of replies) {
      const i = msgs.indexOf(r);
      const prevUser = msgs.slice(0, i).reverse().find((m) => m.role === 'user');
      if (prevUser && !parts.includes(prevUser)) parts.push(prevUser);
      parts.push(r);
    }
    return parts;
  }

  // Job 1: a detailed summary and the lasting facts of each AI reply.
  // Summaries the keeper skipped (or that were cut off) are asked for again.
  async function summarise(chat, msgs, slot = 0) {
    const replies = msgs.filter((m) => m.role === 'assistant');
    // Only user messages (e.g. the newest one, still waiting for its reply): nothing to summarise.
    if (!replies.length) return [];
    const names = chat.entries.map((e) => e.name + (e.aliases && e.aliases.length ? ' (' + e.aliases.join(', ') + ')' : ''));
    const scene = sectionOf(chat.memory, 'Current Scene').trim();
    const ask = async (list) => {
      const user = (names.length ? 'KNOWN NAMES: ' + names.join('; ') + '\n\n' : '') +
        (scene ? 'WHERE THE STORY STOOD BEFORE THESE MESSAGES:\n<<<\n' + scene + '\n>>>\n\n' : '') +
        'MESSAGES (oldest first):\n<<<\n' + formatMessages(list, chat.title) + '\n>>>\n\n' +
        'JOB: SUMMARISE. Write one summary and one FACTS line for each [R…] reply now.';
      const out = cleanOutput(await callLLM(summarySystem(), user, slot));
      checkStop();
      const log = /^\W*=+\s*LOG\s*=+/im.test(out) ? out : '=== LOG ===\n' + out;
      return { out, entries: parseKeeperAnswer(log, list.filter((m) => m.role === 'assistant')).entries };
    };
    const first = await ask(msgs);
    let got = first.entries;
    if (!got.length && replies.length) throw new Error('Memory keeper gave an unusable answer: "' + first.out.slice(0, 120) + '"');
    for (let round = 0; round < 3; round++) {
      const have = new Set(got.map((e) => e.id));
      const missing = replies.filter((r) => !have.has(r.id));
      if (!missing.length) break;
      const count = got.length;
      for (let i = 0; i < missing.length; i += 3) {
        checkStop();
        got = got.concat((await ask(withPrompts(msgs, missing.slice(i, i + 3)))).entries);
      }
      // A keeper that won't write them at all is not asked forever.
      if (got.length === count) break;
    }
    const order = new Map(replies.map((r, i) => [r.id, i]));
    return dedupeEntries(got).sort((a, b) => order.get(a.id) - order.get(b.id));
  }

  // Summaries as the keeper sees them in UPDATE and CHAPTER jobs.
  function formatEvents(items) {
    return items.map((e, i) => '[S' + (i + 1) + '] ' + e.text + (e.facts ? '\nFACTS: ' + e.facts : '')).join('\n\n');
  }

  // Job 2: fold new summaries into the story sections and the entries.
  async function fold(chat, items, compact) {
    try {
      return await foldOnce(chat, items, compact);
    } catch (e) {
      if (compact || !TOO_LONG_RE.test(String(e.message || e))) throw e;
      toast('The request was too long for the bot; sending only the entries these events involve.', true);
      return foldOnce(chat, items, true);
    }
  }

  async function foldOnce(chat, items, compact) {
    const events = formatEvents(items);
    const user = 'STORY (' + chat.memory.trim().length + ' characters):\n<<<\n' + (chat.memory.trim() || '(empty — this is the start)') + '\n>>>\n\n' +
      (chat.chapters.length ? 'CHAPTERS SO FAR (history, kept separately): ' + chat.chapters.map((c, i) => (i + 1) + '. ' + c.title).join('; ') + '\n\n' : '') +
      'CURRENT ENTRIES:\n<<<\n' + entriesForRequest(chat, events, compact) + '\n>>>\n\n' +
      (chat.pinned.trim() ? 'FACTS THE USER PINNED (always true, do not repeat them):\n<<<\n' + chat.pinned.trim() + '\n>>>\n\n' : '') +
      (chat.ignored.length ? 'NEVER write entries for (the user removed them): ' + chat.ignored.join(', ') + '\n\n' : '') +
      'NEW EVENTS (oldest first):\n<<<\n' + events + '\n>>>\n\n' +
      'JOB: UPDATE. Write the changed STORY sections, the CAST, and every new or changed ENTRY now.';
    const before = knowledgeSize(chat.memory.trim(), chat.entries);
    let result = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const extra = attempt === 1 ? '' : '\n\nIMPORTANT: your previous answer left out much of what is already known. Keep EVERY fact; only add and update.';
      const out = cleanOutput(await callLLM(updateSystem(), user + extra));
      checkStop();
      const parsed = parseKeeperAnswer(out, []);
      // The history lives in chapters, not in the story sections.
      const sections = parsed.sections.filter((x) => !/^story so far$/i.test(x.title));
      if (!parsed.memory.trim() && !sections.length && !parsed.updates.length && !parsed.cast.length) {
        throw new Error('Memory keeper gave an unusable answer: "' + out.slice(0, 120) + '"');
      }
      let memory = sections.length ? applySections(chat.memory, sections) : chat.memory;
      // An older-style complete STORY replaces it all, without its history part.
      if (parsed.memory.trim() && !sections.length) memory = removeSection(parsed.memory, 'Story So Far');
      result = { memory, updates: parsed.updates, cast: parsed.cast };
      // Much less knowledge than before means facts were dropped (or the answer was cut off).
      const after = knowledgeSize(memory.trim(), applyUpdates(cloneEntries(chat.entries), parsed.updates, chat.ignored).entries);
      if (!(before > 1500 && after < before * 0.6)) break;
      if (attempt === 2) {
        result = { memory: chat.memory, updates: [], cast: [] };
        toast('The memory keeper tried to drop facts, so the story and entries were kept as they were.', true);
      }
    }
    // Characters in the cast without an entry are asked for explicitly.
    for (let round = 0; round < 2; round++) {
      const known = applyUpdates(cloneEntries(chat.entries), result.updates, chat.ignored).entries;
      const skip = new Set(chat.ignored.map((n) => n.toLowerCase()));
      const missing = [...new Set(result.cast)].filter((n) => !findEntry(known, n) && !skip.has(n.toLowerCase()));
      if (!missing.length) break;
      const count = result.updates.length;
      for (let i = 0; i < missing.length; i += 4) {
        checkStop();
        result.updates = result.updates.concat(await entriesFor(chat, events, result.memory, missing.slice(i, i + 4)));
      }
      if (result.updates.length === count) break;
    }
    return result;
  }

  // Ask only for entries about some characters the keeper left out.
  async function entriesFor(chat, events, story, names) {
    const user = 'STORY:\n<<<\n' + (story.trim() || chat.memory.trim() || '(empty)') + '\n>>>\n\n' +
      'EXISTING ENTRIES (for context):\n<<<\n' + entriesForRequest(chat, events, false) + '\n>>>\n\n' +
      'NEW EVENTS:\n<<<\n' + events + '\n>>>\n\n' +
      'ENTRIES ONLY: write a complete character entry for each of these characters, who have none yet: ' + names.join(', ') +
      '. Use everything the story, entries and events say about them. Use the "=== ENTRY: Name | character | aliases: … ===" format. Nothing else.';
    const out = cleanOutput(await callLLM(updateSystem(), user));
    return parseKeeperAnswer(out, []).updates;
  }

  // Checks lasting facts from the summaries against the entries and story,
  // and adds the ones that are missing. Returns the keeper's changes.
  async function checkFacts(chat, items) {
    const facts = items.map((e, i) => '[F' + (i + 1) + '] ' + e.facts).join('\n');
    const user = 'STORY:\n<<<\n' + (chat.memory.trim() || '(empty)') + '\n>>>\n\n' +
      'CURRENT ENTRIES:\n<<<\n' + entriesForRequest(chat, facts, false) + '\n>>>\n\n' +
      (chat.pinned.trim() ? 'FACTS THE USER PINNED (always true, do not repeat them):\n<<<\n' + chat.pinned.trim() + '\n>>>\n\n' : '') +
      (chat.ignored.length ? 'NEVER write entries for (the user removed them): ' + chat.ignored.join(', ') + '\n\n' : '') +
      'FACTS FROM THE STORY (oldest first; later facts override earlier ones):\n<<<\n' + facts + '\n>>>\n\n' +
      'JOB: CHECK. Every fact above is true in the story (unless a later one changed it). Find the facts that are NOT yet recorded in the CURRENT ENTRIES or the STORY, ' +
      'and add each to the entry (or story section) it belongs to, using === ENTRY: Name | add === with only the missing facts. Output only the entries and sections you changed. ' +
      'If nothing is missing, output only the CAST.';
    const out = cleanOutput(await callLLM(updateSystem(), user));
    checkStop();
    const parsed = parseKeeperAnswer(out, []);
    const sections = parsed.sections.filter((x) => !/^story so far$/i.test(x.title));
    if (!sections.length && !parsed.updates.length && !parsed.cast.length && !/CAST/i.test(out)) {
      throw new Error('Memory keeper gave an unusable answer: "' + out.slice(0, 120) + '"');
    }
    return { sections, updates: parsed.updates };
  }

  // Job 3: a run of summaries becomes a chapter of the story's history.
  async function makeChapter(chat, items) {
    const prev = chat.chapters[chat.chapters.length - 1];
    const n = chat.chapters.length + 1;
    const user = (prev ? 'PREVIOUS CHAPTER (' + prev.title + '):\n<<<\n' + prev.text + '\n>>>\n\n' : '') +
      'EVENTS (oldest first):\n<<<\n' + formatEvents(items) + '\n>>>\n\n' +
      'JOB: CHAPTER. Write chapter ' + n + ' now.';
    const out = cleanOutput(await callLLM(chapterSystem(), user));
    checkStop();
    const m = out.match(/^[^\S\n]*[*#_]*[^\S\n]*=+[^\S\n]*CHAPTER\b[^\S\n]*:?([^\n=]*?)[^\S\n]*=+[^\n]*$/im);
    const title = (m ? m[1] : '').replace(/^\s*\d+\s*[:.–—-]\s*/, '').replace(/[*_#]/g, '').trim();
    const text = squashRepeats((m ? out.slice(m.index + m[0].length) : out).trim());
    if (text.length < 80) throw new Error('Memory keeper gave an unusable chapter: "' + out.slice(0, 120) + '"');
    return { title: title || 'Chapter ' + n, text, ids: items.map((e) => e.id) };
  }

  function cloneEntries(entries) {
    return entries.map((e) => Object.assign({}, e, { aliases: (e.aliases || []).slice() }));
  }

  function findEntry(entries, name) {
    const n = String(name).trim().toLowerCase();
    return entries.find((e) => e.name.toLowerCase() === n || (e.aliases || []).some((a) => a.toLowerCase() === n));
  }

  // Apply the keeper's new or changed entries. An "add" update appends its new
  // lines (ones the entry already has are skipped). A rewrite that is much
  // shorter than a long existing entry probably lost details, so it is not applied.
  function applyUpdates(entries, updates, ignored) {
    const refused = [];
    const skip = new Set((ignored || []).map((n) => n.toLowerCase()));
    for (const u of updates) {
      // Entries the user deleted stay deleted.
      if ([u.name].concat(u.aliases).some((n) => skip.has(n.toLowerCase()))) continue;
      const e = findEntry(entries, u.name) || u.aliases.map((a) => findEntry(entries, a)).find(Boolean);
      if (!e) {
        entries.push({ name: u.name, kind: (u.add ? '' : u.kind) || 'character', aliases: u.aliases, text: u.text, always: false, updated: Date.now() });
        continue;
      }
      if (u.add) {
        const have = new Set(e.text.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean));
        const lines = u.text.split('\n').filter((l) => l.trim() && !have.has(l.trim().toLowerCase()));
        if (lines.length) {
          e.text = (e.text.trim() ? e.text.replace(/\s+$/, '') + '\n' : '') + lines.join('\n');
          e.updated = Date.now();
        }
      } else if (e.text.length > 800 && u.text.length < e.text.length * 0.5) {
        refused.push(e.name);
      } else {
        e.text = u.text;
        e.updated = Date.now();
      }
      if (u.kind && !u.add) e.kind = u.kind;
      const names = new Set([e.name.toLowerCase()].concat(e.aliases.map((a) => a.toLowerCase())));
      for (const a of u.aliases.concat(u.name)) {
        if (!names.has(a.toLowerCase())) { e.aliases.push(a); names.add(a.toLowerCase()); }
      }
    }
    return { entries, refused };
  }

  // Keeps a chat's memory tidy and consistent; returns what it fixed.
  //  - entries for the same thing (one's name is the other's alias) are merged
  //  - aliases that repeat the entry's own name or another entry's name go
  //  - entries the user deleted that came back are removed
  //  - entries are sorted: characters, places, items, groups, lore
  //  - a reply has one summary (the longer one), with a valid chapter link
  const KIND_ORDER = ['character', 'place', 'item', 'group', 'lore'];
  function organize(chat) {
    const fixes = [];
    // Entries
    const skip = new Set((chat.ignored || []).map((n) => n.toLowerCase()));
    const kept = [];
    for (const e of chat.entries) {
      e.aliases = e.aliases || [];
      if (!e.always && entryKeys(e).some((k) => skip.has(k.toLowerCase()))) { fixes.push('removed deleted entry ' + e.name); continue; }
      // Only a name counts: two characters may share a nickname like "babe".
      const keys = entryKeys(e).map((k) => k.toLowerCase());
      const twin = kept.find((x) => (x.kind || 'character') === (e.kind || 'character') &&
        (keys.includes(x.name.toLowerCase()) || entryKeys(x).some((k) => k.toLowerCase() === e.name.toLowerCase())));
      if (!twin) { kept.push(e); continue; }
      // Merge: keep the longer text, add lines only the other one has.
      const [main, other] = twin.text.length >= e.text.length ? [twin.text, e.text] : [e.text, twin.text];
      const have = new Set(main.split('\n').map((l) => l.trim()).filter(Boolean));
      const extra = other.split('\n').filter((l) => l.trim() && !have.has(l.trim()));
      twin.text = main + (extra.length ? '\n' + extra.join('\n') : '');
      twin.aliases = twin.aliases.concat(entryKeys(e));
      twin.always = twin.always || e.always;
      twin.updated = Math.max(twin.updated || 0, e.updated || 0);
      fixes.push('merged ' + e.name + ' into ' + twin.name);
    }
    const names = new Set(kept.map((e) => e.name.toLowerCase()));
    for (const e of kept) {
      const seen = new Set([e.name.toLowerCase()]);
      const before = e.aliases.length;
      e.aliases = e.aliases.map((a) => String(a).trim()).filter((a) => {
        const k = a.toLowerCase();
        if (!a || seen.has(k) || names.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (e.aliases.length < before && fixes.length < 50) fixes.push('cleaned aliases of ' + e.name);
    }
    const rank = (e) => { const r = KIND_ORDER.indexOf(e.kind || 'character'); return r < 0 ? KIND_ORDER.length : r; };
    const sorted = kept.map((e, i) => [e, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
    if (sorted.length !== chat.entries.length || sorted.some((e, i) => e !== chat.entries[i])) chat.entries = sorted;
    // Summaries
    const best = new Map();
    for (const e of chat.log) if (!best.has(e.id) || e.text.length > best.get(e.id).text.length) best.set(e.id, e);
    if (best.size < chat.log.length) {
      fixes.push('removed ' + (chat.log.length - best.size) + ' duplicate summaries');
      chat.log = chat.log.filter((e) => best.get(e.id) === e);
    }
    for (const e of chat.log) {
      if (typeof e.folded !== 'boolean') e.folded = !!e.folded;
      if (e.chapter != null && !(e.chapter >= 0 && e.chapter < chat.chapters.length)) { delete e.chapter; fixes.push('fixed a chapter link'); }
    }
    return fixes;
  }

  function removeSection(memory, title) {
    return String(memory || '').replace(new RegExp('^##[^\\S\\n]*' + title + '[^\\n]*\\n[\\s\\S]*?(?=^##\\s|$(?![\\s\\S]))', 'im'), '').trim();
  }

  // Split the keeper's answer into the story, new or changed entries, and
  // log entries matched to the replies they describe:
  //   === STORY === … === ENTRY: Name | kind | aliases: … === … === LOG === [R1] …
  function parseKeeperAnswer(out, replies) {
    // Headers may come wrapped in markdown (**=== LOG ===**, ### === LOG ===).
    const HEADER = /^[^\S\n]*[*#_]*[^\S\n]*=+[^\S\n]*(STORY|(?:STORY[^\S\n]+)?MEMORY|LOG|CAST|ENTRY[^\S\n]*:[^\n=]*?|SECTION[^\S\n]*:[^\n=]*?)[^\S\n]*=+[^\S\n]*[*_]*[^\S\n]*$/gim;
    const marks = [];
    let m;
    while ((m = HEADER.exec(out))) marks.push({ at: m.index, end: m.index + m[0].length, head: m[1].trim() });
    let memory = '';
    const updates = [];
    const entries = [];
    let cast = [];
    const sections = [];
    // Text before any header counts as the story (older answers had no headers).
    if (!marks.length || marks[0].at > 0) memory = out.slice(0, marks.length ? marks[0].at : out.length);
    marks.forEach((mk, i) => {
      const body = out.slice(mk.end, i + 1 < marks.length ? marks[i + 1].at : out.length).trim();
      if (/^(STORY|(STORY\s+)?MEMORY)$/i.test(mk.head)) {
        memory = body;
      } else if (/^SECTION\s*:/i.test(mk.head)) {
        const fields = mk.head.replace(/^SECTION\s*:\s*/i, '').split('|').map((x) => x.trim());
        const title = fields[0].replace(/^#+\s*/, '');
        // The keeper may repeat the "## Title" line inside the section.
        const text = body.replace(new RegExp('^#+\\s*' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\n', 'i'), '').trim();
        if (title && text) sections.push({ title, add: fields.slice(1).some((f) => /^add/i.test(f)), text });
      } else if (/^CAST$/i.test(mk.head)) {
        cast = body.split(/[,\n;]/).map((n) => n.replace(/^[\s*•-]+|[\s.]+$/g, '').replace(/\s*\(.*\)$/, '').trim())
          .filter((n) => n && n.length < 60 && !/^(you|user|the user|narrator|\{\{user\}\}|none)$/i.test(n));
      } else if (/^LOG$/i.test(mk.head)) {
        // Each entry starts a line with its label: [R1], R1, **R1**, R1:, - [R1, …] …
        const LABEL = /^[^\S\n]*(?:[-*•][^\S\n]+)?[*_]{0,2}(?:\[R(\d+)[^\]\n]*\]|R(\d+)(?![\w]))[*_]{0,2}[^\S\n]*[:.)\-–—]?[*_]{0,2}[^\S\n]*/gim;
        const labels = [];
        let r;
        while ((r = LABEL.exec(body))) labels.push({ n: Number(r[1] || r[2]), at: r.index, end: r.index + r[0].length });
        labels.forEach((l, k) => {
          const reply = replies[l.n - 1];
          const raw = body.slice(l.end, k + 1 < labels.length ? labels[k + 1].at : body.length);
          // "FACTS: …" after the summary: the reply's lasting facts.
          const f = raw.match(/^[^\S\n]*[*_]*\s*(?:lasting\s+)?facts?(?:\s+to\s+remember)?[*_]*\s*:[*_]*/im);
          const text = (f ? raw.slice(0, f.index) : raw).replace(/\s+/g, ' ').trim();
          let facts = f ? raw.slice(f.index + f[0].length).replace(/\s*\n\s*[-*•]?\s*/g, ' | ').replace(/\s+/g, ' ').replace(/^[\s|]+|[\s|]+$/g, '').trim() : '';
          if (/^(none|n\/?a|nothing( new)?|-+|—)\.?$/i.test(facts)) facts = '';
          if (reply && text) entries.push(facts ? { id: reply.id, text, facts } : { id: reply.id, text });
        });
      } else {
        const fields = mk.head.replace(/^ENTRY\s*:\s*/i, '').split('|').map((x) => x.trim());
        const name = fields[0];
        let kind = '';
        let aliases = [];
        let add = false;
        for (const f of fields.slice(1)) {
          if (/^(add|additions?|new facts?)$/i.test(f)) add = true;
          else if (/^aliases?\s*:/i.test(f)) {
            aliases = f.replace(/^aliases?\s*:/i, '').split(',').map((a) => a.trim())
              .filter((a) => a && a.toLowerCase() !== name.toLowerCase() && !/^(none|n\/?a|null|nil|-+|—|no aliases?|unknown)$/i.test(a));
          }
          else if (f) kind = f.toLowerCase();
        }
        if (name && body) updates.push(add ? { name, kind, aliases, text: body, add } : { name, kind, aliases, text: body });
      }
    });
    sections.forEach((x) => { x.text = squashRepeats(x.text); });
    updates.forEach((u) => { u.text = squashRepeats(u.text); });
    entries.forEach((e) => { e.text = squashRepeats(e.text); if (e.facts) e.facts = squashRepeats(e.facts); });
    return { memory: squashRepeats(cleanOutput(memory)), sections, updates, entries: dedupeEntries(entries), cast };
  }

  // The story is "## Title" sections. Applies the keeper's changed sections:
  // an "add" section gets new lines at its end, any other replaces it.
  const SECTION_ORDER = ['story so far', 'current scene', 'open threads', 'world & timeline'];
  function applySections(memory, edits) {
    const text = String(memory || '').trim();
    const parts = [];
    const re = /^##[^\S\n]*(.+?)[^\S\n]*$/gm;
    const heads = [];
    let m;
    while ((m = re.exec(text))) heads.push({ at: m.index, end: m.index + m[0].length, title: m[1] });
    const intro = text.slice(0, heads.length ? heads[0].at : text.length).trim();
    heads.forEach((h, i) => parts.push({ title: h.title, text: text.slice(h.end, i + 1 < heads.length ? heads[i + 1].at : text.length).trim() }));
    for (const e of edits) {
      const key = e.title.toLowerCase();
      let sec = parts.find((p) => p.title.toLowerCase() === key);
      if (!sec) {
        sec = { title: e.title, text: '' };
        const rank = (t) => { const r = SECTION_ORDER.indexOf(t.toLowerCase()); return r < 0 ? SECTION_ORDER.length : r; };
        const at = parts.findIndex((p) => rank(p.title) > rank(e.title));
        parts.splice(at < 0 ? parts.length : at, 0, sec);
      }
      if (e.add && sec.text) {
        // Lines the keeper repeated instead of only adding new ones are dropped.
        const have = new Set(sec.text.split('\n').map((l) => l.trim()).filter(Boolean));
        const added = e.text.split('\n').filter((l) => !l.trim() || !have.has(l.trim())).join('\n').trim();
        if (added) sec.text += '\n' + added;
      } else {
        sec.text = e.text;
      }
    }
    return [intro].concat(parts.map((p) => '## ' + p.title + '\n' + p.text)).filter(Boolean).join('\n\n');
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

  // For "Undo last change": the story, all entries and chapters as they were.
  function snapshot(chat) {
    return { memory: chat.memory, entries: cloneEntries(chat.entries), chapters: chat.chapters.map((c) => Object.assign({}, c)) };
  }

  function restore(chat, snap) {
    if (typeof snap === 'string') { chat.memory = snap; return; } // older versions kept only the text
    chat.memory = snap.memory;
    chat.entries = cloneEntries(snap.entries || []);
    if (snap.chapters) chat.chapters = snap.chapters.map((c) => Object.assign({}, c));
  }

  // Keeps the phone screen on while an update runs, so it isn't interrupted
  // by the screen turning off (Screen Wake Lock API; Firefox 126+).
  const wake = { lock: null, want: false, state: 'not used yet' };
  async function keepAwake(on) {
    wake.want = on;
    if (!on) {
      if (wake.lock) { try { await wake.lock.release(); } catch (e) { /* already gone */ } }
      wake.lock = null;
      return;
    }
    if (wake.lock || document.visibilityState !== 'visible') return;
    const wl = navigator.wakeLock;
    if (!wl || !wl.request) { wake.state = 'not supported by this browser'; return; }
    try {
      wake.lock = await wl.request('screen');
      wake.state = 'kept on during updates';
      wake.lock.addEventListener('release', () => { wake.lock = null; });
      if (!wake.want) keepAwake(false);
    } catch (e) {
      wake.state = 'refused (' + String(e.message || e).slice(0, 60) + ')';
    }
  }
  // The browser drops the lock when the tab is hidden; take it again on return.
  document.addEventListener('visibilitychange', () => { if (wake.want) keepAwake(true); });
  function anyBusy() {
    return Object.values(busy).some(Boolean);
  }

  // ---------------------------------------------------------------------------
  // The memory pipeline. Every AI reply goes through three stages, and each
  // log entry records how far it got:
  //   1. summarised: it has a log entry (summary + facts)
  //   2. folded:     its facts are in the story sections and entries
  //   3. chaptered:  it is part of a chapter of the story's history
  // Each request is a job; finished jobs are saved at once, so stopping or a
  // failure never loses work, and "Update now" carries on where it stopped.
  // ---------------------------------------------------------------------------

  const FOLD_MAX = 20;          // summaries folded in one request at most
  const FOLD_CHARS = 40000;     // …and at most this many characters of them

  function foldEvery() { return Math.max(1, Number(settings.foldEvery) || DEFAULT_SETTINGS.foldEvery); }
  function chapterSize() { return Math.max(4, Number(settings.chapterSize) || DEFAULT_SETTINGS.chapterSize); }
  function parallel() { return Math.min(3, Math.max(1, Number(settings.parallel) || 1)); }

  // Where each stage stands.
  function stages(chat) {
    return {
      summaries: chat.log.length,
      unfolded: chat.log.filter((e) => !e.folded).length,
      unchaptered: chat.log.filter((e) => e.folded && e.chapter == null).length,
      chapters: chat.chapters.length,
    };
  }

  // The next run of summaries to fold: in story order, within the limits.
  function nextFold(chat) {
    const out = [];
    let size = 0;
    for (const e of chat.log) {
      if (e.folded) continue;
      const len = e.text.length + (e.facts || '').length;
      if (out.length && (out.length >= FOLD_MAX || size + len > FOLD_CHARS)) break;
      out.push(e);
      size += len;
    }
    return out;
  }

  // Roughly how many requests a run will take, for the progress display and
  // the "catch up?" question.
  function estimate(chat, todo) {
    const summaries = chunk(todo, CHUNK_CHARS).length;
    const replies = todo.filter((m) => m.role === 'assistant').length;
    const unfolded = stages(chat).unfolded + replies;
    const folds = Math.ceil(unfolded / FOLD_MAX);
    const chapters = Math.floor((stages(chat).unchaptered + unfolded) / chapterSize());
    return { summaries, folds, chapters, total: summaries + folds + chapters };
  }

  // Runs organize() and records what it fixed in the Activity list.
  function tidy(chat) {
    const fixes = organize(chat);
    chat.checked = Date.now();
    if (fixes.length) logJob(chat, { kind: 'check', label: 'Tidied the memory: ' + fixes.slice(0, 8).join('; ') + (fixes.length > 8 ? '; …' : ''), ok: true, ms: 0 });
    return fixes;
  }

  // A record of each job, newest first, for the Activity list.
  function logJob(chat, job) {
    chat.jobs = [Object.assign({ at: Date.now() }, job)].concat(chat.jobs || []).slice(0, 40);
  }

  function setStep(id, text) {
    if (progress[id]) { progress[id].step = text; progress[id].writing = []; }
    renderPanel();
  }

  // Positions of log entries as numbers people can read (#1 = first reply).
  function replyRange(chat, items) {
    const at = (e) => chat.log.indexOf(e) + 1;
    const a = at(items[0]);
    const b = at(items[items.length - 1]);
    return a === b ? 'reply ' + a : 'replies ' + a + '–' + b;
  }

  // Runs the whole pipeline for a chat: summarise new replies, fold them in,
  // write chapters. all = fold everything waiting now (not only every
  // foldEvery replies). Returns 'done', 'stopped', 'failed' or 'skipped'.
  async function updateMemory(id, msgs, { force = false } = {}) {
    const chat = await getChat(id, true);
    if (busy[id] || (!chat.enabled && !force)) return 'skipped';
    const todo = unprocessed(chat, msgs);
    const st = stages(chat);
    const foldDue = st.unfolded && (force || st.unfolded >= foldEvery() || !chat.memory.trim());
    if (!todo.length && !foldDue && st.unchaptered < chapterSize()) return 'skipped';
    busy[id] = true;
    keepAwake(true);
    stopRequested[id] = false;
    activeChatId = id;
    chat.backlog = null;
    setStatus();
    const before = snapshot(chat);
    progress[id] = { done: 0, total: estimate(chat, todo).total, step: 'Starting…' };
    renderPanel();
    const job = async (kind, label, fn) => {
      const t0 = Date.now();
      setStep(id, label + '…');
      try {
        const r = await fn();
        logJob(chat, { kind, label, ok: true, ms: Date.now() - t0 });
        progress[id].done++;
        return r;
      } catch (e) {
        if (!e.stopped) logJob(chat, { kind, label, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200) });
        throw e;
      }
    };
    try {
      // 1. Summaries, a few requests at a time when allowed.
      const parts = chunk(todo, CHUNK_CHARS);
      let next = chat.log.length;
      // Read every time, so a change in Settings applies to a run already going.
      for (let i = 0, P = parallel(); i < parts.length; i += P, P = parallel()) {
        checkStop();
        const wave = parts.slice(i, i + P);
        const labels = wave.map((part) => {
          const n = part.filter((m) => m.role === 'assistant').length;
          const label = 'Summarised ' + (n ? (n === 1 ? 'reply ' + (next + 1) : 'replies ' + (next + 1) + '–' + (next + n)) : 'messages');
          next += n;
          return label;
        });
        const running = wave.map((part, k) => (part.some((m) => m.role === 'assistant')
          ? job('summarise', labels[k], () => summarise(chat, part, k)) : Promise.resolve([])));
        const first = (labels[0].match(/\d+/) || [''])[0];
        if (wave.length > 1 && first && next > Number(first)) setStep(id, 'Summarising replies ' + first + '–' + next + ' (' + wave.length + ' at once)…');
        const results = await Promise.allSettled(running);
        // Kept in order up to the first failure, so nothing is skipped.
        let failure = null;
        for (let k = 0; k < wave.length; k++) {
          if (results[k].status === 'rejected') { failure = results[k].reason; break; }
          const got = results[k].value.map((e) => Object.assign(e, { folded: false }));
          const ids = new Set(got.map((e) => e.id));
          // A regenerated or re-read reply replaces its old summary.
          chat.log = sortLog(chat.log.filter((e) => !ids.has(e.id)).concat(got), msgs);
          chat.processedIds = chat.processedIds.concat(wave[k].map((m) => m.id)).slice(-300);
          chat.processedCount = msgs.indexOf(wave[k][wave[k].length - 1]) + 1;
          chat.readCount = (chat.readCount || 0) + wave[k].length;
          chat.lastUpdate = Date.now();
          chat.lastError = '';
        }
        await saveChat(chat);
        renderPanel();
        if (failure) throw failure;
        // During a long catch-up, keep the story and entries up to date as it goes.
        await foldAndChapter(chat, FOLD_MAX, job);
      }
      // 2 + 3. Fold what is due (all of it when asked, or for a new story),
      // then write the chapters that are complete.
      await foldAndChapter(chat, force || !chat.memory.trim() ? 1 : foldEvery(), job);
      tidy(chat);
      if (JSON.stringify(before) !== JSON.stringify(snapshot(chat))) {
        chat.history = [before].concat(chat.history).slice(0, 5);
      }
      await saveChat(chat);
      return 'done';
    } catch (e) {
      if (JSON.stringify(before) !== JSON.stringify(snapshot(chat))) {
        chat.history = [before].concat(chat.history).slice(0, 5);
      }
      if (e.stopped) {
        await saveChat(chat);
        toast('Stopped. What was finished is kept; tap "Update now" to continue.');
        return 'stopped';
      }
      chat.lastError = String(e.message || e);
      await saveChat(chat);
      toast('Story memory update failed: ' + chat.lastError, true);
      return 'failed';
    } finally {
      busy[id] = false;
      if (!anyBusy()) keepAwake(false);
      stopRequested[id] = false;
      if (activeChatId === id) activeChatId = null;
      delete progress[id];
      setStatus();
      renderPanel();
    }
  }

  // Folds waiting summaries into the story and entries once at least
  // `threshold` are waiting, then writes the chapters that are complete.
  async function foldAndChapter(chat, threshold, job) {
    while (stages(chat).unfolded && stages(chat).unfolded >= threshold) {
      const items = nextFold(chat);
      checkStop();
      const r = await job('update', 'Updated story & characters from ' + replyRange(chat, items), () => fold(chat, items));
      chat.memory = r.memory;
      const applied = applyUpdates(chat.entries, r.updates, chat.ignored);
      if (applied.refused.length) toast('Kept the fuller version of: ' + applied.refused.join(', '));
      for (const e of items) e.folded = true;
      chat.lastUpdate = Date.now();
      chat.lastError = '';
      await saveChat(chat);
      renderPanel();
      await writeChapters(chat, job);
    }
    await writeChapters(chat, job);
  }

  // "Check for missing facts": every summary's facts not checked yet, in
  // batches, against the entries and story.
  const CHECK_CHARS = 8000;
  async function runFactCheck(id, all) {
    const chat = await getChat(id, true);
    if (busy[id]) return 'skipped';
    if (all) for (const e of chat.log) delete e.checked;
    const todo = chat.log.filter((e) => e.facts && !e.checked);
    if (!todo.length) return 'nothing';
    const batches = [];
    let cur = [];
    let size = 0;
    for (const e of todo) {
      if (cur.length && size + e.facts.length > CHECK_CHARS) { batches.push(cur); cur = []; size = 0; }
      cur.push(e);
      size += e.facts.length;
    }
    if (cur.length) batches.push(cur);
    busy[id] = true;
    keepAwake(true);
    stopRequested[id] = false;
    activeChatId = id;
    setStatus();
    const before = snapshot(chat);
    progress[id] = { done: 0, total: batches.length, step: 'Starting…' };
    renderPanel();
    const changed = new Set();
    try {
      for (const items of batches) {
        checkStop();
        const label = 'Checked the facts of ' + replyRange(chat, items);
        setStep(id, label + '…');
        const t0 = Date.now();
        let r;
        try {
          r = await checkFacts(chat, items);
        } catch (e) {
          if (!e.stopped) logJob(chat, { kind: 'check', label, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200) });
          throw e;
        }
        if (r.sections.length) { chat.memory = applySections(chat.memory, r.sections); changed.add('the story'); }
        const was = new Map(chat.entries.map((e) => [e, e.text]));
        const applied = applyUpdates(chat.entries, r.updates, chat.ignored);
        for (const e of chat.entries) {
          if (!was.has(e) || was.get(e) !== e.text) changed.add(e.name);
        }
        if (applied.refused.length) toast('Kept the fuller version of: ' + applied.refused.join(', '));
        for (const e of items) e.checked = true;
        logJob(chat, { kind: 'check', label: label + (r.updates.length || r.sections.length ? ': updated ' + [...new Set(r.updates.map((u) => u.name).concat(r.sections.map((x) => x.title)))].join(', ') : ': nothing missing'), ok: true, ms: Date.now() - t0 });
        progress[id].done++;
        await saveChat(chat);
        renderPanel();
      }
      tidy(chat);
      if (JSON.stringify(before) !== JSON.stringify(snapshot(chat))) chat.history = [before].concat(chat.history).slice(0, 5);
      await saveChat(chat);
      toast('Checked ' + todo.length + ' summaries\' facts' + (changed.size ? '; added missing facts to ' + [...changed].join(', ') : '; nothing was missing'));
      return 'done';
    } catch (e) {
      if (JSON.stringify(before) !== JSON.stringify(snapshot(chat))) chat.history = [before].concat(chat.history).slice(0, 5);
      await saveChat(chat);
      if (e.stopped) { toast('Stopped. What was checked is kept.'); return 'stopped'; }
      chat.lastError = String(e.message || e);
      toast('Fact check failed: ' + chat.lastError, true);
      return 'failed';
    } finally {
      busy[id] = false;
      if (!anyBusy()) keepAwake(false);
      stopRequested[id] = false;
      if (activeChatId === id) activeChatId = null;
      delete progress[id];
      setStatus();
      renderPanel();
    }
  }

  async function writeChapters(chat, job) {
    for (;;) {
      const ready = chat.log.filter((e) => e.folded && e.chapter == null);
      if (ready.length < chapterSize()) return;
      const items = ready.slice(0, chapterSize());
      checkStop();
      const ch = await job('chapter', 'Wrote chapter ' + (chat.chapters.length + 1) + ' (' + replyRange(chat, items) + ')', () => makeChapter(chat, items));
      chat.chapters.push(ch);
      for (const e of items) e.chapter = chat.chapters.length - 1;
      await saveChat(chat);
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
    chat.knownMessages = Math.max(chat.knownMessages || 0, msgs.length);
    if (!chat.enabled || busy[id]) return;
    // The site only loads the newest messages. When they don't reach back to
    // what the memory already holds, read further back to see what is missing.
    const done = new Set(chat.processedIds);
    const sinceRead = async () => {
      try {
        const all = await fetchMessages(id, { mode: 'since' });
        return final || !all.length || all[all.length - 1].role !== 'assistant' ? all : all.slice(0, -1);
      } catch (e) { return usable; }
    };
    if (learned && done.size && !usable.some((m) => done.has(m.id))) usable = await sinceRead();
    const fresh = unprocessed(chat, usable).filter((m) => m.role === 'assistant').length;
    await saveChat(chat);
    if (id === currentId) renderPanel();
    if (fresh < Math.max(1, Number(settings.updateEvery) || 1)) return;
    if (learned && done.size && usable.some((m) => done.has(m.id))) usable = await sinceRead();
    // A chat seen for the first time starts from its recent messages; the
    // whole history is read only when asked (Rebuild), as it can be long.
    if (!chat.processedIds.length && !chat.memory.trim() && usable.length > FIRST_RUN_MESSAGES) {
      usable = usable.slice(-FIRST_RUN_MESSAGES);
      toast('Story memory started from the latest messages. Tap 📖 → Rebuild to read the whole chat.');
    }
    // Catching up on many messages takes many requests: only when asked.
    const todo = unprocessed(chat, usable);
    const plan = estimate(chat, todo);
    const requests = plan.total;
    if (plan.summaries > AUTO_MAX_REQUESTS) {
      const was = chat.backlog && chat.backlog.messages;
      chat.backlog = { messages: todo.length, requests };
      await saveChat(chat);
      if (was !== todo.length) toast(todo.length + ' messages are not in the story memory yet. Tap 📖 → Update now to read them (about ' + requests + ' requests).');
      if (id === currentId) renderPanel();
      return;
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
    if (settings.injectBudget === 16000) settings.injectBudget = DEFAULT_SETTINGS.injectBudget;
    // Helper chats used to be kept forever, until they got too long for the bot.
    if (!settings.rotateSet) { settings.helperRotate = DEFAULT_SETTINGS.helperRotate; settings.rotateSet = true; }
    if (!DETAIL[settings.detail]) settings.detail = DEFAULT_SETTINGS.detail;
    chatIndex = await Store.get('chatIndex', []);
    learned = await Store.get('learned', null);
    for (let slot = 0; slot < 3; slot++) {
      helperChats[slot] = await Store.get(helperKey(slot), null);
      if (helperChats[slot]) helperIds.add(helperChats[slot].id);
    }
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
    // "ce" = an error writing a reply, e.g. { conversationId, requestId, error, code }.
    if (d.dir === 'in' && chatOf && (d.event === 'ce' || (first.error && first.requestId && !first.payload))) {
      const raw = first.error;
      const text = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? (raw.message || raw.error || JSON.stringify(raw)) : '';
      lastChatError = chatErrors[String(chatOf).toLowerCase()] = {
        error: String(text || '').slice(0, 200), code: first.code == null ? '' : String(first.code), at: Date.now(),
        helper: helperIds.has(String(chatOf).toLowerCase()),
      };
      return;
    }
    // "pcm" events are pieces of a reply still being written (a few words
    // each), not messages; the finished reply arrives later as "cm".
    if (d.event === 'pcm' || (first && first.tmpO !== undefined)) {
      // Kept so a reply that never finishes can still be used.
      const pm = first && first.payload;
      if (chatOf && pm && typeof pm.text === 'string') {
        const key = String(chatOf).toLowerCase();
        let st = helperStream[key];
        if (!st || st.requestId !== first.requestId) st = helperStream[key] = { requestId: first.requestId, text: '', at: Date.now() };
        if (st.text.length < 400000) st.text += pm.text;
      }
      return;
    }
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
    .fab.top-right { right: 12px; top: 120px; bottom: auto; } .fab.top-left { left: 12px; top: 120px; bottom: auto; }
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
    // A zero-size fixed box: the button and panel never change the page's own
    // layout or scrolling (which could push the site's top bar off screen).
    host.style.cssText = 'position:fixed!important;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483647;';
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

  // Focusing a text box (or the keyboard opening) makes mobile browsers scroll
  // the whole page, which pushes the site's top bar and message box off
  // screen. Remember where the page was and put it back when the panel closes.
  let pageScroll = null;

  function scrollState() {
    const se = document.scrollingElement || document.documentElement;
    return { x: window.scrollX, y: window.scrollY, html: se ? se.scrollTop : 0, body: document.body ? document.body.scrollTop : 0 };
  }

  function restoreScroll(st) {
    if (!st) return;
    const se = document.scrollingElement || document.documentElement;
    if (window.scrollX !== st.x || window.scrollY !== st.y) window.scrollTo(st.x, st.y);
    if (se && se.scrollTop !== st.html) se.scrollTop = st.html;
    if (document.body && document.body.scrollTop !== st.body) document.body.scrollTop = st.body;
  }

  function togglePanel(open) {
    const want = open === undefined ? !ui.panel.classList.contains('open') : open;
    if (want && !ui.panel.classList.contains('open')) pageScroll = scrollState();
    ui.panel.classList.toggle('open', want);
    if (want) {
      renderPanel(true);
    } else {
      const active = root.activeElement;
      if (active && active.blur) active.blur();
      const st = pageScroll;
      // Again after the keyboard has finished closing.
      restoreScroll(st);
      setTimeout(() => restoreScroll(st), 150);
      setTimeout(() => restoreScroll(st), 600);
    }
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
    const chapterEds = chat.chapters.map((c, i) => chapterEditor(c, i));

    const save = async (quiet) => {
      const snap = snapshot(chat);
      chat.pinned = pinned.value;
      chat.memory = mem.value;
      for (const ed of editors) ed.apply();
      for (const ed of chapterEds) ed.apply();
      for (const e of chat.entries.filter((x) => x.deleted)) {
        for (const n of entryKeys(e)) if (!chat.ignored.includes(n.toLowerCase())) chat.ignored.push(n.toLowerCase());
      }
      chat.entries = chat.entries.filter((e) => !e.deleted && (e.name.trim() || e.text.trim()));
      tidy(chat);
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
          const parts = estimate(newChat(chat.id), msgs).total;
          const cost = settings.provider === 'miniapps'
            ? ' Each one uses MiniApps credits.'
            : '';
          if (!confirm('Rebuild the memory from all ' + msgs.length + ' messages? This takes about ' + parts +
            ' memory-keeper request' + (parts === 1 ? '' : 's') + '.' + cost +
            ' (Pinned facts and entries marked "Always send" are kept.)')) return;
          // Let an automatic update that started meanwhile finish first.
          for (let i = 0; busy[chat.id] && i < 600; i++) await sleep(500);
          const old = { snap: snapshot(chat), log: chat.log.slice(), ids: chat.processedIds.slice(), count: chat.processedCount, read: chat.readCount };
          chat.history = [old.snap].concat(chat.history).slice(0, 5);
          chat.memory = '';
          chat.entries = chat.entries.filter((e) => e.always);
          chat.chapters = [];
          chat.log = [];
          chat.processedIds = [];
          chat.processedCount = 0;
          await saveChat(chat);
          renderPanel(true);
          chat.readCount = 0;
          const status = await updateMemory(chat.id, msgs, { force: true });
          if ((status === 'failed' || status === 'stopped') && !chat.processedIds.length) {
            // Nothing was rebuilt: put the previous memory back.
            restore(chat, old.snap);
            chat.log = old.log;
            chat.processedIds = old.ids;
            chat.processedCount = old.count;
            chat.history.shift();
            await saveChat(chat);
            chat.readCount = old.read;
            await saveChat(chat);
            toast(status === 'stopped' ? 'Rebuild stopped, so the previous memory was kept.' : 'Rebuild failed, so the previous memory was kept: ' + chat.lastError, status !== 'stopped');
          } else if (status === 'stopped') {
            toast('Rebuild stopped partway; what was finished is kept. Tap "Update now" to continue.');
          } else if (status === 'failed') {
            toast('Rebuild stopped partway: ' + chat.lastError + ' Tap "Update now" to continue from where it stopped.', true);
          } else {
            toast('Memory rebuilt');
          }
          renderPanel(true);
          return;
        } else if (!unprocessed(chat, msgs).length && !stages(chat).unfolded) {
          toast('Memory is already up to date (' + msgs.length + ' messages checked)');
          return;
        }
        const status = await updateMemory(chat.id, msgs, { force: true });
        if (status === 'done') toast('Memory updated');
      } catch (e) {
        toast(String(e.message || e), true);
      }
      renderPanel(true);
    };

    // Redo the story, entries and chapters from the summaries already in the
    // log, without reading the chat again (much cheaper than a rebuild).
    const redoFromSummaries = async () => {
      if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
      if (!chat.log.length) { toast('There are no reply summaries yet.'); return; }
      const n = Math.ceil(chat.log.length / FOLD_MAX) + Math.floor(chat.log.length / chapterSize());
      if (!confirm('Rewrite the story, the entries and the chapters from the ' + chat.log.length + ' reply summaries? This takes about ' + n +
        ' memory-keeper requests. The summaries themselves, pinned facts and entries marked "Always send" are kept.')) return;
      await save(true);
      const old = { snap: snapshot(chat), log: chat.log.map((e) => Object.assign({}, e)) };
      chat.history = [old.snap].concat(chat.history).slice(0, 5);
      chat.memory = '';
      chat.entries = chat.entries.filter((e) => e.always);
      chat.chapters = [];
      for (const e of chat.log) { e.folded = false; delete e.chapter; }
      await saveChat(chat);
      const status = await updateMemory(chat.id, [], { force: true });
      if ((status === 'failed' || status === 'stopped') && stages(chat).unfolded === chat.log.length) {
        restore(chat, old.snap);
        chat.log = old.log;
        chat.history.shift();
        await saveChat(chat);
        toast(status === 'stopped' ? 'Stopped, so the previous memory was kept.' : 'Failed, so the previous memory was kept: ' + chat.lastError, status !== 'stopped');
      } else if (status === 'done') {
        toast('Story, entries and chapters rewritten from the summaries');
      }
      renderPanel(true);
    };

    const factCheck = async () => {
      if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
      await save(true);
      const unchecked = chat.log.filter((e) => e.facts && !e.checked).length;
      const all = !unchecked;
      const n = all ? chat.log.filter((e) => e.facts).length : unchecked;
      if (!n) { toast('There are no facts to check yet.'); return; }
      if (!confirm((all ? 'All facts have been checked before. Check all ' + n + ' summaries\' facts again?' : 'Check the facts of ' + n + ' summaries against the entries and story, and add what is missing?') +
        ' This takes a few memory-keeper requests.')) return;
      const status = await runFactCheck(chat.id, all);
      if (status === 'nothing') toast('There are no facts to check yet.');
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
    const st = stages(chat);
    const inPlay = entriesInPlay(chat).map((e) => e.name);
    return el('div', {},
      el('div', { class: 'status' },
        el('div', {}, el('b', {}, chat.title || 'Chat'), ' · ', chat.id.slice(0, 8)),
        el('div', {}, 'Messages in memory: ', el('b', {}, String(chat.readCount || chat.processedCount)), total ? ' of ' + total : '',
          ' · Last update: ', el('b', {}, ago(chat.lastUpdate))),
        lastSentInfo[chat.id] ? el('div', {}, 'Last message carried: ' + lastSentInfo[chat.id]) : null,
        el('div', {}, 'Reply summaries: ', el('b', {}, String(st.summaries)),
          st.unfolded ? ' (' + st.unfolded + ' waiting to go into the story & characters)' : '',
          ' · Chapters: ', el('b', {}, String(st.chapters)),
          st.summaries ? ' (next after ' + Math.max(0, chapterSize() - st.unchaptered - st.unfolded) + ' more replies)' : '',
          chat.log.some((e) => e.checked) ? ' · Facts checked: ' + chat.log.filter((e) => e.checked).length + ' of ' + chat.log.filter((e) => e.facts).length : ''),
        isBusy ? el('div', {}, '⏳ ' + ((progress[chat.id] && progress[chat.id].step) || 'Updating memory…') +
          (progress[chat.id] && progress[chat.id].writing && progress[chat.id].writing.some(Boolean)
            ? ' The bot has written ' + progress[chat.id].writing.reduce((n, x) => n + (x || 0), 0).toLocaleString() + ' characters so far.' : '') +
          (progress[chat.id] && progress[chat.id].total > 1
            ? ' (step ' + Math.min(progress[chat.id].done + 1, progress[chat.id].total) + ' of about ' + Math.max(progress[chat.id].total, progress[chat.id].done + 1) + ')' : ''),
          ' ', el('button', { class: 'btn', onclick: () => { stopRequested[chat.id] = true; toast('Stopping after the current request…'); } }, '■ Stop')) : null,
        !isBusy && chat.backlog ? el('div', { class: 'error' }, '⚠ ' + chat.backlog.messages + ' messages are not in the memory yet (about ' +
          chat.backlog.requests + ' requests). Tap "Update now" to read them.') : null,
        chat.lastError ? el('div', { class: 'error' }, '⚠ ' + chat.lastError) : null),
      el('div', { class: 'row' }, enabled, el('label', { for: 'smx-en' }, 'Auto-manage this chat')),
      el('label', {}, '📌 Pinned facts (never changed automatically, always sent)'),
      pinned,
      el('label', {}, '📖 The story now (current scene, open threads, world & timeline; always sent)'),
      mem,
      el('div', { class: 'hint' }, mem.value.length + ' characters.'),
      el('label', {}, '📚 Chapters (' + chat.chapters.length + ')'),
      el('div', { class: 'hint' }, chat.chapters.length
        ? 'The story\'s history. The newest chapters are sent in full, older ones by title once they no longer fit.'
        : 'Every ' + chapterSize() + ' AI replies become a chapter of the story\'s history.'),
      chapterEds.map((ed) => ed.node),
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
        el('button', { class: 'btn', disabled: !chat.history.length, onclick: undo }, 'Undo last change')),
      el('div', { class: 'btns' },
        el('button', { class: 'btn', disabled: isBusy || !chat.log.length, onclick: factCheck }, 'Check for missing facts'),
        el('button', { class: 'btn', disabled: isBusy || !chat.log.length, onclick: redoFromSummaries }, 'Redo story & characters from summaries'),
        el('button', { class: 'btn', disabled: isBusy, onclick: () => runNow(true) }, 'Rebuild from whole chat')),
      activityView(chat),
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

  // One collapsible chapter in the panel. apply() copies the edits into it.
  function chapterEditor(c, i) {
    const title = el('input', { value: c.title });
    const text = el('textarea', { class: 'entry' });
    text.value = c.text;
    const node = el('details', { class: 'entrybox' },
      el('summary', {}, 'Chapter ' + (i + 1) + ': ' + c.title + ' · ' + (c.ids ? c.ids.length + ' replies · ' : '') + c.text.length + ' chars'),
      el('label', {}, 'Title'), title,
      el('label', {}, 'Summary'), text);
    return {
      node,
      apply() {
        c.title = title.value.trim() || c.title;
        c.text = text.value;
      },
    };
  }

  // What the memory keeper did, newest first.
  function activityView(chat) {
    const jobs = chat.jobs || [];
    const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dur = (ms) => (ms >= 60000 ? Math.round(ms / 60000) + ' min' : Math.round(ms / 1000) + ' s');
    return el('details', { class: 'entrybox' },
      el('summary', {}, '🗒 Activity (' + jobs.length + ' recent jobs' + (jobs.some((j) => !j.ok) ? ', some failed' : '') + ')'),
      jobs.length
        ? el('div', { class: 'hint' }, ...jobs.map((j) => el('div', {}, time(j.at) + ' ' + (j.ok ? '✓ ' : '✗ ') + j.label +
          ' (' + dur(j.ms || 0) + ')' + (j.error ? ': ' + j.error : ''))))
        : el('div', { class: 'hint' }, 'Nothing yet.'));
  }

  let hookStats = null;
  on('stats', (d) => { hookStats = d; });

  // The reply-by-reply log, newest first; read-only (Rebuild redoes it).
  function logView(chat) {
    const box = el('textarea', { readonly: true, class: 'log' });
    // ⏳ = not yet in the story & characters; 📚n = part of chapter n.
    box.value = chat.log.length
      ? chat.log.slice().reverse().map((e, i) => '#' + (chat.log.length - i) +
        (!e.folded ? ' ⏳' : e.chapter != null ? ' 📚' + (e.chapter + 1) : '') + '  ' + e.text +
        (e.facts ? '\n   Facts: ' + e.facts : '')).join('\n\n')
      : 'Each AI reply gets a detailed summary here as the story goes on.';
    const attached = Math.min(chat.log.length, Math.max(0, Number(settings.logAttach) || 0));
    return el('div', {},
      el('label', {}, '📜 Reply-by-reply log (' + chat.log.length + ' entries, newest first)'),
      box,
      el('div', { class: 'hint' }, 'Everything since the last chapter (at least the latest ' + attached + ') is attached to your messages, newest first, as far as the space allows. ⏳ = not yet in the story & characters; 📚 = in that chapter.'));
  }

  function diagnosticsText() {
    document.dispatchEvent(new CustomEvent('smx:ping'));
    const version = typeof GM_info !== 'undefined' && GM_info && GM_info.script ? GM_info.script.version : '?';
    const chat = currentId && chats[currentId];
    const lines = [
      'Story Manager v' + version,
      'Page: ' + shortUrl(location.href),
      'Screen: ' + wake.state,
      'Current chat: ' + (currentId ? currentId.slice(0, 8) : 'none') +
        (chat ? ' · messages seen: ' + (seenMsgs[currentId] ? seenMsgs[currentId].size : 0) + ' · in memory: ' + (chat.readCount || chat.processedCount) : ''),
      'Learned message address: ' + (learned ? shortUrl(learned.template.split('{id}').join('00000000-0000-0000-0000-000000000000')) : 'none yet'),
      'Memory keeper: ' + settings.provider + (settings.provider === 'miniapps' ? ' (' + settings.miniappsSlug + ')' : ''),
      'Helper chat: ' + (helperChats.some(Boolean) ? helperChats.map((h, i) => (h ? (i ? 'slot ' + i + ' ' : '') + h.id.slice(0, 8) + ', ' + h.uses + ' requests' : '')).filter(Boolean).join(' · ') : 'none yet') +
        (helperWait ? ' · last wait: ' + Math.round((Date.now() - helperWait.started) / 1000) + 's ago started, messages ' + (helperWait.roles || '-') +
          ', request ' + (helperWait.requestFound ? 'found' : 'not found') + ', new answers ' + helperWait.newAnswers +
          (helperWait.readOk ? '' : ', last read failed') + ', answer ' + helperWait.answerChars + ' chars' +
          (helperWait.done ? ', done' : '') +
          ', bot last active ' + (helperWait.lastActivity ? Math.round((Date.now() - helperWait.lastActivity) / 1000) + 's ago' : 'never') : ''),
      'Pipeline: ' + (chat ? (() => { const st = stages(chat); return st.summaries + ' summaries (' + chat.log.filter((e) => e.facts).length + ' with facts), ' +
        chat.log.filter((e) => e.checked).length + ' facts-checked, ' + st.unfolded + ' waiting for story & characters, ' + st.unchaptered + ' waiting for a chapter, ' + st.chapters + ' chapters' +
        ' · settings: summaries every ' + settings.updateEvery + ', story & characters every ' + foldEvery() + ', chapter every ' + chapterSize() +
        ', ' + parallel() + ' at once, detail ' + settings.detail; })() : 'no chat'),
      'Last tidy-up: ' + (chat && chat.checked ? ago(chat.checked) : 'never') +
        (chat && chat.jobs ? ' · ' + ((chat.jobs.find((j) => j.kind === 'check') || {}).label || 'nothing needed fixing') : ''),
      'Recent jobs: ' + (chat && chat.jobs && chat.jobs.length ? chat.jobs.slice(0, 6).map((j) => (j.ok ? '✓ ' : '✗ ') + j.label +
        ' ' + Math.round((j.ms || 0) / 1000) + 's' + (j.error ? ' (' + j.error.slice(0, 80) + ')' : '')).join(' · ') : 'none'),
      'Memory size: ' + (chat ? 'story ' + chat.memory.length + ' characters · chapters ' + chat.chapters.reduce((n, c) => n + c.text.length, 0) + ' characters · ' + chat.entries.length + ' entries, ' +
        chat.entries.reduce((n, e) => n + e.text.length, 0) + ' characters' +
        (chat.entries.length ? ' (longest: ' + chat.entries.reduce((a, b) => (b.text.length > a.text.length ? b : a)).name + ', ' +
          Math.max(...chat.entries.map((e) => e.text.length)) + ')' : '') +
        ' · log ' + chat.log.length + ' entries, ' + chat.log.reduce((n, e) => n + e.text.length, 0) + ' characters' : 'no chat'),
      'Last chat error from MiniApps: ' + (lastChatError ? (lastChatError.helper ? 'helper chat, ' : 'story chat, ') +
        Math.round((Date.now() - lastChatError.at) / 1000) + 's ago: ' + (lastChatError.error || '(no message)') + (lastChatError.code ? ' · code ' + lastChatError.code : '') : 'none'),
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
    lines.push('', 'Layout (to find out what hides the top bar):');
    lines.push(...layoutReport());
    lines.push('Since the page loaded: page scrolled up to ' + Math.round(layoutWatch.maxScroll) + ', visible area moved down up to ' +
      Math.round(layoutWatch.maxViewportTop) + ', window height ' + (layoutWatch.maxHeight ? layoutWatch.minHeight + '–' + layoutWatch.maxHeight : innerHeight));
    if (layoutWatch.first) {
      lines.push('First shift ' + Math.round((Date.now() - layoutWatch.first.at) / 1000) + 's ago (page ' + Math.round(layoutWatch.first.y) +
        ', visible area ' + Math.round(layoutWatch.first.vvTop) + ', panel ' + (layoutWatch.first.panelOpen ? 'open' : 'closed') + '):');
      layoutWatch.first.report.forEach((l) => lines.push('  ' + l));
    }
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

  // Watch for the whole page shifting at any time (not just when the panel is
  // open), keeping the worst state and a snapshot of the first shift.
  const layoutWatch = { maxScroll: 0, maxViewportTop: 0, minHeight: Infinity, maxHeight: 0, first: null };

  function watchLayout() {
    try {
      const se = document.scrollingElement || document.documentElement;
      const y = Math.max(window.scrollY, se ? se.scrollTop : 0, document.body ? document.body.scrollTop : 0);
      const vvTop = window.visualViewport ? window.visualViewport.offsetTop : 0;
      layoutWatch.maxScroll = Math.max(layoutWatch.maxScroll, y);
      layoutWatch.maxViewportTop = Math.max(layoutWatch.maxViewportTop, vvTop);
      layoutWatch.minHeight = Math.min(layoutWatch.minHeight, innerHeight);
      layoutWatch.maxHeight = Math.max(layoutWatch.maxHeight, innerHeight);
      if ((y > 0 || vvTop > 0) && !layoutWatch.first) {
        layoutWatch.first = { at: Date.now(), y, vvTop, panelOpen: !!(ui.panel && ui.panel.classList.contains('open')), report: layoutReport() };
      }
    } catch (e) { /* ignore */ }
  }
  window.addEventListener('scroll', watchLayout, { passive: true });
  window.addEventListener('resize', watchLayout, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('scroll', watchLayout, { passive: true });
    window.visualViewport.addEventListener('resize', watchLayout, { passive: true });
  }

  // Where the page and the site's bars are, without any text from the page.
  function layoutReport() {
    const out = [];
    const r = (n) => Math.round(n);
    const se = document.scrollingElement || document.documentElement;
    const vv = window.visualViewport;
    out.push('Window ' + innerWidth + '×' + innerHeight + (vv ? ', visible ' + r(vv.width) + '×' + r(vv.height) + ' at ' + r(vv.offsetTop) : '') +
      ' · page scrolled ' + r(window.scrollY) + ' (page height ' + (se ? se.scrollHeight : '?') + ', body scroll ' + (document.body ? document.body.scrollTop : '?') + ')' +
      (pageScroll ? ' · when panel opened: ' + r(pageScroll.y) : ''));
    const cs = (e) => getComputedStyle(e);
    out.push('html overflow ' + cs(document.documentElement).overflowY + ', height ' + cs(document.documentElement).height +
      ' · body overflow ' + (document.body ? cs(document.body).overflowY + ', height ' + cs(document.body).height + ', position ' + cs(document.body).position : '?'));
    out.push('Elements around the page: ' + [...document.documentElement.children].map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')).join(', '));
    const label = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
      (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
    // Fixed or sticky bars, and anything near the top of the page.
    const bars = [];
    if (document.body) {
      for (const e of document.body.querySelectorAll('*')) {
        if (bars.length >= 8) break;
        const st = cs(e);
        if (st.position !== 'fixed' && st.position !== 'sticky') continue;
        const b = e.getBoundingClientRect();
        if (b.width < innerWidth * 0.5 || b.height < 20 || b.height > innerHeight * 0.5) continue;
        bars.push(label(e).slice(0, 60) + ' ' + st.position + ' top ' + r(b.top) + ' bottom ' + r(b.bottom) +
          (st.transform && st.transform !== 'none' ? ' transform ' + st.transform : '') + (st.display === 'none' || st.visibility === 'hidden' ? ' hidden' : ''));
      }
    }
    out.push('Fixed/sticky bars: ' + (bars.length ? '' : 'none found'));
    bars.forEach((b) => out.push('  ' + b));
    // Scrolled containers (e.g. the chat).
    const scrolled = [];
    if (document.body) {
      for (const e of document.body.querySelectorAll('*')) {
        if (scrolled.length >= 5) break;
        if (e.scrollTop > 0 && e.scrollHeight > e.clientHeight + 10) {
          const b = e.getBoundingClientRect();
          scrolled.push('  ' + label(e).slice(0, 60) + ' top ' + r(b.top) + ' height ' + r(b.height) + ' scrolled ' + r(e.scrollTop) + ' of ' + e.scrollHeight);
        }
      }
    }
    out.push('Scrolled containers: ' + (scrolled.length ? '' : 'none'));
    out.push(...scrolled);
    const host = document.getElementById('story-manager-root');
    if (host) {
      const b = host.getBoundingClientRect();
      out.push('Story Manager box: ' + cs(host).position + ' ' + r(b.width) + '×' + r(b.height) + ' at ' + r(b.top) + ',' + r(b.left));
    }
    return out;
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
      // No select()/focus here: it would scroll the page (see togglePanel).
      try { await navigator.clipboard.writeText(box.value); toast('Diagnostics copied — paste them to Claude'); } catch (e) { toast('Long-press the text in the box to copy it'); }
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
    f.foldEvery = el('input', { type: 'number', min: '1', value: String(s.foldEvery) });
    f.chapterSize = el('input', { type: 'number', min: '4', value: String(s.chapterSize) });
    f.parallel = el('select', {}, ...[1, 2, 3].map((n) => el('option', { value: String(n), selected: Number(s.parallel) === n ? '' : null }, String(n))));
    f.injectEvery = el('input', { type: 'number', min: '0', value: String(s.injectEvery) });
    f.detail = el('select', {}, ...Object.entries(DETAIL).map(([k, d]) => el('option', { value: k, selected: s.detail === k ? '' : null }, d.label)));
    f.logAttach = el('input', { type: 'number', min: '0', value: String(s.logAttach) });
    f.injectBudget = el('input', { type: 'number', min: '2000', step: '1000', value: String(s.injectBudget) });
    f.autoEnable = el('input', { type: 'checkbox', id: 'smx-auto' });
    f.autoEnable.checked = s.autoEnable;
    f.buttonSide = el('select', {},
      el('option', { value: 'right' }, 'Bottom right'), el('option', { value: 'left' }, 'Bottom left'),
      el('option', { value: 'top-right' }, 'Top right'), el('option', { value: 'top-left' }, 'Top left'));
    f.buttonSide.value = s.buttonSide;

    const keyBox = el('div', {}, el('label', {}, 'API key'), f.apiKey, el('label', {}, 'Model'), f.model);
    const baseBox = el('div', {}, el('label', {}, 'Base URL'), f.baseUrl,
      el('div', { class: 'hint' }, 'OpenRouter: https://openrouter.ai/api/v1 · OpenAI: https://api.openai.com/v1 · Groq: https://api.groq.com/openai/v1'));
    const slugBox = el('div', {}, el('label', {}, 'MiniApps bot used as memory keeper (slug from its URL)'), f.miniappsSlug,
      el('div', { class: 'hint' }, 'Memory updates are sent to this bot in one helper chat in your MiniApps history (uses MiniApps credits).'),
      el('label', {}, 'Start a fresh helper chat every … requests (0 = always the same chat)'), f.helperRotate,
      el('div', { class: 'hint' }, 'A helper chat that gets too long can make the bot stop answering. 30 is a safe default; lower it if the bot still errors, raise it for fewer chats in your history.'),
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
      rotateSet: true,
      updateEvery: Math.max(1, parseInt(f.updateEvery.value, 10) || 1),
      foldEvery: Math.max(1, parseInt(f.foldEvery.value, 10) || DEFAULT_SETTINGS.foldEvery),
      chapterSize: Math.max(4, parseInt(f.chapterSize.value, 10) || DEFAULT_SETTINGS.chapterSize),
      parallel: Math.min(3, Math.max(1, parseInt(f.parallel.value, 10) || 1)),
      injectEvery: Math.max(0, parseInt(f.injectEvery.value, 10) || 0),
      detail: f.detail.value,
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
      try { await navigator.clipboard.writeText(backup.value); toast('Backup copied to clipboard'); } catch (e) { toast('Backup ready — long-press the box to copy it'); }
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
      el('label', {}, 'Summarise new AI replies every … replies'), f.updateEvery,
      el('label', {}, 'Update the story & characters every … AI replies'), f.foldEvery,
      el('div', { class: 'hint' }, 'The newest reply summaries are always sent with your messages, so the story & characters can be updated less often. Update now does it straight away.'),
      el('label', {}, 'Chapter length (AI replies)'), f.chapterSize,
      el('label', {}, 'Summary requests that may run at the same time'), f.parallel,
      el('div', { class: 'hint' }, 'More than 1 makes catching up faster, each in its own helper chat. If the bot starts failing, set it back to 1.'),
      el('label', {}, 'Attach the memory to every … messages you send (0 = never)'), f.injectEvery,
      el('label', {}, 'Summary detail'), f.detail,
      el('div', { class: 'hint' }, 'How long reply summaries and character entries are. Standard: 300–1,500 characters per reply summary. Detailed: 700–3,000. Maximum: 1,200–5,000. More detail needs more memory-keeper requests (each one covers fewer replies). Summaries already written stay as they are; Rebuild from whole chat rewrites them.'),
      el('label', {}, 'Most characters attached to one message'), f.injectBudget,
      el('div', { class: 'hint' }, 'The story and entries in play are always attached; entries your message mentions and the newest reply summaries fill the rest of this space.'),
      el('label', {}, 'Detailed reply summaries attached to each message'), f.logAttach,
      el('div', { class: 'hint' }, 'Every AI reply gets a summary (length set by Summary detail above). The newest ones are attached to your messages in full, as far as the space above allows. More helps the AI remember detail, but makes every message longer.'),
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
