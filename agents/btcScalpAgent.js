'use strict';

/**
 * BTC Scalp Agent — latency arbitrage via pure math, no API calls.
 *
 * Signal is derived entirely from BtcDataFeed WebSocket metrics:
 *   velocity × pressure × volume × orderbook × odds-lag → 0-100 confidence score
 *
 * Odds-lag:  expected repricing (from BTC velocity) vs actual Polymarket move.
 *            When Polymarket lags → temporary inefficiency → edge exists.
 */

const { getInstance: getFeed } = require('../core/btcDataFeed');
const { toTrade } = require('./agentUtils');

// ── Config ────────────────────────────────────────────────────────────────────

const MIN_CONFIDENCE  = 65;      // fire trade above this
const MAX_LOSSES      = 3;       // halt session after 3 consecutive losses
const ODDS_SENSITIVITY = 15;     // how much a 1% BTC move should reprice Polymarket (%)
const MIN_LIQUIDITY   = 500;     // skip BTC markets below this USDC liquidity
const MIN_SPREAD_BPS  = 100;     // skip if Polymarket spread > 100bps (1 cent on 0.50)

// ── Session state ─────────────────────────────────────────────────────────────

let _consecutiveLosses = 0;
let _sessionStopped    = false;

// Rolling odds history for lag calculation: marketId → [{ price, ts }, ...]
const _oddsHistory = new Map();
const ODDS_WINDOW  = 30;   // keep last 30 snapshots per market

// ── Odds lag math ─────────────────────────────────────────────────────────────

/**
 * Measures how far Polymarket's yes-price has moved vs how far it SHOULD
 * have moved given BTC's velocity.
 *
 * Returns:
 *   lagScore  0-100  (higher = more opportunity)
 *   direction  1 (LONG) | -1 (SHORT) | 0 (none)
 */
function calcOddsLag(market, btcVelocity30s) {
  const id  = market.id;
  const now = Date.now();
  const arr = _oddsHistory.get(id) || [];

  arr.push({ price: market.priceYes, ts: now });
  if (arr.length > ODDS_WINDOW) arr.shift();
  _oddsHistory.set(id, arr);

  if (arr.length < 4) return { lagScore: 0, direction: 0, oddsMove: 0, expectedMove: 0 };

  const oldest      = arr[0];
  const elapsed_s   = (now - oldest.ts) / 1000;
  if (elapsed_s < 5)  return { lagScore: 0, direction: 0, oddsMove: 0, expectedMove: 0 };

  // How much has the yes-price actually moved?
  const oddsMove     = market.priceYes - oldest.price;                // absolute
  const oddsMoveP    = oldest.price > 0 ? oddsMove / oldest.price * 100 : 0;

  // How much SHOULD it have moved given BTC velocity?
  // Rule of thumb: 1% BTC → ODDS_SENSITIVITY% repricing on short-term binary
  const expectedMoveP = btcVelocity30s * ODDS_SENSITIVITY / 100;     // % of yes-price
  const expectedAbs   = oldest.price * (expectedMoveP / 100);

  // Lag = expected - actual (positive = yes-price hasn't caught up to bullish BTC move)
  const lag = expectedAbs - oddsMove;

  if (Math.abs(expectedAbs) < 0.002) return { lagScore: 0, direction: 0, oddsMove, expectedMove: expectedAbs };

  const lagScore   = Math.min(100, Math.abs(lag / expectedAbs) * 100);
  const direction  = lag > 0 && btcVelocity30s > 0 ?  1    // BTC rising, odds not caught up → LONG
                   : lag < 0 && btcVelocity30s < 0 ? -1    // BTC falling, odds not caught up → SHORT
                   : 0;

  return { lagScore, direction, oddsMove: oddsMoveP, expectedMove: expectedMoveP };
}

// ── Anti-patterns ─────────────────────────────────────────────────────────────

function checkExhaustion(metrics) {
  // Extended candle + large wick = late entry, skip
  if (metrics.exhausted) return true;
  // Z-score > 3 = price already overextended
  if (Math.abs(metrics.zScore) > 3.0) return true;
  // Choppy: continuation score contradicts velocity
  if (metrics.continuation !== 0 && metrics.continuation !== metrics.dir) return true;
  return false;
}

// ── Signal engine ─────────────────────────────────────────────────────────────

