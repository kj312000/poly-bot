'use strict';

const EventEmitter = require('events');

const WS_MARKET_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const WS_USER_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';

class PolymarketWsAdapter extends EventEmitter {
  constructor({ apiKey = '' } = {}) {
    super();
    this.apiKey = apiKey;
    this._ws = null;
    this._subscriptions = new Set();
    this._reconnectDelay = 1000;
    this._reconnectTimer = null;
    this._pingInterval = null;
    this._connected = false;
    this._destroyed = false;
  }

  connect(url = WS_MARKET_URL) {
    if (this._destroyed) return;
    this._url = url;
    let WS;
    try {
      WS = require('ws');
    } catch {
      throw new Error('ws package required — run: npm install ws');
    }

    this._ws = new WS(url, { handshakeTimeout: 10000 });

    this._ws.on('open', () => {
      if (this._destroyed) { this._ws.close(); return; }
      this._connected = true;
      this._reconnectDelay = 1000;
      this.emit('connected');

      // Ping every 20s to keep connection alive
      this._pingInterval = setInterval(() => {
        if (this._ws.readyState === WS.OPEN) this._ws.ping();
      }, 20000);

      // Resubscribe after reconnect
      for (const assetId of this._subscriptions) {
        this._sendSubscribe(assetId);
      }
    });

    this._ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        const msgs = Array.isArray(data) ? data : [data];
        for (const msg of msgs) this._dispatch(msg);
      } catch (e) {
        this.emit('error', e);
      }
    });

    this._ws.on('close', (code, reason) => {
      clearInterval(this._pingInterval);
      this._connected = false;
      this.emit('disconnected', { code, reason: reason?.toString() });
      if (code && code !== 1000) console.log(`[WS] Closed code=${code} reason=${reason?.toString() || 'none'}`);
      if (!this._destroyed) this._scheduleReconnect();
    });

    this._ws.on('error', (err) => {
      this.emit('error', err);
    });

    this._ws.on('pong', () => {
      this.emit('heartbeat');
    });
  }

  subscribe(assetId) {
    this._subscriptions.add(assetId);
    if (this._connected) this._sendSubscribe(assetId);
  }

  unsubscribe(assetId) {
    this._subscriptions.delete(assetId);
    if (this._connected) {
      this._send({ assets_ids: [assetId], type: 'market', unsubscribe: true });
    }
  }

  close() {
    this._destroyed = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._pingInterval);
    if (this._ws) {
      this._ws.removeAllListeners();
      this._ws.close();
    }
  }

  get connected() { return this._connected; }

  _sendSubscribe(assetId) {
    // Polymarket CLOB WS subscribe format (from official py-clob-client):
    // {"assets_ids": ["<token_id>"], "type": "market"}
    this._send({ assets_ids: [assetId], type: 'market' });
  }

  _send(payload) {
    let WS;
    try { WS = require('ws'); } catch { return; }
    if (this._ws?.readyState === WS.OPEN) {
      this._ws.send(JSON.stringify(payload));
    }
  }

  _dispatch(msg) {
    // Emit raw for full access
    this.emit('message', msg);

    switch (msg.event_type || msg.type) {
      case 'price_change':
        this.emit('priceChange', {
          assetId: msg.asset_id || msg.market_id,
          price: parseFloat(msg.price || 0),
          side: msg.side,
          timestamp: msg.timestamp || Date.now(),
        });
        break;

      case 'book':
        this.emit('orderBook', {
          assetId: msg.asset_id || msg.market_id,
          bids: (msg.bids || []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
          asks: (msg.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
          timestamp: msg.timestamp || Date.now(),
        });
        break;

      case 'last_trade_price':
      case 'trade':
        this.emit('lastTrade', {
          assetId: msg.asset_id || msg.market_id,
          price: parseFloat(msg.price || 0),
          size: parseFloat(msg.size || 0),
          timestamp: msg.timestamp || Date.now(),
        });
        break;

      case 'order_matched':
      case 'fill':
        this.emit('fill', {
          orderId: msg.order_id,
          price: parseFloat(msg.price || 0),
          size: parseFloat(msg.size || 0),
          timestamp: msg.timestamp || Date.now(),
        });
        break;
    }
  }

  _scheduleReconnect() {
    this._reconnectTimer = setTimeout(() => {
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
      console.log(`[WS] Reconnecting in ${this._reconnectDelay}ms...`);
      this.connect(this._url);
    }, this._reconnectDelay);
  }
}

module.exports = { PolymarketWsAdapter, WS_MARKET_URL, WS_USER_URL };
