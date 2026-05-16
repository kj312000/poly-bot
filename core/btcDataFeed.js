'use strict';

/**
 * BtcDataFeed — real-time Binance WebSocket feed + microstructure math engine.
 *
 * Streams:
 *   btcusdt@aggTrade      — every trade tick   (~50–200ms)
 *   btcusdt@kline_1m      — 1m candle updates  (every ~500ms while open)
 *   btcusdt@depth20@100ms — top-20 orderbook   (every 100ms)
 *
 * All computation is pure math — no external API calls during getMetrics().
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

// ── Constants ──────────────────────────────────────────────────────────────────

const WS_ENDPOINT = 'wss://stream.binance.com:9443/stream?streams=' +
  'btcusdt@aggTrade/btcusdt@kline_1m/btcusdt@depth20@100ms';

const TICK_HISTORY   = 600;   // max trade ticks kept
const PRICE_HISTORY  = 120;   // price snapshots (one per tick batch)
const VOL_EMA_PERIOD = 20;    // candles for volume EMA
const RECONNECT_MS   = 3000;
const MAX_RECONNECTS = 50;     // hard cap — if endpoint is permanently down, stop retrying
const WARMUP_SNAPS   = 15;     // min price snapshots before signals are valid post-reconnect

// ── BtcDataFeed ───────────────────────────────────────────────────────────────

class BtcDataFeed extends EventEmitter {
  constructor() {
    super();
    this._ws                 = null;
    this._reconnects         = 0;
    this._stopped            = false;
    this.connected           = false;
    this._lastSignalEmitTs   = 0;
    this._lastEvalEmitTs     = 0;
    this._signalCooldownMs   = 10000;  // min 10s between signal events

    // ── Live state ─────────────────────────────────────────────────────────────
    this.price        = null;          // latest trade price
    this.priceSnaps   = [];            // [{ price, ts }]  rolling 120-entry window
    this.trades       = [];            // recent aggTrades  [{ p, q, m, ts }]

    this.candle       = null;          // current open 1m candle
    this.closedCandles= [];            // last 20 completed 1m candles

    this.bids         = [];            // [[price_str, qty_str], ...]
    this.asks         = [];

    this._volEma      = null;          // EMA of per-candle volume
    this._lastSnapTs  = 0;             // throttle snapshots

    // ── VWAP ──────────────────────────────────────────────────────────────────
    this._vwapNum     = 0;             // sum(price * qty) since session start
    this._vwapDen     = 0;             // sum(qty) since session start
    this.vwap         = null;

    // ── Cumulative delta ──────────────────────────────────────────────────────
    this._cumDelta    = 0;             // running (buyVol - sellVol) since session start
    this._cdSnaps     = [];            // [{ cd, price, ts }] rolling 120-entry

    // ── Signal threshold (configurable) ──────────────────────────────────────
    this._signalThreshold = 65;
    this._warmedUp        = false;   // suppresses signals until enough history collected post-connect
  }

  setSignalThreshold(n) {
    this._signalThreshold = Math.max(1, Math.min(100, n));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  start() {
    if (this._stopped) return;
    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._ws) { try { this._ws.close(); } catch {} }
  }

  _connect() {
    if (this._stopped) return;
    const ws = new WebSocket(WS_ENDPOINT);
    this._ws = ws;

    ws.on('open', () => {
      this.connected   = true;
      this._reconnects = 0;
      // Full state reset — stale pre-disconnect history produces invalid RSI/EMA/VWAP signals
      this._vwapNum      = 0;
      this._vwapDen      = 0;
      this.vwap          = null;
      this._cumDelta     = 0;
      this._cdSnaps      = [];
      this.priceSnaps    = [];
      this.trades        = [];
      this.closedCandles = [];
      this._volEma       = null;
      this._warmedUp     = false;
      this.emit('connected');
    });

    ws.on('message', data => {
      try { this._handle(JSON.parse(data)); } catch {}
    });

    ws.on('close', () => {
      this.connected = false;
      this.emit('disconnected');
      if (!this._stopped && this._reconnects < MAX_RECONNECTS) {
        this._reconnects++;
        setTimeout(() => this._connect(), RECONNECT_MS);
      }
    });

    ws.on('error', () => {}); // handled by close
  }

  // ── Message handler ────────────────────────────────────────────────────────

  _handle(msg) {
    const { stream, data } = msg;
    if (!stream || !data) return;

    if (stream.includes('aggTrade')) this._onTrade(data);
    else if (stream.includes('kline'))  this._onKline(data);
    else if (stream.includes('depth'))  this._onDepth(data);
  }

  _onTrade(d) {
    this.price    = parseFloat(d.p);
    const qty     = parseFloat(d.q);
    this.trades.push({ p: this.price, q: qty, m: d.m, ts: d.T });
    if (this.trades.length > TICK_HISTORY) this.trades.shift();

    // VWAP — accumulate every tick
    this._vwapNum += this.price * qty;
    this._vwapDen += qty;
    this.vwap      = this._vwapDen > 0 ? this._vwapNum / this._vwapDen : null;

    // Cumulative delta — m=false means aggressive buy, m=true means aggressive sell
    this._cumDelta += d.m ? -qty : qty;

    const now = Date.now();
    if (now - this._lastSnapTs >= 1000) {
      this.priceSnaps.push({ price: this.price, ts: now });
      if (this.priceSnaps.length > PRICE_HISTORY) this.priceSnaps.shift();
      this._cdSnaps.push({ cd: this._cumDelta, price: this.price, ts: now });
      if (this._cdSnaps.length > PRICE_HISTORY) this._cdSnaps.shift();
      this._lastSnapTs = now;
      // Mark warmed-up once we have enough history for valid indicator calculations
      if (!this._warmedUp && this.priceSnaps.length >= WARMUP_SNAPS) {
        this._warmedUp = true;
      }
    }

    // Fast-path signal check — compute metrics, emit 'evaluated' every 5s for tick logging,
    // emit 'signal' when confidence >= signalThreshold (with cooldown to prevent flooding).
    if (now - this._lastSnapTs >= 0) {  // runs every trade tick
      const m = this.getMetrics();
      if (!m) return;

      // Emit 'evaluated' every ~5s for tick log (throttled)
      if (now - this._lastEvalEmitTs >= 5000) {
        this._lastEvalEmitTs = now;
        this.emit('evaluated', m);
      }

      // Emit 'signal' only when high confidence + cooldown elapsed
      if (m.signal !== 'NO TRADE' && m.confidence >= this._signalThreshold &&
          now - this._lastSignalEmitTs >= this._signalCooldownMs) {
        this._lastSignalEmitTs = now;
        this.emit('signal', m);
      }
    }
  }

  _onKline(d) {
    const k = d.k;
    const candle = {
      t:      k.t,                      // open time
      o:      parseFloat(k.o),
      h:      parseFloat(k.h),
      l:      parseFloat(k.l),
      c:      parseFloat(k.c),
      v:      parseFloat(k.v),
      closed: k.x,
    };
    this.candle = candle;

    if (k.x) {
      // Update volume EMA with completed candle
      const alpha = 2 / (VOL_EMA_PERIOD + 1);
      this._volEma = this._volEma == null
        ? candle.v
        : alpha * candle.v + (1 - alpha) * this._volEma;

      this.closedCandles.push({ ...candle, volEmaAtClose: this._volEma });
      if (this.closedCandles.length > 50) this.closedCandles.shift();
    }
  }

  _onDepth(d) {
    this.bids = d.bids || [];   // already sorted best-first by Binance
    this.asks = d.asks || [];
  }

  // ── Math engine ───────────────────────────────────────────────────────────────
  // getMetrics() — call this each trading cycle. Pure computation, zero I/O.

  getMetrics() {
    if (!this.price || !this.connected || !this._warmedUp) return null;

    const now = Date.now();

    // 1. Velocity ──────────────────────────────────────────────────────────────
    const v15  = this._velocity(15000, now);
    const v30  = this._velocity(30000, now);
    const v60  = this._velocity(60000, now);
    const vScore = v30 * 0.5 + v60 * 0.3 + v15 * 0.2;   // weighted composite

    // 2. Buy / sell pressure (last 30 s of trades) ─────────────────────────────
    const cutoff = now - 30000;
    const recent = this.trades.filter(t => t.ts >= cutoff);
    let buyVol = 0, sellVol = 0;
    for (const t of recent) {
      if (t.m) sellVol += t.q;   // m=true → buyer was maker → taker sold
      else      buyVol  += t.q;   // m=false → buyer was taker → someone bought aggressively
    }
    const totalVol  = buyVol + sellVol;
    const pressure  = totalVol > 0 ? (buyVol - sellVol) / totalVol : 0;  // -1 → +1
    const tradeFreq = recent.length;                                       // trades/30s

    // 3. Volume expansion ──────────────────────────────────────────────────────
    const curVol   = this.candle?.v || 0;
    const volRatio = this._volEma && this._volEma > 0 ? curVol / this._volEma : 1;

    // 4. Orderbook imbalance ───────────────────────────────────────────────────
    const { obImbalance, bidDepth, askDepth, spread, spreadBps } = this._calcOrderbook();

    // 5. Candle structure ──────────────────────────────────────────────────────
    const c      = this.candle;
    const body   = c ? Math.abs(c.c - c.o) : 0;
    const range  = c ? (c.h - c.l) : 0;
    const bodyRatio = range > 0 ? body / range : 0;        // 1 = full body, low = wick-dominated
    const candleDir = c ? (c.c > c.o ? 1 : c.c < c.o ? -1 : 0) : 0;
    const upperWick = c ? c.h - Math.max(c.o, c.c) : 0;
    const lowerWick = c ? Math.min(c.o, c.c) - c.l : 0;

    // 6. Volatility (rolling std-dev of price snaps) ───────────────────────────
    const { stdDev, zScore } = this._calcVolatility();

    // 7. Momentum continuation (same direction last 3 snaps) ──────────────────
    const continuation = this._calcContinuation();

    // 8. EMA crossover (fast 5 vs slow 20 on price snaps) ─────────────────────
    const ema5  = this._ema(this.priceSnaps.map(s => s.price), 5);
    const ema20 = this._ema(this.priceSnaps.map(s => s.price), 20);
    const emaCross = ema5 !== null && ema20 !== null ? ema5 - ema20 : 0;

    // 9. Exhaustion detector (extended candle + high wick) ────────────────────
    const lastClosed = this.closedCandles[this.closedCandles.length - 1];
    const prevClosed = this.closedCandles[this.closedCandles.length - 2];
    const exhausted  = lastClosed && prevClosed
      ? (body / Math.max(range, 0.01) < 0.3)   // wick-heavy = potential exhaustion
      : false;

    // ── Composite signal score ─────────────────────────────────────────────────
    // Each component capped to its max contribution.
    // Direction determined by velocity sign.

    const dir = vScore > 0 ? 1 : vScore < 0 ? -1 : 0;
    if (dir === 0) return { ...this._base(now), signal: 'NO TRADE', confidence: 0, dir: 0 };

    // Score each factor aligned with direction
    const s_velocity  = cap(Math.abs(vScore)  / 0.40, 0, 1) * 35;  // 35 pts at 0.40% move
    const s_pressure  = cap(dir * pressure,     0, 1) * 20;         // 20 pts for aligned pressure
    const s_volume    = cap((volRatio - 1.0) / 1.5, 0, 1) * 15;    // 15 pts at 2.5x volume
    const s_obimbal   = cap(dir * obImbalance,  0, 1) * 15;         // 15 pts for aligned OB
    const s_candle    = dir === candleDir ? cap(bodyRatio, 0, 1) * 10 : 0;  // 10 pts clean candle
    const s_cont      = continuation === dir ? 5 : continuation !== 0 ? -5 : 0; // ±5 pts
    const s_ema       = dir * emaCross > 0 ? 5 : 0;                 // 5 pts ema aligned

    // ── VWAP bias ────────────────────────────────────────────────────────────
    let s_vwap = 0;
    if (this.vwap && this.vwap > 0) {
      const vwapBias = (this.price - this.vwap) / this.vwap;
      s_vwap = dir * vwapBias > 0 ? 8 : -5;   // +8 price on right side of VWAP, -5 against
    }

    // ── RSI ─────────────────────────────────────────────────────────────────
    const rsi    = this._calcRsi(14);
    let s_rsi    = 0;
    if (rsi !== null) {
      if (dir === 1)  s_rsi = rsi > 75 ? -10 : rsi < 30 ? -10 : rsi >= 45 && rsi <= 70 ? 8 : 0;
      if (dir === -1) s_rsi = rsi < 25 ? -10 : rsi > 70 ? -10 : rsi >= 30 && rsi <= 55 ? 8 : 0;
    }

    // ── Cumulative delta divergence ──────────────────────────────────────────
    const { s_delta, cdDir } = this._calcCumDeltaScore(dir);

    // Penalties
    const p_exhausted = exhausted ? -15 : 0;
    const p_wicks     = dir === 1 && upperWick > body * 2 ? -10
                       : dir === -1 && lowerWick > body * 2 ? -10 : 0;
    const p_spread    = spreadBps > 30 ? -15 : spreadBps > 15 ? -7 : 0;

    const rawConf = s_velocity + s_pressure + s_volume + s_obimbal + s_candle + s_cont + s_ema
                  + s_vwap + s_rsi + s_delta
                  + p_exhausted + p_wicks + p_spread;
    const confidence = Math.round(cap(rawConf, 0, 100));

    return {
      ...this._base(now),
      dir,
      signal:       confidence >= this._signalThreshold ? (dir === 1 ? 'LONG' : 'SHORT') : 'NO TRADE',
      confidence,
      vwap:         this.vwap,
      rsi,
      cumDelta:     this._cumDelta,
      cdDir,

      // Velocity
      v15, v30, v60, vScore,

      // Pressure
      pressure, buyVol, sellVol, tradeFreq,

      // Volume
      volRatio, curVol, volEma: this._volEma,

      // Orderbook
      obImbalance, bidDepth, askDepth, spread, spreadBps,

      // Candle
      bodyRatio, candleDir, upperWick, lowerWick, exhausted,

      // Volatility
      stdDev, zScore, emaCross,

      // Score breakdown (for UI)
      scoreBreakdown: {
        velocity:   s_velocity.toFixed(1),
        pressure:   s_pressure.toFixed(1),
        volume:     s_volume.toFixed(1),
        orderbook:  s_obimbal.toFixed(1),
        candle:     s_candle.toFixed(1),
        vwap:       s_vwap.toFixed(1),
        rsi:        s_rsi.toFixed(1),
        delta:      s_delta.toFixed(1),
        penalties:  (p_exhausted + p_wicks + p_spread).toFixed(1),
        total:      rawConf.toFixed(1),
      },
    };
  }

  // ── RSI (Wilder's, period-bar simple approximation from price snaps) ─────────

  _calcRsi(period) {
    const prices = this.priceSnaps.slice(-(period + 1)).map(s => s.price);
    if (prices.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i < prices.length; i++) {
      const d = prices[i] - prices[i - 1];
      if (d > 0) gains  += d;
      else       losses -= d;
    }
    const avgGain = gains  / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
  }

  // ── Cumulative delta divergence ───────────────────────────────────────────────
  // Compares delta direction to price direction over the last ~30 snaps.
  // Divergence (delta opposes price move) is a leading exhaustion signal.

  _calcCumDeltaScore(dir) {
    if (this._cdSnaps.length < 10) return { s_delta: 0, cdDir: 0 };
    const old    = this._cdSnaps[Math.max(0, this._cdSnaps.length - 30)];
    const latest = this._cdSnaps[this._cdSnaps.length - 1];
    const deltaMove = latest.cd    - old.cd;
    const priceMove = latest.price - old.price;
    const cdDir     = Math.sign(deltaMove);

    // Aligned: delta moves same direction as price → genuine buying/selling pressure
    // Divergence: delta opposes price move → suspect move, potential reversal
    const aligned   = Math.sign(priceMove) === cdDir && cdDir !== 0;
    const diverging = Math.sign(priceMove) !== cdDir && cdDir !== 0 && priceMove !== 0;

    let s_delta = 0;
    if (aligned   && cdDir === dir)  s_delta =  10;
    if (diverging && cdDir !== dir)  s_delta = -15;

    return { s_delta, cdDir };
  }

  // ── Math helpers ──────────────────────────────────────────────────────────────

  _velocity(windowMs, now) {
    if (this.priceSnaps.length < 2) return 0;
    const ref = this.priceSnaps.find(s => s.ts >= now - windowMs);
    if (!ref || ref.price === 0) return 0;
    return (this.price - ref.price) / ref.price * 100;
  }

  _calcOrderbook() {
    let bidDepth = 0, askDepth = 0;
    for (const [, q] of this.bids.slice(0, 10)) bidDepth += parseFloat(q);
    for (const [, q] of this.asks.slice(0, 10)) askDepth += parseFloat(q);
    const tot      = bidDepth + askDepth;
    const obImbalance = tot > 0 ? (bidDepth - askDepth) / tot : 0;

    let spread = 0, spreadBps = 0;
    if (this.bids.length && this.asks.length) {
      const bestBid = parseFloat(this.bids[0][0]);
      const bestAsk = parseFloat(this.asks[0][0]);
      spread    = bestAsk - bestBid;
      spreadBps = this.price > 0 ? (spread / this.price) * 10000 : 0;
    }
    return { obImbalance, bidDepth, askDepth, spread, spreadBps };
  }

  _calcVolatility() {
    if (this.priceSnaps.length < 5) return { stdDev: 0, zScore: 0 };
    const prices = this.priceSnaps.slice(-30).map(s => s.price);
    const mean   = prices.reduce((s, p) => s + p, 0) / prices.length;
    const stdDev = Math.sqrt(prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length);
    const zScore = stdDev > 0 ? (this.price - mean) / stdDev : 0;
    return { stdDev, zScore };
  }

  _calcContinuation() {
    if (this.priceSnaps.length < 4) return 0;
    const last = this.priceSnaps.slice(-4);
    const moves = last.slice(1).map((s, i) => Math.sign(s.price - last[i].price));
    // All same direction = strong continuation
    if (moves.every(m => m === 1))  return 1;
    if (moves.every(m => m === -1)) return -1;
    return 0;
  }

  _ema(prices, period) {
    if (prices.length < period) return null;
    const alpha = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((s, p) => s + p, 0) / period;
    for (const p of prices.slice(period)) ema = alpha * p + (1 - alpha) * ema;
    return ema;
  }

  _base(now) {
    return {
      price:     this.price,
      ts:        now,
      connected: this.connected,
    };
  }
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function cap(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance = null;

module.exports = {
  getInstance() {
    if (!_instance) _instance = new BtcDataFeed();
    return _instance;
  },
  BtcDataFeed,
};
