'use strict';

const https = require('https');

const TRIGGER_EVERY   = 3;
const MIN_INTERVAL_MS = 60000;

// ── System prompts ────────────────────────────────────────────────────────────

const PERF_SYSTEM = `You are a quantitative trading performance analyst for a Polymarket BTC scalp bot.
Analyze recent closed trades and suggest SPECIFIC parameter improvements to increase profitability.

ADJUSTABLE PARAMETERS:
confidence_threshold (50-90) | take_profit_pct (0.10-0.40) | stop_loss_pct (0.04-0.15)
max_hold_ms (30000-300000) | cooldown_ms (5000-30000) | vol_ratio_min (1.0-2.0) | ob_imbalance_min (0.10-0.40)

RULES: max 4 changes | only if justified | if WR>65% and P&L positive → minor tuning only
OUTPUT: respond with ONLY valid JSON, no surrounding text, all strings under 100 chars

OUTPUT (valid JSON only):
{
  "analysis": "2-3 sentence diagnosis",
  "performance_grade": "A|B|C|D|F",
  "primary_issue": "one-line root cause",
  "recommendations": [{"parameter":"","current":0,"suggested":0,"change":"","reason":"","expected_impact":""}],
  "do_not_change": [],
  "watch_for": ""
}`;

const COUNTERFACTUAL_SYSTEM = `You are a parameter calibration expert for a Polymarket BTC scalp trading bot.

The bot has been running but NOT TAKING ANY TRADES because signal thresholds are too strict.
You are given logs from 100 consecutive market evaluation ticks — every one resulted in NO TRADE.

YOUR MISSION: Find the minimum parameter relaxations that would have generated at least 3-5 HIGH-QUALITY trade signals from this real market data, WITHOUT opening the floodgates to noise trades.

THE MATH ENGINE scores each tick 0-100:
  velocity (35pts): 30s BTC price change speed — measures momentum
  pressure (20pts): buy vs sell volume imbalance — measures direction conviction
  volume   (15pts): vol ratio vs EMA — confirms momentum with flow
  orderbook(15pts): bid/ask depth imbalance — confirms institutional direction
  candle   (10pts):  clean body vs wick ratio — confirms candle quality
  penalties:         exhaustion, wide spread, chop reduce score

THE BOT ONLY TRADES WHEN: confidence >= confidence_threshold AND signal != "NO TRADE"

PARAMETERS TO CONSIDER ADJUSTING:
- confidence_threshold: currently the main gate. Default 65. Range 40-85.
- MIN_VELOCITY_PCT: minimum 30s price velocity to score velocity points. Default 0.15%.
- VOL_RATIO_MIN: minimum volume vs EMA. Default 1.3x.
- OB_IMBALANCE_MIN: minimum orderbook imbalance 0-1. Default 0.15.
- SPREAD_MAX_BPS: maximum spread in basis points. Default 30.

ANALYSIS INSTRUCTIONS:
1. Look at the confidence distribution — what was the MAX confidence seen? AVG?
2. Find the "best" ticks — highest confidence, clearest momentum
3. Identify what single parameter change would unlock the most quality signals
4. Check: if confidence_threshold = MAX_SEEN - 5, how many trades would have fired?
5. Are near-miss ticks (conf 50-64) actually good quality or noise?
6. What's blocking signals: velocity too low? volume too low? OB imbalance?
7. ONLY suggest lowering thresholds if the underlying market conditions were real
8. If BTC was completely flat (all v30 < 0.05%), say "market was dead, no good trades existed"

CRITICAL: Better to say "no good setups existed in this batch" than to suggest lowering quality standards to noise level.

OUTPUT RULES:
- Respond with ONLY the JSON object — no explanation text before or after
- Keep ALL string values under 120 characters — be terse
- recommendations array: max 3 items
- If market was dead, set recommendations to []

OUTPUT (valid JSON only):
{
  "market_condition_summary": "Was BTC actually moving? What kind of session was this?",
  "good_opportunities_found": true|false,
  "best_tick_confidence": 0,
  "avg_confidence": 0,
  "near_miss_count": 0,
  "primary_blocker": "what prevented signals: low_velocity|low_volume|wide_spread|low_confidence|flat_market",
  "counterfactual_analysis": "If X parameter was Y, these ticks would have fired: [describe specific conditions]",
  "recommendations": [
    {
      "parameter": "",
      "current_value": 0,
      "suggested_value": 0,
      "estimated_trades_unlocked": 0,
      "quality_assessment": "HIGH|MEDIUM|LOW",
      "reason": "",
      "risk_warning": ""
    }
  ],
  "verdict": "ADJUST_PARAMS|WAIT_FOR_BETTER_MARKET|MARKET_WAS_DEAD",
  "summary": "One paragraph plain English explanation"
}`;

