'use strict';

const fs   = require('fs');
const path = require('path');

class CapitalStore {
  constructor(filePath) {
    this.filePath = filePath;
    this._data    = this._load();
  }

  get current()     { return this._data.current; }
  get allTimePnl()  { return this._data.allTimePnl; }
  get sessions()    { return this._data.sessions; }

  setCapital(amount, note = '') {
    const prev = this._data.current;
    this._data.current = Math.max(0.01, amount);
    this._data.changes.push({ ts: Date.now(), from: prev, to: this._data.current, note });
    if (this._data.changes.length > 200) this._data.changes.shift();
    this._persist();
    return this._data.current;
  }

  addCapital(delta, note = '') {
    return this.setCapital(this._data.current + delta, note);
  }

  // Call at end of each session
  recordSession({ startCapital, endCapital, trades, wins, pnl }) {
    const session = {
      ts:           Date.now(),
      startCapital,
      endCapital,
      trades,
      wins,
      pnl,
      winRate:      trades > 0 ? (wins / trades * 100).toFixed(1) : '—',
      returnPct:    startCapital > 0 ? ((pnl / startCapital) * 100).toFixed(2) : '0',
    };
    this._data.sessions.push(session);
    if (this._data.sessions.length > 100) this._data.sessions.shift();
    this._data.allTimePnl = (this._data.allTimePnl || 0) + pnl;
    this._data.current    = endCapital;
    this._persist();
    return session;
  }

  getChanges()     { return this._data.changes; }
  getSessions(n=20){ return this._data.sessions.slice(-n); }

  _load() {
    try {
      if (fs.existsSync(this.filePath))
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {}
    const cfg = (() => { try { return require('../config/config.json'); } catch { return {}; } })();
    return { current: cfg.total_capital || 10, allTimePnl: 0, sessions: [], changes: [] };
  }

  _persist() {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = { CapitalStore };
