class RiskManager {
  constructor(config) {
    this.config = config;
    this.cooldowns = new Map();
  }

  isPortfolioBlocked(performance) {
    // Absolute dollar floor — stop when equity falls below starting capital minus fixed loss cap
    if (this.config.stop_loss_usd != null && performance.equity != null) {
      if (performance.equity <= this.config.stop_loss_usd) return true;
    }
    // Percentage drawdown from peak
    return (performance.maxDrawdown || 0) >= this.config.max_drawdown;
  }

  inCooldown(agentName) {
    return (this.cooldowns.get(agentName) || 0) > 0;
  }

  onCycleEnd() {
    for (const [agent, n] of this.cooldowns.entries()) {
      this.cooldowns.set(agent, Math.max(0, n - 1));
    }
  }

  registerLoss(agentName) {
    this.cooldowns.set(agentName, this.config.cooldown_cycles_after_loss);
  }

  validateTrade(trade, context) {
    const { openPositions, totalCapital, portfolioExposure, perMarketExposure } = context;

    if (openPositions.length >= this.config.max_concurrent_trades) {
      return { approved: false, reason: "max concurrent trades reached" };
    }

    const marketExposure = perMarketExposure[trade.marketId] || 0;
    const addedExposure = trade.notional / Math.max(1, totalCapital);
    if (marketExposure + addedExposure > this.config.max_exposure_per_market) {
      return { approved: false, reason: "max exposure per market exceeded" };
    }

    if (portfolioExposure + addedExposure > 1) {
      return { approved: false, reason: "portfolio fully allocated" };
    }

    return { approved: true };
  }
}

module.exports = RiskManager;
