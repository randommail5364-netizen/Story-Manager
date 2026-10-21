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
  async function load() {
    if (!conv) return;
    if (localStorage.getItem('altApi')) {
      // Like a site that loads messages from a separate, paged endpoint.
      const opts = encodeURIComponent(JSON.stringify({ page: 1, itemsPerPage: 4 }));
      const r = await xhr('GET', 'https://api.miniapps.ai/chat-messages/' + conv + '?options=' + opts);
      document.getElementById('log').textContent = r.items.map(m => m.origin + ': ' + m.elements[0].text).join('\\n');
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

  function reply(conv, text, delay) {
    setTimeout(() => {
      conv.messages.push({ id: uuid(), origin: 'assistant', createdAt: new Date().toISOString(), elements: [{ type: 'text', text }] });
    }, delay);
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
    if (req.method() === 'GET' && (m = url.pathname.match(/^\/conversations\/(.+)$/))) {
      const c = convs[m[1]];
      if (!c) return json({ message: 'nope' }, 404);
      const title = c.toolId === 'tool-story' ? 'Dragon Tale' : 'helper';
      return json(altApi ? { id: m[1], title } : { id: m[1], title, messages: c.messages });
    }
    if (req.method() === 'GET' && (m = url.pathname.match(/^\/chat-messages\/(.+)$/))) {
      const c = convs[m[1]];
      const o = JSON.parse(url.searchParams.get('options'));
      // Newest first, like most chat APIs; the script must page back and re-sort.
      const all = [...c.messages].reverse();
      return json({ total: all.length, items: all.slice((o.page - 1) * o.itemsPerPage, o.page * o.itemsPerPage) });
    }
    if (req.method() === 'POST' && url.pathname === '/chat') {
      const body = JSON.parse(req.postData());
      if (req.headers()['x-csrf-token'] !== 'csrf-123') return json({ message: 'csrf' }, 403);
      chatBodies.push(body);
      const id = body.conversationId || uuid();
      const conv = convs[id] || (convs[id] = { toolId: body.toolId, messages: [] });
      const text = body.elements[0].text;
      conv.messages.push({ id: uuid(), origin: 'user', createdAt: new Date().toISOString(), elements: [{ type: 'text', text }] });
      if (body.toolId === 'tool-helper') {
        llmCalls.push(text);
        reply(conv, '## Characters\n- Mira: healer (via MiniApps bot)', 500);
      } else {
        const n = conv.messages.filter((x) => x.origin === 'user').length;
        reply(conv, 'Story reply #' + n + ': the dragon Ash watches Mira.', 1500);
      }
      return json({ conversationId: id, chatMessageId: uuid(), requestId: body.requestId });
    }
    return json({});
  });

  // Fake OpenAI-compatible memory keeper.
  await ctx.route('https://mock-llm.test/**', async (route) => {
    const body = JSON.parse(route.request().postData());
    llmCalls.push(body.messages[1].content);
    const n = llmCalls.length;
    await route.fulfill({
      status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ choices: [{ message: { content: '## Characters\n- Mira: a healer\n- Ash: a dragon\n## Story So Far\n- update ' + n } }] }),
    });
  });

  const settings = { provider: 'openai', apiKey: 'test-key', baseUrl: 'https://mock-llm.test/v1', model: 'mock', updateEvery: 2, injectEvery: 1 };
  await ctx.addInitScript((s) => { if (!localStorage.getItem('smx:settings')) localStorage.setItem('smx:settings', JSON.stringify(s)); }, settings);
  await ctx.addInitScript({ content: SCRIPT });

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
  check(mem && /Ash: a dragon/.test(mem.memory), 'memory saved for this chat');
  check(mem.title === 'Dragon Tale', 'chat title picked up');

  console.log('3) Next message has the memory attached');
  await page.evaluate(() => window.sendMsg('What do I do next?'));
  const sent = chatBodies[chatBodies.length - 1].elements[0].text;
  check(sent.startsWith('[[STORY-MEMORY]]') && /Ash: a dragon/.test(sent) && sent.endsWith('What do I do next?'), 'memory block prepended to user message');

  console.log('4) The memory block is stripped before the keeper sees history again');
  await waitFor(() => convs[convId].messages.length === 6, 5000, 'reply 3');
  await page.evaluate(() => window.sendMsg('I bandage Ash.'));
  await waitFor(() => llmCalls.length >= 2, 30000, 'second memory update');
  check(!llmCalls[1].includes('Background notes for story continuity') && /What do I do next\?/.test(llmCalls[1]), 'no memory echo, only new messages');
  check(!/I am Mira, a healer\./.test(llmCalls[1]), 'already-processed messages are not resent');

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

  console.log('9) Site loads messages from another, paged endpoint (learned automatically)');
  altApi = true;
  await page.evaluate(() => localStorage.setItem('altApi', '1'));
  await page.reload();
  await page.waitForTimeout(500);
  const learnedTpl = await page.evaluate(() => localStorage.getItem('smx:learned'));
  check(/chat-messages\/\{id\}\?options=/.test(learnedTpl || ''), 'message address learned from the site');
  const beforeRebuild = llmCalls.length;
  await page.locator('#story-manager-root >> .fab').click();
  page.once('dialog', (d) => d.accept());
  await page.getByText('Rebuild from whole chat').click();
  await waitFor(() => llmCalls.length > beforeRebuild, 30000, 'rebuild via learned endpoint');
  const rebuiltFrom = llmCalls.slice(beforeRebuild).join('\n');
  check(/I am Mira, a healer\./.test(rebuiltFrom) && /Fetch path check/.test(rebuiltFrom), 'all pages read (oldest and newest messages)');
  check(rebuiltFrom.indexOf('I am Mira, a healer.') < rebuiltFrom.indexOf('Fetch path check'), 'messages put back in order');

  console.log('10) Diagnostics shows what was seen, without message text');
  await page.getByText('Diagnostics', { exact: true }).click();
  const diag = await page.locator('#story-manager-root >> textarea[readonly]').inputValue();
  check(/chat-messages\/\{id\}/.test(diag) && /Learned message address/.test(diag), 'diagnostics list requests');
  check(!/I am Mira/.test(diag), 'diagnostics contain no story text');

  await browser.close();
  console.log('\nAll checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
