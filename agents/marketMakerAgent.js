const { toTrade } = require("./agentUtils");

module.exports = {
  name: "market_maker",
  async generateSignals(markets, _news, _sharedData) {
    return markets.map((m) => {
      const spread = Math.max(0.005, (m.askYes - m.bidYes) || 0.01);
      const volatility = m.volatility || 0.2;
      const conf = Math.max(0.55, 0.85 - volatility * 0.4);
      return {
        marketId: m.id,
        mid: (m.askYes + m.bidYes) / 2,
        spread,
        confidence: conf
      };
    });
  },
  async evaluateOpportunities(signals) {
    return signals.map((s) => {
      const side = Math.random() > 0.5 ? "YES" : "NO";
      // EV = full spread capture: market maker quotes at mid but true value is mid ± spread
      const probability = side === "YES"
        ? Math.min(0.99, s.mid + s.spread)
        : Math.max(0.01, s.mid - s.spread);
      return {
        marketId: s.marketId,
        probability,
        confidence: s.confidence,
        price: s.mid,
        side,
        requestedSize: 8,
        agentScore: 0.68
      };
    });
  },
  async proposeTrades(opportunities) {
    return opportunities.map((o) => toTrade("market_maker", o));
  }
};
