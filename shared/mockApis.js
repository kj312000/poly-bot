function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

async function fetchMarkets() {
  const base = [
    { id: "election_2028", group: "politics" },
    { id: "btc_100k_2026", group: "crypto" },
    { id: "fed_cut_q3", group: "macro" },
    { id: "championship_team_a", group: "sports" },
    { id: "oil_above_100", group: "macro" }
  ];
  return base.map((m) => {
    const impliedProb = randomBetween(0.2, 0.8);
    const spread = randomBetween(0.01, 0.04);
    const mid = impliedProb;
    return {
      ...m,
      impliedProb,
      priceYes: mid,
      bidYes: Math.max(0.01, mid - spread / 2),
      askYes: Math.min(0.99, mid + spread / 2),
      liquidity: randomBetween(500, 10000),
      volatility: randomBetween(0.1, 0.5),
      bias: randomBetween(-0.03, 0.03)
    };
  });
}

async function fetchNews() {
  const feed = [
    { title: "Candidate A surges in latest poll", body: "Support rises in key states." },
    { title: "Regulatory lawsuit hits crypto exchange", body: "Sentiment weakens temporarily." },
    { title: "Central bank hints at possible cut", body: "Macro risk assets react positively." }
  ];
  return feed.sort(() => Math.random() - 0.5).slice(0, 2);
}

class MockPolymarketApi {
  async placeOrder(trade) {
    return {
      tradeId: `live_mock_${Date.now()}`,
      status: "filled",
      entryPrice: trade.price,
      exitPrice: Math.max(0.01, Math.min(0.99, trade.price + (Math.random() - 0.5) * 0.04)),
      pnl: (Math.random() - 0.48) * trade.size * 0.05
    };
  }
}

module.exports = {
  fetchMarkets,
  fetchNews,
  MockPolymarketApi
};
