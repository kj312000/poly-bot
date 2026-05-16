'use strict';

const https = require('https');
const crypto = require('crypto');

const CLOB_BASE = 'https://clob.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';

class PolymarketRestAdapter {
  constructor({ apiKey = '', apiSecret = '', apiPassphrase = '', walletAddress = '' } = {}) {
    this.apiKey        = apiKey;
    this.apiSecret     = apiSecret;
    this.apiPassphrase = apiPassphrase;
    this.walletAddress = walletAddress;

    // Decode secret once at construction — avoid per-request base64 decode
    this._secretBuf = apiSecret ? Buffer.from(apiSecret, 'base64') : null;

    // Persistent keepAlive agent — reuses TCP/TLS connections, saves ~100ms per request
    this._agent = new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 5000 });

    // Header cache — HMAC timestamp only changes each second, cache for reuse
    this._headerCache = { ts: '', headers: null };

    this._rateLimit = { tokens: 10, lastRefill: Date.now(), maxTokens: 10, refillMs: 1000 };
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  _hmacHeaders(method, path, body = '') {
    const ts = String(Math.floor(Date.now() / 1000));

    // Reuse cached headers if still in the same second and same method+path
    const cacheKey = ts + method + path;
    if (this._headerCache.ts === cacheKey && !body) return this._headerCache.headers;

    const message = ts + method.toUpperCase() + path + body.replace(/'/g, '"');
    const sig = this._secretBuf
      ? crypto.createHmac('sha256', this._secretBuf).update(message).digest('base64')
      : '';

    const headers = {
      'POLY_ADDRESS':    this.walletAddress || '',
      'POLY_API_KEY':    this.apiKey,
      'POLY_PASSPHRASE': this.apiPassphrase,
      'POLY_SIGNATURE':  sig,
      'POLY_TIMESTAMP':  ts,
    };

    if (!body) this._headerCache = { ts: cacheKey, headers };
    return headers;
  }

  // Warm the connection to CLOB before trading starts (call once at startup)
  async warmUp() {
    try {
      await this._get(`${CLOB_BASE}/time`);
    } catch {}
  }

  // ── Rate limiter ─────────────────────────────────────────────────────────────

  async _throttle() {
    const now = Date.now();
    const elapsed = now - this._rateLimit.lastRefill;
    const refilled = Math.floor(elapsed / this._rateLimit.refillMs);
    if (refilled > 0) {
      this._rateLimit.tokens = Math.min(
        this._rateLimit.maxTokens,
        this._rateLimit.tokens + refilled
      );
      this._rateLimit.lastRefill = now;
    }
    if (this._rateLimit.tokens <= 0) {
      await new Promise(r => setTimeout(r, this._rateLimit.refillMs));
    }
    this._rateLimit.tokens -= 1;
  }

  // ── Market Data (public, no auth) ────────────────────────────────────────────

  async getClobMarkets({ limit = 50, nextCursor = '' } = {}) {
    const qs = new URLSearchParams({ limit, ...(nextCursor ? { next_cursor: nextCursor } : {}) });
    return this._get(`${CLOB_BASE}/markets?${qs}`);
  }

  async getGammaMarkets({ limit = 50, offset = 0, active = true } = {}) {
    const qs = new URLSearchParams({ limit, offset, ...(active ? { active: 'true' } : {}) });
    return this._get(`${GAMMA_BASE}/markets?${qs}`);
  }

  async getOrderBook(tokenId) {
    return this._get(`${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`);
  }

  // Returns { tokenId: "0.5123", ... } using /midpoint per token, with /book fallback.
  // The CLOB has no GET /prices?token_ids= — that's a POST-only endpoint.
  async getPrices(tokenIds) {
    const ids = Array.isArray(tokenIds) ? tokenIds : [tokenIds];
    const results = await Promise.all(ids.map(async (id) => {
      try {
        const r = await this._get(`${CLOB_BASE}/midpoint?token_id=${encodeURIComponent(id)}`);
        const mid = r?.mid;
        if (mid != null && !isNaN(parseFloat(mid))) return [id, String(mid)];
      } catch {}
      // Fallback: pull the book and compute mid from best bid/ask.
      // Sort-order-agnostic: best bid = max, best ask = min.
      try {
        const book = await this._get(`${CLOB_BASE}/book?token_id=${encodeURIComponent(id)}`);
        const bidPrices = (book?.bids || []).map(b => parseFloat(b.price)).filter(p => !isNaN(p));
        const askPrices = (book?.asks || []).map(a => parseFloat(a.price)).filter(p => !isNaN(p));
        if (bidPrices.length && askPrices.length) {
          const bestBid = Math.max(...bidPrices);
          const bestAsk = Math.min(...askPrices);
          return [id, String((bestBid + bestAsk) / 2)];
        }
      } catch {}
      return [id, null];
    }));
    return Object.fromEntries(results.filter(([, v]) => v != null));
  }

  async getRecentTrades(tokenId, { limit = 20 } = {}) {
    return this._get(`${CLOB_BASE}/trades?token_id=${encodeURIComponent(tokenId)}&limit=${limit}`);
  }

  async getPriceHistory(conditionId, { interval = 'max', fidelity = 100 } = {}) {
    const qs = new URLSearchParams({ interval, market: conditionId, fidelity });
    return this._get(`${CLOB_BASE}/prices-history?${qs}`);
  }

  // ── Order Management (requires L2 auth) ──────────────────────────────────────

  async placeOrder({ tokenId, side, price, size, orderType = 'GTC' }) {
    const path = '/order';
    const body = JSON.stringify({ token_id: tokenId, side, price, size, type: orderType });
    return this._post(`${CLOB_BASE}${path}`, body, this._hmacHeaders('POST', path, body));
  }

  async cancelOrder(orderId) {
    const path = `/order/${orderId}`;
    return this._delete(`${CLOB_BASE}${path}`, this._hmacHeaders('DELETE', path));
  }

  async cancelAllOrders() {
    const path = '/orders';
    return this._delete(`${CLOB_BASE}${path}`, this._hmacHeaders('DELETE', path));
  }

  async getOpenOrders() {
    const path = '/orders';
    return this._get(`${CLOB_BASE}${path}`, this._hmacHeaders('GET', path));
  }

  async getPositions() {
    const path = '/positions';
    return this._get(`${CLOB_BASE}${path}`, this._hmacHeaders('GET', path));
  }

  // ── Convenience: normalized market format for agents ─────────────────────────

  async fetchMarketsForTrading() {
    const m = await this.fetchBtc5mMarket();
    if (!m) throw new Error('BTC 5m market unavailable');
    return [m];
  }

  // ── BTC 5-minute rolling market ───────────────────────────────────────────────
  // These markets resolve every 5 minutes and are only accessible by slug.
  // Slug pattern: btc-updown-5m-{unix_timestamp_of_window_start}

  async fetchBtc5mMarket() {
    const nowSec  = Math.floor(Date.now() / 1000);
    const current = nowSec - (nowSec % 300);

    // Try current window, next (upcoming), and previous (may still be open briefly)
    for (const ts of [current, current + 300, current - 300]) {
      try {
        const slug = `btc-updown-5m-${ts}`;
        const raw  = await this._get(`${GAMMA_BASE}/markets?slug=${slug}`);
        const arr  = Array.isArray(raw) ? raw : (raw.markets || []);
        if (!arr.length) continue;

        const m = arr[0];
        if (m.closed === true || m.acceptingOrders === false) continue;

        const prices  = _parseJsonArray(m.outcomePrices);
        const bid     = parseFloat(m.bestBid ?? prices[0] ?? 0.5);
        const ask     = parseFloat(m.bestAsk ?? prices[1] ?? prices[0] ?? 0.5);
        const mid     = isNaN(bid) || isNaN(ask) ? parseFloat(m.lastTradePrice || 0.5) : (bid + ask) / 2;
        const liq     = parseFloat(m.liquidityNum || m.liquidity || 0);
        const tokenIds = _extractTokenIds(m);

        return {
          id:          m.conditionId || m.id,
          group:       'crypto',
          title:       m.question || slug,
          impliedProb: mid,
          priceYes:    mid,
          bidYes:      Math.max(0.01, isNaN(bid) ? mid : bid),
          askYes:      Math.min(0.99, isNaN(ask) ? mid : ask),
          liquidity:   isNaN(liq) ? 1000 : liq,
          volatility:  0.3,
          bias:        0,
          tokenIds,
          _raw:        m,
          _isBtc5m:   true,
        };
      } catch {}
    }
    return null;
  }

  async _fetchFromClob(limit) {
    const raw = await this.getClobMarkets({ limit });
    const data = Array.isArray(raw) ? raw : (raw.data || []);
    // Lenient filter: include if closed is not explicitly true and active is not explicitly false
    const markets = data.filter(m => m.closed !== true && m.active !== false);
    if (!markets.length) throw new Error(`CLOB returned no usable markets (raw count: ${data.length})`);

    // Bulk-fetch YES token prices in one request
    const yesTokenIds = markets
      .map(m => m.tokens?.find(t => t.outcome === 'Yes')?.token_id)
      .filter(Boolean);

    let priceMap = {};
    if (yesTokenIds.length) {
      try { priceMap = await this.getPrices(yesTokenIds); } catch {}
    }

    const normalized = [];
    for (const m of markets) {
      try {
        const yesToken = m.tokens?.find(t => t.outcome === 'Yes');
        const price    = yesToken ? parseFloat(priceMap[yesToken.token_id] || 0.5) : 0.5;
        const spread   = 0.02;
        normalized.push({
          id:         m.condition_id,
          group:      'general',
          title:      m.question || '',
          impliedProb: price,
          priceYes:   price,
          bidYes:     Math.max(0.01, price - spread / 2),
          askYes:     Math.min(0.99, price + spread / 2),
          liquidity:  1000,
          volatility: 0.2,
          bias:       0,
          tokenIds:   m.tokens?.map(t => t.token_id).filter(Boolean) || [],
          _raw:       m,
        });
      } catch {}
    }
    return normalized;
  }

  async _fetchFromGamma(limit) {
    const raw     = await this.getGammaMarkets({ limit, active: true });
    const markets = Array.isArray(raw) ? raw : (raw.markets || []);
    const normalized = [];
    for (const m of markets) {
      try {
        // outcomePrices arrives as a JSON-encoded string: "[\"0.54\",\"0.46\"]"
        const prices = _parseJsonArray(m.outcomePrices);
        const bid    = parseFloat(m.bestBid ?? prices[0] ?? 0.5);
        const ask    = parseFloat(m.bestAsk ?? prices[1] ?? prices[0] ?? 0.5);
        const mid    = isNaN(bid) || isNaN(ask) ? 0.5 : (bid + ask) / 2;
        const liq    = parseFloat(m.liquidityNum || m.liquidity || m.volume24hr || 1000);
        normalized.push({
          id:          m.conditionId || m.id || m.slug,
          group:       m.tags?.[0]?.slug || m.category || 'general',
          title:       m.question || m.title || '',
          impliedProb: mid,
          priceYes:    mid,
          bidYes:      Math.max(0.01, isNaN(bid) ? mid : bid),
          askYes:      Math.min(0.99, isNaN(ask) ? mid : ask),
          liquidity:   isNaN(liq) ? 1000 : liq,
          volatility:  Math.min(0.5, Math.abs(ask - bid) * 10) || 0.2,
          bias:        0,
          tokenIds:    _extractTokenIds(m),
          _raw:        m,
        });
      } catch {}
    }
    return normalized;
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────────

  async _get(url, extraHeaders = {}) {
    return this._request('GET', url, null, extraHeaders);
  }

  async _post(url, body, extraHeaders = {}) {
    return this._request('POST', url, body, extraHeaders);
  }

  async _delete(url, extraHeaders = {}) {
    return this._request('DELETE', url, null, extraHeaders);
  }

  _request(method, url, body, extraHeaders, attempt = 0) {
    return new Promise(async (resolve, reject) => {
      await this._throttle();
      const parsed  = new URL(url);
      const bodyBuf = body ? Buffer.from(body, 'utf8') : null;

      const req = https.request({
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method,
        agent:    this._agent,          // persistent keepAlive connection
        headers: {
          'Content-Type': 'application/json',
          Accept:         'application/json',
          'User-Agent':   'polymarket-trader/1.0',
          ...extraHeaders,
          ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
        },
        timeout: 12000,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 429 && attempt < 2) {
            setTimeout(() => {
              this._request(method, url, body, extraHeaders, attempt + 1)
                .then(resolve).catch(reject);
            }, 500 * (attempt + 1));    // shorter backoff for scalping
            return;
          }
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode} ${method} ${url}: ${raw.slice(0, 200)}`));
          }
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error(`JSON parse error: ${raw.slice(0, 200)}`)); }
        });
      });

      req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
      req.on('error', reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }
}

// ── JSON field helpers — Gamma returns arrays as JSON-encoded strings ─────────
function _parseJsonArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { const r = JSON.parse(val); if (Array.isArray(r)) return r; } catch {}
  }
  return [];
}

// ── Token ID extraction — Gamma API uses different field names ────────────────
function _extractTokenIds(m) {
  // 1. m.tokens array: [{ token_id, outcome }, ...]
  if (m.tokens?.length) {
    const ids = m.tokens.map(t => t.token_id || t.tokenId || t.id).filter(Boolean);
    if (ids.length) return ids;
  }
  // 2. m.clobTokenIds — direct array OR JSON-encoded string (Gamma sends it as a string)
  const clobIds = _parseJsonArray(m.clobTokenIds).filter(Boolean);
  if (clobIds.length) return clobIds;
  // 3. m.tokenId (singular)
  if (m.tokenId) return [m.tokenId];
  // 4. m.outcomes array: [{ tokenId, ... }]
  if (m.outcomes?.length) {
    const ids = m.outcomes.map(o => o.tokenId || o.token_id).filter(Boolean);
    if (ids.length) return ids;
  }
  return [];
}

module.exports = { PolymarketRestAdapter };
