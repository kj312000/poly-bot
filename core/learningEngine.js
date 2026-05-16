class LearningEngine {
  update(coordinator) {
    const stats = coordinator.state.agentStats;
    for (const [agent, s] of Object.entries(stats)) {
      const trades = Math.max(1, s.trades);
      const winRate = s.wins / trades;
      const pnlPerTrade = s.pnl / trades;
      if (pnlPerTrade < 0 || winRate < 0.35) {
        coordinator.config.agent_allocations[agent] = Math.max(
          0.05,
          (coordinator.config.agent_allocations[agent] || 0.1) * 0.9
        );
      } else {
        coordinator.config.agent_allocations[agent] = Math.min(
          0.45,
          (coordinator.config.agent_allocations[agent] || 0.1) * 1.03
        );
      }
    }
  }
}

module.exports = LearningEngine;
