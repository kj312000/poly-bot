'use strict';

/**
 * FastExecutor — event-driven order execution for btcScalp.
 *
 * Listens directly to BtcDataFeed 'signal' events and places orders
 * in <5ms of signal detection (no poll cycle delay).
 *
 * Flow:
 *   BtcDataFeed WebSocket tick
 *     → _onTrade() computes confidence
 *       → emits 'signal' event (if conf >= 65)
 *         → FastExecutor.handle()
 *           → validate (sync, <1ms)
 *             → placeOrder() via keepAlive HTTP
 *               → update coordinator state callback
 *
 * Total latency from signal to HTTP request: ~1–3ms
 */

const { getInstance: getFeed }        = require('./btcDataFeed');
const { appendJsonl }                 = require('../shared/dataStore');
const { ORDER_STATES }                = require('../db/orderStore');
const { PositionMonitor, calcRR }     = require('./positionMonitor');
const { TradeAnalyzer }               = require('./tradeAnalyzer');
const { ClaudeAdvisor }               = require('./claudeAdvisor');
const { getInstance: getTelegram }    = require('./telegramNotifier');
const { LocalOrderbook }              = require('./localOrderbook');

const MAX_LOSSES       = 3;
const COOLDOWN_MS      = 15000;   // min time between consecutive btcScalp orders
const MAX_INFLIGHT     = 1;       // only one open btcScalp order at a time
const ORDER_TIMEOUT_MS = 5000;    // auto-clear inflight if no response in 5s
const DEFAULT_OB_WAIT_MS = 2500;   // keep signals fresh; do not chase stale books
const DEFAULT_OB_POLL_MS = 250;
const DEFAULT_OB_MAX_SLIPPAGE = 0.03;
const DEFAULT_OB_MIN_FILL_SIZE = 1;

class FastExecutor {
  /**
   * @param {object} opts
   * @param {object}   opts.marketApi      — PolymarketRestAdapter (live) or null (paper)
   * @param {object}   opts.positionBook
   * @param {object}   opts.orderStore
   * @param {object}   opts.config
   * @param {string}   opts.logPath
   * @param {function} opts.onTrade        — called with finalised trade object
   * @param {function} opts.onLog
   */
  constructor({ marketApi, clobClient, positionBook, orderStore, config, logPath, polymarketWs, onTrade, onLog }) {
    this.marketApi    = marketApi;
    this.clobClient   = clobClient || null;   // @polymarket/clob-client-v2 instance for signed orders
    this.positionBook = positionBook;
    this.orderStore   = orderStore;
    this.config       = config;
    this.logPath      = logPath;
    this.onTrade      = onTrade || (() => {});
    this.onLog        = onLog   || (() => {});

    this._inflight          = 0;
    this._consecutiveLosses = 0;
    this._sessionStopped    = false;
    this._lastOrderTs       = 0;
    this._currentMarkets    = [];
    this._tokenIdCache      = new Map();  // conditionId → { yes, no }
    this._dryRun            = !!config.dryRun;  // runtime-toggleable test mode
    this._polymarketWs      = polymarketWs || null;
    this._localBooks        = new Map();  // tokenId → LocalOrderbook (WS-maintained, zero-latency)
    this._Side              = null;       // cached Side constant from clob-client-v2

    // Performance analysis + 100-tick counterfactual
    this._analyzer = new TradeAnalyzer((batch100) => {
      // Called automatically when 100 ticks accumulate
      this._advisor.analyzeCounterfactual(batch100, this.config)
        .catch(e => onLog(`[cf] ${e.message}`));
    });

    this._advisor = new ClaudeAdvisor({
      onLog,
      onRecommendation: (rec) => {
        if (typeof this._onAdvisory === 'function') this._onAdvisory(rec);
      },
      onCounterfactual: (cf) => {
        if (typeof this._onCounterfactual === 'function') this._onCounterfactual(cf);
      },
    });

    // Position monitor — enforces TP/SL automatically
    this._monitor = new PositionMonitor({
      marketApi,
      clobClient:   clobClient || null,
      positionBook,
      config,
      polymarketWs: polymarketWs || null,
      onLog,
      onClose: (closeResult) => {
        if (closeResult.pnl > 0)  this._consecutiveLosses = 0;
        if (closeResult.pnl < 0)  this._consecutiveLosses++;
        if (this._consecutiveLosses >= MAX_LOSSES) {
          this._sessionStopped = true;
          onLog('[fastExec] 3 consecutive losses — session halted');
        }

        // Log to analyzer + trigger advisory check
        this._analyzer.logTradeClose(closeResult);
        this._advisor.onTradeClosed(this._analyzer, this.config);

        onTrade({ ...closeResult, agent: 'btcScalp', isClose: true });
      },
    });
  }

  // Called by the trading loop each cycle with the latest fetched markets
  updateMarkets(markets) {
    this._currentMarkets = markets;
  }

