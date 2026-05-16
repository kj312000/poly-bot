'use strict';

/**
 * TradeAnalyzer — two separate buffers:
 *
 *  1. _rollingTicks (30)  — rolling window for the performance advisor
 *  2. _tickBuffer  (100)  — accumulates exactly 100 ticks, then fires
 *                           onBuffer100Full(ticks) for counterfactual analysis.
 *     After firing, resets and starts collecting the next batch.
 *
 *  3. _trades (20)        — closed trade results for performance advisor
 */

const ROLLING_TICKS = 30;
const BUFFER_TARGET = 100;
const MAX_TRADES    = 20;

class TradeAnalyzer {
  /**
   * @param {function} onBuffer100Full — called with (ticks[100]) when buffer fills
   */
  constructor(onBuffer100Full) {
    this._onBuffer100Full = onBuffer100Full || (() => {});
    this._rollingTicks   = [];
    this._tickBuffer     = [];
    this._trades         = [];
  }

  // ── Called for EVERY metrics evaluation (every ~5s from btcDataFeed) ─────────

  logTick(m) {
    const entry = {
      ts:          m.ts          || Date.now(),
      btcPrice:    +(m.btcPrice  || m.price || 0).toFixed(2),
      v15:         +parseFloat(m.v15  || 0).toFixed(4),
      v30:         +parseFloat(m.v30  || 0).toFixed(4),
      v60:         +parseFloat(m.v60  || 0).toFixed(4),
      pressure:    +(parseFloat(m.pressure    || 0) * 100).toFixed(1),
      volRatio:    +parseFloat(m.volRatio     || 1).toFixed(2),
      obImbalance: +(parseFloat(m.obImbalance || 0) * 100).toFixed(1),
      spreadBps:   +parseFloat(m.spreadBps    || 0).toFixed(1),
      zScore:      +parseFloat(m.zScore       || 0).toFixed(2),
      confidence:  m.confidence  || 0,
      signal:      m.signal      || 'NO TRADE',
      action:      m.action      || 'evaluated',
      reason:      m.reason      || '',
      scoreBreakdown: m.scoreBreakdown || m.score || null,
    };

    // 1. Rolling window (advisor)
    this._rollingTicks.push(entry);
    if (this._rollingTicks.length > ROLLING_TICKS) this._rollingTicks.shift();

    // 2. Accumulation buffer (counterfactual)
    this._tickBuffer.push(entry);
    if (this._tickBuffer.length >= BUFFER_TARGET) {
      const batch = this._tickBuffer.splice(0, BUFFER_TARGET);
      // Fire async — don't block the tick pipeline
      setImmediate(() => this._onBuffer100Full(batch));
    }
  }

  // ── Called when a trade closes ────────────────────────────────────────────────

  logTradeClose(result) {
    this._trades.push({
      ts:         result.timestamp || Date.now(),
      signal:     result.side === 'YES' ? 'LONG' : 'SHORT',
      entryPrice: +parseFloat(result.entryPrice || 0).toFixed(4),
      exitPrice:  +parseFloat(result.exitPrice  || 0).toFixed(4),
      tpPrice:    +parseFloat(result.tpPrice    || 0).toFixed(4),
      slPrice:    +parseFloat(result.slPrice    || 0).toFixed(4),
      rrRatio:    result.rrRatio  || '—',
      pnl:        +parseFloat(result.pnl        || 0).toFixed(3),
      reason:     result.reason   || 'unknown',
      holdMs:     result.holdMs   || 0,
      confidence: result.confidence ? +(result.confidence * 100).toFixed(0) : null,
    });
    if (this._trades.length > MAX_TRADES) this._trades.shift();
  }

  // ── Stats ─────────────────────────────────────────────────────────────────────

  getSummary() {
    const trades   = this._trades;
    if (!trades.length) return { totalTrades: 0 };
    const wins     = trades.filter(t => t.pnl > 0);
    const losses   = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgWin   = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0)   / wins.length   : 0;
    const avgLoss  = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const avgHoldMs = trades.length ? trades.reduce((s, t) => s + t.holdMs, 0) / trades.length : 0;
    const highConf = trades.filter(t => t.confidence && t.confidence >= 75);
    const lowConf  = trades.filter(t => t.confidence && t.confidence < 75);

    return {
      totalTrades: trades.length,
      winRate:     trades.length ? (wins.length / trades.length * 100).toFixed(1) : '—',
      totalPnl:    totalPnl.toFixed(3),
      avgWin:      avgWin.toFixed(3),
      avgLoss:     avgLoss.toFixed(3),
      tpHits:      trades.filter(t => t.reason === 'take_profit').length,
      slHits:      trades.filter(t => t.reason === 'stop_loss').length,
      expired:     trades.filter(t => t.reason === 'max_hold').length,
      avgHoldSec:  (avgHoldMs / 1000).toFixed(0),
      realizedRR:  avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : '∞',
      highConfWR:  highConf.length ? (highConf.filter(t=>t.pnl>0).length / highConf.length * 100).toFixed(0) : null,
      lowConfWR:   lowConf.length  ? (lowConf.filter(t=>t.pnl>0).length  / lowConf.length  * 100).toFixed(0) : null,
    };
  }

  // For performance advisor
  getSnapshot(currentParams) {
    return {
      summary:      this.getSummary(),
      recentTicks:  this._rollingTicks.slice(-20),
      recentTrades: this._trades.slice(-10),
      currentParams,
    };
  }

  // Tick buffer progress (for UI display)
  bufferProgress() {
    return { filled: this._tickBuffer.length, target: BUFFER_TARGET };
  }

  hasEnoughData(minTrades = 3) { return this._trades.length >= minTrades; }
  tradeCount()                 { return this._trades.length; }
}

module.exports = { TradeAnalyzer };
