'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp, escapeHtml } = require('../src/server');
const { validateLine } = require('../src/validate');
const { verifyWebhook, formEncode } = require('../src/stripe');

const WEBHOOK_SECRET = 'whsec_test';

function sign(body, secret = WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buckline-')), 'line.json');
}

async function listen(app) {
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${app.server.address().port}`;
}

async function close(app) {
  app.server.closeSse();
  await new Promise((r) => app.server.close(r));
}

// ---------- unit ----------

test('validateLine trims, collapses whitespace and strips invisible characters', () => {
  const r = validateLine('  hi​   there\n ', { maxLength: 80 });
  assert.deepEqual(r, { ok: true, text: 'hi there' });
});

test('validateLine rejects empty, too long and blocked text', () => {
  assert.equal(validateLine('   ', { maxLength: 80 }).ok, false);
  assert.equal(validateLine('x'.repeat(81), { maxLength: 80 }).ok, false);
  assert.equal(validateLine('😀'.repeat(80), { maxLength: 80 }).ok, true, 'emoji count as one char');
  assert.equal(validateLine('Buy SPAM now', { maxLength: 80, blockedWords: ['spam'] }).ok, false);
  assert.equal(validateLine(42, { maxLength: 80 }).ok, false);
});

test('escapeHtml escapes markup', () => {
  assert.equal(escapeHtml(`<script>"x"&'y'</script>`), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;');
});

test('verifyWebhook accepts valid and rejects bad or stale signatures', () => {
  const body = '{"a":1}';
  assert.equal(verifyWebhook(body, sign(body), WEBHOOK_SECRET), true);
  assert.equal(verifyWebhook(body, sign(body, 'other'), WEBHOOK_SECRET), false);
  assert.equal(verifyWebhook('{"a":2}', sign(body), WEBHOOK_SECRET), false);
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(verifyWebhook(body, sign(body, WEBHOOK_SECRET, old), WEBHOOK_SECRET), false);
  assert.equal(verifyWebhook(body, undefined, WEBHOOK_SECRET), false);
});

test('formEncode produces Stripe-style nested keys', () => {
  const s = formEncode({ a: 1, b: { c: 'x' }, d: [{ e: 2 }] }).toString();
  assert.equal(decodeURIComponent(s), 'a=1&b[c]=x&d[0][e]=2');
});

// ---------- demo mode ----------

test('demo mode: checkout applies the line immediately and persists it', async () => {
  const file = tmpFile();
  const app = createApp({ dataFile: file, demoMode: true, stripeSecretKey: '' });
  const base = await listen(app);
  try {
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Hello, internet\./);

    const res = await fetch(base + '/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '<b>Mine now</b>' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).demo, true);

    const line = await (await fetch(base + '/api/line')).json();
    assert.equal(line.text, '<b>Mine now</b>');
    assert.equal(line.changes, 1);

    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('&lt;b&gt;Mine now&lt;/b&gt;'), 'server-rendered text is escaped');
    assert.ok(!html.includes('<b>Mine now</b>'));

    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).text, '<b>Mine now</b>');
  } finally {
    await close(app);
  }
});

test('checkout rejects invalid text and enforces the rate limit', async () => {
  const app = createApp({ dataFile: tmpFile(), demoMode: true, checkoutRateLimit: 2 });
  const base = await listen(app);
  try {
    const post = (text) =>
      fetch(base + '/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    assert.equal((await post('')).status, 400);
    assert.equal((await post('ok')).status, 200);
    assert.equal((await post('again')).status, 429);
  } finally {
    await close(app);
  }
});

// ---------- Stripe mode ----------

let stripeApp;
let stripeBase;
const sessionsCreated = [];

before(async () => {
  stripeApp = createApp({
    dataFile: tmpFile(),
    demoMode: false,
    stripeSecretKey: 'sk_test_x',
    stripeWebhookSecret: WEBHOOK_SECRET,
    createCheckoutSession: async (args) => {
      sessionsCreated.push(args);
      return { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' };
    },
  });
  stripeBase = await listen(stripeApp);
});

after(async () => close(stripeApp));

test('stripe mode: checkout returns a Stripe URL without changing the line', async () => {
  const res = await fetch(stripeBase + '/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Paid line' }),
  });
  assert.equal(res.status, 200);
  assert.match((await res.json()).url, /^https:\/\/checkout\.stripe\.com/);
  assert.equal(sessionsCreated.at(-1).text, 'Paid line');
  assert.equal(sessionsCreated.at(-1).priceCents, 100);
  assert.equal(stripeApp.store.get().text, 'Hello, internet.');
});

test('stripe mode: signed webhook applies the line once, unsigned is rejected', async () => {
  const event = {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_1', payment_status: 'paid', metadata: { buckline_text: 'Paid line' } } },
  };
  const body = JSON.stringify(event);

  const bad = await fetch(stripeBase + '/api/stripe/webhook', { method: 'POST', body });
  assert.equal(bad.status, 400);
  assert.equal(stripeApp.store.get().text, 'Hello, internet.');

  for (let i = 0; i < 2; i++) {
    const ok = await fetch(stripeBase + '/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Stripe-Signature': sign(body) },
      body,
    });
    assert.equal(ok.status, 200);
  }
  const state = stripeApp.store.get();
  assert.equal(state.text, 'Paid line');
  assert.equal(state.changes, 1, 'duplicate webhook delivery is ignored');
});

test('stripe mode: unpaid sessions do not change the line', async () => {
  const body = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_2', payment_status: 'unpaid', metadata: { buckline_text: 'Nope' } } },
  });
  await fetch(stripeBase + '/api/stripe/webhook', {
    method: 'POST',
    headers: { 'Stripe-Signature': sign(body) },
    body,
  });
  assert.notEqual(stripeApp.store.get().text, 'Nope');
});

test('static files are served and path traversal is blocked', async () => {
  const css = await fetch(stripeBase + '/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.equal(css.headers.get('cache-control'), 'no-cache');
  const v = await fetch(stripeBase + '/styles.css?v=abc');
  assert.match(v.headers.get('cache-control'), /immutable/);
  const trav = await fetch(stripeBase + '/..%2fpackage.json');
  assert.equal(trav.status, 404);
  const raw = await fetch(stripeBase + '/index.html');
  assert.equal(raw.status, 404, 'unrendered template is not exposed');
});

test('SSE stream sends the current line', async () => {
  const ctrl = new AbortController();
  const res = await fetch(stripeBase + '/api/events', { signal: ctrl.signal });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const chunk = new TextDecoder().decode(value);
  assert.match(chunk, /event: line/);
  assert.match(chunk, /"text":/);
  ctrl.abort();
});

// ---------- admin panel ----------

test('stripe mode: paid webhook is recorded once in the transaction log', () => {
  const paid = stripeApp.transactions.all().filter((t) => t.id === 'cs_test_1');
  assert.equal(paid.length, 1);
  assert.equal(paid[0].status, 'paid');
  assert.equal(paid[0].text, 'Paid line');
  assert.equal(stripeApp.transactions.all().some((t) => t.id === 'cs_test_2'), false, 'unpaid not logged');
});

test('admin panel is disabled without ADMIN_PASSWORD', async () => {
  const res = await fetch(stripeBase + '/adminpanel');
  assert.equal(res.status, 404);
});

test('admin panel requires login and shows transactions', async () => {
  const app = createApp({
    dataFile: tmpFile(),
    demoMode: true,
    adminUser: 'boss',
    adminPassword: 's3cret',
  });
  const base = await listen(app);
  try {
    await fetch(base + '/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Admin <b>visible</b>' }),
    });

    const anon = await (await fetch(base + '/adminpanel')).text();
    assert.match(anon, /name="password"/);
    assert.doesNotMatch(anon, /Admin/);

    const login = (password) =>
      fetch(base + '/adminpanel/login', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ login: 'boss', password }),
      });

    const bad = await login('wrong');
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get('set-cookie'), null);

    const ok = await login('s3cret');
    assert.equal(ok.status, 303);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.match(ok.headers.get('set-cookie'), /HttpOnly/);

    const page = await fetch(base + '/adminpanel', { headers: { Cookie: cookie } });
    const html = await page.text();
    assert.match(html, /<table/);
    assert.match(html, /Admin &lt;b&gt;visible&lt;\/b&gt;/, 'text is escaped');

    const forged = await (await fetch(base + '/adminpanel', { headers: { Cookie: 'bl_admin=9999999999999.x' } })).text();
    assert.doesNotMatch(forged, /<table/);
  } finally {
    await close(app);
  }
});

test('admin can set the line; anonymous cannot', async () => {
  const app = createApp({ dataFile: tmpFile(), demoMode: false, stripeSecretKey: 'sk_test_x', adminPassword: 'pw' });
  const base = await listen(app);
  try {
    const post = (path, body, cookie) =>
      fetch(base + path, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie && { Cookie: cookie }) },
        body: new URLSearchParams(body),
      });

    const anon = await post('/adminpanel/line', { text: 'Hijack' });
    assert.equal(anon.status, 303);
    assert.notEqual(app.store.get().text, 'Hijack');

    const cookie = (await post('/adminpanel/login', { login: 'admin', password: 'pw' })).headers
      .get('set-cookie')
      .split(';')[0];

    const tooLong = await post('/adminpanel/line', { text: 'x'.repeat(200) }, cookie);
    assert.equal(tooLong.status, 400);

    const ok = await post('/adminpanel/line', { text: '  Set by admin  ' }, cookie);
    assert.equal(ok.status, 303);
    assert.equal(app.store.get().text, 'Set by admin');
    assert.equal(app.transactions.all()[0].status, 'admin');

    const page = await (await fetch(base + '/adminpanel?updated=1', { headers: { Cookie: cookie } })).text();
    assert.match(page, /Line updated\./);
    assert.match(page, /class="current">Set by admin</);
  } finally {
    await close(app);
  }
});

test('every new line gets a permanent link page', async () => {
  const app = createApp({ dataFile: tmpFile(), demoMode: true });
  const base = await listen(app);
  try {
    const pay = async (text) =>
      (await fetch(base + '/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })).json();

    const first = await pay('First <line>');
    assert.match(first.link, /^\/l\/[A-Za-z0-9_-]{8}$/);
    const second = await pay('Second line');
    assert.notEqual(first.link, second.link);

    const old = await fetch(base + first.link);
    assert.equal(old.status, 200);
    const oldHtml = await old.text();
    assert.match(oldHtml, /First &lt;line&gt;/);
    assert.match(oldHtml, /lasted .* before someone paid/);

    const cur = await (await fetch(base + second.link)).text();
    assert.match(cur, /<\/time><\/p>/, "no status after the date");
    assert.match(cur, /— \$1 <span/);
    assert.match(cur, /just now/);

    const home = await (await fetch(base + '/')).text();
    assert.ok(home.includes(`href="${second.link}"`), 'home links the current line');
    assert.equal((await (await fetch(base + '/api/line')).json()).slug, second.link.slice(3));

    assert.equal((await fetch(base + '/l/doesnotexist')).status, 404);
  } finally {
    await close(app);
  }
});

test('admin can switch between demo and live mode, and it persists', async () => {
  const dataFile = tmpFile();
  const opts = { dataFile, stripeSecretKey: 'sk_test_x', adminPassword: 'pw',
    createCheckoutSession: async () => ({ url: 'https://checkout.stripe.com/x' }) };
  const app = createApp(opts);
  const base = await listen(app);
  const post = (p, body, cookie) =>
    fetch(base + p, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie && { Cookie: cookie }) },
      body: new URLSearchParams(body),
    });
  const checkout = async () =>
    (await fetch(base + '/api/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Mode test' }),
    })).json();
  try {
    assert.match((await checkout()).url, /stripe/);

    assert.equal((await post('/adminpanel/mode', { mode: 'demo' })).status, 303);
    assert.equal(app.config.demoMode, false, 'anonymous cannot switch');

    const cookie = (await post('/adminpanel/login', { login: 'admin', password: 'pw' })).headers
      .get('set-cookie').split(';')[0];
    await post('/adminpanel/mode', { mode: 'demo' }, cookie);
    assert.equal(app.config.demoMode, true);
    assert.equal((await checkout()).demo, true);

    const page = await (await fetch(base + '/adminpanel', { headers: { Cookie: cookie } })).text();
    assert.match(page, /Switch to live mode/);
    assert.match(page, /<th>Link<\/th>/);
    assert.match(page, /href="\/l\/[A-Za-z0-9_-]{8}"/);
  } finally {
    await close(app);
  }

  const restarted = createApp(opts);
  assert.equal(restarted.config.demoMode, true, 'mode survives restart');
});
