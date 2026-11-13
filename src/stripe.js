'use strict';

const crypto = require('node:crypto');

const STRIPE_API = 'https://api.stripe.com/v1';

/** Flattens a nested object into Stripe's form encoding: a[b][0][c]=v */
function formEncode(obj, prefix, out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') formEncode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

/** Creates a Stripe Checkout Session using the REST API (no SDK needed). */
async function createCheckoutSession({ secretKey, text, priceCents, currency, baseUrl }) {
  const body = formEncode({
    mode: 'payment',
    success_url: `${baseUrl}/?paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?cancelled=1`,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency,
          unit_amount: priceCents,
          product_data: {
            name: 'OneBuckLine — own the line',
            description: text.length > 300 ? `${text.slice(0, 297)}...` : text,
          },
        },
      },
    ],
    metadata: { buckline_text: text },
    payment_intent_data: { metadata: { buckline_text: text } },
  });

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || `Stripe responded ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

/**
 * Verifies a Stripe webhook signature header ("t=...,v1=...") against the raw body.
 * Rejects events older than `toleranceSec` to block replays.
 */
function verifyWebhook(rawBody, header, secret, toleranceSec = 300, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.create(null);
  const v1 = [];
  for (const item of header.split(',')) {
    const [k, v] = item.split('=');
    if (k === 'v1') v1.push(v);
    else parts[k] = v;
  }
  const t = Number(parts.t);
  if (!t || v1.length === 0) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  return v1.some((sig) => {
    const sigBuf = Buffer.from(sig || '', 'hex');
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

module.exports = { createCheckoutSession, verifyWebhook, formEncode };
