'use strict';

/**
 * TelegramNotifier — sends trade notifications via Telegram Bot API.
 * Uses only Node built-ins (no SDK). Queues messages to avoid floods.
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   TELEGRAM_CHAT_ID    — your personal chat ID (run npm run telegram-setup)
 */

const https = require('https');

class TelegramNotifier {
  constructor() {
    this._token   = process.env.TELEGRAM_BOT_TOKEN || '';
    this._chatId  = process.env.TELEGRAM_CHAT_ID   || '';
    this._enabled = !!(this._token && this._chatId);
    this._queue   = [];
    this._sending = false;
    // Session running P&L (reset when notifier is reset)
    this._sessionPnl = 0;
  }

  get enabled() { return this._enabled; }

  reload() {
    this._token   = process.env.TELEGRAM_BOT_TOKEN || '';
    this._chatId  = process.env.TELEGRAM_CHAT_ID   || '';
    this._enabled = !!(this._token && this._chatId);
  }

  resetSession() { this._sessionPnl = 0; }

  // ── Public API ──────────────────────────────────────────────────────────────

  tradeOpened(trade) {
    if (!this._enabled) return;
    const side   = trade.side === 'YES' ? 'LONG 🟢' : 'SHORT 🔴';
    const entry  = (trade.entryPrice || trade.price || 0).toFixed(3);
    const size   = trade.size || 0;
    const notion = ((trade.entryPrice || 0) * size).toFixed(2);
    const tp     = trade.tpPrice ? trade.tpPrice.toFixed(3) : '—';
    const sl     = trade.slPrice ? trade.slPrice.toFixed(3) : '—';
    const rr     = trade.rrRatio || '—';
    const conf   = trade.confidence ? ((trade.confidence || 0) * 100).toFixed(0) : '—';
    const mkt    = _shortMarket(trade.marketId);
    const mode   = trade.mode === 'live' ? '🔴 LIVE' : '📄 PAPER';

    this._enqueue(`⚡ <b>NEW TRADE — ${side}</b>
${mode} | Conf: ${conf}%

📊 <b>${mkt}</b>
💵 Entry: $${entry} × ${size} shares = $${notion}
🎯 TP: $${tp}  |  🛑 SL: $${sl}
📈 R:R: ${rr}`);
  }

  tradeClosed(result) {
    if (!this._enabled) return;
    const pnl     = result.pnl || 0;
    this._sessionPnl += pnl;

    const won     = pnl > 0;
    const icon    = result.reason === 'take_profit' ? '✅' : result.reason === 'stop_loss' ? '❌' : '⏱';
    const rLabel  = result.reason === 'take_profit' ? 'Take Profit Hit 🎯'
                  : result.reason === 'stop_loss'   ? 'Stop Loss Hit 🛑'
                  : 'Max Hold Expired ⏱';
    const pnlStr  = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(3);
    const entry   = (result.entryPrice || 0).toFixed(3);
    const exit    = (result.exitPrice  || 0).toFixed(3);
    const holdS   = result.holdMs ? Math.round(result.holdMs / 1000) + 's' : '—';
    const mkt     = _shortMarket(result.marketId);
    const sesStr  = (this._sessionPnl >= 0 ? '+$' : '-$') + Math.abs(this._sessionPnl).toFixed(2);
    const sesIcon = this._sessionPnl >= 0 ? '📈' : '📉';

    this._enqueue(`${icon} <b>TRADE CLOSED — ${pnlStr}</b>
${rLabel}

📊 <b>${mkt}</b>
${won ? '📈' : '📉'} Entry: $${entry} → Exit: $${exit}
💰 P&L: <b>${pnlStr}</b>  |  ⏱ Held: ${holdS}

${sesIcon} Session total: <b>${sesStr}</b>`);
  }

  tradeError(trade, errorMsg) {
    if (!this._enabled) return;
    this._enqueue(`⚠️ <b>ORDER ERROR</b>
Market: ${_shortMarket(trade.marketId)}
Error: <code>${(errorMsg || 'unknown').slice(0, 200)}</code>`);
  }

  // ── Message queue ───────────────────────────────────────────────────────────

  _enqueue(text) {
    this._queue.push(text);
    if (!this._sending) this._flush();
  }

  async _flush() {
    if (!this._queue.length) { this._sending = false; return; }
    this._sending = true;
    const text = this._queue.shift();
    try { await this._send(text); } catch {}
    // Telegram rate limit: 1 message/second per chat
    setTimeout(() => this._flush(), 1100);
  }

  _send(text) {
    const body = JSON.stringify({ chat_id: this._chatId, text, parse_mode: 'HTML' });
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        path:     `/bot${this._token}/sendMessage`,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout:  8000,
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const r = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (r.ok) resolve(r);
          else reject(new Error(r.description || 'Telegram API error'));
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Telegram timeout')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _shortMarket(id) {
  if (!id) return '—';
  if (id.startsWith('0x')) return id.slice(0, 10) + '…' + id.slice(-6);
  return id.slice(0, 30);
}

// ── Singleton ─────────────────────────────────────────────────────────────────
let _instance = null;
module.exports = {
  getInstance() {
    if (!_instance) _instance = new TelegramNotifier();
    return _instance;
  },
  TelegramNotifier,
};
