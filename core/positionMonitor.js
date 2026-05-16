'use strict';

/**
 * PositionMonitor — TP/SL enforcement + latency-exploit exit mode.
 *
 * Normal mode:  polls /prices every 2 s, exits at TP/SL/max-hold levels.
 * Latency mode: per-position fast poll every LATENCY_POLL_MS, exits as soon as
 *               the token price moved >= latency_min_profit_pct in our favour,
 *               or hard-exits after latency_hold_ms regardless of P&L.
 *               This captures the spread between BTC spot (which moved) and the
 *               Polymarket oracle price (which lags 2-10 s behind spot).
 */

const CHECK_INTERVAL_MS = 2000;

class PositionMonitor {
  constructor({ marketApi, clobClient, positionBook, config, onClose, onLog, polymarketWs }) {
    this.marketApi    = marketApi;
    this.clobClient   = clobClient || null;
    this.positionBook = positionBook;
    this.config       = config;
    this.onClose      = onClose || (() => {});
    this.onLog        = onLog   || (() => {});
    this._polymarketWs          = polymarketWs || null;

    this._tracked               = new Map();
    this._timer                 = null;
    this._livePrices            = new Map();  // tokenId → latest mid price from WS
    this._bestBids              = new Map();  // tokenId → best bid price from WS
    this._bestAsks              = new Map();  // tokenId → best ask price from WS
    this._priceListenerAttached = false;
    this._Side                  = null;       // cached Side constant (lazy-loaded)
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._check(), CHECK_INTERVAL_MS);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._tracked.clear();
  }

  // ── Register a trade for monitoring ──────────────────────────────────────

  track(positionId, opts) {
    const isLatency    = !!(this.config.latency_mode);
    const latencyHoldMs = this.config.latency_hold_ms        || 2500;
    const latencyMinPct = this.config.latency_min_profit_pct || 0.020;
    const latencyStopPct = this.config.latency_stop_pct      || 0.015;
    const latencyPollMs = this.config.latency_poll_ms        || 250;
    const btcReversalPct = this.config.latency_btc_reversal_pct  || 0.05;
    const lagCloseFrac   = this.config.latency_lag_close_threshold || 0.6;

    // In latency mode use a very short max-hold as backstop for the regular loop;
    // the dedicated per-position fast loop exits much sooner.
    const maxMs = isLatency
      ? latencyHoldMs + 2000   // backstop = hold + 2 s buffer
      : (this.config.max_hold_ms || 300000);

    const tpPct = this.config.take_profit_pct || 0.20;
    const slPct = this.config.stop_loss_pct   || 0.10;

    // We always BUY the token (YES token to go long, NO token to go short).
    // Profit therefore equals token-price rising, regardless of side.
    const tpPrice = Math.min(0.98, opts.entryPrice + opts.entryPrice * tpPct);
    const slPrice = Math.max(0.02, opts.entryPrice - opts.entryPrice * slPct);
    const rrRatio = (Math.abs(tpPrice - opts.entryPrice) / Math.abs(opts.entryPrice - slPrice)).toFixed(2);

    const entry = {
      ...opts,
      positionId,
      tpPrice,
      slPrice,
      rrRatio,
      openedAt:      Date.now(),
      closeBy:       Date.now() + maxMs,
      closed:        false,
      isLatency,
      latencyHoldMs,
      latencyMinPct,
      latencyStopPct,
      btcReversalPct,
      lagCloseFrac,
      // Smart-exit anchors captured from caller (FastExecutor):
      entryDir:     opts.entryDir     || 0,      // +1 if BTC was rising at entry, -1 falling
      entryBtcPrice: opts.entryBtcPrice || null, // BTC spot at moment of entry
      _simPrice:     opts.entryPrice,
    };

    this._tracked.set(positionId, entry);

    // Subscribe WS price feed for this token (zero-latency price updates replace REST polling)
    if (this._polymarketWs && opts.tokenId) {
      if (!this._priceListenerAttached) {
        this._polymarketWs.on('priceChange', (data) => {
          const p = parseFloat(data.price);
          if (!isFinite(p)) return;
          this._livePrices.set(data.assetId, p);
          if (data.side === 'BUY')  this._bestBids.set(data.assetId, p);
          if (data.side === 'SELL') this._bestAsks.set(data.assetId, p);
        });
        this._priceListenerAttached = true;
      }
      this._polymarketWs.subscribe(opts.tokenId);
    }

    if (isLatency && opts.mode === 'live') {
      this.onLog(`[monitor] Tracking ${positionId.slice(-8)} | entry=${opts.entryPrice.toFixed(3)} mode=LATENCY hold=${latencyHoldMs}ms target=+${(latencyMinPct * 100).toFixed(1)}%`);
      this._startLatencyLoop(entry, latencyPollMs);
    } else {
      this.onLog(`[monitor] Tracking ${positionId.slice(-8)} | entry=${opts.entryPrice.toFixed(3)} TP=${tpPrice.toFixed(3)} SL=${slPrice.toFixed(3)} R:R=${rrRatio} mode=${opts.mode}`);
    }
  }

  // ── Latency-exploit fast exit loop ───────────────────────────────────────

  _startLatencyLoop(entry, pollMs) {
    const poll = async () => {
      try {
        if (entry.closed) return;

        const elapsed = Date.now() - entry.openedAt;

        if (elapsed >= entry.latencyHoldMs) {
          await this._latencyFetch(entry, 'latency_timeout');
          return;
        }

        await this._latencyFetch(entry, null);

        if (!entry.closed) setTimeout(poll, pollMs);
      } catch (e) {
        this.onLog(`[monitor] Latency loop error (${entry.positionId?.slice(-8)}): ${e.message} — rescheduling`);
        if (!entry.closed) setTimeout(poll, pollMs);
      }
    };

    setTimeout(poll, pollMs);
  }

  async _latencyFetch(entry, forceReason) {
    if (entry.closed) return;
    let currentPrice = entry.entryPrice;

    // Prefer WS price (zero latency). Fall back to REST only if no WS price available yet.
    const wsPrice = this._livePrices.get(entry.tokenId);
    if (wsPrice !== undefined) {
      currentPrice = wsPrice;
    } else if (this.marketApi) {
      try {
        const prices = await this.marketApi.getPrices([entry.tokenId]);
        currentPrice = parseFloat(prices?.[entry.tokenId] || entry.entryPrice);
      } catch {
        if (forceReason) await this._forceClose(entry, entry.entryPrice, forceReason, entry.entryPrice);
        return;
      }
    }

    if (forceReason) {
      await this._forceClose(entry, currentPrice, forceReason, currentPrice);
      return;
    }

    // We always own the token long — profit when token price rises.
    const delta      = currentPrice - entry.entryPrice;
    const deltaPct   = delta / entry.entryPrice;
    const elapsedMs  = Date.now() - entry.openedAt;

    // 1) Profit target — capture the bulk of repricing, don't chase the last 0.5%.
    if (deltaPct >= entry.latencyMinPct) {
      this.onLog(`[monitor] ✓ profit +${(deltaPct * 100).toFixed(2)}% in ${elapsedMs}ms`);
      await this._forceClose(entry, currentPrice, 'latency_profit', currentPrice);
      return;
    }

    // 2) Adverse stop — losers cut sooner than winners (tighter than profit target).
    if (deltaPct <= -entry.latencyStopPct) {
      this.onLog(`[monitor] ✗ stop ${(deltaPct * 100).toFixed(2)}% in ${elapsedMs}ms`);
      await this._forceClose(entry, currentPrice, 'latency_stop', currentPrice);
      return;
    }

    // 3) Signal-based smart exits — fire BEFORE thresholds when the edge has gone.
    // Re-grab live BTC metrics for the velocity-flip and lag-closed checks.
    let m = null;
    try {
      const { getInstance: getFeed } = require('./btcDataFeed');
      m = getFeed().getMetrics?.();
    } catch { /* no feed available — skip smart checks */ }

    if (m && entry.entryDir !== 0) {
      // 3a) BTC velocity flip — Binance turned. Polymarket will follow; exit first.
      //     v15 is the 15-second velocity in %; require both opposite sign and
      //     non-trivial magnitude to avoid noise-flips.
      if (Math.sign(m.v15) === -entry.entryDir && Math.abs(m.v15) > entry.btcReversalPct) {
        this.onLog(`[monitor] ↺ BTC reversal v15=${m.v15.toFixed(3)}% pnl=${(deltaPct * 100).toFixed(2)}% in ${elapsedMs}ms`);
        await this._forceClose(entry, currentPrice, 'btc_reversal', currentPrice);
        return;
      }

      // 3b) Lag closed — Polymarket has caught up to where BTC said it should be.
      //     "Expected" token move ≈ (BTC % move) × ODDS_SENSITIVITY/100 in token-price space.
      //     If actual move has reached lagCloseFrac of expected, the edge is gone.
      if (entry.entryBtcPrice && m.price) {
        const btcMovePct  = (m.price - entry.entryBtcPrice) / entry.entryBtcPrice * 100;
        const expectedTokenMove = (btcMovePct * 15 / 100) * entry.entryPrice / 100; // ODDS_SENSITIVITY=15
        // Only useful when BTC actually moved in our direction
        if (entry.entryDir * btcMovePct > 0 && Math.abs(expectedTokenMove) > 0.002) {
          const caughtUpFrac = delta / expectedTokenMove;
          if (caughtUpFrac >= entry.lagCloseFrac) {
            this.onLog(`[monitor] ⇆ lag closed ${(caughtUpFrac * 100).toFixed(0)}% pnl=${(deltaPct * 100).toFixed(2)}% in ${elapsedMs}ms`);
            await this._forceClose(entry, currentPrice, 'lag_closed', currentPrice);
            return;
          }
        }
      }
    }
  }

  // ── Normal periodic check (TP / SL / max-hold) ────────────────────────────

  async _check() {
    if (!this._tracked.size) return;

    const live  = [];
    const paper = [];
    for (const [, e] of this._tracked) {
      if (e.closed) { this._tracked.delete(e.positionId); continue; }
      if (e.isLatency && e.mode === 'live' && (Date.now() - e.openedAt) < e.latencyHoldMs + 5000) continue;
      e.mode === 'live' ? live.push(e) : paper.push(e);
    }

    // Paper: simulate price tick
    for (const e of paper) {
      const drift = (e.side === 'YES' ? 1 : -1) * 0.001;
      const noise = (Math.random() - 0.48) * 0.003;
      e._simPrice = Math.max(0.01, Math.min(0.99, e._simPrice + drift + noise));
      await this._evaluateClose(e, e._simPrice);
    }

    // Live: batch-fetch prices
    if (live.length && this.marketApi) {
      const tokenIds = live.map(e => e.tokenId).filter(Boolean);
      if (tokenIds.length) {
        try {
          const prices = await this.marketApi.getPrices(tokenIds);
          for (const e of live) {
            const price = parseFloat(prices?.[e.tokenId] || e.entryPrice);
            await this._evaluateClose(e, price);
          }
        } catch {
          const now = Date.now();
          for (const e of live) {
            if (now > e.closeBy) await this._forceClose(e, e.entryPrice, 'max_hold', e.entryPrice);
          }
        }
      }
    }
  }

  async _evaluateClose(entry, currentPrice) {
    if (entry.closed) return;
    const now = Date.now();

    // We always BUY the token at entry — profit when its price rises.
    const hitTP   = currentPrice >= entry.tpPrice;
    const hitSL   = currentPrice <= entry.slPrice;
    const expired = now > entry.closeBy;

    if (hitTP)        await this._forceClose(entry, entry.tpPrice,                         'take_profit', currentPrice);
    else if (hitSL)   await this._forceClose(entry, entry.slPrice,                         'stop_loss',   currentPrice);
    else if (expired) await this._forceClose(entry, Math.max(0.01, currentPrice * 0.97),   'max_hold',    currentPrice);
  }

  async _forceClose(entry, exitPrice, reason, marketPrice = exitPrice) {
    if (entry.closed) return;
    entry.closed = true;
    this._tracked.delete(entry.positionId);

    // Always long the token — pnl = (exit - entry) * size, no side flip.
    const pnl = (exitPrice - entry.entryPrice) * entry.size;

    // Capture BTC spot at exit for diagnostics
    let btcAtExit = null;
    try {
      const { getInstance: getFeed } = require('./btcDataFeed');
      btcAtExit = getFeed().getMetrics?.()?.price || null;
    } catch {}

    try {
      if (this.positionBook) {
        this.positionBook.closePosition(entry.positionId, { exitPrice, pnl });
      }
    } catch (e) {
      this.onLog(`[monitor] positionBook.closePosition failed: ${e.message}`);
    }

    // Submit the closing SELL only for true live mode, not dryRun.
    if (entry.mode === 'live' && !entry.dryRun && entry.tokenId) {
      try {
        // For SELL FAK: limit must be ≤ best bid for guaranteed fill.
        // Wide-spread BTC 5m markets have bid/ask spread of 0.15-0.30 — using mid
        // as sell limit guarantees FAK cancellation. Must use real best bid.
        const tick = this.config.exit_bid_offset ?? 0.01;
        let bestBid = this._bestBids.get(entry.tokenId) ?? null;

        // WS bid not yet available — fetch real orderbook for guaranteed fill price
        if (bestBid === null) {
          try {
            const ob = this.clobClient
              ? await this.clobClient.getOrderBook(entry.tokenId)
              : (this.marketApi?.getOrderBook ? await this.marketApi.getOrderBook(entry.tokenId) : null);
            const bids = (ob?.bids || [])
              .map(b => parseFloat(b.price ?? b.p))
              .filter(v => isFinite(v) && v > 0);
            if (bids.length) bestBid = Math.max(...bids);
          } catch (obErr) {
            this.onLog(`[monitor] Orderbook fetch failed for close: ${obErr.message}`);
          }
        }

        // Fallback: sell at 85% of market price — accept slippage over staying open to settlement
        const closePrice = bestBid !== null
          ? Math.max(0.01, bestBid - tick)
          : Math.max(0.01, marketPrice * 0.85);

        if (this.clobClient) {
          if (!this._Side) {
            const mod = await import('@polymarket/clob-client-v2');
            this._Side = mod.Side;
          }
          await this.clobClient.createAndPostOrder(
            { tokenID: entry.tokenId, price: closePrice, size: entry.size, side: this._Side.SELL },
            { tickSize: '0.01', negRisk: false },
            'FAK'
          );
        } else if (this.marketApi) {
          await this.marketApi.placeOrder({
            tokenId:   entry.tokenId,
            side:      'SELL',
            price:     closePrice,
            size:      entry.size,
            orderType: 'FAK',
          });
        }
      } catch (e) {
        this.onLog(`[monitor] Close order failed: ${e.message}`);
      }
    }

    const tag = reason === 'take_profit'    ? '✓ TP'
              : reason === 'stop_loss'      ? '✗ SL'
              : reason === 'latency_profit' ? '⚡ LP'
              : reason === 'latency_stop'   ? '⚡ LS'
              : reason === 'latency_timeout'? '⏱ LT'
              : reason === 'btc_reversal'   ? '↺ RV'
              : reason === 'lag_closed'     ? '⇆ LC'
              :                               '⏱ EXP';
    const simTag = entry.dryRun ? ' [SIM]' : '';
    this.onLog(`[monitor]${simTag} ${tag} ${entry.positionId.slice(-8)} exit=${exitPrice.toFixed(3)} pnl=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)} (${reason})`);

    const closeResult = {
      positionId:  entry.positionId,
      marketId:    entry.marketId,
      side:        entry.side,
      entryPrice:  entry.entryPrice,
      exitPrice,
      size:        entry.size,
      pnl,
      reason,
      rrRatio:     entry.rrRatio,
      agent:       entry.agent,
      holdMs:      Date.now() - entry.openedAt,
      timestamp:   Date.now(),
      dryRun:      !!entry.dryRun,
      btcAtEntry:  entry.entryBtcPrice || null,
      btcAtExit,
      btcMovePct:  (entry.entryBtcPrice && btcAtExit)
        ? ((btcAtExit - entry.entryBtcPrice) / entry.entryBtcPrice * 100)
        : null,
    };

    try {
      const { getInstance: getTelegram } = require('./telegramNotifier');
      getTelegram().tradeClosed(closeResult);
    } catch {}

    this.onClose(closeResult);
  }

  trackedCount() { return this._tracked.size; }
}

// ── R:R calculator ────────────────────────────────────────────────────────────

function calcRR(entryPrice, side, tpPct, slPct) {
  const dir  = side === 'YES' ? 1 : -1;
  const tp   = Math.min(0.98, entryPrice + dir * entryPrice * tpPct);
  const sl   = Math.max(0.02, entryPrice - dir * entryPrice * slPct);
  const gain = Math.abs(tp - entryPrice);
  const risk = Math.abs(entryPrice - sl);
  return {
    tpPrice: tp,
    slPrice: sl,
    gainPct: (tpPct * 100).toFixed(1) + '%',
    riskPct: (slPct * 100).toFixed(1) + '%',
    rrRatio: risk > 0 ? (gain / risk).toFixed(2) : '∞',
  };
}

module.exports = { PositionMonitor, calcRR };