  setAdvisoryCallback(fn)       { this._onAdvisory       = fn; }
  setCounterfactualCallback(fn) { this._onCounterfactual = fn; }
  setAdvisorEnabled(bool)       { this._advisor.setEnabled(bool); }
  isAdvisorEnabled()            { return this._advisor.enabled; }
  setDryRun(bool)               { this._dryRun = !!bool; this.onLog(`[fastExec] dryRun=${this._dryRun}`); }
  isDryRun()                    { return this._dryRun; }

  getLatestAdvisory()    { return this._advisor.latest; }
  getLatestCf()          { return this._advisor.latestCf; }
  getBufferProgress()    { return this._analyzer.bufferProgress(); }

  async triggerAnalysis() {
    return this._advisor.analyzeNow(this._analyzer, this.config);
  }

  async triggerCounterfactual() {
    // Manually flush current buffer to Claude (even if < 100 ticks)
    const buf = this._analyzer._tickBuffer;
    if (!buf.length) return { ok: false, error: 'No ticks collected yet' };
    const result = await this._advisor.analyzeCounterfactual([...buf], this.config);
    return result ? { ok: true, result } : { ok: false, error: 'Analysis failed' };
  }

  async start() {
    // Cache Side constant before any signal fires — eliminates dynamic import from hot path
    try {
      const mod = await import('@polymarket/clob-client-v2');
      this._Side = mod.Side;
    } catch (e) {
      this.onLog(`[fastExec] Side constant unavailable: ${e.message}`);
    }

    // Pre-resolve target market token IDs + subscribe local WS orderbooks
    await this._preloadTargetMarket();

    const feed = getFeed();
    feed.on('signal',    metrics => this._onSignal(metrics));
    // 'evaluated' fires every ~5s regardless of signal — feeds the 100-tick buffer
    feed.on('evaluated', metrics => this._logTick(metrics, 'evaluated'));
    this._monitor.start();
    this.onLog('[fastExec] Listening for BTC signals + logging every tick');
  }

  stop() {
    getFeed().removeAllListeners('signal');
    this._monitor.stop();
    this._inflight = 0;
    this.onLog('[fastExec] Stopped');
  }

  // ── Startup preloading ────────────────────────────────────────────────────────

  async _preloadTargetMarket() {
    if (!this.marketApi) return;
    try {
      const market = await this.marketApi.fetchBtc5mMarket();
      if (!market) { this.onLog('[fastExec] Preload: BTC 5m market unavailable'); return; }
      if (!this._currentMarkets.length) this._currentMarkets = [market];

      // Pre-resolve token IDs now — eliminates CLOB API HTTP call on first signal
      const yesId = await this._resolveTokenId(market, 'YES');
      const noId  = await this._resolveTokenId(market, 'NO');
      this.onLog(`[fastExec] Preloaded YES=${yesId?.slice(0,12)}... NO=${noId?.slice(0,12)}...`);

      // Subscribe WS orderbooks so quote selection is zero-latency at signal time
      if (this._polymarketWs) {
        if (yesId) this._subscribeLocalBook(yesId);
        if (noId && noId !== yesId) this._subscribeLocalBook(noId);
      }
    } catch (e) {
      this.onLog(`[fastExec] Preload failed (non-fatal): ${e.message}`);
    }
  }

  _subscribeLocalBook(tokenId) {
    const book = new LocalOrderbook(tokenId);
    this._localBooks.set(tokenId, book);

    this._polymarketWs.subscribe(tokenId);

    this._polymarketWs.on('orderBook', (data) => {
      if (data.assetId === tokenId) book.update(data);
    });
    this._polymarketWs.on('priceChange', (data) => {
      if (data.assetId === tokenId) book.onPriceChange(data);
    });

    this.onLog(`[fastExec] Local WS orderbook subscribed for ${tokenId.slice(0, 16)}...`);
  }

  resetSession() {
    this._consecutiveLosses = 0;
    this._sessionStopped    = false;
    this._inflight          = 0;
    this._lastOrderTs       = 0;
    this._tokenIdCache.clear();
    this._monitor.stop();
    this._monitor.start();
  }

  // ── Tick logger — records every evaluation regardless of signal ─────────────

  _logTick(metrics, action, reason = '') {
    this._analyzer.logTick({
      ts:         Date.now(),
      btcPrice:   metrics.price,
      v15:        metrics.v15,
      v30:        metrics.v30,
      v60:        metrics.v60,
      pressure:   metrics.pressure,
      volRatio:   metrics.volRatio,
      obImbalance:metrics.obImbalance,
      spreadBps:  metrics.spreadBps,
      zScore:     metrics.zScore,
      confidence: metrics.confidence,
      signal:     metrics.signal,
      scoreBreakdown: metrics.scoreBreakdown,
      action,
      reason,
    });
  }

  // ── Signal handler — runs every time feed emits a signal ───────────────────

