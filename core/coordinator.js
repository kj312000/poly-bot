'use strict';

const { appendJsonl } = require('../shared/dataStore');
const agentParams = require('../shared/agentParams');

class Coordinator {
  constructor({ config, agents, dataBus, riskManager, capitalAllocator, executionEngine, loggerPath, metrics = null, positionBook = null }) {
    this.config = config;
    this.agents = agents;
    this.dataBus = dataBus;
    this.riskManager = riskManager;
    this.capitalAllocator = capitalAllocator;
    this.executionEngine = executionEngine;
    this.loggerPath = loggerPath;
    this.metrics = metrics;
    this.positionBook = positionBook;

    this.state = {
      equity: config.total_capital,
      peakEquity: config.total_capital,
      openPositions: [],
      tradeHistory: [],
      agentStats: {},
    };

    // Equity snapshot per cycle for performance charts
    this.equityHistory = [{ t: Date.now(), equity: config.total_capital }];
  }

  getPerformance() {
    const drawdown = (this.state.peakEquity - this.state.equity) / this.state.peakEquity;
    return { maxDrawdown: drawdown, equity: this.state.equity };
  }

  buildAgentPerformance() {
    const result = {};
    for (const [agentName, stats] of Object.entries(this.state.agentStats)) {
      const trades = Math.max(1, stats.trades || 0);
      const avgPnl = (stats.pnl || 0) / trades;
      result[agentName] = {
        winRate: (stats.wins || 0) / trades,
        sharpeLike: Math.max(0.5, Math.min(1.5, 1 + avgPnl * 5)),
      };
    }
    return result;
  }

  resolveConflicts(trades) {
    const byMarket = new Map();
    for (const trade of trades) {
      if (!byMarket.has(trade.marketId)) byMarket.set(trade.marketId, []);
      byMarket.get(trade.marketId).push(trade);
    }

    const resolved = [];
    for (const marketTrades of byMarket.values()) {
      marketTrades.sort((a, b) => {
        const scoreA = a.ev * 0.5 + a.confidence * 0.3 + (a.agentScore || 0.5) * 0.2;
        const scoreB = b.ev * 0.5 + b.confidence * 0.3 + (b.agentScore || 0.5) * 0.2;
        return scoreB - scoreA;
      });
      const best = marketTrades[0];
      const conflictCount = marketTrades.filter(t => t.side !== best.side).length;
      if (conflictCount > 0) {
        best.conflictAdjusted = true;
        best.requestedSize = (best.requestedSize || best.size || 10) * 0.7;
      }
      resolved.push(best);
    }
    return resolved;
  }

