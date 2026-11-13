'use strict';

/**
 * Normalises and checks a proposed line.
 * Returns { ok: true, text } or { ok: false, error }.
 */
function validateLine(input, { maxLength, blockedWords = [] }) {
  if (typeof input !== 'string') return { ok: false, error: 'Text is required.' };

  const text = input
    .normalize('NFC')
    // Strip control and invisible formatting characters (zero-width, bidi overrides).
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return { ok: false, error: 'Text is required.' };

  const length = [...text].length; // count code points, not UTF-16 units
  if (length > maxLength) {
    return { ok: false, error: `Keep it to ${maxLength} characters or fewer.` };
  }

  const lower = text.toLowerCase();
  if (blockedWords.some((w) => lower.includes(w))) {
    return { ok: false, error: 'That text is not allowed.' };
  }

  return { ok: true, text };
}

module.exports = { validateLine };
