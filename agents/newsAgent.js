const { analyzeNews } = require("../shared/aiAnalyzer");
const { combineProbability, clamp01 } = require("../shared/probabilityEngine");
const { toTrade } = require("./agentUtils");

module.exports = {
  name: "news",
  async generateSignals(markets, news) {
    const analyses = await analyzeNews(news);
    return markets.map((m, idx) => {
      const n = analyses[idx % Math.max(1, analyses.length)] || {
        probability_shift: 0,
        confidence: 0.55
      };
      const aiProb = clamp01(m.impliedProb + n.probability_shift);
      const combined = combineProbability({
        marketProb: m.impliedProb,
        aiProb,
        adjustments: [n.probability_shift / 2],
        baseConfidence: n.confidence
      });
      return { marketId: m.id, price: m.priceYes, news: n, ...combined };
    });
  },
  async evaluateOpportunities(signals) {
    return signals.map((s) => ({
      marketId: s.marketId,
      probability: s.finalProbability,
      confidence: Math.min(0.95, s.confidence + 0.05),
      price: s.price,
      side: s.finalProbability >= s.price ? "YES" : "NO",
      requestedSize: 12,
      agentScore: 0.72
    }));
  },
  async proposeTrades(opportunities) {
    return opportunities.map((o) => toTrade("news", o));
  }
};