  async _onSignal(metrics) {
    const now = Date.now();

    // Log every signal event for analysis
    this._logTick(metrics, 'signal_fired');

    // Guards — log reason for skipping
    if (this._sessionStopped)                  { this._logTick(metrics, 'skipped', 'session_stopped'); return; }
    if (this._consecutiveLosses >= MAX_LOSSES) { this._sessionStopped = true; this._logTick(metrics, 'skipped', 'max_losses'); return; }
    if (this._inflight >= MAX_INFLIGHT)        { this._logTick(metrics, 'skipped', 'inflight'); return; }
    if (now - this._lastOrderTs < COOLDOWN_MS) {
      this._logTick(metrics, 'skipped', `cooldown_${Math.round((COOLDOWN_MS - (now - this._lastOrderTs)) / 1000)}s`);
      this.onLog(`[fastExec] Signal conf=${metrics.confidence} skipped — cooldown ${Math.round((COOLDOWN_MS - (now - this._lastOrderTs)) / 1000)}s remaining`);
      return;
    }
    // If market list is empty, do a one-shot fetch of the BTC 5m market
    if (!this._currentMarkets.length && this.marketApi) {
      this.onLog(`[fastExec] No market loaded — fetching BTC 5m inline`);
      try {
        const m = await this.marketApi.fetchBtc5mMarket();
        if (m) this._currentMarkets = [m];
      } catch (e) {
        this.onLog(`[fastExec] BTC 5m fetch failed: ${e.message}`);
        return;
      }
    }

    const target = this._currentMarkets[0];
    if (!target) {
      this.onLog(`[fastExec] Signal conf=${metrics.confidence} skipped — BTC 5m market unavailable`);
      return;
    }

    // Block if a position is already open for this market — no opposite-side hedging
    if (this.positionBook) {
      const open = this.positionBook.getOpen().find(p => p.marketId === target.id);
      if (open) {
        this.onLog(`[fastExec] Signal skipped — ${open.side} position already open for this market`);
        return;
      }
    }
    // Signal staleness check — reject signals that aged in the event loop queue
    const signalAge = Date.now() - metrics.ts;
    const maxSignalAge = this.config.max_signal_age_ms || 500;
    if (signalAge > maxSignalAge) {
      this._logTick(metrics, 'skipped', `stale_${signalAge}ms`);
      this.onLog(`[fastExec] Signal skipped — age ${signalAge}ms > max ${maxSignalAge}ms`);
      return;
    }

    // BTC price reversal check — abort if BTC moved against signal direction since emission
    const btcFeed = getFeed();
    if (btcFeed.price && metrics.price > 0) {
      const btcSlipBps = (btcFeed.price - metrics.price) / metrics.price * 10000;
      if (Math.sign(btcSlipBps) === -metrics.dir && Math.abs(btcSlipBps) > 20) {
        this._logTick(metrics, 'skipped', `btc_reversed_${btcSlipBps.toFixed(1)}bps`);
        this.onLog(`[fastExec] Signal skipped — BTC reversed ${btcSlipBps.toFixed(1)}bps since emission`);
        return;
      }
    }

    // Refresh market data at signal time — ensures current window tokens and live prices.
    // The 5m market window rotates every 300s; main loop refreshes every 5s but can lag.
    if (this.marketApi) {
      try {
        const fresh = await this.marketApi.fetchBtc5mMarket();
        if (fresh) {
          const oldId = this._currentMarkets[0]?.id;
          this._currentMarkets = [fresh];
          // New market window — subscribe WS orderbooks for new tokens
          if (fresh.id !== oldId && this._polymarketWs) {
            const yesId = await this._resolveTokenId(fresh, 'YES');
            const noId  = await this._resolveTokenId(fresh, 'NO');
            if (yesId && !this._localBooks.has(yesId)) this._subscribeLocalBook(yesId);
            if (noId && noId !== yesId && !this._localBooks.has(noId)) this._subscribeLocalBook(noId);
          }
        }
      } catch (e) {
        this.onLog(`[fastExec] Market refresh failed: ${e.message} — using cached`);
      }
    }

    const side = metrics.signal === 'LONG' ? 'YES' : 'NO';

    // Use aggressive (taker) price to cross the spread and fill immediately:
    //   YES buy → pay the ask
    //   NO  buy → pay the ask for NO token = 1 - bidYes
    const price = side === 'YES'
      ? Math.min(0.99, target.askYes || target.priceYes)
      : Math.min(0.99, 1 - (target.bidYes || 1 - target.priceYes));

    // Capital check
    const notional = Math.min(
      this.config.max_trade_usd || 4,
      (this.config.total_capital || 40) * (this.config.risk_per_trade || 0.05)
    );
    if (notional <= 0) return;

    const size = Math.max(1, Math.floor(notional / Math.max(0.01, price)));

    this._inflight++;
    this._lastOrderTs = now;

    const t0 = Date.now();
    const execMode = this.config.orderbook_taker_enabled === false ? 'direct FAK' : 'orderbook taker';
    this.onLog(`[fastExec] ${metrics.signal} conf=${metrics.confidence} price=${price.toFixed(3)} size=${size} ${execMode} - preparing order`);

    let execResult;
    try {
      execResult = await this._execute({ target, side, price, size, notional, metrics });
    } catch (e) {
      const msg = e.message?.slice(0, 200) || 'unknown error';
      this.onLog(`[fastExec] Order error: ${msg}`);
      execResult = { status: 'error', errorMsg: msg, pnl: 0, mode: this.config.mode };
    } finally {
      // Auto-clear inflight after ORDER_TIMEOUT_MS even if no response
      setTimeout(() => { if (this._inflight > 0) this._inflight--; }, ORDER_TIMEOUT_MS);
      this._inflight = Math.max(0, this._inflight - 1);
    }

    const rtt = Date.now() - t0;
    const entryPrice = execResult.entryPrice || price;
    const finalSize = execResult.filledSize != null ? execResult.filledSize : size;
    const rr  = calcRR(entryPrice, side, this.config.take_profit_pct || 0.20, this.config.stop_loss_pct || 0.08);
    this.onLog(`[fastExec] Executed in ${rtt}ms | R:R=${rr.rrRatio} TP=${rr.tpPrice.toFixed(3)} SL=${rr.slPrice.toFixed(3)}`);

    const finalTrade = {
      agent:       'btcScalp',
      marketId:    target.id,
      side,
      price:       entryPrice,
      size:        finalSize,
      notional:    entryPrice * finalSize,
      ev:          metrics.confidence / 100 * 0.1,
      confidence:  metrics.confidence / 100,
      probability: metrics.dir === 1 ? 0.72 : 0.28,
      timestamp:   now,
      tpPrice:  rr.tpPrice,
      slPrice:  rr.slPrice,
      rrRatio:  rr.rrRatio,
      dryRun:   this._dryRun,
      microstructure: {
        btcPrice:   metrics.price,
        v30s:       metrics.v30.toFixed(4) + '%',
        confidence: metrics.confidence,
        signal:     metrics.signal,
        scoreBreakdown: metrics.scoreBreakdown,
      },
      ...execResult,
    };

    // Register with position monitor for TP/SL enforcement.
    // Skip in pure paper mode — _simulatePaper already opened+closed the position.
    const skipMonitor = execResult.status === 'error'
                     || execResult.status === 'fok_canceled'
                     || (execResult.mode === 'paper');
    if (!skipMonitor) {
      const trackedSize = execResult.filledSize || size;
      // CRITICAL: use the positionBook's own id so closePosition() succeeds.
      // Fall back to tradeId only if openPosition wasn't called (shouldn't happen).
      const monitorId = execResult.positionId || execResult.tradeId;
      this._monitor.track(monitorId, {
        side, price: entryPrice, size: trackedSize, notional: trackedSize * entryPrice,
        entryPrice,
        marketId:   target.id,
        tokenId:    execResult.tokenId || (side === 'YES' ? target.tokenIds?.[0] : target.tokenIds?.[1]) || target.id,
        agent:      'btcScalp',
        mode:       this.config.mode || 'paper',
        dryRun:     !!execResult.dryRun,
        // Smart-exit anchors:
        entryDir:      metrics.dir,           // +1 LONG, -1 SHORT — used for BTC-reversal detection
        entryBtcPrice: metrics.price,         // BTC spot at entry — used for lag-closed detection
      });
    }

    // Update consecutive loss tracking
    if (finalTrade.pnl < 0) {
      this._consecutiveLosses++;
      if (this._consecutiveLosses >= MAX_LOSSES) {
        this._sessionStopped = true;
        this.onLog('[fastExec] 3 consecutive losses — session halted');
      }
    } else if (finalTrade.pnl > 0) {
      this._consecutiveLosses = 0;
    }

    // Telegram notification
    const tg = getTelegram();
    if (finalTrade.status === 'error') {
      tg.tradeError(finalTrade, finalTrade.errorMsg);
    } else if (finalTrade.status !== 'fok_canceled') {
      tg.tradeOpened(finalTrade);
    }

    if (this.logPath) appendJsonl(this.logPath, finalTrade);
    this.onTrade(finalTrade);
  }

