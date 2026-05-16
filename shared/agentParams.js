'use strict';

/**
 * Runtime-tunable per-agent parameters.
 * Used by the strategy optimizer to apply Claude's suggestions without
 * touching individual agent source files.
 *
 * Coordinator.runCycle() applies these overrides after collecting proposals.
 */

const DEFAULTS = Object.freeze({
  btcScalp: { agentScore: 0.90, confidenceScale: 1.0, sizeScale: 1.0, enabled: true },
});

let _params = JSON.parse(JSON.stringify(DEFAULTS));

const agentParams = {
  get(name) {
    return _params[name] ? { ..._params[name] } : {};
  },

  getAll() {
    return JSON.parse(JSON.stringify(_params));
  },

  update(name, updates) {
    if (!_params[name]) _params[name] = { ...DEFAULTS[name] };
    _params[name] = { ..._params[name], ...updates };
  },

  updateMany(changes) {
    for (const [name, updates] of Object.entries(changes)) {
      this.update(name, updates);
    }
  },

  reset() {
    _params = JSON.parse(JSON.stringify(DEFAULTS));
  },

  /**
   * Apply overrides to a trade proposal object.
   * Called in Coordinator after collecting all agent proposals.
   */
  applyToTrade(trade) {
    const p = _params[trade.agent];
    if (!p) return trade;
    return {
      ...trade,
      agentScore: p.agentScore,
      confidence: Math.min(0.97, trade.confidence * (p.confidenceScale || 1.0)),
      requestedSize: Math.max(1, Math.round((trade.requestedSize || 10) * (p.sizeScale || 1.0))),
    };
  },

  isEnabled(agentName) {
    const p = _params[agentName];
    return !p || p.enabled !== false;
  },
};

module.exports = agentParams;
