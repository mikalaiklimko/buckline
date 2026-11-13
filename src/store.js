'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

/**
 * Holds the current line and persists it to a JSON file.
 * Writes are atomic (temp file + rename) so a crash never leaves a half-written file.
 */
class LineStore extends EventEmitter {
  constructor(file, initialText) {
    super();
    this.file = file;
    this.state = { text: initialText, updatedAt: null, changes: 0 };
    this.appliedSessions = new Set();
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof raw.text === 'string') {
        this.state = {
          text: raw.text,
          updatedAt: raw.updatedAt ?? null,
          changes: Number(raw.changes) || 0,
        };
      }
      if (Array.isArray(raw.appliedSessions)) {
        this.appliedSessions = new Set(raw.appliedSessions.slice(-1000));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[store] could not read ${this.file}:`, err.message);
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body = JSON.stringify(
      { ...this.state, appliedSessions: [...this.appliedSessions].slice(-1000) },
      null,
      2,
    );
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, this.file);
  }

  get() {
    return { ...this.state };
  }

  /**
   * Replace the line. `sessionId` makes the call idempotent: Stripe can deliver
   * the same webhook more than once, and a repeat must not count twice.
   * Returns true if the line changed.
   */
  set(text, sessionId) {
    if (sessionId) {
      if (this.appliedSessions.has(sessionId)) return false;
      this.appliedSessions.add(sessionId);
    }
    this.state = {
      text,
      updatedAt: new Date().toISOString(),
      changes: this.state.changes + 1,
    };
    this._save();
    this.emit('change', this.get());
    return true;
  }
}

module.exports = { LineStore };
