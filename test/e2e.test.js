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
    ws.onmessage = (ev) => { if (String(ev.data).startsWith('431')) res(); };
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
  load();
</script></body></html>`;

function uuid() { return require('crypto').randomUUID(); }

async function main() {
  const convs = {};          // id -> { toolId, messages: [] }
  let altApi = false;        // when true, /conversations/{id} has no messages (like a paged real API)
  const chatBodies = [];     // every POST /chat body the "server" received
  const llmCalls = [];       // prompts the memory keeper received

  let liveWs = null;
  let helperBroken = false;  // makes the MiniApps-bot memory keeper fail
  let helperDelay = 500;
  let helperRunaway = false;   // the bot writes a good start, then repeats itself forever
  let helperChatError = false; // the existing helper chat answers with a "ce" error event     // how long the MiniApps-bot memory keeper takes to answer
  const aborts = [];         // POST /chat/abort bodies         // the page's fake Socket.IO connection, once open
  function reply(conv, text, delay, convId) {
    const msg = { id: uuid(), origin: 'assistant', createdAt: new Date().toISOString(), elements: [{ type: 'text', text: '- **' }] };
    // Like the real bot, a slow answer shows up half-written in the chat
    // while it is still being streamed in small "pcm" pieces.
    if (delay >= 10000) conv.messages.push(msg);
    const tmpId = uuid();
    let i = 0;
    const typing = setInterval(() => {
      if (liveWs) liveWs.send('42["pcm",' + JSON.stringify({ cId: convId, requestId: 'r', tmpId, tmpO: 0, payload: { type: 'text', text: i % 2 ? '- **' : ' ', i: i++ } }) + ']');
    }, Math.min(1000, delay / 3));
    setTimeout(() => {
      clearInterval(typing);
      msg.elements = [{ type: 'text', text }];
      if (!conv.messages.includes(msg)) conv.messages.push(msg);
      // Like the real site, finished replies are also pushed over the live connection.
      // Same shape as the real site's "cm" event: { cId, requestId, tmpId, payload: message }.
      if (liveWs) liveWs.send('42["cm",' + JSON.stringify({ cId: convId, requestId: 'r', tmpId, payload: msg }) + ']');
    }, delay);
  }

  // Answers like a real memory keeper: the memory, then one entry per [R#] reply.
  function keeperAnswer(input, n, tag) {
    let replies = [...input.matchAll(/\[R(\d+)[^\]\n]*\]/g)].map((r) => r[1]);
    const log = () => replies.map((r) => '[R' + r + '] Detailed summary of reply ' + r + ' in update ' + n + '.').join('\n');
    if (/LOG ENTRIES ONLY/.test(input)) return log();
    const asked = input.match(/who have none yet: ([^.]+)\./);
    if (/ENTRIES ONLY/.test(input) && asked) {
      return asked[1].split(',').map((name) => '=== ENTRY: ' + name.trim() + ' | character ===\n- ' + name.trim() + ' is a member of the group.').join('\n');
    }
    // WINTERTEST in the chat: the keeper names Winter in the cast but forgets her entry.
    const cast = 'Mira, Ash' + (/WINTERTEST/.test(input) ? ', Winter, Giselle' : '');
    // DROPLAST in the chat simulates a keeper that runs out of room.
    if (/DROPLAST/.test(input)) replies = replies.slice(0, -1);
    // Like the real keeper: only changed story sections (new events added),
    // all of them for an empty story; a very long story (the shrink test)
    // gets the older complete-STORY answer.
    const storyLen = Number((input.match(/CURRENT STORY \((\d+) characters\)/) || [])[1] || 0);
    const story = storyLen > 1500
      ? '=== STORY ===\n## Story So Far\n- update ' + n + tag + '\n## Current Scene\n- Mira and Ash rest by the river.\n'
      : '=== SECTION: Story So Far' + (storyLen ? ' | add' : '') + ' ===\n- update ' + n + tag + '\n' +
        '=== SECTION: Current Scene ===\n- Mira and Ash rest by the river.\n';
    return story +
      '=== CAST ===\n' + cast + '\n' +
      '=== ENTRY: Mira | character | aliases: Miri, the healer ===\n- Mira: a healer' + tag + ' (update ' + n + ')\n' +
      '=== ENTRY: Ash | character | aliases: the dragon ===\n- Ash: a dragon\n' +
      '=== ENTRY: Old Mill | place | aliases: the mill, old mill ===\n- An abandoned mill where they once hid from hunters.\n' +
      '=== LOG ===\n' + log();
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
    if (url.pathname.startsWith('/tools/s/')) return json({ id: 'tool-helper', revision: 1, modelId: 'm-helper' });
    let m;
    if (req.method() === 'GET' && (m = url.pathname.match(/^\/conversations\/([^/]+)$/))) {
      const c = convs[m[1]];
      if (!c) return json({ message: 'nope' }, 404);
      const title = c.toolId === 'tool-story' ? 'Dragon Tale' : 'helper';
      return json(altApi ? { id: m[1], title } : { id: m[1], title, messages: c.messages });
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
      const items = c.messages.slice(start, end).map((x, i) => Object.assign({ conversationId: m[1], index: start + i }, x));
      const hasMore = end - limit > 0;
      return json({ items, hasMore, nextBeforeMessageId: hasMore ? items[0].id : null });
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
      if (body.toolId === 'tool-helper' && helperBroken) return json({ message: 'Insufficient credits' }, 412);
      const id = body.conversationId || uuid();
      const isNew = !convs[id];
      const conv = convs[id] || (convs[id] = { toolId: body.toolId, messages: [] });
      const text = body.elements[0].text;
      const added = [];
      // Like the real bot: a new helper chat starts with a greeting.
      if (isNew && body.toolId === 'tool-helper') {
        const greet = { id: uuid(), origin: 'assistant', createdAt: new Date().toISOString(), elements: [{ type: 'text', text: 'Hi! Tell me what to write.' }] };
        conv.messages.push(greet);
        added.push(greet);
      }
      // Long requests to the helper are stored as a file, so their text can't be read back.
      const userMsg = body.toolId === 'tool-helper'
        ? { id: uuid(), origin: 'user', createdAt: new Date().toISOString(), text: '', elements: [{ type: 'file', name: 'message.txt' }] }
        : { id: uuid(), origin: 'user', createdAt: new Date().toISOString(), elements: [{ type: 'text', text }] };
      conv.messages.push(userMsg);
      added.push(userMsg);
      if (body.toolId === 'tool-helper' && helperRunaway) {
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
      } else if (body.toolId === 'tool-helper' && helperChatError && !isNew) {
        setTimeout(() => liveWs && liveWs.send('42["ce",' + JSON.stringify({ conversationId: id, requestId: body.requestId, messageId: userMsg.id, replyToMessageId: null, error: 'Context too long', code: 'CONTEXT_LIMIT' }) + ']'), 300);
      } else if (body.toolId === 'tool-helper') {
        llmCalls.push(text);
        reply(conv, keeperAnswer(text, llmCalls.length, ' (via MiniApps bot)'), helperDelay, id);
      } else {
        const n = conv.messages.filter((x) => x.origin === 'user').length;
        reply(conv, 'Story reply #' + n + ': the dragon Ash watches Mira.', 1500, id);
      }
      return json({ conversationId: id, chatMessageId: userMsg.id, requestId: body.requestId,
        addedMessages: added.map((x) => Object.assign({ index: conv.messages.indexOf(x) }, x)) });
    }
    return json({});
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

  const settings = { provider: 'openai', apiKey: 'test-key', baseUrl: 'https://mock-llm.test/v1', model: 'mock', updateEvery: 2, injectEvery: 1 };
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
    throw new Error('Timed out waiting for ' + what);
  };

  console.log('1) New chat, first message carries no memory');
  await page.evaluate(() => window.sendMsg('I am Mira, a healer.'));
  check(!chatBodies[0].elements[0].text.includes('[[STORY-MEMORY]]'), 'first message sent unchanged');
  const convId = Object.keys(convs)[0];

  console.log('2) After 2 AI replies the memory keeper runs automatically');
  await waitFor(() => convs[convId].messages.length === 2, 5000, 'reply 1');
  await page.evaluate(() => window.sendMsg('I meet a dragon called Ash.'));
  await waitFor(() => llmCalls.length >= 1, 30000, 'memory update');
  check(/I am Mira, a healer\./.test(llmCalls[0]) && /Story reply #2/.test(llmCalls[0]), 'memory keeper got both exchanges');
  const mem = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1])));
  check(mem && /update 1/.test(mem.memory), 'story saved for this chat');
  check(mem.entries.map((e) => e.name).join() === 'Mira,Ash,Old Mill' && mem.entries[0].aliases.includes('Miri'), 'separate entries for characters and places, with aliases');
  check(mem.title === 'Dragon Tale', 'chat title picked up');
  check(!/===/.test(mem.memory) && !mem.entries.some((e) => /===/.test(e.text)), 'answer split into story, entries and log');
  check(mem.log.length === 2 && /reply 1 in update 1/.test(mem.log[0].text) && /reply 2 in update 1/.test(mem.log[1].text), 'one detailed log entry per AI reply');

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
  await waitFor(() => llmCalls.length >= 2, 30000, 'second memory update');
  check(!llmCalls[1].includes('Background notes for story continuity') && /What do I do next\?/.test(llmCalls[1]), 'no memory echo, only new messages');
  check(!/I am Mira, a healer\./.test(llmCalls[1]), 'already-processed messages are not resent');
  await page.waitForTimeout(1000);
  const mem2 = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1])).memory);
  check(/## Story So Far\n- update 1\n- update 2\n\n## Current Scene\n- Mira and Ash rest by the river\.$/.test(mem2), 'only changed story sections written: new events added, old ones kept');

  console.log('5) Panel opens and shows the memory');
  await page.locator('#story-manager-root >> .fab').click();
  const panelText = await page.locator('#story-manager-root >> .panel').innerText();
  check(/Dragon Tale/.test(panelText), 'panel shows the current chat');
  const memBox = await page.locator('#story-manager-root >> textarea.mem').inputValue();
  check(/update 2/.test(memBox), 'panel shows latest memory');

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
  check(/We reach a river\./.test(llmCalls[llmCalls.length - 1]), 'rebuild read the whole chat');

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
    const stopShown = () => page.locator('#story-manager-root >> button', { hasText: 'Stop' }).count();
    do { n = llmCalls.length; await page.waitForTimeout(3000); } while (llmCalls.length !== n || await stopShown());
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
  check(/\[R1, entry about \d+ characters\] STORY AI/.test(withRecap), 'story replies numbered for the log');
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
  await waitFor(() => llmCalls.slice(beforeLong).some((c) => /LOG ENTRIES ONLY/.test(c)), 30000, 'follow-up for the missing entry');
  await page.waitForTimeout(1500);
  const longCalls = llmCalls.slice(beforeLong).join('\n');
  check(/LONGEND/.test(longCalls) && longText.length > 12000, 'a ' + longText.length + '-character message reached the memory keeper whole');
  const replyIds = recapConv.messages.filter((x) => x.origin === 'assistant').map((x) => x.id);
  const longChat = await page.evaluate(() => JSON.parse(localStorage.getItem('smx:chat:' + location.pathname.split('/c/')[1])));
  check(replyIds.every((rid) => longChat.log.some((e) => e.id === rid)), 'every AI reply has a log entry (' + replyIds.length + '), including the one first left out');
  check(longChat.log.map((e) => e.id).join() === replyIds.join(), 'log entries are in story order');
  check(/\[R1, entry about 700 characters\]/.test(longCalls), 'each reply labelled with its target entry length');

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
  await page.getByText('Update now').click();
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
  await page.getByText('Update now').click();
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
  await page.getByText('Update now').click();
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
  await page.getByText('Update now').click();
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
  page.once('dialog', (d) => d.accept());
  await page.locator('#story-manager-root >> .fab').click();
  await page.locator('#story-manager-root >> button', { hasText: 'Update now' }).click();
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

  console.log('29) A bot answer stuck repeating itself is cut off and used');
  await page.locator('#story-manager-root >> .x').click();
  helperRunaway = true;
  const abortsBefore = aborts.length;
  const beforeLoop = await keyNow();
  await page.evaluate(() => window.sendMsg('We climb the stairs.'));
  await page.evaluate(() => window.sendMsg('We open the door.'));
  await waitFor(async () => { const c = await keyNow(); return c.lastUpdate !== beforeLoop.lastUpdate || c.lastError !== beforeLoop.lastError; }, 120000, 'update with a looping answer');
  helperRunaway = false;
  const afterLoop = await keyNow();
  check(aborts.length > abortsBefore, 'MiniApps asked to stop the looping answer');
  check(!afterLoop.lastError && /via MiniApps bot/.test(afterLoop.memory) && !/over and over/.test(JSON.stringify(afterLoop)), 'the good part of the answer was used, without the repetition' + (afterLoop.lastError ? ' (got: ' + afterLoop.lastError + ')' : ''));

  await browser.close();
  console.log('\nAll checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
