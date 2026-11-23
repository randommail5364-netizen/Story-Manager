// ==UserScript==
// @name         MiniApps Story Manager
// @namespace    https://github.com/randommail5364-netizen/Story-Manager
// @version      3.53.1
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
// @connect      api.github.com
// @connect      gist.githubusercontent.com
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
  // This script's version, recorded on each story it works on.
  const SM_VERSION = typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version ? String(GM_info.script.version) : '';

  // If anything stops the script from starting, say where instead of failing silently.
  let stage = 'starting';
  let uiStarted = false;
  setTimeout(() => {
    if (!uiStarted) alert('Story Manager did not finish starting (stuck at: ' + stage + '). Please send this message to Claude.');
  }, 15000);

  const MEM_START = '[[STORY-MEMORY]]';
  const MEM_END = '[[/STORY-MEMORY]]';
  const MEM_BLOCK_RE = /\[\[STORY-MEMORY\]\][\s\S]*?\[\[\/STORY-MEMORY\]\]\s*/g;
  // The label Story Manager puts before the user's own text in the pinned
  // memory message (see memoryMessageText): not something the user wrote.
  const PINNED_LABEL_RE = /\(My earlier message from when this note was pinned\.[^)]*\)\s*/g;
  const ownText = (t) => String(t || '').replace(MEM_BLOCK_RE, '').replace(PINNED_LABEL_RE, '').trim();
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  // ---------------------------------------------------------------------------
  // Page hook — runs in the website's own JavaScript world so it can see and
  // adjust the site's network requests. Talks to the rest of the script only
  // through DOM events / attributes, so it works in every userscript manager.
  // ---------------------------------------------------------------------------

  function pageHook(win, compose) {
    if (win.__smxHooked) return;
    win.__smxHooked = true;
    const doc = win.document;
    if (doc.documentElement) doc.documentElement.setAttribute('data-smx-hook', '1');

    // When this runs inside Firefox's userscript sandbox instead of the page,
    // functions and objects handed to the page must be exported / cloned.
    const sandboxed = typeof exportFunction === 'function' && typeof cloneInto === 'function';
    const expFn = (fn, target) => (sandboxed ? exportFunction(fn, target) : fn);
    const toPage = (obj) => (sandboxed ? cloneInto(obj, win) : obj);

    // MiniApps' own sounds (ringtones, notification sounds from /sounds/) and
    // audio channels it opens can take the phone's audio focus, pausing the
    // user's music. Unless turned off in Settings: those sounds never play,
    // and an audio channel only starts right after the user taps something
    // (so MiniApps' voice features still work when used).
    let blockSounds = true;
    try { blockSounds = win.localStorage.getItem('smx:blockSounds') !== '0'; } catch (e) { /* ignore */ }
    doc.addEventListener('smx:sounds', (ev) => { blockSounds = ev.detail !== '0'; });
    let gestureAt = 0;
    const gesture = () => { gestureAt = Date.now(); };
    win.addEventListener('pointerdown', expFn(gesture, win), true);
    win.addEventListener('keydown', expFn(gesture, win), true);
    const justTapped = () => Date.now() - gestureAt < 1500;
    try {
      const MP = win.HTMLMediaElement && win.HTMLMediaElement.prototype;
      if (MP && MP.play) {
        const origPlay = MP.play;
        MP.play = expFn(function () {
          try {
            const src = String(this.currentSrc || this.src || (this.querySelector && this.querySelector('source') && this.querySelector('source').src) || '');
            if (blockSounds && /\/sounds\//i.test(src)) { this.muted = true; return win.Promise.resolve(); }
          } catch (e) { /* play normally */ }
          return origPlay.apply(this, arguments);
        }, MP);
      }
      for (const name of ['AudioContext', 'webkitAudioContext']) {
        const AC = win[name];
        if (!AC || !AC.prototype || !AC.prototype.resume) continue;
        const origResume = AC.prototype.resume;
        AC.prototype.resume = expFn(function () {
          if (blockSounds && !justTapped()) return win.Promise.resolve();
          return origResume.apply(this, arguments);
        }, AC.prototype);
      }
    } catch (e) { /* the page's audio is left as it is */ }

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
      // An edit (or edit and regenerate) of an earlier message gets no memory.
      const edit = !!body.overrideMessageId;
      if (convId && !edit) {
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
      // The request's fields (names, IDs and flags; never message text), so
      // Diagnostics can show how e.g. an edit differs from a new message.
      const shape = {};
      for (const [k, v] of Object.entries(body)) {
        if (k === 'elements') shape[k] = Array.isArray(v) ? v.map((x) => (x && x.type) || '?').join(',') : typeof v;
        else if (typeof v === 'string') shape[k] = /text|content|message|prompt/i.test(k) || v.length > 64 ? 'text(' + v.length + ')' : v;
        else if (v === null || typeof v !== 'object') shape[k] = v;
        else shape[k] = Array.isArray(v) ? 'array[' + v.length + ']' : '{' + Object.keys(v).join(',') + '}';
      }
      emit('sent', { conversationId: convId, injected, userText, included, size, shape, edit });
      return injected;
    }

    function report(info, text, status) {
      if (info.kind === 'send') emit('sendResult', { text });
      else if (info.kind === 'conv') emit('conv', { id: info.id, text });
      // Everything else is reported too, so the script can learn which
      // request really carries a chat's messages.
      else if (info.kind === 'other') emit('api', { method: info.method, url: info.url, status, text: text && text.length < 3000000 ? text : '' });
    }

    // Story Manager's helper chats are left out of MiniApps' chat lists.
    let hidden = [];
    // Read at once from the site's storage: the chat list loads before the script's own storage.
    try { hidden = JSON.parse(win.localStorage.getItem('smx:hide') || doc.documentElement.getAttribute('data-smx-hide') || '[]'); } catch (e) { /* ignore */ }
    // While Story Manager creates a helper chat, announcements of new chats are
    // held back (its id is not known yet), then passed on unless they are it.
    let holdUntil = 0;
    let held = [];
    const releaseHeld = () => {
      const list = held;
      held = [];
      holdUntil = 0;
      for (const h of list) { try { h.fn.apply(h.self, h.args); } catch (e) { /* the site's own handler */ } }
    };
    doc.addEventListener('smx:hold', () => { holdUntil = Date.now() + 20000; setTimeout(() => { if (held.length && Date.now() >= holdUntil) releaseHeld(); }, 20500); });
    doc.addEventListener('smx:hide', (ev) => {
      try { hidden = JSON.parse(ev.detail); } catch (e) { /* ignore */ }
      if (held.length) {
        held = held.filter((h) => !hidden.some((id) => String(h.args[0] && h.args[0].data).toLowerCase().indexOf(id) >= 0));
        releaseHeld();
      } else holdUntil = 0;
    });
    const LIST_RE = /\/conversations\/quickAccess|\/tools\/[^/?]+\/conversations|\/projects\/[^/?]+\/conversations|\/conversations\/?(\?|$)/;
    function withoutHelpers(r) {
      if (!r.ok || !hidden.length) return r;
      return r.clone().text().then((t) => {
        let d;
        try { d = JSON.parse(t); } catch (e) { return r; }
        const here = pageChat();
        const keep = (x) => !(x && x.id && String(x.id).toLowerCase() !== here && hidden.includes(String(x.id).toLowerCase()));
        const list = Array.isArray(d) ? d : d && Array.isArray(d.items) ? d.items : null;
        if (!list) return r;
        const kept = list.filter(keep);
        if (kept.length === list.length) return r;
        if (Array.isArray(d)) d = kept;
        else {
          d.items = kept;
          if (typeof d.total === 'number') d.total = Math.max(0, d.total - (list.length - kept.length));
        }
        return new win.Response(JSON.stringify(d), { status: r.status, statusText: r.statusText, headers: r.headers });
      }).catch(() => r);
    }

    // The site must not switch to a helper chat on its own (e.g. when it hears
    // that a new chat was started). A page change the user did not just ask
    // for (no tap or key press in the last 2 seconds) is refused if it leads
    // to a helper chat, or to any chat while a helper chat is being created.
    let lastInput = 0;
    for (const t of ['pointerdown', 'touchstart', 'keydown', 'click']) {
      doc.addEventListener(t, () => { lastInput = Date.now(); }, true);
    }
    // The chat the page is on (never hidden or blocked: the site needs it).
    const pageChat = () => ((String(win.location.pathname).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [''])[0]).toLowerCase();
    const unwanted = (url) => {
      try {
        if (Date.now() - lastInput < 2000) return false;
        const u = String(url || '').toLowerCase();
        if (!/\/c\/[0-9a-f-]{36}/.test(u)) return false;
        const here = pageChat();
        if (here && u.indexOf(here) >= 0) return false; // the chat already open
        return Date.now() < holdUntil || hidden.some((id) => u.indexOf(id) >= 0);
      } catch (e) { return false; }
    };
    for (const name of ['pushState', 'replaceState']) {
      const orig = win.history[name];
      win.history[name] = expFn(function (state, title, url) {
        if (unwanted(url)) return undefined;
        return orig.apply(this, arguments);
      }, win.history);
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
      let p = origFetch(input, init);
      try {
        const u = typeof input === 'string' ? input : (input && input.url) || String(input);
        const m = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (m === 'GET' && hidden.length && LIST_RE.test(u)) p = p.then(withoutHelpers);
      } catch (e) { /* leave the response as it is */ }
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
      // Live events about a helper chat (or one of Story Manager's own
      // requests, known before its chat exists) are not passed on to the site:
      // otherwise a new helper chat shows up in its lists, and the site may
      // even jump to it. Story Manager's own listener still gets them.
      const aboutHelper = (ev) => {
        try {
          const d = ev && ev.data;
          if (typeof d !== 'string' || !hidden.length || d.indexOf('42[') !== 0) return false;
          const low = d.toLowerCase();
          const path = String(win.location.pathname).toLowerCase();
          return hidden.some((id) => low.indexOf(id) >= 0 && path.indexOf(id) < 0);
        } catch (e) { return false; }
      };
      const wrapped = new WeakMap();
      const wrap = (fn) => {
        if (typeof fn !== 'function') return fn;
        if (!wrapped.has(fn)) {
          wrapped.set(fn, expFn(function (ev) {
            if (aboutHelper(ev)) return undefined;
            const d = ev && typeof ev.data === 'string' ? ev.data : '';
            if (Date.now() < holdUntil && d.indexOf('42["cu"') === 0 && d.indexOf('"conversation"') >= 0) {
              held.push({ fn, self: this, args: arguments });
              return undefined;
            }
            return fn.apply(this, arguments);
          }, win));
        }
        return wrapped.get(fn);
      };
      const oAdd = WP.addEventListener;
      const oRemove = WP.removeEventListener;
      WP.addEventListener = expFn(function (type, fn, opts) {
        return oAdd.call(this, type, type === 'message' ? wrap(fn) : fn, opts);
      }, WP);
      WP.removeEventListener = expFn(function (type, fn, opts) {
        return oRemove.call(this, type, type === 'message' && wrapped.has(fn) ? wrapped.get(fn) : fn, opts);
      }, WP);
      try {
        const om = Object.getOwnPropertyDescriptor(WP, 'onmessage');
        if (om && om.set && om.configurable) {
          Object.defineProperty(WP, 'onmessage', {
            configurable: true,
            enumerable: om.enumerable,
            get: om.get,
            set: expFn(function (fn) { om.set.call(this, wrap(fn)); }, WP),
          });
        }
      } catch (e) { /* the site keeps the unfiltered events */ }
      const oWsSend = WP.send;
      WP.send = expFn(function (data) {
        try {
          bump('wsOut');
          // Start listening to this socket the first time it sends anything.
          if (!this.__smxListening) {
            this.__smxListening = true;
            oAdd.call(this, 'message', sandboxed ? expFn(onWsMessage, win) : onWsMessage);
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

  // Builds the notes attached to a message from a plan (see buildPlan): the
  // story, the entries in play, entries the message mentions (while they
  // fit), then the newest reply summaries. Self-contained: the page hook gets
  // a copy of it.
  function composeMemory(plan, userText) {
    if (typeof plan === 'string') return { text: plan, names: [] };
    const mentionsKey = (text, key) => {
      const k = String(key || '').trim();
      if (k.length < 2) return false;
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^\\p{L}\\p{N}])' + esc + '($|[^\\p{L}\\p{N}])', 'iu').test(text);
    };
    const names = [];
    const blocks = [];
    let size = plan.head.length + (plan.tail || '').length;
    // Entries in play are always sent, but a very long one is shortened for
    // this message (its start and its newest facts) so the notes fit.
    const room = Math.max(4000, plan.budget - size);
    // Short entries go in whole; the space left is shared by the long ones.
    const space = Math.floor(room * 0.75);
    const lens = plan.core.map((e) => e.text.length).sort((a, b) => a - b);
    let share = Infinity;
    let left = space;
    for (let i = 0; i < lens.length; i++) {
      const even = Math.floor(left / (lens.length - i));
      if (lens[i] > even) { share = Math.max(1200, even); break; }
      left -= lens[i];
    }
    const trim = (t) => {
      if (t.length <= share) return t;
      const head = t.slice(0, Math.floor(share * 0.35));
      const tail = t.slice(t.length - Math.floor(share * 0.65));
      return head.slice(0, Math.max(head.lastIndexOf('\n'), 1)) + '\n[…]\n' + tail.slice(tail.indexOf('\n') + 1);
    };
    const add = (e, force) => {
      const t = '### ' + e.name + (e.kind ? ' (' + e.kind + ')' : '') + '\n' + (force ? trim(e.text) : e.text);
      if (!force && size + t.length > plan.budget) return;
      blocks.push(t);
      names.push(e.name);
      size += t.length + 2;
    };
    plan.core.forEach((e) => add(e, true));
    plan.extra.filter((e) => e.keys.some((k) => mentionsKey(userText, k))).forEach((e) => add(e, false));
    // The pinned memory message (no text of its own) fits in the others too, as far as there is room.
    if (!userText && plan.fillAll) plan.extra.filter((e) => !names.includes(e.name)).forEach((e) => add(e, false));
    const logs = [];
    for (let i = plan.log.length - 1; i >= 0; i--) {
      const t = '- ' + plan.log[i];
      if (size + t.length > plan.budget) break;
      logs.unshift(t);
      size += t.length + 1;
    }
    const parts = [];
    if (plan.head) parts.push(plan.head);
    if (blocks.length) parts.push('## ' + (plan.charTitle || 'Characters and details in play') + '\n' + blocks.join('\n\n'));
    if (plan.tail) parts.push(plan.tail);
    if (logs.length) parts.push('## Recent events in detail (oldest first)\n' + logs.join('\n'));
    if (logs.length) names.push(logs.length + ' reply summaries');
    return { text: plan.prefix + parts.join('\n\n') + plan.suffix, names };
  }

  function installPageHook() {
    const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    if (W === window) { pageHook(window, composeMemory); return; }
    if (W.__smxHooked) return;
    try {
      const s = document.createElement('script');
      s.textContent = '(' + pageHook.toString() + ')(window, ' + composeMemory.toString() + ');';
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) { /* ignore */ }
    // Inline scripts can be blocked by a Content-Security-Policy; fall back to
    // patching the page directly through unsafeWindow.
    if (!document.documentElement || document.documentElement.getAttribute('data-smx-hook') !== '1') {
      try { pageHook(W, composeMemory); } catch (e) { console.warn('[Story Manager] could not hook the page', e); }
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

  // Saved data lives in Tampermonkey's storage. It is never swapped for the
  // browser's own storage (an old copy there once made a story look like a
  // helper chat and turned sync off): a slow read is waited for and tried
  // again; if it still fails, nothing is saved this visit and the panel says
  // to reload, so the real data is never overwritten with defaults.
  let storageFailed = '';
  const Store = {
    async get(key, def) {
      let raw;
      if (hasGM) {
        for (let attempt = 1; ; attempt++) {
          try { raw = await withTimeout(GM.getValue(key), 15000); break; }
          catch (e) {
            if (attempt >= 3) { storageFailed = 'could not read "' + key + '" from Tampermonkey (' + String(e.message || e) + ')'; console.warn('[Story Manager] ' + storageFailed); return def; }
          }
        }
      } else if (hasGMLegacy) raw = GM_getValue(key);
      else raw = localStorage.getItem('smx:' + key);
      if (raw === undefined || raw === null) return def;
      try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return def; }
    },
    async set(key, value) {
      if (storageFailed) return; // never overwrite the real data with what a failed read gave
      const raw = JSON.stringify(value);
      try {
        if (hasGM) await withTimeout(GM.setValue(key, raw), 15000);
        else if (hasGMLegacy) GM_setValue(key, raw);
        else localStorage.setItem('smx:' + key, raw);
      } catch (e) { console.warn('[Story Manager] could not save', e); }
    },
  };

  const DEFAULT_SETTINGS = {
    provider: 'miniapps', // miniapps | gemini | anthropic | openai
    apiKey: '',
    githubToken: '',  // syncs every chat's memory to a private GitHub Gist when set
    model: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    miniappsSlug: 'claude-37',
    helperRotate: 30, // start a new helper chat every N requests (0 = always the same one)
    updateEvery: 3,   // AI replies between summary requests
    holdBack: 2,      // newest AI replies left out until newer ones come (they may be redone)
    foldEvery: 9,     // AI replies between story & character updates
    chapterSize: 15,  // AI replies per chapter
    parallel: 1,      // summary requests that may run at the same time
    injectEvery: 3,   // attach memory to every Nth message (0 = never)
    detail: 'detailed', // how long summaries and entries are: standard | detailed | maximum
    logAttach: 15,    // detailed reply summaries attached to each message
    injectBudget: 16000, // most characters attached to one message
    pinMemory: true,  // keep the newest message carrying the memory pinned
    memoryMessage: true, // keep the memory in that pinned message, edited in place
    hideHelpers: true, // leave Story Manager's helper chats out of MiniApps' chat lists
    autoEnable: true, // manage new chats automatically
    newFormat: 'facts', // memory format for new stories: 'facts' or 'classic'
    threadsShown: 'records', // Open Threads in the pinned message: 'records' (built from the goals) or 'keeper' (the keeper's own text)
    momentsShown: 'important', // key moments in the pinned message: 'important' or 'all'
    blockSounds: true, // keep MiniApps' own sounds from taking the phone's audio
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
      format: settings.newFormat === 'classic' ? 'classic' : 'facts', // saved older stories say 'classic'
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
      // Stories saved before the facts format existed stay classic until switched.
      const chat = chats[id] = Object.assign(newChat(id), { version: 0, format: 'classic' }, saved);
      // What it holds as stored: only a real change after this counts as newer.
      if (!chat.contentKey) chat.contentKey = contentKey(chat);
      if (chat.version < 3) await migrate(chat);
      // Stories saved by older versions get the current cleaning rules too.
      if (tidy(chat).length) await saveChat(chat);
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

  // fromSync: the chat was just loaded from the sync gist (not a local change).
  // What the memory holds (not when or where it was last looked at): a save
  // that changes none of it is not a newer version, so a device with an old
  // copy open cannot win the sync just by tidying or checking it.
  function contentKey(chat) {
    return hashText(JSON.stringify([chat.format, chat.memory, chat.pinned, chat.enabled, chat.title, chat.ignored, chat.chapters,
      chat.log.map((e) => [e.id, e.text, e.facts, e.records, e.folded, e.chapter, e.nofacts]),
      factsMode(chat) ? null : (chat.entries || []).map((e) => [e.name, e.kind, e.aliases, e.text, e.always]),
      chat.manualRecords, chat.hiddenRecords, chat.portraits, chat.keptMoments, chat.relMap, chat.reconRecords, chat.secretAlias, chat.commitReg, chat.commitAlias, chat.sortings, chat.commitChecked, chat.commitTier, chat.commitTierV2]));
  }

  async function saveChat(chat, fromSync) {
    const key = contentKey(chat);
    if (fromSync) chat.contentKey = key; // as loaded from the other device: not a change made here
    else if (key !== chat.contentKey) {
      chat.contentKey = key;
      chat.changedAt = Date.now();
      // Which versions of Story Manager worked on this story, oldest first.
      const vs = chat.smVersions || (chat.smVersions = []);
      if (SM_VERSION && (!vs.length || vs[vs.length - 1].v !== SM_VERSION)) {
        vs.push({ v: SM_VERSION, at: Date.now() });
        if (vs.length > 30) vs.splice(0, vs.length - 30);
      }
    }
    // The facts format: the entries are built from the records, every time.
    if (factsMode(chat)) {
      const built = buildEntries(chat);
      // While some summaries still have no records (just switched), the
      // previous characters fill in for anyone not built from facts yet.
      if (chat.classicEntries && chat.log.some((e) => e.needsRecords && !e.records)) {
        for (const c of chat.classicEntries) if (!built.some((b) => b.name.toLowerCase() === c.name.toLowerCase() || sameButTitle(b.name, c.name))) built.push(Object.assign({}, c, { aliases: (c.aliases || []).slice(), fromClassic: true }));
      }
      chat.entries = built;
    }
    await Store.set('chat:' + chat.id, chat);
    try { refreshAgo(); } catch (e) { /* the panel is not set up yet */ } // "updated … ago" shows the new time at once
    publishInjectMap();
    if (!fromSync) scheduleSync();
    schedulePinned(chat);
  }

  // The pinned memory message always follows the memory: whatever changed it
  // (an update, a tidy-up, an edit, Undo, a sync from another device), the
  // message is rewritten soon after, once no update is running.
  const pinnedTimers = {};
  function schedulePinned(chat, delay = 4000) {
    if (!chat.pinnedMemoryId || !settings.memoryMessage || !settings.pinMemory) return;
    clearTimeout(pinnedTimers[chat.id]);
    pinnedTimers[chat.id] = setTimeout(() => {
      if (busy[chat.id]) { schedulePinned(chat, 10000); return; }
      // Not while the page is still starting (MiniApps may still be logging in).
      if (performance.now() < 15000 * TIME_SCALE) { schedulePinned(chat, 5000); return; }
      refreshMemoryMessage(chat).catch(() => {});
    }, delay * TIME_SCALE);
  }

  // ---------------------------------------------------------------------------
  // Sync between devices: each chat's memory is kept in a private GitHub Gist
  // ("Story Manager sync", one file per chat). Changes are saved there a few
  // seconds after they happen; every couple of minutes, and when a chat is
  // opened, newer copies from other devices are loaded. The newest copy wins.
  // ---------------------------------------------------------------------------

  const GIST_DESC = 'Story Manager sync (private; memory of your MiniApps chats)';
  const sync = { state: 'off', at: 0, error: '', timer: null, running: null };

  function gh(method, path, body) {
    return requestJSON(method, 'https://api.github.com' + path, {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + settings.githubToken.trim(),
      'Content-Type': 'application/json',
    }, body);
  }

  async function syncGist() {
    if (settings.gistId) return settings.gistId;
    for (let page = 1; page <= 5; page++) {
      const list = await gh('GET', '/gists?per_page=100&page=' + page);
      const found = (list || []).find((g) => g && g.description === GIST_DESC);
      if (found) { settings.gistId = found.id; break; }
      if (!list || list.length < 100) break;
    }
    if (!settings.gistId) {
      const made = await gh('POST', '/gists', { description: GIST_DESC, public: false,
        files: { 'README.md': { content: 'Saved by the Story Manager userscript so its memories are the same on all your devices. Do not edit by hand.' } } });
      settings.gistId = made.id;
    }
    await Store.set('settings', settings);
    return settings.gistId;
  }


  // Settings that follow the user between devices (the memory keeper and how
  // it works). The GitHub token, the button position and API keys stay on
  // each device.
  const SHARED_SETTINGS = ['provider', 'model', 'miniappsSlug', 'detail', 'holdBack', 'updateEvery', 'foldEvery', 'chapterSize', 'parallel', 'helperRotate',
    'injectEvery', 'injectBudget', 'logAttach', 'pinMemory', 'memoryMessage', 'hideHelpers', 'autoEnable', 'newFormat', 'blockSounds', 'momentsShown', 'threadsShown'];
  function sharedSettings() {
    const v = {};
    for (const k of SHARED_SETTINGS) if (settings[k] !== undefined) v[k] = settings[k];
    return v;
  }

  function scheduleSync() {
    if (!settings.githubToken || !settings.githubToken.trim()) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(() => runSync().catch(() => {}), 8000 * TIME_SCALE);
  }

  // Loads newer chats from the gist, then saves chats changed here.
  async function runSync() {
    if (storageFailed) return; // saved data could not be read: never upload or load over it
    if (!settings.githubToken || !settings.githubToken.trim()) { sync.state = 'off'; return; }
    if (sync.running) return sync.running;
    sync.running = (async () => {
      try {
        let id = await syncGist();
        let gist;
        try {
          gist = await gh('GET', '/gists/' + id);
        } catch (e) {
          if (!/HTTP 404/.test(String(e.message))) throw e;
          settings.gistId = '';          // deleted on GitHub: make a new one
          id = await syncGist();
          gist = await gh('GET', '/gists/' + id);
        }
        // A big gist comes with some files' content cut off or missing (GitHub
        // limits the total): those are read from raw_url instead.
        const readFile = async (f) => (f.truncated || !f.content) && f.raw_url ? requestJSON('GET', f.raw_url, {}, undefined) : JSON.parse(f.content);
        const remote = {};
        for (const [name, f] of Object.entries(gist.files || {})) {
          const m = name.match(/^chat-([0-9a-f-]+)\.json$/i);
          if (!m) continue;
          // Big files come without their content: it is read from raw_url.
          try { remote[m[1]] = await readFile(f); } catch (e) { /* unreadable: skip */ }
        }
        // Helper chats from every device, so all of them stay hidden everywhere.
        let remoteHelpers = [];
        try { remoteHelpers = gist.files['helpers.json'] ? (await readFile(gist.files['helpers.json'])) || [] : []; } catch (e) { /* ignore */ }
        let remoteNot = [];
        try { remoteNot = gist.files['not-helpers.json'] ? (await readFile(gist.files['not-helpers.json'])) || [] : []; } catch (e) { /* ignore */ }
        for (const h of remoteNot) if (typeof h === 'string' && !notHelpers.includes(h)) await notHelper(h);
        for (const h of remoteHelpers) if (typeof h === 'string' && !helperAll.includes(h)) rememberHelper(h);
        // Settings: the newest saved settings, from whichever device.
        let remoteSettings = null;
        try { remoteSettings = gist.files['settings.json'] ? await readFile(gist.files['settings.json']) : null; } catch (e) { /* ignore */ }
        sync.remoteSettings = remoteSettings ? { at: remoteSettings.at || 0, keeper: remoteSettings.values ? (remoteSettings.values.provider === 'miniapps' ? remoteSettings.values.miniappsSlug : remoteSettings.values.provider) : '?' } : null;
        let settingsLoaded = false;
        if (remoteSettings && remoteSettings.values && (remoteSettings.at || 0) > (settings.settingsAt || 0)) {
          for (const k of SHARED_SETTINGS) if (remoteSettings.values[k] !== undefined) settings[k] = remoteSettings.values[k];
          settings.settingsAt = remoteSettings.at;
          await Store.set('settings', settings);
          toolCache = null;
          publishSounds();
          settingsLoaded = true;
        }
        // Newer on GitHub: load it (unless the memory is being updated here).
        let loaded = 0;
        for (const [cid, r] of Object.entries(remote)) {
          if (!r || !r.id || busy[cid]) continue;
          const local = await getChat(cid, false);
          // The newest real change wins (a device that only looked at or tidied
          // an old copy has not changed it, so it cannot win: see contentKey).
          if (local && (local.changedAt || 0) >= (r.changedAt || 0)) continue;
          // Updated in place, so an open panel keeps working on the same chat.
          const fresh = Object.assign(newChat(cid), { format: 'classic' }, r, { id: cid, syncedAt: r.changedAt || 0 });
          if (chats[cid]) { for (const k of Object.keys(chats[cid])) delete chats[cid][k]; Object.assign(chats[cid], fresh); } else chats[cid] = fresh;
          if (!chatIndex.includes(cid)) { chatIndex.push(cid); await Store.set('chatIndex', chatIndex); }
          await saveChat(chats[cid], true);
          loaded++;
        }
        // Changed here since the last save to GitHub: save them.
        const files = {};
        for (const cid of chatIndex) {
          const c = chats[cid] || await getChat(cid, false);
          if (!c || busy[cid] || (c.changedAt || 0) <= (c.syncedAt || 0)) continue;
          const r = remote[cid];
          if (r && (r.changedAt || 0) > (c.changedAt || 0)) continue;
          files['chat-' + cid + '.json'] = { content: JSON.stringify(Object.assign({}, c, { syncedAt: undefined })) };
        }
        if (helperAll.some((h) => !remoteHelpers.includes(h)) || remoteHelpers.some((h) => notHelpers.includes(h))) files['helpers.json'] = { content: JSON.stringify(helperAll) };
        if (notHelpers.some((h) => !remoteNot.includes(h))) files['not-helpers.json'] = { content: JSON.stringify(notHelpers) };
        if ((settings.settingsAt || 0) > ((remoteSettings && remoteSettings.at) || 0)) files['settings.json'] = { content: JSON.stringify({ at: settings.settingsAt, values: sharedSettings() }) };
        const names = Object.keys(files).filter((n) => /^chat-/.test(n));
        if (Object.keys(files).length) {
          await gh('PATCH', '/gists/' + id, { files });
          if (files['settings.json']) sync.remoteSettings = { at: settings.settingsAt, keeper: settings.provider === 'miniapps' ? settings.miniappsSlug : settings.provider };
          for (const n of names) {
            const c = chats[n.slice(5, -5)];
            if (c) { c.syncedAt = c.changedAt; await Store.set('chat:' + c.id, c); }
          }
        }
        sync.state = 'ok';
        sync.at = Date.now();
        sync.error = '';
        if (loaded) { if (currentId && remote[currentId]) toast('Loaded the newer memory from your other device'); renderPanel(); }
        // Redrawn at once, so the Settings form shows them (and cannot save the old values back).
        if (settingsLoaded) { toast('Loaded your settings from your other device'); renderPanel(true); }
      } catch (e) {
        sync.state = 'error';
        sync.error = String(e.message || e).slice(0, 200);
      } finally {
        sync.running = null;
      }
    })();
    return sync.running;
  }
  setInterval(() => { if (!anyBusy()) runSync().catch(() => {}); }, 120000);

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
  // The newest chapters are in the pinned message in full; older ones short.
  const FULL_CHAPTERS = 8;
  const SHORTEN_PER_UPDATE = 6;
  // The keeper's format lines ("=== CHAPTER: … ===", "=== CAST === …") are not
  // part of a chapter: taken out when it is written, and from older ones here.
  function cleanChapterText(t) {
    return String(t || '').replace(/\n?[^\S\n]*=+[^\S\n]*CAST\b[\s\S]*$/i, '')
      // A bare list of names (the cast written without its heading) on its own line.
      .replace(/^[^\S\n]*(?:[A-Z\u00C0-\u024F\uAC00-\uD7A3][\p{L}'’-]*(?: [A-Z][\p{L}'’-]*)?\s*,\s*){2,}[A-Z\u00C0-\u024F\uAC00-\uD7A3][\p{L}'’-]*(?: [A-Z][\p{L}'’-]*)?\.?[^\S\n]*$/gmu, '').replace(/^[^\S\n]*[*#_]*[^\S\n]*=+[^\S\n]*CHAPTER\b[^=\n]*=+[^\S\n]*/gim, '').trim();
  }
  function chaptersText(chat, budget) {
    const lines = [];
    let size = 0;
    // A chapter that tells the same events as one of the two before it (a
    // rebuild can write one twice) is left out of the pinned message.
    const sig = chat.chapters.map((c) => sigWords(cleanChapterText(c.short || c.text)));
    const repeat = (i) => [i - 1, i - 2].some((j) => { if (j < 0) return false; const a = sig[i], b = sig[j]; if (a.size < 8 || b.size < 8) return false; let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.min(a.size, b.size) >= 0.7; });
    for (let i = chat.chapters.length - 1; i >= 0; i--) {
      const c = chat.chapters[i];
      if (settings.momentsShown !== 'all' && repeat(i)) continue;
      // Older chapters: their short version (the full one stays stored).
      const old = c.short && i < chat.chapters.length - FULL_CHAPTERS && settings.momentsShown !== 'all';
      const full = 'Chapter ' + (i + 1) + ': ' + c.title + '\n' + cleanChapterText(old ? c.short : c.text);
      const short = 'Chapter ' + (i + 1) + ': ' + c.title;
      const t = size + full.length <= budget ? full : short;
      lines.unshift(t);
      size += t.length + 2;
    }
    return lines.join('\n\n');
  }

  function buildPlan(chat, size) {
    if (factsMode(chat)) return buildFactsPlan(chat, size);
    const head = [];
    const budget = size || Math.max(2000, Number(settings.injectBudget) || DEFAULT_SETTINGS.injectBudget);
    if (chat.pinned.trim()) head.push('## Must remember\n' + chat.pinned.trim());
    if (chat.chapters.length) head.push('## The story so far, chapter by chapter\n' + chaptersText(chat, Math.round(budget * 0.3)));
    if (chat.memory.trim()) head.push('## The story now\n' + chat.memory.trim());
    const inPlay = new Set(entriesInPlay(chat));
    // A slimmed-down entry (made with "Slim down") is what the AI reads; the full one stays here.
    const pack = (e) => ({ name: e.name, kind: e.kind || '', keys: entryKeys(e), text: e.slim && e.slim.text ? e.slim.text : e.text });
    const plan = {
      prefix: MEM_START + '\n(Background notes for story continuity. Use them silently; do not quote, mention or reply to them.)\n\n',
      suffix: '\n' + MEM_END,
      head: head.join('\n\n'),
      // With no size limit (the pinned memory message) every entry goes in, in full.
      core: chat.entries.filter((e) => size === Infinity || inPlay.has(e)).map(pack),
      extra: chat.entries.filter((e) => size !== Infinity && !inPlay.has(e)).map(pack),
      // Everything since the last chapter (or at least the newest logAttach),
      // newest first as far as the space allows.
      log: chat.log.slice(-Math.max(Math.max(0, Number(settings.logAttach) || 0), chat.log.filter((e) => e.chapter == null).length))
        .map((e) => e.text),
      budget,
    };
    return plan.head || plan.core.length || plan.extra.length || plan.log.length ? plan : null;
  }

  // The facts format's layout: Must remember → Now → Characters, places &
  // things (main characters first) → World → Story moments → History,
  // chapter by chapter → Recent events.
  // "Story moments": one list for the whole story in place of each
  // character's key moments. The newest STORY_MAJOR major moments (turning
  // points count as major), STORY_MINOR minor and STORY_ROUTINE routine ones,
  // plus each character's newest major moment so no one is left without one.
  // The same event under several people is listed once, with all their names.
  const STORY_MAJOR = 40, STORY_MINOR = 15, STORY_ROUTINE = 5;
  function storyMoments(chat) {
    const skip = new Set((chat.ignored || []).map((n) => n.toLowerCase()));
    const recs = allRecords(chat).filter((r) => r.k === 'moment' && r.s && !skip.has(r.s.toLowerCase()) && !PLACEHOLDER_SUBJECT_RE.test(r.s.trim()));
    const tiered = recs.some((r) => r.tier || r.imp);
    const kept = chat.keptMoments || [];
    const tierOf = (r) => (r.manual || kept.includes(r.id) || r.tier === 'turning' || r.imp ? 'major'
      : tiered ? (r.tier === 'major' ? 'major' : r.tier || 'minor') : (BIG_MOMENT_RE.test(r.v) ? 'major' : 'minor'));
    const list = [];
    for (const r of recs) {
      const w = sigWords(r.v);
      const twin = list.find((m) => m.at === r.at && (() => { let n = 0; for (const a of w) if (m.w.has(a)) n++; return n >= 2 && n / Math.min(w.size, m.w.size || 1) >= 0.5; })());
      const t = tierOf(r);
      if (twin) {
        if (!twin.who.some((x) => x.toLowerCase() === r.s.toLowerCase())) twin.who.push(r.s);
        if (r.v.length > twin.v.length) { twin.v = r.v; twin.w = w; }
        if (['major', 'minor', 'routine'].indexOf(t) < ['major', 'minor', 'routine'].indexOf(twin.t)) twin.t = t;
      } else list.push({ at: r.at, v: r.v, w, who: [r.s], t });
    }
    const order = (a, b) => (a.at === Infinity ? 1e9 : a.at) - (b.at === Infinity ? 1e9 : b.at);
    list.sort(order);
    const pick = new Set();
    const newest = (t, n) => list.filter((m) => m.t === t).slice(-n).forEach((m) => pick.add(m));
    newest('major', STORY_MAJOR); newest('minor', STORY_MINOR); newest('routine', STORY_ROUTINE);
    const covered = new Set();
    for (const m of pick) for (const n of m.who) covered.add(n.toLowerCase());
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.t !== 'major' || pick.has(m)) continue;
      if (m.who.some((n) => !covered.has(n.toLowerCase()))) { pick.add(m); for (const n of m.who) covered.add(n.toLowerCase()); }
    }
    const shown = list.filter((m) => pick.has(m));
    return { left: list.length - shown.length, lines: shown.map((m) => '- ' + (m.at !== Infinity ? '(reply ' + m.at + ') ' : '') + m.who.join(', ') + ': ' + m.v) };
  }
  // A section the keeper kept adding to: the same point said again in other
  // words is kept once (the first, which is the keeper's newest wording), and
  // in the world only the first "Time:" line (older times are out of date).
  function tidyBullets(text, world) {
    const lines = String(text || '').split('\n');
    const kept = [];
    const seen = [];
    let time = false;
    for (const l of lines) {
      const b = l.match(/^\s*[-*•]\s+(.*)$/);
      if (!b) { kept.push(l); continue; }
      if (world && /^\**\s*(time|date|when)\s*\**\s*:/i.test(b[1])) { if (time) continue; time = true; }
      const w = sigWords(b[1]);
      if (w.size >= 3 && seen.some((o) => { let n = 0; for (const a of w) if (o.has(a)) n++; return n / Math.min(w.size, o.size) >= 0.7; })) continue;
      seen.push(w);
      kept.push(l);
    }
    return kept.join('\n');
  }
  function buildFactsPlan(chat, size) {
    const budget = size || Math.max(2000, Number(settings.injectBudget) || DEFAULT_SETTINGS.injectBudget);
    const head = [];
    if (chat.pinned.trim()) head.push('## Must remember\n' + chat.pinned.trim());
    const commits = factsMode(chat) ? commitState(chat) : null;
    const threads = (t) => commits && settings.threadsShown !== 'keeper' ? commits.openThreads(t) : tidyBullets(t).split('\n').filter((l) => !(commits && /^\s*[-*•]\s/.test(l) && commits.closedThread(l))).join('\n');
    const now = ['Current Scene', 'Open Threads'].map((t) => [t, t === 'Open Threads' ? threads(sectionOf(chat.memory, t).trim()) : sectionOf(chat.memory, t).trim()]).filter(([, x]) => x);
    // Any other section the keeper wrote (except the world) belongs to "now" too.
    const others = (chat.memory.match(/^##\s*(.+?)\s*$/gm) || []).map((h) => h.replace(/^##\s*/, '').trim())
      .filter((t) => !/^(current scene|open threads|world & timeline|story so far)$/i.test(t)).map((t) => [t, sectionOf(chat.memory, t).trim()]).filter(([, x]) => x);
    if (now.length || others.length) head.push('## Now\n' + now.concat(others).map(([t, x]) => '### ' + t + '\n' + x).join('\n\n'));
    // Right after "Now": so a character never knows what they should not.
    const secrets = secretsText(chat);
    if (secrets) head.push('## Who knows what\n(Characters only know the secrets listed for them; never let anyone act on a secret they do not know.)\n' + secrets);
    const tail = [];
    let world = tidyBullets(sectionOf(chat.memory, 'World & Timeline').trim(), true);
    // The keeper's old "Turning points:" list is left out: the story moments replace it.
    if (settings.momentsShown !== 'all') {
      world = world.replace(/\n*\**turning points:?\**[\s\S]*$/i, '').trim();
      if (world) tail.push('## World\n' + world);
      const sm = storyMoments(chat);
      if (sm.lines.length) tail.push('## Story moments (oldest first)\n' + (sm.left ? '(' + sm.left + ' older moments are left out here; History covers them.)\n' : '') + sm.lines.join('\n'));
    } else if (world) tail.push('## World & Timeline\n' + world);
    if (chat.chapters.length) tail.push('## History, chapter by chapter\n' + chaptersText(chat, Math.round(budget * 0.3)));
    const inPlay = new Set(entriesInPlay(chat));
    const main = new Set(mainCharacters(chat));
    const order = chat.entries.slice().sort((a, b) => (main.has(b) - main.has(a)) || ((a.kind || 'character') === 'character' ? 0 : 1) - ((b.kind || 'character') === 'character' ? 0 : 1) || (b.records || 0) - (a.records || 0));
    // The pinned message's shorter versions (the full entries stay stored):
    // main characters and anyone in the current scene get the pinned version,
    // other characters only their few lines (unless "All" is chosen in Settings).
    const pinnedText = (e) => {
      if (settings.momentsShown === 'all') return e.text;
      if (!main.has(e) && !inPlay.has(e) && e.miniText) return e.miniText;
      // (An empty pinned version — e.g. only unsorted facts — means nothing to show.)
      return e.pinText != null ? e.pinText : e.text;
    };
    const pack = (e) => ({ name: e.name, kind: e.kind || '', keys: entryKeys(e), text: pinnedText(e) });
    const plan = {
      prefix: MEM_START + '\n(Background notes for story continuity. Use them silently; do not quote, mention or reply to them.)\n\n',
      suffix: '\n' + MEM_END,
      head: head.join('\n\n'),
      tail: tail.join('\n\n'),
      charTitle: 'Characters, places & things',
      core: order.filter((e) => size === Infinity || inPlay.has(e)).map(pack).filter((x) => x.text.trim()),
      extra: order.filter((e) => size !== Infinity && !inPlay.has(e)).map(pack).filter((x) => x.text.trim()),
      log: chat.log.slice(-Math.max(Math.max(0, Number(settings.logAttach) || 0), chat.log.filter((e) => e.chapter == null).length)).map((e) => e.text),
      budget,
    };
    return plan.head || plan.tail || plan.core.length || plan.extra.length || plan.log.length ? plan : null;
  }

  function publishInjectMap() {
    const map = {};
    const every = Number(settings.injectEvery) || 0;
    for (const id of Object.keys(chats)) {
      const c = chats[id];
      if (!c.enabled || memoryInMessage(c)) continue;
      // No pinned memory message (none yet, or it was deleted when the user went
      // back): the very next message carries the memory, so it can be pinned,
      // whatever "attach the memory every N messages" says.
      const needsPin = settings.memoryMessage && settings.pinMemory && !c.pinnedMemoryId;
      if (!needsPin) {
        if (!(every > 0)) continue;
        if (c.sentSinceInject > 0 && c.sentSinceInject < every) continue;
      }
      {
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

  // Every version of every message seen per chat (regenerated replies
  // included), for the count of all versions.
  const versionsSeen = {};

  function extractMessages(data) {
    const arr = findMessageArray(data);
    for (const m of arr) {
      if (!m || !m.id || !m.conversationId) continue;
      const cid = String(m.conversationId).toLowerCase();
      (versionsSeen[cid] = versionsSeen[cid] || new Set()).add(String(m.id));
    }
    const out = arr.filter(looksLikeMessage).map((m) => ({
      id: String(m.id || m._id || m.chatMessageId || m.uuid || ('h-' + roleOf(m) + '-' + hashText(textOf(m)))),
      role: roleOf(m),
      text: ownText(textOf(m)),
      t: Date.parse(m.createdAt || m.created_at || '') || 0,
      index: typeof m.index === 'number' ? m.index : null,
      version: typeof m.version === 'number' ? m.version : 0,
    })).filter((m) => m.role !== 'system' && m.text);
    if (out.length > 1 && out.every((m) => m.t)) out.sort((a, b) => a.t - b.t);
    return latestVersions(out);
  }

  // MiniApps lists every version of a regenerated (or re-edited) message at
  // the same index, each with its own version number; only the newest is part
  // of the story. The index can start again within a chat, so messages that
  // share an index but not a version history (same version) are all kept.
  function latestVersions(msgs) {
    // In time order, a higher version replaces the most recent earlier message
    // with the same index and role (the one it is a new version of).
    const order = msgs.slice().sort((a, b) => (a.t || 0) - (b.t || 0));
    const drop = new Set();
    const kept = [];
    for (const m of order) {
      if (m.index != null && m.version > 0) {
        for (let i = kept.length - 1; i >= 0; i--) {
          const k = kept[i];
          if (k.index === m.index && k.role === m.role && k.version < m.version) { drop.add(k); kept.splice(i, 1); break; }
        }
      }
      kept.push(m);
    }
    return msgs.filter((m) => !drop.has(m));
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

  // Tests can make every wait shorter (smx:timeScale in the page's storage).
  const TIME_SCALE = (() => { try { return Math.min(1, Math.max(0.05, Number(localStorage.getItem('smx:timeScale')) || 1)); } catch (e) { return 1; } })();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms * TIME_SCALE));

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

  // Memory-keeper requests may take long on a local model (Ollama on a home PC): up to 15 minutes.
  function postJSON(url, headers, body) {
    return requestJSON('POST', url, headers, body, 900000);
  }

  async function requestJSON(method, url, headers, body, timeout = 180000) {
    const gm = gmRequest();
    let res;
    if (gm) {
      res = await new Promise((resolve, reject) => {
        gm({
          method, url, headers, data: body === undefined ? undefined : JSON.stringify(body), timeout,
          onload: (r) => resolve({ status: r.status, text: r.responseText }),
          onerror: () => reject(new Error('Network error contacting ' + new URL(url).hostname)),
          ontimeout: () => reject(new Error('Timed out contacting ' + new URL(url).hostname)),
        });
      });
    } else {
      const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
  // While bots are being compared, every keeper request goes to the bot under
  // test (in its own helper chat), and its raw answer is kept for the report.
  const compare = { slug: null, slot: 0, raw: null, running: false };
  async function callLLM(system, user, slot = 0) {
    const out = compare.slug ? await callMiniApps(system + '\n\n' + user, compare.slot) : await callLLMWith(system, user, slot);
    if (compare.raw) compare.raw.push(String(out || ''));
    return out;
  }

  async function callLLMWith(system, user, slot = 0) {
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
  const helperTag = [];    // slot -> { chat, pos } of the latest answer
  const helperKey = (slot) => (slot ? 'helperChat' + slot : 'helperChat');

  // Every helper chat ever used (also old ones after a fresh one was started),
  // so they stay hidden from MiniApps' chat lists.
  let helperAll = [];
  function rememberHelper(cid) {
    if (notHelpers.includes(cid)) return;
    helperIds.add(cid);
    if (location.href.toLowerCase().indexOf(cid) >= 0) setTimeout(() => renderPanel(true), 0);
    if (!helperAll.includes(cid)) { helperAll.push(cid); Store.set('helperAll', helperAll); scheduleSync(); }
    publishHidden();
  }
  const helperRequests = []; // request ids of Story Manager's own messages, hidden before their chat is known
  // The user says a chat is theirs, not a helper chat: forget it everywhere.
  async function notHelper(cid) {
    helperIds.delete(cid);
    helperAll = helperAll.filter((h) => h !== cid);
    await Store.set('helperAll', helperAll);
    for (let slot = 0; slot < helperChats.length; slot++) {
      if (helperChats[slot] && helperChats[slot].id === cid) { helperChats[slot] = null; await Store.set(helperKey(slot), null); }
    }
    notHelpers = [...new Set(notHelpers.concat(cid))];
    await Store.set('notHelpers', notHelpers);
    publishHidden();
    scheduleSync();
  }
  let notHelpers = []; // chats the user said are theirs (synced, so other devices forget them too)

  // The page part reads this at once when the page loads (before the
  // script's own storage is ready), and hears changes as an event.
  function publishSounds() {
    const v = settings.blockSounds === false ? '0' : '1';
    try { localStorage.setItem('smx:blockSounds', v); } catch (e) { /* private mode etc. */ }
    document.dispatchEvent(new CustomEvent('smx:sounds', { detail: v }));
  }

  function publishHidden() {
    const ids = settings.hideHelpers === false ? [] : [...new Set(helperAll.concat([...helperIds], helperRequests))].filter((h) => !notHelpers.includes(h));
    document.dispatchEvent(new CustomEvent('smx:hide', { detail: JSON.stringify(ids) }));
    if (document.documentElement) document.documentElement.setAttribute('data-smx-hide', JSON.stringify(ids));
    try { localStorage.setItem('smx:hide', JSON.stringify(ids)); } catch (e) { /* private mode etc. */ }
  }
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
    const slug = (compare.slug || settings.miniappsSlug || 'claude-37').trim();
    if (!toolCache || toolCache.slug !== slug) {
      const tool = await rpc('GET', '/tools/s/' + encodeURIComponent(slug) + '?lang=en');
      if (!tool || !tool.id) throw new Error('MiniApps bot "' + slug + '" not found');
      toolCache = {
        slug,
        id: tool.id,
        revision: tool.revision || 1,
        modelId: tool.modelId || (tool.model && tool.model.id) || tool.defaultModelId || '',
      };
      // A bot without a model of its own uses MiniApps' default for it (as the site does).
      if (!toolCache.modelId) {
        try {
          const d = await rpc('GET', '/ai-models/defaults/by-tool/' + encodeURIComponent(tool.id) + '?revision=' + encodeURIComponent(toolCache.revision));
          toolCache.modelId = (d && d.model && (d.model.id || (typeof d.model === 'string' ? d.model : ''))) || (d && d.modelId) || '';
        } catch (e) { /* tried below without one */ }
      }
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
    helperRequests.push(body.requestId.toLowerCase());
    if (helperRequests.length > 50) helperRequests.shift();
    Store.set('helperRequests', helperRequests);
    publishHidden();
    const rotate = Number(settings.helperRotate) || 0;
    let reuse = !!(helperChat && helperChat.slug === slug && !(rotate && helperChat.uses >= rotate));
    // With the same bot as one of the user's stories, asking MiniApps for a
    // new chat can hand back the user's own (new) story chat. So never start a
    // new helper chat then: keep using an existing one, or stop.
    const storyBot = Object.values(chats).some((c) => c.tool && c.tool.toolId === toolCache.id && !helperIds.has(c.id));
    if (!reuse && storyBot) {
      const existing = helperChats.find((h) => h && h.slug === slug);
      if (!existing) {
        publishHidden();
        throw new Error('The memory-keeper bot "' + slug + '" is the bot you write stories with, so Story Manager will not start a chat with it ' +
          '(MiniApps could hand back one of your stories). Pick a different bot in Settings → MiniApps bot.');
      }
      helperChats[slot] = existing;
      reuse = true;
    }
    const usedChat = helperChats[slot];
    if (reuse) body.conversationId = usedChat.id;
    // Messages already in the helper chat are not the answer. (The request
    // itself may not be readable: MiniApps can store long messages as files.)
    const before = new Set();
    if (reuse) {
      try { (await fetchMessages(usedChat.id, { cache: false, mode: 'latest' })).forEach((m) => before.add(m.id)); } catch (e) { /* see below */ }
      if (seenMsgs[usedChat.id]) for (const k of seenMsgs[usedChat.id].keys()) before.add(k);
    }
    let res;
    // Everything the bot sends from here on belongs to this request.
    let sentAt = Date.now();
    if (!reuse) document.dispatchEvent(new CustomEvent('smx:hold'));
    try {
      res = await rpc('POST', '/chat', body);
    } catch (e) {
      if (!reuse) { publishHidden(); throw e; }
      if (storyBot) {
        helperChats[slot] = null;
        await Store.set(helperKey(slot), null);
        throw new Error('The helper chat is gone, and the memory-keeper bot "' + slug + '" is the bot you write stories with, so Story Manager will not start a new chat with it. Pick a different bot in Settings → MiniApps bot.');
      }
      // The helper chat is gone (e.g. deleted); start a new one.
      delete body.conversationId;
      reuse = false;
      before.clear();
      document.dispatchEvent(new CustomEvent('smx:hold'));
      sentAt = Date.now();
      try { res = await rpc('POST', '/chat', body); } catch (e2) { publishHidden(); throw e2; }
    }
    const cid = res && res.conversationId;
    if (!cid) throw new Error('MiniApps did not start a conversation');
    // A new chat starts with our request (maybe after a greeting). If MiniApps
    // put it into a chat that already had messages (e.g. a chat the user just
    // started with the same bot), that chat is the user's, not a helper chat.
    if (!reuse) {
      // Read the chat: a new one holds only what this request added (and
      // maybe a greeting). Message numbers are not used: they can start again.
      const added = new Set((Array.isArray(res.addedMessages) ? res.addedMessages : []).map((m) => m && String(m.id)).concat(String(res.chatMessageId || '')));
      let others = 0;
      try { others = (await fetchMessages(cid, { cache: false, mode: 'latest' })).filter((m) => !added.has(m.id)).length; } catch (e) { /* unknown: trust it */ }
      const known = chats[String(cid).toLowerCase()];
      if (others > 1 || (known && (known.log.length || known.processedIds.length))) {
        rpc('POST', '/chat/abort', { conversationId: cid, requestId: body.requestId }).catch(() => {});
        publishHidden();
        const err = new Error('MiniApps put the memory keeper\'s request into one of your chats (' + String(cid).slice(0, 8) +
          ') instead of a new one. It was stopped; you can delete that request from the chat. Using a different bot as the memory keeper (Settings) avoids this.');
        err.botError = true;
        throw err;
      }
    }
    rememberHelper(cid);
    helperChats[slot] = reuse && cid === usedChat.id ? Object.assign({}, usedChat, { uses: usedChat.uses + 1 }) : { slug, id: cid, uses: 1 };
    // Which helper chat answered, and how many requests it had seen: to measure
    // whether the keeper gets worse the longer a helper chat runs.
    helperTag[slot] = { chat: String(cid).slice(0, 8), pos: helperChats[slot].uses };
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
      const streamed = st && st.at >= sentAt ? st.text : '';
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
      if (ce && ce.at >= sentAt) {
        const err = new Error('The MiniApps bot reported an error' + (ce.error ? ': ' + ce.error : '') + (ce.code ? ' (' + ce.code + ')' : '') + '.');
        // A fresh chat doesn't help when the request itself is too long.
        err.botError = !TOO_LONG_RE.test(ce.error || '');
        throw err;
      }
      let msgs = [];
      let readOk = true;
      try { msgs = await fetchMessages(cid, { cache: false, mode: 'latest' }); } catch (e) { readOk = false; }
      // Whole messages pushed over the live connection count too.
      if (seenMsgs[cid]) msgs = mergeMsgs(msgs, [...seenMsgs[cid].values()]).filter((m) => !deletedMsgs.has(m.id));
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

  // The FACTS part of a summary in the facts format: one record per line.
  const RECORD_RULES = [
    '- After each summary write FACTS: and then, one per line, the lasting facts this reply revealed or changed, as records: "- Subject | kind | fact".',
    '  Subject: the exact name of the person, place or item the fact is about (one record per subject; never a pronoun or "unnie"/"oppa").',
    '  Kind: one of full name, age, role, type (character/place/item/group), status, location, appearance, personality, ability, likes, dislikes, boundary, backstory, ' +
      'relationship: <other person>, where things stand: <other person>, possession, promise, secret, knows, does not know, cover story, goal, scheduled, done, progress, postponed, cancelled, want, nickname, learned, believes, condition, major moment, minor moment, routine moment.',
    '  "where things stand: X" is the state of their relationship with X NOW (what changed, what each needs, what was promised) — never where they are or what they did in this scene.',
    '  "relationship: X" is a lasting fact about the two of them (dating, engaged, rivals, what they call each other), not a scene; a scene is a key moment. Outfits worn in a scene are not possessions.',
    '  Secrets: give each secret a short name in square brackets and use the same name every time. "- Person | secret | [short name] what the secret is" for whose secret it is;',
    '  "- Person | knows | [short name] how they found out" when someone learns, is told or overhears it; "- Person | does not know | [short name]" for someone it is kept from;',
    '  "- Everyone | knows | [short name]" when it comes out (e.g. confessed in the group chat); when someone is told or confesses it to someone, a knows record for each person who now knows; reuse the exact short name already used for that secret; "- Public | cover story | [short name] what others are told". Write these whenever this reply changes who knows.',
    '  A goal or promise is only an explicit commitment (a promise, an appointment, an order, a vow) or a stated intention (decided to, means to, sets out to). A wish, a hope, an interest or a figure of speech is "want" ("- Lena | want | to see the sea again"), never a goal.',
    '  "scheduled": something set for a later time (an appointment, a session, a date, a meeting), with a [short name] and when: "- Lena | scheduled | [council] council meeting on Thursday at noon". It has not happened yet: never a moment. When it happens, write "done" with its [short name]; moved: "postponed"; called off: "cancelled".',
    '  Give each goal, promise or scheduled event a level: "major goal" (matters for the whole story: a life goal, a quest, a vow, a mystery), "minor goal" (matters for a while: a date, plans for the coming days), "routine goal" (over within a scene: fetch a drink, go to class now) — e.g. "- Lena | major goal | [retake Varn] …". When unsure, minor.',
    '  A joke, a passing remark or a casual wish is never a goal; something already done when it is mentioned is a moment, not a goal.',
    '  A standing agreement, rule or signal between people (a code word, a house rule, how one will comfort the other) is not a goal: write it as "relationship: Other Person".',
    '  Goals and promises (a plan, a quest, a mission, a vow) get a short name in square brackets, like secrets: "- Person | goal | [short name] what they mean to do". Reuse the [short name] given in OPEN GOALS AND PROMISES when it is the same one.',
    '  What becomes of one, always with its [short name]: "done" only when it actually happened or was kept in this reply ("- Person | done | [short name] what happened"); "progress" for one step of it; "postponed" when it was moved to later; "cancelled" when it was dropped or broken. Planning, scheduling, agreeing to it, confirming it, being reminded of it or promising it again is NOT done (that is "progress", e.g. "progress | [visit] set for Thursday"); a part of it is "progress" too ("wrote three pages" of an essay to finish). Something someone did that completes no goal is a moment, never "done".',
    '  Times: write the story day or date ("the day of the tournament", "Saturday"), never "today", "tomorrow" or "tonight" (they are wrong a day later).',
    '  Moments (a short line saying what happened to or because of them in this reply) have three levels; choose one:',
    '  For a major moment, write what happened and, when the story shows a lasting change, what is different since: "quarrelled over the broken oath → since then he no longer trusts her with the watch (affects: Tomas & Lena)". Leave out the arrow part when nothing lasting changed.',
    '  "major moment": only when it changes something that lasts: a relationship starts, changes or ends, a secret comes out, a first time, a confession, a promise or vow, a fight or making up, a move, a big decision. Rare: most replies have none. Hugs, kisses, meals, teasing, coffee and dozing off are never major.',
    '  "minor moment": worth remembering but changes little (a date, a gift, a small plan, a meaningful talk).',
    '  Use all three moment levels: most everyday replies have routine moments.',
    '  "routine moment": everyday things (meals, chores, banter, sleeping, texts, an intimate scene with nothing new in it). Every reply has at least one moment for the main characters in it (minor or routine when nothing major happened).',
    '  A secret is something a character hides from someone in the story, always with what it is after its [short name]; an intimate scene is a key moment, not a secret.',
    '  "knows" is ONLY for a secret: it always starts with the secret\'s [short name]. Anything else someone found out or was told (not a secret) is "learned". Something that happened is a moment, never "knows".',
    '  "condition": a person\'s lasting condition until it changes (dead, badly wounded, missing, captured, pregnant, cursed), not a passing state.',
    '  When a secret is told to a group (a group chat, a council, a crew), write "knows" with the group as subject ("- The group chat | knows | [x] he posted it there"); "Everyone" only when the whole world knows.',
    '  In a RECAP reply, write facts only for what is new or corrected; never repeat facts about earlier events.',
    '  "believes": what a character thinks is true, which may be wrong ("- Lena | believes | [the king] the king is loyal"). Write what is really true as its own fact; never present a belief or a claim as true.',
    '  "where things stand: X" is how things are between them now, never what one of them did in the scene (that is a moment).',
    '  Only lasting facts: not where someone is, what they wear, or how they look or feel at this moment (no "bound", "in tears", "naked"). Appearance is their lasting looks (body, hair, eyes, usual style). "status" is only for things (e.g. a gift: delivered).',
    '  One subject per record: never "Lena and Tomas" — write a record for each of them. To say what a place or thing is, use kind "type" (place, item, group) or "basics". Write FACTS: none if there are none.',
    '  Example (a made-up story; use your story\'s own names):',
    '  FACTS:',
    '  - Lena | relationship: Tomas | sworn sister-in-arms since the siege of Varn',
    '  - Lena | where things stand: Tomas | trusting again after their quarrel; she promised to stop testing his loyalty',
    '  - Lena | minor moment | mended Tomas\'s cloak by the fire and told him about her brother',
    '  - Tomas | major moment | confessed he deserted at Varn → since then Lena keeps the truth from the council',
    '  - Tomas | secret | [Varn] he deserted his post at the siege of Varn',
    '  - Lena | knows | [Varn] Tomas confessed it to her at the campfire',
    '  - Lena | learned | the eastern pass is closed by snow until spring',
    '  - Captain Orrin | believes | [Varn] Tomas held the gate to the end',
    '  - Orrin | role | captain of the city watch',
    '  - The silver key | status | hidden under the chapel floor',
    '  - Lena | goal | [retake Varn] lead the Ember Circle back to Varn before winter',
    '  - Lena | progress | [retake Varn] won the council\'s vote for the march',
    '  Wrong: "- Lena | done | [retake Varn] planned the march" (planning is not done). Wrong: "- Lena | done | cooked supper for the camp" (completes no goal: a moment). Wrong: "- Lena | knows | Tomas kissed her by the fire" (a moment, not a secret). Wrong: "- Lena | where things stand: Tomas | he mended her cloak" (a scene, not a state).',
  ];
  // Version B of the fact rules, for the Keeper test only: the same kinds in
  // a compact table, one example each (a made-up story).
  const RECORD_RULES_COMPACT = [
    '- After each summary write FACTS: and then one fact per line: "- Subject | kind | fact". Subject: one exact name (never a pronoun; one person per line).',
    '  Kinds (use the one that fits; each fact once):',
    '  moment major / moment minor / moment routine — something that happened (major: changes something lasting) — "- Lena | moment minor | mended Tomas\'s cloak by the fire"',
    '  learned — something found out that is not a secret — "- Lena | learned | the eastern pass is closed until spring"',
    '  secret / knows / does not know — only for a secret, always with its [short name] — "- Tomas | secret | [Varn] he deserted at Varn", "- Lena | knows | [Varn] he told her"',
    '  believes — what someone thinks is true (may be wrong) — "- Orrin | believes | [Varn] Tomas held the gate"',
    '  relationship: Other — a lasting fact about the two — "- Lena | relationship: Tomas | sworn sister-in-arms"',
    '  where things stand: Other — how things are between them NOW, never a scene — "- Lena | where things stand: Tomas | trusting again after the quarrel"',
    '  goal / promise — only a stated commitment or intention, with a [short name] — "- Lena | goal | [retake Varn] lead the Circle back to Varn"',
    '  progress / done / postponed / cancelled — what became of a goal, with its [short name]; done only when it actually happened — "- Lena | progress | [retake Varn] won the council vote"',
    '  want — a wish or interest, not a commitment — "- Lena | want | to see the sea again"',
    '  personality / likes / dislikes / appearance / ability / backstory / role / location / condition / possession / nickname / type — lasting facts about someone or something',
    '  Not: "knows" for anything but a secret; a scene as "where things stand"; a plan as "done". Dates as the story names them, never "today/tomorrow". Write FACTS: none if there are none.',
  ];
  function summarySystem(facts, rules) {
    return [
      'You are the continuity editor for a long-running interactive story / roleplay chat.',
      'Your job now: write a detailed summary of EACH story reply in the messages, so the storyteller AI can remember exactly what happened.',
      '',
      'Rules:',
      '- Story replies are numbered [R1], [R2], … Write exactly one summary for EACH of them, starting a new line with its label.',
      '- Each summary is past-tense prose describing what happened in that reply and what the user did just before it, step by step in order: actions, important dialogue (short quotes are fine), decisions, revelations, emotions and reactions, changes in relationships, injuries, clothing and items, where and when it happened. Use names, be concrete; no vague phrases like "they talked" or "things got intense".',
      '- Each [R…] label gives the MOST its summary should be (longer replies get longer summaries). A short reply gets a short summary: never pad, never discuss the length. Cover the whole reply, including its end.',
      '- A story reply may begin with the storyteller AI\'s own planning or thinking (e.g. "Okay, the user wants…", notes on how to write the scene). That is not part of the story: ignore it and summarise only the story itself.',
      '- Write only the summaries and FACTS lines. Never write your own planning, questions about the task, notes on the format or the length, or what you are about to do.',
    ].concat(facts ? (rules || RECORD_RULES) : [
      '- After each summary, on its own line, write FACTS: followed by the lasting facts this reply revealed or changed, separated by " | ": names and nicknames, relationships and feelings, confessions, promises, secrets (and who knows them), injuries and condition, possessions, appearance changes, places, rules of the world, dates and times. Write FACTS: none if there are none.',
    ], [
      '- A reply that is a recap gets a summary starting with "Recap of earlier events:".',
      '- Never invent anything. Use the names in KNOWN NAMES for people and places that already have them.',
      '',
    ], RECAP_RULES, [
      '',
      'No commentary, no warnings, no questions. Answer in exactly this format and nothing else:',
      '[R1] (summary)',
      facts ? 'FACTS:\n- (Subject | kind | fact)\n- (…)' : 'FACTS: (facts)',
      '[R2] (summary)',
      facts ? 'FACTS:\n- (…)' : 'FACTS: (facts)',
    ]).join('\n');
  }

  function updateSystem() {
    return [
      'You are the continuity editor for a long-running interactive story / roleplay chat.',
      'You keep a knowledge base up to date so the storyteller AI never forgets anything. Your job now: fold NEW EVENTS (summaries of the latest story replies, with their lasting FACTS) into it.',
      'The knowledge base has STORY sections (the situation now) and ENTRIES (one per character, and per important place, item, group or piece of lore). The history of events is kept separately, in chapters; do not write it here.',
      '',
      'STORY rules:',
      '- Every line of every entry must be a fact in the entry format ("### Heading", "- bullet", or "Label: value"). Never write your working-out (which fact goes where, what is already covered, what you will output).',
      '- ## Current Scene must describe the situation after the NEWEST event (later events override earlier ones, e.g. a punishment that was changed). Rewrite it fully each time it changes; never keep outdated parts.',
      '- Sections: ## Current Scene (where and when it is, who is present, what is happening right now), ## Open Threads (only what is still unresolved: plans, promises, mysteries, things that must be followed up — remove a thread once it is resolved; never finished events, never what someone is doing right now (that is the Current Scene), never secrets (they are kept separately, with who knows them)), ## World & Timeline (world rules, the date and time (name days and times as the story does, never just "tomorrow" — it is wrong a day later), how much time has passed, important background; no list of events — they are kept separately).',
      '- Output only the sections that change, each as === SECTION: Name === followed by its complete new text, keeping every fact that is still true. Leave out sections that did not change. If a section is empty, write it in full.',
      '- Keep each section short, at most about 1,500 characters : it is sent with every message. What happened belongs in the history (chapters), details about characters, places and items in their entries.',
      '- Details about a character, place or item belong in its entry, not here.',
      '',
      'ENTRY rules:',
      '- EVERY named character gets an entry, including the user\'s character and side characters, even if they only appear briefly. List them all in CAST.',
      '- Places, groups and lore get an entry when the story keeps coming back to them. Items get an entry only when they are important to the plot over several scenes (e.g. a weapon, a gift, an heirloom, a key); never for props, clothing or objects used within a scene.',
      '- A character entry covers: who they are; appearance, clothing and distinguishing features; personality, mannerisms and how they talk; abilities; likes, dislikes and boundaries; backstory; their relationship with each other character and the moments that shaped it; feelings; current condition, injuries and whereabouts; what they carry or own; goals, promises and secrets (and who knows them); nicknames and running jokes. Be detailed and specific, with bullet points.',
      CHARACTER_LAYOUT,
      '- Length: main characters ' + detail().mainChar + ' characters each, growing as the story reveals more; side characters and places as long as their facts need. Record specifics, not general impressions.',
      '- Every FACT in the new events must end up in the right entry or story section.',
      '- Header format: === ENTRY: Name | kind | aliases: other names, nicknames, titles === where kind is character, place, item, group or lore. Aliases are every other way the story refers to it.',
      '- Output ONLY entries that are new or changed by the new events. Do not output unchanged entries, or entries listed by name only. Use the exact existing name for an existing entry.',
      '- For an EXISTING entry, do NOT rewrite it: write === ENTRY: Name | add === followed by ONLY the new bullet points (new facts, new developments). Never repeat what the entry already says. New nicknames go in the header: === ENTRY: Name | add | aliases: new nickname ===.',
      '- Only when something the entry says is no longer true (e.g. a relationship, condition or whereabouts changed), write the entry complete instead, with the normal header and every fact that is still true.',
      '- A NEW entry is written complete with the normal header.',
      '- Never remove a fact unless the story changed it; then update it. When something changes, update every entry it affects (e.g. both sides of a relationship).',
      '- Never invent anything. Only record what actually happened or was stated. Never write guesses ("assumed", "presumed", "probably"): if something is not known, leave it out.',
      '- Write ONLY facts about the story. Never write notes about your task, the request, the events list, the timeline or what you will output: no "But note", "We have", "So we output".',
      '- Where everyone is NOW lives only in ## Current Scene, never in entries: its "Where everyone is" list has one line per main character (and anyone else in the scene): "- Name: place — what they are doing, mood, what they wear". Characters not in the scene get their last known place and when. Rewrite the whole list each time; never keep old states.',
      '- Personality & Voice describes who the character is NOW, including how they have changed: when the story deepens or changes a trait, rewrite that line instead of only adding events.',
      '- For secrets, private moments, cover stories and hidden relationships, say WHO KNOWS (and who must not find out).',
      '- Use plain words for feelings and motives. Do not repeat the story\'s pet metaphors (e.g. "anchor", "sanctuary", "storm", "spark") as labels.',
      '- One person, one entry: "Ms. Choi" and "Choi" are the same entry; give a person one role and correct it when the story changes it.',
      '- Give every NEW entry its kind in the header: character (people and animals only), place, item, group or lore. Objects such as plushies, clothes, jewellery, vehicles are items; venues and rooms are places.',
      '- When something changes (a role, an item delivered, a plan cancelled), rewrite that line: the old version may stay only as history ("was …, until …"), never as a second current fact.',
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
  // How a character entry is laid out, so it stays organised and detailed.
  const CHARACTER_LAYOUT = '- Lay out a COMPLETE character entry under these headings, in this order, leaving out headings with nothing known: ' +
    '### Basics (full name, age, role, what they are) · ### Appearance (body, face, hair, eyes, height, build, scars, tattoos, usual and current clothing) · ' +
    '### Personality & Voice (traits, habits, mannerisms, how they talk, typical phrases) · ### Abilities & Skills · ### Likes, Dislikes & Boundaries · ' +
    '### Backstory · ### Relationships (one bullet per other character: what they are to each other, how they feel, the key moments between them, in order; and for each important one a "Where things stand:" line — the state of the RELATIONSHIP: what last changed between them, what each needs, what was promised, what is still unresolved; never where they are or what they are doing at this moment — rewritten whenever it changes) · ' +
    '### Key Moments (the important things that happened to or because of them, in order, with specifics) · ' +
    '### Goals, Promises & Secrets (and who knows each secret). In "add" updates, start each bullet with its topic, e.g. "- Relationships – Lena: …" or "- Key Moments: …". ' +
    'Leave out headings with nothing known: never write "None stated" or "Unknown". ' +
    'Entries hold LASTING facts only: never where someone is, what they are doing, wearing or feeling at this moment — that is written once, in the Current Scene. ' +
    'Be concrete: exact names, numbers, words said, places and objects, not vague impressions like "they grew closer".';

  const DETAIL = {
    standard: { label: 'Standard', logMin: 300, logShare: 0.15, logMax: 1500, perChunk: 8, mainChar: '800–1,500' },
    detailed: { label: 'Detailed', logMin: 700, logShare: 0.3, logMax: 3000, perChunk: 5, mainChar: '2,000–4,000' },
    maximum: { label: 'Maximum', logMin: 1200, logShare: 0.5, logMax: 5000, perChunk: 3, mainChar: '4,000–8,000' },
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
  // The cleaning rules, applied every time the memory is tidied (cleaning
  // twice changes nothing): the keeper's own notes and guesses go, an entry
  // keeps only its newest "Current State", and looping text is squashed.
  // Returns what it fixed.
  function cleanChat(chat) {
    const size = () => chat.memory.length + chat.entries.reduce((n, e) => n + e.text.length, 0) +
      (chat.chapters || []).reduce((n, c) => n + c.text.length, 0) + chat.log.reduce((n, e) => n + e.text.length, 0);
    const was = size();
    const noted = (t) => t.split('\n').some((l) => REASONING_RE.test(l) || REASONING_WORDS_RE.test(l)) || ASIDE_RE.test(t) || GUESS_RE.test(t);
    const clean = (t) => { ASIDE_RE.lastIndex = 0; GUESS_RE.lastIndex = 0; const n = noted(t); ASIDE_RE.lastIndex = 0; GUESS_RE.lastIndex = 0; return n ? dropReasoning(t) : t; };
    chat.memory = dedupeSections(squashRepeats(dropJunk(clean(chat.memory))));
    let kinds = 0;
    const moved = [];
    for (const e of chat.entries) {
      const split = splitStates(dropEmpty(dropJunk(clean(e.text), true)));
      if (split.states.length && (e.kind || 'character') === 'character') moved.push({ name: e.name, states: ['last known — ' + split.states[split.states.length - 1]] });
      e.text = squashRepeats(split.text);
      // Objects and places filed as characters.
      // (Entries built from facts already got their kind from the facts; never guessed again from text.)
      if (e.fromFacts) { /* kind decided in buildEntries */ }
      else if ((e.kind || 'character') === 'character') { const k = guessKind(e.name, [], e.text); if (k && k !== 'character') { e.kind = k; kinds++; } }
      // A person filed as a place or item (e.g. "Park Ji-won" as a park).
      else if (/^(place|item)$/.test(e.kind) && PERSON_RE.test(e.text) && !ITEM_WORDS.test(e.name)) { e.kind = 'character'; kinds++; }
    }
    for (const c of chat.chapters || []) c.text = squashRepeats(dropJunk(clean(c.text)));
    const tmpl = chat.entries.filter((e) => TEMPLATE_NAME_RE.test(e.name) && !e.always);
    if (tmpl.length) chat.entries = chat.entries.filter((e) => !tmpl.includes(e));
    if (moved.length) placeStates(chat, moved);
    for (const e of chat.log) e.text = squashRepeats(e.text);
    const gone = was - size();
    const fixes = gone > 0 ? ['removed ' + gone.toLocaleString() + ' characters of keeper notes, guesses, out-of-date states or repeated text'] : [];
    if (kinds) fixes.push('corrected the kind of ' + kinds + ' entr' + (kinds === 1 ? 'y' : 'ies') + ' (objects or places filed as characters)');
    return fixes;
  }

  // Some bots write their thinking into the answer ("Looking at the example…
  // So I think we can do:"). Those lines are not facts about the story.
  const REASONING_RE = /^\s*[(\[]?\s*(looking at|so,? i think|i think we|i think i|let me|let's|wait[,.]|hmm|okay,? so|ok,? so|alright,? so|now,? i|we (need|should|can|could|must|have|had|don't|do not|did|will|'ll|are|were|only|already)\b|we'll|i('ll| will| need| should| can| must)\b|first,? i|the (user|instructions?|example|task|knowledge base|entry format|format|context|request)\b|they (used|didn't|did not|updated|changed|want)|but they|this (means|entry|update)|actually,|but note|note:? (that )?(the|i|we)|so we\b|how can we|in the provided|therefore,? we|since we|however,? (we|the user)|but wait)/i;
  const REASONING_WORDS_RE = /knowledge base|the example|"add"|\badd mode\b|=== ?entry|rewrite the (entire|whole) entry|the instructions|\brequest [0-9a-f]{8}\b|entries only|output only|\b(previous|new|this|earlier) (request|update)\b|\bS\d+\s*[-–]\s*S\d+\b|the user (also )?(says|said|is now|asks|wants)|ignore all earlier messages/i;
  // Notes in brackets inside a fact, e.g. "(But note the timeline: …)", and
  // guesses marked "(assumed)" / "(presumed)": the guessed part is removed.
  const ASIDE_RE = /\s*\((?:but )?(?:note|n\.b\.|we |i |actually|the timeline|however)[^()]*\)/gi;
  const GUESS_RE = /[^.;\n]*\((?:assumed|presumed|probably|likely|guess(?:ed)?|unconfirmed|inferred)\)[^.;\n]*[.;]?/gi;
  function dropReasoning(t) {
    const text = String(t || '').replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, '');
    return text.split('\n').filter((l) => !(REASONING_RE.test(l) || REASONING_WORDS_RE.test(l)))
      .map((l) => l.replace(ASIDE_RE, '').replace(GUESS_RE, '').replace(/\s+$/, ''))
      .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // An entry's "right now" lines (Current State, whereabouts, mood, clothing):
  // only the newest of each kind is true, so older ones are removed.
  const STATE_RE = /^\s*[-*•]?\s*(?:\*\*)?\s*(current state|current location|whereabouts|location now|current mood|mood now|current clothing|wearing now|currently wearing|current condition)\s*(?:\*\*)?\s*(?:[:–—-]|\*\*)/i;
  function latestState(text) {
    const lines = String(text || '').split('\n');
    const last = new Map();
    lines.forEach((l, i) => { const m = l.match(STATE_RE); if (m) last.set(m[1].toLowerCase(), i); });
    return lines.filter((l, i) => { const m = l.match(STATE_RE); return !m || last.get(m[1].toLowerCase()) === i; }).join('\n');
  }

  function cleanOutput(t) {
    return String(t || '').replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, '').replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').replace(MEM_BLOCK_RE, '').trim();
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
    // The bot's greeting is not a story reply.
    const replies = msgs.filter((m) => m.role === 'assistant' && m.id !== chat.greetingId);
    if (chat.greetingId && msgs.some((m) => m.id === chat.greetingId)) msgs = msgs.filter((m) => m.id !== chat.greetingId);
    // Only user messages (e.g. the newest one, still waiting for its reply): nothing to summarise.
    if (!replies.length) return [];
    const names = chat.entries.map((e) => e.name + (e.aliases && e.aliases.length ? ' (' + e.aliases.join(', ') + ')' : ''));
    // The current scene only when it is really where the story stood just before these replies
    // (new replies, none summarised yet); never for older replies being redone.
    const logIds = new Set(chat.log.map((e) => e.id));
    const fresh = replies.every((m) => !logIds.has(m.id));
    const scene = fresh ? sectionOf(chat.memory, 'Current Scene').trim() : '';
    // Only the open goals of people these messages mention, at most 15 (a long list made the
    // keeper extract much less — Keeper test).
    const batchText = msgs.map((m) => m.text || '').join('\n').toLowerCase();
    const openCommits = factsMode(chat) ? (chat.commitReg || []).filter((c) => c.state !== 'done' && c.state !== 'cancelled' && batchText.includes(String(c.who || c.owner).toLowerCase())).slice(-15)
      .map((c) => (c.who || c.owner) + ': [' + c.id + '] ' + c.text) : [];
    const ask = async (list) => {
      const user = (names.length ? 'KNOWN NAMES: ' + names.join('; ') + '\n\n' : '') +
        (openCommits.length ? 'OPEN GOALS AND PROMISES (use these [short names] for their done / progress / postponed / cancelled):\n' + openCommits.join('\n') + '\n\n' : '') +
        (scene ? 'WHERE THE STORY STOOD BEFORE THESE MESSAGES:\n<<<\n' + scene + '\n>>>\n\n' : '') +
        'MESSAGES (oldest first):\n<<<\n' + formatMessages(list, chat.title) + '\n>>>\n\n' +
        (factsMode(chat) ? 'JOB: SUMMARISE. Write one summary and its FACTS records for each [R…] reply now.' : 'JOB: SUMMARISE. Write one summary and one FACTS line for each [R…] reply now.');
      const out = cleanOutput(await callLLM(summarySystem(factsMode(chat)), user, slot));
      checkStop();
      const tag = helperTag[slot] && !compare.slug ? Object.assign({}, helperTag[slot]) : null;
      const log = /^\W*=+\s*LOG\s*=+/im.test(out) ? out : '=== LOG ===\n' + out;
      // Working-out inside a summary is removed; a summary that is mostly
      // working-out counts as missing, so it is asked for again.
      const entries = parseKeeperAnswer(log, list.filter((m) => m.role === 'assistant')).entries.filter((e) => {
        const c = cleanSummary(e.text);
        e.text = c.text;
        if (tag) { e.hc = tag.chat; e.hp = tag.pos; }
        return !c.bad;
      });
      return { out, entries };
    };
    const first = await ask(msgs);
    let got = first.entries;
    // No [R…] summaries at all is unusable; summaries that were only working-out are asked for again below.
    if (!got.length && replies.length && !/\[?R\d+/.test(first.out)) throw new Error('Memory keeper gave an unusable answer: "' + first.out.slice(0, 120) + '"');
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
    got = dedupeEntries(got);
    // Summaries without a FACTS line (or, in the facts format, without
    // usable records): ask once more, for their facts only.
    const noLine = got.filter((e) => e.nofacts === 'missing' || (factsMode(chat) && e.facts && !e.records));
    for (let i = 0; i < noLine.length; i += 3) {
      checkStop();
      const batch = noLine.slice(i, i + 3);
      let again = [];
      try { again = (await ask(withPrompts(msgs, replies.filter((r) => batch.some((e) => e.id === r.id))))).entries; } catch (e) { if (e.stopped) throw e; }
      mergeFacts(batch, again);
    }
    const order = new Map(replies.map((r, i) => [r.id, i]));
    return got.sort((a, b) => order.get(a.id) - order.get(b.id));
  }

  // Replies whose summaries were removed here (deleted, redone, or gone from
  // the chat), with when: a merge with another device's copy never brings
  // them back.
  function forget(chat, ids) {
    const now = Date.now();
    chat.removed = Object.assign({}, chat.removed);
    for (const id of ids) chat.removed[id] = now;
    const keys = Object.keys(chat.removed);
    if (keys.length > 600) for (const k of keys.sort((x, y) => chat.removed[x] - chat.removed[y]).slice(0, keys.length - 600)) delete chat.removed[k];
  }

  // A summary whose facts are already in the story & characters, for a reply
  // that was deleted or redone: kept until the memory is corrected.
  function markStale(chat, e) {
    if (!e || !e.folded) return;
    chat.stale = (chat.stale || []).filter((x) => x.id !== e.id);
    chat.stale.push({ id: e.id, text: e.text, facts: e.facts || '', chapter: e.chapter != null ? e.chapter : null, at: Date.now() });
    if (chat.stale.length > 40) chat.stale.splice(0, chat.stale.length - 40);
  }

  // Takes only the facts from a second answer into existing summaries.
  // Still without a FACTS line: kept as "missing" and not asked again.
  function mergeFacts(items, again) {
    let n = 0;
    for (const e of items) {
      const a = again.find((x) => x.id === e.id);
      if (a && a.facts) { e.facts = a.facts; if (a.records) e.records = a.records; delete e.nofacts; n++; } else if (a && a.nofacts === 'none') e.nofacts = 'none';
      else e.nofacts = 'missing';
      e.factsAsked = true;
    }
    return n;
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
      (chat.memory.length > 6000 ? 'The STORY is ' + chat.memory.length + ' characters, which is too long: rewrite every section in full, at most 1,500 characters each, and move details about characters, places and items into their entries (with | add).\n\n' : '') +
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
      if (parsed.memory.trim() && !sections.length) memory = dedupeSections(dropJunk(removeSection(parsed.memory, 'Story So Far')));
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

  // Job 3: a run of summaries becomes a chapter of the story's history.
  async function makeChapter(chat, items, at, notes) {
    const idx = at == null ? chat.chapters.length : at;
    const prev = chat.chapters[idx - 1];
    const n = idx + 1;
    const user = (prev ? 'PREVIOUS CHAPTER (' + prev.title + '):\n<<<\n' + prev.text + '\n>>>\n\n' : '') +
      'EVENTS (oldest first):\n<<<\n' + formatEvents(items) + '\n>>>\n\n' +
      (notes ? 'A REVIEW OF THE PREVIOUS VERSION OF THIS CHAPTER FOUND THESE PROBLEMS (avoid them; follow the EVENTS exactly):\n<<<\n' + notes + '\n>>>\n\n' : '') +
      'JOB: CHAPTER. Write chapter ' + n + ' now.';
    const out = cleanOutput(await callLLM(chapterSystem(), user));
    checkStop();
    const m = out.match(/^[^\S\n]*[*#_]*[^\S\n]*=+[^\S\n]*CHAPTER\b[^\S\n]*:?([^\n=]*?)[^\S\n]*=+[^\n]*$/im);
    const title = (m ? m[1] : '').replace(/^\s*\d+\s*[:.–—-]\s*/, '').replace(/[*_#]/g, '').trim();
    const text = cleanChapterText(squashRepeats(dropReasoning((m ? out.slice(m.index + m[0].length) : out).trim())));
    if (text.length < 80) throw new Error('Memory keeper gave an unusable chapter: "' + out.slice(0, 120) + '"');
    return { title: title || 'Chapter ' + n, text, ids: items.map((e) => e.id) };
  }

  function cloneEntries(entries) {
    return entries.map((e) => Object.assign({}, e, { aliases: (e.aliases || []).slice() }));
  }

  // Is this answer's entry the one we asked about? Only by its name (or a
  // real nickname of it, or the name with a title), never a shared term of
  // address: while consolidating Karina, an entry for Yujin ("unnie" too)
  // must not replace hers.
  function isEntryFor(e, u) {
    const n = String(u.name || '').trim().toLowerCase();
    if (!n || isGeneric(n)) return false;
    return n === e.name.toLowerCase() || sameButTitle(e.name, u.name) || (e.aliases || []).some((a) => !isGeneric(a) && a.toLowerCase() === n);
  }

  // Terms of address the characters use for each other ("unnie", "oppa",
  // "little one"): they are not names, and never identify one person.
  const GENERIC_ALIAS_RE = /^(the )?(unnie|eonni|eonnie|onnie|oppa|hyung|hyungnim|noona|nuna|sunbae|sunbaenim|hoobae|maknae|babe|baby|bae|honey|hon|sweetheart|sweetie|sugar|darling|darlin'?|dear|dearest|love|my love|lover|little one|little bird|princess|prince|queen|king|kitten|pet|puppy|angel|beautiful|gorgeous|pretty|sir|ma'?am|madam|boss|leader|captain|master|mistress|daddy|mommy|sis|sister|bro|brother|girl|boy|kid|you|her|him|them)$/i;
  const isGeneric = (a) => GENERIC_ALIAS_RE.test(String(a || '').trim());
  // An entry by its name; by a nickname only when that nickname is a real
  // name for it (not a term of address) and belongs to no other entry.
  function findEntry(entries, name) {
    const n = String(name).trim().toLowerCase();
    const byName = entries.find((e) => e.name.toLowerCase() === n);
    if (byName || !n || isGeneric(n)) return byName;
    const byAlias = entries.filter((e) => (e.aliases || []).some((a) => a.toLowerCase() === n));
    return byAlias.length === 1 ? byAlias[0] : undefined;
  }

  // Apply the keeper's new or changed entries. An "add" update appends its new
  // lines (ones the entry already has are skipped). A rewrite that is much
  // shorter than a long existing entry probably lost details, so it is not applied.
  // State lines the keeper put in entries go to the Current Scene's
  // "Where everyone is" list, for anyone the scene does not mention yet.
  function placeStates(chat, updates) {
    const scene = sectionOf(chat.memory, 'Current Scene');
    const lines = [];
    for (const u of updates) {
      if (!u.states || !u.states.length) continue;
      if (mentions(scene, u.name)) continue;
      lines.push('- ' + u.name + ': ' + u.states[u.states.length - 1]);
    }
    if (lines.length) chat.memory = applySections(chat.memory, [{ title: 'Current Scene', add: true, text: lines.join('\n') }]);
  }

  // A block inside an entry that is headed by another entry's name
  // ("Ningning:", "**Ningning**", "### Ningning") belongs to that entry: the
  // keeper left out its header. Returns the updates with such blocks split off.
  function splitMisplaced(entries, updates) {
    const names = new Map();
    for (const e of entries) for (const k of entryKeys(e)) if (k.length > 2) names.set(k.toLowerCase(), e.name);
    for (const u of updates) names.set(u.name.toLowerCase(), u.name);
    const out = [];
    for (const u of updates) {
      const own = new Set([u.name].concat(u.aliases || []).map((n) => n.toLowerCase()));
      let cur = { u, lines: [] };
      const parts = [cur];
      for (const l of String(u.text || '').split('\n')) {
        const h = l.trim().replace(/^#{1,4}\s*/, '').replace(/^\*\*|\*\*$/g, '').replace(/\*\*/g, '').replace(/[:\s]+$/, '').trim().toLowerCase();
        const target = h && h.length <= 40 && !own.has(h) ? names.get(h) : null;
        if (target) { cur = { u: { name: target, aliases: [], add: true, text: '', states: [] }, lines: [] }; parts.push(cur); continue; }
        cur.lines.push(l);
      }
      for (const p of parts) {
        p.u.text = p.lines.join('\n').trim();
        if (p.u === u || p.u.text) out.push(p.u);
      }
    }
    return out;
  }

  // A nickname that is (or contains) another entry's name, e.g. "Giselle" or
  // "Yujin-unnie" on Karina, belongs to that other person.
  function aliasOfOther(entries, e, alias) {
    const a = String(alias || '').toLowerCase();
    return entries.some((x) => x !== e && x.name.length > 2 && (a === x.name.toLowerCase() || new RegExp('(^|[^\\p{L}])' + x.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\p{L}])', 'u').test(a)));
  }

  function applyUpdates(entries, updates, ignored) {
    updates = splitMisplaced(entries, updates);
    const refused = [];
    const skip = new Set((ignored || []).map((n) => n.toLowerCase()));
    for (const u of updates) {
      u.text = dropReasoning(u.text);
      if (!u.text) continue;
      // Entries the user deleted stay deleted.
      if ([u.name].concat(u.aliases).some((n) => skip.has(n.toLowerCase()))) continue;
      // A nickname only leads to an entry when it is not another update's
      // name and the update's own name is not a different known character.
      const others = new Set(updates.filter((x) => x !== u).map((x) => x.name.toLowerCase()));
      const e = findEntry(entries, u.name) || u.aliases.filter((a) => !others.has(a.toLowerCase())).map((a) => findEntry(entries, a)).find(Boolean);
      if (!e) {
        if (!u.text) continue;
        entries.push({ name: u.name, kind: (u.add ? u.newKind : u.kind) || guessKind(u.name, [], u.text) || 'lore', aliases: u.aliases, text: latestState(u.text), always: false, updated: Date.now() });
        continue;
      }
      if (!u.text) continue;
      if (u.add) {
        const have = new Set(e.text.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean));
        const lines = u.text.split('\n').filter((l) => l.trim() && !have.has(l.trim().toLowerCase()));
        if (lines.length) {
          e.text = latestState((e.text.trim() ? e.text.replace(/\s+$/, '') + '\n' : '') + lines.join('\n'));
          e.updated = Date.now();
        }
      } else if (e.text.length > 800 && u.text.length < e.text.length * 0.5) {
        refused.push(e.name);
      } else {
        e.text = latestState(u.text);
        e.updated = Date.now();
      }
      if (u.kind && !u.add) e.kind = u.kind;
      const names = new Set([e.name.toLowerCase()].concat(e.aliases.map((a) => a.toLowerCase())));
      for (const a of u.aliases.concat(u.name)) {
        if (!names.has(a.toLowerCase()) && !aliasOfOther(entries, e, a)) { e.aliases.push(a); names.add(a.toLowerCase()); }
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
  // Lines that are the keeper's working-out, not story facts: references to
  // its input ("F9:", "S3", "[R12]"), notes on where facts are filed
  // ("already in Karina's entry", "-> covered"), plans ("we can add…"),
  // and questions. Quoted speech is ignored when checking.
  const JUNK_RE = /(^|[\s(])(F|S)\d+\s*[:|\]\-–)]|\[R\d+|\balready (in|covered|recorded|reflected|has|have|listed|noted|captured)\b|\bin (his|her|their|its|the [\w'’ ]{1,40}?|[A-Z][\w-]*(?: [A-Z][\w-]*)?['’]s?|[\w-]+['’]s) entr(y|ies)\b|\b(the )?entry for\b|(->|→)\s*(in|covered|skip|temporary|same|already|not)\b|\b(we|i) (can|should|must|need|will|could|might|have to|do not|don't|already)\b|\bwe['’](ll|ve|d)\b|\bfor brevity\b|^\s*[-*•]?\s*similarly,? (for|with) (the )?(others|rest|remaining)\b|\b(headings?|sections?) (with nothing|that (are|is) empty)\b|\btoken limit\b|\b(output|write) (only|the|this|that|these)\b.*\bentr(y|ies)\b|^\s*[-*•]?\s*(implementation|correction|after review|summary of changes|changes|plan|reasoning|analysis)\s*:\s*$|\b(the )?(new events|events list|this request|previous request|previous update|knowledge base|the instructions)\b|[:\-–]\s*(temporary|skip|none)\s*\.?$|\bnot recorded\b|\bremains? unchanged\b|^\s*[-*•]?\s*(in )?(the )?[\w'’ ]{1,40}?['’]s? entr(y|ies)\s*[:.]|\bentry\s*:\s*(add|update|include|record)\b|^\s*[-*•]?\s*in (the )?[\w'’ ]{1,40}?(entry|entries)\.?\s*$|\bin the key moments of\b|\b(add|include) (a |the )?bullets?\b|^\s*(we update|now,? we (write|update|output|add)|let me|first,? we)\b|\b(this|that) (is|counts as|isn't|is not) a (lasting )?fact\b|\b(recorded|covered|captured|reflected|noted|listed|kept|stored|mentioned) in (the |his |her |their |its )?([\w'’ ]{1,30} )?(entr(y|ies)|sections?|timeline|key moments)\b|^\s*[-*•]?\s*JOB\s*:|\bwrite the (changed|new|complete) (story )?sections?\b|\b(and|write) the CAST\b|^\s*[-*•]?\s*=+\s*(SECTION|CAST|CHAPTER|ENTRY)\b|^\s*(entries|entry|cast|no entries)\.?\s*$/i;
  const unquoted = (l) => l.replace(/"[^"]*"|“[^”]*”/g, '""');
  const isJunk = (l, questions) => { const u = unquoted(l); return JUNK_RE.test(u) || (questions && u.trim().length < 300 && /\?\s*$/.test(u.trim())); };
  // Removes the keeper's working-out from any text. Once two such lines are
  // found in a part, the plain lines after them (up to the next "###"
  // heading) are working-out too and go as well; bullet points stay.
  // questions: also drop lines that end in a question (only in entries; an
  // Open Thread or a chapter may rightly ask one).
  function dropJunk(t, questions) {
    const out = [];
    let bad = 0;
    let skipping = false;
    for (const l of String(t || '').split('\n')) {
      if (/^\s*#{1,4}\s/.test(l)) { skipping = false; bad = 0; out.push(l); continue; }
      if (isJunk(l, questions)) { bad++; if (bad >= 2) skipping = true; continue; }
      // In a run of working-out, unlabelled plain lines are part of it;
      // bullets and "Label: value" lines are facts, each judged on its own.
      if (skipping && !/^\s*[-*•]\s+\S/.test(l) && !/^\s*\*{0,2}[A-Z][\w &,'’/()-]{1,40}?\*{0,2}\s*:\s*\S/.test(l)) continue;
      out.push(l);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  // An entry written by the keeper: its working-out is dropped (see
  // dropJunk), and so are bare labels with nothing after them
  // ("Implementation:", "Correction: the takeoff ritual:").
  function structuredOnly(t) {
    return dropJunk(t, true).split('\n').filter((l) => {
      const s = l.trim().replace(/^[-*•]\s*/, '');
      if (!s || /^#{1,4}\s/.test(l.trim())) return true;
      return !/:\s*$/.test(s) || /^\*{0,2}[A-Z][\w'’ &/,()-]{0,40}\*{0,2}:\s*$/.test(s) && false;
    }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  // Takes the "right now" state out of an entry ("Current State:" lines and
  // a "### Current State" part): it belongs in the Current Scene, so there
  // is one "now" for everyone. Returns the entry text and the state lines.
  function splitStates(t) {
    const keep = [];
    const states = [];
    // Under a "Current State" heading only the state lines right below it
    // count (at most a few): older entries had their later facts added
    // after it, and those are not states. A labelled line ("Key Moments:")
    // or a blank line ends the part.
    const LABEL = /^\s*[-*•]?\s*\*{0,2}[A-Z][\w &,'’/()-]{1,40}?\*{0,2}\s*:/;
    let inState = 0;
    for (const l of String(t || '').split('\n')) {
      if (/^\s*#{1,4}\s/.test(l)) { inState = /^\s*#{1,4}\s*(current state|right now|currently|whereabouts)\b/i.test(l) ? 1 : 0; if (!inState) keep.push(l); continue; }
      if (inState) {
        if (!l.trim() || (LABEL.test(l) && !STATE_RE.test(l)) || inState > 4) inState = 0;
        else { states.push(l.trim().replace(/^[-*•]\s*/, '')); inState++; continue; }
      }
      if (STATE_RE.test(l)) { states.push(l.trim().replace(STATE_RE, '').trim()); continue; }
      keep.push(l);
    }
    return { text: keep.join('\n').replace(/\n{3,}/g, '\n\n').trim(), states: states.filter(Boolean) };
  }

  // What an entry is when the keeper did not say: a name in its CAST list is
  // a character; otherwise its words decide; anything else is lore.
  const PLACE_WORDS = /\b(villa|house|home|penthouse|apartment|flat|room|bedroom|suite|pavilion|alcove|garage|bar|club|speakeasy|lounge|beach|city|town|village|island|studio|office|building|tower|street|park|hotel|resort|restaurant|cafe|café|terrace|pool|forest|jungle|cove|dorm|dormitory|school|hospital|kitchen|bathroom|garden|lake|river|mountain|castle|palace|church|temple|mansion|cabin|yacht club|airport|hangar|stage|arena|venue|hall|auditorium|annex|university|college|campus|library|lab|laboratory|classroom|lecture hall|dorm room|gym|theatre|theater|cinema|mall|market|shop|store|station)\b/i;
  const ITEM_WORDS = /\b(plushie|plush|toy|doll|hammock|jacket|coat|dress|gown|necklace|choker|bracelet|anklet|earrings?|ring|watch|car|motorcycle|ducati|jet|plane|boeing|helicopter|sikorsky|yacht|boat|van|phone|notebook|diary|letter|photo|key|keys|sword|gun|book|gift|box|collar|blanket|pillow|snow ?globe|perfume|bag|scarf|rig|speaker|guitar|piano|microphone|camera|laptop|preset|lights?|projector)\b/i;
  const GROUP_WORDS = /\b(team|crew|band|family|company|agency|entertainment|members|group|gang|club members|staff|board)\b/i;
  // Signs that an entry is about a person: "She …", a full name or role.
  const PERSON_RE = /^\s*[-*•]?\s*(she|he)\b|\b(full name|role|age|birthday|her (role|job|title)|his (role|job|title)|personality)\s*[:\-–]|\b(she|he) (is|was|has|delivered|said)\b/im;
  function guessKind(name, cast, text) {
    const n = String(name || '');
    if ((cast || []).some((c) => c.toLowerCase() === n.toLowerCase())) return 'character';
    if (text && PERSON_RE.test(text)) return 'character';
    if (TITLE_RE.test(n) && /^\S+\s+[A-Z]/.test(n)) return 'character'; // "CEO Lee", "CFO Park Ji-won"
    if (ITEM_WORDS.test(n)) return 'item';
    // A place or group word as the first word of a name may be a surname ("Park Ji-won").
    const rest = n.replace(/^\S+\s*/, '');
    if (PLACE_WORDS.test(rest) || (PLACE_WORDS.test(n) && !/^[A-Z][a-z]+ [A-Z][a-z]+(-[a-z]+)?$/.test(n))) return 'place';
    if (GROUP_WORDS.test(n)) return 'group';
    return '';
  }

  // A summary is one paragraph, so the keeper's working-out is found sentence
  // by sentence: planning ("Need around 5000 chars", "Let's draft"),
  // questions about the task, and talk about labels, format or length.
  const SUMMARY_JUNK_RE = /^\s*(summary\s*:\s*)?(need|needs|we need|we should|we can|we must|we'll|we will|let'?s|let me|i need|i will|i'll|i should|must|should|okay|ok|so,? (we|i)|but (wait|note|the instruction)|wait|actually|hmm|however,? (the|we|i)|therefore,? (we|i)|maybe|perhaps (we|i)|now,? (we|i|let))\b|\[R\d+[^\]]*\]|\b(\d[\d,]* ?chars?\b|characters? long|summary target|the (instruction|instructions|format|label|messages block)\b|story repl(y|ies) (is|are|in)\b|(R\d+)\b (is|was|has|contains)|we (have|need|should|must|can)\b|draft|outline:)/i;
  function cleanSummary(t) {
    const text = String(t || '').trim();
    // "Let's outline: Jacek joined…": the lead-in is planning, the rest may be the summary.
    const split = text.replace(/((?:let'?s|let me|we'?ll|now,? (?:we|i)|i'?ll)\s+(?:outline|draft|write|summari[sz]e|start|begin)[^:.!?]{0,40}|(?:summary|outline|draft)(?: for \[?R\d+\]?)?)\s*:\s*/gi, '$1.\n');
    const parts = split.split(/(?<=[.!?…]["”’']?)\s+(?=["“A-Z(\[])|\n+/);
    const kept = parts.filter((x) => x.trim() && !SUMMARY_JUNK_RE.test(unquoted(x)) && !/^\s*facts?\s*:/i.test(x) && !/^\s*(summary|outline|draft)( for \[?R\d+\]?)?\.?\s*$/i.test(x));
    const out = kept.join(' ').replace(/^\s*summary\s*:\s*/i, '').trim();
    // Mostly working-out: not a usable summary (it is asked for again).
    const bad = out.length < 40 || out.length < text.length * 0.5;
    return { text: out, bad };
  }

  // An entry whose name is the template's ("Name", "kind", "Title", …): the
  // keeper copied the format instead of writing an entry.
  const TEMPLATE_NAME_RE = /^\s*(name|names|title|kind|entry|character|person|place|item|thing|group|lore|n\/?a|\.{2,}|…|\(.*\)|<.*>|\[.*\])\s*$/i;
  const TEMPLATE_ALIAS_RE = /^(other names|nicknames|titles|aliases?|…|\.{2,})$/i;

  // "None stated" and the like are not facts; a heading with nothing under
  // it is dropped too.
  const EMPTY_FACT_RE = /^\s*[-*•]?\s*(\*{0,2}[A-Za-z][\w &,'’/()-]{0,40}\*{0,2}\s*:\s*)?(none|nothing|n\/?a|unknown|not (stated|mentioned|known|specified|given)|none (stated|known|yet|mentioned|specified|given|so far))\.?\s*$/i;
  function dropEmpty(t) {
    const lines = String(t || '').split('\n').filter((l) => !EMPTY_FACT_RE.test(l));
    return lines.filter((l, i) => {
      if (!/^\s*#{1,4}\s/.test(l)) return true;
      const next = lines.slice(i + 1).find((x) => x.trim());
      return !!next && !/^\s*#{1,4}\s/.test(next);
    }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // The bot's greeting (an AI message before the user's first message) is
  // not a story reply: it is not summarised.
  function greetingOf(msgs) {
    const first = (msgs || []).find((m) => m.role === 'user' || m.role === 'assistant');
    return first && first.role === 'assistant' ? first.id : null;
  }

  // The story's "## Title" sections: one per title (the first; a repeat is
  // usually the keeper's planning), without "none" lines or empty sections.
  function dedupeSections(memory) {
    const text = String(memory || '');
    const parts = text.split(/^(?=##\s)/m);
    const seen = new Set();
    const out = [];
    for (const p of parts) {
      const m = p.match(/^##\s*(.+?)\s*$/m);
      if (!m || !/^##\s/.test(p)) { if (p.trim()) out.push(p.trim()); continue; }
      const key = m[1].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const body = p.slice(m[0].length).split('\n').filter((l) => !EMPTY_FACT_RE.test(l.replace(/^\s*\(|\)\s*$/g, ''))).join('\n').trim();
      if (body) out.push('## ' + m[1] + '\n' + body);
    }
    return out.join('\n\n');
  }

  // ---------------------------------------------------------------------------
  // The "facts" memory format (per story; see docs/REDESIGN.md)
  // ---------------------------------------------------------------------------
  // Each reply's summary carries fact records: "Subject | kind | value"
  // (kind may name a target: "relationship: Winter"). Story Manager builds
  // the entries from all records itself; the AI never edits entries, so
  // facts cannot move to the wrong person, contradictions are settled by
  // "the newest wins", and a redone or deleted reply takes its facts along.
  const RECORD_KINDS = [
    ['fullname', /^(full name|real name|birth name|name)$/],
    ['age', /^(age|born|birthday)$/],
    ['role', /^(role|job|occupation|position|title|profession|rank)$/],
    ['type', /^(type|is a|what it is|category)$/],
    ['status', /^(status|condition of item|state of item)$/],
    ['condition', /^(condition|health|alive|injur(y|ies)|wounds?|fate)$/],
    ['location', /^(location|lives|home|lives in|based in)$/],
    ['basics', /^(basics?|identity|info|about)$/],
    ['appearance', /^(appearance|looks?|body|build|hair|eyes|face|features?|scar|tattoo)$/],
    ['personality', /^(personality|traits?|voice|manner|mannerisms?|habits?|speech|temperament|character)$/],
    ['ability', /^(abilit(y|ies)|skills?|talents?|power)$/],
    ['likes', /^(likes?|loves?|preferences?|favou?rites?|enjoys)$/],
    ['dislikes', /^(dislikes?|hates?|fears?)$/],
    ['boundary', /^(boundar(y|ies)|limits?|consent)$/],
    ['backstory', /^(backstory|history|past|origin)$/],
    ['stands', /^(where things stand|stands|relationship status|status with)$/],
    ['relationship', /^(relationships?|relation|bond|feelings? (for|about|toward))$/],
    ['possession', /^(possessions?|owns|gifts?|items?|belongings?)$/],
    ['promise', /^(promises?|vows?|agreements?|commitments?|deals?)$/],
    ['secret', /^(secrets?)$/],
    ['notknows', /^(does not know|doesn'?t know|does not know about|doesn'?t know about|unaware of|must not know|must not find out|kept from|not told|in the dark about)$/],
    ['knows', /^(knows|knows about|is aware of|aware of|in on)$/],
    ['learned', /^(learned|learnt|found out|was told|overheard|discovered|realized|realised|heard)$/],
    ['believes', /^(believes?|thinks?|suspects?|assumes?|is convinced|convinced|claims?)$/],
    ['cover', /^(cover story|cover|public story|official story|what others are told|what outsiders are told|alibi)$/],
    ['goal', /^(goals?|plans?|intentions?|missions?|quests?|tasks?|orders?)$/],
    ['scheduled', /^(scheduled|appointments?|upcoming|set for|planned for|booked)$/],
    ['want', /^(wants?|desires?|wishes|wish|hopes?|dreams? of|longs? for|ambitions?|motivations?|interested in|curious about|drawn to)$/],
    ['done', /^(done|completed|complete|kept|fulfilled|resolved|goal done|promise kept|finished|achieved|accomplished)$/],
    ['cancelled', /^(dropped|cancelled|canceled|abandoned|no longer|called off|broken|promise broken|failed)$/],
    ['postponed', /^(postponed|delayed|rescheduled|put off|on hold)$/],
    ['progress', /^(progress|partly done|partial|step done|underway|in progress|step)$/],
    ['nickname', /^(nicknames?|alias(es)?|called|also known as|pet names?)$/],
    ['moment', /^(key moments?|moments?|events?|did|milestones?|turning points?|(major|important|big|key major|minor|routine|small) (key )?moments?)$/],
  ];
  // Kinds that hold one value at a time: the newest is true, older ones are history.
  const SINGLE_KINDS = new Set(['fullname', 'age', 'role', 'type', 'status', 'condition', 'location', 'stands']);
  function recordKind(k) {
    // "relationship with Winter", "Relationship to Winter", "where things stand with Winter" → kind and target.
    let raw = String(k || '').replace(/\([^)]*\)/g, '').replace(/\*+/g, '').trim();
    raw = raw.replace(/^(relationships?|relation|bond|where things stand|stands|feelings?)\s+(?:with|to|toward|towards|for|about)\s+(.+)$/i, '$1: $2');
    const m = raw.match(/^([^:]+?)\s*(?::\s*(.+))?$/);
    if (!m) return null;
    let name = m[1].trim().toLowerCase();
    // "major goal", "routine promise", "minor scheduled": a goal with its level.
    const lv = name.match(/^(major|minor|routine)\s+(goals?|promises?|plans?|scheduled|appointments?|upcoming)$/);
    if (lv) name = lv[2];
    const hit = RECORD_KINDS.find(([, re]) => re.test(name));
    return Object.assign({ kind: hit ? hit[0] : 'other', target: (m[2] || '').trim(), label: name }, lv ? { level: lv[1] } : {});
  }
  // "- Karina | relationship: Winter | close friends since the dorm night"
  function parseRecords(block) {
    const out = [];
    for (const l of String(block || '').split('\n')) {
      // (Some keepers wrap a line in quotes: "- Mira | done | …".)
      const wrapped = /^\s*["“']+\s*[-*•]?\s*[^|]+\|/.test(l);
      const m = (wrapped ? l.replace(/^\s*["“']+\s*/, '').replace(/\s*["”']+\s*$/, '') : l).match(/^\s*[-*•]?\s*([^|\n]{1,60}?)\s*\|\s*([^|\n]{1,60}?)\s*\|\s*(.+?)\s*$/);
      if (!m) continue;
      const k = recordKind(m[2]);
      const s = m[1].replace(/^\*+|\*+$/g, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
      const v = m[3].replace(/\s*\|\s*/g, '; ').trim();
      if (!k || !s || !v || TEMPLATE_NAME_RE.test(s) || isGeneric(s) || isJunk(v, true) || EMPTY_FACT_RE.test(v)) continue;
      // A record's subject is a name and its kind a short label. "Mira is a
      // healer | Ash is a dragon | …" (old-style facts on one line) is not a record.
      // (A group that learns a secret — "The council | knows | [x]" — may start with "the".)
      const groupKnower = (k.kind === 'knows' || k.kind === 'notknows') && /^the\s+\S/i.test(s) && s.split(/\s+/).length <= 4;
      if (s.split(/\s+/).length > 5 || /\b(is|was|are|were|has|had|did|does|became|got|gave|said|told)\b/i.test(s) || (!groupKnower && /^(the|a|an|they|she|he|it|we|i)\b/i.test(s))) continue;
      // A kind Story Manager does not know is kept (as "unclassified"), never dropped.
      if (k.kind === 'other' && k.label.split(/\s+/).length > 3) k.kind = 'unclassified';
      // "done | dropped: …" (older check-ups): a cancellation.
      if (k.kind === 'done' && /^\s*(\[[^\]]+\]\s*)?(dropped|cancelled|canceled|abandoned)\s*:/i.test(m[3])) k.kind = 'cancelled';
      // Learning a named secret is knowing it.
      if (k.kind === 'learned' && /^\s*\[[^\]]+\]/.test(m[3])) k.kind = 'knows';
      // "Lecture Hall B | place | a raked auditorium…": the kind says what it IS.
      const isA = k.label.match(/^(place|location type|venue|building|room|item|object|thing|group|organisation|organization|lore|event)$/);
      if (isA) {
        out.push({ s, k: 'type', t: '', v: ({ venue: 'place', building: 'place', room: 'place', 'location type': 'place', object: 'item', thing: 'item', organisation: 'group', organization: 'group', event: 'lore' })[isA[1]] || isA[1], label: 'type' });
        out.push({ s, k: 'basics', t: '', v, label: 'basics' });
        continue;
      }
      const rec = Object.assign({ s, k: k.kind, t: k.target, v, label: k.label }, k.level ? { level: k.level } : {});
      // Moments come in four levels (see RECORD_RULES).
      if (k.kind === 'moment') {
        rec.tier = /turning/.test(k.label) ? 'turning' : /^(major|important|big|key major)\b/.test(k.label) ? 'major' : /^(routine|small)\b/.test(k.label) ? 'routine' : /^minor\b/.test(k.label) ? 'minor' : undefined;
        if (!rec.tier) delete rec.tier; // a plain "key moment" (older keepers): no level
        if (rec.tier === 'turning' || rec.tier === 'major') rec.imp = true;
      }
      out.push(rec);
    }
    return out;
  }

  // Commitments: goals and promises (a quest, a mission, a date, a vow — any
  // story). Each gets a permanent id from Story Manager when it first appears,
  // kept in chat.commitReg, so it survives rebuilds: a rebuilt goal with
  // another name or wording is matched to the one it already is. The keeper
  // refers to it by its [short name]; a "done" must name a real commitment of
  // that person and say it happened — a statement of intent never completes
  // anything, and an action that completes nothing is a moment filed wrongly.
  const INTENT_RE = /^\s*(plan(s|ned|ning)?|intend(s|ed)?|will|would|shall|wants? to|wanted to|decided to|agreed to(?! (the|a|an|his|her|their|its|our|terms)\b)|promised to|vowed to|swore to|is going to|was going to|hopes? to|hoped to|prepar(es|ed|ing) to|set out to|aims? to|means? to|offered to|asked to|tried to|plans? for)\b/i;
  // A plan, wish or promise, with or without a subject first ("he will …", "Mira wants to …", "she vowed …").
  const isIntent = (t) => { const x = String(t).replace(/^\s*["“']+/, ''); return INTENT_RE.test(x) || INTENT_RE.test(x.replace(/^\s*(he|she|they|i|we|it|[A-Z][\p{L}'’-]+)\s+(?:(?:is|was|has|had)\s+)?/u, '')) || /^\s*(he|she|they|[A-Z][\p{L}'’-]+)\s+(wants?|wished?|hopes?|vowed|swore|promised|reaffirmed|is thinking|was thinking|thinks|plans?|will|would)\b/u.test(x); };
  const STALE_ROUTINE = 10; // replies without a mention after which a routine goal is probably over
  const STALE_MINOR = 50;   // … and a minor one
  const LIFE_KINDS = new Set(['done', 'progress', 'cancelled', 'postponed']);
  // A "done" is judged against what the goal asks for:
  //  - setting it up (scheduled, arranged, agreed, confirmed, promised again,
  //    reminded, accepted, booked) is progress — unless setting it up IS the
  //    goal ("secure an agreement", "book the hall");
  //  - a goal to finish or complete something needs the event to say it was
  //    finished; a part of it ("wrote three pages") is progress.
  // English wording; a story in another language is judged by the keeper and
  // the check-up alone.
  const SETUP_RE = /^\s*(scheduled|rescheduled|arranged|set up|booked|agreed|confirmed|reconfirmed|promised|reminded|accepted|planned|organi[sz]ed|reserved|invited|was invited|made plans|made an appointment|signed up)\b/i;
  const SETUP_GOAL_RE = /\b(agree|agreement|treaty|deal|truce|arrange|book|schedule|confirm|invite|accept|sign|reserve|organi[sz]e|appointment|consent|permission)/i;
  const FINISH_GOAL_RE = /^\s*(finish|complete|completing|finishing|write the (whole|rest|entire)|read the (whole|rest|entire))\b/i;
  const FINISHED_RE = /\b(finish|finished|completed?|done|wrapped up|handed in|turned in|submitted|delivered|the last|in full|all of it)\b/i;
  function doneMeans(goal, event) {
    if (SETUP_RE.test(event) && !SETUP_GOAL_RE.test(goal)) return 'setup';
    if (FINISH_GOAL_RE.test(goal) && !FINISHED_RE.test(event)) return 'partial';
    return 'done';
  }
  const commitName = (v) => (String(v || '').match(/^\s*\[([^\]]{1,60})\]\s*/) || [])[1] || '';
  const commitText = (v) => String(v || '').replace(/^\s*\[[^\]]{1,60}\]\s*/, '').trim();
  function commitState(chat, persist) {
    const recs = allRecords(chat);
    const sim = (a, b) => { const x = sigWords(a), y = sigWords(b); if (x.size < 2 || y.size < 2) return 0; let n = 0; for (const w of x) if (y.has(w)) n++; return n < 2 ? 0 : n / Math.min(x.size, y.size); };
    const reg = (chat.commitReg || []).map((x) => Object.assign({}, x, { names: (x.names || []).slice(), state: 'open', events: [], at: Infinity }));
    const ids = new Set(reg.map((x) => x.id));
    const newId = (owner, nm, text) => {
      const base = (normValue(nm) || normValue(text).split(' ').filter((w) => w.length > 2 && !STOP_WORDS.has(w)).slice(0, 4).join(' ') || 'goal').replace(/ /g, '-').slice(0, 40);
      let id = base, i = 2;
      while (ids.has(id)) id = base + '-' + i++;
      ids.add(id);
      return id;
    };
    const ownerOf = (r) => r.s.trim().toLowerCase();
    // Wording alone merges two goals only when it is nearly the same AND no
    // specifics differ (a day, a date, a time, a number, a name): "visit her on
    // Monday" and "visit her on Friday" are two commitments. When unsure they
    // stay separate — a wrong merge could silently erase an obligation.
    const SPECIFIC_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d+(:\d+)?(st|nd|rd|th|am|pm)?|[A-Z][\p{L}'-]+)\b/gu;
    const specifics = (t) => new Set((String(t).replace(/^\s*\S+/, '').match(SPECIFIC_RE) || []).map((w) => w.toLowerCase().replace(/['’]s$/, '')));
    const conflict = (a, b) => { const x = specifics(a), y = specifics(b); return [...x].some((w) => !y.has(w)) && [...y].some((w) => !x.has(w)); };
    const sameByWords = (a, b) => sim(a, b) >= 0.75 && !conflict(a, b);
    const ownName = (owner, nm) => { const k = secretKeyOf(nm); return k ? reg.find((x) => x.owner === owner && (x.names.includes(k) || secretKeyOf(x.id) === k)) : null; };
    const byName = (owner, nm) => { const k = secretKeyOf(nm); if (!k) return null; return reg.find((x) => x.owner === owner && (x.names.includes(k) || secretKeyOf(x.id) === k)) || (() => { const all = reg.filter((x) => x.names.includes(k) || secretKeyOf(x.id) === k); return all.length === 1 ? all[0] : null; })(); };
    const ofRecord = new Map();
    for (const r of recs) {
      if (r.k !== 'goal' && r.k !== 'promise' && r.k !== 'scheduled') continue;
      const owner = ownerOf(r), nm = commitName(r.v), text = commitText(r.v);
      let c = (nm && ownName(owner, nm)) || reg.filter((x) => x.owner === owner && sameByWords(x.text, text)).map((x) => [x, sim(x.text, text)]).sort((a, b) => b[1] - a[1]).map(([x]) => x)[0];
      if (!c) { c = { id: newId(owner, nm, text), owner, who: r.s.trim(), names: [], text, kind: r.k, at: r.at, state: 'open', events: [] }; reg.push(c); }
      if (nm && !c.names.includes(secretKeyOf(nm))) c.names.push(secretKeyOf(nm));
      if (text.length > (c.text || '').length && sameByWords(c.text, text)) c.text = text;
      if (!c.at || r.at < c.at) c.at = r.at;
      // Its level: the most important one given for it.
      const order = ['routine', 'minor', 'major'];
      if (r.level && order.indexOf(r.level) > order.indexOf(c.level || '')) { c.level = r.level; c.levelFromRecord = true; }
      c.seen = true;
      ofRecord.set(r.id, { status: 'ok', c });
    }
    // Two goals the check-up said are one ("[a] = [b]", same person): merged.
    for (const [from, to] of Object.entries(chat.commitAlias || {})) {
      const a = reg.find((x) => x.id === from), b = reg.find((x) => x.id === to);
      if (!a || !b || a === b || a.owner !== b.owner) continue;
      for (const n of a.names) if (!b.names.includes(n)) b.names.push(n);
      b.names.push(secretKeyOf(a.id));
      for (const [k, v] of ofRecord) if (v.c === a) ofRecord.set(k, { status: 'ok', c: b });
      if (a.at && (!b.at || a.at < b.at)) b.at = a.at;
      reg.splice(reg.indexOf(a), 1);
    }
    for (const r of recs) {
      if (!LIFE_KINDS.has(r.k)) continue;
      const owner = ownerOf(r), nm = commitName(r.v), text = commitText(r.v);
      if (r.k === 'done' && isIntent(text)) { ofRecord.set(r.id, { status: 'intent' }); continue; }
      let c = nm ? byName(owner, nm) : null;
      // Without a name: only a near-identical goal of the same person, nothing specific in conflict.
      if (!c && !nm) c = reg.filter((x) => x.owner === owner && (x.at || 0) <= r.at && sameByWords(x.text, text)).map((x) => [x, sim(x.text, text)]).sort((a, b) => b[1] - a[1]).map(([x]) => x)[0];
      // A step can only belong to a goal that already exists at that point in the story.
      if (!c || (c.at !== undefined && r.at < c.at)) { ofRecord.set(r.id, { status: 'unmatched' }); continue; }
      let k = r.k;
      // What a "done" means depends on what the goal asks for (see doneMeans).
      if (k === 'done') { const m = doneMeans(c.text, text); if (m !== 'done') { k = 'progress'; ofRecord.set(r.id, { status: 'ok', c, downgraded: m }); c.events.push({ k, at: r.at, v: text }); continue; } }
      ofRecord.set(r.id, { status: 'ok', c });
      c.events.push({ k, at: r.at, v: text });
    }
    // Levels set by a check-up for goals the keeper wrote without one; unsure ones count as minor.
    // A promise or something with a set time is never routine.
    const tiers = chat.commitTier || {};
    const now = chat.log.length;
    const logWords = chat.log.map((e) => ({ t: String(e.text || '').toLowerCase(), w: sigWords(e.text) }));
    for (const c of reg) {
      c.level = tiers[c.id] === 'arrangement' || tiers[c.id] === 'none' ? tiers[c.id] : c.level || tiers[c.id] || 'minor';
      if (c.level === 'routine' && (c.kind === 'promise' || c.kind === 'scheduled')) c.level = 'minor';
      // When the story last touched it: a step, or a reply that names its person and its words.
      let last = c.at || 0;
      for (const ev of c.events) if (ev.at !== Infinity && ev.at > last) last = ev.at;
      if (c.seen && c.level !== 'major') {
        const w = sigWords(c.text), who = String(c.who || c.owner || '').toLowerCase();
        for (let i = now - 1; i >= last; i--) { const x = logWords[i]; if (!x || !x.t.includes(who)) continue; let m = 0; for (const a of w) if (x.w.has(a)) m++; if (m >= 2) { last = i + 1; break; } }
      }
      c.lastSeen = last;
    }
    for (const c of reg) {
      c.events.sort((a, b) => a.at - b.at);
      for (const ev of c.events) {
        if (ev.k === 'done') { c.state = 'done'; c.doneAt = ev.at; c.how = ev.v; }
        else if (ev.k === 'cancelled') { c.state = 'cancelled'; c.doneAt = ev.at; c.how = ev.v; }
        else if (c.state !== 'done' && c.state !== 'cancelled') { if (ev.k === 'postponed') { c.state = 'postponed'; c.note = ev.v; } else c.note = ev.v; }
      }
      // (Not closed, but long untouched: see below, after goals closed together.)
    }
    // Goals set up in the same moment for the same thing close together: when one is done or
    // cancelled, another open goal from within a few replies that shares its specific words (not
    // just names) — three of them, or two for the same person — closes with it.
    {
      const people = knownPeople(chat);
      for (const x of reg) people.add(String(x.owner || '').toLowerCase()); // (whoever has a goal is a person)
      const words = (t) => new Set([...sigWords(t)].filter((w) => !people.has(w.replace(/['’]s$/, ''))));
      const specNoPeople = (t) => new Set([...specifics(t)].filter((w) => !people.has(w)));
      const specConflict = (a, b) => { const p = specNoPeople(a), q = specNoPeople(b); return [...p].some((w) => !q.has(w)) && [...q].some((w) => !p.has(w)); };
      const closed = reg.filter((x) => x.seen && (x.state === 'done' || x.state === 'cancelled') && x.level !== 'arrangement');
      for (const x of reg) {
        if (!x.seen || x.state === 'done' || x.state === 'cancelled' || !x.at || x.level === 'arrangement' || x.level === 'none') continue; // (standing agreements never close with something else)
        const wx = words(x.text);
        const by = closed.find((c) => { if (!c.at || Math.abs(c.at - x.at) > 3 || !(c.doneAt >= x.at) || specConflict(c.text, x.text)) return false; let m = 0; for (const w of words(c.text)) if (wx.has(w)) m++; return m >= (c.owner === x.owner ? 2 : 3); });
        if (by) { x.state = by.state; x.doneAt = by.doneAt; x.how = by.how; x.closedWith = by.id; }
      }
    }
    for (const c of reg) {
      // Not closed, but long untouched: probably over (kept, marked; back as soon as it is mentioned).
      if (c.state !== 'done' && c.state !== 'cancelled' && c.level !== 'major' && c.level !== 'arrangement' && c.level !== 'none' && now - (c.lastSeen || 0) >= (c.level === 'routine' ? STALE_ROUTINE : STALE_MINOR)) c.stale = true;
    }
    // …unless something still ahead covers it: an open major goal or upcoming event, or a line of
    // the story's Open Threads, about the same thing (a wedding and its preparations).
    const ahead = reg.filter((x) => x.seen && !x.stale && x.state !== 'done' && x.state !== 'cancelled' && (x.level === 'major' || x.kind === 'scheduled')).map((x) => sigWords(x.text))
      .concat(String((chat.memory || '').split(/^##\s*Open Threads\s*$/m)[1] || '').split(/^##\s/m)[0].split('\n').filter((l) => /^\s*[-*•]/.test(l)).map((l) => sigWords(l)));
    for (const c of reg) {
      if (!c.stale) continue;
      const w = sigWords(c.text);
      if (ahead.some((a) => { let m = 0; for (const x of w) if (a.has(x)) m++; return m >= 2; })) c.stale = false;
    }
    if (persist) {
      const keep = reg.filter((x) => x.seen || (chat.commitReg || []).some((y) => y.id === x.id)).map((x) => { const old = (chat.commitReg || []).find((y) => y.id === x.id) || {}; return { id: x.id, owner: x.owner, who: x.who, names: x.names, text: x.text, kind: x.kind, at: x.seen ? x.at : old.at, state: x.seen ? (x.stale ? 'stale' : x.state) : old.state }; });
      if (JSON.stringify(keep) !== JSON.stringify(chat.commitReg || [])) chat.commitReg = keep;
    }
    // Open Threads must not contradict the goals (until threads are built from
    // records): a thread that clearly is one goal now done or cancelled — and
    // like no open goal — is left out. When unsure it stays.
    const closedThread = (line) => {
      const t = String(line).replace(/^\s*[-*•]\s*/, '');
      const near = reg.filter((x) => x.seen).map((x) => [x, sim(x.text, t)]).filter(([, v]) => v >= 0.5);
      if (near.some(([x]) => x.state !== 'done' && x.state !== 'cancelled')) return null;
      const strong = near.filter(([x, v]) => v >= 0.75 && !conflict(x.text, t));
      return strong.length === 1 ? strong[0][0] : null;
    };
    // Open Threads built from the records: what is still open and still matters (major goals,
    // upcoming events, promises, and any open goal one of the keeper's thread lines is about),
    // each with where it stands now. A keeper line about no goal at all (a mystery, a danger)
    // is kept as it is, marked "not checked"; one about a goal is replaced by that goal.
    // (Word stems, so "paint" and "painting" agree; three shared stems are enough on long lines.)
    const whoSet = new Set([...knownPeople(chat)].concat(reg.map((x) => String(x.owner || '').toLowerCase())));
    const stems = (t) => new Set([...sigWords(t)].map((w) => w.replace(/['’]s$/, '')).filter((w) => !whoSet.has(w)).map((w) => w.slice(0, 5)));
    const stemSim = (a, b) => { const x = stems(a), y = stems(b); let n = 0; for (const w of x) if (y.has(w)) n++; return n < 2 ? 0 : n >= 3 ? Math.max(0.4, n / Math.min(x.size, y.size)) : n / Math.min(x.size, y.size); };
    const noteOf = (v) => String(v || '').replace(/\s*\(repl(?:y|ies)[^)]*\)\s*quote:[\s\S]*$/i, '').replace(/\s*\(repl(?:y|ies)[^)]*\)\s*$/i, '').trim();
    const openThreads = (prose) => {
      const live = reg.filter((x) => x.seen && !x.stale && x.state !== 'done' && x.state !== 'cancelled' && x.level !== 'none' && x.level !== 'arrangement'); // (standing agreements have their own place)
      const pick = new Set(live.filter((x) => x.level === 'major' || x.kind === 'scheduled' || x.kind === 'promise'));
      const loose = [];
      for (const l of String(prose || '').split('\n')) {
        const b = l.match(/^\s*[-*•]\s+(.*)$/);
        if (!b) continue;
        const near = reg.filter((x) => x.seen).map((x) => [x, stemSim(x.text, b[1])]).filter(([, v]) => v >= 0.4).sort((a, c) => c[1] - a[1]);
        if (!near.length) { loose.push('- ' + b[1].replace(/\s*\(not checked\)\s*$/, '') + ' (not checked)'); continue; }
        for (const [x] of near) if (live.includes(x)) pick.add(x); // (a thread about closed goals is simply over)
      }
      const order = { major: 0, minor: 1, arrangement: 2, routine: 3 };
      const lines = [...pick].sort((a, c) => (order[a.level] ?? 1) - (order[c.level] ?? 1) || (a.at || 0) - (c.at || 0)).map((x) =>
        '- ' + x.who + ': ' + x.text + ' [' + x.id + ']' + (x.state === 'postponed' ? ' (postponed' + (x.note ? ': ' + noteOf(x.note) : '') + ')' : x.note ? ' (so far: ' + noteOf(x.note) + ')' : ''));
      return lines.concat(tidyBullets(loose.join('\n')).split('\n').filter(Boolean)).join('\n');
    };
    return { reg: reg.filter((x) => x.seen), ofRecord, closedThread, openThreads };
  }

  // Fact quality: each record checked against its kind. Nothing is dropped —
  // a record that fails is kept (in the full entry, under "Unsorted") with
  // why, so it can be sorted later. Statuses:
  //   ok · unclassified (a kind Story Manager does not know) · no-secret
  //   ("knows" that names no secret: a moment or something learned, filed
  //   wrongly) · unresolved ("knows [x]" where no secret [x] exists yet — it
  //   may come later, or be another name for one) · suspect-state ("where
  //   things stand" that reads like a scene; flagged only, still used).
  const SCENE_STATE_RE = /^\s*(he|she|they|i|we)\s+\w+ed\b|^\s*\w+ed (him|her|them|his|the)\b|\b(tomorrow|tonight|today|this (morning|afternoon|evening)|right now|at the moment|for now|next (day|morning)|no schedule)\b/i;
  function factStatus(r, secretKeys, keyOf, commits) {
    if (r.keptAsIs) return 'ok';
    if (r.k === 'unclassified') return 'unclassified';
    if (LIFE_KINDS.has(r.k) && commits) {
      const s = (commits.ofRecord.get(r.id) || {}).status;
      if (s === 'intent') return 'intent-not-done';
      if (s === 'unmatched') return 'unmatched-done';
    }
    if (r.k === 'knows' || r.k === 'notknows') {
      const m = String(r.v).match(/^\s*\[([^\]]+)\]/);
      if (!m) return r.k === 'knows' ? 'no-secret' : 'ok';
      return secretKeys.has(keyOf(m[1])) ? 'ok' : 'unresolved';
    }
    if (r.k === 'stands' && SCENE_STATE_RE.test(r.v)) return 'suspect-state';
    return 'ok';
  }
  const secretKeyOf = (n) => normValue(n).split(' ').filter((w) => w && !STOP_WORDS.has(w) && !/^(on|of|to|a|an|in|at|by|is|my|me)$/.test(w)).sort().join(' ');
  function factQuality(chat) {
    const recs = allRecords(chat);
    const alias = chat.secretAlias || {};
    const keys = new Set();
    for (const r of recs) if (r.k === 'secret') { const m = String(r.v).match(/^\s*\[([^\]]+)\]/); if (m) keys.add(secretKeyOf(m[1])); }
    for (const k of Object.keys(alias)) keys.add(k);
    const commits = commitState(chat);
    const out = recs.map((r) => ({ r, status: factStatus(r, keys, secretKeyOf, commits) }));
    return out;
  }

  // ---- Step B: sorting facts the checks set aside (see factQuality) ----
  // chat.sortings: { key: { key, reply, s, k, v (the original), to: {k, t, v, tier}, decision, batch, at, why } }
  // decision: sorted (counts as "to") · dropped (left out of memory, kept in the log) · kept (the
  // original kind was right) · unsure / failed (stays unsorted).
  // A decision is tied to the original fact by its reply, subject, kind and wording, so a rebuild that
  // writes the same fact again keeps it; one reworded only a little keeps it too; one reworded
  // more is listed for review, never guessed.
  const sortKey = (reply, r) => [reply, String(r.s).trim().toLowerCase(), r.k, normValue(r.v)].join('|');
  const QUANTITY_RE = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|both|all|none|neither|either|single|pair|couple|dozen|half|twice|once|several|many|few)\b/gi;
  const quantityConflict = (a, b) => { const q = (t) => (String(t).toLowerCase().match(QUANTITY_RE) || []).sort().join(' '); return q(a) !== q(b); };
  function sortingFor(chat, reply, r, index) {
    const all = chat.sortings || {};
    const exact = all[sortKey(reply, r)];
    if (exact) return { d: exact, sure: true };
    const same = (index && index.get(reply)) || [];
    let best = null, bestV = 0;
    for (const d of same) {
      if (d.s !== String(r.s).trim().toLowerCase() || d.k !== r.k) continue;
      const a = sigWords(d.v), b = sigWords(r.v);
      let n = 0; for (const w of a) if (b.has(w)) n++;
      const v = a.size && b.size ? n / Math.max(a.size, b.size) : 0;
      if (v > bestV) { bestV = v; best = d; }
    }
    // A close match must also agree on numbers and quantities ("both" / "all three").
    if (best && bestV >= 0.8 && !quantityConflict(best.v, r.v)) return { d: best, sure: true, reworded: true };
    if (best && bestV >= 0.5) return { d: best, sure: false };
    return null;
  }
  const decisionValid = (d) => !(d.decision === 'sorted' && d.to && d.to.k === 'stands') && d.decision !== 'kept';
  function applySortings(chat, recs) {
    const all = Object.values(chat.sortings || {});
    if (!all.length) return recs;
    const index = new Map();
    for (const d of all) { if (!index.has(d.reply)) index.set(d.reply, []); index.get(d.reply).push(d); }
    const out = [];
    const review = [];
    for (const r of recs) {
      if (r.manual || r.recon || r.at === Infinity) { out.push(r); continue; }
      const reply = String(r.id).split('#')[0];
      const hit = sortingFor(chat, reply, r, index);
      if (!hit) { out.push(r); continue; }
      if (!hit.sure) { review.push(hit.d.key); out.push(r); continue; }
      const d = hit.d;
      if (d.decision === 'dropped') continue;
      // Decisions the current rules no longer allow (into "where things stand", or "kept") are not applied.
      if (!decisionValid(d)) { out.push(r); continue; }
      // On a reworded fact only the kind carries over; the fact keeps its own (new) wording.
      if (d.decision === 'sorted' && d.to) out.push(Object.assign({}, r, { k: d.to.k, t: d.to.t || '', v: hit.reworded ? (d.to.k === 'progress' || d.to.k === 'done' || d.to.k === 'knows' ? String(d.to.v).match(/^\s*\[[^\]]+\]/)[0] + ' ' + commitText(r.v) : r.v) : d.to.v, label: d.to.label || d.to.k, orig: { k: r.k, t: r.t, v: r.v }, sortedBy: d.key }, d.to.tier ? { tier: d.to.tier, imp: d.to.tier === 'major' } : {}));
      else out.push(Object.assign({}, r, d.decision === 'kept' ? { keptAsIs: true } : {}, { sortDecision: d.decision }));
    }
    Object.defineProperty(chat, '__sortReview', { value: review, configurable: true, enumerable: false, writable: true });
    return out;
  }
  // The keeper's answer for one fact, checked at three levels: structure (kind, ids), evidence
  // (the quote is in the source summary) and meaning (stays close to the original, no new names,
  // no flipped "not"). Returns { decision, to, why }.
  const SORT_KINDS = ['moment major', 'moment minor', 'moment routine', 'learned', 'knows', 'stands', 'progress', 'done', 'want', 'personality', 'keep', 'drop', 'unsure'];
  // Opposite outcomes (refused / accepted, wounded / killed …): an answer may not swap one for the other.
  const REVERSALS = [['refus', 'accept|agree'], ['won', 'lost'], ['alive|surviv', 'dead|died|killed'], ['wounded|injured', 'killed|dead'], ['arriv', 'left|depart'],
    ['succeed|success', 'fail'], ['kept', 'broke'], ['admit', 'den(y|ie)'], ['remember', 'forg[eo]t'], ['love', 'hate'], ['start|began|begin', 'stop|ended|quit'],
    ['open', 'clos'], ['join', 'left|quit'], ['trust', 'distrust|suspect'], ['forgave|forgive', 'blame'], ['found', 'lost'], ['captured', 'escaped|freed']]
    .map(([a, b]) => [new RegExp('\\b(' + a + ')', 'i'), new RegExp('\\b(' + b + ')', 'i')]);
  const NEGATION_RE = /\b(not|never|no|refused|refuses|didn['’]t|doesn['’]t|won['’]t|wouldn['’]t|cannot|can['’]t|without|failed to|declined)\b/i;
  function judgeSorting(fact, answer, source, ctx) {
    const kind = String(answer.kind || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const base = /^moment\b/.test(kind) ? 'moment' : kind.split(':')[0].trim();
    if (!SORT_KINDS.includes(base) && base !== 'moment' && !/^(moment|stands|knows|progress|done)\b/.test(base)) return { decision: 'failed', why: 'unknown kind "' + kind + '"' };
    if (base === 'unsure') return { decision: 'unsure', why: 'the keeper was unsure' };
    if (base === 'drop') return { decision: 'dropped', why: 'not worth keeping' };
    // "keep" is not proof: a flagged fact stays as it was (still used, still flagged), not marked right.
    if (base === 'keep') return { decision: 'unsure', why: 'the keeper kept the original kind; left as it was' };
    // "Where things stand" is the one kind code cannot check (a state, not a scene): never a sorting result.
    if (base === 'stands') return { decision: 'unsure', why: 'sorting never files a fact as "where things stand" (a scene is a moment)' };
    const v = String(answer.value || '').trim();
    if (v.length < 4) return { decision: 'failed', why: 'no value' };
    const src = normValue(source);
    const quote = normValue(answer.quote || '');
    // Evidence: a quote, when given, must be in the source summary.
    if (quote && (quote.length < 12 || !src.includes(quote))) return { decision: 'failed', why: 'the quote is not in the source summary' };
    // Lasting things need evidence.
    if (/^(personality|stands|done)$/.test(base) && !quote) return { decision: 'unsure', why: base + ' needs a quote from the summary' };
    // Meaning: close to the original fact (or the quote), no new names, no flipped negation.
    const near = (a, b) => { const x = sigWords(a), y = sigWords(b); if (!x.size) return 0; let n = 0; for (const w of x) if (y.has(w)) n++; return n / x.size; };
    const support = Math.max(near(v, fact.r.v), near(v, answer.quote || ''), near(v, source) * 0.9);
    if (support < 0.5) return { decision: 'unsure', why: 'reads like something new, not the same fact' };
    const names = (v.match(/\b[A-Z][\p{L}'’-]{2,}\b/gu) || []).filter((n, i) => i > 0 || !/^[A-Z]/.test(v));
    const newName = names.find((n) => !String(source).includes(n) && !String(fact.r.v).includes(n) && n !== fact.r.s);
    if (newName) return { decision: 'unsure', why: 'names someone not in the source ("' + newName + '")' };
    if (NEGATION_RE.test(v) !== NEGATION_RE.test(fact.r.v)) return { decision: 'unsure', why: 'a "not" was added or lost' };
    const flip = REVERSALS.find(([a, b]) => (a.test(v) && b.test(fact.r.v) && !b.test(v)) || (b.test(v) && a.test(fact.r.v) && !a.test(v)));
    if (flip) return { decision: 'unsure', why: 'the outcome was reversed' };
    const to = { v };
    if (base === 'moment') { const tier = (kind.match(/major|minor|routine/) || ['minor'])[0]; Object.assign(to, { k: 'moment', tier, label: tier + ' moment' }); }
    else if (base === 'stands') { const t = (kind.split(':')[1] || answer.target || '').trim(); if (!t) return { decision: 'failed', why: '"where things stand" without the other person' }; Object.assign(to, { k: 'stands', t, label: 'where things stand' }); }
    else if (base === 'knows') { const m = v.match(/^\s*\[([^\]]+)\]/); if (!m || !ctx.secretKeys.has(secretKeyOf(m[1]))) return { decision: 'unsure', why: 'knows a secret that does not exist' }; to.k = 'knows'; }
    else if (base === 'progress' || base === 'done') {
      const m = v.match(/^\s*\[([^\]]+)\]/);
      const c = m && ctx.goals.find((g) => g.id === m[1].trim() && g.owner === String(fact.r.s).trim().toLowerCase());
      if (!c) return { decision: 'unsure', why: 'names no goal of this person' };
      if (c.at !== undefined && fact.r.at < c.at) return { decision: 'unsure', why: 'the goal only appears later' };
      if (base === 'done' && (isIntent(commitText(v)) || doneMeans(c.text, commitText(v)) !== 'done')) return { decision: 'unsure', why: 'not a completion' };
      to.k = base;
    } else to.k = base;
    if (!to.label) to.label = to.k;
    return { decision: 'sorted', to, why: '' };
  }

  // Every record of the story, oldest first: from the summaries (in story
  // order), then the ones the user added. Hidden ones (deleted by the user)
  // are left out. Each gets an id: "<reply id>#<n>" or "manual#<n>".
  function allRecords(chat) {
    const hidden = new Set(chat.hiddenRecords || []);
    const out = [];
    // A recap retells earlier events: its facts count only when they are new (nothing like them
    // was recorded before for that person and kind). The rest stays in the log, unused.
    const seenFacts = [];
    const isRecap = (e) => /^\W*recap of earlier events/i.test(e.text || '');
    chat.log.forEach((e, i) => (e.records || []).forEach((r, n) => {
      const rec = Object.assign({ id: e.id + '#' + n, at: i + 1 }, r);
      if (isRecap(e)) {
        const w = sigWords(r.v);
        const dup = seenFacts.some((x) => x.s === String(r.s).toLowerCase() && x.k === r.k && (() => { let m = 0; for (const a of w) if (x.w.has(a)) m++; return w.size && m / Math.min(w.size, x.w.size || 1) >= 0.6; })());
        if (dup) return;
        rec.fromRecap = true;
      }
      seenFacts.push({ s: String(r.s).toLowerCase(), k: r.k, w: sigWords(r.v) });
      out.push(rec);
    }));
    (chat.manualRecords || []).forEach((r, n) => out.push(Object.assign({ id: 'manual#' + (r.n != null ? r.n : n), at: Infinity, manual: true }, r)));
    // Corrections from the check-ups (see reconcileFacts), placed at the reply they were made after.
    (chat.reconRecords || []).forEach((r, n) => {
      r = Object.assign({}, r, { v: String(r.v || '').replace(/\s*\((reply \d+[^)]*)\)\s*$/i, '') });
      if ((r.k === 'done' && NOT_DONE_RE.test(r.v)) || (r.k === 'knows' && NO_NEWS_RE.test(r.v)) || ((r.k === 'location' || r.k === 'role') && NOT_HOME_RE.test(r.v))) return;
      out.push(Object.assign({ id: 'recon#' + n, recon: true }, r));
    });
    // Sorting decisions (step B, see sortFacts) are a layer over the original
    // facts: the original is never changed and stays in r.orig. Facts the user
    // hid stay hidden; check-up and hand-added facts are never re-sorted.
    // Subjects saved with stray quotes or list marks ("\"- Miyeon") by older versions: cleaned.
    for (const r of out) if (/^["“'\s*•-]|["”']$/.test(r.s || '')) r.s = String(r.s).replace(/^["“'\s*•-]+|["”'\s]+$/g, '');
    const sorted = applySortings(chat, out.filter((r) => !hidden.has(r.id)));
    return sorted;
  }

  // An "appearance" fact about a passing moment (what someone is wearing or
  // how they look in one scene) is not their lasting look. Keepers write
  // these despite being told not to, so they are filtered here.
  const MOMENT_LOOK_RE = /^\s*(now|currently|still|wearing|wore|dressed in|in (her|his|their|a|an|the) (\w+ )?(bra|panties|underwear|lingerie|robe|towel|dress|shirt)\b)|\b(exposed|undone|unzipped|unbuttoned|torn|ripped|naked|nude|topless|bound|tied|taped|cuffed|gagged|blindfolded|covered in|dripping|soaked|smeared|disheveled|dishevelled|flushed|trembling|panting|after (her|his|their|the|being)|left (her|him|them) in|pulled (up|down|off|aside)|removed)\b/i;
  // A "role" that is really an activity ("has an afternoon class to teach").
  const NOT_ROLE_RE = /^\s*(has|have|had|is|was|will|going to|needs? to|must|wants? to|plans? to|about to|just|currently|now)\b/i;
  // Subjects that are not a person, place or thing of their own; the story's
  // World & Timeline section covers them.
  const PLACEHOLDER_SUBJECT_RE = /^(the )?(setting|scene|location|world|story|timeline|narrator|narration|user|you|me|everyone|everybody|all|the group|group|others|them|they)$/i;
  // The relationships list's lines first (it is the authority on the dynamic);
  // pairs it does not cover keep their lines from the facts.
  function mergeRel(mapped, rel, which) {
    if (!mapped) return rel.map((x) => x[which]);
    const has = (t) => mapped.find((l) => l.toLowerCase().startsWith('- ' + t.toLowerCase() + ':'));
    return mapped.concat(rel.filter((x) => !has(x.t)).map((x) => x[which]));
  }
  // The relationships list: "- Winter: dating — close again after the fight".
  function relationsOf(chat, p) {
    const list = chat.relMap && chat.relMap.list;
    if (!list || !list.length) return null;
    const names = [p.name].concat(p.aliases || []).map((n) => n.toLowerCase());
    // Each pair in full once: under the person with fewer relationships (Shuhua
    // holds "Jacek: …"); the one with more (Jacek) gets the status only.
    const pairsOf = {};
    for (const x of list) for (const n of [x.a, x.b]) pairsOf[n.toLowerCase()] = (pairsOf[n.toLowerCase()] || 0) + 1;
    const out = [];
    for (const x of list) {
      const a = names.includes(x.a.toLowerCase()), b = names.includes(x.b.toLowerCase());
      if (a === b) continue;
      const me = (a ? x.a : x.b).toLowerCase(), other = a ? x.b : x.a;
      if (/,|&/.test(other)) continue; // a group, not one relationship
      const mine = pairsOf[me] || 0, theirs = pairsOf[other.toLowerCase()] || 0;
      if (mine > theirs || (mine === theirs && me < other.toLowerCase())) { out.push('- ' + other + ': ' + x.status + ' (more under ' + other + ')'); continue; }
      out.push('- ' + other + ': ' + x.status + (x.now ? ' — ' + x.now : '') + (x.dynamic ? '. ' + x.dynamic.replace(/\.$/, '') : '') +
        (x.shaped ? '. Shaped by: ' + x.shaped.replace(/\.$/, '') : '') + (x.understood && !/^(none|none stated|not stated|n\/?a|nothing)\.?$/i.test(x.understood) ? '. Understandings: ' + x.understood.replace(/\.$/, '') : '') + (x.dynamic || x.shaped || x.understood ? '.' : ''));
    }
    return out;
  }
  // Key moments: how many of the newest always go into the pinned message.
  const MOMENTS_RECENT = 15;
  const MINOR_PINNED = 15;   // minor moments per character in the pinned message
  const ROUTINE_PINNED = 5;  // routine moments per character in the pinned message
  // The pinned message: lasting facts per relationship, possessions.
  const RELATION_FACTS = 3;
  const POSSESSIONS_PINNED = 10;
  const STOP_WORDS = new Set('that this with from into their there they them then than were have been what when where which while about after before over under again just very also only your more most some such each other back down onto upon his her hers him she he it its the and for was are but not all any one two'.split(' '));
  function sigWords(t) {
    return new Set(normValue(t).split(' ').filter((w) => w.length > 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w)));
  }
  // Two facts that say the same thing in other words ("Obsidian cuff bracelet
  // engraved 'Mine'" / "Obsidian bracelet engraved 'Mine' worn prominently"):
  // the longer one is kept.
  // Profile consolidation for the pinned version: facts that say the same thing in other words
  // (half or more of the shorter one's key words shared) count once — the NEWEST wording, at the
  // position of the newest. Nothing is removed from the full entry.
  function consolidate(list) {
    const out = [];
    for (const r of list) {
      const w = sigWords(r.v);
      const i = out.findIndex((x) => { const o = sigWords(x.v); if (!w.size || !o.size) return normValue(x.v) === normValue(r.v); let n = 0; for (const a of w) if (o.has(a)) n++; return n >= 2 && n / Math.min(w.size, o.size) >= 0.5; });
      if (i >= 0) out.splice(i, 1);
      out.push(r);
    }
    return out;
  }
  function alike(list, share) {
    const kept = [];
    for (const r of list) {
      const w = sigWords(r.v);
      const twin = kept.findIndex((x) => {
        const o = sigWords(x.v);
        let n = 0; for (const a of w) if (o.has(a)) n++;
        return n >= 2 && n / Math.min(w.size, o.size) >= share;
      });
      if (twin < 0) kept.push(r);
      else if (r.v.length > kept[twin].v.length) kept[twin] = Object.assign({}, r, { at: kept[twin].at });
    }
    return kept;
  }
  // Words that make a key moment important even when the keeper did not mark it.
  const BIG_MOMENT_RE = /\b(first (time|kiss|date|night)|for the first time|confess(ed|ion|es)?|propos(ed|al)|engaged|married|wedding|pregnan|vow(ed|s)?|promis(ed|e)|reveal(ed|s)?|found out|discover(ed|s)|learn(ed|s|t) (that|about|the truth)|exposed|broke up|break-?up|made up|reconcil|forgave|betray|moved (in|out|to)|quit|fired|died|death|virginity|deflower|i love you|in love|became (his|her|their)|agreed to|decided to|pact|killed|captured|escaped|rescued|kidnapped|arrested|exiled|crowned|defeated|won the|lost the|battle|war|alliance|treaty|oath|sworn|swore|surrender(ed)?|invaded|conquered|solved|accused|framed|cursed|awakened|transformed)\b/i;
  function importantMoment(chat, p, r, turning, weighty) {
    if (r.imp || r.manual || (chat.keptMoments || []).includes(r.id)) return true;
    if (r.at !== Infinity && (p.records.some((x) => x.at === r.at && /^(promise|secret)$/.test(x.k)) ||
      [p.name].concat(p.aliases).some((n) => weighty.has(n.toLowerCase() + '#' + r.at)))) return true;
    if (BIG_MOMENT_RE.test(r.v)) return true;
    const w = sigWords(r.v);
    return turning.some((t) => { let n = 0; for (const a of w) if (t.has(a)) n++; return n >= 3 || (n >= 2 && n / Math.min(w.size, t.size) >= 0.5); });
  }
  // Check-up lines that say the opposite of what they are ("done … (still open)"),
  // or only repeat what is known ("knows … already knows"): never used.
  const NOT_DONE_RE = /\b(still open|not done|not yet|in progress|ongoing|remains? (open|pending|unresolved)|still pending|no change|unchanged|not completed|underway|is happening|happening now|upcoming|still ahead|in progress|currently)\b/i;
  const NO_NEWS_RE = /\b(already knows?|already known|already listed|no change|unchanged)\b/i;
  // English word lists like this one are only a fallback for stories in
  // English; the kind checks (factQuality, commitState) do the real work and
  // do not depend on the story's language, genre or names.
  const NOT_HOME_RE = /\b(left|went|walked|arrived|returned|headed|was in|is in|was at|is at|passed|sitting|lying|doing|waiting|standing|leaning|parked|sat|stood|at the moment|for now|now at|no longer|currently at|with him|with her|\d{1,2}(:\d\d)?\s*(am|pm)|today|tonight|yesterday|this morning|right now|currently|arriving|leaving|playing|laughing|asleep|fell asleep|sleeping|surrounded by|then (her|his|the)|(late |early )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday) (night|morning|afternoon|evening)|in the (master suite )?bed|away|travel(l)?ing|on (a|his|her|their) (trip|tour)|trip|abroad|visiting|on business|for (the )?(meetings?|conference|tour))\b/i;
  const GROUP_HINT_RE = /\b(magazine|tabloid|outlet|media|news|newspaper|label|girl group|boy group|idol group|company|agency|entertainment|corporation|firm|fund|brand|network|channel|team|band|crew|army|guild|clan|tribe|council|faction|legion|squad|regiment|cult|gang|fleet|order of|house of)\b/i;
  const normValue = (v) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // Builds the entries from the records. Returns [{ name, kind, aliases, text, … }].
  function buildEntries(chat) {
    // Knowledge records ("knows", "does not know", "cover story") are not facts
    // of their own: they make a person exist and feed "Who knows what".
    const records = allRecords(chat).filter((r) => r.k !== 'cover');
    // Records that failed the fact check (see factQuality) stay in the full entry, under "Unsorted".
    const unsortedIds = new Set(factQuality(chat).filter((x) => /^(no-secret|unresolved|unclassified|intent-not-done|unmatched-done)$/.test(x.status)).map((x) => x.r.id));
    const commits = commitState(chat, true);
    // Secrets are put together once; each person's entry lists what they know.
    Object.defineProperty(chat, '__secrets', { value: buildSecrets(chat), configurable: true, enumerable: false, writable: true });
    const skip = new Set((chat.ignored || []).map((n) => n.toLowerCase()));
    // Who is who: names, titles ("Ms. Choi"), first/full names and real
    // nicknames lead to one person; terms of address ("unnie") never do.
    const people = [];
    const find = (name) => {
      const n = String(name).trim();
      const l = n.toLowerCase();
      return people.find((p) => p.name.toLowerCase() === l || sameButTitle(p.name, n) || p.aliases.some((a) => a.toLowerCase() === l) ||
        (n.includes(' ') !== p.name.includes(' ') && !/\band\b|&|,/i.test(n + ' ' + p.name) && (n.toLowerCase().startsWith(p.name.toLowerCase() + ' ') || p.name.toLowerCase().startsWith(l + ' '))));
    };
    // "Tiffany and Irene | …": the fact belongs to each of them.
    const NAMEISH = /^[A-Z\u00C0-\u024F\uAC00-\uD7A3][^\s,&]*(?: [A-Z\u00C0-\u024F][^\s,&]*){0,2}$/;
    const split = [];
    for (const r of records) {
      const parts = r.s.split(/\s*(?:,|&|\band\b)\s*/).map((x) => x.trim()).filter(Boolean);
      if (parts.length > 1 && parts.every((x) => NAMEISH.test(x))) for (const x of parts) split.push(Object.assign({}, r, { s: x }));
      else split.push(r);
    }
    // Every subject's name is known before any nickname is accepted, so a
    // nickname that names (or contains) someone else is never taken.
    const subjects = [...new Set(split.map((r) => r.s.trim()).filter((x) => x.length > 2))];
    const namesOther = (a, own) => subjects.some((x) => x.toLowerCase() !== own.toLowerCase() && !sameButTitle(x, own) &&
      new RegExp('(^|[^\\p{L}])' + x.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\p{L}])', 'u').test(a.toLowerCase()));
    for (const r of split) {
      if (skip.has(r.s.toLowerCase()) || PLACEHOLDER_SUBJECT_RE.test(r.s.trim())) continue;
      if (r.k === 'appearance' && MOMENT_LOOK_RE.test(r.v)) continue;
      if (r.k === 'role' && NOT_ROLE_RE.test(r.v)) continue;
      if ((r.k === 'knows' || r.k === 'notknows') && EVERYONE_RE.test(r.s.trim())) continue;
      let p = find(r.s);
      if (!p) { p = { name: r.s, aliases: [], records: [] }; people.push(p); }
      if ((r.k === 'knows' || r.k === 'notknows') && !unsortedIds.has(r.id)) { p.knowsOnly = true; continue; }
      // The fuller name is the entry's name ("Jacek Kowalski" over "Jacek").
      if (r.s.length > p.name.length && r.s.toLowerCase().startsWith(p.name.toLowerCase() + ' ')) { p.aliases.push(p.name); p.name = r.s; }
      p.records.push(r);
      if (r.k === 'nickname') for (const a of r.v.split(/[,;]|\band\b/).map((x) => x.replace(/["“”]/g, '').trim()).filter(Boolean)) {
        if (!isGeneric(a) && a.length <= 40 && !namesOther(a, r.s) && !people.some((q) => q !== p && q.name.toLowerCase() === a.toLowerCase()) && !p.aliases.some((x) => x.toLowerCase() === a.toLowerCase())) p.aliases.push(a);
      }
    }
    const before = new Map((chat.entries || []).map((e) => [e.name.toLowerCase(), e]));
    // For choosing key moments: the turning points, and which replies brought a
    // promise, secret, change in who knows or in where things stand, per person.
    const turning = (sectionOf(chat.memory, 'World & Timeline').split(/turning points?:/i)[1] || '').split('\n').map((x) => sigWords(x)).filter((w) => w.size >= 2);
    // A story whose keeper sorts moments into levels (v3.31+), or marked major ones.
    const tiered = allRecords(chat).some((r) => r.k === 'moment' && (r.tier || r.imp));
    const weighty = new Set(allRecords(chat).filter((r) => /^(promise|secret|knows|notknows)$/.test(r.k)).map((r) => r.s.toLowerCase() + '#' + r.at));
    const built = people.filter((p) => !p.aliases.some((a) => skip.has(a.toLowerCase()))).map((p) => {
      const by = (k) => p.records.filter((r) => r.k === k);
      const mineName = (n) => [p.name].concat(p.aliases, p.records.map((r) => r.s.trim())).some((x) => x.toLowerCase() === String(n).toLowerCase());
      const uniq = (list) => {
        const kept = [];
        for (const r of list) {
          const n = normValue(r.v);
          const twin = kept.findIndex((x) => { const m = normValue(x.v); return m === n || m.includes(n) || n.includes(m); });
          if (twin < 0) kept.push(r);
          else if (r.v.length > kept[twin].v.length) kept[twin] = r;
        }
        return kept;
      };
      // One value at a time: the newest, with the older ones as history.
      const single = (list) => {
        if (!list.length) return null;
        const last = list[list.length - 1];
        const older = uniq(list.slice(0, -1)).filter((r) => normValue(r.v) !== normValue(last.v));
        return last.v + (older.length ? ' (before: ' + older.map((r) => r.v + (r.at !== Infinity ? ', until reply ' + list[list.indexOf(r) + 1].at : '')).join('; ') + ')' : '');
      };
      // L: the full entry (panel, storage). P: the pinned message's shorter
      // version (no "before" histories, relationships in one line, important
      // key moments). M: a minor character's few lines.
      const L = [];
      const P = [];
      const M = [];
      const section = (title, lines, pin = lines, mini) => {
        if (lines.length) L.push('### ' + title, ...lines);
        if (pin && pin.length) P.push('### ' + title, ...pin);
        if (mini && mini.length) M.push('### ' + title, ...mini);
      };
      const now = (list) => (list.length ? list[list.length - 1].v : null);
      // "Who they are now": the keeper's short portrait of a main character.
      const portrait = (chat.portraits || {})[p.name.toLowerCase()];
      if (portrait && portrait.text) section('Who they are now', [portrait.text], [portrait.text], [portrait.text]);
      const basics = [], basicsNow = [];
      const one = (label, k) => {
        const v = single(by(k));
        if (v) { basics.push('- ' + label + ': ' + v); basicsNow.push('- ' + label + ': ' + now(by(k))); }
      };
      one('Full name', 'fullname'); one('Age', 'age'); one('Role', 'role'); one('Condition', 'condition');
      // "Lives / based" is a place, not where they went at some moment.
      const isThing = by('type').length ? !/character|person/i.test(single(by('type'))) : /^(item|place|group)$/.test(guessKind(p.name, [], '') || '');
      // (Where a thing is may be temporary; for a person only a home counts.)
      if (!isThing) p.records = p.records.filter((r) => r.k !== 'location' || !NOT_HOME_RE.test(r.v));
      one(isThing ? 'Where it is' : 'Lives / based', 'location');
      // "Status" is for things ("delivered"); for a person it is only the moment.
      const isPerson = by('type').length ? /character|person/i.test(single(by('type'))) : p.records.some((r) => /^(fullname|age|personality|relationship|stands|nickname)$/.test(r.k));
      if (!isPerson) one('Status', 'status');
      const extraBasics = uniq(by('basics')).map((r) => '- ' + r.v);
      section('Basics', basics.concat(extraBasics), basicsNow.concat(extraBasics), basicsNow.concat(extraBasics.slice(-2)));
      section('Appearance', alike(uniq(by('appearance')), 0.75).map((r) => '- ' + r.v));
      // Minor characters keep who they are (personality, likes, boundaries) in the pinned message.
      const persona = uniq(by('personality')).map((r) => '- ' + r.v);
      // Pinned: the same trait said again in other words counts once (the full entry keeps every wording).
      const personaPin = consolidate(by('personality')).map((r) => '- ' + r.v);
      section('Personality & Voice', persona, personaPin, personaPin.slice(-6));
      section('Abilities & Skills', uniq(by('ability')).map((r) => '- ' + r.v));
      const likes = [].concat(uniq(by('likes')).map((r) => '- Likes: ' + r.v), uniq(by('dislikes')).map((r) => '- Dislikes: ' + r.v), uniq(by('boundary')).map((r) => '- Boundary: ' + r.v));
      const likesPin = [].concat(consolidate(by('likes')).map((r) => '- Likes: ' + r.v), consolidate(by('dislikes')).map((r) => '- Dislikes: ' + r.v), consolidate(by('boundary')).map((r) => '- Boundary: ' + r.v));
      section('Likes, Dislikes & Boundaries', likes, likesPin, likesPin.filter((x) => /^- Boundary/.test(x)).concat(likesPin.filter((x) => !/^- Boundary/.test(x)).slice(-4)));
      section('Backstory', alike(uniq(by('backstory')), 0.6).map((r) => '- ' + r.v));
      // Relationships: one line per person, with where things stand now. The
      // pinned message keeps where things stand and the 3 newest lasting facts.
      const targets = [];
      // "Miyeon, Yujin, Chaewon: …" is a group event, not one relationship: left out.
      const groupTarget = (t) => /,|&|\band\b/i.test(t) && t.split(/\s*(?:,|&|\band\b)\s*/i).filter(Boolean).length > 1;
      for (const r of p.records) if ((r.k === 'relationship' || r.k === 'stands') && r.t && !groupTarget(r.t) && !targets.some((t) => t.toLowerCase() === r.t.toLowerCase())) targets.push(r.t);
      const rel = targets.map((t) => {
        const of = (k) => p.records.filter((r) => r.k === k && r.t.toLowerCase() === t.toLowerCase());
        const hist = uniq(of('relationship')).map((r) => r.v);
        const full = single(of('stands'));
        // A "where things stand" that reads like a scene is kept in the full entry only.
        const last = now(of('stands').filter((r) => !SCENE_STATE_RE.test(r.v)));
        const short = alike(uniq(of('relationship')), 0.85).slice(-RELATION_FACTS).map((r) => r.v);
        return {
          t,
          full: '- ' + t + ': ' + hist.join('; ') + (full ? (hist.length ? '. ' : '') + 'Where things stand: ' + full : ''),
          pin: '- ' + t + ': ' + (short.length ? short.join('; ') + (last ? '. ' : '') : '') + (last ? 'Where things stand: ' + last : ''),
          mini: '- ' + t + ': ' + (last ? last : short.slice(-1).join('')),
        };
      });
      const loose = uniq(by('relationship').filter((r) => !r.t));
      // Written once at the end of a rebuild (see writeRelationships): only what
      // they are to each other and a short note on how things stand.
      const mapped = relationsOf(chat, p);
      section('Relationships', rel.map((x) => x.full).concat(loose.map((r) => '- ' + r.v)),
        mergeRel(mapped, rel, 'pin').concat(loose.slice(-RELATION_FACTS).map((r) => '- ' + r.v)), mergeRel(mapped, rel, 'mini'));
      const things = alike(uniq(by('possession')), 0.5);
      section('Possessions', things.map((r) => '- ' + r.v), things.slice(-POSSESSIONS_PINNED).map((r) => '- ' + r.v));
      // What they know (from "Who knows what"): the secrets' short names.
      const knownNames = (chat.__secrets || []).filter((x) => x.knows.some((k) => k.who.toLowerCase() === p.name.toLowerCase() || p.aliases.some((a) => a.toLowerCase() === k.who.toLowerCase()))).map((x) => '[' + x.name + ']');
      const unknownNames = (chat.__secrets || []).filter((x) => x.notKnows.some((k) => k.who.toLowerCase() === p.name.toLowerCase())).map((x) => '[' + x.name + ']');
      // A goal or promise marked done later (a "done" record) leaves the pinned
      // message; the full entry keeps it, marked done.
      // Their goals and promises, once each, with where each stands (see commitState).
      const mine = new Set([p.name].concat(p.aliases, p.records.map((r) => r.s.trim())).map((n) => n.toLowerCase()));
      void mine;
      const own = commits.reg.filter((c) => mine.has(c.owner)).sort((a, b) => (a.at || 0) - (b.at || 0));
      const gpWord = (c) => (c.level === 'none' ? 'Not a goal (a remark or joke)' : c.level === 'arrangement' ? 'Standing agreement' : c.kind === 'promise' ? 'Promise' : c.kind === 'scheduled' ? 'Upcoming' : 'Goal');
      const atTxt = (n) => (n && n !== Infinity ? ', reply ' + n : '');
      // The full entry keeps every step (progress, postponements) as history.
      const steps = (c) => { const l = (c.events || []).filter((ev) => ev.k === 'progress' || ev.k === 'postponed').map((ev) => ev.k + ' ' + atTxt(ev.at).slice(2) + ': ' + ev.v); return l.length ? ' [history: ' + l.join('; ') + ']' : ''; };
      const gpFull = own.map((c) => '- ' + gpWord(c) + ' [' + c.id + ']' + (c.stale && c.state !== 'done' && c.state !== 'cancelled' ? ' (probably over — not mentioned since reply ' + c.lastSeen + ')' : '') + (c.state === 'done' ? ' (done' + atTxt(c.doneAt) + (c.how ? ': ' + c.how : '') + ')' : c.state === 'cancelled' ? ' (cancelled' + atTxt(c.doneAt) + (c.how ? ': ' + c.how : '') + ')' : c.state === 'postponed' ? ' (postponed' + (c.note ? ': ' + c.note : '') + ')' : c.note ? ' (progress: ' + c.note + ')' : '') + ': ' + c.text + steps(c));
      const gpOpen = own.filter((c) => c.state !== 'done' && c.state !== 'cancelled' && !c.stale && c.level !== 'arrangement' && c.level !== 'none').map((c) => '- ' + gpWord(c) + ' [' + c.id + ']' + (c.state === 'postponed' ? ' (postponed' + (c.note ? ': ' + c.note : '') + ')' : c.note ? ' (progress: ' + c.note + ')' : '') + ': ' + c.text);
      // Their secrets, once each (merged in "Who knows what").
      const ownSecrets = (chat.__secrets || []).filter((x) => (x.owners || []).some((o) => [p.name].concat(p.aliases).some((n) => n.toLowerCase() === o.toLowerCase())))
        .map((x) => '- Secret: [' + x.name + '] ' + x.text);
      const secretLines = ownSecrets.length ? ownSecrets : uniq(by('secret')).map((r) => '- Secret: ' + r.v);
      const goals = [].concat(gpFull, secretLines,
        knownNames.length ? ['- Knows: ' + knownNames.join(', ')] : [], unknownNames.length ? ['- Does NOT know: ' + unknownNames.join(', ')] : []);
      // Standing agreements (a signal, a rule between them) are kept as they are, never "over".
      const agreements = own.filter((c) => c.level === 'arrangement' && c.state !== 'cancelled').map((c) => '- Standing agreement: ' + c.text);
      const openGoals = [].concat(gpOpen, agreements, goals.slice(gpFull.length));
      section('Goals, Promises & Secrets', goals, openGoals, openGoals.filter((x) => /^- (Promise|Secret|Does NOT know)/.test(x)));
      const moments = uniq(by('moment'));
      const momentLine = (r) => '- ' + (r.at !== Infinity ? '(reply ' + r.at + ') ' : '') + (r.tier === 'turning' ? 'Turning point: ' : '') + r.v;
      // The pinned message: turning points, major moments and the ones the user
      // kept in full; minor ones the newest MINOR_PINNED, routine ones the newest
      // ROUTINE_PINNED. Stories from before the levels: see importantMoment.
      const tierOf = (r) => (r.manual || (chat.keptMoments || []).includes(r.id) ? 'major' : tiered ? (r.tier || (r.imp ? 'major' : 'minor')) : (importantMoment(chat, p, r, turning, weighty) ? 'major' : 'minor'));
      const newest = (t, n) => new Set(moments.filter((r) => tierOf(r) === t).slice(-n));
      const minorShown = newest('minor', MINOR_PINNED), routineShown = newest('routine', ROUTINE_PINNED);
      const shown = moments.filter((r) => { const t = tierOf(r); return t === 'turning' || t === 'major' || minorShown.has(r) || routineShown.has(r); });
      // The pinned message has one "Story moments" list instead (see storyMoments).
      void shown;
      section('Key Moments', moments.map(momentLine), []);
      // What they want: wishes, ambitions, interests — not commitments.
      const wants = alike(uniq(by('want')), 0.6).map((r) => '- ' + r.v);
      section('Motivations & Desires', wants, wants.slice(-5), wants.slice(-2));
      // What they found out (not a secret) and what they believe (may be wrong).
      const learned = alike(uniq(by('learned')), 0.6).map((r) => '- Learned: ' + r.v);
      const believes = alike(uniq(by('believes')), 0.6).map((r) => '- Believes (may not be true): ' + r.v);
      // A belief about a secret they have since come to know is out of date (full entry keeps it).
      const knownTopics = new Set((chat.__secrets || []).filter((x) => x.knows.some((k) => mineName(k.who))).map((x) => secretKeyOf(x.name)));
      const believesNow = consolidate(by('believes').filter((r) => { const m = String(r.v).match(/^\s*\[([^\]]+)\]/); return !(m && knownTopics.has(secretKeyOf(m[1]))); })).map((r) => '- Believes (may not be true): ' + r.v);
      section('Knowledge & Beliefs', learned.concat(believes), consolidate(by('learned')).slice(-3).map((r) => '- Learned: ' + r.v).concat(believesNow), believesNow);
      // Facts the keeper filed under a wrong or unknown kind: kept, not shown in the pinned message.
      const unsorted = p.records.filter((r) => unsortedIds.has(r.id));
      section('Unsorted (kind unclear; kept for sorting later)', unsorted.map((r) => '- ' + (r.at !== Infinity ? '(reply ' + r.at + ') ' : '') + (r.label || r.k) + ': ' + r.v), []);
      section('Other', alike(uniq(by('other')), 0.6).map((r) => '- ' + (r.label && r.label !== 'other' ? r.label + ': ' : '') + r.v));
      const typed = single(by('type'));
      const kindWord = typed && (typed.match(/\b(character|person|place|item|object|group|lore)\b/i) || [])[1];
      // Without a type: a person only if something personal is known about them.
      // Someone who acts in the story (moments), has a personality, relationships, plans or knows things is a person.
      const nameSaysThing = (typed && !/character|person|human|woman|man|girl|boy/i.test(typed)) || !!guessKind(p.name, [], '') || /^(setting|world|story|scene|timeline|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|morning|evening)$/i.test(p.name);
      const personal = p.knowsOnly || p.records.some((r) => /^(fullname|age|role|personality|ability|likes|dislikes|boundary|relationship|stands|promise|secret|goal|nickname|backstory|learned|believes|want|condition|scheduled)$/.test(r.k)) || !!portrait ||
        (!nameSaysThing && p.records.some((r) => r.k === 'moment'));
      // A name in capitals ("BABYMONSTER", "IVE") is a group, even with personal facts.
      const capsGroup = /^[A-Z0-9()&' -]{3,20}$/.test(p.name) && /[A-Z]{3}/.test(p.name);
      // A chat, channel or board where people post is a group, not a person.
      const chatGroup = /\b(group chat|chat|channel|forum|server|board)$/i.test(p.name);
      // A "type: place/item" for a person (the keeper describing their apartment) does not make them a place.
      const typedThing = kindWord && /^(place|item|object)$/i.test(kindWord) && personal && p.records.some((r) => /^(personality|likes|relationship|stands|moment|goal|learned)$/.test(r.k));
      const inCast = !chatGroup && castOf(chat, p);
      const kind = inCast ? 'character' : chatGroup ? 'group' : capsGroup && !kindWord ? 'group' : kindWord && !typedThing ? ({ person: 'character', object: 'item' }[kindWord.toLowerCase()] || kindWord.toLowerCase()) : typedThing ? 'character'
        : (guessKind(p.name, [], personal ? L.join('\n') : '') || (personal ? 'character' : GROUP_HINT_RE.test(p.name + '\n' + L.join('\n')) || /^[A-Z0-9]{2,6}$/.test(p.name) ? 'group' : (/^(setting|world|story|scene|timeline|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(p.name) ? 'lore' : 'item')));
      const old = before.get(p.name.toLowerCase());
      const pinText = P.join('\n');
      const miniText = M.join('\n');
      return { name: p.name, kind, aliases: p.aliases, text: L.join('\n'), pinText: pinText !== L.join('\n') ? pinText : undefined, miniText, always: !!(old && old.always), updated: Date.now(), records: p.records.length, recordIds: p.records.map((r) => r.id), fromFacts: true };
    }).filter((e) => e.text.trim()); // an entry with nothing but its type says nothing
    // The tidy-up's nickname rules, applied here so built entries are already
    // tidy (otherwise every save would "clean" the same nickname again).
    for (const e of built) {
      const seen = new Set([e.name.toLowerCase()]);
      e.aliases = e.aliases.filter((a) => { const k = a.toLowerCase(); if (!a || seen.has(k) || aliasOfOther(built, e, a)) return false; seen.add(k); return true; });
    }
    return built.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.records - a.records);
  }

  // "Who knows what": every secret of the story, put together from the
  // records of all replies. A secret has a short name in brackets
  // ("[SM ownership] …") so the same secret is found again later; the newest
  // record per person wins ("does not know" in reply 40, "knows" in reply 90
  // → knows since reply 90). Returns [{ name, text, knows, notKnows, cover }].
  const SECRET_NAME_RE = /^\s*\[([^\]]{1,60})\]\s*[:–—-]?\s*/;
  const EVERYONE_RE = /^(everyone|everybody|the public|public|all|the world|the whole group)$/i;
  function buildSecrets(chat) {
    const recs = allRecords(chat).filter((r) => /^(secret|knows|notknows|cover)$/.test(r.k));
    const secrets = [];
    // "[crush on Minsoo]" and "[minsoo-crush]" are one name: same words, any order.
    const keyOf = (name, text) => (name ? normValue(name).split(' ').filter((w) => w && !STOP_WORDS.has(w) && !/^(on|of|to|a|an|in|at|by|is|my|me)$/.test(w)).sort().join(' ') : normValue(text).split(' ').slice(0, 8).join(' '));
    const find = (key, text) => secrets.find((x) => x.key === key) ||
      (text ? secrets.find((x) => { const a = normValue(x.text); const b = normValue(text); return a && b && (a.includes(b) || b.includes(a)); }) : null);
    const alias = chat.secretAlias || {};
    // Whose secret each name is: two secrets of different people are never
    // merged, whatever the keeper said ("Jacek wants to be a father" is not
    // "Yujin wants his child").
    const ownersOf = {};
    for (const r of recs) if (r.k === 'secret') { const m = r.v.match(SECRET_NAME_RE); if (m) { const k = keyOf(m[1].trim(), ''); (ownersOf[k] = ownersOf[k] || new Set()); for (const w of r.s.split(/\s*(?:,|&|\band\b)\s*/)) if (w.trim()) ownersOf[k].add(w.trim().toLowerCase()); } }
    const sameOwners = (a, b) => { const x = ownersOf[a], y = ownersOf[b]; return !x || !y || [...x].some((w) => y.has(w)); };
    const ensure = (name, text) => {
      if (name && alias[keyOf(name, '')] && sameOwners(keyOf(name, ''), keyOf(alias[keyOf(name, '')], ''))) name = alias[keyOf(name, '')];
      const key = keyOf(name, text);
      let x = find(key, name ? '' : text);
      if (!x) { x = { key, name: name || '', text: '', people: new Map(), cover: '', at: 0 }; secrets.push(x); }
      if (name && !x.name) x.name = name;
      return x;
    };
    // Who: split "Karina and Winter"; one name per person.
    const whoOf = (sub) => sub.split(/\s*(?:,|&|\band\b)\s*/).map((p) => p.trim()).filter(Boolean);
    for (const r of recs) {
      const m = r.v.match(SECRET_NAME_RE);
      const name = m ? m[1].trim() : '';
      const rest = m ? r.v.slice(m[0].length).trim() : r.v.trim();
      if (r.k === 'secret') {
        const x = ensure(name, rest);
        if (rest) x.text = rest;
        x.at = r.at;
        for (const p of whoOf(r.s)) x.people.set(p.toLowerCase(), { who: p, knows: true, at: r.at, how: 'their secret' });
      } else if (r.k === 'cover') {
        const x = ensure(name, rest);
        if (rest) x.cover = rest;
      } else {
        // "knows [name] how they found out" / "does not know [name]"; without a name, the first secret it matches.
        const x = name ? ensure(name, '') : find(keyOf('', rest), rest);
        if (!x) continue;
        // "Everyone knows … (posted in the group chat)": that group knows, not the whole world.
        const viaGroup = r.k === 'knows' && EVERYONE_RE.test(String(r.s).trim()) && (String(rest).match(/\b(group chat|chat|channel|forum|group|household|council|crew|team|class)\b/i) || [])[1];
        for (const p of viaGroup ? ['The ' + viaGroup.toLowerCase()] : whoOf(r.s)) {
          const prev = x.people.get(p.toLowerCase());
          if (prev && prev.at > r.at) continue; // the newest record about this person wins
          if (prev && prev.how === 'their secret') continue; // their own secret: they always know it
          // Knowing is not undone by a later "does not know" — only by forgetting, said plainly.
          if (prev && prev.knows && r.k === 'notknows' && !/\b(forg[eo]t|forgotten|amnesia|lost (his|her|their) memor)/i.test(rest)) continue;
          if (prev && r.recon && r.k === 'knows' && prev.knows) continue; // a check-up only adds new knowers
          // "knows … does not know the secret": the keeper contradicting itself.
          if (r.k === 'knows' && /\b(does not|doesn['’]t|did not|didn['’]t) know\b|\bunaware of (it|the secret)\b/i.test(rest)) continue;
          x.people.set(p.toLowerCase(), { who: p, knows: r.k === 'knows', at: r.at, how: r.k === 'knows' ? rest : '' });
        }
      }
    }
    // The same secret under different names ("[giselle-ningning-fantasy]",
    // "[shared fantasies]"): one secret, with everyone from all of them.
    for (let a = 0; a < secrets.length; a++) {
      const wa = sigWords(secrets[a].text);
      if (wa.size < 3) continue;
      for (let b = secrets.length - 1; b > a; b--) {
        const wb = sigWords(secrets[b].text);
        if (wb.size < 3) continue;
        let n = 0; for (const w of wa) if (wb.has(w)) n++;
        // Two secrets of the same person (and only theirs) about the same thing
        // ("wants Jacek's baby" / "said yes to a child with Jacek") merge with less in common.
        const own = (x) => [...x.people.values()].filter((p) => p.how === 'their secret').map((p) => p.who.toLowerCase()).sort().join('|');
        const sameOwner = own(secrets[a]) && own(secrets[a]) === own(secrets[b]);
        // One without an owner ("[my dumbass]") joins its owned twin the same way.
        const oneUnowned = !own(secrets[a]) !== !own(secrets[b]);
        if (n / Math.min(wa.size, wb.size) < 0.6 && !((sameOwner || oneUnowned) && n >= 3 && n / Math.min(wa.size, wb.size) >= 0.35)) continue;
        const x = secrets[a], y = secrets[b];
        for (const [k, v] of y.people) { const prev = x.people.get(k); if (prev && prev.how === 'their secret') continue; if (!prev || prev.at <= v.at || v.how === 'their secret') x.people.set(k, v); }
        if (y.text.length > x.text.length) x.text = y.text;
        x.cover = x.cover || y.cover;
        secrets.splice(b, 1);
      }
    }
    // A secret that is only a label ("[car play]") says nothing to the story AI.
    return secrets.filter((x) => x.text && normValue(x.text) !== normValue(x.name) && !/\b(no|not an?y?|does not (seem to )?have an?y?|doesn['’]t have an?y?) secret\b/i.test(x.text)).map((x) => {
      const people = [...x.people.values()];
      const everyone = people.some((p) => p.knows && EVERYONE_RE.test(p.who));
      // Whoever the secret belongs to knows it, whatever a later record says.
      const ownerSet = new Set(people.filter((p) => p.how === 'their secret').map((p) => p.who.toLowerCase()));
      for (const p of people) if (ownerSet.has(p.who.toLowerCase())) { p.knows = true; if (p.how !== 'their secret') p.how = 'their secret'; }
      return {
        name: x.name || x.text.split(/[.;,]/)[0].split(/\s+/).slice(0, 5).join(' '),
        text: x.text,
        owners: people.filter((p) => p.how === 'their secret').map((p) => p.who),
        everyone,
        knows: people.filter((p) => p.knows && !EVERYONE_RE.test(p.who)),
        notKnows: everyone ? [] : people.filter((p) => !p.knows),
        cover: x.cover,
      };
    });
  }
  // The "Who knows what" text for the pinned message.
  function secretsText(chat) {
    const all = buildSecrets(chat);
    // Secrets the whole world knows are no longer secrets: one short line, not a full entry.
    const pub = all.filter((x) => x.everyone);
    return all.filter((x) => !x.everyone).map((x) => {
      const knows = x.everyone ? 'everyone (no longer a secret)' : x.knows.map((p) => p.who + (p.how && p.how !== 'their secret' ? ' (' + p.how + (p.at !== Infinity ? ', reply ' + p.at : '') + ')' : '')).join(', ');
      return '- [' + x.name + '] ' + (x.owners && x.owners.length ? x.owners.join(' and ') + '’s secret: ' : '') + (x.text || '') + '\n  Knows: ' + (knows || 'not recorded') +
        (x.notKnows.length ? ' · Does NOT know: ' + x.notKnows.map((p) => p.who).join(', ') : '') +
        (x.cover ? ' · Cover story: ' + x.cover : '');
    }).concat(pub.length ? ['- No longer secret (everyone knows): ' + pub.map((x) => '[' + x.name + ']').join(', ')] : []).join('\n');
  }

  const factsMode = (chat) => chat && chat.format === 'facts';

  // "Choi" and "Ms. Choi" are the same person; "Mr. Kim" and "Ms. Kim" may not be.
  const TITLE_RE = /^(?:ms|mr|mrs|miss|mx|dr|prof|sir|madam|madame|lady|lord|director|manager|ceo|cfo|coo|cto|cmo|chairman|chairwoman|chair|vp|president|executive|producer|coach|teacher|officer|detective|agent|captain|inspector|constable|sheriff|sergeant|sgt|corporal|lieutenant|lt|major|colonel|col|general|gen|commander|admiral|marshal|king|queen|prince|princess|duke|duchess|count|countess|baron|baroness|emperor|empress|professor|doctor|nurse|judge|senator|minister|governor|mayor|priest|chief|commissioner)\.?\s+/i;
  function sameButTitle(a, b) {
    const ta = TITLE_RE.test(a);
    const tb = TITLE_RE.test(b);
    if (ta === tb) return false;
    return a.replace(TITLE_RE, '').trim().toLowerCase() === b.replace(TITLE_RE, '').trim().toLowerCase();
  }
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
      // Characters merge only on clear evidence: the same name, the same name
      // with a title ("Ms. Choi"), a first name and the full name ("Jacek" /
      // "Jacek Kowalski"), or one's full name (two or more words) as the
      // other's nickname when neither mentions the other (two people who do are not one person; the wrong
      // nickname is removed below).
      const person = (e.kind || 'character') === 'character';
      const firstAndFull = (a, b) => { const A = a.toLowerCase().split(/\s+/); const B = b.toLowerCase().split(/\s+/); return A.length !== B.length && (A.length < B.length ? B.slice(0, A.length).join(' ') === A.join(' ') : A.slice(0, B.length).join(' ') === B.join(' ')); };
      const twin = kept.find((x) => (x.kind || 'character') === (e.kind || 'character') &&
        (x.name.toLowerCase() === e.name.toLowerCase() || sameButTitle(x.name, e.name) ||
          ((keys.includes(x.name.toLowerCase()) || entryKeys(x).some((k) => k.toLowerCase() === e.name.toLowerCase())) &&
            // Two people who mention each other ("Relationships – Giselle: …") are not one person.
            (!person || (!mentions(e.text, x.name) && !mentions(x.text, e.name) && (x.name.trim().includes(' ') || e.name.trim().includes(' '))))) ||
          (person && firstAndFull(x.name, e.name))));
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
        if (!a || seen.has(k) || names.has(k) || aliasOfOther(kept, e, a)) return false;
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
          const block = f ? raw.slice(f.index + f[0].length) : '';
          // The facts format: one "Subject | kind | value" record per line.
          const records = parseRecords(block);
          let facts = records.length ? records.map((r) => r.s + ' — ' + r.label + (r.t ? ': ' + r.t : '') + ': ' + r.v).join(' | ')
            : block.replace(/\s*\n\s*[-*•]?\s*/g, ' | ').replace(/\s+/g, ' ').replace(/^[\s|]+|[\s|]+$/g, '').trim();
          if (/^(none|n\/?a|nothing( new)?|-+|—)\.?$/i.test(facts)) facts = '';
          // No facts: the keeper said so ("none"), or left the FACTS line out ("missing").
          if (reply && text) entries.push(Object.assign(facts ? { id: reply.id, text, facts } : { id: reply.id, text, nofacts: f ? 'none' : 'missing' }, records.length ? { records } : {}));
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
    // One section per title: a second one is usually the keeper's planning.
    for (let i = sections.length - 1; i >= 0; i--) if (sections.findIndex((x) => x.title.toLowerCase() === sections[i].title.toLowerCase()) < i) sections.splice(i, 1);
    sections.forEach((x) => { x.text = dropJunk(squashRepeats(x.text)).split('\n').filter((l) => !EMPTY_FACT_RE.test(l.replace(/^\(|\)$/g, ''))).join('\n').trim(); });
    for (let i = updates.length - 1; i >= 0; i--) if (TEMPLATE_NAME_RE.test(updates[i].name)) updates.splice(i, 1);
    updates.forEach((u) => {
      u.aliases = (u.aliases || []).filter((a) => !TEMPLATE_ALIAS_RE.test(a));
      const split = splitStates(dropEmpty(structuredOnly(squashRepeats(u.text))));
      u.text = split.text;
      u.states = split.states;
      if (!u.kind && !u.add) u.kind = guessKind(u.name, cast, u.text);
      if (!u.kind && u.add) u.newKind = guessKind(u.name, cast, u.text);
    });
    for (let i = updates.length - 1; i >= 0; i--) if (!updates[i].text && !updates[i].states.length) updates.splice(i, 1);
    entries.forEach((e) => { e.text = squashRepeats(e.text); if (e.facts) e.facts = squashRepeats(e.facts); });
    return { memory: squashRepeats(cleanOutput(memory)), sections, updates, entries: dedupeEntries(entries), cast };
  }

  // The story is "## Title" sections. Applies the keeper's changed sections:
  // an "add" section gets new lines at its end, any other replaces it.
  const SECTION_ORDER = ['story so far', 'current scene', 'open threads', 'world & timeline'];
  function applySections(memory, edits) {
    edits = edits.map((x) => Object.assign({}, x, { text: dropReasoning(x.text) })).filter((x) => x.text);
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
  function parallel() { return Math.min(MAX_PARALLEL, Math.max(1, Number(settings.parallel) || 1)); }
  const MAX_PARALLEL = 5; // helper chats used side by side (slots 0–4)

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
  // How many requests a run takes, for the progress count: summaries, story
  // updates (as many as the summaries' size needs), chapters, the older
  // chapters' short versions, portraits and a correction after redone replies.
  function estimate(chat, todo, force) {
    const summaries = chunk(todo, CHUNK_CHARS).length;
    const replies = todo.filter((m) => m.role === 'assistant').length;
    const unfolded = stages(chat).unfolded + replies;
    const recent = chat.log.slice(-20);
    const avg = recent.length ? recent.reduce((n, e) => n + (e.text || '').length, 0) / recent.length : 1500;
    const perFold = Math.max(1, Math.min(FOLD_MAX, Math.floor(FOLD_CHARS / Math.max(1, avg))));
    const folds = Math.ceil(unfolded / Math.min(perFold, Math.max(1, force || summaries > parallel() ? perFold : foldEvery())));
    const chapters = Math.floor((stages(chat).unchaptered + unfolded) / chapterSize());
    const facts = factsMode(chat);
    const after = chat.chapters.length + chapters;
    const shortened = chat.chapters.filter((c) => c.short).length;
    const shorts = facts && settings.momentsShown !== 'all' ? Math.max(0, after - FULL_CHAPTERS - shortened) : 0;
    const portraits = facts ? Math.min(force ? 8 : PORTRAITS_PER_UPDATE, Math.max(1, mainCharacters(chat).length)) : 0;
    const correction = (chat.stale || []).length ? 1 : 0;
    return { summaries, folds, chapters, shorts, portraits, total: summaries + folds + chapters + shorts + portraits + correction };
  }

  // Runs organize() and records what it fixed in the Activity list.
  function tidy(chat) {
    const fixes = cleanChat(chat).concat(organize(chat));
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
    if (busy[id] || compare.running || (!chat.enabled && !force)) return 'skipped';
    // A first read of the chat starts at its beginning: note the greeting.
    if (!chat.processedIds.length && !chat.log.length && msgs.length) chat.greetingId = greetingOf(msgs);
    if (factsMode(chat)) await ensureSetupCast(chat, msgs).catch((e) => { if (e.stopped) throw e; });
    let todo = unprocessed(chat, msgs);
    // The newest replies wait: the user often has them redone.
    const hold = Math.max(0, Number(settings.holdBack) || 0);
    if (hold) {
      const replies = msgs.filter((m) => m.role === 'assistant');
      if (replies.length >= hold) {
        let cut = msgs.indexOf(replies[replies.length - hold]);
        while (cut > 0 && msgs[cut - 1].role === 'user') cut--;
        todo = todo.filter((m) => msgs.indexOf(m) < cut);
      } else {
        todo = [];
      }
    }
    // Replies that changed after they were summarised (see overwritten()).
    // One of the newest (held back) replies is not summarised again yet: its
    // old summary goes now (that version no longer exists) and the new one is
    // summarised like any other reply once newer ones follow.
    const held = new Set(hold ? msgs.filter((m) => m.role === 'assistant').slice(-hold).map((m) => m.id) : []);
    const heldRedo = (chat.redo || []).filter((x) => held.has(x));
    if (heldRedo.length) {
      for (const e of chat.log) if (heldRedo.includes(e.id)) markStale(chat, e);
      forget(chat, heldRedo);
      chat.log = chat.log.filter((e) => !heldRedo.includes(e.id));
      chat.processedIds = chat.processedIds.filter((x) => !heldRedo.includes(x));
      chat.redo = chat.redo.filter((x) => !heldRedo.includes(x));
      logJob(chat, { kind: 'check', label: 'A held-back reply was redone: its old summary is removed, and the new version is summarised once newer replies follow', ok: true, ms: 0 });
    }
    const redo = (chat.redo || []).map((x) => msgs.find((m) => m.id === x && m.role === 'assistant')).filter(Boolean);
    const st = stages(chat);
    const foldDue = st.unfolded && (force || st.unfolded >= foldEvery() || !chat.memory.trim());
    const staleDue = (chat.stale || []).length && !(chat.redo || []).length;
    if (!todo.length && !redo.length && !foldDue && !staleDue && st.unchaptered < chapterSize()) return 'skipped';
    busy[id] = true;
    keepAwake(true);
    stopRequested[id] = false;
    activeChatId = id;
    chat.backlog = null;
    setStatus();
    const before = snapshot(chat);
    progress[id] = { done: 0, total: estimate(chat, todo, force).total, step: 'Starting…' };
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
      // 0. Changed replies get a new summary in place of the old one.
      if (redo.length) {
        const got = await job('summarise', 'Summarised ' + redo.length + ' changed repl' + (redo.length === 1 ? 'y' : 'ies') + ' again',
          () => summarise(chat, withPrompts(msgs, redo)));
        const ids = new Set(got.map((e) => e.id));
        for (const e of chat.log) if (ids.has(e.id)) markStale(chat, e);
        chat.log = chat.log.map((e) => (ids.has(e.id) ? Object.assign(got.find((g) => g.id === e.id), { folded: false, at: Date.now() }, SM_VERSION ? { v: SM_VERSION } : {}, e.chapter != null ? { chapter: e.chapter } : {}) : e));
        chat.redo = chat.redo.filter((x) => !redo.some((m) => m.id === x));
        await saveChat(chat);
      }
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
          const got = results[k].value.map((e) => Object.assign(e, { folded: false, at: Date.now() }, SM_VERSION ? { v: SM_VERSION } : {}));
          const ids = new Set(got.map((e) => e.id));
          // A regenerated or re-read reply replaces its old summary.
          for (const e of chat.log) if (ids.has(e.id)) markStale(chat, e);
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
        await foldAndChapter(chat, FOLD_MAX, job, true);
      }
      // 2 + 3. Fold what is due (all of it when asked, or for a new story),
      // then write the chapters that are complete.
      await foldAndChapter(chat, force || !chat.memory.trim() ? 1 : foldEvery(), job);
      // After a rebuild or a long catch-up: every older chapter's short version now.
      if (force || parts.length > parallel()) await shortenChapters(chat, job, Infinity);
      // The facts format: portraits of main characters that have grown.
      // (After a rebuild or "Update now", every main character that needs one.)
      if (factsMode(chat)) { try { await updatePortraits(chat, job, null, force ? 8 : PORTRAITS_PER_UPDATE); } catch (e) { if (e.stopped) throw e; } }
      // Short portraits of the other recurring characters (all after a rebuild, else one request at a time).
      if (factsMode(chat) && shortPortraitsDue(chat).length) { try { await writeShortPortraits(chat, job, force ? Infinity : 1); } catch (e) { if (e.stopped) throw e; } }
      // After a rebuild: the relationships, once.
      // The relationships: all after a rebuild; at each check-up, the pairs with new facts.
      if (factsMode(chat) && (force || chat.log.length - (chat.reconAt || 0) >= RECONCILE_EVERY)) {
        try { await job('update', force ? 'Wrote the relationships' : 'Updated the relationships with new facts', () => writeRelationships(chat, force, force ? Infinity : 2)); } catch (e) { if (e.stopped) throw e; }
      }
      // The check-up: after a rebuild, and every RECONCILE_EVERY replies.
      if (factsMode(chat) && (force || chat.log.length - (chat.reconAt || 0) >= RECONCILE_EVERY)) {
        try { const n = await job('check', 'Check-up of what is out of date', () => reconcileFacts(chat)); if (n) logJob(chat, { kind: 'check', label: 'Check-up: ' + n + ' fact' + (n === 1 ? '' : 's') + ' brought up to date', ok: true, ms: 0 }); } catch (e) { if (e.stopped) throw e; }
      }
      // 4. Replies that were deleted or redone after their facts went in:
      // take what only they said back out, and rewrite their chapters.
      if ((chat.stale || []).length && !(chat.redo || []).length) await correctAfterRedo(chat, job);
      tidy(chat);
      if (JSON.stringify(before) !== JSON.stringify(snapshot(chat))) {
        chat.history = [before].concat(chat.history).slice(0, 5);
      }
      await saveChat(chat);
      await refreshMemoryMessage(chat);
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

  // "Who they are now": for the main characters (the most facts), a short
  // portrait written from their facts, so the AI knows who they have become,
  // not only a list. Rewritten when a character has a quarter more facts than
  // when it was written (unless the user wrote it); at most PORTRAITS_PER_UPDATE
  // per update.
  const PORTRAIT_MIN_FACTS = 12;
  const PORTRAITS_PER_UPDATE = 2;
  // The cast named in the user's first message (the story setup): who is a character, and
  // who the main ones are. Only for Story Manager's own decisions; nothing of it is pinned.
  function castWords(n) { return String(n || '').toLowerCase().replace(/['’]s\b/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1); }
  function castOf(chat, e) {
    const cast = (chat.setupCast && chat.setupCast.cast) || [];
    const names = [e.name].concat(e.aliases || []).map((n) => castWords(n).join(' '));
    return cast.find((c) => { const k = castWords(c.name).join(' '); return k && names.some((n) => n && (n === k || k.split(' ').includes(n))); }) || null;
  }
  function mainCharacters(chat) {
    const byFacts = chat.entries.filter((e) => e.fromFacts && (e.kind || 'character') === 'character' && (e.records || 0) >= PORTRAIT_MIN_FACTS)
      .sort((a, b) => (b.records || 0) - (a.records || 0)).slice(0, 8);
    // The setup's main characters always count, once the story has said something about them.
    const fromSetup = chat.entries.filter((e) => e.fromFacts && (e.kind || 'character') === 'character' && (e.records || 0) >= 1 && (castOf(chat, e) || {}).main);
    return fromSetup.concat(byFacts.filter((e) => !fromSetup.includes(e)));
  }
  async function readSetupCast(chat, text) {
    const user = 'THE USER\'S FIRST MESSAGE (it sets up the story):\n<<<\n' + String(text).slice(0, 60000) + '\n>>>\n\n' +
      'JOB: CAST. List every person or character this message names (people only: never places, groups, companies, items or the setting). ' +
      'One per line, exactly "Name | main" for the central characters the story is about, or "Name | side" for the others. Use the name the message uses most. Output only the lines; "NONE" if there are none.';
    const out = cleanOutput(await callLLM(updateSystem(), user));
    checkStop();
    const cast = [];
    for (const l of out.split('\n')) {
      const m = l.replace(/^\s*[-*•\d.)]+\s*/, '').match(/^([^|]{2,60}?)\s*\|\s*(main|side)\b/i);
      if (m && !cast.some((c) => c.name.toLowerCase() === m[1].trim().toLowerCase())) cast.push({ name: m[1].trim().replace(/^["'*]+|["'*]+$/g, ''), main: /main/i.test(m[2]) });
    }
    return cast;
  }
  // Once per story (and again if the first message is edited): read the cast from it.
  async function ensureSetupCast(chat, msgs) {
    let first = firstUserMessage(chat, msgs);
    if (!first && !(chat.setupCast && chat.setupCast.text)) {
      // Reading the whole chat is slow on a long story: at most once a day when it fails.
      if (Date.now() - (chat.setupCastTried || 0) < 86400000) return;
      chat.setupCastTried = Date.now();
      try { first = firstUserMessage(chat, await fetchMessages(chat.id, { cache: false, mode: 'full' })); } catch (e) { return; }
    }
    if (!first) { if (!chat.setupCast) chat.setupCast = { text: '', cast: [] }; return; }
    const t = String(first.text || '').trim();
    if (chat.setupCast && chat.setupCast.text === t) return;
    try {
      const cast = t ? await readSetupCast(chat, t) : [];
      chat.setupCast = { text: t, cast, at: Date.now() };
      logJob(chat, { kind: 'update', label: 'Read the cast from your first message (' + cast.filter((c) => c.main).length + ' main, ' + cast.filter((c) => !c.main).length + ' others)', ok: true, ms: 0 });
    } catch (e) { if (e.stopped) throw e; } // (tried again next update)
  }
  // The user's first message: the first one in the chat, if the list starts at the chat's start.
  function firstUserMessage(chat, msgs) {
    const list = (msgs || []).filter((m) => m.role === 'user' || m.role === 'assistant');
    if (!list.length) return null;
    const startsAtStart = list[0].role === 'user' || list[0].id === chat.greetingId || list[0].id === greetingOf(msgs);
    if (!startsAtStart) return null;
    const u = list.find((m) => m.role === 'user' && String(m.text || '').replace(MEM_BLOCK_RE, '').trim());
    return u ? { id: u.id, text: String(u.text).replace(MEM_BLOCK_RE, '') } : null;
  }
  function portraitDue(chat, e) {
    const p = (chat.portraits || {})[e.name.toLowerCase()];
    return !p || (!p.manual && (e.records || 0) >= (p.records || 0) * 1.25);
  }
  async function writePortrait(chat, e) {
    const facts = e.text.replace(/### Who they are now\n[\s\S]*?(?=\n### |$)/, '').trim();
    const user = 'STORY NOW:\n<<<\n' + (sectionOf(chat.memory, 'Current Scene').trim() || '(not known)') + '\n>>>\n\n' +
      'EVERYTHING KNOWN ABOUT ' + e.name.toUpperCase() + ' (built from the story, oldest facts first):\n<<<\n' + facts.slice(-30000) + '\n>>>\n\n' +
      'JOB: PORTRAIT. Write who ' + e.name + ' is NOW, in 4 to 8 plain sentences of prose: their personality as it is now and how they have changed since the start, ' +
      'what they want and fear, how they act and talk, and where they stand with the people closest to them. Use only what the facts say; never invent. ' +
      'No headings, no lists, no notes. Output only the portrait.';
    const out = cleanOutput(await callLLM(updateSystem(), user));
    checkStop();
    const c = cleanSummary(out.replace(/^\s*[#*=].*$/gm, '').replace(/\s+/g, ' '));
    if (c.bad || c.text.length < 120) throw new Error('the memory keeper did not write a usable portrait of ' + e.name);
    return c.text;
  }
  // Short portraits for every recurring character who is not a main one, a few
  // characters per request: who they are, how they talk and act, what they want,
  // how they show affection; only what their facts show.
  const SHORT_PORTRAIT_MIN_FACTS = 6;
  const SHORT_PORTRAITS_PER_REQUEST = 6;
  function shortPortraitsDue(chat) {
    const main = new Set(mainCharacters(chat));
    return chat.entries.filter((e) => e.fromFacts && !main.has(e) && (e.kind || 'character') === 'character' && (e.records || 0) >= SHORT_PORTRAIT_MIN_FACTS && portraitDue(chat, e));
  }
  async function writeShortPortraits(chat, job, maxRequests = 1) {
    const due = shortPortraitsDue(chat);
    let n = 0;
    for (let i = 0, req = 0; i < due.length && req < maxRequests; i += SHORT_PORTRAITS_PER_REQUEST, req++) {
      checkStop();
      const batch = due.slice(i, i + SHORT_PORTRAITS_PER_REQUEST);
      const label = 'Wrote short portraits of ' + batch.map((e) => e.name).join(', ');
      const out = await job('update', label, async () => cleanOutput(await callLLM(updateSystem(),
        'CHARACTERS (everything known about each, built from the story):\n<<<\n' +
        batch.map((e) => '=== ' + e.name + ' ===\n' + e.text.replace(/### Who they are now\n[\s\S]*?(?=\n### |$)/, '').slice(-6000)).join('\n\n') + '\n>>>\n\n' +
        'JOB: SHORT PORTRAITS. For each character write 2 to 4 sentences of plain prose: their core personality, how they talk, how they typically act, what they want, and how they show affection. ' +
        'Use only what the facts show; if something is only suggested, say "seems". Where an experience changed them, say what changed. No lists, no headings inside.\n' +
        'Answer in exactly this form, for every character:\n=== PORTRAIT: Name ===\n(portrait)')));
      for (const part of out.split(/^\s*=+\s*PORTRAIT\s*:\s*/im).slice(1)) {
        const m = part.match(/^([^\n=]{1,60}?)\s*=*\s*\n([\s\S]*)$/);
        if (!m) continue;
        const e = batch.find((x) => x.name.toLowerCase() === m[1].trim().toLowerCase());
        const text = cleanSummary(m[2].replace(/^\s*[#*=].*$/gm, '').replace(/\s+/g, ' ')).text;
        if (!e || text.length < 60) continue;
        chat.portraits = chat.portraits || {};
        const prev = chat.portraits[e.name.toLowerCase()];
        if (prev && prev.manual) continue;
        if (prev && text.length < prev.text.length * 0.5) { prev.records = e.records || 0; continue; } // never a less informative one
        chat.portraits[e.name.toLowerCase()] = { text, at: Date.now(), records: e.records || 0, short: true };
        n++;
      }
      await saveChat(chat);
    }
    return n;
  }
  async function updatePortraits(chat, job, names, max = PORTRAITS_PER_UPDATE) {
    const todo = names ? names.map((n) => chat.entries.find((e) => e.name === n)).filter(Boolean)
      : mainCharacters(chat).filter((e) => portraitDue(chat, e)).slice(0, max);
    for (const e of todo) {
      checkStop();
      const text = await job('update', 'Wrote who ' + e.name + ' is now', () => writePortrait(chat, e));
      chat.portraits = chat.portraits || {};
      const prev = chat.portraits[e.name.toLowerCase()];
      // Never a less informative portrait (e.g. after a long absence): the fuller one stays.
      if (!names && prev && !prev.manual && text.length < prev.text.length * 0.5) prev.records = e.records || 0;
      else chat.portraits[e.name.toLowerCase()] = { text, at: Date.now(), records: e.records || 0 };
      await saveChat(chat);
    }
    return todo.length;
  }

  // "Shorten old chapters now" (all), and a few whenever a story is opened.
  async function runShortenChapters(id, max) {
    const chat = await getChat(id, true);
    if (!chaptersToShorten(chat) || busy[id]) return 'nothing';
    return withBusy(id, Math.min(max, chaptersToShorten(chat)), async () => {
      const job = async (kind, label, fn) => {
        const t0 = Date.now();
        setStep(id, label + '…');
        try { const r = await fn(); logJob(chat, { kind, label, ok: true, ms: Date.now() - t0 }); progress[id].done++; return r; }
        catch (e) { if (!e.stopped) logJob(chat, { kind, label, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200) }); throw e; }
      };
      try {
        await shortenChapters(chat, job, max);
        return 'done';
      } catch (e) {
        await saveChat(chat);
        if (max > SHORTEN_PER_UPDATE) toast(e.stopped ? 'Stopped. The short chapters written so far are kept.' : 'Could not shorten the chapters: ' + (e.message || e), !e.stopped);
        return e.stopped ? 'stopped' : 'failed';
      }
    });
  }

  // The relationships, once at the end of a rebuild (and with the button):
  // what each pair is to each other, plus a short note on how things stand.
  // The relationships: for each important pair, what they are, how they are
  // together, what shaped them and what they have agreed. Only pairs with new
  // facts are rewritten (with their previous description to build on), so the
  // list is consolidated, never appended to; "all" rewrites every pair.
  const REL_MIN_FACTS = 3;
  const REL_PER_REQUEST = 15;
  function relationPairs(chat) {
    const pairs = new Map();
    const recs = allRecords(chat);
    for (const r of recs) {
      if (!/^(relationship|stands)$/.test(r.k) || !r.t || isGeneric(r.t) || /,|\band\b/.test(r.t)) continue;
      const key = [r.s, r.t].map((x) => x.toLowerCase()).sort().join(' & ');
      const x = pairs.get(key) || { a: r.s, b: r.t, rel: [], stands: [], moments: [], count: 0 };
      if (r.k === 'stands') x.stands.push(r.s + ' about ' + r.t + ': ' + r.v + (r.at !== Infinity ? ' (reply ' + r.at + ')' : ''));
      else x.rel.push(r.s + ' → ' + r.t + ': ' + r.v + (r.at !== Infinity ? ' (reply ' + r.at + ')' : ''));
      x.count++;
      pairs.set(key, x);
    }
    for (const r of recs) {
      if (r.k !== 'moment') continue;
      for (const x of pairs.values()) {
        const other = r.s.toLowerCase() === x.a.toLowerCase() ? x.b : r.s.toLowerCase() === x.b.toLowerCase() ? x.a : null;
        if (other && new RegExp('\\b' + other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(r.v)) x.moments.push((r.tier ? r.tier + ': ' : '') + r.s + ' ' + r.v + (r.at !== Infinity ? ' (reply ' + r.at + ')' : ''));
      }
    }
    return pairs;
  }
  async function writeRelationships(chat, all, maxRequests = Infinity) {
    const pairs = relationPairs(chat);
    const old = new Map(((chat.relMap && chat.relMap.list) || []).map((x) => [[x.a, x.b].map((n) => n.toLowerCase()).sort().join(' & '), x]));
    const todo = [...pairs.entries()].filter(([k, x]) => x.count >= REL_MIN_FACTS && (all || !old.has(k) || x.count >= (old.get(k).count || 0) + REL_MIN_FACTS))
      .sort((a, b) => b[1].count - a[1].count);
    if (!todo.length) return [];
    const written = [];
    for (let i = 0, req = 0; i < todo.length && req < maxRequests; i += REL_PER_REQUEST, req++) {
      checkStop();
      const batch = todo.slice(i, i + REL_PER_REQUEST);
      const facts = batch.map(([k, x]) => {
        const prev = old.get(k);
        return '=== ' + x.a + ' & ' + x.b + ' ===\n' + (prev && prev.dynamic ? 'PREVIOUS DESCRIPTION: status: ' + prev.status + ' · dynamic: ' + prev.dynamic + ' · shaped by: ' + (prev.shaped || '') + ' · understandings: ' + (prev.understood || '') + '\n' : '') +
          'FACTS:\n' + x.rel.slice(-10).map((l) => '- ' + l).join('\n') + (x.stands.length ? '\n' + x.stands.slice(-3).map((l) => '- now: ' + l).join('\n') : '') +
          (x.moments.length ? '\nMOMENTS BETWEEN THEM:\n' + x.moments.slice(-8).map((l) => '- ' + l).join('\n') : '');
      }).join('\n\n').slice(-60000);
      const user = 'PAIRS (facts oldest first):\n<<<\n' + facts + '\n>>>\n\n' +
        'JOB: RELATIONSHIPS. For each pair, describe the relationship AS IT IS NOW, using only the facts (and building on the previous description, correcting what newer facts changed). Answer for every pair in exactly this form:\n' +
        '=== Name & Name ===\nStatus: what they are to each other and its state now (a few words: "girlfriend, close and trusting")\n' +
        'Dynamic: how they normally treat, talk to and behave around each other (one sentence)\nShaped by: the one or two experiences that changed them, each with what changed (one sentence)\n' +
        'Understandings: private agreements, promises, boundaries, habits or pet names between them ("none" if there are none)\n' +
        'Never describe a single scene as the dynamic. Never invent. No commentary.';
      const out = cleanOutput(await callLLM(updateSystem(), user));
      for (const part of out.split(/^\s*=+\s*/m)) {
        const head = part.match(/^([^\n=]{1,60}?)\s*&\s*([^\n=]{1,60}?)\s*=+\s*\n([\s\S]*)$/);
        if (!head) continue;
        const field = (n) => ((head[3].match(new RegExp('^\\s*[-*]?\\s*' + n + '\\s*:\\s*(.+)$', 'im')) || [])[1] || '').trim();
        const k = [head[1], head[2]].map((n) => n.trim().toLowerCase()).sort().join(' & ');
        const x = pairs.get(k);
        if (!x || !field('Status')) continue;
        const understood = field('Understandings');
        written.push({ a: x.a, b: x.b, status: field('Status'), dynamic: field('Dynamic'), shaped: field('Shaped by'), understood: /^(none|none stated|not stated|n\/?a|nothing)\.?$/i.test(understood) ? '' : understood, count: x.count, at: Date.now() });
      }
    }
    if (!written.length) throw new Error('the memory keeper did not write a usable list of relationships');
    for (const w of written) old.set([w.a, w.b].map((n) => n.toLowerCase()).sort().join(' & '), w);
    chat.relMap = { at: Date.now(), list: [...old.values()] };
    return written;
  }
  async function runRelationships(id) {
    const chat = await getChat(id, true);
    return withBusy(id, 1, async () => {
      const t0 = Date.now();
      setStep(id, 'Writing the relationships…');
      try {
        const list = await writeRelationships(chat, true);
        logJob(chat, { kind: 'update', label: 'Wrote the relationships (' + list.length + ')', ok: true, ms: Date.now() - t0 });
        await saveChat(chat);
        toast('Relationships written. The pinned message updates in a few seconds.');
        return 'done';
      } catch (e) {
        if (!e.stopped) logJob(chat, { kind: 'update', label: 'Writing the relationships', ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200) });
        await saveChat(chat);
        toast(e.stopped ? 'Stopped.' : 'Could not write the relationships: ' + (e.message || e), !e.stopped);
        return e.stopped ? 'stopped' : 'failed';
      }
    });
  }

  // The check-up: the keeper compares what is still listed as open (goals,
  // promises, where people are, who knows each secret) with the story now, and
  // says what is done, out of date or now known. Story Manager adds those as
  // facts; nothing is deleted (the full entries keep the history).
  const RECONCILE_EVERY = 10;
  // A step may cite a reply from shortly before its goal was written down (the keeper often records a goal a few replies late).
  const EVIDENCE_GAP = 3;
  const GOALS_PER_CHECK = 25;
  // A check-up "done" or "cancelled" for a goal must show its evidence: a quote that really is in
  // the summary of the reply it cites, and that names the other people the goal is about (a
  // completion involves them). Returns why it is refused, or ''.
  // First names (and aliases) of the story's characters, lower-case.
  function knownPeople(chat) {
    const out = new Set();
    for (const c of (chat.setupCast && chat.setupCast.cast) || []) for (const w of castWords(c.name)) out.add(w);
    for (const e of chat.entries || []) {
      if ((e.kind || 'character') !== 'character') continue;
      for (const n of [e.name].concat(e.aliases || [])) for (const w of String(n || '').split(/\s+/)) if (w.length > 1) out.add(w.toLowerCase().replace(/['’]s$/, ''));
    }
    return out;
  }
  function closureProblem(chat, r, line) {
    const nm = commitName(r.v);
    const c = nm && (chat.commitReg || []).find((x) => secretKeyOf(x.id) === secretKeyOf(nm) || (x.names || []).includes(secretKeyOf(nm)));
    if (!c) return '';
    const q = (String(line).match(/quote:\s*["“]([^"”]{8,})["”]/i) || [])[1];
    if (!q) return 'no quote from the reply as evidence';
    const n = evidenceReply(line);
    const e = chat.log[n - 1];
    if (!e || !normValue(e.text).includes(normValue(q))) return 'the quote is not in that reply';
    const owner = String(c.who || c.owner || '').toLowerCase();
    const said = (q + ' ' + commitText(r.v)).toLowerCase(); // (not the [name], which may mention them)
    // The other people the goal is about: only known characters (not places or things), and
    // they may be named anywhere in the cited reply, not only in the short quote.
    // A capitalised word with no entry counts as a person unless it reads like a place or thing
    // ("from the Hongdae market", "Bay 3", "at Lotte").
    const people = knownPeople(chat);
    const things = new Set((chat.entries || []).filter((x) => (x.kind || 'character') !== 'character').flatMap((x) => String(x.name || '').toLowerCase().split(/\s+/)));
    const looksLikePlace = (w) => new RegExp('\\b(the|at|in|from|on|near|inside)\\s+' + w + '\\b|\\b' + w + '\\s+(\\d|street|market|station|building|hall|park|bay|district|cafe|café|bar|restaurant|hotel|mall|tower|university)', 'i').test(c.text);
    const PLACE_WORD = /^(street|market|station|building|hall|park|bay|district|cafe|café|bar|restaurant|hotel|mall|tower|university|square|garden|gardens|bridge|river|lake|mountain|temple|palace|castle|village|city|town)$/i;
    const isPerson = (w) => people.has(w.toLowerCase()) || (!things.has(w.toLowerCase()) && !PLACE_WORD.test(w) && !looksLikePlace(w));
    const others = (String(c.text).match(/\b[A-Z][\p{L}'’-]{2,}\b/gu) || []).map((w) => w.replace(/['’]s$/, '')).filter((w, i, a) => a.indexOf(w) === i && w.toLowerCase() !== owner && !/^(I|The|A|An|He|She|They|His|Her|Their|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(w) && isPerson(w));
    const replyText = (said + ' ' + String(e.text || '')).toLowerCase();
    const missing = others.find((w) => !replyText.includes(w.toLowerCase()));
    if (missing) return 'the evidence does not mention ' + missing + ', whom the goal is about';
    // …and it must be about the same thing: at least one of the goal's own words (not a name).
    const stem = (w) => w.slice(0, 4);
    const goalWords = new Set([...sigWords(c.text)].filter((w) => !others.some((o) => o.toLowerCase() === w) && w !== owner).map(stem));
    const evWords = new Set([...sigWords(said)].map(stem));
    if (goalWords.size && ![...goalWords].some((w) => evWords.has(w))) return 'the evidence is not about this goal';
    return '';
  }
  // The reply a check-up line cites: "(reply 12)", or the newest of "(reply 51, 265)" / "(replies 3 and 9)".
  const evidenceReply = (line) => { const m = String(line).match(/\(repl(?:y|ies)\s+([\d\s,and&–-]+)\)/i); if (!m) return NaN; const ns = (m[1].match(/\d+/g) || []).map(Number); return ns.length ? Math.max(...ns) : NaN; };
  async function reconcileFacts(chat, options) {
    const opts = options || {};
    const runId = 'c' + Date.now().toString(36);
    const at = chat.log.length;
    const recs = allRecords(chat);
    const open = [];
    for (const e of chat.entries.filter((x) => (x.kind || 'character') === 'character')) {
      const lines = (e.pinText || e.text).split('\n').filter((l) => /^- (Goal|Promise)( \[[^\]]*\])?( \([^)]*\))?:|^- (Lives \/ based|Role):/.test(l));
      if (lines.length) open.push(e.name + '\n' + lines.map((l) => '  ' + l).join('\n'));
    }
    const secrets = (chat.__secrets || buildSecrets(chat)).map((x) => '[' + x.name + '] ' + x.text + ' — knows: ' + (x.everyone ? 'everyone' : x.knows.map((k) => k.who).join(', ') || 'nobody listed'));
    if (!open.length && !secrets.length) return 0;
    const recent = chat.log.slice(-8).map((e, i) => '[reply ' + (at - Math.min(8, at) + i + 1) + '] ' + e.text).join('\n\n');
    // Older evidence: the replies where each secret and open goal or promise was
    // recorded (so a confession far back can still be seen), and the chapters.
    const shownIds = new Set(chat.entries.flatMap((e) => e.recordIds || []));
    const wantAt = [...new Set(recs.filter((r) => r.at !== Infinity && !r.recon && r.at <= at - 8 && (/^(secret|knows|notknows)$/.test(r.k) || (/^(goal|promise)$/.test(r.k) && shownIds.has(r.id)))).map((r) => r.at))].sort((a, b) => a - b);
    let older = '';
    for (const n of wantAt) { const e = chat.log[n - 1]; if (!e) continue; const t = '[reply ' + n + '] ' + e.text + '\n\n'; if (older.length + t.length > 40000) break; older += t; }
    const chapters = (chat.chapters || []).map((c, i) => 'Chapter ' + (i + 1) + ': ' + cleanChapterText(c.short || c.text)).join('\n').slice(-20000);
    const user = 'THE STORY NOW:\n<<<\n' + (chat.memory.trim() || '(empty)') + '\n>>>\n\nTHE STORY SO FAR (chapters):\n<<<\n' + chapters + '\n>>>\n\n' +
      (older ? 'OLDER REPLIES WHERE THE OPEN ITEMS AND SECRETS WERE RECORDED (summaries):\n<<<\n' + older + '\n>>>\n\n' : '') +
      'THE LATEST REPLIES (summaries):\n<<<\n' + recent.slice(-30000) + '\n>>>\n\n' +
      'STILL LISTED AS OPEN:\n<<<\n' + open.join('\n').slice(-30000) + '\n>>>\n\nSECRETS AND WHO KNOWS THEM:\n<<<\n' + secrets.join('\n').slice(-15000) + '\n>>>\n\n' +
      'JOB: CHECK-UP. Using only what the texts above show, list ONLY real changes, one per line, each ending with the reply that shows it as "(reply N)":\n' +
      '- "- Person | progress | [its short name] what step was taken (reply N)" when it was scheduled, confirmed, agreed, promised again or partly done — these are never "done".\n' +
      '- "- Person | done | [its short name as listed] what happened (reply N) quote: \"words copied exactly from that reply\'s summary\"" only when the thing itself happened or was kept, dropped or replaced. Not when planning for it moved on, it is underway or still ahead (a party in 20 days is not done because its plan is locked), and never because it is not mentioned. Also, for a plan set for a day or time the story has clearly passed (a lunch "tomorrow at 1 PM" when the story is days later) that never happened: "- Person | postponed | [its short name] the day passed and it never happened (reply N)" with the reply that shows the later day; "- Person | cancelled | [its short name] why (reply N)" only when the story shows it was dropped.\n' +
      '- "- Person | location | their new home or base (reply N)" only when they moved house; never where they are at the moment (that is the scene). "- Person | role | new role (reply N)" only when their job or role changed.\n' +
      '- "- Person | knows | [exact listed secret name] how they learned it (reply N)" only for a person NOT already listed as knowing it, who clearly learned it (told, confessed to, overheard, said in the group chat; "Everyone" when everyone knows).\n' +
      '- "- [secret name] = [other secret name]" when two listed secrets are the same secret (use the listed names exactly).\n' +
      '- "- [goal name] = [other goal name]" when two goals or promises listed for the SAME person are one and the same commitment. Never for two that differ in when, where or with whom (a visit on Monday and a visit on Friday are two).\n' +
      'Never write lines that change nothing (no "already knows", "still open", "no change"). Never guess or invent. Write "none" if nothing changed. Output only those lines.';
    const keyOfName = (n) => normValue(n).split(' ').filter((w) => w && !STOP_WORDS.has(w) && !/^(on|of|to|a|an|in|at|by|is|my|me)$/.test(w)).sort().join(' ');
    const out1 = cleanOutput(await callLLM(updateSystem(), user));
    // The secrets on their own (one focused question works better): for each,
    // the reply where it was recorded; who knows it, and which are the same.
    let out2 = '';
    const secs = chat.__secrets || buildSecrets(chat);
    if (secs.length) {
      const firstAt = (x) => { const r = recs.find((y) => y.k === 'secret' && !y.recon && y.at !== Infinity && (y.v.match(/\[([^\]]+)\]/) || [])[1] && keyOfName((y.v.match(/\[([^\]]+)\]/) || [])[1]) === keyOfName(x.name)); return r ? r.at : 0; };
      let ev = '';
      const lines = secs.map((x) => {
        const n = firstAt(x);
        const e = n ? chat.log[n - 1] : null;
        if (e && ev.length < 45000) ev += '[reply ' + n + '] ' + e.text + '\n\n';
        return '[' + x.name + '] ' + (x.owners && x.owners.length ? x.owners.join(' and ') + '\'s secret: ' : '') + x.text + ' — recorded in reply ' + (n || '?') + ' — listed as knowing: ' + (x.everyone ? 'everyone' : x.knows.map((k) => k.who).join(', ') || 'nobody');
      });
      const user2 = 'SECRETS:\n<<<\n' + lines.join('\n') + '\n>>>\n\nTHE REPLIES WHERE THEY WERE RECORDED (summaries):\n<<<\n' + ev + '\n>>>\n\nTHE LATEST REPLIES (summaries):\n<<<\n' + recent.slice(-20000) + '\n>>>\n\n' +
        'JOB: SECRETS CHECK. For each secret, who really knows it? Think of the person it was confided to, revealed to, or who was part of it (e.g. a secret someone showed or confessed to another character: that character knows it).\n' +
        '- "- Person | knows | [exact secret name] how they know (reply N)" for each person who knows a secret but is not listed as knowing it.\n' +
        '- "- [secret name] = [other secret name]" for two listed secrets that are the same secret (the same fact about the same person, worded differently, or one is a later step of the other, e.g. wanting something and then saying yes to it). Check every secret of the same person against each other.\n' +
        'Only what the texts show; never guess. Write "none" if nothing is missing. Output only those lines.';
      out2 = cleanOutput(await callLLM(updateSystem(), user2));
    }
    let levelsAnswer = '';
    // Levels for goals written without one (older summaries): one request, up to 100 at a time.
    // (Goals labelled before "arrangement" existed are asked about once more.)
    const levelless = commitState(chat).reg.filter((c) => !c.levelFromRecord && (!(chat.commitTier || {})[c.id] || !chat.commitTierV2) && c.state !== 'done' && c.state !== 'cancelled').slice(0, 100);
    if (levelless.length) {
      const userL = 'GOALS, PROMISES AND UPCOMING EVENTS:\n' + levelless.map((c) => '[' + c.id + '] ' + (c.who || c.owner) + ': ' + c.text).join('\n') + '\n\n' +
        'JOB: LEVELS. For each, how much it matters for the story: major (matters for the whole story: a life goal, a quest, a vow, a mystery), minor (matters for a while: a date, a plan for the coming days), routine (over within a scene: fetch a drink, go to class now), or arrangement (not something to do but a standing agreement, rule or signal between people, e.g. a code word, a house rule), or none (not a commitment at all: a joke, a passing remark, a wish, or something already done when it was said). One line each: "[id] major" / "[id] minor" / "[id] routine" / "[id] arrangement" / "[id] none". When unsure, minor.';
      const outL = cleanOutput(await callLLM(updateSystem(), userL));
      levelsAnswer = outL;
      const tiers = Object.assign({}, chat.commitTier);
      for (const l of outL.split('\n')) { const m = l.match(/\[([^\]]+)\]\s*[:\-–]?\s*(major|minor|routine|arrangement|none)\b/i); if (m && levelless.some((c) => c.id === m[1].trim())) tiers[m[1].trim()] = m[2].toLowerCase(); }
      chat.commitTier = tiers;
      if (!commitState(chat).reg.some((c) => !c.levelFromRecord && !tiers[c.id] && c.state !== 'done' && c.state !== 'cancelled')) chat.commitTierV2 = true;
    }
    // The goals check (third request): the oldest open goals, promises and upcoming events not
    // checked lately, each with the later summaries that mention its person and its words, asked
    // one by one: done, cancelled, postponed, progress or still open — with the reply that shows it.
    let out3 = '';
    const reg = commitState(chat).reg.filter((c) => c.state !== 'done' && c.state !== 'cancelled' && (c.at || 0) <= at - 3);
    const checked = chat.commitChecked || {};
    const rank = (c) => (c.stale ? 3 : c.level === 'major' ? 0 : c.level === 'minor' ? 1 : 2);
    // Automatic check-ups look at GOALS_PER_CHECK goals; one asked for by hand looks at all of them, in batches.
    const dueAll = reg.filter((c) => c.level !== 'none' && (opts.allGoals || !checked[c.id] || checked[c.id] <= at - 30)).sort((a, b) => rank(a) - rank(b) || (a.at || 0) - (b.at || 0));
    const batchesG = [];
    for (let i = 0; i < dueAll.length && (opts.allGoals || i < GOALS_PER_CHECK); i += GOALS_PER_CHECK) batchesG.push(dueAll.slice(i, i + GOALS_PER_CHECK));
    chat.commitChecked = Object.assign({}, checked);
    for (const due of batchesG) {
      checkStop();
      let ev = '';
      const used = new Set();
      const blocks = due.map((c) => {
        const w = sigWords(c.text);
        const later = chat.log.map((e, i) => ({ e, n: i + 1 })).filter((x) => x.n > (c.at || 0) && String(x.e.text).toLowerCase().includes(String(c.who || c.owner).toLowerCase()))
          .map((x) => { let m = 0; const o = sigWords(x.e.text); for (const a of w) if (o.has(a)) m++; return Object.assign(x, { score: m }); })
          .filter((x) => x.score >= 2).sort((a, b) => b.score - a.score).slice(0, 3);
        for (const x of later) if (!used.has(x.n) && ev.length < 40000) { used.add(x.n); ev += '[reply ' + x.n + '] ' + x.e.text + '\n\n'; }
        return '[' + c.id + '] ' + (c.who || c.owner) + ' — ' + (c.kind === 'scheduled' ? 'upcoming: ' : c.kind === 'promise' ? 'promise: ' : 'goal: ') + c.text + ' (since reply ' + (c.at || '?') + ')' +
          (later.length ? ' — see replies ' + later.map((x) => x.n).join(', ') : ' — not mentioned again');
      });
      const user3 = 'OPEN GOALS, PROMISES AND UPCOMING EVENTS:\n<<<\n' + blocks.join('\n') + '\n>>>\n\nLATER REPLIES (summaries):\n<<<\n' + ev + '\n>>>\n\n' +
        'JOB: GOALS CHECK. For each listed one, using only the replies above, write one line if something changed:\n' +
        '- "- Person | done | [exact id] what happened (reply N) quote: \"words copied exactly from that reply\"" only when the reply shows it actually happened or was kept.\n' +
        '- "- Person | cancelled | [exact id] why (reply N) quote: \"words copied exactly from that reply\"" when it was dropped or broken; "- Person | postponed | [exact id] to when (reply N)"; "- Person | progress | [exact id] the step (reply N)".\n' +
        '- "- [id] = [other id]" when two listed ones of the SAME person are one and the same commitment.\n' +
        'Talking about it, planning it, agreeing to it or being reminded of it is not done. But when the reply shows it FINISHED (carried out, paid, delivered, attended, kept), write done — never progress. Nothing for ones that are still open. Never guess. Output only those lines, or "none".';
      out3 += (out3 ? '\n' : '') + cleanOutput(await callLLM(updateSystem(), user3));
      for (const c of due) chat.commitChecked[c.id] = at;
    }
    const out = out1 + (out2 ? '\n' + out2 : '') + (out3 ? '\n' + out3 : '');
    const got = [];
    const alias = Object.assign({}, chat.secretAlias || {});
    // A report of what the keeper said and what was done with it (Diagnostics).
    const applied = [], skipped = [];
    const have = new Set((chat.reconRecords || []).map((r) => [r.s, r.k, normValue(r.v)].join('|').toLowerCase()));
    for (const l of out.split('\n')) {
      const line = l.trim();
      if (!line || /^none\.?$/i.test(line)) continue;
      const same = line.match(/\[([^\]]{1,60})\]\s*=\s*\[([^\]]{1,60})\]/);
      // Two listed goals that are one: merged by id (never across people).
      const goalIds = new Set((chat.commitReg || []).map((c) => c.id));
      if (same && goalIds.has(same[1].trim()) && goalIds.has(same[2].trim())) {
        const ga = chat.commitReg.find((c) => c.id === same[1].trim()), gb = chat.commitReg.find((c) => c.id === same[2].trim());
        if (ga.owner !== gb.owner) skipped.push([line, 'goals of different people']);
        else if ((chat.commitAlias || {})[gb.id] === ga.id) skipped.push([line, 'already merged']);
        else { chat.commitAlias = Object.assign({}, chat.commitAlias, { [gb.id]: ga.id }); applied.push(line); }
        continue;
      }
      if (same) {
        if (keyOfName(same[1]) === keyOfName(same[2])) skipped.push([line, 'already the same name']);
        else if (alias[keyOfName(same[2])] === same[1].trim()) skipped.push([line, 'already merged']);
        else if ((() => { const own = (n) => ((chat.__secrets || []).find((x) => keyOfName(x.name) === keyOfName(n)) || {}).owners || []; const o1 = own(same[1]).map((w) => w.toLowerCase()), o2 = own(same[2]).map((w) => w.toLowerCase()); return o1.length && o2.length && !o1.some((w) => o2.includes(w)); })()) skipped.push([line, 'secrets of different people']);
        else { alias[keyOfName(same[2])] = same[1].trim(); applied.push(line); }
        continue;
      }
      const recs = parseRecords(line);
      if (!recs.length) { skipped.push([line, 'not a fact line']); continue; }
      for (const r of recs) {
        const key = [r.s, r.k, normValue(r.v)].join('|').toLowerCase();
        const sec = r.k === 'knows' ? (chat.__secrets || []).find((x) => { const m = r.v.match(/\[([^\]]+)\]/); return m && keyOfName(x.name) === keyOfName(alias[keyOfName(m[1])] || m[1]); }) : null;
        if (!/^(done|cancelled|postponed|progress|role|location|knows)$/.test(r.k)) skipped.push([line, 'kind "' + (r.label || r.k) + '" is not a check-up correction']);
        else if (!(evidenceReply(line) <= at)) skipped.push([line, 'no reply given as evidence']);
        else if (r.k === 'done' && NOT_DONE_RE.test(r.v)) skipped.push([line, 'says it is not done']);
        else if (r.k === 'done' && isIntent(commitText(r.v))) skipped.push([line, 'a plan, not something done']);
        else if (r.k === 'knows' && NO_NEWS_RE.test(r.v)) skipped.push([line, 'nothing new']);
        else if (r.k === 'knows' && !sec) skipped.push([line, 'no such secret']);
        else if (r.k === 'knows' && (sec.everyone || sec.knows.some((k) => k.who.toLowerCase() === r.s.toLowerCase()))) skipped.push([line, 'already listed as knowing']);
        else if ((r.k === 'location' || r.k === 'role') && NOT_HOME_RE.test(r.v)) skipped.push([line, 'where they are now, not a home or role']);
        else if (/^(done|cancelled)$/.test(r.k) && closureProblem(chat, r, line)) skipped.push([line, closureProblem(chat, r, line)]);
        else if (/^(done|cancelled|postponed|progress)$/.test(r.k) && (() => { const nm = commitName(r.v); const c = nm && (chat.commitReg || []).find((x) => secretKeyOf(x.id) === secretKeyOf(nm) || (x.names || []).includes(secretKeyOf(nm))); const n = evidenceReply(line); return c && c.at && (r.k === 'progress' ? n < c.at - EVIDENCE_GAP : n <= c.at); })()) skipped.push([line, 'the evidence is from before the goal existed']);
        else if (have.has(key)) skipped.push([line, 'already applied before']);
        else { have.add(key); got.push(Object.assign(r, { at, run: runId })); applied.push(line); }
      }
    }
    chat.reconReport = { at: Date.now(), open: open.length, secrets: secrets.length, answer: out.slice(0, 6000), applied, skipped, levels: levelsAnswer.slice(0, 4000) };
    chat.reconRecords = (chat.reconRecords || []).concat(got);
    chat.lastReconRun = runId;
    chat.secretAlias = alias;
    chat.reconAt = at;
    return got.length;
  }
  // Step B: "Sort unsorted facts". Only when the user asks. Small batches (at most
  // SORT_BATCH facts and SORT_CHARS characters of input, each source summary
  // once); after every batch the decisions are saved, so a stopped run goes on
  // where it stopped. Facts already decided are skipped; "unsure" ones get one
  // more try.
  const SORT_BATCH = 40;
  const SORT_CHARS = 14000;
  function sortCandidates(chat) {
    const all = chat.sortings || {};
    return factQuality(chat).filter((x) => /^(no-secret|unresolved|unclassified|intent-not-done|unmatched-done|suspect-state)$/.test(x.status) &&
      !x.r.manual && !x.r.recon && x.r.at !== Infinity && !x.r.keptAsIs &&
      (() => { const d = all[sortKey(String(x.r.id).split('#')[0], x.r)]; // (Decisions made under older rules — no "rule" mark — that were unsure or failed get one try under the current ones.)
      return !d || !decisionValid(d) || (d.decision === 'unsure' && (d.tries || 1) < 2) || (!d.rule && (d.decision === 'unsure' || d.decision === 'failed')); })());
  }
  async function sortFacts(chat, job) {
    const todo = sortCandidates(chat);
    if (!todo.length) return { sorted: 0, batches: 0 };
    const keys = new Set();
    for (const r of allRecords(chat)) if (r.k === 'secret') { const m = String(r.v).match(/^\s*\[([^\]]+)\]/); if (m) keys.add(secretKeyOf(m[1])); }
    const secretNames = [...new Set(allRecords(chat).filter((r) => r.k === 'secret').map((r) => (String(r.v).match(/^\s*\[([^\]]+)\]/) || [])[1]).filter(Boolean))];
    const goals = commitState(chat).reg;
    // Batches: facts of the same reply together; each summary once.
    const byReply = new Map();
    for (const x of todo) { const rep = String(x.r.id).split('#')[0]; if (!byReply.has(rep)) byReply.set(rep, []); byReply.get(rep).push(x); }
    const batches = [];
    let cur = { facts: [], chars: 0 };
    for (const [rep, facts] of byReply) {
      const e = chat.log.find((l) => l.id === rep);
      const size = (e ? e.text.length : 0) + facts.reduce((n, x) => n + String(x.r.v).length + 40, 0);
      if (cur.facts.length && (cur.facts.length + facts.length > SORT_BATCH || cur.chars + size > SORT_CHARS)) { batches.push(cur); cur = { facts: [], chars: 0 }; }
      cur.facts.push(...facts.slice(0, SORT_BATCH));
      cur.chars += size;
    }
    if (cur.facts.length) batches.push(cur);
    let sorted = 0;
    const batchId = 'b' + Date.now().toString(36);
    for (let bi = 0; bi < batches.length; bi++) {
      checkStop();
      const b = batches[bi];
      const replies = [...new Set(b.facts.map((x) => String(x.r.id).split('#')[0]))];
      const src = new Map(replies.map((rep, i) => [rep, { tag: 'S' + (i + 1), text: (chat.log.find((l) => l.id === rep) || {}).text || '' }]));
      const people = new Set(b.facts.map((x) => String(x.r.s).trim().toLowerCase()));
      const goalLines = goals.filter((g) => people.has(g.owner) && g.state !== 'done' && g.state !== 'cancelled').map((g) => (g.who || g.owner) + ': [' + g.id + '] ' + g.text);
      const user = 'SOURCE SUMMARIES:\n<<<\n' + [...src.values()].map((x) => '[' + x.tag + '] ' + x.text).join('\n\n') + '\n>>>\n\n' +
        (secretNames.length ? 'SECRETS (by name): ' + secretNames.map((n) => '[' + n + ']').join(', ') + '\n\n' : '') +
        (goalLines.length ? 'OPEN GOALS AND PROMISES:\n' + goalLines.join('\n') + '\n\n' : '') +
        'FACTS TO SORT (each was filed under a kind that does not fit):\n' + b.facts.map((x, i) => 'F' + (i + 1) + ' (' + src.get(String(x.r.id).split('#')[0]).tag + ') ' + x.r.s + ' | ' + (x.r.label || x.r.k) + (x.r.t ? ': ' + x.r.t : '') + ' | ' + x.r.v).join('\n') + '\n\n' +
        'JOB: SORT FACTS. For each fact F#, choose its right kind using only its source summary. Do not add anything the summary does not say; keep the fact\'s meaning and wording close; never turn one action into a lasting trait. One line per fact:\n' +
        'F# | kind | the fact | quote: "words copied exactly from its source summary"\n' +
        'Kinds: moment major / moment minor / moment routine (something that happened) · learned (non-secret knowledge) · knows ([secret name] from SECRETS) · stands: Other Person (how things are between them now — never a scene) · progress ([goal] a step towards it) · done ([goal] it actually happened) · want (a wish or interest) · personality (a lasting trait, shown more than once) · keep (the original kind was right) · drop (not worth keeping) · unsure.\n' +
        'A quote is required for personality, stands and done. When in doubt, write unsure.';
      const out = cleanOutput(await job('sort', 'Sorting facts, batch ' + (bi + 1) + ' of ' + batches.length, () => callLLM(updateSystem(), user)));
      const seen = new Set();
      const answers = new Map();
      for (const l of out.split('\n')) {
        const m = l.match(/^\s*[-*•]?\s*F(\d+)\s*\|\s*([^|]+?)\s*\|\s*(.+?)(?:\s*\|\s*quote:\s*["“]?(.+?)["”]?\s*)?$/i);
        if (!m) continue;
        const n = Number(m[1]);
        if (seen.has(n)) { answers.set(n, null); continue; } // the same fact twice: not used
        seen.add(n);
        answers.set(n, { kind: m[2], value: m[3], quote: m[4] || '' });
      }
      const ctx = { secretKeys: keys, goals };
      chat.sortings = Object.assign({}, chat.sortings);
      b.facts.forEach((x, i) => {
        const rep = String(x.r.id).split('#')[0];
        const key = sortKey(rep, x.r);
        const a = answers.get(i + 1);
        const prev = chat.sortings[key];
        const res = !a ? { decision: 'unsure', why: a === null ? 'answered twice' : 'no answer' } : judgeSorting(x, a, src.get(rep).text, ctx);
        chat.sortings[key] = { key, reply: rep, s: String(x.r.s).trim().toLowerCase(), k: x.r.k, v: x.r.v, status: x.status, to: res.to || null, decision: res.decision, why: res.why, batch: batchId + '-' + (bi + 1), at: Date.now(), tries: (prev && prev.tries || 0) + 1, answer: a ? (a.kind + ' | ' + a.value + (a.quote ? ' | quote: "' + a.quote + '"' : '')).slice(0, 600) : '', rule: 2 };
        if (res.decision === 'sorted') sorted++;
      });
      await saveChat(chat);
    }
    return { sorted, batches: batches.length };
  }
  // Undo: one fact, one batch, or all. The originals were never changed.
  function undoSortings(chat, which) {
    const all = Object.assign({}, chat.sortings || {});
    for (const [k, d] of Object.entries(all)) if (which.all || (which.key && k === which.key) || (which.batch && String(d.batch).startsWith(which.batch))) delete all[k];
    chat.sortings = all;
  }
  function sortingCounts(chat) {
    const c = { sorted: 0, dropped: 0, kept: 0, unsure: 0, failed: 0 };
    for (const d of Object.values(chat.sortings || {})) c[d.decision] = (c[d.decision] || 0) + 1;
    return c;
  }
  async function runSortFacts(id) {
    const chat = await getChat(id, true);
    return withBusy(id, 1, async () => {
      const t0 = Date.now();
      const job = async (kind, label, fn) => { setStep(id, label + '…'); const t = Date.now(); try { const r = await fn(); logJob(chat, { kind, label, ok: true, ms: Date.now() - t }); return r; } catch (e) { if (!e.stopped) logJob(chat, { kind, label, ok: false, ms: Date.now() - t, error: String(e.message || e).slice(0, 200) }); throw e; } };
      try {
        const r = await sortFacts(chat, job);
        logJob(chat, { kind: 'sort', label: 'Sorted ' + r.sorted + ' facts in ' + r.batches + ' batches', ok: true, ms: Date.now() - t0 });
        await saveChat(chat);
        const c = sortingCounts(chat);
        toast('Sorted ' + r.sorted + ' facts. Dropped ' + c.dropped + ', unsure ' + c.unsure + ', failed checks ' + c.failed + '. Nothing was deleted.');
        return 'done';
      } catch (e) {
        await saveChat(chat);
        toast(e.stopped ? 'Stopped. Pressing the button again goes on where it stopped.' : 'Sorting stopped: ' + (e.message || e) + '. Pressing the button again goes on where it stopped.', !e.stopped);
        return e.stopped ? 'stopped' : 'failed';
      }
    });
  }

  // Keeper test (A/B): the same replies summarised with the current fact rules
  // (A) and the compact ones (B). Read-only: nothing in the story's memory,
  // sortings, goals or processing changes; the result is kept separately.
  // 10 early, 10 middle and 10 late replies, 3 per request, identical input
  // for both. Scores: right-kind share, how much each extracts (coverage of
  // the names in the story's own summary of each reply), serious errors.
  const KEEPER_TEST_EACH = 10;
  const keeperTestCache = {};
  async function keeperTest(chat, job, mode = 'rules') {
    const all = await fetchMessages(chat.id, { mode: 'full' });
    const replies = all.filter((m) => m.role === 'assistant' && m.id !== chat.greetingId && chat.log.some((e) => e.id === m.id));
    if (replies.length < 6) throw new Error('The story needs more replies for a keeper test.');
    const n = Math.min(KEEPER_TEST_EACH, Math.floor(replies.length / 3));
    const mid = Math.floor(replies.length / 2) - Math.floor(n / 2);
    const picks = [].concat(replies.slice(0, n), replies.slice(mid, mid + n), replies.slice(-n));
    const parts = { early: replies.slice(0, n), middle: replies.slice(mid, mid + n), late: replies.slice(-n) };
    const names = chat.entries.map((e) => e.name + (e.aliases && e.aliases.length ? ' (' + e.aliases.join(', ') + ')' : ''));
    const batches = [];
    for (const [part, list] of Object.entries(parts)) for (let i = 0; i < list.length; i += 3) batches.push({ part, replies: list.slice(i, i + 3) });
    const result = { at: Date.now(), story: chat.id.slice(0, 8), replies: picks.length, variants: {}, mode };
    // The context normal processing sends with each request: the current scene and the open goals.
    const scene = sectionOf(chat.memory, 'Current Scene').trim();
    const openCommits = (chat.commitReg || []).filter((c) => c.state !== 'done' && c.state !== 'cancelled').slice(-80).map((c) => (c.who || c.owner) + ': [' + c.id + '] ' + c.text);
    const context = (scene ? 'WHERE THE STORY STOOD BEFORE THESE MESSAGES:\n<<<\n' + scene + '\n>>>\n\n' : '') +
      (openCommits.length ? 'OPEN GOALS AND PROMISES (use these [short names] for their done / progress / postponed / cancelled):\n' + openCommits.join('\n') + '\n\n' : '');
    const variants = mode === 'context'
      ? [['A', RECORD_RULES, ''], ['A+context', RECORD_RULES, context]]
      : [['A', RECORD_RULES, ''], ['B', RECORD_RULES_COMPACT, '']];
    const keys = new Set();
    for (const r of allRecords(chat)) if (r.k === 'secret') { const m = String(r.v).match(/^\s*\[([^\]]+)\]/); if (m) keys.add(secretKeyOf(m[1])); }
    const commits = commitState(chat);
    for (const [variant, rules, extra] of variants) {
      const v = { facts: 0, byKind: {}, byStatus: {}, perPart: {}, outputChars: 0, answers: [], coverage: { names: 0, found: 0 } };
      for (let bi = 0; bi < batches.length; bi++) {
        checkStop();
        const b = batches[bi];
        const list = withPrompts(all, b.replies);
        const user = (names.length ? 'KNOWN NAMES: ' + names.join('; ') + '\n\n' : '') + extra +
          'MESSAGES (oldest first):\n<<<\n' + formatMessages(list, chat.title) + '\n>>>\n\nJOB: SUMMARISE. Write one summary and its FACTS records for each [R…] reply now.';
        const out = cleanOutput(await job('test', 'Keeper test ' + variant + ', ' + (bi + 1) + ' of ' + batches.length, () => callLLM(summarySystem(true, rules), user)));
        v.outputChars += out.length;
        const got = parseKeeperAnswer(/^\W*=+\s*LOG\s*=+/im.test(out) ? out : '=== LOG ===\n' + out, b.replies).entries;
        for (const rep of b.replies) {
          const g = got.find((x) => x.id === rep.id);
          const recs = (g && g.records) || [];
          const idx = chat.log.findIndex((e) => e.id === rep.id) + 1;
          const pp = v.perPart[b.part] = v.perPart[b.part] || { facts: 0, ok: 0, moments: 0, replies: 0, noMoment: 0 };
          pp.replies++;
          if (!recs.some((r) => r.k === 'moment')) pp.noMoment++;
          for (const r of recs) {
            const st = factStatus(Object.assign({ id: 'kt#0', at: idx }, r), keys, secretKeyOf, null);
            const status = r.k === 'done' && INTENT_RE.test(commitText(r.v)) ? 'intent-not-done' : st;
            v.facts++; pp.facts++;
            v.byKind[r.k] = (v.byKind[r.k] || 0) + 1;
            v.byStatus[status] = (v.byStatus[status] || 0) + 1;
            if (status === 'ok') pp.ok++;
            if (r.k === 'moment') pp.moments++;
          }
          // Coverage: the known names in the story's own summary of this reply that the facts mention.
          const own = (chat.log.find((e) => e.id === rep.id) || {}).text || '';
          const factText = recs.map((r) => r.s + ' ' + r.v + ' ' + (r.t || '')).join(' ').toLowerCase();
          for (const e of chat.entries) if ((e.kind || 'character') === 'character' && new RegExp('\\b' + e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(own)) { v.coverage.names++; if (factText.includes(e.name.toLowerCase())) v.coverage.found++; }
          v.answers.push({ reply: idx, id: rep.id, part: b.part, summary: g ? g.text : '', facts: recs.map((r) => r.s + ' | ' + (r.label || r.k) + (r.t ? ': ' + r.t : '') + ' | ' + r.v) });
        }
      }
      result.variants[variant] = v;
    }
    void commits;
    result.replyTexts = picks.map((m) => ({ id: m.id, reply: chat.log.findIndex((e) => e.id === m.id) + 1, text: String(m.text || m.content || '').slice(0, 12000) }));
    await Store.set('keeperTest:' + chat.id, result);
    keeperTestCache[chat.id] = result;
    return result;
  }
  function keeperTestText(r) {
    if (!r) return '';
    const line = (k) => {
      const v = r.variants[k];
      const ok = v.byStatus.ok || 0;
      const serious = (v.byStatus['no-secret'] || 0) + (v.byStatus['intent-not-done'] || 0) + (v.byStatus.unclassified || 0);
      const parts = ['early', 'middle', 'late'].map((p) => { const x = v.perPart[p]; return x ? p + ' ' + Math.round(100 * x.ok / Math.max(1, x.facts)) + '% ok, ' + (x.moments / x.replies).toFixed(1) + ' moments/reply' : ''; }).filter(Boolean).join(' · ');
      return '  ' + k + ': ' + v.facts + ' facts (' + (v.facts / r.replies).toFixed(1) + ' per reply), right kind ' + Math.round(100 * ok / Math.max(1, v.facts)) + '%, serious errors ' + serious + ', names covered ' + v.coverage.found + '/' + v.coverage.names +
        ', ' + Math.round(v.outputChars / Math.max(1, v.facts)) + ' answer characters per fact\n     ' + parts + '\n     kinds: ' + Object.entries(v.byKind).sort((a, b) => b[1] - a[1]).map(([k2, n]) => k2 + ' ' + n).join(', ');
    };
    const names = Object.keys(r.variants);
    return 'Keeper test (' + new Date(r.at).toLocaleString() + ', ' + r.replies + ' replies, ' + (r.mode === 'context' ? 'A = current rules without context, A+context = with the scene and open goals normal processing sends' : 'A = current rules, B = compact rules') + '):\n' + names.map(line).join('\n') + '\n';
  }
  async function runKeeperTest(id, mode) {
    const chat = await getChat(id, true);
    return withBusy(id, 1, async () => {
      const job = async (kind, label, fn) => { setStep(id, label + '…'); const t = Date.now(); try { return await fn(); } catch (e) { if (!e.stopped) logJob(chat, { kind, label, ok: false, ms: Date.now() - t, error: String(e.message || e).slice(0, 200) }); throw e; } };
      try {
        const r = await keeperTest(chat, job, mode);
        logJob(chat, { kind: 'test', label: 'Keeper test (A/B) on ' + r.replies + ' replies', ok: true, ms: Date.now() - r.at });
        toast('Keeper test done. See Diagnostics, and use "Download keeper test" to send it.');
        return 'done';
      } catch (e) {
        toast(e.stopped ? 'Stopped.' : 'The keeper test failed: ' + (e.message || e), !e.stopped);
        return e.stopped ? 'stopped' : 'failed';
      }
    });
  }

  // Undo the last check-up: its corrections stop counting (they were only ever added, never
  // changed anything else). Older check-ups (before runs were marked) are found by their reply.
  // Check-ups, each with its corrections (older ones, made before runs were marked, by the reply they ran after).
  const checkupKey = (r) => r.run || 'at' + r.at;
  function checkupRuns(chat) {
    const runs = [];
    for (const r of chat.reconRecords || []) {
      const k = checkupKey(r);
      let x = runs.find((y) => y.key === k);
      if (!x) { x = { key: k, after: r.at, n: 0, sample: r.s + ' | ' + r.k + ' | ' + String(r.v).slice(0, 60) }; runs.push(x); }
      x.n++;
    }
    return runs;
  }
  function undoCheckup(chat, key) {
    const all = chat.reconRecords || [];
    chat.reconRecords = all.filter((r) => checkupKey(r) !== key);
    if (chat.lastReconRun === key) chat.lastReconRun = null;
    return all.length - chat.reconRecords.length;
  }

  async function runReconcile(id) {
    const chat = await getChat(id, true);
    return withBusy(id, 1, async () => {
      const t0 = Date.now();
      setStep(id, 'Checking what is out of date…');
      try {
        const n = await reconcileFacts(chat, { allGoals: true });
        logJob(chat, { kind: 'check', label: 'Check-up: ' + (n ? n + ' fact' + (n === 1 ? '' : 's') + ' brought up to date' : 'nothing out of date'), ok: true, ms: Date.now() - t0 });
        await saveChat(chat);
        toast(n ? 'Brought ' + n + ' out-of-date fact' + (n === 1 ? '' : 's') + ' up to date.' : 'Nothing was out of date.');
        return 'done';
      } catch (e) {
        if (!e.stopped) logJob(chat, { kind: 'check', label: 'Check-up', ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200) });
        await saveChat(chat);
        toast(e.stopped ? 'Stopped.' : 'The check-up failed: ' + (e.message || e), !e.stopped);
        return e.stopped ? 'stopped' : 'failed';
      }
    });
  }

  async function runPortrait(id, name) {
    const chat = await getChat(id, true);
    return withBusy(id, 1, async () => {
      const job = async (kind, label, fn) => {
        const t0 = Date.now();
        setStep(id, label + '…');
        try { const r = await fn(); logJob(chat, { kind, label, ok: true, ms: Date.now() - t0 }); progress[id].done++; return r; }
        catch (e) { if (!e.stopped) logJob(chat, { kind, label, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200) }); throw e; }
      };
      try {
        await updatePortraits(chat, job, [name]);
        toast('Wrote who ' + name + ' is now.');
        return 'done';
      } catch (e) {
        await saveChat(chat);
        toast(e.stopped ? 'Stopped.' : 'Could not write the portrait: ' + (e.message || e), !e.stopped);
        return e.stopped ? 'stopped' : 'failed';
      }
    });
  }

  // In the facts format the AI only keeps the story sections (Current Scene,
  // Open Threads, World & Timeline); the entries are built from the records.
  function sceneSystem() {
    const all = updateSystem().split('\n');
    const start = all.findIndex((l) => /^STORY rules:/.test(l));
    const end = all.findIndex((l) => /^ENTRY rules:/.test(l));
    return all.slice(0, 1).concat([
      'You keep the STORY sections of a knowledge base up to date: the situation now. Characters, places and items are kept separately (do not write entries).',
      '',
    ], all.slice(start, end), [
      'Answer in exactly this format and nothing else:',
      '=== SECTION: Current Scene ===',
      '(complete section; repeat for each changed section)',
      '=== CAST ===',
      '(every named character in the STORY and NEW EVENTS, comma-separated)',
    ]).join('\n');
  }
  async function foldScene(chat, items) {
    const user = 'STORY:\n<<<\n' + (chat.memory.trim() || '(empty — this is the start)') + '\n>>>\n\n' +
      (chat.entries.length ? 'PEOPLE AND THINGS IN THE STORY: ' + chat.entries.map((e) => e.name).join(', ') + '\n\n' : '') +
      (chat.pinned.trim() ? 'FACTS THE USER PINNED (always true):\n<<<\n' + chat.pinned.trim() + '\n>>>\n\n' : '') +
      'NEW EVENTS (oldest first):\n<<<\n' + formatEvents(items) + '\n>>>\n\n' +
      'JOB: SCENE. Write the changed STORY sections and the CAST now. No entries.';
    const out = cleanOutput(await callLLM(sceneSystem(), user));
    checkStop();
    const parsed = parseKeeperAnswer(out, []);
    const sections = parsed.sections.filter((x) => !/^story so far$/i.test(x.title));
    if (!sections.length && !parsed.memory.trim() && !parsed.cast.length) throw new Error('Memory keeper gave an unusable answer: "' + out.slice(0, 120) + '"');
    const memory = sections.length ? applySections(chat.memory, sections) : (parsed.memory.trim() ? dedupeSections(dropJunk(removeSection(parsed.memory, 'Story So Far'))) : chat.memory);
    return { memory, updates: [], cast: parsed.cast };
  }

  // catchingUp: in the middle of a long catch-up (a rebuild): short chapters
  // wait for the end, so they do not hold up the summaries.
  async function foldAndChapter(chat, threshold, job, catchingUp) {
    while (stages(chat).unfolded && stages(chat).unfolded >= threshold) {
      const items = nextFold(chat);
      checkStop();
      if (factsMode(chat)) {
        // The facts format: the AI updates the story sections only.
        const r = await job('update', 'Updated the story from ' + replyRange(chat, items), () => foldScene(chat, items));
        chat.memory = r.memory;
        for (const e of items) e.folded = true;
      } else {
        const r = await job('update', 'Updated story & characters from ' + replyRange(chat, items), () => fold(chat, items));
        chat.memory = r.memory;
        const applied = applyUpdates(chat.entries, r.updates, chat.ignored);
        placeStates(chat, r.updates);
        if (applied.refused.length) toast('Kept the fuller version of: ' + applied.refused.join(', '));
        for (const e of items) e.folded = true;
      }
      chat.lastUpdate = Date.now();
      chat.lastError = '';
      await saveChat(chat);
      renderPanel();
      await writeChapters(chat, job, catchingUp);
    }
    await writeChapters(chat, job, catchingUp);
  }

  // "Check for missing facts": every summary's facts not checked yet, in
  // batches, against the entries and story.
  // Asks again for the FACTS lines of summaries that have none and are not
  // known to be "none" (skipped lines, and summaries from older versions).
  async function runMissingFacts(id) {
    const chat = await getChat(id, true);
    if (busy[id]) return 'skipped';
    const want = chat.log.filter((e) => !e.facts && e.nofacts !== 'none');
    if (!want.length) return 'nothing';
    busy[id] = true;
    keepAwake(true);
    stopRequested[id] = false;
    activeChatId = id;
    setStatus();
    progress[id] = { done: 0, total: 1, step: 'Reading the chat…' };
    renderPanel();
    let got = 0;
    let asked = 0;
    try {
      const msgs = await fetchMessages(id, { mode: 'full' });
      const byId = new Map(msgs.map((m) => [m.id, m]));
      const todo = want.filter((e) => byId.has(e.id));
      const per = Math.max(1, detail().perChunk);
      progress[id].total = Math.ceil(todo.length / per) || 1;
      for (let i = 0; i < todo.length; i += per) {
        checkStop();
        const batch = todo.slice(i, i + per);
        const label = 'Got the facts of ' + replyRange(chat, batch);
        setStep(id, label + '…');
        const t0 = Date.now();
        const again = await summarise(chat, withPrompts(msgs, batch.map((e) => byId.get(e.id))));
        const n = mergeFacts(batch, again);
        got += n;
        asked += batch.length;
        logJob(chat, { kind: 'check', label: label + ': ' + n + ' of ' + batch.length + ' had facts', ok: true, ms: Date.now() - t0 });
        progress[id].done++;
        await saveChat(chat);
        renderPanel();
      }
      toast('Asked again for ' + asked + ' facts lists: ' + got + ' had facts' + (asked - got ? ', ' + (asked - got) + ' had none' : '') +
        (got ? '. Tap "Check for missing facts" to add them to the characters & story.' : '.'));
      return 'done';
    } catch (e) {
      await saveChat(chat);
      if (e.stopped) { toast('Stopped. What was done is kept.'); return 'stopped'; }
      toast('Could not get the facts lists: ' + (e.message || e), true);
      return 'failed';
    } finally {
      busy[id] = false;
      if (!anyBusy()) keepAwake(false);
      stopRequested[id] = false;
      if (activeChatId === id) activeChatId = null;
      delete progress[id];
      setStatus();
      renderPanel(true);
    }
  }


  // Runs a user-started job on a chat: marks it busy (so updates wait),
  // keeps the screen on, shows progress, and always cleans up.
  async function withBusy(id, total, fn) {
    if (busy[id]) return 'skipped';
    busy[id] = true;
    keepAwake(true);
    stopRequested[id] = false;
    activeChatId = id;
    setStatus();
    progress[id] = { done: 0, total, step: 'Starting…' };
    renderPanel();
    try {
      return await fn();
    } finally {
      busy[id] = false;
      if (!anyBusy()) keepAwake(false);
      stopRequested[id] = false;
      if (activeChatId === id) activeChatId = null;
      delete progress[id];
      setStatus();
      renderPanel(true);
    }
  }

  // "Check summaries": each summary is compared with the actual reply. A wrong
  // one is replaced by a corrected summary; if its facts were already in the
  // story & characters, the correction step takes the wrong ones out and the
  // new ones are folded in; its chapter is marked for a check.
  const SUMMARY_CHECK_LATEST = 30;
  async function runCheckSummaries(id, all) {
    const chat = await getChat(id, true);
    if (busy[id]) return 'skipped';
    let msgs;
    try { msgs = await fetchMessages(id, { mode: 'full' }); } catch (e) { toast('Could not read the chat: ' + (e.message || e), true); return 'failed'; }
    const byId = new Map(msgs.map((m) => [m.id, m]));
    let todo = chat.log.filter((e) => !e.inherited && byId.has(e.id) && (all || !e.verified));
    if (!all) todo = todo.slice(-SUMMARY_CHECK_LATEST);
    if (!todo.length) return 'nothing';
    const per = Math.max(1, detail().perChunk);
    const batches = [];
    for (let i = 0; i < todo.length; i += per) batches.push(todo.slice(i, i + per));
    let fine = 0;
    const fixed = [];
    let factsAdded = 0;
    const status = await withBusy(id, batches.length, async () => {
      const before = snapshot(chat);
      try {
        for (const batch of batches) {
          checkStop();
          const label = 'Checked the summaries of ' + replyRange(chat, batch);
          setStep(id, label + '…');
          const t0 = Date.now();
          const replies = batch.map((e) => byId.get(e.id));
          const part = withPrompts(msgs, replies);
          const user = 'MESSAGES (oldest first):\n<<<\n' + formatMessages(part, chat.title) + '\n>>>\n\n' +
            'SUMMARIES TO CHECK:\n<<<\n' + batch.map((e, i) => '[R' + (i + 1) + '] ' + e.text + (e.facts ? '\nFACTS: ' + e.facts : '')).join('\n\n') + '\n>>>\n\n' +
            'JOB: VERIFY. Compare each summary [R…] with its reply in MESSAGES. Check: the events and their order, WHO said and did each thing, ' +
            'names, details that were left out, and anything the summary says that the reply does not. ' +
            'For a correct summary write "[R#] OK". For a wrong or incomplete one write "[R#]" followed by the corrected, complete summary, and on the next line ' +
            'FACTS: with its complete facts list. Answer in this format only, one line per correct summary.';
          const out = cleanOutput(await callLLM(summarySystem(factsMode(chat)), user));
          checkStop();
          const got = parseKeeperAnswer(/^\W*=+\s*LOG\s*=+/im.test(out) ? out : '=== LOG ===\n' + out, replies).entries;
          let n = 0;
          for (const e of batch) {
            const g = got.find((x) => x.id === e.id);
            e.verified = Date.now();
            if (!g || /^ok\b/i.test(g.text) || g.text.length < 40) { fine++; continue; }
            if (e.folded) markStale(chat, e);
            if (!e.facts && g.facts) factsAdded++;
            e.text = g.text;
            if (SM_VERSION) e.v = SM_VERSION;
            e.at = Date.now();
            if (g.facts) { e.facts = g.facts; delete e.nofacts; } else if (g.nofacts === 'none') e.nofacts = 'none';
            if (g.records) e.records = g.records; else delete e.records;
            delete e.checked;
            if (e.folded) e.folded = false;
            if (e.chapter != null && chat.chapters[e.chapter]) chat.chapters[e.chapter].needsCheck = true;
            fixed.push(chat.log.indexOf(e) + 1);
            n++;
          }
          logJob(chat, { kind: 'check', label: label + (n ? ': corrected ' + n : ': all correct'), ok: true, ms: Date.now() - t0 });
          progress[id].done++;
          await saveChat(chat);
          renderPanel();
        }
        if (JSON.stringify(before) !== JSON.stringify(snapshot(chat))) chat.history = [before].concat(chat.history).slice(0, 5);
        await saveChat(chat);
        return 'done';
      } catch (e) {
        await saveChat(chat);
        if (e.stopped) { toast('Stopped. What was checked is kept.'); return 'stopped'; }
        toast('Checking the summaries failed: ' + (e.message || e), true);
        return 'failed';
      }
    });
    if (status === 'done' || status === 'stopped') {
      const checked = fine + fixed.length;
      toast('Checked ' + checked + ' summaries: ' + fine + ' correct' + (fixed.length ? ', ' + fixed.length + ' corrected (repl' + (fixed.length === 1 ? 'y ' : 'ies ') + fixed.join(', ') + ')' : '') +
        (factsAdded ? ', ' + factsAdded + ' facts list' + (factsAdded === 1 ? '' : 's') + ' added' : '') + '.' +
        (fixed.length ? ' Updating the story & characters…' : ''));
      // The corrected summaries go into the story & characters (and what only
      // the wrong ones said comes out).
      if (fixed.length) await updateMemory(id, msgs, { force: true });
    }
    return status;
  }

  // "Check chapters": each chapter is compared with the summaries it was
  // written from, and graded; problems are listed, and a flagged chapter can
  // be rewritten from its summaries with the problems pointed out.
  const CHAPTERS_PER_CHECK = 3;
  function chapterFlagged(c) {
    return !!(c.check && (c.check.score < 8 || c.check.wrong || c.check.missing));
  }
  async function runCheckChapters(id, all) {
    const chat = await getChat(id, true);
    if (busy[id]) return 'skipped';
    const idxs = chat.chapters.map((c, i) => i).filter((i) => all || !chat.chapters[i].check || chat.chapters[i].needsCheck)
      .filter((i) => chat.log.some((e) => e.chapter === i));
    if (!idxs.length) return 'nothing';
    const batches = [];
    for (let i = 0; i < idxs.length; i += CHAPTERS_PER_CHECK) batches.push(idxs.slice(i, i + CHAPTERS_PER_CHECK));
    return withBusy(id, batches.length, async () => {
      try {
        for (const batch of batches) {
          checkStop();
          const label = 'Checked chapter' + (batch.length === 1 ? ' ' + (batch[0] + 1) : 's ' + (batch[0] + 1) + '–' + (batch[batch.length - 1] + 1));
          setStep(id, label + '…');
          const t0 = Date.now();
          const user = batch.map((i) => '=== CHAPTER ' + (i + 1) + ': ' + chat.chapters[i].title + ' ===\n' + chat.chapters[i].text +
            '\n\nWHAT HAPPENED (the summaries this chapter was written from, oldest first):\n<<<\n' + formatEvents(chat.log.filter((e) => e.chapter === i)) + '\n>>>').join('\n\n') +
            '\n\nJOB: GRADE. For each chapter, compare it with WHAT HAPPENED. Answer for each, in this format only:\n' +
            '=== CHAPTER n ===\nSCORE: (0–10: how accurate and complete it is)\nWRONG: (events, people, who said or did what, or order that differ from what happened; or none)\n' +
            'MISSING: (important events, reveals, promises or changes left out; or none)\nPADDING: (repeated phrases, recurring metaphors or filler; or none)';
          const out = cleanOutput(await callLLM(chapterSystem(), user));
          checkStop();
          const parts = out.split(/^[^\S\n]*[*#_]*[^\S\n]*=+[^\S\n]*CHAPTER[^\S\n]*(\d+)[^\n]*$/im);
          const field = (t, k) => { const m = t.match(new RegExp('^\\W*' + k + '\\W*:\\s*([\\s\\S]*?)(?=^\\W*(SCORE|WRONG|MISSING|PADDING)\\W*:|$(?![\\s\\S]))', 'im')); const v = m ? m[1].trim() : ''; return /^(none|n\/?a|nothing|-)\.?$/i.test(v) ? '' : v; };
          const flagged = [];
          for (let k = 1; k < parts.length; k += 2) {
            const i = Number(parts[k]) - 1;
            if (!batch.includes(i)) continue;
            const t = parts[k + 1] || '';
            const score = Number((t.match(/SCORE\W*:\s*(\d+(?:\.\d+)?)/i) || [])[1]);
            if (!(score >= 0)) continue;
            const c = chat.chapters[i];
            c.check = { score: Math.min(10, score), wrong: field(t, 'WRONG'), missing: field(t, 'MISSING'), padding: field(t, 'PADDING'), at: Date.now() };
            delete c.needsCheck;
            if (chapterFlagged(c)) flagged.push(i + 1);
          }
          logJob(chat, { kind: 'check', label: label + (flagged.length ? ': chapter' + (flagged.length === 1 ? ' ' : 's ') + flagged.join(', ') + ' need' + (flagged.length === 1 ? 's' : '') + ' work' : ': all good'), ok: true, ms: Date.now() - t0 });
          progress[id].done++;
          await saveChat(chat);
          renderPanel();
        }
        const checked = chat.chapters.filter((c) => c.check);
        const bad = chat.chapters.map((c, i) => (chapterFlagged(c) ? i + 1 : 0)).filter(Boolean);
        toast('Checked ' + idxs.length + ' chapter' + (idxs.length === 1 ? '' : 's') + '. Average score ' +
          (checked.reduce((n, c) => n + c.check.score, 0) / Math.max(1, checked.length)).toFixed(1) + '/10' +
          (bad.length ? '; chapter' + (bad.length === 1 ? ' ' : 's ') + bad.join(', ') + ' could be rewritten (see Chapters).' : '; none need rewriting.'));
        return 'done';
      } catch (e) {
        await saveChat(chat);
        if (e.stopped) { toast('Stopped. What was checked is kept.'); return 'stopped'; }
        toast('Checking the chapters failed: ' + (e.message || e), true);
        return 'failed';
      }
    });
  }

  // Rewrites one chapter from its summaries, with its check's problems.
  async function rewriteChapter(id, i) {
    const chat = await getChat(id, true);
    const c = chat.chapters[i];
    const items = chat.log.filter((e) => e.chapter === i);
    if (!c || !items.length || busy[id]) return 'skipped';
    return withBusy(id, 1, async () => {
      const t0 = Date.now();
      const label = 'Rewrote chapter ' + (i + 1) + ' from its summaries';
      setStep(id, label + '…');
      try {
        const notes = c.check ? ['wrong: ' + (c.check.wrong || 'none'), 'missing: ' + (c.check.missing || 'none'), 'padding: ' + (c.check.padding || 'none')].join('\n') : '';
        const before = snapshot(chat);
        const ch = await makeChapter(chat, items, i, notes);
        chat.chapters[i] = Object.assign(ch, { needsCheck: true });
        chat.history = [before].concat(chat.history).slice(0, 5);
        logJob(chat, { kind: 'chapter', label, ok: true, ms: Date.now() - t0 });
        await saveChat(chat);
        toast('Chapter ' + (i + 1) + ' rewritten. "Check chapters" grades it again.');
        return 'done';
      } catch (e) {
        if (!e.stopped) logJob(chat, { kind: 'chapter', label, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200) });
        await saveChat(chat);
        toast(e.stopped ? 'Stopped.' : 'Could not rewrite chapter ' + (i + 1) + ': ' + (e.message || e), !e.stopped);
        return e.stopped ? 'stopped' : 'failed';
      }
    });
  }



  // "Compare bots": each bot gets the same two jobs on the FIRST replies of
  // the story, as if the story were just starting (a dry run: the memory is
  // not touched): summarise them, then write the story & characters from the
  // summaries. The result is one report with every bot's output and numbers.
  async function runCompare(chat, slugs, count) {
    if (busy[chat.id] || compare.running) { toast('The memory is being updated right now — try again in a moment'); return null; }
    let msgs;
    try { msgs = await fetchMessages(chat.id, { mode: 'full' }); } catch (e) { toast('Could not read the chat: ' + (e.message || e), true); return null; }
    const greeting = greetingOf(msgs);
    const replies = msgs.filter((m) => m.role === 'assistant' && m.id !== greeting).slice(0, count);
    if (!replies.length) { toast('This chat has no AI replies yet.'); return null; }
    const part = withPrompts(msgs, replies);
    const results = [];
    compare.running = true;
    try {
      await withBusy(chat.id, slugs.length * 2, async () => {
        for (let i = 0; i < slugs.length; i++) {
          const slug = slugs[i];
          const r = { slug, ok: false, error: '', times: [], raw: [], summaries: [], memory: '', entries: [] };
          results.push(r);
          compare.slug = slug;
          compare.slot = 8 + i;
          // A fresh helper chat each time: the bot must not see earlier runs.
          helperChats[compare.slot] = null;
          await Store.set(helperKey(compare.slot), null);
          compare.raw = r.raw;
          toolCache = null;
          const temp = Object.assign(newChat(chat.id), { title: chat.title, greetingId: greetingOf(msgs) });
          try {
            setStep(chat.id, slug + ': summarising replies 1–' + replies.length + '…');
            let t0 = Date.now();
            r.summaries = await summarise(temp, part);
            r.times.push(Date.now() - t0);
            progress[chat.id].done++;
            checkStop();
            setStep(chat.id, slug + ': writing the story & characters…');
            t0 = Date.now();
            // The facts format (what new stories use): the story from the
            // summaries, the characters built from their records.
            temp.log = r.summaries.map((e) => Object.assign({}, e, { folded: false }));
            const f = await foldScene(temp, temp.log);
            r.times.push(Date.now() - t0);
            progress[chat.id].done++;
            temp.memory = f.memory;
            temp.entries = buildEntries(temp);
            r.records = allRecords(temp).length;
            r.memory = temp.memory;
            r.entries = temp.entries;
            r.ok = true;
          } catch (e) {
            if (e.stopped) throw e;
            r.error = String(e.message || e).slice(0, 300);
            progress[chat.id].done = (i + 1) * 2;
          }
        }
      });
    } catch (e) {
      if (!e.stopped) toast('The comparison stopped: ' + (e.message || e), true);
    } finally {
      compare.slug = null;
      compare.raw = null;
      compare.running = false;
      toolCache = null;
    }
    if (!results.length) return null;
    const report = compareReport(chat, part, replies.length, results);
    const saved = { at: Date.now(), slugs, count: replies.length, report, rows: results.map(compareRow) };
    await Store.set('comparison:' + chat.id, saved);
    renderPanel(true);
    return saved;
  }

  // The numbers that can be measured fairly for one bot.
  function compareRow(r) {
    // Lines of the answer format itself ("[R1] …", "=== ENTRY … ===", "FACTS:", "### …") are not working-out.
    const FORMAT_RE = /^\s*(\[R\d+[^\]]*\]|[*#_]*\s*=+\s*\w|\*{0,2}facts?\*{0,2}\s*:|#{1,4}\s)/i;
    const junk = r.raw.join('\n').split('\n').filter((l) => l.trim() && !FORMAT_RE.test(l) && (isJunk(l, true) || REASONING_RE.test(l) || REASONING_WORDS_RE.test(l)));
    const n = { facts: 0, none: 0, missing: 0 };
    for (const e of r.summaries) n[e.facts ? 'facts' : e.nofacts === 'none' ? 'none' : 'missing']++;
    const factCount = r.summaries.reduce((k, e) => k + (e.facts ? e.facts.split('|').filter((x) => x.trim()).length : 0), 0);
    return {
      slug: r.slug, ok: r.ok, error: r.error,
      summaries: r.summaries.length,
      facts: n, factCount,
      avgSummary: r.summaries.length ? Math.round(r.summaries.reduce((k, e) => k + e.text.length, 0) / r.summaries.length) : 0,
      sections: (r.memory.match(/^##\s/gm) || []).length,
      entries: r.entries.length,
      entryChars: r.entries.reduce((k, e) => k + e.text.length, 0),
      junk: junk.length, junkLines: junk.slice(0, 15),
      seconds: r.times.map((t) => Math.round(t / 1000)),
      requests: r.raw.length,
    };
  }

  function compareReport(chat, part, count, results) {
    const rows = results.map(compareRow);
    const L = [];
    L.push('# Memory-keeper comparison: ' + (chat.title || chat.id.slice(0, 8)));
    L.push('');
    L.push('Made ' + new Date().toLocaleString() + ' by Story Manager v' + (SM_VERSION || '?') + '. Each bot got the same two jobs on the FIRST ' + count +
      ' AI repl' + (count === 1 ? 'y' : 'ies') + ' of this chat, as if the story were just starting: (1) summarise each reply with its facts, ' +
      '(2) write the story from those summaries, in the facts format: the characters are built by Story Manager from the facts in the summaries. Summary detail: ' + detail().label + '. Nothing in the real memory was changed.');
    L.push('');
    L.push('## Results');
    L.push('');
    L.push('| Bot | Worked | Summaries | Facts lists (with / none / skipped) | Facts found | Avg summary length | Story sections | Entries (characters) | Lines of working-out removed | Requests | Seconds (summaries, story) |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      L.push('| ' + [r.slug, r.ok ? 'yes' : 'no: ' + r.error.replace(/\|/g, '/'), r.summaries + ' of ' + count, r.facts.facts + ' / ' + r.facts.none + ' / ' + r.facts.missing,
        r.factCount, r.avgSummary, r.sections, r.entries + ' (' + r.entryChars + ')', r.junk, r.requests, r.seconds.join(', ') || '-'].join(' | ') + ' |');
    }
    L.push('');
    L.push('"Lines of working-out removed": lines of the bot\'s own notes and planning that Story Manager had to throw away (fewer is better). ' +
      '"Skipped" facts lists: the bot left out the FACTS line and was asked again. Accuracy is not scored: compare each bot\'s summaries with the replies below.');
    L.push('');
    L.push('## The replies tested');
    L.push('');
    L.push(formatMessages(part, chat.title));
    for (const r of results) {
      const row = rows.find((x) => x.slug === r.slug);
      L.push('');
      L.push('---');
      L.push('');
      L.push('## Bot: ' + r.slug);
      L.push('');
      L.push('### Diagnostics');
      L.push('- Worked: ' + (r.ok ? 'yes' : 'no — ' + r.error));
      L.push('- Requests: ' + row.requests + ' · seconds: ' + (row.seconds.join(', ') || '-') + ' · raw answer sizes: ' + r.raw.map((x) => x.length).join(', '));
      L.push('- Summaries: ' + row.summaries + ' of ' + count + ' · facts lists: ' + row.facts.facts + ' with, ' + row.facts.none + ' "none", ' + row.facts.missing + ' skipped · facts found: ' + row.factCount);
      L.push('- Story sections: ' + row.sections + ' · entries: ' + row.entries + ' (' + row.entryChars + ' characters)');
      L.push('- Lines of working-out removed: ' + row.junk + (row.junkLines.length ? ':' : ''));
      for (const l of row.junkLines) L.push('  - ' + l.trim().slice(0, 200));
      L.push('');
      L.push('### Summaries');
      L.push('');
      if (!r.summaries.length) L.push('(none)');
      r.summaries.forEach((e, k) => { L.push('[R' + (k + 1) + '] ' + e.text); L.push(e.facts ? 'FACTS: ' + e.facts : 'FACTS: ' + (e.nofacts === 'none' ? 'none' : '(skipped)')); L.push(''); });
      L.push('### Story & characters');
      L.push('');
      L.push(r.memory.trim() || '(none)');
      L.push('');
      L.push(r.entries.length ? formatEntries(r.entries) : '(no entries)');
    }
    L.push('');
    L.push('---');
    L.push('');
    L.push('## Story Manager diagnostics');
    L.push('');
    L.push(diagnosticsText());
    return L.join('\n');
  }

  function downloadText(name, text) {
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      a.download = name;
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
      return true;
    } catch (e) { return false; }
  }

  // Settings: the comparison panel.
  function compareBox() {
    const chat = currentId && chats[currentId];
    const box = el('div', {});
    const names = el('input', { value: [(settings.miniappsSlug || '').trim()].filter(Boolean).join(', '), placeholder: 'e.g. er-8, another-bot, third-bot' });
    const count = el('input', { type: 'number', min: '1', max: '10', value: '3' });
    const out = el('div', {});
    const show = (saved) => {
      if (!saved) { out.replaceChildren(); return; }
      const best = (r) => (r.ok ? 1000 : 0) - r.junk * 10 + r.factCount + (r.facts.missing ? -5 : 0);
      out.replaceChildren(
        el('div', { class: 'hint' }, 'Last comparison: ' + ago(saved.at) + ', on replies 1–' + saved.count + '.'),
        ...saved.rows.map((r) => el('div', { class: r.ok ? 'status' : 'error' },
          el('b', {}, r.slug), r.ok ? '' : ' — failed: ' + r.error,
          r.ok ? el('div', {}, r.summaries + '/' + saved.count + ' summaries · ' + r.factCount + ' facts (' + r.facts.missing + ' facts lists skipped) · ' +
            r.entries + ' entries · ' + r.junk + ' lines of working-out · ' + r.seconds.reduce((a, b) => a + b, 0) + ' s') : null,
          r.ok && r.slug !== (settings.miniappsSlug || '').trim() ? el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: async () => {
            if (!confirm('Use "' + r.slug + '" as your memory keeper from now on?')) return;
            settings.miniappsSlug = r.slug;
            settings.provider = 'miniapps';
            settings.settingsAt = Date.now();
            scheduleSync();
            await Store.set('settings', settings);
            toolCache = null;
            toast('The memory keeper is now ' + r.slug);
            renderPanel(true);
          } }, 'Use this bot')) : null)),
        el('div', { class: 'hint' }, 'Most promising by these numbers: ' + saved.rows.slice().sort((a, b) => best(b) - best(a))[0].slug + '. Read the report to judge accuracy.'),
        el('div', { class: 'btns' },
          el('button', { class: 'btn primary', onclick: () => {
            const name = 'story-manager-bot-comparison-' + new Date(saved.at).toISOString().slice(0, 10) + '.md';
            if (downloadText(name, saved.report)) toast('Report downloaded: ' + name); else toast('Could not download; use Copy report', true);
          } }, 'Download report'),
          el('button', { class: 'btn', onclick: async () => {
            try { await navigator.clipboard.writeText(saved.report); toast('Report copied (' + saved.report.length.toLocaleString() + ' characters)'); } catch (e) { toast('Could not copy; use Download report', true); }
          } }, 'Copy report')));
    };
    if (chat) Store.get('comparison:' + chat.id, null).then(show).catch(() => {});
    box.append(
      el('label', {}, 'Compare memory-keeper bots'),
      el('div', { class: 'hint' }, 'Up to 4 MiniApps bots (slugs from their URLs, comma-separated). Each gets the same jobs on the FIRST replies of the open story — summaries, then story & characters — without changing your memory. About 2 requests per bot (MiniApps credits). The result is one report with every bot\'s output and the diagnostics.'),
      names,
      el('label', {}, 'How many of the first AI replies to use'), count,
      el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: async () => {
        const c = currentId && chats[currentId];
        if (!c) { toast('Open your story chat first.'); return; }
        const slugs = [...new Set(names.value.split(/[,\s]+/).map((x) => x.trim().replace(/^https?:\/\/[^/]+\//, '').split('/')[0]).filter(Boolean))].slice(0, 4);
        if (!slugs.length) { toast('Enter at least one bot.'); return; }
        const n = Math.max(1, Math.min(10, parseInt(count.value, 10) || 3));
        if (!confirm('Compare ' + slugs.join(', ') + ' on the first ' + n + ' replies of "' + (c.title || 'this story') + '"? About ' + slugs.length * 2 + ' requests; your memory is not changed. Keep this tab open until it finishes.')) return;
        tab = 'memory';
        renderPanel(true);
        const saved = await runCompare(c, slugs, n);
        if (saved) toast('Comparison done. Open Settings → Compare memory-keeper bots for the results and the report.');
      } }, 'Start comparison')),
      out);
    return box;
  }


  // "Slim down": the keeper writes a compact version of a big entry for the
  // pinned message (and attached memory), keeping everything that still
  // matters. The full entry stays in Story Manager and keeps growing; the
  // slim one is only remade when the user presses the button again.
  // An answer cut into its "[R1]", "[R2]" … parts: { 1: text, 2: text }.
  function splitByLabel(out) {
    const parts = {};
    const re = /^[^\S\n]*[-*•]?[^\S\n]*[*_]{0,2}\[?R(\d+)\b[^\]\n]*\]?[*_]{0,2}[:.]?/gim;
    const marks = [];
    let m;
    while ((m = re.exec(out))) marks.push({ n: Number(m[1]), at: m.index, end: m.index + m[0].length });
    marks.forEach((x, k) => { parts[x.n] = out.slice(x.end, k + 1 < marks.length ? marks[k + 1].at : out.length); });
    return parts;
  }

  // Fact records for summaries that have none (made before the facts format,
  // or by a keeper that wrote plain FACTS): read from the summaries
  // themselves, 8 at a time, without reading the chat again.
  const EXTRACT_PER = 8;
  async function runExtractRecords(id) {
    const chat = await getChat(id, true);
    const todo = chat.log.filter((e) => !e.records && e.text);
    if (!todo.length) return 'nothing';
    const batches = [];
    for (let i = 0; i < todo.length; i += EXTRACT_PER) batches.push(todo.slice(i, i + EXTRACT_PER));
    let got = 0;
    const status = await withBusy(id, batches.length, async () => {
      try {
        for (const batch of batches) {
          checkStop();
          const label = 'Took the facts out of the summaries of ' + replyRange(chat, batch);
          setStep(id, label + '…');
          const t0 = Date.now();
          const names = [...new Set(allRecords(chat).map((r) => r.s))];
          const user = (names.length ? 'KNOWN NAMES: ' + names.join('; ') + '\n\n' : '') +
            'SUMMARIES (oldest first):\n<<<\n' + batch.map((e, i) => '[R' + (i + 1) + '] ' + e.text + (e.facts ? '\nFACTS SO FAR: ' + e.facts : '')).join('\n\n') + '\n>>>\n\n' +
            'JOB: RECORDS. Do not repeat the summaries. For each summary write only its label on its own line, then its lasting facts as records, one per line ("- Subject | kind | fact"), or "none".';
          const out = cleanOutput(await callLLM(summarySystem(true), user));
          checkStop();
          const parsed = splitByLabel(out);
          let n = 0;
          batch.forEach((e, i) => {
            const part = parsed[i + 1];
            if (part == null) return;
            const recs = parseRecords(part);
            if (recs.length) { e.records = recs; n++; } else if (/\bnone\b/i.test(part)) e.records = [];
            if (e.records) delete e.needsRecords;
          });
          got += n;
          logJob(chat, { kind: 'check', label: label + ': ' + n + ' of ' + batch.length, ok: true, ms: Date.now() - t0 });
          progress[id].done++;
          await saveChat(chat);
          renderPanel();
        }
        return 'done';
      } catch (e) {
        await saveChat(chat);
        if (e.stopped) { toast('Stopped. What was done is kept.'); return 'stopped'; }
        toast('Could not take the facts out of the summaries: ' + (e.message || e), true);
        return 'failed';
      }
    });
    if (status === 'done') toast('Took ' + allRecords(chat).length + ' facts out of ' + got + ' summaries; the characters are built from them.');
    return status;
  }

  // Switching a story to the facts format (and back).
  async function switchFormat(chat, to) {
    const before = snapshot(chat);
    chat.history = [before].concat(chat.history).slice(0, 5);
    if (to === 'facts') {
      chat.classicEntries = cloneEntries(chat.entries);
      chat.format = 'facts';
      // The summaries made so far have no records yet ("Take facts from summaries").
      for (const e of chat.log) if (!e.records) e.needsRecords = true;
      logJob(chat, { kind: 'check', label: 'Switched this story to the facts format (the previous characters are kept for switching back)', ok: true, ms: 0 });
    } else {
      chat.format = 'classic';
      if (chat.classicEntries) chat.entries = cloneEntries(chat.classicEntries);
      logJob(chat, { kind: 'check', label: 'Switched this story back to the classic format', ok: true, ms: 0 });
    }
    await saveChat(chat);
    renderPanel(true);
  }

  async function correctAfterRedo(chat, job) {
    const stale = chat.stale.slice();
    const removed = stale.map((e, i) => '[OLD' + (i + 1) + '] ' + e.text + (e.facts ? '\nFACTS: ' + e.facts : '')).join('\n\n');
    const now = chat.log.slice(-8);
    const what = stale.length === 1 ? 'a reply that was' : stale.length + ' replies that were';
    // The facts format: the removed replies took their records along, so only
    // the story sections and the chapters need correcting.
    const r = await job('update', 'Corrected the memory after ' + what + ' redone or deleted', async () => {
      const user = 'STORY:\n<<<\n' + (chat.memory.trim() || '(empty)') + '\n>>>\n\n' +
        'CURRENT ENTRIES:\n<<<\n' + entriesForRequest(chat, removed, false) + '\n>>>\n\n' +
        (chat.pinned.trim() ? 'FACTS THE USER PINNED (always true):\n<<<\n' + chat.pinned.trim() + '\n>>>\n\n' : '') +
        'EVENTS THAT NO LONGER HAPPENED (the user deleted or redid these replies, so they are not part of the story any more):\n<<<\n' + removed + '\n>>>\n\n' +
        'WHAT THE STORY SAYS NOW (the newest replies, oldest first):\n<<<\n' + (now.length ? formatEvents(now) : '(nothing yet)') + '\n>>>\n\n' +
        (factsMode(chat) ? 'JOB: CORRECT. The ENTRIES are already correct; output only STORY sections. ' : '') +
        'JOB: CORRECT. Some facts in the STORY and ENTRIES came only from the events that no longer happened. Remove or fix those facts, ' +
        'and keep everything that is still true (including facts the current story also says). Output every changed STORY section in full, ' +
        'and every changed ENTRY complete with its normal header (never "| add"). Leave out what does not need to change. If nothing needs to change, answer NO CHANGES.';
      const out = cleanOutput(await callLLM(updateSystem(), user));
      checkStop();
      if (/^\W*no changes\W*$/i.test(out)) return { sections: [], updates: [] };
      const parsed = parseKeeperAnswer(out, []);
      parsed.updates = parsed.updates.filter((u) => !u.add);
      return parsed;
    });
    if (r.sections.length) chat.memory = applySections(chat.memory, r.sections.filter((x) => !x.add));
    if (factsMode(chat)) r.updates = [];
    const applied = applyUpdates(chat.entries, r.updates, chat.ignored);
    if (applied.refused.length) toast('Kept the fuller version of: ' + applied.refused.join(', '));
    // Chapters that held a removed reply: written again from what is left.
    const touched = [...new Set(stale.map((e) => e.chapter).filter((c) => c != null && c < chat.chapters.length))].sort((a, b) => b - a);
    for (const idx of touched) {
      const items = chat.log.filter((e) => e.chapter === idx);
      if (!items.length) {
        chat.chapters.splice(idx, 1);
        for (const e of chat.log) if (e.chapter != null && e.chapter > idx) e.chapter--;
        continue;
      }
      checkStop();
      const ch = await job('chapter', 'Rewrote chapter ' + (idx + 1) + ' without the removed replies', () => makeChapter(chat, items, idx));
      chat.chapters[idx] = ch;
    }
    chat.stale = (chat.stale || []).filter((x) => !stale.some((y) => y.id === x.id));
    if (!chat.stale.length) chat.staleFacts = false;
    await saveChat(chat);
  }

  // Consolidation: an entry that grew by adding lines is rewritten once in
  // full, so contradictions are settled (the newest is true; an older
  // version stays only as labelled history), duplicates are merged and facts
  // sit under the right headings. Up to CONSOLIDATE_MAX entries a time, the
  // ones changed longest ago first, so every entry gets its turn.
  async function writeChapters(chat, job, catchingUp, shortMax) {
    for (;;) {
      const ready = chat.log.filter((e) => e.folded && e.chapter == null);
      if (ready.length < chapterSize()) break;
      const items = ready.slice(0, chapterSize());
      checkStop();
      const ch = await job('chapter', 'Wrote chapter ' + (chat.chapters.length + 1) + ' (' + replyRange(chat, items) + ')', () => makeChapter(chat, items));
      chat.chapters.push(ch);
      for (const e of items) e.chapter = chat.chapters.length - 1;
      await saveChat(chat);
      renderPanel();
    }
    if (!catchingUp) await shortenChapters(chat, job, shortMax);
  }

  // A short version of each older chapter for the pinned message: what still
  // matters later, in a few sentences. Written once; a rewritten chapter gets
  // a new one. A few per update, oldest first.
  function shortChapterSystem() {
    return [
      'You are the continuity editor for a long-running interactive story / roleplay chat.',
      'Your job now: shorten one CHAPTER of the story\'s history to what still matters later.',
      '- Write 2 to 4 sentences (at most about 500 characters) of past-tense prose.',
      '- Keep only what later chapters depend on: turning points, relationships that began, changed or ended, promises and vows, secrets made or revealed, moves, new characters, big decisions, and how the chapter ends.',
      '- Leave out scene detail, banter, outfits and the details of intimate scenes (say only that they happened if it mattered).',
      '- Use names. Never invent anything.',
      'No commentary. Answer with the short version only.',
    ].join('\n');
  }
  const chaptersToShorten = (chat) => (factsMode(chat) && settings.momentsShown !== 'all' ? chat.chapters.filter((c, i) => !c.short && i < chat.chapters.length - FULL_CHAPTERS).length : 0);
  async function shortenChapters(chat, job, max = SHORTEN_PER_UPDATE) {
    if (!factsMode(chat) || settings.momentsShown === 'all') return;
    let n = 0;
    for (let i = 0; i < chat.chapters.length - FULL_CHAPTERS && n < max; i++) {
      const c = chat.chapters[i];
      if (c.short) continue;
      checkStop();
      const text = await job('chapter', 'Wrote the short version of chapter ' + (i + 1), async () => {
        const out = cleanChapterText(squashRepeats(dropReasoning(cleanOutput(await callLLM(shortChapterSystem(), 'CHAPTER ' + (i + 1) + ': ' + c.title + '\n<<<\n' + c.text + '\n>>>\n\nJOB: SHORT CHAPTER. Write the short version now.')).trim())));
        if (out.length < 60) throw new Error('the memory keeper gave an unusable short chapter');
        return out.length < c.text.length ? out : c.text;
      });
      c.short = text;
      n++;
      await saveChat(chat);
    }
  }

  // Starts a new chat with the same bot that carries on the story: its first
  // message holds the memory and the last AI reply, and the new chat gets a
  // copy of this chat's memory. For chats that got too long for the AI.
  async function continueInNewChat(chat) {
    const conv = await rpc('GET', '/conversations/' + chat.id);
    const toolId = conv && (conv.toolId || (conv.tool && conv.tool.id));
    if (!toolId) throw new Error('Could not find which bot this chat uses');
    const msgs = await fetchMessages(chat.id, { mode: 'latest' });
    const last = [...msgs].reverse().find((m) => m.role === 'assistant');
    const plan = buildPlan(chat);
    // The first message may carry more than usual: it is the only one at first.
    const memory = plan ? composeMemory(Object.assign(plan, { budget: Math.max(plan.budget, 30000) }), '').text : '';
    const text = memory + '\n\n(OOC: We are continuing our story from a previous chat that became too long. ' +
      'The notes above hold everything important so far.' + (last ? ' This was your last reply there:)\n\n' + last.text.slice(-6000) +
      '\n\n(OOC: Continue the story from exactly this point, in the same style.)' : ' Continue the story from where it left off.)');
    const res = await rpc('POST', '/chat', {
      toolId,
      revision: conv.toolRevision || (conv.tool && conv.tool.revision) || 1,
      modelId: conv.modelId || (conv.model && conv.model.id) || '',
      requestId: uuid4(),
      elements: [{ type: 'text', text }],
      language: 'en',
    });
    const id = res && res.conversationId && String(res.conversationId).toLowerCase();
    if (!id) throw new Error('MiniApps did not start a new chat');
    const copy = Object.assign(JSON.parse(JSON.stringify(chat)), {
      id, processedIds: [], processedCount: 0, readCount: 0, knownMessages: 0, backlog: null, lastError: '',
      sentSinceInject: 1, history: [], continuedFrom: chat.id,
    });
    // These summaries are of replies in the old chat, not missing ones.
    for (const e of copy.log) e.inherited = true;
    copy.inheritedMarked = true;
    logJob(copy, { kind: 'continue', label: 'Continued the story from chat ' + chat.id.slice(0, 8), ok: true, ms: 0 });
    chats[id] = copy;
    if (!chatIndex.includes(id)) chatIndex.push(id);
    await Store.set('chatIndex', chatIndex);
    await saveChat(copy);
    const opener = (Array.isArray(res.addedMessages) ? res.addedMessages : []).filter((m) => m && roleOf(m) === 'user').pop();
    const openerId = (opener && opener.id) || res.chatMessageId;
    copy.pinnedMemoryId = null;
    copy.tool = { toolId, revision: conv.toolRevision || (conv.tool && conv.tool.revision) || 1, modelId: conv.modelId || (conv.model && conv.model.id) || '' };
    if (openerId) await pinMemory(copy, String(openerId), text.replace(MEM_BLOCK_RE, ''));
    chat.continuedIn = id;
    logJob(chat, { kind: 'continue', label: 'Story continued in a new chat (' + id.slice(0, 8) + ')', ok: true, ms: 0 });
    await saveChat(chat);
    return id;
  }

  // ---------------------------------------------------------------------------
  // Finding a chat's messages. MiniApps has no public API, so besides the
  // documented GET /conversations/{id} the script learns which request the
  // site itself uses to load messages, and reads the chat the same way.
  // ---------------------------------------------------------------------------

  let learned = null;               // { template: 'https://…{id}…' }
  const seenMsgs = {};              // chat id -> Map(message id -> message), this page visit only
  const deletedMsgs = new Set();    // messages MiniApps reported deleted on this page visit
  const siteLog = new Map();        // the site's own requests, for Diagnostics
  const ownLog = new Map();         // Story Manager's requests, for Diagnostics
  const sockLog = new Map();        // Socket.IO events, for Diagnostics

  function mergeMsgs(...lists) {
    const map = new Map();
    for (const list of lists) for (const m of list) map.set(m.id, m);
    const out = [...map.values()];
    if (out.length > 1 && out.every((m) => m.t)) out.sort((a, b) => a.t - b.t);
    return latestVersions(out);
  }

  function remember(id, msgs) {
    const prev = seenMsgs[id] ? [...seenMsgs[id].values()] : [];
    const all = mergeMsgs(prev, msgs).filter((m) => !deletedMsgs.has(m.id));
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
  // Addresses that return some messages but are not the chat's message list.
  const NOT_MESSAGE_LIST = /\/(pinned|alternatives|changes|status|context|run-state)(\/|\?|$)/i;

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
      if (/\/conversations\/[0-9a-f-]{36}\/?$/i.test(path) || /\/chat\/?$/.test(path) || NOT_MESSAGE_LIST.test(path)) continue;
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

  // How many messages the chat has (a regenerated reply's versions count once).
  // AI replies (newest version of each) that have no summary yet: the held
  // back ones, and any not summarised so far. Counted from the messages seen.
  function waitingReplies(chat) {
    const seen = seenMsgs[chat.id] ? latestVersions([...seenMsgs[chat.id].values()]) : null;
    if (!seen) return chat.waitingReplies || 0;
    const have = new Set(chat.log.map((e) => e.id));
    // Only replies after the newest summarised one: older ones without a
    // summary are deleted or replaced versions still in the list.
    let last = -1;
    seen.forEach((m, i) => { if (have.has(m.id)) last = i; });
    chat.waitingReplies = seen.slice(last + 1).filter((m) => m.role === 'assistant').length;
    return chat.waitingReplies;
  }

  function countMessages(chat, msgs) {
    if (versionsSeen[chat.id]) chat.allVersions = Math.max(chat.allVersions || 0, versionsSeen[chat.id].size);
    // MiniApps' message numbers can start again within a chat, so the count
    // is what has been read (the whole chat after a full read).
    return Math.max(chat.knownMessages || 0, msgs.length);
  }

  // Called whenever we see (part of) a chat's history.
  // Story Manager's own request text (see callMiniAppsOnce).
  const OWN_REQUEST_RE = /^Request [0-9a-f]{8}\. This is a new, separate task/;

  async function syncChat(id, msgs, { final }) {
    if (helperIds.has(id)) return;
    // A chat where everything the "user" wrote is a Story Manager request is a
    // helper chat (e.g. one an older version wrongly turned down).
    const mine = msgs.filter((m) => m.role === 'user');
    if (mine.length && mine.every((m) => OWN_REQUEST_RE.test(m.text)) && !notHelpers.includes(id)) { rememberHelper(id); return; }
    const chat = await getChat(id, true);
    // While the AI may still be typing, ignore its last message for now.
    let usable = msgs;
    if (!final && usable.length && usable[usable.length - 1].role === 'assistant') usable = usable.slice(0, -1);
    chat.knownMessages = countMessages(chat, msgs);
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
    publishSounds();
    // Each attached block stays in the chat for good, and MiniApps sends the
    // whole chat to the AI: attach less, less often (once, for old settings).
    if (!settings.attachSet) {
      if (settings.injectBudget >= 16000) settings.injectBudget = DEFAULT_SETTINGS.injectBudget;
      if (settings.injectEvery === 1) settings.injectEvery = DEFAULT_SETTINGS.injectEvery;
      settings.attachSet = true;
    }
    // Helper chats used to be kept forever, until they got too long for the bot.
    if (!settings.rotateSet) { settings.helperRotate = DEFAULT_SETTINGS.helperRotate; settings.rotateSet = true; }
    if (!DETAIL[settings.detail]) settings.detail = DEFAULT_SETTINGS.detail;
    chatIndex = await Store.get('chatIndex', []);
    learned = await Store.get('learned', null);
    // Older versions could learn e.g. the pinned messages as the message list.
    if (learned && NOT_MESSAGE_LIST.test(learned.template)) { learned = null; await Store.set('learned', null); }
    notHelpers = await Store.get('notHelpers', []);
    // Remembered as a number; "everything" (Infinity) is not stored.
    const savedSize = await Store.get('memoryMsgSize', 0);
    memoryMsgSize = Infinity; // always the whole memory (a smaller one is never sent)
    if (savedSize) await Store.set('memoryMsgSize', 0);
    helperAll = (await Store.get('helperAll', [])).filter((h) => !notHelpers.includes(h));
    helperRequests.push(...(await Store.get('helperRequests', [])));
    for (const h of helperAll) helperIds.add(h);
    for (let slot = 0; slot < MAX_PARALLEL; slot++) {
      helperChats[slot] = await Store.get(helperKey(slot), null);
      // A chat the user said is their story is never used as a helper again.
      if (helperChats[slot] && notHelpers.includes(helperChats[slot].id)) { helperChats[slot] = null; await Store.set(helperKey(slot), null); }
      if (helperChats[slot]) rememberHelper(helperChats[slot].id);
    }
    publishHidden();
    for (const id of chatIndex) await getChat(id, false);
    // A sync link from another device (miniapps.ai/#smx-sync=TOKEN): save the
    // token and take it out of the address bar.
    const link = location.hash.match(/smx-sync=([A-Za-z0-9_-]{8,255})/);
    if (link) {
      settings.githubToken = link[1];
      settings.gistId = '';
      await Store.set('settings', settings);
      history.replaceState(null, '', location.pathname + location.search);
      setTimeout(() => toast('Sync is set up on this device ✓'), 1500);
    }
    publishInjectMap();
  })();
  // The first sync finishes before any chat is read here, so a device that
  // has not got a chat yet loads it from GitHub instead of starting it anew.
  // (The button does not wait for it: it only waits for `ready`.)
  const synced = ready.then(() => Promise.race([runSync().catch(() => {}), new Promise((r) => setTimeout(r, 30000))]));

  on('conv', async (d) => {
    await synced;
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
    await synced;
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
    if (conv.inUrl && d.method === 'GET' && !NOT_MESSAGE_LIST.test(d.url)) {
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
    await synced;
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
    // "cmd" = messages deleted (e.g. replaced by "edit and regenerate"),
    // "cmu" = a message changed (e.g. a plain edit, or a reply regenerated in
    // place). Their old summaries no longer describe the story.
    if (d.dir === 'in' && chatOf && (d.event === 'cmd' || d.event === 'cmu')) {
      const cid = String(chatOf).toLowerCase();
      if (!helperIds.has(cid)) await overwritten(cid, d.event === 'cmd' ? (first.ids || []) : [first.message && first.message.id], d.event === 'cmu');
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
      const text = ownText(textOf(pm));
      const role = roleOf(pm);
      if (text && role !== 'system') {
        msgs = [{ id: String(pm.id || first.tmpId || first.requestId || ('h-' + hashText(text))), role, text, t: Date.parse(pm.createdAt || '') || Date.now(),
          index: typeof pm.index === 'number' ? pm.index : null, version: typeof pm.version === 'number' ? pm.version : 0 }];
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

  // Messages the user deleted or rewrote: their summaries are dropped; a
  // changed reply (or the reply after a changed message of the user's) is
  // summarised again at the next update.
  async function overwritten(cid, ids, changed) {
    const chat = chats[cid];
    // The pinned memory message is not a story message: it is left out (its
    // own loss is noticed when it is next updated); the others still count.
    ids = ids.filter(Boolean).map(String).filter((x) => x !== chat?.pinnedMemoryId);
    if (!chat || !ids.length) return;
    const gone = new Set(ids);
    const hit = chat.log.filter((e) => gone.has(e.id));
    const seen = seenMsgs[cid] ? [...seenMsgs[cid].values()] : [];
    // Deleted messages are forgotten at once, so e.g. "the newest reply" (for
    // Hold back) is never one that no longer exists.
    if (!changed && seenMsgs[cid]) for (const x of ids) { seenMsgs[cid].delete(x); deletedMsgs.add(x); }
    if (changed) {
      // A changed user message: the reply after it is summarised again too.
      const i = seen.findIndex((m) => gone.has(m.id));
      const next = i >= 0 ? seen.slice(i + 1).find((m) => m.role === 'assistant') : null;
      if (next && chat.log.some((e) => e.id === next.id)) gone.add(next.id);
      chat.redo = [...new Set((chat.redo || []).concat([...gone].filter((x) => chat.log.some((e) => e.id === x))))];
    }
    const dropped = chat.log.filter((e) => gone.has(e.id) && (!changed || !chat.redo.includes(e.id)));
    if (!hit.length && !(chat.redo || []).length) return;
    if (dropped.length) {
      for (const e of dropped) markStale(chat, e);
      forget(chat, dropped.map((e) => e.id));
      chat.log = chat.log.filter((e) => !dropped.includes(e));
      for (const c of chat.chapters) if (c.ids) c.ids = c.ids.filter((x) => !gone.has(x));
      if (dropped.some((e) => e.folded)) chat.staleFacts = true;
    }
    chat.processedIds = chat.processedIds.filter((x) => !gone.has(x) || (chat.redo || []).includes(x));
    logJob(chat, { kind: 'check', label: changed ? 'A message was changed: its reply will be summarised again' : 'Removed the summaries of ' + dropped.length + ' deleted message(s)', ok: true, ms: 0 });
    await saveChat(chat);
    if (cid === currentId) renderPanel();
  }

  const sentStats = { sent: 0, withMemory: 0 };
  const sendShapes = [];        // the fields of recent send requests, for Diagnostics
  const lastSentInfo = {};      // chat id -> what the last message carried

  on('sent', async (d) => {
    sentStats.sent++;
    if (d.shape) sendShapes.unshift({ at: Date.now(), shape: d.shape, injected: !!d.injected });
    sendShapes.length = Math.min(sendShapes.length, 8);
    if (d.injected) sentStats.withMemory++;
    if (d.conversationId && d.injected) {
      lastSentInfo[d.conversationId] = 'story' + (d.included && d.included.length ? ', ' + d.included.join(', ') : '') +
        ' (' + Number(d.size || 0).toLocaleString() + ' characters)';
    }
    await synced;
    lastSent = d;
    if (!d.conversationId) return;
    const chat = await getChat(d.conversationId, true);
    // What the site sends with a message, for editing the memory message later.
    const sh = d.shape || {};
    if (sh.toolId && sh.modelId) chat.tool = { toolId: sh.toolId, revision: sh.revision || 1, modelId: sh.modelId };
    if (typeof sh.personaId === 'string' && sh.personaId.length <= 64) chat.personaId = sh.personaId;
    if (!d.edit) chat.sentSinceInject = d.injected ? 1 : chat.sentSinceInject + 1;
    await saveChat(chat);
  });

  on('sendResult', async (d) => {
    await synced;
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
    // The message that carried the memory gets pinned (it then stays in the
    // AI's memory however long the chat gets); the previous one is unpinned.
    if (lastSent && lastSent.injected) {
      const added = Array.isArray(data.addedMessages) ? data.addedMessages : [];
      const mine = added.filter((m) => m && roleOf(m) === 'user').pop();
      const mid = (mine && mine.id) || data.chatMessageId;
      if (mid) pinMemory(chat, String(mid), lastSent.userText);
    }
    waitForReply(id, lastSent && lastSent.userText.replace(MEM_BLOCK_RE, ''));
  });

  // Waits until the story AI is not writing in a chat (MiniApps' run-state,
  // and no live activity for a few seconds), so a pin or an edit never lands
  // while a reply is being written. Gives up after 10 minutes.
  async function waitIdle(cid) {
    for (let i = 0; i < 200; i++) {
      let writing = false;
      try { const r = await rpc('GET', '/chat/' + cid + '/run-state'); writing = !!(r && r.isGenerating); } catch (e) { /* unknown: rely on activity */ }
      if (!writing && Date.now() - (lastActivity[cid] || 0) > 8000 * TIME_SCALE) return true;
      await sleep(3000);
    }
    return false;
  }

  // With a pinned memory message, the memory is kept up to date in that one
  // message (a plain edit: MiniApps' editInPlace, which writes no new reply),
  // so new messages need not carry the memory. On failure, memory goes back
  // to being attached to messages.
  // How big the pinned memory message may be. It starts large so long
  // character entries and more chapters fit; if MiniApps refuses a message
  // that big, the next smaller size is used (and remembered).
  const MEMORY_MESSAGE_SIZES = [Infinity, 120000, 60000, 40000, 24000]; // Infinity: everything, in full
  let memoryMsgSize = MEMORY_MESSAGE_SIZES[0];
  const tokensOf = (chars) => Math.round((chars || 0) / 3.5); // a rough estimate
  function memoryMessageText(chat) {
    const plan = buildPlan(chat, memoryMsgSize);
    if (!plan) return null;
    plan.fillAll = true;
    // The user's own text in this message is from when it was pinned: it was
    // answered long ago, and says so, so the AI does not take it as the latest.
    return composeMemory(plan, '').text + (chat.pinnedMemoryText ? '\n\n' + PINNED_TEXT_LABEL + '\n' + chat.pinnedMemoryText : '');
  }
  // What a smaller pinned message keeps and leaves out, compared with all of it.
  function describeCut(chat, text) {
    const full = [], shortened = [], left = [];
    for (const e of chat.entries) {
      if (text.includes(e.text)) full.push(e.name);
      else if (text.includes('### ' + e.name + ' (') || text.includes('### ' + e.name + '\n')) shortened.push(e.name);
      else left.push(e.name);
    }
    const chFull = chat.chapters.filter((c) => text.includes(c.text)).length;
    const logs = chat.log.slice(-Math.max(Math.max(0, Number(settings.logAttach) || 0), chat.log.filter((e) => e.chapter == null).length));
    const logIn = logs.filter((e) => text.includes(e.text)).length;
    return { full, shortened, left, chapters: chat.chapters.length, chFull, logs: logs.length, logIn };
  }

  const refreshing = {};
  const PINNED_TEXT_LABEL = '(My earlier message from when this note was pinned. It was answered long ago; it is not what happens next.)';
  async function refreshMemoryMessage(chat) {
    if (!settings.memoryMessage || !settings.pinMemory || !chat.pinnedMemoryId) return;
    // One at a time per chat; a change meanwhile is picked up right after.
    if (refreshing[chat.id]) { refreshing[chat.id].again = true; return; }
    refreshing[chat.id] = {};
    try {
      await refreshMemoryMessageNow(chat);
    } finally {
      const again = refreshing[chat.id].again;
      delete refreshing[chat.id];
      if (again) schedulePinned(chat, 1000);
    }
  }
  function pinnedUpToDate(chat) {
    const text = memoryMessageText(chat);
    return !text || (chat.memoryMsgHash === hashText(text) && chat.memoryMsgSynced);
  }
  async function refreshMemoryMessageNow(chat) {
    let text = memoryMessageText(chat);
    if (!text) return;
    if (chat.memoryMsgHash === hashText(text) && chat.memoryMsgSynced) return;
    if (!await waitIdle(chat.id)) return;
    const t0 = Date.now();
    // The message may be gone (deleted, or replaced by "edit and regenerate")
    // or unpinned: then the next message carries the memory and is pinned instead.
    const lost = async (why) => {
      chat.pinnedMemoryId = null;
      chat.memoryMsgSynced = false;
      chat.memoryMsgError = '';
      logJob(chat, { kind: 'pin', label: 'The pinned memory message ' + why + '; your next message carries the memory and is pinned instead', ok: true, ms: Date.now() - t0 });
      await saveChat(chat);
      renderPanel();
    };
    try {
      const pinned = await rpc('GET', '/conversations/' + chat.id + '/messages/pinned');
      const items = pinned && Array.isArray(pinned.items) ? pinned.items : null;
      if (items && !items.some((m) => m && String(m.id) === chat.pinnedMemoryId)) return lost('is no longer pinned (deleted, regenerated or unpinned)');
    } catch (e) { /* checked again by the edit below */ }
    try {
      if (!chat.tool) {
        const conv = await rpc('GET', '/conversations/' + chat.id);
        const toolId = conv && (conv.toolId || (conv.tool && conv.tool.id));
        if (!toolId) throw new Error('could not find which bot this chat uses');
        chat.tool = { toolId, revision: conv.toolRevision || (conv.tool && conv.tool.revision) || 1, modelId: conv.modelId || (conv.model && conv.model.id) || '' };
      }
      for (let attempt = 1; ; attempt++) {
        const body = Object.assign({ toolId: chat.tool.toolId, revision: chat.tool.revision, modelId: chat.tool.modelId, conversationId: chat.id, requestId: uuid4() },
          chat.personaId ? { personaId: chat.personaId } : {},
          { overrideMessageId: chat.pinnedMemoryId, editInPlace: true, elements: [{ type: 'text', text }], language: 'en' });
        try {
          await rpc('POST', '/chat', body);
          break;
        } catch (e) {
          const m = String(e.message || e);
          if (/not found|HTTP 404/i.test(m) || attempt >= 4) throw e;
          if (/HTTP 409|generating/i.test(m)) {
            // The story AI started writing: wait until it is done, then try again.
            if (!await waitIdle(chat.id)) throw e;
            continue;
          }
          // Anything else: never a smaller message (the user wants it whole).
          // Usually a passing hiccup (e.g. MiniApps still logging in): wait, try again.
          logJob(chat, { kind: 'pin', label: 'MiniApps did not take the pinned memory message (' + body.elements[0].text.length.toLocaleString() + ' characters); trying again in full', ok: false, ms: 0, error: m.slice(0, 200) });
          await new Promise((r) => setTimeout(r, 8000 * attempt * TIME_SCALE));
        }
      }
      chat.memoryMsgHash = hashText(text);
      chat.memoryMsgSynced = true;
      chat.memoryMsgAt = Date.now();
      chat.memoryMsgChars = text.length;
      // Smaller than everything: say what was kept and what was left out.
      chat.memoryMsgCut = memoryMsgSize === Infinity ? null : Object.assign(describeCut(chat, text), { size: memoryMsgSize, chars: text.length,
        error: chat.memoryMsgRefused ? chat.memoryMsgRefused.error : '', at: chat.memoryMsgRefused ? chat.memoryMsgRefused.at : 0 });
      if (memoryMsgSize === Infinity) chat.memoryMsgRefused = null;
      if (chat.memoryMsgCut && chat.memoryMsgCut.left.length + chat.memoryMsgCut.shortened.length + (chat.memoryMsgCut.chapters - chat.memoryMsgCut.chFull) > 0 && chat.memoryMsgRefused && Date.now() - chat.memoryMsgRefused.at < 120000) {
        toast('MiniApps refused the full memory message, so a smaller one is pinned. Open 📖 to see what was left out.', true);
      }
      chat.memoryMsgError = '';
      logJob(chat, { kind: 'pin', label: 'Updated the pinned memory message (' + text.length.toLocaleString() + ' characters)', ok: true, ms: Date.now() - t0 });
    } catch (e) {
      const msg = String(e.message || e).slice(0, 160);
      if (/not found|HTTP 404/i.test(msg)) return lost('no longer exists');
      if (chat.memoryMsgError !== msg) toast('Could not update the pinned memory message: ' + msg + '. The memory is attached to your messages instead.', true);
      chat.memoryMsgSynced = false;
      chat.memoryMsgError = msg;
      logJob(chat, { kind: 'pin', label: 'Updating the pinned memory message', ok: false, ms: Date.now() - t0, error: msg });
    }
    await saveChat(chat);
    renderPanel();
  }

  function memoryInMessage(chat) {
    return !!(settings.memoryMessage && settings.pinMemory && chat.pinnedMemoryId && chat.memoryMsgSynced);
  }

  // MiniApps (PRO) keeps pinned messages in the AI's memory permanently, with
  // at most 2 pins per chat. Story Manager uses one of them for the newest
  // message that carries the memory, and never touches the user's own pins.
  async function pinMemory(chat, mid, userText) {
    if (!settings.pinMemory || chat.pinnedMemoryId === mid) return;
    if (!await waitIdle(chat.id)) return;
    const old = chat.pinnedMemoryId;
    const pin = (m) => rpc('POST', '/chat-messages/' + chat.id + '/' + m + '/pin', {});
    const unpin = (m) => rpc('POST', '/chat-messages/' + chat.id + '/' + m + '/unpin', {}).catch(() => {});
    try {
      try {
        await pin(mid);
      } catch (e) {
        // Both pin slots taken: free ours first, then try again.
        if (!old) throw e;
        await unpin(old);
        await pin(mid);
      }
      if (old) await unpin(old);
      chat.pinnedMemoryId = mid;
      // The text the user wrote in it (kept when the memory in it is updated).
      chat.pinnedMemoryText = ownText(userText);
      chat.memoryMsgSynced = true;
      chat.memoryMsgHash = '';
      chat.pinError = '';
      logJob(chat, { kind: 'pin', label: 'Pinned the newest memory message' + (old ? ' (unpinned the previous one)' : ''), ok: true, ms: 0 });
    } catch (e) {
      const msg = String(e.message || e).slice(0, 160);
      if (chat.pinError !== msg) toast('Could not pin the memory message: ' + msg + '. (Pinning needs MiniApps PRO and a free pin slot.)', true);
      chat.pinError = msg;
      logJob(chat, { kind: 'pin', label: 'Pinning the memory message', ok: false, ms: 0, error: msg });
    }
    await saveChat(chat);
  }

  // Compares the summaries with the replies actually in the chat (from a
  // read of the whole chat). A summary whose reply is gone (redone or
  // deleted while Story Manager was not watching) is handled like a deleted
  // reply: removed, and what only it said is corrected at the next update.
  // Returns how many were removed, or -1 if the read looked incomplete.
  function reconcile(chat, msgs) {
    const here = new Set(msgs.map((m) => m.id));
    // The bot's greeting is not a story reply: no summary for it.
    chat.greetingId = greetingOf(msgs);
    if (chat.greetingId && chat.log.some((e) => e.id === chat.greetingId)) {
      chat.log = chat.log.filter((e) => e.id !== chat.greetingId);
      logJob(chat, { kind: 'check', label: 'Removed the summary of the bot\'s greeting (it is not part of the story)', ok: true, ms: 0 });
    }
    chat.knownMessages = msgs.length;
    chat.knownReplies = msgs.filter((m) => m.role === 'assistant').length;
    chat.fullCheckAt = Date.now();
    // A continued chat starts with the old chat's summaries: those stay.
    if (chat.continuedFrom && !chat.inheritedMarked) {
      const first = chat.log.findIndex((e) => here.has(e.id));
      chat.log.forEach((e, i) => { if (first < 0 || i < first) e.inherited = true; });
      chat.inheritedMarked = true;
    }
    const gone = chat.log.filter((e) => !e.inherited && !here.has(e.id));
    const own = chat.log.filter((e) => !e.inherited).length;
    // A read that misses many replies is more likely incomplete than right.
    if (gone.length && (gone.length > Math.max(10, own * 0.2))) {
      logJob(chat, { kind: 'check', label: 'Checked the whole chat: ' + gone.length + ' summaries have no reply in it — too many to be redone replies, so nothing was removed (the chat may not have loaded fully)', ok: false, ms: 0 });
      return -1;
    }
    if (!gone.length) return 0;
    for (const e of gone) markStale(chat, e);
    forget(chat, gone.map((e) => e.id));
    const ids = new Set(gone.map((e) => e.id));
    chat.log = chat.log.filter((e) => !ids.has(e.id));
    for (const c of chat.chapters) if (c.ids) c.ids = c.ids.filter((x) => !ids.has(x));
    chat.processedIds = chat.processedIds.filter((x) => !ids.has(x));
    logJob(chat, { kind: 'check', label: 'Checked the whole chat: removed ' + gone.length + ' summar' + (gone.length === 1 ? 'y' : 'ies') + ' of replies that are no longer in it (redone or deleted); the memory is corrected at the next update', ok: true, ms: 0 });
    return gone.length;
  }

  // Once per page load for each story opened: read the whole chat, compare,
  // and correct the memory if summaries of vanished replies were found.
  const fullChecked = new Set();
  async function fullCheck(id) {
    if (fullChecked.has(id) || helperIds.has(id)) return;
    const chat = await getChat(id, false);
    if (!chat || !chat.enabled || !chat.log.length) return;
    if (busy[id]) { setTimeout(() => fullCheck(id), 20000 * TIME_SCALE); return; }
    fullChecked.add(id);
    let msgs;
    try { msgs = await fetchMessages(id, { mode: 'full' }); } catch (e) { fullChecked.delete(id); return; }
    if (!msgs.length || busy[id]) { fullChecked.delete(id); return; }
    const removed = reconcile(chat, msgs);
    await saveChat(chat);
    if (id === currentId) renderPanel();
    if (removed > 0) {
      toast('Removed ' + removed + ' summar' + (removed === 1 ? 'y' : 'ies') + ' of replies no longer in this chat; correcting the memory…');
      updateMemory(id, msgs).catch(() => {});
    }
  }

  function setCurrent(id) {
    if (!id || id === currentId || helperIds.has(id)) return;
    currentId = id;
    renderPanel();
    setStatus();
    runSync().catch(() => {}); // the other device may have a newer memory of this chat
    // After the sync (which may bring a newer memory), compare with the whole chat.
    setTimeout(() => ready.then(() => fullCheck(id)).catch(() => {}), 10000 * TIME_SCALE);
    // Older chapters' short versions, a few each time a story is opened, so
    // they do not wait for the next reply.
    setTimeout(() => ready.then(() => { if (currentId === id && !anyBusy()) return runShortenChapters(id, SHORTEN_PER_UPDATE); }).catch(() => {}), 40000 * TIME_SCALE);
  }

  // Single-page app: also pick the chat id up from the address bar.
  let lastHref = '';
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const m = location.href.match(UUID_RE);
    if (m) synced.then(() => setCurrent(m[0].toLowerCase()));
  }, 1000);

  // ---------------------------------------------------------------------------
  // User interface
  // ---------------------------------------------------------------------------

  let root = null;
  let ui = {};
  let tab = 'memory';
  let memTab = 'story'; // Memory: Story / Chapters / Characters
  // Tests show all three at once (as before the tabs).
  const allMemTabs = (() => { try { return localStorage.getItem('smx:allMemTabs') === '1'; } catch (e) { return false; } })();

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .fab { position: fixed; bottom: 92px; z-index: 2147483646; width: 46px; height: 46px; border-radius: 50%;
      border: none; background: #5b4bdb; color: #fff; font-size: 22px; box-shadow: 0 4px 14px rgba(0,0,0,.35);
      display: flex; align-items: center; justify-content: center; cursor: pointer; -webkit-tap-highlight-color: transparent; }
    .fab.right { right: 12px; } .fab.left { left: 12px; }
    .fab.top-right { right: 12px; top: 120px; bottom: auto; } .fab.top-left { left: 12px; top: 120px; bottom: auto; }
    .fab.middle-right { right: 6px; top: 45%; bottom: auto; }
    .fab.typing { display: none; }
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
    nav.subtabs { margin: 8px 0 4px; border-radius: 6px; position: sticky; top: 0; z-index: 1; }
    nav.subtabs button { padding: 8px 4px; font-size: 13px; }
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
    // Out of the way while the user types or edits on the site (a text box
    // has focus, or the on-screen keyboard is open): it would cover the
    // site's own buttons.
    const typingOnSite = () => {
      const a = document.activeElement;
      const field = !!(a && a !== document.body && a.id !== 'story-manager-root' &&
        (/^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName) || a.isContentEditable));
      const vv = window.visualViewport;
      const keyboard = !!(vv && vv.height < window.innerHeight * 0.75);
      // (Touch screens only: on a computer the button never covers the message box.)
      const touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      ui.fab.classList.toggle('typing', touch && (field || keyboard) && !(ui.panel && ui.panel.classList.contains('open')));
    };
    document.addEventListener('focusin', typingOnSite, true);
    document.addEventListener('focusout', () => setTimeout(typingOnSite, 50), true);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', typingOnSite);
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
    setTimeout(prerenderPanel, 3000); // draw the panel ahead of time, once the page has settled
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
      // Already drawn in the background (see renderPanel): just show it; otherwise draw now.
      if (panelDirty || !ui.body.firstChild) renderPanel(true);
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

  // A live "… ago" in the panel: it shows the CURRENT value of a chat's time
  // (e.g. when the pinned message was last updated), re-read every 15 seconds
  // and whenever a job changes it, so it never shows a time from before.
  function agoEl(chat, field) {
    return el('span', { 'data-ago-chat': chat.id, 'data-ago-field': field }, ago(chat[field]));
  }
  function refreshAgo() {
    if (!root) return;
    for (const sp of root.querySelectorAll('[data-ago-field]')) {
      const c = chats[sp.getAttribute('data-ago-chat')];
      if (c) sp.textContent = ago(c[sp.getAttribute('data-ago-field')]);
    }
  }
  setInterval(refreshAgo, 15000);

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(ts).toLocaleDateString();
  }

  // Re-render only when forced or when the user is not typing in the panel.
  // The panel is drawn ahead of time while it is closed, when the browser is idle, so opening
  // it is instant; anything that changes the memory marks it to be drawn again.
  let panelDirty = true;
  let prerenderQueued = false;
  function prerenderPanel() {
    if (prerenderQueued || !ui.panel) return;
    prerenderQueued = true;
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1500));
    idle(() => {
      prerenderQueued = false;
      if (!ui.panel || ui.panel.classList.contains('open') || !panelDirty) return;
      drawPanel();
    }, { timeout: 8000 });
  }
  function renderPanel(force) {
    if (!ui.panel) return;
    if (!ui.panel.classList.contains('open')) { panelDirty = true; prerenderPanel(); return; }
    drawPanel(force);
  }
  function drawPanel(force) {
    const active = root.activeElement;
    if (!force && active && /TEXTAREA|INPUT|SELECT/.test(active.tagName)) return;
    ui.tabs.memory.classList.toggle('on', tab === 'memory');
    ui.tabs.settings.classList.toggle('on', tab === 'settings');
    // Sections the user opened stay open when the panel is redrawn (updates
    // and background checks redraw it often).
    const keyOf = (d) => { const sm = d.querySelector(':scope > summary'); return sm ? sm.textContent.split(' · ')[0].replace(/^★ /, '') : ''; };
    const opened = new Set([...ui.body.querySelectorAll('details[open]')].map(keyOf).filter(Boolean));
    ui.body.replaceChildren(tab === 'memory' ? memoryView() : settingsView());
    panelDirty = false;
    if (opened.size) for (const d of ui.body.querySelectorAll('details')) if (opened.has(keyOf(d))) d.open = true;
  }

  function memoryView() {
    if (storageFailed) return el('div', { class: 'status' }, el('div', { class: 'error' }, '⚠ Story Manager could not read its saved data from Tampermonkey this time, so it is paused to keep your memory safe. Reload the page.'));
    // The page shows a helper chat (Story Manager never makes those "current").
    const onPage = ((location.href.match(UUID_RE) || [])[0] || '').toLowerCase();
    const chat = onPage && helperIds.has(onPage) ? (chats[onPage] || newChat(onPage)) : currentId && chats[currentId];
    // The open chat (or the current one) has no memory loaded yet: load it.
    const want = !chat && (onPage && !helperIds.has(onPage) ? onPage : currentId);
    if (want) {
      getChat(want, true).then((c) => {
        if (!c) return;
        if (!currentId || currentId === want || onPage === want) { currentId = want; renderPanel(true); setTimeout(() => fullCheck(want).catch(() => {}), 10000 * TIME_SCALE); }
        fetchMessages(want, { mode: 'since' }).then((msgs) => syncChat(want, msgs, { final: true })).catch(() => {});
      }).catch(() => {});
    }
    if (!chat) {
      return el('div', {},
        el('div', { class: 'empty' }, 'Open a chat (or send a message) and its story memory will appear here.'),
        diagnosticsBox());
    }
    if (helperIds.has(chat.id)) {
      return el('div', {},
        el('div', { class: 'status' }, el('b', {}, 'This is one of Story Manager\'s helper chats.'),
          el('div', {}, 'Story Manager sends its summary requests here; it is not one of your stories. Open your story chat to see its memory.'),
          toolCache && chat.tool && toolCache.id === chat.tool.toolId || toolCache && Object.values(chats).some((c) => c.tool && c.tool.toolId === toolCache.id)
            ? el('div', { class: 'error' }, '⚠ Your memory keeper is the same bot you write stories with, so MiniApps may open these helper chats as your latest chat with it. Pick a different bot in Settings → MiniApps bot.') : null,
          el('div', { class: 'btns' }, el('button', { class: 'btn primary', onclick: () => {
            const latest = Object.values(chats).filter((c) => c.id !== chat.id && !helperIds.has(c.id) && (c.log.length || c.processedIds.length))
              .sort((a, b) => (b.changedAt || 0) - (a.changedAt || 0))[0];
            if (!latest) { toast('No story with a memory yet on this device.'); return; }
            location.href = location.pathname.replace(chat.id, latest.id);
          } }, 'Back to my latest story'), el('button', { class: 'btn', onclick: async () => {
            if (!confirm('Treat this chat as one of your stories? Story Manager stops using it as a helper chat and starts managing its memory.')) return;
            await notHelper(chat.id);
            setCurrent(chat.id);
            toast('This chat is now treated as a story');
            renderPanel(true);
            fetchMessages(chat.id, { mode: 'since' }).then((msgs) => syncChat(chat.id, msgs, { final: true })).catch(() => {});
          } }, 'This is my story, not a helper chat'))),
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

    // Only the open sub-tab is drawn (a long story has a lot of text); switching tabs keeps edits.
    const showTab = (k) => memTab === k || allMemTabs;
    const editors = [];
    const chapterEds = [];
    const chapterBox = el('div', {}), entryBox = el('div', {}), secretsBox = el('div', {});
    const built = {};
    const buildTab = (k) => {
      if (built[k]) return;
      built[k] = true;
      if (k === 'chapters') { chat.chapters.forEach((c, i) => chapterEds.push(chapterEditor(c, i, chat))); chapterBox.replaceChildren(...chapterEds.map((ed) => ed.node)); }
      if (k === 'characters') {
        chat.entries.forEach((e) => editors.push(factsMode(chat) ? factsEntryView(chat, e) : entryEditor(chat, e)));
        entryBox.replaceChildren(...editors.map((ed) => ed.node));
        if (factsMode(chat)) secretsBox.replaceChildren(secretsView(chat));
      }
    };
    if (showTab('chapters')) buildTab('chapters');
    if (showTab('characters')) buildTab('characters');

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
      refreshMemoryMessage(chat);
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
        chat.knownMessages = countMessages(chat, msgs);
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
            ' (Pinned facts, entries marked "Always send" and facts you added yourself are kept.)')) return;
          // A classic story is rebuilt in the facts format, if the user agrees.
          const toFacts = !factsMode(chat) && confirm('Rebuild this story in the new facts format? (Recommended: the characters are built from facts taken out of every reply.) Cancel keeps the classic format.');
          // Let an automatic update that started meanwhile finish first.
          for (let i = 0; busy[chat.id] && i < 600; i++) await sleep(500);
          const old = { snap: snapshot(chat), log: chat.log.slice(), ids: chat.processedIds.slice(), count: chat.processedCount, read: chat.readCount,
            format: chat.format, hidden: (chat.hiddenRecords || []).slice(), portraits: chat.portraits, classic: chat.classicEntries };
          chat.history = [old.snap].concat(chat.history).slice(0, 5);
          if (toFacts) { chat.classicEntries = cloneEntries(chat.entries); chat.format = 'facts'; }
          // Facts removed by hand were remembered by their place in a summary, and
          // portraits describe the old facts: both start again with the new summaries.
          chat.hiddenRecords = [];
          chat.portraits = {};
          chat.memory = '';
          chat.entries = chat.entries.filter((e) => e.always);
          chat.chapters = [];
          chat.log = [];
          chat.stale = [];
          chat.processedIds = [];
          chat.processedCount = 0;
          chat.rebuiltWith = SM_VERSION;
          chat.rebuiltAt = Date.now();
          chat.smVersions = []; // a rebuild starts the list of versions again
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
            chat.format = old.format;
            chat.hiddenRecords = old.hidden;
            chat.portraits = old.portraits;
            chat.classicEntries = old.classic;
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
        } else if (!unprocessed(chat, msgs).length && !stages(chat).unfolded && !(chat.redo || []).length && !(chat.stale || []).length) {
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
      chat.staleFacts = false;
      chat.stale = [];
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

    const continueNew = async () => {
      if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
      if (!confirm('Start a new chat with the same bot that carries on this story? Its first message holds the memory and your last AI reply, and the new chat gets a copy of this memory. This chat stays as it is.')) return;
      await save(true);
      try {
        toast('Starting the new chat…');
        const id = await continueInNewChat(chat);
        location.href = location.pathname.includes(chat.id) ? location.pathname.replace(chat.id, id) : '/c/' + id;
      } catch (e) {
        toast('Could not start the new chat: ' + (e.message || e), true);
      }
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
    // Not cheap: worked out again only when the facts changed.
    const sortKeyNow = [chat.log.length, (chat.log[chat.log.length - 1] || {}).id, (chat.reconRecords || []).length, Object.keys(chat.sortings || {}).length, (chat.hiddenRecords || []).length].join('|');
    if (!chat.__sortCount || chat.__sortCount.key !== sortKeyNow) Object.defineProperty(chat, '__sortCount', { value: { key: sortKeyNow, n: factsMode(chat) ? sortCandidates(chat).length : 0 }, configurable: true, enumerable: false, writable: true });
    const sortCount = chat.__sortCount.n;
    return el('div', {},
      el('div', { class: 'status' },
        el('div', {}, el('b', {}, chat.title || 'Chat'), ' · ', chat.id.slice(0, 8)),
        versionLine(chat),
        formatLine(chat),
        (() => {
          const hold = Math.max(0, Number(settings.holdBack) || 0);
          const waiting = waitingReplies(chat);
          const done = chat.log.length;
          const own = chat.log.filter((e) => !e.inherited).length;
          const replies = Math.max(chat.knownReplies || 0, own + waiting);
          return el('div', {}, 'AI replies in this chat: ', el('b', {}, String(replies)),
            ' · summarised: ', el('b', {}, String(own)),
            waiting ? ' · waiting: ' + waiting + (hold && waiting <= hold ? ' (the newest ' + (hold === 1 ? 'reply waits' : hold + ' replies wait') + ' in case you redo ' + (hold === 1 ? 'it' : 'them') + ')' : '') : ' · none waiting',
            ' (' + (total ? total + ' messages including yours' : 'messages not counted yet') +
            (chat.allVersions > total ? ', ' + chat.allVersions + ' counting every redone version' : '') + ')',
            chat.log.length > own ? ' · plus ' + (chat.log.length - own) + ' from the chat this one continues' : '',
            ' · Last update: ', el('b', {}, agoEl(chat, 'lastUpdate')));
        })(),
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
            // The count goes on past the first estimate (chapters, short versions and
            // corrections are only known as it goes): then the step alone is shown.
            ? (progress[chat.id].done < progress[chat.id].total
              ? ' (step ' + (progress[chat.id].done + 1) + ' of about ' + progress[chat.id].total + ')'
              : ' (step ' + (progress[chat.id].done + 1) + ' — more than first estimated, nearly done)') : ''),
          ' ', el('button', { class: 'btn', onclick: () => { stopRequested[chat.id] = true; toast('Stopping after the current request…'); } }, '■ Stop')) : null,
        !isBusy && chat.backlog ? el('div', { class: 'error' }, '⚠ ' + chat.backlog.messages + ' messages are not in the memory yet (about ' +
          chat.backlog.requests + ' requests). Tap "Update now" to read them.') : null,
        chat.lastError ? el('div', { class: 'error' }, '⚠ ' + chat.lastError) : null,
        chatErrors[chat.id] && TOO_LONG_RE.test(chatErrors[chat.id].error)
          ? el('div', { class: 'error' }, '⚠ This chat has become too long for the AI (MiniApps sends the whole chat every time). Tap "Continue in a new chat" below to carry the story on in a fresh chat.') : null,
        memoryInMessage(chat)
          ? el('div', {}, '📌 The memory lives in one pinned message, updated in place (', agoEl(chat, 'memoryMsgAt'), ')' +
            (pinnedUpToDate(chat) ? '' : ' — it is behind the memory and will be updated as soon as the story AI is idle') + '. The AI keeps it however long the chat gets, and new messages carry no memory.')
          : chat.pinnedMemoryId && settings.pinMemory ? el('div', {}, '📌 The newest memory message is pinned, so the AI keeps it however long the chat gets.' +
            (chat.memoryMsgChars ? ' Size: about ' + tokensOf(chat.memoryMsgChars).toLocaleString() + ' tokens' + (tokensOf(chat.memoryMsgChars) > 50000 ? ' ⚠ large: the story AI reads it together with the whole chat (DeepSeek reads at most about 164,000 tokens in all).' : '.') : '')) : null,
        chat.memoryMsgError && settings.memoryMessage && !memoryInMessage(chat) ? el('div', { class: 'error' }, '⚠ Could not update the pinned memory message (' + chat.memoryMsgError + '); the memory is attached to your messages instead.') : null,
        chat.pinError && settings.pinMemory ? el('div', { class: 'error' }, '⚠ Could not pin the memory message: ' + chat.pinError) : null,
        chat.memoryMsgCut && memoryInMessage(chat) && (chat.memoryMsgCut.left.length || chat.memoryMsgCut.shortened.length ||
          chat.memoryMsgCut.chFull < chat.memoryMsgCut.chapters || chat.memoryMsgCut.logIn < chat.memoryMsgCut.logs) ? (() => {
          const c = chat.memoryMsgCut;
          const list = (a) => a.length ? a.join(', ') : 'none';
          return el('div', { class: 'error' },
            el('div', {}, el('b', {}, '⚠ The pinned memory message is not complete. '),
              c.error ? 'MiniApps refused the full message (' + c.error + '), so a smaller one (' + c.chars.toLocaleString() + ' characters, limit ' + c.size.toLocaleString() + ') is pinned instead.'
                : 'A smaller one (' + c.chars.toLocaleString() + ' characters, limit ' + c.size.toLocaleString() + ') is pinned, because MiniApps refused a bigger one before.'),
            el('div', {}, 'Characters & details in full: ' + list(c.full)),
            c.shortened.length ? el('div', {}, 'Shortened (start and newest facts kept): ' + list(c.shortened)) : null,
            c.left.length ? el('div', {}, 'Left out: ' + list(c.left)) : null,
            el('div', {}, 'Chapters: ' + c.chFull + ' of ' + c.chapters + ' in full' + (c.chapters > c.chFull ? ', the older ' + (c.chapters - c.chFull) + ' by title only' : '') +
              ' · Recent reply summaries: ' + c.logIn + ' of ' + c.logs),
            el('div', {}, 'Tick "Always send" on a character to keep them in, or put must-know facts in Pinned facts.'),
            el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: async () => {
              memoryMsgSize = MEMORY_MESSAGE_SIZES[0];
              await Store.set('memoryMsgSize', 0);
              chat.memoryMsgHash = '';
              chat.memoryMsgRefused = null;
              toast('Trying the full memory message again…');
              await refreshMemoryMessage(chat);
              renderPanel(true);
            } }, 'Try the full size again')));
        })() : null,
        settings.provider === 'miniapps' && toolCache && chat.tool && toolCache.id === chat.tool.toolId
          ? el('div', { class: 'error' }, '⚠ The memory keeper is the same bot as this story. MiniApps may then open Story Manager\'s helper chats instead of your story. Pick a different bot in Settings → MiniApps bot.') : null,
        (chat.stale || []).length ? el('div', {}, 'ℹ ' + chat.stale.length + ' repl' + (chat.stale.length === 1 ? 'y was' : 'ies were') + ' deleted or redone after their facts went into the story & characters. At the next update, the memory keeper takes out what only ' + (chat.stale.length === 1 ? 'it' : 'they') + ' said and rewrites ' + (chat.stale.length === 1 ? 'its chapter' : 'their chapters') + '.')
          : chat.staleFacts ? el('div', {}, 'ℹ Some replies were deleted or rewritten after their facts went into the story & characters. Tap "Redo story & characters from summaries" to remove anything from the old versions.') : null,
        chat.continuedIn ? el('div', {}, 'This story continues in chat ' + chat.continuedIn.slice(0, 8) + '.') : null,
        chat.continuedFrom ? el('div', {}, 'Continued from chat ' + chat.continuedFrom.slice(0, 8) + ', with its memory.') : null),
      el('div', { class: 'row' }, enabled, el('label', { for: 'smx-en' }, 'Auto-manage this chat')),
      // Story / Chapters / Characters, so there is less to scroll. All three are
      // built (hidden ones too), so Save still saves everything.
      (() => {
        const views = [['story', '📖 Story'], ['chapters', '📚 Chapters (' + chat.chapters.length + ')'], ['characters', '👥 Characters (' + chat.entries.length + ')']];
        const bar = el('nav', { class: 'subtabs' }, ...views.map(([k, label]) => el('button', { class: memTab === k ? 'on' : '', onclick: (ev) => {
          // Only show/hide (what was typed stays); a tab is drawn the first time it is opened.
          memTab = k;
          buildTab(k);
          for (const b of bar.children) b.classList.toggle('on', b === ev.currentTarget);
          for (const d of ui.body.querySelectorAll('[data-memtab]')) d.style.display = d.getAttribute('data-memtab') === k ? '' : 'none';
        } }, label)));
        return bar;
      })(),
      el('div', { 'data-memtab': 'story', style: memTab === 'story' || allMemTabs ? undefined : 'display:none' },
      el('label', {}, '📌 Pinned facts (never changed automatically, always sent)'),
      pinned,
      el('label', {}, '📖 The story now (current scene, open threads, world & timeline; always sent)'),
      mem,
      el('div', { class: 'hint' }, mem.value.length + ' characters.'),
      logView(chat)),
      el('div', { 'data-memtab': 'chapters', style: memTab === 'chapters' || allMemTabs ? undefined : 'display:none' },
      el('label', {}, '📚 Chapters (' + chat.chapters.length + ')'),
      el('div', { class: 'hint' }, chat.chapters.length && memoryInMessage(chat) && !chat.memoryMsgCut
        ? 'The story\'s history. Every chapter is in the pinned memory message in full.'
        : chat.chapters.length
        ? 'The story\'s history. The newest chapters are sent in full, older ones by title once they no longer fit.'
        : 'Every ' + chapterSize() + ' AI replies become a chapter of the story\'s history.'),
      chapterBox),
      el('div', { 'data-memtab': 'characters', style: memTab === 'characters' || allMemTabs ? undefined : 'display:none' },
      secretsBox,
      el('label', {}, '👥 Entries (' + chat.entries.length + ')'),
      el('div', { class: 'hint' }, chat.entries.length && memoryInMessage(chat) && !chat.memoryMsgCut
        ? 'Every entry is in the pinned memory message in full.' + (inPlay.length ? ' In the current scene: ' + inPlay.join(', ') + '.' : '')
        : inPlay.length
        ? 'In play right now (sent with every message): ' + inPlay.join(', ') + '. Others are sent when your message mentions them.'
        : 'Characters, places and items get their own entries as the story goes on. Each is sent when it is in the current scene or your message mentions it.'),
      entryBox,
      el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: addEntry }, '+ Add entry')),
      chat.ignored.length ? el('div', { class: 'hint' }, 'Deleted, not created again: ' + chat.ignored.join(', ') + ' ',
        el('button', { class: 'btn', onclick: async () => { chat.ignored = []; await saveChat(chat); renderPanel(true); } }, 'Allow again')) : null),
      el('details', { class: 'entrybox' }, el('summary', {}, '🛠 More tools (rarely needed — Story Manager does these by itself)'), el('div', { class: 'btns' },
        factsMode(chat) ? el('button', { class: 'btn', disabled: isBusy, onclick: async () => {
          if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
          if (!confirm('Have the memory keeper write the list of relationships (who is dating, married, … and how things stand) for the pinned message? One request. (A rebuild does this at its end.)')) return;
          await save(true);
          await runRelationships(chat.id);
        } }, chat.relMap ? 'Rewrite relationships (' + ago(chat.relMap.at) + ')' : 'Write relationships') : null,
        factsMode(chat) && shortPortraitsDue(chat).length ? el('button', { class: 'btn', disabled: isBusy, onclick: async () => {
          if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
          const due = shortPortraitsDue(chat).length;
          if (!confirm('Write short portraits of ' + due + ' recurring characters (who they are, how they talk and act, how they show affection)? About ' + Math.ceil(due / SHORT_PORTRAITS_PER_REQUEST) + ' requests.')) return;
          await save(true);
          await withBusy(chat.id, Math.ceil(due / SHORT_PORTRAITS_PER_REQUEST), async () => {
            const job = async (kind, label, fn) => { setStep(chat.id, label + '…'); const t0 = Date.now(); try { const r = await fn(); logJob(chat, { kind, label, ok: true, ms: Date.now() - t0 }); progress[chat.id].done++; return r; } catch (e) { if (!e.stopped) logJob(chat, { kind, label, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200) }); throw e; } };
            try { const n = await writeShortPortraits(chat, job, Infinity); toast('Wrote ' + n + ' short portraits.'); } catch (e) { await saveChat(chat); toast(e.stopped ? 'Stopped.' : 'Could not write the portraits: ' + (e.message || e), !e.stopped); }
          });
        } }, 'Write short portraits (' + shortPortraitsDue(chat).length + ')') : null,
        factsMode(chat) ? el('button', { class: 'btn', disabled: isBusy, onclick: async () => {
          if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
          if (!confirm('Have the memory keeper check what is out of date (finished goals and promises, old roles or places, who now knows each secret, the same secret under two names)? One request. Nothing is deleted.')) return;
          await save(true);
          await runReconcile(chat.id);
        } }, 'Check what is out of date') : null,
        factsMode(chat) && (chat.reconRecords || []).length ? el('button', { class: 'btn', disabled: isBusy, onclick: async () => {
          const runs = checkupRuns(chat);
          const pick = prompt('Undo which check-up? Its corrections stop counting (goals it marked done open again); nothing else changes.\n\n' +
            runs.map((x, i) => (i + 1) + ') after reply ' + x.after + ': ' + x.n + ' corrections, e.g. ' + x.sample).join('\n') + '\n\nType its number:', String(runs.length));
          const run = runs[Number(pick) - 1];
          if (!run) return;
          const n = undoCheckup(chat, run.key);
          await saveChat(chat); renderPanel(true); toast('Undone: ' + n + ' corrections from the last check-up.');
        } }, 'Undo a check-up…') : null,
        factsMode(chat) && sortCount ? el('button', { class: 'btn', disabled: isBusy, onclick: async () => {
          if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
          const n = sortCandidates(chat).length;
          if (!confirm('Have the memory keeper sort ' + n + ' facts that were filed under the wrong kind? About ' + Math.ceil(n / SORT_BATCH) + ' or more requests. The original facts are kept; every decision can be undone.')) return;
          await save(true);
          await runSortFacts(chat.id);
        } }, 'Sort unsorted facts (' + sortCount + ')') : null,
        factsMode(chat) && Object.keys(chat.sortings || {}).length ? el('button', { class: 'btn', disabled: isBusy, onclick: async () => {
          const batches = [...new Set(Object.values(chat.sortings).map((d) => String(d.batch).replace(/-\d+$/, '')))].sort();
          const last = batches[batches.length - 1];
          const which = prompt('Undo sorting: type "last" for the last run, "all" for everything, or paste a fact\'s key from Diagnostics.', 'last');
          if (!which) return;
          undoSortings(chat, which === 'all' ? { all: true } : which === 'last' ? { batch: last } : { key: which });
          await saveChat(chat); renderPanel(true); toast('Undone. The original facts count again.');
        } }, 'Undo sorting…') : null)),
      el('div', { class: 'btns' },
        el('button', { class: 'btn primary', onclick: save }, 'Save'),
        el('button', { class: 'btn', disabled: isBusy, onclick: () => runNow(false) }, 'Update now'),
        el('button', { class: 'btn', disabled: !chat.history.length, onclick: undo }, 'Undo last change')),
      el('div', { class: 'btns' },
        el('button', { class: 'btn', disabled: isBusy, onclick: () => runNow(true) }, 'Rebuild from whole chat'),
        el('button', { class: 'btn', disabled: isBusy, onclick: continueNew }, 'Continue in a new chat')),
      el('details', { class: 'entrybox' }, el('summary', {}, '🛠 Repair tools (rarely needed)'), el('div', { class: 'btns' },
        el('button', { class: 'btn', disabled: isBusy || !chat.log.length, onclick: async () => {
          if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
          const left = chat.log.filter((e) => !e.inherited && !e.verified).length;
          const n = Math.min(left, SUMMARY_CHECK_LATEST);
          const all = !n;
          if (all && !confirm('Every summary has been checked. Check all ' + chat.log.filter((e) => !e.inherited).length + ' again against their replies? This takes about ' + Math.ceil(chat.log.length / Math.max(1, detail().perChunk)) + ' requests.')) return;
          if (!all && !confirm('Check the latest ' + n + ' unchecked summaries against the actual replies, and correct wrong ones? This takes about ' + Math.ceil(n / Math.max(1, detail().perChunk)) + ' requests.' + (left > n ? ' (' + (left - n) + ' older ones stay unchecked; tap again to do the next ' + SUMMARY_CHECK_LATEST + '.)' : ''))) return;
          await save(true);
          const status = await runCheckSummaries(chat.id, all);
          if (status === 'nothing') toast('There are no summaries of replies in this chat to check.');
        } }, 'Check summaries'),
        el('button', { class: 'btn', disabled: isBusy || !chat.chapters.length, onclick: async () => {
          if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
          const left = chat.chapters.filter((c) => !c.check || c.needsCheck).length;
          const all = !left;
          const n = all ? chat.chapters.length : left;
          if (!confirm((all ? 'Every chapter has been checked. Check all ' + n + ' again' : 'Check ' + n + ' chapter' + (n === 1 ? '' : 's')) +
            ' against the summaries they were written from, and grade them? This takes about ' + Math.ceil(n / CHAPTERS_PER_CHECK) + ' requests. (Tip: "Check summaries" first.)')) return;
          await save(true);
          const status = await runCheckChapters(chat.id, all);
          if (status === 'nothing') toast('No chapters with summaries to check.');
        } }, 'Check chapters'),
        chaptersToShorten(chat) ? el('button', { class: 'btn', disabled: isBusy, onclick: async () => {
          if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
          const n = chaptersToShorten(chat);
          if (!confirm('Write the short version of ' + n + ' older chapter' + (n === 1 ? '' : 's') + ' for the pinned message now? About ' + n + ' requests. The full chapters stay stored.')) return;
          await save(true);
          const status = await runShortenChapters(chat.id, Infinity);
          if (status === 'done') toast('Short chapters written. The pinned message updates in a few seconds.');
        } }, 'Shorten old chapters now (' + chaptersToShorten(chat) + ')') : null,
        factsMode(chat) && chat.log.some((e) => !e.records && e.text) ? el('button', { class: 'btn', disabled: isBusy, onclick: async () => {
          if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
          const n = chat.log.filter((e) => !e.records && e.text).length;
          if (!confirm(n + ' summaries have no fact records yet. Take the facts out of them (the chat is not read again)? About ' + Math.ceil(n / EXTRACT_PER) + ' requests.')) return;
          await save(true);
          await runExtractRecords(chat.id);
        } }, 'Take facts from summaries') : null,
        chat.log.some((e) => !e.facts && e.nofacts !== 'none') ? el('button', { class: 'btn', disabled: isBusy, onclick: async () => {
          if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
          const n = chat.log.filter((e) => !e.facts && e.nofacts !== 'none').length;
          if (!confirm(n + ' reply summaries have no facts list (the memory keeper skipped it, or an older version made them). Ask the memory keeper for their facts again? This takes about ' + Math.ceil(n / Math.max(1, detail().perChunk)) + ' requests.')) return;
          await runMissingFacts(chat.id);
        } }, 'Get missing facts lists') : null,
        el('button', { class: 'btn', disabled: isBusy || !chat.log.length, onclick: redoFromSummaries }, 'Redo story & characters from summaries'))),
      activityView(chat),
      diagnosticsBox());
  }

  // How many summaries have facts, "none", a skipped FACTS line, or are too old to tell.
  function factsSplit(chat) {
    const n = { facts: 0, none: 0, missing: 0, unknown: 0 };
    for (const e of chat.log) n[e.facts ? 'facts' : e.nofacts === 'none' ? 'none' : e.nofacts === 'missing' ? 'missing' : 'unknown']++;
    return n.facts + ' with facts, ' + n.none + ' none' + (n.missing ? ', ' + n.missing + ' FACTS line missing' : '') + (n.unknown ? ', ' + n.unknown + ' unknown (older)' : '');
  }

  // What is still wrong in a memory, by the same rules the cleaning uses (it
  // should all read 0 after a tidy-up; anything else means a rule is missing).
  // Fact quality for Diagnostics: how many facts pass their kind's check, by
  // reply range and by how long the helper chat had been running.
  function factQualityText(chat) {
    const q = factQuality(chat).filter((x) => x.r.at !== Infinity && !x.r.recon);
    if (!q.length) return 'no facts yet';
    const count = (list) => { const c = {}; for (const x of list) c[x.status] = (c[x.status] || 0) + 1; return c; };
    const pct = (list) => (list.length ? Math.round(100 * list.filter((x) => x.status === 'ok').length / list.length) + '%' : '-');
    const c = count(q);
    const parts = ['ok ' + (c.ok || 0) + ' of ' + q.length + ' (' + pct(q) + ')'];
    for (const [k, label] of [['no-secret', '"knows" without a secret'], ['unresolved', '"knows" an unknown secret'], ['unclassified', 'unknown kind'], ['suspect-state', '"where things stand" that reads like a scene (flagged, still used)']]) if (c[k]) parts.push(c[k] + ' ' + label);
    const n = chat.log.length;
    const step = Math.max(10, Math.ceil(n / 5));
    const ranges = [];
    for (let a = 1; a <= n; a += step) { const b = Math.min(n, a + step - 1); ranges.push(a + '–' + b + ' ' + pct(q.filter((x) => x.r.at >= a && x.r.at <= b))); }
    const byLog = new Map(chat.log.map((e, i) => [i + 1, e]));
    const withPos = q.filter((x) => byLog.get(x.r.at) && byLog.get(x.r.at).hp);
    const pos = withPos.length ? ' · by helper chat position: ' + [[1, 5], [6, 15], [16, 30], [31, 9999]].map(([a, b]) => { const l = withPos.filter((x) => byLog.get(x.r.at).hp >= a && byLog.get(x.r.at).hp <= b); return l.length ? (b > 999 ? a + '+' : a + '–' + b) + ' ' + pct(l) + ' (' + l.length + ')' : ''; }).filter(Boolean).join(', ') : ' · by helper chat position: not recorded yet (summaries from v3.41 on)';
    return parts.join(', ') + ' · ok by replies: ' + ranges.join(', ') + pos;
  }
  // Sorting (step B) for Diagnostics: decisions by kind, what is left, what needs a look.
  function sortingText(chat) {
    const all = Object.values(chat.sortings || {});
    allRecords(chat);
    const review = chat.__sortReview || [];
    const left = sortCandidates(chat).length;
    if (!all.length && !left) return '';
    const c = sortingCounts(chat);
    const to = {};
    for (const d of all) if (d.decision === 'sorted' && d.to) to[d.to.label || d.to.k] = (to[d.to.label || d.to.k] || 0) + 1;
    let t = 'Sorting: ' + c.sorted + ' sorted (' + Object.entries(to).map(([k, n]) => n + ' ' + k).join(', ') + '), ' + c.dropped + ' dropped (kept in the log), ' + c.kept + ' kept as they were, ' + c.unsure + ' unsure, ' + c.failed + ' failed its checks · ' + left + ' still to sort' + (review.length ? ' · ' + review.length + ' decisions need a look (the fact was reworded by a rebuild)' : '') + '\n';
    const odd = all.filter((d) => d.decision === 'unsure' || d.decision === 'failed').slice(-12);
    if (odd.length) t += odd.map((d) => '  ? ' + d.s + ' | ' + d.k + ' | ' + String(d.v).slice(0, 70) + ' ← ' + d.decision + ': ' + d.why + '  [key: ' + d.key.slice(0, 120) + ']').join('\n') + '\n';
    return t;
  }
  function memoryHealth(chat) {
    const junk = chat.entries.reduce((n, e) => n + e.text.split('\n').filter((l) => isJunk(l, true)).length, 0) +
      chat.memory.split('\n').filter((l) => isJunk(l)).length;
    const states = chat.entries.filter((e) => splitStates(e.text).states.length).length;
    const kinds = chat.entries.filter((e) => ((e.kind || 'character') === 'character' && /^(item|place|group)$/.test(guessKind(e.name, [], e.text))) ||
      (/^(place|item)$/.test(e.kind) && PERSON_RE.test(e.text) && !ITEM_WORDS.test(e.name))).length;
    const twins = chat.entries.filter((e, i) => chat.entries.some((x, j) => j < i && sameButTitle(x.name, e.name))).length;
    const bad = [];
    if (junk) bad.push(junk + ' lines of keeper working-out');
    if (states) bad.push(states + ' entries with a "Current State"');
    if (kinds) bad.push(kinds + ' objects or places filed as characters');
    if (twins) bad.push(twins + ' duplicate people');
    const facts = factsMode(chat) ? ' · ' + allRecords(chat).length + ' facts' : ' · classic format';
    let moments = '';
    if (factsMode(chat)) {
      const ms = allRecords(chat).filter((r) => r.k === 'moment');
      const n = (t) => ms.filter((r) => (r.tier === 'turning' ? 'major' : r.tier || (r.imp ? 'major' : 'unmarked')) === t).length;
      const last = ms.filter((r) => r.at !== Infinity).reduce((m, r) => Math.max(m, r.at), 0);
      moments = ' · moments: ' + n('major') + ' major, ' + n('minor') + ' minor, ' + n('routine') + ' routine, ' + n('unmarked') + ' unmarked; newest in reply ' + (last || 'none') +
        ' · replies without a moment: ' + chat.log.filter((e) => !(e.records || []).some((r) => r.k === 'moment')).length;
    }
    return (bad.length ? '⚠ ' + bad.join(', ') : 'OK') + facts + moments;
  }

  // The memory format of this story, and the switch.
  function formatLine(chat) {
    const facts = factsMode(chat);
    const missing = chat.log.filter((e) => !e.records && e.text).length;
    return el('div', {}, 'Memory format: ', el('b', {}, facts ? 'Facts (new)' : 'Classic'),
      facts ? ' — characters are built from ' + allRecords(chat).length + ' facts' + (missing ? '; ' + missing + ' summaries have no facts yet (tap "Take facts from summaries")' : '') + '. ' : ' — ',
      el('button', { class: 'btn', onclick: async () => {
        if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
        if (facts) {
          if (!confirm('Switch this story back to the classic format? The characters go back to how they were before the switch (later changes in the facts format are not carried over).')) return;
          await switchFormat(chat, 'classic');
          return;
        }
        if (!confirm('Switch this story to the new facts format? The memory keeper will only take facts out of each reply, and Story Manager builds the characters from them (newest wins, nothing moves to the wrong person). ' +
          'Your current characters are kept, so you can switch back. Next: tap "Take facts from summaries" (about ' + Math.ceil(chat.log.length / EXTRACT_PER) + ' requests), or Rebuild from whole chat.')) return;
        await switchFormat(chat, 'facts');
      } }, facts ? 'Switch back to classic' : 'Switch to the facts format'));
  }

  // Which versions of Story Manager made this story's memory.
  // Which versions of Story Manager made the summaries the memory is built
  // from (newest first, with how many each), so only versions that matter
  // are shown; a rebuild starts the list again.
  function summaryVersions(chat) {
    const by = new Map();
    for (const e of chat.log) { const v = e.v || ''; by.set(v, (by.get(v) || 0) + 1); }
    const cmp = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
    return [...by.keys()].sort((a, b) => (!a) - (!b) || cmp(a, b)).map((v) => (v ? 'v' + v : 'an older version') + ' (' + by.get(v) + ')');
  }
  function versionLine(chat) {
    if (!chat.log.length && !chat.rebuiltWith) return null;
    const list = summaryVersions(chat);
    return el('div', {}, 'Summaries made with Story Manager: ', el('b', {}, list.join(', ') || '—'),
      chat.rebuiltWith ? ' · rebuilt with v' + chat.rebuiltWith : '');
  }



  // The facts format: an entry is built from records, so it is not edited as
  // text; its facts are listed (with the reply each came from) and can be
  // removed one by one, and the user can add facts of their own.
  const KIND_CHOICES = ['key moment', 'appearance', 'personality', 'relationship: ', 'where things stand: ', 'role', 'full name', 'age', 'ability', 'likes', 'dislikes', 'boundary', 'backstory', 'possession', 'promise', 'secret', 'goal', 'nickname', 'status', 'location', 'type'];
  function factsEntryView(chat, e) {
    const byId = new Map(allRecords(chat).map((r) => [r.id, r]));
    // "Who they are now" (main characters): editable; an edit is kept until the user asks for a new one.
    const portrait = (chat.portraits || {})[e.name.toLowerCase()];
    const isMain = mainCharacters(chat).includes(e);
    const portraitText = el('textarea', { class: 'entry', placeholder: 'A short portrait of who ' + e.name + ' is now.' });
    portraitText.value = portrait ? portrait.text : '';
    const portraitBox = isMain || portrait ? el('div', {},
      el('label', {}, 'Who they are now' + (portrait ? (portrait.manual ? ' (written by you)' : ' (written ' + ago(portrait.at) + ')') : ' (not written yet)')),
      portraitText,
      el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: async () => {
        if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
        if (!confirm('Have the memory keeper write who ' + e.name + ' is now, from their facts? One request.' + (portrait && portrait.manual ? ' (This replaces your own text.)' : ''))) return;
        e.open = true;
        await runPortrait(chat.id, e.name);
      } }, portrait ? 'Rewrite who they are now' : 'Write who they are now'))) : null;
    const recs = (e.recordIds || []).map((id) => byId.get(id)).filter(Boolean);
    const text = el('textarea', { class: 'entry', readonly: true });
    text.value = e.text;
    const kindIn = el('input', { placeholder: 'kind, e.g. key moment, relationship: Tomas', list: 'smx-kinds' });
    const valueIn = el('input', { placeholder: 'the fact' });
    const del = el('button', { class: 'btn', onclick: () => {
      if (!confirm('Delete "' + e.name + '" and all its facts? It will not be created again. (Save to confirm.)')) return;
      e.deleted = true;
      node.style.opacity = '0.4';
    } }, 'Delete');
    const node = el('details', { class: 'entrybox', open: e.open || undefined },
      el('summary', {}, (e.always ? '★ ' : '') + e.name + ' · ' + (e.kind || 'character') + ' · ' + recs.length + ' facts · ' + e.text.length + ' chars'),
      e.aliases && e.aliases.length ? el('div', { class: 'hint' }, 'Also known as: ' + e.aliases.join(', ')) : null,
      portraitBox,
      el('label', {}, 'What the AI reads (built from the facts below)'), text,
      el('label', {}, 'Facts (' + recs.length + ')'),
      el('div', { class: 'hint' }, ...recs.slice().reverse().map((r) => el('div', { class: 'row' },
        el('span', {}, (r.label || r.k) + (r.t ? ': ' + r.t : '') + ' — ' + r.v + (r.manual ? ' (added by you)' : ' (reply ' + r.at + ')') + (r.k === 'moment' && r.imp ? ' · important' : '')),
        r.k === 'moment' && !r.manual ? el('button', { class: 'btn', title: 'Always keep this moment in the pinned message', onclick: async () => {
          const kept = new Set(chat.keptMoments || []);
          if (kept.has(r.id)) kept.delete(r.id); else kept.add(r.id);
          chat.keptMoments = [...kept];
          e.open = true;
          await saveChat(chat);
          renderPanel(true);
        } }, (chat.keptMoments || []).includes(r.id) ? 'Kept ✓' : 'Keep') : null,
        el('button', { class: 'btn', title: 'Remove this fact', onclick: async () => {
          chat.hiddenRecords = [...new Set((chat.hiddenRecords || []).concat(r.id))];
          e.open = true;
          await saveChat(chat);
          renderPanel(true);
        } }, '✕')))),
      el('label', {}, 'Add a fact about ' + e.name), kindIn, valueIn,
      el('datalist', { id: 'smx-kinds' }, ...KIND_CHOICES.map((k) => el('option', { value: k }))),
      el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: async () => {
        const k = recordKind(kindIn.value || 'key moment');
        const v = valueIn.value.trim();
        if (!v) { toast('Write the fact first.'); return; }
        const list = chat.manualRecords || (chat.manualRecords = []);
        list.push({ n: list.reduce((m, x) => Math.max(m, (x.n || 0) + 1), list.length), s: e.name, k: k.kind, t: k.target, v, label: k.label });
        e.open = true;
        await saveChat(chat);
        renderPanel(true);
      } }, 'Add fact'), del));
    return { node, apply() {
      delete e.open;
      const t = portraitText.value.trim();
      const key = e.name.toLowerCase();
      if (t && (!portrait || t !== portrait.text)) { chat.portraits = chat.portraits || {}; chat.portraits[key] = { text: t, at: Date.now(), records: e.records || 0, manual: true }; }
      else if (!t && portrait) delete chat.portraits[key];
    } };
  }


  // The facts format: "Who knows what" in the panel. The user can mark
  // someone as knowing (or not knowing) a secret; their choice is the newest.
  function secretsView(chat) {
    const list = buildSecrets(chat);
    const who = el('input', { placeholder: 'who, e.g. Lena' });
    const which = el('select', {}, ...list.map((x) => el('option', { value: x.name }, '[' + x.name + ']')));
    const how = el('select', {}, el('option', { value: 'knows' }, 'knows'), el('option', { value: 'notknows' }, 'does not know'));
    const add = async () => {
      const p = who.value.trim();
      if (!p || !which.value) { toast('Choose a secret and write who.'); return; }
      const listR = chat.manualRecords || (chat.manualRecords = []);
      listR.push({ n: listR.reduce((m, x) => Math.max(m, (x.n || 0) + 1), listR.length), s: p, k: how.value, t: '', v: '[' + which.value + '] (set by you)', label: how.value === 'knows' ? 'knows' : 'does not know' });
      await saveChat(chat);
      renderPanel(true);
    };
    return el('details', { class: 'entrybox' },
      el('summary', {}, '🔒 Who knows what (' + list.length + ' secret' + (list.length === 1 ? '' : 's') + ')'),
      list.length ? el('div', { class: 'hint' }, ...list.map((x) => el('div', {},
        el('b', {}, '[' + x.name + '] '), x.text || '',
        el('div', {}, 'Knows: ' + (x.everyone ? 'everyone' : x.knows.map((p) => p.who).join(', ') || 'not recorded') +
          (x.notKnows.length ? ' · Does NOT know: ' + x.notKnows.map((p) => p.who).join(', ') : '') + (x.cover ? ' · Cover story: ' + x.cover : ''))))) :
        el('div', { class: 'hint' }, 'No secrets recorded yet. The memory keeper records them as the story goes on.'),
      list.length ? el('div', {}, el('label', {}, 'Correct who knows'), who, which, how,
        el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: add }, 'Save'))) : null);
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
  function chapterEditor(c, i, chat) {
    const title = el('input', { value: c.title });
    const text = el('textarea', { class: 'entry' });
    text.value = c.text;
    const k = c.check;
    const grade = k ? ' · ' + (chapterFlagged(c) ? '⚠ ' : '✓ ') + k.score + '/10' : c.needsCheck ? ' · to check' : '';
    const node = el('details', { class: 'entrybox' },
      el('summary', {}, 'Chapter ' + (i + 1) + ': ' + c.title + ' · ' + (c.ids ? c.ids.length + ' replies · ' : '') + c.text.length + ' chars' + grade),
      k ? el('div', { class: chapterFlagged(c) ? 'error' : 'hint' },
        el('div', {}, 'Check: ' + k.score + '/10 (' + ago(k.at) + ')' + (c.needsCheck ? ' — changed since, check again' : '')),
        k.wrong ? el('div', {}, 'Wrong: ' + k.wrong) : null,
        k.missing ? el('div', {}, 'Missing: ' + k.missing) : null,
        k.padding ? el('div', {}, 'Padding: ' + k.padding) : null) : null,
      el('label', {}, 'Title'), title,
      el('label', {}, 'Summary'), text,
      chat && chat.log.some((e) => e.chapter === i) ? el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: async () => {
        if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
        if (!confirm('Rewrite chapter ' + (i + 1) + ' from its reply summaries' + (k ? ', avoiding the problems the check found' : '') + '? (Undo last change brings the old one back.)')) return;
        await rewriteChapter(chat.id, i);
      } }, 'Rewrite')) : null);
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
    // Filled only when opened: a long log is a lot of text to draw every time the panel opens.
    const fill = () => { box.value = chat.log.length
      ? chat.log.slice().reverse().map((e, i) => '#' + (chat.log.length - i) +
        (!e.folded ? ' ⏳' : e.chapter != null ? ' 📚' + (e.chapter + 1) : '') + '  ' + e.text +
        (e.facts ? '\n   Facts: ' + e.facts : '')).join('\n\n')
      : 'Each AI reply gets a detailed summary here as the story goes on.'; };
    const attached = Math.min(chat.log.length, Math.max(0, Number(settings.logAttach) || 0));
    const d = el('details', { class: 'entrybox' }, el('summary', {}, '📜 Reply-by-reply log (' + chat.log.length + ' entries, newest first)'), box);
    d.addEventListener('toggle', () => { if (d.open && !box.value) fill(); });
    return el('div', {},
      d,
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
        (chat ? ' · messages seen: ' + (seenMsgs[currentId] ? seenMsgs[currentId].size : 0) + ' · AI replies: ' + (chat.knownReplies || '?') + ' · summarised: ' + chat.log.filter((e) => !e.inherited).length + ' · waiting: ' + waitingReplies(chat) +
          ' · whole chat last compared: ' + (chat.fullCheckAt ? ago(chat.fullCheckAt) : 'never') : ''),
      'Learned message address: ' + (learned ? shortUrl(learned.template.split('{id}').join('00000000-0000-0000-0000-000000000000')) : 'none yet'),
      'Memory keeper: ' + settings.provider + (settings.provider === 'miniapps' ? ' (' + settings.miniappsSlug + ')' : ''),
      'Helper chat: ' + (helperChats.some(Boolean) ? helperChats.map((h, i) => (h ? (i ? 'slot ' + i + ' ' : '') + h.id.slice(0, 8) + ', ' + h.uses + ' requests' : '')).filter(Boolean).join(' · ') : 'none yet') +
        (helperWait ? ' · last wait: ' + Math.round((Date.now() - helperWait.started) / 1000) + 's ago started, messages ' + (helperWait.roles || '-') +
          ', request ' + (helperWait.requestFound ? 'found' : 'not found') + ', new answers ' + helperWait.newAnswers +
          (helperWait.readOk ? '' : ', last read failed') + ', answer ' + helperWait.answerChars + ' chars' +
          (helperWait.done ? ', done' : '') +
          ', bot last active ' + (helperWait.lastActivity ? Math.round((Date.now() - helperWait.lastActivity) / 1000) + 's ago' : 'never') : ''),
      'Storage: ' + (storageFailed ? 'FAILED — ' + storageFailed + '; nothing is saved until you reload' : hasGM ? 'Tampermonkey' : hasGMLegacy ? 'Tampermonkey (old style)' : 'browser') + '\n' +
      'Settings: saved here ' + (settings.settingsAt ? ago(settings.settingsAt) + ' (' + new Date(settings.settingsAt).toLocaleString() + ')' : 'never') +
        ' · on GitHub: ' + (!settings.githubToken ? 'sync off' : sync.remoteSettings ? 'saved ' + new Date(sync.remoteSettings.at).toLocaleString() + ', keeper ' + sync.remoteSettings.keeper : 'none yet') + '\n' +
      'Memory health: ' + (chat ? memoryHealth(chat) : 'no chat') + '\n' +
      (chat && factsMode(chat) ? 'Fact quality: ' + factQualityText(chat) + '\n' : '') +
      (chat && factsMode(chat) ? sortingText(chat) : '') +
      (chat && keeperTestCache[chat.id] ? keeperTestText(keeperTestCache[chat.id]) : '') +
      'Summaries made with: ' + (chat && chat.log.length ? summaryVersions(chat).join(', ') : 'none yet') + (chat && chat.rebuiltWith ? ', rebuilt with v' + chat.rebuiltWith : '') + '\n' +
      'Pipeline: ' + (chat ? (() => { const st = stages(chat); return st.summaries + ' summaries (' + factsSplit(chat) + '), ' +
        chat.log.filter((e) => e.checked).length + ' facts-checked, ' + st.unfolded + ' waiting for story & characters, ' + st.unchaptered + ' waiting for a chapter, ' + st.chapters + ' chapters' +
        ' · settings: summaries every ' + settings.updateEvery + ', story & characters every ' + foldEvery() + ', chapter every ' + chapterSize() +
        ', ' + parallel() + ' at once, detail ' + settings.detail; })() : 'no chat'),
      'Pinned memory message: ' + (!settings.pinMemory ? 'off' : chat && chat.pinnedMemoryId ? chat.pinnedMemoryId.slice(0, 8) : 'none yet') +
        (chat && memoryInMessage(chat) ? ' · holds the memory (updated ' + ago(chat.memoryMsgAt || 0) + ')' : '') +
        (chat && memoryInMessage(chat) ? (pinnedUpToDate(chat) ? ' · up to date' : ' · out of date, updates when the story AI is idle') : '') +
        (chat && chat.memoryMsgChars ? ' · size ' + chat.memoryMsgChars.toLocaleString() + ' characters, about ' + tokensOf(chat.memoryMsgChars).toLocaleString() + ' tokens' : '') +
        (chat && chat.memoryMsgError ? ' · last update error: ' + chat.memoryMsgError : '') +
        (chat && chat.pinError ? ' · last pin error: ' + chat.pinError : ''),
      'Sync: ' + (sync.state === 'ok' ? 'last synced ' + ago(sync.at) : sync.state === 'error' ? 'error: ' + sync.error : 'off') +
        (chat ? ' · this chat changed ' + ago(chat.changedAt || 0) + ', saved to GitHub ' + ago(chat.syncedAt || 0) : ''),
      'Last check-up: ' + (chat && chat.reconReport ? ago(chat.reconReport.at) + ' · looked at ' + chat.reconReport.open + ' characters with open items and ' + chat.reconReport.secrets + ' secrets · ' + chat.reconReport.applied.length + ' applied, ' + chat.reconReport.skipped.length + ' not used' : 'never') + '\n' +
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
      // The last check-up in full (story words: what the keeper said and what was done with it).
      ...(chat && chat.reconReport ? ['Last check-up, applied:', ...(chat.reconReport.applied.length ? chat.reconReport.applied.map((l) => '  ✓ ' + l) : ['  (nothing)']),
        'Last check-up, not used:', ...(chat.reconReport.skipped.length ? chat.reconReport.skipped.map(([l, why]) => '  ✗ ' + l + '  ← ' + why) : ['  (nothing)']),
        'Last check-up, the keeper\'s whole answer:', chat.reconReport.answer || '(empty)', '',
        'Last check-up, goal levels set:', chat.reconReport.levels || '(none asked — every goal already has a level)', ''] : []),
      'Send requests (newest first; field names and short values, no message text):',
      ...(sendShapes.length ? sendShapes.map((x) => Math.round((Date.now() - x.at) / 1000) + 's ago' + (x.injected ? ' [memory attached]' : '') + ': ' + JSON.stringify(x.shape)) : ['(none yet)']),
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

  // "Export for testing": everything Story Manager made from the story (the
  // summaries, their facts and source replies, check-up corrections and where
  // they came from, chapters, the memory, the built entries and the pinned
  // message) — never the chat's own messages. Used to test new versions on a
  // real story before they are released.
  function testExport(chat) {
    const version = typeof GM_info !== 'undefined' && GM_info && GM_info.script ? GM_info.script.version : '?';
    let pinned = '';
    // (Without the user's own message text that the pinned message carries.)
    try { const plan = buildPlan(chat, memoryMsgSize); if (plan) { plan.fillAll = true; pinned = composeMemory(plan, '').text; } } catch (e) { pinned = ''; }
    return {
      kind: 'story-manager-test-export', exportVersion: 1, smVersion: version, exportedAt: new Date().toISOString(),
      format: chat.format || 'classic',
      settings: { momentsShown: settings.momentsShown, detail: settings.detail },
      log: chat.log.map((e, i) => ({ reply: i + 1, id: e.id, v: e.v || '', chapter: e.chapter, folded: !!e.folded, summary: e.text, facts: e.facts || '', records: e.records || [], helperChat: e.hc || '', helperPos: e.hp || 0 })),
      manualRecords: chat.manualRecords || [], hiddenRecords: chat.hiddenRecords || [],
      reconRecords: chat.reconRecords || [], reconReport: chat.reconReport || null, reconAt: chat.reconAt || 0,
      secretAlias: chat.secretAlias || {}, commitReg: chat.commitReg || [], commitAlias: chat.commitAlias || {}, commitTier: chat.commitTier || {}, setupCast: chat.setupCast || null, sortings: chat.sortings || {}, keptMoments: chat.keptMoments || [], ignored: chat.ignored || [],
      relMap: chat.relMap || null, portraits: chat.portraits || {},
      chapters: (chat.chapters || []).map((c) => ({ title: c.title, text: c.text, short: c.short || '' })),
      memory: chat.memory || '', pinnedNote: chat.pinned || '',
      entries: (chat.entries || []).map((e) => ({ name: e.name, kind: e.kind, aliases: e.aliases || [], text: e.text, pinText: e.pinText || '', miniText: e.miniText || '' })),
      pinnedMessage: pinned,
    };
  }
  function exportForTesting() {
    const chat = currentId && chats[currentId];
    if (!chat) { toast('Open the story first.'); return; }
    const ok = downloadText('story-manager-test-' + currentId.slice(0, 8) + '.json', JSON.stringify(testExport(chat), null, 1));
    toast(ok ? 'Saved the test file. It holds your story\'s summaries and memory (not the chat itself).' : 'Could not save the file.', !ok);
  }
  function diagnosticsBox() {
    const box = el('textarea', { readonly: true, class: 'diag' });
    box.style.display = 'none';
    box.style.minHeight = '220px';
    const show = async () => {
      const c = currentId && chats[currentId];
      if (c && !(c.id in keeperTestCache)) { try { keeperTestCache[c.id] = await Store.get('keeperTest:' + c.id, null); } catch (e) { keeperTestCache[c.id] = null; } }
      box.value = diagnosticsText();
      box.style.display = '';
    };
    const copy = async () => {
      await show();
      // No select()/focus here: it would scroll the page (see togglePanel).
      try { await navigator.clipboard.writeText(box.value); toast('Diagnostics copied — paste them to Claude'); } catch (e) { toast('Long-press the text in the box to copy it'); }
    };
    return el('div', {},
      el('div', { class: 'btns' },
        el('button', { class: 'btn', onclick: show }, 'Diagnostics'),
        el('button', { class: 'btn', onclick: copy }, 'Copy diagnostics'),
        el('button', { class: 'btn', onclick: exportForTesting }, 'Export for testing')),
      el('details', { class: 'entrybox' }, el('summary', {}, '🧪 Keeper test'), el('div', { class: 'btns' },
        el('button', { class: 'btn', onclick: async () => {
          const chat = currentId && chats[currentId];
          if (!chat || !factsMode(chat)) { toast('Open a story that uses the facts format first.'); return; }
          if (busy[chat.id]) { toast('The memory is being updated right now — try again in a moment'); return; }
          const which = prompt('Keeper test: summarise 30 replies (10 early, 10 middle, 10 late) twice and compare. About 20 requests; nothing in the story changes.\n\nType 1 to compare the current rules with compact rules, or 2 to compare the current rules with and without the context normal processing sends (scene and open goals).', '2');
          if (which !== '1' && which !== '2') return;
          await runKeeperTest(chat.id, which === '2' ? 'context' : 'rules');
        } }, 'Keeper test (A/B)'),
        el('button', { class: 'btn', onclick: async () => {
          const chat = currentId && chats[currentId];
          const r = chat && (keeperTestCache[chat.id] || await Store.get('keeperTest:' + chat.id, null));
          if (!r) { toast('No keeper test yet for this story.'); return; }
          if (!confirm('The file holds the 30 test replies themselves (story text) and both keepers\' answers, so the results can be checked by hand. Save it?')) return;
          downloadText('story-manager-keeper-test-' + chat.id.slice(0, 8) + '.json', JSON.stringify(r, null, 1));
        } }, 'Download keeper test'))),
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
    f.holdBack = el('input', { type: 'number', min: '0', value: String(s.holdBack == null ? 2 : s.holdBack) });
    f.foldEvery = el('input', { type: 'number', min: '1', value: String(s.foldEvery) });
    f.chapterSize = el('input', { type: 'number', min: '4', value: String(s.chapterSize) });
    f.parallel = el('select', {}, ...[1, 2, 3, 4, 5].map((n) => el('option', { value: String(n), selected: Number(s.parallel) === n ? '' : null }, String(n))));
    f.injectEvery = el('input', { type: 'number', min: '0', value: String(s.injectEvery) });
    f.detail = el('select', {}, ...Object.entries(DETAIL).map(([k, d]) => el('option', { value: k, selected: s.detail === k ? '' : null }, d.label)));
    f.logAttach = el('input', { type: 'number', min: '0', value: String(s.logAttach) });
    f.injectBudget = el('input', { type: 'number', min: '2000', step: '1000', value: String(s.injectBudget) });
    f.pinMemory = el('input', { type: 'checkbox', id: 'smx-pin' });
    f.pinMemory.checked = s.pinMemory !== false;
    f.memoryMessage = el('input', { type: 'checkbox', id: 'smx-memmsg' });
    f.memoryMessage.checked = s.memoryMessage !== false;
    f.githubToken = el('input', { type: 'password', value: s.githubToken || '', placeholder: 'GitHub token (gist access only)', autocomplete: 'off' });
    f.hideHelpers = el('input', { type: 'checkbox', id: 'smx-hide' });
    f.hideHelpers.checked = s.hideHelpers !== false;
    f.autoEnable = el('input', { type: 'checkbox', id: 'smx-auto' });
    f.autoEnable.checked = s.autoEnable;
    f.blockSounds = el('input', { type: 'checkbox', id: 'smx-sounds' });
    f.blockSounds.checked = s.blockSounds !== false;
    f.newFormat = el('select', {}, el('option', { value: 'facts' }, 'Facts (new): characters built from facts'), el('option', { value: 'classic' }, 'Classic'));
    f.newFormat.value = s.newFormat === 'classic' ? 'classic' : 'facts';
    f.momentsShown = el('select', {}, el('option', { value: 'important' }, 'Shortened: what matters for the story (everything stays stored)'), el('option', { value: 'all' }, 'Everything in full'));
    f.momentsShown.value = s.momentsShown === 'all' ? 'all' : 'important';
    f.threadsShown = el('select', {}, el('option', { value: 'records' }, 'Built from the goals (always matches them)'), el('option', { value: 'keeper' }, "The keeper's own text"));
    f.threadsShown.value = s.threadsShown === 'keeper' ? 'keeper' : 'records';
    f.buttonSide = el('select', {},
      el('option', { value: 'right' }, 'Bottom right'), el('option', { value: 'left' }, 'Bottom left'),
      el('option', { value: 'top-right' }, 'Top right'), el('option', { value: 'top-left' }, 'Top left'),
      el('option', { value: 'middle-right' }, 'Middle right'));
    f.buttonSide.value = s.buttonSide;

    const keyBox = el('div', {}, el('label', {}, 'API key'), f.apiKey, el('label', {}, 'Model'), f.model);
    const baseBox = el('div', {}, el('label', {}, 'Base URL'), f.baseUrl,
      el('div', { class: 'hint' }, 'OpenRouter: https://openrouter.ai/api/v1 · OpenAI: https://api.openai.com/v1 · Groq: https://api.groq.com/openai/v1'));
    const sameBot = toolCache && Object.values(chats).some((c) => c.tool && c.tool.toolId === toolCache.id && !helperIds.has(c.id));
    const slugBox = el('div', {}, el('label', {}, 'MiniApps bot used as memory keeper (slug from its URL)'), f.miniappsSlug,
      sameBot ? el('div', { class: 'error' }, '⚠ This is a bot you also write stories with. Use a different bot here: otherwise MiniApps can open Story Manager\'s helper chats as your latest chat with it.') : null,
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
      holdBack: Math.max(0, parseInt(f.holdBack.value, 10) || 0),
      foldEvery: Math.max(1, parseInt(f.foldEvery.value, 10) || DEFAULT_SETTINGS.foldEvery),
      chapterSize: Math.max(4, parseInt(f.chapterSize.value, 10) || DEFAULT_SETTINGS.chapterSize),
      parallel: Math.min(MAX_PARALLEL, Math.max(1, parseInt(f.parallel.value, 10) || 1)),
      injectEvery: Math.max(0, parseInt(f.injectEvery.value, 10) || 0),
      detail: f.detail.value,
      logAttach: Math.max(0, parseInt(f.logAttach.value, 10) || 0),
      injectBudget: Math.max(2000, parseInt(f.injectBudget.value, 10) || DEFAULT_SETTINGS.injectBudget),
      attachSet: true,
      autoEnable: f.autoEnable.checked,
      newFormat: f.newFormat.value,
      momentsShown: f.momentsShown.value,
      threadsShown: f.threadsShown.value,
      blockSounds: f.blockSounds.checked,
      hideHelpers: f.hideHelpers.checked,
      githubToken: f.githubToken.value.trim(),
      // A different token may belong to another GitHub account: find its gist again.
      gistId: f.githubToken.value.trim() === (s.githubToken || '') ? s.gistId || '' : '',
      pinMemory: f.pinMemory.checked,
      memoryMessage: f.memoryMessage.checked,
      buttonSide: f.buttonSide.value,
    });

    // explicit: the "Save settings" button, which always makes these the
    // newest settings (the user pressed it on purpose). "Sync now" and "Test
    // connection" save too, but only a real change to a shared setting counts
    // there, so they never send the form's old values over newer ones.
    const save = async (explicit) => {
      const next = Object.assign({}, DEFAULT_SETTINGS, collect());
      const changed = SHARED_SETTINGS.some((k) => JSON.stringify(next[k]) !== JSON.stringify(settings[k]));
      next.settingsAt = changed || explicit === true ? Date.now() : settings.settingsAt;
      settings = next;
      publishSounds();
      scheduleSync(); // the settings follow to your other devices
      toolCache = null;
      await Store.set('settings', settings);
      ui.fab.className = 'fab ' + settings.buttonSide;
      setStatus();
      publishInjectMap();
      publishHidden();
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
      const data = { version: 1, settings: Object.assign({}, settings, { apiKey: '', githubToken: '', gistId: '' }), chats: {} };
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
      el('label', {}, 'Wait until the newest … AI replies are no longer the newest'), f.holdBack,
      el('div', { class: 'hint' }, 'They are summarised only once newer replies follow, so a reply you have redone is never summarised. 0 = no waiting.'),
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
      el('div', { class: 'row' }, f.pinMemory, el('label', { for: 'smx-pin' }, 'Pin the newest message that carries the memory')),
      el('div', { class: 'hint' }, 'MiniApps (PRO) keeps pinned messages in the AI\'s memory however long the chat gets. Uses one of the 2 pin slots; your own pins are left alone.'),
      el('div', { class: 'row' }, f.memoryMessage, el('label', { for: 'smx-memmsg' }, 'Keep the memory in that pinned message, updated in place')),
      el('div', { class: 'hint' }, 'The pinned message is edited (without a new reply) whenever the memory changes, so your new messages carry no memory and the chat stays short. If an edit fails, the memory is attached to messages again.'),
      el('div', { class: 'row' }, f.hideHelpers, el('label', { for: 'smx-hide' }, 'Hide the helper chats from MiniApps\' chat lists')),
      el('div', { class: 'row' }, f.autoEnable, el('label', { for: 'smx-auto' }, 'Automatically manage new chats')),
      el('label', {}, 'Memory format for new stories'), f.newFormat,
      el('label', {}, 'Characters and history in the pinned message'), f.momentsShown,
      el('label', {}, 'Open Threads in the pinned message'), f.threadsShown,
      el('div', { class: 'row' }, f.blockSounds, el('label', { for: 'smx-sounds' }, 'Block MiniApps\' own sounds (so your music is not paused)')),
      el('div', { class: 'hint' }, 'Stops MiniApps\' ringtones and notification sounds, and keeps its audio channel off until you tap something. Turn off if a MiniApps voice feature stops working.'),
      el('label', {}, 'Button position'), f.buttonSide,
      el('div', { class: 'btns' },
        el('button', { class: 'btn primary', onclick: () => save(true) }, 'Save settings'),
        el('button', { class: 'btn', onclick: test }, 'Test connection')),
      compareBox(),
      el('label', {}, 'Sync between your devices (GitHub)'), f.githubToken,
      el('div', { class: 'hint' }, 'Keeps the memory of every chat the same on your phone and PC, automatically, in a private GitHub Gist. ',
        el('a', { href: 'https://github.com/settings/tokens/new?scopes=gist&description=Story%20Manager%20sync', target: '_blank', rel: 'noopener' }, 'Make a token'),
        ' (sign in or create a free GitHub account, set "Expiration" to "No expiration", leave only "gist" ticked, tap "Generate token", copy it), paste it here on every device and tap Save settings. ' +
        (sync.state === 'ok' ? 'Last synced ' + ago(sync.at) + '.' : sync.state === 'error' ? 'Sync error: ' + sync.error : 'Not set up.')),
      el('div', { class: 'btns' }, el('button', { class: 'btn', onclick: async () => {
        await save();
        toast('Syncing…');
        await runSync();
        toast(sync.state === 'ok' ? 'Synced ✓' : sync.state === 'error' ? 'Sync failed: ' + sync.error : 'Paste a GitHub token first', sync.state === 'error');
        renderPanel(true);
      } }, 'Sync now'),
      el('button', { class: 'btn', disabled: !s.githubToken, onclick: async () => {
        const link = 'https://miniapps.ai/#smx-sync=' + s.githubToken;
        try { await navigator.clipboard.writeText(link); toast('Sync link copied. Send it to yourself and open it on your other device (logged in to MiniApps, with Story Manager installed). Keep it private: it contains your token.'); } catch (e) { prompt('Copy this link and open it on your other device:', link); }
      } }, 'Copy sync link')),
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
