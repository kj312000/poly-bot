const { combineProbability } = require("../shared/probabilityEngine");
const { toTrade } = require("./agentUtils");

module.exports = {
  name: "mispricing",
  async generateSignals(markets, _news, _sharedData) {
    return markets.map((m) => {
      const aiProb = Math.max(0.01, Math.min(0.99, m.impliedProb + (Math.random() - 0.5) * 0.14));
      const combined = combineProbability({
        marketProb: m.impliedProb,
        aiProb,
        adjustments: [m.bias || 0],
        baseConfidence: 0.7
      });
      return { marketId: m.id, price: m.priceYes, ...combined };
    });
  },
  async evaluateOpportunities(signals) {
    return signals.map((s) => ({
      marketId: s.marketId,
      probability: s.finalProbability,
      confidence: s.confidence,
      price: s.price,
      side: s.finalProbability >= s.price ? "YES" : "NO",
      requestedSize: 15,
      agentScore: 0.78
    }));
  },
  async proposeTrades(opportunities) {
    return opportunities.map((o) => toTrade("mispricing", o));
  }
};