// ── ClaudeAdvisor ─────────────────────────────────────────────────────────────

class ClaudeAdvisor {
  constructor({ onRecommendation, onCounterfactual, onLog }) {
    this.onRecommendation  = onRecommendation  || (() => {});
    this.onCounterfactual  = onCounterfactual  || (() => {});
    this.onLog             = onLog             || (() => {});

    this._enabled          = true;   // toggled via setEnabled()
    this._lastPerfCallMs   = 0;
    this._lastCfCallMs     = 0;
    this._tradesSinceLast  = 0;
    this._latestPerf       = null;
    this._latestCf         = null;
    this._perfPending      = false;
    this._cfPending        = false;
  }

  setEnabled(bool) {
    this._enabled = !!bool;
    this.onLog(`[advisor] ${this._enabled ? 'Enabled ✓' : 'Disabled — Claude calls paused'}`);
  }

  get enabled() { return this._enabled; }

  // ── Performance advisor (trade outcomes) ─────────────────────────────────────

  onTradeClosed(analyzer, currentParams) {
    if (!this._enabled) return;
    this._tradesSinceLast++;
    if (this._tradesSinceLast >= TRIGGER_EVERY &&
        (Date.now() - this._lastPerfCallMs) >= MIN_INTERVAL_MS &&
        analyzer.hasEnoughData(TRIGGER_EVERY) && !this._perfPending) {
      this._tradesSinceLast = 0;
      this._runPerfAnalysis(analyzer.getSnapshot(currentParams));
    }
  }

  async analyzeNow(analyzer, currentParams) {
    if (!this._enabled) return { ok: false, error: 'AI Advisor is disabled' };
    if (this._perfPending) return { ok: false, error: 'Analysis in progress' };
    return this._runPerfAnalysis(analyzer.getSnapshot(currentParams));
  }

  // ── Counterfactual (100-tick batch, no trades fired) ─────────────────────────

  /**
   * Called automatically by TradeAnalyzer when 100 ticks accumulate.
   * @param {object[]} ticks100  — exactly 100 tick records
   * @param {object}   params    — current bot parameters
   */
  async analyzeCounterfactual(ticks100, params) {
    if (!this._enabled) return null;
    if (this._cfPending) { this.onLog('[cf] Analysis already in progress, skipping batch'); return null; }
    if ((Date.now() - this._lastCfCallMs) < 30000) { this.onLog('[cf] Too soon, skipping batch'); return null; }

    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) { this.onLog('[cf] CLAUDE_API_KEY not set'); return null; }

    this._cfPending    = true;
    this._lastCfCallMs = Date.now();
    this.onLog(`[cf] Sending 100-tick batch to Claude for counterfactual analysis…`);

