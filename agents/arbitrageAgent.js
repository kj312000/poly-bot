const { toTrade } = require("./agentUtils");
const agentParams = require("../shared/agentParams");

module.exports = {
  name: "arbitrage",
  async generateSignals(markets, _news, _sharedData) {
    const p = agentParams.get("arbitrage");
    const threshold  = p.divergenceThreshold || 0.12;
    const confidence = p.confidence          || 0.80;

    const byGroup = {};
    for (const m of markets) {
      byGroup[m.group] = byGroup[m.group] || [];
      byGroup[m.group].push(m);
    }
    const signals = [];
    for (const groupMarkets of Object.values(byGroup)) {
      for (let i = 0; i < groupMarkets.length; i += 1) {
        for (let j = i + 1; j < groupMarkets.length; j += 1) {
          const a = groupMarkets[i];
          const b = groupMarkets[j];
          if (Math.abs(a.impliedProb - b.impliedProb) > threshold) {
            signals.push({ marketId: a.id, probability: (a.impliedProb + b.impliedProb) / 2, confidence, price: a.priceYes });
            signals.push({ marketId: b.id, probability: (a.impliedProb + b.impliedProb) / 2, confidence, price: b.priceYes });
          }
        }
      }
    }
    return signals;
  },
  async evaluateOpportunities(signals) {
    return signals.map((s) => ({
      ...s,
      // Trade direction based on mispricing relative to current market price:
      // probability > price → market underpriced → buy YES
      // probability < price → market overpriced  → buy NO (sell YES)
      side: s.probability >= s.price ? "YES" : "NO",
      requestedSize: 10,
      agentScore: 0.82
    }));
  },
  async proposeTrades(opportunities) {
    return opportunities.map((o) => toTrade("arbitrage", o));
  }
};
