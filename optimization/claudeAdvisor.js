'use strict';

const https = require('https');

const API_HOST = 'api.anthropic.com';
const API_PATH = '/v1/messages';
const MODEL = process.env.OPTIMIZER_MODEL || 'claude-sonnet-4-6';

// Parameter bounds to prevent degenerate solutions
const BOUNDS = {
  ev_threshold:               { min: 0.03, max: 0.20 },
  confidence_threshold:       { min: 0.50, max: 0.90 },
  fractional_kelly:           { min: 0.10, max: 0.70 },
  cooldown_cycles_after_loss: { min: 1,    max: 6    },
  agent_allocations: {
    mispricing:   { min: 0.01, max: 0.55 },
    news:         { min: 0.01, max: 0.45 },
    market_maker: { min: 0.01, max: 0.45 },
    arbitrage:    { min: 0.01, max: 0.60 },
    liquidity:    { min: 0.01, max: 0.40 },
  },
  agent_params: {
    agentScore:       { min: 0.30, max: 1.00 },
    confidenceScale:  { min: 0.50, max: 1.50 },
    sizeScale:        { min: 0.20, max: 2.00 },
  },
};

class ClaudeAdvisor {
  constructor(apiKey) {
    if (!apiKey) throw new Error('CLAUDE_API_KEY not set');
    this.apiKey = apiKey;
  }