/**
 * Combines BTC microstructure metrics + Polymarket odds lag into a final
 * 0-100 confidence score, direction, and signal.
 */
function generateSignal(metrics, oddsLag, spreadBps) {
  const dir = metrics.dir;
  if (dir === 0 || metrics.confidence < 1) return { signal: 'NO TRADE', confidence: 0, dir: 0 };

  // Polymarket spread guard
  if (spreadBps > MIN_SPREAD_BPS) return { signal: 'NO TRADE', confidence: 0, dir: 0, reason: 'spread too wide' };

  // Exhaustion / fake-breakout guard
  if (checkExhaustion(metrics)) return { signal: 'NO TRADE', confidence: 0, dir: 0, reason: 'exhaustion detected' };

  // Odds must lag in the same direction as BTC momentum
  const oddsAligned = oddsLag.direction === dir;

  // Final score = base microstructure score + odds-lag bonus/penalty
  const oddsBonus   = oddsAligned ? Math.min(15, oddsLag.lagScore * 0.15) : -10;
  const finalConf   = Math.round(Math.min(100, Math.max(0, metrics.confidence + oddsBonus)));

  if (finalConf < MIN_CONFIDENCE) return { signal: 'NO TRADE', confidence: finalConf, dir };

  return {
    signal:     dir === 1 ? 'LONG' : 'SHORT',
    confidence: finalConf,
    dir,
  };
}

// ── Agent interface ────────────────────────────────────────────────────────────

module.exports = {
  name: 'btcScalp',

  async generateSignals(markets, _news, _shared) {
    if (_sessionStopped) return [];

    const feed = getFeed();
    if (!feed.connected) return [];

    const metrics = feed.getMetrics();
    if (!metrics || metrics.signal === 'NO TRADE') return [];

    // Find best BTC market: must meet liquidity floor
    const btcMarkets = markets
      .filter(m =>
        /btc|bitcoin/i.test((m.title || '') + (m.id || '')) &&
        (m.liquidity || 0) >= MIN_LIQUIDITY
      )
      .sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0));

    if (!btcMarkets.length) return [];

    const target  = btcMarkets[0];
    const oddsLag = calcOddsLag(target, metrics.v30);
    const polySpreadBps = target.askYes && target.bidYes
      ? ((target.askYes - target.bidYes) / target.priceYes * 10000)
      : 200;  // assume wide if unknown

    const result = generateSignal(metrics, oddsLag, polySpreadBps);
    if (result.signal === 'NO TRADE') return [];

    return [{
      marketId:     target.id,
      price:        target.priceYes,
      probability:  result.dir === 1 ? 0.72 : 0.28,
      confidence:   result.confidence / 100,
      side:         result.dir === 1 ? 'YES' : 'NO',
      // Pass through for dashboard display
      microstructure: {
        btcPrice:       metrics.price,
        v30s:           metrics.v30.toFixed(4) + '%',
        pressure:       (metrics.pressure * 100).toFixed(1) + '%',
        volRatio:       metrics.volRatio.toFixed(2) + 'x',
        obImbalance:    (metrics.obImbalance * 100).toFixed(1) + '%',
        spread:         metrics.spreadBps.toFixed(1) + ' bps',
        zScore:         metrics.zScore.toFixed(2),
        oddsLag:        oddsLag.lagScore.toFixed(1),
        oddsMove:       oddsLag.oddsMove.toFixed(4) + '%',
        expectedMove:   oddsLag.expectedMove.toFixed(4) + '%',
        scoreBreakdown: metrics.scoreBreakdown,
      },
    }];
  },

  async evaluateOpportunities(signals) {
    return signals.map(s => ({
      ...s,
      agentScore:    s.confidence,
      requestedSize: 25,
    }));
  },

  async proposeTrades(opportunities) {
    return opportunities.map(o => toTrade('btcScalp', o));
  },

  onWin()  { _consecutiveLosses = 0; },
  onLoss() {
    _consecutiveLosses++;
    if (_consecutiveLosses >= MAX_LOSSES) {
      _sessionStopped = true;
      console.log('[btcScalp] 3 consecutive losses — session halted');
    } else {
      console.log(`[btcScalp] Loss ${_consecutiveLosses}/${MAX_LOSSES}`);
    }
  },

  resetSession() {
    _consecutiveLosses = 0;
    _sessionStopped    = false;
    _oddsHistory.clear();
    console.log('[btcScalp] Session reset');
  },
};
