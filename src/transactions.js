'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Append-only transaction log stored as JSON Lines (one record per line).
 * Kept in memory as well so the admin panel can read it without disk I/O.
 */
class TransactionLog {
  constructor(file) {
    this.file = file;
    this.items = [];
    this._load();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[transactions] could not read ${this.file}:`, err.message);
      return;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.items.push(JSON.parse(line));
      } catch {
        // Skip a partially written last line after a crash.
      }
    }
  }

  /** Records a transaction. Fields: id, status, text, amount, currency, email. */
  add(tx) {
    const record = { createdAt: new Date().toISOString(), ...tx };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(record) + '\n');
    this.items.push(record);
    return record;
  }

  /** Newest first. */
  all() {
    return [...this.items].reverse();
  }
}

module.exports = { TransactionLog };