  /**
   * Ask Claude to analyze backtest results and suggest parameter changes.
   *
   * @param {object} context
   * @param {number} context.iteration
   * @param {object} context.currentConfig  — flattened current config + agentParams
   * @param {object} context.metrics        — from PerformanceAnalyzer
   * @param {object} context.agentBreakdown — per-agent win rate / PnL
   * @param {Array}  context.history        — previous iterations
   * @param {number} context.targetWinRate  — e.g. 0.70
   */
  async suggestImprovements({ iteration, currentConfig, metrics, agentBreakdown, history, targetWinRate = 0.70 }) {
    const targetPct = Math.round(targetWinRate * 100);
    const currentWr = parseFloat(metrics.winRate || '0');
    const gap = (targetPct - currentWr).toFixed(1);

    const historyStr = history.length
      ? history.slice(-4).map(h =>
          `  iter=${h.iteration} win_rate=${h.winRate}% trades=${h.totalTrades} changes=${JSON.stringify(h.changes)}`
        ).join('\n')
      : '  (no previous iterations)';

    const prompt = `You are a quantitative strategy optimizer for a Polymarket prediction-market trading system.

## Goal
Improve win rate from **${currentWr}%** to **≥${targetPct}%** (gap: ${gap} pp).
Also ensure total trades ≥ 20 (strategy must remain active).

## How the simulation works
Win probability for each trade = logistic(20 × ev × max(0, confidence − 0.5) × 2)
This means:
- Higher ev_threshold → only high-EV trades pass → higher per-trade win rate
- Higher confidence_threshold → only confident trades pass → higher win rate
- Disabling a low-performing agent removes its noisy trades
- Agent allocations affect position size but not win rate directly
- agentScore affects conflict resolution (higher = prioritised when two agents target same market)
- confidenceScale multiplies the agent's raw confidence output (>1 boosts, <1 penalises)

## Current configuration
\`\`\`json
${JSON.stringify(currentConfig, null, 2)}
\`\`\`

## Backtest metrics (iteration ${iteration})
\`\`\`json
${JSON.stringify(metrics, null, 2)}
\`\`\`

## Per-agent breakdown
\`\`\`json
${JSON.stringify(agentBreakdown, null, 2)}
\`\`\`

## Previous iterations
${historyStr}

## Parameter bounds
- ev_threshold: [0.03, 0.20]
- confidence_threshold: [0.50, 0.90]
- fractional_kelly: [0.10, 0.70]
- cooldown_cycles_after_loss: [1, 6] (integer)
- agent_allocations per agent: [0.01, 0.60], must sum to ≤ 1.0
- agentParams.*.agentScore: [0.30, 1.00]
- agentParams.*.confidenceScale: [0.50, 1.50]
- agentParams.*.sizeScale: [0.20, 2.00]
- agentParams.*.enabled: true | false

## Instructions
1. Diagnose WHY win rate is below target (which agents are dragging it down, what thresholds are too loose)
2. Recommend specific parameter changes. Be bold — small changes won't close a large gap.
3. Prefer: raising thresholds, disabling poor agents, boosting top agents.
4. Do NOT make all allocations zero; keep at least 2 agents enabled.
5. Return ONLY valid JSON (no markdown, no prose outside JSON):

{
  "analysis": "<2-3 sentence diagnosis>",
  "changes": {
    "ev_threshold": <number or omit if unchanged>,
    "confidence_threshold": <number or omit>,
    "fractional_kelly": <number or omit>,
    "cooldown_cycles_after_loss": <integer or omit>,
    "agent_allocations": {
      "mispricing": <number>, "news": <number>,
      "market_maker": <number>, "arbitrage": <number>, "liquidity": <number>
    },
    "agentParams": {
      "mispricing":   { "agentScore": <n>, "confidenceScale": <n>, "sizeScale": <n>, "enabled": <bool> },
      "news":         { ... },
      "market_maker": { ... },
      "arbitrage":    { ... },
      "liquidity":    { ... }
    }
  },
  "reasoning": "<step-by-step explanation of each change>"
}`;

    const raw = await this._callClaude(prompt);
    const parsed = this._extractJson(raw);

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Claude returned non-JSON response: ${raw.slice(0, 300)}`);
    }

    return this._clampChanges(parsed);
  }

  // ── Claude HTTP call ────────────────────────────────────────────────────────

  _callClaude(prompt) {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: API_HOST,
          path: API_PATH,
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
          timeout: 60000,
        },
        (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode >= 400) {
              reject(new Error(`Claude API ${res.statusCode}: ${text.slice(0, 300)}`));
              return;
            }
            try {
              const msg = JSON.parse(text);
              resolve(msg.content?.[0]?.text || '');
            } catch {
              reject(new Error(`Claude response parse error: ${text.slice(0, 200)}`));
            }
          });
        }
      );
      req.on('timeout', () => { req.destroy(); reject(new Error('Claude API timeout')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ── JSON extraction (handles code blocks + bare JSON) ───────────────────────

  _extractJson(text) {
    const attempts = [
      () => JSON.parse(text.trim()),
      () => { const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/); return m && JSON.parse(m[1]); },
      () => { const m = text.match(/(\{[\s\S]*\})/); return m && JSON.parse(m[1]); },
    ];
    for (const fn of attempts) {
      try { const r = fn(); if (r) return r; } catch {}
    }
    return null;
  }

  // ── Clamp all numeric changes within bounds ─────────────────────────────────

  _clampChanges(parsed) {
    const changes = parsed.changes || {};

    if (changes.ev_threshold != null)
      changes.ev_threshold = clamp(changes.ev_threshold, BOUNDS.ev_threshold);

    if (changes.confidence_threshold != null)
      changes.confidence_threshold = clamp(changes.confidence_threshold, BOUNDS.confidence_threshold);

    if (changes.fractional_kelly != null)
      changes.fractional_kelly = clamp(changes.fractional_kelly, BOUNDS.fractional_kelly);

    if (changes.cooldown_cycles_after_loss != null)
      changes.cooldown_cycles_after_loss = Math.round(clamp(changes.cooldown_cycles_after_loss, BOUNDS.cooldown_cycles_after_loss));

    if (changes.agent_allocations) {
      for (const [agent, val] of Object.entries(changes.agent_allocations)) {
        const b = BOUNDS.agent_allocations[agent];
        if (b) changes.agent_allocations[agent] = clamp(val, b);
      }
      // Normalise so allocations sum to ≤ 1
      const total = Object.values(changes.agent_allocations).reduce((s, v) => s + v, 0);
      if (total > 1) {
        for (const k of Object.keys(changes.agent_allocations)) {
          changes.agent_allocations[k] = Math.round((changes.agent_allocations[k] / total) * 1000) / 1000;
        }
      }
    }

    if (changes.agentParams) {
      for (const [agent, agentChanges] of Object.entries(changes.agentParams)) {
        if (agentChanges.agentScore != null)
          agentChanges.agentScore = clamp(agentChanges.agentScore, BOUNDS.agent_params.agentScore);
        if (agentChanges.confidenceScale != null)
          agentChanges.confidenceScale = clamp(agentChanges.confidenceScale, BOUNDS.agent_params.confidenceScale);
        if (agentChanges.sizeScale != null)
          agentChanges.sizeScale = clamp(agentChanges.sizeScale, BOUNDS.agent_params.sizeScale);
        // At least 2 agents must remain enabled
        if (agentChanges.enabled === false) {
          const stillEnabled = Object.entries(changes.agentParams)
            .filter(([a, p]) => a !== agent && p.enabled !== false).length;
          if (stillEnabled < 2) agentChanges.enabled = true;
        }
        changes.agentParams[agent] = agentChanges;
      }
    }

    return { ...parsed, changes };
  }
}

function clamp(v, { min, max }) {
  return Math.max(min, Math.min(max, Number(v)));
}

module.exports = { ClaudeAdvisor };
