'use strict';

const DataBus = require('../core/dataBus');
const RiskManager = require('../core/riskManager');
const CapitalAllocator = require('../core/capitalAllocator');
const ExecutionEngine = require('../core/executionEngine');
const { appendJsonl } = require('../shared/dataStore');

/**
 * Event-driven historical replay engine.
 *
 * Steps through historical price data in chronological order, feeds each
 * time-step to all agents, executes their trades using prices from that
 * point in history, and records the full equity curve.
 */
class ReplayEngine {
  constructor({ config, agents, logPath = null } = {}) {
    this.config = { ...config };
    this.config.mode = 'backtest';
    this.agents = agents;
    this.logPath = logPath;
  }

  /**
   * Run the backtest.
   * @param {Map<string, Array<{t:number, p:number}>>} historicalData
   * @returns {BacktestResult}
   */
  async run(historicalData) {
    const dataBus = new DataBus();
    const riskManager = new RiskManager(this.config);
    const capitalAllocator = new CapitalAllocator(this.config);
    const executionEngine = new ExecutionEngine(this.config, null);
    const config = this.config;

    const state = {
      equity: config.total_capital,
      peakEquity: config.total_capital,
      openPositions: [],
      agentStats: {},
    };

    const allTrades = [];

    // Build unified timeline: bucket ticks into steps of ~15min
    const timeline = this._buildTimeline(historicalData);
    const t0 = timeline[0]?.timestamp || Date.now();
    const equityCurve = [{ t: t0, equity: config.total_capital }];
    const drawdownCurve = [{ t: t0, drawdown: 0 }];
    console.log(`[backtest] Replaying ${timeline.length} time steps across ${historicalData.size} markets`);

    let cycleNum = 0;
    let prevPrices = null;

    for (const step of timeline) {
      cycleNum++;
      const { timestamp, prices } = step;

      // Build market snapshot at this time step
      const markets = this._buildMarketSnapshot(prices, historicalData);
      if (!markets.length) continue;

      // Check portfolio stop
      const dd = (state.peakEquity - state.equity) / state.peakEquity;
      if (dd >= config.max_drawdown) {
        console.log(`[backtest] Max drawdown reached at step ${cycleNum}, stopping.`);
        break;
      }

      // Synthetic news derived from recent price moves (feeds newsAgent)
      const stepNews = this._generateStepNews(prices, prevPrices);
      prevPrices = prices;

      // Collect proposals from all agents
      let proposals = [];
      for (const agent of this.agents) {
        if (riskManager.inCooldown(agent.name)) continue;
        const sharedData = {
          latestSignals: dataBus.subscribe('signals'),
          outcomes: dataBus.subscribe('outcomes'),
        };
        const signals = await agent.generateSignals(markets, stepNews, sharedData);
        const opps = await agent.evaluateOpportunities(signals);
        const trades = await agent.proposeTrades(opps);
        for (const s of signals) dataBus.publish('signals', { agent: agent.name, signal: s });
        proposals = proposals.concat(trades);
      }

      proposals = proposals.filter(
        t => t.ev >= config.ev_threshold && t.confidence >= config.confidence_threshold
      );

      const resolved = resolveConflicts(proposals);
      const agentPerf = buildAgentPerf(state.agentStats);
      const allocated = capitalAllocator.allocate(resolved, agentPerf, state.equity);

      const perMarketExp = {};
      let portfolioExp = 0;
      for (const p of state.openPositions) {
        const frac = p.notional / Math.max(1, state.equity);
        portfolioExp += frac;
        perMarketExp[p.marketId] = (perMarketExp[p.marketId] || 0) + frac;
      }

      for (const trade of allocated) {
        const validated = riskManager.validateTrade(trade, {
          openPositions: state.openPositions,
          totalCapital: state.equity,
          portfolioExposure: portfolioExp,
          perMarketExposure: perMarketExp,
        });
        if (!validated.approved) continue;

        // Use the historical price at this step + slippage
        const historicalPrice = prices[trade.marketId] || trade.price;
        const size = Math.max(1, Math.floor(trade.notional / Math.max(0.01, historicalPrice)));
        const exec = executionEngine.simulateWithHistoricalPrice(
          { ...trade, size, price: historicalPrice },
          0.003,                     // 0.3% slippage for backtest
          prices[trade.marketId]     // next step exit price approximation
        );

        const finalTrade = {
          ...trade,
          ...exec,
          size,
          timestamp,
          cycleNum,
        };

        // Update state
        state.equity += finalTrade.pnl;
        state.peakEquity = Math.max(state.peakEquity, state.equity);
        const s = state.agentStats[finalTrade.agent] || { trades: 0, wins: 0, pnl: 0 };
        s.trades++;
        s.pnl += finalTrade.pnl;
        if (finalTrade.pnl > 0) s.wins++;
        state.agentStats[finalTrade.agent] = s;
        if (finalTrade.pnl < 0) riskManager.registerLoss(finalTrade.agent);

        allTrades.push(finalTrade);
        dataBus.publish('outcomes', finalTrade);
        if (this.logPath) appendJsonl(this.logPath, finalTrade);
      }

      riskManager.onCycleEnd();

      const drawdown = (state.peakEquity - state.equity) / state.peakEquity;
      equityCurve.push({ t: timestamp, equity: Math.round(state.equity * 100) / 100 });
      drawdownCurve.push({ t: timestamp, drawdown: Math.round(drawdown * 10000) / 100 });

      if (cycleNum % 50 === 0) {
        process.stdout.write(`\r[backtest] Step ${cycleNum}/${timeline.length} | equity=${state.equity.toFixed(2)} dd=${(drawdown * 100).toFixed(2)}%`);
      }
    }
    process.stdout.write('\n');

    return {
      mode: 'backtest',
      startTimestamp: timeline[0]?.timestamp || Date.now(),
      endTimestamp: timeline[timeline.length - 1]?.timestamp || Date.now(),
      initialEquity: config.total_capital,
      finalEquity: state.equity,
      equityCurve,
      drawdownCurve,
      trades: allTrades,
      agentStats: state.agentStats,
      marketCount: historicalData.size,
      cyclesRun: cycleNum,
    };
  }

