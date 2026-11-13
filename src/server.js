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

  const indexTemplate = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

  store.on('change', (state) => {
    const payload = `event: line\ndata: ${JSON.stringify(publicState(state))}\n\n`;
    for (const client of sseClients) client.write(payload);
  });

  function publicState(state = store.get()) {
    return { text: state.text, updatedAt: state.updatedAt, changes: state.changes };
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return String(fwd).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function renderIndex() {
    const { text } = store.get();
    const price = (config.priceCents / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: config.currency.toUpperCase(),
      minimumFractionDigits: config.priceCents % 100 === 0 ? 0 : 2,
    });
    return indexTemplate
      .replaceAll('{{TEXT}}', escapeHtml(text))
      .replaceAll('{{PRICE}}', escapeHtml(price))
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
        'Cache-Control': 'public, max-age=3600',
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
        status: 'demo',
        text: result.text,
        amount: 0,
        currency: config.currency,
        email: null,
      });
      return sendJson(res, 200, { url: '/?paid=1', demo: true });
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
<link rel="stylesheet" href="/admin.css"></head><body>${body}</body></html>`;
  }

  function renderLogin(error) {
    return adminPage(
      'BuckLine admin',
      `<main class="login"><h1>BuckLine admin</h1>
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

  function renderTransactions() {
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
<td class="id">${escapeHtml(t.id)}</td></tr>`,
      )
      .join('');
    return adminPage(
      'Transactions — BuckLine admin',
      `<header><h1>Transactions</h1>
<form method="post" action="/adminpanel/logout"><button type="submit">Sign out</button></form></header>
<p class="summary">${list.length} transaction${list.length === 1 ? '' : 's'} · paid total ${escapeHtml(totalText)}</p>
<div class="table-wrap"><table><thead><tr><th>Time (UTC)</th><th>Status</th><th>Amount</th><th>Email</th><th>Text</th><th>ID</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="empty">No transactions yet.</td></tr>'}</tbody></table></div>`,
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
      return send(res, 200, isAdmin(req) ? renderTransactions() : renderLogin(), ADMIN_HEADERS);
    }
    if (pathname === '/adminpanel/login' && method === 'POST') return handleLogin(req, res);
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
    console.log(`BuckLine listening on http://${config.host}:${config.port}`);
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
