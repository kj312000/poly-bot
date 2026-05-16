'use strict';

const https = require('https');

/**
 * TelegramCommander — long-polls getUpdates and handles bot commands.
 *
 * Commands:
 *   /start   — start the trading loop
 *   /stop    — stop the trading loop
 *   /status  — current equity / P&L / win-rate
 *   /dryrun  — toggle test ↔ real mode
 *   /help    — list commands
 *
 * Security: only processes messages from the configured TELEGRAM_CHAT_ID.
 */
class TelegramCommander {
  constructor({ token, chatId, onStart, onStop, onStatus, onToggleDryRun, onLog }) {
    this._token          = token   || '';
    this._chatId         = String(chatId || '');
    this._onStart        = onStart        || (() => Promise.resolve({ ok: false, error: 'not configured' }));
    this._onStop         = onStop         || (() => {});
    this._onStatus       = onStatus       || (() => 'no status');
    this._onToggleDryRun = onToggleDryRun || (() => false);
    this._onLog          = onLog          || (() => {});
    this._offset         = 0;
    this._stopped        = false;
    this._enabled        = !!(token && chatId);
  }

  start() {
    if (!this._enabled) {
      this._onLog('[tgCmd] Disabled — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing');
      return;
    }
    this._onLog(`[tgCmd] Starting — token=...${this._token.slice(-6)} chatId=${this._chatId}`);
    this._send('🤖 Bot online.\n/start /stop /status /dryrun /help')
      .then(() => this._onLog('[tgCmd] Startup message sent OK'))
      .catch(e => this._onLog(`[tgCmd] Startup message failed: ${e.message}`));
    this._poll();
  }

  stop() { this._stopped = true; }

  async _poll() {
    this._onLog('[tgCmd] Poll loop started');
    while (!this._stopped) {
      try {
        const updates = await this._getUpdates(55);
        if (updates.length > 0) this._onLog(`[tgCmd] Got ${updates.length} update(s)`);
        for (const upd of updates) {
          this._offset = upd.update_id + 1;
          this._handleUpdate(upd).catch(e => this._onLog(`[tgCmd] Handler error: ${e.message}`));
        }
      } catch (e) {
        const isConflict = e.message && e.message.includes('Conflict');
        this._onLog(`[tgCmd] Poll error${isConflict ? ' (another instance running — waiting 30s)' : ''}: ${e.message}`);
        await this._sleep(isConflict ? 30000 : 5000);
      }
    }
    this._onLog('[tgCmd] Poll loop stopped');
  }

  async _handleUpdate(upd) {
    const msg = upd.message || upd.channel_post;
    if (!msg?.text) return;
    this._onLog(`[tgCmd] Incoming chat_id=${msg.chat.id} text="${msg.text}"`);
    if (String(msg.chat.id) !== this._chatId) {
      this._onLog(`[tgCmd] Rejected — unauthorized chat_id=${msg.chat.id} (expected ${this._chatId})`);
      return;
    }

    const cmd = (msg.text || '').split(' ')[0].toLowerCase().replace(/@\w+$/, '');
    this._onLog(`[tgCmd] Dispatching command: ${cmd}`);

    switch (cmd) {
      case '/start':
      case '/start_trading': {
        const r = await this._onStart();
        await this._send(r.ok ? '▶️ Trading started' : `⚠️ ${r.error}`);
        break;
      }
      case '/stop':
      case '/stop_trading': {
        this._onStop();
        await this._send('■ Stop signal sent — finishing current cycle');
        break;
      }
      case '/status': {
        await this._send(this._onStatus());
        break;
      }
      case '/dryrun': {
        const isDry = this._onToggleDryRun();
        await this._send(isDry
          ? '🔵 TEST mode — signals fire but no orders sent'
          : '🔴 REAL mode — orders will execute on Polymarket');
        break;
      }
      case '/help': {
        await this._send(
          'Commands:\n' +
          '/start — start trading\n' +
          '/stop — stop trading\n' +
          '/status — equity, P&amp;L, win rate\n' +
          '/dryrun — toggle test ↔ real\n' +
          '/help — this list'
        );
        break;
      }
    }
  }

  _getUpdates(timeout) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        path:     `/bot${this._token}/getUpdates?offset=${this._offset}&timeout=${timeout}&allowed_updates=["message"]`,
        method:   'GET',
        timeout:  (timeout + 15) * 1000,
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const r = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (r.ok) resolve(r.result || []);
            else reject(new Error(r.description || 'getUpdates failed'));
          } catch (e) { reject(e); }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('getUpdates timeout')); });
      req.on('error', reject);
      req.end();
    });
  }

  _send(text) {
    const body = JSON.stringify({ chat_id: this._chatId, text, parse_mode: 'HTML' });
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        path:     `/bot${this._token}/sendMessage`,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout:  10000,
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve());
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('send timeout')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { TelegramCommander };
