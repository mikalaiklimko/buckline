'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const defaultConfig = require('./config');
const { LineStore } = require('./store');
const { validateLine } = require('./validate');
const stripe = require('./stripe');
const { TransactionLog } = require('./transactions');
const admin = require('./admin');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

/** Content hash of a public file, used as ?v= so browsers fetch updates right away. */
function assetVersion(file) {
  try {
    return require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, file))).digest('hex').slice(0, 10);
  } catch {
    return '0';
  }
}
const ASSET = {
  css: `/styles.css?v=${assetVersion('styles.css')}`,
  js: `/app.js?v=${assetVersion('app.js')}`,
  admin: `/admin.css?v=${assetVersion('admin.css')}`,
};

/** "3 minutes ago", "2 days ago". */
function timeAgo(from, now = Date.now()) {
  const sec = Math.max(0, Math.round((now - from) / 1000));
  if (sec < 45) return 'just now';
  return `${duration(sec * 1000)} ago`;
}

/** "5 minutes", "2 hours", "3 days". */
function duration(ms) {
  const sec = Math.max(1, Math.round(ms / 1000));
  const units = [
    ['year', 365 * 86400],
    ['month', 30 * 86400],
    ['week', 7 * 86400],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  for (const [name, size] of units) {
    if (sec >= size || name === 'second') {
      const n = Math.round(sec / size);
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return '';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Fixed-window per-key rate limiter. */
function rateLimiter(limit, windowMs = 60_000) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  timer.unref();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

function createApp(overrides = {}) {
  const config = { ...defaultConfig, ...overrides };
  config.demoMode = overrides.demoMode ?? !config.stripeSecretKey;

  // Runtime settings changed from the admin panel (currently: demo mode on/off).
  const settingsFile =
    overrides.settingsFile || path.join(path.dirname(config.dataFile), 'settings.json');
  if (overrides.demoMode === undefined) {
    try {
      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (typeof saved.demoMode === 'boolean') config.demoMode = saved.demoMode || !config.stripeSecretKey;
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[settings] could not read ${settingsFile}:`, err.message);
    }
  }

  /** Switches demo mode; live mode needs a Stripe key. Returns an error message or null. */
  function setDemoMode(demo) {
    if (!demo && !config.stripeSecretKey) return 'Live mode needs STRIPE_SECRET_KEY in .env.';
    config.demoMode = demo;
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const tmp = `${settingsFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ demoMode: demo }, null, 2));
    fs.renameSync(tmp, settingsFile);
    console.log(`[admin] switched to ${demo ? 'demo' : 'live'} mode`);
    return null;
  }
  const store = overrides.store || new LineStore(config.dataFile, config.initialText);
  const transactions =
    overrides.transactions ||
    new TransactionLog(
      overrides.transactionsFile ||
        (overrides.dataFile ? path.join(path.dirname(config.dataFile), 'transactions.jsonl') : config.transactionsFile),
    );
  const sessions = admin.createSessions();
  const allowLogin = rateLimiter(5);
  const allowCheckout = rateLimiter(config.checkoutRateLimit);
  const createSession = overrides.createCheckoutSession || stripe.createCheckoutSession;
  const sseClients = new Set();

  const indexTemplate = fs
    .readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('href="/styles.css"', `href="${ASSET.css}"`)
    .replace('src="/app.js"', `src="${ASSET.js}"`);

  store.on('change', (state) => {
    const payload = `event: line\ndata: ${JSON.stringify(publicState(state))}\n\n`;
    for (const client of sseClients) client.write(payload);
  });

  function publicState(state = store.get()) {
    return { text: state.text, updatedAt: state.updatedAt, changes: state.changes, slug: state.slug };
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return String(fwd).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function formatPrice() {
    return (config.priceCents / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: config.currency.toUpperCase(),
      minimumFractionDigits: config.priceCents % 100 === 0 ? 0 : 2,
    });
  }

  function renderIndex() {
    const { text } = store.get();
    return indexTemplate
      .replaceAll('{{TEXT}}', escapeHtml(text))
      .replaceAll('{{PRICE}}', escapeHtml(formatPrice()))
      .replaceAll('{{MAX_LENGTH}}', String(config.maxLength))
      .replaceAll('{{DEMO}}', config.demoMode ? 'true' : 'false');
  }

  function serveStatic(req, res, pathname) {
    const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) || pathname.endsWith('index.html')) {
      return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    }
    fs.readFile(filePath, (err, data) => {
      if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      send(res, 200, req.method === 'HEAD' ? undefined : data, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        // Versioned URLs (?v=hash) never change; plain ones must be revalidated.
        'Cache-Control': new URL(req.url, 'http://localhost').searchParams.has('v')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      });
    });
  }

  async function handleCheckout(req, res) {
    if (!allowCheckout(clientIp(req))) {
      return sendJson(res, 429, { error: 'Too many attempts. Try again in a minute.' });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return sendJson(res, err.status || 400, { error: 'Invalid request.' });
    }
    const result = validateLine(body?.text, config);
    if (!result.ok) return sendJson(res, 400, { error: result.error });

    if (config.demoMode) {
      store.set(result.text);
      transactions.add({
        id: `demo_${Date.now().toString(36)}`,
        slug: store.get().slug,
        status: 'demo',
        text: result.text,
        amount: 0,
        currency: config.currency,
        email: null,
      });
      return sendJson(res, 200, { url: `/?paid=1`, demo: true, link: `/l/${store.get().slug}` });
    }

    try {
      const session = await createSession({
        secretKey: config.stripeSecretKey,
        text: result.text,
        priceCents: config.priceCents,
        currency: config.currency,
        baseUrl: config.baseUrl,
      });
      return sendJson(res, 200, { url: session.url });
    } catch (err) {
      console.error('[checkout] Stripe error:', err.message);
      return sendJson(res, 502, { error: 'Payment provider unavailable. Please try again.' });
    }
  }

  async function handleWebhook(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      return send(res, err.status || 400, 'Bad request');
    }
    if (!stripe.verifyWebhook(raw, req.headers['stripe-signature'], config.stripeWebhookSecret)) {
      return send(res, 400, 'Invalid signature');
    }
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return send(res, 400, 'Invalid JSON');
    }

    const types = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
    if (types.includes(event.type)) {
      const session = event.data?.object || {};
      if (session.payment_status === 'paid') {
        // Re-validate: the blocklist may have changed since checkout started.
        const result = validateLine(session.metadata?.buckline_text, config);
        const applied = result.ok && store.set(result.text, session.id);
        if (!result.ok) console.warn(`[webhook] paid session ${session.id} had rejected text; refund manually.`);
        if (applied || !result.ok) {
          transactions.add({
            id: session.id,
            slug: applied ? store.get().slug : null,
            status: result.ok ? 'paid' : 'rejected (refund)',
            text: String(session.metadata?.buckline_text ?? ''),
            amount: Number(session.amount_total) || 0,
            currency: session.currency || config.currency,
            email: session.customer_details?.email || null,
          });
        }
      }
    }
    return sendJson(res, 200, { received: true });
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\nevent: line\ndata: ${JSON.stringify(publicState())}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  }

  // ---------- permanent line pages ----------

  // Picked at random on each view of the current line's page.
  const CURRENT_EYEBROWS = [
    'Holding the line, for now',
    'Still standing, somehow',
    'Up there right now',
    'Owning the line, for now',
    'Clinging on, for now',
    'King of the line, for now',
    'Not replaced yet',
    'Living rent-free up there',
    'Top of the internet, briefly',
    'Still the line, believe it or not',
  ];
  const CURRENT_CTAS = [
    'Think you can top it?',
    'Got something better?',
    'Knock it off the top',
    'Your turn to own it',
    'Say it better',
    'Bump it off',
    'Make it yours',
    'Take the line',
    'Write over it',
    'Steal the spotlight',
  ];
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  const SLUG_RE = /^\/l\/([A-Za-z0-9_-]{6,16})$/;

  function renderLinePage(tx) {
    const current = store.get().slug === tx.slug;
    const posted = Date.parse(tx.createdAt);
    const date = new Date(posted).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' });
    // When was it replaced? The next line in the log with a link.
    const items = transactions.items;
    const idx = items.indexOf(tx);
    const next = items.slice(idx + 1).find((t) => t.slug);
    const lasted = next ? duration(Date.parse(next.createdAt) - posted) : null;

    const eyebrow = current ? pick(CURRENT_EYEBROWS) : 'Once upon a time, the line said';
    const status = current
      ? null
      : lasted
        ? `lasted ${lasted} before someone paid to replace it`
        : 'since replaced';
    const cta = current ? `${pick(CURRENT_CTAS)} \u2014 ${formatPrice()}` : 'See what it says now';
    const title = `\u201C${tx.text}\u201D \u2014 OneBuckLine`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="A line that was on OneBuckLine on ${escapeHtml(date)} UTC.">
  <meta property="og:title" content="${escapeHtml(tx.text)}">
  <meta property="og:description" content="Posted on OneBuckLine \u00B7 ${escapeHtml(date)} UTC">
  <link rel="canonical" href="${escapeHtml(config.baseUrl)}/l/${escapeHtml(tx.slug)}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800;900&display=swap">
  <link rel="stylesheet" href="${ASSET.css}">
</head>
<body>
  <div class="page">
    <header class="header">
      <a class="logo" href="/" aria-label="OneBuckLine home">OneBuck<span>Line</span></a>
    </header>
    <main class="hero">
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <h1 class="line">${escapeHtml(tx.text)}</h1>
      <p class="muted permalink-meta">Posted <time datetime="${escapeHtml(tx.createdAt)}" title="${escapeHtml(date)} UTC">${escapeHtml(
        timeAgo(posted),
      )}</time>${status ? ` \u00B7 ${escapeHtml(status)}` : ''}</p>
      <div class="actions">
        <a class="btn btn-primary btn-xl" href="/">${escapeHtml(cta)} <span aria-hidden="true">\u2192</span></a>
      </div>
    </main>
  </div>
</body>
</html>`;
  }

  // ---------- admin panel ----------

  const ADMIN_HEADERS = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  };

  function isAdmin(req) {
    return sessions.valid(admin.parseCookies(req.headers.cookie)[admin.COOKIE]);
  }

  function adminPage(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${ASSET.admin}"></head><body>${body}</body></html>`;
  }

  function renderLogin(error) {
    return adminPage(
      'OneBuckLine admin',
      `<main class="login"><h1>OneBuckLine admin</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/adminpanel/login">
<label>Login <input name="login" autocomplete="username" required autofocus></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button></form></main>`,
    );
  }

  function money(cents, currency) {
    try {
      return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: String(currency).toUpperCase() });
    } catch {
      return `${(cents / 100).toFixed(2)} ${currency}`;
    }
  }

  function renderTransactions(flash) {
    const list = transactions.all();
    const totals = {};
    for (const t of list) if (t.status === 'paid') totals[t.currency] = (totals[t.currency] || 0) + t.amount;
    const totalText = Object.entries(totals).map(([c, v]) => money(v, c)).join(', ') || money(0, config.currency);
    const rows = list
      .map(
        (t) => `<tr><td>${escapeHtml(t.createdAt.replace('T', ' ').slice(0, 19))}</td>
<td><span class="status s-${escapeHtml(t.status.split(' ')[0])}">${escapeHtml(t.status)}</span></td>
<td class="num">${escapeHtml(money(t.amount, t.currency))}</td>
<td>${escapeHtml(t.email || '—')}</td>
<td class="text">${escapeHtml(t.text)}</td>
<td class="link">${t.slug ? `<a href="/l/${encodeURIComponent(t.slug)}" target="_blank" rel="noopener">/l/${escapeHtml(t.slug)}</a>` : '—'}</td>
<td class="id">${escapeHtml(t.id)}</td></tr>`,
      )
      .join('');
    return adminPage(
      'Transactions — OneBuckLine admin',
      `<header><h1>Transactions</h1>
<form method="post" action="/adminpanel/logout"><button type="submit">Sign out</button></form></header>
${flash ? `<p class="flash ${flash.ok ? 'ok' : 'error'}">${escapeHtml(flash.message)}</p>` : ''}
<section class="setline"><h2>Current line</h2>
<p class="current">${escapeHtml(store.get().text)}</p>
<form method="post" action="/adminpanel/line">
<input name="text" maxlength="${config.maxLength * 2}" required placeholder="New line (max ${config.maxLength} characters)" aria-label="New line">
<button type="submit">Set line</button></form>
<p class="hint">Changes the line for everyone right away, free of charge. Logged as an admin change.</p></section>
<section class="mode ${config.demoMode ? 'is-demo' : 'is-live'}">
<div><h2>Mode</h2>
<p class="mode-state"><strong>${config.demoMode ? 'Demo' : 'Live'}</strong> \u2014 ${
      config.demoMode
        ? 'anyone can change the line for free, no payment taken.'
        : 'visitors pay through Stripe to change the line.'
    }</p></div>
<form method="post" action="/adminpanel/mode">
<input type="hidden" name="mode" value="${config.demoMode ? 'live' : 'demo'}">
<button type="submit"${!config.demoMode || config.stripeSecretKey ? '' : ' disabled title="Set STRIPE_SECRET_KEY first"'}>Switch to ${
      config.demoMode ? 'live' : 'demo'
    } mode</button></form></section>
<p class="summary">${list.length} transaction${list.length === 1 ? '' : 's'} · paid total ${escapeHtml(totalText)}</p>
<div class="table-wrap"><table><thead><tr><th>Time (UTC)</th><th>Status</th><th>Amount</th><th>Email</th><th>Text</th><th>Link</th><th>ID</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7" class="empty">No transactions yet.</td></tr>'}</tbody></table></div>`,
    );
  }

  async function handleLogin(req, res) {
    if (!allowLogin(clientIp(req))) {
      return send(res, 429, renderLogin('Too many attempts. Try again in a minute.'), ADMIN_HEADERS);
    }
    let form;
    try {
      form = new URLSearchParams(await readBody(req));
    } catch (err) {
      return send(res, err.status || 400, 'Bad request', { 'Content-Type': 'text/plain' });
    }
    const userOk = admin.safeEqual(form.get('login') || '', config.adminUser);
    const passOk = admin.safeEqual(form.get('password') || '', config.adminPassword);
    if (!(userOk && passOk)) {
      return send(res, 401, renderLogin('Wrong login or password.'), ADMIN_HEADERS);
    }
    const secure = config.baseUrl.startsWith('https:') ? '; Secure' : '';
    return send(res, 303, undefined, {
      Location: '/adminpanel',
      'Set-Cookie': `${admin.COOKIE}=${sessions.issue()}; Path=/adminpanel; HttpOnly; SameSite=Strict; Max-Age=${admin.SESSION_MS / 1000}${secure}`,
    });
  }

  async function handleAdmin(req, res, pathname, method) {
    if (!config.adminPassword) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    if (pathname === '/adminpanel' && method === 'GET') {
      if (!isAdmin(req)) return send(res, 200, renderLogin(), ADMIN_HEADERS);
      const q = new URL(req.url, 'http://localhost').searchParams;
      const flash = q.has('updated')
        ? { ok: true, message: 'Line updated.' }
        : q.get('mode') === 'demo'
          ? { ok: true, message: 'Demo mode is on. Changes are free until you switch back.' }
          : q.get('mode') === 'live'
            ? { ok: true, message: 'Live mode is on. Visitors pay through Stripe.' }
            : null;
      return send(res, 200, renderTransactions(flash), ADMIN_HEADERS);
    }
    if (pathname === '/adminpanel/login' && method === 'POST') return handleLogin(req, res);
    if (pathname === '/adminpanel/mode' && method === 'POST') {
      if (!isAdmin(req)) return send(res, 303, undefined, { Location: '/adminpanel' });
      let form;
      try {
        form = new URLSearchParams(await readBody(req));
      } catch (err) {
        return send(res, err.status || 400, 'Bad request', { 'Content-Type': 'text/plain' });
      }
      const mode = form.get('mode');
      if (mode !== 'demo' && mode !== 'live') return send(res, 400, 'Bad mode', { 'Content-Type': 'text/plain' });
      const error = setDemoMode(mode === 'demo');
      if (error) return send(res, 400, renderTransactions({ ok: false, message: error }), ADMIN_HEADERS);
      return send(res, 303, undefined, { Location: `/adminpanel?mode=${mode}` });
    }
    if (pathname === '/adminpanel/line' && method === 'POST') {
      if (!isAdmin(req)) return send(res, 303, undefined, { Location: '/adminpanel' });
      let form;
      try {
        form = new URLSearchParams(await readBody(req));
      } catch (err) {
        return send(res, err.status || 400, 'Bad request', { 'Content-Type': 'text/plain' });
      }
      const result = validateLine(form.get('text'), config);
      if (!result.ok) {
        return send(res, 400, renderTransactions({ ok: false, message: result.error }), ADMIN_HEADERS);
      }
      store.set(result.text);
      transactions.add({
        id: `admin_${Date.now().toString(36)}`,
        slug: store.get().slug,
        status: 'admin',
        text: result.text,
        amount: 0,
        currency: config.currency,
        email: null,
      });
      return send(res, 303, undefined, { Location: '/adminpanel?updated=1' });
    }
    if (pathname === '/adminpanel/logout' && method === 'POST') {
      return send(res, 303, undefined, {
        Location: '/adminpanel',
        'Set-Cookie': `${admin.COOKIE}=; Path=/adminpanel; HttpOnly; SameSite=Strict; Max-Age=0`,
      });
    }
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }

  async function handler(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    const method = req.method;

    try {
      if ((method === 'GET' || method === 'HEAD') && pathname === '/') {
        return send(res, 200, method === 'HEAD' ? undefined : renderIndex(), {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
      }
      if (method === 'GET' && pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (method === 'GET' && pathname === '/api/line') return sendJson(res, 200, publicState());
      if (method === 'GET' && pathname === '/api/events') return handleEvents(req, res);
      if (method === 'POST' && pathname === '/api/checkout') return await handleCheckout(req, res);
      if (method === 'POST' && pathname === '/api/stripe/webhook') return await handleWebhook(req, res);
      const slugMatch = (method === 'GET' || method === 'HEAD') && SLUG_RE.exec(pathname);
      if (slugMatch) {
        const tx = transactions.bySlug(slugMatch[1]);
        if (!tx) return send(res, 404, 'Line not found', { 'Content-Type': 'text/plain; charset=utf-8' });
        return send(res, 200, method === 'HEAD' ? undefined : renderLinePage(tx), {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
      }
      if (pathname === '/adminpanel' || pathname.startsWith('/adminpanel/')) {
        return await handleAdmin(req, res, pathname, method);
      }
      if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, pathname);
      return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
    } catch (err) {
      console.error('[server] unhandled error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong.' });
      else res.end();
    }
  }

  const server = http.createServer(handler);
  server.closeSse = () => {
    for (const c of sseClients) c.end();
    sseClients.clear();
  };
  return { server, store, config, transactions };
}

if (require.main === module) {
  const { server, config } = createApp();
  server.listen(config.port, config.host, () => {
    console.log(`OneBuckLine listening on http://${config.host}:${config.port}`);
    if (config.demoMode) {
      console.log('Demo mode: no STRIPE_SECRET_KEY set, so "paying" changes the line for free.');
    } else if (!config.stripeWebhookSecret) {
      console.warn('STRIPE_WEBHOOK_SECRET is not set: paid changes will never be applied.');
    }
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down.`);
    server.closeSse();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp, escapeHtml };
