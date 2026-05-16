const { expectedValue } = require("../shared/probabilityEngine");

function toTrade(agent, opp) {
  // For YES trades: EV = probability - price  (positive when we think prob > market price)
  // For NO trades:  EV = (1-probability) - (1-price) = price - probability
  //                 (positive when market is overpriced and we sell YES = buy NO)
  const ev = opp.side === 'YES'
    ? expectedValue(opp.probability, opp.price)
    : expectedValue(1 - opp.probability, 1 - opp.price);
  return {
    agent,
    marketId: opp.marketId,
    side: opp.side,
    price: opp.price,
    probability: opp.probability,
    ev,
    confidence: opp.confidence,
    requestedSize: opp.requestedSize || 10,
    agentScore: opp.agentScore || 0.5
  };
}

module.exports = { toTrade };
