function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function combineProbability({ marketProb, aiProb, adjustments = [], baseConfidence = 0.6 }) {
  const adjusted = adjustments.reduce((acc, v) => acc + v, 0);
  const blended = 0.5 * marketProb + 0.5 * aiProb + adjusted;
  const finalProbability = clamp01(blended);
  const uncertainty = Math.abs(finalProbability - 0.5);
  const confidence = clamp01(0.5 * baseConfidence + 0.5 * (0.5 + uncertainty));
  return { finalProbability, confidence };
}

function expectedValue(probabilityYes, marketPriceYes) {
  return probabilityYes - marketPriceYes;
}

module.exports = {
  combineProbability,
  expectedValue,
  clamp01
};
