'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir } = require('../shared/dataStore');

const STATES = {
  PENDING: 'PENDING',
  SUBMITTED: 'SUBMITTED',
  OPEN: 'OPEN',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
};

const TERMINAL = new Set([STATES.FILLED, STATES.CANCELLED, STATES.REJECTED, STATES.EXPIRED]);

// Valid transitions: from → Set<to>
const TRANSITIONS = {
  [STATES.PENDING]:          new Set([STATES.SUBMITTED, STATES.CANCELLED]),
  [STATES.SUBMITTED]:        new Set([STATES.OPEN, STATES.REJECTED, STATES.FILLED, STATES.CANCELLED]),
  [STATES.OPEN]:             new Set([STATES.PARTIALLY_FILLED, STATES.FILLED, STATES.CANCELLED, STATES.EXPIRED]),
  [STATES.PARTIALLY_FILLED]: new Set([STATES.FILLED, STATES.CANCELLED, STATES.EXPIRED]),
};

class OrderStore {
  constructor(filePath) {
    this.filePath = filePath;
    ensureDir(path.dirname(filePath));
    this._data = this._load();
  }

  // ── Write API ──────────────────────────────────────────────────────────────

  create({ marketId, tokenId, side, type = 'GTC', price, size, agent, metadata = {} }) {
    const order = {
      id: `ord_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      marketId,
      tokenId: tokenId || null,
      side,
      type,
      price,
      requestedSize: size,
      filledSize: 0,
      remainingSize: size,
      avgFillPrice: null,
      status: STATES.PENDING,
      agent,
      externalId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      fills: [],
      metadata,
    };
    this._data.orders[order.id] = order;
    this._persist();
    return order;
  }

  transition(orderId, newState, updates = {}) {
    const order = this._data.orders[orderId];
    if (!order) throw new Error(`Order not found: ${orderId}`);
    if (TERMINAL.has(order.status)) {
      throw new Error(`Order ${orderId} is terminal (${order.status}), cannot transition to ${newState}`);
    }
    const allowed = TRANSITIONS[order.status];
    if (!allowed || !allowed.has(newState)) {
      throw new Error(`Invalid transition ${order.status} → ${newState} for order ${orderId}`);
    }
    Object.assign(order, updates, { status: newState, updatedAt: Date.now() });

    if (TERMINAL.has(newState)) {
      this._data.history.push({ ...order });
      delete this._data.orders[orderId];
    }

    this._persist();
    return order;
  }

  addFill(orderId, { price, size, timestamp }) {
    const order = this._data.orders[orderId];
    if (!order) return null;

    order.fills.push({ price, size, timestamp: timestamp || Date.now() });
    order.filledSize += size;
    order.remainingSize = Math.max(0, order.requestedSize - order.filledSize);
    order.updatedAt = Date.now();

    // Weighted average fill price
    const totalFilled = order.fills.reduce((s, f) => s + f.size, 0);
    const totalCost = order.fills.reduce((s, f) => s + f.price * f.size, 0);
    order.avgFillPrice = totalFilled > 0 ? totalCost / totalFilled : null;

    const newState = order.remainingSize === 0 ? STATES.FILLED : STATES.PARTIALLY_FILLED;
    return this.transition(orderId, newState);
  }

  setExternalId(orderId, externalId) {
    const order = this._data.orders[orderId];
    if (!order) return null;
    order.externalId = externalId;
    order.updatedAt = Date.now();
    this._persist();
    return order;
  }

  // ── Read API ───────────────────────────────────────────────────────────────

  getById(id) {
    return this._data.orders[id] || this._data.history.find(o => o.id === id) || null;
  }

  getByState(state) {
    if (TERMINAL.has(state)) {
      return this._data.history.filter(o => o.status === state);
    }
    return Object.values(this._data.orders).filter(o => o.status === state);
  }

  getActive() {
    return Object.values(this._data.orders);
  }

  getByAgent(agent) {
    return [
      ...Object.values(this._data.orders).filter(o => o.agent === agent),
      ...this._data.history.filter(o => o.agent === agent),
    ];
  }

  getHistory({ limit = 100, since = 0 } = {}) {
    return this._data.history
      .filter(o => o.updatedAt >= since)
      .slice(-limit);
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch {}
    return { orders: {}, history: [] };
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

module.exports = { OrderStore, ORDER_STATES: STATES, ORDER_TERMINAL: TERMINAL };