    try {
      const prompt = this._buildCounterfactualPrompt(ticks100, params);
      const result = await this._post(prompt, apiKey, COUNTERFACTUAL_SYSTEM, 2000);
      this._cfPending = false;

      if (!result) { this.onLog('[cf] No valid JSON from Claude'); return null; }

      this._latestCf = { ...result, analyzedAt: Date.now(), batchSize: ticks100.length, _partial: !result.verdict };
      const verdict = result.verdict || (result.good_opportunities_found === false ? 'MARKET_WAS_DEAD' : 'PARTIAL');
      this.onLog(`[cf] Verdict: ${verdict} | blocker: ${result.primary_blocker || '—'} | best_conf: ${result.best_tick_confidence ?? '—'} | near-misses: ${result.near_miss_count ?? '—'}`);
      this.onCounterfactual(this._latestCf);
      return this._latestCf;
    } catch (e) {
      this._cfPending = false;
      this.onLog(`[cf] Error: ${e.message}`);
      return null;
    }
  }

  get latest()        { return this._latestPerf; }
  get latestCf()      { return this._latestCf;   }
  get cfPending()     { return this._cfPending;   }

  // ── Build prompts ─────────────────────────────────────────────────────────────

  _buildCounterfactualPrompt(ticks, params) {
    // Compute distributions before sending to Claude — saves tokens, better analysis
    const confs    = ticks.map(t => t.confidence);
    const v30s     = ticks.map(t => t.v30);
    const vols     = ticks.map(t => t.volRatio);
    const pressures= ticks.map(t => t.pressure);
    const obs      = ticks.map(t => t.obImbalance);
    const spreads  = ticks.map(t => t.spreadBps);

    const stat = (arr) => {
      const sorted = [...arr].sort((a,b)=>a-b);
      return {
        min:  sorted[0].toFixed(2),
        p25:  sorted[Math.floor(arr.length * 0.25)].toFixed(2),
        p50:  sorted[Math.floor(arr.length * 0.50)].toFixed(2),
        p75:  sorted[Math.floor(arr.length * 0.75)].toFixed(2),
        max:  sorted[arr.length - 1].toFixed(2),
        avg:  (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2),
      };
    };

    const nearMisses  = ticks.filter(t => t.confidence >= 50 && t.confidence < 65);
    const highSignals = ticks.filter(t => t.signal !== 'NO TRADE' && t.confidence >= 55);
    const longTicks   = ticks.filter(t => t.signal === 'LONG');
    const shortTicks  = ticks.filter(t => t.signal === 'SHORT');

    // Best 5 ticks by confidence for Claude to examine
    const best5 = [...ticks].sort((a,b) => b.confidence - a.confidence).slice(0, 5);

    const best5Lines = best5.map((t, i) =>
      `  #${i+1} t=${new Date(t.ts).toLocaleTimeString()} BTC=$${t.btcPrice} ` +
      `conf=${t.confidence} sig=${t.signal} v30=${t.v30}% pres=${t.pressure}% ` +
      `vol=${t.volRatio}x ob=${t.obImbalance}% sprd=${t.spreadBps}bps ` +
      `scores=[vel=${t.scoreBreakdown?.velocity||'?'} pres=${t.scoreBreakdown?.pressure||'?'} vol=${t.scoreBreakdown?.volume||'?'} ob=${t.scoreBreakdown?.orderbook||'?'} pen=${t.scoreBreakdown?.penalties||'?'}]`
    ).join('\n');

    // Sample every 10th tick for context (10 ticks shown)
    const sample = ticks.filter((_, i) => i % 10 === 0);
    const sampleLines = sample.map(t =>
      `  t=${new Date(t.ts).toLocaleTimeString()} conf=${t.confidence} sig=${t.signal} v30=${t.v30}% vol=${t.volRatio}x ob=${t.obImbalance}% sprd=${t.spreadBps}bps`
    ).join('\n');

    return `=== 100-TICK COUNTERFACTUAL ANALYSIS ===
Zero trades were taken in this batch. Determine if any quality setups existed.

CURRENT THRESHOLDS (what the bot requires to trade):
  confidence_threshold = ${params.confidence_threshold || 65}  ← MAIN GATE
  min_velocity_pct     = 0.15%
  vol_ratio_min        = 1.3
  ob_imbalance_min     = 0.15
  spread_max_bps       = 30

CONFIDENCE DISTRIBUTION (100 ticks):
  min=${stat(confs).min}  p25=${stat(confs).p25}  median=${stat(confs).p50}  p75=${stat(confs).p75}  max=${stat(confs).max}  avg=${stat(confs).avg}
  near-misses (50-64): ${nearMisses.length} ticks
  high-dir signals (conf≥55, non-NO-TRADE): ${highSignals.length} ticks
  LONG signals: ${longTicks.length} | SHORT signals: ${shortTicks.length}

VELOCITY (v30s %) DISTRIBUTION:
  min=${stat(v30s).min}%  median=${stat(v30s).p50}%  max=${stat(v30s).max}%  avg=${stat(v30s).avg}%

VOLUME RATIO DISTRIBUTION:
  min=${stat(vols).min}x  median=${stat(vols).p50}x  max=${stat(vols).max}x  avg=${stat(vols).avg}x

PRESSURE DISTRIBUTION (%):
  min=${stat(pressures).min}  median=${stat(pressures).p50}  max=${stat(pressures).max}

OB IMBALANCE DISTRIBUTION (%):
  min=${stat(obs).min}  median=${stat(obs).p50}  max=${stat(obs).max}

SPREAD DISTRIBUTION (bps):
  min=${stat(spreads).min}  median=${stat(spreads).p50}  max=${stat(spreads).max}

TOP 5 TICKS BY CONFIDENCE (most tradeable moments):
${best5Lines}

SAMPLE ACROSS 100 TICKS (every 10th):
${sampleLines}

Now analyze: were there real opportunities missed? What parameters would have unlocked them? Return JSON:`;
  }

  _buildPerfPrompt(snap) {
    const s   = snap.summary;
    const par = snap.currentParams;

    const tradeLines = snap.recentTrades.map((t, i) =>
      `  #${i+1}: ${t.signal} entry=${t.entryPrice} exit=${t.exitPrice} TP=${t.tpPrice} SL=${t.slPrice} pnl=${t.pnl>=0?'+':''}$${t.pnl} ${t.reason} held=${t.holdMs/1000}s conf=${t.confidence??'—'}`
    ).join('\n');

    const tickLines = snap.recentTicks.slice(-10).map(t =>
      `  ${new Date(t.ts).toLocaleTimeString()} $${t.btcPrice} v30=${t.v30}% vol=${t.volRatio}x ob=${t.obImbalance}% conf=${t.confidence} → ${t.signal}`
    ).join('\n');

    return `SESSION SUMMARY: trades=${s.totalTrades} wr=${s.winRate}% pnl=$${s.totalPnl} avgWin=+$${s.avgWin} avgLoss=-$${Math.abs(s.avgLoss)} realRR=${s.realizedRR} TP=${s.tpHits} SL=${s.slHits} exp=${s.expired} avgHold=${s.avgHoldSec}s hcWR=${s.highConfWR??'—'}% lcWR=${s.lowConfWR??'—'}%

PARAMS: conf_thresh=${par.confidence_threshold||0.65} tp=${par.take_profit_pct||0.20} sl=${par.stop_loss_pct||0.08} maxhold=${par.max_hold_ms||180000} cool=${par.cooldown_ms||15000} volmin=${par.vol_ratio_min||1.3} obmin=${par.ob_imbalance_min||0.15}

TRADES:\n${tradeLines||'(none)'}

TICKS:\n${tickLines||'(none)'}

Return JSON analysis:`;
  }

  // ── Internal ──────────────────────────────────────────────────────────────────

  async _runPerfAnalysis(snapshot) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return null;
    if (this._perfPending) return null;

    this._perfPending    = true;
    this._lastPerfCallMs = Date.now();
    this.onLog(`[advisor] Sending perf snapshot (${snapshot.recentTrades.length} trades) to Claude…`);

    try {
      const result = await this._post(this._buildPerfPrompt(snapshot), apiKey, PERF_SYSTEM, 800);
      this._perfPending = false;
      if (!result) return null;
      this._latestPerf = { ...result, analyzedAt: Date.now() };
      this.onLog(`[advisor] Grade=${result.performance_grade} | ${result.primary_issue} | ${result.recommendations?.length||0} rec(s)`);
      this.onRecommendation(this._latestPerf);
      return this._latestPerf;
    } catch (e) {
      this._perfPending = false;
      this.onLog(`[advisor] Error: ${e.message}`);
      return null;
    }
  }

  _post(userMsg, apiKey, systemPrompt, maxTokens = 800) {
    const body = JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMsg }],
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length':    Buffer.byteLength(body),
        },
        timeout: 35000,
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');

          // HTTP-level error
          if (res.statusCode >= 400) {
            this.onLog(`[claude] HTTP ${res.statusCode}: ${raw.slice(0, 300)}`);
            return resolve(null);
          }

          let apiResp;
          try { apiResp = JSON.parse(raw); } catch {
            this.onLog(`[claude] Response parse failed: ${raw.slice(0, 200)}`);
            return resolve(null);
          }

          // API-level error (e.g. overloaded, invalid model)
          if (apiResp.error || apiResp.type === 'error') {
            this.onLog(`[claude] API error: ${JSON.stringify(apiResp.error || apiResp).slice(0, 300)}`);
            return resolve(null);
          }

          const text = apiResp.content?.[0]?.text || '';
          if (!text) {
            this.onLog(`[claude] Empty response. Stop reason: ${apiResp.stop_reason}`);
            return resolve(null);
          }

          // Extract JSON — handles: raw JSON, ```json blocks, ``` blocks
          const json = _extractJson(text);
          if (!json) {
            this.onLog(`[claude] Could not extract JSON. Raw text (first 400): ${text.slice(0, 400)}`);
            return resolve(null);
          }

          resolve(json);
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Claude API timeout (35s)')); });
      req.on('error', e => reject(e));
      req.write(body);
      req.end();
    });
  }
}