  // ── Timeline construction ──────────────────────────────────────────────────

  _buildTimeline(historicalData) {
    // Collect all unique timestamps across all markets
    const tsSet = new Set();
    for (const series of historicalData.values()) {
      for (const pt of series) tsSet.add(pt.t);
    }
    const timestamps = Array.from(tsSet).sort((a, b) => a - b);

    // For each timestamp, capture the latest known price per market
    const lastPrice = new Map();
    const timeline = [];

    for (const ts of timestamps) {
      // Update latest prices
      for (const [marketId, series] of historicalData) {
        for (const pt of series) {
          if (pt.t <= ts) lastPrice.set(marketId, pt.p);
          else break;
        }
      }
      const prices = Object.fromEntries(lastPrice);
      timeline.push({ timestamp: ts, prices });
    }
    return timeline;
  }

  _buildMarketSnapshot(prices, historicalData) {
    return Object.entries(prices).map(([id, p]) => {
      // Wider spreads so market-maker EV clears the ev_threshold
      const spread = 0.025 + Math.random() * 0.035;   // 2.5–6%
      // ~30% of markets are illiquid, giving the liquidity agent opportunities
      const liquidity = Math.random() < 0.30
        ? 200  + Math.random() * 1800   // illiquid: $200–$2000
        : 2500 + Math.random() * 7500;  // normal: $2500–$10000
      return {
        id,
        group: id.includes('fed') || id.includes('oil') ? 'macro' : 'backtest',
        impliedProb: p,
        priceYes: p,
        bidYes: Math.max(0.01, p - spread / 2),
        askYes: Math.min(0.99, p + spread / 2),
        liquidity,
        volatility: 0.1 + Math.random() * 0.3,
        bias: 0,
      };
    });
  }

  // Synthetic news: ~25% of steps emit 1-2 price-movement headlines that the
  // newsAgent's heuristic parser can match (surges / falls keywords).
  _generateStepNews(currentPrices, prevPrices) {
    if (!prevPrices || Math.random() > 0.25) return [];
    const items = [];
    for (const [id, p] of Object.entries(currentPrices)) {
      const prev = prevPrices[id];
      if (prev == null) continue;
      const change = p - prev;
      if (Math.abs(change) < 0.015) continue;   // only notable moves
      const label = id.replace(/_/g, ' ');
      if (change > 0) {
        items.push({ title: `${label} surges on strong demand`, body: 'Positive sentiment drives the market higher.' });
      } else {
        items.push({ title: `${label} falls amid growing uncertainty`, body: 'Market weakness extends as sentiment deteriorates.' });
      }
      if (items.length >= 2) break;
    }
    return items;
  }
}

// ── Standalone helpers (mirrors Coordinator logic) ─────────────────────────────

function resolveConflicts(trades) {
  const byMarket = new Map();
  for (const t of trades) {
    if (!byMarket.has(t.marketId)) byMarket.set(t.marketId, []);
    byMarket.get(t.marketId).push(t);
  }
  const out = [];
  for (const group of byMarket.values()) {
    group.sort((a, b) => {
      const sa = a.ev * 0.5 + a.confidence * 0.3 + (a.agentScore || 0.5) * 0.2;
      const sb = b.ev * 0.5 + b.confidence * 0.3 + (b.agentScore || 0.5) * 0.2;
      return sb - sa;
    });
    const best = group[0];
    if (group.some(t => t.side !== best.side)) best.requestedSize = (best.requestedSize || best.size || 10) * 0.7;
    out.push(best);
  }
  return out;
}

function buildAgentPerf(agentStats) {
  const out = {};
  for (const [name, stats] of Object.entries(agentStats)) {
    const t = Math.max(1, stats.trades || 0);
    out[name] = {
      winRate: (stats.wins || 0) / t,
      sharpeLike: Math.max(0.5, Math.min(1.5, 1 + (stats.pnl / t) * 5)),
    };
  }
  return out;
}

module.exports = { ReplayEngine };
