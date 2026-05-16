'use strict';

const http = require('http');

let client;
try {
  client = require('prom-client');
} catch {
  throw new Error('prom-client package required — run: npm install prom-client');
}

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'node_' });

// ── Counters ─────────────────────────────────────────────────────────────────

const tradesTotal = new client.Counter({
  name: 'polymarket_trades_total',
  help: 'Total trades executed',
  labelNames: ['agent', 'side', 'status', 'mode'],
  registers: [register],
});

const cyclesTotal = new client.Counter({
  name: 'polymarket_cycles_total',
  help: 'Total trading cycles completed',
  registers: [register],
});

const proposalsTotal = new client.Counter({
  name: 'polymarket_proposals_total',
  help: 'Total trade proposals generated',
  labelNames: ['agent'],
  registers: [register],
});

const ordersPlacedTotal = new client.Counter({
  name: 'polymarket_orders_placed_total',
  help: 'Total orders submitted to exchange',
  labelNames: ['agent', 'type'],
  registers: [register],
});

// ── Gauges ───────────────────────────────────────────────────────────────────

const portfolioEquity = new client.Gauge({
  name: 'polymarket_portfolio_equity_usd',
  help: 'Current portfolio equity in USD',
  registers: [register],
});

const portfolioPnl = new client.Gauge({
  name: 'polymarket_portfolio_pnl_usd',
  help: 'Total realised + unrealised PnL in USD',
  registers: [register],
});

const portfolioDrawdown = new client.Gauge({
  name: 'polymarket_portfolio_drawdown_ratio',
  help: 'Current drawdown as fraction of peak equity',
  registers: [register],
});

const openPositions = new client.Gauge({
  name: 'polymarket_open_positions_count',
  help: 'Number of currently open positions',
  registers: [register],
});

const agentAllocation = new client.Gauge({
  name: 'polymarket_agent_allocation_ratio',
  help: 'Capital allocation ratio per agent',
  labelNames: ['agent'],
  registers: [register],
});

const agentWinRate = new client.Gauge({
  name: 'polymarket_agent_win_rate',
  help: 'Win rate per agent (0–1)',
  labelNames: ['agent'],
  registers: [register],
});

const agentPnl = new client.Gauge({
  name: 'polymarket_agent_pnl_usd',
  help: 'Cumulative PnL per agent in USD',
  labelNames: ['agent'],
  registers: [register],
});

const wsConnected = new client.Gauge({
  name: 'polymarket_ws_connected',
  help: '1 if WebSocket is connected, 0 otherwise',
  registers: [register],
});

// ── Histograms ────────────────────────────────────────────────────────────────

const tradePnlHistogram = new client.Histogram({
  name: 'polymarket_trade_pnl_usd',
  help: 'Distribution of per-trade PnL in USD',
  labelNames: ['agent'],
  buckets: [-10, -5, -2, -1, -0.5, 0, 0.5, 1, 2, 5, 10],
  registers: [register],
});

const tradeSizeHistogram = new client.Histogram({
  name: 'polymarket_trade_size_contracts',
  help: 'Distribution of trade sizes in contracts',
  labelNames: ['agent'],
  buckets: [1, 5, 10, 20, 50, 100, 200],
  registers: [register],
});

const cycleDuration = new client.Histogram({
  name: 'polymarket_cycle_duration_ms',
  help: 'Time to complete one trading cycle in ms',
  buckets: [50, 100, 250, 500, 1000, 2500, 5000],
  registers: [register],
});

// ── Convenience accessor ─────────────────────────────────────────────────────

const metrics = {
  tradesTotal,
  cyclesTotal,
  proposalsTotal,
  ordersPlacedTotal,
  portfolioEquity,
  portfolioPnl,
  portfolioDrawdown,
  openPositions,
  agentAllocation,
  agentWinRate,
  agentPnl,
  wsConnected,
  tradePnlHistogram,
  tradeSizeHistogram,
  cycleDuration,

  recordTrade(trade) {
    tradesTotal.inc({ agent: trade.agent, side: trade.side, status: trade.status || 'filled', mode: trade.mode || 'paper' });
    tradePnlHistogram.observe({ agent: trade.agent }, trade.pnl || 0);
    tradeSizeHistogram.observe({ agent: trade.agent }, trade.size || 0);
  },

  updatePortfolio({ equity, initialCapital, drawdown, openCount }) {
    portfolioEquity.set(equity);
    portfolioPnl.set(equity - initialCapital);
    portfolioDrawdown.set(drawdown);
    openPositions.set(openCount);
  },

  updateAgentStats(agentStats, allocations = {}) {
    for (const [agent, stats] of Object.entries(agentStats)) {
      const t = Math.max(1, stats.trades || 0);
      agentWinRate.set({ agent }, (stats.wins || 0) / t);
      agentPnl.set({ agent }, stats.pnl || 0);
    }
    for (const [agent, alloc] of Object.entries(allocations)) {
      agentAllocation.set({ agent }, alloc);
    }
  },
};

// ── HTTP Server ───────────────────────────────────────────────────────────────

class MetricsServer {
  constructor() {
    this._server = null;
  }

  start(port = 9091) {
    return new Promise((resolve, reject) => {
      this._server = http.createServer(async (req, res) => {
        if (req.url === '/metrics') {
          try {
            res.setHeader('Content-Type', register.contentType);
            res.end(await register.metrics());
          } catch (e) {
            res.statusCode = 500;
            res.end(e.message);
          }
        } else if (req.url === '/health') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
        } else {
          res.statusCode = 404;
          res.end();
        }
      });

      this._server.once('error', reject);
      this._server.listen(port, () => {
        console.log(`[metrics] Prometheus endpoint: http://localhost:${port}/metrics`);
        resolve(port);
      });
    });
  }

  stop() {
    return new Promise(resolve => {
      if (this._server) this._server.close(resolve);
      else resolve();
    });
  }
}

module.exports = { metrics, MetricsServer, register };