  // ── Execution ──────────────────────────────────────────────────────────────

  async _execute({ target, side, price, size, notional, metrics }) {
    const mode = this.config.mode;

    // Dry-run: real data + signal + Polymarket prices for TP/SL, but no order placed.
    if (this._dryRun && mode === 'live' && this.marketApi) {
      return this._executeDryRun({ target, side, price, size, notional });
    }
    if (mode === 'live' && this.marketApi) {
      return this._executeLive({ target, side, price, size, notional });
    }
    return this._simulatePaper({ side, price, size, notional, metrics });
  }

  // ── Dry-run path ───────────────────────────────────────────────────────────
  // Opens a position in the book at the would-be entry price, returns a sim
  // tradeId, and lets PositionMonitor track P&L using real Polymarket prices.
  // No CLOB order is submitted at entry or exit.

  async _executeDryRun({ target, side, price, size, notional }) {
    const tokenID = await this._resolveTokenId(target, side);
    if (!tokenID) throw new Error(`No tokenId for market ${target.id} — cannot price-track dry-run`);

    const tradeId    = `sim_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    let entryPrice = price;
    let filledSize = size;

    if (this.config.orderbook_taker_enabled !== false) {
      const quote = await this._findBookTakerQuote({
        tokenID,
        orderSide: 'BUY',
        referencePrice: price,
        requestedSize: size,
        maxNotional: notional,
        tickSize: '0.01',
      });

      if (!quote) {
        return {
          tradeId,
          status:     'fok_canceled',
          filledSize: 0,
          tokenId:    tokenID,
          mode:       'live',
          dryRun:     true,
          entryPrice,
          exitPrice:  entryPrice,
          pnl:        0,
        };
      }

      entryPrice = quote.price;
      filledSize = quote.size;
      this.onLog(`[orderbook] [SIM] selected ask=${entryPrice} size=${filledSize}/${size} visible=${quote.visibleSize.toFixed(2)} attempts=${quote.attempts}`);
    }
    let positionId = null;
    if (this.positionBook) {
      const pos = this.positionBook.openPosition({
        marketId: target.id, side, size: filledSize, entryPrice,
        agent: 'btcScalp', tokenId: tokenID,
        metadata: { dryRun: true },
      });
      positionId = pos.id;
    }
    this.onLog(`[order] [SIM] ${side} tokenID=${tokenID.slice(0,16)}... price=${entryPrice} size=${filledSize} - no order submitted`);
    return {
      tradeId,
      status:     'matched',
      filledSize,
      tokenId:    tokenID,
      mode:       'live',           // monitor uses live-price polling
      dryRun:     true,
      positionId,
      entryPrice,
      exitPrice:  entryPrice,
      pnl:        0,
    };
  }

  async _executeLive({ target, side, price, size, notional }) {
    // Prefer ClobClient v2 (handles EIP-712 order signing automatically).
    // Fall back to legacy HMAC-only adapter only if clobClient is unavailable.
    if (this.clobClient) {
      return this._executeLiveClobClient({ target, side, price, size, notional });
    }
    return this._executeLiveLegacy({ target, side, price, size, notional });
  }

  async _executeLiveClobClient({ target, side, price, size, notional }) {
    const tokenID = await this._resolveTokenId(target, side);
    if (!tokenID) throw new Error(`No tokenId found for market ${target.id} — check Gamma/CLOB API response`);

    // Use cached Side constant — resolved at start() to eliminate dynamic import from hot path
    if (!this._Side) throw new Error('Side constant not loaded — await start() before trading');
    const orderSide = this._Side.BUY;  // Always BUY the token — YES to go long, NO to go short

    // Get tick size for this market (default 0.01 if unavailable)
    let tickSize = '0.01';
    let negRisk  = false;
    try {
      const info = await this.clobClient.getClobMarketInfo(target.id);
      tickSize = String(info?.mts || info?.minimum_tick_size || '0.01');
      negRisk  = info?.neg_risk ?? info?.nr ?? false;
    } catch { /* use defaults */ }

    const useBookTaker = this.config.orderbook_taker_enabled !== false;
    let orderPrice = price;
    let orderSize  = size;

    if (useBookTaker) {
      // Try local WS orderbook first — zero latency, no HTTP call
      let quote = null;
      const localBook = this._localBooks.get(tokenID);
      if (localBook && !localBook.isStale(2000)) {
        const result = localBook.selectTakerQuote({
          isBuy:          true,
          requestedSize:  size,
          maxSlippage:    this.config.orderbook_max_price_slippage ?? 0.03,
          referencePrice: price,
          maxNotional:    notional,
          tickSize,
          minFillSize:    this.config.orderbook_min_fill_size ?? 1,
        });
        if (result.quote) {
          quote = { ...result.quote, attempts: 0 };
          this.onLog(`[orderbook] local: ask=${result.quote.price} size=${result.quote.size}/${size} visible=${result.quote.visibleSize.toFixed(2)}`);
        } else {
          this.onLog(`[orderbook] local book thin: ${result.reason} — REST fallback`);
        }
      }

      // REST polling fallback only if local book unavailable or stale
      if (!quote) {
        quote = await this._findBookTakerQuote({
          tokenID, orderSide: 'BUY', referencePrice: price,
          requestedSize: size, maxNotional: notional, tickSize,
        });
        if (quote) {
          this.onLog(`[orderbook] REST fallback: ask=${quote.price} size=${quote.size}/${size} attempts=${quote.attempts}`);
        }
      }

      if (!quote) {
        if (this.orderStore) {
          const rec = this.orderStore.create({ marketId: target.id, tokenId: tokenID, side: orderSide, type: 'FAK', price, size, agent: 'btcScalp' });
          this.orderStore.transition(rec.id, ORDER_STATES.CANCELLED, { metadata: { reason: 'no_nearby_book_liquidity' } });
        }
        return { tradeId: `book_skip_${Date.now()}`, status: 'fok_canceled', filledSize: 0, mode: 'live', tokenId: tokenID, entryPrice: price, exitPrice: price, pnl: 0 };
      }

      orderPrice = quote.price;
      orderSize  = quote.size;
    }

    this.onLog(`[order] ${side} tokenID=${tokenID.slice(0,16)}… price=${orderPrice} size=${orderSize} tick=${tickSize}`);

    // FAK: fills immediately against book, cancels remainder. FOK too strict for thin PM markets.
    const result = await this.clobClient.createAndPostOrder(
      { tokenID, price: orderPrice, size: orderSize, side: orderSide },
      { tickSize, negRisk },
      'FAK'
    );

    if (!result) throw new Error('createAndPostOrder returned null');
    this.onLog(`[order] raw response: ${JSON.stringify(result).slice(0, 200)}`);
    if (result.error) throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error));

    const orderId    = result.orderID || result.id || result.order_id || `live_${Date.now()}`;
    const entryPrice = parseFloat(result.price_matched || result.price || orderPrice);

    // FAK: status='matched' means at least partial fill; 'unmatched' means nothing filled.
    // size_matched holds the actual contracts filled (may be less than requested).
    const rawStatus   = (result.status || '').toLowerCase();
    const sizeMatched = parseFloat(result.size_matched || result.size_filled || 0);
    const wasFilled   = rawStatus === 'matched' && sizeMatched >= 1;

    if (!wasFilled) {
      this.onLog(`[order] FAK not filled (status=${result.status || 'none'} matched=${sizeMatched}) — no position opened`);
      if (this.orderStore) {
        const rec = this.orderStore.create({ marketId: target.id, tokenId: tokenID, side: orderSide, type: 'FAK', price: orderPrice, size: orderSize, agent: 'btcScalp' });
        this.orderStore.transition(rec.id, ORDER_STATES.SUBMITTED);
        this.orderStore.setExternalId(rec.id, orderId);
        this.orderStore.transition(rec.id, ORDER_STATES.CANCELLED);
      }
      return { tradeId: orderId, status: 'fok_canceled', filledSize: 0, mode: 'live', tokenId: tokenID, entryPrice: orderPrice, exitPrice: orderPrice, pnl: 0 };
    }

    // Use actual filled size (FAK may fill less than requested)
    const filledSize = Math.floor(sizeMatched) || orderSize;
    this.onLog(`[order] FAK filled ${filledSize}/${orderSize} @ ${entryPrice}`);

    if (this.orderStore) {
      const rec = this.orderStore.create({ marketId: target.id, tokenId: tokenID, side: orderSide, type: 'FAK', price: orderPrice, size: filledSize, agent: 'btcScalp' });
      this.orderStore.transition(rec.id, ORDER_STATES.SUBMITTED);
      this.orderStore.setExternalId(rec.id, orderId);
    }
    let positionId = null;
    if (this.positionBook) {
      const pos = this.positionBook.openPosition({ marketId: target.id, side, size: filledSize, entryPrice, agent: 'btcScalp', orderId, tokenId: tokenID });
      positionId = pos.id;
    }

    return { tradeId: orderId, status: 'matched', filledSize, tokenId: tokenID, mode: 'live', positionId, entryPrice, exitPrice: entryPrice, pnl: 0 };
  }

  async _findBookTakerQuote({ tokenID, orderSide, referencePrice, requestedSize, maxNotional, tickSize }) {
    const cfg = this.config || {};
    const pollMs = Math.max(50, Number(cfg.orderbook_poll_ms ?? DEFAULT_OB_POLL_MS));
    const maxWaitMs = Math.max(0, Number(cfg.orderbook_max_wait_ms ?? DEFAULT_OB_WAIT_MS));
    const maxSlippage = Math.max(0, Number(cfg.orderbook_max_price_slippage ?? DEFAULT_OB_MAX_SLIPPAGE));
    const minFillSize = Math.max(1, Number(cfg.orderbook_min_fill_size ?? DEFAULT_OB_MIN_FILL_SIZE));

    const isBuy = String(orderSide).toUpperCase() === 'BUY';
    const deadline = Date.now() + maxWaitMs;
    let attempts = 0;
    let lastSummary = 'book unavailable';

    while (true) {
      attempts++;
      try {
        const book = await this._fetchOrderBook(tokenID);
        const selected = this._selectBookTakerQuote(book, {
          isBuy,
          referencePrice,
          requestedSize,
          maxNotional,
          maxSlippage,
          minFillSize,
          tickSize,
        });

        if (selected.quote) return { ...selected.quote, attempts };
        lastSummary = selected.reason;
      } catch (e) {
        lastSummary = e.message || 'book fetch failed';
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await this._sleep(Math.min(pollMs, remainingMs));
    }

    this.onLog(`[orderbook] no nearby ${isBuy ? 'ask' : 'bid'} for ${tokenID.slice(0,16)}... after ${attempts} attempt(s), ref=${referencePrice.toFixed(3)}, maxSlip=${maxSlippage.toFixed(3)} (${lastSummary})`);
    return null;
  }

  async _fetchOrderBook(tokenID) {
    if (this.clobClient?.getOrderBook) return this.clobClient.getOrderBook(tokenID);
    if (this.marketApi?.getOrderBook) return this.marketApi.getOrderBook(tokenID);
    throw new Error('no orderbook client available');
  }

  _selectBookTakerQuote(book, { isBuy, referencePrice, requestedSize, maxNotional, maxSlippage, minFillSize, tickSize }) {
    const levels = this._normaliseBookLevels(isBuy ? book?.asks : book?.bids)
      .sort((a, b) => isBuy ? a.price - b.price : b.price - a.price);

    if (!levels.length) return { quote: null, reason: `empty ${isBuy ? 'asks' : 'bids'}` };

    const best = levels[0];
    const limitPrice = isBuy
      ? Math.min(0.99, referencePrice + maxSlippage)
      : Math.max(0.01, referencePrice - maxSlippage);

    const eligible = levels.filter(level => isBuy ? level.price <= limitPrice : level.price >= limitPrice);
    const visibleSize = eligible.reduce((sum, level) => sum + level.size, 0);
    if (visibleSize < minFillSize) {
      return {
        quote: null,
        reason: `best=${best.price.toFixed(3)} limit=${limitPrice.toFixed(3)} visible=${visibleSize.toFixed(2)}`,
      };
    }

    let cumulative = 0;
    let selectedPrice = eligible[0].price;
    for (const level of eligible) {
      const remaining = requestedSize - cumulative;
      if (remaining <= 0) break;
      cumulative += Math.min(level.size, remaining);
      selectedPrice = level.price;
      if (cumulative >= requestedSize) break;
    }

    const notionalCapSize = maxNotional > 0
      ? Math.floor(maxNotional / Math.max(0.01, selectedPrice))
      : requestedSize;
    const executableSize = Math.floor(Math.min(requestedSize, cumulative, notionalCapSize));
    if (executableSize < minFillSize) {
      return {
        quote: null,
        reason: `available=${cumulative.toFixed(2)} capSize=${notionalCapSize}`,
      };
    }

    const roundedPrice = this._roundPriceToTick(selectedPrice, tickSize, isBuy ? 'up' : 'down');
    return {
      quote: {
        price: roundedPrice,
        size: executableSize,
        visibleSize,
        bestPrice: best.price,
        limitPrice,
      },
      reason: '',
    };
  }

  _normaliseBookLevels(levels) {
    return (levels || [])
      .map(level => {
        if (!level) return { price: NaN, size: NaN };
        const price = parseFloat(level.price ?? level.p ?? level[0]);
        const size = parseFloat(level.size ?? level.s ?? level[1]);
        return { price, size };
      })
      .filter(level => Number.isFinite(level.price)
        && Number.isFinite(level.size)
        && level.price > 0
        && level.price < 1
        && level.size > 0);
  }

  _roundPriceToTick(price, tickSize, mode = 'nearest') {
    const tick = parseFloat(tickSize) || 0.01;
    const units = price / tick;
    const roundedUnits = mode === 'up'
      ? Math.ceil(units - 1e-9)
      : mode === 'down'
        ? Math.floor(units + 1e-9)
        : Math.round(units);
    const decimals = Math.max(2, (String(tickSize).split('.')[1] || '').length);
    const rounded = parseFloat((roundedUnits * tick).toFixed(Math.min(6, decimals)));
    return Math.max(0.01, Math.min(0.99, rounded));
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Resolve the token ID for an order in order of reliability:
   *  1. Cached from a previous lookup
   *  2. tokenIds array on the market object (from fetchMarketsForTrading)
   *  3. _raw field on the market (original Gamma API response)
   *  4. CLOB API fetch as last resort (1 HTTP call, result cached)
   */
  async _resolveTokenId(target, side) {
    const cid = target.id;
    const cached = this._tokenIdCache.get(cid);
    if (cached) return side === 'YES' ? cached.yes : cached.no;

    // Source 2: normalized tokenIds array
    if (target.tokenIds?.length) {
      const yes = target.tokenIds[0];
      const no  = target.tokenIds[1] || target.tokenIds[0];
      this._tokenIdCache.set(cid, { yes, no });
      return side === 'YES' ? yes : no;
    }

    // Source 3: _raw field from Gamma API response
    const raw = target._raw;
    if (raw) {
      const fromTokens  = raw.tokens?.map(t => t.token_id || t.tokenId).filter(Boolean);
      const fromClob    = raw.clobTokenIds?.filter(Boolean);
      const fromOutcomes = raw.outcomes?.map(o => o.tokenId || o.token_id).filter(Boolean);
      const ids = fromTokens || fromClob || fromOutcomes;
      if (ids?.length) {
        this._tokenIdCache.set(cid, { yes: ids[0], no: ids[1] || ids[0] });
        return side === 'YES' ? ids[0] : (ids[1] || ids[0]);
      }
    }

    // Source 4: CLOB API lookup (1 HTTP call)
    if (this.clobClient) {
      try {
        this.onLog(`[order] Fetching token IDs from CLOB for ${cid.slice(0, 20)}…`);
        const info = await this.clobClient.getClobMarketInfo(cid);
        // CLOB returns abbreviated fields: t[] = tokens, t[n].t = tokenId, t[n].o = outcome
        const tokens = info?.t || info?.tokens || [];
        const yes = tokens.find(t => /yes/i.test(t.o || t.outcome));
        const no  = tokens.find(t => /no/i.test(t.o  || t.outcome));
        const yesId = yes?.t || yes?.token_id;
        const noId  = no?.t  || no?.token_id  || yesId;
        if (yesId) {
          this._tokenIdCache.set(cid, { yes: yesId, no: noId });
          this.onLog(`[order] Cached token IDs — YES: ${yesId.slice(0,12)}…`);
          return side === 'YES' ? yesId : noId;
        }
      } catch (e) {
        this.onLog(`[order] CLOB token lookup failed: ${e.message}`);
      }
    }

    return null;
  }

  async _executeLiveLegacy({ target, side, price, size, notional }) {
    // Old HMAC-only path — only works for exchanges that don't require signed orders
    const tokenID = side === 'YES' ? target.tokenIds?.[0] : (target.tokenIds?.[1] || target.tokenIds?.[0]);
    if (!tokenID) throw new Error(`No tokenId for market ${target.id}`);

    let orderPrice = price;
    let orderSize = size;
    if (this.config.orderbook_taker_enabled !== false) {
      const quote = await this._findBookTakerQuote({
        tokenID,
        orderSide: 'BUY',
        referencePrice: price,
        requestedSize: size,
        maxNotional: notional,
        tickSize: '0.01',
      });
      if (!quote) {
        return { tradeId: `book_skip_${Date.now()}`, status: 'fok_canceled', filledSize: 0, mode: 'live', tokenId: tokenID, entryPrice: price, exitPrice: price, pnl: 0 };
      }
      orderPrice = quote.price;
      orderSize = quote.size;
      this.onLog(`[orderbook] selected ask=${orderPrice} size=${orderSize}/${size} visible=${quote.visibleSize.toFixed(2)} attempts=${quote.attempts}`);
    }

    const result = await this.marketApi.placeOrder({
      tokenId: tokenID, side: 'BUY',
      price: orderPrice, size: orderSize, orderType: 'FAK',
    });
    if (result?.error) throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error));

    const entryPrice = parseFloat(result.price || orderPrice);
    let positionId = null;
    if (this.positionBook) {
      const pos = this.positionBook.openPosition({ marketId: target.id, side, size: orderSize, entryPrice, agent: 'btcScalp', tokenId: tokenID });
      positionId = pos.id;
    }
    return { tradeId: result.orderID || result.id || `live_${Date.now()}`, status: result.status || 'submitted', filledSize: orderSize, tokenId: tokenID, mode: 'live', positionId, entryPrice, exitPrice: entryPrice, pnl: 0 };
  }

  _simulatePaper({ side, price, size, notional, metrics }) {
    // Simulate fill with small slippage
    const slip       = side === 'YES' ? 0.001 : -0.001;
    const entryPrice = Math.max(0.01, Math.min(0.99, price + slip));
    const pWin       = metrics.confidence / 100;
    const win        = Math.random() < pWin;
    const dir        = side === 'YES' ? 1 : -1;
    const magnitude  = win ? 0.03 + Math.random() * 0.07 : 0.02 + Math.random() * 0.06;
    const exitPrice  = Math.max(0.01, Math.min(0.99, entryPrice + dir * (win ? magnitude : -magnitude)));
    const pnl        = (exitPrice - entryPrice) * size * dir;

    if (this.positionBook) {
      const pos = this.positionBook.openPosition({ marketId: `btc_sim_${Date.now()}`, side, size, entryPrice, agent: 'btcScalp' });
      this.positionBook.closePosition(pos.id, { exitPrice, pnl });
    }

    return {
      tradeId:    `fast_${Date.now()}`,
      status:     'filled',
      mode:       'paper',
      entryPrice,
      exitPrice,
      pnl,
    };
  }
}

module.exports = { FastExecutor };
