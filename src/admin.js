'use strict';

const crypto = require('node:crypto');

const COOKIE = 'bl_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;

function safeEqual(a, b) {
  // Hash first so lengths match and timing does not leak the length.
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header = '') {
  const out = Object.create(null);
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Signed, expiring session tokens. The key is random per process, so a restart
 * logs everyone out — acceptable for a single-admin panel.
 */
function createSessions(key = crypto.randomBytes(32)) {
  const sign = (data) => crypto.createHmac('sha256', key).update(data).digest('base64url');
  return {
    issue(now = Date.now()) {
      const data = String(now + SESSION_MS);
      return `${data}.${sign(data)}`;
    },
    valid(token, now = Date.now()) {
      if (typeof token !== 'string') return false;
      const [data, sig] = token.split('.');
      if (!data || !sig || !safeEqual(sig, sign(data))) return false;
      return Number(data) > now;
    },
  };
}

module.exports = { COOKIE, SESSION_MS, safeEqual, parseCookies, createSessions };
