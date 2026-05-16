'use strict';

/**
 * LocalOrderbook — in-memory orderbook maintained from Polymarket WS feed.
 *
 * No REST calls. selectTakerQuote() and getBestSellPrice() are pure math.
 * Wire via PolymarketWsAdapter 'orderBook' and 'priceChange' events.
 */

class LocalOrderbook {
  constructor(tokenId) {
    this.tokenId      = tokenId;
    this.bids         = [];    // sorted desc by price  [{ price, size }]
    this.asks         = [];    // sorted asc  by price
    this.mid          = null;
    this.bestBid      = null;
    this.bestAsk      = null;
    this.lastUpdateTs = 0;
    this._hasSnapshot = false;
  }

  // Full snapshot from WS 'orderBook' event — bids/asks already { price, size } floats
  update({ bids, asks, timestamp }) {
    this.bids = (bids || [])
      .map(b => ({ price: +b.price, size: +b.size }))
      .filter(b => b.price > 0 && b.price < 1 && b.size > 0)
      .sort((a, b) => b.price - a.price);

    this.asks = (asks || [])
      .map(a => ({ price: +a.price, size: +a.size }))
      .filter(a => a.price > 0 && a.price < 1 && a.size > 0)
      .sort((a, b) => a.price - b.price);

    this.lastUpdateTs = timestamp || Date.now();
    this._hasSnapshot = true;
    this._recalc();
  }

  // Incremental price update from WS 'priceChange' event
  onPriceChange({ price, side }) {
    const p = parseFloat(price);
    if (!isFinite(p) || p <= 0 || p >= 1) return;
    if (side === 'BUY')  this.bestBid = p;
    if (side === 'SELL') this.bestAsk = p;
    if (this.bestBid && this.bestAsk) this.mid = (this.bestBid + this.bestAsk) / 2;
    else this.mid = p;
    this.lastUpdateTs = Date.now();
  }

  isStale(maxAgeMs = 3000) {
    return !this._hasSnapshot || Date.now() - this.lastUpdateTs > maxAgeMs;
  }

  _recalc() {
    this.bestBid = this.bids[0]?.price ?? null;
    this.bestAsk = this.asks[0]?.price ?? null;
    if (this.bestBid && this.bestAsk) this.mid = (this.bestBid + this.bestAsk) / 2;
  }

  /**
   * Select executable taker quote from local book (zero I/O).
   * Returns { quote: { price, size, visibleSize, bestPrice, limitPrice }, reason: '' }
   *      or { quote: null, reason: string }
   */
  selectTakerQuote({ isBuy, requestedSize, maxSlippage, referencePrice, maxNotional, tickSize = '0.01', minFillSize = 1 }) {
    const levels = isBuy ? this.asks : this.bids;
    if (!levels.length) return { quote: null, reason: `empty ${isBuy ? 'asks' : 'bids'}` };

    const best       = levels[0];
    const limitPrice = isBuy
      ? Math.min(0.99, referencePrice + maxSlippage)
      : Math.max(0.01, referencePrice - maxSlippage);

    const eligible = levels.filter(l => isBuy ? l.price <= limitPrice : l.price >= limitPrice);
    if (!eligible.length) {
      return { quote: null, reason: `best=${best.price.toFixed(3)} outside limit=${limitPrice.toFixed(3)}` };
    }

    const visibleSize = eligible.reduce((s, l) => s + l.size, 0);
    if (visibleSize < minFillSize) {
      return { quote: null, reason: `visible=${visibleSize.toFixed(2)} < min=${minFillSize}` };
    }

    let cum = 0;
    let selectedPrice = eligible[0].price;
    for (const level of eligible) {
      const rem = requestedSize - cum;
      if (rem <= 0) break;
      cum += Math.min(level.size, rem);
      selectedPrice = level.price;
      if (cum >= requestedSize) break;
    }

    const tick     = parseFloat(tickSize) || 0.01;
    const capSize  = maxNotional > 0 ? Math.floor(maxNotional / Math.max(0.01, selectedPrice)) : requestedSize;
    const execSize = Math.floor(Math.min(requestedSize, cum, capSize));
    if (execSize < minFillSize) {
      return { quote: null, reason: `execSize=${execSize} < min after notional cap` };
    }

    const units        = selectedPrice / tick;
    const roundedUnits = isBuy ? Math.ceil(units - 1e-9) : Math.floor(units + 1e-9);
    const rounded      = Math.max(0.01, Math.min(0.99, parseFloat((roundedUnits * tick).toFixed(6))));

    return {
      quote:  { price: rounded, size: execSize, visibleSize, bestPrice: best.price, limitPrice },
      reason: '',
    };
  }

  /**
   * Best aggressive price for a SELL FAK — bid minus 1 tick guarantees fill.
   * Returns null if no bid is available.
   */
  getBestSellPrice(tickSize = '0.01') {
    if (!this.bestBid) return null;
    const tick = parseFloat(tickSize) || 0.01;
    return Math.max(0.01, this.bestBid - tick);
  }
}

module.exports = { LocalOrderbook };
