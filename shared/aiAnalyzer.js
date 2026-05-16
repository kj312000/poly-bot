/**
 * Claude-backed analyzer with deterministic fallback.
 * For production live mode, set CLAUDE_API_KEY and implement real endpoint in callClaude.
 */
async function analyzeNews(newsItems) {
  if (!newsItems || newsItems.length === 0) return [];
  const results = [];
  for (const item of newsItems) {
    const signal = await callClaude(item);
    results.push(signal);
  }
  return results;
}

async function callClaude(newsItem) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    // Safe fallback: no blind LLM decisions in live mode; deterministic parser in absence of API.
    return heuristicParse(newsItem);
  }

  // Replace with real Claude call as needed. Kept mocked for local testing safety.
  return heuristicParse(newsItem);
}

function heuristicParse(newsItem) {
  const t = `${newsItem.title || ""} ${newsItem.body || ""}`.toLowerCase();
  let impact = "neutral";
  let probabilityShift = 0;
  let confidence = 0.55;

  if (/(wins|approved|supports|surges|leads|strong)/.test(t)) {
    impact = "positive";
    probabilityShift = 0.07;
    confidence = 0.74;
  } else if (/(loses|denied|scandal|weak|falls|injury|lawsuit)/.test(t)) {
    impact = "negative";
    probabilityShift = -0.07;
    confidence = 0.74;
  }

  return {
    event: newsItem.title || "Untitled event",
    impact,
    probability_shift: probabilityShift,
    confidence
  };
}

module.exports = { analyzeNews };
