'use strict';

const fs = require('fs');

/**
 * Loads historical price data from:
 *   1. Polymarket CLOB REST API (if adapter provided)
 *   2. CSV file (columns: timestamp,marketId,price)
 *   3. Synthetic GBM simulation (always available)
 */
class HistoricalLoader {
  constructor(restAdapter = null) {
    this.adapter = restAdapter;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Attempt to load real price history from Polymarket CLOB.
   * Falls back to synthetic data on any error.
   * @param {string[]} conditionIds
   * @param {number} days
   * @returns {Map<string, Array<{t:number, p:number}>>}
   */
  async loadFromApi(conditionIds, days = 30) {
    if (!this.adapter) return this.generateSynthetic(conditionIds.map(id => ({ id })), days);

    const result = new Map();
    for (const id of conditionIds) {
      try {
        const raw = await this.adapter.getPriceHistory(id, { interval: 'max', fidelity: 100 });
        const series = (raw.history || []).map(pt => ({
          t: typeof pt.t === 'string' ? parseInt(pt.t, 10) * 1000 : pt.t,
          p: parseFloat(pt.p),
        })).filter(pt => !isNaN(pt.p) && !isNaN(pt.t));

        if (series.length >= 10) {
          result.set(id, series);
          continue;
        }
      } catch {
        // fall through to synthetic
      }
      result.set(id, this._gbmSeries(0.5, days));
    }
    return result;
  }

  /**
   * Load from a CSV with header: timestamp,marketId,price
   */
  loadFromCsv(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.trim().split('\n');
    const header = lines[0].toLowerCase().split(',');
    const tIdx = header.indexOf('timestamp');
    const mIdx = header.indexOf('marketid');
    const pIdx = header.indexOf('price');
    if (tIdx < 0 || mIdx < 0 || pIdx < 0) {
      throw new Error('CSV must have columns: timestamp, marketId, price');
    }

    const result = new Map();
    for (const line of lines.slice(1)) {
      const cols = line.split(',');
      const marketId = cols[mIdx].trim();
      const t = parseInt(cols[tIdx].trim(), 10);
      const p = parseFloat(cols[pIdx].trim());
      if (isNaN(t) || isNaN(p)) continue;
      if (!result.has(marketId)) result.set(marketId, []);
      result.get(marketId).push({ t, p });
    }

    for (const [, series] of result) {
      series.sort((a, b) => a.t - b.t);
    }
    return result;
  }

  /**
   * Generate synthetic GBM price paths.
   * @param {Array<{id:string, impliedProb?:number, volatility?:number}>} markets
   * @param {number} days
   * @param {number} intervalMinutes  15min default → 96 ticks/day
   */
  generateSynthetic(markets, days = 30, intervalMinutes = 15) {
    const result = new Map();
    const now = Date.now();
    const startMs = now - days * 86400 * 1000;
    const stepMs = intervalMinutes * 60 * 1000;

    for (const m of markets) {
      const startPrice = m.impliedProb != null ? m.impliedProb : 0.3 + Math.random() * 0.4;
      const vol = m.volatility != null ? m.volatility : 0.1 + Math.random() * 0.15;
      const series = this._gbmSeries(startPrice, days, vol, stepMs, startMs);
      result.set(m.id, series);
    }
    return result;
  }

  // ── Internal GBM generator ─────────────────────────────────────────────────

  _gbmSeries(startPrice, days, annualVol = 0.15, stepMs = 15 * 60 * 1000, startMs = null) {
    const start = startMs != null ? startMs : Date.now() - days * 86400 * 1000;
    const totalSteps = Math.ceil((days * 86400 * 1000) / stepMs);
    const dt = stepMs / (365 * 86400 * 1000);     // fraction of a year
    const drift = 0;                               // unbiased martingale
    const sigma = annualVol;

    const series = [];
    let p = Math.max(0.05, Math.min(0.95, startPrice));

    for (let i = 0; i < totalSteps; i++) {
      const t = start + i * stepMs;
      series.push({ t, p: Math.round(p * 10000) / 10000 });

      const z = this._boxMuller();
      const logReturn = (drift - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * z;

      // Map to logistic space to keep in (0,1): transform, step, transform back
      const logit = Math.log(p / (1 - p));
      const newLogit = logit + logReturn * 10; // scale for binary market dynamics
      const newP = 1 / (1 + Math.exp(-newLogit));
      p = Math.max(0.01, Math.min(0.99, newP));
    }
    return series;
  }

  _boxMuller() {
    const u1 = Math.random() || 1e-10;
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

module.exports = { HistoricalLoader };
