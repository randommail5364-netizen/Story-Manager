// End-to-end test: runs the userscript inside a fake miniapps.ai page whose
// API (and the memory-keeper AI) are simulated, then checks that the story
// memory is built automatically and attached to outgoing messages.
//
//   node test/e2e.test.js

const path = require('path');
const fs = require('fs');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'story-manager.user.js'), 'utf8');

// A tiny stand-in for the MiniApps chat page. It talks to the API with XHR the
// way an axios-based app would, and renders the conversation.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="log"></div><input id="msg"><button id="send">Send</button>
<script>
  let conv = location.pathname.split('/c/')[1] || null;
  function xhr(method, url, body) {
    if (localStorage.getItem('useFetch')) {
      const headers = { 'x-csrf-token': 'csrf-123' };
      if (body) headers['Content-Type'] = 'application/json';
      return fetch(url, { method, headers, credentials: 'include', body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
    }
    return new Promise((res) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      x.setRequestHeader('x-csrf-token', 'csrf-123');
      if (body) x.setRequestHeader('Content-Type', 'application/json');
      x.onload = () => res(JSON.parse(x.responseText));
      x.send(body ? JSON.stringify(body) : null);
    });
  }
  // Like a site that loads history and sends messages over Socket.IO.
  window.wsLoad = () => new Promise((res) => {
    const ws = new WebSocket('wss://api.miniapps.ai/socket.io/?EIO=4&transport=websocket');
    window.sock = ws;
    ws.onopen = () => { ws.send('40'); ws.send('421["messages:list",' + JSON.stringify({ conversationId: conv }) + ']'); };
    ws.onmessage = (ev) => {
      if (String(ev.data).startsWith('42["cu"')) (window.cuSeen = window.cuSeen || []).push(String(ev.data));
      if (String(ev.data).startsWith('42[')) (window.wsSeen = window.wsSeen || []).push(String(ev.data));
      if (String(ev.data).startsWith('431')) res();
    };
  });
  window.wsSend = (text) => window.sock.send('42["chat",' + JSON.stringify({ conversationId: conv, toolId: 'tool-story', elements: [{ type: 'text', text }] }) + ']');
  async function load() {
    if (!conv) return;
    if (localStorage.getItem('wsApi')) { await window.wsLoad(); return; }
    if (localStorage.getItem('altApi')) {
      // Like the real site: messages come from a separate endpoint, newest
      // page first, older pages via a cursor when the user scrolls up.
      const base = 'https://api.miniapps.ai/conversations/' + conv + '/messages?limit=4';
      const r = await xhr('GET', base);
      const older = r.hasMore ? await xhr('GET', base + '&beforeMessageId=' + r.nextBeforeMessageId) : { items: [] };
      document.getElementById('log').textContent = older.items.concat(r.items).map(m => m.origin + ': ' + m.elements[0].text).join('\\n');
      return;
    }
    const d = await xhr('GET', 'https://api.miniapps.ai/conversations/' + conv);
    document.getElementById('log').textContent = d.messages.map(m => m.origin + ': ' + m.elements[0].text).join('\\n');
  }
  window.sendMsg = async (text) => {
    const body = { toolId: 'tool-story', revision: 1, modelId: 'm1', requestId: crypto.randomUUID(),
      elements: [{ type: 'text', text }], language: 'en' };
    if (conv) body.conversationId = conv;
    const r = await xhr('POST', 'https://api.miniapps.ai/chat', body);
    conv = r.conversationId;
    history.replaceState(null, '', '/c/' + conv);
  };
  // Like the site's plain "Edit" (no new reply).
  window.editMsg = (id, text) => xhr('POST', 'https://api.miniapps.ai/chat', { toolId: 'tool-story', revision: 1, modelId: 'm1',
    conversationId: conv, requestId: crypto.randomUUID(), overrideMessageId: id, editInPlace: true, elements: [{ type: 'text', text }], language: 'en' });
  load();
</script></body></html>`;

function uuid() { return require('crypto').randomUUID(); }

async function main() {
  const convs = {};          // id -> { toolId, messages: [] }
  let altApi = false;        // when true, /conversations/{id} has no messages (like a paged real API)
  const chatBodies = [];     // every POST /chat body the "server" received
  const llmCalls = [];       // prompts the memory keeper received

  let liveWs = null;
  let editBusy = 0;    // the next n plain edits are refused: the AI is writing (HTTP 409)
  let editTooBig = 0;  // the next n plain edits are refused as too big
  let helperBroken = false;  // makes the MiniApps-bot memory keeper fail
  let helperDelay = 500;
  let helperMaxChars = 0;      // longer requests get a "context length" chat error (0 = no limit)
  let helperRunaway = false;   // the bot writes a good start, then repeats itself forever
  let helperChatError = false; // the existing helper chat answers with a "ce" error event     // how long the MiniApps-bot memory keeper takes to answer
  const edits = [];           // plain edits the "server" received
  const pins = {};           // conversation id -> Set of pinned message ids
  const aborts = [];         // POST /chat/abort bodies         // the page's fake Socket.IO connection, once open
  function reply(conv, text, delay, convId) {
    const msg = { id: uuid(), origin: 'assistant', createdAt: new Date().toISOString(), elements: [{ type: 'text', text: '- **' }] };
    // Like the real bot, a slow answer shows up half-written in the chat
    // while it is still being streamed in small "pcm" pieces.
    if (delay >= 10000) conv.messages.push(msg);
    const tmpId = uuid();
    conv.generating = (conv.generating || 0) + 1;
    let i = 0;
    const typing = setInterval(() => {
      if (liveWs) liveWs.send('42["pcm",' + JSON.stringify({ cId: convId, requestId: 'r', tmpId, tmpO: 0, payload: { type: 'text', text: i % 2 ? '- **' : ' ', i: i++ } }) + ']');
    }, Math.min(1000, delay / 3));
    setTimeout(() => {
      clearInterval(typing);
      conv.generating--;
      msg.elements = [{ type: 'text', text }];
      if (!conv.messages.includes(msg)) conv.messages.push(msg);
      // Like the real site, finished replies are also pushed over the live connection.
      // Same shape as the real site's "cm" event: { cId, requestId, tmpId, payload: message }.
      if (liveWs) liveWs.send('42["cm",' + JSON.stringify({ cId: convId, requestId: 'r', tmpId, payload: msg }) + ']');
    }, delay);
  }

  // Answers like a real memory keeper, for each of its three jobs.
  const factsSkipped = new Set();
  function keeperAnswer(input, n, tag) {
    // The messages it was given: each reply [R#] and the user message before it.
    const replies = [];
    let lastUser = '';
    for (const block of input.split('\n\n')) {
      const u = block.match(/^(?:\[RECAP\] )?USER: (.*)/m);
      if (u) { lastUser = u[1]; continue; }
      const r = block.match(/^\[R(\d+)[^\]\n]*\] (?:\[RECAP\] )?STORY AI[^:]*: (.*)/m);
      if (r) replies.push({ n: r[1], user: lastUser, text: r[2] });
    }
    if (/JOB: SUMMARISE/.test(input)) {
      // DROPLAST in the chat simulates a keeper that runs out of room.
      const list = /DROPLAST/.test(input) && replies.length > 1 ? replies.slice(0, -1) : replies;
      // NOFACTSLINE in a reply: the keeper leaves its FACTS line out the first time.
      return list.map((r) => {
        const skip = /NOFACTSLINE/.test(r.text) && !factsSkipped.has(r.text);
        if (skip) factsSkipped.add(r.text);
        return '[R' + r.n + '] Detailed summary of reply ' + r.n + ' in update ' + n + '. User: ' + r.user.slice(0, 60) +
          ' Reply: ' + r.text.slice(0, 40) + (skip ? '' : '\nFACTS: Mira is a healer | Ash is a dragon');
      }).join('\n');
    }
    const asked = input.match(/who have none yet: ([^.]+)\./);
    if (/ENTRIES ONLY/.test(input) && asked) {
      return asked[1].split(',').map((name) => '=== ENTRY: ' + name.trim() + ' | character ===\n- ' + name.trim() + ' is a member of the group.').join('\n');
    }
    if (/JOB: VERIFY/.test(input)) {
      const list = (input.split('SUMMARIES TO CHECK:\n<<<\n')[1] || '').split('\n>>>')[0];
      return [...list.matchAll(/^\[R(\d+)\] (.*)$/gm)].map((m) => (/NONSENSE/.test(m[2])
        ? '[R' + m[1] + '] Corrected summary: Mira and Ash crossed the bridge together, as the reply says.\nFACTS: Mira is a healer | Ash crossed the bridge'
        : '[R' + m[1] + '] OK')).join('\n');
    }
    if (/JOB: GRADE/.test(input)) {
      return [...input.matchAll(/^=== CHAPTER (\d+): /gm)].map((m, k) => '=== CHAPTER ' + m[1] + ' ===\nSCORE: ' + (k === 0 ? 5 : 9) +
        '\nWRONG: ' + (k === 0 ? 'It was Ash, not Mira, who lit the fire.' : 'none') + '\nMISSING: none\nPADDING: none').join('\n');
    }
    if (/JOB: CONSOLIDATE/.test(input)) {
      const m = input.match(/THE ENTRY:\n<<<\n=== ENTRY: ([^|=\n]+?) \| (\w+)[^\n]*\n([\s\S]*?)\n>>>/);
      if (!m) return 'OK';
      const lines = [...new Set(m[3].split('\n').filter((l) => l.trim()))];
      // "MISPLACED Name:" lines are about someone else: moved to them.
      const moves = lines.filter((l) => /MISPLACED \w+:/.test(l));
      return '=== ENTRY: ' + m[1] + ' | ' + m[2] + ' ===\n' + lines.filter((l) => !moves.includes(l)).join('\n') + '\n- Consolidated.' +
        moves.map((l) => { const x = l.match(/MISPLACED (\w+): (.*)/); return '\n=== MOVE: ' + x[1] + ' ===\n- ' + x[2]; }).join('');
    }
    if (/JOB: CORRECT/.test(input)) {
      return '=== ENTRY: Ash | character ===\n- Ash is a dragon. Corrected after redo.';
    }
    if (/ONE ENTRY ONLY/.test(input)) {
      const old = (input.match(/THE ENTRY SO FAR:\n<<<\n=== ENTRY: Mira[^\n]*\n([\s\S]*?)\n>>>/) || [])[1] || '';
      return 'Looking at the example, I think we can do:\n=== ENTRY: Mira | character | aliases: the healer ===\n### Basics\n' + old + '\n### Key Moments\n- Rewritten in full detail.';
    }
    if (/JOB: CHAPTER/.test(input)) {
      return '=== CHAPTER: Chapter ' + n + ' by the river ===\nMira and Ash travelled on together' + tag + ', faced the hunters and grew closer; written in update ' + n + '.';
    }
    if (/JOB: CHECK/.test(input)) {
      const n2 = (input.match(/^\[F\d+\]/gm) || []).length;
      return '=== CAST ===\nMira, Ash\n=== ENTRY: Mira | add ===\n- Checked ' + n2 + ' facts; Mira fears deep water.';
    }
    if (!/JOB: UPDATE/.test(input)) return 'OK';
    // WINTERTEST in the chat: the keeper names Winter in the cast but forgets her entry.
    const cast = 'Mira, Ash' + (/WINTERTEST/.test(input) ? ', Winter, Giselle' : '');
    // A very long story (the shrink test) gets an older-style complete STORY
    // answer that drops most of it.
    const storyLen = Number((input.match(/STORY \((\d+) characters\)/) || [])[1] || 0);
    const story = storyLen > 1500
      ? '=== STORY ===\n## Current Scene\n- update ' + n + tag + '\n'
      : '=== SECTION: Current Scene ===\n- Mira and Ash rest by the river (update ' + n + tag + ').\n';
    return story +
      '=== CAST ===\n' + cast + '\n' +
      '=== ENTRY: Mira | character | aliases: Miri, the healer ===\n- Mira: a healer' + tag + ' (update ' + n + ')\n' +
      '=== ENTRY: Ash | character | aliases: the dragon ===\n- Ash: a dragon\n' +
      '=== ENTRY: Old Mill | place | aliases: the mill, old mill ===\n- An abandoned mill where they once hid from hunters.\n';
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext();

  await ctx.route('https://miniapps.ai/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
  await ctx.route('https://api.miniapps.ai/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const cors = {
      'Access-Control-Allow-Origin': 'https://miniapps.ai',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'content-type, x-csrf-token',
      'Access-Control-Allow-Methods': 'GET, POST',
    };
    const json = (obj, status = 200) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(obj) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === '/auth/csrf') return json({ csrfToken: 'csrf-123' });
    if (url.pathname.startsWith('/tools/s/')) return json({ id: /sloppy-bot/.test(url.pathname) ? 'tool-helper-sloppy' : 'tool-helper', revision: 1, modelId: 'm-helper' });
    let m;
    if (req.method() === 'GET' && url.pathname === '/conversations/quickAccess') {
      const items = Object.keys(convs).map((id) => ({ id, toolId: convs[id].toolId }));
      return json({ page: 1, take: 50, total: items.length, hasMore: false, items });
    }
    if (req.method() === 'GET' && (m = url.pathname.match(/^\/conversations\/([^/]+)$/))) {
      const c = convs[m[1]];
      if (!c) return json({ message: 'nope' }, 404);
      const title = c.toolId === 'tool-story' ? 'Dragon Tale' : 'helper';
      const info = { id: m[1], title, toolId: c.toolId, toolRevision: 1, modelId: 'm1' };
      return json(altApi ? info : Object.assign(info, { messages: c.messages }));
    }
    if (req.method() === 'GET' && (m = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/))) {
      // Same shape as the real site: { items, hasMore, nextBeforeMessageId }.
      const c = convs[m[1]];
      if (!c) return json({ message: 'Conversation not found' }, 404);
      const limit = Math.min(Number(url.searchParams.get('limit')) || 10, 50);
      const before = url.searchParams.get('beforeMessageId');
      let end = c.messages.length;
      if (before) {
        end = c.messages.findIndex((x) => x.id === before);
        if (end < 0) return json({ message: 'Invalid message cursor' }, 400);
      }
      const start = Math.max(0, end - limit);
      const items = c.messages.slice(start, end).map((x, i) => Object.assign({ conversationId: m[1], index: start + i + (String(c.toolId).startsWith('tool-helper') ? 7 : 0) }, x));
      const hasMore = end - limit > 0;
      return json({ items, hasMore, nextBeforeMessageId: hasMore ? items[0].id : null });
    }
    if (req.method() === 'GET' && (m = url.pathname.match(/^\/chat\/([^/]+)\/run-state$/))) {
      const c = convs[m[1]];
      return json({ conversationId: m[1], activeRunRequestId: null, isGenerating: !!(c && c.generating > 0) });
    }
    if (req.method() === 'GET' && (m = url.pathname.match(/^\/conversations\/([^/]+)\/messages\/pinned$/))) {
      const c = convs[m[1]];
      return json({ items: c ? c.messages.filter((x) => pins[m[1]] && pins[m[1]].has(x.id)) : [] });
    }
    if (req.method() === 'POST' && (m = url.pathname.match(/^\/chat-messages\/([^/]+)\/([^/]+)\/(pin|unpin)$/))) {
      const set = pins[m[1]] || (pins[m[1]] = new Set());
      if (m[3] === 'unpin') { set.delete(m[2]); return json({}, 201); }
      if (set.size >= 2 && !set.has(m[2])) return json({ message: 'You can pin at most 2 messages' }, 400);
      set.add(m[2]);
      return json({}, 201);
    }
    if (req.method() === 'POST' && url.pathname === '/chat/abort') {
      aborts.push(JSON.parse(req.postData()));
      return json({});
    }
    if (req.method() === 'POST' && url.pathname === '/chat') {
      const body = JSON.parse(req.postData());
      if (req.headers()['x-csrf-token'] !== 'csrf-123') return json({ message: 'csrf' }, 403);
      chatBodies.push(body);
      if (body.conversationId && !convs[body.conversationId]) return json({ message: 'Conversation not found' }, 404);
      // A plain edit: the message's text is replaced, no new reply.
      if (body.overrideMessageId && body.editInPlace) {
        if (editBusy > 0) { editBusy--; return json({ message: 'Conversation is currently generating. Stop the current response first.' }, 409); }
        if (editTooBig > 0) { editTooBig--; return json({ message: 'Message is too long' }, 400); }
        const target = convs[body.conversationId].messages.find((x) => x.id === body.overrideMessageId);
        if (!target) return json({ message: 'Message to override not found' }, 400);
        target.elements = [{ type: 'text', text: body.elements[0].text }];
        edits.push(body);
        return json({ conversationId: body.conversationId, chatMessageId: target.id, requestId: body.requestId, addedMessages: [] });
      }
      if (String(body.toolId).startsWith('tool-helper') && helperBroken) return json({ message: 'Insufficient credits' }, 412);
      const id = body.conversationId || uuid();
      const isNew = !convs[id];
      const conv = convs[id] || (convs[id] = { toolId: body.toolId, messages: [] });
      const text = body.elements[0].text;
      const added = [];
      // Like the real bot: a new helper chat starts with a greeting.
      if (isNew && String(body.toolId).startsWith('tool-helper')) {
        const greet = { id: uuid(), origin: 'assistant', createdAt: new Date().toISOString(), elements: [{ type: 'text', text: 'Hi! Tell me what to write.' }] };
        conv.messages.push(greet);
        added.push(greet);
      }
      // Long requests to the helper are stored as a file, so their text can't be read back.
      const userMsg = String(body.toolId).startsWith('tool-helper')
        ? { id: uuid(), origin: 'user', createdAt: new Date().toISOString(), text: '', elements: [{ type: 'file', name: 'message.txt' }] }
        : { id: uuid(), origin: 'user', createdAt: new Date().toISOString(), elements: [{ type: 'text', text }] };
      conv.messages.push(userMsg);
      added.push(userMsg);
      if (String(body.toolId).startsWith('tool-helper') && helperMaxChars && text.length > helperMaxChars) {
        setTimeout(() => liveWs && liveWs.send('42["ce",' + JSON.stringify({ conversationId: id, requestId: body.requestId, messageId: userMsg.id, replyToMessageId: null, error: "This endpoint's maximum context length is 163840 tokens. However, you requested about 170117 tokens. Please reduce the length of either one", code: 'error' }) + ']'), 300);
      } else if (String(body.toolId).startsWith('tool-helper') && helperRunaway) {
        llmCalls.push(text);
        const full = keeperAnswer(text, llmCalls.length, ' (via MiniApps bot)');
        const pieces = full.match(/[\s\S]{1,40}/g);
        const loop = 'and then she said the same thing again, and again, over and over. ';
        let k = 0;
        const timer = setInterval(() => {
          const stopped = aborts.some((a) => a.requestId === body.requestId);
          if (stopped || k > 3000) return clearInterval(timer);
          const piece = k < pieces.length ? pieces[k] : loop;
          if (liveWs) liveWs.send('42["pcm",' + JSON.stringify({ cId: id, requestId: body.requestId, tmpId: 'run', tmpO: 0, payload: { type: 'text', text: piece, i: k++ } }) + ']');
        }, 5);
      } else if (String(body.toolId).startsWith('tool-helper') && helperChatError && !isNew) {
        setTimeout(() => liveWs && liveWs.send('42["ce",' + JSON.stringify({ conversationId: id, requestId: body.requestId, messageId: userMsg.id, replyToMessageId: null, error: 'Context too long', code: 'CONTEXT_LIMIT' }) + ']'), 300);
      } else if (String(body.toolId).startsWith('tool-helper')) {
        llmCalls.push(text);
        // A sloppy bot writes its working-out into the answer.
        const sloppy = body.toolId === 'tool-helper-sloppy' ? 'We can add these to the entries.\nImplementation:\nF1: covered -> skip.\n' : '';
        reply(conv, sloppy + keeperAnswer(text, llmCalls.length, ' (via MiniApps bot)'), helperDelay, id);
      } else {
        const n = conv.messages.filter((x) => x.origin === 'user').length;
        reply(conv, 'Story reply #' + n + ': the dragon Ash watches Mira.', 1500, id);
      }
      return json({ conversationId: id, chatMessageId: userMsg.id, requestId: body.requestId,
        // Like the real site, numbers need not start at 0 (they can start again in a chat).
        addedMessages: added.map((x) => Object.assign({ index: conv.messages.indexOf(x) + (String(body.toolId).startsWith('tool-helper') ? 7 : 0) }, x)) });
    }
    return json({});
  });

  // Fake GitHub Gist API (sync between devices).
  const gists = {};
  await ctx.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS' };
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (req.headers().authorization !== 'Bearer gh-test-token') return reply({ message: 'Bad credentials' }, 401);
    let m;
    if (url.pathname === '/gists' && req.method() === 'GET') return reply(Object.values(gists).map((g) => ({ id: g.id, description: g.description })));
    if (url.pathname === '/gists' && req.method() === 'POST') {
      const b = JSON.parse(req.postData());
      const g = { id: 'g' + Object.keys(gists).length, description: b.description, files: {} };
      for (const [n, f] of Object.entries(b.files)) g.files[n] = { content: f.content };
      gists[g.id] = g;
      return reply(g, 201);
    }
    // Like GitHub, every save is kept as a version.
    if ((m = url.pathname.match(/^\/gists\/([^/]+)\/commits$/))) {
      const g = gists[m[1]];
      return reply(g ? (g.history || []).slice().reverse().map((h) => ({ version: h.version, committed_at: new Date(h.at).toISOString() })) : []);
    }
    if ((m = url.pathname.match(/^\/gists\/([^/]+)\/([^/]+)$/))) {
      const h = ((gists[m[1]] || {}).history || []).find((x) => x.version === m[2]);
      return h ? reply({ id: m[1], files: h.files }) : reply({ message: 'Not Found' }, 404);
    }
    if ((m = url.pathname.match(/^\/gists\/([^/]+)$/))) {
      const g = gists[m[1]];
      if (!g) return reply({ message: 'Not Found' }, 404);
      if (req.method() === 'PATCH') {
        for (const [n, f] of Object.entries(JSON.parse(req.postData()).files)) g.files[n] = { content: f.content };
        (g.history = g.history || []).push({ version: 'v' + ((g.history || []).length + 1), at: Date.now(), files: JSON.parse(JSON.stringify(g.files)) });
      }
      return reply(g);
    }
    return reply({ message: 'Not Found' }, 404);
  });

  // Fake OpenAI-compatible memory keeper.
  await ctx.route('https://mock-llm.test/**', async (route) => {
    const body = JSON.parse(route.request().postData());
    const input = body.messages[1].content;
    llmCalls.push(input);
    const content = keeperAnswer(input, llmCalls.length, '');
    await route.fulfill({
      status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ choices: [{ message: { content } }] }),
    });
  });

  const wsFrames = [];       // chat messages the fake socket server received
  await ctx.routeWebSocket(/socket\.io/, (ws) => {
    liveWs = ws;
    ws.onMessage((msg) => {
      msg = String(msg);
      if (msg === '40') return ws.send('40{"sid":"s1"}');
      if (msg.startsWith('421[')) {
        const id = JSON.parse(msg.slice(3))[1].conversationId;
        const items = convs[id].messages.map((m) => Object.assign({ conversationId: id }, m));
        return ws.send('431' + JSON.stringify([{ items }]));
      }
      if (msg.startsWith('42["chat"')) wsFrames.push(msg);
    });
  });

  const settings = { provider: 'openai', apiKey: 'test-key', baseUrl: 'https://mock-llm.test/v1', model: 'mock', updateEvery: 2, foldEvery: 2, injectEvery: 1, attachSet: true, memoryMessage: false, holdBack: 0 };
  // A fake screen wake lock that records when it is taken and released.
  await ctx.addInitScript(() => {
    window.wakeLog = [];
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => {
      window.wakeLog.push('on');
      const l = new EventTarget();
      l.release = async () => { window.wakeLog.push('off'); l.dispatchEvent(new Event('release')); };
      return l;
    } } });
  });
  // Shorter waits inside Story Manager (E2E_SLOW=1 runs at real speed), and a version like the userscript manager's.
  await ctx.addInitScript((scale) => { localStorage.setItem('smx:timeScale', scale); window.GM_info = { script: { version: '9.9.9' } }; }, process.env.E2E_SLOW ? '1' : '0.25');
  await ctx.addInitScript((s) => { if (!localStorage.getItem('smx:settings')) localStorage.setItem('smx:settings', JSON.stringify(s)); }, settings);
  // 'lateStart' simulates a userscript manager that starts the script only
  // after the site has already loaded the chat (seen on Firefox for Android).
  await ctx.addInitScript({ content: "if (!localStorage.getItem('lateStart')) {\n" + SCRIPT + '\n}' });

  const page = await ctx.newPage();
  page.on('console', (m) => { if (/Story Manager/.test(m.text())) console.log('  [page]', m.text()); });
  page.on('pageerror', (e) => console.log('  [page error]', e.message));
  await page.goto('https://miniapps.ai/');

  const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); console.log('  ✓ ' + msg); };
  const waitFor = async (fn, ms, what) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 250)); }
    if (process.env.DEBUG_SETTLE) {
      const diag = await page.evaluate(() => {
        const root = document.querySelector('#story-manager-root').shadowRoot;
        const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Diagnostics');
        if (btn) btn.click();
        const box = root.querySelector('textarea.diag');
        return box ? box.value.split('\n').slice(0, 14).join('\n') : 'no diagnostics (panel closed)';
      }).catch((e) => String(e));
      console.log('  [timeout-diag]\n' + diag);
    }
    throw new Error('Timed out waiting for ' + what);
  };

  console.log('1) New chat, first message carries no memory');
  await page.evaluate(() => window.sendMsg('I am Mira, a healer.'));
  check(!chatBodies[0].elements[0].text.includes('[[STORY-MEMORY]]'), 'first message sent unchanged');
  const convId = Object.keys(convs)[0];

  console.log('2) After 2 AI replies the memory keeper runs automatically');
  await waitFor(() => convs[convId].messages.length === 2, 5000, 'reply 1');
  await page.evaluate(() => window.sendMsg('I meet a dragon called Ash.'));
  await waitFor(async () => (await page.evaluate(() => (JSON.parse(localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1]) || '{}').entries || []).length)) === 3, 30000, 'memory update');
  check(/JOB: SUMMARISE/.test(llmCalls[0]) && /I am Mira, a healer\./.test(llmCalls[0]) && /Story reply #2/.test(llmCalls[0]), 'summary job got both exchanges');
  check(/JOB: UPDATE/.test(llmCalls[1]) && /\[S1\] Detailed summary of reply 1[\s\S]*FACTS: Mira is a healer/.test(llmCalls[1]) && !/USER: I am Mira/.test(llmCalls[1]),
    'story & characters updated from the summaries and facts, not the raw messages');
  const mem = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1])));
  check(mem && /## Current Scene\n- Mira and Ash rest by the river \(update 2\)/.test(mem.memory), 'story saved for this chat');
  check(mem.entries.map((e) => e.name).join() === 'Mira,Ash,Old Mill' && mem.entries[0].aliases.includes('Miri'), 'separate entries for characters and places, with aliases');
  check(mem.title === 'Dragon Tale', 'chat title picked up');
  check(!/===/.test(mem.memory) && !mem.entries.some((e) => /===/.test(e.text)), 'answer split into story, entries and log');
  check(mem.log.length === 2 && /reply 1 in update 1/.test(mem.log[0].text) && /reply 2 in update 1/.test(mem.log[1].text), 'one detailed log entry per AI reply');
  check(mem.log.every((e) => e.facts === 'Mira is a healer | Ash is a dragon' && e.folded && !/FACTS/.test(e.text)), 'each summary keeps its facts, marked as folded in');
  check(mem.jobs.length === 2 && mem.jobs.every((j) => j.ok) && /Summarised replies 1–2/.test(mem.jobs[1].label) && /Updated story & characters from replies 1–2/.test(mem.jobs[0].label), 'both jobs recorded in the activity list');

  await page.waitForTimeout(500);
  check((await page.evaluate(() => window.wakeLog.join())) === 'on,off', 'screen kept on during the update and released after');

  console.log('3) Next message has the memory attached');
  await page.evaluate(() => window.sendMsg('What do I do next?'));
  const sent = chatBodies[chatBodies.length - 1].elements[0].text;
  check(sent.startsWith('[[STORY-MEMORY]]') && /Ash: a dragon/.test(sent) && sent.endsWith('What do I do next?'), 'memory block prepended to user message');
  check(/## Recent events in detail[\s\S]*reply 1 in update 1[\s\S]*reply 2 in update 1/.test(sent), 'recent reply summaries attached, oldest first');
  check(/### Mira \(character\)/.test(sent) && /### Ash \(character\)/.test(sent), 'characters in the current scene attached');
  check(!/### Old Mill/.test(sent), 'entries not in play and not mentioned are left out');

  console.log('4) The memory block is stripped before the keeper sees history again');
  await waitFor(() => convs[convId].messages.length === 6, 5000, 'reply 3');
  await page.evaluate(() => window.sendMsg('I bandage Ash.'));
  await waitFor(() => llmCalls.length >= 4, 30000, 'second memory update');
  check(!llmCalls[2].includes('Background notes for story continuity') && /What do I do next\?/.test(llmCalls[2]), 'no memory echo, only new messages');
  check(!/I am Mira, a healer\./.test(llmCalls[2]), 'already-processed messages are not resent');
  await page.waitForTimeout(1000);
  const mem2 = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1])));
  check(mem2.memory === '## Current Scene\n- Mira and Ash rest by the river (update 4).' && mem2.log.length === 4 && mem2.log.every((e) => e.folded),
    'the story holds the situation now; every summary folded in');

  console.log('5) Panel opens and shows the memory');
  await page.locator('#story-manager-root >> .fab').click();
  const panelText = await page.locator('#story-manager-root >> .panel').innerText();
  check(/Dragon Tale/.test(panelText), 'panel shows the current chat');
  const memBox = await page.locator('#story-manager-root >> textarea.mem').inputValue();
  check(/update 4/.test(memBox), 'panel shows latest memory');
  check(/Reply summaries: 4/.test(panelText) && /Chapters: 0/.test(panelText), 'panel shows where each stage stands');
  check(/AI replies in this chat: \d+ · summarised: \d+ · (none waiting|waiting: \d+[^(]*(\([^)]*\))?) \((\d+ messages including yours|messages not counted yet)/.test(panelText), 'panel shows AI replies, how many are summarised and how many wait, and all messages');

  console.log('6) Pinned facts are always injected');
  await page.locator('#story-manager-root >> textarea').first().fill('Mira cannot swim.');
  await page.locator('#story-manager-root >> button.btn.primary').click();
  await page.evaluate(() => window.sendMsg('We reach a river.'));
  check(/## Must remember\nMira cannot swim\./.test(chatBodies[chatBodies.length - 1].elements[0].text), 'pinned fact attached');

  console.log('7) "MiniApps bot" mode uses the site\'s own API (no key)');
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('smx:settings'));
    s.provider = 'miniapps';
    localStorage.setItem('smx:settings', JSON.stringify(s));
  });
  await page.reload();
  const before = llmCalls.length;
  await page.locator('#story-manager-root >> .fab').click();
  await page.getByText('Rebuild from whole chat').click({ trial: true });
  page.once('dialog', (d) => d.accept());
  await page.getByText('Rebuild from whole chat').click();
  await waitFor(async () => /via MiniApps bot/.test(await page.evaluate(() => localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1]))), 30000, 'miniapps rebuild');
  const helperBody = chatBodies.find((b) => b.toolId === 'tool-helper');
  check(helperBody && !helperBody.conversationId && llmCalls.length > before, 'helper bot was asked through POST /chat');
  check(llmCalls.slice(before).some((c) => /We reach a river\./.test(c)), 'rebuild read the whole chat');

  console.log('8) Same flow works when the site uses fetch() instead of XHR');
  await page.evaluate(() => localStorage.setItem('useFetch', '1'));
  await page.reload();
  await page.waitForTimeout(300); // let the script load its saved memory
  await page.evaluate(() => window.sendMsg('Fetch path check'));
  const viaFetch = chatBodies[chatBodies.length - 1].elements[0].text;
  check(viaFetch.startsWith('[[STORY-MEMORY]]') && viaFetch.endsWith('Fetch path check'), 'memory attached via fetch hook');

  // Waits until a multi-request rebuild has sent all its requests.
  const settle = async () => {
    let n;
    // Only a visible Stop button counts (a closed panel keeps an old one).
    const stopShown = () => page.locator('#story-manager-root >> button:visible', { hasText: 'Stop' }).count();
    let rounds = 0;
    do {
      n = llmCalls.length;
      await page.waitForTimeout(process.env.E2E_SLOW ? 3000 : 1200);
      if (process.env.DEBUG_SETTLE && ++rounds % 10 === 0) {
        const last = llmCalls[llmCalls.length - 1] || '';
        if (rounds % 20 === 0) {
          const diagLine = await page.evaluate(() => {
            const root = document.querySelector('#story-manager-root').shadowRoot;
            const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Diagnostics');
            if (btn) btn.click();
            const box = root.querySelector('textarea.diag');
            return box ? box.value.split('\n').filter((l) => /^(Helper chat|Last chat error|Recent jobs|Pinned memory)/.test(l)).join(' || ') : 'no diagnostics';
          });
          console.log('  [settle-diag]', diagLine.slice(0, 1200));
        }
        console.log('  [settle]', llmCalls.length, 'calls; last:', (last.match(/JOB: \w+|ENTRIES ONLY/) || ['?'])[0], (last.match(/\[R\d+[^\]]*\]/g) || []).length, 'replies',
          await page.evaluate(() => { const b = document.querySelector('#story-manager-root').shadowRoot.querySelector('.status'); return b ? b.innerText.replace(/\s+/g, ' ').slice(150, 700) : ''; }));
      }
    } while (llmCalls.length !== n || await stopShown());
  };

  console.log('9) Site loads messages from another, paged endpoint (learned automatically)');
  altApi = true;
  await page.evaluate(() => localStorage.setItem('altApi', '1'));
  await page.reload();
  await page.waitForTimeout(500);
  const learnedTpl = await page.evaluate(() => localStorage.getItem('smx:learned'));
  check(/conversations\/\{id\}\/messages\?limit=4"/.test(learnedTpl || ''), 'message address learned from the site (without the one-time cursor)');
  const beforeRebuild = llmCalls.length;
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Rebuild from whole chat').click();
  await waitFor(() => /Fetch path check/.test(llmCalls.slice(beforeRebuild).join('\n')), 60000, 'rebuild via learned endpoint');
  const rebuiltFrom = llmCalls.slice(beforeRebuild).join('\n');
  check(/I am Mira, a healer\./.test(rebuiltFrom) && /Fetch path check/.test(rebuiltFrom), 'all pages read (oldest and newest messages)');
  check(rebuiltFrom.indexOf('I am Mira, a healer.') < rebuiltFrom.indexOf('Fetch path check'), 'messages put back in order');

  console.log('10) Diagnostics shows what was seen, without message text');
  await page.getByText('Diagnostics', { exact: true }).click();
  const diag = await page.locator('#story-manager-root >> textarea.diag').inputValue();
  check(/conversations\/\{id\}\/messages/.test(diag) && /Learned message address/.test(diag), 'diagnostics list requests');
  check(!/I am Mira/.test(diag), 'diagnostics contain no story text');

  console.log('11) Site loads history and sends messages over the live connection');
  await page.evaluate(() => { localStorage.removeItem('smx:learned'); localStorage.setItem('wsApi', '1'); });
  await page.reload();
  await page.waitForTimeout(800);
  const beforeWs = llmCalls.length;
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Rebuild from whole chat').click();
  await waitFor(() => llmCalls.length > beforeWs, 30000, 'rebuild from socket history');
  await settle();
  const fromWs = llmCalls.slice(beforeWs).join('\n');
  check(/I am Mira, a healer\./.test(fromWs) && /Fetch path check/.test(fromWs), 'messages from the live connection used for the memory');
  await page.locator('#story-manager-root >> .x').click();
  await page.evaluate(() => window.wsSend('Socket send check'));
  await waitFor(() => wsFrames.length > 0, 5000, 'socket chat frame');
  const frame = JSON.parse(wsFrames[0].slice(2))[1].elements[0].text;
  check(frame.startsWith('[[STORY-MEMORY]]') && frame.endsWith('Socket send check'), 'memory attached to messages sent over the live connection');
  await page.locator('#story-manager-root >> .fab').click();
  await page.getByText('Diagnostics', { exact: true }).click();
  const diag2 = await page.locator('#story-manager-root >> textarea.diag').inputValue();
  check(/in reply · messages: \d+/.test(diag2) && /Hook: \{"mode":"page"/.test(diag2), 'diagnostics show socket events and hook activity');
  const shapeLine = (diag2.split('Send requests')[1] || '').split('\n')[1] || '';
  check(/^\d+s ago \[memory attached\]: \{/.test(shapeLine) && /"conversationId":"[0-9a-f-]{36}"/.test(shapeLine) && /"elements":"text"/.test(shapeLine) && !/Socket send check/.test(diag2),
    'diagnostics show the fields of send requests, without the message text');

  console.log('12) Script starts after the site already loaded the chat');
  await page.evaluate(() => {
    localStorage.removeItem('smx:learned');
    localStorage.removeItem('wsApi');
    localStorage.setItem('lateStart', '1');
  });
  await page.reload();
  await page.waitForTimeout(500);
  await page.addScriptTag({ content: SCRIPT });
  await page.waitForTimeout(800);
  const beforeLate = llmCalls.length;
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Rebuild from whole chat').click();
  await waitFor(() => llmCalls.length > beforeLate, 30000, 'rebuild after late start');
  await settle();
  const fromLate = llmCalls.slice(beforeLate).join('\n');
  check(/I am Mira, a healer\./.test(fromLate) && /Socket send check|Fetch path check/.test(fromLate), 'messages found from the browser\'s request list');
  const learnedLate = await page.evaluate(() => localStorage.getItem('smx:learned'));
  check(/conversations\/\{id\}\/messages/.test(learnedLate || ''), 'message address learned without seeing the request');

  console.log('13) An address saved with a stale cursor (as on a real phone) still works');
  await page.evaluate(() => {
    localStorage.removeItem('lateStart');
    localStorage.setItem('smx:learned', JSON.stringify({ template: 'https://api.miniapps.ai/conversations/{id}/messages?limit=4&beforeMessageId=11111111-1111-4111-8111-111111111111' }));
  });
  await page.reload();
  await page.waitForTimeout(800);
  const beforeStale = llmCalls.length;
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Rebuild from whole chat').click();
  await waitFor(() => llmCalls.length > beforeStale, 30000, 'rebuild with stale cursor');
  await settle();
  check(/I am Mira, a healer\./.test(llmCalls.slice(beforeStale).join('\n')), 'whole chat read despite the stale cursor');

  console.log('14) Recaps are labelled for the memory keeper, with rules for them');
  await page.locator('#story-manager-root >> .x').click();
  const recapConv = convs[convId];
  await page.evaluate(() => window.sendMsg('Recap: earlier, Mira and Ash escaped the hunters in the old mill.'));
  await waitFor(() => recapConv.messages[recapConv.messages.length - 1].origin === 'assistant', 5000, 'reply after recap');
  const beforeRecap = llmCalls.length;
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Rebuild from whole chat').click();
  await waitFor(() => llmCalls.length > beforeRecap, 30000, 'rebuild with a recap');
  await settle();
  const withRecap = llmCalls.slice(beforeRecap).join('\n');
  check(/\[RECAP\] USER: Recap: earlier, Mira and Ash escaped/.test(withRecap), 'recap message labelled [RECAP]');
  check(/\[R1, summary about \d+ characters\] STORY AI/.test(withRecap), 'story replies numbered for the log');
  check(!/\[RECAP\] USER: I am Mira/.test(withRecap), 'ordinary messages not labelled');
  check(/A recap describes the PAST/.test(withRecap), 'memory keeper told how to handle recaps');

  console.log('15) Long replies are passed on whole, and missing log entries are asked for again');
  await page.locator('#story-manager-root >> .x').click();
  const longText = 'LONGSTART ' + 'Mira walks on through the endless forest. '.repeat(300) + 'LONGEND DROPLAST';
  await page.evaluate((t) => window.sendMsg(t), longText);
  await waitFor(() => recapConv.messages[recapConv.messages.length - 1].origin === 'assistant', 5000, 'reply after long message');
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('smx:settings'));
    st.provider = 'openai';
    localStorage.setItem('smx:settings', JSON.stringify(st));
  });
  await page.reload();
  await page.waitForTimeout(800);
  const beforeLong = llmCalls.length;
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Rebuild from whole chat').click();
  await waitFor(() => llmCalls.length > beforeLong, 30000, 'rebuild with a long message');
  await settle();
  const longCalls = llmCalls.slice(beforeLong).join('\n');
  check(/LONGEND/.test(longCalls) && longText.length > 12000, 'a ' + longText.length + '-character message reached the memory keeper whole');
  const replyIds = recapConv.messages.filter((x) => x.origin === 'assistant').map((x) => x.id);
  const longChat = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1])));
  check(replyIds.every((rid) => longChat.log.some((e) => e.id === rid)), 'every AI reply has a log entry (' + replyIds.length + '), including the one first left out');
  check(longChat.log.map((e) => e.id).join() === replyIds.join(), 'log entries are in story order');
  check(/\[R1, summary about 700 characters\]/.test(longCalls), 'each reply labelled with its target summary length');

  console.log('16) An update that would drop most of the memory is retried, then refused');
  const bigMemory = '## Characters\n' + Array.from({ length: 60 }, (_, i) => '- Fact number ' + i + ' about Mira and Ash that must survive.').join('\n');
  await page.evaluate((mem) => {
    const key = 'smx:chat:' + location.pathname.split('/c/')[1];
    const c = JSON.parse(localStorage.getItem(key));
    c.memory = mem;
    localStorage.setItem(key, JSON.stringify(c));
  }, bigMemory);
  await page.reload();
  await page.waitForTimeout(800);
  await page.evaluate(() => window.sendMsg('We rest by the fire.'));
  await waitFor(() => recapConv.messages[recapConv.messages.length - 1].origin === 'assistant', 5000, 'reply before shrink test');
  await page.waitForTimeout(500);
  const beforeShrink = llmCalls.length;
  await page.locator('#story-manager-root >> .fab').click();
  await page.getByText('Update now').click({ timeout: 120000 });
  await waitFor(() => llmCalls.slice(beforeShrink).some((c) => /IMPORTANT: your previous answer left out/.test(c)), 30000, 'retry after shrinking');
  await page.waitForTimeout(1500);
  const shrinkChat = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1])));
  check(shrinkChat.memory === bigMemory, 'memory kept when the keeper tried to drop facts');
  const lastReply = recapConv.messages[recapConv.messages.length - 1].id;
  check(shrinkChat.log.some((e) => e.id === lastReply), 'reply log still updated');

  console.log('17) Entries are attached when a message mentions them');
  await page.locator('#story-manager-root >> .x').click();
  await page.evaluate(() => window.sendMsg('Let us go back to the old mill tonight.'));
  const mentionSent = chatBodies[chatBodies.length - 1].elements[0].text;
  check(/### Old Mill \(place\)/.test(mentionSent), 'mentioned place attached (found by its alias)');
  await waitFor(() => recapConv.messages[recapConv.messages.length - 1].origin === 'assistant', 5000, 'reply');
  await page.evaluate(() => window.sendMsg('We keep walking.'));
  check(!/### Old Mill/.test(chatBodies[chatBodies.length - 1].elements[0].text), 'not attached once it is no longer mentioned');
  await page.locator('#story-manager-root >> .fab').click();
  const panel17 = await page.locator('#story-manager-root >> .panel').innerText();
  check(/Entries \(3\)/.test(panel17) && /In play right now/.test(panel17) && /Last message carried: story, Mira, Ash/.test(panel17), 'panel lists entries, what is in play and what was sent');

  console.log('18) Entries can be edited in the panel, and marked "Always send"');
  const mill = page.locator('#story-manager-root >> details.entrybox', { hasText: 'Old Mill' });
  await mill.locator('summary').click();
  await mill.locator('textarea.entry').fill('- An abandoned mill. The roof leaks. Edited by hand.');
  await mill.locator('input[type=checkbox]').check();
  await page.locator('#story-manager-root >> button.btn.primary', { hasText: 'Save' }).click();
  await page.locator('#story-manager-root >> .x').click();
  await page.evaluate(() => window.sendMsg('We keep walking again.'));
  const alwaysSent = chatBodies[chatBodies.length - 1].elements[0].text;
  check(/### Old Mill \(place\)\n- An abandoned mill\. The roof leaks\. Edited by hand\./.test(alwaysSent), 'edited entry marked "Always send" is attached without being mentioned');

  console.log('19) The MiniApps-bot memory keeper uses one helper chat');
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('smx:settings'));
    st.provider = 'miniapps';
    localStorage.setItem('smx:settings', JSON.stringify(st));
  });
  await page.reload();
  await page.waitForTimeout(800);
  const countOf = (o) => recapConv.messages.filter((x) => x.origin === o).length;
  await waitFor(() => countOf('user') === countOf('assistant'), 8000, 'every message answered');
  const helperChatsBefore = Object.values(convs).filter((c) => c.toolId === 'tool-helper').length;
  const helperPostsBefore = chatBodies.filter((b) => b.toolId === 'tool-helper').length;
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Rebuild from whole chat').click();
  await waitFor(() => chatBodies.filter((b) => b.toolId === 'tool-helper').length >= helperPostsBefore + 3, 60000, 'several helper requests');
  const replyCount19 = recapConv.messages.filter((x) => x.origin === 'assistant').length;
  await waitFor(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1])).log.length)) === replyCount19, 120000, 'rebuild to finish');
  await settle();
  const helperPosts = chatBodies.filter((b) => b.toolId === 'tool-helper').slice(helperPostsBefore);
  const helperIdsUsed = new Set(helperPosts.map((b) => b.conversationId).filter(Boolean));
  check(helperPosts.length >= 3 && helperIdsUsed.size === 1 && helperPosts.slice(1).every((b) => b.conversationId), helperPosts.length + ' memory-keeper requests all went to one helper chat');
  check(Object.values(convs).filter((c) => c.toolId === 'tool-helper').length <= helperChatsBefore + 1, 'no new chat per request');
  const helperChat19 = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:helperChat')));
  check(helperChat19 && helperIdsUsed.has(helperChat19.id), 'helper chat remembered for next time');
  const log19 = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1])).log);
  const lastUpdate19 = Math.max(...log19.map((e) => Number((e.text.match(/update (\d+)/) || [])[1] || 0)));
  check(log19.length === recapConv.messages.filter((x) => x.origin === 'assistant').length && lastUpdate19 > 0, 'each request got its own answer from the shared chat');

  console.log('20) A deleted helper chat is replaced automatically');
  delete convs[helperChat19.id];
  await page.locator('#story-manager-root >> .x').click();
  await page.evaluate(() => window.sendMsg('One more step.'));
  await waitFor(() => recapConv.messages[recapConv.messages.length - 1].origin === 'assistant', 5000, 'reply');
  await page.waitForTimeout(300);
  await page.locator('#story-manager-root >> .fab').click();
  await page.getByText('Update now').click({ timeout: 120000 });
  await waitFor(async () => {
    const h = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:helperChat')));
    return h && h.id !== helperChat19.id && convs[h.id];
  }, 60000, 'new helper chat');
  await waitFor(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1])).log.length)) === countOf('assistant'), 60000, 'update to finish');
  check(true, 'new helper chat created and used for the update');

  console.log('21) Characters named in the cast but left without an entry are asked for');
  await page.locator('#story-manager-root >> .x').click();
  await page.evaluate(() => window.sendMsg('Winter and Giselle join us. WINTERTEST'));
  await waitFor(() => countOf('user') === countOf('assistant'), 8000, 'reply');
  await page.waitForTimeout(300);
  await page.locator('#story-manager-root >> .fab').click();
  await page.getByText('Update now').click({ timeout: 120000 });
  await waitFor(async () => {
    const c = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1])));
    return c.entries.some((e) => e.name === 'Winter') && c.entries.some((e) => e.name === 'Giselle');
  }, 60000, 'entries for Winter and Giselle');
  check(true, 'missing characters got their own entries');

  console.log('22) A deleted entry is not created again');
  await page.locator('#story-manager-root >> .x').click();
  await page.locator('#story-manager-root >> .fab').click();
  const scarf = page.locator('#story-manager-root >> details.entrybox', { hasText: 'Old Mill' });
  await scarf.locator('summary').click();
  await scarf.locator('input[type=checkbox]').uncheck();
  page.once('dialog', (d) => d.accept());
  await scarf.getByText('Delete').click();
  await page.locator('#story-manager-root >> button.btn.primary', { hasText: 'Save' }).click();
  await page.locator('#story-manager-root >> .x').click();
  await page.evaluate(() => window.sendMsg('We walk on.'));
  await waitFor(() => countOf('user') === countOf('assistant'), 8000, 'reply');
  await page.waitForTimeout(300);
  await page.locator('#story-manager-root >> .fab').click();
  const beforeDel = llmCalls.length;
  await page.getByText('Update now').click({ timeout: 120000 });
  await waitFor(() => llmCalls.length > beforeDel, 60000, 'update after delete');
  await page.waitForTimeout(8000);
  const afterDel = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1])));
  check(!afterDel.entries.some((e) => e.name === 'Old Mill') && afterDel.ignored.includes('old mill'), 'deleted entry stays deleted although the keeper wrote it again');
  check(/NEVER write entries for \(the user removed them\): old mill/.test(llmCalls[llmCalls.length - 1]) || llmCalls.slice(beforeDel).some((c) => /NEVER write entries for/.test(c)), 'keeper told not to recreate it');

  console.log('23) A rebuild that fails completely keeps the previous memory');
  const keyNow = () => page.evaluate(() => JSON.parse(localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1])));
  const beforeFail = await keyNow();
  helperBroken = true;
  await page.locator('#story-manager-root >> .x').click();
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Rebuild from whole chat').click();
  await waitFor(async () => /Rebuild failed/.test(await page.locator('#story-manager-root >> .toast').allInnerTexts().then((t) => t.join(' '))), 60000, 'rebuild failure message');
  const afterFail = await keyNow();
  helperBroken = false;
  check(afterFail.memory === beforeFail.memory && afterFail.entries.length === beforeFail.entries.length && afterFail.log.length === beforeFail.log.length, 'story, entries and log restored after the failed rebuild');

  console.log('24) Stop cancels a running rebuild and keeps the previous memory');
  const beforeStop = await keyNow();
  helperDelay = 60000;
  await page.locator('#story-manager-root >> .x').click();
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Rebuild from whole chat').click();
  await page.locator('#story-manager-root >> button', { hasText: 'Stop' }).click({ timeout: 30000 });
  await waitFor(async () => /Rebuild stopped/.test((await page.locator('#story-manager-root >> .toast').allInnerTexts()).join(' ')), 30000, 'stop message');
  helperDelay = 500;
  const afterStop = await keyNow();
  check(aborts.length > 0, 'MiniApps asked to stop writing the answer');
  check(afterStop.memory === beforeStop.memory && afterStop.log.length === beforeStop.log.length, 'previous memory kept after stopping');

  console.log('25) A big backlog is not caught up automatically');
  await page.evaluate(() => {
    const key = 'smx:chat:' + location.pathname.split('/c/')[1];
    const c = JSON.parse(localStorage.getItem(key));
    c.processedIds = c.processedIds.slice(0, 2);
    localStorage.setItem(key, JSON.stringify(c));
  });
  await page.reload();
  await page.waitForTimeout(800);
  const callsBeforeBacklog = llmCalls.length;
  await page.evaluate(() => window.sendMsg('Onward.'));
  await waitFor(() => countOf('user') === countOf('assistant'), 8000, 'reply');
  await page.waitForTimeout(6000);
  const backlogChat = await keyNow();
  check(backlogChat.backlog && backlogChat.backlog.requests > 2 && llmCalls.length === callsBeforeBacklog, 'no automatic catch-up of ' + (backlogChat.backlog && backlogChat.backlog.messages) + ' messages; waiting for the user');
  await page.locator('#story-manager-root >> .fab').click();
  check(/messages are not in the memory yet/.test(await page.locator('#story-manager-root >> .panel').innerText()), 'panel says how many messages are missing');

  console.log('26) Closing the panel puts the page back where it was');
  await page.locator('#story-manager-root >> .x').click();
  await page.evaluate(() => {
    const tall = document.createElement('div');
    tall.style.height = '3000px';
    document.body.appendChild(tall);
    window.scrollTo(0, 0);
  });
  await page.locator('#story-manager-root >> .fab').click();
  await page.evaluate(() => window.scrollTo(0, 400)); // what focusing a box / the keyboard does
  await page.locator('#story-manager-root >> .x').click();
  await page.waitForTimeout(700);
  check(await page.evaluate(() => window.scrollY) === 0, 'page scrolled back to where it was');

  console.log('27) Streamed pieces of the bot\'s answer are not taken as the answer');
  helperDelay = 15000; // pieces arrive at once, the finished answer 15s later
  await page.evaluate(() => window.wsLoad()); // the live connection the real site always has
  const beforeStream = await keyNow();
  await page.locator('#story-manager-root >> .fab').click();
  await page.locator('#story-manager-root >> button', { hasText: 'Update now' }).click({ timeout: 120000 });
  await waitFor(async () => { const c = await keyNow(); return c.lastUpdate !== beforeStream.lastUpdate || c.lastError !== beforeStream.lastError; }, 120000, 'update with streamed answer');
  helperDelay = 500;
  const streamed = await keyNow();
  check(!streamed.lastError && /via MiniApps bot/.test(streamed.memory), 'finished answer used, not the streamed piece "- **"' + (streamed.lastError ? ' (got: ' + streamed.lastError + ')' : ''));

  console.log('28) A chat error in the helper chat moves to a fresh helper chat');
  await page.locator('#story-manager-root >> .x').click();
  const oldHelper = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:helperChat')).id);
  helperChatError = true;
  const beforeCe = await keyNow();
  await page.evaluate(() => window.sendMsg('We cross the bridge.'));
  await page.evaluate(() => window.sendMsg('We reach the tower.'));
  await waitFor(async () => { const c = await keyNow(); return c.lastUpdate !== beforeCe.lastUpdate || c.lastError !== beforeCe.lastError; }, 120000, 'update after chat error');
  helperChatError = false;
  const afterCe = await keyNow();
  const newHelper = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:helperChat')).id);
  check(!afterCe.lastError && newHelper !== oldHelper, 'update finished in a new helper chat' + (afterCe.lastError ? ' (got: ' + afterCe.lastError + ')' : ''));
  await page.locator('#story-manager-root >> .fab').click();
  await page.getByText('Diagnostics', { exact: true }).click();
  const diagCe = await page.locator('#story-manager-root >> textarea.diag').inputValue();
  check(/Last chat error from MiniApps: helper chat, \d+s ago: Context too long · code CONTEXT_LIMIT/.test(diagCe), 'chat error shown in Diagnostics');
  if (!/Last chat error from MiniApps: helper/.test(diagCe)) console.log((diagCe.match(/Last chat error[^\n]*/) || [''])[0]);

  console.log('29) A bot answer stuck repeating itself is cut off and used');
  await page.locator('#story-manager-root >> .x').click();
  helperRunaway = true;
  const abortsBefore = aborts.length;
  const beforeLoop = await keyNow();
  await page.evaluate(() => window.sendMsg('We climb the stairs.'));
  await page.evaluate(() => window.sendMsg('We open the door.'));
  await waitFor(async () => { const c = await keyNow(); return c.lastError !== beforeLoop.lastError || aborts.length > abortsBefore; }, 120000, 'update with a looping answer');
  helperRunaway = false;
  await settle();
  const afterLoop = await keyNow();
  check(aborts.length > abortsBefore, 'MiniApps asked to stop the looping answer');
  check(!afterLoop.lastError && /via MiniApps bot/.test(afterLoop.memory) && !/over and over/.test(JSON.stringify(afterLoop)), 'the good part of the answer was used, without the repetition' + (afterLoop.lastError ? ' (got: ' + afterLoop.lastError + ')' : ''));

  console.log('30) Repeated text in a saved memory is cleaned up; a too-long request is sent again smaller');
  await page.locator('#story-manager-root >> .x').click().catch(() => {});
  await page.evaluate(() => {
    const key = 'smx:chat:' + location.pathname.split('/c/')[1];
    const c = JSON.parse(localStorage.getItem(key));
    c.memory = '## Story So Far\n- update 1 (via MiniApps bot)\n- She moaned his name again and again. ' + 'She moaned his name again and again. '.repeat(3000) + '\n## Current Scene\n- Mira and Ash rest by the river.';
    c.entries.push({ name: 'Archive', kind: 'place', aliases: [], always: false, updated: 1,
      text: Array.from({ length: 600 }, (_, i) => '- Fact ' + i + ' about shelf ' + (i * 7919 % 1000) + ' of the archive.').join('\n') });
    localStorage.setItem(key, JSON.stringify(c));
  });
  await page.reload();
  await page.waitForTimeout(1500);
  const repaired = await keyNow();
  check(repaired.memory.length < 400 && /update 1/.test(repaired.memory) && /Current Scene/.test(repaired.memory), 'looping text removed from the saved story (now ' + repaired.memory.length + ' characters), real content kept');
  check(repaired.entries.find((e) => e.name === 'Archive').text.split('\n').length === 600, 'normal long entries left alone');
  await page.evaluate(() => window.wsLoad());
  // Let an update that started on load finish first.
  for (let n = -1; n !== llmCalls.length;) { n = llmCalls.length; await page.waitForTimeout(process.env.E2E_SLOW ? 15000 : 5000); }
  const callsBeforeBig = llmCalls.length;
  const bodiesBeforeBig = chatBodies.length;
  const beforeBig = await keyNow();
  helperMaxChars = 25000;
  await page.evaluate(() => window.sendMsg('We search the tower.'));
  await page.evaluate(() => window.sendMsg('We find a map.'));
  await waitFor(async () => { const c = await keyNow(); return c.lastError !== beforeBig.lastError ||
    (llmCalls.slice(callsBeforeBig).some((x) => /JOB: UPDATE/.test(x)) && c.log.every((e) => e.folded)); }, 120000, 'update after a too-long request');
  helperMaxChars = 0;
  const afterBig = await keyNow();
  const smaller = llmCalls.slice(callsBeforeBig);
  const folds = smaller.filter((c) => /JOB: UPDATE/.test(c));
  check(!afterBig.lastError && folds.length && folds.every((c) => /OTHER ENTRIES \(not involved[^\n]*Archive/.test(c) && !/Fact 599 about/.test(c)),
    'request sent again with only the entries involved' + (afterBig.lastError ? ' (got: ' + afterBig.lastError + ')' : ''));

  console.log('31) A memory from the old design moves its history into a first chapter');
  await page.evaluate(() => {
    const key = 'smx:chat:' + location.pathname.split('/c/')[1];
    const c = JSON.parse(localStorage.getItem(key));
    c.version = 2;
    c.chapters = [];
    c.memory = '## Story So Far\n- Mira met Ash.\n- They hid in the old mill.\n\n## Current Scene\n- By the river.';
    c.log.forEach((e) => { delete e.folded; delete e.chapter; });
    localStorage.setItem(key, JSON.stringify(c));
  });
  await page.reload();
  await page.waitForTimeout(1500);
  const migrated = await keyNow();
  check(migrated.version === 3 && migrated.chapters.length === 1 && migrated.chapters[0].title === 'The story until now' &&
    /Mira met Ash/.test(migrated.chapters[0].text) && migrated.memory === '## Current Scene\n- By the river.' &&
    migrated.log.every((e) => e.folded && e.chapter === 0), 'old "Story So Far" became chapter 1; existing summaries count as done');

  console.log('32) Chapters are written, sent with messages, and the memory can be redone from the summaries');
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('smx:settings'));
    st.provider = 'openai';
    st.chapterSize = 4;
    localStorage.setItem('smx:settings', JSON.stringify(st));
  });
  await page.reload();
  await page.waitForTimeout(800);
  const summaries32 = (await keyNow()).log.length;
  const callsBefore32 = llmCalls.length;
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Redo story & characters from summaries').click();
  await waitFor(() => llmCalls.length > callsBefore32, 30000, 'redo from summaries');
  await settle();
  const redone = await keyNow();
  const calls32 = llmCalls.slice(callsBefore32);
  check(calls32.every((c) => !/JOB: SUMMARISE/.test(c)) && calls32.some((c) => /JOB: UPDATE/.test(c)), 'redo used the summaries, without reading the chat again');
  check(redone.log.length === summaries32 && redone.log.every((e) => e.folded), 'all ' + summaries32 + ' summaries kept and folded in again');
  check(redone.chapters.length === Math.floor(summaries32 / 4) && redone.chapters.every((c) => /by the river/.test(c.title) && c.ids.length === 4),
    redone.chapters.length + ' chapters of 4 replies each');
  check(redone.log.filter((e) => e.chapter != null).length === redone.chapters.length * 4, 'each summary knows its chapter');
  const panel32 = await page.locator('#story-manager-root >> .panel').innerText();
  check(/Chapters \(\d+\)/.test(panel32) && /Activity/.test(panel32), 'panel shows chapters and the activity list');
  await page.locator('#story-manager-root >> details.entrybox', { hasText: 'Activity' }).locator('summary').click();
  check(/✓ Wrote chapter 1 \(replies 1–4\)/.test(await page.locator('#story-manager-root >> .panel').innerText()), 'activity lists each job');
  await page.locator('#story-manager-root >> .x').click();
  await page.evaluate(() => window.sendMsg('Where were we?'));
  const sent32 = chatBodies[chatBodies.length - 1].elements[0].text;
  check(/## The story so far, chapter by chapter\nChapter 1: Chapter \d+ by the river/.test(sent32) && /## The story now\n## Current Scene/.test(sent32),
    'chapters and the story now are sent with the message');

  console.log('33) Several summary requests can run at once, each in its own helper chat');
  await waitFor(() => countOf('user') === countOf('assistant'), 8000, 'reply');
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('smx:settings'));
    st.provider = 'miniapps';
    st.parallel = 2;
    st.chapterSize = 15;
    localStorage.setItem('smx:settings', JSON.stringify(st));
  });
  await page.reload();
  await page.waitForTimeout(800);
  const postsBefore33 = chatBodies.filter((b) => b.toolId === 'tool-helper').length;
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Rebuild from whole chat').click();
  await waitFor(() => chatBodies.filter((b) => b.toolId === 'tool-helper').length > postsBefore33 + 2, 60000, 'helper requests');
  await settle();
  const after33 = await keyNow();
  const slots = await page.evaluate(() => [localStorage.getItem('smx:helperChat'), localStorage.getItem('smx:helperChat1')].map((x) => x && JSON.parse(x).id));
  check(slots[0] && slots[1] && slots[0] !== slots[1], 'two helper chats used');
  check(!after33.lastError && after33.log.length === countOf('assistant') && after33.log.every((e) => e.folded),
    'every reply summarised in order and folded in' + (after33.lastError ? ' (got: ' + after33.lastError + ')' : ''));
  check(after33.log.map((e) => e.id).join() === recapConv.messages.filter((x) => x.origin === 'assistant').map((x) => x.id).join(), 'summaries in story order');

  console.log('34) "Check for missing facts" adds what the entries are missing, and remembers what it checked');
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('smx:settings'));
    st.provider = 'openai';
    localStorage.setItem('smx:settings', JSON.stringify(st));
  });
  await page.reload();
  await page.waitForTimeout(800);
  const callsBefore34 = llmCalls.length;
  const withFacts = (await keyNow()).log.filter((e) => e.facts).length;
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Check for missing facts').click({ timeout: 120000 });
  await waitFor(async () => (await keyNow()).log.every((e) => !e.facts || e.checked), 60000, 'fact check');
  await settle();
  const checked = await keyNow();
  const checks = llmCalls.slice(callsBefore34).filter((c) => /JOB: CHECK/.test(c));
  check(checks.length >= 1 && checks.every((c) => /\[F1\] Mira is a healer \| Ash is a dragon/.test(c)), checks.length + ' check request(s) with every summary\'s facts');
  const mira34 = checked.entries.find((e) => e.name === 'Mira').text;
  check(/^- Mira: a healer[^\n]*\n- Checked \d+ facts; Mira fears deep water\.$/.test(mira34), 'missing fact added to the end of the right entry, the rest kept');
  check(checked.log.filter((e) => e.checked).length === withFacts && /Checked the facts of replies 1–/.test(checked.jobs.find((j) => j.kind === 'check').label + checked.jobs.map((j) => j.label).join()),
    'all ' + withFacts + ' summaries marked as checked; recorded in Activity');
  check(/Facts checked: \d+ of \d+/.test(await page.locator('#story-manager-root >> .panel').innerText()), 'panel shows how many facts are checked');

  console.log('34b) "Write in full detail" rewrites one entry from every reply that mentions it, keeping what it had');
  const callsBefore34b = llmCalls.length;
  await page.locator('#story-manager-root >> summary', { hasText: /^Mira · / }).click();
  await page.locator('#story-manager-root >> button.btn.primary', { hasText: 'Save' }).click();
  await page.waitForTimeout(300);
  check(await page.locator('#story-manager-root >> details[open] > summary', { hasText: /^Mira · / }).count() === 1, 'an entry the user opened stays open when the panel is redrawn');
  page.once('dialog', (d) => d.accept());
  await page.locator('#story-manager-root >> details[open] >> text=Write in full detail').click();
  await waitFor(async () => /Rewritten in full detail/.test(((await keyNow()).entries.find((e) => e.name === 'Mira') || {}).text || ''), 60000, 'entry rewrite');
  await settle();
  const after34b = await keyNow();
  const mira34b = after34b.entries.find((e) => e.name === 'Mira');
  const asks = llmCalls.slice(callsBefore34b).filter((c) => /ONE ENTRY ONLY/.test(c));
  check(asks.length >= 1 && asks.every((c) => /\[R1\] /.test(c)), asks.length + ' request(s) with the replies that mention Mira');
  check(mira34b.text.includes(mira34) && /^### Basics/.test(mira34b.text) && !/Looking at|I think we/.test(mira34b.text) && mira34b.aliases.includes('the healer'),
    'entry rewritten and organised, old facts kept, no bot notes');
  check(after34b.jobs.some((j) => /Wrote Mira in full detail/.test(j.label)), 'recorded in Activity');

  console.log('35) A chat that got too long for the AI carries on in a new chat, with its memory');
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('smx:settings'));
    st.memoryMessage = true;
    localStorage.setItem('smx:settings', JSON.stringify(st));
  });
  await page.reload();
  await page.waitForTimeout(800);
  const oldId = await page.evaluate(() => location.pathname.split('/c/')[1]);
  const oldChat = await keyNow();
  const lastReply35 = recapConv.messages.filter((x) => x.origin === 'assistant').pop().elements[0].text;
  // The site reports the AI's context-length error for the story chat.
  await page.evaluate((id) => document.dispatchEvent(new CustomEvent('smx:ws', { detail: JSON.stringify({ dir: 'in', event: 'ce',
    text: JSON.stringify([{ conversationId: id, requestId: 'x', messageId: 'y', replyToMessageId: null, code: 'error',
      error: "This endpoint's maximum context length is 163840 tokens. However, you requested about 177566 tokens. Please reduce the length" }]) }) })), oldId);
  await page.locator('#story-manager-root >> .fab').click();
  check(/too long for the AI/.test(await page.locator('#story-manager-root >> .panel').innerText()), 'panel says the chat is too long and what to do');
  const convsBefore35 = Object.keys(convs).length;
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Continue in a new chat' }).click({ timeout: 120000 });
  await waitFor(async () => {
    try { return (await page.evaluate(() => location.pathname.split('/c/')[1])) !== oldId; } catch (e) { return false; } // mid-navigation
  }, 60000, 'move to the new chat');
  await page.waitForLoadState();
  const newId = await page.evaluate(() => location.pathname.split('/c/')[1]);
  const newConv = convs[newId];
  const opener = newConv && newConv.messages[0].elements[0].text;
  check(Object.keys(convs).length === convsBefore35 + 1 && newConv.toolId === 'tool-story', 'a new chat with the same bot');
  check(/^\[\[STORY-MEMORY\]\][\s\S]*### Mira[\s\S]*\[\[\/STORY-MEMORY\]\]/.test(opener) && opener.includes(lastReply35.slice(-40)) && /Continue the story from exactly this point/.test(opener),
    'its first message carries the memory and the last reply');
  await page.waitForTimeout(1500);
  const moved = await keyNow();
  check(moved.continuedFrom === oldId && moved.entries.length === oldChat.entries.length && moved.log.length === oldChat.log.length &&
    moved.chapters.length === oldChat.chapters.length, 'the new chat has a copy of the memory');
  check((await page.evaluate((id) => JSON.parse(localStorage.getItem('smx:chat:' + id)), oldId)).continuedIn === newId, 'the old chat points to the new one');
  check(moved.pinnedMemoryId === newConv.messages[0].id && pins[newId] && pins[newId].has(newConv.messages[0].id), 'the first message, with the memory, is pinned');
  await waitFor(() => newConv.messages.length >= 2, 8000, 'first reply in the new chat');
  await page.evaluate(() => window.sendMsg('And so we go on.'));
  check(!/STORY-MEMORY/.test(chatBodies[chatBodies.length - 1].elements[0].text), 'later messages carry no memory: it lives in the pinned first message');

  console.log('36) The newest message that carries the memory stays pinned; the user\'s own pins are left alone');
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('smx:settings'));
    st.memoryMessage = false; // attach the memory to messages, as without the pinned memory message
    localStorage.setItem('smx:settings', JSON.stringify(st));
  });
  await page.reload();
  await page.waitForTimeout(800);
  await waitFor(() => newConv.messages[newConv.messages.length - 1].origin === 'assistant', 8000, 'reply');
  await page.evaluate(() => window.sendMsg('A new step.'));
  await waitFor(() => newConv.messages[newConv.messages.length - 1].origin === 'assistant', 8000, 'reply');
  const pinnedOf = () => [...(pins[newId] || [])];
  const lastUser = () => newConv.messages.filter((x) => x.origin === 'user').pop().id;
  await waitFor(() => pinnedOf().includes(lastUser()), 8000, 'pin of the newest memory message');
  check(pinnedOf().length === 1, 'only the newest memory message is pinned (' + pinnedOf().length + ')');
  pins[newId].add('users-own-pin');
  await page.evaluate(() => window.sendMsg('Onward again.'));
  await waitFor(() => pinnedOf().includes(lastUser()), 8000, 'pin moved to the newest memory message');
  check(pinnedOf().length === 2 && pinnedOf().includes('users-own-pin'), 'pin moved to the newest one; the user\'s own pin kept');
  // Both slots are full now (the user's pin and ours): ours moves to the newest message.
  await waitFor(() => newConv.messages[newConv.messages.length - 1].origin === 'assistant', 8000, 'reply');
  await page.evaluate(() => window.sendMsg('And on.'));
  await waitFor(() => pinnedOf().includes(lastUser()), 8000, 'pin moved with both slots full');
  check(pinnedOf().length === 2 && pinnedOf().includes('users-own-pin'), 'with both slots full, ours is moved, never the user\'s');
  // Both slots taken by the user's own pins: nothing of theirs is touched, and the panel says so.
  pins[newId] = new Set(['users-own-pin', 'users-second-pin']);
  await waitFor(() => newConv.messages[newConv.messages.length - 1].origin === 'assistant', 8000, 'reply');
  await page.evaluate(() => window.sendMsg('Further.'));
  await waitFor(async () => !!(await keyNow()).pinError, 8000, 'pin error recorded');
  check(pinnedOf().join() === 'users-own-pin,users-second-pin', 'the user\'s two pins are left alone');
  await page.locator('#story-manager-root >> .fab').click();
  check(/Could not pin the memory message/.test(await page.locator('#story-manager-root >> .panel').innerText()), 'the panel says why the memory could not be pinned');

  console.log('37) The memory lives in one pinned message that is edited in place; new messages and the user\'s edits carry none');
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('smx:settings'));
    st.memoryMessage = true;
    localStorage.setItem('smx:settings', JSON.stringify(st));
    const key = 'smx:chat:' + location.pathname.split('/c/')[1];
    const c = JSON.parse(localStorage.getItem(key));
    c.pinnedMemoryId = null;
    c.pinError = '';
    localStorage.setItem(key, JSON.stringify(c));
  });
  pins[newId] = new Set();
  await page.reload();
  await page.waitForTimeout(800);
  await waitFor(() => newConv.messages[newConv.messages.length - 1].origin === 'assistant', 8000, 'reply');
  await page.evaluate(() => window.sendMsg('Pin this one.'));
  const carrier = lastUser();
  check(/^\[\[STORY-MEMORY\]\]/.test(chatBodies[chatBodies.length - 1].elements[0].text), 'the first message carries the memory');
  await waitFor(() => pinnedOf().includes(carrier), 8000, 'carrier pinned');
  await waitFor(() => newConv.messages[newConv.messages.length - 1].origin === 'assistant', 8000, 'reply');
  await page.evaluate(() => window.sendMsg('Then we rest.'));
  check(!/STORY-MEMORY/.test(chatBodies[chatBodies.length - 1].elements[0].text), 'the next message carries none');
  const editsBefore = edits.length;
  await waitFor(() => edits.length > editsBefore, 60000, 'the pinned message updated after the memory changed');
  const memEdit = edits[edits.length - 1];
  const pinnedText = newConv.messages.find((x) => x.id === carrier).elements[0].text;
  check(memEdit.overrideMessageId === carrier && memEdit.editInPlace === true && memEdit.toolId === 'tool-story' &&
    /^\[\[STORY-MEMORY\]\][\s\S]*\[\[\/STORY-MEMORY\]\]\n\n\(My earlier message from when this note was pinned\. It was answered long ago; it is not what happens next\.\)\nPin this one\.$/.test(pinnedText),
    'the pinned message was edited in place with the new memory, keeping the user\'s text, labelled as answered long ago');
  check(newConv.messages.filter((x) => x.origin === 'user').length === newConv.messages.filter((x) => x.origin === 'assistant').length, 'the edit wrote no new reply');
  const all37 = await keyNow();
  check(all37.entries.every((e) => pinnedText.includes(e.text)) && all37.chapters.every((c) => pinnedText.includes(c.text)),
    'the pinned message holds every entry (' + all37.entries.length + ') and every chapter (' + all37.chapters.length + ') in full');
  await page.locator('#story-manager-root >> .fab').click();
  check(/The memory lives in one pinned message/.test(await page.locator('#story-manager-root >> .panel').innerText()), 'the panel says where the memory lives');
  await page.locator('#story-manager-root >> .x').click();
  await page.evaluate((id) => window.editMsg(id, 'Then we rest by the fire.'), lastUser());
  check(!/STORY-MEMORY/.test(edits[edits.length - 1].elements[0].text), 'the user\'s own edits get no memory');

  console.log('37b) The pinned message is updated even if the AI is writing (waits and tries again) or a big message is refused (smaller one)');
  const edits37b = edits.length;
  editBusy = 1;
  editTooBig = 1;
  await page.locator('#story-manager-root >> .fab').click();
  await page.locator('#story-manager-root >> textarea').first().fill('Mira hums when nervous.');
  await page.locator('#story-manager-root >> button.btn.primary', { hasText: 'Save' }).click();
  await waitFor(() => edits.length > edits37b, 60000, 'the pinned message updated after a 409 and a size refusal');
  check(editBusy === 0 && editTooBig === 0 && /Mira hums when nervous/.test(newConv.messages.find((x) => x.id === carrier).elements[0].text), 'updated after waiting and after the refusal');
  await waitFor(async () => /Updated the pinned memory message/.test((await keyNow()).jobs[0].label), 15000, 'job recorded');
  check(!(await keyNow()).memoryMsgError && await page.evaluate(() => localStorage.getItem('smx:memoryMsgSize')) === '120000', 'no error shown; the smaller size is remembered');
  const cut37 = (await keyNow()).memoryMsgCut;
  check(cut37 && /too long/.test(cut37.error) && cut37.size === 120000 && !cut37.left.length && (await keyNow()).jobs.some((j) => /MiniApps refused the pinned memory message/.test(j.label)),
    'what MiniApps said is recorded, with what the smaller message holds; in Activity');
  // A message that had to leave things out: the panel says what was kept and what was not.
  // (Updates still running would rewrite the pinned message, and this state with it.)
  await settle();
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const key = 'smx:chat:' + location.pathname.split('/c/')[1];
    const c = JSON.parse(localStorage.getItem(key));
    c.memoryMsgCut = Object.assign(c.memoryMsgCut, { left: ['Ash'], shortened: ['Mira'], full: ['Old Mill'], chapters: 3, chFull: 1 });
    localStorage.setItem(key, JSON.stringify(c));
  });
  await page.reload();
  await page.waitForTimeout(800);
  await page.locator('#story-manager-root >> .fab').click();
  const cutText = await page.locator('#story-manager-root >> .panel').innerText();
  check(/not complete/.test(cutText) && /MiniApps refused the full message \([^)]*Message is too long\)/.test(cutText) && /Left out: Ash/.test(cutText) &&
    /Shortened[^\n]*: Mira/.test(cutText) && /Chapters: 1 of 3 in full, the older 2 by title only/.test(cutText), 'the panel says what MiniApps said, what was kept and what was left out');
  check(/Made with Story Manager: v9\.9\.9[^\n]*reply summaries: \d+ from v9\.9\.9/.test(cutText), 'the panel shows which Story Manager version made the memory');
  const edits37c = edits.length;
  await page.getByText('Try the full size again').click();
  await waitFor(() => edits.length > edits37c, 30000, 'retried at full size');
  check(await page.evaluate(() => localStorage.getItem('smx:memoryMsgSize')) === '0' && !(await keyNow()).memoryMsgCut, '"Try the full size again" pins everything again');
  await page.locator('#story-manager-root >> .x').click();

  console.log('37c) Any change to the memory reaches the pinned message on its own; keeper notes are cleaned whenever the memory is tidied');
  await waitFor(async () => !(await keyNow()).memoryMsgCut && (await keyNow()).memoryMsgSynced, 15000, 'pinned message synced');
  const edits37d = edits.length;
  await page.evaluate(() => {
    const key = 'smx:chat:' + location.pathname.split('/c/')[1];
    const c = JSON.parse(localStorage.getItem(key));
    const e = c.entries.find((x) => x.name === 'Mira');
    e.text += '\n- Current State: By the river.\nBut note: we don\'t have her appearance. So we output only the new entry.\n- Current State: Asleep in the tent (presumed).\n- Loves plums.\n- Current State: Cooking by the fire.';
    localStorage.setItem(key, JSON.stringify(c));
  });
  await page.reload();
  await waitFor(() => edits.length > edits37d, 30000, 'the pinned message updated with no update or Save');
  const mira37d = (await keyNow()).entries.find((x) => x.name === 'Mira').text;
  const pinned37d = newConv.messages.find((x) => x.id === carrier).elements[0].text;
  check(!/But note|presumed|Current State/.test(mira37d) && /- Loves plums\.$/.test(mira37d), 'notes and guesses cleaned when the story was opened; the state left the entry, the new fact stayed');
  check(pinned37d.includes('- Loves plums.') && !/But note|presumed|Current State/.test(pinned37d), 'the pinned message followed the cleaned memory on its own');
  await page.locator('#story-manager-root >> .fab').click();
  await page.getByText('Diagnostics', { exact: true }).click();
  await waitFor(async () => /Pinned memory message: [^\n]*up to date/.test(await page.locator('#story-manager-root >> textarea.diag').inputValue()), 15000, 'Diagnostics: up to date');
  check(true, 'Diagnostics says the pinned message is up to date');
  await page.locator('#story-manager-root >> .x').click();

  console.log('38) A pinned memory message that was deleted or regenerated is replaced by the next one');
  // Like "edit and regenerate": the pinned message is replaced by a new one.
  const gone = carrier;
  const gi = newConv.messages.findIndex((x) => x.id === gone);
  newConv.messages[gi] = Object.assign({}, newConv.messages[gi], { id: uuid() });
  pins[newId].delete(gone);
  await page.locator('#story-manager-root >> .fab').click();
  await page.locator('#story-manager-root >> textarea').first().fill('Mira cannot swim. Ash cannot read.');
  await page.locator('#story-manager-root >> button.btn.primary', { hasText: 'Save' }).click();
  await waitFor(async () => !(await keyNow()).pinnedMemoryId, 15000, 'the lost pinned message forgotten');
  const lostState = await keyNow();
  check(!lostState.memoryMsgError && /no longer pinned/.test(lostState.jobs[0].label), 'noticed that the pinned message is gone, without an error');
  await page.locator('#story-manager-root >> .x').click();
  await waitFor(() => newConv.messages[newConv.messages.length - 1].origin === 'assistant', 8000, 'reply');
  await page.evaluate(() => window.sendMsg('Onwards, freshly pinned.'));
  check(/^\[\[STORY-MEMORY\]\][\s\S]*Ash cannot read/.test(chatBodies[chatBodies.length - 1].elements[0].text), 'the next message carries the memory again');
  await waitFor(() => pinnedOf().includes(lastUser()), 8000, 'new carrier pinned');
  check((await keyNow()).pinnedMemoryId === lastUser(), 'and becomes the new pinned memory message');

  console.log('39) Deleted and rewritten messages: old summaries dropped, rewritten replies summarised again');
  await page.evaluate(() => window.wsLoad());
  await page.locator('#story-manager-root >> .fab').click().catch(() => {});
  await page.getByText('Update now').click({ timeout: 120000 });
  await settle();
  const log39 = (await keyNow()).log;
  const replies39 = newConv.messages.filter((x) => x.origin === 'assistant' && log39.some((e) => e.id === x.id));
  const [deleted, rewritten] = replies39.slice(-2);
  const sock = (event, payload) => page.evaluate(([ev, p]) => document.dispatchEvent(new CustomEvent('smx:ws', { detail: JSON.stringify({ dir: 'in', event: ev, text: JSON.stringify([p]) }) })), [event, payload]);
  newConv.messages = newConv.messages.filter((x) => x.id !== deleted.id);
  await sock('cmd', { conversationId: newId, ids: [deleted.id] });
  rewritten.elements = [{ type: 'text', text: 'REWRITTEN reply: Ash flies away. NOFACTSLINE' }];
  await sock('cmu', { conversationId: newId, message: Object.assign({ conversationId: newId }, rewritten) });
  await page.waitForTimeout(500);
  const after39 = await keyNow();
  check(!after39.log.some((e) => e.id === deleted.id) && after39.redo.includes(rewritten.id), 'deleted reply\'s summary removed; rewritten reply queued');
  const calls39 = llmCalls.length;
  await page.getByText('Update now').click({ timeout: 120000 });
  await settle();
  const redone39 = await keyNow();
  check(llmCalls.slice(calls39).some((c) => /JOB: SUMMARISE/.test(c) && /REWRITTEN reply: Ash flies away/.test(c)) &&
    /Reply: REWRITTEN reply/.test(redone39.log.find((e) => e.id === rewritten.id).text) && !(redone39.redo || []).length, 'rewritten reply summarised again from its new text');
  const redoneEntry = redone39.log.find((e) => e.id === rewritten.id);
  check(redoneEntry.facts && redoneEntry.factsAsked && llmCalls.slice(calls39).filter((c) => /JOB: SUMMARISE/.test(c) && /NOFACTSLINE/.test(c)).length === 2,
    'a skipped FACTS line is asked for again, once');
  const corr39 = llmCalls.slice(calls39).filter((c) => /JOB: CORRECT/.test(c));
  check(corr39.length === 1 && /EVENTS THAT NO LONGER HAPPENED[\s\S]*\[OLD1\]/.test(corr39[0]), 'one correction request with the summaries of the replies that are gone');
  check(!(redone39.stale || []).length && !redone39.staleFacts && /Corrected after redo/.test(redone39.entries.find((e) => e.name === 'Ash').text) &&
    redone39.jobs.some((j) => /Corrected the memory after/.test(j.label)), 'what only the old replies said is corrected; recorded in Activity');
  await page.getByText('Diagnostics', { exact: true }).click();
  const diag39 = await page.locator('#story-manager-root >> textarea.diag').inputValue();
  check(/summaries \(\d+ with facts, \d+ none/.test(diag39), 'Diagnostics shows which summaries have facts');
  check(/Memory health: OK · \d+ entr(y|ies) waiting to be consolidated/.test(diag39), 'Diagnostics shows the memory is healthy after tidying');

  console.log('39b) A deleted reply inside a chapter: the chapter is written again without it');
  const inCh = redone39.log.find((e) => e.chapter != null && newConv.messages.some((x) => x.id === e.id));
  if (!inCh) check(false, 'a reply in a chapter to delete: ' + JSON.stringify(redone39.log.map((e) => e.chapter)));
  const chI = inCh.chapter;
  const chCount = redone39.log.filter((e) => e.chapter === chI).length;
  newConv.messages = newConv.messages.filter((x) => x.id !== inCh.id);
  await sock('cmd', { conversationId: newId, ids: [inCh.id] });
  await page.waitForTimeout(500);
  const calls39b = llmCalls.length;
  await page.getByText('Update now').click({ timeout: 120000 });
  await settle();
  const after39b = await keyNow();
  const chCalls = llmCalls.slice(calls39b).filter((c) => new RegExp('JOB: CHAPTER\\. Write chapter ' + (chI + 1) + ' now').test(c));
  const left39b = after39b.log.filter((e) => e.chapter === chI).length;
  check((chCount > 1 ? chCalls.length === 1 && left39b === chCount - 1 && after39b.jobs.some((j) => new RegExp('Rewrote chapter ' + (chI + 1) + ' without').test(j.label))
    : after39b.chapters.length === redone39.chapters.length - 1), 'the chapter is rewritten from the replies left in it (or removed if none are left)');

  console.log('39c) "Get missing facts lists" asks again for summaries without facts');
  const here39c = newConv.messages.map((x) => x.id);
  const pick39c = (await keyNow()).log.filter((e) => here39c.includes(e.id)).slice(0, 2).map((e) => e.id);
  await page.evaluate((ids) => {
    const key = 'smx:chat:' + location.pathname.split('/c/')[1];
    const c = JSON.parse(localStorage.getItem(key));
    for (const e of c.log) if (ids.includes(e.id)) { delete e.facts; delete e.nofacts; delete e.factsAsked; }
    localStorage.setItem(key, JSON.stringify(c));
  }, pick39c);
  await page.reload();
  await page.waitForTimeout(800);
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Get missing facts lists').click();
  await waitFor(async () => (await keyNow()).log.filter((e) => pick39c.includes(e.id)).every((e) => e.facts), 60000, 'facts lists');
  await settle();
  check((await keyNow()).jobs.some((j) => /Got the facts of [^:]*: 2 of 2 had facts/.test(j.label)), 'both summaries got their facts back; recorded in Activity');
  await page.locator('#story-manager-root >> .x').click();

  console.log('39d) Opening a story compares it with the whole chat: summaries of replies that vanished unseen are removed and corrected; the old chat\'s summaries stay');
  await settle();
  const before39d = await keyNow();
  const inherited39d = before39d.log.filter((e) => !newConv.messages.some((x) => x.id === e.id)).length;
  const victim = before39d.log.filter((e) => newConv.messages.some((x) => x.id === e.id)).slice(-3)[0];
  // Redone on another device: the reply is replaced, and this page never hears of it.
  const vi = newConv.messages.findIndex((x) => x.id === victim.id);
  newConv.messages[vi] = Object.assign({}, newConv.messages[vi], { id: uuid(), elements: [{ type: 'text', text: 'A quietly redone reply.' }] });
  const calls39d = llmCalls.length;
  await page.reload();
  await waitFor(async () => !(await keyNow()).log.some((e) => e.id === victim.id), 60000, 'the vanished reply\'s summary removed');
  await waitFor(() => llmCalls.slice(calls39d).some((c) => /JOB: CORRECT/.test(c)), 60000, 'correction');
  await settle();
  const after39d = await keyNow();
  check(after39d.log.filter((e) => e.inherited).length === inherited39d && after39d.log.filter((e) => !newConv.messages.some((x) => x.id === e.id)).length === inherited39d,
    'only the vanished reply\'s summary was removed; the ' + inherited39d + ' from the old chat stay');
  check(after39d.jobs.some((j) => /Checked the whole chat: removed 1 summary of replies that are no longer in it/.test(j.label)) &&
    llmCalls.slice(calls39d).some((c) => /JOB: CORRECT/.test(c) && c.includes(victim.text.slice(0, 50))), 'recorded in Activity, and the memory corrected for it');
  check(after39d.knownReplies === newConv.messages.filter((x) => x.origin === 'assistant').length && after39d.knownMessages === newConv.messages.length, 'reply and message counts come from the whole chat');

  console.log('39e) Every few updates, entries that grew by additions are consolidated in full');
  await page.evaluate(() => {
    const key = 'smx:chat:' + location.pathname.split('/c/')[1];
    const c = JSON.parse(localStorage.getItem(key));
    const e = c.entries.find((x) => x.name === 'Ash');
    e.text = '### Basics\n- Ash is a dragon.\n- Role: messenger of the king.\n' + Array.from({ length: 24 }, (_, i) => '- Key Moments: Flew over valley number ' + i + ' at dusk.').join('\n') +
      '\n- Ash is a dragon.\n- Role: guard of the old mill.';
    e.updated = Date.now();
    delete e.consolidated;
    c.foldsSinceConsolidate = 2;
    localStorage.setItem(key, JSON.stringify(c));
  });
  await page.reload();
  await page.waitForTimeout(800);
  const calls39e = llmCalls.length;
  await waitFor(() => !newConv.generating, 8000, 'idle');
  await page.evaluate(() => window.sendMsg('We fly on.'));
  await waitFor(() => !newConv.generating && newConv.messages[newConv.messages.length - 1].origin === 'assistant', 8000, 'reply');
  await page.evaluate(() => window.sendMsg('And land.'));
  await waitFor(() => !newConv.generating && newConv.messages[newConv.messages.length - 1].origin === 'assistant', 8000, 'reply');
  await page.locator('#story-manager-root >> .fab').click();
  await page.getByText('Update now').click({ timeout: 120000 });
  await waitFor(() => llmCalls.slice(calls39e).some((c) => /JOB: CONSOLIDATE/.test(c) && /=== ENTRY: Ash/.test(c)), 60000, 'consolidation of Ash');
  await settle();
  const ash39e = (await keyNow()).entries.find((x) => x.name === 'Ash');
  check(/- Consolidated\.$/.test(ash39e.text) && (ash39e.text.match(/Ash is a dragon/g) || []).length === 1 && ash39e.consolidated >= ash39e.updated - 5,
    'Ash was rewritten in full: duplicates merged, marked as consolidated');
  check((await keyNow()).jobs.some((j) => /Consolidated Ash/.test(j.label)), 'recorded in Activity');
  await page.locator('#story-manager-root >> .x').click().catch(() => {});

  console.log('39f) "Check summaries" compares summaries with the replies and corrects wrong ones');
  await settle();
  const here39f = newConv.messages.map((x) => x.id);
  const wrong39f = (await keyNow()).log.filter((e) => here39f.includes(e.id) && e.folded).slice(-2)[0];
  await page.evaluate((id) => {
    const key = 'smx:chat:' + location.pathname.split('/c/')[1];
    const c = JSON.parse(localStorage.getItem(key));
    const e = c.log.find((x) => x.id === id);
    e.text = 'NONSENSE: Winter flew to the moon.';
    for (const x of c.log) delete x.verified;
    localStorage.setItem(key, JSON.stringify(c));
  }, wrong39f.id);
  await page.reload();
  await page.waitForTimeout(800);
  await page.locator('#story-manager-root >> .fab').click();
  const calls39f = llmCalls.length;
  page.once('dialog', (d) => d.accept());
  await page.getByText('Check summaries').click();
  await waitFor(async () => /Corrected summary/.test(((await keyNow()).log.find((e) => e.id === wrong39f.id) || {}).text || ''), 60000, 'summary corrected');
  await settle();
  const after39f = await keyNow();
  const verify39f = llmCalls.slice(calls39f).filter((c) => /JOB: VERIFY/.test(c));
  check(verify39f.length >= 1 && verify39f.some((c) => /NONSENSE: Winter flew to the moon/.test(c) && /MESSAGES \(oldest first\)/.test(c)), 'each summary is sent with its actual reply');
  check(after39f.log.filter((e) => here39f.includes(e.id)).slice(-30).every((e) => e.verified) && after39f.log.find((e) => e.id === wrong39f.id).facts === 'Mira is a healer | Ash crossed the bridge',
    'the wrong summary and its facts were corrected; the checked ones are remembered');
  check(llmCalls.slice(calls39f).some((c) => /JOB: CORRECT/.test(c) && /NONSENSE: Winter flew to the moon/.test(c)) && after39f.log.find((e) => e.id === wrong39f.id).folded,
    'what only the wrong summary said is corrected in the story & characters, and the corrected one folded in');
  check(after39f.jobs.some((j) => /Checked the summaries of [^:]*: corrected 1/.test(j.label)), 'recorded in Activity');

  console.log('39g) "Check chapters" grades each chapter against its summaries; a flagged one can be rewritten');
  const calls39g = llmCalls.length;
  page.once('dialog', (d) => d.accept());
  await page.getByText('Check chapters').click();
  await waitFor(async () => { const k = await keyNow(); return k.chapters.every((c, i) => c.check || !k.log.some((e) => e.chapter === i)); }, 60000, 'chapters graded');
  await settle();
  const after39g = await keyNow();
  const graded = after39g.chapters.map((c, i) => [c, i]).filter(([c]) => c.check);
  const flaggedCh = graded.find(([c]) => c.check.score === 5);
  check(llmCalls.slice(calls39g).some((c) => /JOB: GRADE/.test(c) && /WHAT HAPPENED/.test(c)) && graded.length >= 1 && flaggedCh && /Ash, not Mira/.test(flaggedCh[0].check.wrong) && !flaggedCh[0].check.missing,
    'chapters graded with their problems listed');
  await page.locator('#story-manager-root >> summary', { hasText: new RegExp('^Chapter ' + (flaggedCh[1] + 1) + ':.*⚠ 5/10') }).click();
  const panel39g = await page.locator('#story-manager-root >> .panel').innerText();
  check(/Wrong: It was Ash, not Mira, who lit the fire\./.test(panel39g), 'the panel shows the grade and what is wrong');
  const calls39h = llmCalls.length;
  page.once('dialog', (d) => d.accept());
  await page.locator('#story-manager-root >> details[open] >> button', { hasText: 'Rewrite' }).click();
  await waitFor(async () => (await keyNow()).jobs.some((j) => new RegExp('Rewrote chapter ' + (flaggedCh[1] + 1) + ' from its summaries').test(j.label)), 60000, 'chapter rewritten');
  const re39 = llmCalls.slice(calls39h).find((c) => /JOB: CHAPTER/.test(c));
  check(re39 && /FOUND THESE PROBLEMS[\s\S]*Ash, not Mira/.test(re39) && (await keyNow()).chapters[flaggedCh[1]].needsCheck, 'rewritten with the problems pointed out, and marked to be checked again');
  await page.locator('#story-manager-root >> .x').click().catch(() => {});

  console.log('39e2) "Consolidate now" files every changed entry, and moves facts about someone else to them');
  await page.evaluate(() => {
    const key = 'smx:chat:' + location.pathname.split('/c/')[1];
    const c = JSON.parse(localStorage.getItem(key));
    const e = c.entries.find((x) => x.name === 'Ash');
    e.text += '\n- MISPLACED Mira: Packed her herb satchel for the trip.';
    e.updated = Date.now() + 5000;
    localStorage.setItem(key, JSON.stringify(c));
  });
  await page.reload();
  await page.waitForTimeout(800);
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Consolidate now').click();
  await waitFor(async () => /Packed her herb satchel/.test((await keyNow()).entries.find((x) => x.name === 'Mira').text), 60000, 'fact moved to Mira');
  await settle();
  const k39e2 = await keyNow();
  check(!/herb satchel/.test(k39e2.entries.find((x) => x.name === 'Ash').text) && /### Moved here from Ash\n- Packed her herb satchel for the trip\./.test(k39e2.entries.find((x) => x.name === 'Mira').text),
    'the fact left Ash and went to Mira');
  check(k39e2.jobs.some((j) => /Moved facts from Ash to Mira/.test(j.label)) && llmCalls.some((c) => /JOB: CONSOLIDATE/.test(c) && /WHAT HAPPENED \(summaries/.test(c) && /OTHER CHARACTERS: /.test(c)),
    'the keeper got the summaries as evidence; recorded in Activity');
  await page.locator('#story-manager-root >> .x').click().catch(() => {});

  console.log('40) Pins wait for the story AI to finish; the newest replies are held back until newer ones follow');
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('smx:settings'));
    st.holdBack = 1;
    localStorage.setItem('smx:settings', JSON.stringify(st));
  });
  await page.reload();
  await page.waitForTimeout(800);
  await waitFor(() => !newConv.generating, 8000, 'idle');
  // Lose the pin, so the next message carries the memory and gets pinned.
  pins[newId] = new Set();
  await page.locator('#story-manager-root >> .fab').click();
  await page.locator('#story-manager-root >> textarea').first().fill('Mira cannot swim. Ash cannot read. Winter sings.');
  await page.locator('#story-manager-root >> button.btn.primary', { hasText: 'Save' }).click();
  await waitFor(async () => !(await keyNow()).pinnedMemoryId, 15000, 'pin forgotten');
  await page.locator('#story-manager-root >> .x').click();
  let pinnedWhileWriting = false;
  const watch = setInterval(() => { if (newConv.generating && pins[newId].size) pinnedWhileWriting = true; }, 20);
  await page.evaluate(() => window.sendMsg('Pin me after the reply.'));
  await waitFor(() => pins[newId].size > 0, 30000, 'pin after the reply');
  clearInterval(watch);
  check(!pinnedWhileWriting, 'the pin waited until the story AI had finished its reply');
  const newest = newConv.messages.filter((x) => x.origin === 'assistant').pop().id;
  await page.locator('#story-manager-root >> .fab').click();
  await page.getByText('Update now').click({ timeout: 120000 });
  await settle();
  check(!(await keyNow()).log.some((e) => e.id === newest), 'the newest reply is held back');
  const p40 = await page.locator('#story-manager-root >> .panel').innerText();
  check(/waiting: 1 \(the newest reply waits in case you redo it\)/.test(p40), 'the panel counts the held-back reply as waiting');
  await page.locator('#story-manager-root >> .x').click();
  await page.evaluate(() => window.sendMsg('One more.'));
  await waitFor(() => !newConv.generating && newConv.messages[newConv.messages.length - 1].origin === 'assistant', 8000, 'reply');
  await page.locator('#story-manager-root >> .fab').click();
  await page.getByText('Update now').click({ timeout: 120000 });
  await settle();
  check((await keyNow()).log.some((e) => e.id === newest), 'once a newer reply follows, it is summarised');

  console.log('41) The button gets out of the way while the user types or edits on the site');
  await page.locator('#story-manager-root >> .x').click().catch(() => {});
  await page.locator('#msg').focus();
  await page.waitForTimeout(200);
  check(!(await page.locator('#story-manager-root >> .fab').isVisible()), 'hidden while a text box on the site has focus');
  await page.locator('#msg').blur();
  await page.waitForTimeout(300);
  check(await page.locator('#story-manager-root >> .fab').isVisible(), 'back afterwards');

  console.log('42) Memories sync between devices through a private GitHub Gist');
  await page.locator('#story-manager-root >> .fab').click().catch(() => {});
  await page.locator('#story-manager-root >> nav button', { hasText: 'Settings' }).click();
  await page.locator('#story-manager-root >> input[placeholder^="GitHub token"]').fill('gh-test-token');
  await page.getByText('Sync now').click();
  await waitFor(() => Object.values(gists).some((g) => g.files['chat-' + newId + '.json']), 30000, 'chat saved to the gist');
  const gist = Object.values(gists)[0];
  check(/Story Manager sync/.test(gist.description) && Object.keys(gist.files).filter((n) => /^chat-/.test(n)).length >= 2, 'a private gist holds every chat');
  const here = await keyNow();
  check(JSON.parse(gist.files['chat-' + newId + '.json'].content).log.length === here.log.length, 'with the whole memory');
  // A fresh device: no memories stored locally, same token.
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^smx:chat/.test(k)) localStorage.removeItem(k); });
  await page.reload();
  await waitFor(async () => !!(await keyNow()), 20000, 'memory loaded from the gist');
  const restored = await keyNow();
  check(restored.log.length === here.log.length && restored.entries.length === here.entries.length && restored.pinned === here.pinned, 'a new device gets the memory automatically');
  // The other device changed it later: the newer copy is loaded here.
  const other = JSON.parse(gist.files['chat-' + newId + '.json'].content);
  other.pinned = 'Changed on the other device.';
  other.changedAt = Date.now() + 1000;
  gist.files['chat-' + newId + '.json'] = { content: JSON.stringify(other) };
  await page.locator('#story-manager-root >> .fab').click();
  await page.locator('#story-manager-root >> nav button', { hasText: 'Settings' }).click();
  await page.getByText('Sync now').click();
  await waitFor(async () => (await keyNow()).pinned === 'Changed on the other device.', 20000, 'newer copy loaded');
  check(true, 'the newer copy from the other device replaces the older one');
  await page.waitForTimeout(1500); // the panel redraws after syncing
  // A change here goes up to the gist.
  await page.locator('#story-manager-root >> nav button', { hasText: 'Memory' }).click();
  await page.locator('#story-manager-root >> textarea').first().fill('Changed on this device.');
  await page.locator('#story-manager-root >> button.btn.primary', { hasText: 'Save' }).click();
  await waitFor(() => JSON.parse(gist.files['chat-' + newId + '.json'].content).pinned === 'Changed on this device.', 30000, 'change saved to the gist');
  check(true, 'changes made here are saved to the gist by themselves');
  // A second device opens the sync link: the token is saved and removed from the address bar.
  await page.evaluate(() => { const st = JSON.parse(localStorage.getItem('smx:settings')); st.githubToken = ''; localStorage.setItem('smx:settings', JSON.stringify(st)); });
  await page.goto('https://miniapps.ai/c/' + newId + '#smx-sync=gh-test-token');
  await page.reload(); // as when the link is opened on another device
  await waitFor(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('smx:settings')).githubToken)) === 'gh-test-token', 15000, 'token from the sync link');
  check(!(await page.evaluate(() => location.href)).includes('smx-sync'), 'opening the sync link sets up sync, and the token leaves the address bar');

  console.log('42b) "Recover lost facts" adds back facts an earlier saved version had');
  // An earlier version (as GitHub keeps it) where Mira had more facts.
  const g42 = Object.values(gists)[0];
  const old42 = JSON.parse(g42.files['chat-' + newId + '.json'].content);
  const mira42 = old42.entries.find((e) => e.name === 'Mira');
  mira42.text += '\n- Grew up in the river village of Elm.\n- We can add this to her entry.';
  const files42 = JSON.parse(JSON.stringify(g42.files));
  files42['chat-' + newId + '.json'] = { content: JSON.stringify(old42) };
  g42.history.unshift({ version: 'v0', at: Date.now() - 2 * 86400000, files: files42 });
  await page.reload();
  await page.waitForTimeout(800);
  await page.locator('#story-manager-root >> .fab').click();
  let asked42 = '';
  page.once('dialog', (d) => { asked42 = d.message(); d.accept(String((d.message().match(/(\d+)\) [^\n]*\n\nType/) || [])[1] || '')); });
  await page.getByText('Recover lost facts').click();
  await waitFor(async () => /Grew up in the river village of Elm/.test((await keyNow()).entries.find((e) => e.name === 'Mira').text), 30000, 'fact recovered');
  const mira42now = (await keyNow()).entries.find((e) => e.name === 'Mira').text;
  check(/Recover facts from which saved version/.test(asked42) && /### Recovered facts\n- Grew up in the river village of Elm\.$/.test(mira42now) && !/We can add/.test(mira42now),
    'the lost fact is back under "Recovered facts", without working-out');
  check((await keyNow()).jobs.some((j) => /Recovered 1 facts from the version saved on/.test(j.label)), 'recorded in Activity');
  await page.locator('#story-manager-root >> .x').click().catch(() => {});

  console.log('42c) "Compare bots" runs the same jobs on the first replies with each bot and makes one report');
  const mem42c = JSON.stringify((await keyNow()).entries) + (await keyNow()).memory;
  await page.locator('#story-manager-root >> .fab').click();
  await page.locator('#story-manager-root >> nav button', { hasText: 'Settings' }).click();
  await page.locator('#story-manager-root >> input[placeholder^="e.g. er-8"]').fill('good-bot, sloppy-bot');
  page.once('dialog', (d) => d.accept());
  await page.getByText('Start comparison').click();
  await waitFor(async () => !!(await page.evaluate((id) => localStorage.getItem('smx:comparison:' + id), newId)), 120000, 'comparison finished');
  const cmp = JSON.parse(await page.evaluate((id) => localStorage.getItem('smx:comparison:' + id), newId));
  const good = cmp.rows.find((r) => r.slug === 'good-bot');
  const sloppy = cmp.rows.find((r) => r.slug === 'sloppy-bot');
  const first3 = newConv.messages.filter((x) => x.origin === 'assistant').slice(0, 3);
  check(good.ok && sloppy.ok && good.summaries === 3 && sloppy.summaries === 3 && good.junk === 0 && sloppy.junk > 0, 'both bots did both jobs; the working-out of the sloppy one is counted');
  check(first3.every((m) => cmp.report.includes(m.elements[0].text.slice(0, 40))) && !cmp.report.includes(newConv.messages.filter((x) => x.origin === 'assistant').slice(-1)[0].elements[0].text.slice(0, 60)),
    'the FIRST replies were used, and they are in the report');
  check(/## Results[\s\S]*\| good-bot \| yes[\s\S]*\| sloppy-bot \| yes[\s\S]*## Bot: good-bot[\s\S]*### Summaries[\s\S]*### Story & characters[\s\S]*## Bot: sloppy-bot[\s\S]*We can add these to the entries[\s\S]*## Story Manager diagnostics\n\nStory Manager v/.test(cmp.report),
    'one report: results table, each bot\'s summaries, story & characters and working-out, and the diagnostics');
  check(JSON.stringify((await keyNow()).entries) + (await keyNow()).memory === mem42c, 'the real memory was not changed');
  check(!/### Summaries[\s\S]*My earlier message from when this note was pinned/.test(cmp.report.split('## Story Manager diagnostics')[0].split('## The replies tested')[1] || 'x'),
    'the pinned message\'s label is not shown to the keeper as something the user wrote');
  await page.locator('#story-manager-root >> nav button', { hasText: 'Settings' }).click();
  await waitFor(async () => (await page.locator('#story-manager-root >> button', { hasText: 'Download report' }).count()) > 0, 10000, 'results shown');
  const dl = page.waitForEvent('download', { timeout: 10000 });
  await page.getByText('Download report').click();
  check(/^story-manager-bot-comparison-\d{4}-\d\d-\d\d\.md$/.test((await dl).suggestedFilename()), 'the report downloads as one file');
  await page.locator('#story-manager-root >> .x').click().catch(() => {});

  console.log('43) Helper chats are hidden from MiniApps\' chat lists');
  const helperConvs = Object.keys(convs).filter((id) => convs[id].toolId === 'tool-helper');
  const listed = async () => page.evaluate(() => fetch('https://api.miniapps.ai/conversations/quickAccess?options=%7B%7D', { credentials: 'include' }).then((r) => r.json()));
  const shown = await listed();
  check(helperConvs.length > 1 && !shown.items.some((x) => helperConvs.includes(x.id)) && shown.items.some((x) => x.id === newId),
    'the ' + helperConvs.length + ' helper chats are left out; story chats are listed');
  check(shown.total === shown.items.length, 'the count matches');
  await page.reload();
  check(!(await listed()).items.some((x) => helperConvs.includes(x.id)), 'hidden right from the start of a page load');
  await page.evaluate(() => { const st = JSON.parse(localStorage.getItem('smx:settings')); st.hideHelpers = false; localStorage.setItem('smx:settings', JSON.stringify(st)); });
  await page.reload();
  await page.waitForTimeout(1500);
  check((await listed()).items.some((x) => helperConvs.includes(x.id)), 'shown again when the setting is off');

  console.log('44) The list of helper chats syncs too, so they are hidden on every device');
  await page.evaluate(() => { const st = JSON.parse(localStorage.getItem('smx:settings')); st.hideHelpers = true; st.githubToken = 'gh-test-token'; localStorage.setItem('smx:settings', JSON.stringify(st)); });
  await page.reload();
  await waitFor(() => { try { return helperConvs.every((h) => JSON.parse(gist.files['helpers.json'].content).includes(h)); } catch (e) { return false; } }, 30000, 'helper list in the gist');
  check(true, 'helper chats saved to the gist');
  // Another device made a helper chat: it gets hidden here too.
  convs['other-device-helper'] = { toolId: 'tool-helper', messages: [] };
  gist.files['helpers.json'] = { content: JSON.stringify(JSON.parse(gist.files['helpers.json'].content).concat('other-device-helper')) };
  await page.reload();
  await waitFor(async () => (await page.evaluate(() => localStorage.getItem('smx:hide') || '')).includes('other-device-helper'), 20000, 'helper from the other device');
  check(!(await listed()).items.some((x) => x.id === 'other-device-helper'), 'a helper chat from the other device is hidden here as well');

  console.log('45) Live "new chat" events for helper chats do not reach the site; opening one says what it is');
  await page.evaluate(() => window.wsLoad());
  await page.waitForTimeout(500);
  const helperId = helperConvs[0];
  liveWs.send('42["cu",' + JSON.stringify({ id: helperId, type: 'conversation', conversation: { id: helperId, title: 'helper' } }) + ']');
  liveWs.send('42["cu",' + JSON.stringify({ id: newId, type: 'conversation', conversation: { id: newId, title: 'Dragon Tale' } }) + ']');
  await page.waitForTimeout(800);
  const seen = await page.evaluate(() => window.cuSeen || []);
  check(seen.some((x) => x.includes(newId)) && !seen.some((x) => x.includes(helperId)), 'the site hears about story chats, not helper chats');
  // A brand-new helper chat is announced before Story Manager knows its id: the request id gives it away.
  const helperReq = chatBodies.filter((b) => b.toolId === 'tool-helper').pop().requestId;
  liveWs.send('42["crsu",' + JSON.stringify({ conversationId: 'brand-new-helper', requestId: helperReq, addedMessages: [] }) + ']');
  liveWs.send('42["crsu",' + JSON.stringify({ conversationId: newId, requestId: 'users-own-request', addedMessages: [] }) + ']');
  await page.waitForTimeout(800);
  const all = await page.evaluate(() => window.wsSeen || []);
  check(!all.some((x) => x.includes('brand-new-helper')) && all.some((x) => x.includes('users-own-request')), 'events of Story Manager\'s own requests are held back from the site, even before the chat is known');
  await page.goto('https://miniapps.ai/c/' + helperId);
  await page.waitForTimeout(1500);
  await page.locator('#story-manager-root >> .fab').click();
  const helperPanel = await page.locator('#story-manager-root >> .panel').innerText();
  check(/helper chats/.test(helperPanel) || /Open a chat/.test(helperPanel), 'opening a helper chat does not show it as a story');

  console.log('46) A new helper chat announced before its id is known is held back; pinned messages are never taken for the chat');
  await page.goto('https://miniapps.ai/c/' + newId);
  await page.evaluate(() => window.wsLoad());
  await page.waitForTimeout(500);
  // Story Manager starts creating a helper chat; the site announces it (and, meanwhile, a chat of the user's).
  await page.evaluate(() => { window.wsSeen = []; document.dispatchEvent(new CustomEvent('smx:hold')); });
  liveWs.send('42["cu",' + JSON.stringify({ id: 'fresh-helper', type: 'conversation', conversation: { id: 'fresh-helper' } }) + ']');
  liveWs.send('42["cu",' + JSON.stringify({ id: 'users-new-chat', type: 'conversation', conversation: { id: 'users-new-chat' } }) + ']');
  await page.waitForTimeout(300);
  check(!(await page.evaluate(() => window.wsSeen.join())).includes('users-new-chat'), 'new-chat announcements wait while a helper chat is being created');
  // The helper's id becomes known.
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('smx:hide', { detail: JSON.stringify(JSON.parse(localStorage.getItem('smx:hide')).concat('fresh-helper')) })));
  await page.waitForTimeout(300);
  const after46 = await page.evaluate(() => window.wsSeen.join());
  check(after46.includes('users-new-chat') && !after46.includes('fresh-helper'), 'then the user\'s chat is announced, the helper chat never');
  // A wrongly learned pinned-messages address is dropped.
  await page.evaluate(() => localStorage.setItem('smx:learned', JSON.stringify({ template: 'https://api.miniapps.ai/conversations/{id}/messages/pinned' })));
  await page.reload();
  await page.waitForTimeout(1500);
  check(!/pinned/.test(await page.evaluate(() => localStorage.getItem('smx:learned') || '')), 'a pinned-messages address is not used as the message list');

  console.log('47) A chat wrongly taken for a helper chat can be given back as a story');
  const mistaken = helperConvs[1];
  await page.goto('https://miniapps.ai/c/' + mistaken);
  await page.waitForTimeout(1500);
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('This is my story, not a helper chat').click();
  await page.waitForTimeout(1500);
  const hide47 = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:hide') || '[]'));
  check(!hide47.includes(mistaken) && !/helper chats\./.test(await page.locator('#story-manager-root >> .panel').innerText()), 'it is shown again and treated as a story');
  check(JSON.parse(gist.files['not-helpers.json'] ? gist.files['not-helpers.json'].content : '[]').includes(mistaken) ||
    (await page.waitForTimeout(10000), JSON.parse((gist.files['not-helpers.json'] || { content: '[]' }).content).includes(mistaken)), 'other devices are told too');

  console.log('48) The site cannot switch to a helper chat on its own; the user still can');
  await page.goto('https://miniapps.ai/c/' + newId);
  await page.waitForTimeout(3000);
  const where = () => page.evaluate(() => location.pathname);
  const someChat = '/c/' + require('crypto').randomUUID();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('smx:hold')));
  await page.evaluate((u) => history.pushState(null, '', u), someChat);
  check((await where()) === '/c/' + newId, 'no jump while a helper chat is being created');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('smx:hide', { detail: localStorage.getItem('smx:hide') })));
  const helperUrl = '/c/' + JSON.parse(await page.evaluate(() => localStorage.getItem('smx:hide'))).find((x) => /^[0-9a-f-]{36}$/.test(x));
  await page.evaluate((u) => history.pushState(null, '', u), helperUrl);
  check((await where()) === '/c/' + newId, 'no jump into a helper chat without a tap');
  await page.mouse.click(5, 5);
  await page.evaluate((u) => history.pushState(null, '', u), someChat);
  check((await where()) === someChat, 'a change right after the user taps goes through');

  console.log('49) No new helper chat is started with a bot the user writes stories with');
  // The story chat uses the same bot as the memory keeper, and no helper chat exists yet.
  await page.evaluate((id) => {
    const key = 'smx:chat:' + id;
    const c = JSON.parse(localStorage.getItem(key));
    c.tool = { toolId: 'tool-helper', revision: 1, modelId: 'm1' };
    localStorage.setItem(key, JSON.stringify(c));
    for (const k of ['smx:helperChat', 'smx:helperChat1', 'smx:helperChat2']) localStorage.removeItem(k);
    const st = JSON.parse(localStorage.getItem('smx:settings'));
    st.provider = 'miniapps';
    st.parallel = 1;
    st.holdBack = 0;
    localStorage.setItem('smx:settings', JSON.stringify(st));
  }, newId);
  await page.goto('https://miniapps.ai/c/' + newId);
  await page.waitForTimeout(1500);
  const newChatsBefore = chatBodies.filter((b) => b.toolId === 'tool-helper' && !b.conversationId).length;
  await page.locator('#story-manager-root >> .fab').click();
  await page.getByText('Update now').click({ timeout: 120000 });
  await waitFor(async () => /bot you write stories with/.test((await keyNow()).lastError || ''), 60000, 'refusal');
  check(chatBodies.filter((b) => b.toolId === 'tool-helper' && !b.conversationId).length === newChatsBefore, 'no new chat was asked for; the user is told to pick a different bot');

  console.log('50) A story wrongly listed as a helper chat still works when it is open');
  await page.evaluate((id) => {
    localStorage.setItem('smx:helperAll', JSON.stringify(JSON.parse(localStorage.getItem('smx:helperAll') || '[]').concat(id)));
    localStorage.setItem('smx:hide', JSON.stringify(JSON.parse(localStorage.getItem('smx:hide') || '[]').concat(id)));
  }, newId);
  await page.goto('https://miniapps.ai/c/' + newId);
  await page.waitForTimeout(3000);
  await page.evaluate((id) => history.replaceState({ app: 'state' }, '', '/c/' + id + '?view=1'), newId);
  check(/view=1/.test(await page.evaluate(() => location.search)), 'the site can still change the address of the open chat');
  check((await listed()).items.some((x) => x.id === newId), 'the open chat stays in the site\'s chat list');

  await browser.close();
  console.log('\nAll checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
