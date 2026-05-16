class CapitalAllocator {
  constructor(config) {
    this.config = config;
  }

  kellyFraction(ev, winProb) {
    const p = Math.max(0.0001, Math.min(0.9999, winProb));
    const b = 1; // Binary options payoff approximation.
    const q = 1 - p;
    const kelly = (b * p - q) / b;
    return Math.max(0, kelly * Math.max(0, ev));
  }

  allocate(trades, agentPerformance, totalCapital) {
    return trades.map((trade) => {
      const perf = agentPerformance[trade.agent] || { sharpeLike: 1, winRate: 0.5 };
      const baseWeight = this.config.agent_allocations[trade.agent] || 0.1;
      const rawKelly = this.kellyFraction(trade.ev, trade.probability);
      const dynamicPerfBoost = Math.max(0.5, Math.min(1.5, perf.sharpeLike || 1));
      const capitalFrac = baseWeight * rawKelly * this.config.fractional_kelly * dynamicPerfBoost;
      const cappedFrac = Math.min(capitalFrac, this.config.risk_per_trade);
      let notional = totalCapital * cappedFrac;
      // Hard absolute-dollar cap — prevents compounding from inflating trade size
      if (this.config.max_trade_usd) notional = Math.min(notional, this.config.max_trade_usd);
      return {
        ...trade,
        allocatedFraction: notional / Math.max(1, totalCapital),
        notional
      };
    }).filter((t) => t.notional > 0);
  }
}

module.exports = CapitalAllocator;