  async runCycle({ markets, news }) {
    const cycleStart = Date.now();

    if (this.riskManager.isPortfolioBlocked(this.getPerformance())) {
      return { stopped: true, reason: 'max drawdown reached' };
    }

    let proposals = [];
    for (const agent of this.agents) {
      if (this.riskManager.inCooldown(agent.name)) continue;
      const sharedData = {
        latestSignals: this.dataBus.subscribe('signals'),
        outcomes: this.dataBus.subscribe('outcomes'),
      };
      const signals = await agent.generateSignals(markets, news, sharedData);
      const opportunities = await agent.evaluateOpportunities(signals);
      const trades = await agent.proposeTrades(opportunities);
      for (const s of signals) {
        this.dataBus.publish('signals', { agent: agent.name, signal: s });
      }

      if (this.metrics) {
        this.metrics.proposalsTotal.inc({ agent: agent.name }, trades.length);
      }

      proposals = proposals.concat(trades);
    }

    // Apply runtime agentParams overrides (agentScore, confidenceScale, enabled)
    proposals = proposals
      .filter(t => agentParams.isEnabled(t.agent))
      .map(t => agentParams.applyToTrade(t));

    proposals = proposals.filter(
      t => t.ev >= this.config.ev_threshold && t.confidence >= this.config.confidence_threshold
    );
    const resolved = this.resolveConflicts(proposals);
    const allocated = this.capitalAllocator.allocate(resolved, this.buildAgentPerformance(), this.state.equity);

    const perMarketExposure = {};
    let portfolioExposure = 0;
    for (const p of this.state.openPositions) {
      const frac = p.notional / Math.max(1, this.state.equity);
      portfolioExposure += frac;
      perMarketExposure[p.marketId] = (perMarketExposure[p.marketId] || 0) + frac;
    }

    // Validate all trades synchronously (reads shared state), then execute in parallel
    const approved = [];
    for (const trade of allocated) {
      const validated = this.riskManager.validateTrade(trade, {
        openPositions:    this.state.openPositions,
        totalCapital:     this.state.equity,
        portfolioExposure,
        perMarketExposure,
      });
      if (validated.approved) approved.push(trade);
    }

    // Fire all approved trades concurrently — no sequential HTTP wait
    const execResults = await Promise.all(
      approved.map(trade => {
        const size = Math.max(1, Math.floor(trade.notional / Math.max(0.01, trade.price)));
        return this.executionEngine
          .executeTrade({ ...trade, size }, this.config.mode)
          .then(exec => ({ ...trade, ...exec, size, timestamp: Date.now() }))
          .catch(err => ({ ...trade, size, timestamp: Date.now(), status: 'error', pnl: 0, _err: err.message }));
      })
    );

    const executed = [];
    for (const finalTrade of execResults) {
      this.handleTradeOutcome(finalTrade);
      executed.push(finalTrade);
      appendJsonl(this.loggerPath, finalTrade);
      this.dataBus.publish('outcomes', finalTrade);
      if (this.metrics) this.metrics.recordTrade(finalTrade);
    }

    this.riskManager.onCycleEnd();

    // Snapshot equity for charts
    this.equityHistory.push({ t: Date.now(), equity: this.state.equity });

    // Emit metrics
    if (this.metrics) {
      const { maxDrawdown } = this.getPerformance();
      const openCount = this.positionBook
        ? this.positionBook.getOpen().length
        : this.state.openPositions.length;

      this.metrics.updatePortfolio({
        equity: this.state.equity,
        initialCapital: this.config.total_capital,
        drawdown: maxDrawdown,
        openCount,
      });
      this.metrics.updateAgentStats(this.state.agentStats, this.config.agent_allocations || {});
      this.metrics.cyclesTotal.inc();
      this.metrics.cycleDuration.observe(Date.now() - cycleStart);
    }

    return { stopped: false, proposals: proposals.length, executed };
  }

  handleTradeOutcome(trade) {
    this.state.tradeHistory.push(trade);
    this.state.equity += trade.pnl;
    this.state.peakEquity = Math.max(this.state.peakEquity, this.state.equity);
    const s = this.state.agentStats[trade.agent] || { trades: 0, wins: 0, pnl: 0 };
    s.trades += 1;
    s.pnl    += trade.pnl;
    if (trade.pnl > 0) s.wins += 1;
    this.state.agentStats[trade.agent] = s;
    if (trade.pnl < 0) this.riskManager.registerLoss(trade.agent);

    // Notify the originating agent so it can track its own risk state
    const agent = this.agents.find(a => a.name === trade.agent);
    if (agent) {
      if (trade.pnl > 0 && typeof agent.onWin  === 'function') agent.onWin(trade);
      if (trade.pnl < 0 && typeof agent.onLoss === 'function') agent.onLoss(trade);
    }
  }

  dashboard() {
    const history = this.state.tradeHistory;
    const wins = history.filter(t => t.pnl > 0).length;
    const dd = this.getPerformance().maxDrawdown;
    const openCount = this.positionBook
      ? this.positionBook.getOpen().length
      : this.state.openPositions.length;

    return {
      totalPnL: this.state.equity - this.config.total_capital,
      agentPnL: Object.fromEntries(
        Object.entries(this.state.agentStats).map(([k, v]) => [k, v.pnl])
      ),
      winRate: history.length ? wins / history.length : 0,
      maxDrawdown: dd,
      openPositions: openCount,
      leaderboard: Object.entries(this.state.agentStats)
        .sort((a, b) => b[1].pnl - a[1].pnl)
        .map(([agent, stat]) => ({
          agent,
          pnl: stat.pnl,
          winRate: stat.wins / Math.max(1, stat.trades),
        })),
      positionBookSummary: this.positionBook ? this.positionBook.summary() : null,
    };
  }
}

module.exports = Coordinator;
