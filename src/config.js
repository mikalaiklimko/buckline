'use strict';

const path = require('node:path');

function int(name, fallback) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

const config = {
  port: int('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  // Public URL used for Stripe success/cancel redirects.
  baseUrl: (process.env.BASE_URL || `http://localhost:${int('PORT', 3000)}`).replace(/\/+$/, ''),
  dataFile: process.env.DATA_FILE || path.join(process.cwd(), 'data', 'line.json'),
  initialText: process.env.INITIAL_TEXT || 'Hello, internet.',
  maxLength: int('MAX_LENGTH', 80),
  priceCents: int('PRICE_CENTS', 100),
  currency: (process.env.CURRENCY || 'usd').toLowerCase(),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  // Comma-separated words that are rejected (case-insensitive).
  blockedWords: (process.env.BLOCKED_WORDS || '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean),
  // Checkout attempts allowed per IP per minute.
  checkoutRateLimit: int('CHECKOUT_RATE_LIMIT', 10),
  // Admin panel at /adminpanel. Disabled unless ADMIN_PASSWORD is set.
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Google Analytics 4 measurement ID. Set GA_MEASUREMENT_ID= (empty) to turn analytics off.
  gaMeasurementId: process.env.GA_MEASUREMENT_ID ?? 'G-63V8H5EP16',
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
};

// Without a Stripe key the app runs in demo mode: "paying" applies the text immediately.
config.demoMode = !config.stripeSecretKey;
config.transactionsFile =
  process.env.TRANSACTIONS_FILE || path.join(path.dirname(config.dataFile), 'transactions.jsonl');

module.exports = config;