// ── JSON extraction — handles markdown blocks, raw JSON, and truncated responses

function _extractJson(text) {
  // 1. ```json ... ``` block (complete)
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch {}
  }

  // 2. Find outermost { ... } (complete)
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }

  // 3. Whole text
  try { return JSON.parse(text.trim()); } catch {}

  // 4. Truncated JSON repair — response was cut off before closing braces
  if (first !== -1) {
    try { return _repairTruncated(text.slice(first)); } catch {}
  }

  // 5. Strip code-fence then repair
  if (codeBlock) {
    try { return _repairTruncated(codeBlock[1].trim()); } catch {}
  }

  return null;
}

/**
 * Repair a JSON string that was truncated mid-value.
 * Strategy:
 *   - Truncate at the last complete "key": value, pair
 *   - Close all open brackets/braces
 */
function _repairTruncated(partial) {
  let s = partial.trim();

  // Remove trailing incomplete token (partial string, partial number, etc.)
  // Find last complete value by scanning backwards for comma or {
  // Simple heuristic: truncate at last complete line ending with , " } ]
  const lastSafe = Math.max(
    s.lastIndexOf('",'),
    s.lastIndexOf('",\n'),
    s.lastIndexOf('],'),
    s.lastIndexOf('},'),
    s.lastIndexOf('"'),   // last closed string
  );

  // If we found a safe cut point, truncate there and close
  if (lastSafe > 0) {
    s = s.slice(0, lastSafe + 1);
  }

  // Count open brackets and close them
  let braces = 0, brackets = 0, inStr = false, escape = false;
  for (const ch of s) {
    if (escape)        { escape = false; continue; }
    if (ch === '\\')   { escape = true;  continue; }
    if (ch === '"')    { inStr = !inStr;  continue; }
    if (inStr)          continue;
    if (ch === '{')    braces++;
    if (ch === '}')    braces--;
    if (ch === '[')    brackets++;
    if (ch === ']')    brackets--;
  }

  // Close unclosed arrays then objects
  while (brackets-- > 0) s += ']';
  while (braces--   > 0) s += '}';

  return JSON.parse(s);
}

module.exports = { ClaudeAdvisor };
