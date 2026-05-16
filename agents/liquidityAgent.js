const { toTrade } = require("./agentUtils");

module.exports = {
  name: "liquidity",
  async generateSignals(markets, _news, sharedData) {
    const signals = markets
      .filter((m) => m.liquidity < 2000)
      .map((m) => {
        const crowdBias = (sharedData.latestSignals || []).slice(-20);
        const directionalSkew = crowdBias.reduce((acc, s) => {
          if (!s.signal || s.signal.marketId !== m.id) return acc;
          // Support all field names used across agents
          const p = s.signal.finalProbability ?? s.signal.probability ?? s.signal.mid ?? 0.5;
          return acc + (p >= 0.5 ? 1 : -1);
        }, 0);
        // Scale 0.015: need crowd skew of ≥2 to clear the ev_threshold of 0.03
        const prob = Math.max(0.02, Math.min(0.98, m.impliedProb - directionalSkew * 0.015));
        return {
          marketId: m.id,
          probability: prob,
          confidence: 0.64,
          price: m.priceYes
        };
      });
    return signals;
  },
  async evaluateOpportunities(signals) {
    return signals.map((s) => ({
      ...s,
      side: s.probability >= s.price ? "YES" : "NO",
      requestedSize: 9,
      agentScore: 0.66
    }));
  },
  async proposeTrades(opportunities) {
    return opportunities.map((o) => toTrade("liquidity", o));
  }
};
