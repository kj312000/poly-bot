'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir } = require('../shared/dataStore');

const STATES = {
  OPEN: 'OPEN',
  PARTIALLY_CLOSED: 'PARTIALLY_CLOSED',
  CLOSED: 'CLOSED',
};

class PositionBook {
  constructor(filePath) {
    this.filePath = filePath;
    ensureDir(path.dirname(filePath));
    this._data = this._load();
  }

  // ── Write API ──────────────────────────────────────────────────────────────

  openPosition({ id, marketId, side, size, entryPrice, agent, orderId, metadata = {} }) {
    const pos = {
      id: id || `pos_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      marketId,
      side,
      size,
      entryPrice,
      currentPrice: entryPrice,
      notional: size * entryPrice,
      unrealizedPnl: 0,
      realizedPnl: 0,
      status: STATES.OPEN,
      agent,
      orderId: orderId || null,
      openedAt: Date.now(),
      closedAt: null,
      exitPrice: null,
      fills: [],
      metadata,
    };
    this._data.positions[pos.id] = pos;
    this._persist();
    return pos;
  }

  updatePrice(positionId, currentPrice) {
    const pos = this._data.positions[positionId];
    if (!pos || pos.status === STATES.CLOSED) return null;
    const direction = pos.side === 'YES' ? 1 : -1;
    pos.currentPrice = currentPrice;
    pos.unrealizedPnl = (currentPrice - pos.entryPrice) * pos.size * direction;
    this._persist();
    return pos;
  }

  closePosition(positionId, { exitPrice, pnl = null } = {}) {
    const pos = this._data.positions[positionId];
    if (!pos) return null;
    const direction = pos.side === 'YES' ? 1 : -1;
    pos.exitPrice = exitPrice;
    pos.closedAt = Date.now();
    pos.status = STATES.CLOSED;
    pos.realizedPnl = pnl !== null ? pnl : (exitPrice - pos.entryPrice) * pos.size * direction;
    pos.unrealizedPnl = 0;
    this._data.history.push({ ...pos });
    delete this._data.positions[positionId];
    this._persist();
    return pos;
  }

  addFill(positionId, fill) {
    const pos = this._data.positions[positionId];
    if (!pos) return null;
    pos.fills.push({ ...fill, timestamp: fill.timestamp || Date.now() });
    this._persist();
    return pos;
  }

  // ── Read API ───────────────────────────────────────────────────────────────

  getOpen() {
    return Object.values(this._data.positions);
  }

  getById(id) {
    return this._data.positions[id] || null;
  }

  getByMarket(marketId) {
    return Object.values(this._data.positions).filter(p => p.marketId === marketId);
  }

  getByAgent(agentName) {
    return Object.values(this._data.positions).filter(p => p.agent === agentName);
  }

  getHistory({ since = 0, agent = null, limit = 100 } = {}) {
    let h = this._data.history.filter(p => p.closedAt >= since);
    if (agent) h = h.filter(p => p.agent === agent);
    return h.slice(-limit);
  }

  summary() {
    const open = this.getOpen();
    const totalUnrealized = open.reduce((s, p) => s + p.unrealizedPnl, 0);
    const totalNotional = open.reduce((s, p) => s + p.notional, 0);
    const totalRealized = this._data.history.reduce((s, p) => s + p.realizedPnl, 0);
    return {
      openCount: open.length,
      totalNotional,
      totalUnrealized,
      totalRealized,
      totalPnl: totalUnrealized + totalRealized,
    };
  }

  reset() {
    this._data = { positions: {}, history: [] };
    this._persist();
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch {
      // corrupted file — start fresh
    }
    return { positions: {}, history: [] };
  }

  _persist() {
    const tmp = `${this.filePath}.tmp.${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }
}

module.exports = { PositionBook, POSITION_STATES: STATES };
